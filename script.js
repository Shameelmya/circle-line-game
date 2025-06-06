// script.js
import { db, ref, onValue, set, update } from './firebase.js';

const gridContainer = document.getElementById("circleGrid");
const canvas = document.getElementById("lineCanvas");
const ctx = canvas.getContext("2d");
const turnIndicator = document.getElementById("turnIndicator");
const player1Score = document.getElementById("player1");
const player2Score = document.getElementById("player2");
const resetBtn = document.getElementById("resetGame");

let roomId = "demo-room";
let playerId = localStorage.getItem("playerId") || (Math.random() > 0.5 ? "blue" : "red");
localStorage.setItem("playerId", playerId);
let turn = "blue";
let state = {};
let score = { blue: 0, red: 0 };

function init() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  gridContainer.innerHTML = "";

  for (let i = 0; i < 10; i++) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "center";
    for (let j = 0; j < 10 - i; j++) {
      const circle = document.createElement("div");
      circle.classList.add("circle");
      circle.dataset.row = i;
      circle.dataset.col = j;
      circle.addEventListener("click", handleCircleClick);
      row.appendChild(circle);
    }
    gridContainer.appendChild(row);
  }
  listenToGame();
}

function handleCircleClick(e) {
  if (playerId !== turn) return;
  const row = e.target.dataset.row;
  const col = e.target.dataset.col;
  const key = `${row}-${col}`;

  if (state[key]) return;

  state[key] = playerId;
  update(ref(db, `games/${roomId}`), {
    state,
    turn: null
  });
}

function listenToGame() {
  const gameRef = ref(db, `games/${roomId}`);
  onValue(gameRef, (snapshot) => {
    const data = snapshot.val() || { state: {}, turn: "blue", lines: [], score: { blue: 0, red: 0 } };
    state = data.state;
    turn = data.turn || (playerId === "blue" ? "red" : "blue");
    score = data.score || { blue: 0, red: 0 };

    updateBoard();
    drawLines(data.lines || []);
    update(ref(db, `games/${roomId}`), { turn });
  });
}

function updateBoard() {
  document.querySelectorAll(".circle").forEach(circle => {
    const key = `${circle.dataset.row}-${circle.dataset.col}`;
    circle.classList.remove("filled-blue", "filled-red");
    if (state[key]) circle.classList.add(`filled-${state[key]}`);
  });
  turnIndicator.textContent = (turn === playerId) ? "Your Turn" : "Opponent's Turn";
  player1Score.textContent = `🔵 ${score.blue}`;
  player2Score.textContent = `🔴 ${score.red}`;
  checkForLines();
}

function checkForLines() {
  const newLines = [];
  const tempState = {};
  for (const key in state) {
    const [r, c] = key.split("-").map(Number);
    tempState[`${r}-${c}`] = state[key];
  }

  const directions = [
    [0, 1], [1, 0], [1, 1], [1, -1]
  ];

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      for (const [dr, dc] of directions) {
        const line = [];
        let cr = r, cc = c;
        for (let i = 0; i < 4; i++) {
          if (tempState[`${cr}-${cc}`] === playerId) {
            line.push([cr, cc]);
          }
          cr += dr;
          cc += dc;
        }
        if (line.length === 4) {
          newLines.push({ from: line[0], to: line[3], player: playerId });
          score[playerId] += 4;
        }
      }
    }
  }
  if (newLines.length) {
    update(ref(db, `games/${roomId}`), {
      lines: newLines,
      score,
      turn: playerId
    });
  }
}

function drawLines(lines) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lines.forEach(line => {
    const fromEl = document.querySelector(`[data-row='${line.from[0]}'][data-col='${line.from[1]}']`);
    const toEl = document.querySelector(`[data-row='${line.to[0]}'][data-col='${line.to[1]}']`);
    if (fromEl && toEl) {
      const rect1 = fromEl.getBoundingClientRect();
      const rect2 = toEl.getBoundingClientRect();
      ctx.beginPath();
      ctx.moveTo(rect1.left + 15, rect1.top + 15);
      ctx.lineTo(rect2.left + 15, rect2.top + 15);
      ctx.strokeStyle = line.player === "blue" ? "#3b82f6" : "#ef4444";
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  });
}

resetBtn.addEventListener("click", () => {
  set(ref(db, `games/${roomId}`), {
    state: {},
    lines: [],
    score: { blue: 0, red: 0 },
    turn: "blue"
  });
});

window.addEventListener("resize", () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

init();
