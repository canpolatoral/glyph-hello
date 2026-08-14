# Ultimate Tic Tac Toe — specification of record (Classic + Ultimate)

Status: **authoritative for v1**. Scope: Classic (preserved) + Ultimate.
Variants (FR-2.3) are out of scope per **D-3**.

`specs/requirements.md` is the source of truth for *what* is built; this file is
the source of truth for *how it is shaped*. Where the requirements say
"recommended", "e.g." or "or", this file **chooses**, and the choice is recorded
in §11 with a one-line rationale. If code disagrees with this file, this file
wins; if this file disagrees with `specs/requirements.md`, that file wins.

Every section carries requirement ids. Section 10 is the numbered acceptance
criteria list (AC-1 … AC-47) that becomes the test matrix.

---

## 1. Module layout, language rules, browser safety

### 1.1 Files

| File | Module | Role | Status |
|---|---|---|---|
| `src/xox.glyph` | `xox` | Classic 3x3 engine + Classic AI | **frozen** (D-4): public API and its 14 `@example`s must not change |
| `src/ultimate.glyph` | `ultimate` | Ultimate rules engine (pure) | new |
| `src/ai.glyph` | `ai` | Difficulty ladder for **both** modes | new |
| `assets/worker.js` | — | Web Worker shim: JS-named boundary over the compiled engine | new, hand-written JS |
| `tools/bundle.mjs` | — | Build step: compile `src` → JS and rewrite bare `std/*` specifiers (D-1) | new |
| `src/web.glyph`, `src/cli.glyph` | — | dev-only server / terminal Classic game | unchanged, must keep compiling |

`ai` hosts both ladders so the worker has exactly one entry point for "pick a
move", regardless of mode.

### 1.2 Hard browser-safety rule (blocking)

`ultimate` and `ai` run inside a Web Worker. They may import **only**:

```
std/array   std/option   std/string   std/result   std/math   std/time
```

and the project module `xox` (which itself imports only `std/array`,
`std/option`, `std/string`). They must **never** import `std/io`, `std/fs`,
`std/process`, `std/http`, `std/sqlite`, and must never reference `document`,
`window`, `self`, or `postMessage`. Verified against the emitted runtime: the
`.glyph-runtime/std/{array,option,result,string,schema,math,time}.ts` files and
`glyph-bootstrap.ts` contain no `node:` import and no `process` use;
`glyph-bootstrap` only installs prelude helpers onto `globalThis`. This is what
makes D-1 true in practice, and AC-14 (source) / AC-41 (built bundle) keep it
true.

`glyph build` emits bare `std/*` specifiers plus a relative
`./.glyph-runtime/glyph-bootstrap` import and materialises the whole stdlib under
`<out>/.glyph-runtime/std/`. `tools/bundle.mjs` must rewrite `std/*` →
`./.glyph-runtime/std/*` **in the emitted modules and inside
`.glyph-runtime/std/*` itself** (at least one stdlib file imports a bare
`std/result`), so the worker loads with no bundler-resolution magic and no
network fetch.

### 1.3 Language rules that shape the design

- No `if`/`else`. Every branch is a `match`, every arm ends with a trailing comma.
- Mutation only via the `mut` statement prefix. The engine uses **none**: every
  engine function is pure and allocation-based (§2.4).
- No object-literal shorthand: `{ board: board, cell: cell }`.
- `bool`, not `boolean`. Tail expression is the return value.
- Tests are `@example <expr> == <expr>` above a function and run on every
  `glyph check` / `glyph build`.
- Gotcha to respect: a name used **only** inside an `@example` still trips the
  E0106 unused-import warning. Keep imports referenced from real code.
- Gotcha to respect: `ultimate` must not name-import `xox`'s `Outcome` variants
  (`Ongoing`/`Draw`/`Win`) — its own outcome variants would collide (E0100). It
  imports `xox { Cell, Empty, X, O }` for constructors and uses the namespace
  form (`xox.same`, `xox.other`, `xox.is_empty`, `xox.mark`, `xox.win_lines`) for
  everything else.

---

## 2. Domain model (FR-3.3, FR-3.5)

### 2.1 Indexing — one convention, used everywhere

- Mini-boards are numbered `b ∈ 0..8`, **row-major on the meta-grid**: `b = 3*R + C`.
- Cells inside a mini-board are numbered `i ∈ 0..8`, **row-major**: `i = 3*r + c`.
- The 81 cells live in one flat array: `cells[b * 9 + i]`.
- Because both numberings are row-major over the same 3x3 shape, **the forced
  mini-board index is exactly the cell index of the move just played**:
  a move at cell `(r,c)` forces mini-board `3*r + c = i`. No coordinate maths
  anywhere in the engine (D-U1).

### 2.2 Types

```glyph
module ultimate

import std/array
import std/option { Option, Some, None }
import std/result { Result, Ok, Err }
import std/string
import xox { Cell, Empty, X, O }
import xox

// Status of one mini-board. `line` is the winning triple of cell indices
// (0..8) inside that mini-board, for UI-5.3 / UI-5.7.
pub type MiniStatus =
  | MiniOpen
  | MiniWon({ winner: Cell, line: Array<number> })
  | MiniDrawn

// Status of the whole game. `line` is the winning triple of MINI-BOARD
// indices (0..8); it is the empty array for a tiebreak win (§4.6).
pub type UOutcome =
  | Playing
  | Drawn
  | Won({ winner: Cell, line: Array<number> })

// A move: which mini-board, which cell inside it.
pub type Move = { board: number, cell: number }

// Why a move was refused (FR-3.4). Every rejection names the offending
// coordinates so the UI can explain itself.
pub type MoveError =
  | GameOver
  | OutOfRange({ board: number, cell: number })
  | WrongBoard({ required: number, got: number })
  | BoardClosed({ board: number })
  | CellTaken({ board: number, cell: number })

// The whole game state. See §2.3 for the invariants and §2.4 for why this
// shape is what the AI copies.
pub type UState = {
  // 81 cells, cells[b * 9 + i]. Reuses xox.Cell (Empty | X | O).
  cells: Array<Cell>,
  // 9 entries, derived from `cells`, cached. boards[b] is b's status.
  boards: Array<MiniStatus>,
  // The mini-board the side to move MUST play in. None = free move.
  forced: Option<number>,
  // Whose turn it is: X or O, never Empty.
  turn: Cell,
  // Every move played, oldest first (FR-3.5).
  history: Array<Move>,
}
```

