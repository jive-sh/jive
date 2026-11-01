/**
 * The parts of the SSH agent protocol (draft-miller-ssh-agent) the signing agent speaks. Every message is a
 * `uint32` length, then a type byte and its payload; a `string` is a `uint32` length and that many bytes.
 */

export const AgentMessageType = {
  Failure: 5,
  RequestIdentities: 11,
  IdentitiesAnswer: 12,
  SignRequest: 13,
  SignResponse: 14,
} as const;

export type AgentRequest =
  | { readonly _tag: "RequestIdentities" }
  | { readonly _tag: "SignRequest"; readonly keyBlob: Uint8Array; readonly data: Uint8Array; readonly flags: number }
  /** A message the agent does not support (extensions, adding or removing keys, locking), answered with a failure. */
  | { readonly _tag: "Unsupported"; readonly type: number };

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

const uint32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const sshString = (bytes: Uint8Array): Uint8Array => concat([uint32(bytes.length), bytes]);

/** Splits complete messages off the bytes received so far; the rest waits for more bytes. */
export const takeMessages = (received: Uint8Array): { readonly messages: ReadonlyArray<Uint8Array>; readonly rest: Uint8Array } => {
  const messages: Array<Uint8Array> = [];
  let offset = 0;
  while (received.length - offset >= 4) {
    const length = readUint32(received, offset);
    if (received.length - offset - 4 < length) break;
    messages.push(received.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { messages, rest: received.slice(offset) };
};

export const frame = (message: Uint8Array): Uint8Array => concat([uint32(message.length), message]);

/** Reads one message; a malformed one is unsupported, so it gets a failure rather than closing the connection. */
export const parseRequest = (message: Uint8Array): AgentRequest => {
  const type = message[0];
  if (type === AgentMessageType.RequestIdentities) return { _tag: "RequestIdentities" };
  if (type !== AgentMessageType.SignRequest) return { _tag: "Unsupported", type: type ?? -1 };
  let offset = 1;
  const readString = (): Uint8Array | undefined => {
    if (message.length - offset < 4) return undefined;
    const length = readUint32(message, offset);
    if (message.length - offset - 4 < length) return undefined;
    const value = message.slice(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return value;
  };
  const keyBlob = readString();
  const data = readString();
  if (keyBlob === undefined || data === undefined || message.length - offset < 4) return { _tag: "Unsupported", type };
  return { _tag: "SignRequest", keyBlob, data, flags: readUint32(message, offset) };
};

export const failure = (): Uint8Array => Uint8Array.of(AgentMessageType.Failure);

export const identitiesAnswer = (identities: ReadonlyArray<{ readonly keyBlob: Uint8Array; readonly comment: string }>): Uint8Array =>
  concat([
    Uint8Array.of(AgentMessageType.IdentitiesAnswer),
    uint32(identities.length),
    ...identities.flatMap(({ keyBlob, comment }) => [sshString(keyBlob), sshString(new TextEncoder().encode(comment))]),
  ]);

/** `signature` is already in SSH's encoding (`string algorithm || string signature`), as the server returns it. */
export const signResponse = (signature: Uint8Array): Uint8Array =>
  concat([Uint8Array.of(AgentMessageType.SignResponse), sshString(signature)]);

/** An OpenSSH public key line's key blob (its base64 field, decoded) and comment. */
export const parsePublicKeyLine = (line: string): { readonly keyBlob: Uint8Array; readonly comment: string } => {
  const [, base64 = "", ...comment] = line.trim().split(/\s+/);
  return { keyBlob: new Uint8Array(Buffer.from(base64, "base64")), comment: comment.join(" ") };
};

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
