# Ultimate Tic Tac Toe — test matrix

Status: **plan only**. No test code, no implementation. This file maps every
acceptance criterion in `specs/ultimate.spec.md` §10 (AC-1 … AC-47) to concrete,
constructible test cases.

Traceability: `specs/requirements.md` → `specs/ultimate.spec.md` → this file.
Where this file adds a case the spec did not enumerate, the case id carries the
tag **[ADV]** (adversarial) and §6 explains why it exists.

Every board literal, every replay string, every move count and every expected
`forced` / `outcome` value in §2 and §3 was mechanically verified against a
reference implementation of the §3/§4 rules before being written down. The
verification notes are in §8.

---

## 1. Conventions

### 1.1 Fixture literal format

A position is written as nine 9-character groups separated by `/`:

```
"B0/B1/B2/B3/B4/B5/B6/B7/B8"
```

Group `b` is mini-board `b`; character `i` within a group is cell `i` of that
board, i.e. `cells[b * 9 + i]`. Characters are `X`, `O`, `.`. This is exactly
what `ultimate.state_from_text(cells, forced, turn)` consumes (`/` is stripped,
non-`X`/`O` is `Empty`), so a fixture is a one-liner in a Glyph `@example`.

A fixture is therefore fully specified by the triple **(literal, forced, turn)**.

### 1.2 Replay literal format

A game is written as its `encode` string, `"U1|<first>|<pairs>"` (spec §7.1),
and constructed with `decode(...)` or `replay(first, moves)`. Replay-built states
are the only ones with a real `history`, so every case touching `history`,
`undo`, `encode` or the worker wire form **must** use a replay literal, never a
fixture literal (see gap **G-1** in §7).

### 1.3 Test ids and areas

| Prefix | Area | Runner |
|---|---|---|
| `TE-*` | engine | Glyph `@example` under `glyph check src`, unless noted `grep` |
| `TA-*` | ai | Glyph `@example`, unless noted `js-test` |
| `TW-*` | worker | `js-test` against the built bundle |
| `TU-*` | ui | `js-test` in a real browser (main thread) |

A case marked **`js-test`** cannot be an `@example`: it needs a wall clock, a
`Worker`, a `PerformanceObserver`, or more compute than a check-time example
should spend.

---

## 2. Fixture library

### 2.1 Mini-board patterns (the 9-char building blocks)

| Name | Literal | Status | X/O | Note |
|---|---|---|---|---|
| `EMPTY` | `.........` | MiniOpen | 0/0 | |
| `WX012` | `XXXOO.O..` | MiniWon(X, [0,1,2]) | 3/3 | balanced, meta-tally building block |
| `WO012` | `OOOXX.X..` | MiniWon(O, [0,1,2]) | 3/3 | balanced mirror |
| `WX012L` | `XXXOO....` | MiniWon(X, [0,1,2]) | 3/2 | "light" variant, 4 empty cells |
| `D1` | `XXOOOXXOX` | MiniDrawn | 5/4 | full, no line |
| `D2` | `OOXXXOOXO` | MiniDrawn | 4/5 | colour mirror of `D1` |
| `L1` | `XX.OOXXOO` | MiniOpen | 4/4 | **one** empty cell (2); X→win, O→draw |
| `SP_OPEN` | `.O.X.....` | MiniOpen | 1/1 | cell 0 empty; X@0 leaves it open |
| `SP_WIN` | `.XXOO....` | MiniOpen | 2/2 | cell 0 empty; X@0 wins [0,1,2] |
| `SP_DRAW` | `.XOOXXXOO` | MiniOpen | 4/4 | cell 0 empty; X@0 fills it, no line |
| `DIAG` | `XOO.....X` | MiniOpen | 2/2 | cell 4 empty; X@4 wins [0,4,8] |
| `THREAT8` | `..X.OX...` | MiniOpen | 2/1 | X@{2,5}; X@8 wins [2,5,8] |
| `B6` | `.X.OXO.O.` | MiniOpen | 2/3 | empties {0,2,6,8}; the AC-35 trap board |
| `ONEX` | `X........` | MiniOpen | 1/0 | parity filler |

`L1` is the workhorse for win-on-last-cell: the same literal with the same empty
cell proves **both** branches of R-4 depending on which mark plays it. That pair
is the whole of E-2 in two lines.

### 2.2 Fixture states

Each row is `(literal, forced, turn)`. **Parity** = whether the X/O counts are
consistent with alternating play from X (`#X == #O` ⟹ turn X; `#X == #O + 1` ⟹
turn O). Non-parity fixtures are legal inputs to `state_from_text` but
unreachable in play; they are marked *synthetic* and exist only to prove a
function is total.

| Fixture | Literal (groups) | forced | turn | Key properties (verified) |
|---|---|---|---|---|
| `FX-NEW` | 9 × `EMPTY` | `None` | X | 81 legal, `Playing`, parity ok |
| `FX-WONFREE` | `EMPTY EMPTY EMPTY WX012L EMPTY EMPTY EMPTY EMPTY EMPTY` | `Some(0)` | O | after `(0,3)`: forced `None`, **71** legal |
| `FX-DRAWFREE` | `EMPTY EMPTY EMPTY D1 EMPTY WX012 EMPTY EMPTY EMPTY` | `Some(0)` | O | after `(0,3)`: forced `None`, **62** legal |
| `FX-TERMFORCED` | `WX012 WX012 .X.O.O.X. EMPTY×6` | `Some(2)` | X | after `(2,4)`: `Won(X,[0,1,2])`, terminal, legal `[]`, **forced `Some(4)`** |
| `FX-TIE43` | `WX012 WX012 WO012 D1 WO012 WX012 WX012 WO012 D2` | `None` | X | terminal, `Won(X, [])`, 4/3/2 |
| `FX-TIEEQ` | `WX012 WX012 WO012 D1 WO012 WX012 D2 WO012 D1` | `None` | O | terminal, `Drawn`, 3/3/3 |
| `FX-ALLDRAWN` | `D1 D2 D1 D2 D1 D2 D1 D2 D1` | `None` | O | 81 cells full, `Drawn`, 0/0/9 |
| `FX-LINEBEATS` | `WO012 WO012 WO012 WX012 D1 WX012 WX012 WX012 D2` | `None` | X | `Won(O,[0,1,2])` although X owns 4 boards to O's 3 |
| `FX-BOTHLINES` | `WX012 WX012 WX012 WO012 WO012 WO012 EMPTY EMPTY EMPTY` | `None` | O | *synthetic*; `Won(X,[0,1,2])` by `win_lines` order |
| `FX-MUSTBLOCK` | `WX012 D1 D2 D1 WX012 D2 B6 D1 THREAT8` | `Some(6)` | O | 4 legal moves; **exactly one** `(6,6)` avoids losing next move |
| `FX-WINLAST` | `L1 EMPTY×8` | `Some(0)` | X | 1 legal move; `(0,2)` → `MiniWon(X,[0,1,2])`, forced `Some(2)` |
| `FX-DRAWLAST` | `L1 ONEX EMPTY×7` | `Some(0)` | O | 1 legal move; `(0,2)` → `MiniDrawn`, forced `Some(2)` |
| `FX-SP-OPEN` | `SP_OPEN EMPTY×8` | `Some(0)` | X | `(0,0)` leaves board 0 open → forced `Some(0)` |
| `FX-SP-WIN` | `SP_WIN EMPTY×8` | `Some(0)` | X | `(0,0)` wins board 0 → forced `None`, 72 legal |
| `FX-SP-DRAW` | `SP_DRAW EMPTY×8` | `Some(0)` | X | `(0,0)` draws board 0 → forced `None`, 72 legal |
| `FX-DIAG` | `DIAG EMPTY×8` | `Some(0)` | X | `(0,4)` → `MiniWon(X,[0,4,8])`, forced `Some(4)` |
| `FX-CLOSEDFORCED` | `EMPTY EMPTY EMPTY WX012 EMPTY×5` | `Some(3)` | X | `state_from_text` must normalise forced → `None`, 72 legal |
| `FX-BADFORCED` | 9 × `EMPTY` | `Some(12)` / `Some(-1)` | X | must normalise to `None`, 81 legal |

