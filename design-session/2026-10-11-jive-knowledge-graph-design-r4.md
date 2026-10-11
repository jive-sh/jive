# Jive Knowledge Graph — Design

**Status:** Implemented draft, revision 4 · **Date:** 2026-10-11 · **Author:** Alex Leung (with Claude)
**Supersedes:** revision 3 (`2026-10-10-jive-knowledge-graph-design.md`). Changes are listed in Appendix A.

---

## 1. Summary

Each Jive project has one **brain**: a store of sourced facts about everything in the project, from code to customers. Workflows write facts into it and agents query it.

**The brain stores sourced facts. Workflows keep it true.** The brain never contacts Slack, git, Confluence, or anything else. Jive's other interfaces and workflows do that, and they tell the brain what they learn.

Two programs implement this document:

| Program | What it is |
|---|---|
| `brain` | The service: one executable that serves the interface over HTTP and stores everything in Postgres. |
| `brain-caller` | The client: one executable that agents and workflows run. It calls every interface method, and it contains the code-indexer workflow that turns a repo's SCIP index into facts (§8.1). |

## 2. How it fits into Jive

A Jive user builds workflows and wires interfaces into them. The Knowledge Graph is one interface, alongside Message Board and Task Board. Agents call the interfaces' methods. Until Jive exists, agents call `brain-caller` directly.

```text
Workflow / agent ──calls──▶ KnowledgeGraph interface ──implemented by──▶ Convex component ─┐
Agent (standalone) ──runs──▶ brain-caller ──────────────────────────────────────────────────┤ HTTP
                                                                                           ▼
                                                                                 brain ── Postgres
```

Example: a meeting-summary workflow, with MessageBoard (Slack) and KnowledgeGraph wired in.

1. Triggered by a new transcript posted in `#meeting-transcripts`.
2. The agent reads the transcript through MessageBoard.
3. `search({ text: "Acme" })` finds the existing `customer/acme` entity, so the agent reuses it instead of creating a duplicate.
4. `getEntity({ id: "customer/acme" })` shows what's already known.
5. `write(...)` adds new facts citing the transcript message and quoting it. Where the meeting contradicts an existing fact, the new fact lists it in `contradicts`.
6. The agent posts a summary through MessageBoard.

Example: a code workflow, triggered by a commit to a tracked repo.

1. For each changed file, call `sourceChanged({ ref: "git:dat/rate-engine:src/retry.ts", version: "<new blob sha>" })`. Every fact citing the old version is now stale.
2. Run the SCIP indexer on the commit and `write` the resulting code facts (§8.1), updating or retracting this workflow's previous facts for the changed files.
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
| R10 | The service ships as one self-contained executable: database, search, and embedding model included. |

**Non-goals:** read permissions (everyone using a project can read its whole brain), claim categories such as "intended" versus "current" (writers phrase claims accurately and readers judge), and source types (the brain treats every source as an opaque reference plus a version).

## 4. Data model

### 4.1 Entities

An entity is anything facts can be about: a person, team, customer, service, decision, function, file, and so on.

```typescript
interface Entity {
  id: EntityId;       // stable, never changes. Examples: "customer/acme", "scip:<SCIP symbol>"
  type: string;       // free text. Examples: "person", "service", "function"
  name: string;
  aliases: string[];  // other names, used by exact-name search
}
```

Rules:

- Entities are shared. They have no owner, and any writer may create one or change it.
- Writing an entity that doesn't exist creates it. Writing one that exists replaces its `type` and `name` and **adds** the given aliases to its existing ones; aliases are never removed by a write. A write that changes nothing records nothing.
- Every change is kept in entity history with the write that made it.
- IDs are chosen by writers. By convention, written entities use `<type>/<slug>`, and code uses the IDs in §8.1.
- Renaming an entity changes the text of every fact that mentions it, so the service re-indexes those facts for search (§6.3).

### 4.2 Facts

A fact is one claim about one subject entity. It either links to another entity (`object`) or states a value (`value`).

