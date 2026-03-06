import * as crypto from "node:crypto";
import * as e from "effect";
import { encode, decode } from "cbor-x";

const YUBICO_VENDOR_ID = 0x1050;
const FIDO_USAGE_PAGE = 0xf1d0;

const HID_PACKET_SIZE = 64;
const HID_INIT_PAYLOAD_SIZE = 57;
const HID_CONT_PAYLOAD_SIZE = 59;
const BROADCAST_CID = 0xffffffff;

const CTAPHID = {
  PING: 0x01,
  INIT: 0x06,
  CBOR: 0x10,
  KEEPALIVE: 0x3b,
  ERROR: 0x3f,
} as const;

const CTAP2 = {
  MAKE_CREDENTIAL: 0x01,
  GET_INFO: 0x04,
} as const;

type HidDevice = {
  close: () => void;
  write: (values: number[] | Buffer) => number;
  readTimeout: (timeout: number) => number[];
};

interface HidDeviceInfo {
  path?: string;
  vendorId: number;
  usagePage?: number;
  product?: string;
}

interface CtapConnection {
  device: HidDevice;
  cid: number;
  path: string;
  label: string;
}

interface CtapCommandResult {
  statusCode: number;
  data: Uint8Array;
}

const CTAP_STATUS_LABELS: Record<number, string> = {
  0x00: "CTAP2_OK",
  0x01: "CTAP1_ERR_INVALID_COMMAND",
  0x02: "CTAP1_ERR_INVALID_PARAMETER",
  0x11: "CTAP2_ERR_CBOR_UNEXPECTED_TYPE",
  0x12: "CTAP2_ERR_INVALID_CBOR",
  0x14: "CTAP2_ERR_MISSING_PARAMETER",
  0x15: "CTAP2_ERR_LIMIT_EXCEEDED",
  0x19: "CTAP2_ERR_CREDENTIAL_EXCLUDED",
  0x21: "CTAP2_ERR_PROCESSING",
  0x23: "CTAP2_ERR_USER_ACTION_PENDING",
  0x24: "CTAP2_ERR_OPERATION_PENDING",
  0x26: "CTAP2_ERR_UNSUPPORTED_ALGORITHM",
  0x27: "CTAP2_ERR_OPERATION_DENIED",
  0x2b: "CTAP2_ERR_INVALID_OPTION",
  0x2c: "CTAP2_ERR_KEEPALIVE_CANCEL",
  0x2d: "CTAP2_ERR_NO_CREDENTIALS",
  0x2e: "CTAP2_ERR_USER_ACTION_TIMEOUT",
  0x31: "CTAP2_ERR_PIN_INVALID",
  0x32: "CTAP2_ERR_PIN_BLOCKED",
  0x33: "CTAP2_ERR_PIN_AUTH_INVALID",
  0x34: "CTAP2_ERR_PIN_AUTH_BLOCKED",
  0x35: "CTAP2_ERR_PIN_NOT_SET",
  0x36: "CTAP2_ERR_PUAT_REQUIRED",
  0x37: "CTAP2_ERR_PIN_POLICY_VIOLATION",
  0x3b: "CTAP2_ERR_UP_REQUIRED",
  0x3c: "CTAP2_ERR_UV_BLOCKED",
  0x3f: "CTAP2_ERR_UV_INVALID",
};

export function isCtapPrototypeEnabled(): boolean {
  return process.env.JIVE_EXPERIMENTAL_CTAP === "1";
}

export function isCtapCreateAttemptEnabled(): boolean {
  return process.env.JIVE_EXPERIMENTAL_CTAP_CREATE === "1";
}

export async function runCtapGetInfoPrototype(): Promise<e.Option.Option<string>> {
  const connection = await openFirstConnection();
  if (e.Option.isNone(connection)) return e.Option.none();

  try {
    const response = await sendCtapCommand(connection.value, CTAP2.GET_INFO);
    if (response.statusCode !== 0x00) {
      return e.Option.some(`direct CTAP getInfo failed (${formatStatus(response.statusCode)})`);
    }

    let infoSummary = "direct CTAP getInfo succeeded";
    try {
      const decoded = decode(response.data) as unknown;
      if (decoded && typeof decoded === "object" && decoded instanceof Map) {
        const versions = decoded.get(1);
        if (Array.isArray(versions) && versions.length > 0) {
          infoSummary = `${infoSummary}: versions=${versions.join(", ")}`;
        }
      }
    } catch {
      // Keep the success summary even if decode fails.
    }

    return e.Option.some(infoSummary);
  } finally {
    safeClose(connection.value.device);
  }
}

