import * as e from "effect";

/**
 * The protocol between the Jive browser extension and `jive-extension-daemon`. The extension is the only client: it
 * reaches the daemon through Chrome native messaging, and the native host (`jive-native-host`) relays each message to
 * the daemon's local socket unchanged. Both sides import this module, so a message one side sends is exactly what the
 * other decodes. It imports nothing but `effect`, so the extension can import it from jive's source.
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
  /** The authenticator app's shared secret, uppercase base32 without padding. */
  totpSecret: e.Schema.NonEmptyString,
});
export type NpmCredential = typeof NpmCredential.Type;

export const DaemonRequest = e.Schema.Union([
  /** Whether this machine is signed in to Jive, or waiting for a sign-in. Never returns the token. */
  e.Schema.TaggedStruct("GetSession", {}),
  /**
   * Starts signing this machine in: the daemon opens a sign-in request and answers with the jive.sh page to open,
   * where the person signs in with their passkey. The session then goes from Jive to the daemon, never through the
   * extension.
   */
  e.Schema.TaggedStruct("StartSignIn", {}),
  /** Signs this machine out of Jive: the session `jive login` and the extension share is forgotten. */
  e.Schema.TaggedStruct("SignOut", {}),
  /** Whether a collected npm credential could be posted now; asked before anything on npm changes. */
  e.Schema.TaggedStruct("GetNpmConnectionReadiness", {}),
  /** Posts the credential to Jive with this machine's session. The daemon keeps no copy. */
  e.Schema.TaggedStruct("PostNpmCredential", { credential: NpmCredential }),
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
  /** Waiting for the person to sign in on `loginUrl` before `expiresAt` (ISO-8601). */
  e.Schema.TaggedStruct("SigningIn", { loginUrl: e.Schema.String, expiresAt: e.Schema.String }),
  /** `expiresAt` (ISO-8601) is when Jive ends this machine's session unless it is used before then. */
  e.Schema.TaggedStruct("SignedIn", { expiresAt: e.Schema.String }),
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
  /** Sign-in could not start, for example because Jive could not be reached. */
  e.Schema.TaggedStruct("SignInFailed", { reason: e.Schema.String }),
  ...NpmConnectionReadiness.members,
  ...PostOutcome.members,
  /** The request could not be handled: malformed, another protocol version, or a failure inside the daemon. */
  e.Schema.TaggedStruct("Failed", { message: e.Schema.String }),
]);
export type DaemonResponse = typeof DaemonResponse.Type;

export const ResponseEnvelope = e.Schema.Struct({
  requestId: e.Schema.String,
  response: DaemonResponse,
});
export type ResponseEnvelope = typeof ResponseEnvelope.Type;

/** Sent by the native host, in place of any response, when it cannot reach the daemon; the host then exits. */
export const DaemonUnreachable = e.Schema.TaggedStruct("DaemonUnreachable", { message: e.Schema.String });
export type DaemonUnreachable = typeof DaemonUnreachable.Type;

/** Everything the extension can receive on its native messaging port. */
export const NativePortMessage = e.Schema.Union([ResponseEnvelope, DaemonUnreachable]);
export type NativePortMessage = typeof NativePortMessage.Type;
