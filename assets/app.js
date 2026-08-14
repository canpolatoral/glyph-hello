// assets/app.js — the shell (owner: Shell).
//
// Boots the page, routes between Classic 3x3 and Ultimate, owns every shared
// element in the rail, and is the only place that talks to the engine client.
// The 81-cell board itself belongs to ultimate-ui.js; the shell hands it a
// plain view object and gets clicks back.
//
// Threading (FR-4.4): search happens in the worker, never here. The main
// thread only calls the O(81) pure functions — legal_moves, apply_move,
// outcome — which are microseconds each.

import { store } from "/store.js";
import { mountUltimate } from "/ultimate-ui.js";
import * as U from "/engine/ultimate.js";
import * as XOX from "/engine/xox.js";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMPTY9 = ".........";
const LEVEL_NAME = { easy: "Easy", medium: "Medium", hard: "Hard", human: "Two players" };
const CLASSIC_LEVEL = { easy: "careless", medium: "fair", hard: "perfect" };
const BUDGET = { easy: 60, medium: 250, hard: 1500 };

function markOf(cell) {
  return XOX.mark(cell);
}

function cellOf(mark) {
  return XOX.cell_from(mark);
}

// ---------------------------------------------------------------------------
// UState -> plain view for ultimate-ui.js
// ---------------------------------------------------------------------------

function boardsOf(s) {
  const out = [];
  for (let b = 0; b < 9; b++) {
    const st = U.mini_status(s, b);
    if (st.tag === "MiniWon") {
      out.push({ state: "won", winner: markOf(st.winner), line: st.line });
    } else if (st.tag === "MiniDrawn") {
      out.push({ state: "drawn", winner: null, line: [] });
    } else {
      out.push({ state: "open", winner: null, line: [] });
    }
  }
  return out;
}

function outcomeOf(s) {
  const o = U.outcome(s);
  if (o.tag === "Won") return { status: "won", winner: markOf(o.winner), line: o.line };
  if (o.tag === "Drawn") return { status: "drawn", winner: null, line: [] };
  return { status: "playing", winner: null, line: [] };
}

function viewOf(s, opts) {
  const cells = U.state_to_text(s).split("/").join("").split("");
  const legal = new Set();
  for (const m of U.legal_moves(s)) legal.add(m.board * 9 + m.cell);
  const out = outcomeOf(s);
  const hist = s.history;
  return {
    cells: cells,
    boards: boardsOf(s),
    forced: s.forced.tag === "Some" ? s.forced.value : null,
    playable: U.playable_boards(s),
    legal: legal,
    lastMove: hist.length ? hist[hist.length - 1] : null,
    turn: markOf(s.turn),
    metaLine: out.status === "won" ? out.line : [],
    over: out.status !== "playing",
    interactive: opts.interactive,
    thinking: opts.thinking,
  };
}

// ---------------------------------------------------------------------------
// Sound (UI-5.10) — off by default, built lazily on the first gesture.
// ---------------------------------------------------------------------------

const sound = {
  on: false,
  ctx: null,
  ping(kind) {
    if (!this.on) return;
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.ctx;
      if (ctx.state === "suspended") ctx.resume();
      const notes =
        kind === "win" ? [523, 659, 784] : kind === "lose" ? [330, 262] : kind === "O" ? [392] : [587];
      notes.forEach((f, k) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        const t0 = ctx.currentTime + k * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.24);
      });
    } catch (_err) {
      /* audio is a nicety; never let it break a move */
    }
  },
};

// ---------------------------------------------------------------------------
// Engine client. Preference order:
//   1. /engine-client.js          (the Protocol owner's module, if it landed)
//   2. /worker.js                 (the Protocol owner's worker + our plumbing)
//   3. an inline module worker we build over assets/engine/**  (always works)
//   4. a shallow main-thread fallback, so the page still plays if the AI
//      module has not been compiled yet
// Whichever it is, the shell only ever sees `choose()` and the FR-4.6 floor is
// applied exactly once.
// ---------------------------------------------------------------------------

const THINK_FLOOR = 300;

