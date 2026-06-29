import * as e from "effect";
import type { BadPreconditionsError } from "@/modules";

export interface RefreshTokenStore {
  load: () => e.Effect.Effect<e.Option.Option<string>>;
  save: (refreshToken: string) => e.Effect.Effect<void, BadPreconditionsError>; 
}

export interface IOAuth2 {
  getAccessToken: (clientSecret: string, clientId: string, refreshStorage: RefreshTokenStore) => e.Effect.Effect<string>;
}
