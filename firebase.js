// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getDatabase, ref, onValue, set, update } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBnOC0IGWlpOTSUFoMqtji36XqrFgYoRII",
  authDomain: "circle-line-game.firebaseapp.com",
  projectId: "circle-line-game",
  storageBucket: "circle-line-game.appspot.com",
  messagingSenderId: "73822238753",
  appId: "1:73822238753:web:48c52f0ffef482235e0b60",
  databaseURL: "https://circle-line-game-default-rtdb.asia-southeast1.firebasedatabase.app"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db, ref, onValue, set, update };