// The inline worker speaks the architecture §3.2/§3.3 protocol verbatim, so
// the same client drives it and the Protocol owner's /worker.js.
function workerScript(url) {
  return `
import * as U from ${JSON.stringify(url.ultimate)};
import * as XOX from ${JSON.stringify(url.xox)};
import * as AI from ${JSON.stringify(url.ai)};

const DIFF = { easy: AI.Easy, medium: AI.Medium, hard: AI.Hard };
const reply = (m) => self.postMessage(m);

self.onmessage = (ev) => {
  const req = (ev && ev.data) || {};
  const id = req.id;
  try {
    if (req.type === "ping") { reply({ id: id, type: "pong" }); return; }

    if (req.type === "choose") {
      const t0 = Date.now();
      const level = DIFF[req.level] || AI.Medium;

      if (req.mode === "classic") {
        const opt = AI.classic_choose(XOX.from_text(req.state), XOX.cell_from(req.turn), level);
        if (opt.tag !== "Some") { reply({ id: id, type: "error", code: "NoMove", message: "no legal move" }); return; }
        reply({ id: id, type: "chosen", move: { square: opt.value }, score: 0, depth: 9,
                nodes: 0, elapsedMs: Date.now() - t0, state: req.state });
        return;
      }

      const d = U.decode(req.state);
      if (d.tag !== "Ok") { reply({ id: id, type: "error", code: "Decode", message: "bad state" }); return; }
      const plan = AI.choose(d.value, level, req.seed | 0, req.budgetMs | 0);
      if (plan.tag !== "Some") { reply({ id: id, type: "error", code: "NoMove", message: "terminal" }); return; }
      const p = plan.value;
      const after = U.apply_move(d.value, p.move);
      reply({ id: id, type: "chosen", move: { board: p.move.board, cell: p.move.cell },
              score: p.score, depth: p.depth, nodes: p.nodes, elapsedMs: Date.now() - t0,
              state: after.tag === "Ok" ? U.encode(after.value) : req.state });
      return;
    }

    if (req.type === "classicEvals") {
      reply({ id: id, type: "result",
              value: XOX.evaluate(XOX.from_text(req.state), XOX.cell_from(req.turn)) });
      return;
    }

    reply({ id: id, type: "error", code: "BadRequest", message: "unknown type" });
  } catch (err) {
    reply({ id: id, type: "error", code: "Internal", message: String(err) });
  }
};
`;
}

// The X-ray read (a full 3x3 minimax per square) needs a worker that exposes
// `classicEvals`. If the main worker does not, we keep the feature alive on a
// small inline worker of our own rather than removing a control that worked
// before.
async function inlineWorker() {
  const files = await manifestFiles();
  const ai = ["ai.js", "ultimate_ai.js"].find((f) => files.indexOf(f) >= 0);
  if (!ai) return null;
  const base = new URL("/engine/", location.href).href;
  const src = workerScript({ ultimate: base + "ultimate.js", xox: base + "xox.js", ai: base + ai });
  return spawn(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
}

// Lazily-built side channel for `classicEvals`, shared by every path below.
let sideSend = null;
let sideTried = false;

async function sideEvals(state, turn) {
  if (!sideTried) {
    sideTried = true;
    const w = await inlineWorker();
    if (w) sideSend = talk(w);
  }
  if (!sideSend) return { type: "error", code: "Unsupported" };
  return sideSend({ type: "classicEvals", state: state, turn: turn }, 8000);
}

async function manifestFiles() {
  try {
    const r = await fetch("/engine/manifest.json", { cache: "no-store" });
    const m = await r.json();
    return Array.isArray(m.files) ? m.files : [];
  } catch (_err) {
    return [];
  }
}

function talk(worker) {
  let nextId = 1;
  const pending = new Map();
  worker.addEventListener("message", (ev) => {
    const m = ev.data || {};
    const p = pending.get(m.id);
    if (!p) return; // unsolicited `ready` (id 0) and late cancels land here
    pending.delete(m.id);
    p(m);
  });
  worker.addEventListener("error", () => {
    for (const [, p] of pending) p({ type: "error", code: "WorkerDied" });
    pending.clear();
  });
  return function send(msg, timeoutMs) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      if (timeoutMs) {
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); resolve({ type: "error", code: "Timeout" }); }
        }, timeoutMs);
      }
      worker.postMessage(Object.assign({ id: id }, msg));
    });
  };
}

// A worker that answers `ready` or `pong` is alive. Anything else — a 404
// served as HTML, a link error, a missing module — fires `error` and we move
// down the ladder.
function spawn(url) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(url, { type: "module" });
    } catch (_err) {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      w.removeEventListener("message", onMsg);
      if (!ok) { try { w.terminate(); } catch (_e) {} }
      resolve(ok ? w : null);
    };
    function onMsg(ev) {
      const m = ev.data || {};
      if (m.type === "ready" || m.type === "pong") done(true);
    }
    w.addEventListener("message", onMsg);
    w.addEventListener("error", () => done(false));
    w.postMessage({ id: 0, type: "ping" });
    setTimeout(() => done(false), 2500);
  });
}

