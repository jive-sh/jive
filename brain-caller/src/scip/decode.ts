/** Decodes a SCIP index (scip.proto, github.com/scip-code/scip) into plain objects. */
import { Reader } from "./wire.ts"

export interface Range {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}
export interface Occurrence {
  symbol: string
  roles: number
  range: Range
  enclosingRange?: Range
}
export interface Relationship {
  symbol: string
  isReference: boolean
  isImplementation: boolean
  isTypeDefinition: boolean
  isDefinition: boolean
}
export interface SymbolInformation {
  symbol: string
  documentation: string[]
  relationships: Relationship[]
  kind: number
  displayName: string
  signature?: string
  enclosingSymbol: string
}
export interface Document {
  relativePath: string
  language: string
  occurrences: Occurrence[]
  symbols: SymbolInformation[]
}
export interface ScipIndex {
  projectRoot: string
  toolName: string
  documents: Document[]
  externalSymbols: SymbolInformation[]
}

export const ROLE_DEFINITION = 0x1
export const ROLE_IMPORT = 0x2

const fromInts = (r: number[]): Range | undefined =>
  r.length === 3
    ? { startLine: r[0]!, startChar: r[1]!, endLine: r[0]!, endChar: r[2]! }
    : r.length === 4
      ? { startLine: r[0]!, startChar: r[1]!, endLine: r[2]!, endChar: r[3]! }
      : undefined

const singleLine = (m: Reader): Range => {
  let line = 0, start = 0, end = 0
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 1) line = m.varint() | 0
    else if (f === 2) start = m.varint() | 0
    else if (f === 3) end = m.varint() | 0
    else m.skip(w)
  }
  return { startLine: line, startChar: start, endLine: line, endChar: end }
}

const multiLine = (m: Reader): Range => {
  const v = [0, 0, 0, 0]
  while (!m.done) {
    const [f, w] = m.tag()
    if (f >= 1 && f <= 4) v[f - 1] = m.varint() | 0
    else m.skip(w)
  }
  return { startLine: v[0]!, startChar: v[1]!, endLine: v[2]!, endChar: v[3]! }
}

const occurrence = (m: Reader): Occurrence => {
  let legacy: number[] = [], legacyEnclosing: number[] = []
  let typed: Range | undefined, typedEnclosing: Range | undefined
  let symbol = "", roles = 0
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 1) legacy = legacy.concat(m.int32s(w))
    else if (f === 2) symbol = m.string()
    else if (f === 3) roles = m.varint()
    else if (f === 7) legacyEnclosing = legacyEnclosing.concat(m.int32s(w))
    else if (f === 8) typed = singleLine(m.message())
    else if (f === 9) typed = multiLine(m.message())
    else if (f === 10) typedEnclosing = singleLine(m.message())
    else if (f === 11) typedEnclosing = multiLine(m.message())
    else m.skip(w)
  }
  const range = typed ?? fromInts(legacy) ?? { startLine: 0, startChar: 0, endLine: 0, endChar: 0 }
  const enclosingRange = typedEnclosing ?? fromInts(legacyEnclosing)
  return enclosingRange ? { symbol, roles, range, enclosingRange } : { symbol, roles, range }
}

const relationship = (m: Reader): Relationship => {
  const r: Relationship = { symbol: "", isReference: false, isImplementation: false, isTypeDefinition: false, isDefinition: false }
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 1) r.symbol = m.string()
    else if (f === 2) r.isReference = m.varint() !== 0
    else if (f === 3) r.isImplementation = m.varint() !== 0
    else if (f === 4) r.isTypeDefinition = m.varint() !== 0
    else if (f === 5) r.isDefinition = m.varint() !== 0
    else m.skip(w)
  }
  return r
}

const signatureText = (m: Reader): string => {
  let text = ""
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 5) text = m.string()
    else m.skip(w)
  }
  return text
}

const symbolInformation = (m: Reader): SymbolInformation => {
  const s: SymbolInformation = { symbol: "", documentation: [], relationships: [], kind: 0, displayName: "", enclosingSymbol: "" }
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 1) s.symbol = m.string()
    else if (f === 3) s.documentation.push(m.string())
    else if (f === 4) s.relationships.push(relationship(m.message()))
    else if (f === 5) s.kind = m.varint()
    else if (f === 6) s.displayName = m.string()
    else if (f === 7) s.signature = signatureText(m.message())
    else if (f === 8) s.enclosingSymbol = m.string()
    else m.skip(w)
  }
  return s
}

const document = (m: Reader): Document => {
  const d: Document = { relativePath: "", language: "", occurrences: [], symbols: [] }
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 1) d.relativePath = m.string()
    else if (f === 2) d.occurrences.push(occurrence(m.message()))
    else if (f === 3) d.symbols.push(symbolInformation(m.message()))
    else if (f === 4) d.language = m.string()
    else m.skip(w)
  }
  return d
}

const metadata = (m: Reader) => {
  let projectRoot = "", toolName = ""
  while (!m.done) {
    const [f, w] = m.tag()
    if (f === 2) {
      const t = m.message()
      while (!t.done) {
        const [tf, tw] = t.tag()
        if (tf === 1) toolName = t.string()
        else t.skip(tw)
      }
    } else if (f === 3) projectRoot = m.string()
    else m.skip(w)
  }
  return { projectRoot, toolName }
}

export const decodeIndex = (bytes: Uint8Array): ScipIndex => {
  const r = new Reader(bytes)
  const index: ScipIndex = { projectRoot: "", toolName: "", documents: [], externalSymbols: [] }
  while (!r.done) {
    const [f, w] = r.tag()
    if (f === 1) Object.assign(index, metadata(r.message()))
    else if (f === 2) index.documents.push(document(r.message()))
    else if (f === 3) index.externalSymbols.push(symbolInformation(r.message()))
    else r.skip(w)
  }
  return index
}
