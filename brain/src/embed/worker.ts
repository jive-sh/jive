/** Background embedding (design rev 4 §6.3): fills fact_embeddings for current active facts. */
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Embedder } from "./Embedder.ts"

const PER_THREAD = 32

/** The next queued texts: facts that aren't compiler-derived first (few, and they carry most of the meaning). */
export const nextPending = (limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ text_hash: string; text: string }>`
      select text_hash, text from embedding_queue order by priority, text_hash limit ${limit}`
  })

export const toVector = (v: ReadonlyArray<number>) => `[${v.join(",")}]`

/** Number of texts waiting in the embedding queue. */
export const pendingCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql<{ n: number }>`select count(*)::int as n from embedding_queue`)[0]!.n
})

/** Embed every pending text; returns how many were embedded. */
export const drain = Effect.gen(function* () {
  const embedder = yield* Embedder
  if (!embedder.enabled) return 0
  const sql = yield* SqlClient.SqlClient
  let total = 0
  for (;;) {
    const batch = yield* nextPending(PER_THREAD * embedder.parallelism)
    if (batch.length === 0) return total
    const vectors = yield* embedder.embedDocs(batch.map((r) => r.text))
    yield* sql`insert into fact_embeddings (text_hash, embedding)
      values ${sql.csv(batch.map((row, i) => sql`(${row.text_hash}, ${toVector(vectors[i]!)}::vector)`))}
      on conflict (text_hash) do nothing`
    yield* sql`delete from embedding_queue where text_hash in ${sql.in(batch.map((r) => r.text_hash))}`
    total += batch.length
    // PGlite and the model both run on this thread and resolve as microtasks; without a real
    // timer between batches, a long backlog starves the HTTP server of I/O turns.
  }
})

/** Drain forever, pausing a second whenever there is nothing to do. */
export const runWorker = drain.pipe(
  Effect.catchCause((cause) => Effect.logError("embedding worker failed", cause).pipe(Effect.as(0))),
  Effect.repeat(Schedule.spaced("1 second")),
)
