# Brain + brain-caller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `brain` (the Knowledge Graph service, one executable) and `brain-caller` (the agent CLI with SCIP code ingestion), then onboard one DAT team with them.

**Architecture:** `brain` is an Effect HTTP server on Bun backed by Postgres (embedded PGlite + pgvector, or external via `BRAIN_DATABASE_URL`), with an in-process ONNX embedder running as a background worker. `brain-caller` is a thin Effect CLI over the HTTP API plus the code-indexer workflow, which decodes SCIP protobuf itself.

**Tech Stack:** Bun 1.4, TypeScript, effect 4.0.2 (`effect/http`, `effect/sql`, `effect/cli`, `effect/Schema`), effect-qb 0.24.1, @effect/sql-pglite / @effect/sql-pg 4.0.2, @electric-sql/pglite 0.5.8 + pglite-pgvector 0.0.9, onnxruntime-web 1.30.0, @huggingface/tokenizers 0.2.0, bge-small-en-v1.5 (int8 ONNX).

**Spec:** `../design-session/2026-10-11-jive-knowledge-graph-design-r4.md` (rev 4). Section numbers below refer to it.

## Global Constraints

- All `@effect/*` packages pinned to 4.0.2 with `"overrides": { "@effect/platform-node-shared": "4.0.2" }` (4.0.3 needs an unpublished `effect`).
- Every interface method: `POST /v1/<method>`, one JSON object in, one JSON value out, `Authorization: Bearer <key>` (§6.1).
- Error body `{ "error": { "code", "message", "details"? } }` with the §5.2 code→status table.
- Batch limits 5,000 facts / 5,000 entities / 5,000 retractions, 32 MB body (§5.1).
- Defaults: getEntity 50+50; listFacts limit 50 max 500; search limit 20 max 100, top 100 per list, RRF k=60; neighbors depth 1 max 3, limit 50 max 500.
- Embedding: 384-dim, query prefix `Represent this sentence for searching relevant passages: `, CLS pooling, L2 normalized, async worker.
- `brain-caller` imports brain's contract with `import type` only (one runtime copy of `effect` per executable).
- Executables: `brain/dist/brain`, `brain-caller/dist/brain-caller`, built with `bun build --compile`.

## Review Focus

1. **Huge SCIP batches**: a repo producing >5,000 facts must ingest via multiple batches without exceeding limits; ingest-code test with batch size forced to 2 checks it.
2. **Re-running ingest-code on an unchanged repo** must write nothing; test asserts zero creates/updates/retracts on the second run.
3. **Concurrent writes to the same fact** must give one success and one `CONFLICT`, never two revisions from the same base; write test fires two updates in parallel.
4. **Search before the embedding worker catches up** must still return exact-name and full-text hits; search test runs with the worker paused.
5. **Unicode and odd identifiers in SCIP symbols** (escaped backticks, spaces doubled) must parse to entities without crashing; symbol parser test includes `` `weird name` `` and doubled spaces.

---

## File Structure

