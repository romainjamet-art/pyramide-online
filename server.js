const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const rooms = {};

const suits = ["♥", "♦", "♣", "♠"];
const values = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function makeDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({
        value,
        suit,
        color: suit === "♥" || suit === "♦" ? "red" : "black"
      });
    }
  }
  return shuffle(deck);
}

function shuffle(deck) {
  return deck.sort(() => Math.random() - 0.5);
}

function codeRoom() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function publicRoom(room, socketId = null) {
  const me = room.players.find(p => p.id === socketId);

  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    currentDealPlayer: room.currentDealPlayer,
    currentDealStep: room.currentDealStep,
    currentPyramidIndex: room.currentPyramidIndex,
    currentPyramidCard: room.currentPyramidCard,
    currentPenalty: room.currentPenalty,
    log: room.log.slice(-40),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      cardCount: p.hand.length,
      drinks: p.drinks,
      hand: p.id === socketId && room.phase !== "pyramid_locked" ? p.hand : null
    })),
    myHand: me ? me.hand : [],
    pyramid: room.pyramid.map((card, index) => ({
      index,
      revealed: card.revealed,
      value: card.revealed ? card.value : "?",
      suit: card.revealed ? card.suit : "?",
      color: card.revealed ? card.color : "hidden",
      penalty: card.penalty
    }))
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", publicRoom(room, p.id));
  }
}

function addLog(room, text) {
  room.log.push(text);
}

function dealCard(room) {
  if (room.deck.length === 0) room.deck = makeDeck();
  return room.deck.pop();
}

function buildPyramid(room) {
  const rows = [
    { count: 6, penalty: 1 },
    { count: 5, penalty: 2 },
    { count: 4, penalty: 3 },
    { count: 3, penalty: 4 },
    { count: 2, penalty: 5 },
    { count: 1, penalty: "CUL SEC" }
  ];

  room.pyramid = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const card = dealCard(room);
      room.pyramid.push({ ...card, revealed: false, penalty: row.penalty });
    }
  }
}

function stepName(step) {
  return ["Rouge ou Noir", "Plus ou Moins", "Intérieur ou Extérieur", "Symbole"][step];
}

function cardText(card) {
  return `${card.value}${card.suit}`;
}

function nextDeal(room) {
  const player = room.players[room.currentDealPlayer];

  if (player.hand.length >= 4) {
    room.currentDealPlayer++;
    room.currentDealStep = 0;
  }

  if (room.currentDealPlayer >= room.players.length) {
    buildPyramid(room);
    room.phase = "pyramid_locked";
    addLog(room, "La pyramide est posée. Les cartes sont maintenant cachées.");
    return;
  }

  addLog(room, `Au tour de ${room.players[room.currentDealPlayer].name} : ${stepName(room.currentDealStep)}.`);
}

function compareValue(a, b) {
  return values.indexOf(a) - values.indexOf(b);
}

function checkDealGuess(player, step, guess, card) {
  if (step === 0) return guess === card.color;
  if (step === 1) {
    const previous = player.hand[0];
    if (guess === "plus") return compareValue(card.value, previous.value) > 0;
    if (guess === "moins") return compareValue(card.value, previous.value) < 0;
  }
  if (step === 2) {
    const a = values.indexOf(player.hand[0].value);
    const b = values.indexOf(player.hand[1].value);
    const c = values.indexOf(card.value);
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (guess === "interieur") return c > min && c < max;
    if (guess === "exterieur") return c < min || c > max;
  }
  if (step === 3) return guess === card.suit;
  return false;
}

