/** Fact text for search (design rev 4 §6.3). */

export const valueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value))

export interface TextParts {
  readonly subjectName: string
  readonly predicate: string
  readonly objectName?: string | undefined
  readonly hasValue: boolean
  readonly value?: unknown
  readonly quotes: ReadonlyArray<string>
}

export const factText = (p: TextParts): string => {
  const object = p.objectName ?? (p.hasValue ? valueText(p.value) : "")
  return [`${p.subjectName} ${p.predicate} ${object}`.trim(), ...p.quotes.filter((q) => q.length > 0)].join("\n")
}

export const textHash = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32)
