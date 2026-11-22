import { utf8Bytes } from "./codec.ts";
import { encodePayload } from "./payload.ts";
import type { PoolEntry } from "./protect.ts";
import { OP, type Proto } from "./vm.ts";
import { freshIdent, type Rng } from "./rng.ts";

export interface RuntimeNames {
  ds: string;
  dn: string;
  vm: string;
}

export interface BuiltRuntime {
  source: string;
  checksumValue: number;
  stringBlobs: number;
  numberBlobs: number;
  fused: number;
}

type Variant = 0 | 1 | 2;

interface Params {
  variant: Variant;
  mul: number;
  inv: number;
  add: number;
  xorc: number;
  salt: number;
  basis: number;
  prime: number;
  step: number;
  smix: number;
  m1: number;
  m2: number;
  lane: number;
  nonce: number;
}

const PRIMES = [131, 137, 149, 157, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317];
const INSN_WIDTH = 13;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function inv256(mul: number): number {
  let a = mul;
  let b = 256;
  let x0 = 1;
  let x1 = 0;
  while (b !== 0) {
    const q = Math.floor(a / b);
    const nb = a - q * b;
    a = b;
    b = nb;
    const nx = x0 - q * x1;
    x0 = x1;
    x1 = nx;
  }
  return mod(x0, 256);
}

function mixsum(bytes: readonly number[], prime: number, basis: number): number {
  let h = basis >>> 0;
  for (const b of bytes) {
    h = Math.imul(h, prime) >>> 0;
    h = (h + (b & 255)) >>> 0;
  }
  return h >>> 0;
}

function u16le(n: number): number[] {
  return [n & 255, (n >> 8) & 255];
}

function u32le(n: number): number[] {
  const v = n >>> 0;
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

function kbyte(i: number, user: readonly number[], bk: readonly number[]): number {
  const i0 = i - 1;
  const ub = user.length ? user[i0 % user.length] : 0;
  const bb = bk[i0 % bk.length];
  return (ub + bb) % 256;
}

function mix32(x: number, m1: number, m2: number): number {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), m1) >>> 0;
  x = Math.imul(x ^ (x >>> 15), m2) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function blobSalt(index: number, salt: number, smix: number, m1: number, m2: number): number {
  const mixed = ((salt + 1) ^ Math.imul(index, smix)) >>> 0;
  return mix32(mixed, m1, m2) % 251;
}

function encByte(p: Params, plain: number, i: number, kb: number, salt: number): number {
  const iadd = (i * p.add) % 256;
  if (p.variant === 0) {
    const mixed = mod(plain + kb + salt + iadd, 256);
    const y = (mixed * p.mul) % 256;
    return (y ^ p.xorc ^ ((i * p.step) % 256)) & 255;
  }
  if (p.variant === 1) {
    const x = (plain ^ kb ^ iadd) & 255;
    const y = mod(x + salt, 256);
    const z = (y * p.mul) % 256;
    return (z ^ p.xorc) & 255;
  }
  const x = mod(plain + iadd, 256);
  const y = (x ^ kb ^ salt) & 255;
  const z = (y * p.mul) % 256;
  return (z ^ p.xorc ^ ((i * p.step) % 256)) & 255;
}

function decByte(p: Params, enc: number, i: number, kb: number, salt: number): number {
  const iadd = (i * p.add) % 256;
  if (p.variant === 0) {
    const y = (enc ^ p.xorc ^ ((i * p.step) % 256)) & 255;
    const mixed = (y * p.inv) % 256;
    return mod(mixed - kb - salt - iadd, 256);
  }
  if (p.variant === 1) {
    const z = (enc ^ p.xorc) & 255;
    const y = (z * p.inv) % 256;
    const x = mod(y - salt, 256);
    return (x ^ kb ^ iadd) & 255;
  }
  const z = (enc ^ p.xorc ^ ((i * p.step) % 256)) & 255;
  const y = (z * p.inv) % 256;
  const x = (y ^ kb ^ salt) & 255;
  return mod(x - iadd, 256);
}

