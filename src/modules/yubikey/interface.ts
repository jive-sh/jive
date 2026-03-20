import * as e from "effect";

export interface ConnectedYubiKey {
  readonly serial: string;
  readonly name: e.Option.Option<string>;
}

export class IYubiKey extends e.Context.Tag("IYubiKey")<IYubiKey, {
  readonly listConnectedDevices: e.Effect.Effect<ConnectedYubiKey[]>;
  readonly ensurePinConfigured: (serial: string) => e.Effect.Effect<boolean>;
  readonly setDeviceName: (serial: string, name: string) => e.Effect.Effect<void>;
}>() {}
