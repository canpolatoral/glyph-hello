// assets/ultimate-ui.js — the Ultimate board (owner: UI-Ultimate).
//
// Owns every node inside the container it is handed and nothing outside it.
// It knows no engine and no worker: `mountUltimate` takes a plain view object
// (produced by app.js from the Glyph UState) and paints it.
//
// The board is DOM, not SVG (architecture §5.1): 81 <button> cells inside 9
// mini boards inside one CSS grid, so focus, touch targets and ARIA come for
// free. The big claimed-board marks and the winning line are SVG layered on
// top with pointer-events:none.

const SVG = "http://www.w3.org/2000/svg";

const ROW_WORD = ["top", "middle", "bottom"];
const COL_WORD = ["left", "centre", "right"];

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function svgEl(tag, cls, parent) {
  const n = document.createElementNS(SVG, tag);
  if (cls) n.setAttribute("class", cls);
  if (parent) parent.appendChild(n);
  return n;
}

// A mark drawn the way the Classic board draws them: pathLength=1 strokes that
// animate themselves in.
function markSvg(mark, cls) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 40 40");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", cls + " " + (mark === "X" ? "x" : "o"));
  if (mark === "X") {
    for (const d of ["M 11 11 L 29 29", "M 29 11 L 11 29"]) {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("pathLength", "1");
      p.setAttribute("d", d);
      s.appendChild(p);
    }
  } else {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("pathLength", "1");
    c.setAttribute("cx", "20");
    c.setAttribute("cy", "20");
    c.setAttribute("r", "10");
    s.appendChild(c);
  }
  return s;
}

function place(i) {
  return ROW_WORD[Math.floor(i / 3)] + " " + COL_WORD[i % 3];
}