```text
brain/
  src/contract.ts        Effect Schemas + TS types for §4–§5 (requests, responses, errors)
  src/errors.ts          BrainError(code, message, details) + HTTP status map
  src/db/assets.ts       embedded PGlite/pgvector assets (Bun `with { type: "file" }`)
  src/db/client.ts       Db layer: PGlite (dataDir) or Pg (BRAIN_DATABASE_URL); runs migrations
  src/db/migrations.ts   DDL for §6.2 as SQL statements
  src/db/tables.ts       effect-qb Table definitions for §6.2
  src/embed/assets.ts    embedded model, tokenizer, ORT wasm
  src/embed/Embedder.ts  Embedder service: embedDocs(texts), embedQuery(text); Real + Fake layers
  src/embed/worker.ts    background fiber filling fact_embeddings
  src/kg/text.ts         fact text builder (§6.3)
  src/kg/views.ts        staleness computation + FactView assembly (§4.3, §6.4)
  src/kg/write.ts        write (§5.1)
  src/kg/read.ts         getEntity, getFact, listFacts
  src/kg/search.ts       search (§6.3)
  src/kg/neighbors.ts    neighbors
  src/kg/sources.ts      sourceChanged
  src/admin.ts           registerWriter, rotateKey, listWriters, revertWriter, auth lookup
  src/http.ts            routes, auth, error mapping, /health
  src/main.ts            config + launch
  test/*.test.ts
brain-caller/
  src/client.ts          HTTP client: call(method, body) → JSON | BrainError
  src/main.ts            effect/cli commands (§8)
  src/scip/wire.ts       protobuf wire-format reader
  src/scip/decode.ts     SCIP Index/Document/Occurrence/SymbolInformation decoder
  src/scip/symbol.ts     symbol string parser (descriptors, qualified name, parent)
  src/scip/toFacts.ts    index + blobs → desired entities/facts (§8.1 tables)
  src/ingest/indexers.ts language detection + indexer commands
  src/ingest/ingestCode.ts the §8.1 workflow (diff + batched writes)
  SKILL.md               how an agent uses brain-caller
  test/*.test.ts
```

## Tasks

### Task 1: Database layer and migrations

**Files:** Create `brain/tsconfig.json`, `brain/src/db/{assets,client,migrations,tables}.ts`, `brain/test/db.test.ts`.

**Interfaces — Produces:** `Db.layer(config: { dataDir?: string; databaseUrl?: string }): Layer<SqlClient>` (runs migrations once, idempotent); tables `writers, writes, entities, entityHistory, facts, factRevisions, factSources, factBasedOn, factContradicts, sourceReports, factEmbeddings` as effect-qb tables with snake_case casing.

- [ ] Test `migrations apply twice on memory PGlite`: provide `Db.layer({ dataDir: "memory://" })` twice in sequence on the same dir → no error; `select extname from pg_extension` contains `vector`.
- [ ] Implement; `fact_revisions.tsv` is `tsvector` generated from `text`; `fact_embeddings.embedding vector(384)` with HNSW cosine index; partial indexes on current revisions via `facts.current_revision` join.
- [ ] Run `bun test test/db.test.ts` → PASS. Commit.

### Task 2: Contract, errors, writers and auth

**Files:** Create `brain/src/{contract,errors,admin}.ts` (admin: register/rotate/list/authenticate only), `brain/test/admin.test.ts`.

**Interfaces — Produces:** Schemas `Entity, Source, Fact, FactView, WriteRequest, …` and `type` exports; `class BrainError { code: ErrorCode; message: string; details?: unknown }`; `Admin.registerWriter({writerId, allowedBases}) → { writerId, apiKey }`, `Admin.authenticate(key) → Writer` (fails `UNAUTHENTICATED`).

- [ ] Tests: register returns a 64-hex-char key; authenticate(key) returns the writer with its bases; authenticate("nope") fails `UNAUTHENTICATED`; registering an existing id fails `INVALID_INPUT`; rotateKey invalidates the old key.
- [ ] Implement (SHA-256 key hashes). Run tests → PASS. Commit.

### Task 3: write

**Files:** Create `brain/src/kg/{text,write}.ts`, `brain/test/write.test.ts`.

**Interfaces — Consumes:** Task 1 tables, Task 2 `Writer`. **Produces:** `write(writer: Writer, batch: WriteRequest) → WriteResult`.

- [ ] Tests (each asserts the error code or stored rows):
  - creates entity + fact; returned `{ id, revision }`; `fact.writer` = caller.
  - entity rewrite merges aliases (`["A"]` then `["B"]` → `["A","B"]`), replaces name; unchanged rewrite adds no entity_history row.
  - fact with unknown subject → `INVALID_INPUT`; subject created in same batch → OK.
  - no sources and no basedOn → `INVALID_INPUT`; both object and value → `INVALID_INPUT`.
  - update with stale revision → `CONFLICT`; other writer's fact → `NOT_OWNER`; unknown id → `NOT_FOUND`.
  - basis not in writer's allowed bases → `BASIS_NOT_ALLOWED`.
  - `{ key }` references resolve within the batch; duplicate key → `INVALID_INPUT`.
  - self basedOn → `INVALID_INPUT`; fact-level cycle A→B then update A basedOn B → `INVALID_INPUT`.
  - any failing item rolls back the whole batch (entity from the same batch absent afterwards).
  - two parallel updates from the same revision → exactly one `CONFLICT` (Review Focus 3).
  - batch over 5,000 facts → `INVALID_INPUT`.
