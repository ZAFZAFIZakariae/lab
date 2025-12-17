import { JetStreamClient, NatsConnection, consumerOpts } from "nats";
import { KvLike, sc } from "./connection";
import { MetadataStore } from "../crdt/metadataStore";
import { Operation, versionFromOp } from "../crdt/lww";
import { LogicalClock } from "../crdt/clock";

export interface LocalWatcherContext {
  nc: NatsConnection;
  jsCtx?: JetStreamClient;
  kv: KvLike;
  bucket: string;
  nodeId: string;
  repSubject: string;
  metadataStore: MetadataStore;
  clock: LogicalClock;
}

/**
 * Watches the local KV bucket for changes that did NOT originate from this agent
 * (no KV-Origin header) and publishes LWW operations to the replication subject.
 *
 * It also exposes convenience helpers:
 *   (ctx as any).localPut(key, value)
 *   (ctx as any).localDelete(key)
 */
export async function startLocalWatcher(ctx: LocalWatcherContext): Promise<void> {
  console.log("[local] watcher initialized");

  // Watch KV changes and publish CRDT operations for locally-originated writes
  const js = ctx.jsCtx ?? ctx.nc.jetstream();
  const subject = `$KV.${ctx.bucket}.>`;

  const opts = consumerOpts();
  opts.ackNone();
  opts.deliverNew();

  const sub = await js.subscribe(subject, opts);

  (async () => {
    for await (const msg of sub) {
      const origin = msg.headers?.get("KV-Origin");
      if (origin) {
        // Skip events we wrote ourselves (or remote replicas applied) to avoid loops
        continue;
      }

      const key = msg.subject.substring(`$KV.${ctx.bucket}.`.length);
      const isDelete = msg.headers?.get("KV-Operation") === "DEL";
      const op: Operation = {
        op: isDelete ? "delete" : "put",
        bucket: ctx.bucket,
        key,
        value: isDelete ? undefined : sc.decode(msg.data),
        ts: ctx.clock.tick(),
        nodeId: ctx.nodeId,
      };

      ctx.metadataStore.set(ctx.bucket, key, versionFromOp(op));
      await publishOperation(ctx, op);
      console.log(`[local] detected KV change ${key} -> ${op.op}, published op`);
    }
  })().catch((err) => console.error("[local] watcher loop error:", err));

  // Convenience helpers for local updates
  (ctx as any).localPut = async (key: string, value: string) => {
    const op: Operation = {
      op: "put",
      bucket: ctx.bucket,
      key,
      value,
      ts: ctx.clock.tick(),
      nodeId: ctx.nodeId,
    };
    await ctx.kv.put(key, sc.encode(value), {
      origin: ctx.nodeId,
      timestamp: op.ts,
    });
    ctx.metadataStore.set(ctx.bucket, key, versionFromOp(op));
    await publishOperation(ctx, op);
    console.log(`[local] put ${key}=${value}, op published`);
  };

  (ctx as any).localDelete = async (key: string) => {
    const op: Operation = {
      op: "delete",
      bucket: ctx.bucket,
      key,
      ts: ctx.clock.tick(),
      nodeId: ctx.nodeId,
    };
    await ctx.kv.delete(key, { origin: ctx.nodeId, timestamp: op.ts });
    ctx.metadataStore.set(ctx.bucket, key, versionFromOp(op));
    await publishOperation(ctx, op);
    console.log(`[local] delete ${key}, op published`);
  };

  console.log("[local] helpers: (ctx as any).localPut/.localDelete");
}

async function publishOperation(ctx: LocalWatcherContext, op: Operation): Promise<void> {
  const payload = sc.encode(JSON.stringify(op));
  if (ctx.jsCtx) {
    await ctx.jsCtx.publish(ctx.repSubject, payload);
  } else {
    ctx.nc.publish(ctx.repSubject, payload);
  }
}
