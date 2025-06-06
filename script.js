/**
 * Main game logic for Circle Battle (Row Connect).
 * Uses Firebase Realtime Database to sync two-player state.
 * Now: Lines become “eligible” but only appear after the player clicks them.
 * Eligible lines show as dashed overlays; clicking draws them with animation.
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

// Compute allowed line definitions (only rows + two diagonal types starting on top row).
// That yields exactly 10 rows + 10 ↘ diagonals + 10 ↙ diagonals = 30 total.

let ALL_LINES = {}; // { lineId: { cells: [ {r,c}, ... ] } }

// 1) Rows
for (let r = 1; r <= ROW_COUNT; r++) {
  const rowCells = boardStructure
    .find((rowObj) => rowObj.row === r)
    .cols.map((c) => ({ r, c }));
  ALL_LINES[`row-${r}`] = { cells: rowCells };
}

// 2) "\" diagonals (↘) starting on top row
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

// 3) "/" diagonals (↙) starting on top row
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

// Build a quick lookup: lineId → [ "r_c", ... ]
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
 * - lines: {}            // lines actually drawn
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
    lines: {}, // drawn lines only
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

// When lines become “eligible” for the local player, store them here
let pendingLines = [];

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
 * Update UI: cells, scores, drawn lines, turn indicator.
 * (Eligible lines are client‐local and not stored in DB.)
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
 * Note: Only “drawn” lines appear as solid polylines.
 */
function updateBoardUI(state) {
  const { cells, scores, turn, lines } = state;

  // 1) Update each circle’s color & interactivity
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
      if (turn !== localPlayer || pendingLines.length > 0) {
        // Disable if it's not our turn or if we have pending lines to draw
        cellEl.classList.add("disabled");
      }
    }
  });

  // 2) Update scoreboard
  player1ScoreEl.textContent = scores ? scores["1"] : 0;
  player2ScoreEl.textContent = scores ? scores["2"] : 0;

  // 3) Update turn indicator
  if (turn === localPlayer) {
    if (pendingLines.length > 0) {
      turnIndicator.textContent = `Draw your ${pendingLines.length} line${pendingLines.length > 1 ? "s" : ""}`;
      turnIndicator.style.color = "#d35400";
    } else {
      turnIndicator.textContent = "Your turn";
      turnIndicator.style.color = "#27ae60";
    }
  } else {
    turnIndicator.textContent = "Opponent’s turn";
    turnIndicator.style.color = "#c0392b";
  }

  // 4) Clear existing SVG elements
  while (svgOverlay.firstChild) {
    svgOverlay.removeChild(svgOverlay.firstChild);
  }

  // 5) Draw all “already drawn” lines from state.lines
  Object.entries(lines || {}).forEach(([lineId, playerNum]) => {
    drawLineInSVG(lineId, playerNum, /* animate= */ false);
  });

  // 6) If local player has pendingLines, show them as dashed clickable overlays
  if (turn === localPlayer && pendingLines.length > 0) {
    pendingLines.forEach((lineId) => {
      drawEligibleOverlay(lineId);
    });
  }
}

/**
 * Draw a single drawn line in the SVG overlay.
 * If animate=true, uses stroke‐dash animation.
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
    // Force reflow for the animation to kick in
    poly.getBoundingClientRect();
    poly.style.animation = `drawLine 0.6s forwards ease-in-out`;
  } else {
    // Already drawn—just append without animation
    poly.style.strokeDasharray = "";
    poly.style.strokeDashoffset = "";
    svgOverlay.appendChild(poly);
  }
}

/**
 * Draw a dashed, clickable overlay for a line that’s “eligible” but not yet drawn.
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
  poly.dataset.lineId = lineId; // store for click handler

  // Ensure pointer-events are enabled so it can be clicked
  poly.style.pointerEvents = "all";
  poly.style.cursor = "pointer";

  svgOverlay.appendChild(poly);
}

// Handle clicks on eligible‐line overlays
svgOverlay.addEventListener("click", (e) => {
  if (
    e.target.nodeName === "polyline" &&
    e.target.classList.contains("eligible-line")
  ) {
    const lineId = e.target.dataset.lineId;
    if (!pendingLines.includes(lineId)) return;
    // Draw this line (animate), award points, then remove from pending
    drawOneEligibleLine(lineId);
  }
});

/**
 * When player clicks one eligible line:
 * 1) highlight circles
 * 2) draw solid animated line
 * 3) update DB: set lines/<lineId> = localPlayer, add points
 * 4) remove from pendingLines; if none remain, end drawing-phase and switch or continue turn as needed
 */
