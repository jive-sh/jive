/** `write` (design rev 4 §4.1, §4.2, §5.1). */
import { Clock, Effect } from "effect"
import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import { SqlClient } from "effect/sql"
import { newId } from "../ids.ts"
import type { Entity, Json, WriteFactItem, WriteRequest, WriteResult, Writer } from "../contract.ts"
import { insertRows } from "../db/bulk.ts"
import { tables } from "../db/tables.ts"
import { fail, invalid } from "../errors.ts"
import { enqueueText, enqueueWrite } from "../embed/queue.ts"
import { factText, textHash } from "./text.ts"

const exec = Pg.Executor.make()
const LIMIT = 5000

const hasValue = (item: WriteFactItem) => Object.prototype.hasOwnProperty.call(item, "value")
const sourcesOf = (item: WriteFactItem) => item.sources ?? []
const isKeyRef = <T>(r: T): r is Extract<T, { readonly key: string }> => typeof r === "object" && r !== null && "key" in r
const searchKeys = (e: { id: string; name: string; aliases: ReadonlyArray<string> }) =>
  [...new Set([e.id, e.name, ...e.aliases].map((s) => s.toLowerCase()))]

/** Checks that need no database. */
const checkShape = (writer: Writer, batch: WriteRequest) =>
  Effect.gen(function* () {
    const facts = batch.facts ?? []
    const retract = batch.retract ?? []
    if (facts.length > LIMIT || (batch.entities?.length ?? 0) > LIMIT || retract.length > LIMIT) {
      return yield* invalid(`a batch may contain at most ${LIMIT} facts, ${LIMIT} entities and ${LIMIT} retractions`)
    }
    const keys = new Map<string, number>()
    const touched = new Set<string>()
    for (const [i, item] of facts.entries()) {
      const at = `facts[${i}]`
      const object = item.object !== undefined
      if (object === hasValue(item)) return yield* invalid(`${at}: exactly one of object or value must be set`)
      if (sourcesOf(item).length + (item.basedOn?.length ?? 0) === 0) {
        return yield* invalid(`${at}: a fact needs at least one source or basedOn entry`)
      }
      if ((item.id === undefined) !== (item.revision === undefined)) {
        return yield* invalid(`${at}: id and revision must be given together`)
      }
      if (!writer.allowedBases.includes(item.basis)) {
        return yield* fail("BASIS_NOT_ALLOWED", `${at}: writer ${writer.id} may not write basis ${item.basis}`)
      }
      for (const ref of [...(item.basedOn ?? []), ...(item.contradicts ?? [])]) {
        if (isKeyRef(ref) && !(keys.get(ref.key)! < i)) {
          return yield* invalid(`${at}: key ${ref.key} must name an earlier fact in this batch`)
        }
      }
      if (item.key !== undefined) {
        if (keys.has(item.key)) return yield* invalid(`${at}: duplicate key ${item.key}`)
        keys.set(item.key, i)
      }
      if (item.id !== undefined) {
        if (touched.has(item.id)) return yield* invalid(`${at}: fact ${item.id} appears twice in this batch`)
        touched.add(item.id)
      }
    }
    for (const [i, r] of retract.entries()) {
      if (touched.has(r.id)) return yield* invalid(`retract[${i}]: fact ${r.id} appears twice in this batch`)
      touched.add(r.id)
    }
  })

interface EntityRow {
  id: string
  type: string
  name: string
  aliases: string[]
}

const upsertEntities = (writeId: string, entities: ReadonlyArray<Entity>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const renamed = new Set<string>()
    const created: string[] = []
    const changed: string[] = []
    if (entities.length === 0) return { renamed, created, changed }
    const ids = [...new Set(entities.map((e) => e.id))]
    const existing = new Map<string, EntityRow>()
    for (const row of yield* sql<EntityRow>`select id, type, name, aliases from entities where id in ${sql.in(ids)} for update`) {
      existing.set(row.id, row)
    }
    const before = new Map(existing)
    const next = new Map<string, EntityRow>()
    for (const e of entities) {
      const prev = next.get(e.id) ?? existing.get(e.id)
      const aliases = [...new Set([...(prev?.aliases ?? []), ...e.aliases])]
      next.set(e.id, { id: e.id, type: e.type, name: e.name, aliases })
    }
    const inserts: EntityRow[] = []
    const history: Record<string, unknown>[] = []
    for (const [id, row] of next) {
      const prev = before.get(id)
      if (!prev) {
        created.push(id)
        inserts.push(row)
        history.push({ entityId: id, writeId, before: null, after: { type: row.type, name: row.name, aliases: row.aliases } })
        continue
      }
      const same = prev.type === row.type && prev.name === row.name && prev.aliases.join("\u0000") === row.aliases.join("\u0000")
      if (same) continue
      changed.push(id)
      if (prev.name !== row.name) renamed.add(id)
      yield* exec.execute(
        Query.update(tables.entities, { type: row.type, name: row.name, aliases: row.aliases, searchKeys: searchKeys(row) }).pipe(
          Query.where(Query.eq(tables.entities.id, id)),
        ),
      )
      history.push({
        entityId: id,
        writeId,
        before: { type: prev.type, name: prev.name, aliases: prev.aliases },
        after: { type: row.type, name: row.name, aliases: row.aliases },
      })
    }
    yield* insertRows(tables.entities, inserts.map((r) => ({ ...r, searchKeys: searchKeys(r) })))
    yield* insertRows(tables.entityHistory, history)
    return { renamed, created, changed }
  })

