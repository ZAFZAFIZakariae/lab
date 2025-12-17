# NATS KV Syncd (TypeScript)

This repository implements **nats-kv-syncd**, a lightweight agent that keeps two
or more NATS Key/Value buckets convergent using a **Last-Writer-Wins (LWW) CRDT**
with tombstones and a Lamport logical clock. It follows the entregables
described in `NATSCRDT.pdf`:

- Source code for the agent.
- A `README.md` that explains how to run it, the CRDT logic, metadata handling,
  and test results.
- Helper scripts to exercise the flows.

## Prerequisites

- Node.js 18+ and `npm`
- Docker (to start local NATS servers quickly)
- Two NATS servers with JetStream enabled (see `docker/docker-compose.yml`)

## Quick start

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start two JetStream-capable NATS servers**

   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

3. **Create matching KV buckets on both servers** (default bucket name: `config`)

   ```bash
   nats kv add config --server localhost:4222
   nats kv add config --server localhost:5222
   ```

4. **Run the sync agents** (one per site)

   ```bash
   # Site A
   npm run dev:a

   # Site B
   npm run dev:b
   ```

   Each agent watches its local bucket, publishes CRDT operations to the
   replication subject (default `rep.kv.ops`), and applies remote operations that
   win under LWW rules.

5. **Validate** by writing conflicting values while one side is offline, then
   bringing it back—both buckets should converge per the LWW+nodeId tie-breaker
   using the logical clock timestamps.

## Helper scripts for manual testing

With both agents running, you can publish sample operations and inspect bucket
contents using the included npm scripts:

- Publish a dark theme preference from site A:

  ```bash
  npm run op:a:dark
  ```

- Publish a light theme preference from site B:

  ```bash
  npm run op:b:light
  ```

- Inspect each KV bucket (tombstones are shown explicitly):

  ```bash
  npm run kv:a
  npm run kv:b
  ```

These scripts help verify replication behavior while toggling values and
observing convergence across both sites.

## CRDT design (LWW register)

- **Operation shape** (`src/crdt/lww.ts`):
  - `op`: `"put"` or `"delete"`
  - `bucket`, `key`, `value`
  - `ts`: Lamport logical timestamp
  - `nodeId`: node identifier
- **Version tuple**: `{ ts, nodeId, tombstone }`
- **Win rule** (`wins`):
  1. Highest `ts` wins.
  2. On `ts` ties, lexicographically higher `nodeId` wins.
- **Deletes**: encoded as tombstones (`KV-Operation: DEL` header) so deletes are
  not resurrected.

### Logical clock

`src/crdt/clock.ts` implements a Lamport clock. Local events call `tick()`;
remote operations call `observe(op.ts)` to advance the counter before applying
the operation.

### Metadata storage

`InMemoryMetadataStore` (`src/crdt/metadataStore.ts`) tracks the winning version
per `(bucket, key)`. It is used to decide whether incoming operations beat the
local state.

## Replication flow

- **Local watcher** (`src/nats/kvWatcher.ts`): wraps local KV `put`/`delete`,
  stamps operations with the logical clock, applies them locally, stores
  metadata, and publishes to the replication subject.
- **Remote replication** (`src/nats/replication.ts`): subscribes (plain NATS or
  JetStream durable consumer), observes incoming timestamps, and applies only
  operations that win per LWW. Deletes publish tombstones.
- **Periodic reconciliation** (`src/nats/reconcile.ts`): optional state-based
  anti-entropy. It compares local and peer KV entries (including tombstones),
  builds synthetic operations stamped with the logical clock, and writes the
  winner to both sides to recover from lost messages.

## Configuration

`src/config.ts` defines CLI flags (see `npm run dev:a` / `npm run dev:b` for
examples):

- `--nats-url`, `--peer-nats-url`
- `--bucket`
- `--node-id`
- `--rep-subj`
- `--use-jetstream`
- `--reconcile-interval`

## Repository structure

- `NATSCRDT.pdf` — Lab specification and entregables reference.
- `package.json` — Scripts and dependencies.
- `tsconfig.json` — TypeScript configuration.
- `docker/docker-compose.yml` — Two JetStream-enabled NATS servers on ports
  4222 and 5222 for local testing.
- `src/index.ts` — Main entry point: loads config, starts NATS, KV bucket,
  metadata store, logical clock, replication subscriber, local watcher, and
  optional periodic reconciliation.
- `src/config.ts` — CLI options and defaults.
- `src/crdt/lww.ts` — LWW operation/version types and conflict resolution
  (`wins`, `versionFromOp`).
- `src/crdt/clock.ts` — Lamport logical clock implementation.
- `src/crdt/metadataStore.ts` — In-memory version tracking per `(bucket, key)`.
- `src/nats/connection.ts` — NATS/JetStream connections; lightweight KV facade
  with tombstone-aware `get`.
- `src/nats/kvWatcher.ts` — Wraps local writes to emit CRDT operations.
- `src/nats/replication.ts` — Applies remote operations (plain NATS or
  JetStream durable consumer).
- `src/nats/reconcile.ts` — State-based anti-entropy reconciliation using the
  logical clock and tombstones.
- `src/publishOp.ts` — Helper to publish a single logical-clocked `put`
  operation and write it to KV.
- `src/checkKv.ts` — Helper to list KV contents, showing tombstones explicitly.
- `node_modules/` — Local dependencies (ignored in git; install via
  `npm install`).
- `dist/` — Build output (ignored in git; generated by `npm run build`).

## How to run tests

```bash
npm run build
```

This compiles the TypeScript sources. (Add your preferred linters or unit tests
as needed.)
