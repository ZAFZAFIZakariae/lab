import { JetStreamClient, NatsConnection } from "nats";
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
 * Wraps local writes with CRDT operations.
 * In your app, instead of directly calling kv.put/delete from outside,
 * you expose these functions.
 */
export async function startLocalWatcher(ctx: LocalWatcherContext): Promise<void> {
  console.log("[local] watcher initialized (wrap API for local PUT/DELETE)");

  // For simplicity, we just attach helper methods on context (could also export them).
  (ctx as any).localPut = async (key: string, value: string) => {
    const op: Operation = {
      op: "put",
      bucket: ctx.bucket,
      key,
      value,
      ts: ctx.clock.tick(),
      nodeId: ctx.nodeId,
    };

    // Apply locally
    await ctx.kv.put(key, sc.encode(value));
    ctx.metadataStore.set(ctx.bucket, key, versionFromOp(op));

    // Publish operation
    const payload = sc.encode(JSON.stringify(op));
    if (ctx.jsCtx) {
      await ctx.jsCtx.publish(ctx.repSubject, payload);
    } else {
      ctx.nc.publish(ctx.repSubject, payload);
    }

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

    // Apply locally
    await ctx.kv.delete(key);
    ctx.metadataStore.set(ctx.bucket, key, versionFromOp(op));

    const payload = sc.encode(JSON.stringify(op));
    if (ctx.jsCtx) {
      await ctx.jsCtx.publish(ctx.repSubject, payload);
    } else {
      ctx.nc.publish(ctx.repSubject, payload);
    }

    console.log(`[local] delete ${key}, op published`);
  };

  console.log(
    "[local] use (ctx as any).localPut(key, value) and (ctx as any).localDelete(key) for local changes"
  );
}
