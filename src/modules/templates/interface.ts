import * as e from "effect";

export interface ITemplates {
  readonly availableTemplates: e.Effect.Effect<string[]>;
}