export function mountUltimate(container, opts) {
  const onPlay = (opts && opts.onPlay) || function () {};

  container.textContent = "";
  const root = el("div", "uboard", container);
  const scroll = el("div", "uboard-scroll", root);
  const meta = el("div", "umeta", scroll);
  // Not role="grid": a grid must contain rows and gridcells, and these are
  // nine nested groups of buttons. Claiming grid without that structure makes
  // the accessibility tree lie; nested labelled groups describe it honestly.
  meta.setAttribute("role", "group");
  meta.setAttribute("aria-label", "Ultimate tic tac toe board, nine mini boards");

  // Hand-drawn meta rules, matching the Classic grid lines.
  const rules = svgEl("svg", "umeta-rules", meta);
  rules.setAttribute("viewBox", "0 0 300 300");
  rules.setAttribute("preserveAspectRatio", "none");
  rules.setAttribute("aria-hidden", "true");
  for (const d of [
    "M 100 8 Q 102 150 100 292",
    "M 200 8 Q 198 150 200 292",
    "M 8 100 Q 150 102 292 100",
    "M 8 200 Q 150 198 292 200",
  ]) {
    svgEl("path", null, rules).setAttribute("d", d);
  }

  const streak = svgEl("svg", "ustreak", meta);
  streak.setAttribute("aria-hidden", "true");

  const minis = [];
  const cells = [];

  for (let b = 0; b < 9; b++) {
    const mini = el("div", "umini", meta);
    mini.setAttribute("role", "group");
    const flag = el("span", "umini-flag", mini);
    flag.textContent = String(b + 1);
    flag.setAttribute("aria-hidden", "true");
    minis.push({ node: mini, flag: flag, overlay: null, tag: null, cls: "", status: "open" });

    for (let i = 0; i < 9; i++) {
      const btn = el("button", "ucell", mini);
      btn.type = "button";
      btn.tabIndex = -1;
      btn.dataset.b = String(b);
      btn.dataset.i = String(i);
      cells.push({ node: btn, mark: ".", cls: "", label: "" });
    }
  }

  // ------------------------------------------------------------------ state

  let view = null;
  let cursor = 40; // flat index of the roving-tabindex cell
  let destroyed = false;
  cells[cursor].node.tabIndex = 0;

  function flat(b, i) {
    return b * 9 + i;
  }

  function isLegal(v, idx) {
    return v.legal.has(idx);
  }

  function moveCursor(next, focus) {
    if (next < 0 || next > 80) return;
    cells[cursor].node.tabIndex = -1;
    cursor = next;
    cells[cursor].node.tabIndex = 0;
    if (focus) cells[cursor].node.focus();
  }

  // Global 9x9 coordinates make arrows behave the obvious way: one step moves
  // inside the mini board and slides into the neighbour at its edge, shift
  // jumps a whole mini board.
  function toRC(idx) {
    const b = Math.floor(idx / 9);
    const i = idx % 9;
    return [Math.floor(b / 3) * 3 + Math.floor(i / 3), (b % 3) * 3 + (i % 3)];
  }

  function fromRC(r, c) {
    const b = Math.floor(r / 3) * 3 + Math.floor(c / 3);
    const i = (r % 3) * 3 + (c % 3);
    return b * 9 + i;
  }

  function clamp(n) {
    return Math.max(0, Math.min(8, n));
  }

  meta.addEventListener("keydown", (ev) => {
    const btn = ev.target.closest(".ucell");
    if (!btn) return;
    const idx = flat(Number(btn.dataset.b), Number(btn.dataset.i));
    const step = ev.shiftKey ? 3 : 1;
    let [r, c] = toRC(idx);

    switch (ev.key) {
      case "ArrowUp": r = clamp(r - step); break;
      case "ArrowDown": r = clamp(r + step); break;
      case "ArrowLeft": c = clamp(c - step); break;
      case "ArrowRight": c = clamp(c + step); break;
      case "Home": {
        const b = Math.floor(idx / 9);
        ev.preventDefault();
        moveCursor(b * 9, true);
        return;
      }
      case "End": {
        const b = Math.floor(idx / 9);
        ev.preventDefault();
        moveCursor(b * 9 + 8, true);
        return;
      }
      case "Enter":
      case " ":
        ev.preventDefault();
        play(idx);
        return;
      default:
        return;
    }
    ev.preventDefault();
    moveCursor(fromRC(r, c), true);
  });

  meta.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".ucell");
    if (!btn) return;
    play(flat(Number(btn.dataset.b), Number(btn.dataset.i)));
  });

  function play(idx) {
    if (!view || !view.interactive || !isLegal(view, idx)) return;
    moveCursor(idx, false);
    onPlay({ board: Math.floor(idx / 9), cell: idx % 9 });
  }

  // ----------------------------------------------------------------- render

  function miniClasses(v, b) {
    const s = v.boards[b];
    const out = ["umini"];
    if (s.state === "won") out.push("closed", "won-" + s.winner.toLowerCase());
    if (s.state === "drawn") out.push("closed", "drawn");
    if (v.playable.includes(b)) {
      out.push("playable");
      // Signal 2/3: the one board you must play in. Signal 5: on a free move
      // every open board gets the ring at half strength instead.
      out.push(v.forced === b ? "forced" : v.forced === null ? "free" : "");
    } else if (!v.over) {
      out.push("blocked");
    }
    return out.filter(Boolean).join(" ");
  }

  function cellLabel(v, b, i) {
    const s = v.boards[b];
    const mark = v.cells[b * 9 + i];
    const what = mark === "." ? "empty" : mark;
    const where = "board " + (b + 1) + " " + place(b) + ", cell " + (i + 1) + " " + place(i);
    if (s.state === "won") return where + ", " + what + ", board won by " + s.winner + ", closed";
    if (s.state === "drawn") return where + ", " + what + ", board drawn, closed";
    if (isLegal(v, b * 9 + i)) return where + ", empty, playable";
    return where + ", " + what + ", not playable";
  }

  function paintOverlay(m, s) {
    const want = s.state === "won" ? s.winner : s.state === "drawn" ? "drawn" : "open";
    if (m.status === want) return;
    if (m.overlay) { m.overlay.remove(); m.overlay = null; }
    if (m.tag) { m.tag.remove(); m.tag = null; }
    if (want === "X" || want === "O") {
      const fresh = m.status !== "open" ? "" : " fresh";
      m.overlay = markSvg(want, "umini-overlay" + fresh);
      m.overlay.setAttribute("viewBox", "0 0 40 40");
      m.node.appendChild(m.overlay);
    } else if (want === "drawn") {
      m.tag = el("span", "umini-drawn-tag", m.node);
      m.tag.textContent = "drawn";
      m.tag.setAttribute("aria-hidden", "true");
    }
    m.status = want;
  }

  function paintStreak(v) {
    streak.textContent = "";
    if (!v.metaLine || v.metaLine.length !== 3) return;
    const box = meta.getBoundingClientRect();
    if (box.width === 0) return;
    streak.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);
    const centre = (b) => {
      const r = minis[b].node.getBoundingClientRect();
      return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
    };
    const a = centre(v.metaLine[0]);
    const z = centre(v.metaLine[2]);
    const p = svgEl("path", null, streak);
    p.setAttribute("pathLength", "1");
    p.setAttribute("d", "M " + a[0] + " " + a[1] + " L " + z[0] + " " + z[1]);
  }

  function render(next) {
    if (destroyed) return;
    const prev = view;
    view = next;

    root.dataset.turn = next.turn;
    root.classList.toggle("over", !!next.over);
    root.classList.toggle("thinking", !!next.thinking);

    for (let b = 0; b < 9; b++) {
      const m = minis[b];
      const cls = miniClasses(next, b);
      if (cls !== m.cls) { m.node.className = cls; m.cls = cls; }
      const s = next.boards[b];
      const state =
        s.state === "won" ? "won by " + s.winner : s.state === "drawn" ? "drawn" : "open";
      m.node.setAttribute("aria-label", "mini board " + (b + 1) + " " + place(b) + ", " + state);
      // Signal 6: the forced board says so in words, right on the board.
      // "play here" is an instruction to the person holding the mouse, so it
      // only appears on their turn; while the engine thinks, the same ring
      // stays but the label goes quiet rather than ordering you to move.
      const yours = next.forced === b && !next.over && !next.thinking;
      const flag = yours ? "play here" : String(b + 1);
      if (flag !== m.flag.textContent) m.flag.textContent = flag;
      paintOverlay(m, s);

      for (let i = 0; i < 9; i++) {
        const idx = b * 9 + i;
        const c = cells[idx];
        const mark = next.cells[idx];

        if (mark !== c.mark) {
          c.node.textContent = "";
          if (mark !== ".") {
            const wasEmpty = !prev || prev.cells[idx] === ".";
            c.node.appendChild(markSvg(mark, "umark" + (wasEmpty ? " fresh" : "")));
          }
          c.mark = mark;
        }

        const bits = ["ucell"];
        if (mark === "." && isLegal(next, idx) && next.interactive) bits.push("legal");
        if (next.lastMove && next.lastMove.board === b && next.lastMove.cell === i) bits.push("last");
        if (s.state === "won" && s.line.indexOf(i) >= 0) bits.push("wincell");
        const cls2 = bits.join(" ");
        if (cls2 !== c.cls) { c.node.className = cls2; c.cls = cls2; }

        const playable = isLegal(next, idx) && next.interactive;
        c.node.setAttribute("aria-disabled", playable ? "false" : "true");
        const label = cellLabel(next, b, i);
        if (label !== c.label) { c.node.setAttribute("aria-label", label); c.label = label; }
      }
    }

    // Keep the keyboard cursor on something worth playing.
    if (!isLegal(next, cursor) || !next.interactive) {
      const first = next.legal.size ? Math.min(...next.legal) : cursor;
      const hadFocus = meta.contains(document.activeElement);
      moveCursor(first, hadFocus && next.interactive);
    }

    paintStreak(next);
  }

  function focusBoard() {
    cells[cursor].node.focus();
  }

  function destroy() {
    destroyed = true;
    container.textContent = "";
  }

  window.addEventListener("resize", () => {
    if (!destroyed && view) paintStreak(view);
  });

  return { render: render, focusBoard: focusBoard, destroy: destroy };
}