async function connectEngine() {
  // 1. the Protocol module
  try {
    const mod = await import("/engine-client.js");
    if (mod && typeof mod.createEngineClient === "function") {
      const c = mod.createEngineClient();
      if (typeof c.ready === "function") await c.ready();
      return {
        kind: "engine-client",
        floorApplied: true,
        choose: (req) => c.choose(req),
        evals: sideEvals,
        cancel: () => { if (typeof c.cancel === "function") c.cancel(); },
      };
    }
  } catch (_err) {
    /* not landed yet — fall through */
  }

  // 2/3. a worker we drive ourselves
  let worker = await spawn("/worker.js");
  let inline = false;
  if (!worker) {
    worker = await inlineWorker();
    inline = worker !== null;
  }

  if (worker) {
    const send = talk(worker);
    return {
      kind: inline ? "inline-worker" : "worker",
      floorApplied: false,
      choose: (req) => send(Object.assign({ type: "choose" }, req)),
      evals: async (state, turn) => {
        const r = await send({ type: "classicEvals", state: state, turn: turn }, 8000);
        return r && r.type === "result" ? r : sideEvals(state, turn);
      },
      cancel: () => send({ type: "cancel", target: 0 }, 500),
    };
  }

  // 4. no worker at all: keep the game playable with a shallow, cheap policy.
  return {
    kind: "fallback",
    floorApplied: false,
    choose: (req) => Promise.resolve(localPlan(req)),
    evals: sideEvals,
    cancel: () => {},
  };
}

// Main-thread safety net for the no-worker case only: take an immediate win,
// otherwise play a random legal move. ~81 apply_move calls at ~0.6 us each,
// so it never approaches a long task. Every real path searches in the worker.
function localPlan(req) {
  if (req.mode === "classic") {
    const b = XOX.from_text(req.state);
    const opt = XOX.choose_move(b, cellOf(req.turn), XOX.level_from(CLASSIC_LEVEL[req.level] || "fair"));
    if (opt.tag !== "Some") return { type: "error", code: "NoMove" };
    return { type: "chosen", move: { square: opt.value }, score: 0, depth: 9, nodes: 0 };
  }
  const d = U.decode(req.state);
  if (d.tag !== "Ok") return { type: "error", code: "Decode" };
  const s = d.value;
  const me = markOf(s.turn);
  const moves = U.legal_moves(s);
  if (!moves.length) return { type: "error", code: "NoMove" };
  let pick = moves[Math.floor(Math.random() * moves.length)];
  for (const m of moves) {
    const r = U.apply_move(s, m);
    if (r.tag !== "Ok") continue;
    const o = outcomeOf(r.value);
    if (o.status === "won" && o.winner === me) { pick = m; break; }
  }
  const after = U.apply_move(s, pick);
  return {
    type: "chosen",
    move: { board: pick.board, cell: pick.cell },
    score: 0, depth: 1, nodes: moves.length,
    state: after.tag === "Ok" ? U.encode(after.value) : req.state,
  };
}

function errorOf(res) {
  if (!res) return "no reply";
  if (res.error && res.error.code) return res.error.code;
  return res.code || res.type || "no reply";
}

// FR-4.6: the main thread owns the 300 ms floor, applied exactly once.
async function think(engine, req) {
  const t0 = performance.now();
  const res = await engine.choose(req);
  if (!engine.floorApplied) {
    const rest = THINK_FLOOR - (performance.now() - t0);
    if (rest > 0) await sleep(rest);
  }
  return res;
}

// ---------------------------------------------------------------------------
// application state
// ---------------------------------------------------------------------------

const app = {
  mode: "ultimate",
  level: "medium",
  human: "X",
  seed: 918273,
  busy: false,
  xrayOk: false,
  engine: null,
  u: { state: U.new_game(cellOf("X")), redo: [], counted: false },
  c: { board: EMPTY9, turn: "X", history: [], redo: [], line: [], evals: [], xray: false, counted: false },
};

const vsEngine = () => app.level !== "human";
const uOver = () => outcomeOf(app.u.state).status !== "playing";
const cOutcome = () => XOX.outcome(XOX.from_text(app.c.board));
const cOver = () => cOutcome().tag !== "Ongoing";

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function pairsOf(moves) {
  return moves.map((m) => String(m.board) + String(m.cell)).join("");
}

function movesOf(pairs) {
  const out = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    out.push({ board: Number(pairs[i]), cell: Number(pairs[i + 1]) });
  }
  return out;
}

function saveGame() {
  if (app.mode === "ultimate") {
    store.game.save("ultimate", {
      save: U.encode(app.u.state),
      redo: pairsOf(app.u.redo),
      difficulty: app.level,
      human: app.human,
    });
  } else {
    store.game.save("classic", {
      board: app.c.board,
      turn: app.c.turn,
      you: app.human,
      level: app.level,
      history: app.c.history.join(""),
      redo: app.c.redo.join(""),
    });
  }
}

