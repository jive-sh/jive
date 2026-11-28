import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { jiveServerFailure, type JiveServerError, type OpenedSignInRequest, type SignInCaller } from "@/modules/jive-server/interface";
import { readBase64, readBase64Url, bytesToBase64 } from "@/modules/security-key/bytes";
import { buildCeremony } from "@/modules/security-key/webauthn";
import { SignedInAccount } from "@/modules/session/interface";
import type { IExtensionDaemon } from "./interface";
import { PROTOCOL_VERSION, RequestEnvelope, type DaemonRequest, type DaemonResponse, type ResponseEnvelope } from "./protocol";

const decodeRequestLine = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(RequestEnvelope));
const isoTime = (epochMs: number): string => new Date(epochMs).toISOString();

const StoredRepository = e.Schema.Struct({
  repositoryOwner: e.Schema.NonEmptyString,
  repositoryName: e.Schema.NonEmptyString,
});
const decodeStoredRepository = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(StoredRepository));

interface PreparedRepository {
  readonly repositoryOwner: string;
  readonly repositoryName: string;
}

export class ExtensionDaemonImpl extends implementing(modules.extensionDaemon).uses(
  modules.session,
  modules.machineSignIn,
  modules.npmCredentialPoster,
  modules.jiveServer,
  OSPlatform,
  e.FileSystem.FileSystem,
) implements IExtensionDaemon {
  /**
   * The repository whose signing passkey answers npm, also stored in the jive home so a restart keeps it. The page
   * does not name one. Empty means refuse, and the page keeps the browser's own prompt.
   */
  private readonly preparedRepository = e.Ref.makeUnsafe(e.Option.none<PreparedRepository>());

  *answerLine({ line, caller }: { readonly line: string; readonly caller: SignInCaller }): EffectGen<ResponseEnvelope> {
    // A decode error would quote the line, which can hold a token or secret, so none is kept.
    const maybeEnvelope = decodeRequestLine(line);
    if (e.Option.isNone(maybeEnvelope)) {
      return { requestId: "", response: { _tag: "Failed", message: "the daemon could not read that request" } };
    }
    const { requestId, protocolVersion, request } = maybeEnvelope.value;
    if (protocolVersion !== PROTOCOL_VERSION) {
      const older = protocolVersion < PROTOCOL_VERSION ? "the extension" : "jive";
      return { requestId, response: { _tag: "Failed", message: `the extension speaks protocol ${protocolVersion} and jive-daemon ${PROTOCOL_VERSION}; upgrade ${older}` } };
    }
    return {
      requestId,
      response: yield* e.pipe(
        e.Effect.gen(() => this.answer({ request, caller })),
        // A defect answers this request only; the connection keeps answering the ones after it.
        e.Effect.catchCause((cause) => e.pipe(
          e.Effect.logError(`Could not answer the extension's ${request._tag}: ${e.Cause.pretty(cause)}`),
          e.Effect.as<DaemonResponse>({ _tag: "Failed", message: `jive-daemon could not answer ${request._tag}` }),
        )),
      ),
    };
  }

  private *answer({ request, caller }: { readonly request: DaemonRequest; readonly caller: SignInCaller }): EffectGen<DaemonResponse> {
    const { session, machineSignIn, npmCredentialPoster } = this.dependencies;
    switch (request._tag) {
      case "GetSession": {
        const account = yield* e.Effect.result(e.Effect.gen(() => session.whoIsSignedIn()));
        if (e.Result.isFailure(account)) {
          return { _tag: "Failed", message: `Jive's server could not check this machine's session: ${account.failure.reason}` };
        }
        return yield* SignedInAccount.$match(account.success, {
          Confirmed: ({ username, session: confirmed }) => e.Effect.succeed<DaemonResponse>({
            _tag: "SignedIn", username, expiresAt: isoTime(confirmed.expiresAt), confirmedByServer: true,
          }),
          Unconfirmed: ({ maybeUsername, session: unconfirmed, unreachableUrl }) => e.Effect.succeed<DaemonResponse>({
            _tag: "SignedIn",
            ...e.Option.match(maybeUsername, { onNone: () => ({}), onSome: (username) => ({ username }) }),
            expiresAt: isoTime(unconfirmed.expiresAt),
            confirmedByServer: false,
            unreachableServerUrl: unreachableUrl,
          }),
          SignedOut: () => e.Effect.map(e.Effect.gen(() => machineSignIn.waiting()), e.Option.match({
            onNone: (): DaemonResponse => ({ _tag: "SignedOut" }),
            onSome: (waiting): DaemonResponse => signingIn(waiting),
          })),
        });
      }
      case "StartSignIn":
        return yield* e.pipe(
          e.Effect.gen(() => machineSignIn.startOrJoin(caller)),
          e.Effect.map(signingIn),
          e.Effect.catchTag("SignInFailed", ({ reason }) => e.Effect.succeed<DaemonResponse>({ _tag: "SignInFailed", reason })),
        );
      case "AwaitSignIn":
        return yield* e.pipe(
          e.Effect.gen(() => machineSignIn.awaitEnd()),
          e.Effect.as<DaemonResponse>({ _tag: "SignInFinished" }),
          e.Effect.catchTag("SignInFailed", ({ reason }) => e.Effect.succeed<DaemonResponse>({ _tag: "SignInFailed", reason })),
        );
      case "SignOut":
        yield* machineSignIn.cancel();
        yield* session.forget();
        return { _tag: "SignedOut" };
      case "GetNpmConnectionReadiness": {
        if (e.Option.isNone(yield* session.current())) return { _tag: "NotReady", reason: "this machine is not signed in to Jive" };
        return e.Option.match(yield* npmCredentialPoster.unavailableBecause(), {
          onNone: (): DaemonResponse => ({ _tag: "Ready" }),
          onSome: (reason): DaemonResponse => ({ _tag: "NotReady", reason }),
        });
      }
      case "PostNpmCredential": {
        const maybeSession = yield* session.current();
        if (e.Option.isNone(maybeSession)) return { _tag: "Refused", reason: "this machine is no longer signed in to Jive" };
        return yield* e.pipe(
          e.Effect.gen(() => npmCredentialPoster.postNpmCredential({ session: maybeSession.value, credential: request.credential })),
          e.Effect.as<DaemonResponse>({ _tag: "Posted" }),
          e.Effect.catchTag("CredentialRefused", ({ reason }) => e.Effect.succeed<DaemonResponse>({ _tag: "Refused", reason })),
        );
      }
      case "PrepareSigningPasskey": {
        const repository = { repositoryOwner: request.repositoryOwner, repositoryName: request.repositoryName };
        const saved = yield* e.Effect.result(e.Effect.gen(() => this.storePrepared(repository)));
        if (e.Result.isFailure(saved)) return { _tag: "Failed", message: "jive-daemon could not remember which repository's signing passkey answers npm" };
        yield* e.Ref.set(this.preparedRepository, e.Option.some(repository));
        return { _tag: "SigningPasskeyPrepared" };
      }
      case "AnswerSecurityKey":
        return yield* this.answerSecurityKey(request);
    }
  }

  /**
   * Builds the WebAuthn bytes from the page's own challenge, rpId and origin, and asks the server to sign
   * `authenticatorData || sha256(clientDataJSON)`. The server returns raw `r‖s` and does not read those bytes.
   * A refusal names no challenge.
   */
  private *answerSecurityKey(request: Extract<DaemonRequest, { readonly _tag: "AnswerSecurityKey" }>): EffectGen<DaemonResponse> {
    const prepared = yield* this.prepared();
    if (e.Option.isNone(prepared)) {
      return { _tag: "SecurityKeyRefused", reason: "this machine has not been told which repository's signing passkey answers npm" };
    }
    const { session, jiveServer } = this.dependencies;
    const maybeSession = yield* session.current();
    if (e.Option.isNone(maybeSession)) return { _tag: "SecurityKeyRefused", reason: "this machine is not signed in to Jive" };
    const checked = yield* e.Effect.result(e.Effect.gen(() => session.checkWithServer(maybeSession.value)));
    if (e.Result.isFailure(checked)) return { _tag: "SecurityKeyRefused", reason: "this machine is not signed in to Jive" };
    const live = checked.success;
    if (e.Option.isNone(live)) return { _tag: "SecurityKeyRefused", reason: "this machine is not signed in to Jive" };
    const signingSession = live.value.session;
    const challenge = readBase64Url(request.challenge);
    if (challenge._tag === "Rejected") return { _tag: "SecurityKeyRefused", reason: "the challenge is not base64url" };
    const ensured = yield* e.Effect.result(e.Effect.gen(() => jiveServer.ensureSigningPasskey({
      session: signingSession,
      repositoryOwner: prepared.value.repositoryOwner,
      repositoryName: prepared.value.repositoryName,
    })));
    if (e.Result.isFailure(ensured)) return refused(ensured.failure);
    const credentialId = readBase64Url(ensured.success.credentialId);
    if (credentialId._tag === "Rejected") return { _tag: "SecurityKeyRefused", reason: "the signing passkey's credential id is not base64url" };
    const publicKeySpki = readBase64(ensured.success.publicKeySpki);
    if (publicKeySpki._tag === "Rejected") return { _tag: "SecurityKeyRefused", reason: "the signing passkey's public key is not base64" };
    const built = buildCeremony({
      kind: request.kind,
      challenge: challenge.bytes,
      rpId: request.rpId,
      origin: request.origin,
      crossOrigin: request.crossOrigin,
      credentialId: credentialId.bytes,
      publicKeySpki: publicKeySpki.bytes,
    });
    if (built._tag === "Rejected") return { _tag: "SecurityKeyRefused", reason: built.reason };
    const signed = yield* e.Effect.result(e.Effect.gen(() => jiveServer.signWithSigningPasskey({
      session: signingSession,
      repositoryOwner: prepared.value.repositoryOwner,
      repositoryName: prepared.value.repositoryName,
      challenge: built.ceremony.signedBytes,
    })));
    if (e.Result.isFailure(signed)) return refused(signed.failure);
    const ceremony = built.ceremony;
    const credential = bytesToBase64(credentialId.bytes);
    const clientDataJSON = bytesToBase64(ceremony.clientDataJSON);
    const authenticatorData = bytesToBase64(ceremony.authenticatorData);
    const signature = bytesToBase64(signed.success);
    if (ceremony._tag === "get") return { _tag: "SecurityKeyAnswer", credentialId: credential, clientDataJSON, authenticatorData, signature };
    return { _tag: "SecurityKeyAnswer", credentialId: credential, clientDataJSON, authenticatorData, signature, attestationObject: bytesToBase64(ceremony.attestationObject) };
  }

  /** This process's repository, or the one stored for the next start of the daemon. */
  private *prepared(): EffectGen<e.Option.Option<PreparedRepository>> {
    const current = yield* e.Ref.get(this.preparedRepository);
    if (e.Option.isSome(current)) return current;
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { signingPasskeyRepositoryFile } = yield* this.paths();
    const stored = e.Option.flatMap(yield* e.Effect.option(fs.readFileString(signingPasskeyRepositoryFile)), decodeStoredRepository);
    if (e.Option.isSome(stored)) yield* e.Ref.set(this.preparedRepository, stored);
    return stored;
  }

  /** Written beside the target and renamed over it, so a restart never reads a half-written repository. */
  private *storePrepared(repository: PreparedRepository): EffectGen<void, e.PlatformError.PlatformError> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { signingPasskeyRepositoryFile } = yield* this.paths();
    const staging = `${signingPasskeyRepositoryFile}.${process.pid}.tmp`;
    yield* fs.makeDirectory(path.dirname(signingPasskeyRepositoryFile), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(staging, `${JSON.stringify(repository)}\n`, { mode: 0o600 });
    yield* fs.chmod(staging, 0o600);
    yield* fs.rename(staging, signingPasskeyRepositoryFile);
  }

  private *paths() {
    return jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory());
  }
}

const refused = (error: JiveServerError): DaemonResponse => {
  const failure = jiveServerFailure(error);
  const reason = failure.includes("challenge") ? "Jive could not sign" : failure;
  return { _tag: "SecurityKeyRefused", reason };
};

function signingIn(request: OpenedSignInRequest): DaemonResponse {
  return { _tag: "SigningIn", loginUrl: request.loginUrl, expiresAt: isoTime(request.expiresAt), approvalDevices: request.approvalDevices };
}
