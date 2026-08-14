#!/usr/bin/env node
// bench-search.mjs — how deep can Ultimate's alpha-beta go in 1500 ms when the
// engine is written in Glyph and run as Glyph-emitted JS?
//
// It benchmarks TWO engines that are byte-for-byte equivalent in behaviour and
// both writable in Glyph. They differ only in the coding idiom:
//
//   "idiomatic"  the style src/xox.glyph already uses, and the style the spec's
//                pseudo-code implies: array.map(array.range(81), fn(i) ...),
//                array.filter, array.fold, closures everywhere, no `mut`.
//
//   "tight"      the same pure functions, but each hot allocation is one
//                array.slice + a local `mut xs[i] = v` on the fresh copy, and
//                the scans are `for i in range(n)` loops with `mut` accumulators
//                instead of map/filter/fold closure chains. Still pure at the
//                API boundary (the mutated array never escapes before it is
//                frozen into the returned record), so FR-3.3 and every
//                invariant in §2.3 hold unchanged.
//
// std/array is imported from the REAL emitted bundle (assets/engine/glyph/std),
// so the idiomatic numbers include the real allocation behaviour of
// array.map / array.filter / array.push, not a guess at it.
//
//   node tools/build-web.mjs        # once, to emit assets/engine
//   node tools/bench-search.mjs
//   node tools/bench-search.mjs --budget 1500

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STD = resolve(ROOT, "assets/engine/glyph/std/array.js");
if (!existsSync(STD)) {
  console.error("bench-search: run `node tools/build-web.mjs` first (needs assets/engine/glyph/std/array.js)");
  process.exit(1);
}
const array = await import(pathToFileURL(STD).href);

const BUDGET = Number(process.argv.includes("--budget") ? process.argv[process.argv.indexOf("--budget") + 1] : 1500);

// ------------------------------------------------------ shared vocabulary ---

// Glyph emits variant constructors as module-level singletons, so a cell copy
// is a pointer copy. Modelled exactly.
const Empty = { tag: "Empty" };
const X = { tag: "X" };
const O = { tag: "O" };
const MiniOpen = { tag: "MiniOpen" };
const MiniDrawn = { tag: "MiniDrawn" };
const MiniWon = (winner, line) => ({ tag: "MiniWon", value: { winner: winner, line: line } });
const Some = (v) => ({ tag: "Some", value: v });
const None = { tag: "None" };

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const CORNERS = [0, 2, 6, 8];
const other = (c) => (c === X ? O : X);

// ============================================================== idiomatic ===
// Every function below is a transliteration of the style in src/xox.glyph.