function saveSettings() {
  store.settings.patch({
    mode: app.mode,
    difficulty: app.level,
    sound: sound.on,
    first: app.human,
    seed: app.seed,
  });
}

function statKey() {
  return app.mode + ":" + app.level;
}

function recordResult(result) {
  if (!vsEngine()) return;
  store.stats.record({ mode: app.mode, difficulty: app.level, result: result });
  paintTally();
}

// ---------------------------------------------------------------------------
// Ultimate
// ---------------------------------------------------------------------------

let ultimate = null;

function renderUltimate() {
  const interactive = !app.busy && !uOver() && (!vsEngine() || markOf(app.u.state.turn) === app.human);
  ultimate.render(viewOf(app.u.state, { interactive: interactive, thinking: app.busy }));
  paintStatus();
  paintActions();
}

function uCaption() {
  const s = app.u.state;
  const out = outcomeOf(s);
  if (out.status !== "playing") {
    const x = U.boards_won(s, cellOf("X"));
    const o = U.boards_won(s, cellOf("O"));
    return "boards won — X " + x + " · O " + o;
  }
  const turn = markOf(s.turn);
  const who = vsEngine() ? (turn === app.human ? "You" : "The engine") : turn;
  const verb = vsEngine() && turn === app.human ? "must play" : "must play";
  if (s.forced.tag === "Some") {
    return who + " " + verb + " in the highlighted board (board " + (s.forced.value + 1) + ")";
  }
  // Against the engine this is "you" or "the engine"; between two people it
  // names the mark to move, because "they" tells a pass-and-play pair nothing.
  const mover = vsEngine() ? (turn === app.human ? "you" : "the engine") : turn;
  return "Free move — " + mover + " may play in any open board";
}

async function playUltimate(move) {
  if (app.busy || uOver()) return;
  const res = U.apply_move(app.u.state, move);
  if (res.tag !== "Ok") {
    // The engine is the authority (FR-3.4); the UI only ever hides illegal
    // moves, so this is a bug-catcher, not a normal path.
    flashCaption("that move is " + res.value.tag);
    return;
  }
  app.u.state = res.value;
  app.u.redo = [];
  sound.ping(markOf(app.u.state.turn) === "X" ? "O" : "X");
  renderUltimate();
  saveGame();
  if (settleUltimate()) return;
  if (vsEngine()) await engineTurnUltimate();
}

async function engineTurnUltimate() {
  if (uOver()) return;
  app.busy = true;
  renderUltimate();
  const res = await think(app.engine, {
    mode: "ultimate",
    state: U.encode(app.u.state),
    level: app.level,
    seed: (app.seed + app.u.state.history.length * 7919) | 0,
    budgetMs: BUDGET[app.level] || 800,
  });
  app.busy = false;
  const move = res && res.move;
  if (!move || typeof move.board !== "number") {
    flashCaption("engine unavailable — " + errorOf(res));
    renderUltimate();
    return;
  }
  const applied = U.apply_move(app.u.state, { board: move.board, cell: move.cell });
  if (applied.tag !== "Ok") {
    flashCaption("engine proposed an illegal move (" + applied.value.tag + ")");
    renderUltimate();
    return;
  }
  app.u.state = applied.value;
  app.u.redo = [];
  app.lastPlan = res;
  sound.ping(markOf(app.u.state.turn) === "X" ? "O" : "X");
  renderUltimate();
  saveGame();
  settleUltimate();
}

function settleUltimate() {
  const out = outcomeOf(app.u.state);
  if (out.status === "playing") return false;
  if (!app.u.counted) {
    app.u.counted = true;
    if (out.status === "drawn") recordResult("draw");
    else recordResult(out.winner === app.human ? "win" : "loss");
    sound.ping(out.status === "drawn" ? "place" : out.winner === app.human ? "win" : "lose");
  }
  renderUltimate();
  return true;
}

function newUltimate() {
  app.u.state = U.new_game(cellOf("X"));
  app.u.redo = [];
  app.u.counted = false;
  app.lastPlan = null;
  app.busy = false;
  renderUltimate();
  saveGame();
  if (vsEngine() && app.human === "O") engineTurnUltimate();
}

function undoUltimate() {
  if (app.busy) return;
  let s = app.u.state;
  const popped = [];
  for (let guard = 0; guard < 4; guard++) {
    if (!s.history.length) break;
    const prev = U.undo(s);
    if (prev.tag !== "Some") break;
    popped.unshift(s.history[s.history.length - 1]);
    s = prev.value;
    if (!vsEngine()) break;
    if (markOf(s.turn) === app.human) break;
  }
  if (!popped.length) return;
  app.u.state = s;
  app.u.redo = popped.concat(app.u.redo);
  app.u.counted = false;
  renderUltimate();
  saveGame();
}

