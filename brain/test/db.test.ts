import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Db } from "../src/db/client.ts"

describe("Db", () => {
  test("migrations apply twice on the same data dir and enable pgvector", async () => {
    const dir = `${import.meta.dir}/../.brain-data/test-db-${process.pid}`
    await Bun.$`rm -rf ${dir}`
    const extensions = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ extname: string }>`select extname from pg_extension`
    })
    await Effect.runPromise(Effect.scoped(Effect.provide(Effect.void, Db.layer({ dataDir: dir }))))
    const rows = await Effect.runPromise(Effect.scoped(Effect.provide(extensions, Db.layer({ dataDir: dir }))))
    expect(rows.map((r) => r.extname)).toContain("vector")
    await Bun.$`rm -rf ${dir}`
  }, 60_000)
})

import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import { tables } from "../src/db/tables.ts"

describe("tables", () => {
  test("effect-qb round-trips arrays, timestamptz and jsonb through PGlite", async () => {
    const exec = Pg.Executor.make()
    const program = Effect.gen(function* () {
      yield* exec.execute(Query.insert(tables.writers, { id: "w1", keyHash: "h1", allowedBases: ["imported", "model-inferred"] }))
      yield* exec.execute(
        Query.insert(tables.writes, { id: "wr1", actor: "w1", kind: "write", rationale: "test" }),
      )
      const writers = yield* exec.execute(
        Query.select({ id: tables.writers.id, bases: tables.writers.allowedBases, createdAt: tables.writers.createdAt }).pipe(
          Query.from(tables.writers),
        ),
      )
      yield* exec.execute(
        Query.insert(tables.entityHistory, { entityId: "e1", writeId: "wr1", after: { name: "E", aliases: ["x"] } }),
      )
      const history = yield* exec.execute(
        Query.select({ after: tables.entityHistory.after }).pipe(Query.from(tables.entityHistory)),
      )
      return { writers, history }
    })
    const { writers, history } = await Effect.runPromise(
      Effect.scoped(Effect.provide(program, Db.layer({ dataDir: "memory://" }))),
    )
    expect(writers[0]!.bases).toEqual(["imported", "model-inferred"])
    expect(typeof writers[0]!.createdAt).toBe("string")
    expect(history[0]!.after).toEqual({ name: "E", aliases: ["x"] })
  }, 60_000)
})
