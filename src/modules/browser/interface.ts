import type { EffectGen } from "effective-modules";

export interface IBrowser {
  /** Opens `url` in the person's default browser. Fails with what the platform's opener reported. */
  open(url: string): EffectGen<void, string>;
}
