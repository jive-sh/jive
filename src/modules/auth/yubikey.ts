import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as e from "effect";
import { TOOL_NAME } from "../../constants";
import { FIDO_APPLICATION, GITHUB_KEY_PREFIX } from "./constants";
import {
  isCtapCreateAttemptEnabled,
  isCtapPrototypeEnabled,
  runCtapGetInfoPrototype,
  runCtapMakeCredentialPrototype,
} from "./ctap-hid";
import { parsePublicKey } from "./key-format";
import { runOpenSshCommand } from "./openssh";
import type { ConnectedYubiKeyDevice, YubiKeyJiveKey } from "./types";

interface ExtractedResidentKey {
  privatePath: string;
  publicPath: string;
  publicKey: string;
  keyBody: string;
  comment: string;
}

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const YUBICO_VENDOR_ID = 0x1050;
const FIDO_USAGE_PAGE = 0xf1d0;
const logWarningSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logWarning(...message));
};

export async function listConnectedYubiKeys(): Promise<e.Option.Option<ConnectedYubiKeyDevice[]>> {
  try {
    const hid = await import("node-hid");
    const allDevices = hid.devices();

    const yubicoDevices = allDevices.filter((device) => device.vendorId === YUBICO_VENDOR_ID);
    const fidoDevices = yubicoDevices.filter((device) => device.usagePage === FIDO_USAGE_PAGE);
    const candidates = fidoDevices.length > 0
      ? fidoDevices
      : yubicoDevices.filter((device) => /yubikey/i.test(device.product ?? ""));

    const normalized = candidates.map((device, index) => toConnectedDevice(device, index));
    return e.Option.some(dedupeById(normalized));
  } catch {
    return e.Option.none();
  }
}

export async function listResidentJiveKeys(): Promise<e.Option.Option<YubiKeyJiveKey[]>> {
  await maybeRunCtapGetInfoPrototype("resident key list");

  const extracted = await extractResidentKeysToTemp();
  if (e.Option.isNone(extracted)) return e.Option.none();

  const jiveKeys = extracted.value.keys
    .filter((key) => key.comment.startsWith(GITHUB_KEY_PREFIX))
    .map((key) => {
      const email = key.comment.slice(GITHUB_KEY_PREFIX.length);
      return {
        name: key.comment,
        email,
        publicKey: key.publicKey,
        keyBody: key.keyBody,
      } satisfies YubiKeyJiveKey;
    });

  cleanupTempDir(extracted.value.tmpDir);
  return e.Option.some(dedupeByPublicKey(jiveKeys));
}

