import * as e from "effect";
import type { ConnectedYubiKeyDevice, YubiKeyJiveKey } from "@/modules/auth/types";

export class IYubiKey extends e.Context.Tag("IYubiKey")<IYubiKey, {
  readonly requiredCLICommands: readonly string[];
  readonly listConnectedDevices: e.Effect.Effect<e.Option.Option<ConnectedYubiKeyDevice[]>>;
  readonly listResidentJiveKeys: e.Effect.Effect<e.Option.Option<YubiKeyJiveKey[]>>;
  readonly createResidentJiveKey: (name: string) => e.Effect.Effect<e.Option.Option<YubiKeyJiveKey>>;
  readonly loadResidentJiveKeyIntoAgent: (target: YubiKeyJiveKey) => e.Effect.Effect<void>;
}>() {}
