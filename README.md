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
win under LWW rules. Local KV writes (CLI, app code, etc.) are detected via a
watcher on `$KV.<bucket>.>` and stamped with Lamport time + `nodeId`.

5. **Validate** by writing conflicting values while one side is offline, then
   bringing it back—both buckets should converge per the LWW+nodeId tie-breaker
   using the logical clock timestamps.

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

- **Local watcher** (`src/nats/kvWatcher.ts`): subscribes to `$KV.<bucket>.>`
  (ack-less, deliver-new) and emits CRDT operations for entries that do **not**
  carry the `KV-Origin` header. Writes from this agent include `KV-Origin` and
  `KV-Lamport` headers so the watcher avoids loops while preserving the logical
  timestamp inside KV.
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
  with tombstone-aware `get` and headers (`KV-Origin`, `KV-Lamport`) for
  metadata.
- `src/nats/kvWatcher.ts` — Watches local KV traffic and emits CRDT operations
  for origin-less events; exposes helpers for programmatic puts/deletes.
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

## Respuestas al cuestionario del PDF

- **¿Por qué los CRDT no necesitan consenso global?**  
  Las operaciones son conmutativas, asociativas e idempotentes; el orden exacto
  no importa siempre que todos apliquen la misma regla de desempate (LWW +
  `nodeId`). La convergencia se logra sin líder ni quórums.

- **Ventaja de desempatar por `nodeId`:**  
  Permite resolver colisiones de timestamp de forma determinista y estable, sin
  depender de relojes perfectamente sincronizados.

- **Relojes del sistema desincronizados:**  
  El Lamport lógico (`KV-Lamport`) solo depende de la observación de eventos;
  crece al recibir/enviar operaciones y no requiere sincronización de reloj de
  pared.

- **Replicación por operaciones vs. por estado:**  
  El log `rep.kv.ops` mantiene la intención y reduce tráfico; la reconciliación
  por estado (`reconcile.ts`) sirve como red de seguridad cuando faltan
  operaciones (p. ej. purga de stream o nodos apagados).

- **Idempotencia de una actualización CRDT:**  
  El par `{ts, nodeId}` almacenado en metadata y headers identifica unívocamente
  la versión; re-aplicar la misma operación no cambia el resultado si no gana
  según `wins`.

- **¿Por qué combinar JetStream con reconciliación periódica?**  
  JetStream ofrece durabilidad y reentrega, pero si un consumidor estuvo
  desconectado demasiado tiempo o se perdieron mensajes, la reconciliación
  periódica vuelve a alinear buckets sin intervención manual.

- **Pruebas para demostrar convergencia tras partición:**  
  Simular desconexión (apagar `nats-b`), escribir valores distintos en `config`
  de cada sitio, reencender `nats-b` y verificar con `ts-node src/checkKv.ts`
  que ambos convergen al valor LWW. Repetir con un `delete` para comprobar que
  los tombstones no se resucitan.

- **Diferencias frente a cr-sqlite:**  
  cr-sqlite integra CRDTs en SQLite con persistencia transaccional; aquí usamos
  un log NATS/JetStream y un store en memoria. La convergencia es eventual y no
  hay MVCC ni consultas SQL; el foco es la replicación ligera de KV.
