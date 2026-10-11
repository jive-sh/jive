# Jive Knowledge Graph — Design

**Status:** Draft for review, revision 3 · **Date:** 2026-10-11 · **Author:** Alex Leung (with Claude)
**Supersedes:** revision 2 and `jive-memory-agent-handoff.md`. Changes are listed in Appendix A.

---

## 1. Summary

Each Jive project has one **brain**: a store of sourced facts about everything in the project, from code to customers. Workflows write facts into it and agents query it.

**The brain stores sourced facts. Workflows keep it true.** The brain never contacts Slack, git, Confluence, or anything else. Jive's other interfaces and workflows do that, and they tell the brain what they learn.

## 2. How it fits into Jive

A Jive user builds workflows and wires interfaces into them. The Knowledge Graph is one interface, alongside Message Board and Task Board. Agents call the interfaces' methods.

```text
Workflow  ──calls──▶  KnowledgeGraph interface  ──implemented by──▶  Convex component
                                                                       │ HTTP
                                                                       ▼
                                                                  brain service ── Postgres
```

Example: a meeting-summary workflow, with MessageBoard (Slack) and KnowledgeGraph wired in.

1. Triggered by a new transcript posted in `#meeting-transcripts`.
2. The agent reads the transcript through MessageBoard.
3. `search("Acme")` finds the existing `customer/acme` entity, so the agent reuses it instead of creating a duplicate.
4. `getEntity("customer/acme")` shows what's already known.
5. `write(...)` adds new facts citing the transcript message and quoting it. Where the meeting contradicts an existing fact, the new fact lists it in `contradicts`.
6. The agent posts a summary through MessageBoard.

Example: a code workflow, triggered by a commit to a tracked repo.

1. For each changed file, call `sourceChanged("git:dat/rate-engine:src/retry.ts", "<new blob sha>")`. Every fact citing the old version is now stale.
2. Run the SCIP indexer on the commit and `write` the resulting code facts (§4.4), retracting this workflow's previous facts for the changed files.
3. Facts other workflows wrote about that code are now stale too. Each workflow finds its own with `listFacts({ writer: <itself>, staleOnly: true })` the next time it runs, and updates or retracts them.

## 3. Requirements

| # | Requirement |
|---|---|
| R1 | One brain per project. Code and business knowledge live in one graph. |
| R2 | Every fact records its sources, how it was derived, who wrote it, and when. |
| R3 | When a source changes, every fact that depends on it, directly or through other facts, is flagged stale. The brain flags; workflows fix. |
| R4 | Conflicting facts coexist with their evidence. The brain never decides which is true. |
| R5 | Code structure comes from a compiler (SCIP), not an LLM. |
| R6 | A writer can change only its own facts. All history is kept, and one writer's changes can be reverted. |
| R7 | Search finds things by exact name and by meaning. |
| R8 | The brain never contacts external systems. |
| R9 | A new implementer can read this document and build it. |

**Non-goals:** read permissions (everyone using a project can read its whole brain), claim categories such as "intended" versus "current" (writers phrase claims accurately and readers judge), and source types (the brain treats every source as an opaque reference plus a version).

## 4. Data model

### 4.1 Entities

An entity is anything facts can be about: a person, team, customer, service, decision, function, and so on.

```typescript
interface Entity {
  id: EntityId;       // stable, never changes. Examples: "customer/acme", "scip:<SCIP symbol>"
  type: string;       // free text. Examples: "person", "service", "function"
  name: string;
  aliases: string[];  // other names, used by exact-name search
}
```

Any writer may create an entity or update its name and aliases. Entity changes are kept in history. IDs are chosen by writers. By convention, written entities use `<type>/<slug>`, and code symbols use `scip:` plus their SCIP symbol string.

### 4.2 Facts

A fact is one claim about one subject entity. It either links to another entity (`object`) or states a value (`value`).

```typescript
interface Source {
  ref: string;        // opaque ID of the evidence, chosen by the writer, e.g. "slack:C123/1728400000.123"
  version: string;    // opaque version of the evidence at the time it was cited
  at?: Timestamp;     // when the evidence was created (message time, commit time, ...)
  quote?: string;     // exact text from the evidence that supports the fact
}

interface Fact {
  id: FactId;
  revision: string;           // changes every time the fact is updated or retracted
  subject: EntityId;
  predicate: string;          // free text, e.g. "owned-by", "retry-behavior", "code:references"
  object?: EntityId;          // exactly one of object / value is set
  value?: Json;
  basis: 'compiler-derived' | 'imported' | 'human-asserted' | 'model-inferred';
  writer: WriterId;           // set by the service from the caller's credentials
  recordedAt: Timestamp;      // when this revision was written
  sources: Source[];          // external evidence
  basedOn: { factId: FactId; revision: string }[];  // other facts this one rests on
  contradicts: FactId[];      // facts this one disputes; both stay
  status: 'active' | 'retracted';
  retractedReason?: string;
}
```