const I = {
  new_game(first) {
    const cells = array.map(array.range(81), (_i) => Empty);
    const boards = array.map(array.range(9), (_b) => MiniOpen);
    return { cells: cells, boards: boards, forced: None, turn: first, history: [] };
  },

  line_winner(cells, base, line) {
    const a = cells[base + line[0]];
    const b = cells[base + line[1]];
    const c = cells[base + line[2]];
    return a !== Empty && a === b && a === c ? a : Empty;
  },

  mini_status(cells, b) {
    const base = b * 9;
    const wins = array.filter(WIN_LINES, (line) => I.line_winner(cells, base, line) !== Empty);
    const full = array.len(array.filter(array.range(9), (i) => cells[base + i] === Empty)) === 0;
    return array.len(wins) > 0
      ? MiniWon(I.line_winner(cells, base, wins[0]), wins[0])
      : full ? MiniDrawn : MiniOpen;
  },

  outcome(s) {
    const claimed = (b, who) => s.boards[b].tag === "MiniWon" && s.boards[b].value.winner === who;
    const lineFor = (who) => array.filter(WIN_LINES, (l) => claimed(l[0], who) && claimed(l[1], who) && claimed(l[2], who));
    const xs = lineFor(X);
    const os = lineFor(O);
    if (array.len(xs) > 0) return { tag: "Won", value: { winner: X, line: xs[0] } };
    if (array.len(os) > 0) return { tag: "Won", value: { winner: O, line: os[0] } };
    const open = array.filter(array.range(9), (b) => s.boards[b] === MiniOpen);
    if (array.len(open) > 0) return { tag: "Playing" };
    const wx = I.boards_won(s, X);
    const wo = I.boards_won(s, O);
    if (wx > wo) return { tag: "Won", value: { winner: X, line: [] } };
    if (wo > wx) return { tag: "Won", value: { winner: O, line: [] } };
    return { tag: "Drawn" };
  },

  boards_won(s, who) {
    return array.len(array.filter(s.boards, (m) => m.tag === "MiniWon" && m.value.winner === who));
  },

  is_terminal(s) {
    return I.outcome(s).tag !== "Playing";
  },

  legal_moves(s) {
    if (I.is_terminal(s)) return [];
    const allowed = s.forced.tag === "Some"
      ? array.filter(array.range(9), (b) => b === s.forced.value)
      : array.filter(array.range(9), (b) => s.boards[b] === MiniOpen);
    return array.flat_map(
      array.filter(allowed, (b) => s.boards[b] === MiniOpen),
      (b) => array.map(
        array.filter(array.range(9), (i) => s.cells[b * 9 + i] === Empty),
        (i) => ({ board: b, cell: i }),
      ),
    );
  },

  // The hot one. Same shape as xox.place: map over a fresh range.
  apply_move(s, m) {
    const idx = m.board * 9 + m.cell;
    const cells = array.map(array.range(81), (i) => (i === idx ? s.turn : s.cells[i]));
    const status = I.mini_status(cells, m.board);
    const boards = array.map(array.range(9), (b) => (b === m.board ? status : s.boards[b]));
    const target = boards[m.cell];
    return {
      cells: cells,
      boards: boards,
      forced: target === MiniOpen ? Some(m.cell) : None,
      turn: other(s.turn),
      history: array.push(s.history, m),
    };
  },

  evaluate(s, me) {
    const out = I.outcome(s);
    if (out.tag === "Won") {
      const ply = array.len(s.history);
      return out.value.winner === me ? 1000000 - ply : -1000000 + ply;
    }
    if (out.tag === "Drawn") return 0;
    const you = other(me);
    const boardScore = (who) => {
      const won = array.fold(array.range(9), 0, (acc, b) =>
        acc + (s.boards[b].tag === "MiniWon" && s.boards[b].value.winner === who ? (b === 4 ? 140 : 100) : 0));
      const metaTwo = array.fold(WIN_LINES, 0, (acc, l) => {
        const mine = array.len(array.filter(l, (b) => s.boards[b].tag === "MiniWon" && s.boards[b].value.winner === who));
        const openThird = array.len(array.filter(l, (b) => s.boards[b] === MiniOpen));
        return acc + (mine === 2 && openThird === 1 ? 60 : 0);
      });
      const cellScore = array.fold(array.range(9), 0, (acc, b) => {
        if (s.boards[b] !== MiniOpen) return acc;
        const base = b * 9;
        const centre = s.cells[base + 4] === who ? 8 : 0;
        const corner = array.fold(CORNERS, 0, (a2, i) => a2 + (s.cells[base + i] === who ? 2 : 0));
        const twos = array.fold(WIN_LINES, 0, (a2, l) => {
          const mine = array.len(array.filter(l, (i) => s.cells[base + i] === who));
          const empty = array.len(array.filter(l, (i) => s.cells[base + i] === Empty));
          return a2 + (mine === 2 && empty === 1 ? 5 : 0);
        });
        return acc + centre + corner + twos;
      });
      return won + metaTwo + cellScore;
    };
    const free = s.forced.tag === "None" ? (s.turn === me ? 12 : -12) : 0;
    return boardScore(me) - boardScore(you) + free;
  },
};

// =================================================================== tight ===
// Same semantics; `for` + `mut` + array.slice instead of closure chains.
// Everything here is expressible in Glyph: `mut xs[i] = v` on a local copy.