`Cell` is reused from `xox` deliberately: `xox.same`, `xox.other`,
`xox.is_empty`, `xox.mark` and `xox.win_lines` all apply unchanged to a
mini-board, so the Ultimate engine adds rules, not a second vocabulary — and
`xox`'s public API is untouched (D-4).

### 2.3 Invariants (each is an assertion the tests may check)

- **I-1** `array.len(cells) == 81`, `array.len(boards) == 9`.
- **I-2** `boards[b]` is exactly what recomputing status from
  `cells[b*9 .. b*9+8]` would give (the cache is never stale).
- **I-3** `turn` is `X` or `O`, never `Empty`.
- **I-4** `forced == Some(b)` **implies** `is_open(state, b)`. A forced board is
  never a closed board — normalisation happens on *write*, in `apply_move`
  (D-U3), so `legal_moves` needs no re-derivation and UI-5.2 can highlight
  `state.forced` directly.
- **I-5** `array.len(history) == ` the number of non-`Empty` cells.
- **I-6** No rules function ever reads `history`. Ultimate is Markovian:
  everything the rules need is in `cells`, `boards`, `forced`, `turn`. This
  invariant is what makes §2.4's search trick sound.
- **I-7** `is_terminal(state) == (array.len(legal_moves(state)) == 0)`.

### 2.4 Cheap cloning (FR-3.3) — the representation argument

The AI copies state thousands of times per move, so the cost of one
`apply_move` is the number that matters.

`UState` is a flat record of 3 array references + 1 `Option` + 1 `Cell`
reference. `apply_move` returns a **new record with structural sharing**:

| Field | Cost per applied move |
|---|---|
| `cells` | one 81-element array of *pointers* (`Cell` variants `Empty`/`X`/`O` are module-level singletons in the emitted JS, so no cell object is allocated — only the array) |
| `boards` | one 9-element array; only the touched entry differs |
| `forced` | one `Option` allocation (or the shared `None`) |
| `turn` | pointer copy of a singleton |
| `history` | `array.push` → a new array, `n+1` pointers |

So one ply ≈ **3 small array allocations and ~91 + n pointer copies**, no deep
copy of any cell object, no `structuredClone`, no serialisation.

**Why not the alternatives.**
- *An 81-char `string` (the `xox.from_text` idiom).* Free to copy, but every
  cell read in the hot loop allocates a 1-char string (`string.slice`), and the
  search does far more reads than writes. Rejected for the engine; kept as the
  *serialisation* form only (§7).
- *Mutable array + undo stack.* Fastest in principle, but Glyph's `mut` on a
  shared array makes every caller (UI, worker, persistence) a potential aliasing
  bug, and FR-3.3 asks for immutable-or-cheap. Rejected.
- *Recomputing `boards` on demand.* 9 boards × 8 lines × 3 reads = 216 reads per
  node, on every `legal_moves`/`outcome` call. Caching `boards` costs 9 pointers
  per ply and turns those calls into O(9). Kept.

**The `history` caveat, resolved.** `array.push` is O(n), and `n` reaches 81 in a
real game — that would make search copies grow with game length for data the
rules never read. Resolution (D-U5): `ai.choose` calls `search_root(state)` once,
which returns a state identical in every rules-relevant field but with
`history: []`. Because of **I-6** the search is unaffected, and inside the search
`history` never exceeds the search depth (≤ ~12 entries). There is exactly **one**
`apply_move`, so the rules cannot drift between UI and AI.

---

## 3. The four contracts (FR-3.2)

Glyph is snake_case; the worker boundary (`assets/worker.js`) exposes the JS
names FR-3.2 names verbatim. The boundary is a thin adapter: it renames, it
converts to/from the wire form (§7), and it does nothing else.

| Glyph (module `ultimate`) | JS name at the worker boundary | Returns |
|---|---|---|
| `legal_moves(s: UState) -> Array<Move>` | `getLegalMoves(state)` | `Array<{board, cell}>` |
| `apply_move(s: UState, m: Move) -> Result<UState, MoveError>` | `applyMove(state, move)` | `{ok:true, state} \| {ok:false, error:{code, ...}}` |
| `winner(s: UState) -> Option<Cell>` | `getWinner(state)` | `"X" \| "O" \| null` |
| `is_terminal(s: UState) -> bool` | `isTerminal(state)` | `boolean` |

### 3.1 `legal_moves`

```glyph
pub fn legal_moves(s: UState) -> Array<Move>
```

- Returns `[]` when `is_terminal(s)` — **including** when open boards remain
  because the meta-grid is already won. (I-7.)
- Otherwise: when `s.forced == Some(b)`, every empty cell of board `b`; when
  `s.forced == None`, every empty cell of every **open** board.
- A board is open iff `boards[b] == MiniOpen`. Cells of won or drawn boards are
  never legal (§4.3).
- **Order is normative**: ascending by `board`, then ascending by `cell`. The AI's
  tie-breaks and every `@example` depend on it.
- Pure; allocates one array; no state is read that is not in `UState`.

### 3.2 `apply_move` — rejects, never silently no-ops (FR-3.4)

```glyph
pub fn apply_move(s: UState, m: Move) -> Result<UState, MoveError>
```

