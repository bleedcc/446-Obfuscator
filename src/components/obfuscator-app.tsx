import { useMemo, useState } from "react";
import { Copy, Download, Shield } from "lucide-react";
import { obfuscate, type ObfuscateReport, type Profile } from "@/lib/dailyfuscator/pipeline";

const SAMPLE = `local function greet(name)
  local msg = "hello, " .. name
  if #name > 0 then
    return msg
  end
  return "hello"
end

return greet("world")
`;

const PROFILES: { id: Profile; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Strings, ASCII output" },
  { id: "standard", label: "Standard", hint: "VM + encrypted pool" },
  { id: "hard", label: "Hard", hint: "Locked globals" },
];

export function ObfuscatorApp() {
  const [source, setSource] = useState(SAMPLE);
  const [profile, setProfile] = useState<Profile>("standard");
  const [seed, setSeed] = useState("");
  const [code, setCode] = useState("");
  const [report, setReport] = useState<ObfuscateReport | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [inspecting, setInspecting] = useState(false);

  const stats = useMemo(() => {
    if (!report) return [];
    return [
      ["Output", `${report.bytes.toLocaleString("en-US")} B`],
      ["VM funcs", String(report.virtualized)],
      ["Flow blocks", String(report.flattened)],
      ["Renamed", String(report.renamed)],
      ["Checksum", String(report.checksum)],
    ];
  }, [report]);

  function run() {
    setCopied(false);
    const result = obfuscate(source, { profile, seed: seed.trim() || undefined });
    if (!result.ok) {
      setError(result.error);
      setCode("");
      setReport(null);
      return;
    }
    setError("");
    setCode(result.code);
    setReport(result.report);
  }

  async function copyOut() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    if (!code) return;
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "protected.lua";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-muted uppercase">Lua / Luau</p>
          <h1 className="mt-1 text-4xl leading-none font-semibold tracking-tight sm:text-5xl">Dailyfuscator</h1>
          <p className="mt-3 max-w-xl text-lg leading-snug text-muted">
            Register VM with per-build opcodes, closure cells, and a versioned DF3 payload. The stream mix is an obfuscation transform, not a cryptographic proof.
          </p>
        </div>
        <Shield className="mt-1 size-8 shrink-0 text-accent" aria-hidden="true" />
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        {PROFILES.map((item) => {
          const on = profile === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setProfile(item.id)}
              className={
                "min-h-11 rounded-md border px-4 py-3 text-left transition-colors " +
                (on
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line bg-surface text-fg hover:border-accent")
              }
            >
              <span className="block text-lg leading-none font-semibold">{item.label}</span>
              <span className={"mt-1 block font-mono text-xs " + (on ? "text-accent-ink/80" : "text-muted")}>
                {item.hint}
              </span>
            </button>
          );
        })}
      </section>

      <label className="block">
        <span className="font-mono text-xs tracking-wide text-muted uppercase">Seed (optional)</span>
        <input
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="Leave empty for a new build each run"
          className="mt-2 min-h-11 w-full rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
      </label>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="flex min-h-80 flex-col gap-2">
          <span className="font-mono text-xs tracking-wide text-muted uppercase">Source</span>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="min-h-80 flex-1 resize-y rounded-md border border-line bg-surface p-3 font-mono text-sm leading-relaxed text-fg outline-none focus:border-accent"
          />
        </label>

        <div className="flex min-h-80 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs tracking-wide text-muted uppercase">Protected</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={copyOut}
                disabled={!code}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-fg disabled:opacity-40"
              >
                <Copy className="size-4" aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={download}
                disabled={!code}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-fg disabled:opacity-40"
              >
                <Download className="size-4" aria-hidden="true" />
                Save
              </button>
            </div>
          </div>
          <pre className="min-h-80 flex-1 overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap text-fg">
            {code
              ? `Cloaked file ready (${code.length.toLocaleString()} characters).\n\nThe raw script is not shown here. Opening it in an editor hits invisible characters, reversed text, and stacked marks, which smears the view.\n\nCopy or Save to get the real file. Running that file still executes.`
              : "Output appears here."}
          </pre>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-danger/40 bg-surface px-4 py-3 text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {report?.warnings.length ? (
        <ul className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-muted">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {stats.length ? (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-5">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-surface px-3 py-3">
              <dt className="font-mono text-xs text-muted uppercase">{k}</dt>
              <dd className="mt-1 font-mono text-sm break-all text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <button
        type="button"
        onClick={run}
        className="min-h-12 rounded-md bg-accent px-5 text-lg font-semibold text-accent-ink"
      >
        Protect script
      </button>

      <section className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-muted">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>Anti-Logger is an inspection reply in this app. It does not change the script and it cannot see an external logger.</p>
          <button
            type="button"
            onClick={() => setInspecting(true)}
            className="min-h-11 rounded-md border border-line bg-surface-2 px-3 text-fg"
          >
            Inspect
          </button>
        </div>
        {inspecting ? (
          <p className="mt-3 font-mono text-fg">Lol u tried to log my shi bud DAILYFUSCATOR ON TOP</p>
        ) : null}
        <p className="mt-3">
          FusionDailyfuscator. The shell is the Luraph-style <span className="font-mono">return setmetatable</span> call. Libraries are read as real globals, not through <span className="font-mono">_G</span>, so Luau does not die with <span className="font-mono">env</span>. The old byte-chain recipe no longer matches. A debug hook or a logging metatable on <span className="font-mono">_G</span> stops with a troll line. This is not a copy of Luraph, Centurion, MoonVeil, Voltfuscator, or Fulcrum, and running it still shows the result.
        </p>
      </section>
    </main>
  );
}
