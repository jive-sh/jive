import { Effect } from "effect"
import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"

const exec = Pg.Executor.make()
const CHUNK = 500

/** Multi-row insert in chunks; a no-op for no rows. Rows are built at runtime, so the plan is untyped here. */
export const insertRows = <T>(table: T, rows: ReadonlyArray<Record<string, unknown>>) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK)),
    (chunk) =>
      exec.execute(
        (Query.insert as any)(table).pipe(Query.from((Query.values as any)(chunk))),
      ),
    { discard: true },
  )
