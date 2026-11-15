import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bytesToBase64Url } from "./bytes";
import { buildCeremony, sha256 } from "./webauthn";

const challenge = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
const credentialId = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const rpId = "www.npmjs.com";
const origin = "https://www.npmjs.com";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

const signedOver = (authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array => {
  const hash = createHash("sha256").update(clientDataJSON).digest();
  const out = new Uint8Array(authenticatorData.length + hash.length);
  out.set(authenticatorData, 0);
  out.set(hash, authenticatorData.length);
  return out;
};

const readText = (bytes: Uint8Array, offset: number): { readonly value: string; readonly offset: number } => {
  const initial = bytes[offset];
  if (initial === undefined || (initial >> 5) !== 3) throw new Error("expected a text string");
  const length = initial & 31;
  const start = offset + 1;
  return { value: new TextDecoder().decode(bytes.subarray(start, start + length)), offset: start + length };
};

const readBstr = (bytes: Uint8Array, offset: number): { readonly value: Uint8Array; readonly offset: number } => {
  const initial = bytes[offset];
  if (initial === undefined || (initial >> 5) !== 2) throw new Error("expected a byte string");
  const additional = initial & 31;
  const length = additional < 24 ? additional : bytes[offset + 1];
  if (length === undefined) throw new Error("missing length");
  const start = additional < 24 ? offset + 1 : offset + 2;
  return { value: bytes.subarray(start, start + length), offset: start + length };
};

test("a get ceremony signs authenticatorData concatenated with sha256(clientDataJSON)", async () => {
  const built = buildCeremony({ kind: "get", challenge, rpId, origin, crossOrigin: false, credentialId, publicKeySpki: spki });
  expect(built._tag).toBe("Built");
  if (built._tag !== "Built" || built.ceremony._tag !== "get") return;
  const { clientDataJSON, authenticatorData, signedBytes } = built.ceremony;
  expect(JSON.parse(new TextDecoder().decode(clientDataJSON))).toEqual({
    type: "webauthn.get",
    challenge: bytesToBase64Url(challenge),
    origin,
    crossOrigin: false,
  });
  expect(authenticatorData.subarray(0, 32)).toEqual(sha256(new TextEncoder().encode(rpId)));
  expect(authenticatorData[32]).toBe(0x05);
  expect(authenticatorData.subarray(33, 37)).toEqual(new Uint8Array(4));
  expect(authenticatorData.length).toBe(37);
  expect(signedBytes).toEqual(signedOver(authenticatorData, clientDataJSON));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signedBytes);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, signedBytes)).toBe(true);
  const flipped = Uint8Array.from(signedBytes);
  const last = flipped[flipped.length - 1];
  if (last === undefined) throw new Error("empty signed bytes");
  flipped[flipped.length - 1] = last ^ 0xff;
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, flipped)).toBe(false);
});

test("a create ceremony's attestation is fmt none and wraps the same authenticator data", () => {
  const built = buildCeremony({ kind: "create", challenge, rpId, origin, crossOrigin: true, credentialId, publicKeySpki: spki });
  expect(built._tag).toBe("Built");
  if (built._tag !== "Built" || built.ceremony._tag !== "create") return;
  const { authenticatorData, attestationObject, clientDataJSON, signedBytes } = built.ceremony;
  expect(authenticatorData[32]).toBe(0x45);
  expect(JSON.parse(new TextDecoder().decode(clientDataJSON)).crossOrigin).toBe(true);
  expect(signedBytes).toEqual(signedOver(authenticatorData, clientDataJSON));
  expect(attestationObject[0]).toBe(0xa3);
  let offset = 1;
  const fmtKey = readText(attestationObject, offset);
  expect(fmtKey.value).toBe("fmt");
  const fmt = readText(attestationObject, fmtKey.offset);
  expect(fmt.value).toBe("none");
  const stmtKey = readText(attestationObject, fmt.offset);
  expect(stmtKey.value).toBe("attStmt");
  expect(attestationObject[stmtKey.offset]).toBe(0xa0);
  const authKey = readText(attestationObject, stmtKey.offset + 1);
  expect(authKey.value).toBe("authData");
  const auth = readBstr(attestationObject, authKey.offset);
  expect(auth.value).toEqual(authenticatorData);
  expect(auth.offset).toBe(attestationObject.length);
  const x = spki.subarray(spki.length - 64, spki.length - 32);
  const y = spki.subarray(spki.length - 32);
  const suffix = authenticatorData.subarray(authenticatorData.length - (2 + 32 + 1 + 2 + 32));
  expect(suffix[0]).toBe(0x58);
  expect(suffix[1]).toBe(32);
  expect(suffix.subarray(2, 34)).toEqual(x);
  expect(suffix[34]).toBe(0x22);
  expect(suffix[35]).toBe(0x58);
  expect(suffix[36]).toBe(32);
  expect(suffix.subarray(37)).toEqual(y);
});

test("a public key that is not a P-256 SPKI is refused", () => {
  const built = buildCeremony({ kind: "create", challenge, rpId, origin, crossOrigin: false, credentialId, publicKeySpki: new Uint8Array(91) });
  expect(built).toEqual({ _tag: "Rejected", reason: "the signing passkey's public key is not a P-256 key" });
});