export async function runCtapMakeCredentialPrototype(
  keyName: string,
  rpId: string,
): Promise<e.Option.Option<string>> {
  const connection = await openFirstConnection();
  if (e.Option.isNone(connection)) return e.Option.none();

  try {
    const payload = buildMakeCredentialPayload(keyName, rpId);
    const response = await sendCtapCommand(connection.value, CTAP2.MAKE_CREDENTIAL, payload);

    if (response.statusCode === 0x00) {
      return e.Option.some("direct CTAP makeCredential returned success");
    }

    return e.Option.some(`direct CTAP makeCredential returned ${formatStatus(response.statusCode)}`);
  } finally {
    safeClose(connection.value.device);
  }
}

async function openFirstConnection(): Promise<e.Option.Option<CtapConnection>> {
  const devices = await listCtapDeviceInfos();
  if (e.Option.isNone(devices)) return e.Option.none();

  const first = devices.value[0];
  if (!first?.path) return e.Option.none();

  const hid = await import("node-hid");
  try {
    const device = new hid.HID(first.path, { nonExclusive: true }) as HidDevice;
    const initNonce = crypto.randomBytes(8);
    const initPayload = await sendHidCommand(device, BROADCAST_CID, CTAPHID.INIT, initNonce);
    if (initPayload.length < 12 || !equalBytes(initPayload.slice(0, 8), initNonce)) {
      safeClose(device);
      return e.Option.none();
    }

    const cid = readUInt32BE(initPayload.slice(8, 12));
    return e.Option.some({
      device,
      cid,
      path: first.path,
      label: first.product ?? "YubiKey",
    });
  } catch {
    return e.Option.none();
  }
}

async function listCtapDeviceInfos(): Promise<e.Option.Option<HidDeviceInfo[]>> {
  try {
    const hid = await import("node-hid");
    const infos = hid.devices() as HidDeviceInfo[];

    const yubico = infos.filter((device) => device.vendorId === YUBICO_VENDOR_ID);
    const fido = yubico.filter((device) => device.usagePage === FIDO_USAGE_PAGE);
    const selected = fido.length > 0
      ? fido
      : yubico.filter((device) => /yubikey/i.test(device.product ?? ""));

    return e.Option.some(selected.filter((device) => Boolean(device.path)));
  } catch {
    return e.Option.none();
  }
}

async function sendCtapCommand(
  connection: CtapConnection,
  cborCommand: number,
  cborPayload?: Uint8Array,
): Promise<CtapCommandResult> {
  const payload = cborPayload
    ? new Uint8Array(1 + cborPayload.length)
    : new Uint8Array(1);
  payload[0] = cborCommand;
  if (cborPayload) {
    payload.set(cborPayload, 1);
  }

  const raw = await sendHidCommand(connection.device, connection.cid, CTAPHID.CBOR, payload);
  const statusCode = raw[0] ?? 0xff;
  const data = raw.slice(1);
  return { statusCode, data };
}

async function sendHidCommand(
  device: HidDevice,
  cid: number,
  cmd: number,
  payload: Uint8Array,
): Promise<Uint8Array> {
  writeHidFrames(device, cid, cmd, payload);
  return readHidFrames(device, cid, cmd);
}

function writeHidFrames(device: HidDevice, cid: number, cmd: number, payload: Uint8Array): void {
  const totalLen = payload.length;
  const firstChunk = payload.slice(0, HID_INIT_PAYLOAD_SIZE);
  const firstFrame = new Uint8Array(HID_PACKET_SIZE);

  writeUInt32BE(firstFrame, 0, cid);
  firstFrame[4] = 0x80 | (cmd & 0x7f);
  firstFrame[5] = (totalLen >> 8) & 0xff;
  firstFrame[6] = totalLen & 0xff;
  firstFrame.set(firstChunk, 7);
  device.write([0x00, ...firstFrame]);

  let seq = 0;
  let offset = firstChunk.length;
  while (offset < totalLen) {
    const chunk = payload.slice(offset, offset + HID_CONT_PAYLOAD_SIZE);
    const contFrame = new Uint8Array(HID_PACKET_SIZE);
    writeUInt32BE(contFrame, 0, cid);
    contFrame[4] = seq & 0x7f;
    contFrame.set(chunk, 5);
    device.write([0x00, ...contFrame]);
    offset += chunk.length;
    seq += 1;
  }
}

