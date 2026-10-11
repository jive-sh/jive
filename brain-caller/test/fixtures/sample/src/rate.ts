/** Computes a freight rate. */
export interface Pricer {
  price(miles: number): number
}

/** Prices loads per mile. */
export class RateEngine implements Pricer {
  constructor(private readonly perMile: number) {}

  /** Price for a trip of `miles`. */
  price(miles: number): number {
    return round(miles * this.perMile)
  }
}

export const round = (n: number) => Math.round(n * 100) / 100
