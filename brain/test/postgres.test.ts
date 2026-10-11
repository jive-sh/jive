/** Runs against an external Postgres with pgvector when BRAIN_TEST_DATABASE_URL is set; skipped otherwise. */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Db } from "../src/db/client.ts"
import { write } from "../src/kg/write.ts"
import { codeOf, ent, src, writer } from "./support.ts"

const url = process.env["BRAIN_TEST_DATABASE_URL"]
const run = <A>(effect: Effect.Effect<A, unknown, any>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Fresh schema per test.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`drop schema if exists public cascade`
            yield* sql`create schema public`
          }).pipe(Effect.provide(Db.layerRaw({ databaseUrl: url! }))),
        )
        return yield* effect.pipe(Effect.provide(Db.layer({ databaseUrl: url! })))
      }),
    ) as Effect.Effect<A, unknown, never>,
  )

describe.skipIf(!url)("external Postgres", () => {
  test("two concurrent writes creating the same entity both succeed and merge aliases", async () => {
    const r = await run(Effect.gen(function* () {
      const w = yield* writer("w1")
      const codes = yield* Effect.all(
        [0, 1, 2, 3].map((i) => codeOf(write(w, { rationale: `w${i}`, entities: [ent("lib/shared", "Shared", [`alias${i}`])] }))),
        { concurrency: 4 },
      )
      const sql = yield* SqlClient.SqlClient
      const row = (yield* sql<{ aliases: string[] }>`select aliases from entities where id = 'lib/shared'`)[0]!
      return { codes, aliases: [...row.aliases].sort() }
    }))
    expect(r.codes).toEqual(["OK", "OK", "OK", "OK"])
    expect(r.aliases).toEqual(["alias0", "alias1", "alias2", "alias3"])
  }, 60_000)

  test("two concurrent updates from the same revision: exactly one CONFLICT", async () => {
    const codes = await run(Effect.gen(function* () {
      const w = yield* writer("w1")
      const fact = { subject: "x/e", predicate: "p", value: 1, basis: "imported" as const, sources: [src("s")] }
      const { id, revision } = (yield* write(w, { rationale: "c", entities: [ent("x/e")], facts: [fact] })).facts[0]!
      return yield* Effect.all(
        ["a", "b"].map((v) => codeOf(write(w, { rationale: v, facts: [{ ...fact, id, revision, value: v }] }))),
        { concurrency: 2 },
      )
    }))
    expect([...codes].sort()).toEqual(["CONFLICT", "OK"])
  }, 60_000)
})
