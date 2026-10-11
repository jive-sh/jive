/** Turns a SCIP index into the entities and facts of design rev 4 §8.1. */
import type { Entity, Source, WriteFactItem } from "../../../brain/src/contract.ts"
import { ROLE_DEFINITION, type Document, type Occurrence, type Range, type ScipIndex, type SymbolInformation } from "./decode.ts"
import { entityId, lastName, parentSymbol, parseSymbol, qualifiedName, type Suffix } from "./symbol.ts"

export type FactItem = Omit<WriteFactItem, "id" | "revision" | "key" | "sources"> & { readonly sources: ReadonlyArray<Source> }
export interface DesiredFact {
  readonly item: FactItem
  /** Identity of the claim, independent of the cited blob: subject, predicate, object or value, and file. */
  readonly fingerprint: string
}
export interface ToFactsInput {
  /** `<org>/<repo>`. */
  readonly repo: string
  /** Blob SHA per tracked path at the indexed commit. Documents for untracked paths are skipped. */
  readonly blobs: ReadonlyMap<string, string>
  readonly fileLines: (path: string) => ReadonlyArray<string>
}

// scip.proto SymbolInformation.Kind values worth naming.
const KINDS: Record<number, string> = {
  7: "class", 8: "constant", 9: "constructor", 11: "enum", 12: "enum-member", 15: "field", 17: "function",
  18: "getter", 21: "interface", 26: "method", 29: "module", 30: "namespace", 35: "package", 37: "parameter",
  41: "property", 45: "setter", 49: "struct", 53: "trait", 54: "type", 55: "type-alias", 58: "type-parameter",
  61: "variable", 66: "abstract-method", 80: "static-method", 81: "static-property",
}
const SUFFIX_TYPES: Record<Suffix, string> = {
  namespace: "namespace", type: "type", term: "term", method: "method", "type-parameter": "type-parameter",
  parameter: "parameter", meta: "meta", macro: "macro",
}

const MAX_QUOTE = 300
const MAX_DOC = 2000

const contains = (outer: Range, inner: Range) =>
  (outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startChar <= inner.startChar)) &&
  (outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endChar >= inner.endChar))
const span = (r: Range) => (r.endLine - r.startLine) * 100_000 + (r.endChar - r.startChar)
const lines = (r: Range) => (r.startLine === r.endLine ? `L${r.startLine + 1}` : `L${r.startLine + 1}-L${r.endLine + 1}`)

const isCodeFence = (s: string) => s.trimStart().startsWith("```")

