import {
  connect,
  NatsConnection,
  StringCodec,
  JetStreamManager,
  JetStreamClient,
  RetentionPolicy,
  headers,
} from "nats";

export const sc = StringCodec();

/**
 * Connect to NATS
 */
export async function connectToNats(url: string): Promise<NatsConnection> {
  return await connect({ servers: url });
}

/**
 * Minimal KV-like interface our code uses.
 */
export interface KvEntry {
  value: Uint8Array | null;
  isTombstone: boolean;
  origin?: string;
  ts?: number;
  revision?: number;
}

export interface KvWriteOptions {
  origin?: string;
  timestamp?: number;
}

export interface KvLike {
  bucket: string;
  put(key: string, value: Uint8Array, opts?: KvWriteOptions): Promise<void>;
  get(key: string): Promise<KvEntry | null>;
  delete(key: string, opts?: KvWriteOptions): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Create a KV bucket using a JetStream stream.
 * We emulate KV on top of a stream named "KV_<bucketName>".
 */
export async function createKvBucket(
  nc: NatsConnection,
  bucketName: string
): Promise<{ kv: KvLike }> {
  const js: JetStreamClient = nc.jetstream();
  const jsm: JetStreamManager = await nc.jetstreamManager();

  const streamName = `KV_${bucketName}`;

  // Ensure stream exists
  try {
    await jsm.streams.info(streamName);
  } catch {
    await jsm.streams.add({
      name: streamName,
      subjects: [`$KV.${bucketName}.>`],
      retention: RetentionPolicy.Limits,
      max_msgs_per_subject: 1,
    });
  }

  const kv: KvLike = {
    bucket: bucketName,

    // Publish a value for the key
    async put(key: string, value: Uint8Array, opts?: KvWriteOptions): Promise<void> {
      const h = headers();
      if (opts?.origin) h.set("KV-Origin", opts.origin);
      if (opts?.timestamp !== undefined) h.set("KV-Lamport", String(opts.timestamp));
      await js.publish(`$KV.${bucketName}.${key}`, value, { headers: h });
    },

    // Get the latest value for the key (if any)
    async get(key: string): Promise<KvEntry | null> {
      try {
        const msg = await jsm.streams.getMessage(streamName, {
          last_by_subj: `$KV.${bucketName}.${key}`,
        });
        const kvOperation = msg.header?.get("KV-Operation");
        const isTombstone = kvOperation === "DEL";
        const origin = msg.header?.get("KV-Origin") ?? undefined;
        const tsHeader = msg.header?.get("KV-Lamport");
        const ts = tsHeader ? Number(tsHeader) : msg.seq;
        return {
          value: isTombstone ? null : msg.data,
          isTombstone,
          origin,
          ts,
          revision: msg.seq,
        };
      } catch {
        // If no message exists for that subject, just return null
        return null;
      }
    },

    // "Delete" by publishing a tombstone (header)
    async delete(key: string, opts?: KvWriteOptions): Promise<void> {
      const h = headers();
      h.set("KV-Operation", "DEL");
      if (opts?.origin) h.set("KV-Origin", opts.origin);
      if (opts?.timestamp !== undefined) h.set("KV-Lamport", String(opts.timestamp));
      await js.publish(`$KV.${bucketName}.${key}`, new Uint8Array(), {
        headers: h,
      });
    },

    // List all keys by scanning stream messages
    async keys(): Promise<string[]> {
      const info = await jsm.streams.info(streamName);
      const maxSeq = info.state.last_seq;
      const keySet = new Set<string>();

      for (let seq = 1; seq <= maxSeq; seq++) {
        try {
          const msg = await jsm.streams.getMessage(streamName, { seq });
          const subj = msg.subject;
          const prefix = `$KV.${bucketName}.`;
          if (subj.startsWith(prefix)) {
            const k = subj.substring(prefix.length);
            keySet.add(k);
          }
        } catch {
          // message might have been deleted/purged; ignore
        }
      }

      return Array.from(keySet);
    },
  };

  return { kv };
}

/**
 * Create JetStream client context.
 */
export async function createJetStreamCtx(
  nc: NatsConnection
): Promise<JetStreamClient> {
  return nc.jetstream();
}