interface CurrentFact {
  id: string
  writer: string
  current_revision: string
  seq: number
}

interface RevisionContent {
  revision: string
  subject: string
  predicate: string
  object: string | null
  value: Json | null
  has_value: boolean
  basis: string
  text: string
  text_hash: string
}

/** Recompute stored text for current revisions that mention renamed entities. */
export const refreshText = (entityIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (entityIds.length === 0) return
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<RevisionContent & { subject_name: string; object_name: string | null; quotes: string[] | null }>`
      select r.revision, r.subject, r.predicate, r.object, r.value, r.has_value, r.basis, r.text, r.text_hash,
             s.name as subject_name, o.name as object_name,
             (select array_agg(q.quote order by q.idx) from fact_sources q where q.revision = r.revision and q.quote is not null) as quotes
      from facts f
      join fact_revisions r on r.revision = f.current_revision
      join entities s on s.id = r.subject
      left join entities o on o.id = r.object
      where f.subject in ${sql.in(entityIds)} or f.object in ${sql.in(entityIds)}`
    for (const r of rows) {
      const text = factText({
        subjectName: r.subject_name,
        predicate: r.predicate,
        objectName: r.object_name ?? undefined,
        hasValue: r.has_value,
        value: r.value,
        quotes: r.quotes ?? [],
      })
      if (text !== r.text) {
        const hash = textHash(text)
        yield* sql`update fact_revisions set text = ${text}, text_hash = ${hash} where revision = ${r.revision}`
        yield* enqueueText(hash, text, r.basis)
      }
    }
  })

const checkCycles = (factIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (factIds.length === 0) return
    const sql = yield* SqlClient.SqlClient
    const cyclic = yield* sql<{ start: string }>`
      with recursive walk(start, node, path) as (
        select f.id, b.target_fact, array[f.id]
        from facts f join fact_based_on b on b.revision = f.current_revision
        where f.id in ${sql.in(factIds)}
        union all
        select w.start, b.target_fact, w.path || w.node
        from walk w
        join facts f on f.id = w.node
        join fact_based_on b on b.revision = f.current_revision
        where not (w.node = any(w.path))
      )
      select start from walk where node = start limit 1`
    if (cyclic.length > 0) return yield* invalid(`basedOn would form a cycle through fact ${cyclic[0]!.start}`)
  })