Checks run **in this order** and the first failure is returned (the order is
normative so error messages are predictable):

1. `is_terminal(s)` → `Err(GameOver)`
2. `m.board`/`m.cell` outside `0..8` → `Err(OutOfRange({ board: m.board, cell: m.cell }))`
3. `s.forced == Some(b) && m.board != b` → `Err(WrongBoard({ required: b, got: m.board }))`
4. `boards[m.board] != MiniOpen` → `Err(BoardClosed({ board: m.board }))`
5. cell not `Empty` → `Err(CellTaken({ board: m.board, cell: m.cell }))`

On success it returns `Ok(next)` where `next`:

- has `cells` with `cells[m.board*9 + m.cell] = s.turn`,
- has `boards[m.board]` recomputed (only that entry can change),
- has `turn = xox.other(s.turn)`,
- has `history = array.push(s.history, m)`,
- has `forced = Some(m.cell)` **if** the post-move status of board `m.cell` is
  `MiniOpen`, else `None` (I-4, D-U3). Note the status used is the *post-move*
  one, which matters when `m.cell == m.board` (§5, E-6).

`Err` returns the input untouched: `apply_move` never mutates `s` (there is no
`mut` in the module at all). Returning `Result` rather than `Option<UState>` is
deliberate — the UI must be able to say *why* (UI-5.1, UI-5.6).

### 3.3 `winner` and `outcome`

```glyph
pub fn outcome(s: UState) -> UOutcome        // the rich form the UI uses
pub fn winner(s: UState) -> Option<Cell>     // the FR-3.2 contract
```

`winner` is defined as `match outcome(s) { Won(w) => Some(w.winner), Drawn => None, Playing => None, }`.
`winner` alone cannot distinguish draw from in-progress; the UI uses `outcome`
(UI-5.4) and `is_terminal`. The worker exposes both (`getWinner`, `getOutcome`).

`outcome` is computed from `boards` only:

1. Scan `xox.win_lines` **in order**; the first line whose three boards are all
   `MiniWon` by the same mark → `Won({ winner: that mark, line: that triple })`.
2. Else, if any board is `MiniOpen` → `Playing`.
3. Else (all 9 closed, no line) → the tiebreak of §4.6.

### 3.4 `is_terminal`

```glyph
pub fn is_terminal(s: UState) -> bool
```

`match outcome(s) { Playing => false, Drawn => true, Won(_w) => true, }`.
Equivalent to "no legal moves" (I-7): with no meta line, `Playing` holds exactly
while some board is open, and an open board has at least one empty cell (§4.3).

### 3.5 Rest of the engine API (non-normative for FR-3.2, normative here)

```glyph
pub fn new_game(first: Cell) -> UState                       // 81 Empty, forced None, turn = first
pub fn is_open(s: UState, b: number) -> bool                 // boards[b] == MiniOpen
pub fn mini_status(s: UState, b: number) -> MiniStatus
pub fn cell_at(s: UState, b: number, i: number) -> Cell
pub fn playable_boards(s: UState) -> Array<number>           // UI-5.1 / UI-5.2 dimming
pub fn boards_won(s: UState, who: Cell) -> number            // tiebreak + heuristic
pub fn undo(s: UState) -> Option<UState>                     // UI-5.5; None at the root
pub fn replay(first: Cell, moves: Array<Move>) -> Result<UState, MoveError>
pub fn encode(s: UState) -> string                           // §7
pub fn decode(text: string) -> Result<UState, string>        // §7
pub fn state_from_text(cells: string, forced: Option<number>, turn: Cell) -> UState   // tests/fixtures
pub fn state_to_text(s: UState) -> string
pub fn render(s: UState) -> string                           // debug/CLI only, no DOM
```

`undo(s)` is defined as `replay(first_player(s), history minus its last entry)`
— one implementation of the rules, no inverse-move logic. `first_player(s)` is
derivable: `turn` when `array.len(history)` is even, else `xox.other(turn)`.

`state_from_text` is the fixture builder that makes acceptance criteria writable
as `@example` lines. It mirrors `xox.from_text`'s leniency: `/` separators are
stripped, the string is padded/truncated to 81 chars, and anything that is not
`X`/`O` is `Empty`. It **derives `boards` from the cells** and **normalises
`forced`** (I-4), so a fixture cannot express an impossible state.

---

## 4. Ultimate rules (FR-2.2) — normative statements

- **R-1 (forced board).** After a move at `(board b, cell i)`, the opponent must
  play in mini-board `i` — the mini-board whose meta-position matches the cell's
  position inside its board (§2.1).
- **R-2 (free move).** If mini-board `i` is not open at that moment — it is won
  (`MiniWon`) or full (`MiniDrawn`) — the opponent may play in **any** open
  board. This is stored as `forced = None`, decided at apply time (D-U3).
- **R-3 (closed boards are closed).** A won or drawn mini-board is permanently
  closed. Its remaining empty cells are dead: they never appear in
  `legal_moves`, and a move into them is `Err(BoardClosed)`. (Some published
  rulesets allow play into a won board; we do not — D-U2.)
- **R-4 (mini-board status).** After each move, the touched board's status is
  recomputed: the first line of `xox.win_lines` held entirely by one mark →
  `MiniWon({ winner, line })`; else, no empty cell left → `MiniDrawn`; else
  `MiniOpen`. Win is tested **before** fullness, so a move that fills the last
  cell *and* completes a line yields `MiniWon`, never `MiniDrawn` (§5, E-2).
- **R-5 (claiming a meta cell).** `MiniWon({winner: m})` claims meta cell `b` for
  `m`. There is no other way to claim a meta cell, and a claim is never revoked.
- **R-6 (drawn boards are neutral).** `MiniDrawn` is claimable by nobody. It
  counts toward neither player in any meta line, and toward neither player's
  tiebreak tally. It *does* count toward the meta-grid being full (§4.6).