export async function createResidentJiveKey(name: string): Promise<e.Option.Option<YubiKeyJiveKey>> {
  await maybeRunCtapCreatePrototype(name);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL_NAME}-resident-create-`));
  const keyPath = path.join(tmpDir, TOOL_NAME);
  const pubKeyPath = `${keyPath}.pub`;

  const result = runOpenSshCommand(
    "ssh-keygen",
    [
      "-t", "ed25519-sk",
      "-O", "resident",
      "-O", "verify-required",
      "-O", `application=${FIDO_APPLICATION}`,
      "-C", name,
      "-f", keyPath,
      "-N", "",
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );

  if (e.Option.isNone(result) || result.value.exitCode !== 0 || !fs.existsSync(pubKeyPath)) {
    cleanupTempDir(tmpDir);
    logWarningSync(yellow(`WARNING: could not create resident YubiKey key ${name}`));
    return e.Option.none();
  }

  const pubKey = fs.readFileSync(pubKeyPath, "utf8").trim();
  cleanupTempDir(tmpDir);

  const parsed = parsePublicKey(pubKey);
  if (e.Option.isNone(parsed)) return e.Option.none();

  const comment = parsed.value.comment;
  if (!comment.startsWith(GITHUB_KEY_PREFIX)) return e.Option.none();

  return e.Option.some({
    name: comment,
    email: comment.slice(GITHUB_KEY_PREFIX.length),
    publicKey: pubKey,
    keyBody: parsed.value.keyBody,
  });
}

export async function loadResidentJiveKeyIntoAgent(target: YubiKeyJiveKey): Promise<void> {
  await maybeRunCtapGetInfoPrototype(`agent load for ${target.name}`);

  const extracted = await extractResidentKeysToTemp();
  if (e.Option.isNone(extracted)) return;

  const matching = extracted.value.keys.find((key) =>
    key.keyBody === target.keyBody && key.comment === target.name,
  );

  if (!matching) {
    cleanupTempDir(extracted.value.tmpDir);
    logWarningSync(yellow(`WARNING: could not find ${target.name} on YubiKey while loading ssh-agent`));
    return;
  }

  const addResult = runOpenSshCommand(
    "ssh-add",
    [matching.privatePath],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );

  cleanupTempDir(extracted.value.tmpDir);

  if (e.Option.isNone(addResult) || addResult.value.exitCode !== 0) {
    logWarningSync(yellow("WARNING: could not load resident YubiKey key into ssh-agent."));
  }
}

function dedupeByPublicKey(keys: YubiKeyJiveKey[]): YubiKeyJiveKey[] {
  const byBody = new Map<string, YubiKeyJiveKey>();
  for (const key of keys) {
    byBody.set(key.keyBody, key);
  }
  return Array.from(byBody.values());
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
}

async function extractResidentKeysToTemp(): Promise<e.Option.Option<{ tmpDir: string; keys: ExtractedResidentKey[] }>> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL_NAME}-resident-list-`));
  const prefix = path.join(tmpDir, TOOL_NAME);

  const result = runOpenSshCommand(
    "ssh-keygen",
    ["-K", "-f", prefix],
    { stdout: "ignore", stderr: "ignore", stdin: "inherit" },
  );
  if (e.Option.isNone(result)) {
    cleanupTempDir(tmpDir);
    return e.Option.none();
  }

  const pubPaths = fs.readdirSync(tmpDir)
    .filter((entry) => entry.endsWith(".pub"))
    .map((entry) => path.join(tmpDir, entry));

  if (pubPaths.length === 0) {
    if (result.value.exitCode !== 0) {
      logWarningSync(yellow("WARNING: no resident FIDO2 keys found via ssh-keygen -K."));
    }
    return e.Option.some({ tmpDir, keys: [] });
  }

  const keys: ExtractedResidentKey[] = [];
  for (const pubPath of pubPaths) {
    const privatePath = pubPath.slice(0, -4);
    if (!fs.existsSync(privatePath)) continue;

    const publicKey = fs.readFileSync(pubPath, "utf8").trim();
    const parsed = parsePublicKey(publicKey);
    if (e.Option.isNone(parsed)) continue;

    keys.push({
      privatePath,
      publicPath: pubPath,
      publicKey,
      keyBody: parsed.value.keyBody,
      comment: parsed.value.comment,
    });
  }

  return e.Option.some({ tmpDir, keys });
}

function cleanupTempDir(tmpDir: string): void {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function toConnectedDevice(
  device: {
    vendorId: number;
    productId: number;
    serialNumber?: string;
    product?: string;
    path?: string;
  },
  index: number,
): ConnectedYubiKeyDevice {
  const serial = device.serialNumber?.trim() ?? "";
  const baseLabel = device.product?.trim() || "YubiKey";
  const id = serial || device.path || `${device.vendorId}:${device.productId}:${index + 1}`;
  const label = serial ? `${baseLabel} ${serial}` : baseLabel;

  return { id, label };
}

async function maybeRunCtapGetInfoPrototype(context: string): Promise<void> {
  if (!isCtapPrototypeEnabled()) return;

  const result = await runCtapGetInfoPrototype();
  if (e.Option.isNone(result)) {
    logWarningSync(yellow(`WARNING: CTAP/HID prototype (${context}) could not open an authenticator session.`));
    return;
  }

  logWarningSync(yellow(`WARNING: CTAP/HID prototype (${context}): ${result.value}; continuing with OpenSSH fallback.`));
}

async function maybeRunCtapCreatePrototype(name: string): Promise<void> {
  if (!isCtapPrototypeEnabled()) return;
  if (!isCtapCreateAttemptEnabled()) {
    logWarningSync(yellow("WARNING: CTAP/HID create prototype is disabled. Set JIVE_EXPERIMENTAL_CTAP_CREATE=1 to attempt direct makeCredential."));
    return;
  }

  const result = await runCtapMakeCredentialPrototype(name, FIDO_APPLICATION);
  if (e.Option.isNone(result)) {
    logWarningSync(yellow("WARNING: CTAP/HID makeCredential prototype could not open an authenticator session."));
    return;
  }

  logWarningSync(yellow(`WARNING: CTAP/HID makeCredential prototype: ${result.value}; continuing with OpenSSH fallback.`));
}
