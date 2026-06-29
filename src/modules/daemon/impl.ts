import * as e from "effect";
import { modules } from "@/modules";
import { Implementing, type GenEffect } from "@/temp-libs/effective-modules";
import type { IDaemon } from "./interface";

export class DaemonImpl extends Implementing(modules.daemon) implements IDaemon {
  *start(): GenEffect<void> {
    
  }
  
}
