// script.js
import { db, ref, onValue, runTransaction, set } from './firebase.js';

// UI Elements
const gridEl       = document.getElementById('circleGrid');
const turnEl       = document.getElementById('turnIndicator');
const giveBtn      = document.getElementById('giveTurn');
const resetBtn     = document.getElementById('resetGame');
const player1El    = document.getElementById('player1');
const player2El    = document.getElementById('player2');
const canvas       = document.getElementById('lineCanvas');
const ctx          = canvas.getContext('2d');
const modal        = document.getElementById('modal');
const modalText    = document.getElementById('modalText');
const modalOk      = document.getElementById('modalOk');
const modalClose   = document.getElementById('modalClose');

canvas.width = window.innerWidth;
canvas.height= window.innerHeight;

// Game State
const roomId     = 'demo-room';
let playerId     = localStorage.getItem('playerId') || (Math.random()>0.5?'blue':'red');
localStorage.setItem('playerId', playerId);
let state        = { board:{}, lines:[], score:{blue:0,red:0}, turn:'blue' };
let lastAction   = null; // 'fill' or 'line'

// 27 allowed lines: precompute as array of arrays of 'r-c' keys
const allowedLines = [];
(function buildLines(){
  // rows 0–8 horizontals
  for(let r=0;r<9;r++){
    const line=[]; for(let c=0;c<10-r;c++) line.push(`${r}-${c}`);
    allowedLines.push(line);
  }
  // ↘ diagonals
  for(let start=0; start<9; start++){
    let r=0,c=start,seg=[]; while(r<10&&c<10-r){seg.push(`${r}-${c}`); r++; c++;}
    if(seg.length>1) allowedLines.push(seg);
  }
  for(let start=1; start<9; start++){
    let r=start,c=0,seg=[]; while(r<10&&c<10-r){seg.push(`${r}-${c}`); r++; c++;}
    if(seg.length>1) allowedLines.push(seg);
  }
  // ↙ diagonals
  for(let start=1; start<10; start++){
    let r=0,c=start,seg=[]; while(r<10&&c>=0){seg.push(`${r}-${c}`); r++; c--;}
    if(seg.length>1) allowedLines.push(seg);
  }
  for(let start=1; start<9; start++){
    let r=start,c=9-start,seg=[]; while(r<10&&c>=0){seg.push(`${r}-${c}`); r++; c--;}
    if(seg.length>1) allowedLines.push(seg);
  }
})();

// Build UI grid
function initGrid(){
  gridEl.innerHTML='';
  for(let r=0;r<10;r++){
    const row=document.createElement('div'); row.className='circle-row';
    for(let c=0;c<10-r;c++){
      const cell=document.createElement('div');
      cell.className='circle'; cell.dataset.pos=`${r}-${c}`;
      cell.addEventListener('pointerdown',onFill);
      row.appendChild(cell);
    }
    gridEl.appendChild(row);
  }
}

// Fill handler
function onFill(e){
  if(state.turn!==playerId) return;
  const key=e.target.dataset.pos;
  if(state.board[key]) return;
  if(lastAction==='fill') return showModal('Draw a line before filling again.');
  runTransaction(ref(db,`games/${roomId}`), data=>{
    if(!data) data=state;
    if(data.turn!==playerId) return;
    if(data.board[key]) return;
    data.board[key]=playerId;
    data.turn=null; // lock until line or giveTurn
    lastAction='fill';
    return data;
  });
}

// Listen for changes
onValue(ref(db,`games/${roomId}`),snap=>{
  const data=snap.val();
  if(data) state=data;
  render();
});

// Render UI
function render(){
  // circles
  document.querySelectorAll('.circle').forEach(div=>{
    const key=div.dataset.pos;
    div.classList.toggle('filled-blue', state.board[key]==='blue');
    div.classList.toggle('filled-red',  state.board[key]==='red');
  });
  // turn
  turnEl.textContent = state.turn===playerId? "Your Turn":"Opponent's Turn";
  // scores
  player1El.textContent=`🔵 ${state.score.blue}`;
  player2El.textContent=`🔴 ${state.score.red}`;
  // lines
  drawAllLines();
}

