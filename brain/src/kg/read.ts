/** getEntity, getFact, listFacts (design rev 4 §5). */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Entity, EntityResult, FactResult, FactView, ListFactsRequest, Page } from "../contract.ts"
import { invalid } from "../errors.ts"
import { loadRevisions, staleIdsSql, viewsOf } from "./views.ts"

const ENTITY_FACTS = 50

const encodeCursor = (recordedAt: string, id: string) => Buffer.from(JSON.stringify([recordedAt, id])).toString("base64url")
const decodeCursor = (cursor: string) =>
  Effect.try({
    try: () => {
      const [t, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string]
      if (typeof t !== "string" || typeof id !== "string") throw new Error("bad cursor")
      return { t, id }
    },
    catch: () => invalid("invalid cursor"),
  })

const iso = (t: string | Date) => (t instanceof Date ? t.toISOString() : new Date(t).toISOString())

export const entityById = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<Entity>`select id, type, name, aliases from entities where id = ${id}`
    return rows[0] ? { id: rows[0].id, type: rows[0].type, name: rows[0].name, aliases: [...rows[0].aliases] } : undefined
  })

/**
 * Up to ENTITY_FACTS active facts with `column` = id: the newest fact of each predicate first,
 * then the rest newest first, so one busy predicate can't hide the others.
 */
const diverseFacts = (column: "subject" | "object", id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const col = sql.literal(column)
    const rows = yield* sql<{ id: string }>`
      select id from (
        select id, recorded_at,
          row_number() over (partition by predicate order by recorded_at desc, id desc) as rank
        from facts where ${col} = ${id} and status = 'active'
      ) ranked
      order by rank, recorded_at desc, id desc
      limit ${ENTITY_FACTS + 1}`
    const counts = yield* sql<{ predicate: string; n: number }>`
      select predicate, count(*)::int as n from facts where ${col} = ${id} and status = 'active' group by predicate order by predicate`
    return {
      ids: rows.slice(0, ENTITY_FACTS).map((r) => r.id),
      more: rows.length > ENTITY_FACTS,
      counts: Object.fromEntries(counts.map((c) => [c.predicate, c.n])),
    }
  })

export const getEntity = (q: { id: string }) =>
  Effect.gen(function* () {
    const entity = yield* entityById(q.id)
    if (!entity) return null
    const about = yield* diverseFacts("subject", q.id)
    const pointing = yield* diverseFacts("object", q.id)
    return {
      entity,
      about: yield* viewsOf(about.ids),
      pointingHere: yield* viewsOf(pointing.ids),
      moreAbout: about.more,
      morePointingHere: pointing.more,
      aboutPredicates: about.counts,
      pointingHerePredicates: pointing.counts,
    } satisfies EntityResult
  })

export const getFact = (q: { id: string; includeHistory?: boolean }) =>
  Effect.gen(function* () {
    const [view] = yield* viewsOf([q.id])
    if (!view) return null
    const sql = yield* SqlClient.SqlClient
    const supports = yield* sql<{ id: string }>`
      select distinct f.id, f.recorded_at from fact_based_on b join facts f on f.current_revision = b.revision
      where b.target_fact = ${q.id} and f.status = 'active' order by f.recorded_at desc, f.id desc`
    const disputed = view.fact.contradicts.length === 0 ? [] : yield* sql<{ id: string }>`
      select f.id from facts f where f.id in ${sql.in(view.fact.contradicts)} and f.status = 'active'`
    const result: FactResult = {
      view,
      basedOn: yield* viewsOf([...new Set(view.fact.basedOn.map((b) => b.factId))]),
      supports: yield* viewsOf(supports.map((r) => r.id)),
      contradictions: yield* viewsOf([...new Set([...disputed.map((r) => r.id), ...view.contradictedBy])]),
    }
    if (q.includeHistory) {
      const revs = yield* sql<{ revision: string }>`select revision from fact_revisions where fact_id = ${q.id} order by seq`
      const facts = yield* loadRevisions(revs.map((r) => r.revision))
      result.history = revs.map((r) => facts.get(r.revision)!)
    }
    return result
  })

export const listFacts = (q: ListFactsRequest) =>
  Effect.gen(function* () {
    const limit = q.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return yield* invalid("limit must be between 1 and 500")
    const sql = yield* SqlClient.SqlClient
    const where = [sql`f.status = 'active'`]
    if (q.subject !== undefined) where.push(sql`f.subject = ${q.subject}`)
    if (q.object !== undefined) where.push(sql`f.object = ${q.object}`)
    if (q.predicate !== undefined) where.push(sql`f.predicate = ${q.predicate}`)
    if (q.writer !== undefined) where.push(sql`f.writer = ${q.writer}`)
    if (q.sourceRef !== undefined) {
      where.push(sql`exists (select 1 from fact_sources s where s.revision = f.current_revision and s.ref = ${q.sourceRef})`)
    }
    if (q.sourceRefPrefix !== undefined) {
      const pattern = q.sourceRefPrefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%"
      where.push(sql`exists (select 1 from fact_sources s where s.revision = f.current_revision and s.ref like ${pattern})`)
    }
    if (q.staleOnly) where.push(sql`f.id in (${sql.literal(staleIdsSql)})`)
    if (q.cursor !== undefined) {
      const c = yield* decodeCursor(q.cursor)
      where.push(sql`(f.recorded_at, f.id) < (${c.t}::timestamptz, ${c.id})`)
    }
    const rows = yield* sql<{ id: string; recorded_at: string | Date }>`
      select f.id, f.recorded_at from facts f where ${sql.and(where)}
      order by f.recorded_at desc, f.id desc limit ${limit + 1}`
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const result: Page<FactView> = { items: yield* viewsOf(page.map((r) => r.id)) }
    if (rows.length > limit && last) result.nextCursor = encodeCursor(iso(last.recorded_at), last.id)
    return result
  })
