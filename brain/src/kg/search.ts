/** `search` (design rev 4 §6.3). */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Entity, SearchResult } from "../contract.ts"
import { Embedder } from "../embed/Embedder.ts"
import { toVector } from "../embed/worker.ts"
import { invalid } from "../errors.ts"
import { viewsOf } from "./views.ts"

const CANDIDATES = 100
const RRF_K = 60
/**
 * Compiler-derived facts count half in the fusion: a question asked in prose is usually about claims,
 * and code structure matches it mostly by shared identifier words. Code is still found by exact name
 * (entities) and ranks first when no claim matches.
 */
const STRUCTURE_WEIGHT = 0.5

export const search = (q: { text: string; limit?: number }) =>
  Effect.gen(function* () {
    const limit = q.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* invalid("limit must be between 1 and 100")
    const sql = yield* SqlClient.SqlClient
    const embedder = yield* Embedder

    const entities = yield* sql<Entity>`
      select id, type, name, aliases from entities where search_keys @> array[${q.text.trim().toLowerCase()}]::text[]
      order by (name = ${q.text.trim()}) desc, (${q.text.trim()} = any(aliases)) desc, (id = ${q.text.trim()}) desc, id
      limit ${limit}`

    // Full text: any of the question's lexemes may match; ranking rewards matching more of them.
    // Rank normalised by text length (flag 1), so long path-laden code texts don't win on coincidental words.
    const textHits = yield* sql<{ id: string; basis: string }>`
      with q as (
        select to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) as query
        from unnest(to_tsvector('english', ${q.text}))
      )
      select f.id, r.basis
      from q, facts f join fact_revisions r on r.revision = f.current_revision
      where q.query is not null and f.status = 'active' and r.tsv @@ q.query
      order by ts_rank_cd(r.tsv, q.query, 1) desc, f.recorded_at desc
      limit ${CANDIDATES}`

    // pgvector's HNSW scan returns at most hnsw.ef_search rows (default 40); raise it for this query only.
    const queryVector = embedder.enabled ? toVector(yield* embedder.embedQuery(q.text)) : undefined
    const vectorHits = queryVector
      ? yield* sql.withTransaction(
          Effect.gen(function* () {
            const v = queryVector
            yield* sql`set local hnsw.ef_search = ${sql.literal(String(CANDIDATES * 4))}`
            return yield* sql<{ id: string; basis: string }>`
              select f.id, r.basis
              from (select text_hash, embedding <=> ${v}::vector as d from fact_embeddings order by embedding <=> ${v}::vector limit ${CANDIDATES * 3}) e
              join fact_revisions r on r.text_hash = e.text_hash
              join facts f on f.current_revision = r.revision
              where f.status = 'active'
              order by e.d, f.id
              limit ${CANDIDATES}`
          }),
        )
      : ([] as Array<{ id: string; basis: string }>)

    const scores = new Map<string, number>()
    for (const hits of [textHits, vectorHits]) {
      const seen = new Set<string>()
      let rank = 0
      for (const { id, basis } of hits) {
        if (seen.has(id)) continue
        seen.add(id)
        rank += 1
        const weight = basis === "compiler-derived" ? STRUCTURE_WEIGHT : 1
        scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + rank))
      }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
    return {
      entities: entities.map((e) => ({ id: e.id, type: e.type, name: e.name, aliases: [...e.aliases] })),
      facts: yield* viewsOf(ranked),
    } satisfies SearchResult
  })
