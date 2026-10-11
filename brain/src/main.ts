/** `brain`: the Knowledge Graph service (design rev 4 §6). Configured by environment variables; see README. */
import { BunRuntime } from "@effect/platform-bun"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Config, Effect, Layer, Option } from "effect"
import { appLayer } from "./app.ts"

const VERSION = "0.1.0"

const config = Config.all({
  port: Config.Port("BRAIN_PORT").pipe(Config.withDefault(8787)),
  hostname: Config.String("BRAIN_HOST").pipe(Config.withDefault("127.0.0.1")),
  dataDir: Config.String("BRAIN_DATA_DIR").pipe(Config.withDefault("./.brain-data")),
  databaseUrl: Config.option(Config.String("BRAIN_DATABASE_URL")),
  adminKey: Config.option(Config.String("BRAIN_ADMIN_KEY")),
  embedder: Config.Literals(["local", "none"], "BRAIN_EMBEDDER").pipe(Config.withDefault("local" as const)),
})

/** The admin key from the environment, or from `<dataDir>/admin.key`, generated on first start. */
const resolveAdminKey = (dataDir: string, fromEnv: Option.Option<string>) => {
  if (Option.isSome(fromEnv)) return { key: fromEnv.value, file: undefined }
  const file = join(dataDir, "admin.key")
  if (existsSync(file)) return { key: readFileSync(file, "utf8").trim(), file }
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
  writeFileSync(file, `${key}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return { key, file }
}

/** One process per data directory: PGlite would corrupt a directory opened twice. */
const lockDataDir = (dataDir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const lock = join(dataDir, "brain.lock")
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, "utf8"))
        let alive = false
        try {
          process.kill(pid, 0)
          alive = pid !== process.pid
        } catch {}
        if (alive) throw new Error(`${dataDir} is in use by brain process ${pid}`)
      }
      writeFileSync(lock, String(process.pid))
      return lock
    }),
    (lock) => Effect.sync(() => rmSync(lock, { force: true })),
  )

const main = Effect.gen(function* () {
  if (process.argv.includes("--version")) return yield* Effect.sync(() => console.log(VERSION))
  if (process.argv.includes("--help")) {
    return yield* Effect.sync(() =>
      console.log(`brain ${VERSION} — Knowledge Graph service
Environment: BRAIN_PORT (8787), BRAIN_HOST (127.0.0.1), BRAIN_DATA_DIR (./.brain-data),
BRAIN_DATABASE_URL (use external Postgres), BRAIN_ADMIN_KEY (else <data dir>/admin.key), BRAIN_EMBEDDER (local|none)`),
    )
  }
  const c = yield* config
  const dataDir = resolve(c.dataDir)
  mkdirSync(dataDir, { recursive: true })
  if (Option.isNone(c.databaseUrl)) yield* lockDataDir(dataDir)
  const admin = resolveAdminKey(dataDir, c.adminKey)
  const layer = appLayer({
    port: c.port,
    hostname: c.hostname,
    embedder: c.embedder,
    adminKey: admin.key,
    // Resolved from this entry file so it also works inside the compiled executable.
    embedThreadUrl: new URL("./embed/thread.ts", import.meta.url).href,
    ...(Option.isSome(c.databaseUrl) ? { databaseUrl: c.databaseUrl.value } : { dataDir: join(dataDir, "pg") }),
  })
  yield* Effect.log(
    `brain ${VERSION} listening on http://${c.hostname}:${c.port}` +
      (admin.file ? `; admin key in ${admin.file}` : "; admin key from BRAIN_ADMIN_KEY") +
      (Option.isSome(c.databaseUrl) ? "; database: BRAIN_DATABASE_URL" : `; data in ${join(dataDir, "pg")}`),
  )
  return yield* Layer.launch(layer)
})

BunRuntime.runMain(Effect.scoped(main) as Effect.Effect<void, unknown>)