const applyBatch = (writer: Writer, batch: WriteRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const items = batch.facts ?? []
    const retract = batch.retract ?? []
    const writeId = newId("w")
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* exec.execute(Query.insert(tables.writes, { id: writeId, actor: writer.id, kind: "write", rationale: batch.rationale }))

    const { renamed, created, changed } = yield* upsertEntities(writeId, batch.entities ?? [])

    // Entities referenced by facts must exist now.
    const entityIds = [...new Set(items.flatMap((f) => (f.object !== undefined ? [f.subject, f.object] : [f.subject])))]
    const names = new Map<string, string>()
    if (entityIds.length > 0) {
      for (const r of yield* sql<{ id: string; name: string }>`select id, name from entities where id in ${sql.in(entityIds)}`) {
        names.set(r.id, r.name)
      }
      const missing = entityIds.filter((id) => !names.has(id))
      if (missing.length > 0) return yield* invalid(`unknown entities: ${missing.slice(0, 10).join(", ")}`, { missing })
    }

    // Facts being updated or retracted.
    const targetIds = [...items.flatMap((f) => (f.id !== undefined ? [f.id] : [])), ...retract.map((r) => r.id)]
    const current = new Map<string, CurrentFact>()
    if (targetIds.length > 0) {
      for (const r of yield* sql<CurrentFact>`
        select f.id, f.writer, f.current_revision, (select max(seq) from fact_revisions r where r.fact_id = f.id)::int as seq
        from facts f where f.id in ${sql.in(targetIds)} for update`) current.set(r.id, r)
    }
    const checkTarget = (at: string, id: string, revision: string) =>
      Effect.gen(function* () {
        const c = current.get(id)
        if (!c) return yield* fail("NOT_FOUND", `${at}: no fact ${id}`)
        if (c.writer !== writer.id) return yield* fail("NOT_OWNER", `${at}: fact ${id} belongs to ${c.writer}`)
        if (c.current_revision !== revision) {
          return yield* fail("CONFLICT", `${at}: fact ${id} is at revision ${c.current_revision}, not ${revision}`, {
            currentRevision: c.current_revision,
          })
        }
        return c
      })

    // Referenced existing facts.
    const citedRevisions = items.flatMap((f) => (f.basedOn ?? []).flatMap((b) => (isKeyRef(b) ? [] : [b.revision])))
    const knownRevisions = new Map<string, string>()
    if (citedRevisions.length > 0) {
      for (const r of yield* sql<{ revision: string; fact_id: string }>`
        select revision, fact_id from fact_revisions where revision in ${sql.in([...new Set(citedRevisions)])}`) {
        knownRevisions.set(r.revision, r.fact_id)
      }
    }
    const contradictedIds = items.flatMap((f) => (f.contradicts ?? []).flatMap((c) => (isKeyRef(c) ? [] : [c])))
    const knownFacts = new Set<string>()
    if (contradictedIds.length > 0) {
      for (const r of yield* sql<{ id: string }>`select id from facts where id in ${sql.in([...new Set(contradictedIds)])}`) {
        knownFacts.add(r.id)
      }
    }

    const byKey = new Map<string, { id: string; revision: string }>()
    const revisions: Record<string, unknown>[] = []
    const sources: Record<string, unknown>[] = []
    const basedOnRows: Record<string, unknown>[] = []
    const contradictRows: Record<string, unknown>[] = []
    const factRows: Record<string, unknown>[] = []
    const results: WriteResult["facts"] = []
    const withBasedOn: string[] = []

    for (const [i, item] of items.entries()) {
      const at = `facts[${i}]`
      const prev = item.id !== undefined ? yield* checkTarget(at, item.id, item.revision!) : undefined
      const id = prev?.id ?? newId("f")
      const revision = newId("r")
      const basedOn: Array<{ factId: string; revision: string }> = []
      for (const b of item.basedOn ?? []) {
        if (isKeyRef(b)) {
          basedOn.push({ factId: byKey.get(b.key)!.id, revision: byKey.get(b.key)!.revision })
        } else {
          if (knownRevisions.get(b.revision) !== b.factId) {
            return yield* invalid(`${at}: basedOn cites unknown fact revision ${b.factId}@${b.revision}`)
          }
          basedOn.push(b)
        }
      }
      const contradicts = (item.contradicts ?? []).map((c) => (isKeyRef(c) ? byKey.get(c.key)!.id : c))
      for (const c of item.contradicts ?? []) {
        if (!isKeyRef(c) && !knownFacts.has(c)) return yield* invalid(`${at}: contradicts unknown fact ${c}`)
      }
      if (basedOn.some((b) => b.factId === id) || contradicts.includes(id)) {
        return yield* invalid(`${at}: a fact may not reference itself`)
      }
      const text = factText({
        subjectName: names.get(item.subject)!,
        predicate: item.predicate,
        objectName: item.object !== undefined ? names.get(item.object) : undefined,
        hasValue: hasValue(item),
        value: item.value,
        quotes: sourcesOf(item).flatMap((s) => (s.quote ? [s.quote] : [])),
      })
      revisions.push({
        revision,
        factId: id,
        seq: (prev?.seq ?? 0) + 1,
        writeId,
        recordedAt,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object ?? null,
        value: hasValue(item) ? (item.value ?? null) : null,
        hasValue: hasValue(item),
        basis: item.basis,
        status: "active",
        retractedReason: null,
        text,
        textHash: textHash(text),
      })
      sourcesOf(item).forEach((s, idx) =>
        sources.push({ revision, idx, ref: s.ref, version: s.version, at: s.at ?? null, quote: s.quote ?? null, locator: s.locator ?? null }),
      )
      basedOn.forEach((b, idx) => basedOnRows.push({ revision, idx, targetFact: b.factId, targetRevision: b.revision }))
      new Set(contradicts).forEach((c) => contradictRows.push({ revision, targetFact: c }))
      factRows.push({
        id,
        writer: writer.id,
        currentRevision: revision,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object ?? null,
        status: "active",
        recordedAt,
        createdAt: recordedAt,
      })
      if (basedOn.length > 0 && prev) withBasedOn.push(id)
      if (item.key !== undefined) byKey.set(item.key, { id, revision })
      results.push(item.key !== undefined ? { key: item.key, id, revision } : { id, revision })
    }

    // Retractions copy the current content into a new retracted revision.
    const retracted: WriteResult["retracted"] = []
    if (retract.length > 0) {
      const checked: Array<{ c: CurrentFact; reason: string }> = []
      for (const [i, r] of retract.entries()) checked.push({ c: yield* checkTarget(`retract[${i}]`, r.id, r.revision), reason: r.reason })
      const contents = new Map<string, RevisionContent>()
      for (const row of yield* sql<RevisionContent>`
        select revision, subject, predicate, object, value, has_value, basis, text, text_hash
        from fact_revisions where revision in ${sql.in(checked.map((x) => x.c.current_revision))}`) contents.set(row.revision, row)
      const oldSources = yield* sql<{ revision: string; idx: number; ref: string; version: string; at: string | null; quote: string | null; locator: string | null }>`
        select * from fact_sources where revision in ${sql.in(checked.map((x) => x.c.current_revision))}`
      const oldBasedOn = yield* sql<{ revision: string; idx: number; target_fact: string; target_revision: string }>`
        select * from fact_based_on where revision in ${sql.in(checked.map((x) => x.c.current_revision))}`
      const oldContradicts = yield* sql<{ revision: string; target_fact: string }>`
        select * from fact_contradicts where revision in ${sql.in(checked.map((x) => x.c.current_revision))}`
      for (const { c, reason } of checked) {
        const old = contents.get(c.current_revision)!
        const revision = newId("r")
        revisions.push({
          revision,
          factId: c.id,
          seq: c.seq + 1,
          writeId,
          recordedAt,
          subject: old.subject,
          predicate: old.predicate,
          object: old.object,
          value: old.value,
          hasValue: old.has_value,
          basis: old.basis,
          status: "retracted",
          retractedReason: reason,
          text: old.text,
          textHash: old.text_hash,
        })
        for (const s of oldSources.filter((s) => s.revision === c.current_revision)) sources.push({ ...s, revision })
        for (const b of oldBasedOn.filter((b) => b.revision === c.current_revision)) {
          basedOnRows.push({ revision, idx: b.idx, targetFact: b.target_fact, targetRevision: b.target_revision })
        }
        for (const x of oldContradicts.filter((x) => x.revision === c.current_revision)) {
          contradictRows.push({ revision, targetFact: x.target_fact })
        }
        factRows.push({
          id: c.id,
          writer: c.writer,
          currentRevision: revision,
          subject: old.subject,
          predicate: old.predicate,
          object: old.object,
          status: "retracted",
          recordedAt,
          createdAt: recordedAt,
        })
        retracted.push({ id: c.id, revision })
      }
    }

    yield* insertRows(tables.factRevisions, revisions)
    yield* insertRows(tables.factSources, sources)
    yield* insertRows(tables.factBasedOn, basedOnRows)
    yield* insertRows(tables.factContradicts, contradictRows)
    yield* upsertFacts(factRows)
    yield* checkCycles(withBasedOn)
    yield* enqueueWrite(writeId)
    yield* refreshText([...renamed])
    return { writeId, facts: results, retracted, entities: { created, changed } } satisfies WriteResult
  })

