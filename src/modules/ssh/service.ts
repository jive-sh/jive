import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "node:path";
import { TOOL_NAME } from "@/constants";
import { promptText, selectOne } from "@/prompts";
import {
  DEFAULT_YUBIKEY_SSH_KEY_NAME,
  JIVE_SSH_APPLICATION,
  LOCAL_SSH_KEYS_DIR,
  sanitizeKeyName,
  sshKeyId,
} from "./constants";
import { parsePublicKey } from "./key-format";
import type { SshJiveKey } from "./types";
import { type CommandNotFoundError, type HostPlatform, type RunOptions, type VerifiedCommand } from "../host-shell/interface";

export const SSH_KEYGEN_COMMAND = "ssh-keygen" as const;
const MACOS_SYSTEM_SSH_KEYGEN_PATH = "/usr/bin/ssh-keygen" as const;

export interface SshFileSystem {
  readonly exists: (targetPath: string) => e.Effect.Effect<boolean, ep.Error.PlatformError>;
  readonly makeDirectory: (targetPath: string) => e.Effect.Effect<void, ep.Error.PlatformError>;
  readonly readDirectory: (targetPath: string) => e.Effect.Effect<string[], ep.Error.PlatformError>;
  readonly readFileString: (targetPath: string) => e.Effect.Effect<string, ep.Error.PlatformError>;
  readonly copyFile: (fromPath: string, toPath: string) => e.Effect.Effect<void, ep.Error.PlatformError>;
  readonly remove: (targetPath: string) => e.Effect.Effect<void, ep.Error.PlatformError>;
}

export interface SshHostShell {
  readonly platform: HostPlatform;
  readonly getCommand: (command: string) => e.Effect.Effect<VerifiedCommand, CommandNotFoundError>;
  readonly run: (
    opts: RunOptions,
  ) => (verifiedCommand: VerifiedCommand) => e.Effect.Effect<{ exitCode: number; stderr: string; stdout: string }, ep.Error.PlatformError>;
  readonly runInheritIO: (
    opts: RunOptions,
  ) => (verifiedCommand: VerifiedCommand) => e.Effect.Effect<{ exitCode: number }, ep.Error.PlatformError>;
}

export const ensureResidentSshSupport = (
  hostShell: SshHostShell,
) =>
  e.Effect.gen(function*() {
    const sshKeygen = yield* hostShell.getCommand(SSH_KEYGEN_COMMAND).pipe(
      e.Effect.map((command) => e.Option.some(command)),
      e.Effect.catchTag("CommandNotFoundError", () => e.Effect.succeed(e.Option.none<VerifiedCommand>())),
    );
    if (e.Option.isNone(sshKeygen)) {
      yield* e.Effect.logError("Could not find `ssh-keygen` on PATH.");
      return false;
    }

    const unsupportedMacOsSshKeygen = e.Match.value(hostShell.platform).pipe(
      e.Match.tag("MacOs", () => sshKeygen.value.path === MACOS_SYSTEM_SSH_KEYGEN_PATH),
      e.Match.orElse(() => false),
    );

    if (unsupportedMacOsSshKeygen) {
      yield* e.Effect.logError("macOS system `ssh-keygen` is not sufficient for Jive YubiKey resident keys.");
      yield* e.Effect.logError("Run `brew install openssh` and ensure Homebrew's `ssh-keygen` comes before `/usr/bin` on PATH.");
      return false;
    }

    return true;
  });

export const selectOrCreateLocalSshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  email: string,
) =>
  e.Effect.gen(function*() {
    const existingKeys = yield* listWorkspaceLocalSshKeys(fileSystem, hostShell, workspaceRoot);
    const options = [
      ...existingKeys.map((key) => ({ _tag: "Existing" as const, key })),
      { _tag: "Create" as const },
    ];

    const selection = yield* selectOne(
      "Select the local SSH key Jive should use:",
      options,
      (option) => option._tag === "Existing" ? option.key.relativePrivateKeyPath : "create-local",
      (option, index) => option._tag === "Existing"
        ? `${index + 1}. ${option.key.name} (${option.key.fingerprint})`
        : `${index + 1}. Create a new local SSH key`,
    );
    if (e.Option.isNone(selection)) return e.Option.none<SshJiveKey>();

    if (selection.value._tag === "Existing") return e.Option.some(selection.value.key);

    const desiredName = yield* promptText("Enter a name for the new local SSH key: ");
    if (!desiredName) {
      yield* e.Effect.logError("An SSH key name is required.");
      return e.Option.none<SshJiveKey>();
    }

    return yield* createLocalSshKey(fileSystem, hostShell, workspaceRoot, desiredName, email);
  });

export const selectOrCreateYubiKeySshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  serial: string,
  email: string,
) =>
  e.Effect.acquireUseRelease(
    e.Effect.gen(function*() {
      const tempDirectory = temporaryRecoveredKeyDirectory(workspaceRoot, serial);
      yield* fileSystem.makeDirectory(tempDirectory);
      return tempDirectory;
    }),
    (tempDirectory) =>
      e.Effect.gen(function*() {
        const recoveredKeys = yield* recoverResidentYubiKeySshKeys(
          fileSystem,
          hostShell,
          workspaceRoot,
          tempDirectory,
          serial,
        );
        if (e.Option.isNone(recoveredKeys)) return e.Option.none<SshJiveKey>();

        const options = [
          ...recoveredKeys.value.map((key) => ({ _tag: "Existing" as const, key })),
          { _tag: "Create" as const },
        ];

        const selection = yield* selectOne(
          "Select the YubiKey SSH key Jive should use:",
          options,
          (option) => option._tag === "Existing" ? option.key.fingerprint : "create-yubikey",
          (option, index) => option._tag === "Existing"
            ? `${index + 1}. ${option.key.name} (${option.key.fingerprint})`
            : `${index + 1}. Create a new resident SSH key on the selected YubiKey`,
        );
        if (e.Option.isNone(selection)) return e.Option.none<SshJiveKey>();

        if (selection.value._tag === "Existing") {
          return yield* persistRecoveredYubiKeySshKey(
            fileSystem,
            hostShell,
            workspaceRoot,
            email,
            selection.value.key,
          );
        }

        return yield* createResidentYubiKeySshKey(
          fileSystem,
          hostShell,
          workspaceRoot,
          serial,
          DEFAULT_YUBIKEY_SSH_KEY_NAME,
          email,
        );
      }),
    (tempDirectory) => fileSystem.remove(tempDirectory).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    ),
  );

export const resolveStoredSshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  relativePrivateKeyPath: string,
  source: "local" | "yubikey",
  yubiKeySerial: string,
) =>
  inspectKeyPath(
    fileSystem,
    hostShell,
    workspaceRoot,
    path.join(workspaceRoot, relativePrivateKeyPath),
    source,
    yubiKeySerial,
  );

const listWorkspaceLocalSshKeys = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
) =>
  listWorkspaceSshKeysInDirectory(
    fileSystem,
    hostShell,
    workspaceRoot,
    path.join(workspaceRoot, LOCAL_SSH_KEYS_DIR),
    "local",
    "",
  );

const createLocalSshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  name: string,
  email: string,
) =>
  e.Effect.gen(function*() {
    const localDirectory = path.join(workspaceRoot, LOCAL_SSH_KEYS_DIR);
    yield* fileSystem.makeDirectory(localDirectory);

    const privateKeyPath = yield* nextAvailablePrivateKeyPath(fileSystem, localDirectory, name);
    const created = yield* runSshKeygenInheritIO(
      hostShell,
      ["-q", "-t", "ed25519", "-N", "", "-C", keyComment(email, name), "-f", privateKeyPath],
    );
    if (e.Option.isNone(created) || created.value.exitCode !== 0) {
      yield* e.Effect.logWarning(`Could not create a local SSH key at ${privateKeyPath}.`);
      return e.Option.none<SshJiveKey>();
    }

    return yield* inspectKeyPath(fileSystem, hostShell, workspaceRoot, privateKeyPath, "local", "");
  });

const createResidentYubiKeySshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  serial: string,
  name: string,
  email: string,
) =>
  e.Effect.acquireUseRelease(
    e.Effect.gen(function*() {
      const tempDirectory = temporaryRecoveredKeyDirectory(workspaceRoot, `${serial}-create`);
      yield* fileSystem.makeDirectory(tempDirectory);
      return tempDirectory;
    }),
    (tempDirectory) =>
      e.Effect.gen(function*() {
        const temporaryPrivateKeyPath = yield* nextAvailablePrivateKeyPath(fileSystem, tempDirectory, name);
        const created = yield* runSshKeygenInheritIO(hostShell, [
          "-q",
          "-t",
          "ed25519-sk",
          "-N",
          "",
          "-O",
          "resident",
          "-O",
          "verify-required",
          "-O",
          `application=${JIVE_SSH_APPLICATION}`,
          "-C",
          keyComment(email, name),
          "-f",
          temporaryPrivateKeyPath,
        ]);
        if (e.Option.isNone(created) || created.value.exitCode !== 0) {
          yield* e.Effect.logWarning(`Could not create a resident YubiKey SSH key at ${temporaryPrivateKeyPath}.`);
          return e.Option.none<SshJiveKey>();
        }

        const generatedKey = yield* inspectKeyPath(
          fileSystem,
          hostShell,
          workspaceRoot,
          temporaryPrivateKeyPath,
          "yubikey",
          serial,
        );
        if (e.Option.isNone(generatedKey)) return e.Option.none<SshJiveKey>();

        return yield* persistRecoveredYubiKeySshKey(
          fileSystem,
          hostShell,
          workspaceRoot,
          email,
          generatedKey.value,
        );
      }),
    (tempDirectory) => fileSystem.remove(tempDirectory).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    ),
  );

const recoverResidentYubiKeySshKeys = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  tempDirectory: string,
  serial: string,
) =>
  e.Effect.gen(function*() {
    yield* e.Effect.log("Recovering resident SSH keys from the selected YubiKey...");
    yield* e.Effect.log(
      "When prompted, enter the YubiKey FIDO PIN once, press Enter once, then touch the YubiKey to authorize resident-key download.",
    );

    const recovered = yield* runSshKeygenInheritIO(hostShell, ["-K", "-N", ""], tempDirectory);
    if (e.Option.isNone(recovered) || recovered.value.exitCode !== 0) {
      yield* e.Effect.logError("Could not recover resident SSH keys from the selected YubiKey.");
      yield* e.Effect.logError(
        "Retry the YubiKey flow and, after pressing Enter on the PIN prompt, touch the selected YubiKey once to authorize key download.",
      );
      return e.Option.none<SshJiveKey[]>();
    }

    const recoveredKeys = yield* listWorkspaceSshKeysInDirectory(
      fileSystem,
      hostShell,
      workspaceRoot,
      tempDirectory,
      "yubikey",
      serial,
    );

    if (recoveredKeys.length === 0) {
      yield* e.Effect.log("No resident SSH keys were recovered from the selected YubiKey.");
    }

    return e.Option.some(recoveredKeys);
  });

const persistRecoveredYubiKeySshKey = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  email: string,
  recoveredKey: SshJiveKey,
) =>
  e.Effect.gen(function*() {
    const destination = persistentYubiKeyHandlePath(workspaceRoot, email, recoveredKey.fingerprint);
    yield* fileSystem.makeDirectory(path.dirname(destination));
    yield* fileSystem.remove(destination);
    yield* fileSystem.remove(`${destination}.pub`);
    yield* fileSystem.copyFile(recoveredKey.privateKeyPath, destination);
    yield* fileSystem.copyFile(recoveredKey.publicKeyPath, `${destination}.pub`);

    return yield* inspectKeyPath(
      fileSystem,
      hostShell,
      workspaceRoot,
      destination,
      "yubikey",
      recoveredKey.yubiKeySerial,
    );
  });

const listWorkspaceSshKeysInDirectory = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  directory: string,
  source: "local" | "yubikey",
  yubiKeySerial: string,
) =>
  e.Effect.gen(function*() {
    const exists = yield* fileSystem.exists(directory);
    if (!exists) return [] as SshJiveKey[];

    const entries = yield* fileSystem.readDirectory(directory);
    const keys: SshJiveKey[] = [];

    for (const entry of entries) {
      if (!entry || entry.endsWith(".pub")) continue;

      const inspected = yield* inspectKeyPath(
        fileSystem,
        hostShell,
        workspaceRoot,
        path.join(directory, entry),
        source,
        yubiKeySerial,
      );
      if (e.Option.isSome(inspected)) keys.push(inspected.value);
    }

    return keys.sort((left, right) => left.name.localeCompare(right.name));
  });

