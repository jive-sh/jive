import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAnalyzer } from "../src/db/maintenance.ts"
import { write } from "../src/kg/write.ts"
import { ent, runDb, src, writer } from "./support.ts"

describe("maintenance", () => {
  test("statistics are refreshed after a bulk change, and not again without one", async () => {
    const r = await runDb(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const analyzeIfChanged = yield* makeAnalyzer
      const tuples = () => sql<{ n: number }>`select reltuples::int as n from pg_class where relname = 'facts'`.pipe(Effect.map((x) => x[0]!.n))
      const w = yield* writer("w1")
      yield* write(w, { rationale: "bulk", entities: [ent("x/e")], facts: Array.from({ length: 1500 }, (_, i) => ({ subject: "x/e", predicate: `p${i}`, value: i, basis: "imported" as const, sources: [src("s")] })) })
      const before = yield* tuples()
      const first = yield* analyzeIfChanged
      const after = yield* tuples()
      const second = yield* analyzeIfChanged
      return { before, first, after, second }
    }))
    expect(r.before).toBeLessThan(1500)
    expect(r.first).toBe(true)
    expect(r.after).toBe(1500)
    expect(r.second).toBe(false)
  }, 30_000)
})
