import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getDatabase, ref, set, onValue, update } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js";

// Your Firebase Config
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

// DOM Elements
const board = document.getElementById("game-board");
const playerIdDisplay = document.getElementById("player-id");
const score1Display = document.getElementById("score1");
const score2Display = document.getElementById("score2");
const gameStatus = document.getElementById("game-status");

// Create Game Board
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

// Handle Circle Clicks
function handleCircleClick(row, col) {
    if (myPlayerNumber !== currentTurn) return;
    
    const updates = {};
    updates[`${gameId}/board/${row}/${col}`] = myPlayerNumber;
    updates[`${gameId}/currentTurn`] = myPlayerNumber === 1 ? 2 : 1;
    
    update(ref(db), updates);
}

// Update Game State
function updateGameState(snapshot) {
    const data = snapshot.val() || { board: {}, players: {} };
    
    // Update Board
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < (10 - row); col++) {
            const circle = document.querySelector(`.circle[data-row="${row}"][data-col="${col}"]`);
            if (circle) {
                const owner = data.board?.[row]?.[col];
                circle.className = `circle ${owner ? `filled${owner}` : 'empty'}`;
            }
        }
    }
    
    // Update Scores
    let score1 = 0, score2 = 0;
    for (let row = 0; row < 10; row++) {
        const cols = 10 - row;
        let complete1 = true, complete2 = true;
        
        for (let col = 0; col < cols; col++) {
            if (data.board?.[row]?.[col] !== 1) complete1 = false;
            if (data.board?.[row]?.[col] !== 2) complete2 = false;
        }
        
        if (complete1) score1 += cols;
        if (complete2) score2 += cols;
    }
    
    score1Display.textContent = score1;
    score2Display.textContent = score2;
    
    // Update Turn
    currentTurn = data.currentTurn || 1;
    gameStatus.textContent = 
        myPlayerNumber === currentTurn ? "Your turn!" : "Opponent's turn...";
    
    // Assign Player Number
    if (!myPlayerNumber) {
        const playerCount = Object.keys(data.players || {}).length;
        myPlayerNumber = playerCount < 2 ? playerCount + 1 : null;
        
        if (myPlayerNumber) {
            playerIdDisplay.textContent = `Player ${myPlayerNumber}`;
            set(ref(db, `${gameId}/players/${myPlayerNumber}`), true);
        } else {
            gameStatus.textContent = "Game is full (2 players max)";
        }
    }
}

// Initialize Game
createBoard();
set(ref(db, `${gameId}/currentTurn`), 1);

// Listen for Changes
onValue(ref(db, gameId), updateGameState);