- [ ] Implement inside one transaction; lock current revisions `for update` when updating. Run → PASS. Commit.

### Task 4: Staleness, sourceChanged, views

**Files:** Create `brain/src/kg/{views,sources}.ts`, `brain/test/staleness.test.ts`.

**Interfaces — Produces:** `factViews(revisionIds: string[]) → FactView[]` (same order), `staleSet(): Set<factId>` for staleOnly listing, `sourceChanged(writer, {ref, version}) → { newlyStale }`.

- [ ] Tests: unreported ref → fresh; report different version → stale with `staleBecause[0] = { ref, citedVersion, latestVersion }`, `newlyStale` 1; report same version again → `newlyStale` 0; C basedOn B basedOn A(source) → A,B,C stale after A's ref changes, C's reason `{factId: B, reason: "stale"}`; retract B → C `{reason:"retracted"}`; update B → C `{reason:"revised"}`; writer updates A to cite new version → A fresh, B still revised-stale; `contradictedBy` lists active contradictor only.
- [ ] Implement with recursive CTEs that track visited fact ids. Run → PASS. Commit.

### Task 5: Reads

**Files:** Create `brain/src/kg/read.ts`, `brain/test/read.test.ts`.

- [ ] Tests: getEntity unknown → null; `about`/`pointingHere` newest first, capped at 50 with `moreAbout` true at 51; getFact includes `basedOn`, `supports`, `contradictions` (both directions), `history` oldest first; getFact on retracted fact returns status retracted; listFacts filters AND together; `sourceRefPrefix` works; `staleOnly`; cursor paging over 120 facts with limit 50 returns 50/50/20 with no duplicates; limit 501 → `INVALID_INPUT`.
- [ ] Implement. Run → PASS. Commit.

### Task 6: Embedder, worker, search

**Files:** Create `brain/src/embed/{assets,Embedder,worker}.ts`, `brain/src/kg/search.ts`, `brain/test/search.test.ts`, `brain/test/embedder.test.ts`.

**Interfaces — Produces:** `Embedder` service `{ dims: 384; embedDocs(texts): number[][]; embedQuery(text): number[] }` with `Embedder.Real` and `Embedder.Fake` (deterministic bag-of-words hash vectors) layers; `EmbedWorker.drain(): Effect<number>` (embeds all pending, returns count) and a forked loop.

- [ ] Tests: Real embedder: "who is on call for pricing outages?" ranks "Pricing Platform team supports the Rate Engine" above three distractors. Search: exact entity match on alias, case-insensitive; FTS hit before drain (Review Focus 4); paraphrase hit after `drain()` with Real embedder; retracted facts excluded; stale facts flagged; entity rename updates fact text (old name no longer FTS-matches, new name does).
- [ ] Implement. Run → PASS. Commit.

### Task 7: neighbors and revertWriter

**Files:** Create `brain/src/kg/neighbors.ts`, extend `brain/src/admin.ts`, `brain/test/{neighbors,revert}.test.ts`.

- [ ] neighbors tests: a→b→c with depth 2 returns paths [a→b], [a→b→c]; `direction: "in"` from c returns c←b; cycle a→b→a never revisits a; predicates filter; limit 1 → `truncated: true`; value facts ignored.
- [ ] revert tests: writer W creates F1 before T and updates it after T, creates F2 after T, reports a source after T; `revertWriter(W, T)` → F1 content equals pre-T revision with owner W, F2 retracted (reason `reverted`), source report reverted (fact citing old version fresh again), `writes` row actor `admin`.
- [ ] Implement. Run → PASS. Commit.

