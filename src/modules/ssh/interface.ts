import type { EffectGen } from "effective-modules";
import type { SshKey } from "./ssh-key";
import type { ConnectedYubiKey } from "@/modules/yubikey/interface";
export { SshKey, MalformedKeyError, MalformedKeyReason } from "./ssh-key";

export interface ISsh {
  restoreResidentSshKeys(inDirectory: string): EffectGen<SshKey[]>;
  listLocalSshKeys(): EffectGen<{ pathsScanned: string[]; keys: SshKey[] }>;
  createSshKey(email: string, inDirectory: string, onYubikey?: ConnectedYubiKey): EffectGen<SshKey>;
}
