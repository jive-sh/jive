import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { write } from "../src/kg/write.ts"
import { codeOf, ent, runDb, src, writer } from "./support.ts"

const T = 30_000

const twoEntities = [ent("customer/acme", "Acme"), ent("person/alex", "Alex")]
const ownsFact = { subject: "customer/acme", predicate: "owned-by", object: "person/alex", basis: "imported" as const, sources: [src("slack:C1/1")] }

describe("write", () => {
  test("creates an entity and a fact owned by the caller", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const res = yield* write(w, { rationale: "seed", entities: twoEntities, facts: [ownsFact] })
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ writer: string; current_revision: string }>`select writer, current_revision from facts where id = ${res.facts[0]!.id}`
        return { res, rows }
      }),
    )
    expect(r.res.facts).toHaveLength(1)
    expect(r.rows[0]!.writer).toBe("w1")
    expect(r.rows[0]!.current_revision).toBe(r.res.facts[0]!.revision)
  }, T)

  test("rewriting an entity merges aliases and replaces the name; an identical rewrite records no history", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        yield* write(w, { rationale: "a", entities: [ent("customer/acme", "Acme", ["A"])] })
        yield* write(w, { rationale: "b", entities: [ent("customer/acme", "Acme Corp", ["B"])] })
        yield* write(w, { rationale: "c", entities: [ent("customer/acme", "Acme Corp", ["B"])] })
        const sql = yield* SqlClient.SqlClient
        const e = yield* sql<{ name: string; aliases: string[] }>`select name, aliases from entities where id = 'customer/acme'`
        const h = yield* sql<{ n: number }>`select count(*)::int as n from entity_history where entity_id = 'customer/acme'`
        return { e: e[0]!, history: h[0]!.n }
      }),
    )
    expect(r.e).toEqual({ name: "Acme Corp", aliases: ["A", "B"] })
    expect(r.history).toBe(2)
  }, T)

  test("a fact whose subject doesn't exist fails INVALID_INPUT; creating it in the same batch succeeds", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const missing = yield* codeOf(write(w, { rationale: "x", facts: [ownsFact] }))
        const same = yield* codeOf(write(w, { rationale: "x", entities: twoEntities, facts: [ownsFact] }))
        return { missing, same }
      }),
    )
    expect(r).toEqual({ missing: "INVALID_INPUT", same: "OK" })
  }, T)

  test("evidence and object/value rules", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        yield* write(w, { rationale: "e", entities: twoEntities })
        const noEvidence = yield* codeOf(write(w, { rationale: "x", facts: [{ ...ownsFact, sources: [] }] }))
        const both = yield* codeOf(write(w, { rationale: "x", facts: [{ ...ownsFact, value: "x" }] }))
        const neither = yield* codeOf(write(w, { rationale: "x", facts: [{ subject: "customer/acme", predicate: "p", basis: "imported", sources: [src("a")] }] }))
        const nullValue = yield* codeOf(write(w, { rationale: "x", facts: [{ subject: "customer/acme", predicate: "p", value: null, basis: "imported", sources: [src("a")] }] }))
        return { noEvidence, both, neither, nullValue }
      }),
    )
    expect(r).toEqual({ noEvidence: "INVALID_INPUT", both: "INVALID_INPUT", neither: "INVALID_INPUT", nullValue: "OK" })
  }, T)

  test("updates enforce revision, ownership and existence", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w1 = yield* writer("w1")
        const w2 = yield* writer("w2")
        const created = yield* write(w1, { rationale: "c", entities: twoEntities, facts: [ownsFact] })
        const { id, revision } = created.facts[0]!
        const updated = yield* write(w1, { rationale: "u", facts: [{ ...ownsFact, id, revision, predicate: "managed-by" }] })
        const stale = yield* codeOf(write(w1, { rationale: "u", facts: [{ ...ownsFact, id, revision }] }))
        const notOwner = yield* codeOf(write(w2, { rationale: "u", facts: [{ ...ownsFact, id, revision: updated.facts[0]!.revision }] }))
        const notFound = yield* codeOf(write(w1, { rationale: "u", facts: [{ ...ownsFact, id: "f_missing", revision: "r" }] }))
        const missingRevision = yield* codeOf(write(w1, { rationale: "u", facts: [{ ...ownsFact, id }] }))
        return { changed: updated.facts[0]!.revision !== revision, stale, notOwner, notFound, missingRevision }
      }),
    )
    expect(r).toEqual({ changed: true, stale: "CONFLICT", notOwner: "NOT_OWNER", notFound: "NOT_FOUND", missingRevision: "INVALID_INPUT" })
  }, T)

  test("a basis the writer isn't registered for fails BASIS_NOT_ALLOWED", async () => {
    const code = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1", ["imported"])
        return yield* codeOf(write(w, { rationale: "x", entities: twoEntities, facts: [{ ...ownsFact, basis: "compiler-derived" }] }))
      }),
    )
    expect(code).toBe("BASIS_NOT_ALLOWED")
  }, T)

  test("batch keys resolve basedOn and contradicts; duplicate keys fail", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const res = yield* write(w, {
          rationale: "k",
          entities: twoEntities,
          facts: [
            { ...ownsFact, key: "finding" },
            { subject: "customer/acme", predicate: "at-risk", value: true, basis: "model-inferred", sources: [], basedOn: [{ key: "finding" }] },
            { subject: "customer/acme", predicate: "owned-by", object: "person/alex", basis: "imported", sources: [src("x")], contradicts: [{ key: "finding" }] },
          ],
        })
        const sql = yield* SqlClient.SqlClient
        const b = yield* sql<{ target_fact: string; target_revision: string }>`select target_fact, target_revision from fact_based_on`
        const c = yield* sql<{ target_fact: string }>`select target_fact from fact_contradicts`
        const dup = yield* codeOf(write(w, { rationale: "d", facts: [{ ...ownsFact, key: "a" }, { ...ownsFact, key: "a" }] }))
        const forward = yield* codeOf(write(w, { rationale: "f", facts: [{ ...ownsFact, basedOn: [{ key: "later" }] }, { ...ownsFact, key: "later" }] }))
        return { res, b, c, dup, forward }
      }),
    )
    expect(r.res.facts[0]!.key).toBe("finding")
    expect(r.b).toEqual([{ target_fact: r.res.facts[0]!.id, target_revision: r.res.facts[0]!.revision }])
    expect(r.c).toEqual([{ target_fact: r.res.facts[0]!.id }])
    expect(r.dup).toBe("INVALID_INPUT")
    expect(r.forward).toBe("INVALID_INPUT")
  }, T)

  test("self-reference and fact-level cycles fail INVALID_INPUT", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const a = (yield* write(w, { rationale: "a", entities: twoEntities, facts: [ownsFact] })).facts[0]!
        const b = (yield* write(w, { rationale: "b", facts: [{ ...ownsFact, sources: [], basedOn: [{ factId: a.id, revision: a.revision }] }] })).facts[0]!
        const self = yield* codeOf(write(w, { rationale: "s", facts: [{ ...ownsFact, id: a.id, revision: a.revision, basedOn: [{ factId: a.id, revision: a.revision }] }] }))
        const cycle = yield* codeOf(write(w, { rationale: "c", facts: [{ ...ownsFact, id: a.id, revision: a.revision, basedOn: [{ factId: b.id, revision: b.revision }] }] }))
        const selfContradict = yield* codeOf(write(w, { rationale: "s", facts: [{ ...ownsFact, id: a.id, revision: a.revision, contradicts: [a.id] }] }))
        return { self, cycle, selfContradict }
      }),
    )
    expect(r).toEqual({ self: "INVALID_INPUT", cycle: "INVALID_INPUT", selfContradict: "INVALID_INPUT" })
  }, T)

  test("a failing item rolls back the whole batch", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const code = yield* codeOf(
          write(w, { rationale: "x", entities: twoEntities, facts: [ownsFact, { ...ownsFact, object: "person/nobody" }] }),
        )
        const sql = yield* SqlClient.SqlClient
        const n = yield* sql<{ e: number; f: number }>`select (select count(*)::int from entities) as e, (select count(*)::int from facts) as f`
        return { code, ...n[0]! }
      }),
    )
    expect(r).toEqual({ code: "INVALID_INPUT", e: 0, f: 0 })
  }, T)

  test("two parallel updates from the same revision: exactly one CONFLICT", async () => {
    const codes = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        const { id, revision } = (yield* write(w, { rationale: "c", entities: twoEntities, facts: [ownsFact] })).facts[0]!
        const upd = (p: string) => codeOf(write(w, { rationale: p, facts: [{ ...ownsFact, id, revision, predicate: p }] }))
        return yield* Effect.all([upd("p1"), upd("p2")], { concurrency: 2 })
      }),
    )
    expect([...codes].sort()).toEqual(["CONFLICT", "OK"])
  }, T)

  test("retract records the reason, rejects other writers, and a batch may not touch a fact twice", async () => {
    const r = await runDb(
      Effect.gen(function* () {
        const w1 = yield* writer("w1")
        const w2 = yield* writer("w2")
        const f = (yield* write(w1, { rationale: "c", entities: twoEntities, facts: [ownsFact] })).facts[0]!
        const notOwner = yield* codeOf(write(w2, { rationale: "r", retract: [{ id: f.id, revision: f.revision, reason: "wrong" }] }))
        const twice = yield* codeOf(write(w1, { rationale: "r", facts: [{ ...ownsFact, id: f.id, revision: f.revision }], retract: [{ id: f.id, revision: f.revision, reason: "x" }] }))
        const res = yield* write(w1, { rationale: "r", retract: [{ id: f.id, revision: f.revision, reason: "wrong" }] })
        const sql = yield* SqlClient.SqlClient
        const row = yield* sql<{ status: string; retracted_reason: string }>`select status, retracted_reason from fact_revisions where revision = ${res.retracted[0]!.revision}`
        return { notOwner, twice, row: row[0]! }
      }),
    )
    expect(r).toEqual({ notOwner: "NOT_OWNER", twice: "INVALID_INPUT", row: { status: "retracted", retracted_reason: "wrong" } })
  }, T)

  test("more than 5,000 facts in one batch fails INVALID_INPUT", async () => {
    const code = await runDb(
      Effect.gen(function* () {
        const w = yield* writer("w1")
        return yield* codeOf(write(w, { rationale: "big", facts: Array.from({ length: 5001 }, () => ownsFact) }))
      }),
    )
    expect(code).toBe("INVALID_INPUT")
  }, T)
})

