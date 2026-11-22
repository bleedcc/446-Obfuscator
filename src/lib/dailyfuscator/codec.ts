export function checksum(nums: readonly number[]): number {
  let h = 2166136261;
  for (const b of nums) {
    h = (h * 131 + (b >>> 0)) % 4294967296;
  }
  return h;
}

export function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return out;
}

export function keyBytes(key: string): number[] {
  return utf8Bytes(key);
}

export function checksumString(s: string): number {
  return checksum(keyBytes(s));
}

export function canonicalNumber(n: number): string | null {
  if (Object.is(n, -0)) return "-0";
  if (!Number.isFinite(n)) return null;
  if (Number.isSafeInteger(n)) return String(n);
  const exp = n.toExponential(16);
  if (Number(exp) === n) return exp;
  const prec = n.toPrecision(17);
  if (Number(prec) === n) return prec;
  return null;
}

export function encodeBytes(
  plain: readonly number[],
  buildKey: readonly number[],
  userKey: readonly number[],
  salt: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < plain.length; i++) {
    const kb = userKey.length ? userKey[i % userKey.length] : 0;
    const bb = buildKey[i % buildKey.length];
    out.push((plain[i] + kb + bb + salt + (i + 1) * 13) % 256);
  }
  return out;
}

export interface Blob {
  n: number;
  expect: number;
  salt: number;
  keyed: number;
  bytes: number[];
}

export function makeBlob(
  plain: readonly number[],
  buildKey: readonly number[],
  userKey: string,
  salt: number,
): Blob {
  const user = userKey ? keyBytes(userKey) : [];
  return {
    n: plain.length,
    expect: checksum(plain),
    salt: salt % 251,
    keyed: userKey ? 1 : 0,
    bytes: encodeBytes(plain, buildKey, user, salt % 251),
  };
}

export function blobNumbers(b: Blob): number[] {
  return [b.n, b.expect, b.salt, b.keyed, ...b.bytes];
}
