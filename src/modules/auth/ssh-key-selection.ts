import * as e from "effect";
import * as modules from "@/modules";
import { type SshKey } from "@/modules/ssh/interface";
import { selectOne } from "@/prompts";
import type { ConnectedYubiKey } from "../yubikey/interface";

enum YubikeyVsLocal {
  yubikey = "yubikey",
  local = "local"
}

export class CreateSshKeyOnYubikeyError extends e.Data.TaggedError("CreateSshKeyOnYubikeyError")<{
  reason: string;
}> {}

export const selectSshKey: (email: string, tempPath: string) => e.Effect.Effect<SshKey, CreateSshKeyOnYubikeyError, modules.ISsh | modules.IYubiKey> = 
  e.Effect.fn(function*(email, tempPath) {
    const CHOICE_YUBIKEY_SSH = "yubikey (ideal for human users)";
    const CHOICE_LOCAL_SSH = "local ssh key (ideal for agents without a secure hardware enclave)";
    const localVsYubikey = yield* selectOne(
      "For git pushes / commit signing, choose a SSH key storage location:",
      {
        [YubikeyVsLocal.yubikey]: CHOICE_YUBIKEY_SSH, 
        [YubikeyVsLocal.local]: CHOICE_LOCAL_SSH
      }
    );
    // TODO: tagged enum for selection
    switch(localVsYubikey) {
      case YubikeyVsLocal.local:
        return yield* selectLocalSshKey(email, tempPath);
      case YubikeyVsLocal.yubikey:
        return yield* selectYubikeySshKey(email, tempPath);
      default:
        return yield* e.Effect.dieMessage(`IMPOSSIBLE CHOICE ${localVsYubikey}`);
    }
  });

const selectLocalSshKey: (email: string, tempPath: string) => e.Effect.Effect<SshKey, never, modules.ISsh> =
  e.Effect.fn(function*(email, tempPath) {
    const ssh = yield* modules.ISsh;
    const {pathsScanned, keys} = yield* ssh.listLocalSshKeys();
    const CREATE_NEW_KEY = "CREATE_OWN";
    const CREATE_MY_OWN_KEY_MSG = "generate/use new local ssh key";
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
        [CREATE_NEW_KEY]: CREATE_MY_OWN_KEY_MSG
      },
      () => "No local ssh keys. Creating new one."
    );
    const choice = 
      sshKeyFingerprint === CREATE_NEW_KEY ?
        yield* ssh.createSshKey(email, tempPath) :
        keysAsMap[sshKeyFingerprint]!;
    return choice;
  });

const selectYubikeySshKey: (email: string, tempPath: string) => e.Effect.Effect<SshKey, CreateSshKeyOnYubikeyError, modules.IYubiKey | modules.ISsh> =
  e.Effect.fn(function*(email, tempPath) {
    const createOrRestore = yield* selectOne(
      "Create new ssh key on yubikey or use existing one?",
      {
        newKey: "create new key",
        existing: "use existing key"
      }
    );
    switch(createOrRestore) {
      case "newKey":
        return yield* createNewKeyOnYubikey(email, tempPath);
      case "existing":
        return yield* selectExistingKeyOnYubikey(email, tempPath);
      default:
        return yield* e.Effect.dieMessage("IMPOSSIBLE NOT EITHER NEW OR EXISTING KEY");
    }
  });

const selectExistingKeyOnYubikey: (email: string, tempPath: string) => e.Effect.Effect<SshKey, CreateSshKeyOnYubikeyError, modules.IYubiKey | modules.ISsh> =
  e.Effect.fn(function*(email, tempPath) {
    const ssh = yield* modules.ISsh;
    const yubikey = yield* modules.IYubiKey;
    // Restore
    const residentSshKeys = yield* ssh.restoreResidentSshKeys(tempPath);
    if (residentSshKeys.length === 0) {
      const connectedYubikeys = yield* yubikey.listConnectedDevices;
      if (connectedYubikeys.length === 0) {
        yield* e.Effect.logError(`No keys to restore as there are no connected yubikeys.`);
        return yield* e.Effect.die(undefined);
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
        return yield* e.Effect.die(undefined);
      }
      return yield* createNewKeyOnYubikey(email, tempPath);
    }
    // Choose
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
  });

const createNewKeyOnYubikey: (email: string, tempPath: string) => e.Effect.Effect<SshKey, CreateSshKeyOnYubikeyError, modules.IYubiKey | modules.ISsh> =
  e.Effect.fn(function*(email, tempPath) {
    // Choose yubikey
    const yubikey = yield* modules.IYubiKey;
    const connectedYubikeys = yield* yubikey.listConnectedDevices;
    if (connectedYubikeys.length === 0) {
      return yield* new CreateSshKeyOnYubikeyError({reason: "no yubikeys detected"});
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
    const chosenYubikey = yubikeysAsMap[choice]!;
    // Create resident key
    const ssh = yield* modules.ISsh;
    const sshKey = yield* ssh.createSshKey(email, tempPath, chosenYubikey);
    return sshKey;
  });
