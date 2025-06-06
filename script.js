/**
 * Main game logic for Circle Battle (Row Connect).
 * Uses Firebase Realtime Database to sync two-player state in real time.
 * ● Only rows/diagonals of length ≥ 2 are allowed.
 * ● After filling, newly-eligible lines appear as dashed overlays.
 * ● Tapping or “dragging” (pointerdown) on a dashed overlay draws it with animation.
 * ● No single-circle lines: filling the bottom circle won’t produce a 1-point line.
 */

import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js";

const db = window.__FIREBASE_DB__; // exposed in index.html

// ————————————————————————————————————————————————————————————
// 1. CONSTANTS & GLOBALS
// ————————————————————————————————————————————————————————————

const ROW_COUNT = 10;

// Build board structure: each row r (1..10) has (ROW_COUNT+1−r) circles, but later we will only allow lines if length ≥ 2.
let boardStructure = [];
for (let r = 1; r <= ROW_COUNT; r++) {
  const count = ROW_COUNT + 1 - r;
  boardStructure.push({
    row: r,
    cols: Array.from({ length: count }, (_, i) => i + 1),
  });
}

// Compute allowed line definitions (only rows + two diagonal sets), but only if length ≥ 2.
// That yields exactly: 
//   • Rows with ≥ 2 circles → r=1..9  (row 10 has 1 circle, so skip it).  
//   • "\" (↘) diagonals starting on top row whose length ≥ 2.  
//   • "/" (↙) diagonals starting on top row whose length ≥ 2.
let ALL_LINES = {}; // { lineId: { cells: [ {r,c}, ... ] } }

// 1) Rows (only if row has ≥ 2 circles, i.e. ROW_COUNT+1−r ≥ 2 ⇒ r ≤ ROW_COUNT−1)
for (let r = 1; r < ROW_COUNT; r++) {
  const cells = boardStructure
    .find((rowObj) => rowObj.row === r)
    .cols.map((c) => ({ r, c }));
  if (cells.length >= 2) {
    ALL_LINES[`row-${r}`] = { cells };
  }
}

// 2) "\" diagonals (↘) starting on row=1, col=c, if length ≥ 2
function collectDiagBackslash(startR, startC) {
  const cells = [];
  let r = startR,
    c = startC;
  while (r <= ROW_COUNT && c <= ROW_COUNT + 1 - r) {
    cells.push({ r, c });
    r++;
    c++;
  }
  return cells;
}
for (let c = 1; c <= ROW_COUNT; c++) {
  const cells = collectDiagBackslash(1, c);
  if (cells.length >= 2) {
    ALL_LINES[`diag_bslash-${c}`] = { cells };
  }
}

// 3) "/" diagonals (↙) starting on row=1, col=c, if length ≥ 2
function collectDiagSlash(startR, startC) {
  const cells = [];
  let r = startR,
    c = startC;
  while (r <= ROW_COUNT && c >= 1) {
    // But only accept if c ≤ ROW_COUNT+1−r (i.e., valid circle)
    if (c <= ROW_COUNT + 1 - r) {
      cells.push({ r, c });
      r++;
      c--;
    } else {
      break;
    }
  }
  return cells;
}
for (let c = 1; c <= ROW_COUNT; c++) {
  const cells = collectDiagSlash(1, c);
  if (cells.length >= 2) {
    ALL_LINES[`diag_fslash-${c}`] = { cells };
  }
}

// Build a quick lookup: lineId → [ "r_c", ... ]
const LINE_TO_KEYS = {};
Object.entries(ALL_LINES).forEach(([lineId, info]) => {
  LINE_TO_KEYS[lineId] = info.cells.map((pt) => `${pt.r}_${pt.c}`);
});

// ————————————————————————————————————————————————————————————
// 2. HELPERS: CELL KEYS, POSITIONS, ETC.
// ————————————————————————————————————————————————————————————

/** Return a string key "r_c" for row r, column c. */
function cellKey(r, c) {
  return `${r}_${c}`;
}

/**
 * Given a lineId, return an array of center‐points { x,y } **relative to #game-wrapper**,
 * to use for constructing an SVG <polyline>. This ensures pixel‐perfect alignment.
 */
function getLineCenterPoints(lineId) {
  const wrapperRect = document
    .getElementById("game-wrapper")
    .getBoundingClientRect();

  return LINE_TO_KEYS[lineId].map((k) => {
    const circleEl = document.querySelector(`.circle[data-key="${k}"]`);
    const circleRect = circleEl.getBoundingClientRect();
    return {
      x: circleRect.left + circleRect.width / 2 - wrapperRect.left,
      y: circleRect.top + circleRect.height / 2 - wrapperRect.top,
    };
  });
}