- **R-7 (meta win).** Three meta cells claimed by the same mark on one of
  `xox.win_lines` wins the game immediately. The game ends at once: `is_terminal`
  is true and `legal_moves` is `[]` even though open boards remain.
- **R-8 (turn order).** X and O alternate strictly. `new_game(first)` sets the
  first mover; `first` is a setting (FR-6.3) and defaults to `X`.
- **R-9 (first move).** `history == []`, `forced == None`, all 81 cells legal.
- **R-10 (no passing).** A player with legal moves must move; a player with no
  legal moves is in a terminal position (I-7), never stalemated mid-game.

### 4.6 Tiebreak for a full meta-grid with no line (FR-2.2, D-U4)

**"Full" means: every one of the 9 mini-boards is closed** — `MiniWon` or
`MiniDrawn`. Drawn boards count toward fullness (they can never be claimed, so
waiting for them is not a thing), but toward neither tally. Equivalently: full ⟺
`legal_moves(s) == []` with no meta line.

Then:

- `boards_won(s, X) > boards_won(s, O)` → `Won({ winner: X, line: [] })`
- `boards_won(s, O) > boards_won(s, X)` → `Won({ winner: O, line: [] })`
- equal → `Drawn`

`line: []` is the marker for "won on count, not on a line": UI-5.7 draws the
winning-line highlight only when `array.len(line) == 3`, and UI-5.4 announces
"X wins on boards won, 4–3". A tiebreak win is a real win for FR-6.2 stats.

---

## 5. Edge cases — exhaustive enumeration

Each is a required test (NFR-7.3) and maps to an AC in §10.

- **E-1 First move.** `new_game(X)`: `forced == None`, 81 legal moves, all 9
  boards playable, `outcome == Playing`. → AC-1, AC-2
- **E-2 Win on the last cell of a mini-board.** The move both fills the board's
  last empty cell and completes a line → `MiniWon`, **not** `MiniDrawn` (R-4).
  The meta cell is claimed. → AC-26
- **E-3 Free move on a drawn board.** The forced target is `MiniDrawn` → 
  `forced = None`; legal moves span every open board and exclude every cell of
  the drawn board and of every won board. → AC-17, AC-30
- **E-4 Forced board won but not full.** The forced target is `MiniWon` with
  empty cells remaining → `forced = None` (free move); those empty cells are
  never legal (R-3). → AC-16, AC-21
- **E-5 Forced-board chain.** A run of moves each landing on cell `i` of the
  board it was sent to, with each target open: `forced` tracks the previous
  move's `cell` at every step, and each intermediate state has exactly the empty
  cells of one board as its legal moves. → AC-28
- **E-6 Self-pointing forced board.** The move is at `(b, b)` — the cell whose
  position points back at its own board. Two sub-cases, and only the *post-move*
  status decides between them: if the move closes board `b` (wins it or fills
  it), `forced == None`; if board `b` is still open, `forced == Some(b)` and the
  opponent replies inside the same board. This is the only case where a move can
  close the very board it points at, and it is why normalisation must run after
  the status recompute, not before. → AC-29
- **E-7 A move that simultaneously fills a mini-board and wins the meta.** The
  move completes a mini-board line (claiming the meta cell) *and* that claim
  completes a meta line: `outcome == Won`, `is_terminal == true`,
  `legal_moves == []`, and any further `apply_move` is `Err(GameOver)` — even
  though the pointed-to board is open. The winning state's `forced` is whatever
  normalisation produced; it is meaningless once terminal and the UI must not
  highlight a forced board on a terminal state. → AC-27, AC-8
- **E-8 Terminal by exhaustion, tiebreak win.** All 9 boards closed, no meta
  line, unequal tallies → `Won({winner, line: []})`. → AC-22
- **E-9 Terminal by exhaustion, true draw.** All 9 closed, no line, equal
  tallies (e.g. 3–3 with 3 drawn, or 0–0 with 9 drawn) → `Drawn`. → AC-23
- **E-10 Illegal: wrong board while forced.** → `Err(WrongBoard)`. → AC-4
- **E-11 Illegal: occupied cell in the correct board.** → `Err(CellTaken)`. → AC-5
- **E-12 Illegal: out-of-range index** (`-1`, `9`, non-integer coordinates from
  the wire). → `Err(OutOfRange)`. → AC-6
- **E-13 Illegal: closed board on a free move.** → `Err(BoardClosed)`. → AC-7
- **E-14 Illegal: any move on a terminal state.** → `Err(GameOver)`. → AC-8
- **E-15 Undo to the root.** `undo(new_game(X)) == None`; undo after `n` moves
  reproduces the state after `n-1` (AC-11), and redo is re-applying the dropped
  move (UI-5.5 keeps the redo tail; the engine has no redo concept).
- **E-16 Full-length game.** A game where all 81 cells fill with no meta line
  exercises R-6 and §4.6 together; `array.len(history) == 81`. → AC-25
- **E-17 Both marks show a line in one hand-built mini-board fixture.** Only
  reachable via `state_from_text`. Resolution: first line in `xox.win_lines`
  order wins, mirroring `xox.outcome`. Fixtures must avoid it; the rule exists so
  the function is total. → AC-24 (determinism)

---

## 6. AI (FR-4.1 – FR-4.6)

```glyph
module ai

pub type Difficulty =
  | Easy
  | Medium
  | Hard

pub type Plan = {
  move: ultimate.Move,
  score: number,
  depth: number,     // deepest fully-completed ply
  nodes: number,     // nodes visited, for AC-36 / telemetry
}

pub fn choose(s: UState, d: Difficulty, seed: number, budget_ms: number) -> Option<Plan>
pub fn evaluate(s: UState, me: Cell) -> number
pub fn classic_choose(b: xox.Board, me: Cell, d: Difficulty) -> Option<number>
pub fn difficulty_from(text: string) -> Difficulty      // "easy" | "medium" | else Hard
```