function redoUltimate() {
  if (app.busy || !app.u.redo.length) return;
  for (let guard = 0; guard < 4; guard++) {
    if (!app.u.redo.length) break;
    const m = app.u.redo[0];
    const res = U.apply_move(app.u.state, m);
    if (res.tag !== "Ok") { app.u.redo = []; break; }
    app.u.redo = app.u.redo.slice(1);
    app.u.state = res.value;
    if (!vsEngine()) break;
    if (markOf(app.u.state.turn) === app.human) break;
  }
  renderUltimate();
  saveGame();
  settleUltimate();
}

// ---------------------------------------------------------------------------
// Classic — the original board, now fed by the worker instead of /api/move
// ---------------------------------------------------------------------------

const CENTER = [60, 160, 260];
const cx = (i) => CENTER[i % 3];
const cy = (i) => CENTER[Math.floor(i / 3)];
let classicDrawn = [];

function classicMark(i, ch, cls) {
  const x = cx(i), y = cy(i), r = 30;
  if (ch === "X") {
    return '<g class="mark x ' + cls + '">' +
      '<path pathLength="1" d="M ' + (x - r) + ' ' + (y - r) + ' L ' + (x + r) + ' ' + (y + r) + '"/>' +
      '<path pathLength="1" d="M ' + (x + r) + ' ' + (y - r) + ' L ' + (x - r) + ' ' + (y + r) + '"/>' +
      "</g>";
  }
  return '<g class="mark o ' + cls + '"><circle pathLength="1" cx="' + x + '" cy="' + y +
    '" r="' + r + '"/></g>';
}

function renderClassic() {
  const svg = $("board");
  const o = cOutcome();
  const line = o.tag === "Win" ? o.line : [];
  let html = '<rect class="slate" x="0.5" y="0.5" width="319" height="319" rx="6"/>';
  for (let i = 1; i <= 2; i++) {
    const p = 10 + i * 100;
    html += '<path class="grid-line" d="M ' + p + " 22 Q " + (p + 2) + " 160 " + p + ' 298"/>';
    html += '<path class="grid-line" d="M 22 ' + p + " Q 160 " + (p - 2) + " 298 " + p + '"/>';
  }
  const showXray = app.c.xray && !cOver() && !app.busy;
  for (let i = 0; i < 9; i++) {
    const ch = app.c.board.charAt(i);
    if (ch === "X" || ch === "O") {
      const fresh = classicDrawn.indexOf(i) < 0;
      if (fresh) classicDrawn.push(i);
      html += classicMark(i, ch, fresh ? "fresh" : "");
    } else if (showXray) {
      const e = app.c.evals.find((v) => v.square === i);
      if (e) {
        const text = e.score > 0 ? "win " + (10 - e.score) : e.score < 0 ? "loss " + (e.score + 10) : "draw";
        const cls = e.score > 0 ? "good" : e.score < 0 ? "bad" : "even";
        html += '<text class="verdict ' + cls + '" x="' + cx(i) + '" y="' + (cy(i) + 5) + '">' + text + "</text>";
      }
    }
  }
  if (line.length === 3) {
    html += '<path class="streak" pathLength="1" d="M ' + cx(line[0]) + " " + cy(line[0]) +
      " L " + cx(line[2]) + " " + cy(line[2]) + '"/>';
  }
  for (let i = 0; i < 9; i++) {
    if (app.c.board.charAt(i) === "." && !cOver() && !app.busy) {
      html += '<rect class="cell" data-i="' + i + '" tabindex="0" role="button" aria-label="square ' +
        (i + 1) + ', empty" x="' + (cx(i) - 50) + '" y="' + (cy(i) - 50) +
        '" width="100" height="100" rx="4"/>';
    }
  }
  svg.innerHTML = html;
  svg.classList.toggle("locked", app.busy || cOver());
  paintStatus();
  paintActions();
}

function classicBoardFrom(history) {
  let b = EMPTY9;
  history.forEach((sq, k) => {
    b = b.slice(0, sq) + (k % 2 === 0 ? "X" : "O") + b.slice(sq + 1);
  });
  return b;
}

async function playClassic(square) {
  if (app.busy || cOver() || app.c.board.charAt(square) !== ".") return;
  app.c.history.push(square);
  app.c.redo = [];
  app.c.board = classicBoardFrom(app.c.history);
  app.c.turn = app.c.turn === "X" ? "O" : "X";
  app.c.evals = [];
  sound.ping(app.c.turn === "X" ? "O" : "X");
  renderClassic();
  saveGame();
  if (settleClassic()) return;
  if (vsEngine()) await engineTurnClassic();
  else if (app.c.xray) refreshXray();
}