// Draw existing lines
function drawAllLines(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  state.lines.forEach(line=>{
    const [r1,c1]=line.from.split('-').map(Number);
    const [r2,c2]=line.to.split('-').map(Number);
    const el1=document.querySelector(`[data-pos='${r1}-${c1}']`);
    const el2=document.querySelector(`[data-pos='${r2}-${c2}']`);
    if(el1&&el2){
      const a=el1.getBoundingClientRect(),b=el2.getBoundingClientRect();
      ctx.beginPath(); ctx.moveTo(a.left+18,a.top+18);
      ctx.lineTo(b.left+18,b.top+18);
      ctx.strokeStyle = line.player==='blue'? 'var(--neon-blue)':'var(--neon-red)';
      ctx.lineWidth=4; ctx.shadowBlur=12;
      ctx.shadowColor=line.player==='blue'? 'var(--neon-blue)':'var(--neon-red)';
      ctx.stroke(); ctx.shadowBlur=0;
    }
  });
}

// Gesture for drawing lines
let drawing=false, path=[];
gridEl.addEventListener('pointerdown',e=>{
  if(state.turn!==playerId) return;
  drawing=true; path=[];
  handlePointer(e);
});
gridEl.addEventListener('pointermove',handlePointer);
gridEl.addEventListener('pointerup',e=>{
  if(!drawing) return; drawing=false;
  tryLine();
});
function handlePointer(e){
  if(!drawing) return;
  const tgt=e.target.closest('.circle');
  if(tgt){
    const key=tgt.dataset.pos;
    if(!path.includes(key)) path.push(key);
  }
}

// Validate & submit line
function tryLine(){
  // find matching allowed line
  const match = allowedLines.find(seg=>{
    return seg.length===path.length &&
           seg.every((k,i)=>k===path[i]||k===path[path.length-1-i]);
  });
  if(!match) return showModal('Invalid line');
  // ensure not yet drawn
  const exists = state.lines.some(l=>
    l.from+'-'+l.to===`${match[0]}-${match.at(-1)}`
  );
  if(exists) return;
  // commit via transaction
  runTransaction(ref(db,`games/${roomId}`),data=>{
    if(!data) data=state;
    if(!data.lines) data.lines=[];
    data.lines.push({ from:match[0], to:match.at(-1), player:playerId });
    data.score[playerId] += match.length;
    data.turn = playerId; // keep turn
    lastAction='line';
    return data;
  });
  burstParticles(path);
}

// Particle burst
function burstParticles(path){
  path.forEach(key=>{
    const el=document.querySelector(`[data-pos='${key}']`);
    if(!el) return;
    const rect=el.getBoundingClientRect();
    for(let i=0;i<8;i++){
      const dot=document.createElement('div');
      dot.className='particle';
      dot.style.background= playerId==='blue'? 'var(--neon-blue)':'var(--neon-red)';
      const angle= Math.random()*Math.PI*2;
      const dist=20+Math.random()*20;
      dot.style.setProperty('--dx', `${Math.cos(angle)*dist}px`);
      dot.style.setProperty('--dy', `${Math.sin(angle)*dist}px`);
      dot.style.left=`${rect.left+16}px`;
      dot.style.top=`${rect.top+16}px`;
      document.body.appendChild(dot);
      dot.addEventListener('animationend',()=>dot.remove());
    }
  });
}

// Give turn
giveBtn.addEventListener('click',()=>{
  runTransaction(ref(db,`games/${roomId}`),data=>{
    if(!data) data=state;
    data.turn = playerId==='blue'?'red':'blue';
    lastAction=null;
    return data;
  });
});

// Reset
resetBtn.addEventListener('click',()=>{
  set(ref(db,`games/${roomId}`),{
    board:{}, lines:[], score:{blue:0,red:0}, turn:'blue'
  });
});

// Modal
function showModal(msg){
  modalText.textContent=msg;
  modal.classList.remove('hidden');
}
modalOk.onclick = modalClose.onclick = ()=>modal.classList.add('hidden');

// Init
initGrid();
