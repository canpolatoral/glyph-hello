#!/usr/bin/env node
// build-web.mjs — Glyph -> browser-loadable ES modules.
//
// Pipeline (each step is proven, not assumed):
//
//   1. `glyph build src --out dist`      Glyph -> TypeScript. This also runs
//                                        every @example and `tsc --strict`, so
//                                        by the time we get here the code is
//                                        type-checked.
//   2. `tsc --outDir <tmp>`              TypeScript -> ES2022 JS. tsc is used
//                                        (not a bare type-stripper) because it
//                                        ELIDES type-only named imports:
//                                        `import { Option, Some, None }`
//                                        becomes `import { Some, None }`.
//                                        `Option` is a type; leaving it in the
//                                        import list is a hard ESM link error
//                                        in a browser. A `--strip` fallback
//                                        (node's built-in stripper + export
//                                        pruning) exists for machines with no
//                                        tsc.
//   3. graph walk from the entry modules Only the modules the worker actually
//                                        reaches are emitted, so std/http,
//                                        std/fs, std/process and friends never
//                                        land in the bundle even though
//                                        `glyph build` materialised them.
//   4. specifier rewrite                 "std/array" -> "./glyph/std/array.js",
//                                        "./.glyph-runtime/glyph-bootstrap" ->
//                                        "./glyph/glyph-bootstrap.js",
//                                        "./xox" -> "./xox.js". After this the
//                                        graph is 100% relative: no bundler, no
//                                        import map, no network fetch.
//                                        `.glyph-runtime` is renamed to
//                                        `glyph` so no path component starts
//                                        with a dot (static hosts hide those).
//   5. audit                             fail the build on `node:`, a surviving
//                                        bare `std/`, `require(`, `process.`,
//                                        `document`, `window`. (AC-14, AC-41)
//   6. smoke                             load the emitted entry inside a real
//                                        worker thread and call into it, which
//                                        proves the ESM graph links and runs
//                                        off the main thread.
//
// Usage:
//   node tools/build-web.mjs
//   node tools/build-web.mjs --entries ultimate_ai,ultimate --out assets/engine
//   node tools/build-web.mjs --no-compile          # reuse dist/, skip glyph
//   node tools/build-web.mjs --strip               # no tsc on this machine
//   node tools/build-web.mjs --no-smoke
//
// To see it run in a real browser (the dev server in src/web.glyph cannot
// serve /worker.js or /engine/**, see tools/serve-static.mjs):
//   node tools/serve-static.mjs --port 8080 --probe --quiet &
//   chrome --headless=new --disable-gpu --dump-dom \
//          http://127.0.0.1:8080/worker-probe.html
//
// No npm dependencies. Needs node >= 22 and the tsc that `glyph doctor`
// already requires.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- options ---

function parseArgs(argv) {
  const opt = {
    src: "src",
    dist: "dist",
    out: "assets/engine",
    tmp: "dist/.web-js",
    // The worker's entry points, in the order the smoke step loads them.
    // `ultimate_ai` is the AI module's real name (architecture.md calls it
    // `ai`; the Engine/AI owners landed it as `ultimate_ai`), so BOTH names
    // are listed: whichever exists is bundled, the other is skipped. Dropping
    // `ultimate_ai` from this list silently ships a bundle with no AI in it —
    // the worker then has nothing to search with.
    entries: ["ultimate_ai", "ai", "ultimate", "xox"],
    compile: true,
    smoke: true,
    strip: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entries") opt.entries = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") opt.out = argv[++i];
    else if (a === "--dist") opt.dist = argv[++i];
    else if (a === "--src") opt.src = argv[++i];
    else if (a === "--no-compile") opt.compile = false;
    else if (a === "--no-smoke") opt.smoke = false;
    else if (a === "--strip") opt.strip = true;
    else if (a === "--help" || a === "-h") {
      // The header comment IS the help text, so print it whole rather than a
      // hard-coded line range that goes stale the moment the header is edited.
      const header = [];
      for (const line of readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1)) {
        if (!line.startsWith("//")) break;
        header.push(line.replace(/^\/\/ ?/, ""));
      }
      console.log(header.join("\n"));
      process.exit(0);
    } else die(`unknown flag: ${a}`);
  }
  return opt;
}

function die(message) {
  console.error(`build-web: ${message}`);
  process.exit(1);
}

function step(n, message) {
  console.log(`build-web: [${n}] ${message}`);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd: cwd ?? ROOT, encoding: "utf8", stdio: "pipe" });
  if (r.error && r.error.code === "ENOENT") return { ok: false, missing: true, out: "" };
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, missing: false, out };
}

