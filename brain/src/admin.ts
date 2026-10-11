/** Administration (design rev 4 §6.5): writers, keys, and reverts. */
import { Clock, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import type { Basis, Writer } from "./contract.ts"
import { tables } from "./db/tables.ts"
import { fail } from "./errors.ts"
import { newId } from "./ids.ts"
import { enqueueWrite } from "./embed/queue.ts"
import { refreshText } from "./kg/write.ts"

const exec = Pg.Executor.make()
const { writers, writes } = tables

const hashKey = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex")
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")

/** Record an admin call in `writes`. */
const recordAdmin = (kind: string, rationale: string) =>
  exec.execute(Query.insert(writes, { id: newId("w"), actor: "admin", kind, rationale }))

const findWriter = (writerId: string) =>
  exec.execute(Query.select({ id: writers.id }).pipe(Query.from(writers), Query.where(Query.eq(writers.id, writerId)))).pipe(
    Pg.Executor.atMostOne,
  )

export const registerWriter = (req: { writerId: string; allowedBases: ReadonlyArray<Basis> }) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* findWriter(req.writerId))) {
      return yield* fail("INVALID_INPUT", `writer ${req.writerId} already exists`)
    }
    const apiKey = newKey()
    yield* exec.execute(
      Query.insert(writers, { id: req.writerId, keyHash: hashKey(apiKey), allowedBases: [...new Set(req.allowedBases)] }),
    )
    yield* recordAdmin("registerWriter", `register ${req.writerId}`)
    return { writerId: req.writerId, apiKey }
  }).pipe(Pg.Executor.withTransaction)

export const rotateKey = (req: { writerId: string }) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* findWriter(req.writerId))) return yield* fail("NOT_FOUND", `no writer ${req.writerId}`)
    const apiKey = newKey()
    yield* exec.execute(
      Query.update(writers, { keyHash: hashKey(apiKey) }).pipe(Query.where(Query.eq(writers.id, req.writerId))),
    )
    yield* recordAdmin("rotateKey", `rotate ${req.writerId}`)
    return { writerId: req.writerId, apiKey }
  }).pipe(Pg.Executor.withTransaction)

export const listWriters = () =>
  exec
    .execute(
      Query.select({ writerId: writers.id, allowedBases: writers.allowedBases, createdAt: writers.createdAt }).pipe(
        Query.from(writers),
        Query.orderBy(writers.id),
      ),
    )
    .pipe(Effect.map((rows) => rows.map((r) => ({ ...r, allowedBases: r.allowedBases as Basis[] }))))

export const authenticate = (apiKey: string): Effect.Effect<Writer, unknown, any> =>
  exec
    .execute(
      Query.select({ id: writers.id, allowedBases: writers.allowedBases }).pipe(
        Query.from(writers),
        Query.where(Query.eq(writers.keyHash, hashKey(apiKey))),
      ),
    )
    .pipe(
      Pg.Executor.atMostOne,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("UNAUTHENTICATED", "unknown API key")),
          onSome: (w) => Effect.succeed({ id: w.id, allowedBases: w.allowedBases as Basis[] }),
        }),
      ),
    )

/**
 * Undo a writer's changes made at or after `since` (design rev 4 §6.5), as one admin write.
 */
