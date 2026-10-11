/** Time-ordered IDs: `<prefix>_<uuidv7>`. */
export const newId = (prefix: string) => `${prefix}_${Bun.randomUUIDv7()}`