// ------------------------------------------------------- module resolution ---

// Every import/export specifier in an ES module, in source order.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*)(["'])([^"']+)\1/g;

function specifiersOf(text) {
  const found = [];
  for (const m of text.matchAll(SPECIFIER)) found.push(m[2]);
  return found;
}

// Where a specifier written inside `fromFile` actually lives on disk.
// `null` means "no runtime module" (a .d.ts, or something not emitted).
function resolveSpecifier(spec, fromFile, jsRoot) {
  const base = spec.startsWith("std/")
    ? join(jsRoot, ".glyph-runtime", "std", spec.slice("std/".length))
    : spec.startsWith(".")
      ? resolve(dirname(fromFile), spec)
      : null;
  if (base === null) return null; // a bare non-std specifier: not ours
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    if (existsSync(candidate) && candidate.endsWith(".js")) return candidate;
  }
  return null;
}

// dist/.web-js/.glyph-runtime/std/array.js  ->  <out>/glyph/std/array.js
// dist/.web-js/xox.js                       ->  <out>/xox.js
function outPathFor(absJs, jsRoot, outRoot) {
  let rel = relative(jsRoot, absJs).split("\\").join("/");
  if (rel.startsWith(".glyph-runtime/")) rel = `glyph/${rel.slice(".glyph-runtime/".length)}`;
  return join(outRoot, rel);
}

function relativeSpecifier(fromOut, toOut) {
  let rel = relative(dirname(fromOut), toOut).split("\\").join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

// ------------------------------------------------ fallback: strip + prune ---

// Only used with --strip (no tsc). Node's stripper is pure erasure, so a
// type-only named import survives into the JS and breaks ESM linking. We prune
// each named import against the target module's real runtime exports.
const EXPORTED = /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;

function runtimeExportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(EXPORTED)) names.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const piece of m[1].split(",")) {
      const parts = piece.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0] ?? "").trim();
      if (name && !piece.trim().startsWith("type ")) names.add(name);
    }
  }
  return names;
}

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2\s*;?/g;

function pruneTypeOnlyImports(text, exportsByTarget) {
  return text.replace(NAMED_IMPORT, (whole, list, q, spec) => {
    const known = exportsByTarget.get(spec);
    if (!known) return whole;
    const kept = list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !s.startsWith("type "))
      .filter((s) => known.has(s.split(/\s+as\s+/)[0].trim()));
    if (kept.length === 0) return "";
    return `import { ${kept.join(", ")} } from ${q}${spec}${q};`;
  });
}

// ------------------------------------------------------------- the audit ---