```typescript
interface Source {
  ref: string;        // opaque ID of the evidence, chosen by the writer, e.g. "slack:C123/1728400000.123"
  version: string;    // opaque version of the evidence at the time it was cited
  at?: Timestamp;     // when the evidence was created (message time, commit time, ...)
  quote?: string;     // exact text from the evidence that supports the fact
  locator?: string;   // where in the evidence, e.g. "L42-L57" or "section: On-call". Not used for staleness.
}

interface Fact {
  id: FactId;
  revision: string;           // changes every time the fact is updated or retracted
  subject: EntityId;
  predicate: string;          // free text, e.g. "owned-by", "retry-behavior", "code:references"
  object?: EntityId;          // exactly one of object / value is set
  value?: Json;
  basis: 'compiler-derived' | 'imported' | 'human-asserted' | 'model-inferred';
  writer: WriterId;           // the fact's owner: the writer that created it. Never changes.
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
- `subject` and `object` must name entities that exist, or that the same `write` creates.
- `basedOn` and `contradicts` may only reference facts that exist (any status), or that the same `write` creates (§5.1). A fact may not reference itself.
- `basedOn` may not form a cycle between facts: following each fact's current `basedOn` from a fact must never lead back to it.
- Facts are never edited in place. An update creates a new revision, and old revisions stay readable. An update may change every field except `id` and `writer`; it is a full replacement, so omitted `basedOn` or `contradicts` become empty.
- Updating a retracted fact makes it active again.
- `value: null` counts as set. An absent `value` is unset.

### 4.3 Staleness

For each source `ref`, the service keeps every version reported through `sourceChanged`, with who reported it and when. The **latest version** of a ref is the most recent report that has not been reverted (§6.5). A fact is **stale** if any of these is true:

1. One of its `sources` has a latest version that differs from the version the fact cites.
2. A fact in its `basedOn` is stale, retracted, or has a different current revision than the one cited.

Rule 2 applies recursively, so a conclusion is stale if anything beneath it is.

A ref that has never been reported has no latest version, and facts citing it are not stale. Versions are opaque and can't be ordered: "differs" means "is not equal to". A workflow that observes a new version should call `sourceChanged` before writing facts that cite it.

A stale fact becomes fresh again when its writer updates it to cite the current versions and revisions.

## 5. Interface

All methods are called by workflows' agents. The caller's identity, its `WriterId`, comes from its API key, never from method arguments. Every method takes one object and returns one JSON value. `Entity`, `Source`, and `Fact` are defined in §4.

```typescript
type EntityId = string;
type FactId = string;
type WriterId = string;     // e.g. "workflow/meeting-summary"
type Timestamp = string;    // ISO 8601, UTC
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type FactRef =
  | { factId: FactId; revision: string }   // an existing fact at a revision
  | { key: string };                       // a fact created earlier in the same write (§5.1)

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
  /** Create or update entities, create or update the caller's facts, and retract the caller's facts, in one atomic batch. */
  write(batch: {
    rationale: string;        // why these changes were made; kept in history
    entities?: Entity[];
    facts?: Array<{
      key?: string;           // batch-local name, so other items in this batch can reference this fact
      id?: FactId;            // set to update an existing fact
      revision?: string;      // required when id is set; must equal the fact's current revision
      subject: EntityId;
      predicate: string;
      object?: EntityId;
      value?: Json;
      basis: Fact['basis'];
      sources: Source[];
      basedOn?: FactRef[];
      contradicts?: Array<FactId | { key: string }>;
    }>;
    retract?: Array<{ id: FactId; revision: string; reason: string }>;
  }): Promise<{
    writeId: string;
    facts: Array<{ key?: string; id: FactId; revision: string }>;     // same order as batch.facts
    retracted: Array<{ id: FactId; revision: string }>;              // same order as batch.retract
  }>;

  /** An entity plus the first 50 active facts about it and the first 50 pointing at it, newest first. */
  getEntity(q: { id: EntityId }): Promise<{
    entity: Entity;
    about: FactView[];
    pointingHere: FactView[];
    moreAbout: boolean;
    morePointingHere: boolean;
  } | null>;

  /** A fact (in any status) with what it rests on, what rests on it, and what disputes it. */
  getFact(q: { id: FactId; includeHistory?: boolean }): Promise<{
    view: FactView;
    basedOn: FactView[];         // current revisions of the facts this one cites
    supports: FactView[];        // active facts whose basedOn includes this fact
    contradictions: FactView[];  // active facts it contradicts or that contradict it
    history?: Fact[];            // all revisions, oldest first
  } | null>;

  /** Active facts matching every given filter, newest first. Default limit 50, max 500. */
  listFacts(q: {
    subject?: EntityId;
    object?: EntityId;
    predicate?: string;
    writer?: WriterId;
    staleOnly?: boolean;
    sourceRef?: string;
    sourceRefPrefix?: string;    // e.g. "git:dat/rate-engine:" for every fact citing that repo
    limit?: number;
    cursor?: string;
  }): Promise<Page<FactView>>;

  /**
   * Find entities by exact name or alias, and facts by text and meaning.
   * Retracted facts are excluded. Stale facts are included and flagged.
   */
  search(q: { text: string; limit?: number }): Promise<{
    entities: Entity[];          // exact, case-insensitive matches on id, name, or alias
    facts: FactView[];           // ranked; default limit 20, max 100
  }>;

  /** Follow active facts that have an `object`, up to 3 hops, never revisiting an entity in one path. */
  neighbors(q: {
    from: EntityId;
    predicates?: string[];       // default: all
    direction?: 'out' | 'in' | 'both';   // default: 'out'
    depth?: 1 | 2 | 3;           // default: 1
    limit?: number;              // paths; default 50, max 500
  }): Promise<{ paths: Array<{ facts: FactView[]; end: Entity }>; truncated: boolean }>;

  /** Report that the evidence at `ref` is now at `version`. Returns how many active facts went from fresh to stale. */
  sourceChanged(q: { ref: string; version: string }): Promise<{ newlyStale: number }>;
}
```

### 5.1 Write semantics

- The batch is applied in this order: entities, then facts in array order, then retractions. Any failure rolls back the whole batch.
- A fact item with `key` may be referenced by later items in the same batch as `{ key }` in `basedOn` or `contradicts`. Keys must be unique within the batch. A `{ key }` basedOn reference resolves to the revision the batch creates.
- One batch may not touch the same fact twice (update and retract, or two updates).
- Limits: 5,000 fact items, 5,000 entities, and 5,000 retractions per batch, and a 32 MB request body.

### 5.2 Errors

Every error has the shape `{ "error": { "code": string, "message": string, "details"?: Json } }`.

| Code | HTTP | When |
|---|---|---|
| `INVALID_INPUT` | 400 | Bad shape, missing evidence, cycle, self-reference, unknown entity or fact reference, duplicate key, limits exceeded |
| `UNAUTHENTICATED` | 401 | Missing or unknown API key |
| `NOT_OWNER` | 403 | Updating or retracting another writer's fact |
| `BASIS_NOT_ALLOWED` | 403 | Using a `basis` the writer isn't registered for (§6.5) |
| `NOT_FOUND` | 404 | Updating or retracting a fact ID that doesn't exist; unknown method |
| `CONFLICT` | 409 | `revision` doesn't match the fact's current revision |
| `INTERNAL` | 500 | Anything else |

## 6. Implementation

### 6.1 Process and storage

`brain` is one executable built with `bun build --compile`. It contains:

- an HTTP server (Effect HTTP on Bun);
- Postgres with `pgvector`, embedded as PGlite (Postgres compiled to WebAssembly), storing data in a directory;
- the embedding model and its runtime (§6.3).

Set `BRAIN_DATABASE_URL` to use an external Postgres with `pgvector` instead of the embedded one. Everything else is the same. One `brain` process serves one project.

HTTP mapping: every interface method is `POST /v1/<method>` with the method's argument object as the JSON body, and an `Authorization: Bearer <api key>` header. Success is HTTP 200 with the return value as JSON. A read that finds nothing returns 200 with `null`. Errors use §5.2. `GET /health` reports readiness and the embedding backlog without authentication.

### 6.2 Tables

| Table | Holds |
|---|---|
| `writers` | Writer ID, API key hash, the `basis` values the writer may use, created time |
| `writes` | One row per `write`, `sourceChanged`, or admin call: write ID, actor (writer or `admin`), kind, rationale, time |
| `entities` | Current entity rows |
| `entity_history` | Every entity change: entity, write ID, previous and new values |
| `facts` | One row per fact: ID, owner, current revision |
| `fact_revisions` | Every revision of every fact (append-only): content, status, write ID, recorded time, search text and its full-text vector |
| `fact_sources` | One row per source per fact revision |
| `fact_based_on` | One row per `basedOn` entry per fact revision |
| `fact_contradicts` | One row per `contradicts` entry per fact revision |
| `source_reports` | Every `sourceChanged` report: ref, version, write ID, time, reverted flag |
| `fact_embeddings` | One vector per fact revision text, filled asynchronously |

Indexes: current revisions by subject, object, predicate, and owner; sources by `ref` (and prefix); `fact_based_on` in both directions; `fact_contradicts` in both directions; latest report per ref; a GIN index on the full-text vector; an HNSW index on embeddings; entity name and aliases, lower-cased.

### 6.3 Search

**Fact text** is `"<subject name> <predicate> <object name or value>"` followed by any source quotes. The service stores it on each revision and recomputes it for current revisions when an entity they mention is renamed.

1. Match `text` exactly, case-insensitively, against entity IDs, names, and aliases.
2. Run Postgres full-text search (`english` configuration) over current active fact text. The query matches facts containing **any** of the question's lexemes, ranked by `ts_rank_cd`, because a natural-language question rarely has all its words in one fact.
3. Embed `text` and run vector search (cosine distance) over current active facts' embeddings.
4. Merge steps 2 and 3 with reciprocal rank fusion: score = Σ 1 / (60 + rank). Take the top 100 of each list before merging.

**Embeddings.** The model is `bge-small-en-v1.5` (384 dimensions, int8-quantized ONNX), run in-process by ONNX Runtime's WebAssembly backend; no network or API key is used. Questions are embedded with the model's query prefix (`Represent this sentence for searching relevant passages: `); facts are embedded without it.

Embedding runs in the background, not inside `write`: a worker embeds every current revision whose text has no vector yet, in batches. Writes therefore never wait for or fail on the model, and a fact is findable by exact name and full text immediately and by meaning within seconds. `GET /health` reports the backlog.

### 6.4 Staleness

Staleness is computed at read time from the current revisions, exactly as §4.3 defines it:

- **Direct:** a current revision with a source whose ref has a latest report with a different version.
- **Broken support:** a current revision with a `basedOn` entry whose fact is retracted or whose current revision differs from the cited one.
- **Inherited:** a current revision with a `basedOn` entry whose fact is stale. This is a recursive query over `fact_based_on`. It tracks visited facts, so it terminates even if a revert re-creates a cycle.

`sourceChanged` appends a report and returns the number of active facts that were fresh before it and stale after it, including inherited staleness.

### 6.5 Administration

Admin calls are `POST /admin/v1/<method>` with `Authorization: Bearer <admin key>`. The admin key is `BRAIN_ADMIN_KEY` if set; otherwise the service generates one on first start and writes it to `<data dir>/admin.key` (mode 0600).

- `registerWriter({ writerId, allowedBases })` creates the writer and returns its API key. Only the returned key is ever shown; the service stores a hash.
- `rotateKey({ writerId })` returns a new API key and invalidates the old one.
- `listWriters({})` returns writer IDs, allowed bases, and creation times.
- `revertWriter({ writerId, since })` undoes that writer's changes made at or after `since`, as one admin write:
  - each fact the writer created at or after `since` gets a new retracted revision (reason `reverted`);
  - each older fact the writer changed gets a new revision copying the revision that was current just before `since`;
  - each entity the writer changed gets its pre-`since` name, type, and aliases back (entities it created are left; entities have no owner);
  - its `sourceChanged` reports since `since` are marked reverted, so each ref's latest version falls back to its previous report.

Revert revisions keep the fact's owner; the `writes` row records `admin` as the actor.

## 7. Writer conventions

These are rules for writers. The brain cannot check them.

- **Search before creating.** Call `search` for a name before creating an entity. When two IDs turn out to mean the same thing, write a `same-as` fact between them and use the older ID from then on.
- **Quote exactly.** `quote` must be text copied from the evidence, not a paraphrase. The brain can't verify quotes (R8).
- **Phrase claims precisely.** Write "should", "decided", "plans to" when a claim is about intent; write the plain present tense only for what is currently true.
- **No contact details.** Don't put phone numbers, personal email addresses, or home addresses into facts. Cite the source that has them.
- **Canonical refs.** Every workflow must write the same `ref` for the same evidence:

| Evidence | `ref` | `version` |
|---|---|---|
| A file in a git repo | `git:<org>/<repo>:<path>` | the file's blob SHA |
| A Confluence page | `confluence:<pageId>` | the page version number |
| A Jira issue | `jira:<KEY-123>` | the issue's `updated` timestamp |
| A Slack message | `slack:<channelId>/<ts>` | the edit timestamp, or `ts` if never edited |

## 8. brain-caller

`brain-caller` is one executable. It reads `BRAIN_URL` and `BRAIN_KEY` (or `--url`, `--key`), prints JSON to stdout, and prints errors as the §5.2 JSON on stderr with a non-zero exit code.

| Command | Calls |
|---|---|
| `brain-caller write [file]` | `write`, with the batch read from the file or stdin |
| `brain-caller get-entity <id>` | `getEntity` |
| `brain-caller get-fact <id> [--history]` | `getFact` |
| `brain-caller list-facts [--subject …] [--object …] [--predicate …] [--writer …] [--stale-only] [--source-ref …] [--source-ref-prefix …] [--limit n] [--cursor c] [--all]` | `listFacts` (`--all` follows cursors) |
| `brain-caller search <text> [--limit n]` | `search` |
| `brain-caller neighbors <id> [--predicate p]… [--direction d] [--depth n] [--limit n]` | `neighbors` |
| `brain-caller source-changed <ref> <version>` | `sourceChanged` |
| `brain-caller ingest-code <repo dir> --repo <org/name>` | the code-indexer workflow (§8.1) |
| `brain-caller admin register-writer <id> --basis b…` / `rotate-key` / `list-writers` / `revert-writer <id> --since t` | §6.5, with `BRAIN_ADMIN_KEY` |

### 8.1 Code ingestion

`ingest-code` runs as a writer registered for `compiler-derived`. Given a git checkout:

1. List the tracked files at `HEAD` with their blob SHAs (`git ls-tree -r HEAD`).
2. Produce a SCIP index: use `--index <file>` if given, otherwise run the indexer for the repo's language (`scip-typescript`, `scip-python`, `scip-java`, `scip-go`, `rust-analyzer scip`, `scip-dotnet`, `scip-ruby`), detected from the repo's build files.
3. Convert the index into the desired set of entities and facts below.
4. Load this writer's existing facts for the repo (`listFacts({ writer, sourceRefPrefix: "git:<repo>:" })`).
5. Call `sourceChanged` for every file whose blob differs from what this writer's facts cite, and for every deleted file (version `deleted`).
6. Write the difference in batches: create missing facts, update facts whose content or cited blob changed, and retract facts that are no longer produced. Unchanged facts are not touched.

Entities:

| ID | Type | Name |
|---|---|---|
| `repo/<org>/<repo>` | `repo` | `<org>/<repo>` |
| `file/<org>/<repo>/<path>` | `file` | `<path>` |
| `scip:<symbol>` | SCIP `kind` in kebab case (e.g. `method`, `class`), else `symbol` | `display_name`, else the last descriptor's name |

A symbol entity's aliases are its qualified name built from its descriptors (e.g. `RateEngine.computeRate`). Local symbols (`local …`) are skipped.

Facts (all `basis: 'compiler-derived'`; each cites the file it came from, `ref: "git:<org>/<repo>:<path>"`, `version: <blob sha>`):

| Subject | Predicate | Object / value | Locator and quote |
|---|---|---|---|
| file | `code:in-repo` | repo | — |
| symbol | `code:defined-in` | file | definition line range; quote = the first line of the definition |
| symbol | `code:member-of` | the enclosing symbol (from `enclosing_symbol`, else the symbol's descriptors minus the last) | — |
| symbol | `code:documentation` | value: documentation text (first 2,000 characters) | — |
| symbol | `code:signature` | value: `signature_documentation.text` | — |
| symbol | `code:implements` / `code:type-definition` / `code:references-symbol` | the related symbol, from `relationships` | — |
| enclosing symbol (or the file, at top level) | `code:references` | referenced symbol | first reference line; one fact per subject, referenced symbol, and file |

The enclosing symbol of a reference is the innermost definition in the same file whose enclosing range contains it. Referenced symbols defined outside the index (e.g. library symbols) get entities from `external_symbols` when present, otherwise from their descriptors.

### 8.2 Document ingestion

Documents are ingested by an agent using `brain-caller`, not by a fixed program, because what a document means can't be derived mechanically. For each document the agent:

1. Reads it through the system that holds it (for example, Confluence through Jive's or Claude's Atlassian connector).
2. Calls `sourceChanged` with the document's canonical ref and version (§7).
3. Searches for the people, teams, systems, and repos it mentions, and reuses their entities.
4. Writes facts with `basis: 'imported'` (stated directly in the document) or `'model-inferred'` (the agent's conclusion), each citing the document with an exact quote. Conclusions drawn from several facts use `basedOn`.

## 9. Success criteria

The design works if, after ingesting one team's repos and Confluence space, an agent using only `brain-caller` answers a fixed set of questions about that team correctly, with sources. The set covers: what a repo or service does, who owns it, how two components are connected in code, where a function is defined and what calls it, what the on-call process is, what changed recently, and a question whose answer the documents and the code disagree on. Wrong, missing, or unsourced answers are design defects, and are fixed by revising this document.

## 10. Open questions

| Question | Notes |
|---|---|
| SCIP fact volume | Measured per repo during onboarding; see the implementation notes. |
| Hosting for the DAT brain | It holds DAT internal knowledge, so it should run somewhere DAT approves. Today it runs on Alex's machine. |
| Entity merging | `same-as` is a convention. If duplicates become common, the brain may need a merge operation. |

---

## Appendix A: Changes from revision 3

| Change | Reason |
|---|---|
| Entities are shared with merge-on-write aliases; the "caller's entities" wording is gone | Rev 3 contradicted itself (§4.1 vs §5), and replacing aliases let one writer erase another's. |
| `subject`/`object` must exist | `neighbors`, fact text, and `getEntity` all assumed it. |
| Batch-local `key` references | Rev 3 couldn't write a conclusion and its findings atomically. |
| `writer` is the fixed owner; the `writes` table records the actor | Rev 3's admin revert would have transferred ownership to the admin. |
| `revertWriter` defined for created facts, entities, and source reports | Rev 3 left these undefined, and source reports had no history (R6). |
| Cycles checked between facts, not revisions | Revision-level cycles are impossible by construction, so rev 3's rule checked nothing. |
| Every method takes one object; HTTP, error shape, auth, and status codes specified | Rev 3 left the wire format to each implementer (R9). |
| `BASIS_NOT_ALLOWED`, `UNAUTHENTICATED`, `INTERNAL` errors | Rev 3's four codes didn't cover these cases. |
| Embedding model chosen and embedded; embedding is asynchronous | Rev 3 left the model open, which blocked the schema; synchronous embedding made bulk code writes slow and fallible. |
| Fact text stored and recomputed on rename | Rev 3 didn't say where fact text lived or when it changed. |
| `Source.locator` | Code facts need line ranges, and refs must stay file-level for staleness to match. |
| `listFacts.sourceRefPrefix` | The code indexer needs all its facts for one repo without per-file calls. |
| One executable with embedded Postgres (R10) | Alex asked for a single executable with everything contained. |
| `brain-caller`, code ingestion, and document ingestion specified (§8) | Rev 3 assigned code facts to a workflow that doesn't exist yet and had no ingestion section. |
| Writer conventions restored (§7): search first, `same-as`, exact quotes, no contact details, canonical refs | Rev 1–2 had them; rev 3 dropped them silently. Quote checking is impossible under R8, so it became a convention. |
| Success criteria restored (§9) | Rev 3 had no definition of "working". |
