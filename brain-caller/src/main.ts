/** `brain-caller`: the agent CLI for the brain (design rev 4 §8). */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient } from "effect/http"
import { CallError, call, kg, type Connection } from "./client.ts"
import { ingestCode } from "./ingest/ingestCode.ts"
import { runBundledScipTypescript, SCIP_TYPESCRIPT } from "./ingest/indexers.ts"
import { listAll } from "./list.ts"
import { brief } from "./brief.ts"

const VERSION = "0.1.0"

const connFlags = {
  url: Flag.String("url").pipe(
    Flag.withDescription("brain URL (env BRAIN_URL)"),
    Flag.withFallbackConfig(Config.String("BRAIN_URL")),
    Flag.withDefault("http://127.0.0.1:8787"),
  ),
  key: Flag.String("key").pipe(Flag.withDescription("API key (env BRAIN_KEY)"), Flag.withFallbackConfig(Config.String("BRAIN_KEY")), Flag.withDefault("")),
}
const adminFlags = {
  url: connFlags.url,
  adminKey: Flag.String("admin-key").pipe(
    Flag.withDescription("admin key (env BRAIN_ADMIN_KEY)"),
    Flag.withFallbackConfig(Config.String("BRAIN_ADMIN_KEY")),
    Flag.withDefault(""),
  ),
}

const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const describe = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const briefFlag = Flag.Boolean("brief").pipe(Flag.withDefault(false), Flag.withDescription("one line per entity/fact instead of JSON"))

/** Print the result (JSON, or `format` when given), or the service's error JSON on stderr with exit code 1. */
const output = <A, R>(effect: Effect.Effect<A, unknown, R>, format?: (a: A) => string) =>
  effect.pipe(
    Effect.flatMap((a) => (format ? Console.log(format(a)) : print(a))),
    Effect.catch((e: unknown) =>
      Console.error(JSON.stringify(e instanceof CallError ? e.body : { error: { code: "CLIENT", message: describe(e) } })).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  )

const conn = (c: { url: string; key: string }): Connection => ({ url: c.url, key: c.key })
const some = <A>(o: Option.Option<A>) => (Option.isSome(o) ? o.value : undefined)
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

const readJson = (file: Option.Option<string>) =>
  Effect.tryPromise({
    try: async () => JSON.parse(Option.isSome(file) ? await Bun.file(file.value).text() : await Bun.stdin.text()) as unknown,
    catch: (e) => new Error(`could not read JSON batch: ${String(e)}`),
  })

const write = Command.make(
  "write",
  {
    ...connFlags,
    file: Argument.String("file").pipe(Argument.optional),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("validate and report without writing")),
  },
  (c) =>
    output(
      Effect.flatMap(readJson(c.file), (batch) =>
        kg(conn(c), "write", c.dryRun ? { ...(batch as Record<string, unknown>), dryRun: true } : batch),
      ),
    ),
).pipe(Command.withDescription("Apply a write batch (JSON) from a file or stdin"))

const getEntity = Command.make("get-entity", { ...connFlags, id: Argument.String("id"), brief: briefFlag }, (c) =>
  output(kg<any>(conn(c), "getEntity", { id: c.id }), c.brief ? brief.entity : undefined),
).pipe(Command.withDescription("An entity with the facts about it and pointing at it"))

const getFact = Command.make(
  "get-fact",
  { ...connFlags, id: Argument.String("id"), history: Flag.Boolean("history").pipe(Flag.withDefault(false)), brief: briefFlag },
  (c) => output(kg<any>(conn(c), "getFact", c.history ? { id: c.id, includeHistory: true } : { id: c.id }), c.brief ? brief.fact : undefined),
).pipe(Command.withDescription("A fact with what it rests on, what rests on it, and what disputes it"))

const listFacts = Command.make(
  "list-facts",
  {
    ...connFlags,
    subject: Flag.String("subject").pipe(Flag.optional),
    object: Flag.String("object").pipe(Flag.optional),
    predicate: Flag.String("predicate").pipe(Flag.optional),
    writer: Flag.String("writer").pipe(Flag.optional),
    staleOnly: Flag.Boolean("stale-only").pipe(Flag.withDefault(false)),
    sourceRef: Flag.String("source-ref").pipe(Flag.optional),
    sourceRefPrefix: Flag.String("source-ref-prefix").pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.optional),
    cursor: Flag.String("cursor").pipe(Flag.optional),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false), Flag.withDescription("follow cursors and print every page")),
    brief: briefFlag,
  },
  (c) => {
    const filter = defined({
      subject: some(c.subject),
      object: some(c.object),
      predicate: some(c.predicate),
      writer: some(c.writer),
      staleOnly: c.staleOnly || undefined,
      sourceRef: some(c.sourceRef),
      sourceRefPrefix: some(c.sourceRefPrefix),
      limit: some(c.limit),
    })
    return output(listAll(conn(c), filter, some(c.cursor), c.all) as Effect.Effect<any, unknown, HttpClient.HttpClient>, c.brief ? brief.page : undefined)
  },
).pipe(Command.withDescription("Active facts matching every filter, newest first"))

