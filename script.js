/**
 * Main game logic for Circle Battle (Row Connect).
 * Uses Firebase Realtime Database to sync two-player state.
 */

import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js";

const db = window.__FIREBASE_DB__; // from index.html

// ————————————————————————————————————————————————————————————
// 1. CONSTANTS & GLOBALS
// ————————————————————————————————————————————————————————————

const ROW_COUNT = 10;

// Generate a 2D structure: row 1 has 10 cells (1..10), row 2 has 9 cells (1..9), … row 10 has 1 cell
let boardStructure = [];
for (let r = 1; r <= ROW_COUNT; r++) {
  boardStructure.push({
    row: r,
    cols: Array.from({ length: ROW_COUNT + 1 - r }, (_, i) => i + 1),
  });
}

// Compute all line definitions (rows, columns, diagonals "\" and "/").
let ALL_LINES = {}; // { lineId: { cells: [ {r,c}, ... ] } }

// 1) Rows
for (let r = 1; r <= ROW_COUNT; r++) {
  const rowCells = boardStructure
    .find((rowObj) => rowObj.row === r)
    .cols.map((c) => ({ r, c }));
  ALL_LINES[`row-${r}`] = { cells: rowCells };
}

// 2) Columns (ranging c=1..10). A column c includes (r,c) where c ≤ (11−r).
for (let c = 1; c <= ROW_COUNT; c++) {
  let colCells = [];
  for (let r = 1; r <= ROW_COUNT; r++) {
    if (c <= ROW_COUNT + 1 - r) {
      colCells.push({ r, c });
    }
  }
  if (colCells.length > 1) {
    ALL_LINES[`col-${c}`] = { cells: colCells };
  }
}

// 3) Diagonals "\" (slope down-right): start at each (1,c) for c=1..10, and (r,1) for r=2..10
function collectDiagBackslash(startR, startC) {
  let cells = [];
  let r = startR,
    c = startC;
  while (r <= ROW_COUNT && c <= ROW_COUNT + 1 - r) {
    cells.push({ r, c });
    r++;
    c++;
  }
  return cells;
}
const diagBs = {};
for (let c = 1; c <= ROW_COUNT; c++) {
  let cells = collectDiagBackslash(1, c);
  if (cells.length > 1) diagBs[`diag_b\\-top-${c}`] = { cells };
}
for (let r = 2; r <= ROW_COUNT; r++) {
  let cells = collectDiagBackslash(r, 1);
  if (cells.length > 1) diagBs[`diag_b\\-left-${r}`] = { cells };
}
Object.assign(ALL_LINES, diagBs);

