export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x1a2b3c4d;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return this.next() % maxExclusive;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  shuffle<T>(items: T[]): T[] {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

export function hashSeed(input: string | number | undefined): number {
  if (input === undefined) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] || 1;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return 1;
    return (input >>> 0) || 1;
  }
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

const KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
  "continue",
]);

export function freshIdent(rng: Rng, used: Set<string>): string {
  const alphabets = [
    "aeorstnlcm",
    "bcdfghjklmnpqrstvwxyz",
    "abcdefghijkmnopqrstuvwxyz",
  ];
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const alphabet = alphabets[rng.int(alphabets.length)];
    const len = 3 + rng.int(6);
    let name = alphabet[rng.int(alphabet.length)];
    for (let i = 1; i < len; i++) {
      const digit = rng.int(8) === 0;
      if (digit) name += String(rng.int(10));
      else name += alphabet[rng.int(alphabet.length)];
    }
    if (rng.int(5) === 0) name = "_" + name;
    if (KEYWORDS.has(name) || used.has(name)) continue;
    used.add(name);
    return name;
  }
  throw new Error("exhausted identifier space");
}
