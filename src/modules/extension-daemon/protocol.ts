import * as e from "effect";

/**
 * The protocol of `jive-daemon`'s API socket (`~/.jive/jive-daemon.sock`). The Jive browser extension is the client
 * for the session and for posting an npm credential: it reaches the daemon through Chrome native messaging, and the
 * native host (`jive-native-host`) relays each message to the daemon's socket unchanged. A program that opens npm's
 * security-key page sends `PrepareSigningPasskey` on that socket directly, not through the native host, because the
 * page does not name a repository. `jive-ssh`, `jive-ssh-sign` and `jive whoami` send `GetSession` directly too
 * (`./client`). Both sides import this module, so a message one side sends is exactly what the other decodes. It
 * imports nothing but `effect`, so the extension can import it from jive's source.
 *
 * Every request carries `protocolVersion`. A daemon refuses another version with a message saying which side to
 * upgrade; there is no compatibility layer.
 */

export const PROTOCOL_VERSION = 1;

/** The name Chrome knows the native host by: the extension calls `chrome.runtime.connectNative(NATIVE_HOST_NAME)`. */
export const NATIVE_HOST_NAME = "sh.jive.daemon";

/**
 * The extension's public key, as `manifest.json`'s `key`. Chrome derives an unpacked extension's id from it, so the
 * id is the same on every machine and the daemon can allow only that extension to start its native host. No private
 * key exists for it: one is needed only to pack a `.crx`, and a packed release will get its own.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqB2KyVVMWLKswJtyc+XHKhaan891abV1ie8Df7jb+aBglID17h1MPiytRRpsfNdx0955CwFWfb8XnVWAv5RHfy/0XyjG/0uGOyUvhYJ9tUVKQAeOKYT5W6Qk5Qw7+zqWPCxFVIj84c6aTpxZ9yA8846jTEKip8bvUDdMuO3FbMXAXpEBbLRIwkf4XAt0JnAcQHQpc0SvGDu4DUhxSNVOMXeytxOwDt67GysUbwXu03WJmsl2IGu0NJWe68BACxVd/eQ6RNHpTBdbZ20B5F9b1K311gdbDrusMPN6+QsSx3gUL+B2ciw4ukxkNZRQ02SmpMJWx7fgvRT8siQV9CVc8wIDAQAB";

/** The npm account the extension collected: what Jive needs to act on npm as that account. */
export const NpmCredential = e.Schema.Struct({
  npmUser: e.Schema.NonEmptyString,
  token: e.Schema.NonEmptyString,
});
export type NpmCredential = typeof NpmCredential.Type;

export const DaemonRequest = e.Schema.Union([
  /**
   * Whether this machine is signed in to Jive and as whom, checked with the server, or waiting for a sign-in. Never
   * returns the token.
   */
  e.Schema.TaggedStruct("GetSession", {}),
  /**
   * Starts signing this machine in for the program asking: the daemon opens a sign-in request signed with the
   * machine's key, or adds that program to the request already waiting, and answers with the jive.sh page, where the
   * person signs in with their passkey. The daemon names the program from the socket's peer process, never from the
   * request. The session then goes from Jive to the daemon, never through the program.
   */
  e.Schema.TaggedStruct("StartSignIn", {}),
  /** Answers when the sign-in under way ends: `SignInFinished` once the session is stored, or `SignInFailed`. */
  e.Schema.TaggedStruct("AwaitSignIn", {}),
  /** Signs this machine out of Jive: the session `jive login` and the extension share is forgotten. */
  e.Schema.TaggedStruct("SignOut", {}),
  /** Whether a collected npm credential could be posted now; asked before anything on npm changes. */
  e.Schema.TaggedStruct("GetNpmConnectionReadiness", {}),
  /** Posts the credential to Jive with this machine's session. The daemon keeps no copy. */
  e.Schema.TaggedStruct("PostNpmCredential", { credential: NpmCredential }),
  /**
   * Which repository's signing passkey answers the next security-key prompt. The npm page does not name a Jive
   * organization, and a person's session must not sign an arbitrary organization's key, so the program that knows
   * the repository sends this before the page asks.
   */
  e.Schema.TaggedStruct("PrepareSigningPasskey", {
    repositoryOwner: e.Schema.NonEmptyString,
    repositoryName: e.Schema.NonEmptyString,
  }),
  /**
   * Asks the daemon to answer one WebAuthn create or get. `challenge`, `rpId` and `origin` are the page's own
   * options. `challenge` is base64url. Nothing here logs it.
   */
  e.Schema.TaggedStruct("AnswerSecurityKey", {
    kind: e.Schema.Literals(["create", "get"]),
    challenge: e.Schema.NonEmptyString,
    rpId: e.Schema.NonEmptyString,
    origin: e.Schema.NonEmptyString,
    crossOrigin: e.Schema.Boolean,
  }),
]);
export type DaemonRequest = typeof DaemonRequest.Type;

