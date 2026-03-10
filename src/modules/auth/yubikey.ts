import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import { FIDO_APPLICATION, GITHUB_KEY_PREFIX } from "./constants";
import type { AuthHostShell } from "./host-shell";
import {
  isCtapCreateAttemptEnabled,
  isCtapPrototypeEnabled,
  runCtapGetInfoPrototype,
  runCtapMakeCredentialPrototype,
} from "./ctap-hid";
import { parsePublicKey } from "./key-format";
import { runOpenSshCommand } from "./openssh";
import type { ConnectedYubiKeyDevice, YubiKeyJiveKey } from "./types";
import type { HostShellCommand } from "../host-shell/interface";

interface ExtractedResidentKey {
  privatePath: string;
  publicPath: string;
  publicKey: string;
  keyBody: string;
  comment: string;
}

const YUBICO_VENDOR_ID = 0x1050;
const FIDO_USAGE_PAGE = 0xf1d0;

export const listConnectedYubiKeys = (): e.Effect.Effect<e.Option.Option<ConnectedYubiKeyDevice[]>> =>
  e.Effect.promise(() => import("node-hid")).pipe(
    e.Effect.map((hid) => {
      const allDevices = hid.devices();

      const yubicoDevices = allDevices.filter((device) => device.vendorId === YUBICO_VENDOR_ID);
      const fidoDevices = yubicoDevices.filter((device) => device.usagePage === FIDO_USAGE_PAGE);
      const candidates = fidoDevices.length > 0
        ? fidoDevices
        : yubicoDevices.filter((device) => /yubikey/i.test(device.product ?? ""));

      const normalized = candidates.map((device, index) => toConnectedDevice(device, index));
      return e.Option.some(dedupeById(normalized));
    }),
    e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
  );

