(function(){
  var EMPTY = ".........";
  var CENTER = [60,160,260];
  var LEVEL_NAME = {perfect:"Perfect", fair:"Fair", careless:"Careless", human:"Two players"};

  var state = {
    board: EMPTY, turn: "X", you: "X", level: "perfect",
    status: "ongoing", line: [], evals: [], xray: false,
    busy: false, counted: false, tally: {you:0, cpu:0, draw:0}
  };
  var drawn = [];

  var svg = document.getElementById("board");
  var caption = document.getElementById("caption");

  function cx(i){ return CENTER[i % 3]; }
  function cy(i){ return CENTER[Math.floor(i / 3)]; }
  function at(s, i){ return s.charAt(i); }
  function setAt(s, i, ch){ return s.slice(0, i) + ch + s.slice(i + 1); }
  function vsEngine(){ return state.level !== "human"; }
  function over(){ return state.status !== "ongoing"; }

  function gridMarkup(){
    var out = '<rect class="slate" x="0.5" y="0.5" width="319" height="319" rx="6"/>';
    var i, p;
    for(i = 1; i <= 2; i++){
      p = 10 + i * 100;
      out += '<path class="grid-line" d="M ' + p + ' 22 Q ' + (p + 2) + ' 160 ' + p + ' 298"/>';
      out += '<path class="grid-line" d="M 22 ' + p + ' Q 160 ' + (p - 2) + ' 298 ' + p + '"/>';
    }
    return out;
  }

  function markMarkup(i, ch, cls){
    var x = cx(i), y = cy(i), r = 30;
    if(ch === "X"){
      return '<g class="mark x ' + cls + '">' +
        '<path pathLength="1" d="M ' + (x-r) + ' ' + (y-r) + ' L ' + (x+r) + ' ' + (y+r) + '"/>' +
        '<path pathLength="1" d="M ' + (x+r) + ' ' + (y-r) + ' L ' + (x-r) + ' ' + (y+r) + '"/>' +
        '</g>';
    }
    return '<g class="mark o ' + cls + '">' +
      '<circle pathLength="1" cx="' + x + '" cy="' + y + '" r="' + r + '"/></g>';
  }

  function verdictFor(sq){
    var i, e;
    for(i = 0; i < state.evals.length; i++){
      e = state.evals[i];
      if(e.square === sq){ return e; }
    }
    return null;
  }

  function verdictMarkup(i){
    var e = verdictFor(i);
    if(!e){ return ""; }
    var text, cls;
    if(e.score > 0){ text = "win " + (10 - e.score); cls = "good"; }
    else if(e.score < 0){ text = "loss " + (e.score + 10); cls = "bad"; }
    else { text = "draw"; cls = "even"; }
    return '<text class="verdict ' + cls + '" x="' + cx(i) + '" y="' + (cy(i) + 5) + '">' +
      text + '</text>';
  }

  function streakMarkup(){
    if(state.line.length !== 3){ return ""; }
    var a = state.line[0], b = state.line[2];
    return '<path class="streak" pathLength="1" d="M ' + cx(a) + ' ' + cy(a) +
      ' L ' + cx(b) + ' ' + cy(b) + '"/>';
  }

  function render(){
    var html = gridMarkup();
    var i, ch, fresh, showXray;
    showXray = state.xray && !over() && !state.busy;
    for(i = 0; i < 9; i++){
      ch = at(state.board, i);
      if(ch === "X" || ch === "O"){
        fresh = drawn.indexOf(i) < 0;
        if(fresh){ drawn.push(i); }
        html += markMarkup(i, ch, fresh ? "fresh" : "");
      } else if(showXray){
        html += verdictMarkup(i);
      }
    }
    html += streakMarkup();
    for(i = 0; i < 9; i++){
      if(at(state.board, i) === "."){
        html += '<g class="ghost" id="ghost' + i + '">' +
          markMarkup(i, state.turn, "") + '</g>';
      }
    }
    for(i = 0; i < 9; i++){
      if(at(state.board, i) === "." && !over()){
        html += '<rect class="cell" data-i="' + i + '" tabindex="0" role="button" ' +
          'aria-label="square ' + (i + 1) + '" x="' + (cx(i) - 50) + '" y="' + (cy(i) - 50) +
          '" width="100" height="100" rx="4"/>';
      }
    }
    svg.innerHTML = html;
    svg.classList.toggle("locked", state.busy || over());
    paintStatus();
    paintTally();
  }

  function paintStatus(){
    var word = document.getElementById("statusWord");
    var note = document.getElementById("statusNote");
    var box = document.getElementById("status");
    var winner = state.status.charAt(0);
    var w, n;
    if(state.busy && !over()){
      w = "Engine thinking"; n = LEVEL_NAME[state.level] + " · depth 9";
    } else if(state.status === "draw"){
      w = "Draw"; n = "Neither side could force it";
    } else if(over()){
      if(!vsEngine()){ w = winner + " wins"; n = "Two players"; }
      else if(winner === state.you){ w = "You win"; n = "Against " + LEVEL_NAME[state.level].toLowerCase(); }
      else { w = "Engine wins"; n = LEVEL_NAME[state.level] + " opponent"; }
    } else if(!vsEngine()){
      w = state.turn + " to move"; n = "Two players";
    } else {
      w = "Your move"; n = "You are " + state.you + " · " + LEVEL_NAME[state.level];
    }
    word.textContent = w;
    note.textContent = n;
    box.classList.toggle("thinking", state.busy && !over());
    box.style.borderLeftColor = state.turn === "X" ? "var(--x)" : "var(--o)";
    caption.textContent = state.xray && !over()
      ? "engine reading for " + state.turn + " — plies to the result"
      : "";
  }

  // The first two slots mean "you / engine" against the engine, and "X / O"
  // between two people.
  function paintTally(){
    document.getElementById("tallyYou").textContent = state.tally.you;
    document.getElementById("tallyCpu").textContent = state.tally.cpu;
    document.getElementById("tallyDraw").textContent = state.tally.draw;
    document.getElementById("labelYou").textContent = vsEngine() ? "you" : "X";
    document.getElementById("labelCpu").textContent = vsEngine() ? "engine" : "O";
  }

  function countGame(){
    if(state.counted || !over()){ return; }
    state.counted = true;
    var winner = state.status.charAt(0);
    if(state.status === "draw"){ state.tally.draw++; }
    else if(!vsEngine()){ if(winner === "X"){ state.tally.you++; } else { state.tally.cpu++; } }
    else if(winner === state.you){ state.tally.you++; }
    else { state.tally.cpu++; }
  }

  function send(square){
    if(state.busy || over()){ return; }
    state.busy = true;
    render();
    fetch("/api/move", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        board: state.board, square: square, turn: state.turn, level: state.level
      })
    }).then(function(r){ return r.json(); })
      .then(apply)
      .catch(offline);
  }

  function offline(){
    state.busy = false;
    render();
    document.getElementById("statusWord").textContent = "Server unreachable";
    document.getElementById("statusNote").textContent = "Restart glyph run, then reload";
  }

  function apply(res){
    if(res.error){ offline(); return; }
    if(res.played >= 0){
      state.board = setAt(state.board, res.played, state.turn);
      render();
    }
    if(res.reply >= 0){
      window.setTimeout(function(){ settle(res); }, 320);
    } else {
      settle(res);
    }
  }

  function settle(res){
    state.board = res.board;
    state.turn = res.turn;
    state.status = res.status;
    state.line = res.line;
    state.evals = res.evals;
    state.busy = false;
    countGame();
    render();
  }

  function newGame(){
    state.board = EMPTY;
    state.turn = "X";
    state.status = "ongoing";
    state.line = [];
    state.evals = [];
    state.busy = false;
    state.counted = false;
    drawn = [];
    render();
    if(vsEngine() && state.you === "O"){
      state.turn = "O";
      send(-1);
    } else if(state.xray){
      peek();
    }
  }

  // Asks the server to evaluate without playing anything.
  function peek(){
    fetch("/api/move", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        board: state.board, square: -1, turn: state.turn, level: "human"
      })
    }).then(function(r){ return r.json(); })
      .then(function(res){ state.evals = res.evals; render(); })
      .catch(offline);
  }

  svg.addEventListener("click", function(ev){
    var cell = ev.target.closest(".cell");
    if(cell){ send(parseInt(cell.getAttribute("data-i"), 10)); }
  });

  svg.addEventListener("keydown", function(ev){
    var cell = ev.target.closest(".cell");
    if(cell && (ev.key === "Enter" || ev.key === " ")){
      ev.preventDefault();
      send(parseInt(cell.getAttribute("data-i"), 10));
    }
  });

  svg.addEventListener("pointerover", function(ev){
    var cell = ev.target.closest(".cell");
    if(!cell || state.busy){ return; }
    var g = document.getElementById("ghost" + cell.getAttribute("data-i"));
    if(g){ g.style.opacity = ".17"; }
  });

  svg.addEventListener("pointerout", function(ev){
    var cell = ev.target.closest(".cell");
    if(!cell){ return; }
    var g = document.getElementById("ghost" + cell.getAttribute("data-i"));
    if(g){ g.style.opacity = "0"; }
  });

  document.getElementById("levelSeg").addEventListener("click", function(ev){
    var b = ev.target.closest("button");
    if(!b){ return; }
    state.level = b.getAttribute("data-level");
    var all = this.querySelectorAll("button"), i;
    for(i = 0; i < all.length; i++){ all[i].classList.toggle("on", all[i] === b); }
    document.getElementById("sideField").classList.toggle("off", !vsEngine());
    // The first two tally slots change meaning with the mode, so the running
    // count starts over rather than mixing two different scoreboards.
    state.tally = {you: 0, cpu: 0, draw: 0};
    newGame();
  });

  document.getElementById("sideSeg").addEventListener("click", function(ev){
    var b = ev.target.closest("button");
    if(!b){ return; }
    state.you = b.getAttribute("data-side");
    var all = this.querySelectorAll("button"), i;
    for(i = 0; i < all.length; i++){ all[i].classList.toggle("on", all[i] === b); }
    newGame();
  });

  document.getElementById("xray").addEventListener("click", function(){
    state.xray = !state.xray;
    this.setAttribute("aria-pressed", state.xray ? "true" : "false");
    if(state.xray && state.evals.length === 0 && !over()){ peek(); } else { render(); }
  });

  document.getElementById("reset").addEventListener("click", newGame);

  document.addEventListener("keydown", function(ev){
    if(ev.metaKey || ev.ctrlKey || ev.altKey){ return; }
    var k = ev.key.toLowerCase();
    if(k === "r"){ newGame(); return; }
    if(k === "x"){ document.getElementById("xray").click(); return; }
    if(k >= "1" && k <= "9"){
      var i = parseInt(k, 10) - 1;
      if(at(state.board, i) === "."){ send(i); }
    }
  });

  newGame();
})();
