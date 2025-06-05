import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getDatabase, ref, set, onValue, update, remove } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js";

// Firebase Configuration (Replace with your config)
const firebaseConfig = {
    apiKey: "AIzaSyBnOC0IGWlpOTSUFoMqtji36XqrFgYoRII",
    authDomain: "circle-line-game.firebaseapp.com",
    databaseURL: "https://circle-line-game-default-rtdb.firebaseio.com",
    projectId: "circle-line-game",
    storageBucket: "circle-line-game.appspot.com",
    messagingSenderId: "73822238753",
    appId: "1:73822238753:web:48c52f0ffef482235e0b60"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Game Variables
const gameId = "default-game";
let myPlayerNumber = null;
let currentTurn = 1;
let inactivityTimer;
let currentLine = [];
let completedLines = {};

// DOM Elements
const board = document.getElementById("game-board");
const lineCanvas = document.getElementById("line-canvas");
const ctx = lineCanvas.getContext("2d");
const playerIdDisplay = document.getElementById("player-id");
const score1Display = document.getElementById("score1");
const score2Display = document.getElementById("score2");
const connections1Display = document.getElementById("connections1");
const connections2Display = document.getElementById("connections2");
const gameStatus = document.getElementById("game-status");
const resetBtn = document.getElementById("reset-btn");
const turnIndicator = document.getElementById("turn-indicator");

// Initialize Game Board
function createBoard() {
    board.innerHTML = "";
    
    for (let row = 0; row < 10; row++) {
        const rowDiv = document.createElement("div");
        rowDiv.className = "row";
        
        for (let col = 0; col < (10 - row); col++) {
            const circle = document.createElement("div");
            circle.className = "circle empty";
            circle.dataset.row = row;
            circle.dataset.col = col;
            circle.addEventListener("click", () => handleCircleClick(row, col));
            rowDiv.appendChild(circle);
        }
        
        board.appendChild(rowDiv);
    }
}

// Initialize Canvas
function initCanvas() {
    const boardRect = board.getBoundingClientRect();
    lineCanvas.width = boardRect.width;
    lineCanvas.height = boardRect.height;
    drawAllLines();
}

// Draw all lines from Firebase
function drawAllLines() {
    ctx.clearRect(0, 0, lineCanvas.width, lineCanvas.height);
    
    for (const lineId in completedLines) {
        const line = completedLines[lineId];
        drawSingleLine(line.points, line.player);
    }
}

// Draw a single line
function drawSingleLine(points, player) {
    if (points.length < 2) return;
    
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    
    ctx.strokeStyle = player === 1 ? "#3498db" : "#e74c3c";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
}

// Handle Circle Clicks
function handleCircleClick(row, col) {
    if (myPlayerNumber !== currentTurn) return;
    
    resetInactivityTimer();
    
    const circle = document.querySelector(`.circle[data-row="${row}"][data-col="${col}"]`);
    if (!circle || !circle.classList.contains("empty")) return;
    
    // Mark circle as filled
    circle.classList.remove("empty");
    circle.classList.add(`filled${myPlayerNumber}`);
    
    // Calculate circle center position
    const circleRect = circle.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    
    const point = {
        x: circleRect.left + circleRect.width/2 - boardRect.left,
        y: circleRect.top + circleRect.height/2 - boardRect.top
    };
    
    currentLine.push(point);
    
    // If we have at least 2 points, draw the line
    if (currentLine.length >= 2) {
        drawSingleLine(currentLine, myPlayerNumber);
        
        // Save line to Firebase when complete
        const lineId = Date.now();
        const updates = {};
        updates[`${gameId}/lines/${lineId}`] = {
            player: myPlayerNumber,
            points: currentLine
        };
        updates[`${gameId}/board/${row}/${col}`] = myPlayerNumber;
        updates[`${gameId}/currentTurn`] = myPlayerNumber === 1 ? 2 : 1;
        updates[`${gameId}/lastActivity`] = Date.now();
        
        update(ref(db), updates).catch(error => {
            console.error("Update failed:", error);
        });
        
        currentLine = [];
    }
}

// Calculate Scores
function calculateScores(lines) {
    let score1 = 0, score2 = 0;
    let connections1 = 0, connections2 = 0;
    
    for (const lineId in lines) {
        const line = lines[lineId];
        const connections = line.points.length - 1;
        
        if (line.player === 1) {
            score1 += connections * 2; // 2 points per connection
            connections1 += connections;
        } else {
            score2 += connections * 2;
            connections2 += connections;
        }
    }
    
    return { score1, score2, connections1, connections2 };
}

// Update Game State
function updateGameState(snapshot) {
    const data = snapshot.val() || { board: {}, players: {}, lines: {} };
    
    // Update completed lines
    completedLines = data.lines || {};
    drawAllLines();
    
    // Update scores
    const { score1, score2, connections1, connections2 } = calculateScores(completedLines);
    score1Display.textContent = score1;
    score2Display.textContent = score2;
    connections1Display.textContent = connections1;
    connections2Display.textContent = connections2;
    
    // Update turn
    currentTurn = data.currentTurn || 1;
    gameStatus.textContent = myPlayerNumber === currentTurn ? "Your turn!" : "Opponent's turn...";
    
    // Update turn indicator
    turnIndicator.className = "turn-indicator";
    if (myPlayerNumber === currentTurn) {
        turnIndicator.classList.add("active");
        turnIndicator.style.backgroundColor = myPlayerNumber === 1 ? "#3498db" : "#e74c3c";
    }
    
    // Assign player number if not set
    if (!myPlayerNumber) {
        const players = data.players || {};
        myPlayerNumber = Object.keys(players).length < 2 ? Object.keys(players).length + 1 : null;
        
        if (myPlayerNumber) {
            playerIdDisplay.textContent = `PLAYER ${myPlayerNumber}`;
            playerIdDisplay.style.color = myPlayerNumber === 1 ? "#3498db" : "#e74c3c";
            set(ref(db, `${gameId}/players/${myPlayerNumber}`), true);
        } else {
            gameStatus.textContent = "Game is full (2 players max)";
        }
    }
    
    resetInactivityTimer();
}

// Reset after inactivity
function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        set(ref(db, gameId), null);
        console.log("Game reset due to inactivity");
    }, 5 * 60 * 1000); // 5 minutes
}

// Reset Button
resetBtn.addEventListener("click", () => {
    if (confirm("Reset the game for all players?")) {
        set(ref(db, gameId), null).then(() => {
            location.reload();
        });
    }
});

// Initialize Game
createBoard();
initCanvas();
window.addEventListener("resize", initCanvas);

// Set initial game state
set(ref(db, `${gameId}/lastActivity`), Date.now());

// Listen for game changes
onValue(ref(db, gameId), updateGameState);

// Cleanup on page close
window.addEventListener("beforeunload", () => {
    if (myPlayerNumber) {
        remove(ref(db, `${gameId}/players/${myPlayerNumber}`));
    }
});
