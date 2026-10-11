import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { neighbors } from "../src/kg/neighbors.ts"
import { write } from "../src/kg/write.ts"
import { ent, runDb, src, writer } from "./support.ts"

const T = 30_000
const link = (subject: string, predicate: string, object: string) => ({ subject, predicate, object, basis: "imported" as const, sources: [src("s")] })
const seed = Effect.gen(function* () {
  const w = yield* writer("w1")
  yield* write(w, {
    rationale: "graph",
    entities: [ent("x/a"), ent("x/b"), ent("x/c")],
    facts: [link("x/a", "calls", "x/b"), link("x/b", "calls", "x/c"), link("x/b", "loops", "x/a"), { subject: "x/a", predicate: "note", value: "v", basis: "imported" as const, sources: [src("s")] }],
  })
})
const shape = (r: { paths: ReadonlyArray<{ facts: ReadonlyArray<{ fact: { subject: string; object?: string } }>; end: { id: string } }> }) =>
  r.paths.map((p) => [...p.facts.map((v) => `${v.fact.subject}->${v.fact.object}`), p.end.id].join(" | "))

describe("neighbors", () => {
  test("follows outgoing links breadth-first to the requested depth, never revisiting an entity", async () => {
    const r = await runDb(Effect.gen(function* () {
      yield* seed
      return shape(yield* neighbors({ from: "x/a", depth: 2 }))
    }))
    expect(r).toEqual(["x/a->x/b | x/b", "x/a->x/b | x/b->x/c | x/c"])
  }, T)

  test("direction 'in' walks links backwards", async () => {
    const r = await runDb(Effect.gen(function* () {
      yield* seed
      return shape(yield* neighbors({ from: "x/c", direction: "in" }))
    }))
    expect(r).toEqual(["x/b->x/c | x/b"])
  }, T)

  test("predicate filter and truncation", async () => {
    const r = await runDb(Effect.gen(function* () {
      yield* seed
      const loops = shape(yield* neighbors({ from: "x/b", predicates: ["loops"] }))
      const one = yield* neighbors({ from: "x/a", depth: 2, limit: 1 })
      return { loops, one: { n: one.paths.length, truncated: one.truncated } }
    }))
    expect(r).toEqual({ loops: ["x/b->x/a | x/a"], one: { n: 1, truncated: true } })
  }, T)
})
