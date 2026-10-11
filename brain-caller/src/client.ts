/** Calls the brain over HTTP (design rev 4 §6.1). */
import { Data, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/** A non-2xx response: `body` is the service's `{ error: { code, message } }` JSON. */
export class CallError extends Data.TaggedError("CallError")<{ readonly status: number; readonly body: unknown }> {}

export interface Connection {
  readonly url: string
  readonly key: string
}

export const call = <A = unknown>(conn: Connection, path: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(`${conn.url.replace(/\/$/, "")}${path}`).pipe(
      HttpClientRequest.bearerToken(conn.key),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError((e) => new CallError({ status: 0, body: { error: { code: "UNREACHABLE", message: `${conn.url}: ${e.message}` } } })),
    )
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new CallError({ status: response.status, body: { error: { code: "INTERNAL", message: `HTTP ${response.status}: ${text.slice(0, 500)}` } } }),
    })
    if (response.status >= 400) return yield* new CallError({ status: response.status, body: json })
    return json as A
  })

/** Calls `/v1/<method>`. */
export const kg = <A = unknown>(conn: Connection, method: string, body: unknown) => call<A>(conn, `/v1/${method}`, body)
