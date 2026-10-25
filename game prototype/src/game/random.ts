// Match-scoped PRNG. All AI choice noise and sampled set-piece targets use this stream.
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  nextUint(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  next(): number { return this.nextUint() / 0x100000000; }
  range(min: number, max: number): number { return min + (max - min) * this.next(); }
  int(min: number, maxInclusive: number): number { return min + Math.floor(this.next() * (maxInclusive - min + 1)); }
  pick<T>(items: readonly T[]): T { return items[this.int(0, items.length - 1)]; }

  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    let cursor = this.next() * Math.max(total, Number.EPSILON);
    for (const item of items) {
      cursor -= Math.max(0, item.weight);
      if (cursor <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }
}

export function createMatchSeed(): number {
  const words = new Uint32Array(1);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(words);
  else words[0] = Math.floor(Math.random() * 0xffffffff);
  return words[0] >>> 0;
}

// Stable per-player/per-run hash used only to break utility ties.
export function tieBreakHash(seed: number, playerId: number, runSerial: number, key: string): number {
  let h = (seed ^ Math.imul(playerId + 1, 0x9e3779b1) ^ Math.imul(runSerial + 1, 0x85ebca6b)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}