Rules:

- A fact needs at least one entry in `sources` or `basedOn`.
- `basedOn` and `contradicts` may only reference existing facts. `basedOn` may not form a cycle.
- Facts are never edited in place. An update creates a new revision, and old revisions stay readable.

### 4.3 Staleness

The service keeps one record per source `ref`: the latest version reported through `sourceChanged`. A fact is **stale** if any of these is true:

1. One of its `sources` has a reported latest version that differs from the version the fact cites.
2. A fact in its `basedOn` is stale, retracted, or has a newer revision than the one cited.

Rule 2 applies recursively, so a conclusion is stale if anything beneath it is.

A ref that has never been reported through `sourceChanged` has no latest version, and facts citing it are not stale. Versions are opaque and can't be ordered, so a workflow that observes a new version should call `sourceChanged` before writing facts that cite it.

A stale fact becomes fresh again when its writer updates it to cite the current versions.

### 4.4 Code facts

Code is not special. A code-indexer workflow runs the SCIP indexer for a repo and writes ordinary facts with `basis: 'compiler-derived'`:

- One entity per symbol: `id: "scip:<symbol>"`, with `type` taken from SCIP's symbol information where the indexer provides it, otherwise `"symbol"`.
- Facts such as `code:defined-in` and `code:references`, each citing `ref: "git:<repo>:<path>"` with the file's blob SHA as `version`.

The exact predicate set must follow the relationships SCIP actually emits; see `scip.proto` in the SCIP repository. Other writers' facts can link to code entities. For example, `service/rate-engine` `implemented-by` `scip:…`.

## 5. Interface

All methods are called by workflows' agents. The caller's identity, its `WriterId`, comes from its credentials, never from method arguments. `Entity`, `Source`, and `Fact` are defined in §4.

```typescript
type EntityId = string;
type FactId = string;
type WriterId = string;     // e.g. "workflow/meeting-summary@1"
type Timestamp = string;    // ISO 8601, UTC
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface FactView {
  fact: Fact;
  stale: boolean;
  staleBecause: Array<
    | { ref: string; citedVersion: string; latestVersion: string }
    | { factId: FactId; reason: 'stale' | 'retracted' | 'revised' }
  >;
  contradictedBy: FactId[];   // active facts whose `contradicts` lists this fact
}

interface Page<T> { items: T[]; nextCursor?: string }

interface KnowledgeGraph {
  /**
   * Create or update the caller's entities and facts, and retract the caller's facts, in one atomic batch.
   * - A fact without `id` is created.
   * - A fact with `id` replaces that fact; `revision` must equal its current revision.
   * - Fails entirely if any item is invalid or belongs to another writer.
   */
  write(batch: {
    rationale: string;        // why these changes were made; kept in history
    entities?: Entity[];
    facts?: Array<{
      id?: FactId;
      revision?: string;      // required when id is set
      subject: EntityId;
      predicate: string;
      object?: EntityId;
      value?: Json;
      basis: Fact['basis'];
      sources: Source[];
      basedOn?: { factId: FactId; revision: string }[];
      contradicts?: FactId[];
    }>;
    retract?: Array<{ id: FactId; revision: string; reason: string }>;
  }): Promise<{ facts: Array<{ id: FactId; revision: string }> }>;

  /** An entity plus the first 50 active facts about it and the first 50 pointing at it. Use listFacts for more. */
  getEntity(id: EntityId): Promise<{
    entity: Entity;
    about: FactView[];
    pointingHere: FactView[];
    moreAbout: boolean;
    morePointingHere: boolean;
  } | null>;

  /** A fact with everything around it: what it rests on, what rests on it, and what disputes it. */
  getFact(id: FactId, opts?: { includeHistory?: boolean }): Promise<{
    view: FactView;
    basedOn: FactView[];
    supports: FactView[];        // active facts whose basedOn includes this fact
    contradictions: FactView[];  // both directions
    history?: Fact[];            // all revisions, oldest first
  } | null>;

  /** Active facts matching every given filter, ordered by recordedAt, newest first. */
  listFacts(filter: {
    subject?: EntityId;
    object?: EntityId;
    predicate?: string;
    writer?: WriterId;
    staleOnly?: boolean;
    sourceRef?: string;
  }, page?: { limit?: number; cursor?: string }): Promise<Page<FactView>>;

  /**
   * Find entities by exact name or alias, and facts by text and meaning.
   * Retracted facts are excluded. Stale facts are included and flagged.
   */
  search(q: { text: string; limit?: number }): Promise<{
    entities: Entity[];          // exact, case-insensitive matches on name or alias
    facts: FactView[];           // ranked; default limit 20, max 100
  }>;

  /** Follow facts that have an `object`, up to 3 hops. Stops at `limit` paths and reports truncation. */
  neighbors(q: {
    from: EntityId;
    predicates?: string[];       // default: all
    direction?: 'out' | 'in' | 'both';   // default: 'out'
    depth?: 1 | 2 | 3;           // default: 1
    limit?: number;              // default 50, max 500
  }): Promise<{ paths: Array<{ facts: FactView[]; end: Entity }>; truncated: boolean }>;

  /** Report that the evidence at `ref` is now at `version`. Returns how many facts became stale. */
  sourceChanged(q: { ref: string; version: string }): Promise<{ newlyStale: number }>;
}
```

