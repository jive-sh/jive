import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/sql"
import { Effect } from "effect"
import { Embedder } from "../src/embed/Embedder.ts"
import { drain, nextPending, pendingCount } from "../src/embed/worker.ts"
import { search } from "../src/kg/search.ts"
import { sourceChanged } from "../src/kg/sources.ts"
import { write } from "../src/kg/write.ts"
import { ent, runDb, src, writer } from "./support.ts"

const T = 60_000
const entities = [
  ent("team/pricing-platform", "Pricing Platform", ["PP"]),
  ent("service/rate-engine", "Rate Engine", ["rate-engine"]),
  ent("office/denver", "Denver office"),
  ent("customer/acme", "Acme Logistics"),
]
const facts = [
  { subject: "team/pricing-platform", predicate: "on-call-for", object: "service/rate-engine", basis: "imported" as const, sources: [src("confluence:1", "3")] },
  { subject: "office/denver", predicate: "closed-on", value: "Fridays", basis: "imported" as const, sources: [src("confluence:2", "1")] },
  { subject: "customer/acme", predicate: "renewal-date", value: "2026-12-01", basis: "imported" as const, sources: [src("slack:C1/2", "1")] },
]
const seed = Effect.gen(function* () {
  const w = yield* writer("w1")
  const res = yield* write(w, { rationale: "seed", entities, facts })
  return { w, ids: res.facts.map((f) => f.id) }
})

describe("search", () => {
  test("finds entities by exact id, name, or alias, case-insensitively", async () => {
    const r = await runDb(Effect.gen(function* () {
      yield* seed
      return [(yield* search({ text: "pp" })).entities, (yield* search({ text: "RATE-ENGINE" })).entities, (yield* search({ text: "customer/acme" })).entities]
    }), Embedder.Fake)
    expect(r.map((es) => es.map((e) => e.id))).toEqual([["team/pricing-platform"], ["service/rate-engine"], ["customer/acme"]])
  }, T)

  test("full-text hits are available before any embedding runs", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { ids } = yield* seed
      return { pending: yield* pendingCount, hits: (yield* search({ text: "when is the Denver office closed?" })).facts.map((v) => v.fact.id), ids }
    }), Embedder.Fake)
    expect(r.pending).toBe(3)
    expect(r.hits[0]).toBe(r.ids[1]!)
  }, T)

  test("a paraphrase with no shared words is found after the worker embeds facts", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { ids } = yield* seed
      const embedded = yield* drain
      return { embedded, hits: (yield* search({ text: "which group handles incidents for quoting?" })).facts.map((v) => v.fact.id), ids }
    }), Embedder.Local())
    expect(r.embedded).toBe(3)
    expect(r.hits[0]).toBe(r.ids[0]!)
  }, T)

  test("retracted facts are excluded and stale facts are flagged", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { w, ids } = yield* seed
      const [onCall, closed] = ids
      const current = yield* search({ text: "Denver office closed" })
      const rev = current.facts.find((v) => v.fact.id === closed)!.fact.revision
      yield* write(w, { rationale: "r", retract: [{ id: closed!, revision: rev, reason: "reopened" }] })
      yield* sourceChanged(w, { ref: "confluence:1", version: "4" })
      return { closed: (yield* search({ text: "Denver office closed" })).facts.map((v) => v.fact.id), onCall: (yield* search({ text: "Pricing Platform on call" })).facts.find((v) => v.fact.id === onCall)! }
    }), Embedder.Fake)
    expect(r.closed).not.toContain(r.onCall.fact.id)
    expect(r.closed).toHaveLength(0)
    expect(r.onCall.stale).toBe(true)
  }, T)

  test("renaming an entity updates the text of facts that mention it", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { w } = yield* seed
      yield* write(w, { rationale: "rename", entities: [ent("customer/acme", "Zenith Freight")] })
      return { old: (yield* search({ text: "Acme" })).facts.length, fresh: (yield* search({ text: "Zenith" })).facts.length }
    }), Embedder.Fake)
    expect(r).toEqual({ old: 0, fresh: 1 })
  }, T)
})

describe("embedding order", () => {
  test("facts that aren't compiler-derived are embedded first", async () => {
    const order = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, {
        rationale: "mixed",
        entities: [ent("x/e")],
        facts: [
          ...Array.from({ length: 50 }, (_, i) => ({ subject: "x/e", predicate: `code:p${i}`, value: i, basis: "compiler-derived" as const, sources: [src("git:r:f")] })),
          { subject: "x/e", predicate: "owned-by", value: "Velocadapter", basis: "imported" as const, sources: [src("confluence:1")] },
        ],
      })
      return (yield* nextPending(1)).map((r) => r.text)
    }), Embedder.Fake)
    expect(order).toEqual(["x/e owned-by Velocadapter"])
  }, 30_000)
})