// A browser-hostile reference in the emitted graph fails the build. This is
// AC-41 (built bundle) and the runtime half of AC-14 (source).
const BANNED = [
  [/\bfrom\s*["']node:/, "a node: specifier"],
  [/\brequire\s*\(/, "a CommonJS require()"],
  [/\bfrom\s*["']std\//, "an unrewritten bare std/ specifier"],
  [/\bprocess\s*\./, "a reference to process"],
  [/\bdocument\s*\./, "a reference to document"],
  [/\bwindow\s*\./, "a reference to window"],
];

function auditText(text) {
  // Strip line comments and block comments before auditing: prose about
  // `process` is not a use of `process`.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  return BANNED.filter(([re]) => re.test(code)).map(([, why]) => why);
}

// --------------------------------------------------------------- the build ---

const opt = parseArgs(process.argv.slice(2));
const distDir = resolve(ROOT, opt.dist);
const jsRoot = resolve(ROOT, opt.tmp);
const outRoot = resolve(ROOT, opt.out);

// [1] Glyph -> TypeScript (runs @examples and tsc --strict).
if (opt.compile) {
  step(1, `glyph build ${opt.src} --out ${opt.dist}`);
  const g = run("glyph", ["build", opt.src, "--out", opt.dist]);
  if (g.missing) die("`glyph` is not on PATH");
  console.log(g.out.trimEnd().replace(/^/gm, "         | "));
  if (!g.ok) die("glyph build failed (see above)");
} else {
  step(1, `reusing ${opt.dist} (--no-compile)`);
}
if (!existsSync(distDir)) die(`no ${opt.dist}/ — run without --no-compile`);

// [2] TypeScript -> JS.
rmSync(jsRoot, { recursive: true, force: true });
mkdirSync(jsRoot, { recursive: true });
let compiler = "tsc";
if (!opt.strip) {
  step(2, `tsc -p ${opt.dist}/tsconfig.json --outDir ${opt.tmp}`);
  const t = run("tsc", [
    "-p", join(distDir, "tsconfig.json"),
    "--noEmit", "false",
    "--outDir", jsRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--sourceMap", "false",
    "--declaration", "false",
  ]);
  if (t.missing) {
    console.log("         | tsc not found, falling back to node's type stripper");
    compiler = "strip";
  } else if (!t.ok) {
    process.stdout.write(t.out.replace(/^/gm, "         | "));
    die("tsc failed (see above)");
  }
} else {
  compiler = "strip";
}

if (compiler === "strip") {
  step(2, "node --experimental-strip-types (fallback)");
  const { stripTypeScriptTypes } = await import("node:module");
  const { readdirSync } = await import("node:fs");
  // A hand-rolled walk: glob skips dot-directories, and the whole stdlib
  // lives under `.glyph-runtime/`.
  const walk = (dir, prefix = "") =>
    readdirSync(join(distDir, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name), `${prefix}${e.name}/`)
        : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")
          ? [`${prefix}${e.name}`]
          : [],
    );
  // Pass 1: erase types, keeping the dist/ layout so specifiers still resolve.
  const files = [];
  for (const rel of walk(".")) {
    const target = join(jsRoot, rel.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stripTypeScriptTypes(readFileSync(join(distDir, rel), "utf8"), { mode: "strip" }));
    files.push(target);
  }
  // Pass 2: drop the type-only names erasure left behind, resolving each
  // specifier for real so `./std/result` and `std/result` agree.
  const exportsOf = new Map(files.map((f) => [f, runtimeExportsOf(readFileSync(f, "utf8"))]));
  for (const f of files) {
    const known = new Map();
    const text = readFileSync(f, "utf8");
    for (const spec of specifiersOf(text)) {
      const target = resolveSpecifier(spec, f, jsRoot);
      if (target !== null && exportsOf.has(target)) known.set(spec, exportsOf.get(target));
    }
    writeFileSync(f, pruneTypeOnlyImports(text, known));
  }
}

// [3] Walk the module graph from the entries. Nothing unreachable is emitted.
// Entry names that mean the same module. A missing name is only worth a
// warning when none of its aliases turned up either.
const ALIASES = [["ai", "ultimate_ai"]];
const aliasesOf = (name) => ALIASES.find((g) => g.includes(name)) ?? [name];

const present = [];
const missing = [];
for (const name of opt.entries) {
  const p = join(jsRoot, `${name}.js`);
  (existsSync(p) ? present : missing).push(name);
}
const unexplained = missing.filter((name) => !aliasesOf(name).some((a) => present.includes(a)));
if (unexplained.length > 0) {
  console.log(`         | not built yet, skipped: ${unexplained.join(", ")}`);
}
if (present.length === 0) die(`none of the entry modules exist: ${opt.entries.join(", ")}`);
step(3, `walking the graph from ${present.join(", ")}`);

const graph = new Map(); // abs .js path -> source text
const queue = present.map((n) => join(jsRoot, `${n}.js`));
while (queue.length > 0) {
  const file = queue.shift();
  if (graph.has(file)) continue;
  const text = readFileSync(file, "utf8");
  graph.set(file, text);
  for (const spec of specifiersOf(text)) {
    const target = resolveSpecifier(spec, file, jsRoot);
    if (target === null) {
      if (!spec.startsWith(".") && !spec.startsWith("std/")) {
        die(`${relative(jsRoot, file)} imports "${spec}", which is not a project or std module`);
      }
      continue;
    }
    if (!graph.has(target)) queue.push(target);
  }
}
console.log(`         | ${graph.size} module(s) reachable`);

// [4] Rewrite every specifier to a relative .js path, and write the bundle.
step(4, `emitting ${opt.out}`);
rmSync(outRoot, { recursive: true, force: true });
const written = [];
for (const [file, text] of graph) {
  const fromOut = outPathFor(file, jsRoot, outRoot);
  const rewritten = text.replace(SPECIFIER, (whole, q, spec) => {
    const target = resolveSpecifier(spec, file, jsRoot);
    if (target === null) return whole;
    const rel = relativeSpecifier(fromOut, outPathFor(target, jsRoot, outRoot));
    return whole.replace(`${q}${spec}${q}`, `${q}${rel}${q}`);
  });
  mkdirSync(dirname(fromOut), { recursive: true });
  writeFileSync(fromOut, rewritten);
  written.push(relative(outRoot, fromOut).split("\\").join("/"));
}

// A build stamp as an ES module, so `worker.js` can report `ready.buildAt`
// with a plain `import` instead of fetching manifest.json at runtime. G-4:
// nothing on the network once the page is loaded.
const builtAt = new Date().toISOString();
writeFileSync(
  join(outRoot, "build-info.js"),
  [
    "// Generated by tools/build-web.mjs. Do not edit.",
    `export const builtAt = ${JSON.stringify(builtAt)};`,
    `export const compiler = ${JSON.stringify(compiler)};`,
    `export const entries = ${JSON.stringify(present.map((n) => `./${n}.js`))};`,
    "",
  ].join("\n"),
);
written.push("build-info.js");

written.sort();
for (const rel of written) console.log(`         | ${rel}`);

// [5] Audit the emitted bundle.
step(5, "auditing for browser-hostile references");
const problems = [];
for (const rel of written) {
  for (const why of auditText(readFileSync(join(outRoot, rel), "utf8"))) {
    problems.push(`${rel}: ${why}`);
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(`         ! ${p}`);
  die("the bundle is not browser-safe (AC-41)");
}
console.log("         | clean: no node:, no bare std/, no require(), no process/document/window");

// Inert in the browser; it stops node (js-tests, bench) reparsing the bundle
// as CommonJS when it loads these files directly.
writeFileSync(join(outRoot, "package.json"), `{ "type": "module" }\n`);

writeFileSync(
  join(outRoot, "manifest.json"),
  `${JSON.stringify(
    {
      builtAt: builtAt,
      compiler: compiler,
      entries: present.map((n) => `./${n}.js`),
      files: written,
    },
    null,
    2,
  )}\n`,
);

// [6] Load it off the main thread, in a real worker, and PLAY A MOVE with it.
//
// Listing exports only proves the ESM graph links. The engine also has to
// *run* in a worker realm with no node globals reachable, so the probe drives
// the real thing end to end: new_game -> legal_moves -> AI choose -> apply_move
// -> encode, and asserts the AI's move is one of the legal ones. If any of
// that throws, the build fails here rather than in the browser.
if (opt.smoke) {
  step(6, "loading the bundle in a worker thread");
  const urlOf = (name) => pathToFileURL(join(outRoot, `${name}.js`)).href;
  const aiName = present.find((n) => aliasesOf("ai").includes(n)) ?? null;
  const hasEngine = present.includes("ultimate");

  const probe = `
    import { parentPort } from "node:worker_threads";
    const report = { loaded: [], exports: {}, play: null };
    for (const [name, url] of ${JSON.stringify(present.map((n) => [n, urlOf(n)]))}) {
      const m = await import(url);
      report.loaded.push(name);
      report.exports[name] = Object.keys(m).sort();
    }
    ${
      hasEngine && aiName
        ? `
    const u = await import(${JSON.stringify(urlOf("ultimate"))});
    const ai = await import(${JSON.stringify(urlOf(aiName))});
    const xox = await import(${JSON.stringify(urlOf("xox"))});
    const s0 = u.new_game(xox.X);
    const legal = u.legal_moves(s0);
    const t0 = Date.now();
    const plan = ai.choose(s0, ai.Hard, 12345, 150);
    const elapsed = Date.now() - t0;
    if (plan.tag !== "Some") throw new Error("AI returned None on the opening position");
    const mv = plan.value.move;
    const inSet = legal.some((m) => m.board === mv.board && m.cell === mv.cell);
    const applied = u.apply_move(s0, mv);
    if (applied.tag !== "Ok") throw new Error("engine rejected its own AI's move");
    report.play = {
      legalCount: legal.length,
      move: { board: mv.board, cell: mv.cell },
      legal: inSet,
      depth: plan.value.depth,
      nodes: plan.value.nodes,
      elapsedMs: elapsed,
      state: u.encode(applied.value),
    };`
        : ""
    }
    parentPort.postMessage(report);
  `;

  const report = await new Promise((ok, no) => {
    const w = new Worker(probe, { eval: true, type: "module" });
    w.once("message", (m) => { ok(m); w.terminate(); });
    w.once("error", no);
  }).catch((e) => die(`the emitted bundle does not load: ${e.message}`));

  for (const name of report.loaded) {
    const names = report.exports[name];
    console.log(
      `         | ${name}.js loaded, ${names.length} export(s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}`,
    );
  }
  const p = report.play;
  if (p) {
    if (!p.legal) die(`the AI chose an illegal opening move: ${JSON.stringify(p.move)}`);
    console.log(
      `         | played: ${p.legalCount} legal moves -> AI chose board ${p.move.board} cell ${p.move.cell}` +
        ` (legal: yes, depth ${p.depth}, ${p.nodes} nodes, ${p.elapsedMs} ms) -> "${p.state}"`,
    );
  } else {
    console.log("         | engine/AI entries absent, skipped the play-a-move probe");
  }
}

console.log(`build-web: ok — ${written.length} file(s) in ${opt.out}`);
