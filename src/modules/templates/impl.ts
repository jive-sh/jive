import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { ITemplates } from "./interface";

export class TemplatesImpl extends implementing(modules.templates) implements ITemplates {
  *availableTemplates(): EffectGen<string[]> {
    return [];
  }
}