### 2.3 Replay games

| Name | Literal | Length | End state (verified) |
|---|---|---|---|
| `G-CHAIN5` | `"U1\|X\|4440088226"` | 5 | forced chain `Some(4)→Some(0)→Some(8)→Some(2)→Some(6)`; all boards open |
| `G-20` | `"U1\|X\|0112233445566778800224466881133557700336"` | 20 | forced `Some(6)`, turn X, no board closed, 7 legal |
| `G-CLOSED` | `"U1\|X\|400441144224"` | 6 | X owns board 4; turn X, forced `None` (free move), 69 legal |
| `G-XWIN` | `"U1\|X\|0440088000144224466444388228855888"` | 17 | `Won(X,[0,4,8])`, terminal; the 17th move closes board 8 **and** completes the meta line |

`G-XWIN`'s move list, for reference (X first, boards won at plies 5, 11, 17):

```
(0,4) (4,0) (0,8) (8,0) (0,0)   -> X wins board 0 by [0,4,8], forced None
(1,4) (4,2) (2,4) (4,6) (6,4) (4,4)   -> X wins board 4 by [2,4,6], forced None
(3,8) (8,2) (2,8) (8,5) (5,8) (8,8)   -> X wins board 8 by [2,5,8] => meta [0,4,8]
```

Prefixes used by name: `G-XWIN@11` (X owns boards 0 and 4), `G-XWIN@16` (one
move from mate, turn X, forced `Some(8)`), `G-XWIN@17` (terminal).

---

## 3. Engine cases

### 3.1 Contracts and state (AC-1 … AC-14)

| Id | AC | Start | Action | Expected |
|---|---|---|---|---|
| TE-001 | AC-1 | `FX-NEW` | `legal_moves` | `array.len == 81` |
| TE-002 | AC-2 | `FX-NEW` | read fields | `forced == None`, `turn == X`, `len(history) == 0`, `outcome == Playing` |
| TE-003 | AC-2 | `FX-NEW` | `playable_boards` | `[0,1,2,3,4,5,6,7,8]` |
| TE-004 | AC-3 | `FX-NEW` | `apply_move({4,0})` | `Ok`, `forced == Some(0)` |
| TE-005 | AC-3 | `FX-NEW` | `apply_move({4,0})` then `legal_moves` | exactly `[{0,0}…{0,8}]`, len 9, ascending cell order |
| TE-006 | AC-4 | `FX-NEW`+`(4,0)` | `apply_move({3,1})` | `Err(WrongBoard({required: 0, got: 3}))` |
| TE-007 | AC-5 | `G-CLOSED` | `apply_move({0,4})` | `Err(CellTaken({board: 0, cell: 4}))` |
| TE-008 | AC-6 | `FX-NEW` | `apply_move` with `{9,0}`, `{0,9}`, `{-1,0}`, `{0,-1}` | `Err(OutOfRange({board, cell}))` echoing the offending pair, 4 cases |
| TE-009 | AC-6 | `FX-NEW`+`(4,0)` (forced `Some(0)`) | `apply_move({9,0})` | `Err(OutOfRange)`, **not** `WrongBoard` — proves check 2 precedes check 3 |
| TE-010 **[ADV]** | AC-6 | `FX-NEW` | `apply_move({4.5, 0})`, `{0, 4.5}` | `Err(OutOfRange)` — a naive `b < 0 \|\| b > 8` bound check passes 4.5 and then indexes `cells[40.5]` |
| TE-011 **[ADV]** | AC-6 | `FX-NEW` | `apply_move` with `NaN`, `Infinity`, `-0` as board and as cell | `Err(OutOfRange)` for all — `NaN < 0` and `NaN > 8` are both false |
| TE-012 | AC-7 | `G-CLOSED` (free move) | `apply_move({4,3})` | `Err(BoardClosed({board: 4}))` — board 4 is `MiniWon` |
| TE-013 | AC-7 | `FX-DRAWFREE`+`(0,3)` | `apply_move({3,0})` | `Err(BoardClosed({board: 3}))` — board 3 is `MiniDrawn` |
| TE-014 | AC-8 | `G-XWIN` | `apply_move({1,0})` | `Err(GameOver)` — board 1 is open and cell 0 empty, so this is "otherwise legal" |
| TE-015 **[ADV]** | AC-8 | `G-XWIN` | `apply_move({9,0})` | `Err(GameOver)`, **not** `OutOfRange` — proves check 1 precedes check 2 |
| TE-016 | AC-9 | one fixture per error kind (TE-006/007/008/012/014) | the rejected `apply_move`, then re-read the input | `state_to_text`, `forced`, `turn`, `len(history)` all identical to before, 5 sub-cases |
| TE-017 **[ADV]** | AC-9 | `G-20` | reject a move, then `undo` | `undo` still yields the ply-19 state — a rejection must not corrupt `history` |
| TE-018 | AC-10 | `G-20` | read `history` | equals the 20 moves in order; `len == 20`; `history[0] == {0,1}`, `history[19] == {3,6}` |
| TE-019 | AC-11 | `G-20` | for each ply `k` in 1..20: `undo(state@k)` | structurally equal to `state@(k-1)` (compare `state_to_text`, `forced`, `turn`, `history`) |
| TE-020 | AC-11 | `FX-NEW` | `undo` | `None` |
| TE-021 | AC-12 | `G-20` | `decode(encode(s))` | `Ok(s')` with `state_to_text`, `forced`, `turn`, `history` all equal |
| TE-022 | AC-13 | `G-20@19` | `apply_move(m20)` | `state_to_text(before)` unchanged; `len(before.history) + 1 == len(after.history)` |
| TE-023 **[ADV]** | AC-13 | `G-20@19` | `apply_move(m20)`, then inspect `before.boards` | the `boards` array of the input is unchanged too — `cells` is the obvious one to copy, `boards` the easy one to mutate in place |
| TE-024 | AC-14 | `src/ultimate.glyph`, `src/ai.glyph` | `grep -nE '^\s*import'` | every import line matches `std/(array\|option\|string\|result\|math\|time)` or `xox`; zero other matches |
| TE-025 | AC-14 | same two files | `grep -nwE 'document\|window\|self\|postMessage\|globalThis\|process\|localStorage\|fetch\|require'` on non-comment lines | zero matches |

### 3.2 Ultimate rules (AC-15 … AC-25)

