export type Ok<T> =
  { success: true; value: T };

export type Err<E> =
  { success: false; error: E; reason: string; }

export type Result<T, E> = Ok<T> | Err<E>;

export function Ok<T>({ value } : { value: T }): Ok<T> {
  return { success: true, value };
}

export function Err<E>({ error, reason } : { error: E; reason: string }): Err<E> {
  return { success: false, error, reason };
}
