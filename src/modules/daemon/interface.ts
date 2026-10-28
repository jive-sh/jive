import type { EffectGen } from "effective-modules";

export interface IDaemon {
  start(): EffectGen<void>;
}
