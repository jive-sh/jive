import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Embedder } from "../src/embed/Embedder.ts"

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)

describe("Embedder", () => {
  test("the local model ranks a paraphrase above unrelated facts", async () => {
    const docs = [
      "Pricing Platform team supports the Rate Engine",
      "Acme proposal due Oct 16",
      "retryRequest uses exponential backoff",
      "The office is closed on Fridays",
    ]
    const scores = await Effect.runPromise(
      Effect.gen(function* () {
        const e = yield* Embedder
        const q = yield* e.embedQuery("who is on call for pricing outages?")
        const d = yield* e.embedDocs(docs)
        return d.map((v) => cosine(q, v))
      }).pipe(Effect.provide(Embedder.Local())),
    )
    expect(scores.indexOf(Math.max(...scores))).toBe(0)
  }, 60_000)

  test("vectors are 384-dimensional and unit length; the fake embedder is deterministic", async () => {
    const r = await Effect.runPromise(
      Effect.gen(function* () {
        const e = yield* Embedder
        const [a, b] = yield* e.embedDocs(["rate engine retries", "rate engine retries"])
        return { a: a!, b: b! }
      }).pipe(Effect.provide(Embedder.Fake)),
    )
    expect(r.a).toHaveLength(384)
    expect(Math.abs(cosine(r.a, r.a) - 1)).toBeLessThan(1e-6)
    expect(r.a).toEqual(r.b)
  })
})