io.on("connection", socket => {
  socket.on("createRoom", name => {
    const code = codeRoom();
    rooms[code] = {
      code,
      hostId: socket.id,
      phase: "lobby",
      deck: makeDeck(),
      players: [{ id: socket.id, name, hand: [], drinks: 0 }],
      pyramid: [],
      currentDealPlayer: 0,
      currentDealStep: 0,
      currentPyramidIndex: -1,
      currentPyramidCard: null,
      currentPenalty: null,
      log: [`${name} a créé la partie.`]
    };
    socket.join(code);
    emitRoom(rooms[code]);
  });

  socket.on("joinRoom", ({ code, name }) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Salon introuvable.");
    if (room.players.length >= 6) return socket.emit("errorMsg", "Salon complet.");
    if (room.phase !== "lobby") return socket.emit("errorMsg", "Partie déjà commencée.");

    room.players.push({ id: socket.id, name, hand: [], drinks: 0 });
    socket.join(code);
    addLog(room, `${name} a rejoint la partie.`);
    emitRoom(room);
  });

  socket.on("startGame", code => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return;
    if (room.players.length < 2) return socket.emit("errorMsg", "Il faut au moins 2 joueurs.");

    room.phase = "deal";
    room.currentDealPlayer = 0;
    room.currentDealStep = 0;
    addLog(room, "Distribution commencée.");
    nextDeal(room);
    emitRoom(room);
  });

  socket.on("dealGuess", ({ code, guess, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== "deal") return;

    const player = room.players[room.currentDealPlayer];
    if (!player || player.id !== socket.id) return;

    const card = dealCard(room);
    const step = room.currentDealStep;
    const penalty = step + 1;
    const good = checkDealGuess(player, step, guess, card);

    player.hand.push(card);

    if (good) {
      const target = room.players.find(p => p.id === targetId);
      if (target) {
        target.drinks += penalty;
        addLog(room, `${player.name} a eu bon (${cardText(card)}) et donne ${penalty} gorgée(s) à ${target.name}.`);
      } else {
        addLog(room, `${player.name} a eu bon (${cardText(card)}).`);
      }
    } else {
      player.drinks += penalty;
      addLog(room, `${player.name} s'est trompé (${cardText(card)}) et boit ${penalty} gorgée(s).`);
    }

    room.currentDealStep++;
    nextDeal(room);
    emitRoom(room);
  });

  socket.on("revealNextPyramid", code => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return;
    if (room.phase !== "pyramid_locked") return;

    room.currentPyramidIndex++;
    if (room.currentPyramidIndex >= room.pyramid.length) {
      room.phase = "finished";
      addLog(room, "Partie terminée.");
      emitRoom(room);
      return;
    }

    const card = room.pyramid[room.currentPyramidIndex];
    card.revealed = true;
    room.currentPyramidCard = card;
    room.currentPenalty = card.penalty;

    addLog(room, `Carte révélée : ${cardText(card)} — ${card.penalty}.`);
    emitRoom(room);
  });

  socket.on("givePenalty", ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== "pyramid_locked") return;
    if (!room.currentPyramidCard) return;

    const giver = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!giver || !target || giver.id === target.id) return;

    room.pendingChallenge = {
      giverId: giver.id,
      targetId: target.id,
      value: room.currentPyramidCard.value,
      penalty: room.currentPenalty
    };

    addLog(room, `${giver.name} donne ${room.currentPenalty} à ${target.name}. ${target.name} peut accepter ou dire MENTEUR.`);
    emitRoom(room);
  });

  socket.on("acceptPenalty", code => {
    const room = rooms[code];
    if (!room || !room.pendingChallenge) return;

    const challenge = room.pendingChallenge;
    if (challenge.targetId !== socket.id) return;

    const target = room.players.find(p => p.id === challenge.targetId);
    target.drinks += challenge.penalty === "CUL SEC" ? 10 : challenge.penalty;

    addLog(room, `${target.name} accepte et boit ${challenge.penalty}.`);
    room.pendingChallenge = null;
    emitRoom(room);
  });

  socket.on("challengeLiar", ({ code, cardIndex }) => {
    const room = rooms[code];
    if (!room || !room.pendingChallenge) return;

    const challenge = room.pendingChallenge;
    if (challenge.targetId !== socket.id) return;

    const giver = room.players.find(p => p.id === challenge.giverId);
    const target = room.players.find(p => p.id === challenge.targetId);
    const shown = giver.hand[cardIndex];

    if (!shown) return;

    const doublePenalty = challenge.penalty === "CUL SEC" ? "DOUBLE CUL SEC" : challenge.penalty * 2;
    const numeric = challenge.penalty === "CUL SEC" ? 20 : challenge.penalty * 2;

    if (shown.value === challenge.value) {
      target.drinks += numeric;
      giver.hand[cardIndex] = dealCard(room);
      addLog(room, `${giver.name} montre ${cardText(shown)}. Il avait raison. ${target.name} boit ${doublePenalty}. Carte échangée.`);
    } else {
      giver.drinks += numeric;
      addLog(room, `${giver.name} montre ${cardText(shown)}. Menteur ! ${giver.name} boit ${doublePenalty}.`);
    }

    room.pendingChallenge = null;
    emitRoom(room);
  });

  socket.on("lookCard", ({ code, cardIndex }) => {
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.hand[cardIndex]) return;

    if (room.phase === "pyramid_locked") {
      player.drinks += 1;
      addLog(room, `${player.name} regarde une carte et prend 1 gorgée.`);
    }

    socket.emit("privateCard", {
      index: cardIndex,
      card: player.hand[cardIndex]
    });

    emitRoom(room);
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const player = room.players.find(p => p.id === socket.id);
      if (!player) continue;

      room.players = room.players.filter(p => p.id !== socket.id);
      addLog(room, `${player.name} a quitté la partie.`);

      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        emitRoom(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pyramide lancée sur le port ${PORT}`);
});