const inspectKeyPath = (
  fileSystem: SshFileSystem,
  hostShell: SshHostShell,
  workspaceRoot: string,
  privateKeyPath: string,
  source: "local" | "yubikey",
  yubiKeySerial: string,
) =>
  e.Effect.gen(function*() {
    const publicKeyPath = `${privateKeyPath}.pub`;
    const privateExists = yield* fileSystem.exists(privateKeyPath);
    const publicExists = yield* fileSystem.exists(publicKeyPath);
    if (!privateExists || !publicExists) return e.Option.none<SshJiveKey>();

    const publicKey = (yield* fileSystem.readFileString(publicKeyPath)).trim();
    if (!publicKey) return e.Option.none<SshJiveKey>();

    const parsedPublicKey = parsePublicKey(publicKey);
    if (e.Option.isNone(parsedPublicKey)) return e.Option.none<SshJiveKey>();

    const fingerprint = yield* readFingerprint(hostShell, publicKeyPath);
    if (e.Option.isNone(fingerprint)) return e.Option.none<SshJiveKey>();

    return e.Option.some({
      source,
      fingerprint: fingerprint.value,
      name: deriveKeyName(parsedPublicKey.value.comment, path.basename(privateKeyPath)),
      privateKeyPath,
      publicKeyPath,
      publicKey,
      relativePrivateKeyPath: path.relative(workspaceRoot, privateKeyPath),
      yubiKeySerial,
    });
  });

const readFingerprint = (
  hostShell: SshHostShell,
  publicKeyPath: string,
) =>
  e.Effect.gen(function*() {
    const listed = yield* runSshKeygen(hostShell, ["-lf", publicKeyPath, "-E", "sha256"]);
    if (e.Option.isNone(listed) || listed.value.exitCode !== 0) return e.Option.none<string>();

    const fields = listed.value.stdout.trim().split(/\s+/);
    const fingerprint = fields[1] ?? "";
    return fingerprint ? e.Option.some(fingerprint) : e.Option.none<string>();
  });

const nextAvailablePrivateKeyPath = (
  fileSystem: SshFileSystem,
  directory: string,
  desiredName: string,
) =>
  e.Effect.gen(function*() {
    const baseName = sanitizeFileName(desiredName);

    for (let index = 0; index < 1000; index++) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = path.join(directory, `${baseName}${suffix}`);
      const exists = yield* fileSystem.exists(candidate);
      const publicExists = yield* fileSystem.exists(`${candidate}.pub`);
      if (!exists && !publicExists) return candidate;
    }

    return path.join(directory, `${baseName}-${Date.now()}`);
  });

function keyComment(email: string, name: string): string {
  return `${TOOL_NAME}:${email}:${sanitizeKeyName(name)}`;
}

function deriveKeyName(comment: string, fallbackName: string): string {
  const prefix = `${TOOL_NAME}:`;
  if (comment.startsWith(prefix)) {
    const parts = comment.split(":");
    if (parts.length >= 3) {
      return sanitizeKeyName(parts.slice(2).join(":"));
    }
  }

  return sanitizeKeyName(fallbackName);
}

function sanitizeFileName(name: string): string {
  const normalized = sanitizeKeyName(name).toLowerCase();
  return normalized.replace(/[^a-z0-9._-]+/g, "-") || "key";
}

function temporaryRecoveredKeyDirectory(workspaceRoot: string, serial: string): string {
  return path.join(
    workspaceRoot,
    `.${TOOL_NAME}`,
    "tmp",
    `yubikey-recovery-${sanitizeFileName(serial)}-${Date.now()}`,
  );
}

function persistentYubiKeyHandlePath(workspaceRoot: string, email: string, keyIdentifier: string): string {
  return path.join(
    workspaceRoot,
    `.${TOOL_NAME}`,
    "users",
    `${sanitizeCurrentUserStem(email)}_yubikey_handle_${sshKeyId(keyIdentifier)}`,
  );
}

function sanitizeCurrentUserStem(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    || "current_user";
}

function runSshKeygen(
  hostShell: SshHostShell,
  args: readonly string[],
  runInDir?: string,
): e.Effect.Effect<e.Option.Option<{ exitCode: number; stderr: string; stdout: string }>> {
  return e.pipe(
    SSH_KEYGEN_COMMAND,
    hostShell.getCommand,
    e.Effect.flatMap(hostShell.run({
      args,
      env: {},
      runInDir,
    })),
    e.Effect.map(e.Option.some),
    e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
  );
}

function runSshKeygenInheritIO(
  hostShell: SshHostShell,
  args: readonly string[],
  runInDir?: string,
): e.Effect.Effect<e.Option.Option<{ exitCode: number }>> {
  return e.pipe(
    SSH_KEYGEN_COMMAND,
    hostShell.getCommand,
    e.Effect.flatMap(hostShell.runInheritIO({
      args,
      env: {},
      runInDir,
    })),
    e.Effect.map(e.Option.some),
    e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
  );
}
