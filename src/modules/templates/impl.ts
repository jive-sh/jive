import * as e from "effect";
import * as modules from "@/modules";

export const TemplatesImpl = e.Layer.effect(modules.ITemplates, e.Effect.gen(function*() {
  return {
    availableTemplates: e.Effect.gen(function*() {
      return [] as string[];
    }),
  };
}));
