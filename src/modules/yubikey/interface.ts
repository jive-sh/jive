import type * as e from "effect";
import type { EffectGen } from "effective-modules";

export interface ConnectedYubiKey {
  readonly serial: string;
  readonly name: e.Option.Option<string>;
}

export interface IYubiKey {
  listConnectedDevices(): EffectGen<ConnectedYubiKey[]>;
  ensurePinConfigured(serial: string): EffectGen<boolean>;
  setDeviceName(serial: string, name: string): EffectGen<void>;
}