function readHidFrames(device: HidDevice, cid: number, expectedCmd: number): Uint8Array {
  const deadline = Date.now() + 15000;
  let expectedLen = -1;
  let expectedSeq = 0;
  const bytes: number[] = [];

  while (Date.now() < deadline) {
    const packet = device.readTimeout(500);
    if (!packet || packet.length === 0) continue;

    const frame = normalizePacket(packet);
    if (frame.length < 5) continue;

    const frameCid = readUInt32BE(frame.slice(0, 4));
    if (frameCid !== cid && frameCid !== BROADCAST_CID) continue;

    const cmdOrSeq = frame[4] ?? 0;

    if ((cmdOrSeq & 0x80) !== 0) {
      const responseCmd = cmdOrSeq & 0x7f;
      if (responseCmd === CTAPHID.KEEPALIVE) {
        continue;
      }

      if (responseCmd === CTAPHID.ERROR) {
        const errorCode = frame[7] ?? frame[5] ?? 0xff;
        throw new Error(`CTAPHID error ${errorCode}`);
      }

      if (responseCmd !== expectedCmd) {
        continue;
      }

      expectedLen = (((frame[5] ?? 0) << 8) | (frame[6] ?? 0)) & 0xffff;
      for (const value of frame.slice(7)) bytes.push(value);
      expectedSeq = 0;
    } else {
      if (expectedLen < 0) continue;
      if (cmdOrSeq !== (expectedSeq & 0x7f)) continue;

      for (const value of frame.slice(5)) bytes.push(value);
      expectedSeq += 1;
    }

    if (expectedLen >= 0 && bytes.length >= expectedLen) {
      return Uint8Array.from(bytes.slice(0, expectedLen));
    }
  }

  throw new Error("CTAPHID timeout");
}

function buildMakeCredentialPayload(keyName: string, rpId: string): Uint8Array {
  const rp = new Map<string, unknown>([
    ["id", rpId],
    ["name", rpId],
  ]);

  const user = new Map<string, unknown>([
    ["id", crypto.randomBytes(16)],
    ["name", keyName],
    ["displayName", keyName],
  ]);

  const pubKeyCredParams = [
    new Map<string, unknown>([
      ["type", "public-key"],
      ["alg", -8],
    ]),
  ];

  const options = new Map<string, unknown>([
    ["rk", true],
    ["uv", true],
  ]);

  const request = new Map<number, unknown>([
    [1, crypto.randomBytes(32)],
    [2, rp],
    [3, user],
    [4, pubKeyCredParams],
    [7, options],
  ]);

  return toUint8Array(encode(request));
}

function normalizePacket(packet: number[]): Uint8Array {
  if (packet.length === HID_PACKET_SIZE + 1) {
    return new Uint8Array(packet.slice(1));
  }

  if (packet.length >= HID_PACKET_SIZE) {
    return new Uint8Array(packet.slice(0, HID_PACKET_SIZE));
  }

  const out = new Uint8Array(HID_PACKET_SIZE);
  out.set(packet, 0);
  return out;
}

function writeUInt32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUInt32BE(bytes: Uint8Array): number {
  return (
    ((bytes[0] ?? 0) << 24)
    | ((bytes[1] ?? 0) << 16)
    | ((bytes[2] ?? 0) << 8)
    | (bytes[3] ?? 0)
  ) >>> 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return new Uint8Array(0);
}

function safeClose(device: HidDevice): void {
  try {
    device.close();
  } catch {
    // Ignore close failures.
  }
}

function formatStatus(code: number): string {
  const label = CTAP_STATUS_LABELS[code];
  const hex = `0x${code.toString(16).padStart(2, "0")}`;
  return label ? `${label} (${hex})` : hex;
}