async function engineTurnClassic() {
  if (cOver()) return;
  app.busy = true;
  renderClassic();
  const res = await think(app.engine, {
    mode: "classic",
    state: app.c.board,
    turn: app.c.turn,
    level: app.level,
    seed: (app.seed + app.c.history.length * 7919) | 0,
    budgetMs: BUDGET[app.level] || 800,
  });
  app.busy = false;
  const sq = res && res.move && typeof res.move.square === "number" ? res.move.square : -1;
  if (sq < 0 || app.c.board.charAt(sq) !== ".") {
    flashCaption("engine unavailable — " + errorOf(res));
    renderClassic();
    return;
  }
  app.c.history.push(sq);
  app.c.board = classicBoardFrom(app.c.history);
  app.c.turn = app.c.turn === "X" ? "O" : "X";
  sound.ping(app.c.turn === "X" ? "O" : "X");
  renderClassic();
  saveGame();
  if (!settleClassic() && app.c.xray) refreshXray();
}

function settleClassic() {
  const o = cOutcome();
  if (o.tag === "Ongoing") return false;
  if (!app.c.counted) {
    app.c.counted = true;
    if (o.tag === "Draw") recordResult("draw");
    else recordResult(markOf(o.winner) === app.human ? "win" : "loss");
    sound.ping(o.tag === "Draw" ? "place" : markOf(o.winner) === app.human ? "win" : "lose");
  }
  renderClassic();
  return true;
}

function newClassic() {
  app.c.board = EMPTY9;
  app.c.turn = "X";
  app.c.history = [];
  app.c.redo = [];
  app.c.evals = [];
  app.c.counted = false;
  app.busy = false;
  classicDrawn = [];
  renderClassic();
  saveGame();
  if (vsEngine() && app.human === "O") engineTurnClassic();
  else if (app.c.xray) refreshXray();
}

function undoClassic() {
  if (app.busy || !app.c.history.length) return;
  for (let guard = 0; guard < 4; guard++) {
    if (!app.c.history.length) break;
    app.c.redo.unshift(app.c.history.pop());
    if (!vsEngine()) break;
    const turn = app.c.history.length % 2 === 0 ? "X" : "O";
    if (turn === app.human) break;
  }
  app.c.board = classicBoardFrom(app.c.history);
  app.c.turn = app.c.history.length % 2 === 0 ? "X" : "O";
  app.c.counted = false;
  app.c.evals = [];
  classicDrawn = app.c.history.slice();
  renderClassic();
  saveGame();
  if (app.c.xray) refreshXray();
}

function redoClassic() {
  if (app.busy || !app.c.redo.length) return;
  for (let guard = 0; guard < 4; guard++) {
    if (!app.c.redo.length) break;
    app.c.history.push(app.c.redo.shift());
    if (!vsEngine()) break;
    const turn = app.c.history.length % 2 === 0 ? "X" : "O";
    if (turn === app.human) break;
  }
  app.c.board = classicBoardFrom(app.c.history);
  app.c.turn = app.c.history.length % 2 === 0 ? "X" : "O";
  renderClassic();
  saveGame();
  settleClassic();
}

// X-ray reads the engine's per-square verdict, which is a full 3x3 minimax
// per square — ~400 ms, so it can only ever run in the worker. Not every
// worker build exposes it; probe once at boot and hide the control rather
// than offer a button that dies on click.
async function probeXray() {
  const res = await app.engine.evals(EMPTY9, "X");
  app.xrayOk = !!(res && res.type === "result" && Array.isArray(res.value));
  paintActions();
}

async function refreshXray() {
  if (!app.c.xray || cOver()) return;
  const res = await app.engine.evals(app.c.board, app.c.turn);
  if (res && res.type === "result" && Array.isArray(res.value)) {
    app.c.evals = res.value;
  } else {
    app.xrayOk = false;
    app.c.xray = false;
    $("xray").setAttribute("aria-pressed", "false");
  }
  renderClassic();
}

// ---------------------------------------------------------------------------
// shared chrome
// ---------------------------------------------------------------------------

let captionTimer = 0;

function flashCaption(text) {
  const c = $("caption");
  c.textContent = text;
  c.classList.add("alert");
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => {
    c.classList.remove("alert");
    paintStatus();
  }, 2600);
}