### Task 8: HTTP server, config, executable

**Files:** Create `brain/src/{http,main}.ts`, `brain/test/http.test.ts`, `brain/README.md`, `brain/Dockerfile`.

- [ ] Tests via `BunHttpServer.layerTest`: no auth → 401 `UNAUTHENTICATED`; bad JSON → 400 `INVALID_INPUT`; `/v1/nope` → 404; full round trip write → getEntity; admin endpoint with writer key → 401; `/health` returns `{ ok: true, pendingEmbeddings }`.
- [ ] `main.ts` config: `BRAIN_PORT` (default 8787), `BRAIN_DATA_DIR` (default `./.brain-data`), `BRAIN_DATABASE_URL`, `BRAIN_ADMIN_KEY`, `BRAIN_EMBEDDER` (`local` default, `none` for tests).
- [ ] `bun run build` → `dist/brain`; run it from `/` with a temp data dir; curl `/health` → ok. Commit.

### Task 9: brain-caller CLI

**Files:** Create `brain-caller/{package.json,tsconfig.json,src/client.ts,src/main.ts}`, `brain-caller/test/cli.test.ts`, `brain-caller/SKILL.md`.

- [ ] Tests (spawn `bun run src/main.ts` against a test brain on an ephemeral port): `search` prints JSON with `entities`/`facts`; `write` from stdin; error prints §5.2 JSON on stderr and exits 1; `list-facts --all` follows cursors.
- [ ] Implement with `effect/cli` and `effect/http` FetchHttpClient. Commit.

### Task 10: SCIP decoding and fact generation

**Files:** Create `brain-caller/src/scip/{wire,decode,symbol,toFacts}.ts`, `brain-caller/test/scip.test.ts`.

**Interfaces — Produces:** `decodeIndex(bytes: Uint8Array): ScipIndex`; `parseSymbol(s) → { local: boolean; descriptors: Descriptor[] } `; `qualifiedName(sym)`, `parentSymbol(sym)`; `toFacts(index, { repo, blobs: Map<path, sha>, fileLines: (path) => string[] }) → { entities: Entity[]; facts: DesiredFact[] }` where `DesiredFact` is a write item plus a stable `fingerprint`.

- [ ] Tests: decode a real `index.scip` produced by `scip-typescript` on a 3-file fixture → documents, occurrences, symbol infos; `parseSymbol` on `` scip-typescript npm pkg 1.0.0 src/`a b.ts`/Foo#bar(). `` (Review Focus 5); toFacts produces exactly one `code:defined-in` per defined global symbol, `code:references` aggregated per (enclosing, target, file), no local symbols, each fact citing `git:<repo>:<path>` with the file's blob.
- [ ] Implement. Commit.

### Task 11: ingest-code workflow

**Files:** Create `brain-caller/src/ingest/{indexers,ingestCode}.ts`, `brain-caller/test/ingest.test.ts`.

- [ ] Tests against a test brain and a temp git repo fixture: first run creates N facts; second run with no changes writes nothing (Review Focus 2); editing one file → `sourceChanged` for that file only, its facts updated, a human-asserted fact by another writer citing that file becomes stale; deleting a file retracts its facts; batch size forced to 2 still completes (Review Focus 1).
- [ ] Implement. Commit.

### Task 12: Build, onboard, evaluate

- [ ] Build both executables; write `brain/README.md` (run, config, admin bootstrap) and `brain-caller/SKILL.md`.
- [ ] Start `dist/brain` with a persistent data dir; register writers `workflow/code-indexer` (`compiler-derived`) and `claude/onboarding` (`imported`, `model-inferred`, `human-asserted`).
- [ ] Ingest the repos in `~/github.com/DAT` (when present) with `ingest-code`; record fact volume and time per repo.
- [ ] Ingest the Velocadapter (TeamVA) Confluence space per §8.2.
- [ ] Ask the §9 question set through `brain-caller` only; record answer quality; fix design defects by writing a new design revision and changing the code.
