import { RateEngine } from "./rate"

/** Builds a quote using the RateEngine. */
export function quote(miles: number): string {
  const engine = new RateEngine(2.5)
  return `$${engine.price(miles)}`
}
