import { createHash } from "node:crypto";
import { bytesToBase64Url } from "./bytes";

/**
 * The WebAuthn bytes an assertion or attestation is made of. `@jive-sh/server`'s `signingPasskey:sign` returns raw
 * ECDSA `r‖s` and does not build these: the caller passes `authenticatorData || sha256(clientDataJSON)`, because the
 * server hashes those bytes once (`ECDSA` with `SHA-256`).
 */

export const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

export type Ceremony =
  | {
    readonly _tag: "get";
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signedBytes: Uint8Array;
  }
  | {
    readonly _tag: "create";
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signedBytes: Uint8Array;
    readonly attestationObject: Uint8Array;
  };

export type CeremonyOutcome = { readonly _tag: "Built"; readonly ceremony: Ceremony } | { readonly _tag: "Rejected"; readonly reason: string };

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** CBOR initial byte plus the argument. Lengths here stay under 65536, which a passkey's authenticator data does. */
const header = (major: number, value: number): Uint8Array => {
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value < 256) return new Uint8Array([(major << 5) | 24, value]);
  return new Uint8Array([(major << 5) | 25, (value >> 8) & 0xff, value & 0xff]);
};

const text = (value: string): Uint8Array => concat([header(3, value.length), new TextEncoder().encode(value)]);

const bstr = (bytes: Uint8Array): Uint8Array => concat([header(2, bytes.length), bytes]);

/** CBOR argument of a negative integer is `-1 - value`, so `-7` is argument `6`. */
const negative = (value: number): Uint8Array => header(1, -1 - value);

/**
 * COSE_Key EC2 for a P-256 SPKI key. WebCrypto's P-256 SPKI is 91 bytes and ends with the uncompressed point
 * `04 || x || y`.
 */
const coseP256 = (spki: Uint8Array): Uint8Array | undefined => {
  if (spki.length !== 91) return undefined;
  const point = spki.subarray(spki.length - 65);
  const prefix = point[0];
  if (prefix !== 0x04) return undefined;
  const x = point.subarray(1, 33);
  const y = point.subarray(33, 65);
  return concat([
    new Uint8Array([0xa5]),
    header(0, 1), header(0, 2),
    header(0, 3), negative(-7),
    negative(-1), header(0, 1),
    negative(-2), bstr(x),
    negative(-3), bstr(y),
  ]);
};

const clientData = (input: {
  readonly kind: "create" | "get";
  readonly challenge: Uint8Array;
  readonly origin: string;
  readonly crossOrigin: boolean;
}): Uint8Array => new TextEncoder().encode(JSON.stringify({
  type: input.kind === "create" ? "webauthn.create" : "webauthn.get",
  challenge: bytesToBase64Url(input.challenge),
  origin: input.origin,
  crossOrigin: input.crossOrigin,
}));

/**
 * Relying parties that require user verification reject a clear UV bit. This key is the organization's, and the
 * person already signed this machine in to use it, so UV is set. The component stores no signature counter, the
 * same as the server's jive.sh passkeys, so the counter is zero.
 */
const authenticatorHead = (rpIdHash: Uint8Array, flags: number): Uint8Array =>
  concat([rpIdHash, new Uint8Array([flags, 0, 0, 0, 0])]);

const attestationObject = (authData: Uint8Array): Uint8Array => concat([
  new Uint8Array([0xa3]),
  text("fmt"), text("none"),
  text("attStmt"), new Uint8Array([0xa0]),
  text("authData"), bstr(authData),
]);

export const buildCeremony = (input: {
  readonly kind: "create" | "get";
  readonly challenge: Uint8Array;
  readonly rpId: string;
  readonly origin: string;
  readonly crossOrigin: boolean;
  readonly credentialId: Uint8Array;
  readonly publicKeySpki: Uint8Array;
}): CeremonyOutcome => {
  const clientDataJSON = clientData(input);
  const rpIdHash = sha256(new TextEncoder().encode(input.rpId));
  if (input.kind === "get") {
    // UP and UV, no attested credential data.
    const data = authenticatorHead(rpIdHash, 0x05);
    return { _tag: "Built", ceremony: { _tag: "get", clientDataJSON, authenticatorData: data, signedBytes: concat([data, sha256(clientDataJSON)]) } };
  }
  const cose = coseP256(input.publicKeySpki);
  if (cose === undefined) return { _tag: "Rejected", reason: "the signing passkey's public key is not a P-256 key" };
  if (input.credentialId.length > 1023) return { _tag: "Rejected", reason: "the signing passkey's credential id is too long" };
  // UP, UV and AT. The AAGUID is sixteen zero bytes: this is not a packed attestation.
  const attested = concat([
    new Uint8Array(16),
    new Uint8Array([(input.credentialId.length >> 8) & 0xff, input.credentialId.length & 0xff]),
    input.credentialId,
    cose,
  ]);
  const data = concat([authenticatorHead(rpIdHash, 0x45), attested]);
  return {
    _tag: "Built",
    ceremony: {
      _tag: "create",
      clientDataJSON,
      authenticatorData: data,
      signedBytes: concat([data, sha256(clientDataJSON)]),
      attestationObject: attestationObject(data),
    },
  };
};
