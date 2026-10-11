import { describe, expect, test } from "bun:test"
import { decodeIndex } from "../src/scip/decode.ts"
import { entityId, parseSymbol, parentSymbol, qualifiedName } from "../src/scip/symbol.ts"
import { toFacts } from "../src/scip/toFacts.ts"

const FIXTURE = `${import.meta.dir}/fixtures/sample`
const index = decodeIndex(new Uint8Array(await Bun.file(`${FIXTURE}/index.scip`).arrayBuffer()))
const PKG = "scip-typescript npm @dat/sample 1.0.0 "

describe("SCIP decoding", () => {
  test("decodes documents, occurrences, and symbol information from a real scip-typescript index", () => {
    const paths = index.documents.map((d) => d.relativePath).sort()
    expect(paths).toEqual(["src/a b.ts", "src/quote.ts", "src/rate.ts"])
    const rate = index.documents.find((d) => d.relativePath === "src/rate.ts")!
    expect(rate.occurrences.length).toBeGreaterThan(5)
    const engine = rate.symbols.find((s) => s.symbol === `${PKG}src/\`rate.ts\`/RateEngine#`)!
    expect(engine.documentation.join("\n")).toContain("Prices loads per mile.")
    expect(engine.relationships).toContainEqual(
      expect.objectContaining({ symbol: `${PKG}src/\`rate.ts\`/Pricer#`, isImplementation: true }),
    )
    const def = rate.occurrences.find((o) => o.symbol === `${PKG}src/\`rate.ts\`/RateEngine#` && (o.roles & 1) === 1)!
    expect(def.range.startLine).toBe(6)
  })
})

describe("SCIP symbols", () => {
  test("parses escaped names, doubled spaces, and descriptor suffixes", () => {
    const s = parseSymbol("scip-typescript npm my  pkg 1.0 src/`a b.ts`/`we``ird`#run().")
    expect(s.local).toBe(false)
    expect(s.package).toEqual({ manager: "npm", name: "my pkg", version: "1.0" })
    expect(s.descriptors.map((d) => [d.name, d.suffix])).toEqual([
      ["src", "namespace"], ["a b.ts", "namespace"], ["we`ird", "type"], ["run", "method"],
    ])
    expect(parseSymbol("local 12").local).toBe(true)
  })

  test("qualified name, parent, and version-free entity id", () => {
    const sym = `${PKG}src/\`rate.ts\`/RateEngine#price().`
    expect(qualifiedName(sym)).toBe("RateEngine.price")
    expect(parentSymbol(sym)).toBe(`${PKG}src/\`rate.ts\`/RateEngine#`)
    expect(parentSymbol(`${PKG}src/`)).toBeUndefined()
    expect(entityId(sym)).toBe("scip:scip-typescript npm @dat/sample . src/`rate.ts`/RateEngine#price().")
  })
})

describe("toFacts", () => {
  const blobs = new Map([["src/rate.ts", "b-rate"], ["src/quote.ts", "b-quote"], ["src/a b.ts", "b-ab"]])
  const lines = (p: string) => require("node:fs").readFileSync(`${FIXTURE}/${p}`, "utf8").split("\n") as string[]
  const out = toFacts(index, { repo: "dat/sample", blobs, fileLines: lines })
  const id = (local: string) => entityId(`${PKG}${local}`)
  const facts = (predicate: string) => out.facts.filter((f) => f.item.predicate === predicate)

  test("one code:defined-in per defined global symbol, citing the file blob with a quote", () => {
    const defs = facts("code:defined-in")
    const engine = defs.filter((f) => f.item.subject === id("src/`rate.ts`/RateEngine#"))
    expect(engine).toHaveLength(1)
    expect(engine[0]!.item.object).toBe("file/dat/sample/src/rate.ts")
    expect(engine[0]!.item.sources).toEqual([{ ref: "git:dat/sample:src/rate.ts", version: "b-rate", locator: expect.stringMatching(/^L7/), quote: "export class RateEngine implements Pricer {" }])
    expect(new Set(defs.map((f) => f.fingerprint)).size).toBe(defs.length)
  })

  test("references are aggregated per enclosing symbol, target, and file", () => {
    const refs = facts("code:references").map((f) => [f.item.subject, f.item.object])
    // `new RateEngine(...)` resolves to the constructor; the import is a top-level reference from the file.
    expect(refs).toContainEqual([id("src/`quote.ts`/quote()."), id("src/`rate.ts`/RateEngine#`<constructor>`().")])
    expect(refs).toContainEqual(["file/dat/sample/src/quote.ts", id("src/`rate.ts`/RateEngine#")])
    expect(refs).toContainEqual(["file/dat/sample/src/quote.ts", "file/dat/sample/src/rate.ts"])
    expect(refs.some(([, o]) => o!.includes(".(miles)"))).toBe(false)
    expect(refs).toContainEqual([id("src/`rate.ts`/RateEngine#price()."), id("src/`rate.ts`/round.")])
    expect(new Set(refs.map((r) => r.join("|"))).size).toBe(refs.length)
  })

  test("references into the language's standard library are skipped", () => {
    const targets = facts("code:references").map((f) => f.item.object!)
    expect(targets.some((t) => t.startsWith("scip:scip-typescript npm typescript . lib/"))).toBe(false)
    expect(out.entities.some((e) => e.id.startsWith("scip:scip-typescript npm typescript . lib/"))).toBe(false)
  })

  test("relationships, members, files, and no local symbols", () => {
    expect(facts("code:implements").map((f) => [f.item.subject, f.item.object])).toContainEqual([id("src/`rate.ts`/RateEngine#"), id("src/`rate.ts`/Pricer#")])
    expect(facts("code:member-of").map((f) => [f.item.subject, f.item.object])).toContainEqual([id("src/`rate.ts`/RateEngine#price()."), id("src/`rate.ts`/RateEngine#")])
    expect(facts("code:in-repo").map((f) => f.item.subject).sort()).toEqual(["file/dat/sample/src/a b.ts", "file/dat/sample/src/quote.ts", "file/dat/sample/src/rate.ts"])
    expect(out.entities.some((e) => e.id.startsWith("scip:local"))).toBe(false)
    expect(out.facts.every((f) => f.item.basis === "compiler-derived")).toBe(true)
    const engine = out.entities.find((e) => e.id === id("src/`rate.ts`/RateEngine#"))!
    expect(engine).toEqual({ id: engine.id, type: "class", name: "RateEngine", aliases: [] })
    const price = out.entities.find((e) => e.id === id("src/`rate.ts`/RateEngine#price()."))!
    expect(price.aliases).toEqual(["RateEngine.price"])
  })

  test("documentation facts carry docstrings", () => {
    const doc = facts("code:documentation").find((f) => f.item.subject === id("src/`quote.ts`/quote()."))!
    expect(doc.item.value).toContain("Builds a quote using the RateEngine.")
  })
})
