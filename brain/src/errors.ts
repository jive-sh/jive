import { Data } from "effect"

/** Error codes from design rev 4 §5.2. */
export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "NOT_OWNER"
  | "BASIS_NOT_ALLOWED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL"

export const httpStatus: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  NOT_OWNER: 403,
  BASIS_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
}

export class BrainError extends Data.TaggedError("BrainError")<{
  readonly code: ErrorCode
  readonly message: string
  readonly details?: unknown
}> {}

export const fail = (code: ErrorCode, message: string, details?: unknown) =>
  new BrainError(details === undefined ? { code, message } : { code, message, details })

export const invalid = (message: string, details?: unknown) => fail("INVALID_INPUT", message, details)