describe("identifiers", () => {
  test("camelCase, snake_case and kebab-case identifiers are searchable by their words", async () => {
    const hits = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, {
        rationale: "code",
        entities: [ent("x/validator", "LoadPostingRequestSchemaValidator"), ent("x/file", "src/api/validators/load-posting.request-schema-validator.ts")],
        facts: [{ subject: "x/validator", predicate: "code:defined-in", object: "x/file", basis: "imported" as const, sources: [src("git:r:f")] }],
      })
      return (yield* search({ text: "where are load postings validated?" })).facts.map((v) => v.fact.subject)
    }), Embedder.Fake)
    expect(hits).toEqual(["x/validator"])
  }, 30_000)
})

describe("embedding queue", () => {
  test("writes enqueue new texts; drain empties the queue; renames enqueue the new text", async () => {
    const r = await runDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queued = () => sql<{ n: number }>`select count(*)::int as n from embedding_queue`.pipe(Effect.map((x) => x[0]!.n))
      const w = yield* writer("w1")
      yield* write(w, { rationale: "s", entities: [ent("x/e", "Old")], facts: [{ subject: "x/e", predicate: "p", value: 1, basis: "imported" as const, sources: [src("s")] }] })
      const afterWrite = yield* queued()
      yield* drain
      const afterDrain = yield* queued()
      yield* write(w, { rationale: "rename", entities: [ent("x/e", "New")] })
      const afterRename = yield* queued()
      return { afterWrite, afterDrain, afterRename }
    }), Embedder.Fake)
    expect(r).toEqual({ afterWrite: 1, afterDrain: 0, afterRename: 1 })
  }, 30_000)
})

describe("ranking", () => {
  test("a document's claim outranks code structure that merely shares words with the question", async () => {
    const hits = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, {
        rationale: "mixed",
        entities: [
          ent("team/velocadapter", "Velocadapter"),
          ent("repo/dat/freight-truck-posting-service", "dat/freight-truck-posting-service"),
          ent("file/x/truck-posting-system-v1-to-v2-mapper.spec.ts", "projects/truck-posting-form/src/lib/services/truck-posting-system-v1-to-v2-mapper/truck-posting-system-v1-to-v2-mapper.spec.ts"),
          ent("scip:x/mapper", "projects/truck-posting-form/src/lib/services/truck-posting-system-v1-to-v2-mapper/truck-posting-system-v1-to-v2-mapper.service.ts"),
        ],
        facts: [
          { subject: "file/x/truck-posting-system-v1-to-v2-mapper.spec.ts", predicate: "code:references", object: "scip:x/mapper", basis: "compiler-derived" as const, sources: [src("git:r:f", "1", { quote: "describe('truck posting system mapper which maintains team data', () => {" })] },
          { subject: "repo/dat/freight-truck-posting-service", predicate: "maintained-by", object: "team/velocadapter", basis: "imported" as const, sources: [src("confluence:1", "1", { quote: "the active VA-related repositories" })] },
        ],
      })
      return (yield* search({ text: "which team maintains the truck posting system" })).facts.map((v) => v.fact.predicate)
    }), Embedder.Fake)
    expect(hits[0]).toBe("maintained-by")
  }, 30_000)
})

describe("entity matches", () => {
  test("an exact-case name match comes before case-insensitive matches", async () => {
    const ids = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "e", entities: [ent("scip:a/observe", "observe"), ent("tool/observe", "Observe"), ent("scip:b/OBSERVE", "OBSERVE")] })
      return (yield* search({ text: "Observe" })).entities.map((e) => e.id)
    }), Embedder.Fake)
    expect(ids[0]).toBe("tool/observe")
    expect(ids).toHaveLength(3)
  }, 30_000)
})

describe("vector candidates", () => {
  test("vector search contributes up to 100 candidates, not pgvector's default 40", async () => {
    const n = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, {
        rationale: "many",
        entities: [ent("x/e", "Zq")],
        facts: Array.from({ length: 150 }, (_, i) => ({ subject: "x/e", predicate: `k${i}`, value: `w${i}a w${i}b`, basis: "imported" as const, sources: [src("s")] })),
      })
      yield* drain
      return (yield* search({ text: "unrelated question words", limit: 100 })).facts.length
    }), Embedder.Fake)
    expect(n).toBe(100)
  }, 60_000)
})
