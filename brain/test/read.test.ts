import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { getEntity, getFact, listFacts } from "../src/kg/read.ts"
import { sourceChanged } from "../src/kg/sources.ts"
import { write } from "../src/kg/write.ts"
import { codeOf, ent, runDb, src, writer } from "./support.ts"

const T = 60_000
const entities = [ent("customer/acme", "Acme"), ent("person/alex", "Alex"), ent("team/pricing", "Pricing")]
const fact = (predicate: string, extra: Record<string, unknown> = {}) => ({
  subject: "customer/acme", predicate, object: "person/alex", basis: "imported" as const, sources: [src("slack:C1/1")], ...extra,
})

describe("reads", () => {
  test("getEntity returns null for an unknown id", async () => {
    expect(await runDb(getEntity({ id: "customer/nobody" }))).toBeNull()
  }, T)

  test("getEntity returns facts about and pointing at the entity, newest first, capped at 50", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "e", entities })
      for (let i = 0; i < 51; i++) yield* write(w, { rationale: `f${i}`, facts: [fact(`p${i}`)] })
      return { acme: (yield* getEntity({ id: "customer/acme" }))!, alex: (yield* getEntity({ id: "person/alex" }))! }
    }))
    expect(r.acme.about).toHaveLength(50)
    expect(r.acme.moreAbout).toBe(true)
    expect(r.acme.about[0]!.fact.predicate).toBe("p50")
    expect(r.acme.pointingHere).toHaveLength(0)
    expect(r.alex.pointingHere).toHaveLength(50)
    expect(r.alex.morePointingHere).toBe(true)
    expect(r.acme.entity).toEqual({ id: "customer/acme", type: "customer", name: "Acme", aliases: [] })
  }, T)

  test("getFact returns support chains, contradictions in both directions, and history oldest first", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      const res = yield* write(w, {
        rationale: "seed",
        entities,
        facts: [
          fact("owned-by", { key: "a" }),
          fact("at-risk", { key: "b", sources: [], basedOn: [{ key: "a" }] }),
          fact("owned-by-other", { key: "c", contradicts: [{ key: "a" }] }),
        ],
      })
      const [a, b, c] = res.facts
      yield* write(w, { rationale: "upd", facts: [fact("owned-by", { id: a!.id, revision: a!.revision, object: "team/pricing" })] })
      const fa = (yield* getFact({ id: a!.id, includeHistory: true }))!
      const fb = (yield* getFact({ id: b!.id }))!
      const fc = (yield* getFact({ id: c!.id }))!
      return { a: a!, b: b!, c: c!, fa, fb, fc }
    }))
    expect(r.fa.supports.map((v) => v.fact.id)).toEqual([r.b.id])
    expect(r.fa.contradictions.map((v) => v.fact.id)).toEqual([r.c.id])
    expect(r.fc.contradictions.map((v) => v.fact.id)).toEqual([r.a.id])
    expect(r.fb.basedOn.map((v) => v.fact.id)).toEqual([r.a.id])
    expect(r.fa.history!.map((f) => f.object)).toEqual(["person/alex", "team/pricing"])
    expect(r.fb.history).toBeUndefined()
  }, T)

  test("getFact returns a retracted fact with its status", async () => {
    const f = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      const a = (yield* write(w, { rationale: "s", entities, facts: [fact("owned-by")] })).facts[0]!
      yield* write(w, { rationale: "r", retract: [{ id: a.id, revision: a.revision, reason: "wrong" }] })
      return (yield* getFact({ id: a.id }))!
    }))
    expect(f.view.fact.status).toBe("retracted")
    expect(f.view.fact.retractedReason).toBe("wrong")
  }, T)

  test("listFacts ANDs filters, supports sourceRef, sourceRefPrefix, writer, and staleOnly", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w1 = yield* writer("w1")
      const w2 = yield* writer("w2")
      yield* write(w1, { rationale: "e", entities })
      yield* write(w1, { rationale: "a", facts: [fact("owned-by", { sources: [src("git:dat/a:x.ts", "1")] })] })
      yield* write(w1, { rationale: "b", facts: [fact("owned-by", { sources: [src("git:dat/b:y.ts", "1")] })] })
      yield* write(w2, { rationale: "c", facts: [fact("managed-by", { sources: [src("git:dat/a:z.ts", "1")] })] })
      yield* sourceChanged(w1, { ref: "git:dat/a:x.ts", version: "2" })
      const ids = (p: { items: ReadonlyArray<{ fact: { sources: ReadonlyArray<{ ref: string }> } }> }) => p.items.map((v) => v.fact.sources[0]!.ref)
      return {
        both: ids(yield* listFacts({ predicate: "owned-by", writer: "w1" })),
        exact: ids(yield* listFacts({ sourceRef: "git:dat/a:x.ts" })),
        prefix: ids(yield* listFacts({ sourceRefPrefix: "git:dat/a:" })),
        stale: ids(yield* listFacts({ staleOnly: true })),
        tooBig: yield* codeOf(listFacts({ limit: 501 })),
      }
    }))
    expect(r.both).toEqual(["git:dat/b:y.ts", "git:dat/a:x.ts"])
    expect(r.exact).toEqual(["git:dat/a:x.ts"])
    expect(r.prefix).toEqual(["git:dat/a:z.ts", "git:dat/a:x.ts"])
    expect(r.stale).toEqual(["git:dat/a:x.ts"])
    expect(r.tooBig).toBe("INVALID_INPUT")
  }, T)

  test("listFacts pages through 120 facts with limit 50 without duplicates", async () => {
    const pages = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "e", entities, facts: Array.from({ length: 120 }, (_, i) => fact(`p${i}`)) })
      const sizes: number[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = yield* listFacts({ limit: 50, ...(cursor ? { cursor } : {}) })
        sizes.push(page.items.length)
        page.items.forEach((v) => seen.add(v.fact.id))
        cursor = page.nextCursor
      } while (cursor)
      return { sizes, unique: seen.size }
    }))
    expect(pages).toEqual({ sizes: [50, 50, 20], unique: 120 })
  }, T)
})

describe("readable results", () => {
  test("fact views carry the names of their subject and object", async () => {
    const v = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "s", entities, facts: [fact("owned-by")] })
      return (yield* getEntity({ id: "customer/acme" }))!.about[0]!
    }))
    expect(v.subjectName).toBe("Acme")
    expect(v.objectName).toBe("Alex")
  }, T)

  test("getEntity shows one fact of every predicate before repeats, and counts per predicate", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      yield* write(w, { rationale: "e", entities })
      yield* write(w, { rationale: "rare", facts: [fact("owned-by")] })
      yield* write(w, { rationale: "many", facts: Array.from({ length: 60 }, () => fact("mentioned-with")) })
      return (yield* getEntity({ id: "customer/acme" }))!
    }))
    expect(r.about.map((v) => v.fact.predicate).slice(0, 2).sort()).toEqual(["mentioned-with", "owned-by"])
    expect(r.aboutPredicates).toEqual({ "mentioned-with": 60, "owned-by": 1 })
    expect(r.about).toHaveLength(50)
  }, T)
})
