export interface Token {
  type: string;
  value: string;
  line: number;
  col: number;
  num?: number;
  str?: string;
}

export class ParseError extends Error {
  line: number;
  col: number;

  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "ParseError";
    this.line = line;
    this.col = col;
  }
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

const MULTI = [
  "...",
  "..=",
  "//=",
  "//",
  "==",
  "~=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
  "<<",
  ">>",
  "::",
  "..",
];

export function lex(source: string): Token[] {
  const src = source.replace(/\r\n/g, "\n");
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const peek = (k = 0) => src[i + k] ?? "";

  const bump = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  if (src.startsWith("#")) {
    while (i < src.length && src[i] !== "\n") bump();
  }

  const push = (type: string, value: string, extra?: Partial<Token>) => {
    tokens.push({ type, value, line, col: col - value.length, ...extra });
  };

  while (i < src.length) {
    const c = peek();
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      bump();
      continue;
    }
    if (c === "-" && peek(1) === "-") {
      const startLine = line;
      const startCol = col;
      bump(2);
      if (peek() === "[") {
        const long = readLong(src, i);
        if (long) {
          const nl = long.raw.slice(0, long.contentEnd).split("\n").length - 1;
          i = long.next;
          line = startLine + nl + long.prefixNewlines;
          // recompute col roughly by scanning is hard; recount from last newline
          const lastNl = src.lastIndexOf("\n", i - 1);
          col = lastNl < 0 ? i + 1 : i - lastNl;
          continue;
        }
      }
      while (i < src.length && peek() !== "\n") bump();
      void startCol;
      continue;
    }
    if (c === '"' || c === "'") {
      const startCol = col;
      const startLine = line;
      const quote = c;
      bump();
      let body = "";
      while (i < src.length && peek() !== quote) {
        if (peek() === "\n") throw new ParseError("unterminated string", startLine, startCol);
        if (peek() === "\\") {
          body += "\\";
          bump();
          if (i >= src.length) break;
          body += peek();
          bump();
          continue;
        }
        body += peek();
        bump();
      }
      if (peek() !== quote) throw new ParseError("unterminated string", startLine, startCol);
      bump();
      const decoded = unescapeLua(body, startLine, startCol);
      tokens.push({
        type: "string",
        value: quote + body + quote,
        str: decoded,
        line: startLine,
        col: startCol,
      });
      continue;
    }
    if (c === "[") {
      const long = readLong(src, i);
      if (long) {
        const startLine = line;
        const startCol = col;
        i = long.next;
        const lastNl = src.lastIndexOf("\n", i - 1);
        const nlCount = long.raw.split("\n").length - 1;
        line = startLine + nlCount;
        col = lastNl < 0 ? i + 1 : i - lastNl;
        tokens.push({
          type: "string",
          value: long.raw,
          str: long.content,
          line: startLine,
          col: startCol,
        });
        continue;
      }
    }
    if (isIdentStart(c)) {
      const startCol = col;
      const startLine = line;
      let value = "";
      while (isIdent(peek())) {
        value += peek();
        bump();
      }
      const type = KEYWORDS.has(value) ? "keyword" : "name";
      tokens.push({ type, value, line: startLine, col: startCol });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(peek(1)))) {
      const startCol = col;
      const startLine = line;
      const num = readNumber(src, i);
      i = num.next;
      const lastNl = src.lastIndexOf("\n", i - 1);
      col = lastNl < 0 ? i + 1 : i - lastNl;
      tokens.push({
        type: "number",
        value: num.raw,
        num: num.value,
        line: startLine,
        col: startCol,
      });
      continue;
    }
    let matched = "";
    for (const op of MULTI) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      const startCol = col;
      const startLine = line;
      bump(matched.length);
      tokens.push({ type: matched, value: matched, line: startLine, col: startCol });
      continue;
    }
    const startCol = col;
    const startLine = line;
    bump();
    tokens.push({ type: c, value: c, line: startLine, col: startCol });
    void push;
  }
  tokens.push({ type: "eof", value: "", line, col });
  return tokens;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}
function isIdent(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

function readNumber(src: string, i: number): { raw: string; value: number; next: number } {
  const start = i;
  if (src[i] === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
    i += 2;
    const hexStart = i;
    while (i < src.length && /[0-9a-fA-F]/.test(src[i])) i++;
    if (i === hexStart) throw new ParseError("malformed hex number", 0, 0);
    const raw = src.slice(start, i);
    return { raw, value: Number(raw), next: i };
  }
  while (i < src.length && isDigit(src[i])) i++;
  if (src[i] === ".") {
    i++;
    while (i < src.length && isDigit(src[i])) i++;
  }
  if (src[i] === "e" || src[i] === "E") {
    i++;
    if (src[i] === "+" || src[i] === "-") i++;
    const exp = i;
    while (i < src.length && isDigit(src[i])) i++;
    if (i === exp) throw new ParseError("malformed number", 0, 0);
  }
  const raw = src.slice(start, i);
  const value = Number(raw);
  if (!Number.isFinite(value) && raw !== "inf") {
    // still accept; caller may skip non-finite
  }
  return { raw, value, next: i };
}

function readLong(
  src: string,
  i: number,
): { content: string; next: number; raw: string; contentEnd: number; prefixNewlines: number } | null {
  if (src[i] !== "[") return null;
  let j = i + 1;
  let eq = 0;
  while (src[j] === "=") {
    eq++;
    j++;
  }
  if (src[j] !== "[") return null;
  j++;
  const contentStart = j;
  const close = "]" + "=".repeat(eq) + "]";
  const end = src.indexOf(close, j);
  if (end < 0) throw new ParseError("unterminated long string", 0, 0);
  let content = src.slice(contentStart, end);
  if (content.startsWith("\n")) content = content.slice(1);
  else if (content.startsWith("\r\n")) content = content.slice(2);
  return {
    content,
    next: end + close.length,
    raw: src.slice(i, end + close.length),
    contentEnd: end,
    prefixNewlines: 0,
  };
}

function unescapeLua(body: string, line: number, col: number): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    i++;
    const e = body[i];
    if (e === undefined) throw new ParseError("unterminated escape", line, col);
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      a: "\u0007",
      b: "\b",
      f: "\f",
      v: "\v",
      "\\": "\\",
      '"': '"',
      "'": "'",
      "\n": "",
    };
    if (e in simple) {
      out += simple[e];
      continue;
    }
    if (e === "z") {
      while (i + 1 < body.length && /[ \t\n\r\v\f]/.test(body[i + 1])) i++;
      continue;
    }
    if (e === "x") {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ParseError("bad hex escape", line, col);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (e === "u") {
      if (body[i + 1] !== "{") throw new ParseError("bad unicode escape", line, col);
      const end = body.indexOf("}", i + 2);
      if (end < 0) throw new ParseError("bad unicode escape", line, col);
      const hex = body.slice(i + 2, end);
      const cp = parseInt(hex, 16);
      if (!Number.isFinite(cp)) throw new ParseError("bad unicode escape", line, col);
      out += String.fromCodePoint(cp);
      i = end;
      continue;
    }
    if (e >= "0" && e <= "9") {
      let digits = e;
      for (let k = 0; k < 2; k++) {
        const n = body[i + 1];
        if (n >= "0" && n <= "9") {
          digits += n;
          i++;
        }
      }
      out += String.fromCharCode(parseInt(digits, 10) & 0xff);
      continue;
    }
    out += e;
  }
  return out;
}
