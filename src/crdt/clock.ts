/**
 * Simple Lamport logical clock.
 *
 * - `tick()` advances the local counter for a new event.
 * - `observe()` incorporates a remote timestamp and returns the updated counter.
 */
export class LogicalClock {
  private counter: number;

  constructor(initialValue: number = Date.now()) {
    this.counter = initialValue;
  }

  tick(): number {
    this.counter += 1;
    return this.counter;
  }

  observe(externalTs: number): number {
    this.counter = Math.max(this.counter, externalTs) + 1;
    return this.counter;
  }

  now(): number {
    return this.counter;
  }
}