Errors: `INVALID_INPUT` (bad shape, missing evidence, cycle, unknown reference), `NOT_OWNER` (changing another writer's fact), `CONFLICT` (`revision` doesn't match the current one), `NOT_FOUND`.

## 6. Implementation

One HTTP service backed by one Postgres database with the `pgvector` extension. The Convex component maps each interface method to `POST /v1/<method>` with a JSON body, and authenticates with an API key.

### 6.1 Tables

| Table | Holds |
|---|---|
| `writers` | Writer ID, API key hash, and the `basis` values the writer may use (so only the code indexer can write `compiler-derived`) |
| `entities` | Current entity rows |
| `entity_history` | Every entity change, with writer and time |
| `fact_revisions` | Every revision of every fact (append-only), with an `is_current` flag |
| `fact_sources` | One row per source per fact revision |
| `fact_based_on` | One row per `basedOn` entry per fact revision |
| `fact_contradicts` | One row per `contradicts` entry per fact revision |
| `source_versions` | Latest reported version per `ref` |
| `writes` | One row per `write` call: writer, rationale, time, and the revisions it produced |
| `fact_embeddings` | One vector per current fact revision |

Indexes are needed on: current facts by subject, object, predicate, and writer; sources by `ref`; `fact_based_on` in both directions; `fact_contradicts` in both directions; a full-text index on fact text; and a vector index on embeddings.

### 6.2 Search

1. Match `text` exactly (case-insensitive) against entity names and aliases.
2. Run Postgres full-text search over fact text.
3. Embed `text` and run vector search over fact embeddings.
4. Merge steps 2 and 3 with reciprocal rank fusion: score = Σ 1 / (60 + rank).

**Fact text** is `"<subject name> <predicate> <object name or value>"` plus any quotes. The service computes the fact's embedding when the fact is written. The embedding model is an open choice (§7).

### 6.3 Staleness

`sourceChanged` upserts `source_versions`, then marks facts citing an older version of that `ref`, and facts `basedOn` them recursively. A recursive query works for this. `stale` and `staleBecause` can be computed at read time or stored and updated on `sourceChanged` and `write`. Either is acceptable if it matches §4.3.

### 6.4 Administration (not part of the agent interface)

- `registerWriter(writerId, allowedBases)` returns an API key.
- `revertWriter(writerId, since)` restores, for every fact that writer changed since that time, the revision current before its first change. It is recorded as a write by an admin.

## 7. Open questions

| Question | Notes |
|---|---|
| Embedding model | A local model (no cost, runs in the service) or a hosted API. Choose after testing on real DAT text. |
| SCIP fact volume | Reference facts for large repos could reach millions of rows. Measure on one DAT repo first. |
| Canonical `ref` formats | Staleness only works if every workflow writes the same `ref` for the same evidence. Each Jive interface should define the ref format for its objects. |
| Hosting for the DAT brain | It holds DAT internal knowledge, so it should be hosted somewhere DAT approves. |

---

## Appendix A: Changes from revision 2

| Change | Reason |
|---|---|
| Storage moved from a git repo of YAML files to Postgres with append-only fact revisions | Many workflows write concurrently. Search is built in. History, attribution, and rollback come from append-only rows. |
| Removed per-source-type freshness checks; added `sourceChanged` | The brain never contacts external systems. Workflows, which already have the interfaces, report changes. |
| `Source` is now an opaque `ref` + `version` | There are unlimited kinds of sources, and the brain doesn't need to know what one is. |
| Added `basedOn` for facts resting on other facts, with recursive staleness | This captures how conclusions build on findings, and keeps conclusions honest when what's beneath them changes. |
| Code facts are written by an indexer workflow, not computed by a special layer | The brain can't read repos (R8). Code is just another writer. |
| Removed the CLI, in-memory index, and `BrainStore` | They existed only to support the git design or a layer Jive doesn't have. |
| `retract` merged into `write`; added `getFact` and `listFacts`, removed `stale()` | `listFacts({ staleOnly: true })` covers stale listing, and `getFact` exposes support chains. |
| Writer identity comes from credentials | Writers shouldn't be able to claim to be someone else. |
| Embeddings and exact-name lookup in the first version | Text search alone misses paraphrases. Names need exact matches. |
