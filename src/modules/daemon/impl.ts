import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { IDaemon } from "./interface";

export class DaemonImpl extends implementing(modules.daemon) implements IDaemon {
  *start(): EffectGen<void> {}
}