// ————————————————————————————————————————————————————————————
// 3. FIREBASE STATE INITIALIZATION & UTILS
// ————————————————————————————————————————————————————————————

/**
 * Use URL param ?gameId=xxx, or default to "defaultGame".
 */
function getGameId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("gameId") || "defaultGame";
}
const GAME_ID = getGameId();
const GAME_REF = ref(db, `games/${GAME_ID}`);

/**
 * Build the initial game‐state:
 *  cells: { "r_c": 0 } for every circle,
 *  turn: 1,
 *  scores: { "1":0, "2":0 },
 *  lines: {}  (drawn lines only)
 */
function buildInitialState() {
  const cells = {};
  boardStructure.forEach(({ row, cols }) => {
    cols.forEach((c) => {
      cells[cellKey(row, c)] = 0;
    });
  });
  return {
    cells,
    turn: 1,
    scores: { "1": 0, "2": 0 },
    lines: {}, // e.g. "row-3": 1  means Player 1 has drawn row-3
  };
}

/** Reset the DB node to a fresh initial state. */
function resetGameInDatabase() {
  const initState = buildInitialState();
  set(GAME_REF, initState);
}

// ————————————————————————————————————————————————————————————
// 4. BUILD THE BOARD DOM
// ————————————————————————————————————————————————————————————

const gameContainer = document.getElementById("game-container");
const svgOverlay = document.getElementById("lines-overlay");
const turnIndicator = document.getElementById("turn-indicator");
const player1ScoreEl = document.querySelector("#player1-score .score-value");
const player2ScoreEl = document.querySelector("#player2-score .score-value");
const resetBtn = document.getElementById("reset-btn");

let localPlayer = null;   // 1 or 2
let pendingLines = [];     // array of lineIds that are eligible but not yet drawn

/**
 * Prompt the user to pick Player 1 or Player 2 (stored in‐session).
 */
function promptForPlayer() {
  let choice = null;
  while (!["1", "2"].includes(choice)) {
    choice = prompt("Choose your player (1 or 2):").trim();
  }
  localPlayer = Number(choice);
}

/** Render the 10 rows of circles into #game-container. */
function renderBoard() {
  boardStructure.forEach(({ row, cols }) => {
    const rowDiv = document.createElement("div");
    rowDiv.classList.add("row");
    cols.forEach((c) => {
      const cell = document.createElement("div");
      cell.classList.add("circle");
      cell.dataset.key = cellKey(row, c);
      cell.dataset.row = row;
      cell.dataset.col = c;
      rowDiv.appendChild(cell);
    });
    gameContainer.appendChild(rowDiv);
  });

  // After layout, ensure the SVG overlay matches #game-wrapper exactly
  window.addEventListener("load", resizeSVGOverlay);
  window.addEventListener("resize", resizeSVGOverlay);
}

/** Make the <svg> cover exactly the same pixel box as #game-wrapper. */
function resizeSVGOverlay() {
  const wrapperRect = document
    .getElementById("game-wrapper")
    .getBoundingClientRect();
  svgOverlay.setAttribute("width", wrapperRect.width);
  svgOverlay.setAttribute("height", wrapperRect.height);
}

// ————————————————————————————————————————————————————————————
// 5. SYNC & RENDER STATE FROM FIREBASE
// ————————————————————————————————————————————————————————————

/**
 * Whenever the game state changes in Firebase, update the UI accordingly.
 */
onValue(GAME_REF, (snapshot) => {
  const state = snapshot.val();
  if (!state) {
    // If there's no state yet, initialize
    resetGameInDatabase();
    return;
  }
  updateBoardUI(state);
});

/**
 * Render the entire board based on `state`:
 *  • Fill circles, disable/enable them
 *  • Update scores
 *  • Update turn indicator
 *  • Draw already‐drawn lines (solid, no animation)
 *  • If localPlayer has pendingLines, render those as dashed clickable overlays
 */
