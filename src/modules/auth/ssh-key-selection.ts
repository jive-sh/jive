import * as e from "effect";
import { Prompt } from "effect/cli";
import type { EffectGen } from "effective-modules";
import { Module, modules } from "@/modules";
import { type SshKey } from "@/modules/ssh/interface";
import type { ConnectedYubiKey } from "../yubikey/interface";

/** What choosing an SSH key needs: the SSH and YubiKey modules, and the terminal its prompts run in. */
export type SshKeySelectionServices = Module.ssh | Module.yubikey | Prompt.Environment;

type SshKeyStorageSelection = "Yubikey" | "Local";

const sshKeyStorageSelectionOptions: Record<SshKeyStorageSelection, string> = {
  Yubikey: "yubikey (ideal for human users)",
  Local: "local ssh key (ideal for agents without a secure hardware enclave)"
};

export class CreateSshKeyOnYubikeyError extends e.Data.TaggedError("CreateSshKeyOnYubikeyError")<{
  reason: string;
}> {}

/**
 * Asks the person to pick one of `options` (key → label) and returns the key; with a single option, picks it
 * without asking and logs `onlyOneItemMessage` for it when given. Quitting the prompt stops the command.
 */
function* selectOne<K extends string>(
  prompt: string,
  options: Record<K, string>,
  onlyOneItemMessage?: (key: K) => string,
): EffectGen<K, never, Prompt.Environment> {
  const entries = Object.entries(options) as Array<[K, string]>;
  const [firstEntry] = entries;
  if (firstEntry === undefined) {
    return yield* e.Effect.die(`GOT EMPTY OPTIONS FOR PROMPT "${prompt}"`);
  }
  if (entries.length === 1) {
    if (onlyOneItemMessage) {
      yield* e.Effect.log(onlyOneItemMessage(firstEntry[0]));
    }
    return firstEntry[0];
  }
  return yield* e.Effect.orDie(Prompt.Select({
    message: prompt,
    choices: entries.map(([value, title]) => ({ title, value })),
  }));
}

export function* selectSshKey(email: string, tempPath: string): EffectGen<SshKey, CreateSshKeyOnYubikeyError, SshKeySelectionServices> {
  const selection = yield* selectOne(
    "For git pushes / commit signing, choose a SSH key storage location:",
    sshKeyStorageSelectionOptions,
  );
  return selection === "Local" ?
    yield* selectLocalSshKey(email, tempPath) :
    yield* selectYubikeySshKey(email, tempPath);
}

function* selectLocalSshKey(email: string, tempPath: string): EffectGen<SshKey, never, Module.ssh | Prompt.Environment> {
  const ssh = yield* modules.ssh;
  const { pathsScanned, keys } = yield* ssh.listLocalSshKeys();
  const CREATE_NEW_KEY = "CREATE_OWN";
  const keysAsMap: Record<string, SshKey> = {};
  const keysDisplay: Record<string, string> = {};
  for (const key of keys) {
    keysAsMap[key.fingerprint] = key;
    keysDisplay[key.fingerprint] = `${key.name} (filename=${key.location}, email=${key.email})`;
  }
  const sshKeyFingerprint = yield* selectOne(
    `chose key from ${pathsScanned.join(", ")}:`,
    {
      ...keysDisplay,
      [CREATE_NEW_KEY]: "generate/use new local ssh key"
    },
    () => "No local ssh keys. Creating new one."
  );
  return sshKeyFingerprint === CREATE_NEW_KEY ?
    yield* ssh.createSshKey(email, tempPath) :
    keysAsMap[sshKeyFingerprint]!;
}

function* selectYubikeySshKey(email: string, tempPath: string): EffectGen<SshKey, CreateSshKeyOnYubikeyError, SshKeySelectionServices> {
  const createOrRestore = yield* selectOne(
    "Create new ssh key on yubikey or use existing one?",
    {
      newKey: "create new key",
      existing: "use existing key"
    }
  );
  return createOrRestore === "newKey" ?
    yield* createNewKeyOnYubikey(email, tempPath) :
    yield* selectExistingKeyOnYubikey(email, tempPath);
}

function* selectExistingKeyOnYubikey(email: string, tempPath: string): EffectGen<SshKey, CreateSshKeyOnYubikeyError, SshKeySelectionServices> {
  const ssh = yield* modules.ssh;
  const yubikey = yield* modules.yubikey;
  const residentSshKeys = yield* ssh.restoreResidentSshKeys(tempPath);
  if (residentSshKeys.length === 0) {
    const connectedYubikeys = yield* yubikey.listConnectedDevices();
    if (connectedYubikeys.length === 0) {
      yield* e.Effect.logError(`No keys to restore as there are no connected yubikeys.`);
      return yield* e.Effect.die("no connected yubikeys");
    }
    yield* e.Effect.log(`No resident keys were found (connected yubikeys: ${connectedYubikeys.map(yk => yk.serial).join(", ")})`);
    const choice = yield* selectOne(
      "No resident keys found. What would you like to do?",
      {
        createNewKey: "create a new one",
        exit: "exit"
      }
    );
    if (choice === "exit") {
      return yield* e.Effect.die("no resident ssh key chosen");
    }
    return yield* createNewKeyOnYubikey(email, tempPath);
  }
  const fingerprintMap: Record<string, SshKey> = {};
  const displayMap: Record<string, string> = {};
  for (const sshKey of residentSshKeys) {
    fingerprintMap[sshKey.fingerprint] = sshKey;
    displayMap[sshKey.fingerprint] = `${sshKey.name} (email=${sshKey.email})`;
  }
  const fingerPrint = yield* selectOne(
    "Choose an existing yubikey ssh key: ",
    displayMap,
    fingerprint => `Using ${displayMap[fingerprint]!}`
  );
  return fingerprintMap[fingerPrint]!;
}

function* createNewKeyOnYubikey(email: string, tempPath: string): EffectGen<SshKey, CreateSshKeyOnYubikeyError, SshKeySelectionServices> {
  const yubikey = yield* modules.yubikey;
  const connectedYubikeys = yield* yubikey.listConnectedDevices();
  if (connectedYubikeys.length === 0) {
    return yield* new CreateSshKeyOnYubikeyError({ reason: "no yubikeys detected" });
  }
  const yubikeysAsMap: Record<string, ConnectedYubiKey> = {};
  const yubikeysDisplay: Record<string, string> = {};
  for (const connectedYubikey of connectedYubikeys) {
    yubikeysAsMap[connectedYubikey.serial] = connectedYubikey;
    yubikeysDisplay[connectedYubikey.serial] = e.Option.getOrElse(
      connectedYubikey.name,
      () => `YubiKey ${connectedYubikey.serial}`,
    );
  }
  const choice = yield* selectOne(
    "which yubikey do you want to create the ssh key on?",
    yubikeysDisplay,
    connectedYubikey => `Using connected yubikey ${yubikeysAsMap[connectedYubikey]!.serial}`
  );
  const ssh = yield* modules.ssh;
  return yield* ssh.createSshKey(email, tempPath, yubikeysAsMap[choice]!);
}
