import * as e from "effect";

export class ITemplates extends e.Context.Tag("ITemplates")<ITemplates, {
  readonly availableTemplates: e.Effect.Effect<string[]>;
}>() {}
