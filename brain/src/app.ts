/** The brain service as one Layer: database, embedder, embedding worker, and HTTP server. */
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Db } from "./db/client.ts"
import { Embedder } from "./embed/Embedder.ts"
import { runWorker } from "./embed/worker.ts"
import { MAX_BODY_BYTES, routes } from "./http.ts"
import { runMaintenance } from "./db/maintenance.ts"

export interface AppConfig {
  readonly port: number
  readonly hostname: string
  readonly dataDir?: string
  readonly databaseUrl?: string
  readonly embedder: "local" | "fake" | "none"
  readonly adminKey: string
  /** Embedding thread module URL; required in compiled executables (see main.ts). */
  readonly embedThreadUrl?: string
}


export const appLayer = (config: AppConfig) => {
  const db = Db.layer({
    ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
    ...(config.databaseUrl !== undefined ? { databaseUrl: config.databaseUrl } : {}),
  })
  const embedder =
    config.embedder === "local" ? Embedder.Local(config.embedThreadUrl) : config.embedder === "fake" ? Embedder.Fake : Embedder.None
  const deps = embedder.pipe(Layer.provideMerge(db))
  const worker = Layer.effectDiscard(Effect.all([Effect.forkScoped(runWorker), Effect.forkScoped(runMaintenance)]))
  const server = HttpRouter.serve(routes(config.adminKey), { disableLogger: true, disableListenLog: true })
  return Layer.mergeAll(server, worker).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ port: config.port, hostname: config.hostname, maxRequestBodySize: MAX_BODY_BYTES + 1024 * 1024 }),
    ),
    Layer.provideMerge(deps),
  )
}
