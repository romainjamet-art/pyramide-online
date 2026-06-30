const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const rooms = new Map();

const suits = [
  { id: 'hearts', name: 'Coeur', sym: '♥', color: 'red' },
  { id: 'diamonds', name: 'Carreau', sym: '♦', color: 'red' },
  { id: 'clubs', name: 'Trèfle', sym: '♣', color: 'black' },
  { id: 'spades', name: 'Pique', sym: '♠', color: 'black' },
];
const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const rankValue = { A: 1, J: 11, Q: 12, K: 13 };
for (let i=2;i<=10;i++) rankValue[String(i)] = i;

function newDeck(){
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ id: `${r}-${s.id}`, rank: r, suit: s.id, suitName: s.name, sym: s.sym, color: s.color, value: rankValue[r] });
  for (let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function code(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function safeRoom(room, viewerId){
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    currentPyramidIndex: room.currentPyramidIndex,
    currentPenalty: room.currentPenalty,
    pendingClaim: room.pendingClaim,
    players: room.players.map(p => ({ id:p.id, name:p.name, connected:p.connected, cards: p.id===viewerId ? p.cards : p.cards.map(c => ({ hidden:true })), cardCount:p.cards.length })),
    pyramid: room.pyramid.map((c, i) => i < room.currentPyramidIndex ? c : { hidden:true, row:c.row, penalty:c.penalty }),
    log: room.log.slice(-30),
  };
}
function emitRoom(room){
  for (const p of room.players) io.to(p.id).emit('state', safeRoom(room, p.id));
}
function log(room, msg){ room.log.push({ t: new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), msg }); }
function getRoomBySocket(id){ for (const r of rooms.values()) if (r.players.some(p=>p.id===id)) return r; return null; }
function draw(room){ if (room.deck.length===0) room.deck = newDeck(); return room.deck.pop(); }
function buildPyramid(deck){
  const pyramid=[];
  for (let row=1; row<=6; row++) {
    for (let col=0; col<row; col++) pyramid.push({ ...deck.pop(), row, penalty: row===6 ? 'CUL SEC' : `${row} gorgée${row>1?'s':''}` });
  }
  return pyramid;
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name }) => {
    const c = code();
    const room = { code:c, hostId:socket.id, phase:'lobby', players:[{id:socket.id, name:(name||'Joueur').slice(0,18), connected:true, cards:[]}], deck:[], pyramid:[], currentPyramidIndex:0, currentPenalty:null, pendingClaim:null, log:[] };
    rooms.set(c, room); socket.join(c); log(room, `${room.players[0].name} a créé la partie.`); emitRoom(room);
  });
  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = rooms.get((roomCode||'').toUpperCase());
    if (!room) return socket.emit('errorMsg','Salon introuvable.');
    if (room.phase !== 'lobby') return socket.emit('errorMsg','La partie a déjà commencé.');
    if (room.players.length >= 6) return socket.emit('errorMsg','Salon complet.');
    room.players.push({id:socket.id, name:(name||'Joueur').slice(0,18), connected:true, cards:[]}); socket.join(room.code); log(room, `${name||'Un joueur'} a rejoint.`); emitRoom(room);
  });
  socket.on('startGame', () => {
    const room = getRoomBySocket(socket.id); if (!room || room.hostId!==socket.id) return;
    if (room.players.length < 2 || room.players.length > 6) return socket.emit('errorMsg','Il faut 2 à 6 joueurs.');
    room.deck = newDeck(); room.pyramid = buildPyramid(room.deck); room.currentPyramidIndex=0; room.pendingClaim=null; room.currentPenalty=null;
    for (const p of room.players) p.cards = [draw(room), draw(room), draw(room), draw(room)];
    room.phase='playing'; log(room, 'La partie commence. Chaque joueur reçoit 4 cartes. La pyramide est posée.'); emitRoom(room);
  });
  socket.on('peekCards', () => { const room=getRoomBySocket(socket.id); if(!room)return; const p=room.players.find(x=>x.id===socket.id); log(room, `${p.name} regarde ses cartes : pénalité 1 gorgée.`); emitRoom(room); });
  socket.on('revealNext', () => {
    const room=getRoomBySocket(socket.id); if(!room || room.hostId!==socket.id || room.phase!=='playing') return;
    if (room.pendingClaim) return socket.emit('errorMsg','Termine le défi menteur avant.');
    if (room.currentPyramidIndex>=room.pyramid.length){ room.phase='finished'; log(room,'Pyramide terminée.'); emitRoom(room); return; }
    const card=room.pyramid[room.currentPyramidIndex]; room.currentPyramidIndex++; room.currentPenalty=card.penalty;
    log(room, `Carte révélée : ${card.rank}${card.sym} — pénalité : ${card.penalty}.`); emitRoom(room);
  });
  socket.on('claim', ({ targetId, cardIndex }) => {
    const room=getRoomBySocket(socket.id); if(!room || room.phase!=='playing' || room.pendingClaim) return;
    const source=room.players.find(p=>p.id===socket.id); const target=room.players.find(p=>p.id===targetId);
    const card=source?.cards[cardIndex]; const pyramidCard=room.pyramid[room.currentPyramidIndex-1];
    if(!source || !target || !card || !pyramidCard) return;
    room.pendingClaim={ sourceId:socket.id, sourceName:source.name, targetId, targetName:target.name, cardIndex, rank:pyramidCard.rank, penalty:pyramidCard.penalty };
    log(room, `${source.name} distribue ${pyramidCard.penalty} à ${target.name} en annonçant ${pyramidCard.rank}.`); emitRoom(room);
  });
  socket.on('acceptClaim', () => {
    const room=getRoomBySocket(socket.id); if(!room || !room.pendingClaim || room.pendingClaim.targetId!==socket.id) return;
    log(room, `${room.pendingClaim.targetName} accepte la pénalité : ${room.pendingClaim.penalty}.`); room.pendingClaim=null; emitRoom(room);
  });
  socket.on('callLiar', () => {
    const room=getRoomBySocket(socket.id); if(!room || !room.pendingClaim || room.pendingClaim.targetId!==socket.id) return;
    const claim=room.pendingClaim; const source=room.players.find(p=>p.id===claim.sourceId); const shown=source.cards[claim.cardIndex];
    const ok = shown && shown.rank === claim.rank;
    source.cards[claim.cardIndex] = draw(room);
    if (ok) log(room, `MENTEUR ! ${source.name} montre ${shown.rank}${shown.sym}. Il disait vrai : ${claim.targetName} prend la pénalité doublée et ${source.name} repioche.`);
    else log(room, `MENTEUR ! ${source.name} montre ${shown.rank}${shown.sym}. Il mentait : ${source.name} prend la pénalité doublée et repioche.`);
    room.pendingClaim=null; emitRoom(room);
  });
  socket.on('disconnect', () => { const room=getRoomBySocket(socket.id); if(!room)return; const p=room.players.find(x=>x.id===socket.id); p.connected=false; log(room, `${p.name} s'est déconnecté.`); emitRoom(room); });
});

server.listen(PORT, () => console.log(`Pyramide en ligne sur port ${PORT}`));
