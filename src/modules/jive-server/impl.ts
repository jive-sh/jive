import * as e from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { convexUrl } from "@jive-sh/server-client";
import { modules } from "@/modules";
import { JiveServerError, SignInClaim, type IJiveServer, type OpenedSignInRequest, type Session } from "./interface";

/**
 * Calls the server through Convex's HTTP API (`POST <deployment>/api/<query|action>`), which answers
 * `{ status: "success", value }` or `{ status: "error", errorMessage, errorData }`. Bytes travel as
 * `{ "$bytes": <base64> }`, Convex's JSON form of `v.bytes()`. The deployment URL comes from
 * `@jive-sh/server-client`, which the server's own deploy publishes.
 */

const ConvexAnswer = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("success"), value: e.Schema.Unknown }),
  e.Schema.Struct({ status: e.Schema.Literal("error"), errorMessage: e.Schema.String, errorData: e.Schema.optionalKey(e.Schema.Unknown) }),
]);

const ConvexBytes = e.Schema.Struct({ $bytes: e.Schema.String });

const OpenedSignInRequestValue = e.Schema.Struct({
  requestId: e.Schema.NonEmptyString,
  claimSecret: e.Schema.NonEmptyString,
  confirmationCode: e.Schema.NonEmptyString,
  loginUrl: e.Schema.NonEmptyString,
  expiresAt: e.Schema.Number,
});

const ClaimValue = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("pending") }),
  e.Schema.Struct({ status: e.Schema.Literal("approved"), sessionToken: e.Schema.NonEmptyString, expiresAt: e.Schema.Number }),
  e.Schema.Struct({ status: e.Schema.Literal("gone") }),
]);

const AccountValue = e.Schema.NullOr(e.Schema.Struct({ username: e.Schema.String }));
const PublicKeyValue = e.Schema.Struct({ publicKey: e.Schema.NonEmptyString });
const SignatureValue = e.Schema.Struct({ signature: ConvexBytes });

type FunctionKind = "query" | "action";

export class JiveServerImpl extends implementing(modules.jiveServer).uses(HttpClient.HttpClient) implements IJiveServer {
  *openSignInRequest(): EffectGen<OpenedSignInRequest, JiveServerError> {
    return yield* this.call("action", "signInRequests:open", {}, OpenedSignInRequestValue);
  }

  *claimSignInRequest(request: OpenedSignInRequest): EffectGen<SignInClaim, JiveServerError> {
    const claim = yield* this.call("action", "signInRequests:claim", { requestId: request.requestId, claimSecret: request.claimSecret }, ClaimValue);
    switch (claim.status) {
      case "pending": return SignInClaim.Pending();
      case "gone": return SignInClaim.Gone();
      case "approved": return SignInClaim.Approved({ session: { sessionToken: claim.sessionToken, expiresAt: claim.expiresAt } });
    }
  }

  *accountOf(session: Session): EffectGen<e.Option.Option<{ readonly username: string }>, JiveServerError> {
    const account = yield* this.call("query", "accounts:me", { sessionToken: session.sessionToken }, AccountValue);
    return e.Option.fromNullOr(account);
  }

  *createSshKey(session: Session): EffectGen<{ readonly publicKey: string }, JiveServerError> {
    return yield* this.call("action", "ssh:createKey", { sessionToken: session.sessionToken }, PublicKeyValue);
  }

  *signWithSshKey(session: Session, data: Uint8Array): EffectGen<Uint8Array, JiveServerError> {
    const { signature } = yield* this.call(
      "action",
      "ssh:sign",
      { sessionToken: session.sessionToken, data: { $bytes: Buffer.from(data).toString("base64") } },
      SignatureValue,
    );
    return new Uint8Array(Buffer.from(signature.$bytes, "base64"));
  }

  private *call<A>(kind: FunctionKind, path: string, args: Record<string, unknown>, value: e.Schema.Codec<A, unknown>): EffectGen<A, JiveServerError> {
    const client = this.getDependency(HttpClient.HttpClient);
    const failure = (reason: string) => new JiveServerError({ call: path, reason });
    const answer = yield* e.pipe(
      client.execute(e.pipe(
        HttpClientRequest.post(`${convexUrl}/api/${kind}`),
        HttpClientRequest.bodyJsonUnsafe({ path, args, format: "json" }),
      )),
      e.Effect.flatMap(HttpClientResponse.schemaJson(e.Schema.Struct({ body: ConvexAnswer }))),
      // Neither error quotes the body or the request, which can hold a token, claim secret or signature.
      e.Effect.catchTag("HttpClientError", (error) => e.Effect.fail(failure(`could not reach ${convexUrl}: ${error.reason._tag}`))),
      e.Effect.catchTag("SchemaError", () => e.Effect.fail(failure(`${convexUrl} answered in an unexpected shape`))),
    );
    if (answer.body.status === "error") {
      const data = answer.body.errorData;
      return yield* failure(typeof data === "string" ? data : answer.body.errorMessage);
    }
    return yield* e.pipe(
      e.Schema.decodeUnknownEffect(value)(answer.body.value),
      e.Effect.mapError(() => failure(`${path} answered in an unexpected shape`)),
    );
  }
}