describe("write ergonomics", () => {
  test("sources may be omitted for facts that rest on other facts", async () => {
    const code = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      return yield* codeOf(write(w, {
        rationale: "x",
        entities: twoEntities,
        facts: [{ ...ownsFact, key: "a" }, { subject: "customer/acme", predicate: "at-risk", value: true, basis: "model-inferred", basedOn: [{ key: "a" }] } as never],
      }))
    }))
    expect(code).toBe("OK")
  }, T)

  test("dryRun validates and reports without writing", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      const res = yield* write(w, { rationale: "x", entities: twoEntities, facts: [ownsFact], dryRun: true })
      const sql = yield* SqlClient.SqlClient
      const n = yield* sql<{ f: number; e: number }>`select (select count(*)::int from facts) as f, (select count(*)::int from entities) as e`
      const bad = yield* codeOf(write(w, { rationale: "x", facts: [ownsFact], dryRun: true }))
      return { res, n: n[0]!, bad }
    }))
    expect(r.res.dryRun).toBe(true)
    expect(r.res.facts).toHaveLength(1)
    expect(r.n).toEqual({ f: 0, e: 0 })
    expect(r.bad).toBe("INVALID_INPUT")
  }, T)

  test("the result says which entities were created and which changed", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "a", entities: [ent("customer/acme", "Acme")] })
      return yield* write(w, { rationale: "b", entities: [ent("customer/acme", "Acme", ["A"]), ent("person/alex", "Alex"), ent("customer/acme", "Acme", ["A"])] })
    }))
    expect(r.entities).toEqual({ created: ["person/alex"], changed: ["customer/acme"] })
  }, T)
})