const T = {
  new_game(first) {
    const cells = new Array(81).fill(Empty);
    const boards = new Array(9).fill(MiniOpen);
    return { cells: cells, boards: boards, forced: None, turn: first, history: [] };
  },

  mini_status(cells, b) {
    const base = b * 9;
    for (let k = 0; k < 8; k++) {
      const l = WIN_LINES[k];
      const a = cells[base + l[0]];
      if (a !== Empty && a === cells[base + l[1]] && a === cells[base + l[2]]) return MiniWon(a, l);
    }
    for (let i = 0; i < 9; i++) if (cells[base + i] === Empty) return MiniOpen;
    return MiniDrawn;
  },

  outcome(s) {
    for (let k = 0; k < 8; k++) {
      const l = WIN_LINES[k];
      const a = s.boards[l[0]];
      if (a.tag === "MiniWon") {
        const w = a.value.winner;
        const b = s.boards[l[1]];
        const c = s.boards[l[2]];
        if (b.tag === "MiniWon" && b.value.winner === w && c.tag === "MiniWon" && c.value.winner === w) {
          return { tag: "Won", value: { winner: w, line: l } };
        }
      }
    }
    let open = 0;
    let wx = 0;
    let wo = 0;
    for (let b = 0; b < 9; b++) {
      const m = s.boards[b];
      if (m === MiniOpen) open++;
      else if (m.tag === "MiniWon") { if (m.value.winner === X) wx++; else wo++; }
    }
    if (open > 0) return { tag: "Playing" };
    if (wx > wo) return { tag: "Won", value: { winner: X, line: [] } };
    if (wo > wx) return { tag: "Won", value: { winner: O, line: [] } };
    return { tag: "Drawn" };
  },

  is_terminal(s) { return T.outcome(s).tag !== "Playing"; },

  legal_moves(s) {
    if (T.is_terminal(s)) return [];
    const out = [];
    const lo = s.forced.tag === "Some" ? s.forced.value : 0;
    const hi = s.forced.tag === "Some" ? s.forced.value : 8;
    for (let b = lo; b <= hi; b++) {
      if (s.boards[b] !== MiniOpen) continue;
      const base = b * 9;
      for (let i = 0; i < 9; i++) if (s.cells[base + i] === Empty) out.push({ board: b, cell: i });
    }
    return out;
  },

  // array.slice(s.cells, 0, 81) then `mut cells[idx] = s.turn` on the copy.
  apply_move(s, m) {
    const cells = s.cells.slice(0, 81);
    cells[m.board * 9 + m.cell] = s.turn;
    const boards = s.boards.slice(0, 9);
    boards[m.board] = T.mini_status(cells, m.board);
    return {
      cells: cells,
      boards: boards,
      forced: boards[m.cell] === MiniOpen ? Some(m.cell) : None,
      turn: other(s.turn),
      history: s.history,   // D-U5: the search root carries history: []
    };
  },

  evaluate(s, me, ply) {
    const out = T.outcome(s);
    if (out.tag === "Won") return out.value.winner === me ? 1000000 - ply : -1000000 + ply;
    if (out.tag === "Drawn") return 0;
    let score = 0;
    for (let b = 0; b < 9; b++) {
      const m = s.boards[b];
      if (m.tag === "MiniWon") {
        const sign = m.value.winner === me ? 1 : -1;
        score += sign * (b === 4 ? 140 : 100);
        continue;
      }
      if (m !== MiniOpen) continue;
      const base = b * 9;
      const c = s.cells[base + 4];
      if (c !== Empty) score += c === me ? 8 : -8;
      for (let k = 0; k < 4; k++) {
        const v = s.cells[base + CORNERS[k]];
        if (v !== Empty) score += v === me ? 2 : -2;
      }
      for (let k = 0; k < 8; k++) {
        const l = WIN_LINES[k];
        let mine = 0;
        let theirs = 0;
        let empty = 0;
        for (let j = 0; j < 3; j++) {
          const v = s.cells[base + l[j]];
          if (v === Empty) empty++;
          else if (v === me) mine++;
          else theirs++;
        }
        if (empty === 1 && mine === 2) score += 5;
        if (empty === 1 && theirs === 2) score -= 5;
      }
    }
    for (let k = 0; k < 8; k++) {
      const l = WIN_LINES[k];
      let mine = 0;
      let theirs = 0;
      let open = 0;
      for (let j = 0; j < 3; j++) {
        const m = s.boards[l[j]];
        if (m === MiniOpen) open++;
        else if (m.tag === "MiniWon") { if (m.value.winner === me) mine++; else theirs++; }
      }
      if (open === 1 && mine === 2) score += 60;
      if (open === 1 && theirs === 2) score -= 60;
    }
    if (s.forced.tag === "None") score += s.turn === me ? 12 : -12;
    return score;
  },
};

// ============================================================ the searcher ===

