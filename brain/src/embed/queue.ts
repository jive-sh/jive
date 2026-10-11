/** The embedding queue: texts waiting for a vector, so the worker never scans all facts to find them. */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Enqueue the texts of the active revisions a write produced (priority 0 unless compiler-derived). */
export const enqueueWrite = (writeId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      insert into embedding_queue (text_hash, text, priority)
      select distinct on (r.text_hash) r.text_hash, r.text, case when r.basis = 'compiler-derived' then 1 else 0 end
      from fact_revisions r
      where r.write_id = ${writeId} and r.status = 'active'
        and not exists (select 1 from fact_embeddings e where e.text_hash = r.text_hash)
      order by r.text_hash
      on conflict (text_hash) do nothing`
  })

/** Enqueue one text (used when a revision's text is recomputed). */
export const enqueueText = (textHash: string, text: string, basis: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      insert into embedding_queue (text_hash, text, priority)
      select ${textHash}, ${text}, ${basis === "compiler-derived" ? 1 : 0}
      where not exists (select 1 from fact_embeddings e where e.text_hash = ${textHash})
      on conflict (text_hash) do nothing`
  })
