import type { Chunk, Expr, Field, FuncName, Stmt } from "./ast.ts";
import { ParseError, lex, type Token } from "./lexer.ts";

const BIN: Record<string, { prec: number; right: boolean }> = {
  or: { prec: 1, right: false },
  and: { prec: 2, right: false },
  "==": { prec: 3, right: false },
  "~=": { prec: 3, right: false },
  "<": { prec: 3, right: false },
  ">": { prec: 3, right: false },
  "<=": { prec: 3, right: false },
  ">=": { prec: 3, right: false },
  "|": { prec: 4, right: false },
  "~": { prec: 5, right: false },
  "&": { prec: 6, right: false },
  "<<": { prec: 7, right: false },
  ">>": { prec: 7, right: false },
  "..": { prec: 8, right: true },
  "+": { prec: 9, right: false },
  "-": { prec: 9, right: false },
  "*": { prec: 10, right: false },
  "/": { prec: 10, right: false },
  "//": { prec: 10, right: false },
  "%": { prec: 10, right: false },
  "^": { prec: 12, right: true },
};

const UNARY_PREC = 11;

const COMPOUND: Record<string, string> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "%=": "%",
  "^=": "^",
  "..=": "..",
  "//=": "//",
};

export function parse(source: string): Chunk {
  const parser = new Parser(lex(source));
  const body = parser.parseChunk();
  return { body };
}

class Parser {
  private i = 0;

  constructor(private tokens: Token[]) {}