function updateBoardUI(state) {
  const { cells, scores, turn, lines } = state;

  // 1) Update circles: filled‐1, filled‐2, or disabled
  Object.entries(cells).forEach(([key, val]) => {
    const cellEl = document.querySelector(`.circle[data-key="${key}"]`);
    if (!cellEl) return;
    cellEl.classList.remove("filled-1", "filled-2", "disabled", "highlight");
    if (val === 1) {
      cellEl.classList.add("filled-1");
    } else if (val === 2) {
      cellEl.classList.add("filled-2");
    } else {
      // empty
      // Disable if not this player's turn OR if they still have pendingLines
      if (turn !== localPlayer || pendingLines.length > 0) {
        cellEl.classList.add("disabled");
      }
    }
  });

  // 2) Update the scoreboard
  player1ScoreEl.textContent = scores ? scores["1"] : 0;
  player2ScoreEl.textContent = scores ? scores["2"] : 0;

  // 3) Update turn indicator
  if (turn === localPlayer) {
    if (pendingLines.length > 0) {
      turnIndicator.textContent = `Draw your ${pendingLines.length} line${pendingLines.length > 1 ? "s" : ""}`;
      turnIndicator.style.color = "#d35400"; // orange while drawing
    } else {
      turnIndicator.textContent = "Your turn";
      turnIndicator.style.color = "#27ae60";
    }
  } else {
    turnIndicator.textContent = "Opponent’s turn";
    turnIndicator.style.color = "#c0392b";
  }

  // 4) Clear all SVG children (both drawn and eligible)
  while (svgOverlay.firstChild) {
    svgOverlay.removeChild(svgOverlay.firstChild);
  }

  // 5) Draw all “already drawn” lines from state.lines (no animation)
  Object.entries(lines || {}).forEach(([lineId, playerNum]) => {
    drawLineInSVG(lineId, playerNum, /*animate=*/ false);
  });

  // 6) Render any pending (eligible) lines as dashed overlays
  if (turn === localPlayer && pendingLines.length > 0) {
    pendingLines.forEach((lineId) => {
      drawEligibleOverlay(lineId);
    });
  }
}

/**
 * Draw a solid, animated line for `lineId` with CSS class .polyline-<playerNum>.
 * If animate=false, it just draws a static line (no dash animation).
 */
function drawLineInSVG(lineId, playerNum, animate = true) {
  const points = getLineCenterPoints(lineId);
  if (!points || points.length < 2) return;

  const poly = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  poly.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" "));
  poly.setAttribute("class", `polyline-${playerNum}`);

  if (animate) {
    svgOverlay.appendChild(poly);
    const totalLen = poly.getTotalLength();
    poly.style.strokeDasharray = totalLen;
    poly.style.strokeDashoffset = totalLen;
    // Force a reflow so animation triggers
    poly.getBoundingClientRect();
    poly.style.animation = `drawLine 0.6s forwards ease-in-out`;
  } else {
    // Static line
    poly.style.strokeDasharray = "";
    poly.style.strokeDashoffset = "";
    svgOverlay.appendChild(poly);
  }
}

/**
 * Draw a dashed, clickable overlay for an eligible line (class .eligible-line).
 * dataset.lineId = lineId so we can identify which was clicked.
 */
function drawEligibleOverlay(lineId) {
  const points = getLineCenterPoints(lineId);
  if (!points || points.length < 2) return;

  const poly = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  poly.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" "));
  poly.setAttribute("class", "eligible-line");
  poly.dataset.lineId = lineId;

  // Ensure it can intercept pointer events
  poly.style.pointerEvents = "all";
  poly.style.cursor = "pointer";

  svgOverlay.appendChild(poly);
}

/**
 * Briefly highlight all circles in a line (add .highlight, then remove after 400ms).
 */
function highlightCircles(lineId) {
  LINE_TO_KEYS[lineId].forEach((k) => {
    const circleEl = document.querySelector(`.circle[data-key="${k}"]`);
    if (!circleEl) return;
    circleEl.classList.add("highlight");
    setTimeout(() => {
      circleEl.classList.remove("highlight");
    }, 400);
  });
}

// ————————————————————————————————————————————————————————————
// 6. HANDLE CLICK / TOUCH ON ELIGIBLE-LINE OVERLAYS
// ————————————————————————————————————————————————————————————

/**
 * When the player taps or “drags” (pointerdown) on a dashed eligible line,
 * we draw it, award points, and remove it from pendingLines.
 */
svgOverlay.addEventListener("pointerdown", (e) => {
  if (
    e.target.nodeName === "polyline" &&
    e.target.classList.contains("eligible-line")
  ) {
    const lineId = e.target.dataset.lineId;
    if (!pendingLines.includes(lineId)) return;
    drawOneEligibleLine(lineId);
  }
});

/**
 * For one eligible line:
 *  1) Highlight circles,
 *  2) Draw the solid line with animation,
 *  3) Update Firebase: lines/<lineId>=localPlayer, add points,
 *  4) Remove from pendingLines, re-render UI, and if pendingLines is empty, switch turn.
 */
function drawOneEligibleLine(lineId) {
  // 1) Highlight circles briefly
  highlightCircles(lineId);

  // 2) Draw solid animated line
  drawLineInSVG(lineId, localPlayer, /* animate= */ true);

  // 3) Update DB: add line ownership + increment score
  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { scores } = state;

  const gained = LINE_TO_KEYS[lineId].length;
  const newScore = (scores[localPlayer] || 0) + gained;

  const updates = {};
  updates[`lines/${lineId}`] = localPlayer;
  updates[`scores/${localPlayer}`] = newScore;

  update(GAME_REF, updates);

  // 4) Remove from pendingLines, then re-render after a short delay
  pendingLines = pendingLines.filter((lid) => lid !== lineId);
  setTimeout(() => {
    const currentState = snapshotValue(GAME_REF);
    updateBoardUI(currentState);
    if (pendingLines.length === 0) {
      finalizeAfterAllLines();
    }
  }, 100);
}

