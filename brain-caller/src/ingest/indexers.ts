/** Finds or runs a SCIP indexer for a repo (design rev 4 §8.1 step 2). */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

/** Hidden subcommand that runs the bundled scip-typescript in this process. */
export const SCIP_TYPESCRIPT = "__scip-typescript"

/** How to re-invoke this program: the compiled executable, or bun + the script in development. */
const self = (): string[] => (Bun.main.startsWith("/$bunfs") ? [process.execPath] : [process.execPath, Bun.main])

interface Indexer {
  readonly name: string
  readonly detect: (dir: string) => boolean
  readonly command: (output: string, dir: string) => string[]
}

/**
 * TypeScript projects to index: the repo root if it has a tsconfig.json, otherwise every directory
 * (outside node_modules, up to four levels deep) that has one, as in Nx and other monorepos.
 */
const typescriptProjects = (dir: string): string[] => {
  if (existsSync(join(dir, "tsconfig.json"))) return []
  const found: string[] = []
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (existsSync(join(dir, child, "tsconfig.json"))) found.push(child)
      walk(child, depth + 1)
    }
  }
  walk("", 1)
  return found.length > 0 ? found : ["--infer-tsconfig"]
}

const has = (dir: string, ...files: string[]) => files.some((f) => existsSync(join(dir, f)))

const INDEXERS: ReadonlyArray<Indexer> = [
  {
    name: "scip-typescript (bundled)",
    detect: (dir) => has(dir, "tsconfig.json", "package.json", "jsconfig.json"),
    command: (out, dir) => [...self(), SCIP_TYPESCRIPT, "index", "--output", out, ...typescriptProjects(dir)],
  },
  { name: "scip-python", detect: (d) => has(d, "pyproject.toml", "setup.py", "requirements.txt"), command: (o) => ["scip-python", "index", "--output", o] },
  { name: "scip-java", detect: (d) => has(d, "pom.xml", "build.gradle", "build.gradle.kts", "build.sbt"), command: (o) => ["scip-java", "index", "--output", o] },
  { name: "scip-go", detect: (d) => has(d, "go.mod"), command: (o) => ["scip-go", "--output", o] },
  { name: "rust-analyzer", detect: (d) => has(d, "Cargo.toml"), command: (o) => ["rust-analyzer", "scip", ".", "--output", o] },
  { name: "scip-ruby", detect: (d) => has(d, "Gemfile"), command: (o) => ["scip-ruby", "--index-file", o] },
]

/** Produce `index.scip` bytes for `dir`: from `indexFile` if given, else by running the detected indexer. */
export const produceIndex = (dir: string, indexFile: string | undefined) =>
  Effect.gen(function* () {
    if (indexFile) return { indexer: "provided", bytes: new Uint8Array(readFileSync(indexFile)) }
    const indexer = INDEXERS.find((i) => i.detect(dir))
    if (!indexer) return yield* Effect.fail(new Error(`no SCIP indexer known for ${dir}; pass --index <file>`))
    const out = join(mkdtempSync(join(tmpdir(), "brain-caller-scip-")), "index.scip")
    const cmd = indexer.command(out, dir)
    const result = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" })
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        return { stderr, code }
      },
      catch: (e) => new Error(`could not run ${indexer.name} (${cmd[0]}): ${String(e)}`),
    })
    if (result.code !== 0 || !existsSync(out)) {
      return yield* Effect.fail(new Error(`${indexer.name} failed (exit ${result.code}): ${result.stderr.slice(-2000)}`))
    }
    return { indexer: indexer.name, bytes: new Uint8Array(readFileSync(out)) }
  })

/** Entry point for the hidden subcommand: `brain-caller __scip-typescript index --output …`. */
export const runBundledScipTypescript = (args: ReadonlyArray<string>) => {
  process.argv = [process.argv[0]!, "scip-typescript", ...args]
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@sourcegraph/scip-typescript/dist/src/main.js").main()
}
