import { mapStmts, TransformError, type Stmt } from "./ast.ts";
import { ParseError } from "./lexer.ts";
import { parse } from "./parser.ts";
import { desugar } from "./desugar.ts";
import { applyMacros } from "./macros.ts";
import { virtualize, OP_COUNT, type Proto } from "./vm.ts";
import { applyControlFlow } from "./controlflow.ts";
import { protectBody, type Pool } from "./protect.ts";
import { renameBody } from "./rename.ts";
import { buildRuntime } from "./runtime.ts";
import { emitChunk, renameRuntime } from "./emit.ts";
import { freshIdent, hashSeed, Rng } from "./rng.ts";

export type Profile = "light" | "standard" | "hard";

export interface ObfuscateOptions {
  seed?: string;
  profile?: Profile;
  strings?: "off" | "standard" | "high";
  constants?: "off" | "safe";
  vm?: boolean;
  cf?: number;
  ui?: boolean;
  integrity?: boolean;
  hardening?: boolean;
  notice?: boolean;
  minBytes?: number;
}

export interface ObfuscateReport {
  seed: number;
  profile: Profile;
  macros: string[];
  warnings: string[];
  virtualized: number;
  skipped: Record<string, number>;
  flattened: number;
  strings: number;
  numbers: number;
  renamed: number;
  checksum: number;
  bytes: number;
  minBytes: number;
}

export type ObfuscateResult =
  | { ok: true; code: string; report: ObfuscateReport }
  | { ok: false; error: string };

const PRESETS: Record<
  Profile,
  Required<Pick<ObfuscateOptions, "strings" | "constants" | "vm" | "cf" | "ui" | "integrity" | "hardening">>
> = {
  light: { strings: "standard", constants: "off", vm: false, cf: 0, ui: false, integrity: true, hardening: false },
  standard: { strings: "standard", constants: "safe", vm: true, cf: 1, ui: false, integrity: true, hardening: false },
  hard: { strings: "high", constants: "safe", vm: true, cf: 2, ui: true, integrity: true, hardening: true },
};

function aliasRuntime(body: Stmt[], names: { ds: string; dn: string; vm: string }): Stmt[] {
  const map: Record<string, string> = {
    __DF_DS: names.ds,
    __DF_DN: names.dn,
    __DF_VM: names.vm,
  };
  return mapStmts(body, (e) => {
    if (e.type === "name" && map[e.name]) return { type: "name", name: map[e.name] };
    return null;
  });
}

export function obfuscate(source: string, options: ObfuscateOptions = {}): ObfuscateResult {
  const profile = options.profile ?? "standard";
  const preset = PRESETS[profile];
  const strings = options.strings ?? preset.strings;
  const constants = options.constants ?? preset.constants;
  const vm = options.vm ?? preset.vm;
  const cf = options.cf ?? preset.cf;
  const ui = options.ui ?? preset.ui;
  const integrity = options.integrity ?? preset.integrity;
  const hardening = options.hardening ?? preset.hardening;
  const notice = options.notice ?? true;
  const minBytes = options.minBytes ?? 0;
  if (!Number.isFinite(minBytes) || minBytes < 0 || minBytes > 2_000_000) {
    return { ok: false, error: "Minimum output size must be between 0 and 2000000 bytes." };
  }

  const trimmed = source.replace(/^\uFEFF/, "");
  if (!trimmed.trim()) return { ok: false, error: "Paste a Lua script first." };

  try {
    const seed = hashSeed(options.seed?.trim() ? options.seed.trim() : undefined);
    const rng = new Rng(seed);
    const used = new Set<string>(["__DF_KSUM", "__DF_CRASH", "__DF_CHK", "__DF_GETG", "__DF_SETG"]);
    const names = {
      ds: freshIdent(rng, used),
      dn: freshIdent(rng, used),
      vm: freshIdent(rng, used),
    };

    const parsed = parse(trimmed);
    const desugared = desugar(parsed.body);
    const macros = applyMacros(desugared);
    const virt = virtualize(macros.body, vm);
    const flow = applyControlFlow(virt.body, Math.max(0, Math.min(3, cf)), rng, used);
    const pool: Pool = { strings: [], numbers: [] };
    const protectedBody = protectBody(flow.body, { strings, constants, ui, rng, pool });
    const renamed = renameBody(protectedBody.body, rng, used);
    const aliased = aliasRuntime(renamed.body, names);

    const buildKey = Array.from({ length: 16 }, () => rng.int(256));
    const opMap = rng.shuffle(Array.from({ length: OP_COUNT }, (_, i) => i));
    const globals = [...new Set(virt.protos.flatMap((p: Proto) => p.globals))];
    const user = renameRuntime(emitChunk(aliased, true), names);
    const header = notice
      ? "--[=[FusionDailyfuscator: Luraph v14.1-v15.2, Centurion 5.2-6.3.2, MoonVeil 2.1.1, Voltfuscator 7.5-8.0, Fulcrum]=]\n"
      : "";
    const runtime = buildRuntime({
      strings: pool.strings,
      numbers: pool.numbers,
      protos: virt.protos,
      buildKey,
      opMap,
      globals,
      hardening,
      integrity,
      rng,
      names,
      userBody: user,
      minBytes: Math.max(0, minBytes - header.length),
      used,
    });
    const code = `${header}${runtime.source}`;
    if (code.length < minBytes) {
      return { ok: false, error: `Output is ${code.length} bytes, under the ${minBytes} byte minimum.` };
    }
    const watched = [
      ...pool.strings.map((s) => s.plain),
      ...virt.protos.flatMap((p) => p.consts.filter((c) => c.k === "s").map((c) => c.s ?? "")),
    ];
    const warnings = [...macros.warnings, ...protectedBody.warnings];
    for (const [key, count] of Object.entries(virt.stats.skipped)) {
      if (!count || key === "disabled") continue;
      warnings.push(`${count} construct(s) left in Lua (${key}).`);
    }
    for (const plain of watched) {
      if (plain.length >= 5 && code.includes(plain)) warnings.push("A protected string still appears in the output.");
    }

    return {
      ok: true,
      code,
      report: {
        seed,
        profile,
        macros: macros.applied,
        warnings,
        virtualized: virt.stats.virtualized,
        skipped: virt.stats.skipped,
        flattened: flow.flattened,
        strings: protectedBody.stats.strings + runtime.stringBlobs,
        numbers: protectedBody.stats.numbers + runtime.numberBlobs,
        renamed: renamed.renamed,
        checksum: runtime.checksumValue,
        bytes: code.length,
        minBytes,
      },
    };
  } catch (err) {
    if (err instanceof ParseError || err instanceof TransformError || err instanceof Error) {
      return { ok: false, error: err.message || "Obfuscation failed." };
    }
    return { ok: false, error: "Obfuscation failed." };
  }
}
