import * as e from "effect";
import type { SshKey } from "./ssh-key";
import type { ConnectedYubiKey } from "@/modules/yubikey/interface";
export { SshKey, MalformedKeyError, MalformedKeyReason } from "./ssh-key";

export interface ISsh {
  readonly restoreResidentSshKeys: (inDirectory: string) => e.Effect.Effect<SshKey[]>;
  readonly listLocalSshKeys: () => e.Effect.Effect<{pathsScanned: string[], keys: SshKey[]}>;
  readonly createSshKey: (email: string, inDirectory: string, onYubikey?: ConnectedYubiKey) => e.Effect.Effect<SshKey>;
}
