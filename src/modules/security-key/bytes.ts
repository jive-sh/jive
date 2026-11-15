/**
 * Standard base64, which `@jive-sh/server`'s `signingPasskey:sign` uses (`atob` / `btoa`), and base64url, which
 * WebAuthn puts in `clientDataJSON` and which the signing passkey's credential id is stored as.
 */

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const bytesToBase64Url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const read = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export type ReadBytes = { readonly _tag: "Read"; readonly bytes: Uint8Array } | { readonly _tag: "Rejected" };

export const readBase64 = (value: string): ReadBytes => {
  try {
    return { _tag: "Read", bytes: read(value) };
  } catch {
    return { _tag: "Rejected" };
  }
};

/** Accepts base64url with or without `=` padding. */
export const readBase64Url = (value: string): ReadBytes => {
  const remainder = value.length % 4;
  const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
  return readBase64(`${value.replaceAll("-", "+").replaceAll("_", "/")}${padding}`);
};