const search = Command.make(
  "search",
  { ...connFlags, text: Argument.String("text").pipe(Argument.variadic()), limit: Flag.Int("limit").pipe(Flag.optional), brief: briefFlag },
  (c) => output(kg<any>(conn(c), "search", defined({ text: c.text.join(" "), limit: some(c.limit) })), c.brief ? brief.search : undefined),
).pipe(Command.withDescription("Find entities by exact name and facts by text and meaning"))

const neighbors = Command.make(
  "neighbors",
  {
    ...connFlags,
    id: Argument.String("id"),
    predicate: Flag.String("predicate").pipe(Flag.atLeast(0)),
    direction: Flag.Literals("direction", ["out", "in", "both"]).pipe(Flag.optional),
    depth: Flag.Int("depth").pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.optional),
    brief: briefFlag,
  },
  (c) =>
    output(
      kg<any>(
        conn(c),
        "neighbors",
        defined({ from: c.id, predicates: c.predicate.length ? c.predicate : undefined, direction: some(c.direction), depth: some(c.depth), limit: some(c.limit) }),
      ),
      c.brief ? brief.neighbors : undefined,
    ),
).pipe(Command.withDescription("Follow links from an entity, up to 3 hops"))

const sourceChanged = Command.make("source-changed", { ...connFlags, ref: Argument.String("ref"), version: Argument.String("version") }, (c) =>
  output(kg(conn(c), "sourceChanged", { ref: c.ref, version: c.version })),
).pipe(Command.withDescription("Report that the evidence at <ref> is now at <version>"))

const ingest = Command.make(
  "ingest-code",
  {
    ...connFlags,
    dir: Argument.String("repo-dir"),
    repo: Flag.String("repo").pipe(Flag.withDescription("<org>/<repo>, used in entity IDs and refs")),
    writer: Flag.String("writer").pipe(Flag.withDefault("workflow/code-indexer"), Flag.withDescription("the writer ID of --key")),
    index: Flag.String("index").pipe(Flag.optional, Flag.withDescription("use this index.scip instead of running an indexer")),
    batchSize: Flag.Int("batch-size").pipe(Flag.withDefault(2000)),
  },
  (c) => output(ingestCode(conn(c), { dir: c.dir, repo: c.repo, writer: c.writer, index: some(c.index), batchSize: c.batchSize })),
).pipe(Command.withDescription("Index a git checkout with SCIP and sync its code facts into the brain"))

const adminConn = (c: { url: string; adminKey: string }): Connection => ({ url: c.url, key: c.adminKey })
const admin = Command.make("admin").pipe(
  Command.withDescription("Administration with the admin key"),
  Command.withSubcommands([
    Command.make("register-writer", { ...adminFlags, id: Argument.String("id"), basis: Flag.String("basis").pipe(Flag.atLeast(1)) }, (c) =>
      output(call(adminConn(c), "/admin/v1/registerWriter", { writerId: c.id, allowedBases: c.basis })),
    ),
    Command.make("rotate-key", { ...adminFlags, id: Argument.String("id") }, (c) =>
      output(call(adminConn(c), "/admin/v1/rotateKey", { writerId: c.id })),
    ),
    Command.make("list-writers", { ...adminFlags }, (c) => output(call(adminConn(c), "/admin/v1/listWriters", {}))),
    Command.make("revert-writer", { ...adminFlags, id: Argument.String("id"), since: Flag.String("since") }, (c) =>
      output(call(adminConn(c), "/admin/v1/revertWriter", { writerId: c.id, since: c.since })),
    ),
  ]),
)

const root = Command.make("brain-caller").pipe(
  Command.withDescription("Read and write the project brain. Prints JSON."),
  Command.withSubcommands([write, getEntity, getFact, listFacts, search, neighbors, sourceChanged, ingest, admin]),
)

if (process.argv[2] === SCIP_TYPESCRIPT) {
  runBundledScipTypescript(process.argv.slice(3))
} else {
  Command.run(root, { version: VERSION }).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
    BunRuntime.runMain,
  )
}