export const revertWriter = (req: { writerId: string; since: string }) =>
  Effect.gen(function* () {
    const since = new Date(req.since)
    if (Number.isNaN(since.getTime())) return yield* fail("INVALID_INPUT", `since is not a timestamp: ${req.since}`)
    if (Option.isNone(yield* findWriter(req.writerId))) return yield* fail("NOT_FOUND", `no writer ${req.writerId}`)
    const sql = yield* SqlClient.SqlClient
    const sinceIso = since.toISOString()
    const writeId = newId("w")
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* exec.execute(
      Query.insert(writes, { id: writeId, actor: "admin", kind: "revertWriter", rationale: `revert ${req.writerId} since ${sinceIso}` }),
    )

    // Facts: the writer's own revisions since the cutoff.
    const changed = yield* sql<{ fact_id: string; current_revision: string; seq: number; before: string | null }>`
      select f.id as fact_id, f.current_revision,
        (select max(seq) from fact_revisions x where x.fact_id = f.id)::int as seq,
        (select x.revision from fact_revisions x where x.fact_id = f.id and x.recorded_at < ${sinceIso}::timestamptz
          order by x.seq desc limit 1) as before
      from facts f
      where f.id in (
        select r.fact_id from fact_revisions r join writes w on w.id = r.write_id
        where w.actor = ${req.writerId} and r.recorded_at >= ${sinceIso}::timestamptz)
      for update of f`
    let restoredFacts = 0
    let retractedFacts = 0
    const touchedEntities = new Set<string>()
    for (const c of changed) {
      const revision = newId("r")
      const from = c.before ?? c.current_revision
      const status = c.before ? sql`status, retracted_reason` : sql`'retracted', 'reverted'`
      yield* sql`
        insert into fact_revisions (revision, fact_id, seq, write_id, recorded_at, subject, predicate, object, value, has_value,
          basis, status, retracted_reason, text, text_hash)
        select ${revision}, fact_id, ${c.seq + 1}, ${writeId}, ${recordedAt}::timestamptz, subject, predicate, object, value, has_value,
          basis, ${status}, text, text_hash
        from fact_revisions where revision = ${from}`
      yield* sql`insert into fact_sources (revision, idx, ref, version, at, quote, locator)
        select ${revision}, idx, ref, version, at, quote, locator from fact_sources where revision = ${from}`
      yield* sql`insert into fact_based_on (revision, idx, target_fact, target_revision)
        select ${revision}, idx, target_fact, target_revision from fact_based_on where revision = ${from}`
      yield* sql`insert into fact_contradicts (revision, target_fact)
        select ${revision}, target_fact from fact_contradicts where revision = ${from}`
      const row = (yield* sql<{ subject: string; object: string | null }>`
        update facts f set current_revision = r.revision, subject = r.subject, predicate = r.predicate, object = r.object,
          status = r.status, recorded_at = r.recorded_at
        from fact_revisions r where r.revision = ${revision} and f.id = r.fact_id
        returning f.subject, f.object`)[0]!
      touchedEntities.add(row.subject)
      if (row.object) touchedEntities.add(row.object)
      if (c.before) restoredFacts++
      else retractedFacts++
    }

    // Entities: restore the state before the writer's first change since the cutoff.
    const firstChanges = yield* sql<{ entity_id: string; before: { type: string; name: string; aliases: string[] } | null }>`
      select distinct on (h.entity_id) h.entity_id, h.before
      from entity_history h join writes w on w.id = h.write_id
      where w.actor = ${req.writerId} and w.created_at >= ${sinceIso}::timestamptz
      order by h.entity_id, h.seq`
    let restoredEntities = 0
    for (const h of firstChanges) {
      if (!h.before) continue // created after the cutoff; entities have no owner, so it stays
      const current = (yield* sql<{ type: string; name: string; aliases: string[] }>`
        select type, name, aliases from entities where id = ${h.entity_id} for update`)[0]!
      const keys = [...new Set([h.entity_id, h.before.name, ...h.before.aliases].map((s) => s.toLowerCase()))]
      yield* sql`update entities set type = ${h.before.type}, name = ${h.before.name}, aliases = ${h.before.aliases},
        search_keys = ${keys} where id = ${h.entity_id}`
      yield* exec.execute(
        Query.insert(tables.entityHistory, { entityId: h.entity_id, writeId, before: current, after: h.before }),
      )
      touchedEntities.add(h.entity_id)
      restoredEntities++
    }

    // Source reports.
    const reverted = yield* sql<{ seq: string }>`
      update source_reports set reverted = true
      where not reverted and write_id in (select id from writes where actor = ${req.writerId} and created_at >= ${sinceIso}::timestamptz)
      returning seq`

    yield* enqueueWrite(writeId)
    yield* refreshText([...touchedEntities])
    return { restoredFacts, retractedFacts, restoredEntities, revertedSourceReports: reverted.length }
  }).pipe(Pg.Executor.withTransaction)
