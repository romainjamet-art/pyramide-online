const socket = io();
let state=null, myId=null;
const $=id=>document.getElementById(id);
function cardHtml(c){ if(c.hidden) return '<div class="card back">?</div>'; return `<div class="card ${c.color==='red'?'red':''}"><div>${c.rank}</div><div>${c.sym}</div></div>`; }
function render(){ if(!state)return; $('home').classList.add('hidden'); $('game').classList.remove('hidden'); $('code').textContent=state.code; $('start').style.display=state.phase==='lobby'&&state.hostId===myId?'inline-block':'none'; $('next').style.display=state.phase==='playing'&&state.hostId===myId?'inline-block':'none';
 const me=state.players.find(p=>p.id===myId);
 $('players').innerHTML=state.players.map(p=>`<div class="player"><span>${p.name}${p.id===state.hostId?' 👑':''}${p.connected?'':' (déco)'}</span><span>${p.cardCount} cartes</span></div>`).join('');
 const rows=[1,2,3,4,5,6].map(r=>`<div class="row"><span class="rowLabel">Ligne ${r} — ${r===6?'CUL SEC':r+' gorgée'+(r>1?'s':'')}</span>${state.pyramid.filter(c=>c.row===r).map(cardHtml).join('')}</div>`).join(''); $('pyramid').innerHTML=rows;
 $('hand').innerHTML=(me?.cards||[]).map((c,i)=>`<div style="display:inline-block;text-align:center">${cardHtml(c)}<br>${state.phase==='playing'?targetSelect(i):''}</div>`).join('');
 $('log').innerHTML=state.log.map(l=>`<div class="logLine"><b>${l.t}</b> ${l.msg}</div>`).reverse().join('');
 if(state.pendingClaim){ $('pending').classList.remove('hidden'); const c=state.pendingClaim; $('pending').innerHTML=`<b>Défi en cours :</b> ${c.sourceName} distribue ${c.penalty} à ${c.targetName}. ${c.targetId===myId?'<button id="accept">Accepter</button><button id="liar" class="danger">Menteur !</button>':'Attente de la réponse...'}`; if(c.targetId===myId){ $('accept').onclick=()=>socket.emit('acceptClaim'); $('liar').onclick=()=>socket.emit('callLiar'); }} else $('pending').classList.add('hidden');
}
function targetSelect(cardIndex){ const others=state.players.filter(p=>p.id!==myId); return `<select id="sel${cardIndex}">${others.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select><button onclick="claim(${cardIndex})">Distribuer</button>`; }
window.claim=i=>socket.emit('claim',{cardIndex:i,targetId:$('sel'+i).value});
$('create').onclick=()=>socket.emit('createRoom',{name:$('name').value});
$('join').onclick=()=>socket.emit('joinRoom',{name:$('name').value,roomCode:$('room').value});
$('start').onclick=()=>socket.emit('startGame'); $('next').onclick=()=>socket.emit('revealNext'); $('peek').onclick=()=>socket.emit('peekCards');
socket.on('connect',()=>myId=socket.id); socket.on('state',s=>{state=s; render();}); socket.on('errorMsg',m=>$('err').textContent=m);
