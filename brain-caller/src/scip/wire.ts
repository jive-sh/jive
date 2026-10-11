/** Minimal protobuf wire-format reader: just what decoding SCIP needs. */
const utf8 = new TextDecoder()

export class Reader {
  pos = 0
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}

  get done() {
    return this.pos >= this.end
  }

  varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.buf[this.pos++]!
      if (shift < 28) result |= (b & 0x7f) << shift
      else result += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) return result >>> 0 === result ? result : result
      shift += 7
    }
  }

  /** Tag as [field number, wire type]. */
  tag(): [number, number] {
    const t = this.varint()
    return [t >>> 3, t & 7]
  }

  bytes(): Uint8Array {
    const len = this.varint()
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  string(): string {
    return utf8.decode(this.bytes())
  }

  /** A nested message as a sub-reader. */
  message(): Reader {
    const len = this.varint()
    const sub = new Reader(this.buf, this.pos + len)
    sub.pos = this.pos
    this.pos += len
    return sub
  }

  /** Packed (or single unpacked) repeated int32. */
  int32s(wireType: number): number[] {
    if (wireType === 0) return [this.varint() | 0]
    const sub = this.message()
    const out: number[] = []
    while (!sub.done) out.push(sub.varint() | 0)
    return out
  }

  skip(wireType: number) {
    if (wireType === 0) this.varint()
    else if (wireType === 1) this.pos += 8
    else if (wireType === 2) this.pos += this.varint()
    else if (wireType === 5) this.pos += 4
    else throw new Error(`unsupported protobuf wire type ${wireType}`)
  }
}
