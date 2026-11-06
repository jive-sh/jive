import * as e from "effect";

/**
 * What jive reads back from each `@jive-sh/server` function, as decoded from Convex's `convex_encoded_json` by
 * `convex/values`' `jsonToConvex`, the encoding Convex's own clients use (bytes arrive as `ArrayBuffer`).
 * `contract.test.ts` checks, at type-check time, that every answer `@jive-sh/server-client` declares for these
 * functions decodes here, so a server change that breaks jive fails jive's audit.
 */

export const OpenedSignInRequestValue = e.Schema.Struct({
  requestId: e.Schema.NonEmptyString,
  claimSecret: e.Schema.NonEmptyString,
  loginUrl: e.Schema.NonEmptyString,
  expiresAt: e.Schema.Number,
  // Absent from servers before phone approval.
  approvalDevices: e.Schema.optionalKey(e.Schema.Number),
});

export const ClaimValue = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("pending") }),
  e.Schema.Struct({ status: e.Schema.Literal("approved"), sessionToken: e.Schema.NonEmptyString, expiresAt: e.Schema.Number }),
  e.Schema.Struct({ status: e.Schema.Literal("gone") }),
]);

export const PipelineSignInValue = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("signedIn"), sessionToken: e.Schema.NonEmptyString, expiresAt: e.Schema.Number }),
  e.Schema.Struct({ status: e.Schema.Literal("refused"), reason: e.Schema.String }),
]);

export const ProvisionValue = e.Schema.Union([
  e.Schema.Struct({ status: e.Schema.Literal("ready"), instanceId: e.Schema.String, instance: e.Schema.Unknown }),
  e.Schema.Struct({ status: e.Schema.Literal("inProgress"), retryAfterSeconds: e.Schema.Number }),
  e.Schema.Struct({ status: e.Schema.Literal("personNeeded"), reason: e.Schema.String, url: e.Schema.String }),
  e.Schema.Struct({ status: e.Schema.Literal("refused"), reason: e.Schema.String }),
]);

export const AccountValue = e.Schema.NullOr(e.Schema.Struct({ username: e.Schema.String, sessionExpiresAt: e.Schema.Number }));
export const PublicKeyValue = e.Schema.Struct({ publicKey: e.Schema.NonEmptyString });
export const SignatureValue = e.Schema.Struct({ signature: e.Schema.instanceOf(ArrayBuffer) });
