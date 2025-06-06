/**
 * Main game logic for Circle Battle (Row Connect).
 * Uses Firebase Realtime Database to sync two-player state.
 * Updated: Only rows + two diagonal types allowed.  Smooth draw-animations.
 * Highlights completed-line circles with brief yellow glow.
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

// Build board structure: row 1 has 10 columns (1..10), row 2 has 9 (1..9), … row 10 has 1 (col 1).
let boardStructure = [];
for (let r = 1; r <= ROW_COUNT; r++) {
  boardStructure.push({
    row: r,
    cols: Array.from({ length: ROW_COUNT + 1 - r }, (_, i) => i + 1),
  });
}

// Compute allowed line definitions (only rows + diagonals that start on the top row).
// That gives exactly 10 rows + 10 "\" diagonals + 10 "/" diagonals = 30 total.

let ALL_LINES = {}; // { lineId: { cells: [ {r,c}, ... ] } }

// 1) Rows
for (let r = 1; r <= ROW_COUNT; r++) {
  const rowCells = boardStructure
    .find((rowObj) => rowObj.row === r)
    .cols.map((c) => ({ r, c }));
  ALL_LINES[`row-${r}`] = { cells: rowCells };
}

// 2) "\" diagonals (↘) starting on the top row only
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
for (let c = 1; c <= ROW_COUNT; c++) {
  const cells = collectDiagBackslash(1, c);
  if (cells.length > 1) {
    ALL_LINES[`diag_bslash-${c}`] = { cells };
  }
}

// 3) "/" diagonals (↙) starting on the top row only
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
for (let c = 1; c <= ROW_COUNT; c++) {
  const cells = collectDiagSlash(1, c);
  if (cells.length > 1) {
    ALL_LINES[`diag_fslash-${c}`] = { cells };
  }
}

// Build a quick map: lineId → [ "r_c", ... ] for lookups.
const LINE_TO_KEYS = {};
Object.entries(ALL_LINES).forEach(([lineId, info]) => {
  LINE_TO_KEYS[lineId] = info.cells.map((pt) => `${pt.r}_${pt.c}`);
});

// ————————————————————————————————————————————————————————————
// 2. HELPERS: CELL KEYS, POSITIONS, ETC.
// ————————————————————————————————————————————————————————————

/**
 * Return the string key "r_c" for a given (r,c).
 */
function cellKey(r, c) {
  return `${r}_${c}`;
}

/**
 * Given a lineId, return an array of center { x, y } (relative to #game-wrapper)
 * to use for drawing an SVG polyline.
 */
function getLineCenterPoints(lineId) {
  const wrapperRect = document
    .getElementById("game-wrapper")
    .getBoundingClientRect();

  return LINE_TO_KEYS[lineId].map((k) => {
    const [rStr, cStr] = k.split("_");
    const r = Number(rStr),
      c = Number(cStr);
    const circleEl = document.querySelector(`.circle[data-key="${k}"]`);
    const circleRect = circleEl.getBoundingClientRect();
    // center relative to wrapper:
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
 * Determine a “gameId” node in Realtime DB. If URL has ?gameId=xxx, use that.
 * Otherwise default to "defaultGame".
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
    scores: { "1": 0, "2": 0 },
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
 * Prompt user to choose Player 1 or Player 2 (stored in-session).
 */
function promptForPlayer() {
  let choice = null;
  while (!["1", "2"].includes(choice)) {
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
    drawLineInSVG(lineId, playerNum, /*animate=*/ false);
  });
}

/**
 * Draw a single line in the SVG overlay.
 * If animate=true, add an animation that draws stroke over time.
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
    // After appending, measure length and trigger CSS draw animation
    svgOverlay.appendChild(poly);
    const totalLen = poly.getTotalLength();
    poly.style.strokeDasharray = totalLen;
    poly.style.strokeDashoffset = totalLen;
    // Force a reflow so that the transition/animation kicks in
    // (we rely on CSS @keyframes drawLine to animate dashoffset → 0)
    poly.getBoundingClientRect();
    poly.style.animation = `drawLine 0.6s forwards ease-in-out`;
  } else {
    // If not animating (re-rendering existing lines), skip dash animations
    poly.style.strokeDasharray = "";
    poly.style.strokeDashoffset = "";
    svgOverlay.appendChild(poly);
  }
}

/**
 * Highlight each circle in the completed-line segment.
 * Add .highlight class briefly, then remove after animation ends (~400ms).
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
// 6. GAME-MOVE HANDLER
// ————————————————————————————————————————————————————————————

/**
 * When a user clicks a circle (only if it’s their turn and cell is empty):
 *  1) Fill the cell locally in DB
 *  2) Check lines completed, draw them with animation, update score, handle turn retention or switch
 */
gameContainer.addEventListener("click", (e) => {
  if (!e.target.classList.contains("circle")) return;
  const circle = e.target;
  const key = circle.dataset.key;

  // First, fetch latest state once to ensure we have current turn + cell value
  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { cells, turn } = state;

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
 * We now check all allowed lines that pass through that cell for completion.
 * If any new line(s) are completed, highlight circles, draw them with animation,
 * update that player’s score, and keep the turn. Otherwise, switch turn.
 */
function processAfterFill(filledKey) {
  // 1) Read latest state again
  onValue(
    GAME_REF,
    (snap) => {
      const state = snap.val();
      if (!state) return;
      const { cells, lines, scores, turn } = state;

      // 2) Identify (r,c) from filledKey
      const [rStr, cStr] = filledKey.split("_");
      const r = Number(rStr),
        c = Number(cStr);

      // 3) Identify all allowed lineIds that include (r,c)
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

      // 4) If any lines completed, highlight, draw with animation, update DB lines & score
      if (completedThisMove.length > 0) {
        const multiUpdates = {};
        let pointsGained = 0;

        completedThisMove.forEach((lineId) => {
          // Mark line in DB
          multiUpdates[`lines/${lineId}`] = localPlayer;
          // Score = length of that line
          pointsGained += LINE_TO_KEYS[lineId].length;
        });

        // Update that player’s score
        multiUpdates[`scores/${localPlayer}`] =
          (scores[localPlayer] || 0) + pointsGained;

        // 4a) First, highlight circles in all newly completed lines
        completedThisMove.forEach((lineId) => highlightCircles(lineId));

        // 4b) Then, apply DB updates (lines + score).  After DB update, the onValue listener
        //     will call updateBoardUI, but we also need to draw them with animation immediately.
        update(GAME_REF, multiUpdates).then(() => {
          // Draw all newly completed lines with animation
          completedThisMove.forEach((lineId) =>
            drawLineInSVG(lineId, localPlayer, /*animate=*/ true)
          );
        });

        // 4c) Keep the turn the same (no turn switch).
        //      We do NOT set turn in DB, so it stays localPlayer.
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

  // After rendering, if DB is empty, initialize it
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