// Indexers that leave `kind` unset (scip-typescript 0.4) still render a signature; its first keyword names the kind.
const SIGNATURE_KINDS: Record<string, string> = {
  class: "class", interface: "interface", function: "function", const: "variable", let: "variable", var: "variable",
  type: "type-alias", enum: "enum", module: "module", namespace: "namespace", constructor: "constructor",
  "(method)": "method", "(property)": "property", "(getter)": "getter", "(setter)": "setter", "(enum member)": "enum-member",
}
const kindFromSignature = (signature: string | undefined) => {
  if (!signature) return undefined
  const s = signature.trim()
  const paren = s.match(/^\([a-z ]+\)/)?.[0]
  return SIGNATURE_KINDS[paren ?? s.split(/\s+/)[0] ?? ""]
}
const stripFence = (s: string) => s.replace(/^\s*```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "").trim()

const lastSuffix = (symbol: string) => parseSymbol(symbol).descriptors.at(-1)?.suffix
const isModule = (symbol: string) => lastSuffix(symbol) === "namespace"
/** The language's own standard library (e.g. TypeScript's lib.*.d.ts): referenced everywhere, informative nowhere. */
const STANDARD_LIBRARY_PACKAGES = new Set(["npm typescript"])
const isStandardLibrary = (symbol: string) => {
  const p = parseSymbol(symbol).package
  return STANDARD_LIBRARY_PACKAGES.has(`${p.manager} ${p.name}`)
}

/** Symbols worth an entity: not local, not parameters (scip-typescript makes parameters global), not the standard library. */
const isGlobal = (symbol: string) => {
  if (symbol.length === 0 || parseSymbol(symbol).local || isStandardLibrary(symbol)) return false
  const suffix = lastSuffix(symbol)
  return suffix !== "parameter" && suffix !== "type-parameter"
}

export const toFacts = (index: ScipIndex, input: ToFactsInput) => {
  const entities = new Map<string, Entity>()
  const facts = new Map<string, DesiredFact>()
  const infos = new Map<string, SymbolInformation>()
  for (const s of index.externalSymbols) infos.set(s.symbol, s)
  for (const d of index.documents) for (const s of d.symbols) infos.set(s.symbol, s)

  const repoId = `repo/${input.repo}`
  const fileId = (path: string) => `file/${input.repo}/${path}`
  entities.set(repoId, { id: repoId, type: "repo", name: input.repo, aliases: [] })

  // A module's symbol (a namespace defined in a document) is the file itself.
  const moduleFile = new Map<string, string>()
  for (const d of index.documents) {
    for (const o of d.occurrences) {
      if ((o.roles & ROLE_DEFINITION) !== 0 && isModule(o.symbol) && input.blobs.has(d.relativePath)) moduleFile.set(o.symbol, fileId(d.relativePath))
    }
  }

  const symbolEntity = (symbol: string): string => {
    const file = moduleFile.get(symbol)
    if (file) return file
    const id = entityId(symbol)
    if (!entities.has(id)) {
      const info = infos.get(symbol)
      const parsed = parseSymbol(symbol)
      const name = info?.displayName || lastName(symbol)
      const qualified = qualifiedName(symbol)
      const signature = info?.signature || info?.documentation.filter(isCodeFence).map(stripFence)[0]
      const type =
        (info && KINDS[info.kind]) ??
        kindFromSignature(signature) ??
        (parsed.descriptors.at(-1) ? SUFFIX_TYPES[parsed.descriptors.at(-1)!.suffix] : "symbol")
      entities.set(id, { id, type, name, aliases: qualified !== name ? [qualified] : [] })
    }
    return id
  }

  const add = (item: FactItem) => {
    const ref = item.sources[0]!.ref
    const what = item.object ?? JSON.stringify(item.value)
    const fingerprint = `${item.subject}\u0000${item.predicate}\u0000${what}\u0000${ref}`
    if (!facts.has(fingerprint)) facts.set(fingerprint, { item, fingerprint })
  }


  for (const doc of index.documents) {
    const blob = input.blobs.get(doc.relativePath)
    if (!blob) continue
    const ref = `git:${input.repo}:${doc.relativePath}`
    const source = (extra: Partial<Source> = {}): Source => ({ ref, version: blob, ...extra })
    const file = fileId(doc.relativePath)
    entities.set(file, { id: file, type: "file", name: doc.relativePath, aliases: [] })
    add({ subject: file, predicate: "code:in-repo", object: repoId, basis: "compiler-derived", sources: [source()] })
    const text = input.fileLines(doc.relativePath)
    const quoteAt = (line: number) => (text[line] ?? "").trim().slice(0, MAX_QUOTE)

    // Definitions, with their enclosing ranges for attributing references.
    const definitions: Array<{ symbol: string; range: Range }> = []
    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE_DEFINITION) === 0 || !isGlobal(occ.symbol) || moduleFile.has(occ.symbol)) continue
      const subject = symbolEntity(occ.symbol)
      const where = occ.enclosingRange ?? occ.range
      definitions.push({ symbol: occ.symbol, range: where })
      const quote = quoteAt(occ.range.startLine)
      add({
        subject,
        predicate: "code:defined-in",
        object: file,
        basis: "compiler-derived",
        sources: [source({ locator: lines(where), ...(quote ? { quote } : {}) })],
      })
    }

    // Symbol information declared in this document.
    for (const info of doc.symbols) {
      if (!isGlobal(info.symbol) || moduleFile.has(info.symbol)) continue
      const subject = symbolEntity(info.symbol)
      const docs = info.documentation.filter((d) => !isCodeFence(d)).join("\n\n").trim()
      // Signatures are not stored as facts: the code:defined-in quote already holds the definition line.
      if (docs) add({ subject, predicate: "code:documentation", value: docs.slice(0, MAX_DOC), basis: "compiler-derived", sources: [source()] })
      const parent = info.enclosingSymbol || parentSymbol(info.symbol)
      if (parent && parseSymbol(parent).descriptors.at(-1)?.suffix !== "namespace") {
        add({ subject, predicate: "code:member-of", object: symbolEntity(parent), basis: "compiler-derived", sources: [source()] })
      }
      for (const rel of info.relationships) {
        if (!isGlobal(rel.symbol)) continue
        const predicate = rel.isImplementation
          ? "code:implements"
          : rel.isTypeDefinition
            ? "code:type-definition"
            : rel.isReference
              ? "code:references-symbol"
              : undefined
        if (predicate) add({ subject, predicate, object: symbolEntity(rel.symbol), basis: "compiler-derived", sources: [source()] })
      }
    }

    // References, attributed to the innermost enclosing definition (or the file at top level).
    const firstLine = new Map<string, { subject: string; object: string; occ: Occurrence; count: number }>()
    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE_DEFINITION) !== 0 || !isGlobal(occ.symbol)) continue
      let enclosing: { symbol: string; range: Range } | undefined
      for (const d of definitions) {
        if (d.symbol !== occ.symbol && contains(d.range, occ.range) && (!enclosing || span(d.range) < span(enclosing.range))) enclosing = d
      }
      const subject = enclosing ? symbolEntity(enclosing.symbol) : file
      const object = symbolEntity(occ.symbol)
      if (subject === object) continue
      const key = `${subject}\u0000${object}`
      const seen = firstLine.get(key)
      if (seen) seen.count++
      else firstLine.set(key, { subject, object, occ, count: 1 })
    }
    for (const r of firstLine.values()) {
      const quote = quoteAt(r.occ.range.startLine)
      const locator = r.count > 1 ? `${lines(r.occ.range)} (+${r.count - 1} more)` : lines(r.occ.range)
      add({
        subject: r.subject,
        predicate: "code:references",
        object: r.object,
        basis: "compiler-derived",
        sources: [source({ locator, ...(quote ? { quote } : {}) })],
      })
    }
  }
  return { entities: [...entities.values()], facts: [...facts.values()] }
}

export type { Document }
