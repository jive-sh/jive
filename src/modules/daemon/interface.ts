import type { GenEffect } from "@/temp-libs/effective-modules";
import * as e from "effect";

export interface IDaemon {
  start(): GenEffect<void>;
}
