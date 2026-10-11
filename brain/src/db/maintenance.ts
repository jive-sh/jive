/**
 * Planner statistics. PGlite has no autovacuum, so without this the planner believes every
 * table is empty and picks nested-loop plans that are quadratic once tables grow.
 */
import { Effect, Ref, Schedule } from "effect"
import { SqlClient } from "effect/sql"

/** An `analyzeIfChanged` that runs ANALYZE when fact revisions moved by more than 10% (or 1,000 rows) since its last run. */
export const makeAnalyzer = Effect.gen(function* () {
  const lastAnalyzed = yield* Ref.make(-1)
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql<{ n: number }>`select count(*)::int as n from fact_revisions`)[0]!.n
    const last = yield* Ref.get(lastAnalyzed)
    if (last >= 0 && Math.abs(rows - last) <= Math.max(1000, last * 0.1)) return false
    yield* sql`analyze`
    yield* Ref.set(lastAnalyzed, rows)
    return true
  })
})

export const runMaintenance = Effect.gen(function* () {
  const analyzeIfChanged = yield* makeAnalyzer
  return yield* analyzeIfChanged.pipe(
    Effect.catchCause((cause) => Effect.logError("analyze failed", cause).pipe(Effect.as(false))),
    Effect.repeat(Schedule.spaced("30 seconds")),
  )
})
