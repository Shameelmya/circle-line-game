// script.js
import { db, ref, onValue, runTransaction, set } from './index.html';

const gridEl     = document.getElementById('circleGrid');
const turnEl     = document.getElementById('turnIndicator');
const giveBtn    = document.getElementById('giveTurn');
const resetBtn   = document.getElementById('resetGame');
const p1El       = document.getElementById('player1');
const p2El       = document.getElementById('player2');
const setupModal = document.getElementById('setupModal');
const chooseB    = document.getElementById('chooseBlue');
const chooseR    = document.getElementById('chooseRed');
const infoModal  = document.getElementById('modal');
const infoText   = document.getElementById('modalText');
const infoOk     = document.getElementById('modalOk');
const canvas     = document.getElementById('lineCanvas');
const ctx        = canvas.getContext('2d');

canvas.width  = window.innerWidth;
canvas.height = window.innerHeight;

const roomId   = 'demo-room';
let playerId, state={board:{},lines:[],score:{blue:0,red:0},turn:null}, last='none';

// Precompute the 27 allowed lines
const allowed = [];
(function(){
  // 9 horizontals
  for(let r=0;r<9;r++){
    const seg=[]; for(let c=0;c<10-r;c++) seg.push(`${r}-${c}`);
    allowed.push(seg);
  }
  // ↘ diagonals
  for(let s=0;s<9;s++){let r=0,c=s,seg=[];while(r<10&&c<10-r)seg.push(`${r++}-${c++}`);if(seg.length>1)allowed.push(seg);}
  for(let s=1;s<9;s++){let r=s,c=0,seg=[];while(r<10&&c<10-r)seg.push(`${r++}-${c++}`);if(seg.length>1)allowed.push(seg);}
  // ↙ diagonals
  for(let s=1;s<10;s++){let r=0,c=s,seg=[];while(r<10&&c>=0)seg.push(`${r++}-${c--}`);if(seg.length>1)allowed.push(seg);}
  for(let s=1;s<9;s++){let r=s,c=9-s,seg=[];while(r<10&&c>=0)seg.push(`${r++}-${c--}`);if(seg.length>1)allowed.push(seg);}
})();

// Build grid
function buildGrid(){
  gridEl.innerHTML='';
  for(let r=0;r<10;r++){
    for(let c=0;c<10-r;c++){
      const div=document.createElement('div');
      div.className='circle';
      div.dataset.pos=`${r}-${c}`;
      div.addEventListener('pointerdown',onFill);
      gridEl.appendChild(div);
    }
  }
}

// Choose player
chooseB.onclick = ()=>select('blue');
chooseR.onclick = ()=>select('red');
function select(col){
  playerId=col;
  localStorage.setItem('playerId',col);
  setupModal.classList.add('hidden');
  initFirebase();
}

// Info modal
function showInfo(msg){
  infoText.textContent=msg;
  infoModal.classList.remove('hidden');
}
infoOk.onclick = ()=>infoModal.classList.add('hidden');

// Fill circle handler
function onFill(e){
  if(state.turn!==playerId) return;
  const key=e.target.dataset.pos;
  if(state.board[key]|| last==='fill') {
    if(last==='fill') return showInfo('Draw a valid line before filling another.');
    return;
  }
  runTransaction(ref(db,`games/${roomId}`),data=>{
    if(!data) data=state;
    if(data.turn!==playerId||data.board[key]) return;
    data.board[key]=playerId;
    data.turn=null; last='fill';
    return data;
  });
}

// Listen to Firebase
function initFirebase(){
  onValue(ref(db,`games/${roomId}`),snap=>{
    const d=snap.val();
    if(d){ state=d; render(); }
    else { // first time
      set(ref(db,`games/${roomId}`),state);
    }
  });
}

// Render UI
function render(){
  // circles
  document.querySelectorAll('.circle').forEach(div=>{
    const k=div.dataset.pos;
    div.classList.toggle('filled-blue',state.board[k]==='blue');
    div.classList.toggle('filled-red', state.board[k]==='red');
  });
  // turn & scores
  turnEl.textContent = state.turn===playerId? "Your Turn":"Opponent's Turn";
  p1El.textContent = `🔵 ${state.score.blue}`;
  p2El.textContent = `🔴 ${state.score.red}`;
  drawLines();
}

// Draw lines
function drawLines(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  state.lines.forEach(l=>{
    const [r1,c1]=l.from.split('-').map(Number),
          [r2,c2]=l.to.split('-').map(Number);
    const el1=document.querySelector(`[data-pos='${r1}-${c1}']`),
          el2=document.querySelector(`[data-pos='${r2}-${c2}']`);
    if(el1&&el2){
      const a=el1.getBoundingClientRect(),
            b=el2.getBoundingClientRect();
      ctx.beginPath();
      ctx.moveTo(a.left+12,a.top+12);
      ctx.lineTo(b.left+12,b.top+12);
      ctx.strokeStyle = l.player==='blue'? 'rgba(33,150,243,0.7)' : 'rgba(229,57,53,0.7)';
      ctx.lineWidth=4; ctx.shadowBlur=12;
      ctx.stroke(); ctx.shadowBlur=0;
    }
  });
}

// Gesture handling
let drawing=false, path=[];
gridEl.addEventListener('pointerdown',e=>{
  if(state.turn!==playerId) return;
  drawing=true; path=[];
  record(e);
});
gridEl.addEventListener('pointermove',record);
gridEl.addEventListener('pointerup',()=>{ drawing=false; tryLine(); });

function record(e){
  if(!drawing) return;
  const tgt=e.target.closest('.circle');
  if(tgt){
    const k=tgt.dataset.pos;
    if(!path.includes(k)) path.push(k);
  }
}

// Validate & submit line
function tryLine(){
  const match=allowed.find(seg=>
    seg.length===path.length &&
    seg.every((v,i)=>v===path[i]||v===path[path.length-1-i])
  );
  if(!match) return;
  const exists=state.lines.some(l=>l.from===match[0]&&l.to===match.at(-1));
  if(exists) return;
  runTransaction(ref(db,`games/${roomId}`),data=>{
    if(!data) data=state;
    data.lines.push({from:match[0],to:match.at(-1),player:playerId});
    data.score[playerId]+=match.length;
    data.turn=playerId; last='line';
    return data;
  });
}

// Turn toggle
giveBtn.onclick = ()=>{
  runTransaction(ref(db,`games/${roomId}`),data=>{
    if(!data) data=state;
    data.turn = (data.turn==='blue'?'red':'blue');
    last=null;
    return data;
  });
};

// Reset game
resetBtn.onclick = ()=>{
  set(ref(db,`games/${roomId}`),{
    board:{}, lines:[], score:{blue:0,red:0}, turn:'blue'
  });
};

// Initialize
window.addEventListener('load',buildGrid);
if(localStorage.getItem('playerId')){
  select(localStorage.getItem('playerId'));
} else {
  setupModal.classList.remove('hidden');
}