function paintStatus() {
  const word = $("statusWord");
  const note = $("statusNote");
  const box = $("status");
  const cap = $("caption");
  let w, n, turn;

  if (app.mode === "ultimate") {
    const out = outcomeOf(app.u.state);
    turn = markOf(app.u.state.turn);
    if (app.busy) {
      w = "Engine thinking";
      n = LEVEL_NAME[app.level] + (app.lastPlan && app.lastPlan.depth ? " · last depth " + app.lastPlan.depth : "");
    } else if (out.status === "drawn") {
      w = "Draw"; n = "nine boards, no line";
    } else if (out.status === "won") {
      const x = U.boards_won(app.u.state, cellOf("X"));
      const o = U.boards_won(app.u.state, cellOf("O"));
      const how = out.line.length === 3 ? "three boards in a row" : "on boards won, " + x + "–" + o;
      w = !vsEngine() ? out.winner + " wins" : out.winner === app.human ? "You win" : "Engine wins";
      n = how;
    } else if (!vsEngine()) {
      w = turn + " to move"; n = "two players";
    } else if (turn === app.human) {
      w = "Your move"; n = "you are " + app.human + " · " + LEVEL_NAME[app.level];
    } else {
      w = "Engine to move"; n = LEVEL_NAME[app.level];
    }
    if (!cap.classList.contains("alert")) cap.textContent = uCaption();
  } else {
    const o = cOutcome();
    turn = app.c.turn;
    if (app.busy) {
      w = "Engine thinking"; n = LEVEL_NAME[app.level] + " · full depth";
    } else if (o.tag === "Draw") {
      w = "Draw"; n = "neither side could force it";
    } else if (o.tag === "Win") {
      const winner = markOf(o.winner);
      w = !vsEngine() ? winner + " wins" : winner === app.human ? "You win" : "Engine wins";
      n = LEVEL_NAME[app.level];
    } else if (!vsEngine()) {
      w = turn + " to move"; n = "two players";
    } else if (turn === app.human) {
      w = "Your move"; n = "you are " + app.human + " · " + LEVEL_NAME[app.level];
    } else {
      w = "Engine to move"; n = LEVEL_NAME[app.level];
    }
    if (!cap.classList.contains("alert")) {
      cap.textContent = app.c.xray && !cOver() ? "engine reading for " + turn + " — plies to the result" : "";
    }
  }

  word.textContent = w;
  note.textContent = n;
  box.classList.toggle("thinking", app.busy);
  box.style.borderLeftColor = turn === "X" ? "var(--x)" : "var(--o)";
  box.dataset.turn = turn === "X" ? "x" : "o";
}

function paintActions() {
  const u = app.mode === "ultimate";
  $("undo").disabled = app.busy || (u ? !app.u.state.history.length : !app.c.history.length);
  $("redo").disabled = app.busy || (u ? !app.u.redo.length : !app.c.redo.length);
  $("xray").hidden = u || !app.xrayOk;
  $("rules").hidden = !u;
}

function paintTally() {
  const rec = store.stats.all()[statKey()] || { w: 0, l: 0, d: 0 };
  $("tallyYou").textContent = rec.w;
  $("tallyCpu").textContent = rec.l;
  $("tallyDraw").textContent = rec.d;
  $("labelYou").textContent = vsEngine() ? "you" : "X wins";
  $("labelCpu").textContent = vsEngine() ? "engine" : "O wins";
  $("tallyScope").textContent = app.mode + " · " + app.level;
}

function paintSegs() {
  for (const b of $("modeSwitch").querySelectorAll("button")) {
    b.setAttribute("aria-selected", b.dataset.mode === app.mode ? "true" : "false");
  }
  for (const b of $("difficulty").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.level === app.level);
  }
  for (const b of $("side").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.side === app.human);
  }
  $("sideField").classList.toggle("off", !vsEngine());
  $("tagline").textContent = app.mode === "ultimate"
    ? "Nine boards inside nine boards"
    : "Nine squares, searched to the last ply";
}

