import { connectToNats, createKvBucket, KvLike, sc } from "./connection";
import { Operation, versionFromOp, wins, nowTs } from "../crdt/lww";

export interface PeriodicReconcileConfig {
  localNatsUrl: string;
  peerNatsUrl: string;
  bucket: string;
  nodeId: string;
  intervalMs: number;
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
  const [localVal, peerVal] = await Promise.all([
    localKv.get(key),
    peerKv.get(key),
  ]);

  // Build pseudo-ops. In a better version, you would load real ts/nodeId from metadata.
  const now = nowTs();

  const localOp: Operation | null = localVal
    ? {
        op: "put",
        bucket: cfg.bucket,
        key,
        value: sc.decode(localVal),
        ts: now,
        nodeId: cfg.nodeId + "-local", // differentiate
      }
    : null;

  const peerOp: Operation | null = peerVal
    ? {
        op: "put",
        bucket: cfg.bucket,
        key,
        value: sc.decode(peerVal),
        ts: now,
        nodeId: cfg.nodeId + "-peer",
      }
    : null;

  if (!localOp && !peerOp) {
    return; // nothing to do
  }

  if (localOp && !peerOp) {
    // only local has value → push to peer
    await peerKv.put(key, sc.encode(localOp.value!));
    return;
  }

  if (!localOp && peerOp) {
    // only peer has value → pull to local
    await localKv.put(key, sc.encode(peerOp.value!));
    return;
  }

  // both have values → LWW decision (here they have same ts, so nodeId decides)
  const localVersion = versionFromOp(localOp!);
  const peerVersion = versionFromOp(peerOp!);

  const remoteWins = wins(peerVersion, localVersion);
  const winnerOp = remoteWins ? peerOp! : localOp!;
  const winnerVal = winnerOp.value!;

  await localKv.put(key, sc.encode(winnerVal));
  await peerKv.put(key, sc.encode(winnerVal));
}
