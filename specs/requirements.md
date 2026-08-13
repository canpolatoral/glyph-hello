# Ultimate Tic Tac Toe — requirements (source of truth)

These are the customer's requirements, verbatim, followed by the decisions taken
before the build started. Every spec, test and module traces back to an ID here.
If an implementation disagrees with this file, this file wins.

## Decisions taken up front

- **D-1 Engine language: Glyph, compiled to JS.** The Ultimate engine and AI are
  written in Glyph as pure modules, compiled with `glyph build`, and loaded into
  a Web Worker. Verified feasible: the stdlib modules the engine needs
  (`array`, `option`, `string`, `result`, `schema`) and `glyph-bootstrap` contain
  no `node:` imports and no `process` use, so they run in a browser realm. The
  emitted code uses bare `std/*` specifiers that a build step must rewrite.
- **D-2 No backend.** G-4 holds: the game is fully client-side. The existing
  Glyph `std/http` server stays as a static file server for local development
  only; nothing at runtime depends on it.
- **D-3 Variants (FR-2.3) are out of scope for v1.** Classic + Ultimate, done
  properly. Variants land later on a proven engine.
- **D-4 The existing Classic 3x3 engine (`src/xox.glyph`) is preserved** and
  becomes "Easy / Classic" (G-3). Its public API and passing `@example` tests
  must not regress.

## 1. Scope & goals

- **G-1** Ship a game with genuine strategic depth (branching factor and game
  length well beyond 3x3).
- **G-2** Support human vs. AI with at least 3 meaningfully different difficulty
  levels.
- **G-3** Keep the existing classic 3x3 mode playable as "Easy / Classic."
- **G-4** Runs entirely client-side, no build-server dependency.

## 2. Game modes

- **FR-2.1** Classic 3x3 — existing behavior, preserved.
- **FR-2.2** Ultimate Tic Tac Toe (primary new mode)
  - 9 mini-boards arranged in a 3x3 meta-grid.
  - A move in cell (r,c) of any mini-board forces the opponent to play in
    mini-board (r,c).
  - If the forced mini-board is already won or full, the opponent may play in any
    open board ("free move").
  - Winning a mini-board claims that cell on the meta-grid; 3 claimed cells in a
    row wins the game.
  - Define and implement a tiebreak rule for a full meta-grid with no line
    (recommended: most mini-boards won, else draw).
  - Drawn mini-boards count as neutral — cannot be claimed by either player.
- **FR-2.3** Variant modules (pick 1–2, optional) — **deferred, see D-3.**

## 3. Rules engine

- **FR-3.1** Engine must be a pure module with no DOM access — same code drives
  UI and AI.
- **FR-3.2** Expose: `getLegalMoves(state)`, `applyMove(state, move)`,
  `getWinner(state)`, `isTerminal(state)`.
- **FR-3.3** State objects are immutable or cheaply cloneable (AI search will
  copy thousands of times).
- **FR-3.4** Illegal moves are rejected by the engine, not just hidden by the UI.
- **FR-3.5** Full move history retained to support undo and replay.

## 4. AI opponent

- **FR-4.1** Classic mode: minimax with alpha-beta pruning, full-depth (trivial
  at 3x3).
- **FR-4.2** Ultimate mode: depth-limited minimax with alpha-beta plus a
  heuristic evaluation, or MCTS. Suggested heuristic weights: mini-boards won >
  center mini-board > mini-board center cells > two-in-a-row threats, minus a
  penalty for handing the opponent a free move.
- **FR-4.3** Difficulty levels:
  - Easy — random legal move with occasional blocking.
  - Medium — shallow search (depth 2–4) with deliberate error rate (~15%).
  - Hard — full time budget, no intentional errors.
- **FR-4.4** AI runs in a Web Worker. The main thread must never block.
- **FR-4.5** Hard time budget per move (e.g. 1500 ms) with iterative deepening so
  it always returns a legal move.
- **FR-4.6** Minimum "thinking" delay (~300 ms) even for instant moves, so play
  feels natural.

## 5. UI / UX

- **UI-5.1** Legal moves are visually highlighted; illegal boards dimmed or
  blocked.
- **UI-5.2** The forced mini-board is unmistakable at a glance — this is the #1
  source of confusion for new Ultimate players.
- **UI-5.3** Won mini-boards render a large overlaid X/O while keeping underlying
  cells visible.
- **UI-5.4** Clear turn indicator, win/draw announcement, and rematch button.
- **UI-5.5** Undo (and redo) using move history.
- **UI-5.6** In-game rules panel for Ultimate mode.
- **UI-5.7** Move animations and a subtle winning-line highlight.
- **UI-5.8** Responsive down to ~360 px wide; touch targets >= 44 px.
- **UI-5.9** Keyboard navigation (arrows + Enter) and ARIA labels announcing cell
  coordinates and board state.
- **UI-5.10** Optional sound with a mute toggle, off by default.

## 6. Persistence & stats

- **FR-6.1** Auto-save in-progress game; restore on reload.
- **FR-6.2** Track wins/losses/draws per mode and per difficulty.
- **FR-6.3** Settings persist: difficulty, sound, theme, who moves first.
- **FR-6.4** Reset-all-data control.

## 7. Non-functional

- **NFR-7.1** First interaction under 1 s on mid-range mobile.
- **NFR-7.2** 60 fps during animations.
- **NFR-7.3** Engine covered by unit tests, including known Ultimate edge cases
  (free move on a drawn board, win-on-last-cell, forced-board chains).
- **NFR-7.4** Latest two versions of Chrome, Firefox, Safari, Edge.

## 8. Stretch (not in v1)

- **S-8.1** Local two-player pass-and-play.
- **S-8.2** Online multiplayer via WebRTC or a small WebSocket relay.
- **S-8.3** Hint button surfacing the AI's top move.
- **S-8.4** Post-game analysis showing evaluation swings per move.
- **S-8.5** Shareable game codes encoding the full move list.
- **S-8.6** Daily puzzle: a fixed position to win in N moves.

## Existing code the build must respect

- `src/xox.glyph` — Classic engine: `Cell`/`Board`/`Outcome`/`Level` types,
  `outcome`, `choose_move`, `evaluate`, `from_text`/`to_text`, 14 passing
  `@example` tests. Preserve behaviour and tests.
- `src/web.glyph` — static file server + `/api/move` (Classic). Dev only.
- `src/cli.glyph` — terminal Classic game. Keep working.
- `assets/index.html`, `assets/xox.css`, `assets/xox.js` — current Classic UI.
- Language notes: Glyph has no `if`/`else` (only `match`, every arm ends with a
  trailing comma), mutation is the `mut` statement prefix, no object-literal
  shorthand, `bool` not `boolean`. Run `glyph llms` for the full reference and
  `glyph --explain <CODE>` for any diagnostic.
