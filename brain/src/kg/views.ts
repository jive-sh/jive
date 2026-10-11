/** Fact loading, staleness (design rev 4 §4.3, §6.4), and FactView assembly. */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Basis, Fact, FactView, Json, StaleReason } from "../contract.ts"

interface RevisionRow {
  revision: string
  fact_id: string
  writer: string
  recorded_at: string | Date
  subject: string
  predicate: string
  object: string | null
  value: Json | null
  has_value: boolean
  basis: Basis
  status: "active" | "retracted"
  retracted_reason: string | null
}

const iso = (t: string | Date) => (t instanceof Date ? t.toISOString() : new Date(t).toISOString())

/** Facts for the given revision IDs, keyed by revision. */
export const loadRevisions = (revisions: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = new Map<string, Fact>()
    if (revisions.length === 0) return out
    const sql = yield* SqlClient.SqlClient
    const ids = [...new Set(revisions)]
    const rows = yield* sql<RevisionRow>`
      select r.revision, r.fact_id, f.writer, r.recorded_at, r.subject, r.predicate, r.object, r.value, r.has_value,
             r.basis, r.status, r.retracted_reason
      from fact_revisions r join facts f on f.id = r.fact_id
      where r.revision in ${sql.in(ids)}`
    const sources = yield* sql<{ revision: string; ref: string; version: string; at: string | null; quote: string | null; locator: string | null }>`
      select revision, ref, version, at, quote, locator from fact_sources where revision in ${sql.in(ids)} order by revision, idx`
    const basedOn = yield* sql<{ revision: string; target_fact: string; target_revision: string }>`
      select revision, target_fact, target_revision from fact_based_on where revision in ${sql.in(ids)} order by revision, idx`
    const contradicts = yield* sql<{ revision: string; target_fact: string }>`
      select revision, target_fact from fact_contradicts where revision in ${sql.in(ids)} order by revision, target_fact`
    for (const r of rows) {
      const fact: Fact = {
        id: r.fact_id,
        revision: r.revision,
        subject: r.subject,
        predicate: r.predicate,
        ...(r.object !== null ? { object: r.object } : {}),
        ...(r.has_value ? { value: r.value } : {}),
        basis: r.basis,
        writer: r.writer,
        recordedAt: iso(r.recorded_at),
        sources: [],
        basedOn: [],
        contradicts: [],
        status: r.status,
        ...(r.retracted_reason !== null ? { retractedReason: r.retracted_reason } : {}),
      }
      out.set(r.revision, fact)
    }
    for (const s of sources) {
      out.get(s.revision)?.sources.push({
        ref: s.ref,
        version: s.version,
        ...(s.at !== null ? { at: s.at } : {}),
        ...(s.quote !== null ? { quote: s.quote } : {}),
        ...(s.locator !== null ? { locator: s.locator } : {}),
      })
    }
    for (const b of basedOn) out.get(b.revision)?.basedOn.push({ factId: b.target_fact, revision: b.target_revision })
    for (const c of contradicts) out.get(c.revision)?.contradicts.push(c.target_fact)
    return out
  })

/**
 * Staleness of the current revisions of `factIds`. Loads everything the facts rest on
 * (transitively), computes each fact's own reasons, then propagates "stale" upward.
 */