// 4) Diagonals "/" (slope down-left): start at (1,c) for c=1..10, and (r, 11−r) for r=2..10
function collectDiagSlash(startR, startC) {
  let cells = [];
  let r = startR,
    c = startC;
  while (r <= ROW_COUNT && c >= 1) {
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
const diagFs = {};
for (let c = 1; c <= ROW_COUNT; c++) {
  let cells = collectDiagSlash(1, c);
  if (cells.length > 1) diagFs[`diag_f\\-top-${c}`] = { cells };
}
for (let r = 2; r <= ROW_COUNT; r++) {
  let startC = ROW_COUNT + 1 - r; // rightmost column on row r
  let cells = collectDiagSlash(r, startC);
  if (cells.length > 1) diagFs[`diag_f\\-right-${r}`] = { cells };
}
Object.assign(ALL_LINES, diagFs);

// ————————————————————————————————————————————————————————————
// 2. HELPERS: ID STRINGS, PIXEL COORDS, ETC.
// ————————————————————————————————————————————————————————————

/**
 * Convert (r,c) → a string key "r_c"
 */
function cellKey(r, c) {
  return `${r}_${c}`;
}

/**
 * Build a mapping of lineId → [ "r_c", ... ] for easier lookups.
 */
const LINE_TO_KEYS = {};
Object.entries(ALL_LINES).forEach(([lineId, info]) => {
  LINE_TO_KEYS[lineId] = info.cells.map((pt) => cellKey(pt.r, pt.c));
});

/**
 * Given a lineId and the DOM circles, return an array of center positions for drawing.
 */
function getLineCenterPoints(lineId) {
  const keys = LINE_TO_KEYS[lineId];
  const points = keys.map((k) => {
    const el = document.querySelector(`.circle[data-key="${k}"]`);
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentNode.parentNode.getBoundingClientRect();
    // center of that circle, relative to #game-wrapper
    return {
      x: rect.left + rect.width / 2 - parentRect.left,
      y: rect.top + rect.height / 2 - parentRect.top,
    };
  });
  return points;
}

/**
 * Given array of points, build an SVG polyline string.
 */
function buildPolylineSVG(points) {
  return points.map((pt) => `${pt.x},${pt.y}`).join(" ");
}

// ————————————————————————————————————————————————————————————
// 3. FIREBASE STATE INITIALIZATION & UTILS
// ————————————————————————————————————————————————————————————

/**
 * Determine a “gameId” node in Realtime DB. 
 * If URL has ?gameId=xxx, use that. Otherwise default to "defaultGame".
 */
function getGameId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("gameId") || "defaultGame";
}
const GAME_ID = getGameId();
const GAME_REF = ref(db, `games/${GAME_ID}`);

/**
 * Build the initial state object:
 * - cells: { "r_c": 0 }
 * - turn: 1
 * - scores: {1:0, 2:0}
 * - lines: {}
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
    scores: { 1: 0, 2: 0 },
    lines: {}, // lineId → playerNumber
  };
}

/**
 * Reset the game node in DB to initial state.
 */
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

let localPlayer = null; // 1 or 2

/**
 * Prompt user to choose Player 1 or Player 2.
 * We store this in-session, not persisted.
 */
function promptForPlayer() {
  let choice = null;
  while (![ "1", "2" ].includes(choice)) {
    choice = prompt("Choose your player: 1 or 2").trim();
  }
  localPlayer = Number(choice);
}

/**
 * Generate the rows of circles in HTML.
 * Each circle: <div class="circle" data-key="r_c" data-row="r" data-col="c"></div>
 */
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

  // Resize SVG overlay to match #game-wrapper
  setTimeout(resizeSVGOverlay, 100); // allow layout
  window.addEventListener("resize", resizeSVGOverlay);
}

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
 * Called whenever the game state node changes.
 * Update UI: cells, scores, lines, turn indicator.
 */
onValue(GAME_REF, (snapshot) => {
  const state = snapshot.val();
  if (!state) {
    // If no state present, initialize
    resetGameInDatabase();
    return;
  }
  updateBoardUI(state);
});

/**
 * Apply full state to the board UI.
 */
function updateBoardUI(state) {
  const { cells, scores, turn, lines } = state;

  // 1) Update each circle’s color & interactivity
  Object.entries(cells).forEach(([key, val]) => {
    const cellEl = document.querySelector(`.circle[data-key="${key}"]`);
    if (!cellEl) return;
    cellEl.classList.remove("filled-1", "filled-2", "disabled");
    if (val === 1) {
      cellEl.classList.add("filled-1");
    } else if (val === 2) {
      cellEl.classList.add("filled-2");
    } else {
      // empty
      if (turn !== localPlayer) {
        cellEl.classList.add("disabled");
      }
    }
  });

  // 2) Update scoreboard
  player1ScoreEl.textContent = scores ? scores["1"] : 0;
  player2ScoreEl.textContent = scores ? scores["2"] : 0;

  // 3) Update turn indicator
  if (turn === localPlayer) {
    turnIndicator.textContent = "Your turn";
    turnIndicator.style.color = "#27ae60";
  } else {
    turnIndicator.textContent = "Opponent’s turn";
    turnIndicator.style.color = "#c0392b";
  }

  // 4) Update drawn lines (clear & redraw)
  while (svgOverlay.firstChild) {
    svgOverlay.removeChild(svgOverlay.firstChild);
  }
  Object.entries(lines || {}).forEach(([lineId, playerNum]) => {
    drawLineInSVG(lineId, playerNum);
  });
}

/**
 * Draw a single line in the SVG overlay.
 */
