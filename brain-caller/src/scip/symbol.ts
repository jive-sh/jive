/** SCIP symbol strings (scip.proto `Symbol` grammar). */

export type Suffix = "namespace" | "type" | "term" | "method" | "type-parameter" | "parameter" | "meta" | "macro"
export interface Descriptor {
  name: string
  suffix: Suffix
  /** Offset in the symbol string where this descriptor starts. */
  start: number
}
export interface ParsedSymbol {
  local: boolean
  scheme: string
  package: { manager: string; name: string; version: string }
  descriptors: Descriptor[]
  /** Offset where descriptors start. */
  descriptorsStart: number
}

const IDENT = /[A-Za-z0-9_+$-]/

/** Reads a space-terminated token where a doubled space is a literal space. */
const token = (s: string, from: number): [string, number] => {
  let out = ""
  let i = from
  while (i < s.length) {
    if (s[i] === " ") {
      if (s[i + 1] === " ") {
        out += " "
        i += 2
        continue
      }
      return [out, i + 1]
    }
    out += s[i++]
  }
  return [out, i]
}

const cache = new Map<string, ParsedSymbol>()

export const parseSymbol = (s: string): ParsedSymbol => {
  const hit = cache.get(s)
  if (hit) return hit
  if (s.startsWith("local ")) {
    return { local: true, scheme: "local", package: { manager: "", name: "", version: "" }, descriptors: [], descriptorsStart: s.length }
  }
  let i = 0
  let scheme: string, manager: string, name: string, version: string
  ;[scheme, i] = token(s, i)
  ;[manager, i] = token(s, i)
  ;[name, i] = token(s, i)
  ;[version, i] = token(s, i)
  const descriptorsStart = i
  const descriptors: Descriptor[] = []

  const readName = (): string => {
    if (s[i] === "`") {
      let out = ""
      i++
      while (i < s.length) {
        if (s[i] === "`") {
          if (s[i + 1] === "`") {
            out += "`"
            i += 2
            continue
          }
          i++
          return out
        }
        out += s[i++]
      }
      return out
    }
    const begin = i
    while (i < s.length && IDENT.test(s[i]!)) i++
    return s.slice(begin, i)
  }

  while (i < s.length) {
    const start = i
    if (s[i] === "[") {
      i++
      const n = readName()
      i++ // ]
      descriptors.push({ name: n, suffix: "type-parameter", start })
      continue
    }
    if (s[i] === "(") {
      i++
      const n = readName()
      i++ // )
      descriptors.push({ name: n, suffix: "parameter", start })
      continue
    }
    const n = readName()
    const c = s[i++]
    if (c === "/") descriptors.push({ name: n, suffix: "namespace", start })
    else if (c === "#") descriptors.push({ name: n, suffix: "type", start })
    else if (c === ".") descriptors.push({ name: n, suffix: "term", start })
    else if (c === ":") descriptors.push({ name: n, suffix: "meta", start })
    else if (c === "!") descriptors.push({ name: n, suffix: "macro", start })
    else if (c === "(") {
      while (i < s.length && s[i] !== ")") i++
      i += 2 // ").
      descriptors.push({ name: n, suffix: "method", start })
    } else break // malformed: stop rather than loop
  }
  const parsed = { local: false, scheme, package: { manager, name, version }, descriptors, descriptorsStart }
  cache.set(s, parsed)
  return parsed
}

/** Names after the last namespace, joined with dots: `RateEngine.price`. */
export const qualifiedName = (s: string): string => {
  const d = parseSymbol(s).descriptors
  let k = d.length
  while (k > 0 && d[k - 1]!.suffix !== "namespace") k--
  const tail = d.slice(k).filter((x) => x.suffix !== "parameter" && x.suffix !== "type-parameter")
  return (tail.length > 0 ? tail : d.slice(-1)).map((x) => x.name).join(".")
}

export const lastName = (s: string): string => parseSymbol(s).descriptors.at(-1)?.name ?? s

/** The symbol minus its last descriptor, or undefined when that would leave no descriptors. */
export const parentSymbol = (s: string): string | undefined => {
  const p = parseSymbol(s)
  if (p.local || p.descriptors.length < 2) return undefined
  return s.slice(0, p.descriptors.at(-1)!.start)
}

/**
 * Entity ID for a symbol: `scip:` plus the symbol with its package version replaced by ".",
 * so IDs survive version bumps and the same package's symbols match across repos.
 */
export const entityId = (s: string): string => {
  const p = parseSymbol(s)
  if (p.local) return `scip:${s}`
  const esc = (t: string) => t.replaceAll(" ", "  ")
  return `scip:${esc(p.scheme)} ${esc(p.package.manager)} ${esc(p.package.name)} . ${s.slice(p.descriptorsStart)}`
}