export const RequestEnvelope = e.Schema.Struct({
  protocolVersion: e.Schema.Number,
  requestId: e.Schema.NonEmptyString,
  request: DaemonRequest,
});
export type RequestEnvelope = typeof RequestEnvelope.Type;

export const SessionStatus = e.Schema.Union([
  e.Schema.TaggedStruct("SignedOut", {}),
  /**
   * Waiting for the person to sign in on `loginUrl` before `expiresAt` (ISO-8601); `approvalDevices` is how many of
   * the account's phones were asked.
   */
  e.Schema.TaggedStruct("SigningIn", { loginUrl: e.Schema.String, expiresAt: e.Schema.String, approvalDevices: e.Schema.optionalKey(e.Schema.Number) }),
  /**
   * Signed in as `username`; `expiresAt` (ISO-8601) is when Jive ends this machine's session unless it is used before
   * then. `confirmedByServer` is false when the server at `unreachableServerUrl` could not be reached: `username` and
   * `expiresAt` are then the ones saved when it last confirmed the session, and `username` is absent for a session
   * file saved before jive kept usernames. `unreachableServerUrl` is present exactly when `confirmedByServer` is false.
   */
  e.Schema.TaggedStruct("SignedIn", {
    username: e.Schema.optionalKey(e.Schema.NonEmptyString),
    expiresAt: e.Schema.String,
    confirmedByServer: e.Schema.Boolean,
    unreachableServerUrl: e.Schema.optionalKey(e.Schema.String),
  }),
]);
export type SessionStatus = typeof SessionStatus.Type;

export const NpmConnectionReadiness = e.Schema.Union([
  e.Schema.TaggedStruct("Ready", {}),
  e.Schema.TaggedStruct("NotReady", { reason: e.Schema.String }),
]);
export type NpmConnectionReadiness = typeof NpmConnectionReadiness.Type;

export const PostOutcome = e.Schema.Union([
  e.Schema.TaggedStruct("Posted", {}),
  e.Schema.TaggedStruct("Refused", { reason: e.Schema.String }),
]);
export type PostOutcome = typeof PostOutcome.Type;

export const DaemonResponse = e.Schema.Union([
  ...SessionStatus.members,
  /** Sign-in could not start or did not finish, for example because Jive could not be reached or the request expired. */
  e.Schema.TaggedStruct("SignInFailed", { reason: e.Schema.String }),
  /** The sign-in finished: the session is stored. */
  e.Schema.TaggedStruct("SignInFinished", {}),
  ...NpmConnectionReadiness.members,
  ...PostOutcome.members,
  /** The request could not be handled: malformed, another protocol version, or a failure inside the daemon. */
  e.Schema.TaggedStruct("Failed", { message: e.Schema.String }),
  e.Schema.TaggedStruct("SigningPasskeyPrepared", {}),
  /**
   * The assembled WebAuthn fields. Every byte string is standard base64. `attestationObject` is present for
   * `create` and omitted for `get`. `signature` is the raw ECDSA `r‖s` the server returned.
   */
  e.Schema.TaggedStruct("SecurityKeyAnswer", {
    credentialId: e.Schema.NonEmptyString,
    clientDataJSON: e.Schema.NonEmptyString,
    authenticatorData: e.Schema.NonEmptyString,
    signature: e.Schema.NonEmptyString,
    attestationObject: e.Schema.optionalKey(e.Schema.NonEmptyString),
  }),
  e.Schema.TaggedStruct("SecurityKeyRefused", { reason: e.Schema.String }),
]);
export type DaemonResponse = typeof DaemonResponse.Type;

export const ResponseEnvelope = e.Schema.Struct({
  requestId: e.Schema.String,
  response: DaemonResponse,
});
export type ResponseEnvelope = typeof ResponseEnvelope.Type;

/** One request, as the daemon's socket reads it: one JSON object, no trailing newline. */
export const encodeRequestLine = (envelope: RequestEnvelope): string =>
  e.Schema.encodeSync(e.Schema.fromJsonString(RequestEnvelope))(envelope);

/** Sent by the native host, in place of any response, when it cannot reach the daemon; the host then exits. */
export const DaemonUnreachable = e.Schema.TaggedStruct("DaemonUnreachable", { message: e.Schema.String });
export type DaemonUnreachable = typeof DaemonUnreachable.Type;

/** Everything the extension can receive on its native messaging port. */
export const NativePortMessage = e.Schema.Union([ResponseEnvelope, DaemonUnreachable]);
export type NativePortMessage = typeof NativePortMessage.Type;
