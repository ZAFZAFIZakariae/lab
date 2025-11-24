import { connectToNats, createKvBucket, sc } from "./nats/connection";

async function main() {
  const [, , natsUrl] = process.argv;

  if (!natsUrl) {
    console.log("Usage: ts-node src/checkKv.ts <nats-url>");
    process.exit(1);
  }

  const nc = await connectToNats(natsUrl);
  console.log("[checkKv] connected to", natsUrl);

  const { kv } = await createKvBucket(nc, "config");

  const keys = await kv.keys();

  console.log(`[checkKv] KV bucket 'config' contains:`);

  for (const key of keys) {
    const value = await kv.get(key);
    const decoded = value ? sc.decode(value) : "<null>";
    console.log(`- ${key} = ${decoded}`);
  }

  nc.close();
}

main().catch((err) => {
  console.error("[checkKv] error:", err);
  process.exit(1);
});