`choose` returns `None` **only** for a terminal state. Everything else returns
`Some(plan)` with a legal move.

### 6.1 Determinism and the PRNG

No `std/random`, no ambient RNG: `choose` takes an explicit `seed`, so
`(state, difficulty, seed, budget)` → same move, always (except for the
budget-dependent depth of Hard, see 6.5). The UI supplies a seed; replays and
tests supply a fixed one.

The generator is MINSTD: `seed_next(x) = (x * 48271) % 2147483647`.
**This multiplier is normative**: `48271 * 2147483646 ≈ 1.04e14 < 2^53`, so it is
exact in JS `number`. The commonly copied `1103515245` multiplier is not, and
would silently degenerate.

### 6.2 Easy (FR-4.3: "random legal move with occasional blocking")

Decided (D-A1), in order:

1. If some legal move wins the **game** outright, play the lowest-indexed such move.
2. Else, draw `r = rand_below(seed, 100)`; if `r < 35` and some legal move
   prevents the opponent from claiming a meta cell on their immediate reply,
   play the lowest-indexed such blocking move.
3. Else play a uniformly random legal move (`legal_moves[rand_below(seed', n)]`).

No search. "Occasional" is pinned to **35%** so AC-32/AC-31 are checkable.

### 6.3 Medium (FR-4.3: "shallow search (depth 2–4), ~15% error rate")

