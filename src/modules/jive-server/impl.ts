import * as e from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { getFunctionName, type FunctionArgs, type FunctionReference } from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { api, convexSiteUrl, convexUrl } from "@jive-sh/server-client";
import { modules } from "@/modules";
import {
  AccountValue,
  AddCallerValue,
  ClaimValue,
  MachineOpenValue,
  PipelineSignInValue,
  ProvisionValue,
  PublicKeyValue,
  SignatureValue,
  SigningPasskeySignatureValue,
  SigningPasskeyValue,
} from "./contract";
import { bytesToBase64, readBase64 } from "@/modules/security-key/bytes";
import type { MachineDescription } from "@/modules/machine-identity/interface";
import { JiveServerRefused, JiveServerUnreachable, ProvisionAnswer, SignInClaim, type IJiveServer, type JiveServerError, type OpenedSignInRequest, type Session, type SessionAccount, type SignInCaller } from "./interface";

/**
 * Calls the server through Convex's HTTP API (`POST <deployment>/api/<query|action>`) in `convex_encoded_json`, the
 * format Convex's own clients use, encoded and decoded by `convex/values` (bytes travel as `{ "$bytes": … }`). Every
 * call names its function by `@jive-sh/server-client`'s `api`, so its path and arguments are the server's own types;
 * what comes back is decoded by `./contract`. The deployment URL comes from `@jive-sh/server-client` too.
 */

const ACCOUNT_CHECK_TIMEOUT = e.Duration.seconds(5);

const ConvexAnswer = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("success"), value: e.Schema.Unknown }),
  e.Schema.Struct({ status: e.Schema.Literal("error"), errorMessage: e.Schema.String, errorData: e.Schema.optionalKey(e.Schema.Unknown) }),
]);

export class JiveServerImpl extends implementing(modules.jiveServer).uses(HttpClient.HttpClient) implements IJiveServer {
  *openMachineSignInRequest(input: {
    readonly previousSession: e.Option.Option<Session>;
    readonly machine: MachineDescription;
    readonly signedAt: number;
    readonly signature: string;
    readonly callers: ReadonlyArray<SignInCaller>;
  }): EffectGen<OpenedSignInRequest, JiveServerError> {
    const call = "POST /sign-in-requests";
    const url = `${convexSiteUrl}/sign-in-requests`;
    const client = this.getDependency(HttpClient.HttpClient);
    const body = {
      ...e.Option.match(input.previousSession, { onNone: () => ({}), onSome: (session) => ({ previousSessionToken: session.sessionToken }) }),
      machine: input.machine,
      signedAt: input.signedAt,
      signature: input.signature,
      callers: input.callers,
    };
    const answer = yield* e.pipe(
      client.execute(e.pipe(HttpClientRequest.post(url), HttpClientRequest.bodyJsonUnsafe(body))),
      // A refusal answers 403 with its reason in the same shape, so the status is not checked here.
      e.Effect.flatMap(HttpClientResponse.schemaJson(e.Schema.Struct({ body: MachineOpenValue }))),
      // Neither error quotes the body, which holds the previous session token.
      e.Effect.catchTag("HttpClientError", (error) => e.Effect.fail(new JiveServerUnreachable({ call, url, transportFailure: error.reason._tag }))),
      e.Effect.catchTag("SchemaError", () => e.Effect.fail(new JiveServerRefused({ call, reason: `${url} answered in an unexpected shape` }))),
    );
    if (answer.body.status === "refused") return yield* new JiveServerRefused({ call, reason: answer.body.reason });
    const opened = answer.body.request;
    return { ...opened, approvalDevices: opened.approvalDevices !== undefined ? opened.approvalDevices : 0 };
  }

  *addSignInCaller({ request, caller }: { readonly request: OpenedSignInRequest; readonly caller: SignInCaller }): EffectGen<boolean, JiveServerError> {
    const added = yield* this.call("action", api.signInRequests.addCaller, {
      requestId: request.requestId,
      claimSecret: request.claimSecret,
      caller: { programs: [...caller.programs] },
    }, AddCallerValue);
    return added === "added";
  }

  *claimSignInRequest({ request, signature }: { readonly request: OpenedSignInRequest; readonly signature: string }): EffectGen<SignInClaim, JiveServerError> {
    const claim = yield* this.call("action", api.signInRequests.claim, { requestId: request.requestId, claimSecret: request.claimSecret, signature }, ClaimValue);
    switch (claim.status) {
      case "pending": return SignInClaim.Pending();
      case "gone": return SignInClaim.Gone();
      case "approved": return SignInClaim.Approved({ session: { sessionToken: claim.sessionToken, expiresAt: claim.expiresAt } });
    }
  }

  *signInPipeline(idToken: string): EffectGen<Session, JiveServerError> {
    const outcome = yield* this.call("action", api.pipelineSessions.signIn, {}, PipelineSignInValue, e.Option.some(idToken));
    if (outcome.status === "refused") {
      return yield* new JiveServerRefused({ call: "pipelineSessions:signIn", reason: `Jive refused to sign this job in: ${outcome.reason}` });
    }
    return { sessionToken: outcome.sessionToken, expiresAt: outcome.expiresAt };
  }