function drawOneEligibleLine(lineId) {
  // 1) Highlight circles in that segment
  highlightCircles(lineId);

  // 2) Draw solid animated line
  drawLineInSVG(lineId, localPlayer, /* animate= */ true);

  // 3) Update DB: lines & score
  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { scores, lines } = state;

  // Score gained = length of that line
  const gained = LINE_TO_KEYS[lineId].length;
  const newScore = (scores[localPlayer] || 0) + gained;

  const updates = {};
  updates[`lines/${lineId}`] = localPlayer;
  updates[`scores/${localPlayer}`] = newScore;

  update(GAME_REF, updates);

  // 4) Remove this line from pendingLines, then re-render UI
  pendingLines = pendingLines.filter((lid) => lid !== lineId);
  // A short delay so the UI can reflect removal of that dashed overlay:
  setTimeout(() => {
    const currentState = snapshotValue(GAME_REF);
    updateBoardUI(currentState);
    // If no more pending lines, end drawing-phase:
    if (pendingLines.length === 0) {
      finalizeAfterAllLines();
    }
  }, 100); // 100ms delay
}

/**
 * After all pending lines are drawn, we check whether the player gets another fill turn or we switch turn.
 * - If the last fill (that caused pendingLines) also completed no further lines, we switch turn.
 * - But since pendingLines are the only lines completed by that last fill, after drawing them we now switch turn.
 * (In other words, after drawing all eligible lines, it’s the other player's turn.)
 */
function finalizeAfterAllLines() {
  // Switch turn to other player
  const nextTurn = localPlayer === 1 ? 2 : 1;
  update(GAME_REF, { turn: nextTurn });
}

// ————————————————————————————————————————————————————————————
// 6. GAME-MOVE HANDLER
// ————————————————————————————————————————————————————————————

/**
 * When a user clicks a circle (only if it’s their turn, no pending lines, and cell is empty):
 * 1) Fill the cell locally in DB
 * 2) Check which lines are now eligible (from the 30 allowed)
 * 3) If ≥1 eligible: store them in pendingLines (client‐local), highlight circles & show dashed overlays
 *    and allow player to click/draw them. Do NOT update DB lines or scores yet.
 * 4) If none eligible: immediately switch turn.
 */
gameContainer.addEventListener("click", (e) => {
  if (!e.target.classList.contains("circle")) return;
  const circle = e.target;
  const key = circle.dataset.key;

  // Fetch latest state
  const stateSnapshot = snapshotValue(GAME_REF);
  const state = stateSnapshot || buildInitialState();
  const { cells, turn } = state;

  // If it’s not our turn or player has pendingLines, do nothing
  if (turn !== localPlayer || pendingLines.length > 0) return;

  // If cell already filled, do nothing
  if (cells[key] !== 0) return;

  // 1) Fill the cell in DB
  const updates = {};
  updates[`cells/${key}`] = localPlayer;
  update(GAME_REF, updates).then(() => {
    // After updating DB with the filled cell, determine eligible lines
    checkEligibleAfterFill(key);
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
 * After filling a circle, check all allowed lines that pass through that cell for eligibility.
 * If any new lines are fully filled, store them in pendingLines, highlight & show dashed overlays.
 * If no lines eligible, switch turn immediately.
 */
function checkEligibleAfterFill(filledKey) {
  onValue(
    GAME_REF,
    (snap) => {
      const state = snap.val();
      if (!state) return;
      const { cells, lines } = state;

      // 1) Identify (r,c) from filledKey (though filledKey is enough to check LINE_TO_KEYS)
      // 2) Find all lineIds that include filledKey, are not already drawn, and now all their cells are filled
      const newlyEligible = [];
      Object.entries(LINE_TO_KEYS).forEach(([lineId, keyArr]) => {
        if (!keyArr.includes(filledKey)) return;
        if (lines && lines[lineId]) return; // already drawn
        // Check if all cells in that line are filled (cells[k] != 0)
        const allFilled = keyArr.every((k) => cells[k] !== 0);
        if (allFilled) {
          newlyEligible.push(lineId);
        }
      });

      if (newlyEligible.length > 0) {
        // 3) If at least one eligible line, store them client‐side
        pendingLines = newlyEligible.slice();
        // 4) Highlight their circles and show dashed overlays
        newlyEligible.forEach((lid) => highlightCircles(lid));
        const currentState = snapshotValue(GAME_REF);
        updateBoardUI(currentState);
      } else {
        // 5) If no eligible lines, switch turn immediately
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
    pendingLines = [];
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