const upsertFacts = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(rows.length / 500) }, (_, i) => rows.slice(i * 500, (i + 1) * 500)),
    (chunk) => {
      const f = tables.facts
      return exec.execute(
        (Query.insert as any)(f).pipe(
          Query.from((Query.values as any)(chunk)),
          Query.onConflict("id", {
            update: {
              currentRevision: Query.excluded(f.currentRevision),
              subject: Query.excluded(f.subject),
              predicate: Query.excluded(f.predicate),
              object: Query.excluded(f.object),
              status: Query.excluded(f.status),
              recordedAt: Query.excluded(f.recordedAt),
            },
          }),
        ),
      )
    },
    { discard: true },
  )

/** Carries a dry run's result out of its transaction, so the transaction rolls back. */
class DryRunDone {
  constructor(readonly result: WriteResult) {}
}

export const write = (writer: Writer, batch: WriteRequest): Effect.Effect<WriteResult, unknown, any> =>
  checkShape(writer, batch).pipe(
    Effect.andThen(
      batch.dryRun
        ? applyBatch(writer, batch).pipe(
            Effect.flatMap((result) => Effect.fail(new DryRunDone(result))),
            Pg.Executor.withTransaction,
            Effect.catch((e: unknown) => (e instanceof DryRunDone ? Effect.succeed({ ...e.result, dryRun: true as const }) : Effect.fail(e))),
          )
        : applyBatch(writer, batch).pipe(Pg.Executor.withTransaction),
    ),
  )
