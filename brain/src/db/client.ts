import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"
import { pgliteOptions } from "./assets.ts"
import { migrations } from "./migrations.ts"

export interface DbConfig {
  /** PGlite data directory, or "memory://" for an in-memory database. */
  readonly dataDir?: string
  /** External Postgres URL. Takes precedence over dataDir. */
  readonly databaseUrl?: string
}

/** Apply each migration version not yet recorded in schema_migrations, in its own transaction. */
const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())`
  const applied = new Set((yield* sql<{ version: number }>`select version from schema_migrations`).map((r) => r.version))
  for (const m of migrations) {
    if (applied.has(m.version)) continue
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of m.statements) yield* sql.unsafe(statement)
        yield* sql`insert into schema_migrations (version) values (${m.version})`
      }),
    )
  }
})

const connection = (config: DbConfig): Layer.Layer<SqlClient.SqlClient, unknown> =>
  config.databaseUrl
    ? PgClient.layer({ url: Redacted.make(config.databaseUrl) })
    : Layer.unwrap(
        Effect.promise(async () => {
          // PGlite creates only the last path segment.
          if (config.dataDir && !config.dataDir.includes("://")) mkdirSync(config.dataDir, { recursive: true })
          return PgliteClient.layer({ dataDir: config.dataDir ?? "memory://", ...(await pgliteOptions()) } as never)
        }),
      )

/** Log statements slower than BRAIN_SLOW_MS (diagnostics; PGlite runs on the one JS thread, so a slow statement stalls everything). */
const slowLog = Effect.gen(function* () {
  const threshold = Number(process.env["BRAIN_SLOW_MS"] ?? 0)
  if (!threshold) return
  const client = yield* Effect.serviceOption(PgliteClient.PgliteClient)
  if (client._tag === "None") return
  const pg = client.value.pglite as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const method of ["query", "exec"] as const) {
    const original = pg[method]!.bind(pg)
    pg[method] = async (...args: unknown[]) => {
      const started = performance.now()
      try {
        return await original(...args)
      } finally {
        const ms = performance.now() - started
        if (ms > threshold) console.error(`[slow sql ${Math.round(ms)}ms] ${String(args[0]).replace(/\s+/g, " ").slice(0, 600)}`)
      }
    }
  }
})

export const Db = {
  /** A connection without migrations (tests and maintenance). */
  layerRaw: (config: DbConfig): Layer.Layer<SqlClient.SqlClient, unknown> => connection(config),
  /** A migrated database connection. */
  layer: (config: DbConfig): Layer.Layer<SqlClient.SqlClient, unknown> =>
    Layer.effectDiscard(Effect.andThen(slowLog, migrate)).pipe(Layer.provideMerge(connection(config))),
}