function rotl32(x: number, n: number): number {
  x >>>= 0;
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function quarter(s: number[], a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl32((s[d] ^ s[a]) >>> 0, 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl32((s[b] ^ s[c]) >>> 0, 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl32((s[d] ^ s[a]) >>> 0, 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl32((s[b] ^ s[c]) >>> 0, 7);
}

function foldUser(user: readonly number[], m1: number, m2: number): number {
  let u = 0;
  for (const b of user) u = mix32((u ^ (b & 255)) >>> 0, m1, m2);
  return u >>> 0;
}

function keyedWords(p: Params, user: readonly number[]): number[] {
  const u = foldUser(user, p.m1, p.m2);
  return [p.basis, p.prime, p.m1, p.m2, p.lane, p.smix, p.nonce].map((w, i) => (w ^ Math.imul(u, i + 1)) >>> 0);
}

function streamBytes(words: readonly number[], index: number, domain: number, nbytes: number): number[] {
  const w0 = (words[0] ^ domain) >>> 0;
  const w1 = words[1] >>> 0;
  const w2 = words[2] >>> 0;
  const w3 = words[3] >>> 0;
  const w4 = words[4] >>> 0;
  const w5 = words[5] >>> 0;
  const w6 = words[6] >>> 0;
  const out: number[] = [];
  let block = 0;
  while (out.length < nbytes) {
    const ctr = (index + block) >>> 0;
    const s = [w0, w1, w2, w3, (w4 ^ ctr) >>> 0, (w5 ^ Math.imul(ctr, 0x9e3779b9)) >>> 0, w6, (ctr + 1) >>> 0];
    const x = s.slice();
    for (let r = 0; r < 4; r++) {
      quarter(x, 0, 1, 2, 3);
      quarter(x, 4, 5, 6, 7);
      quarter(x, 0, 1, 4, 5);
      quarter(x, 2, 3, 6, 7);
    }
    for (let i = 0; i < 8; i++) {
      const v = (x[i] + s[i]) >>> 0;
      out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    }
    block += 1;
  }
  return out.slice(0, nbytes);
}

const SEAL_DOM = 0x9e3779b1;
const VEIL_DOM = 0x85ebca77;

function applyStream(bytes: readonly number[], words: readonly number[], index: number, domain: number): number[] {
  const ks = streamBytes(words, index, domain, bytes.length);
  return bytes.map((b, i) => (b ^ ks[i]) & 255);
}

function seal(payload: readonly number[], user: readonly number[], index: number, p: Params): number[] {
  const sum = mixsum(payload, p.prime, p.basis);
  const plain = [...u32le(sum), ...payload];
  const ks = streamBytes(keyedWords(p, user), index, SEAL_DOM, plain.length);
  let acc = 0;
  return plain.map((byte, i) => {
    const mix = (acc + ((i + 1) & 255)) & 255;
    const c = (byte ^ ks[i] ^ mix) & 255;
    acc = (acc + (byte & 255) + c) & 255;
    return c;
  });
}

function unseal(blob: readonly number[], user: readonly number[], index: number, p: Params): number[] {
  const ks = streamBytes(keyedWords(p, user), index, SEAL_DOM, blob.length);
  let acc = 0;
  const plain = blob.map((c, i) => {
    const mix = (acc + ((i + 1) & 255)) & 255;
    const byte = (c ^ ks[i] ^ mix) & 255;
    acc = (acc + byte + (c & 255)) & 255;
    return byte;
  });
  if (plain.length < 4) throw new Error("sealed blob is shorter than its checksum");
  const expect = (plain[0] + plain[1] * 256 + plain[2] * 65536 + plain[3] * 16777216) >>> 0;
  const payload = plain.slice(4);
  if (mixsum(payload, p.prime, p.basis) !== expect) throw new Error("blob checksum mismatch");
  return payload;
}

function veil(payload: readonly number[], user: readonly number[], index: number, p: Params): number[] {
  return applyStream(payload, keyedWords(p, user), index, VEIL_DOM);
}

function i16le(n: number): number[] {
  let v = n | 0;
  if (v < 0) v += 65536;
  return [v & 255, (v >> 8) & 255];
}

function i24le(n: number): number[] {
  let v = n | 0;
  if (v < 0) v += 16777216;
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
}

function odd32(rng: Rng): number {
  return (rng.next() | 1) >>> 0;
}

function pickParams(rng: Rng): Params {
  const mul = 1 + 2 * rng.int(128);
  const inv = inv256(mul);
  if ((mul * inv) % 256 !== 1) throw new Error("cipher inverse is not invertible");
  return {
    variant: rng.int(3) as Variant,
    mul,
    inv,
    add: 1 + rng.int(255),
    xorc: rng.int(256),
    salt: rng.int(251),
    basis: rng.next() >>> 0,
    prime: PRIMES[rng.int(PRIMES.length)],
    step: 1 + rng.int(255),
    smix: odd32(rng),
    m1: odd32(rng),
    m2: odd32(rng),
    lane: odd32(rng),
    nonce: rng.next() >>> 0,
  };
}

function assertCipher(p: Params) {
  const user = [3, 9, 17, 255, 0, 88];
  const sample = [104, 101, 108, 108, 111, 44, 32, 119, 111, 114, 108, 100];
  const veiled = veil(sample, user, 7, p);
  if (veiled.every((b, i) => b === sample[i])) throw new Error("veil did not change the payload");
  const sealed = seal(veiled, user, 7, p);
  const back = unseal(sealed, user, 7, p);
  const opened = veil(back, user, 7, p);
  if (opened.length !== sample.length || opened.some((b, i) => b !== sample[i])) throw new Error("stream cipher did not round-trip");
}

class KeyBag {
  private used = new Set<number>();
  constructor(private rng: Rng) {}
  next(): number {
    for (;;) {
      const k = 1 + this.rng.int(8191);
      if (!this.used.has(k)) {
        this.used.add(k);
        return k;
      }
    }
  }
}

function luaByteLiteral(bytes: readonly number[]): string {
  let out = '"';
  for (const b of bytes) {
    const v = b & 255;
    if (v >= 32 && v < 127 && v !== 34 && v !== 92) out += String.fromCharCode(v);
    else out += "\\" + String(v).padStart(3, "0");
  }
  out += '"';
  return out;
}

function luaDecByte(variant: Variant, names: Record<string, string>): string {
  const iadd = `(i*${names.ADD})%256`;
  if (variant === 0) {
    return `local function ${names.decByte}(e,i,kb,salt)
  local y=${names.xor8}(${names.xor8}(e,${names.XORC}),(i*${names.STEP})%256)
  local mixed=(y*${names.INV})%256
  return (mixed-kb-salt-${iadd})%256
end`;
  }
  if (variant === 1) {
    return `local function ${names.decByte}(e,i,kb,salt)
  local z=${names.xor8}(e,${names.XORC})
  local y=(z*${names.INV})%256
  local x=(y-salt)%256
  return ${names.xor8}(${names.xor8}(x,kb),${iadd})
end`;
  }
  return `local function ${names.decByte}(e,i,kb,salt)
  local z=${names.xor8}(${names.xor8}(e,${names.XORC}),(i*${names.STEP})%256)
  local y=(z*${names.INV})%256
  local x=${names.xor8}(${names.xor8}(y,kb),salt)
  return (x-${iadd})%256
end`;
}

function mask13(m: number, m1: number, m2: number, lane: number): number[] {
  const out: number[] = [];
  let x = m >>> 0;
  for (let i = 0; i < INSN_WIDTH; i++) {
    x = mix32((x ^ Math.imul(i + 1, lane)) >>> 0, m1, m2);
    out.push(x & 255);
  }
  return out;
}

function posKey(i: number, prime: number, basis: number, m1: number, m2: number): number {
  return mix32((Math.imul(i, prime) ^ basis) >>> 0, m1, m2);
}

function nextChain(chain: number, hid: number, sel: number, i: number, xorOdd: number, m1: number, m2: number): number {
  return mix32((chain ^ hid ^ Math.imul(((sel + 1) ^ i) & 0xffff, xorOdd)) >>> 0, m1, m2);
}

interface JumpRec {
  pos: number;
  chain: number;
}

function packCode(
  code: number[][],
  order: number[],
  handlerForOp: readonly number[],
  selectorForOp: readonly number[],
  chain0: number,
  addOdd: number,
  xorOdd: number,
  prime: number,
  basis: number,
  m1: number,
  m2: number,
  lane: number,
  rng: Rng,
): { plain: number[]; jumps: JumpRec[] } {
  const plain: number[] = [];
  const jumps: JumpRec[] = [];
  let chain = chain0 >>> 0;
  for (let n = 0; n < code.length; n++) {
    const ins = code[n];
    const i = n + 1;
    jumps.push({ pos: plain.length + 1, chain });
    const sel = selectorForOp[ins[0]] & 255;
    const hid = handlerForOp[ins[0]] >>> 0;
    const m = mix32((chain ^ Math.imul(i, addOdd)) >>> 0, m1, m2);
    const token = (hid ^ m) >>> 0;
    const ab = i16le(ins[1]);
    const bb = i24le(ins[2]);
    const cb = i24le(ins[3]);
    const fields = [
      token & 255,
      (token >>> 8) & 255,
      (token >>> 16) & 255,
      (token >>> 24) & 255,
      sel & 255,
      ab[0],
      ab[1],
      bb[0],
      bb[1],
      bb[2],
      cb[0],
      cb[1],
      cb[2],
    ];
    const mask = mask13(m, m1, m2, lane);
    for (let k = 0; k < INSN_WIDTH; k++) fields[k] = (fields[k] ^ mask[k]) & 255;
    for (let pos = 0; pos < INSN_WIDTH; pos++) plain.push(fields[order[pos]]);
    const padN = rng.int(3);
    for (let k = 0; k < padN; k++) plain.push(rng.int(256));
    chain = nextChain(chain, hid, sel, i, xorOdd, m1, m2);
  }
  jumps.push({ pos: plain.length + 1, chain });
  chain = chain0 >>> 0;
  for (let n = 0; n < code.length; n++) {
    const i = n + 1;
    const at = jumps[n].pos - 1;
    const raw = plain.slice(at, at + INSN_WIDTH);
    const fields = new Array<number>(INSN_WIDTH).fill(0);
    for (let pos = 0; pos < INSN_WIDTH; pos++) fields[order[pos]] = raw[pos];
    const m = mix32((chain ^ Math.imul(i, addOdd)) >>> 0, m1, m2);
    const mask = mask13(m, m1, m2, lane);
    for (let k = 0; k < INSN_WIDTH; k++) fields[k] = (fields[k] ^ mask[k]) & 255;
    let token = (fields[0] + fields[1] * 256 + fields[2] * 65536 + fields[3] * 16777216) >>> 0;
    token = (token ^ m) >>> 0;
    const sel = fields[4] & 255;
    let a = fields[5] + fields[6] * 256;
    if (a >= 32768) a -= 65536;
    let b = fields[7] + fields[8] * 256 + fields[9] * 65536;
    if (b >= 8388608) b -= 16777216;
    let c = fields[10] + fields[11] * 256 + fields[12] * 65536;
    if (c >= 8388608) c -= 16777216;
    if (
      token !== (handlerForOp[code[n][0]] >>> 0) ||
      sel !== (selectorForOp[code[n][0]] & 255) ||
      a !== code[n][1] ||
      b !== code[n][2] ||
      c !== code[n][3]
    ) {
      throw new Error("instruction packing did not round-trip");
    }
    chain = nextChain(chain, token, sel, i, xorOdd, m1, m2);
  }
  return { plain, jumps };
}

function varyCommutative(code: number[][], rng: Rng) {
  for (const ins of code) {
    if ((ins[0] === 9 || ins[0] === 11 || ins[0] === 21) && rng.int(2) === 0) {
      const tmp = ins[2];
      ins[2] = ins[3];
      ins[3] = tmp;
    }
  }
}

function fuseBranches(code: number[][]): { code: number[][]; fused: number } {
  const src = code.map((ins) => ins.slice());
  const drop = new Set<number>();
  let fused = 0;
  for (let i = 0; i < src.length - 1; i++) {
    if (drop.has(i)) continue;
    if (src[i][0] === 22 && src[i + 1][0] === 23 && src[i + 1][3] === 0) {
      src[i + 1] = [23, src[i][1], src[i + 1][2], src[i][3] === 1 ? 1 : 2];
      drop.add(i);
      fused += 1;
    }
  }
  const newIndex: number[] = [];
  let next = 1;
  for (let i = 0; i < src.length; i++) {
    if (drop.has(i)) newIndex[i] = -1;
    else newIndex[i] = next++;
  }
  const end = next;
  const mapTarget = (old: number) => {
    if (old > src.length) return end;
    if (old < 1) return old;
    let i = old - 1;
    while (i < src.length && newIndex[i] < 0) i += 1;
    if (i >= src.length) return end;
    return newIndex[i];
  };
  const out: number[][] = [];
  for (let i = 0; i < src.length; i++) {
    if (drop.has(i)) continue;
    const ins = src[i].slice();
    if (ins[0] === 23) {
      ins[2] = mapTarget(ins[2]);
      if (ins[2] < 0 || ins[2] > end) throw new Error("fused jump target is outside the program");
    }
    out.push(ins);
  }
  return { code: out, fused };
}

function splitBytes(bytes: number[], rng: Rng): number[][] {
  if (bytes.length <= 2) return [bytes.slice()];
  const parts: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    const remain = bytes.length - i;
    const take = remain <= 3 ? remain : 1 + rng.int(Math.min(3, remain));
    parts.push(bytes.slice(i, i + take));
    i += take;
  }
  return parts;
}

interface HandlerSpec {
  id: number;
  aKey: number;
  bKey: number;
  body: string;
}

interface HostPair {
  a: number;
  b: number;
  aKey: number;
  bKey: number;
}

function split32(n: number, rng: Rng): [number, number] {
  const a = rng.next() >>> 0;
  const b = (n - a) >>> 0;
  return [a, b];
}

function makeSbox(rng: Rng): { fwd: number[]; inv: number[] } {
  const fwd = rng.shuffle(Array.from({ length: 256 }, (_, i) => i));
  const inv = new Array<number>(256);
  for (let i = 0; i < 256; i++) inv[fwd[i]] = i;
  return { fwd, inv };
}

function luaEscBytes(bytes: number[]): string {
  let s = "\"";
  for (const b of bytes) s += "\\" + String(b & 255).padStart(3, "0");
  return s + "\"";
}

function stageBootstrap(program: string, params: Params, rng: Rng, ident: () => string): string {
  for (let i = 0; i < program.length; i++) {
    if (program.charCodeAt(i) > 255) throw new Error("stage program is not a byte string");
  }
  const stageIndex = 1 + rng.int(64);
  const plain = Array.from(program, (ch) => ch.charCodeAt(0) & 255);
  const sealed = seal(plain, [], stageIndex, params);
  const back = unseal(sealed, [], stageIndex, params);
  if (back.length !== plain.length || back.some((b, i) => b !== plain[i])) throw new Error("stage seal did not round-trip");
  const { fwd, inv } = makeSbox(rng);
  const boxed = sealed.map((b) => fwd[b] & 255);
  if (boxed.some((b, i) => inv[b] !== sealed[i])) throw new Error("s-box is not a permutation");
  const [bA, bB] = split32(params.basis, rng);
  const [pA, pB] = split32(params.prime, rng);
  const [m1A, m1B] = split32(params.m1, rng);
  const [m2A, m2B] = split32(params.m2, rng);
  const [lA, lB] = split32(params.lane, rng);
  const [sA, sB] = split32(params.smix, rng);
  const [nA, nB] = split32(params.nonce, rng);
  const [dA, dB] = split32(SEAL_DOM, rng);
  const [gA, gB] = split32(0x9e3779b9, rng);
  const N = ident();
  const C = ident();
  const parts = ident();
  const blob = ident();
  const byte = ident();
  const char = ident();
  const concat = ident();
  const floor = ident();
  const errfn = ident();
  const bxor = ident();
  const nib = ident();
  const umul = ident();
  const x8 = ident();
  const rot = ident();
  const qr = ident();
  const stream = ident();
  const pred = ident();
  const qv = ident();
  const basis = ident();
  const prime = ident();
  const m1 = ident();
  const m2 = ident();
  const lane = ident();
  const smix = ident();
  const nonce = ident();
  const dom = ident();
  const gold = ident();
  const invT = ident();
  const pc = ident();
  const src = ident();
  const nb = ident();
  const ks = ident();
  const bytes = ident();
  const expect = ident();
  const hh = ident();
  const tt = ident();
  const g = ident();
  const ld = ident();
  const fn = ident();
  const er = ident();
  const chunks: string[] = [];
  const CHUNK = 96;
  for (let i = 0; i < boxed.length; i += CHUNK) chunks.push(luaEscBytes(boxed.slice(i, i + CHUNK)));
  const order = rng.shuffle(chunks.map((_, i) => i));
  let stored = `local ${C}={}\n`;
  for (const index of order) stored += `${C}[${index + 1}]=${chunks[index]}\n`;
  return `local ${byte},${char},${concat},${floor},${errfn}=string.byte,string.char,table.concat,math.floor,error
local ${nib}={${Array.from({ length: 256 }, (_, i) => (i >> 4) ^ (i & 15)).join(",")}}
local function ${bxor}(a,b)
  a=a%4294967296
  b=b%4294967296
  local r,p=0,1
  for _=1,8 do
    r=r+${nib}[(a%16)*16+(b%16)+1]*p
    a=${floor}(a/16)
    b=${floor}(b/16)
    p=p*16
  end
  return r%4294967296
end
local function ${umul}(a,b)
  a=a%4294967296
  b=b%4294967296
  local a0,b0=a%65536,b%65536
  local a1,b1=${floor}((a-a0)/65536),${floor}((b-b0)/65536)
  local p=a0*b0
  p=(p+(a0*b1%65536)*65536)%4294967296
  p=(p+(a1*b0%65536)*65536)%4294967296
  return p
end
local function ${x8}(a,b)
  a=a%256
  b=b%256
  return ${nib}[(a%16)*16+(b%16)+1]+${nib}[${floor}(a/16)*16+${floor}(b/16)+1]*16
end
local function ${rot}(x,n)
  x=x%4294967296
  local d=2^(32-n)
  local m=2^n
  return ((x%d)*m+${floor}(x/d))%4294967296
end
local function ${qr}(s,a,b,c,d)
  s[a]=(s[a]+s[b])%4294967296
  s[d]=${rot}(${bxor}(s[d],s[a]),16)
  s[c]=(s[c]+s[d])%4294967296
  s[b]=${rot}(${bxor}(s[b],s[c]),12)
  s[a]=(s[a]+s[b])%4294967296
  s[d]=${rot}(${bxor}(s[d],s[a]),8)
  s[c]=(s[c]+s[d])%4294967296
  s[b]=${rot}(${bxor}(s[b],s[c]),7)
end
local ${pred}=0
local ${qv}=2
if (${qv}*${qv}+${qv})%2==0 then ${pred}=1 end
if ${pred}==0 then
  local _p=Path2D
  local _u=UDim2
  local _d=Drawing
end
local ${basis}=(${bA}+${bB}+${pred}-1)%4294967296
local ${prime}=(${pA}+${pB})%4294967296
local ${m1}=(${m1A}+${m1B})%4294967296
local ${m2}=(${m2A}+${m2B})%4294967296
local ${lane}=(${lA}+${lB})%4294967296
local ${smix}=(${sA}+${sB})%4294967296
local ${nonce}=(${nA}+${nB})%4294967296
local ${dom}=(${dA}+${dB})%4294967296
local ${gold}=(${gA}+${gB})%4294967296
local ${invT}={${inv.join(",")}}
local function ${stream}(index,nbytes)
  local w0=${bxor}(${basis},${dom})
  local w1=${prime}
  local w2=${m1}
  local w3=${m2}
  local w4=${lane}
  local w5=${smix}
  local w6=${nonce}
  local out={}
  local block=0
  while #out<nbytes do
    local ctr=(index+block)%4294967296
    local s={w0,w1,w2,w3,${bxor}(w4,ctr),${bxor}(w5,${umul}(ctr,${gold})),w6,(ctr+1)%4294967296}
    local x={s[1],s[2],s[3],s[4],s[5],s[6],s[7],s[8]}
    for _=1,4 do
      ${qr}(x,1,2,3,4)
      ${qr}(x,5,6,7,8)
      ${qr}(x,1,2,5,6)
      ${qr}(x,3,4,7,8)
    end
    for i=1,8 do
      local v=(x[i]+s[i])%4294967296
      out[#out+1]=v%256
      out[#out+1]=${floor}(v/256)%256
      out[#out+1]=${floor}(v/65536)%256
      out[#out+1]=${floor}(v/16777216)%256
    end
    block=block+1
  end
  return out
end
${stored}local ${N}=${chunks.length}
local ${pc}=1
local ${src}
while ${pc}~=0 do
  if ${pc}==1 then
    local ${parts}={}
    for i=1,${N} do ${parts}[i]=${C}[i] end
    local ${blob}=${concat}(${parts})
    local raw={}
    for i=1,#${blob} do raw[i]=${char}(${invT}[${byte}(${blob},i)+1]) end
    ${blob}=${concat}(raw)
    local ${nb}=#${blob}
    local ${ks}=${stream}(${stageIndex},${nb})
    local ${bytes}={}
    local acc=0
    for i=1,${nb} do
      local c=${byte}(${blob},i)
      local mix=(acc+(i%256))%256
      ${bytes}[i]=${x8}(${x8}(c,${ks}[i]),mix)
      acc=(acc+${bytes}[i]+c)%256
    end
    local ${expect}=0
    local ${hh}=${basis}
    if ${nb}>=4 then
      ${expect}=(${bytes}[1]+${bytes}[2]*256+${bytes}[3]*65536+${bytes}[4]*16777216)%4294967296
      for i=5,${nb} do ${hh}=(${umul}(${hh},${prime})+${bytes}[i])%4294967296 end
      if ${hh}~=${expect} then ${bytes}[5]=${x8}(${bytes}[5] or 0,255) end
    end
    local ${tt}={}
    for i=5,${nb} do ${tt}[#${tt}+1]=${char}(${bytes}[i]) end
    ${src}=${concat}(${tt})
    ${pc}=2
  elseif ${pc}==2 then
    local ${ld}=loadstring or load
    if type(${ld})~="function" then ${errfn}("host",0) end
    local ${fn},${er}=${ld}(${src})
    if not ${fn} then ${errfn}(${er},0) end
    return ${fn}(...)
  else
    ${pc}=0
  end
end
${errfn}("host",0)
`;
}

function luaEscStr(s: string): string {
  let out = "\"";
  for (let i = 0; i < s.length; i++) out += "\\" + String(s.charCodeAt(i)).padStart(3, "0");
  return out + "\"";
}

function outerStep(s: number, mul: number, add: number, i: number): number {
  return (Math.imul(s, mul) + add + i) >>> 0;
}

function outerMix(h: number, prime: number, b: number): number {
  return (Math.imul(h, prime) + (b & 255)) >>> 0;
}

function sealOuter(
  bytes: number[],
  seed: number,
  mul: number,
  add: number,
  env: number,
  extra: number,
): { boxed: number[]; sum: number; sum2: number; basis: number; prime: number } {
  const prime = 131;
  const basis = (seed ^ 0x9e3779b9) >>> 0;
  let s = (seed + env + extra) >>> 0;
  if (s === 0) s = 1;
  const boxed: number[] = [];
  let h = basis >>> 0;
  let h2 = bytes.length >>> 0;
  for (let i = 1; i <= bytes.length; i++) {
    s = outerStep(s, mul, add, i);
    const k = (s + (i % 251)) & 255;
    const p = bytes[i - 1] & 255;
    const c = (p + k) & 255;
    boxed.push(c);
    s = (s + c + p) >>> 0;
    h = outerMix(h, prime, p);
    h2 = (h2 + p) >>> 0;
  }
  return { boxed, sum: h, sum2: h2, basis, prime };
}

function outerBootstrap(stage: string, rng: Rng, ident: () => string): string {
  for (let i = 0; i < stage.length; i++) {
    if (stage.charCodeAt(i) > 255) throw new Error("outer stage is not a byte string");
  }
  const mul = (1 + 2 * rng.int(32767)) & 65535;
  const add = rng.next() >>> 0;
  const seed = rng.next() >>> 0 || 1;
  const plain = Array.from(stage, (ch) => ch.charCodeAt(0) & 255);
  const CHUNK = 120;
  const chunkCount = Math.max(1, Math.ceil(plain.length / CHUNK));
  const extra = (plain.length * 13 + chunkCount) >>> 0;
  const sealed = sealOuter(plain, seed, mul, add, 0, extra);
  let s = (seed + extra) >>> 0;
  if (s === 0) s = 1;
  let h = sealed.basis >>> 0;
  let h2 = plain.length >>> 0;
  for (let i = 1; i <= sealed.boxed.length; i++) {
    s = outerStep(s, mul, add, i);
    const c = sealed.boxed[i - 1] & 255;
    const k = (s + (i % 251)) & 255;
    const p = (c - k + 256) & 255;
    if (p !== plain[i - 1]) throw new Error("outer seal did not round-trip");
    s = (s + c + p) >>> 0;
    h = outerMix(h, sealed.prime, p);
    h2 = (h2 + p) >>> 0;
  }
  if (h !== sealed.sum || h2 !== sealed.sum2) throw new Error("outer checksum did not round-trip");
  const [bA, bB] = split32(sealed.basis, rng);
  const [sA, sB] = split32(seed, rng);
  const [mA, mB] = split32(mul, rng);
  const [aA, aB] = split32(add, rng);
  const [e1A, e1B] = split32(sealed.sum, rng);
  const [e2A, e2B] = split32(sealed.sum2, rng);
  const [pA, pB] = split32(sealed.prime, rng);
  const chunks: string[] = [];
  for (let i = 0; i < sealed.boxed.length; i += CHUNK) chunks.push(luaEscBytes(sealed.boxed.slice(i, i + CHUNK)));
  const order = rng.shuffle(chunks.map((_, i) => i));
  const C = ident();
  let stored = `local ${C}={}\n`;
  for (const index of order) stored += `${C}[${index + 1}]=${chunks[index]}\n`;
  const st = ident();
  const env = ident();
  const guess = ident();
  const spins = ident();
  const pred = ident();
  const qv = ident();
  const basis = ident();
  const seedV = ident();
  const mulV = ident();
  const addV = ident();
  const e1 = ident();
  const e2 = ident();
  const primeV = ident();
  const extraV = ident();
  const g = ident();
  const byte = ident();
  const char = ident();
  const concat = ident();
  const clock = ident();
  const pok = ident();
  const blob = ident();
  const src = ident();
  const out = ident();
  const hh = ident();
  const h2v = ident();
  const slip = ident();
  const mark = ident();
  const decoy = ident();
  const flip = ident();
  const MOD = 1000003;
  const usedSt = new Set<number>();
  const takeSt = () => {
    for (;;) {
      const v = 40 + rng.int(80000);
      if (!usedSt.has(v)) {
        usedSt.add(v);
        return v;
      }
    }
  };
  const envId = takeSt();
  const bindId = takeSt();
  const catId = takeSt();
  const decoyId = takeSt();
  const decId = takeSt();
  const judgeId = takeSt();
  const loadId = takeSt();
  const ghostId = takeSt();
  const hop = (from: number, to: number) => {
    const a = 1 + 2 * rng.int(400);
    const prod = (from * a) % MOD;
    const b = (to - prod + MOD * 2) % MOD;
    if ((from * a + b) % MOD !== to) throw new Error("bootstrap edge does not land");
    return `(${st}*${a}+${b})%${MOD}`;
  };
  const hide = (n: number) => {
    const a = 40 + rng.int(400);
    return `${char}((${a + n}-${a})+(${pred}-1))`;
  };
  const piece = (word: string) => word.split("").map((ch) => `"\\${String(ch.charCodeAt(0)).padStart(3, "0")}"`);
  const sParts = piece("string");
  const cParts = piece("char");
  const ks = sParts.map(() => ident());
  const cs = cParts.map(() => ident());
  const decoyAdd = 19 + rng.int(200);
  const inner = `return function(blob,guess,pred,flip,byte,char,concat,pok,g,clock,...)
local seed=(${sA}+${sB}+pred-1)%4294967296
local mul=(${mA}+${mB})%4294967296
local addv=(${aA}+${aB})%4294967296
local basis=(${bA}+${bB})%4294967296
local e1=(${e1A}+${e1B})%4294967296
local e2=(${e2A}+${e2B})%4294967296
local prime=(${pA}+${pB})%4294967296
local extra=(#blob*13+${chunkCount}*flip)%4294967296
local spins=0
local src=""
while true do
  local s=(seed+guess+extra)%4294967296
  if s==0 then s=1 end
  local t0=0
  if clock then t0=clock() end
  local out={}
  local h=basis
  local h2=#blob%4294967296
  local slip=0
  for i=1,#blob do
    s=(s*mul+addv+i)%4294967296
    local c=byte(blob,i)
    local k=(s+(i%251))%256
    local p=(c-k)%256
    s=(s+c+p)%4294967296
    out[i]=char(p)
    h=(h*prime+p)%4294967296
    h2=(h2+p)%4294967296
  end
  if clock then local t1=clock() if t1<t0 then slip=1 end end
  local mark=0
  if h==e1 then mark=mark+1 end
  if h2==e2 then mark=mark+4 end
  if slip==0 then mark=mark+2 end
  if mark==7 then
    src=concat(out)
    for i=1,#out do out[i]=nil end
    break
  end
  spins=spins+1
  if spins>=8 then
    if #out>0 then out[1]=char((byte(out[1])+spins)%256) end
    src=concat(out)
    for i=1,#out do out[i]=nil end
    break
  end
  guess=(guess+1)%8
end
local ok,fn=pok(g,src)
src=""
if ok and fn then return fn(...) end
end
`;
  const wMul = 1 + 2 * rng.int(120);
  const wAdd = rng.int(256);
  const wSeed = 1 + rng.int(250);
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => 11 + rng.int(70));
  const uniq = new Set<number>();
  const opOf = (i: number) => {
    let v = pool[i];
    while (uniq.has(v) || v === 0) v = 11 + rng.int(80);
    uniq.add(v);
    pool[i] = v;
    return v;
  };
  const OPK = opOf(0);
  const OPADD = opOf(1);
  const OPSUB = opOf(2);
  const OPMUL = opOf(3);
  const OPMOD = opOf(4);
  const OPADDW = opOf(5);
  const OPGET = opOf(6);
  const OPPUT = opOf(7);
  const OPJMP = opOf(8);
  const OPJGT = opOf(9);
  const plainInner = Array.from(inner, (ch) => ch.charCodeAt(0) & 255);
  const wrapped: number[] = [];
  {
    let ws = wSeed;
    for (let i = 1; i <= plainInner.length; i++) {
      const im = i % 256;
      ws = (ws * wMul) % 256;
      ws = (ws + wAdd) % 256;
      ws = (ws + im) % 256;
      wrapped.push((plainInner[i - 1] + ws) & 255);
    }
  }
  const konst = [wSeed, 0, wrapped.length, wMul, wAdd, 1, 256];
  const bc: number[] = [];
  const emit = (op: number, a: number, b: number, c: number) => {
    bc.push(op, a, b, c);
  };
  const here = () => bc.length + 1;
  emit(OPK, 1, 1, 0);
  emit(OPK, 2, 2, 0);
  emit(OPK, 3, 3, 0);
  emit(OPK, 4, 4, 0);
  emit(OPK, 5, 5, 0);
  emit(OPK, 9, 6, 0);
  emit(OPK, 10, 7, 0);
  const loopAt = here();
  emit(OPADDW, 2, 2, 9);
  emit(OPJGT, 2, 3, 0);
  const jgtC = bc.length - 1;
  emit(OPMOD, 6, 2, 10);
  emit(OPMUL, 1, 1, 4);
  emit(OPADD, 1, 1, 5);
  emit(OPADD, 1, 1, 6);
  emit(OPGET, 7, 2, 0);
  emit(OPSUB, 8, 7, 1);
  emit(OPPUT, 8, 0, 0);
  emit(OPJMP, loopAt, 0, 0);
  bc[jgtC] = here();
  emit(0, 0, 0, 0);
  {
    const R = new Array(12).fill(0);
    const got: number[] = [];
    let ip = 1;
    let guard = 0;
    while (bc[ip - 1] !== 0) {
      if (++guard > plainInner.length * 20) throw new Error("unwrap program did not halt");
      const op = bc[ip - 1];
      const a = bc[ip];
      const b = bc[ip + 1];
      const c = bc[ip + 2];
      let nxt = ip + 4;
      if (op === OPK) R[a] = konst[b - 1];
      else if (op === OPADD) R[a] = (R[b] + R[c]) % 256;
      else if (op === OPSUB) R[a] = (((R[b] - R[c]) % 256) + 256) % 256;
      else if (op === OPMUL) R[a] = (R[b] * R[c]) % 256;
      else if (op === OPMOD) R[a] = R[b] % R[c];
      else if (op === OPADDW) R[a] = R[b] + R[c];
      else if (op === OPGET) R[a] = wrapped[R[b] - 1];
      else if (op === OPPUT) got.push(R[a] & 255);
      else if (op === OPJMP) nxt = a;
      else if (op === OPJGT) {
        if (R[a] > R[b]) nxt = c;
      } else throw new Error("unknown unwrap opcode");
      ip = nxt;
    }
    if (got.length !== plainInner.length || got.some((b, i) => b !== plainInner[i])) throw new Error("unwrap program did not rebuild the runner");
  }
  const mixBias = rng.int(200);
  let mixStep = 1 + rng.int(29);
  if (mixStep === 17 || mixStep === 3) mixStep = 19;
  const enc: number[] = [];
  for (let i = 0; i < bc.length; i++) {
    const v = bc[i];
    if (v > 255) throw new Error("unwrap field does not fit in a byte");
    const m = (mixBias + 1 + (i + 1) * mixStep) % 256;
    enc.push((v + m) & 255);
  }
  for (let i = 0; i < bc.length; i++) {
    const m = (mixBias + 1 + (i + 1) * mixStep) % 256;
    if (((enc[i] - m + 256) % 256) !== bc[i]) throw new Error("unwrap mix did not round-trip");
  }
  let roll = 1;
  for (const b of plainInner) roll = (roll * 33 + b) % 65521;
  const codeT = ident();
  const dataT = ident();
  const konT = ident();
  const reg = ident();
  const ipn = ident();
  const stepN = ident();
  const mt = ident();
  const entry = ident();
  const prims = ["string.byte", "string.char", "string.sub", "string.gsub", "table.concat", "math.floor", "pcall", "select", "tostring", "type"];
  const usedK = new Set<string>();
  const takeKey = () => {
    let k = "";
    do k = "0X" + (16 + rng.int(0xfffff)).toString(16);
    while (usedK.has(k));
    usedK.add(k);
    return k;
  };
  const fields = prims.map((p) => `[${takeKey()}]=${p}`);
  for (let i = 0; i < 8; i++) {
    const lim = 40 + rng.int(180);
    fields.push(`[${takeKey()}]=function(a,w,o) if o<=${lim} then return a end return w end`);
  }
  return `return setmetatable({${fields.join(",")},${entry}=function(_t) return function(...)
${stored}local ${st}=${envId}
local ${env},${guess},${spins},${pred},${qv},${flip}=0,0,0,0,2,1
local ${basis},${seedV},${mulV},${addV},${e1},${e2},${primeV},${extraV}=0,0,0,0,0,0,0,0
local ${g},${byte},${char},${concat},${clock},${pok}
local ${blob},${src}="",""
local ${out},${decoy}={},{}
local ${hh},${h2v},${slip},${mark}=0,0,0,0
${ks.map((name) => `local ${name}`).join("\n")}
${cs.map((name) => `local ${name}`).join("\n")}
while ${st}~=0 do
  if ${st}==${envId} then
    if type(Path2D)~="nil" then ${env}=${env}+1 end
    if type(UDim2)~="nil" then ${env}=${env}+2 end
    if type(Drawing)~="nil" then ${env}=${env}+4 end
    ${guess}=${env}
    if (${qv}*${qv}+${qv})%2==0 then ${pred}=1 end
    if (${qv}*${qv}+${qv})%2==1 then ${flip}=0 end
    if ${pred}==0 then
      local _p=Path2D
      local _u=UDim2
      local _d=Drawing
      ${guess}=${guess}+(_p and 1 or 0)+(_u and 2 or 0)+(_d and 4 or 0)
    end
    ${ks.map((name, i) => `${name}=${sParts[i]}`).join("\n")}
    ${cs.map((name, i) => `${name}=${cParts[i]}`).join("\n")}
    ${st}=${hop(envId, bindId)}
  elseif ${st}==${bindId} then
    ${g}=loadstring or load
    ${char}=string.char
    ${byte}=string.byte
    ${concat}=table.concat
    ${pok}=pcall
    if type(${char})~="function" or type(${byte})~="function" or type(${g})~="function" then error("host",0) end
    local _yell=${[..."Lol u tried to log my shi bud FUSIONDAILYFUSCATOR ON TOP"].map((ch) => hide(ch.charCodeAt(0))).join("..")}
    if type(os)=="table" then ${clock}=os.clock end
    if ${byte}(${char}(90))~=90 then error(_yell,0) end
    if ${byte}(${char}(10))~=10 then error(_yell,0) end
    if type(debug)=="table" and type(debug.gethook)=="function" then
      local _okh,_hk=pcall(debug.gethook)
      if _okh and _hk then error(_yell,0) end
    end
    if type(getmetatable)=="function" then
      local _mt=getmetatable(_G)
      if type(_mt)=="table" and (_mt.__index or _mt.__newindex) then error(_yell,0) end
    end
    ${st}=${hop(bindId, catId)}
  elseif ${st}==${catId} then
    local parts={}
    for i=1,${chunkCount} do parts[i]=${C}[i] end
    ${blob}=${concat}(parts)
    ${st}=${hop(catId, decoyId)}
  elseif ${st}==${decoyId} then
    for i=1,48 do
      if i<=#${blob} then ${decoy}[i]=${char}((${byte}(${blob},i)+${decoyAdd})%256) end
    end
    ${st}=${hop(decoyId, decId)}
  elseif ${st}==${decId} then
    local ${mt}={}
    for i=0,255 do
      ${mt}[i]={}
      local v=0
      for j=0,255 do
        ${mt}[i][j]=v
        v=v+i
        if v>=256 then v=v-256 end
      end
    end
    local ${codeT}={${enc.join(",")}}
    local ${dataT}={${wrapped.join(",")}}
    local ${konT}={${konst.join(",")}}
    local ${reg}={}
    for i=1,12 do ${reg}[i]=0 end
    local buf={}
    local ${ipn}=1
    local guard=0
    while guard<${plainInner.length * 20} do
      guard=guard+1
      if ${ipn}<1 or ${ipn}>#${codeT} then break end
      local op=(${codeT}[${ipn}]-(${mixBias}+${pred}+${ipn}*${mixStep}))%256
      local x=(${codeT}[${ipn}+1]-(${mixBias}+${pred}+(${ipn}+1)*${mixStep}))%256
      local y=(${codeT}[${ipn}+2]-(${mixBias}+${pred}+(${ipn}+2)*${mixStep}))%256
      local z=(${codeT}[${ipn}+3]-(${mixBias}+${pred}+(${ipn}+3)*${mixStep}))%256
      local ${stepN}=${ipn}+4
      if op==0 then break end
      if op==${OPK} then ${reg}[x]=${konT}[y]
      elseif op==${OPADD} then ${reg}[x]=(${reg}[y]+${reg}[z])%256
      elseif op==${OPSUB} then ${reg}[x]=(${reg}[y]-${reg}[z])%256
      elseif op==${OPMUL} then ${reg}[x]=${mt}[${reg}[y]][${reg}[z]]
      elseif op==${OPMOD} then ${reg}[x]=${reg}[y]%${reg}[z]
      elseif op==${OPADDW} then ${reg}[x]=${reg}[y]+${reg}[z]
      elseif op==${OPGET} then ${reg}[x]=${dataT}[${reg}[y]]
      elseif op==${OPPUT} then buf[#buf+1]=${char}(${reg}[x])
      elseif op==${OPJMP} then ${stepN}=x
      elseif op==${OPJGT} then if ${reg}[x]>${reg}[y] then ${stepN}=z end
      end
      ${ipn}=${stepN}
    end
    local sum=1
    for i=1,#buf do sum=(sum*33+${byte}(buf[i]))%65521 end
    if sum~=${roll} then
      if #buf>0 then buf[1]=${char}((${byte}(buf[1])+1)%256) end
    end
    ${src}=${concat}(buf)
    ${st}=${hop(decId, loadId)}
  elseif ${st}==${loadId} then
    local _ld=${g}
    local _ok,_fn=${pok}(_ld,${src})
    if _ok and _fn then
      local _run=_fn()
      if _run then return _run(${blob},${guess},${pred},${flip},${byte},${char},${concat},${pok},${g},${clock},...) end
    end
    ${st}=0
  else
    ${st}=0
  end
end
end end},{}):${entry}()(...)`;
}

export function buildRuntime(opt: {
  strings: PoolEntry[];
  numbers: PoolEntry[];
  protos: Proto[];
  buildKey: number[];
  opMap: number[];
  globals: string[];
  hardening: boolean;
  integrity: boolean;
  rng: Rng;
  names: RuntimeNames;
  userBody: string;
  minBytes: number;
  used: Set<string>;
}): BuiltRuntime {
  const rng = opt.rng;
  const params = pickParams(rng);
  const bk = opt.buildKey.length ? opt.buildKey.slice(0, 8) : [1];
  while (bk.length < 4) bk.push(rng.int(256));
  assertCipher(params);
  const strings = opt.strings.map((e) => ({ plain: utf8Bytes(e.plain), key: e.userKey ? utf8Bytes(e.userKey) : [] }));
  const numbers = opt.numbers.map((e) => ({ plain: utf8Bytes(e.plain), key: e.userKey ? utf8Bytes(e.userKey) : [] }));
  let tagS = 1 + rng.int(255);
  let tagN = 1 + rng.int(255);
  while (tagN === tagS) tagN = 1 + rng.int(255);
  const orderSeed = rng.next() >>> 0 || 1;
  const order = (() => {
    const a = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let s = orderSeed;
    for (let i = 12; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  })();
  const keys = new KeyBag(rng);
  const id = () => freshIdent(rng, opt.used);
  const usedIds = new Set<number>();
  const allocId = () => {
    for (;;) {
      const v = rng.next() >>> 0 || 1;
      if (!usedIds.has(v)) {
        usedIds.add(v);
        return v;
      }
    }
  };
  const F = {
    R: id(), i: id(), top: id(), kz: id(), jumps: id(), chains: id(), nins: id(),
    stop: id(), ret: id(), nret: id(), roll: id(), pos: id(), ups: id(),
  };
  const n = {
    hp: id(), byte: id(), char: id(), concat: id(), tonum: id(), sel: id(), unpack: id(),
    err: id(), floor: id(), bxor: id(), xor8: id(), umul: id(), kbyte: id(), decByte: id(),
    decstr: id(), u16: id(), u24: id(), u32: id(), pool: id(), BK: id(), MUL: id(), INV: id(),
    ADD: id(), XORC: id(), SALT: id(), BASIS: id(), PRIME: id(), STEP: id(), SMIX: id(), M1: id(),
    M2: id(), LANE: id(), ADODD: id(), mix: id(), ord: id(), MAP: id(), TAGS: id(),
    TAGN: id(), mapS: id(), mapN: id(), mapP: id(), strAt: id(), numAt: id(),
    HND: id(), take: id(), pack: id(), BIN: id(), UN: id(), GETG: id(), SETG: id(), st: id(),
    desc: id(), kz: id(), rotl: id(), qr: id(), fold: id(), stream: id(), unveil: id(), NONCE: id(),
    hdr: id(), caps: id(), open: id(),
  };
  const pair = (value: number): HostPair => {
    const a = rng.next() >>> 0;
    const b = (a ^ (value >>> 0)) >>> 0;
    return { a, b, aKey: keys.next(), bKey: keys.next() };
  };
  const pendingPairs: HostPair[] = [];
  const fullExpr = (value: number) => {
    const p = pair(value >>> 0);
    pendingPairs.push(p);
    return `${n.bxor}(${n.hp}[${p.aKey}],${n.hp}[${p.bKey}])`;
  };
  const byteExpr = (value: number) => {
    const p = pair(value & 255);
    pendingPairs.push(p);
    return `(${n.bxor}(${n.hp}[${p.aKey}],${n.hp}[${p.bKey}])%256)`;
  };
  const bkPairs = bk.map((b) => pair(b));
  const mulP = pair(params.mul);
  const invP = pair(params.inv);
  const addP = pair(params.add);
  const xorP = pair(params.xorc);
  const saltP = pair(params.salt);
  const basisP = pair(params.basis);
  const primeP = pair(params.prime);
  const tagSP = pair(tagS);
  const tagNP = pair(tagN);
  const stepP = pair(params.step);
  const smixP = pair(params.smix);
  const m1P = pair(params.m1);
  const m2P = pair(params.m2);
  const laneP = pair(params.lane);
  const nonceP = pair(params.nonce);
  const addOdd = (params.add | 1) & 255;
  const xorOdd = (params.xorc | 1) & 255;
  const addOddP = pair(addOdd);
  const binOps = rng.shuffle([
    { key: "add", lua: "return x+y" },
    { key: "sub", lua: "return x-y" },
    { key: "mul", lua: "return x*y" },
    { key: "div", lua: "return x/y" },
    { key: "mod", lua: "return x%y" },
    { key: "pow", lua: "return x^y" },
    { key: "lt", lua: "return x<y" },
    { key: "le", lua: "return x<=y" },
    { key: "eq", lua: "return x==y" },
  ]);
  const unOps = rng.shuffle([
    { key: "unm", lua: "return -x" },
    { key: "not", lua: "return not x" },
    { key: "len", lua: "return #x" },
  ]);
  const idExpr: Record<string, string> = {};
  for (const op of [...binOps, ...unOps]) idExpr[op.key] = fullExpr(rng.next() >>> 0 || 1);
  const binLua = `local function ${n.BIN}(op,x,y)\n${binOps
    .map((op, i) => `${i === 0 ? "if" : "elseif"} op==${idExpr[op.key]} then ${op.lua}`)
    .join("\n")}\nelse ${n.err}("b",0) end\nend`;
  const unLua = `local function ${n.UN}(op,x)\n${unOps
    .map((op, i) => `${i === 0 ? "if" : "elseif"} op==${idExpr[op.key]} then ${op.lua}`)
    .join("\n")}\nelse ${n.err}("u",0) end\nend`;
  const handlerBody = (op: number): string => {
    const R = `st.${F.R}`;
    const ip = `st.${F.i}`;
    switch (op) {
      case 0:
        return `${R}[a]=${R}[b]`;
      case 1:
        return `${R}[a]=st.${F.kz}(b)`;
      case 2:
        return `${R}[a]=nil`;
      case 3:
        return `${R}[a]=b==1`;
      case 4:
        return `${R}[a]=${n.GETG}(st.${F.kz}(b))`;
      case 5:
        return `${n.SETG}(st.${F.kz}(b),${R}[a])`;
      case 6:
        return `${R}[a]=${R}[b][${R}[c]]`;
      case 7:
        return `${R}[a][${R}[b]]=${R}[c]`;
      case 8:
        return `${R}[a]={}`;
      case 9:
        return `${R}[a]=${n.BIN}(${idExpr.add},${R}[b],${R}[c])`;
      case 10:
        return `${R}[a]=${n.BIN}(${idExpr.sub},${R}[b],${R}[c])`;
      case 11:
        return `${R}[a]=${n.BIN}(${idExpr.mul},${R}[b],${R}[c])`;
      case 12:
        return `${R}[a]=${n.BIN}(${idExpr.div},${R}[b],${R}[c])`;
      case 13:
        return `${R}[a]=${n.BIN}(${idExpr.mod},${R}[b],${R}[c])`;
      case 14:
        return `${R}[a]=${n.BIN}(${idExpr.pow},${R}[b],${R}[c])`;
      case 15:
        return `${R}[a]=${n.UN}(${idExpr.unm},${R}[b])`;
      case 16:
        return `${R}[a]=${n.UN}(${idExpr.not},${R}[b])`;
      case 17:
        return `${R}[a]=${n.UN}(${idExpr.len},${R}[b])`;
      case 18:
        return `local t={}\nif c<b then t[1]=${R}[b] else for i=b,c do t[#t+1]=${R}[i] end end\n${R}[a]=${n.concat}(t)`;
      case 19:
        return `${R}[a]=${n.BIN}(${idExpr.lt},${R}[b],${R}[c])`;
      case 20:
        return `${R}[a]=${n.BIN}(${idExpr.le},${R}[b],${R}[c])`;
      case 21:
        return `${R}[a]=${n.BIN}(${idExpr.eq},${R}[b],${R}[c])`;
      case 22:
        return `local tv=not not ${R}[a]\nif tv==(c==1) then ${ip}=${ip}+1 end`;
      case 23:
        return `if c==0 then ${ip}=b elseif c==1 then if not ${R}[a] then ${ip}=b end elseif c==2 then if ${R}[a] then ${ip}=b end else ${n.err}("j",0) end`;
      case 24:
        return `local fn=${R}[a]\nlocal args={}\nfor i=1,b do args[i]=${R}[a+i] end\nlocal pk=${n.pack}(fn(${n.unpack}(args,1,b)))\nif c<0 then\nfor i=1,pk.n do ${R}[a+i-1]=pk[i] end\nst.${F.top}=a+pk.n-1\nelseif c>0 then\nfor i=1,c do ${R}[a+i-1]=pk[i] end\nend`;
      case 25:
        return `st.${F.stop}=1\nst.${F.ret}={}\nif b==0 then st.${F.nret}=0\nelseif b<0 then\nlocal nr=st.${F.top}-a+1\nif nr<0 then nr=0 end\nst.${F.nret}=nr\nfor i=1,nr do st.${F.ret}[i]=${R}[a+i-1] end\nelse\nst.${F.nret}=b\nfor i=1,b do st.${F.ret}[i]=${R}[a+i-1] end\nend`;
      case 26:
        return `local box={}\nlocal desc=${n.caps}(b)\nfor i=1,#desc do\nlocal k,ix=desc[i][1],desc[i][2]\nif k==0 then box[i]=${R}[ix] else box[i]=st.${F.ups}[ix] end\nif type(box[i])~="table" then ${n.err}("up",0) end\nend\n${R}[a]=function(...) return ${opt.names.vm}(b,nil,box,...) end`;
      case OP.GETUP:
        return `local cell=st.${F.ups}[b]\nif type(cell)~="table" then ${n.err}("up",0) end\n${R}[a]=cell[1]`;
      case OP.SETUP:
        return `local cell=st.${F.ups}[a]\nif type(cell)~="table" then ${n.err}("up",0) end\ncell[1]=${R}[b]`;
      default:
        return `${n.err}("h0",0)`;
    }
  };
  const usedSel = new Set<number>();
  const allocSel = () => {
    for (;;) {
      const s = rng.int(256);
      if (!usedSel.has(s)) {
        usedSel.add(s);
        return s;
      }
    }
  };
  const ranked = opt.opMap.map((mapped, op) => ({ op, mapped }));
  ranked.sort((a, b) => a.mapped - b.mapped || a.op - b.op);
  const handlerForOp = new Array<number>(opt.opMap.length).fill(0);
  const selectorForOp = new Array<number>(opt.opMap.length).fill(0);
  const realHandlers: HandlerSpec[] = [];
  for (let i = 0; i < ranked.length; i += 4) {
    const group = ranked.slice(i, i + 4);
    const hid = allocId();
    const hp = pair(hid);
    pendingPairs.push(hp);
    const arms: { cmp: string; body: string }[] = [];
    for (const item of group) {
      const sel = allocSel();
      handlerForOp[item.op] = hid;
      selectorForOp[item.op] = sel;
      arms.push({ cmp: byteExpr(sel), body: handlerBody(item.op) });
    }
    const decoySel = allocSel();
    const mul = 3 + rng.int(90);
    const add = rng.int(97);
    arms.push({ cmp: byteExpr(decoySel), body: `st.${F.roll}=(st.${F.roll}*${mul}+${add})%4294967296` });
    const shuffledArms = rng.shuffle(arms);
    let body = "";
    shuffledArms.forEach((arm, idx) => {
      body += `${idx === 0 ? "if" : "elseif"} sel==${arm.cmp} then\n${arm.body}\n`;
    });
    body += `else ${n.err}("q",0) end`;
    realHandlers.push({ id: hid, aKey: hp.aKey, bKey: hp.bKey, body });
  }
  let fusedTotal = 0;
  const protoPacked = opt.protos.map((proto, protoIndex) => {
    const parts: { tag: number; indexes: number[] }[] = [];
    for (const c of proto.consts) {
      const key = proto.userKey ? utf8Bytes(proto.userKey) : [];
      if (c.k === "s") {
        strings.push({ plain: utf8Bytes(c.s ?? ""), key });
        parts.push({ tag: tagS, indexes: [strings.length] });
      } else if (c.k === "n") {
        numbers.push({ plain: utf8Bytes(c.s ?? String(c.n ?? "")), key });
        parts.push({ tag: tagN, indexes: [numbers.length] });
      } else throw new Error("unsupported VM constant");
    }
    const shaped = fuseBranches(proto.code.map((row) => row.slice()));
    varyCommutative(shaped.code, rng);
    fusedTotal += shaped.fused;
    const chain0 = mix32((params.basis ^ Math.imul(protoIndex + 1, params.prime)) >>> 0, params.m1, params.m2);
    const packed = packCode(shaped.code, order, handlerForOp, selectorForOp, chain0, addOdd, xorOdd, params.prime, params.basis, params.m1, params.m2, params.lane, rng);
    const jumpPayload = [...u16le(proto.nparams), ...u16le(Math.max(1, proto.maxReg)), ...u16le(shaped.code.length), ...u16le(1), ...u16le(proto.upvals.length)];
    for (const up of proto.upvals) {
      if ((up.kind !== 0 && up.kind !== 1) || up.index < 1 || up.index > 250) throw new Error("upvalue descriptor is out of range");
      jumpPayload.push(up.kind & 255, ...u16le(up.index));
    }
    for (let j = 0; j < packed.jumps.length; j++) {
      const rec = packed.jumps[j];
      const pk = posKey(j + 1, params.prime, params.basis, params.m1, params.m2);
      jumpPayload.push(...u32le((rec.pos ^ pk) >>> 0));
      jumpPayload.push(...u32le((rec.chain ^ mix32((pk ^ params.lane) >>> 0, params.m1, params.m2)) >>> 0));
    }
    const konstPayload: number[] = [...u16le(parts.length)];
    for (const part of parts) {
      konstPayload.push(part.tag & 255);
      if (part.tag === tagS) {
        if (part.indexes.length > 65535) throw new Error("too many string fragments");
        konstPayload.push(...u16le(part.indexes.length));
        for (const idx of part.indexes) konstPayload.push(...u16le(idx));
      } else konstPayload.push(...u16le(part.indexes[0]));
    }
    return { code: packed.plain, jumps: jumpPayload, konst: konstPayload, key: proto.userKey ? utf8Bytes(proto.userKey) : [] };
  });
  const hardRows: { name: string; index: number }[] = [];
  if (opt.hardening) {
    for (const name of opt.globals) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Hard mode cannot bind global "${name}"`);
      strings.push({ plain: utf8Bytes(name), key: [] });
      hardRows.push({ name, index: strings.length });
    }
  }
  type Arranged =
    | { kind: "live"; payload: number[]; key: number[]; index: number; veil: boolean; cipher?: number[]; ref?: { slot: number } }
    | { kind: "decoy"; index: number; lua: string };
  const arranged: Arranged[] = [];
  const remember = (payload: number[], key: number[], veilPayload: boolean) => {
    const ref = { slot: 0 };
    arranged.push({ kind: "live", payload, key, index: 0, veil: veilPayload, ref });
    return ref;
  };
  const stringRefs = strings.map((s) => remember(s.plain, s.key, true));
  const numberRefs = numbers.map((s) => remember(s.plain, s.key, true));
  const protoRefs = protoPacked.map((p) => ({
    code: remember(p.code, [], false),
    jumps: remember(p.jumps, [], false),
    konst: remember(p.konst, p.key, false),
  }));
  const watched = new Set(strings.map((s) => String.fromCharCode(...s.plain.filter((b) => b >= 32 && b < 127))));
  for (let d = 0; d < 36; d++) {
    const len = 4 + rng.int(10);
    const bytes: number[] = [];
    for (let i = 0; i < len; i++) bytes.push(rng.int(256));
    const asText = String.fromCharCode(...bytes.filter((b) => b >= 32 && b < 127));
    if (asText.length >= 4 && watched.has(asText)) continue;
    arranged.push({ kind: "decoy", index: 0, lua: luaByteLiteral(bytes) });
  }
  for (let d = 0; d < 18; d++) arranged.push({ kind: "decoy", index: 0, lua: String(rng.next() >>> 0) });
  const shuffled = rng.shuffle(arranged);
  shuffled.forEach((item, i) => {
    item.index = i + 1;
  });
  for (const item of shuffled) {
    if (item.kind === "live") {
      const body = item.veil ? veil(item.payload, item.key, item.index, params) : item.payload;
      item.cipher = seal(body, item.key, item.index, params);
      if (item.ref) item.ref.slot = item.index;
      const back = unseal(item.cipher, item.key, item.index, params);
      const opened = item.veil ? veil(back, item.key, item.index, params) : back;
      if (opened.length !== item.payload.length || opened.some((b, i) => b !== (item.payload[i] & 255))) {
        throw new Error("sealed pool record did not round-trip");
      }
    }
  }
  const strData: number[] = [...u16le(stringRefs.length)];
  for (const ref of stringRefs) strData.push(...u16le(ref.slot));
  const numData: number[] = [...u16le(numberRefs.length)];
  for (const ref of numberRefs) numData.push(...u16le(ref.slot));
  const protoData: number[] = [...u16le(protoRefs.length)];
  for (const ref of protoRefs) protoData.push(...u16le(ref.code.slot), ...u16le(ref.jumps.slot), ...u16le(ref.konst.slot));
  const mapPayload = encodePayload([
    { tag: 1, data: strData },
    { tag: 2, data: numData },
    { tag: 3, data: protoData },
  ]);
  const decoyHandlers: HandlerSpec[] = [];
  for (let d = 0; d < 24; d++) {
    const hid = allocId();
    const hp = pair(hid);
    pendingPairs.push(hp);
    const mul = 3 + rng.int(90);
    const add = rng.int(97);
    decoyHandlers.push({ id: hid, aKey: hp.aKey, bKey: hp.bKey, body: `st.${F.roll}=(st.${F.roll}*${mul}+${add})%4294967296` });
  }
  const mapIndex = shuffled.length + 1;
  const mapCipher = seal(mapPayload, [], mapIndex, params);
  const mapBack = unseal(mapCipher, [], mapIndex, params);
  if (mapBack.some((b, i) => b !== (mapPayload[i] & 255))) throw new Error("map record did not round-trip");
  const expect = mixsum(mapPayload, params.prime, params.basis);
  const mapP = pair(mapIndex);
  const sealDom = fullExpr(SEAL_DOM);
  const veilDom = fullExpr(VEIL_DOM);
  const gold = fullExpr(0x9e3779b9);
  const poolLuas = shuffled.map((item) => (item.kind === "decoy" ? item.lua : luaByteLiteral(item.cipher ?? [])));
  poolLuas.push(luaByteLiteral(mapCipher));
  const kPrim = {
    byte: keys.next(), char: keys.next(), concat: keys.next(), tonum: keys.next(), sel: keys.next(),
    unpack: keys.next(), err: keys.next(), floor: keys.next(), pool: keys.next(),
  };
  const hostNumbers: { key: number; value: number }[] = [];
  const pushPair = (p: HostPair) => {
    hostNumbers.push({ key: p.aKey, value: p.a >>> 0 }, { key: p.bKey, value: p.b >>> 0 });
  };
  bkPairs.forEach(pushPair);
  pendingPairs.forEach(pushPair);
  [basisP, primeP, tagSP, tagNP, smixP, m1P, m2P, laneP, nonceP, addOddP, mapP].forEach(pushPair);
  const fields: string[] = [];
  fields.push(`[${kPrim.byte}]=string.byte`);
  fields.push(`[${kPrim.char}]=string.char`);
  fields.push(`[${kPrim.concat}]=table.concat`);
  fields.push(`[${kPrim.tonum}]=tonumber`);
  fields.push(`[${kPrim.sel}]=select`);
  fields.push(`[${kPrim.unpack}]=table.unpack or unpack`);
  fields.push(`[${kPrim.err}]=error`);
  fields.push(`[${kPrim.floor}]=math.floor`);
  fields.push(`[${kPrim.pool}]={${poolLuas.join(",")}}`);
  for (const row of hostNumbers) fields.push(`[${row.key}]=${row.value >>> 0}`);
  for (let d = 0; d < 12; d++) fields.push(`[${keys.next()}]=${rng.next() >>> 0}`);
  const xorOf = (p: HostPair, width: "byte" | "full") =>
    width === "byte" ? `(${n.bxor}(${n.hp}[${p.aKey}],${n.hp}[${p.bKey}])%256)` : `${n.bxor}(${n.hp}[${p.aKey}],${n.hp}[${p.bKey}])`;
  const handlers = rng.shuffle([...realHandlers, ...decoyHandlers]);
  const handlerLua = handlers
    .map((h) => `${n.HND}[${n.bxor}(${n.hp}[${h.aKey}],${n.hp}[${h.bKey}])]=function(st,a,b,c,sel)\n${h.body}\nend`)
    .join("\n");
  const hardGet = hardRows.map((r, i) => `${i === 0 ? "if" : "elseif"} n==${n.strAt}(${r.index},"") then return ${r.name}`).join(" ");
  const hardSet = hardRows.map((r, i) => `${i === 0 ? "if" : "elseif"} n==${n.strAt}(${r.index},"") then ${r.name}=v`).join(" ");
  const getLua = opt.hardening
    ? hardRows.length
      ? `local function ${n.GETG}(n) ${hardGet} end return nil end`
      : `local function ${n.GETG}(n) return nil end`
    : `local function ${n.GETG}(n) local e=_G if type(getfenv)=="function" then e=getfenv(0) or e end return e[n] end`;
  const setLua = opt.hardening
    ? hardRows.length
      ? `local function ${n.SETG}(n,v) ${hardSet} end end`
      : `local function ${n.SETG}(n,v) end`
    : `local function ${n.SETG}(n,v) _G[n]=v end`;
  const bkLua = bkPairs.map((p) => `${n.bxor}(${n.hp}[${p.aKey}],${n.hp}[${p.bKey}])%256`).join(",");
  const ordLua = `for i=1,13 do ${n.ord}[i]=i end
local _os=${orderSeed}
for i=13,2,-1 do
  _os=(_os*1664525+1013904223)%4294967296
  local j=_os%i+1
  ${n.ord}[i],${n.ord}[j]=${n.ord}[j],${n.ord}[i]
end`;
  const user = opt.userBody.trim();
  const body = `local ${n.byte},${n.char},${n.concat},${n.tonum},${n.sel},${n.unpack},${n.err},${n.floor}=${n.hp}[${kPrim.byte}],${n.hp}[${kPrim.char}],${n.hp}[${kPrim.concat}],${n.hp}[${kPrim.tonum}],${n.hp}[${kPrim.sel}],${n.hp}[${kPrim.unpack}],${n.hp}[${kPrim.err}],${n.hp}[${kPrim.floor}]
local function ${n.bxor}(a,b)
  a=a%4294967296
  b=b%4294967296
  local r,p=0,1
  for _=1,32 do
    local x,y=a%2,b%2
    if x~=y then r=r+p end
    a=${n.floor}((a-x)/2)
    b=${n.floor}((b-y)/2)
    p=p*2
  end
  return r%4294967296
end
local function ${n.xor8}(a,b)
  a=a%256
  b=b%256
  local r,p=0,1
  for _=1,8 do
    local x,y=a%2,b%2
    if x~=y then r=r+p end
    a=${n.floor}((a-x)/2)
    b=${n.floor}((b-y)/2)
    p=p*2
  end
  return r
end
local function ${n.umul}(a,b)
  a=a%4294967296
  b=b%4294967296
  local a0=a%65536
  local a1=${n.floor}((a-a0)/65536)
  local b0=b%65536
  local b1=${n.floor}((b-b0)/65536)
  local p=a0*b0
  p=(p+(a0*b1%65536)*65536)%4294967296
  p=(p+(a1*b0%65536)*65536)%4294967296
  return p
end
local ${n.BASIS}=${xorOf(basisP, "full")}
local ${n.PRIME}=${xorOf(primeP, "full")}
local ${n.SMIX}=${xorOf(smixP, "full")}
local ${n.M1}=${xorOf(m1P, "full")}
local ${n.M2}=${xorOf(m2P, "full")}
local ${n.LANE}=${xorOf(laneP, "full")}
local ${n.NONCE}=${xorOf(nonceP, "full")}
local ${n.ADODD}=${xorOf(addOddP, "byte")}
local ${n.MAP}=${xorOf(mapP, "full")}
local ${n.TAGS}=${xorOf(tagSP, "byte")}
local ${n.TAGN}=${xorOf(tagNP, "byte")}
local ${n.pool}=${n.hp}[${kPrim.pool}]
local function ${n.mix}(x)
  x=x%4294967296
  x=${n.bxor}(x,${n.floor}(x/65536))
  x=${n.umul}(x,${n.M1})
  x=${n.bxor}(x,${n.floor}(x/32768))
  x=${n.umul}(x,${n.M2})
  x=${n.bxor}(x,${n.floor}(x/65536))
  return x%4294967296
end
local function ${n.rotl}(x,n)
  x=x%4294967296
  local d=2^(32-n)
  local m=2^n
  return ((x%d)*m+${n.floor}(x/d))%4294967296
end
local function ${n.qr}(s,a,b,c,d)
  s[a]=(s[a]+s[b])%4294967296
  s[d]=${n.rotl}(${n.bxor}(s[d],s[a]),16)
  s[c]=(s[c]+s[d])%4294967296
  s[b]=${n.rotl}(${n.bxor}(s[b],s[c]),12)
  s[a]=(s[a]+s[b])%4294967296
  s[d]=${n.rotl}(${n.bxor}(s[d],s[a]),8)
  s[c]=(s[c]+s[d])%4294967296
  s[b]=${n.rotl}(${n.bxor}(s[b],s[c]),7)
end
local function ${n.fold}(key)
  local u=0
  if type(key)=="string" then
    for i=1,#key do u=${n.mix}(${n.bxor}(u,${n.byte}(key,i))) end
  end
  return u
end
local function ${n.stream}(index,u,domain,nbytes)
  local w0=${n.bxor}(${n.bxor}(${n.BASIS},${n.umul}(u,1)),domain)
  local w1=${n.bxor}(${n.PRIME},${n.umul}(u,2))
  local w2=${n.bxor}(${n.M1},${n.umul}(u,3))
  local w3=${n.bxor}(${n.M2},${n.umul}(u,4))
  local w4=${n.bxor}(${n.LANE},${n.umul}(u,5))
  local w5=${n.bxor}(${n.SMIX},${n.umul}(u,6))
  local w6=${n.bxor}(${n.NONCE},${n.umul}(u,7))
  local out={}
  local block=0
  while #out<nbytes do
    local ctr=(index+block)%4294967296
    local s={w0,w1,w2,w3,${n.bxor}(w4,ctr),${n.bxor}(w5,${n.umul}(ctr,${gold})),w6,(ctr+1)%4294967296}
    local x={s[1],s[2],s[3],s[4],s[5],s[6],s[7],s[8]}
    for _=1,4 do
      ${n.qr}(x,1,2,3,4)
      ${n.qr}(x,5,6,7,8)
      ${n.qr}(x,1,2,5,6)
      ${n.qr}(x,3,4,7,8)
    end
    for i=1,8 do
      local v=(x[i]+s[i])%4294967296
      out[#out+1]=v%256
      out[#out+1]=${n.floor}(v/256)%256
      out[#out+1]=${n.floor}(v/65536)%256
      out[#out+1]=${n.floor}(v/16777216)%256
    end
    block=block+1
  end
  return out
end
local function ${n.decstr}(blob,key,index)
  if type(key)~="string" then key="" end
  if type(blob)~="string" then ${n.err}("t",0) end
  local nb=#blob
  local ks=${n.stream}(index,${n.fold}(key),${sealDom},nb)
  local bytes={}
  local acc=0
  for i=1,nb do
    local c=${n.byte}(blob,i)
    local mix=(acc+(i%256))%256
    bytes[i]=${n.xor8}(${n.xor8}(c,ks[i]),mix)
    acc=(acc+bytes[i]+c)%256
  end
  if nb<4 then ${n.err}("s",0) end
  local expect=(bytes[1]+bytes[2]*256+bytes[3]*65536+bytes[4]*16777216)%4294967296
  local h=${n.BASIS}
  for i=5,nb do h=(${n.umul}(h,${n.PRIME})+bytes[i])%4294967296 end
  if h~=expect then ${n.err}("c",0) end
  local t={}
  for i=5,nb do t[#t+1]=${n.char}(bytes[i]) end
  return ${n.concat}(t)
end
local function ${n.unveil}(s,key,index)
  if s=="" then return "" end
  local nb=#s
  local ks=${n.stream}(index,${n.fold}(key),${veilDom},nb)
  local t={}
  for i=1,nb do t[i]=${n.char}(${n.xor8}(${n.byte}(s,i),ks[i])) end
  return ${n.concat}(t)
end
local function ${n.u16}(s,i) return ${n.byte}(s,i)+${n.byte}(s,i+1)*256 end
local function ${n.u24}(s,i) return ${n.byte}(s,i)+${n.byte}(s,i+1)*256+${n.byte}(s,i+2)*65536 end
local function ${n.u32}(s,i) return (${n.byte}(s,i)+${n.byte}(s,i+1)*256+${n.byte}(s,i+2)*65536+${n.byte}(s,i+3)*16777216)%4294967296 end
local ${n.mapS}, ${n.mapN}, ${n.mapP} = {}, {}, {}
do
  local s=${n.decstr}(${n.pool}[${n.MAP}],"",${n.MAP})
  if #s<8 or ${n.byte}(s,1)~=68 or ${n.byte}(s,2)~=70 or ${n.byte}(s,3)~=51 or ${n.byte}(s,4)~=1 then ${n.err}("m",0) end
  if ${n.u16}(s,5)~=3 then ${n.err}("v",0) end
  local p=9
  local function sec(expect)
    if p+2>#s then ${n.err}("i",0) end
    local tag=${n.byte}(s,p)
    local len=${n.u16}(s,p+1)
    local base=p+3
    if tag~=expect or base+len-1>#s then ${n.err}("i",0) end
    p=base+len
    return base,len
  end
  local function fill(base,len,width)
    local q=base
    local last=base+len-1
    if q+1>last then ${n.err}("i",0) end
    local n=${n.u16}(s,q); q=q+2
    local t={}
    for i=1,n do
      if width==1 then
        if q+1>last then ${n.err}("i",0) end
        t[i]=${n.u16}(s,q); q=q+2
      else
        if q+5>last then ${n.err}("i",0) end
        t[i]={${n.u16}(s,q),${n.u16}(s,q+2),${n.u16}(s,q+4)}; q=q+6
      end
    end
    if q~=last+1 then ${n.err}("i",0) end
    return t
  end
  local b1,l1=sec(1)
  local b2,l2=sec(2)
  local b3,l3=sec(3)
  if p~=#s+1 then ${n.err}("i",0) end
  ${n.mapS}=fill(b1,l1,1)
  ${n.mapN}=fill(b2,l2,1)
  ${n.mapP}=fill(b3,l3,3)
end
local function ${n.strAt}(i,key)
  local slot=${n.mapS}[i]
  if slot==nil then ${n.err}("g",0) end
  return ${n.unveil}(${n.decstr}(${n.pool}[slot],key,slot),key,slot)
end
local function ${n.numAt}(i,key)
  local slot=${n.mapN}[i]
  if slot==nil then ${n.err}("g",0) end
  return ${n.unveil}(${n.decstr}(${n.pool}[slot],key,slot),key,slot)
end
${getLua}
${setLua}
${binLua}
${unLua}
local function ${n.pack}(...)
  return {n=${n.sel}("#",...),...}
end
local ${opt.names.vm}
local ${n.open}={}
local openN=0
local function ${n.hdr}(js)
  if type(js)~="string" or #js<10 then ${n.err}("b",0) end
  local p=1
  local function u()
    if p+1>#js then ${n.err}("b",0) end
    local v=${n.u16}(js,p)
    p=p+2
    return v
  end
  local nparams=u()
  local maxr=u()
  local nins=u()
  local entry=u()
  local nups=u()
  if entry~=1 or maxr<1 or maxr>250 or nparams>maxr or nins>100000 or nups>255 then ${n.err}("b",0) end
  local caps={}
  for i=1,nups do
    if p>#js then ${n.err}("b",0) end
    local kind=${n.byte}(js,p); p=p+1
    if p+1>#js then ${n.err}("b",0) end
    local ix=${n.u16}(js,p); p=p+2
    if (kind~=0 and kind~=1) or ix<1 or ix>250 then ${n.err}("b",0) end
    caps[i]={kind,ix}
  end
  return nparams,maxr,nins,caps,p
end
local function openSlot(slot,key)
  if key~="" then return ${n.decstr}(${n.pool}[slot],key,slot) end
  local hit=${n.open}[slot]
  if hit~=nil then return hit end
  local s=${n.decstr}(${n.pool}[slot],"",slot)
  if openN<32 then ${n.open}[slot]=s openN=openN+1 end
  return s
end
local function ${n.caps}(pi)
  local rec=${n.mapP}[pi]
  if rec==nil then ${n.err}("p",0) end
  local _,_,_,caps=${n.hdr}(openSlot(rec[2],""))
  return caps
end
local ${n.HND}={}
${handlerLua}
setmetatable(${n.HND},{__index=function() return function() ${n.err}("x",0) end end})
local function ${opt.names.ds}(i,key)
  if type(key)~="string" then key="" end
  return ${n.strAt}(i,key)
end
local function ${opt.names.dn}(i,key)
  if type(key)~="string" then key="" end
  local s=${n.numAt}(i,key)
  local v
  if s=="-0" then v=-0 else v=${n.tonum}(s) end
  if v==nil then ${n.err}(" ",0) end
  return v
end
${opt.names.vm}=function(pi,key,ups,...)
  if type(key)~="string" then key="" end
  if type(ups)~="table" then ups={} end
  local rec=${n.mapP}[pi]
  if rec==nil then ${n.err}("p",0) end
  local bc=openSlot(rec[1],"")
  local js=openSlot(rec[2],"")
  local nparams,maxr,nins,_,jp=${n.hdr}(js)
  if #ups>255 then ${n.err}("b",0) end
  local ${F.jumps}={}
  local ${F.chains}={}
  for i=1,nins+1 do
    if jp+7>#js then ${n.err}("b",0) end
    local pk=${n.mix}(${n.bxor}(${n.umul}(i,${n.PRIME}),${n.BASIS}))
    ${F.jumps}[i]=${n.bxor}(${n.u32}(js,jp),pk); jp=jp+4
    ${F.chains}[i]=${n.bxor}(${n.u32}(js,jp),${n.mix}(${n.bxor}(pk,${n.LANE}))); jp=jp+4
  end
  if jp~=#js+1 then ${n.err}("b",0) end
  for i=1,nins do
    local pos=${F.jumps}[i]
    if pos<1 or pos+12>#bc then ${n.err}("b",0) end
  end
  local ks=openSlot(rec[3],key)
  local ${n.desc}={}
  if #ks<2 then ${n.err}("b",0) end
  local kp=3
  local nk=${n.u16}(ks,1)
  for i=1,nk do
    if kp>#ks then ${n.err}("b",0) end
    local tag=${n.byte}(ks,kp); kp=kp+1
    if tag==${n.TAGS} then
      if kp+1>#ks then ${n.err}("b",0) end
      local nf=${n.u16}(ks,kp); kp=kp+2
      local idxs={}
      for j=1,nf do
        if kp+1>#ks then ${n.err}("b",0) end
        local ix=${n.u16}(ks,kp); kp=kp+2
        if ix<1 or ix>#${n.mapS} then ${n.err}("b",0) end
        idxs[j]=ix
      end
      ${n.desc}[i]={1,idxs}
    elseif tag==${n.TAGN} then
      if kp+1>#ks then ${n.err}("b",0) end
      local ix=${n.u16}(ks,kp); kp=kp+2
      if ix<1 or ix>#${n.mapN} then ${n.err}("b",0) end
      ${n.desc}[i]={2,ix}
    else ${n.err}("g",0) end
  end
  if kp~=#ks+1 then ${n.err}("b",0) end
  local function ${n.kz}(i)
    local d=${n.desc}[i]
    if d==nil then ${n.err}("g",0) end
    if d[1]==1 then
      local parts={}
      local idxs=d[2]
      for j=1,#idxs do parts[j]=${n.strAt}(idxs[j],key) end
      return ${n.concat}(parts)
    end
    local s=${n.numAt}(d[2],key)
    if s=="-0" then return -0 end
    local v=${n.tonum}(s)
    if v==nil then ${n.err}("v",0) end
    return v
  end
  local R={}
  for i=1,nparams do R[i]=${n.sel}(i,...) end
  for i=nparams+1,maxr do R[i]=nil end
  local st={${F.R}=R,${F.i}=1,${F.top}=nparams,${F.kz}=${n.kz},${F.jumps}=${F.jumps},${F.chains}=${F.chains},${F.nins}=nins,${F.stop}=0,${F.ret}={},${F.nret}=0,${F.roll}=0,${F.pos}=1,${F.ups}=ups}
  local function ${n.take}(st)
    local i=st.${F.pos}
    st.${F.pos}=i+1
    return ${n.byte}(bc,i)
  end
  local ${n.ord}={}
  ${ordLua}
  while st.${F.i}<=st.${F.nins} and st.${F.stop}==0 do
    local ii=st.${F.i}
    st.${F.pos}=st.${F.jumps}[ii]
    local chain=st.${F.chains}[ii]
    local z={}
    for p=1,13 do z[${n.ord}[p]]=${n.take}(st) end
    local m=${n.mix}(${n.bxor}(chain,${n.umul}(ii,${n.ADODD})))
    local x=m
    for p=1,13 do
      x=${n.mix}(${n.bxor}(x,${n.umul}(p,${n.LANE})))
      z[p]=${n.xor8}(z[p],x%256)
    end
    local token=${n.bxor}(z[1]+z[2]*256+z[3]*65536+z[4]*16777216,m)
    local sb=z[5]
    local a=z[6]+z[7]*256
    if a>=32768 then a=a-65536 end
    local b=z[8]+z[9]*256+z[10]*65536
    if b>=8388608 then b=b-16777216 end
    local c=z[11]+z[12]*256+z[13]*65536
    if c>=8388608 then c=c-16777216 end
    st.${F.i}=ii+1
    local hn=${n.HND}[token]
    if hn==nil then ${n.err}("h",0) end
    hn(st,a,b,c,sb)
  end
  if st.${F.stop}~=0 then return ${n.unpack}(st.${F.ret},1,st.${F.nret}) end
end
local function __DF_KSUM(s)
  if type(s)~="string" then return -1 end
  local h=${n.BASIS}
  for i=1,#s do h=(${n.umul}(h,${n.PRIME})+${n.byte}(s,i))%4294967296 end
  return h
end
local function __DF_CRASH()
  ${n.err}("crash",0)
end
${user}`;
  const entry = id();
  fields.push(`${entry}=function(${n.hp},...)\n${body}\nend`);
  const shuffledFields = rng.shuffle(fields);
  const program = `return setmetatable({${shuffledFields.join(",")}},{__index=function()return nil end}):${entry}(...)\n`;
  const wrapParams = pickParams(rng);
  assertCipher(wrapParams);
  const stage = stageBootstrap(program, wrapParams, rng, id);
  const source = outerBootstrap(stage, rng, id);
  if (/d4:[0-9a-f]+:[0-9a-f]+;d4:[0-9a-f]+:[0-9a-f]+/.test(source)) throw new Error("output still contains a linear d4 record");
  return { source, checksumValue: expect, stringBlobs: strings.length, numberBlobs: numbers.length, fused: fusedTotal };
}
