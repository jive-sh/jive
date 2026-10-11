/** HTTP mapping (design rev 4 §6.1): POST /v1/<method>, POST /admin/v1/<method>, GET /health. */
import { timingSafeEqual } from "node:crypto"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Admin from "./admin.ts"
import * as C from "./contract.ts"
import type { Writer } from "./contract.ts"
import { pendingCount } from "./embed/worker.ts"
import { BrainError, fail, httpStatus, invalid } from "./errors.ts"
import { neighbors } from "./kg/neighbors.ts"
import { getEntity, getFact, listFacts } from "./kg/read.ts"
import { search } from "./kg/search.ts"
import { sourceChanged } from "./kg/sources.ts"
import { write } from "./kg/write.ts"

export const MAX_BODY_BYTES = 32 * 1024 * 1024

interface Method {
  readonly schema: any
  readonly run: (writer: Writer, input: any) => Effect.Effect<unknown, unknown, any>
}

const methods: Record<string, Method> = {
  write: { schema: C.WriteRequest, run: write },
  getEntity: { schema: C.GetEntityRequest, run: (_w, q) => getEntity(q) },
  getFact: { schema: C.GetFactRequest, run: (_w, q) => getFact(q) },
  listFacts: { schema: C.ListFactsRequest, run: (_w, q) => listFacts(q) },
  search: { schema: C.SearchRequest, run: (_w, q) => search(q) },
  neighbors: { schema: C.NeighborsRequest, run: (_w, q) => neighbors(q) },
  sourceChanged: { schema: C.SourceChangedRequest, run: sourceChanged },
}

const adminMethods: Record<string, Omit<Method, "run"> & { run: (input: any) => Effect.Effect<unknown, unknown, any> }> = {
  registerWriter: { schema: C.RegisterWriterRequest, run: Admin.registerWriter },
  rotateKey: { schema: C.RotateKeyRequest, run: Admin.rotateKey },
  listWriters: { schema: C.ListWritersRequest, run: () => Admin.listWriters() },
  revertWriter: { schema: C.RevertWriterRequest, run: Admin.revertWriter },
}

const bearer = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers["authorization"] ?? ""
  return header.startsWith("Bearer ") ? header.slice(7).trim() : ""
}

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return yield* invalid("request body exceeds 32 MB")
    const text = yield* request.text.pipe(Effect.mapError(() => invalid("could not read request body")))
    return yield* Effect.try({ try: () => (text.length === 0 ? {} : JSON.parse(text)), catch: () => invalid("request body must be JSON") })
  })

const respond = (effect: Effect.Effect<unknown, unknown, any>) =>
  effect.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value ?? null)),
    Effect.catch((error: unknown) => {
      if (error instanceof BrainError) {
        const body = { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }
        return Effect.succeed(HttpServerResponse.jsonUnsafe(body, { status: httpStatus[error.code] }))
      }
      return Effect.logError("internal error", error).pipe(
        Effect.as(HttpServerResponse.jsonUnsafe({ error: { code: "INTERNAL", message: String((error as Error)?.message ?? error) } }, { status: 500 })),
      )
    }),
  )

const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export const routes = (adminKey: string) =>
  Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/v1/:method",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const writer = yield* Admin.authenticate(bearer(request))
        const method = methods[(yield* HttpRouter.params)["method"] ?? ""]
        if (!method) return yield* fail("NOT_FOUND", "unknown method")
        const input = yield* C.decode(method.schema)(yield* readBody(request))
        return yield* method.run(writer, input)
      }).pipe(respond),
    ),
    HttpRouter.add(
      "POST",
      "/admin/v1/:method",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!sameKey(bearer(request), adminKey)) return yield* fail("UNAUTHENTICATED", "admin key required")
        const method = adminMethods[(yield* HttpRouter.params)["method"] ?? ""]
        if (!method) return yield* fail("NOT_FOUND", "unknown admin method")
        const input = yield* C.decode(method.schema)(yield* readBody(request))
        return yield* method.run(input)
      }).pipe(respond),
    ),
    HttpRouter.add("GET", "/health", Effect.map(pendingCount, (pendingEmbeddings) => ({ ok: true, pendingEmbeddings })).pipe(respond)),
  )
