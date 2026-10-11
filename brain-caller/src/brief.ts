/** Compact text output for agents (`--brief`): one line per entity or fact. */
import type { Entity, EntityResult, FactResult, FactView, NeighborsResult, Page, SearchResult } from "../../brain/src/contract.ts"

const MAX = 300
const clip = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n)}…` : s)
const valueText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))

export const entityLine = (e: Entity) =>
  `entity ${e.id} (${e.type}) ${e.name}${e.aliases.length ? `; aliases: ${e.aliases.join(", ")}` : ""}`

export const factLine = (v: FactView) => {
  const f = v.fact
  const what = f.object !== undefined ? (v.objectName ?? f.object) : valueText(f.value)
  const s = f.sources[0]
  const where = s ? `${s.ref}@${s.version}${s.locator ? ` ${s.locator}` : ""}` : `based on ${f.basedOn.map((b) => b.factId).join(", ")}`
  const flags = [
    f.status === "retracted" ? "RETRACTED" : "",
    v.stale ? "STALE" : "",
    v.contradictedBy.length ? `DISPUTED by ${v.contradictedBy.join(", ")}` : "",
  ].filter(Boolean)
  const quote = s?.quote ? ` "${clip(s.quote, 160)}"` : ""
  return `${f.id} ${v.subjectName} | ${f.predicate} | ${clip(what)} [${where}]${flags.length ? ` ${flags.join(" ")}` : ""}${quote}`
}

const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, n]) => `${p}=${n}`)
    .join(", ")

export const brief = {
  search: (r: SearchResult) => [...r.entities.map(entityLine), ...r.facts.map(factLine)].join("\n"),
  entity: (r: EntityResult | null) =>
    r === null
      ? "not found"
      : [
          entityLine(r.entity),
          `about: ${counts(r.aboutPredicates)}`,
          ...r.about.map(factLine),
          ...(r.pointingHere.length ? [`pointing here: ${counts(r.pointingHerePredicates)}`, ...r.pointingHere.map(factLine)] : []),
        ].join("\n"),
  fact: (r: FactResult | null) =>
    r === null
      ? "not found"
      : [
          factLine(r.view),
          ...(r.basedOn.length ? ["based on:", ...r.basedOn.map((v) => `  ${factLine(v)}`)] : []),
          ...(r.supports.length ? ["supports:", ...r.supports.map((v) => `  ${factLine(v)}`)] : []),
          ...(r.contradictions.length ? ["contradictions:", ...r.contradictions.map((v) => `  ${factLine(v)}`)] : []),
          ...(r.history ? ["history:", ...r.history.map((f) => `  ${f.revision} ${f.recordedAt} ${f.status} ${f.predicate} ${clip(f.object ?? valueText(f.value), 120)}`)] : []),
        ].join("\n"),
  page: (r: Page<FactView>) => [...r.items.map(factLine), ...(r.nextCursor ? [`next: ${r.nextCursor}`] : [])].join("\n"),
  neighbors: (r: NeighborsResult) =>
    [
      ...r.paths.map((p) => `${p.facts.map((v) => `${v.subjectName} -[${v.fact.predicate} ${v.fact.id}]->`).join(" ")} ${p.end.name} (${p.end.id})`),
      ...(r.truncated ? ["(truncated)"] : []),
    ].join("\n"),
}
