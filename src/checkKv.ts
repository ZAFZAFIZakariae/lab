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
    const entry = await kv.get(key);
    if (!entry) {
      console.log(`- ${key} = <missing>`);
      continue;
    }

    const decoded = entry.isTombstone
      ? "<tombstone>"
      : sc.decode(entry.value ?? new Uint8Array());
    console.log(`- ${key} = ${decoded}`);
  }

  nc.close();
}

main().catch((err) => {
  console.error("[checkKv] error:", err);
  process.exit(1);
});
