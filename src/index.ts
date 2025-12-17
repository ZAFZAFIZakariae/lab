import { loadConfigFromCli } from "./config";
import { connectToNats, createKvBucket, createJetStreamCtx } from "./nats/connection";
import { startLocalWatcher } from "./nats/kvWatcher";
import { startReplicationSubscriber } from "./nats/replication";
import { InMemoryMetadataStore } from "./crdt/metadataStore";
import { startPeriodicReconciliation } from "./nats/reconcile";
import { LogicalClock } from "./crdt/clock";

async function main() {
  const config = loadConfigFromCli();
  console.log("[config]", config);

  // Connect to local NATS
  const nc = await connectToNats(config.natsUrl);
  console.log(`[nats] connected to ${config.natsUrl}`);

  const { kv } = await createKvBucket(nc, config.bucket);
  console.log(`[kv] using bucket '${config.bucket}'`);

  const jsCtx = config.useJetStream ? await createJetStreamCtx(nc) : undefined;

  // Metadata CRDT store
  const metadataStore = new InMemoryMetadataStore();
  const clock = new LogicalClock();

  // Start local watcher → publishes operations for local changes
  await startLocalWatcher({
    nc,
    jsCtx,
    kv,
    bucket: config.bucket,
    nodeId: config.nodeId,
    repSubject: config.repSubject,
    metadataStore,
    clock,
  });

  // Start replication subscriber → applies remote operations
  await startReplicationSubscriber({
    nc,
    jsCtx,
    kv,
    bucket: config.bucket,
    nodeId: config.nodeId,
    repSubject: config.repSubject,
    metadataStore,
    clock,
  });

  // Optional periodic reconciliation (state-based)
  if (config.reconcileIntervalMs && config.reconcileIntervalMs > 0 && config.peerNatsUrl) {
    await startPeriodicReconciliation({
      localNatsUrl: config.natsUrl,
      peerNatsUrl: config.peerNatsUrl,
      bucket: config.bucket,
      nodeId: config.nodeId,
      intervalMs: config.reconcileIntervalMs,
      clock,
    });
  } else {
    console.log("[reconcile] periodic reconciliation disabled (no interval or no peer url)");
  }

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("Caught SIGINT, closing NATS connection...");
    nc.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
