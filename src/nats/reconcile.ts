import { connectToNats, createKvBucket, KvEntry, KvLike, sc } from "./connection";
import { Operation, versionFromOp, wins } from "../crdt/lww";
import { LogicalClock } from "../crdt/clock";

export interface PeriodicReconcileConfig {
  localNatsUrl: string;
  peerNatsUrl: string;
  bucket: string;
  nodeId: string;
  intervalMs: number;
  clock: LogicalClock;
}

export async function startPeriodicReconciliation(
  cfg: PeriodicReconcileConfig
): Promise<void> {
  console.log(
    `[reconcile] starting periodic reconciliation every ${cfg.intervalMs}ms with peer ${cfg.peerNatsUrl}`
  );

  setInterval(async () => {
    try {
      await reconcileOnce(cfg);
    } catch (err) {
      console.error("[reconcile] error during reconciliation:", err);
    }
  }, cfg.intervalMs);
}

/**
 * Very simplified reconciliation:
 * - Get all keys from local and peer KV
 * - For each key, fetch values from both sides
 * - Create pseudo-Operations with timestamps
 * - Apply LWW and update both KV to winner
 *
 * NOTE: This is for demonstration. For a more exact reconciliation, you’d
 * use stored metadata (Versions) instead of fresh timestamps.
 */
async function reconcileOnce(cfg: PeriodicReconcileConfig): Promise<void> {
  console.log("[reconcile] running reconciliation cycle...");

  const localNc = await connectToNats(cfg.localNatsUrl);
  const peerNc = await connectToNats(cfg.peerNatsUrl);

  try {
    const { kv: localKv } = await createKvBucket(localNc, cfg.bucket);
    const { kv: peerKv } = await createKvBucket(peerNc, cfg.bucket);

    const localKeys = await localKv.keys();
    const peerKeys = await peerKv.keys();

    const allKeys = new Set<string>([...localKeys, ...peerKeys]);

    for (const key of allKeys) {
      await reconcileKey(cfg, key, localKv, peerKv);
    }

    console.log("[reconcile] cycle completed");
  } finally {
    localNc.close();
    peerNc.close();
  }
}

async function reconcileKey(
  cfg: PeriodicReconcileConfig,
  key: string,
  localKv: KvLike,
  peerKv: KvLike
): Promise<void> {
  const [localEntry, peerEntry] = await Promise.all([
    localKv.get(key),
    peerKv.get(key),
  ]);

  const localOp = buildOpFromEntry(localEntry, cfg, key, cfg.nodeId + "-local");
  const peerOp = buildOpFromEntry(peerEntry, cfg, key, cfg.nodeId + "-peer");

  if (!localOp && !peerOp) {
    return; // nothing to do
  }

  if (localOp && !peerOp) {
    await applyOpToKv(peerKv, localOp);
    return;
  }

  if (!localOp && peerOp) {
    await applyOpToKv(localKv, peerOp);
    return;
  }

  // both have values → LWW decision (here they have same ts, so nodeId decides)
  const localVersion = versionFromOp(localOp!);
  const peerVersion = versionFromOp(peerOp!);

  const remoteWins = wins(peerVersion, localVersion);
  const winnerOp = remoteWins ? peerOp! : localOp!;

  await applyOpToKv(localKv, winnerOp);
  await applyOpToKv(peerKv, winnerOp);
}

function buildOpFromEntry(
  entry: KvEntry | null,
  cfg: PeriodicReconcileConfig,
  key: string,
  nodeId: string
): Operation | null {
  if (!entry) return null;

  const ts = cfg.clock.tick();

  if (entry.isTombstone) {
    return {
      op: "delete",
      bucket: cfg.bucket,
      key,
      ts,
      nodeId,
    };
  }

  if (!entry.value) return null;

  return {
    op: "put",
    bucket: cfg.bucket,
    key,
    value: sc.decode(entry.value),
    ts,
    nodeId,
  };
}

async function applyOpToKv(kv: KvLike, op: Operation): Promise<void> {
  if (op.op === "delete") {
    await kv.delete(op.key);
    return;
  }

  await kv.put(op.key, sc.encode(op.value!));
}