export const stalenessOf = (factIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = new Map<string, StaleReason[]>()
    if (factIds.length === 0) return result
    const sql = yield* SqlClient.SqlClient
    const closure = yield* sql<{ id: string }>`
      with recursive down(id) as (
        select id from facts where id in ${sql.in([...new Set(factIds)])}
        union
        select b.target_fact from down join facts f on f.id = down.id join fact_based_on b on b.revision = f.current_revision
      ) select id from down`
    const ids = closure.map((r) => r.id)
    const direct = yield* sql<{ fact_id: string; ref: string; cited: string; latest: string }>`
      select f.id as fact_id, s.ref, s.version as cited, l.version as latest
      from facts f
      join fact_sources s on s.revision = f.current_revision
      join source_latest l on l.ref = s.ref
      where f.id in ${sql.in(ids)} and l.version <> s.version
      order by f.id, s.idx`
    const edges = yield* sql<{ fact_id: string; target: string; cited: string; target_current: string; target_status: string }>`
      select f.id as fact_id, b.target_fact as target, b.target_revision as cited, t.current_revision as target_current, t.status as target_status
      from facts f
      join fact_based_on b on b.revision = f.current_revision
      join facts t on t.id = b.target_fact
      where f.id in ${sql.in(ids)}
      order by f.id, b.idx`
    const own = new Map<string, StaleReason[]>(ids.map((id) => [id, []]))
    for (const d of direct) own.get(d.fact_id)!.push({ ref: d.ref, citedVersion: d.cited, latestVersion: d.latest })
    const supports = new Map<string, typeof edges>()
    for (const e of edges) supports.set(e.fact_id, [...(supports.get(e.fact_id) ?? []), e])

    const memo = new Map<string, StaleReason[]>()
    const visiting = new Set<string>()
    const reasons = (id: string): StaleReason[] => {
      const known = memo.get(id)
      if (known) return known
      if (visiting.has(id)) return [] // a cycle restored by revert: don't loop
      visiting.add(id)
      const out = [...(own.get(id) ?? [])]
      for (const e of supports.get(id) ?? []) {
        if (e.target_status === "retracted") out.push({ factId: e.target, reason: "retracted" })
        else if (e.target_current !== e.cited) out.push({ factId: e.target, reason: "revised" })
        else if (reasons(e.target).length > 0) out.push({ factId: e.target, reason: "stale" })
      }
      visiting.delete(id)
      memo.set(id, out)
      return out
    }
    for (const id of factIds) result.set(id, reasons(id))
    return result
  })

/** Active facts whose current revision contradicts any of `factIds`. */
const contradictedBy = (factIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = new Map<string, string[]>()
    if (factIds.length === 0) return out
    const sql = yield* SqlClient.SqlClient
    for (const r of yield* sql<{ target: string; id: string }>`
      select c.target_fact as target, f.id
      from fact_contradicts c join facts f on f.current_revision = c.revision
      where c.target_fact in ${sql.in([...new Set(factIds)])} and f.status = 'active'
      order by f.id`) out.set(r.target, [...(out.get(r.target) ?? []), r.id])
    return out
  })

/** FactViews of the current revisions of `factIds`, in the same order. Unknown IDs are skipped. */
export const viewsOf = (factIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (factIds.length === 0) return [] as FactView[]
    const sql = yield* SqlClient.SqlClient
    const current = new Map<string, string>()
    for (const r of yield* sql<{ id: string; current_revision: string }>`
      select id, current_revision from facts where id in ${sql.in([...new Set(factIds)])}`) current.set(r.id, r.current_revision)
    const facts = yield* loadRevisions([...current.values()])
    const stale = yield* stalenessOf([...current.keys()])
    const disputes = yield* contradictedBy([...current.keys()])
    const entityIds = [...new Set([...facts.values()].flatMap((f) => (f.object ? [f.subject, f.object] : [f.subject])))]
    const names = new Map<string, string>()
    if (entityIds.length > 0) {
      for (const r of yield* sql<{ id: string; name: string }>`select id, name from entities where id in ${sql.in(entityIds)}`) {
        names.set(r.id, r.name)
      }
    }
    return factIds.flatMap((id): FactView[] => {
      const fact = facts.get(current.get(id) ?? "")
      if (!fact) return []
      const staleBecause = stale.get(id) ?? []
      return [{
        fact,
        subjectName: names.get(fact.subject) ?? fact.subject,
        ...(fact.object ? { objectName: names.get(fact.object) ?? fact.object } : {}),
        stale: staleBecause.length > 0,
        staleBecause,
        contradictedBy: disputes.get(id) ?? [],
      }]
    })
  })

/** IDs of all current facts that are stale, as a SQL fragment usable in `where id in (...)`. */
export const staleIdsSql = `
  with recursive local_stale(id) as (
    select f.id from facts f
      join fact_sources s on s.revision = f.current_revision
      join source_latest l on l.ref = s.ref
      where l.version <> s.version
    union
    select f.id from facts f
      join fact_based_on b on b.revision = f.current_revision
      join facts t on t.id = b.target_fact
      where t.status = 'retracted' or t.current_revision <> b.target_revision
  ), up(id) as (
    select id from local_stale
    union
    select f.id from up
      join fact_based_on b on b.target_fact = up.id
      join facts f on f.current_revision = b.revision
  ) select id from up`
