import * as e from "effect";
import { IOAuth2 } from "./interface";

export const OAuth2Impl = e.Layer.effect(IOAuth2, e.Effect.gen(function*() {

}))