  *accountOf(session: Session): EffectGen<e.Option.Option<SessionAccount>, JiveServerError> {
    const account = yield* e.Effect.timeoutOrElse(e.Effect.gen(() => this.call("query", api.accounts.me, { sessionToken: session.sessionToken }, AccountValue)), {
      // git and ssh wait on this answer before they sign, so a network that swallows the request counts as no network.
      duration: ACCOUNT_CHECK_TIMEOUT,
      orElse: () => e.Effect.fail(new JiveServerUnreachable({
        call: getFunctionName(api.accounts.me),
        url: convexUrl,
        transportFailure: `no answer within ${e.Duration.format(ACCOUNT_CHECK_TIMEOUT)}`,
      })),
    });
    return e.Option.fromNullOr(account);
  }

  *sshPublicKey(session: Session): EffectGen<string, JiveServerError> {
    const { publicKey } = yield* this.call("query", api.ssh.publicKey, { sessionToken: session.sessionToken }, PublicKeyValue);
    return publicKey;
  }

  *ensureSigningPasskey(input: {
    readonly session: Session;
    readonly repositoryOwner: string;
    readonly repositoryName: string;
  }): EffectGen<{ readonly credentialId: string; readonly publicKeySpki: string }, JiveServerError> {
    return yield* this.call("action", api.signingPasskey.ensure, {
      sessionToken: input.session.sessionToken,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
    }, SigningPasskeyValue);
  }

  *signWithSigningPasskey(input: {
    readonly session: Session;
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly challenge: Uint8Array;
  }): EffectGen<Uint8Array, JiveServerError> {
    const { signature } = yield* this.call("action", api.signingPasskey.sign, {
      sessionToken: input.session.sessionToken,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      challenge: bytesToBase64(input.challenge),
    }, SigningPasskeySignatureValue);
    const decoded = readBase64(signature);
    if (decoded._tag === "Rejected") {
      return yield* new JiveServerRefused({ call: "signingPasskey:sign", reason: "the signature was not base64" });
    }
    return decoded.bytes;
  }

  *signWithSshKey(session: Session, data: Uint8Array): EffectGen<Uint8Array, JiveServerError> {
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const { signature } = yield* this.call("action", api.ssh.sign, { sessionToken: session.sessionToken, data: bytes }, SignatureValue);
    return new Uint8Array(signature);
  }

  *provision({ session, kind, instance }: { readonly session: Session; readonly kind: string; readonly instance: unknown }): EffectGen<ProvisionAnswer, JiveServerError> {
    const answer = yield* this.call("action", api.provision.default, { sessionToken: session.sessionToken, kind, instance }, ProvisionValue);
    switch (answer.status) {
      case "ready": return ProvisionAnswer.Ready({ instanceId: answer.instanceId });
      case "inProgress": return ProvisionAnswer.InProgress({ retryAfterSeconds: answer.retryAfterSeconds });
      case "personNeeded": return ProvisionAnswer.PersonNeeded({ reason: answer.reason, url: answer.url });
      case "refused": return ProvisionAnswer.Refused({ reason: answer.reason });
    }
  }

  /** `kind` is the function's own (`F["_type"]`), passed because `api` only carries it in types. `bearer` goes in the Authorization header, where Convex verifies an ID token itself (the server's auth config). */
  private *call<F extends FunctionReference<"query" | "action">, A>(
    kind: F["_type"],
    fn: F,
    args: FunctionArgs<F>,
    value: e.Schema.Codec<A, unknown>,
    bearer: e.Option.Option<string> = e.Option.none(),
  ): EffectGen<A, JiveServerError> {
    const client = this.getDependency(HttpClient.HttpClient);
    const path = getFunctionName(fn);
    const failure = (reason: string) => new JiveServerRefused({ call: path, reason });
    const request = e.pipe(
      HttpClientRequest.post(`${convexUrl}/api/${kind}`),
      HttpClientRequest.bodyJsonUnsafe({ path, args: convexToJson(args as Value), format: "convex_encoded_json" }),
    );
    const answer = yield* e.pipe(
      client.execute(e.Option.isSome(bearer) ? HttpClientRequest.bearerToken(request, bearer.value) : request),
      e.Effect.flatMap(HttpClientResponse.schemaJson(e.Schema.Struct({ body: ConvexAnswer }))),
      // Neither error quotes the body or the request, which can hold a token, claim secret or signature.
      e.Effect.catchTag("HttpClientError", (error) => e.Effect.fail(new JiveServerUnreachable({ call: path, url: convexUrl, transportFailure: error.reason._tag }))),
      e.Effect.catchTag("SchemaError", () => e.Effect.fail(failure(`${convexUrl} answered in an unexpected shape`))),
    );
    if (answer.body.status === "error") {
      const data = answer.body.errorData;
      return yield* failure(typeof data === "string" ? data : answer.body.errorMessage);
    }
    const encoded = answer.body.value;
    const decoded = yield* e.Effect.try({
      try: () => jsonToConvex(encoded as Parameters<typeof jsonToConvex>[0]),
      catch: () => failure(`${path} answered in an unexpected encoding`),
    });
    return yield* e.pipe(
      e.Schema.decodeUnknownEffect(value)(decoded),
      e.Effect.mapError(() => failure(`${path} answered in an unexpected shape`)),
    );
  }
}