/**
 * Once all pendingLines are drawn, switch the turn to the other player.
 */
function finalizeAfterAllLines() {
  const nextTurn = localPlayer === 1 ? 2 : 1;
  update(GAME_REF, { turn: nextTurn });
}

// ————————————————————————————————————————————————————————————
// 7. HANDLE CIRCLE CLICKS / TOUCHS FOR FILLING
// ————————————————————————————————————————————————————————————

/**
 * When a player taps a circle (if it’s their turn and no pending lines),
 * we fill it and then check which lines (rows/diagonals) become eligible.
 */
gameContainer.addEventListener("click", (e) => {
  if (!e.target.classList.contains("circle")) return;
  const circle = e.target;
  const key = circle.dataset.key;

  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { cells, turn } = state;

  // If not this player's turn, or if they still have pendingLines, do nothing
  if (turn !== localPlayer || pendingLines.length > 0) return;

  // If circle already filled, do nothing
  if (cells[key] !== 0) return;

  // 1) Fill the circle in DB
  const updates = {};
  updates[`cells/${key}`] = localPlayer;
  update(GAME_REF, updates).then(() => {
    // 2) After successful fill, find newly‐eligible lines
    checkEligibleAfterFill(key);
  });
});

/**
 * Also allow touchstart/drag to fill (mobile‐friendly).
 */
gameContainer.addEventListener("pointerdown", (e) => {
  if (!e.target.classList.contains("circle")) return;
  const circle = e.target;
  const key = circle.dataset.key;

  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { cells, turn } = state;

  if (turn === localPlayer && pendingLines.length === 0 && cells[key] === 0) {
    const updates = {};
    updates[`cells/${key}`] = localPlayer;
    update(GAME_REF, updates).then(() => {
      checkEligibleAfterFill(key);
    });
  }
});

/**
 * After filling a circle, check all allowed lines (≥ 2 circles) that pass through that cell.
 * If any is fully filled, add to pendingLines, highlight them, and show dashed overlays.
 * If none, switch turn immediately.
 */
function checkEligibleAfterFill(filledKey) {
  onValue(
    GAME_REF,
    (snap) => {
      const state = snap.val();
      if (!state) return;
      const { cells, lines } = state;

      // Find all allowed lineIds that include filledKey, are not yet drawn, and whose cells are now all filled
      const newlyEligible = [];
      Object.entries(LINE_TO_KEYS).forEach(([lineId, keyArr]) => {
        if (!keyArr.includes(filledKey)) return;
        if (lines && lines[lineId]) return; // already drawn
        // Check if every circle in that line is now filled
        const allFilled = keyArr.every((k) => cells[k] !== 0);
        if (allFilled) {
          newlyEligible.push(lineId);
        }
      });

      if (newlyEligible.length > 0) {
        // If ≥1 eligible, store them locally, highlight & show dashed overlays
        pendingLines = newlyEligible.slice();
        newlyEligible.forEach((lid) => highlightCircles(lid));
        const currentState = snapshotValue(GAME_REF);
        updateBoardUI(currentState);
      } else {
        // If none, switch turn immediately
        const nextTurn = localPlayer === 1 ? 2 : 1;
        update(GAME_REF, { turn: nextTurn });
      }
    },
    { onlyOnce: true }
  );
}

/**
 * Get a synchronous copy of the latest DB snapshot (for quick reads).
 */
function snapshotValue(dbRef) {
  let val = null;
  onValue(
    dbRef,
    (snap) => {
      val = snap.val();
    },
    { onlyOnce: true }
  );
  return val;
}

// ————————————————————————————————————————————————————————————
// 8. RESET BUTTON & CONFIRMATION
// ————————————————————————————————————————————————————————————

resetBtn.addEventListener("click", () => {
  const confirmReset = confirm(
    "Are you sure you want to restart the game? All progress will be lost."
  );
  if (confirmReset) {
    pendingLines = [];
    resetGameInDatabase();
  }
});

// ————————————————————————————————————————————————————————————
// 9. INITIALIZATION (prompt, render, start DB listening) 
// ————————————————————————————————————————————————————————————

function init() {
  promptForPlayer();
  renderBoard();

  // If DB is empty on first connect, initialize it
  onValue(
    GAME_REF,
    (snap) => {
      if (!snap.exists()) {
        resetGameInDatabase();
      }
    },
    { onlyOnce: true }
  );
}

init();