export const listResidentJiveKeys = (
  hostShell: AuthHostShell,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey[]>> =>
  e.Effect.gen(function*() {
    yield* maybeRunCtapGetInfoPrototype("resident key list");

    const extracted = yield* extractResidentKeysToTemp(hostShell);
    if (e.Option.isNone(extracted)) return e.Option.none();

    try {
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

      return e.Option.some(dedupeByPublicKey(jiveKeys));
    } finally {
      cleanupTempDir(extracted.value.tmpDir);
    }
  });

export const createResidentJiveKey = (
  hostShell: AuthHostShell,
  name: string,
): e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>> =>
  e.Effect.gen(function*() {
    yield* maybeRunCtapCreatePrototype(name);

    const tmpDir = yield* e.Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL_NAME}-resident-create-`)));
    const keyPath = path.join(tmpDir, TOOL_NAME);
    const pubKeyPath = `${keyPath}.pub`;

    try {
      const createKeyCommand: HostShellCommand & { readonly command: "ssh-keygen" } = {
        command: "ssh-keygen",
        args: [
          "-t", "ed25519-sk",
          "-O", "resident",
          "-O", "verify-required",
          "-O", `application=${FIDO_APPLICATION}`,
          "-C", name,
          "-f", keyPath,
          "-N", "",
        ],
        cwd: e.Option.none(),
        env: {},
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: e.Option.none(),
      };

      const result = yield* runOpenSshCommand(hostShell, createKeyCommand);

      if (e.Option.isNone(result) || result.value.exitCode !== 0 || !fs.existsSync(pubKeyPath)) {
        yield* e.Effect.logWarning(`Could not create resident YubiKey key ${name}.`);
        yield* e.Effect.logWarning(
          "If ssh-keygen reported `No FIDO SecurityKeyProvider specified`, your OpenSSH installation does not have the FIDO provider support required for ed25519-sk key enrollment.",
        );
        return e.Option.none();
      }

      const pubKey = yield* e.Effect.sync(() => fs.readFileSync(pubKeyPath, "utf8").trim());
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
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

export const loadResidentJiveKeyIntoAgent = (
  hostShell: AuthHostShell,
  target: YubiKeyJiveKey,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* maybeRunCtapGetInfoPrototype(`agent load for ${target.name}`);

    const extracted = yield* extractResidentKeysToTemp(hostShell);
    if (e.Option.isNone(extracted)) return;

    try {
      const matching = extracted.value.keys.find((key) =>
        key.keyBody === target.keyBody && key.comment === target.name
      );

      if (!matching) {
        yield* e.Effect.logWarning(`Could not find ${target.name} on YubiKey while loading ssh-agent.`);
        return;
      }

      const addKeyCommand: HostShellCommand & { readonly command: "ssh-add" } = {
        command: "ssh-add",
        args: [matching.privatePath],
        cwd: e.Option.none(),
        env: {},
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: e.Option.none(),
      };

      const addResult = yield* runOpenSshCommand(hostShell, addKeyCommand);
      if (e.Option.isNone(addResult) || addResult.value.exitCode !== 0) {
        yield* e.Effect.logWarning("Could not load resident YubiKey key into ssh-agent.");
      }
    } finally {
      cleanupTempDir(extracted.value.tmpDir);
    }
  });

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

const extractResidentKeysToTemp = (
  hostShell: AuthHostShell,
): e.Effect.Effect<e.Option.Option<{ tmpDir: string; keys: ExtractedResidentKey[] }>> =>
  e.Effect.gen(function*() {
    const tmpDir = yield* e.Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL_NAME}-resident-list-`)));
    const prefix = path.join(tmpDir, TOOL_NAME);

    const listKeysCommand: HostShellCommand & { readonly command: "ssh-keygen" } = {
      command: "ssh-keygen",
      args: ["-K", "-f", prefix],
      cwd: e.Option.none(),
      env: {},
      stdin: "inherit",
      stdout: "ignore",
      stderr: "ignore",
      shell: e.Option.none(),
    };

    const result = yield* runOpenSshCommand(hostShell, listKeysCommand);
    if (e.Option.isNone(result)) {
      cleanupTempDir(tmpDir);
      return e.Option.none();
    }

    const pubPaths = yield* e.Effect.sync(() =>
      fs.readdirSync(tmpDir)
        .filter((entry) => entry.endsWith(".pub"))
        .map((entry) => path.join(tmpDir, entry))
    );

    if (pubPaths.length === 0) {
      if (result.value.exitCode !== 0) {
        yield* e.Effect.logWarning("No resident FIDO2 keys found via ssh-keygen -K.");
      }
      return e.Option.some({ tmpDir, keys: [] });
    }

    const keys: ExtractedResidentKey[] = [];
    for (const pubPath of pubPaths) {
      const privatePath = pubPath.slice(0, -4);
      if (!fs.existsSync(privatePath)) continue;

      const publicKey = yield* e.Effect.sync(() => fs.readFileSync(pubPath, "utf8").trim());
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
  });

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
  const label = device.product?.trim() || "YubiKey";
  const id = serial || device.path || `${device.vendorId}:${device.productId}:${index + 1}`;

  return { id, label };
}

const maybeRunCtapGetInfoPrototype = (context: string): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    if (!isCtapPrototypeEnabled()) return;

    const result = yield* e.Effect.promise(() => runCtapGetInfoPrototype());
    if (e.Option.isNone(result)) {
      yield* e.Effect.logWarning(`CTAP/HID prototype (${context}) could not open an authenticator session.`);
      return;
    }

    yield* e.Effect.logWarning(`CTAP/HID prototype (${context}): ${result.value}; continuing with OpenSSH fallback.`);
  });

const maybeRunCtapCreatePrototype = (name: string): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    if (!isCtapPrototypeEnabled()) return;
    if (!isCtapCreateAttemptEnabled()) {
      yield* e.Effect.logWarning(
        "CTAP/HID create prototype is disabled. Set JIVE_EXPERIMENTAL_CTAP_CREATE=1 to attempt direct makeCredential.",
      );
      return;
    }

    const result = yield* e.Effect.promise(() => runCtapMakeCredentialPrototype(name, FIDO_APPLICATION));
    if (e.Option.isNone(result)) {
      yield* e.Effect.logWarning("CTAP/HID makeCredential prototype could not open an authenticator session.");
      return;
    }

    yield* e.Effect.logWarning(`CTAP/HID makeCredential prototype: ${result.value}; continuing with OpenSSH fallback.`);
  });