function drawLineInSVG(lineId, playerNum) {
  const points = getLineCenterPoints(lineId);
  if (!points || points.length < 2) return;
  const poly = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  poly.setAttribute("points", buildPolylineSVG(points));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke-width", "4");
  poly.setAttribute("class", `polyline-${playerNum}`);
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  svgOverlay.appendChild(poly);
}

// ————————————————————————————————————————————————————————————
// 6. GAME-MOVE HANDLER
// ————————————————————————————————————————————————————————————

/**
 * When a user clicks a circle (only if it’s their turn and cell is empty):
 *  1) Fill the cell locally in DB
 *  2) Check lines completed, draw them, update score, handle turn retention or switch
 */
gameContainer.addEventListener("click", (e) => {
  if (!e.target.classList.contains("circle")) return;
  const circle = e.target;
  const key = circle.dataset.key;

  // First, fetch latest state once to ensure we have current turn + cell value
  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { cells, turn, lines, scores } = state;

  // If it’s not our turn, do nothing
  if (turn !== localPlayer) return;

  // If cell already filled, do nothing
  if (cells[key] !== 0) return;

  // 1) Fill the cell in DB
  const updates = {};
  updates[`cells/${key}`] = localPlayer;
  update(GAME_REF, updates).then(() => {
    // After updating DB with filled cell, re-fetch state and process line checks
    processAfterFill(key);
  });
});

/**
 * Utility to get a *synchronous* copy of the latest DB snapshot.
 * (Because onValue is async, this uses a Promise + .then shortcut.)
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

/**
 * Called after we successfully set cells[key] = localPlayer.
 * We now check all lines that pass through that cell for completion.
 * If any new line(s) are completed, add them to DB, update that player’s score,
 * and keep the turn on the same player. Otherwise, switch turn.
 */
function processAfterFill(filledKey) {
  // 1) Read latest state again
  onValue(
    GAME_REF,
    (snap) => {
      const state = snap.val();
      if (!state) return;
      const { cells, lines, scores } = state;

      // 2) Determine (r,c) from filledKey
      const [rStr, cStr] = filledKey.split("_");
      const r = Number(rStr);
      const c = Number(cStr);

      // 3) Identify all lineIds that include (r,c)
      const completedThisMove = [];
      Object.entries(LINE_TO_KEYS).forEach(([lineId, keyArr]) => {
        if (!keyArr.includes(filledKey)) return;
        // If line already drawn, skip
        if (lines && lines[lineId]) return;
        // Check if all cells in that line are now nonzero
        const allFilled = keyArr.every((k) => cells[k] !== 0);
        if (allFilled) {
          completedThisMove.push(lineId);
        }
      });

      // 4) If any lines completed, update DB lines & score, keep turn
      if (completedThisMove.length > 0) {
        const multiUpdates = {};
        let pointsGained = 0;
        completedThisMove.forEach((lineId) => {
          multiUpdates[`lines/${lineId}`] = localPlayer;
          // score += length of line
          pointsGained += LINE_TO_KEYS[lineId].length;
        });
        multiUpdates[`scores/${localPlayer}`] =
          (scores[localPlayer] || 0) + pointsGained;
        // We do NOT change turn (retain same player)
        update(GAME_REF, multiUpdates);
      } else {
        // 5) No lines completed → switch turn
        const nextTurn = localPlayer === 1 ? 2 : 1;
        update(GAME_REF, { turn: nextTurn });
      }
    },
    { onlyOnce: true }
  );
}

// ————————————————————————————————————————————————————————————
// 7. RESET BUTTON & CONFIRMATION
// ————————————————————————————————————————————————————————————

resetBtn.addEventListener("click", () => {
  const confirmReset = confirm(
    "Are you sure you want to restart the game? All progress will be lost."
  );
  if (confirmReset) {
    resetGameInDatabase();
  }
});

// ————————————————————————————————————————————————————————————
// 8. INITIALIZATION (prompt, render, and start DB listening)
// ————————————————————————————————————————————————————————————

function init() {
  promptForPlayer();
  renderBoard();

  // After rendering, if DB is empty, initialize
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
