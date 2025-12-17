import {
  JetStreamClient,
  JetStreamSubscription,
  NatsConnection,
  consumerOpts,
  createInbox,
} from "nats";
import { KvLike, sc } from "./connection";
import { MetadataStore } from "../crdt/metadataStore";
import { Operation, versionFromOp, wins } from "../crdt/lww";
import { LogicalClock } from "../crdt/clock";

export interface ReplicationContext {
  nc: NatsConnection;
  jsCtx?: JetStreamClient;
  kv: KvLike;
  bucket: string;
  nodeId: string;
  repSubject: string;
  metadataStore: MetadataStore;
  clock: LogicalClock;
}

export async function startReplicationSubscriber(
  ctx: ReplicationContext
): Promise<void> {
  if (ctx.jsCtx) {
    await startJetStreamSubscriber(ctx);
  } else {
    await startPlainNatsSubscriber(ctx);
  }
}

/**
 * Plain NATS subscription (no durability).
 */
async function startPlainNatsSubscriber(ctx: ReplicationContext): Promise<void> {
  console.log("[replication] starting plain NATS subscription on", ctx.repSubject);

  const sub = ctx.nc.subscribe(ctx.repSubject);
  (async () => {
    for await (const msg of sub) {
      try {
        const json = sc.decode(msg.data);
        const op: Operation = JSON.parse(json);
        await handleOperation(ctx, op);
      } catch (err) {
        console.error("[replication] error handling message:", err);
      }
    }
  })().catch((err) => console.error("[replication] sub loop error:", err));
}

/**
 * JetStream durable subscription (push-based, async iterator).
 */
async function startJetStreamSubscriber(ctx: ReplicationContext): Promise<void> {
  console.log(
    "[replication] starting JetStream durable subscription on",
    ctx.repSubject
  );

  const js = ctx.jsCtx!;
  const jsm = await ctx.nc.jetstreamManager();

  const streamName = "REPKVOPS";

  // Ensure stream exists
  try {
    await jsm.streams.info(streamName);
  } catch {
    await jsm.streams.add({
      name: streamName,
      subjects: [ctx.repSubject],
    });
  }

  const durableName = `rep-kv-${ctx.nodeId}`;
  const inbox = createInbox(); // required deliver subject for push consumers

  const opts = consumerOpts();
  opts.durable(durableName);
  opts.manualAck();
  opts.deliverAll();
  opts.deliverTo(inbox);

  const sub: JetStreamSubscription = await js.subscribe(ctx.repSubject, opts);

  console.log("[replication] JetStream durable consumer ready:", durableName);

  (async () => {
    for await (const m of sub) {
      try {
        const json = sc.decode(m.data);
        const op: Operation = JSON.parse(json);
        await handleOperation(ctx, op);
        m.ack();
      } catch (err) {
        console.error("[replication] error handling JS message:", err);
        try {
          m.term();
        } catch {
          // ignore
        }
      }
    }
  })().catch((err) => console.error("[replication] JS sub loop error:", err));
}

/**
 * Apply a received CRDT operation using LWW rules.
 */
async function handleOperation(
  ctx: ReplicationContext,
  op: Operation
): Promise<void> {
  if (op.nodeId === ctx.nodeId) {
    // ignore our own messages (echo)
    return;
  }
  if (op.bucket !== ctx.bucket) {
    // ignore operations for other buckets
    return;
  }

  const remoteVersion = versionFromOp(op);
  const localVersion = ctx.metadataStore.get(ctx.bucket, op.key);
  ctx.clock.observe(op.ts);

  if (!wins(remoteVersion, localVersion)) {
    // local wins; ignore remote op
    return;
  }

  if (op.op === "put" && typeof op.value === "string") {
    await ctx.kv.put(op.key, sc.encode(op.value));
    ctx.metadataStore.set(ctx.bucket, op.key, remoteVersion);
    console.log(
      `[replication] applied remote PUT ${op.key}=${op.value} from ${op.nodeId}`
    );
  } else if (op.op === "delete") {
    await ctx.kv.delete(op.key);
    ctx.metadataStore.set(ctx.bucket, op.key, remoteVersion);
    console.log(
      `[replication] applied remote DELETE ${op.key} from ${op.nodeId}`
    );
  }
}