function makeSearch(E, idiomatic) {
  let nodes = 0;
  let deadline = Infinity;
  let aborted = false;

  const evaluate = (s, me, ply) => (idiomatic ? E.evaluate(s, me) : E.evaluate(s, me, ply));

  function ab(s, me, depth, alpha, beta, ply) {
    nodes++;
    if (depth >= 2 && (nodes & 63) === 0 && performance.now() > deadline) { aborted = true; return 0; }
    const moves = E.legal_moves(s);
    if (depth === 0 || moves.length === 0) return evaluate(s, me, ply);
    const maximising = s.turn === me;
    let best = maximising ? -Infinity : Infinity;
    let a = alpha;
    let b = beta;
    for (let k = 0; k < moves.length; k++) {
      const v = ab(E.apply_move(s, moves[k]), me, depth - 1, a, b, ply + 1);
      if (aborted) return best;
      if (maximising) { if (v > best) best = v; if (best > a) a = best; }
      else { if (v < best) best = v; if (best < b) b = best; }
      if (b <= a) break;
    }
    return best;
  }

  return {
    // One completed ply from `s`, or null if the budget ran out mid-ply.
    ply(s, depth, budgetMs) {
      nodes = 0;
      aborted = false;
      deadline = performance.now() + budgetMs;
      const start = performance.now();
      const moves = E.legal_moves(s);
      let best = null;
      let bestScore = -Infinity;
      for (let k = 0; k < moves.length; k++) {
        const v = ab(E.apply_move(s, moves[k]), s.turn, depth - 1, -Infinity, Infinity, 1);
        if (aborted) return { done: false, nodes: nodes, ms: performance.now() - start };
        if (v > bestScore) { bestScore = v; best = moves[k]; }
      }
      return { done: true, nodes: nodes, ms: performance.now() - start, move: best, score: bestScore };
    },
  };
}

// ================================================================ fixtures ===

function playOut(E, moves) {
  let s = E.new_game(X);
  for (const [b, c] of moves) s = E.apply_move(s, { board: b, cell: c });
  return s;
}

// A plausible early-middlegame: 10 plies, mostly forced, so the branching
// factor is the realistic 5-9 rather than the opening's 81.
const OPENING_LINE = [[4, 4], [4, 0], [0, 4], [4, 8], [8, 4], [4, 2], [2, 4], [4, 6], [6, 4], [4, 1]];

// ================================================================== report ===

function bench(label, E, idiomatic) {
  const search = makeSearch(E, idiomatic);
  const positions = [
    ["opening (81 moves)", E.new_game(X)],
    ["ply 10, forced board", playOut(E, OPENING_LINE)],
  ];
  console.log(`\n=== ${label} ===`);
  for (const [name, s] of positions) {
    // warm the JIT
    search.ply(s, 2, 5000);
    let reached = 0;
    let spent = 0;
    let totalNodes = 0;
    let lastMs = 0;
    for (let d = 1; d <= 12; d++) {
      const left = BUDGET - spent;
      if (left <= 0) break;
      const r = search.ply(s, d, left);
      if (!r.done) { spent += r.ms; break; }
      reached = d;
      spent += r.ms;
      totalNodes += r.nodes;
      lastMs = r.ms;
      if (Math.abs(r.score) > 900000) break;
    }
    const nps = totalNodes / (spent / 1000);
    console.log(
      `  ${name.padEnd(22)} depth ${String(reached).padStart(2)}  ` +
      `${spent.toFixed(0).padStart(5)} ms total, last ply ${lastMs.toFixed(0)} ms, ` +
      `${(nps / 1000).toFixed(0)}k nodes/s`,
    );
  }
}

// Raw cost of one apply_move, the number FR-3.3 is really about.
function benchApply(label, E) {
  const s = playOut(E, OPENING_LINE);
  const m = E.legal_moves(s)[0];
  for (let i = 0; i < 50000; i++) E.apply_move(s, m);
  const n = 300000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) E.apply_move(s, m);
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(22)} ${(ms * 1e6 / n).toFixed(0).padStart(5)} ns/apply_move  (${(n / ms / 1000).toFixed(2)}M/s)`);
}

console.log(`bench-search: budget ${BUDGET} ms per move, node ${process.version}`);
console.log("\n=== apply_move cost ===");
benchApply("idiomatic", I);
benchApply("tight", T);
bench("idiomatic (map/filter/fold, array.push history)", I, true);
// Attribution: which half of the idiom costs the depth?
bench("idiomatic, tight apply_move only", { ...I, apply_move: T.apply_move }, true);
bench("idiomatic, tight evaluate/legal_moves only",
  { ...I, evaluate: T.evaluate, legal_moves: T.legal_moves, outcome: T.outcome, is_terminal: T.is_terminal }, false);
bench("tight (slice + mut, loops)", T, false);
console.log("");