| Id | AC | Start | Action | Expected |
|---|---|---|---|---|
| TE-026 | AC-15 | `FX-NEW` | apply `G-CHAIN5`'s 5 moves | after each, `forced == Some(previous move's cell)`: `Some(4), Some(0), Some(8), Some(2), Some(6)` |
| TE-027 | AC-16 | `FX-WONFREE` | `apply_move({0,3})` | `forced == None`; `len(legal_moves) == 71`; no move has `board == 3` |
| TE-028 | AC-17 | `FX-DRAWFREE` | `apply_move({0,3})` | `forced == None` (target board 3 is `MiniDrawn`) |
| TE-029 | AC-18 | `FX-WINLAST` | `apply_move({0,2})` | `boards[0] == MiniWon({winner: X, line: [0,1,2]})` |
| TE-030 | AC-18 | `FX-DIAG` | `apply_move({0,4})` | `boards[0] == MiniWon({winner: X, line: [0,4,8]})` — proves the `win_lines` scan reaches the diagonals and returns the *first* matching triple |
| TE-031 | AC-19 | `FX-DRAWLAST` | `apply_move({0,2})` | `boards[0] == MiniDrawn` |
| TE-032 | AC-19 | `FX-TIE43` | `boards_won(s,X)`, `boards_won(s,O)`, count drawn | `4 + 3 + 2 == 9` |
| TE-033 | AC-19 | `FX-ALLDRAWN` | same | `0 + 0 + 9 == 9`; a drawn board counts for neither player |
| TE-034 | AC-20 | `FX-TERMFORCED` | `apply_move({2,4})` | `outcome == Won({winner: X, line: [0,1,2]})`, `is_terminal == true`, `legal_moves == []` — boards 3..8 are still open |
| TE-035 | AC-21 | `FX-DRAWFREE`+`(0,3)` | `legal_moves` | contains no move with `board == 3` (drawn, 0 empty) or `board == 5` (won, 3 empty cells at 5,7,8) |
| TE-036 | AC-22 | `FX-TIE43` | `outcome` | `Won({winner: X, line: []})`; `array.len(line) == 0` distinguishes it from TE-034 |
| TE-037 | AC-23 | `FX-TIEEQ` | `outcome` | `Drawn` (3–3 with 3 drawn) |
| TE-038 | AC-23 | `FX-ALLDRAWN` | `outcome` | `Drawn` (0–0 with 9 drawn) |
| TE-039 | AC-24 | `FX-DRAWFREE`+`(0,3)` | `legal_moves` | the 62-entry array is strictly increasing under `board * 9 + cell`; first `{0,0}`, last `{8,8}` |
| TE-040 | AC-24 | same position built twice (once by `state_from_text`, once by `replay`) | `legal_moves` on both | identical arrays — and identical `outcome`, `is_terminal`, `forced`. Doubles as the **I-6** proof: the two states differ only in `history` |
| TE-041 | AC-25 | `FX-ALLDRAWN` | `is_terminal`, `legal_moves` | `true`, `[]` — "full" includes drawn boards |
| TE-042 | AC-25 | `FX-TIE43` | `is_terminal`, `legal_moves` | `true`, `[]` — mixture of won and drawn boards |

### 3.3 Edge cases (AC-26 … AC-30) — NFR-7.3 priority block

These are the cases NFR-7.3 names explicitly. They get the most attention.

| Id | AC | Start | Action | Expected |
|---|---|---|---|---|
| TE-043 | AC-26 | `FX-WINLAST` (`L1`, one empty cell, turn X) | `apply_move({0,2})` | `boards[0] == MiniWon({X, [0,1,2]})`, **not** `MiniDrawn` — the move fills the last cell and completes the line; R-4 tests win before fullness |
| TE-044 | AC-26 | `FX-DRAWLAST` (same `L1`, same cell, turn **O**) | `apply_move({0,2})` | `boards[0] == MiniDrawn` — the twin. One literal, two branches, no other variable changes |
| TE-045 | AC-27 | `G-XWIN@16` | `apply_move({8,8})` | `boards[8] == MiniWon({X,[2,5,8]})` **and** `outcome == Won({X,[0,4,8]})`, `is_terminal == true`, `legal_moves == []` |
| TE-046 | AC-27 | `G-XWIN` (terminal) | `apply_move({1,0})` | `Err(GameOver)` |
| TE-047 | AC-28 | `FX-NEW` | apply `G-CHAIN5` move by move | at each step `forced == Some(prev.cell)` **and** `legal_moves` is exactly the empty cells of that one board: lengths `8, 9, 9, 9, 9` |
| TE-048 | AC-28 | `G-CHAIN5@1` | `legal_moves` | exactly board 4's 8 empty cells `{4,0}…{4,8}` minus `{4,4}`, ascending |
| TE-049 | AC-29 | `FX-SP-OPEN` | `apply_move({0,0})` | board 0 still `MiniOpen` → `forced == Some(0)`; the opponent replies inside the same board |
| TE-050 | AC-29 | `FX-SP-WIN` | `apply_move({0,0})` | the move **wins** board 0 → `forced == None`, 72 legal moves |
| TE-051 | AC-29 | `FX-SP-DRAW` | `apply_move({0,0})` | the move **fills** board 0 with no line → `MiniDrawn`, `forced == None`, 72 legal moves |
| TE-052 | AC-30 | `FX-DRAWFREE` | `apply_move({0,3})` then `legal_moves` | exactly 62 moves: board 0's 8 remaining empties + all 9 cells of boards 1,2,4,6,7,8; **zero** cells of board 3 (drawn) and **zero** of board 5 (won, 3 cells still empty) |
| TE-053 | AC-30 | `FX-DRAWFREE`+`(0,3)` | `playable_boards` | `[0,1,2,4,6,7,8]` — excludes 3 and 5 |

### 3.4 Persistence (AC-47)

| Id | AC | Input | Expected |
|---|---|---|---|
| TE-054 | AC-47 | `decode("U2\|X\|4444")` | `Err` — bad prefix |
| TE-055 | AC-47 | `decode("X\|4444")`, `decode("")`, `decode("U1X4444")` | `Err` — missing/garbled framing, 3 sub-cases |
| TE-056 | AC-47 | `decode("U1\|X\|444")` | `Err` — odd digit count |
| TE-057 | AC-47 | `decode("U1\|X\|44a4")`, `decode("U1\|X\|4 4 ")` | `Err` — non-digit |
| TE-058 | AC-47 | `decode("U1\|X\|4433")` | `Err` — pair 2 is `WrongBoard` (forced is 4 after `(4,4)`) |
| TE-059 | AC-47 | `decode("U1\|X\|4444")` | `Err` — pair 2 is `CellTaken` |
| TE-060 | AC-47 | `decode("U1\|X\|99")` | `Err` — digit 9 is a valid digit but an out-of-range board; a decoder that trusts single digits passes this |
| TE-061 | AC-47 | `decode("U1\|Z\|")` | `Err` — first-player token is neither `X` nor `O` |
| TE-062 **[ADV]** | AC-47 | `decode("U1\|X\|")` | **`Ok`**, equal to `new_game(X)` — an empty move list is a valid save, not an error |
| TE-063 **[ADV]** | AC-47 | `decode("U1\|X\|" + 82 valid-looking pairs)` | `Err` — replay hits `GameOver`/`CellTaken`; proves validation is by replay, not by length |
| TE-064 | AC-47 | `encode(decode(G-20))` | `== G-20` — encode/decode is a bijection on valid saves, not just left-inverse |
| TE-065 **[ADV]** | AC-47 | `decode("U1\|X\|4440088226\n")` | *documented behaviour* — see gap **G-4**; the case asserts whichever the implementation picks, and the choice must be stated in the module doc |

### 3.5 Invariants and structural adversarial cases

| Id | AC | Start | Action | Expected |
|---|---|---|---|---|
| TE-066 **[ADV]** | AC-20/AC-24 | `FX-TERMFORCED` | `apply_move({2,4})`, then `legal_moves` | `forced == Some(4)` **and** `legal_moves == []`. Board 4 is empty and open, so any implementation that branches on `forced` before testing `is_terminal` returns 9 moves here. This is the single highest-value engine test in the matrix |
| TE-067 **[ADV]** | AC-15 | `FX-WINLAST` | `apply_move({0,2})` | `forced == Some(2)`, **not** `None`. The move closes the board it was *played in* while pointing at a different, open board. Confusing "the board I just closed" with "the board I point at" is the natural bug |
| TE-068 **[ADV]** | AC-4/AC-7 | `G-CLOSED@5` (forced `Some(2)`), board 4 closed | `apply_move({4,3})` | `Err(WrongBoard({required: 2, got: 4}))`, **not** `BoardClosed` — check 3 precedes check 4 |
| TE-069 **[ADV]** | AC-7/AC-5 | `G-CLOSED` (free move) | `apply_move({4,0})` — closed board **and** occupied cell | `Err(BoardClosed({board: 4}))`, **not** `CellTaken` — check 4 precedes check 5 |
| TE-070 **[ADV]** | AC-22 | `FX-LINEBEATS` | `outcome` | `Won({winner: O, line: [0,1,2]})` although X owns 4 boards to O's 3. The meta-line scan runs **before** the tiebreak; an implementation that checks fullness first awards the game to X |
| TE-071 **[ADV]** | AC-24 | `FX-BOTHLINES` (*synthetic*) | `outcome` | `Won({X, [0,1,2]})` — first line in `win_lines` order. Proves totality (E-17 at the meta level) |
| TE-072 **[ADV]** | AC-24 | `state_from_text` of a mini-board holding lines for both marks | `mini_status` | first line in `win_lines` order wins; the function is total and deterministic (E-17) |
| TE-073 **[ADV]** | AC-2 | `FX-BADFORCED` (`Some(12)`, `Some(-1)`) | `state_from_text` then read `forced` | `None` — I-4 normalisation must reject out-of-range, not just closed boards |
| TE-074 **[ADV]** | AC-2 | `FX-CLOSEDFORCED` | `state_from_text` then read `forced`, `legal_moves` | `None`, 72 legal moves — a fixture cannot express `forced` on a closed board (I-4) |
| TE-075 **[ADV]** | AC-2 | `FX-TIE43`, `G-XWIN` | `playable_boards` | `[]` on a terminal state — see gap **G-3**; must agree with `legal_moves == []` |
| TE-076 **[ADV]** | AC-3 | `G-20` (forced `Some(6)`) | `playable_boards` | `[6]` — exactly the forced board |
| TE-077 **[ADV]** | I-7 | every fixture in §2.2 and every ply of `G-XWIN`, `G-20` | compare `is_terminal(s)` with `array.len(legal_moves(s)) == 0` | equal in all 36+ positions |
| TE-078 **[ADV]** | I-2 | every ply of `G-XWIN` | recompute each `boards[b]` from `cells[b*9..b*9+8]` and compare with the cached value | equal at all 9 boards × 18 plies — the cache is never stale |
| TE-079 **[ADV]** | I-1/I-3 | every fixture and every ply of `G-XWIN` | `array.len(cells)`, `array.len(boards)`, `turn` | `81`, `9`, `turn ∈ {X, O}` |
| TE-080 **[ADV]** | I-5 | `G-20` | `array.len(history)` vs count of non-`Empty` cells | `20 == 20`. Then the same check on `FX-DRAWFREE` **fails** — see gap **G-1**; the case documents that I-5 holds for replay-built states only |
| TE-081 **[ADV]** | E-16 | a game filling all 81 cells with no meta line | `outcome`, `len(history)` | `Drawn` or a tiebreak `Won(_, [])`, `len(history) == 81`. Generated by the harness (see §5.6), asserted terminal before use |
| TE-082 **[ADV]** | §3.5 | `G-20` | `replay(X, history)` vs the state itself | structurally equal — `replay` and a fold of `apply_move` agree |
| TE-083 **[ADV]** | §3.5 | `G-XWIN` | `render(s)` | returns a non-empty string, contains no DOM call, and `state_to_text(state_from_text(state_to_text(s), forced, turn))` round-trips |

---

## 4. AI cases

### 4.1 Legality and determinism (AC-31, AC-33)

| Id | AC | Protocol | Expected |
|---|---|---|---|
| TA-001 | AC-31 | For each `d ∈ {Easy, Medium, Hard}`, each `seed ∈ 1..100`, each of the 5 non-terminal fixtures `{FX-NEW, G-XWIN@8, FX-DRAWFREE, FX-MUSTBLOCK, G-CLOSED}`, `budget_ms = 50`: call `choose`. **1500 calls** | every call returns `Some(plan)` and `plan.move ∈ legal_moves(s)`. Zero exceptions |
| TA-002 | AC-31 | Same sweep over the 3 terminal fixtures `{G-XWIN, FX-TIE43, FX-ALLDRAWN}` | `None` for every difficulty and seed — `None` exactly on terminal states |
| TA-003 **[ADV]** | AC-31 | Before/after each call in TA-001, snapshot `state_to_text(s)`, `s.forced`, `s.turn`, `array.len(s.history)` | unchanged. `search_root` (D-U5) must return a *new* state; a mutating implementation corrupts the caller's game |
| TA-004 **[ADV]** | AC-31 | `choose(s, d, seed, b)` vs `choose(search_root(s), d, seed, b)` for all 3 difficulties × 20 seeds on `G-20` | identical `move`. Direct proof of **I-6** and the soundness of D-U5: history must not influence the search |
| TA-005 | AC-33 | Two identical calls for every `(fixture, difficulty, seed)` in TA-001 | identical `move`, `score`, `depth`. Hard is run with `budget_ms = 10^9` and a depth cap of 4 so the result is clock-independent |
| TA-006 **[ADV]** | AC-33 | Run TA-005's grid in a freshly loaded module instance and compare with the first run | identical — no module-level mutable state, no ambient RNG |
| TA-007 **[ADV]** | AC-33/D-A5 | Assert `48271 * 2147483646 < 2^53` and that `seed_next` applied 10 000 times from seed 1 never produces a non-integer or a value outside `1..2147483646` | holds. The rejected `1103515245` multiplier fails the first assertion — the test documents *why* the constant is normative |

### 4.2 Easy (AC-32)

| Id | AC | Start | Protocol | Expected |
|---|---|---|---|---|
| TA-008 | AC-32 | `G-XWIN@16` (turn X, forced `Some(8)`, `(8,8)` wins the game) | `choose(s, Easy, seed, 0)` for `seed ∈ 1..100` | `{board: 8, cell: 8}` for **all 100 seeds** — step 1 of D-A1 is unconditional |
| TA-009 **[ADV]** | AC-32 | a fixture with **two** immediately winning moves | all seeds 1..100 | the lowest `(board, cell)` of the two, for every seed — D-A1 says "the lowest-indexed such move", so the tie-break is normative and seed-independent |
| TA-010 **[ADV]** | AC-32 | `FX-MUSTBLOCK` (Easy is the defender, no win available) | seeds 1..100 | every returned move is legal; **no assertion that it is `(6,6)`** — Easy is explicitly not required to defend. The case exists so that a future "Easy got stronger" regression is visible, not to constrain Easy |
| TA-011 **[ADV]** | AC-32/D-A1 | a fixture where a winning move **and** a blocking move both exist | seeds 1..100 | the winning move, all seeds — step 1 beats step 2 |
| TA-012 **[ADV]** | AC-32/D-A1 | a fixture with a blocking move, `rand_below(seed,100) < 35` seeds only | the 35 seeds in 1..100 that satisfy the draw | the lowest-indexed blocking move; the other 65 seeds give a uniform pick. See §4.6 for why the seed split is exact |

### 4.3 Medium error rate (AC-34)

| Id | AC | Start | Protocol | Expected |
|---|---|---|---|---|
| TA-013 | AC-34 | `G-20` (7 legal moves ≥ 5) | `choose(s, Medium, seed, 10^9)` for `seed ∈ 1..200`; count seeds whose move ≠ the depth-3 best move | **exactly 30 of 200** (15.0%). Not a tolerance: with MINSTD and `rand_below(s,100) = seed_next(s) % 100`, seeds 1..200 map two-to-one onto all 100 residues, so the count is deterministic. The AC's "15% ± 5%" is the fallback assertion if `rand_below` is defined differently — in that case the implementation must document its definition and the test pins the exact count it produces |
| TA-014 | AC-34 | same | every one of the 200 returned moves | `∈ legal_moves(s)`; the 30 "error" moves are all `≠ best` and all legal |
| TA-015 **[ADV]** | AC-34 | a fixture with exactly **one** legal move (`FX-WINLAST`) | seeds 1..200 | that move on all 200 seeds — D-A2's error branch requires "more than one legal move exists"; a naive implementation divides by `n-1 == 0` |
| TA-016 **[ADV]** | AC-34 | `G-20`, the 170 non-error seeds | compare with a direct depth-3 alpha-beta reference | identical move on all 170 — the non-error branch really is the search's best, not a near-best |

### 4.4 Hard (AC-35, AC-36) and the heuristic (AC-37, AC-40)

| Id | AC | Start | Protocol | Expected |
|---|---|---|---|---|
| TA-017 | AC-35 | `FX-MUSTBLOCK` | `choose(s, Hard, seed, 10^9)` with depth cap 4, seeds 1..20 | `{board: 6, cell: 6}` on every seed. This is the **only** one of the 4 legal moves that avoids losing next move: `(6,0)` and `(6,2)` point at closed boards → X gets a free move → `(8,8)` wins; `(6,8)` points at board 8 → `(8,8)` wins; `(6,6)` self-points at an open board and holds |
| TA-018 | AC-35 | `FX-MUSTBLOCK` | `choose(s, Easy, seed, 0)`, seeds 1..100 | legal moves only; **no** requirement to find `(6,6)`. Record the hit rate as telemetry: an Easy that finds it on > 40% of seeds means Easy is accidentally searching |
| TA-019 | AC-36 | `FX-NEW` | `choose(s, Hard, 1, 200)`, 20 repetitions, `js-test` | every run `Some(plan)` with `plan.depth >= 1`; median wall clock ≤ 250 ms; p95 ≤ 300 ms; **max ≤ 700 ms** (a hard ceiling that catches a runaway ply, distinct from the p95 that catches slow CI) |
| TA-020 | AC-36 | `FX-NEW` | `choose(s, Hard, 1, 1500)`, 20 repetitions, `js-test` | every run `plan.depth >= 3`; p95 wall clock ≤ 1800 ms |
| TA-021 **[ADV]** | AC-36 | `FX-NEW`, `G-20`, `G-CLOSED` | budgets `{50, 200, 600, 1500}`, `js-test` | `depth(1500) >= depth(600) >= depth(200) >= depth(50) >= 1` on each position — monotone in budget. Non-monotonicity means a ply is being returned half-searched |
| TA-022 **[ADV]** | AC-36/FR-4.5 | `FX-NEW` | `choose(s, Hard, 1, 0)` and `choose(s, Hard, 1, -1)` | `Some(plan)` with a legal move and `depth >= 1`. §6.4 says the depth-1 result is computed *before* any clock check; zero and negative budgets are the direct test of that sentence and the spec never states them |
| TA-023 **[ADV]** | AC-36/D-A6 | `G-20` | record `(move, depth)` from fixed-depth runs at depths 1..6; then run with budgets `{50,200,600,1500}` | each budgeted run's `(move, depth)` equals the fixed-depth run's move **at that same depth**. This is the observable proof that an overrun ply is discarded whole rather than returned partially searched |
| TA-024 | AC-37 | the 20 fixtures = the 18 states of `G-XWIN` (plies 0..17) + `FX-TIE43` + `FX-ALLDRAWN` | `evaluate(s, X)` and `evaluate(s, O)` | `evaluate(s,X) == -evaluate(s,O)` in all 20, including the 3 terminal ones |
| TA-025 **[ADV]** | AC-37 | each of the 20 fixtures and its colour mirror (swap every X↔O in `cells` and in `turn`) | `evaluate(mirror(s), O)` vs `evaluate(s, X)` | equal. Antisymmetry alone is satisfied by a function that is wrong for both colours in the same way; mirror symmetry catches an X-biased weight table |
| TA-026 **[ADV]** | AC-37 | `G-XWIN` (X won), `FX-ALLDRAWN` (drawn) | `evaluate` | `> 900000` for X on the win, `< -900000` for O, exactly `0` on the draw. Terminal states must short-circuit and contribute **no** positional terms |
| TA-027 | AC-40 | `S_centre` = board 4 = `WX012`, rest `EMPTY`, forced `None`, turn O; `S_corner` = the same with board 0 = `WX012` | `evaluate(_, X)` on both | `evaluate(S_centre, X) - evaluate(S_corner, X) == 40` **exactly**. Both states have one board won (+100), identical dead cells, identical `forced`, so the centre bonus is the only difference. An inequality-only assertion would pass a weight table with the ordering right and the magnitude wrong |
| TA-028 | AC-40 | parent = board 3 = `WX012` (closed), rest `EMPTY`, forced `Some(0)`, turn X. `A = apply(parent,{0,3})` (points at closed board 3 → free move), `B = apply(parent,{0,1})` (points at open board 1) | `evaluate(A, X)` vs `evaluate(B, X)` | `evaluate(A,X) == evaluate(B,X) - 12` **exactly**. Cells 1 and 3 are both edges (weight 0) and neither creates a two-in-a-row, so the free-move penalty is the only term that differs |
| TA-029 **[ADV]** | AC-40 | 12-position tactical suite (§4.7) | `evaluate` ordering | for each pair, the position the requirement calls stronger scores higher: boards-won > centre board > centre cells > two-in-a-row, and free-move-given < free-move-withheld. Proves FR-4.2's stated *ordering*, not just D-A3's numbers |

### 4.5 Classic ladder (AC-38)

| Id | AC | Input | Expected |
|---|---|---|---|
| TA-030 | AC-38 | `classic_choose(xox.from_text("OO.XX...."), O, Easy)` | `Some(2)` — identical to `xox.choose_move(..., Careless)`, which is `xox.glyph`'s own passing example |
| TA-031 | AC-38 | `classic_choose(xox.from_text("XX......."), O, Medium)` | `Some(2)` — identical to `xox.choose_move(..., Fair)` |
| TA-032 | AC-38 | `classic_choose(xox.from_text("XOXXOOOXX"), X, Hard)` | `None` — identical to `xox.choose_move(..., Perfect)` |
| TA-033 | AC-38 | `classic_choose(b, me, d)` vs `xox.choose_move(b, me, mapped(d))` over all 3 difficulties × 30 random reachable Classic boards | identical results — the mapping is total, not just correct on 3 samples |
| TA-034 | AC-38 | `glyph check src` | reports **all 14** of `xox.glyph`'s original examples passing, and `git diff --exit-code src/xox.glyph` is clean (D-4: the file is frozen, not merely compatible) |
| TA-035 **[ADV]** | §6 | `difficulty_from("easy" \| "medium" \| "hard" \| "HARD" \| "" \| "perfect")` | `Easy, Medium, Hard, Hard, Hard, Hard` — the spec's "else Hard" is a safety default and the case-sensitivity behaviour must be pinned |

### 4.6 Proving the three levels are meaningfully different (G-2, FR-4.3, AC-39)

A single 20-game match is not a proof; §12.3 of the spec flags this itself. This
protocol replaces it with three things that fail for different reasons: a
**deterministic strength ladder**, a **tactical competence suite**, and a
**behavioural-distinctness check**. All three must pass.

#### Protocol AI-L1 — deterministic strength ladder (AC-39)

*Configuration.* Hard runs at a **fixed depth cap of 4 with `budget_ms = 10^9`**,
so no clock enters the result and the whole ladder is bit-reproducible on any
machine. Wall-clock behaviour is proved separately by TA-019…TA-023 and TU-001.
Running the ladder under a real time budget would make CI failures
uninvestigable, which is the actual reason AC-39 reads as flaky.

*Seeds.* Games use the spread seed set `s_k = k * 7919` for `k = 1..20`, **not**
`1..20`. Justification in §4.6.1: consecutive MINSTD seeds are linear in the
seed, so Easy's uniform pick walks the move list in a fixed stride and a
sequentially-seeded match is 20 correlated games, not 20 independent ones.

*Matches.* For each ordered pair, 40 games: 20 with A moving first, 20 with B
moving first, one game per seed. Score: win 1, draw 0.5, loss 0.

| Id | AC | Match | Threshold | One-sided p under "no difference" (p=0.5) |
|---|---|---|---|---|
| TA-036 | AC-39 | Hard vs Easy | Hard ≥ **36 / 40** (90%) | ≈ 2e-7 |
| TA-037 | AC-39 | Hard vs Medium | Hard ≥ **28 / 40** (70%) | ≈ 6e-3 |
| TA-038 | AC-39 | Medium vs Easy | Medium ≥ **30 / 40** (75%) | ≈ 8e-4 |
| TA-039 | AC-39 | ordering | `score(Hard vs Easy) ≥ score(Medium vs Easy)` and both ≥ `score(Hard vs Medium)` | the ladder is monotone, not merely three passing matches |
| TA-040 | AC-39 | reproducibility | running TA-036…TA-038 twice yields **identical** `encode` transcripts for all 120 games | a failure is a diagnosable game record, not a flake |
| TA-041 | AC-39 | colour balance | in each match, neither colour accounts for more than 70% of the stronger side's points | catches a first-move-only artefact |

If a threshold is missed, the remedy is more games at the same thresholds
(scaled by √n), never a weaker threshold — spec §12.3.

#### Protocol AI-L2 — tactical competence suite

12 positions, each with a known-correct move, deterministic, ~1 second total.
This is the test that says *why* Hard is better, and it fails loudly and
specifically when the ladder fails vaguely.

| Group | Positions | Correct move is… |
|---|---|---|
| Immediate meta win available | 4 (incl. `G-XWIN@16`) | the game-winning move |
| Must-block-or-lose | 4 (incl. `FX-MUSTBLOCK`) | the unique non-losing move |
| Mini-board win available, no meta consequence | 2 | the board-claiming move |
| Free-move trap (every move but one hands a free move into a won board) | 2 | the move that withholds the free move |

| Id | AC | Assertion |
|---|---|---|
| TA-042 | G-2 | Hard solves **12 / 12**, every seed |
| TA-043 | G-2 | Medium solves **≥ 9 / 12** on its non-error seeds (it must get all 4 immediate wins and all 4 blocks; the 4 subtler ones are optional at depth 3) |
| TA-044 | G-2 | Easy solves **exactly the 4 immediate-win positions** on every seed, and the remaining 8 at no better than chance ± 15pp. Easy scoring high here means it is secretly searching; scoring 0 on the wins means D-A1 step 1 is broken |

#### Protocol AI-L3 — behavioural distinctness

| Id | AC | Assertion |
|---|---|---|
| TA-045 | G-2 | On a fixed mid-game position with ≥ 20 legal moves, over 100 spread seeds: Easy produces **≥ 15 distinct moves**, Medium **≤ 6**, Hard **exactly 1**. Three levels with the same move-distribution shape are not three levels |
| TA-046 | G-2 | Mean nodes per move over 20 positions: `nodes(Hard) ≥ 20 × nodes(Medium)` and `nodes(Easy) == 0`. Easy performs no search by construction (D-A1) |
| TA-047 | G-2 | Mean game length in AI-L1's Hard-vs-Easy games is shorter than in Medium-vs-Easy — a stronger engine converts faster. Reported as telemetry with a warning threshold, not a hard failure |

#### 4.6.1 Why the seed set matters (verified)

With `seed_next(x) = (x * 48271) % 2147483647` and `rand_below(s, n) = seed_next(s) % n`:

- For `s ≤ 44488`, `48271 * s < 2147483647`, so **no modular reduction happens**
  and `seed_next(s) = 48271 * s` exactly.
- `gcd(48271 mod 100, 100) = gcd(71, 100) = 1`, so `s ↦ rand_below(s, 100)` is a
  **bijection** on `0..99` over `s ∈ 1..100`. Sequential seeds sweep every
  residue exactly once.
- Consequence for TA-013: over `s ∈ 1..200` each residue occurs exactly twice, so
  `r < 15` happens on exactly **30** seeds — 15.0%, not 15% ± 5%.
- Consequence for TA-012: `r < 35` happens on exactly **35** of seeds 1..100.
- Consequence for AI-L1: with 81 legal moves, `rand_below(s, 81)` over
  `s = 1, 2, 3, …` yields indices `76, 71, 66, 61, 56, …` — a fixed stride of
  −5. Uniform in aggregate, strongly correlated between adjacent seeds. Hence the
  `k * 7919` spread set for anything that plays a *game*, and the sequential set
  for anything that measures a *rate*.

This is the one place where the PRNG's structure is load-bearing for the tests,
so it is written down rather than assumed.

### 4.7 The 12-position tactical suite

Built from the fixture library so no new literals are needed: `G-XWIN@16`,
`G-XWIN@10`, `FX-TERMFORCED`, `FX-DIAG` (win group); `FX-MUSTBLOCK` and 3
variants with the trap board rotated to boards 2, 5, 7 (block group);
`FX-WINLAST`, `G-CLOSED` (claim group); two free-move traps derived from
`FX-WONFREE` by closing the alternative targets (trap group). Each carries its
expected move in the fixture table so the suite is self-documenting.

---

## 5. Worker boundary and build (AC-41 … AC-46)

### 5.1 Build safety (AC-41)

| Id | AC | Action | Expected |
|---|---|---|---|
| TW-001 | AC-41 | `grep -rn 'node:' <bundle>` | zero matches |
| TW-002 | AC-41 | `grep -rnE 'from ["'"'"']std/' <bundle>` including `.glyph-runtime/std/*` | zero matches — §1.2 warns at least one stdlib file imports a bare `std/result`, so the rewrite must reach inside the runtime directory |
| TW-003 | AC-41 | `grep -rnwE 'document\|window\|localStorage' <bundle>` | zero matches |
| TW-004 | AC-41 | load the bundle in a real `Worker` with every network request intercepted and aborted | the worker starts and answers a `legalMoves` request; **exactly one** request is made (the bundle itself) |

### 5.2 Contract surface (AC-42)

| Id | AC | Action | Expected |
|---|---|---|---|
| TW-005 | AC-42 | enumerate the worker module's exported names | set equality with `{getLegalMoves, applyMove, getWinner, isTerminal, getOutcome, chooseMove}` — extras fail too, "exactly" is normative |
| TW-006 | AC-42 | for 10 fixtures, compare each JS name's result with its Glyph counterpart run directly | `getLegalMoves` ≡ `legal_moves`, `applyMove` ≡ `apply_move`, `getWinner` ≡ `winner`, `isTerminal` ≡ `is_terminal`, `getOutcome` ≡ `outcome`, `chooseMove` ≡ `ai.choose`. Delegation proved behaviourally, not by inspection |
| TW-007 **[ADV]** | AC-42 | `getWinner` on `FX-TIEEQ` (drawn) and on `G-20` (in progress) | `null` in both — and `getOutcome` distinguishes them. Documents why FR-3.2's four contracts are not sufficient for the UI |

### 5.3 Rejection over the boundary (AC-43)

Each case sends `{id, type:"applyMove", state, move}` and expects
`{id, type:"rejected", error:{code}}`. Because the wire `state` is an `encode`
string, every fixture here **must** be a replay literal (gap **G-1**).

| Id | AC | Wire state | Move | Expected `code` |
|---|---|---|---|---|
| TW-008 | AC-43 | `G-XWIN` | `{1,0}` | `GameOver` |
| TW-009 | AC-43 | `G-20` | `{9,0}` | `OutOfRange` |
| TW-010 | AC-43 | `G-CLOSED@5` | `{3,0}` | `WrongBoard` (required 2, got 3) |
| TW-011 | AC-43 | `G-CLOSED` | `{4,3}` | `BoardClosed` |
| TW-012 | AC-43 | `G-CLOSED` | `{0,4}` | `CellTaken` |
| TW-013 | AC-43 | all of the above | — | the response is never an exception, never a `{type:"result"}` with a silently unchanged state |
| TW-014 **[ADV]** | AC-43 | `G-20` | fuzz: 1000 moves with random integer, fractional, negative, huge, `null` and string coordinates | every one returns `rejected` or `result`; **zero** throws, zero worker terminations |

### 5.4 Protocol behaviour (AC-44)

| Id | AC | Action | Expected |
|---|---|---|---|
| TW-015 | AC-44 | send one request of each type with distinct ids | every response carries the matching `id` |
| TW-016 | AC-44 | send `{id: 42, type: "frobnicate"}` | `{id: 42, type: "error"}`; then a following `legalMoves` request succeeds — the worker stayed alive |
| TW-017 | AC-44 | send a request with a malformed `state` string (`"U1|X|zz"`) | `{type: "error"}` with the decode message, not a crash and not a `rejected` |
| TW-018 | AC-44 | send a request with a missing `state` field, and one that is not an object | `{type: "error"}` in both; worker alive afterwards |
| TW-019 **[ADV]** | AC-44 | `cancel` a running `choose` | a `{type:"cancelled", target}` response and **no** later `chosen` for that id; latency ≤ one ply |
| TW-020 **[ADV]** | AC-44 | `cancel` with a `target` that is not running | a response is emitted (spec is silent — see gap **G-5**); the worker stays alive |
| TW-021 **[ADV]** | AC-44 | two `choose` requests in flight at once | both ids receive exactly one terminal response each; §7.2 says the worker owns one job at a time but does not say what happens to the second — see gap **G-6** |
| TW-022 | AC-47 | encode a 20-move game, round-trip it through the worker, apply one more move, reload the page, decode | the restored state equals the pre-reload state on `state_to_text`, `forced`, `turn`, `history` |

### 5.5 Main thread (AC-45, AC-46)

| Id | AC | Action | Expected |
|---|---|---|---|
| TU-001 | AC-45 | `PerformanceObserver` on `longtask` while a Hard move runs in the worker with `budget_ms = 1500` | zero longtask entries above **50 ms** on the main thread |
| TU-002 **[ADV]** | AC-45 | **control**: run the identical search *on the main thread* with the same observer | at least one longtask above 50 ms fires. Without this control, TU-001 passes trivially when the observer is misconfigured |
| TU-003 **[ADV]** | AC-45/NFR-7.2 | count `requestAnimationFrame` callbacks during the 1500 ms search | ≥ 50 frames — the UI is not merely un-blocked, it is still animating |
| TU-004 | AC-46 | stub worker that replies in < 10 ms; measure request → state-applied | ≥ **300 ms** |
| TU-005 **[ADV]** | AC-46 | same | ≤ **400 ms** — the floor must not become a ceiling; asserting only the lower bound passes a 5-second delay |
| TU-006 **[ADV]** | AC-46 | stub worker that replies in 800 ms | total ≤ 900 ms — no delay is added when the search already exceeded the floor |
| TU-007 **[ADV]** | AC-46 | three moves back to back with a fast worker | each interval ≥ 300 ms and total ≤ 1200 ms — the floors do not accumulate |
| TU-008 | AC-47/FR-6.1 | play 10 moves, reload the page for real | the position, `forced`, turn and full history are restored; the save is the `encode` string |

### 5.6 Harness-generated fixtures

Two cases need a position too long to write by hand. Both are generated
deterministically by the harness and **asserted to have the required property
before the case's real assertion runs**, so they can never pass vacuously.

| Fixture | Generated by | Pre-assertion |
|---|---|---|
| `G-FULL81` (TE-081) | self-play, Easy vs Easy, spread seeds, first game reaching 81 plies with no meta line | `array.len(history) == 81` and `outcome ∈ {Drawn, Won(_, [])}` |
| `G-TERM-*` (TW-008 and any GameOver case needing variety) | self-play, fixed-depth Hard vs Hard, seed 1 | `is_terminal == true` before use |

---

## 6. Adversarial cases the spec does not enumerate

Collected here so a reviewer can see the reasoning in one place. All are tagged
**[ADV]** above.

1. **Terminal state with a non-`None` `forced`** (TE-066). §5 E-7 mentions in
   passing that "the winning state's `forced` is whatever normalisation
   produced", but no AC tests it. `FX-TERMFORCED` produces a genuinely terminal
   state with `forced == Some(4)` pointing at an empty, open board. Any
   `legal_moves` that reads `forced` before testing `is_terminal` returns 9
   moves. Highest-value case in the matrix.
2. **The full check-precedence ladder** (TE-009, TE-015, TE-068, TE-069). §3.2
   declares the order normative; AC-6 tests only one of the four adjacent pairs.
   All four are now covered, plus GameOver-dominates-OutOfRange.
3. **Non-integer and non-finite coordinates** (TE-010, TE-011). E-12 says
   "non-integer coordinates from the wire" but AC-6 only says "outside 0..8".
   `4.5` is *inside* 0..8; `NaN` compares false against both bounds. The range
   check must test integrality, not just magnitude.
4. **Closing the board you played in while pointing elsewhere** (TE-067).
   `FX-WINLAST` closes board 0 and points at open board 2, so `forced` must be
   `Some(2)`. E-6 covers the self-pointing case; this is its complement and is
   the more common shape in real play.
5. **Meta line beats board count** (TE-070). §3.3 orders the outcome scan, but no
   AC constructs a position where the two rules disagree. `FX-LINEBEATS` gives O
   the line and X the larger tally.
6. **`state_from_text` fixtures violate I-5** (TE-080, gap G-1). Every fixture
   has `history == []` with cells filled, so `undo` returns `None` mid-game and
   `encode` emits an empty move list — losing the entire position.
7. **`forced` normalisation of out-of-range indices** (TE-073). I-4 talks about
   closed boards; `Some(12)` is neither open nor closed.
8. **`playable_boards` on a terminal state** (TE-075, gap G-3). Undefined in the
   spec; must be `[]` to stay consistent with `legal_moves`, or UI-5.1 will
   highlight a playable board after the game ends.
9. **`decode` of an empty move list** (TE-062). `"U1|X|"` is what `encode`
   produces for a brand-new game, so it must decode to `Ok`, not `Err`.
10. **Replay-validation beyond 81 moves** (TE-063). Proves `decode` validates by
    replaying rather than by counting digits.
11. **`choose` must not mutate its input** (TA-003) and **`choose(s)` must equal
    `choose(search_root(s))`** (TA-004). D-U5 is the spec's most delicate
    optimisation and has no AC of its own.
12. **Hard with a zero or negative budget** (TA-022). §6.4's "the depth-1 result
    is computed before any clock check" is exactly the FR-4.5 guarantee, and
    zero/negative budgets are the only inputs that isolate it.
13. **Discarded-ply proof** (TA-023). D-A6 says an overrunning ply is discarded
    whole; comparing budgeted results against fixed-depth results at the same
    depth makes that observable.
14. **Medium with exactly one legal move** (TA-015). The 15% error branch must
    not attempt to pick "a move other than the best" from a set of size 1.
15. **Colour-mirror symmetry of `evaluate`** (TA-025). Antisymmetry is satisfied
    by a function that is equally wrong for both colours.
16. **Exact heuristic deltas** (TA-027, TA-028) rather than inequalities: `+40`
    for the centre board, `−12` for the free move. AC-40 as written passes a
    weight table with the right ordering and wrong magnitudes.
17. **MINSTD seed correlation** (§4.6.1). Sequential seeds are a linear sweep,
    which makes rate assertions exact but makes self-play matches correlated.
18. **Longtask control experiment** (TU-002). A negative-result test needs proof
    that the instrument can produce a positive result.
19. **The 300 ms floor as a band, not a bound** (TU-005, TU-007).
20. **Worker liveness after every error path** (TW-014, TW-016, TW-017,
    TW-018). AC-44 tests liveness after an unknown `type` only.

---

## 7. Gaps and ambiguities found while writing this matrix

These block nothing, but each needs a one-line decision before the module is
written, and each has a case above that will pin whatever is decided.

- **G-1 — `state_from_text` states have no history.** The spec never states what
  `state_from_text` puts in `history`. If it is `[]` (the only sensible choice),
  then I-5 holds for replay-built states only, `undo` on a fixture returns
  `None`, and `encode` on a fixture emits `"U1|<turn>|"` — silently discarding
  the position. Consequence: **fixture-built states must never cross the worker
  boundary or reach persistence.** Recommend saying so in §3.5 and restricting
  `state_from_text` to tests and debugging in its doc comment. Cases: TE-080,
  and the replay-only rule for §5.3.
- **G-2 — `first_player(s)` is undefined for fixture states.** §3.5 derives it
  from `array.len(history)` parity; with an empty history it always returns
  `turn`, which is wrong for any fixture where O is to move after an odd number
  of plies. Same root cause as G-1.
- **G-3 — `playable_boards` on a terminal state** is unspecified. Recommend `[]`.
  Case TE-075.
- **G-4 — `decode` and surrounding whitespace.** A save round-tripped through
  `localStorage` or a text field can pick up a trailing newline. Strict or
  lenient is fine; it must be decided and documented. Case TE-065.
- **G-5 — `cancel` for an unknown or already-finished target.** §7.2 lists the
  `cancelled` response but not this case. Case TW-020.
- **G-6 — a second `choose` while one is running.** "The worker owns one job at a
  time" does not say whether the second is queued, rejected, or supersedes the
  first. Case TW-021.
- **G-7 — AC-36's elapsed bound is stated two ways.** §10's AC-36 row says
  `elapsed <= 200 + 100 ms`; the task brief says `<= 300 ms`. Same number, but
  the matrix uses a p95/max split (TA-019) because a single max on CI is a
  flake generator.
- **G-8 — `rand_below`'s definition is not in the spec.** §6.1 fixes the
  generator but not whether `rand_below(seed, n)` advances the seed before
  reducing. TA-013's exact count of 30/200 assumes it does. Whichever is chosen,
  it must be documented, because the AC-34 assertion follows from it.

---

## 8. Verification notes

Every literal in §2 was executed against a reference implementation of the §3
`apply_move` / `legal_moves` / `outcome` rules before being recorded here.
Specifically confirmed:

- all 14 mini-board patterns produce the stated `MiniStatus`, including the
  `L1` win/draw pair and the `win_lines` **order** for `DIAG` (`[0,4,8]`) and
  `FX-TERMFORCED`'s board 2 (`[1,4,7]`);
- all four replay games are legal move-for-move, with the stated `forced` value
  after every ply and the stated terminal outcome;
- `G-XWIN`'s 17th move closes board 8 **and** completes meta line `[0,4,8]` in
  one move, which is E-7 occurring naturally in a legal game rather than in a
  synthetic fixture;
- the legal-move counts 81, 71, 62, 72, 69, 9, 7, 5, 1 and 0 in §2.2 and §3;
- `FX-MUSTBLOCK` has exactly 4 legal replies of which exactly one, `(6,6)`,
  survives — the other three lose because they point at a closed board (free
  move) or at board 8 directly;
- `FX-TERMFORCED` reaches a terminal state carrying `forced == Some(4)` with
  `legal_moves == []`;
- `FX-LINEBEATS` is `Won(O, [0,1,2])` while X holds 4 boards to O's 3;
- the parity column in §2.2 (only `FX-BOTHLINES` is synthetic, deliberately);
- the MINSTD arithmetic in §4.6.1, including that `48271 * 2147483646` is exact
  in float64 while `1103515245 * 2147483646` is not, and the exact counts
  30/200 and 35/100.
