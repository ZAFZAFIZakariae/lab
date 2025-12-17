import { connectToNats, createKvBucket, sc } from "./nats/connection";
import { Operation } from "./crdt/lww";
import { LogicalClock } from "./crdt/clock";

async function main() {
  const [, , natsUrl, key, value, nodeId] = process.argv;

  if (!natsUrl || !key || !value || !nodeId) {
    console.log("Usage: ts-node src/publishOp.ts <nats-url> <key> <value> <node-id>");
    process.exit(1);
  }

  const nc = await connectToNats(natsUrl);
  console.log("[publishOp] connected to", natsUrl);

  const clock = new LogicalClock();

  // 1) Write to local KV bucket "config"
  const { kv } = await createKvBucket(nc, "config");
  await kv.put(key, sc.encode(value));
  console.log(`[publishOp] wrote to KV: ${key}=${value}`);

  // 2) Publish CRDT operation on rep.kv.ops
  const op: Operation = {
    op: "put",
    bucket: "config",
    key,
    value,
    ts: clock.tick(),   // LWW logical timestamp
    nodeId,
  };

  const json = JSON.stringify(op);
  nc.publish("rep.kv.ops", sc.encode(json));
  await nc.flush();

  console.log("[publishOp] sent op:", json);

  nc.close();
}

main().catch((err) => {
  console.error("[publishOp] error:", err);
  process.exit(1);
});
