/** `sourceChanged` (design rev 4 §4.3, §6.4). */
import { Effect } from "effect"
import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import { SqlClient } from "effect/sql"
import { newId } from "../ids.ts"
import type { Writer } from "../contract.ts"
import { tables } from "../db/tables.ts"
import { stalenessOf } from "./views.ts"

const exec = Pg.Executor.make()

/** Active facts citing `ref`, and every active fact resting on them (transitively). */
const affectedBy = (ref: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string }>`
      with recursive up(id) as (
        select f.id from facts f join fact_sources s on s.revision = f.current_revision where s.ref = ${ref}
        union
        select f.id from up join fact_based_on b on b.target_fact = up.id join facts f on f.current_revision = b.revision
      ) select up.id from up join facts f on f.id = up.id where f.status = 'active'`
    return rows.map((r) => r.id)
  })

export const sourceChanged = (writer: Writer, req: { ref: string; version: string }) =>
  Effect.gen(function* () {
    const ids = yield* affectedBy(req.ref)
    const before = yield* stalenessOf(ids)
    const writeId = newId("w")
    yield* exec.execute(
      Query.insert(tables.writes, { id: writeId, actor: writer.id, kind: "sourceChanged", rationale: `${req.ref} @ ${req.version}` }),
    )
    yield* exec.execute(Query.insert(tables.sourceReports, { ref: req.ref, version: req.version, writeId }))
    const after = yield* stalenessOf(ids)
    const newlyStale = ids.filter((id) => (before.get(id)?.length ?? 0) === 0 && (after.get(id)?.length ?? 0) > 0).length
    return { newlyStale }
  }).pipe(Pg.Executor.withTransaction)
