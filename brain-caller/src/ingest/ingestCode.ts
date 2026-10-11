/** The code-indexer workflow (design rev 4 §8.1). */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { Entity, FactView, WriteFactItem } from "../../../brain/src/contract.ts"
import { kg, type Connection } from "../client.ts"
import { listAll } from "../list.ts"
import { decodeIndex } from "../scip/decode.ts"
import { toFacts, type DesiredFact, type FactItem } from "../scip/toFacts.ts"
import { produceIndex } from "./indexers.ts"

export interface IngestOptions {
  readonly dir: string
  readonly repo: string
  readonly writer: string
  readonly index?: string | undefined
  readonly batchSize: number
}

const gitBlobs = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const out = await Bun.$`git -C ${dir} ls-tree -r -z HEAD`.quiet().text()
      const blobs = new Map<string, string>()
      for (const entry of out.split("\0")) {
        const tab = entry.indexOf("\t")
        if (tab < 0) continue
        const [, type, sha] = entry.slice(0, tab).split(" ")
        if (type === "blob") blobs.set(entry.slice(tab + 1), sha!)
      }
      return blobs
    },
    catch: (e) => new Error(`${dir} is not a git checkout with a HEAD commit: ${String(e)}`),
  })

const fingerprintOf = (f: FactView["fact"]) =>
  `${f.subject}\u0000${f.predicate}\u0000${f.object ?? JSON.stringify(f.value)}\u0000${f.sources[0]?.ref ?? ""}`

/** True when the stored fact already says exactly what the desired one says, citing the same blob. */
const same = (stored: FactView["fact"], desired: FactItem) => {
  const a = stored.sources[0]
  const b = desired.sources[0]!
  return (
    stored.sources.length === 1 &&
    a !== undefined &&
    a.version === b.version &&
    (a.locator ?? "") === (b.locator ?? "") &&
    (a.quote ?? "") === (b.quote ?? "") &&
    JSON.stringify(stored.value) === JSON.stringify(desired.value) &&
    stored.basis === desired.basis
  )
}

const chunk = <T>(items: ReadonlyArray<T>, size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export const ingestCode = (conn: Connection, o: IngestOptions) =>
  Effect.gen(function* () {
    const started = performance.now()
    const blobs = yield* gitBlobs(o.dir)
    const produced = yield* produceIndex(o.dir, o.index)
    const index = decodeIndex(produced.bytes)
    const fileCache = new Map<string, string[]>()
    const fileLines = (path: string) => {
      let lines = fileCache.get(path)
      if (!lines) {
        try {
          lines = readFileSync(join(o.dir, path), "utf8").split("\n")
        } catch {
          lines = []
        }
        fileCache.set(path, lines)
      }
      return lines
    }
    const desired = toFacts(index, { repo: o.repo, blobs, fileLines })
    fileCache.clear()

    // Existing facts this writer holds for the repo.
    const prefix = `git:${o.repo}:`
    const existing = (yield* listAll(conn, { writer: o.writer, sourceRefPrefix: prefix, limit: 500 }, undefined, true)).items as FactView[]
    const stored = new Map<string, FactView["fact"][]>()
    for (const v of existing) stored.set(fingerprintOf(v.fact), [...(stored.get(fingerprintOf(v.fact)) ?? []), v.fact])

    // Files whose evidence changed or disappeared.
    const cited = new Map<string, Set<string>>()
    for (const v of existing) for (const s of v.fact.sources) if (s.ref.startsWith(prefix)) cited.set(s.ref, (cited.get(s.ref) ?? new Set()).add(s.version))
    const changedRefs: Array<{ ref: string; version: string }> = []
    for (const [ref, versions] of cited) {
      const blob = blobs.get(ref.slice(prefix.length))
      const version = blob ?? "deleted"
      if ([...versions].some((v) => v !== version)) changedRefs.push({ ref, version })
    }

    const items: WriteFactItem[] = []
    const retract: Array<{ id: string; revision: string; reason: string }> = []
    let unchanged = 0
    for (const d of desired.facts) {
      const match = stored.get(d.fingerprint)
      const current = match?.shift()
      if (!current) items.push(d.item)
      else if (same(current, d.item)) unchanged++
      else items.push({ ...d.item, id: current.id, revision: current.revision })
    }
    for (const leftovers of stored.values()) {
      for (const f of leftovers) retract.push({ id: f.id, revision: f.revision, reason: "no longer produced by the code indexer" })
    }
    const created = items.filter((i) => i.id === undefined).length

    for (const c of changedRefs) yield* kg(conn, "sourceChanged", c)

    const entityById = new Map(desired.entities.map((e) => [e.id, e]))
    const needed = (batch: ReadonlyArray<WriteFactItem>): Entity[] => {
      const ids = new Set(batch.flatMap((i) => (i.object !== undefined ? [i.subject, i.object] : [i.subject])))
      return [...ids].flatMap((id) => (entityById.has(id) ? [entityById.get(id)!] : []))
    }
    let batches = 0
    for (const batch of chunk(items, o.batchSize)) {
      yield* kg(conn, "write", { rationale: `index ${o.repo} (${produced.indexer})`, entities: needed(batch), facts: batch })
      batches++
    }
    for (const batch of chunk(retract, o.batchSize)) {
      yield* kg(conn, "write", { rationale: `index ${o.repo}: retract facts no longer produced`, retract: batch })
      batches++
    }
    return {
      repo: o.repo,
      indexer: produced.indexer,
      files: index.documents.length,
      entities: desired.entities.length,
      facts: { desired: desired.facts.length, created, updated: items.length - created, retracted: retract.length, unchanged },
      sourceChanged: changedRefs.length,
      batches,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    }
  })

export type { DesiredFact }
