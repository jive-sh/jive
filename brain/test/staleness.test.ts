import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sourceChanged } from "../src/kg/sources.ts"
import { viewsOf } from "../src/kg/views.ts"
import { write } from "../src/kg/write.ts"
import { ent, runDb, src, writer } from "./support.ts"

const T = 30_000
const base = { subject: "service/rate-engine", predicate: "retry-behavior", basis: "imported" as const }

/** A cites git file v1; B rests on A; C rests on B. */
const chain = Effect.gen(function* () {
  const w = yield* writer("w1")
  const res = yield* write(w, {
    rationale: "seed",
    entities: [ent("service/rate-engine", "Rate Engine")],
    facts: [
      { ...base, key: "a", value: "fixed 5s", sources: [src("git:dat/rate:src/retry.ts", "blob1")] },
      { ...base, key: "b", value: "slow retries", sources: [], basedOn: [{ key: "a" }] },
      { ...base, key: "c", value: "outage risk", sources: [], basedOn: [{ key: "b" }] },
    ],
  })
  const [a, b, c] = res.facts as [typeof res.facts[0], typeof res.facts[0], typeof res.facts[0]]
  return { w, a: a!, b: b!, c: c! }
})

describe("staleness", () => {
  test("a ref never reported is fresh", async () => {
    const v = await runDb(Effect.gen(function* () {
      const { a } = yield* chain
      return (yield* viewsOf([a.id]))[0]!
    }))
    expect(v.stale).toBe(false)
    expect(v.staleBecause).toEqual([])
  }, T)

  test("reporting a different version makes the citing fact and everything resting on it stale", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { w, a, b, c } = yield* chain
      const first = yield* sourceChanged(w, { ref: "git:dat/rate:src/retry.ts", version: "blob2" })
      const again = yield* sourceChanged(w, { ref: "git:dat/rate:src/retry.ts", version: "blob2" })
      const [va, vb, vc] = yield* viewsOf([a.id, b.id, c.id])
      return { first, again, va: va!, vb: vb!, vc: vc! }
    }))
    expect(r.first.newlyStale).toBe(3)
    expect(r.again.newlyStale).toBe(0)
    expect(r.va.staleBecause).toEqual([{ ref: "git:dat/rate:src/retry.ts", citedVersion: "blob1", latestVersion: "blob2" }])
    expect(r.vb.stale).toBe(true)
    expect(r.vc.staleBecause).toEqual([{ factId: r.vb.fact.id, reason: "stale" }])
  }, T)

  test("reporting the cited version again keeps facts fresh", async () => {
    const n = await runDb(Effect.gen(function* () {
      const { w } = yield* chain
      return (yield* sourceChanged(w, { ref: "git:dat/rate:src/retry.ts", version: "blob1" })).newlyStale
    }))
    expect(n).toBe(0)
  }, T)

  test("retracting or revising a supporting fact makes dependents stale with that reason", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { w, a, b, c } = yield* chain
      yield* write(w, { rationale: "revise a", facts: [{ ...base, id: a.id, revision: a.revision, value: "fixed 10s", sources: [src("git:dat/rate:src/retry.ts", "blob1")] }] })
      const [vb1] = yield* viewsOf([b.id])
      yield* write(w, { rationale: "retract b", retract: [{ id: b.id, revision: b.revision, reason: "wrong" }] })
      const [vc] = yield* viewsOf([c.id])
      return { vb1: vb1!, vc: vc! }
    }))
    expect(r.vb1.staleBecause).toEqual([{ factId: r.vb1.fact.basedOn[0]!.factId, reason: "revised" }])
    expect(r.vc.staleBecause).toEqual([{ factId: r.vc.fact.basedOn[0]!.factId, reason: "retracted" }])
  }, T)

  test("updating a stale fact to cite the latest version makes it fresh again", async () => {
    const r = await runDb(Effect.gen(function* () {
      const { w, a, b } = yield* chain
      yield* sourceChanged(w, { ref: "git:dat/rate:src/retry.ts", version: "blob2" })
      yield* write(w, { rationale: "refresh", facts: [{ ...base, id: a.id, revision: a.revision, value: "fixed 5s", sources: [src("git:dat/rate:src/retry.ts", "blob2")] }] })
      const [va, vb] = yield* viewsOf([a.id, b.id])
      return { va: va!, vb: vb! }
    }))
    expect(r.va.stale).toBe(false)
    expect(r.vb.staleBecause).toEqual([{ factId: r.va.fact.id, reason: "revised" }])
  }, T)

  test("contradictedBy lists only active contradicting facts", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      const res = yield* write(w, {
        rationale: "c",
        entities: [ent("service/rate-engine")],
        facts: [
          { ...base, key: "x", value: "fixed", sources: [src("s1")] },
          { ...base, key: "y", value: "exponential", sources: [src("s2")], contradicts: [{ key: "x" }] },
          { ...base, key: "z", value: "none", sources: [src("s3")], contradicts: [{ key: "x" }] },
        ],
      })
      const [x, , z] = res.facts
      yield* write(w, { rationale: "r", retract: [{ id: z!.id, revision: z!.revision, reason: "wrong" }] })
      const [vx] = yield* viewsOf([x!.id])
      return { vx: vx!, y: res.facts[1]!.id }
    }))
    expect(r.vx.contradictedBy).toEqual([r.y])
  }, T)
})