function showMode() {
  $("classicBoard").hidden = app.mode !== "classic";
  $("ultimateBoard").hidden = app.mode !== "ultimate";
  paintSegs();
  paintTally();
  if (app.mode === "ultimate") renderUltimate();
  else renderClassic();
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function wire() {
  $("modeSwitch").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || app.busy) return;
    app.mode = b.dataset.mode;
    saveSettings();
    showMode();
    resumeIfEngineTurn();
  });

  $("difficulty").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || app.busy) return;
    app.level = b.dataset.level;
    saveSettings();
    paintSegs();
    paintTally();
    newGame();
  });

  $("side").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || app.busy) return;
    app.human = b.dataset.side;
    saveSettings();
    paintSegs();
    newGame();
  });

  $("undo").addEventListener("click", () => (app.mode === "ultimate" ? undoUltimate() : undoClassic()));
  $("redo").addEventListener("click", () => (app.mode === "ultimate" ? redoUltimate() : redoClassic()));
  $("newGame").addEventListener("click", newGame);
  $("rules").addEventListener("click", () => $("rulesPanel").showModal());

  $("sound").addEventListener("click", (ev) => {
    sound.on = !sound.on;
    ev.currentTarget.setAttribute("aria-pressed", sound.on ? "true" : "false");
    saveSettings();
    if (sound.on) sound.ping("place");
  });

  $("xray").addEventListener("click", (ev) => {
    app.c.xray = !app.c.xray;
    ev.currentTarget.setAttribute("aria-pressed", app.c.xray ? "true" : "false");
    if (app.c.xray) refreshXray();
    else renderClassic();
  });

  $("resetAll").addEventListener("click", () => {
    if (!window.confirm("Delete saved games, stats and settings?")) return;
    store.resetAll();
    location.reload();
  });

  const svg = $("board");
  svg.addEventListener("click", (ev) => {
    const cell = ev.target.closest(".cell");
    if (cell) playClassic(Number(cell.dataset.i));
  });
  svg.addEventListener("keydown", (ev) => {
    const cell = ev.target.closest(".cell");
    if (cell && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      playClassic(Number(cell.dataset.i));
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.target.closest("input, textarea, dialog")) return;
    const k = ev.key.toLowerCase();
    // `r` throws the position away, and undo cannot bring it back. A stray
    // keystroke must not cost someone a game in progress, so mid-game it asks
    // first; once the game is over there is nothing to lose.
    if (k === "r") {
      const inPlay = app.mode === "ultimate"
        ? (!uOver() && app.u.state.history.length > 0)
        : (!cOver() && app.c.board.indexOf("X") + app.c.board.indexOf("O") > -2);
      if (!inPlay || confirm("Start a new game? The current one is lost.")) newGame();
      return;
    }
    if (k === "u") { app.mode === "ultimate" ? undoUltimate() : undoClassic(); return; }
    if (k === "y") { app.mode === "ultimate" ? redoUltimate() : redoClassic(); return; }
    if (k === "m") { $("sound").click(); return; }
    if (k === "?" || k === "h") { if (app.mode === "ultimate") $("rulesPanel").showModal(); return; }
    if (k === "x" && app.mode === "classic") { $("xray").click(); return; }
    if (app.mode === "classic" && k >= "1" && k <= "9") playClassic(Number(k) - 1);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveGame();
  });
}

function newGame() {
  if (app.mode === "ultimate") newUltimate();
  else newClassic();
}

function resumeIfEngineTurn() {
  if (!vsEngine() || app.busy) return;
  if (app.mode === "ultimate") {
    if (!uOver() && markOf(app.u.state.turn) !== app.human) engineTurnUltimate();
  } else if (!cOver() && app.c.turn !== app.human) {
    engineTurnClassic();
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function restore() {
  const s = store.settings.get();
  app.mode = s.mode === "classic" ? "classic" : "ultimate";
  app.level = LEVEL_NAME[s.difficulty] ? s.difficulty : "medium";
  app.human = s.first === "O" ? "O" : "X";
  app.seed = typeof s.seed === "number" ? s.seed : 918273;
  sound.on = !!s.sound;
  $("sound").setAttribute("aria-pressed", sound.on ? "true" : "false");

  const ug = store.game.load("ultimate");
  if (ug && typeof ug.save === "string") {
    const d = U.decode(ug.save);
    if (d.tag === "Ok") {
      app.u.state = d.value;
      app.u.redo = movesOf(typeof ug.redo === "string" ? ug.redo : "");
      app.u.counted = outcomeOf(d.value).status !== "playing";
      if (typeof ug.human === "string") app.human = ug.human === "O" ? "O" : "X";
      if (LEVEL_NAME[ug.difficulty]) app.level = ug.difficulty;
    } else {
      store.game.clear("ultimate");
    }
  }

  const cg = store.game.load("classic");
  if (cg && typeof cg.history === "string") {
    app.c.history = cg.history.split("").map(Number).filter((n) => n >= 0 && n <= 8);
    app.c.redo = (typeof cg.redo === "string" ? cg.redo : "").split("").map(Number).filter((n) => n >= 0 && n <= 8);
    app.c.board = classicBoardFrom(app.c.history);
    app.c.turn = app.c.history.length % 2 === 0 ? "X" : "O";
    app.c.counted = cOver();
    classicDrawn = app.c.history.slice();
  }
}

async function boot() {
  ultimate = mountUltimate($("ultimateBoard"), { onPlay: playUltimate });
  restore();
  wire();
  showMode();

  app.engine = await connectEngine();
  $("credit").innerHTML =
    "engine &amp; search in Glyph<br>" +
    (app.engine.kind === "fallback"
      ? "<b>no worker — reduced opponent</b>"
      : "thinking in a web worker");
  if (store.degraded) flashCaption("storage unavailable — progress will not be saved");
  resumeIfEngineTurn();
  probeXray();
}

boot();
