import type { EffectGen } from "effective-modules";

export interface ITemplates {
  availableTemplates(): EffectGen<string[]>;
}