  private cur(): Token {
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1];
  }

  private at(type: string, value?: string): boolean {
    const t = this.cur();
    if (t.type !== type && t.value !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return t.type === type || t.value === type;
  }

  private isKeyword(value: string): boolean {
    const t = this.cur();
    return t.type === "keyword" && t.value === value;
  }

  private eat(type: string, value?: string): Token | null {
    if (type === "keyword") {
      if (this.isKeyword(value ?? "")) {
        const t = this.cur();
        this.i++;
        return t;
      }
      return null;
    }
    const t = this.cur();
    if (value !== undefined) {
      if (t.value !== value) return null;
    } else if (t.type !== type && t.value !== type) return null;
    this.i++;
    return t;
  }

  private expectKeyword(value: string): Token {
    const t = this.eat("keyword", value);
    if (!t) this.fail(`expected '${value}'`);
    return t;
  }

  private expect(type: string): Token {
    const t = this.eat(type);
    if (!t) this.fail(`expected '${type}'`);
    return t;
  }

  private fail(message: string): never {
    const t = this.cur();
    throw new ParseError(message, t.line, t.col);
  }

  parseChunk(): Stmt[] {
    const body = this.parseBlock();
    if (this.cur().type !== "eof") this.fail(`unexpected '${this.cur().value || this.cur().type}'`);
    return body;
  }

  private parseBlock(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.blockEnd()) {
      if (this.eat(";")) continue;
      const stmt = this.parseStat();
      stmts.push(stmt);
      this.eat(";");
      if (stmt.type === "return") break;
    }
    return stmts;
  }

  private blockEnd(): boolean {
    const t = this.cur();
    if (t.type === "eof") return true;
    return (
      t.type === "keyword" &&
      (t.value === "end" || t.value === "else" || t.value === "elseif" || t.value === "until")
    );
  }

  private parseStat(): Stmt {
    if (this.isKeyword("if")) return this.parseIf();
    if (this.isKeyword("while")) return this.parseWhile();
    if (this.isKeyword("do")) {
      this.expectKeyword("do");
      const body = this.parseBlock();
      this.expectKeyword("end");
      return { type: "do", body };
    }
    if (this.isKeyword("for")) return this.parseFor();
    if (this.isKeyword("repeat")) {
      this.expectKeyword("repeat");
      const body = this.parseBlock();
      this.expectKeyword("until");
      const cond = this.parseExp();
      return { type: "repeat", body, cond };
    }
    if (this.isKeyword("function")) return this.parseFuncStat(false);
    if (this.isKeyword("local")) return this.parseLocal();
    if (this.isKeyword("return")) {
      this.expectKeyword("return");
      if (this.blockEnd() || this.cur().type === ";") return { type: "return", values: [] };
      return { type: "return", values: this.parseExprList() };
    }
    if (this.isKeyword("break")) {
      this.expectKeyword("break");
      return { type: "break" };
    }
    if (this.isKeyword("continue")) {
      this.expectKeyword("continue");
      return { type: "continue" };
    }
    if (this.isKeyword("goto")) this.fail("goto is not supported");
    if (this.cur().type === "::") this.fail("labels are not supported");
    return this.parseAssignOrCall();
  }

  private parseIf(): Stmt {
    this.expectKeyword("if");
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    let cond = this.parseExp();
    this.expectKeyword("then");
    arms.push({ cond, body: this.parseBlock() });
    while (this.isKeyword("elseif")) {
      this.expectKeyword("elseif");
      cond = this.parseExp();
      this.expectKeyword("then");
      arms.push({ cond, body: this.parseBlock() });
    }
    let elseBody: Stmt[] | null = null;
    if (this.isKeyword("else")) {
      this.expectKeyword("else");
      elseBody = this.parseBlock();
    }
    this.expectKeyword("end");
    return { type: "if", arms, elseBody };
  }

  private parseWhile(): Stmt {
    this.expectKeyword("while");
    const cond = this.parseExp();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "while", cond, body };
  }

  private parseFor(): Stmt {
    this.expectKeyword("for");
    const first = this.expect("name");
    if (this.eat("=")) {
      const start = this.parseExp();
      this.expect(",");
      const stop = this.parseExp();
      let step: Expr | null = null;
      if (this.eat(",")) step = this.parseExp();
      this.expectKeyword("do");
      const body = this.parseBlock();
      this.expectKeyword("end");
      return { type: "numericfor", name: first.value, start, stop, step, body };
    }
    const names = [first.value];
    while (this.eat(",")) names.push(this.expect("name").value);
    this.expectKeyword("in");
    const iters = this.parseExprList();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { type: "genericfor", names, iters, body };
  }

  private parseLocal(): Stmt {
    this.expectKeyword("local");
    if (this.isKeyword("function")) return this.parseFuncStat(true);
    const names = [this.expect("name").value];
    this.skipType();
    while (this.eat(",")) {
      names.push(this.expect("name").value);
      this.skipType();
    }
    let inits: Expr[] = [];
    if (this.eat("=")) inits = this.parseExprList();
    return { type: "local", names, inits };
  }

  private parseFuncStat(local: boolean): Stmt {
    this.expectKeyword("function");
    if (local) {
      const name = this.expect("name").value;
      const fn = this.parseFuncBody();
      return {
        type: "function",
        local: true,
        name: { path: [name], method: null },
        params: fn.params,
        vararg: fn.vararg,
        body: fn.body,
      };
    }
    const fname = this.parseFuncName();
    const fn = this.parseFuncBody();
    return {
      type: "function",
      local: false,
      name: fname,
      params: fn.params,
      vararg: fn.vararg,
      body: fn.body,
    };
  }

  private parseFuncName(): FuncName {
    const path = [this.expect("name").value];
    while (this.eat(".")) path.push(this.expect("name").value);
    let method: string | null = null;
    if (this.eat(":")) method = this.expect("name").value;
    return { path, method };
  }

  private parseFuncBody(): { params: string[]; vararg: boolean; body: Stmt[] } {
    this.expect("(");
    const params: string[] = [];
    let vararg = false;
    if (!this.eat(")")) {
      if (this.eat("...")) {
        vararg = true;
        this.expect(")");
      } else {
        params.push(this.expect("name").value);
        this.skipType();
        while (this.eat(",")) {
          if (this.eat("...")) {
            vararg = true;
            break;
          }
          params.push(this.expect("name").value);
          this.skipType();
        }
        this.expect(")");
      }
    }
    this.skipType();
    const body = this.parseBlock();
    this.expectKeyword("end");
    return { params, vararg, body };
  }

  private parseAssignOrCall(): Stmt {
    const first = this.parsePrefix();
    if (this.cur().value in COMPOUND) {
      const tok = this.cur().value;
      this.i++;
      const value = this.parseExp();
      return { type: "compound", op: COMPOUND[tok], target: first, value };
    }
    if (this.cur().value === "," || this.cur().value === "=") {
      const targets = [first];
      while (this.eat(",")) targets.push(this.parsePrefix());
      this.expect("=");
      const values = this.parseExprList();
      return { type: "assign", targets, values };
    }
    if (first.type === "call") return { type: "call", expr: first };
    this.fail("expected assignment or call");
  }

  private parseExp(): Expr {
    return this.parseSubexpr(0);
  }

  private parseExprList(): Expr[] {
    const list = [this.parseExp()];
    while (this.eat(",")) list.push(this.parseExp());
    return list;
  }

  private parseSubexpr(minPrec: number): Expr {
    let left: Expr;
    const t = this.cur();
    if (t.value === "not" || t.value === "#" || t.value === "-" || t.value === "~") {
      const op = t.value;
      this.i++;
      left = { type: "unary", op, arg: this.parseSubexpr(UNARY_PREC) };
    } else {
      left = this.parsePrefix();
    }
    while (true) {
      const op = this.cur().value;
      const info = BIN[op];
      if (!info || info.prec < minPrec) break;
      this.i++;
      const next = info.right ? info.prec : info.prec + 1;
      const right = this.parseSubexpr(next);
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parsePrefix(): Expr {
    let e = this.parseAtom();
    while (true) {
      if (this.eat(".")) {
        const name = this.expect("name").value;
        e = { type: "index", object: e, index: { type: "string", value: name } };
        continue;
      }
      if (this.eat("[")) {
        const index = this.parseExp();
        this.expect("]");
        e = { type: "index", object: e, index };
        continue;
      }
      if (this.eat(":")) {
        const method = this.expect("name").value;
        const args = this.parseArgs();
        e = { type: "call", callee: e, args, method };
        continue;
      }
      if (this.cur().type === "(" || this.cur().type === "string" || this.cur().value === "{") {
        const args = this.parseArgs();
        e = { type: "call", callee: e, args, method: null };
        continue;
      }
      break;
    }
    return e;
  }

  private parseArgs(): Expr[] {
    if (this.eat("(")) {
      if (this.eat(")")) return [];
      const list = this.parseExprList();
      this.expect(")");
      return list;
    }
    if (this.cur().type === "string") {
      const t = this.cur();
      this.i++;
      return [{ type: "string", value: t.str ?? "" }];
    }
    if (this.cur().value === "{") return [this.parseTable()];
    this.fail("expected arguments");
  }

  private parseAtom(): Expr {
    const t = this.cur();
    if (this.isKeyword("nil")) {
      this.i++;
      return { type: "nil" };
    }
    if (this.isKeyword("true")) {
      this.i++;
      return { type: "boolean", value: true };
    }
    if (this.isKeyword("false")) {
      this.i++;
      return { type: "boolean", value: false };
    }
    if (this.isKeyword("function")) {
      this.i++;
      const fn = this.parseFuncBody();
      return { type: "function", params: fn.params, vararg: fn.vararg, body: fn.body };
    }
    if (this.eat("...")) return { type: "vararg" };
    if (t.type === "number") {
      this.i++;
      return { type: "number", value: t.num ?? Number(t.value), raw: t.value };
    }
    if (t.type === "string") {
      this.i++;
      return { type: "string", value: t.str ?? "" };
    }
    if (t.type === "name") {
      this.i++;
      return { type: "name", name: t.value };
    }
    if (this.eat("(")) {
      if (this.isKeyword("if")) {
        const expr = this.parseIfExpr();
        this.expect(")");
        return { type: "paren", expr };
      }
      const e = this.parseExp();
      this.expect(")");
      return { type: "paren", expr: e };
    }
    if (this.isKeyword("if")) return this.parseIfExpr();
    if (t.value === "{") return this.parseTable();
    this.fail(`unexpected '${t.value || t.type}'`);
  }

  private parseIfExpr(): Expr {
    this.expectKeyword("if");
    const cond = this.parseExp();
    this.expectKeyword("then");
    const yes = this.parseExp();
    const arms: { cond: Expr; value: Expr }[] = [{ cond, value: yes }];
    while (this.isKeyword("elseif")) {
      this.expectKeyword("elseif");
      const c = this.parseExp();
      this.expectKeyword("then");
      arms.push({ cond: c, value: this.parseExp() });
    }
    this.expectKeyword("else");
    let expr: Expr = this.parseExp();
    for (let i = arms.length - 1; i >= 0; i--) {
      const a = arms[i];
      expr = {
        type: "call",
        callee: {
          type: "function",
          params: [],
          vararg: false,
          body: [
            {
              type: "if",
              arms: [{ cond: a.cond, body: [{ type: "return", values: [a.value] }] }],
              elseBody: [{ type: "return", values: [expr] }],
            },
          ],
        },
        args: [],
        method: null,
      };
    }
    return expr;
  }

  private parseTable(): Expr {
    this.expect("{");
    const fields: Field[] = [];
    while (this.cur().value !== "}" && this.cur().type !== "eof") {
      if (this.eat("[")) {
        const key = this.parseExp();
        this.expect("]");
        this.expect("=");
        const value = this.parseExp();
        fields.push({ key, value });
      } else if (this.cur().type === "name" && this.tokens[this.i + 1]?.value === "=") {
        const key = this.expect("name").value;
        this.expect("=");
        const value = this.parseExp();
        fields.push({ key: { type: "string", value: key }, value });
      } else {
        fields.push({ key: null, value: this.parseExp() });
      }
      if (!this.eat(",") && !this.eat(";")) break;
    }
    this.expect("}");
    return { type: "table", fields };
  }

  private skipType(): void {
    if (!this.eat(":")) return;
    this.skipTypeExpr();
  }

  private skipTypeExpr(): void {
    this.skipTypeUnion();
  }

  private skipTypeUnion(): void {
    this.skipTypePrimary();
    while (this.cur().value === "|" || this.cur().value === "?") {
      if (this.eat("?")) continue;
      this.expect("|");
      this.skipTypePrimary();
    }
  }

  private skipTypePrimary(): void {
    const t = this.cur();
    if (t.type === "name" && t.value === "typeof") {
      this.i++;
      this.expect("(");
      this.parseExp();
      this.expect(")");
      return;
    }
    if (this.eat("(")) {
      let depth = 1;
      while (depth > 0 && this.cur().type !== "eof") {
        if (this.cur().value === "(") depth++;
        else if (this.cur().value === ")") depth--;
        if (depth === 0) break;
        this.i++;
      }
      this.expect(")");
      if (this.cur().value === "-" && this.tokens[this.i + 1]?.value === ">") {
        this.i += 2;
        this.skipTypeExpr();
      }
      return;
    }
    if (this.eat("{")) {
      let depth = 1;
      while (depth > 0 && this.cur().type !== "eof") {
        if (this.cur().value === "{") depth++;
        else if (this.cur().value === "}") depth--;
        if (depth === 0) break;
        this.i++;
      }
      this.expect("}");
      if (this.eat("?")) {
        /* optional */
      }
      return;
    }
    if (t.type === "name") {
      this.i++;
      while (this.eat(".")) this.expect("name");
      if (this.eat("<")) {
        let depth = 1;
        while (depth > 0 && this.cur().type !== "eof") {
          if (this.cur().value === "<") depth++;
          else if (this.cur().value === ">") depth--;
          if (depth === 0) break;
          this.i++;
        }
        this.expect(">");
      }
      if (this.eat("?")) {
        /* postfix optional */
      }
      return;
    }
    this.fail("expected type");
  }
}
