/** `neighbors` (design rev 4 §5): breadth-first walk over active facts that have an object. */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Entity, NeighborsRequest, NeighborsResult } from "../contract.ts"
import { invalid } from "../errors.ts"
import { viewsOf } from "./views.ts"

interface Edge {
  id: string
  from: string
  to: string
}
interface Path {
  facts: string[]
  visited: Set<string>
  end: string
}

export const neighbors = (q: NeighborsRequest) =>
  Effect.gen(function* () {
    const limit = q.limit ?? 50
    const depth = q.depth ?? 1
    const direction = q.direction ?? "out"
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return yield* invalid("limit must be between 1 and 500")
    const sql = yield* SqlClient.SqlClient
    const predicateFilter = q.predicates && q.predicates.length > 0 ? sql`and f.predicate in ${sql.in(q.predicates)}` : sql``

    const edgesFrom = (ends: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const out: Edge[] = []
        if (direction !== "in") {
          out.push(...(yield* sql<Edge>`
            select f.id, f.subject as from, f.object as to from facts f
            where f.status = 'active' and f.object is not null and f.subject in ${sql.in(ends)} ${predicateFilter}
            order by f.recorded_at desc, f.id desc`))
        }
        if (direction !== "out") {
          out.push(...(yield* sql<Edge>`
            select f.id, f.object as from, f.subject as to from facts f
            where f.status = 'active' and f.object in ${sql.in(ends)} ${predicateFilter}
            order by f.recorded_at desc, f.id desc`))
        }
        return out
      })

    const result: Path[] = []
    let truncated = false
    let frontier: Path[] = [{ facts: [], visited: new Set([q.from]), end: q.from }]
    for (let level = 1; level <= depth && frontier.length > 0 && !truncated; level++) {
      const edges = yield* edgesFrom([...new Set(frontier.map((p) => p.end))])
      const byFrom = new Map<string, Edge[]>()
      for (const e of edges) byFrom.set(e.from, [...(byFrom.get(e.from) ?? []), e])
      const next: Path[] = []
      for (const path of frontier) {
        for (const e of byFrom.get(path.end) ?? []) {
          if (path.visited.has(e.to)) continue
          if (result.length === limit) {
            truncated = true
            break
          }
          const extended = { facts: [...path.facts, e.id], visited: new Set([...path.visited, e.to]), end: e.to }
          result.push(extended)
          next.push(extended)
        }
        if (truncated) break
      }
      frontier = next
    }

    const views = new Map((yield* viewsOf([...new Set(result.flatMap((p) => p.facts))])).map((v) => [v.fact.id, v]))
    const ends = [...new Set(result.map((p) => p.end))]
    const entities = new Map<string, Entity>()
    if (ends.length > 0) {
      for (const e of yield* sql<Entity>`select id, type, name, aliases from entities where id in ${sql.in(ends)}`) {
        entities.set(e.id, { id: e.id, type: e.type, name: e.name, aliases: [...e.aliases] })
      }
    }
    return {
      paths: result.map((p) => ({ facts: p.facts.map((id) => views.get(id)!), end: entities.get(p.end)! })),
      truncated,
    } satisfies NeighborsResult
  })
