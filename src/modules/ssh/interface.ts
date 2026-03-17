import * as e from "effect";
import type { SshJiveKey, SshKeySource } from "./types";

export interface SshService {
  readonly ensureResidentSshSupport: e.Effect.Effect<boolean>;
  readonly resolveStoredSshKey: (
    workspaceRoot: string,
    relativePrivateKeyPath: string,
    source: SshKeySource,
    yubiKeySerial: string,
  ) => e.Effect.Effect<e.Option.Option<SshJiveKey>>;
  readonly selectOrCreateLocalSshKey: (
    workspaceRoot: string,
    email: string,
  ) => e.Effect.Effect<e.Option.Option<SshJiveKey>>;
  readonly selectOrCreateYubiKeySshKey: (
    workspaceRoot: string,
    serial: string,
    email: string,
  ) => e.Effect.Effect<e.Option.Option<SshJiveKey>>;
}

export class ISsh extends e.Context.Tag("ISsh")<ISsh, SshService>() {}
