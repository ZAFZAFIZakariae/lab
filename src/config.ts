import { Command } from "commander";

export interface AppConfig {
  natsUrl: string;
  peerNatsUrl?: string;
  bucket: string;
  nodeId: string;
  repSubject: string;
  useJetStream: boolean;
  reconcileIntervalMs?: number;
}

export function loadConfigFromCli(): AppConfig {
  const program = new Command();

  program
    .name("nats-kv-syncd")
    .description("Sync NATS KV buckets using LWW CRDT")
    .option("--nats-url <url>", "NATS server URL", "nats://localhost:4222")
    .option("--peer-nats-url <url>", "Peer NATS server URL (for reconciliation)")
    .option("--bucket <bucket>", "KV bucket name", "config")
    .option("--node-id <id>", "Node ID (site identifier)", "site-a")
    .option("--rep-subj <subject>", "Replication subject", "rep.kv.ops")
    .option("--use-jetstream", "Use JetStream for durable replication", false)
    .option(
      "--reconcile-interval <ms>",
      "Reconciliation interval in milliseconds (0 = disabled)",
      "60000"
    );

  program.parse(process.argv);

  const opts = program.opts<{
    natsUrl: string;
    peerNatsUrl?: string;
    bucket: string;
    nodeId: string;
    repSubj: string;
    useJetstream?: boolean;
    reconcileInterval: string;
  }>();

  const reconcileIntervalMs = parseInt(opts.reconcileInterval, 10);
  return {
    natsUrl: opts.natsUrl,
    peerNatsUrl: opts.peerNatsUrl,
    bucket: opts.bucket,
    nodeId: opts.nodeId,
    repSubject: opts.repSubj,
    useJetStream: !!opts.useJetstream,
    reconcileIntervalMs: Number.isNaN(reconcileIntervalMs)
      ? undefined
      : reconcileIntervalMs,
  };
}