Depth-limited alpha-beta at **depth 3** (D-A2: odd depth so the search ends on
the opponent's reply and Medium does not hang pieces), heuristic eval at the
horizon. Then the deliberate error: draw `r = rand_below(seed, 100)`; if
`r < 15` **and** more than one legal move exists, play a uniformly random legal
move **other than** the search's best; else play the best. Error rate is exactly
15% by construction (AC-34).

### 6.4 Hard (FR-4.3, FR-4.5)

Iterative deepening alpha-beta, from depth 1 upward, default budget **1500 ms**,
hard cap depth 12. The depth-1 result is computed before any clock check, so a
legal move always exists to return (FR-4.5). A ply that runs out of budget is
**discarded entirely** and the previous completed ply's move is returned —
never a half-searched ply. No deliberate error.

Clock: `time.now()` from `std/time` (browser-safe), compared against
`deadline = start + budget_ms`. Checked on entry to any node with remaining
depth ≥ 2 (not at leaves, where the check would cost more than the node).

### 6.5 Heuristic evaluation (FR-4.2 — weights decided, D-A3)

`evaluate(s, me)` returns a score from `me`'s point of view and is
**antisymmetric**: `evaluate(s, X) == -evaluate(s, O)` (AC-37).

Terminal states short-circuit: `+1_000_000 - ply` for a win by `me`,
`-1_000_000 + ply` for a loss, `0` for a draw. The `ply` term makes the engine
prefer winning sooner and losing later — the same trick `xox.terminal_score`
uses.

Otherwise the sum of:

| Term | Weight (per occurrence, signed for `me`) |
|---|---|
| Mini-board won | **+100** |
| Mini-board won, board 4 (the centre board) | **+40** extra |
| Meta two-in-a-row with the third meta cell still open | **+60** |
| Meta two-in-a-row blocked by an opponent claim or a drawn board | **0** |
| Centre cell (index 4) of an open mini-board | **+8** |
| Two-in-a-row inside an open mini-board with its third cell empty | **+5** |
| Corner cell of an open mini-board | **+2** |
| The move handed the opponent a free move (`forced == None` on their turn) | **−12** |

Requirement FR-4.2 asked for the ordering "mini-boards won > centre mini-board >
mini-board centre cells > two-in-a-row threats, minus a free-move penalty"; the
numbers above preserve exactly that ordering. Cells inside a closed board score
**0** — they are dead (R-3).

### 6.6 Move ordering (alpha-beta efficiency)

Candidates are searched in this order, ties broken by ascending `(board, cell)`
so search is reproducible: (1) wins the game, (2) claims a mini-board,
(3) sends the opponent to a board where they have no immediate mini-win,
(4) centre cell of the target board, (5) everything else.

### 6.7 Classic mode (FR-4.1, D-4)

Classic reuses `xox` unchanged. `classic_choose` maps
**Easy → `Careless`, Medium → `Fair`, Hard → `Perfect`** (D-A4) and delegates to
`xox.choose_move`. `Perfect` is already full-depth minimax over 9 cells
(FR-4.1). No change to `xox.glyph`.

### 6.8 The 300 ms minimum (FR-4.6)

Enforced on the **main thread**, never in the worker: the UI records the request
timestamp and applies the returned move at
`max(0, 300 - elapsed)` ms later. The worker must not sleep — sleeping there
would burn worker time that iterative deepening could spend, and would delay
cancellation.

---

## 7. Worker contract and wire format (FR-3.1, FR-4.4, D-1)

### 7.1 Wire form of a state

The wire/persistence form is the **move list**, not the cell grid — it is 2
bytes per move, it makes undo/replay trivial (FR-3.5, UI-5.5), it is the basis
for S-8.5 later, and **it validates by construction**: `decode` replays through
`apply_move`, so a tampered save cannot produce an illegal state.

```
encode(s) = "U1|" + <first player: "X"|"O"> + "|" + <two digits per move: board, cell>
```

Digits are read strictly in pairs, `board` then `cell`. Example: `"U1|X|444008"`
is X `{board:4, cell:4}` (forcing board 4), O `{board:4, cell:0}` (forcing board
0), X `{board:0, cell:8}`. `decode(text) -> Result<UState, string>` returns `Err`
for a bad prefix, an odd digit count, a non-digit, or any pair `apply_move`
rejects.

`state_to_text` / `state_from_text` (the 81-char grid form, `/`-separated for
readability) exist for **fixtures and debugging only** and are not the
persistence format.

### 7.2 Message protocol

The worker owns one job at a time. All messages carry a client-generated `id`.

Requests (main → worker):

```js
{ id, type: "choose", mode: "classic"|"ultimate", state, level: "easy"|"medium"|"hard", seed, budgetMs }
{ id, type: "legalMoves", state }
{ id, type: "applyMove", state, move: { board, cell } }
{ id, type: "cancel", target: <id of a running job> }
```

Responses (worker → main):

```js
{ id, type: "chosen",  move: { board, cell }, score, depth, nodes, elapsedMs }
{ id, type: "result",  value }                       // legalMoves / applyMove success
{ id, type: "rejected", error: { code, detail } }    // an illegal move; code is the MoveError variant tag
{ id, type: "error",   code, message }               // a bug: bad message shape, decode failure
{ id, type: "cancelled", target }
```

Rules:

- `state` on the wire is the `encode` string of §7.1. The boundary decodes on
  entry and encodes on exit; tagged-union objects never cross the boundary.
- **An illegal move is a normal response, not an exception.** `applyMove` over the
  boundary never throws and never returns a silently unchanged state; it returns
  `rejected` with the `MoveError` tag as `code` (FR-3.4).
- Cancellation is cooperative and checked at each iterative-deepening ply
  boundary, so worst-case latency is one ply. A cancelled job answers
  `cancelled`, never `chosen`.
- The worker never touches the DOM and never imports a non-browser-safe std
  module (§1.2). The main thread never runs a search (FR-4.4); it may call the
  cheap pure functions (`getLegalMoves`, `applyMove`, `isTerminal`) directly for
  rendering, since they are O(81) at worst.
- Names crossing the boundary are the FR-3.2 JS names (§3). `assets/worker.js`
  is the **only** place where snake_case becomes camelCase.

---

## 8. What this spec does *not* cover

UI rendering, animation, ARIA text, sound, theming and the persistence *store*
(UI-5.\*, FR-6.\*) are specified elsewhere. This file fixes only the engine, the
AI, the worker boundary, and the wire format those layers consume — plus the two
hooks they need: `encode`/`decode` (FR-6.1) and `outcome` (FR-6.2 stats).

---

## 9. Traceability summary

| Requirement | Where it is discharged |
|---|---|
| FR-2.2 (Ultimate rules, tiebreak, neutral draws) | §4, §5 |
| FR-3.1 (pure, no DOM) | §1.2, §7.2 |
| FR-3.2 (four contracts) | §3 |
| FR-3.3 (cheap clone) | §2.4 |
| FR-3.4 (rejects illegal moves) | §3.2, §7.2 |
| FR-3.5 (full history) | §2.2, §3.5, §7.1 |
| FR-4.1 (Classic minimax) | §6.7 |
| FR-4.2 (Ultimate search + heuristic) | §6.3–6.6 |
| FR-4.3 (three difficulties) | §6.2–6.4 |
| FR-4.4 (worker, non-blocking) | §7.2 |
| FR-4.5 (budget + iterative deepening) | §6.4 |
| FR-4.6 (300 ms floor) | §6.8 |
| NFR-7.3 (edge-case tests) | §5, §10 |
| D-1 / D-4 (browser build, Classic preserved) | §1.1, §1.2, §6.7 |

---

## 10. Acceptance criteria

Every AC is one testable statement. **Check** is how it is verified:
`@example` = a Glyph `@example` line that runs under `glyph check src`;
`js-test` = a test against the built worker bundle;
`grep` = a static check in CI.

### Engine — contracts and state

| ID | Requirement | Statement | Check |
|---|---|---|---|
| AC-1 | FR-2.2, FR-3.2 | `array.len(legal_moves(new_game(X))) == 81`. | `@example` |
| AC-2 | FR-2.2 | `new_game(X)` has `forced == None`, `turn == X`, `history == []`, `outcome == Playing`, and `playable_boards` is `[0..8]`. | `@example` |
| AC-3 | FR-2.2, FR-3.2 | After X plays `{board: 4, cell: 0}` from `new_game(X)`, `forced == Some(0)` and `legal_moves` is exactly the 9 cells of board 0 in ascending cell order. | `@example` |
| AC-4 | FR-3.4 | With `forced == Some(0)`, `apply_move(s, {board: 3, cell: 1})` returns `Err(WrongBoard({required: 0, got: 3}))`. | `@example` |
| AC-5 | FR-3.4 | A move onto a non-empty cell of the required board returns `Err(CellTaken({board, cell}))`. | `@example` |
| AC-6 | FR-3.4 | `apply_move` with `board` or `cell` outside `0..8` returns `Err(OutOfRange({board, cell}))` and is checked before the forced-board test. | `@example` |
| AC-7 | FR-3.4 | On a free move, a move into a `MiniWon` or `MiniDrawn` board returns `Err(BoardClosed({board}))`. | `@example` |
| AC-8 | FR-3.4 | Any `apply_move` on a terminal state returns `Err(GameOver)`, including a move that would otherwise be legal. | `@example` |
| AC-9 | FR-3.3, FR-3.4 | After a rejected `apply_move`, `state_to_text(s)`, `s.forced`, `s.turn` and `array.len(s.history)` are unchanged (no mutation on the failure path). | `@example` |
| AC-10 | FR-3.5 | After applying moves `m1..mn`, `s.history` equals `[m1..mn]` in order and `array.len(s.history) == n`. | `@example` |
| AC-11 | FR-3.5 | For any `s` and legal `m`, `undo(apply_move(s, m))` is structurally equal to `Some(s)`; `undo(new_game(X)) == None`. | `@example` |
| AC-12 | FR-3.5, FR-6.1 | `decode(encode(s))` is `Ok(s')` with `s'` structurally equal to `s`, for a 20-move game. | `@example` |
| AC-13 | FR-3.3 | `apply_move` returns a new record: the input's `cells` array is unchanged and `array.len(before.history) + 1 == array.len(after.history)`. | `@example` |
| AC-14 | FR-3.1, D-1 | `src/ultimate.glyph` and `src/ai.glyph` import only from `{std/array, std/option, std/string, std/result, std/math, std/time, xox}` and contain no occurrence of `document`, `window`, `self`, `postMessage`. | `grep` |

### Engine — Ultimate rules

| ID | Requirement | Statement | Check |
|---|---|---|---|
| AC-15 | FR-2.2 | For any legal move `{board: b, cell: i}` whose post-move board `i` is `MiniOpen`, the resulting `forced == Some(i)`. | `@example` |
| AC-16 | FR-2.2 | When the pointed-to board is `MiniWon` (and still has empty cells), the resulting `forced == None` and `legal_moves` spans every open board. | `@example` |
| AC-17 | FR-2.2, NFR-7.3 | When the pointed-to board is `MiniDrawn`, the resulting `forced == None` (free move on a drawn board). | `@example` |
| AC-18 | FR-2.2 | Completing three in a row inside a mini-board sets `boards[b] == MiniWon({winner, line})` with `line` the winning cell triple. | `@example` |
| AC-19 | FR-2.2 | A mini-board that fills with no line is `MiniDrawn`; it contributes to neither player in `outcome`, and `boards_won(s, X) + boards_won(s, O) + drawn == 9` when the grid is full. | `@example` |
| AC-20 | FR-2.2 | Three `MiniWon` boards by X on a `win_lines` triple give `outcome == Won({winner: X, line: <triple>})`, `is_terminal == true` and `legal_moves == []`, even with open boards remaining. | `@example` |
| AC-21 | FR-2.2 | No cell of a `MiniWon` or `MiniDrawn` board ever appears in `legal_moves`, including its still-empty cells. | `@example` |
| AC-22 | FR-2.2 | All 9 boards closed, no meta line, X 4 boards to O 3 → `outcome == Won({winner: X, line: []})`. | `@example` |
| AC-23 | FR-2.2 | All 9 boards closed, no meta line, equal tallies → `outcome == Drawn`. | `@example` |
| AC-24 | FR-3.2 | `legal_moves` is sorted ascending by `board` then `cell`, and two calls on structurally equal states return identical arrays. | `@example` |
| AC-25 | FR-2.2 | A position whose boards are all `MiniWon`/`MiniDrawn` is terminal even though drawn boards belong to nobody ("full" includes drawn boards). | `@example` |

### Engine — edge cases (NFR-7.3)

| ID | Requirement | Statement | Check |
|---|---|---|---|
| AC-26 | NFR-7.3, FR-2.2 | A move that fills a mini-board's last empty cell **and** completes a line yields `MiniWon`, never `MiniDrawn` (win-on-last-cell). | `@example` |
| AC-27 | NFR-7.3, FR-2.2 | A move that simultaneously closes a mini-board and completes the meta line yields `Won`, `is_terminal == true`, `legal_moves == []`, and a following `apply_move` gives `Err(GameOver)`. | `@example` |
| AC-28 | NFR-7.3, FR-2.2 | In a 5-move forced chain, each state's `forced` equals `Some(previous move's cell)` and each `legal_moves` contains only that board's empty cells (forced-board chains). | `@example` |
| AC-29 | FR-2.2 | A move at `{board: b, cell: b}` that closes board `b` yields `forced == None`; the same move with board `b` still open yields `forced == Some(b)`. | `@example` |
| AC-30 | NFR-7.3 | From a state whose forced target is drawn, `legal_moves` excludes every cell of every closed board and includes every empty cell of every open board (free move on a drawn board). | `@example` |

### AI ladder

| ID | Requirement | Statement | Check |
|---|---|---|---|
| AC-31 | FR-4.3 | For every difficulty and for seeds 1..100 on 5 fixture positions, `choose` returns `Some(plan)` whose `move` is a member of `legal_moves`, and `None` exactly on terminal states. | `@example` |
| AC-32 | FR-4.3 | Easy plays an immediately game-winning move whenever one exists, for every seed. | `@example` |
| AC-33 | FR-4.2, FR-4.3 | `choose(s, d, seed, budget)` is deterministic: two calls with identical arguments return the same `move` (Easy and Medium; Hard at a fixed depth cap with an unreachable budget). | `@example` |
| AC-34 | FR-4.3 | Over seeds 1..200 on a fixed position with ≥ 5 legal moves, Medium returns a non-best move on 15% ± 5% of seeds, and always a legal one. | `@example` |
| AC-35 | FR-4.3 | On a fixture where exactly one move avoids an immediate loss, Hard plays that move; Easy is not required to. | `@example` |
| AC-36 | FR-4.5 | Hard with `budget_ms = 200` returns `Some(plan)` with `depth >= 1` and `elapsed <= 200 + 100 ms` on the opening position; with `budget_ms = 1500` it returns `depth >= 3`. | `js-test` |
| AC-37 | FR-4.2 | `evaluate(s, X) == -evaluate(s, O)` for 20 fixture positions, including terminal ones. | `@example` |
| AC-38 | FR-4.1, D-4 | `classic_choose` maps Easy/Medium/Hard to `xox`'s `Careless`/`Fair`/`Perfect`, and `glyph check src` still reports all of `xox.glyph`'s original 14 examples passing. | `@example` + `glyph check` |
| AC-39 | FR-4.2, G-2 | In 20 seeded Ultimate games (Hard vs Easy, 10 as each colour) Hard scores ≥ 18 points (win 1, draw 0.5) — the levels are meaningfully different. | `js-test` |
| AC-40 | FR-4.2 | Hard's heuristic ranks a state with the centre board won above the same state with a corner board won, and penalises a move that hands a free move relative to one that does not. | `@example` |

### Worker boundary and build

| ID | Requirement | Statement | Check |
|---|---|---|---|
| AC-41 | FR-4.4, D-1 | The built worker bundle contains no `node:` specifier, no bare `std/*` specifier, and no reference to `document`/`window`; it loads in a `Worker` with no network request. | `grep` + `js-test` |
| AC-42 | FR-3.2 | The worker module exposes exactly the names `getLegalMoves`, `applyMove`, `getWinner`, `isTerminal` (plus `getOutcome`, `chooseMove`), and each delegates to its `ultimate`/`ai` counterpart. | `js-test` |
| AC-43 | FR-3.4 | `applyMove` over the boundary returns `{type:"rejected", error:{code}}` with the `MoveError` tag as `code` for each of the five rejection kinds, and never throws. | `js-test` |
| AC-44 | FR-4.4 | Every response echoes the request `id`; a request with an unknown `type` returns `{type:"error"}` and the worker stays alive to answer the next request. | `js-test` |
| AC-45 | FR-4.4, NFR-7.1 | While a Hard move is computed with a 1500 ms budget, no main-thread task exceeds 50 ms (measured with `PerformanceObserver` on `longtask`). | `js-test` |
| AC-46 | FR-4.6 | The interval between a `choose` request and the move being applied to the UI state is ≥ 300 ms even when the worker answers in under 10 ms. | `js-test` |
| AC-47 | FR-6.1, FR-3.4 | `decode` returns `Err` for a bad prefix, an odd digit count, a non-digit character, and a digit pair that `apply_move` would reject; a valid save round-trips through reload. | `@example` + `js-test` |

---

## 11. Decisions register (this spec's choices)

| ID | Decision | Rationale (one line) |
|---|---|---|
| D-U1 | Mini-board index and in-board cell index share one row-major 0..8 numbering; the forced board is literally the move's `cell`. | Removes all (r,c) arithmetic and the class of bugs that comes with it. |
| D-U2 | Won and drawn boards are permanently closed; their empty cells are dead. | The rule FR-2.2 states ("play in any open board"); the permissive variant would change the game's character. |
| D-U3 | `forced` is normalised on **write**: `Some(b)` only if `b` is open post-move, else `None`. | Keeps `legal_moves` trivial, makes UI-5.2 a direct read, and encodes the free-move rule in one place. |
| D-U4 | Tiebreak = most mini-boards won, else draw; encoded as `Won({winner, line: []})`. | FR-2.2's recommended rule; the empty `line` distinguishes it for UI-5.7 without a new variant. |
| D-U5 | The AI searches from a state whose `history` is `[]` (`search_root`). | Invariant I-6 makes it sound and it keeps clone cost independent of game length, with only one `apply_move` in existence. |
| D-U6 | `cells: Array<Cell>` (81) with a cached `boards: Array<MiniStatus>` (9), not an 81-char string. | Reads dominate in search; the string form allocates per read. String form is kept for fixtures only. |
| D-U7 | Persistence/wire form is the move list (`"U1\|X\|<pairs>"`), not the grid. | 2 bytes/move, replay-validated so a tampered save cannot yield an illegal state, and it is the basis for undo and S-8.5. |
| D-A1 | Easy = win-if-possible, else block with probability 35%, else uniform random. | Makes "occasional blocking" a number a test can assert. |
| D-A2 | Medium = alpha-beta at depth **3** with a 15% deliberate-error rate. | In FR-4.3's 2–4 range; odd depth ends on the opponent's reply so Medium does not hang pieces for free. |
| D-A3 | Heuristic weights fixed at 100 / +40 centre board / 60 meta-two / 8 centre cell / 5 mini-two / 2 corner / −12 free move. | Preserves FR-4.2's stated ordering while being concrete enough to test (AC-40). |
| D-A4 | Classic difficulty maps Easy→`Careless`, Medium→`Fair`, Hard→`Perfect`. | Reuses `xox` untouched (D-4) and gives Classic three genuinely different levels (G-2). |
| D-A5 | PRNG is MINSTD (`x * 48271 % 2147483647`) with an explicit `seed` parameter. | Exact in float64 (the usual 1103515245 multiplier is not), and explicit seeding keeps `choose` pure and replayable. |
| D-A6 | Hard's budget default is 1500 ms; a ply that overruns is discarded whole. | FR-4.5's suggested budget; discarding partial plies avoids returning a move from a half-searched, biased ply. |
| D-A7 | The 300 ms floor (FR-4.6) is enforced on the main thread, not in the worker. | Sleeping in the worker would waste search budget and delay cancellation. |
| D-W1 | Cancellation is cooperative, checked at ply boundaries. | The engine is synchronous Glyph; a ply boundary is the only safe checkpoint, and 1 ply is a bounded worst case. |

---

## 12. Open questions (do not block implementation)

1. **Who moves first by default** — FR-6.3 makes it a setting; this spec defaults
   to X and assumes the human is X. If the product wants "loser starts", it is a
   UI-layer rule and needs no engine change.
2. **Hard's budget on low-end mobile** — 1500 ms may exceed NFR-7.1's feel on a
   slow device. Suggested follow-up: scale the budget by a one-off calibration
   (nodes/second measured on first run). Not in v1.
3. **AC-39's strength threshold (≥ 18/20)** is a judgement call; if it proves
   flaky, the fix is more games, not a weaker Hard.
4. **Transposition table** — deliberately omitted from v1 (state hashing over 81
   cells plus the forced board is easy to get subtly wrong). Revisit only if
   AC-36's depth targets are missed.
5. **Redo depth** — UI-5.5 says undo *and* redo; the engine exposes only `undo`,
   and the UI keeps the redo tail. If redo must survive a reload, `encode` needs
   a second segment for the tail — a wire-format change, so decide before
   shipping FR-6.1.
