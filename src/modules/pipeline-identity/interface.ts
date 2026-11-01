import type { EffectGen } from "effective-modules";

/** Who this process is when it runs in a CI/CD job: the ID token the job's provider mints for an audience. */
export interface IPipelineIdentity {
  /** Fails, saying what the job lacks, when this process is not in a job that may request one. */
  idToken(audience: string): EffectGen<string, string>;
}
