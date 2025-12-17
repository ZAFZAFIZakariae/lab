export type OperationType = "put" | "delete";

export interface Operation {
  op: OperationType;
  bucket: string;
  key: string;
  value?: string;    // only for put
  ts: number;        // logical or physical timestamp
  nodeId: string;    // node_id (site)
}

export interface Version {
  ts: number;
  nodeId: string;
  tombstone?: boolean; // true if this is a delete
}

/**
 * Decide if the remote version wins over the local one following LWW:
 *
 * 1. If no local version → remote wins
 * 2. If ts_remote > ts_local → remote wins
 * 3. If ts_remote < ts_local → local wins
 * 4. If ts equal:
 *    - compare nodeId lexicographically
 *    - higher nodeId wins
 */
export function wins(remote: Version, local?: Version): boolean {
  if (!local) return true;

  if (remote.ts > local.ts) return true;
  if (remote.ts < local.ts) return false;

  // tie-breaker using nodeId
  return remote.nodeId > local.nodeId;
}

/**
 * Helper to create a Version object from an Operation
 */
export function versionFromOp(op: Operation): Version {
  return {
    ts: op.ts,
    nodeId: op.nodeId,
    tombstone: op.op === "delete",
  };
}
