const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

const packsDir = path.join(__dirname, 'packs');
if (!fs.existsSync(packsDir)) fs.mkdirSync(packsDir);

const rooms = new Map();
const sessions = new Map();

// ===== ПРОВЕРКА ОТВЕТА (для бота) =====
function checkAnswer(correct, given) {
  if (!given || !correct) return false;

  const normalize = (s) => {
    return s.toLowerCase().trim()
      .replace(/ё/g, 'е')
      .replace(/[«»""''„‟\-–—.,:;!?()[\]{}/\\'"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const c = normalize(correct);
  const g = normalize(given);

  if (c === g) return true;
  if (c.includes(g) && g.length >= 3) return true;
  if (g.includes(c) && c.length >= 3) return true;

  const variants = correct
    .split(/[\/|]/)
    .map(v => v.replace(/\(.*?\)/g, ' '))
    .map(normalize)
    .filter(v => v.length > 0);

  const bracketMatches = correct.match(/\(([^)]+)\)/g);
  if (bracketMatches) {
    for (const bm of bracketMatches) {
      const inner = bm.replace(/[()]/g, '').replace(/^(или|or|и|aka)\s+/i, '');
      variants.push(normalize(inner));
    }
  }

  for (const variant of variants) {
    if (!variant) continue;
    if (variant === g) return true;
    if (variant.includes(g) && g.length >= 3) return true;
    if (g.includes(variant) && variant.length >= 3) return true;

    if (variant.length <= 15 && g.length <= 15) {
      const dist = levenshtein(variant, g);
      const maxLen = Math.max(variant.length, g.length);
      if (maxLen > 0 && dist / maxLen <= 0.25) return true;
    }
  }

  const cNums = c.match(/\d+/g);
  const gNums = g.match(/\d+/g);
  if (cNums && gNums && cNums.length === 1 && gNums.length === 1) {
    if (cNums[0] === gNums[0]) return true;
  }

  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

// ===== КЛАСС КОМНАТЫ =====
class GameRoom {
  constructor(id, hostId, hostName, hostSessionId, customQuestions, autoHost) {
    this.id = id;
    this.hostId = hostId;
    this.hostName = hostName;
    this.hostSessionId = hostSessionId;
    this.customQuestions = customQuestions || null;
    this.autoHost = autoHost || false;
    this.players = new Map();
    this.playerSocketMap = new Map();
    this.state = 'lobby';
    this.currentRound = 0;
    this.rounds = this.generateRounds();
    this.currentQuestion = null;
    this.buzzerLocked = true;
    this.currentAnsweringPlayer = null;
    this.wrongAnswers = new Set();
    this.timer = null;
    this.questionTimer = null;
    this.selectedByPlayer = null;
    this.lastCorrectPlayer = null;
    this.catInBagTarget = null;
    this.auctionBets = new Map();
    this.auctionPhase = false;
    this.finalBets = new Map();
    this.finalAnswers = new Map();
    this.finalTheme = null;
    this.finalData = null;
    this.autoStartTimer = null;
    this.createdAt = Date.now();
  }

  generateRounds() {
    const sourceData = this.customQuestions || questionsData;
    this.finalData = sourceData.finalRound;
    const rounds = [];
    for (let r = 0; r < sourceData.rounds.length; r++) {
      const roundData = sourceData.rounds[r];
      const categories = [];
      for (const cat of roundData.categories) {
        const questions = [];
        for (const q of cat.questions) {
          questions.push({
            value: q.value * (r + 1),
            text: q.text,
            answer: q.answer,
            type: q.type || 'normal',
            catTheme: q.catTheme || null,
            options: q.options || null,
            answered: false
          });
        }
        categories.push({ name: cat.name, questions });
      }
      rounds.push({ name: roundData.name, categories });
    }
    return rounds;
  }

  getRandomColor() {
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  addPlayer(sessionId, name) {
    if (this.players.size >= 6) return false;
    if (this.state !== 'lobby') return false;
    this.players.set(sessionId, {
      sessionId, name, score: 0,
      avatarColor: this.getRandomColor(),
      connected: true
    });
    return true;
  }

  getPlayersArray() {
    return Array.from(this.players.values()).map(p => ({ ...p, id: p.sessionId }));
  }

  getRoundData() {
    if (this.currentRound >= this.rounds.length) return null;
    const round = this.rounds[this.currentRound];
    return {
      name: round.name,
      categories: round.categories.map(cat => ({
        name: cat.name,
        questions: cat.questions.map(q => ({
          value: q.value, answered: q.answered, type: q.type
        }))
      }))
    };
  }

  getQuestion(catIndex, qIndex) {
    if (this.currentRound >= this.rounds.length) return null;
    const round = this.rounds[this.currentRound];
    if (catIndex >= round.categories.length) return null;
    const cat = round.categories[catIndex];
    if (qIndex >= cat.questions.length) return null;
    return cat.questions[qIndex];
  }

  markQuestionAnswered(catIndex, qIndex) {
    this.rounds[this.currentRound].categories[catIndex].questions[qIndex].answered = true;
  }

  isRoundComplete() {
    const round = this.rounds[this.currentRound];
    return round.categories.every(cat => cat.questions.every(q => q.answered));
  }

  getSocketId(sessionId) {
    return this.playerSocketMap.get(sessionId);
  }

  getHostSocketId() {
    return this.playerSocketMap.get(this.hostSessionId) || this.hostId;
  }
}

// ===== УТИЛИТЫ =====
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateSessionId() {
  return uuidv4();
}

// Формируем объект question-show
function makeQuestionPayload(room, question, extra) {
  const categoryName = room.rounds[room.currentRound].categories[question.catIndex].name;
  return {
    category: extra?.category || categoryName,
    value: extra?.value || question.value,
    text: question.text,
    catIndex: question.catIndex,
    qIndex: question.qIndex,
    options: question.options || null,
    ...(extra || {})
  };
}

// ===== API =====
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of rooms) {
    if (room.state === 'lobby') {
      list.push({
        id: room.id, hostName: room.hostName,
        players: room.players.size, maxPlayers: 6,
        autoHost: room.autoHost
      });
    }
  }
  res.json(list);
});

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

app.get('/api/questions/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-z0-9_-]/gi, '');
  if (name === 'default') return res.json(questionsData);
  const packPath = path.join(packsDir, `${name}.json`);
  if (fs.existsSync(packPath)) {
    try { return res.json(JSON.parse(fs.readFileSync(packPath, 'utf8'))); }
    catch (e) { return res.status(500).json({ error: 'Ошибка' }); }
  }
  res.status(404).json({ error: 'Не найден' });
});

app.get('/api/packs', (req, res) => {
  const packs = [{ id: 'default', name: 'Стандартный' }];
  if (fs.existsSync(packsDir)) {
    for (const file of fs.readdirSync(packsDir).filter(f => f.endsWith('.json'))) {
      const id = file.replace('.json', '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(packsDir, file), 'utf8'));
        packs.push({ id, name: data.packName || id });
      } catch (e) {}
    }
  }
  res.json(packs);
});

// ===== АВТО-ВЕДУЩИЙ =====
function autoJudgeAnswer(room, sessId, textAnswer) {
  if (!room.currentQuestion || room.currentAnsweringPlayer !== sessId) return;
  clearTimeout(room.timer);

  const player = room.players.get(sessId);
  const question = room.currentQuestion;
  const value = question.value;
  const correct = checkAnswer(question.answer, textAnswer);

  if (correct) {
    player.score += value;
    room.lastCorrectPlayer = sessId;
    room.selectedByPlayer = sessId;
    room.markQuestionAnswered(question.catIndex, question.qIndex);

    io.to(room.id).emit('answer-result', {
      correct: true, playerId: sessId, playerName: player.name,
      value, answer: question.answer, players: room.getPlayersArray()
    });

    room.state = 'playing';
    room.currentQuestion = null;
    room.currentAnsweringPlayer = null;
    setTimeout(() => checkRoundEnd(room), 2500);

  } else {
    player.score -= value;
    room.wrongAnswers.add(sessId);

    io.to(room.id).emit('answer-result', {
      correct: false, playerId: sessId, playerName: player.name,
      value: -value, players: room.getPlayersArray()
    });

    io.to(room.id).emit('auto-wrong-detail', {
      playerAnswer: textAnswer,
      correctAnswer: question.answer,
      playerName: player.name
    });

    room.currentAnsweringPlayer = null;

    if (room.catInBagTarget) {
      endQuestion(room);
      return;
    }

    const active = Array.from(room.players.keys()).filter(id => !room.wrongAnswers.has(id));
    if (active.length === 0) {
      endQuestion(room);
    } else {
      room.state = 'question';
      room.buzzerLocked = false;
      io.to(room.id).emit('buzzer-unlocked');
      room.questionTimer = setTimeout(() => {
        if (room.state === 'question') endQuestion(room);
      }, 10000);
    }
  }
}

function autoStartQuestion(room, catIndex, qIndex) {
  const question = room.getQuestion(catIndex, qIndex);
  if (!question || question.answered) return;

  room.currentQuestion = { catIndex, qIndex, ...question };
  room.wrongAnswers = new Set();
  room.currentAnsweringPlayer = null;
  room.catInBagTarget = null;

  const categoryName = room.rounds[room.currentRound].categories[catIndex].name;

  // Кот в мешке — случайный игрок
  if (question.type === 'cat') {
    const others = Array.from(room.players.keys()).filter(id => id !== room.selectedByPlayer);
    const target = others.length > 0
      ? others[Math.floor(Math.random() * others.length)]
      : room.selectedByPlayer;

    room.catInBagTarget = target;
    room.state = 'question';
    room.buzzerLocked = true;

    io.to(room.id).emit('auto-cat-in-bag', {
      catTheme: question.catTheme,
      value: question.value,
      targetPlayerName: room.players.get(target)?.name
    });

    setTimeout(() => {
      io.to(room.id).emit('question-show', makeQuestionPayload(room, room.currentQuestion, {
        category: question.catTheme || categoryName,
        catInBag: true,
        targetPlayer: target,
        targetPlayerName: room.players.get(target)?.name
      }));

      setTimeout(() => {
        if (room.state === 'question') {
          room.currentAnsweringPlayer = target;
          room.state = 'answering';
          io.to(room.id).emit('player-answering', {
            playerId: target,
            playerName: room.players.get(target)?.name
          });
          room.timer = setTimeout(() => {
            if (room.state === 'answering') autoJudgeAnswer(room, target, '');
          }, 25000);
        }
      }, 3000);
    }, 2000);
    return;
  }

  // Аукцион — упрощённый в авто-режиме
  if (question.type === 'auction') {
    room.state = 'question';
    room.buzzerLocked = true;

    io.to(room.id).emit('auto-auction', {
      category: categoryName,
      value: question.value
    });

    setTimeout(() => {
      io.to(room.id).emit('question-show', makeQuestionPayload(room, room.currentQuestion, {
        auction: true
      }));

      setTimeout(() => {
        if (room.state === 'question') {
          room.buzzerLocked = false;
          io.to(room.id).emit('buzzer-unlocked');
          room.questionTimer = setTimeout(() => {
            if (room.state === 'question') endQuestion(room);
          }, 15000);
        }
      }, 3000);
    }, 2000);
    return;
  }

  // Обычный вопрос
  room.state = 'question';
  room.buzzerLocked = true;

  io.to(room.id).emit('question-show', makeQuestionPayload(room, room.currentQuestion));

  setTimeout(() => {
    if (room.currentQuestion && room.state === 'question') {
      room.buzzerLocked = false;
      io.to(room.id).emit('buzzer-unlocked');
      room.questionTimer = setTimeout(() => {
        if (room.state === 'question') endQuestion(room);
      }, 15000);
    }
  }, 3000);
}

function autoFinalJudge(room) {
  clearTimeout(room.timer);
  const finalData = room.finalData || questionsData.finalRound;
  const results = [];

  for (const [sessId, answer] of room.finalAnswers) {
    const correct = checkAnswer(finalData.answer, answer);
    const player = room.players.get(sessId);
    const bet = room.finalBets.get(sessId) || 0;
    if (player) player.score += correct ? bet : -bet;
    results.push({
      playerId: sessId, playerName: player?.name,
      answer, bet, correct
    });
  }

  room.state = 'finished';
  const playersArr = room.getPlayersArray().sort((a, b) => b.score - a.score);

  io.to(room.id).emit('auto-final-results', {
    results,
    correctAnswer: finalData.answer
  });

  setTimeout(() => {
    io.to(room.id).emit('game-over', {
      players: playersArr,
      winner: playersArr[0]
    });
  }, 5000);
}

function autoStartGame(room) {
  room.state = 'playing';
  room.currentRound = 0;
  const sessionIds = Array.from(room.players.keys());
  room.selectedByPlayer = sessionIds[Math.floor(Math.random() * sessionIds.length)];

  io.to(room.id).emit('game-started', {
    round: room.getRoundData(),
    roundIndex: room.currentRound,
    players: room.getPlayersArray(),
    choosingPlayer: room.selectedByPlayer,
    choosingPlayerName: room.players.get(room.selectedByPlayer)?.name,
    autoHost: true
  });
  console.log(`Авто-игра началась в ${room.id}`);
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log(`Подключение: ${socket.id}`);

  function getSessionId() { return socket.sessionId; }
  function getRoom() { return rooms.get(socket.roomId); }

  // --- Создание обычной комнаты ---
  socket.on('create-room', (data) => {
    const roomId = generateRoomCode();
    const sessionId = data.sessionId || generateSessionId();
    const customQ = data.customQuestions || null;

    const room = new GameRoom(roomId, socket.id, data.name, sessionId, customQ, false);
    room.playerSocketMap.set(sessionId, socket.id);
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.sessionId = sessionId;
    socket.isHost = true;

    sessions.set(sessionId, { roomId, playerName: data.name, isHost: true });

    socket.emit('room-created', {
      roomId, hostName: data.name, sessionId,
      hasCustomQuestions: !!customQ
    });
    console.log(`Комната ${roomId} создана: ${data.name}${customQ ? ' (свои вопросы)' : ''}`);
  });

  // --- Создание авто-комнаты ---
  socket.on('create-auto-room', (data) => {
    const roomId = generateRoomCode();
    const hostSessionId = generateSessionId();
    const customQ = data.customQuestions || null;

    const room = new GameRoom(roomId, 'bot', '🤖 Бот-ведущий', hostSessionId, customQ, true);
    rooms.set(roomId, room);

    socket.emit('auto-room-created', {
      roomId,
      playerName: data.playerName
    });
    console.log(`Авто-комната ${roomId} создана для ${data.playerName}`);
  });

  // --- Переподключение ведущего ---
  socket.on('host-reconnect', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit('reconnect-failed', { message: 'Комната не найдена' }); return; }
    if (room.hostSessionId !== data.sessionId) { socket.emit('reconnect-failed', { message: 'Неверная сессия' }); return; }

    room.hostId = socket.id;
    room.playerSocketMap.set(data.sessionId, socket.id);
    socket.join(data.roomId);
    socket.roomId = data.roomId;
    socket.sessionId = data.sessionId;
    socket.isHost = true;

    console.log(`Ведущий переподключился к ${data.roomId}`);
    sendFullStateToHost(socket, room);
  });

    // --- Вход в комнату ---
  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit('error-msg', { message: 'Комната не найдена' }); return; }

    if (data.sessionId) {
      const existing = room.players.get(data.sessionId);
      if (existing) return handlePlayerReconnect(socket, room, data.sessionId, existing);
    }

    if (room.state !== 'lobby') {
      socket.emit('error-msg', { message: 'Игра уже началась. Обновите страницу для переподключения.' });
      return;
    }
    if (room.players.size >= 6) {
      socket.emit('error-msg', { message: 'Комната полная (макс. 6)' });
      return;
    }

    const sessionId = generateSessionId();
    room.addPlayer(sessionId, data.name);
    room.playerSocketMap.set(sessionId, socket.id);

    socket.join(data.roomId);
    socket.roomId = data.roomId;
    socket.sessionId = sessionId;
    socket.isHost = false;
    socket.playerName = data.name;

    sessions.set(sessionId, { roomId: data.roomId, playerName: data.name, isHost: false });

    socket.emit('joined-room', {
      roomId: data.roomId, playerName: data.name, sessionId,
      avatarColor: room.players.get(sessionId).avatarColor,
      players: room.getPlayersArray(),
      autoHost: room.autoHost
    });

    io.to(data.roomId).emit('players-update', { players: room.getPlayersArray() });

    console.log(`${data.name} → ${data.roomId}`);

    if (room.autoHost) {
      io.to(data.roomId).emit('auto-waiting', {
        message: 'Нажмите "Начать игру", когда все подключатся',
        playerCount: room.players.size
      });
    }
  });

  // --- Ручной старт авто-игры ---
  socket.on('auto-start-now', () => {
    const room = getRoom();
    if (!room || !room.autoHost || room.state !== 'lobby' || room.players.size < 1) return;
    clearTimeout(room.autoStartTimer);
    autoStartGame(room);
  });

  // --- Переподключение игрока ---
  socket.on('player-reconnect', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit('reconnect-failed', { message: 'Комната не найдена' }); return; }
    const player = room.players.get(data.sessionId);
    if (!player) { socket.emit('reconnect-failed', { message: 'Игрок не найден' }); return; }
    handlePlayerReconnect(socket, room, data.sessionId, player);
  });

  function handlePlayerReconnect(socket, room, sessionId, player) {
    room.playerSocketMap.set(sessionId, socket.id);
    player.connected = true;
    socket.join(room.id);
    socket.roomId = room.id;
    socket.sessionId = sessionId;
    socket.isHost = false;
    socket.playerName = player.name;

    socket.emit('reconnected', {
      roomId: room.id, sessionId, playerName: player.name,
      avatarColor: player.avatarColor, autoHost: room.autoHost
    });
    sendFullStateToPlayer(socket, room, sessionId);
    io.to(room.id).emit('players-update', { players: room.getPlayersArray() });
    io.to(room.id).emit('player-reconnected', { playerName: player.name });
  }

  // --- Полное состояние: ведущий ---
  function sendFullStateToHost(socket, room) {
    socket.emit('reconnected-host', {
      roomId: room.id, sessionId: room.hostSessionId,
      state: room.state, players: room.getPlayersArray()
    });

    switch (room.state) {
      case 'lobby':
        socket.emit('players-update', { players: room.getPlayersArray() });
        break;
      case 'playing':
        socket.emit('show-board', {
          round: room.getRoundData(), roundIndex: room.currentRound,
          players: room.getPlayersArray(), choosingPlayer: room.selectedByPlayer,
          choosingPlayerName: room.players.get(room.selectedByPlayer)?.name
        });
        break;
      case 'question':
      case 'answering':
        if (room.currentQuestion) {
          socket.emit('question-show', makeQuestionPayload(room, room.currentQuestion));
          socket.emit('host-answer', { answer: room.currentQuestion.answer });
          if (room.state === 'answering' && room.currentAnsweringPlayer) {
            socket.emit('player-answering', {
              playerId: room.currentAnsweringPlayer,
              playerName: room.players.get(room.currentAnsweringPlayer)?.name
            });
          }
        }
        break;
      case 'finished':
        socket.emit('game-over', {
          players: room.getPlayersArray().sort((a, b) => b.score - a.score),
          winner: room.getPlayersArray().sort((a, b) => b.score - a.score)[0]
        });
        break;
    }
  }

  // --- Полное состояние: игрок ---
  function sendFullStateToPlayer(socket, room, sessionId) {
    switch (room.state) {
      case 'lobby':
        socket.emit('players-update', { players: room.getPlayersArray() });
        break;
      case 'playing':
        socket.emit('game-started', {
          round: room.getRoundData(), roundIndex: room.currentRound,
          players: room.getPlayersArray(), choosingPlayer: room.selectedByPlayer,
          choosingPlayerName: room.players.get(room.selectedByPlayer)?.name,
          autoHost: room.autoHost
        });
        break;
      case 'question':
      case 'answering':
        if (room.currentQuestion) {
          socket.emit('question-show', makeQuestionPayload(room, room.currentQuestion));
          if (room.state === 'question' && !room.buzzerLocked && !room.wrongAnswers.has(sessionId)) {
            socket.emit('buzzer-unlocked');
          }
          if (room.state === 'answering' && room.currentAnsweringPlayer) {
            socket.emit('player-answering', {
              playerId: room.currentAnsweringPlayer,
              playerName: room.players.get(room.currentAnsweringPlayer)?.name
            });
          }
        }
        break;
      case 'cat-select':
        if (room.currentQuestion) {
          socket.emit('cat-in-bag', {
            catTheme: room.currentQuestion.catTheme, value: room.currentQuestion.value,
            choosingPlayer: room.selectedByPlayer,
            choosingPlayerName: room.players.get(room.selectedByPlayer)?.name,
            players: room.getPlayersArray()
          });
        }
        break;
      case 'auction':
        if (room.currentQuestion) {
          const catName = room.rounds[room.currentRound].categories[room.currentQuestion.catIndex].name;
          socket.emit('auction-start', {
            category: catName, value: room.currentQuestion.value,
            players: room.getPlayersArray()
          });
        }
        break;
      case 'final-betting':
        socket.emit('final-round', {
          theme: (room.finalData || questionsData.finalRound).theme,
          players: room.getPlayersArray(),
          eligiblePlayers: getEligibleFinalPlayers(room)
        });
        break;
      case 'final-answering':
        socket.emit('final-question', {
          theme: (room.finalData || questionsData.finalRound).theme,
          text: (room.finalData || questionsData.finalRound).text,
          timeLimit: 30
        });
        break;
      case 'finished':
        socket.emit('game-over', {
          players: room.getPlayersArray().sort((a, b) => b.score - a.score),
          winner: room.getPlayersArray().sort((a, b) => b.score - a.score)[0]
        });
        break;
    }
  }

  // --- Начало игры (живой ведущий) ---
  socket.on('start-game', () => {
    const room = getRoom();
    if (!room || !socket.isHost) return;
    if (room.players.size < 1) { socket.emit('error-msg', { message: 'Нужен хотя бы 1 игрок' }); return; }

    room.state = 'playing';
    room.currentRound = 0;
    const ids = Array.from(room.players.keys());
    room.selectedByPlayer = ids[Math.floor(Math.random() * ids.length)];

    io.to(socket.roomId).emit('game-started', {
      round: room.getRoundData(), roundIndex: room.currentRound,
      players: room.getPlayersArray(), choosingPlayer: room.selectedByPlayer,
      choosingPlayerName: room.players.get(room.selectedByPlayer)?.name
    });
  });

  // --- Выбор вопроса ---
  socket.on('select-question', (data) => {
    const room = getRoom();
    if (!room || room.state !== 'playing') return;

    const sessId = getSessionId();
    if (room.autoHost) {
      if (sessId !== room.selectedByPlayer) return;
    } else {
      if (sessId !== room.selectedByPlayer && !socket.isHost) return;
    }

    const { catIndex, qIndex } = data;
    const question = room.getQuestion(catIndex, qIndex);
    if (!question || question.answered) return;

    if (room.autoHost) {
      autoStartQuestion(room, catIndex, qIndex);
      return;
    }

    // Живой ведущий
    room.currentQuestion = { catIndex, qIndex, ...question };
    room.wrongAnswers = new Set();
    room.currentAnsweringPlayer = null;
    room.catInBagTarget = null;

    const categoryName = room.rounds[room.currentRound].categories[catIndex].name;

    if (question.type === 'cat') {
      room.state = 'cat-select';
      io.to(socket.roomId).emit('cat-in-bag', {
        catTheme: question.catTheme, value: question.value,
        choosingPlayer: room.selectedByPlayer,
        choosingPlayerName: room.players.get(room.selectedByPlayer)?.name,
        players: room.getPlayersArray()
      });
      return;
    }

    if (question.type === 'auction') {
      room.state = 'auction';
      room.auctionBets = new Map();
      room.auctionPhase = true;
      io.to(socket.roomId).emit('auction-start', {
        category: categoryName, value: question.value,
        players: room.getPlayersArray()
      });
      return;
    }

    room.state = 'question';
    room.buzzerLocked = true;

    io.to(socket.roomId).emit('question-show', makeQuestionPayload(room, room.currentQuestion));
    io.to(room.getHostSocketId()).emit('host-answer', { answer: question.answer });

    setTimeout(() => {
      if (room.currentQuestion && room.state === 'question') {
        room.buzzerLocked = false;
        io.to(socket.roomId).emit('buzzer-unlocked');
        room.questionTimer = setTimeout(() => {
          if (room.state === 'question') endQuestion(room);
        }, 15000);
      }
    }, 3000);
  });

  // --- Кот в мешке ---
  socket.on('cat-select-player', (data) => {
    const room = getRoom();
    if (!room || room.state !== 'cat-select') return;
    const sessId = getSessionId();
    if (sessId !== room.selectedByPlayer && !socket.isHost) return;

    const target = data.playerId;
    if (!room.players.has(target)) return;

    room.catInBagTarget = target;
    room.state = 'question';
    room.buzzerLocked = true;

    const q = room.currentQuestion;

    io.to(socket.roomId).emit('question-show', makeQuestionPayload(room, q, {
      category: q.catTheme || room.rounds[room.currentRound].categories[q.catIndex].name,
      catInBag: true,
      targetPlayer: target,
      targetPlayerName: room.players.get(target)?.name
    }));

    io.to(room.getHostSocketId()).emit('host-answer', { answer: q.answer });

    setTimeout(() => {
      if (room.state === 'question') {
        room.currentAnsweringPlayer = target;
        room.state = 'answering';
        io.to(socket.roomId).emit('player-answering', {
          playerId: target,
          playerName: room.players.get(target)?.name
        });
        room.timer = setTimeout(() => {
          if (room.state === 'answering') io.to(room.id).emit('answer-timeout');
        }, 20000);
      }
    }, 3000);
  });

  // --- Аукцион ---
  socket.on('auction-bet', (data) => {
    const room = getRoom();
    if (!room || room.state !== 'auction') return;
    const sessId = getSessionId();
    if (!room.players.has(sessId)) return;

    const player = room.players.get(sessId);

    if (data.allIn) {
      room.auctionBets.set(sessId, { bet: 'all-in', value: Math.max(player.score, room.currentQuestion.value) });
    } else if (data.pass) {
      room.auctionBets.set(sessId, { bet: 'pass', value: 0 });
    } else {
      room.auctionBets.set(sessId, { bet: parseInt(data.bet), value: parseInt(data.bet) });
    }

    io.to(socket.roomId).emit('auction-bet-placed', {
      playerId: sessId, playerName: player.name,
      betCount: room.auctionBets.size, totalPlayers: room.players.size
    });

    if (room.auctionBets.size >= room.players.size) finishAuction(room);
  });

  socket.on('finish-auction', () => {
    const room = getRoom();
    if (!room || !socket.isHost || room.state !== 'auction') return;
    finishAuction(room);
  });

  // --- Buzzer ---
  socket.on('buzzer', () => {
    const room = getRoom();
    if (!room || room.state !== 'question' || room.buzzerLocked) return;
    const sessId = getSessionId();
    if (!room.players.has(sessId) || room.wrongAnswers.has(sessId)) return;

    room.buzzerLocked = true;
    room.currentAnsweringPlayer = sessId;
    room.state = 'answering';
    clearTimeout(room.questionTimer);

    const player = room.players.get(sessId);
    io.to(socket.roomId).emit('player-answering', {
      playerId: sessId, playerName: player.name
    });

    room.timer = setTimeout(() => {
      if (room.state === 'answering' && room.currentAnsweringPlayer === sessId) {
        if (room.autoHost) autoJudgeAnswer(room, sessId, '');
        else io.to(room.id).emit('answer-timeout');
      }
    }, 25000);
  });

  // --- Текстовый ответ ---
  socket.on('text-answer', (data) => {
    const room = getRoom();
    if (!room) return;
    const sessId = getSessionId();
    if (room.currentAnsweringPlayer !== sessId) return;

    const answer = (data.answer || '').substring(0, 200);
    const player = room.players.get(sessId);

    if (room.autoHost) {
      autoJudgeAnswer(room, sessId, answer);
    } else {
      io.to(room.getHostSocketId()).emit('player-text-answer', {
        playerId: sessId, playerName: player.name, answer
      });
    }
  });

  // --- Оценка (живой ведущий) ---
  socket.on('judge-answer', (data) => {
    const room = getRoom();
    if (!room || !socket.isHost || !room.currentAnsweringPlayer) return;
    clearTimeout(room.timer);

    const sessId = room.currentAnsweringPlayer;
    const player = room.players.get(sessId);
    const question = room.currentQuestion;
    const value = question.value;

    if (data.correct) {
      player.score += value;
      room.lastCorrectPlayer = sessId;
      room.selectedByPlayer = sessId;
      room.markQuestionAnswered(question.catIndex, question.qIndex);

      io.to(socket.roomId).emit('answer-result', {
        correct: true, playerId: sessId, playerName: player.name,
        value, answer: question.answer, players: room.getPlayersArray()
      });

      room.state = 'playing';
      room.currentQuestion = null;
      room.currentAnsweringPlayer = null;
      setTimeout(() => checkRoundEnd(room), 2000);
    } else {
      player.score -= value;
      room.wrongAnswers.add(sessId);

      io.to(socket.roomId).emit('answer-result', {
        correct: false, playerId: sessId, playerName: player.name,
        value: -value, players: room.getPlayersArray()
      });

      room.currentAnsweringPlayer = null;

      if (room.catInBagTarget) { endQuestion(room); return; }

      const active = Array.from(room.players.keys()).filter(id => !room.wrongAnswers.has(id));
      if (active.length === 0) {
        endQuestion(room);
      } else {
        room.state = 'question';
        room.buzzerLocked = false;
        io.to(socket.roomId).emit('buzzer-unlocked');
        room.questionTimer = setTimeout(() => {
          if (room.state === 'question') endQuestion(room);
        }, 10000);
      }
    }
  });

  // --- Пропуск ---
  socket.on('skip-question', () => {
    const room = getRoom();
    if (room && socket.isHost && room.currentQuestion) endQuestion(room);
  });

  // --- Следующий раунд ---
  socket.on('next-round', () => {
    const room = getRoom();
    if (room && socket.isHost) startNextRound(room);
  });

  // --- Финал: ставка ---
  socket.on('final-bet', (data) => {
    const room = getRoom();
    if (!room || room.state !== 'final-betting') return;
    const sessId = getSessionId();
    if (!room.players.has(sessId)) return;

    const player = room.players.get(sessId);
    const bet = Math.min(Math.max(0, parseInt(data.bet) || 0), Math.max(player.score, 0));
    room.finalBets.set(sessId, bet);
    socket.emit('final-bet-accepted', { bet });

    if (!room.autoHost) {
      io.to(room.getHostSocketId()).emit('final-bet-update', {
        playerId: sessId, playerName: player.name,
        totalBets: room.finalBets.size,
        totalPlayers: getEligibleFinalPlayers(room).length
      });
    }

    if (room.finalBets.size >= getEligibleFinalPlayers(room).length) {
      startFinalQuestion(room);
    }
  });

  // --- Финал: ответ ---
  socket.on('final-answer', (data) => {
    const room = getRoom();
    if (!room || room.state !== 'final-answering') return;
    const sessId = getSessionId();
    if (!room.players.has(sessId)) return;

    room.finalAnswers.set(sessId, data.answer || '');
    const eligible = getEligibleFinalPlayers(room);

    if (room.autoHost) {
      if (room.finalAnswers.size >= eligible.length) autoFinalJudge(room);
    } else {
      io.to(room.getHostSocketId()).emit('final-answer-update', {
        answersCount: room.finalAnswers.size, totalPlayers: eligible.length
      });
      if (room.finalAnswers.size >= eligible.length) showFinalResults(room);
    }
  });

  // --- Финал: оценка (живой ведущий) ---
  socket.on('judge-final', (data) => {
    const room = getRoom();
    if (!room || !socket.isHost) return;

    for (const result of data.results) {
      const player = room.players.get(result.playerId);
      if (!player) continue;
      const bet = room.finalBets.get(result.playerId) || 0;
      player.score += result.correct ? bet : -bet;
    }

    room.state = 'finished';
    const pa = room.getPlayersArray().sort((a, b) => b.score - a.score);
    io.to(socket.roomId).emit('game-over', { players: pa, winner: pa[0] });
  });

  // --- Очки ---
  socket.on('adjust-score', (data) => {
    const room = getRoom();
    if (!room || !socket.isHost) return;
    const player = room.players.get(data.playerId);
    if (player) {
      player.score += data.amount;
      io.to(socket.roomId).emit('players-update', { players: room.getPlayersArray() });
    }
  });

  // --- Чат ---
  socket.on('chat-message', (data) => {
    const room = getRoom();
    if (!room) return;
    const sessId = getSessionId();
    const name = socket.isHost
      ? `🎤 ${room.hostName}`
      : (room.players.get(sessId)?.name || 'Аноним');

    io.to(socket.roomId).emit('chat-message', {
      name, message: data.message.substring(0, 200), timestamp: Date.now()
    });
  });

  // --- Отключение ---
  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    const sessId = getSessionId();

    if (socket.isHost) {
      console.log(`Ведущий отключился от ${socket.roomId}`);
      io.to(socket.roomId).emit('host-disconnected');
    } else if (sessId && room.players.has(sessId)) {
      room.players.get(sessId).connected = false;
      console.log(`${room.players.get(sessId).name} отключился от ${socket.roomId}`);
      io.to(socket.roomId).emit('player-disconnected', {
        playerName: room.players.get(sessId).name,
        players: room.getPlayersArray()
      });
    }
  });
});

// ===== ОБЩИЕ ФУНКЦИИ =====
function endQuestion(room) {
  clearTimeout(room.timer);
  clearTimeout(room.questionTimer);

  const q = room.currentQuestion;
  if (!q) return;

  room.markQuestionAnswered(q.catIndex, q.qIndex);

  io.to(room.id).emit('question-end', {
    answer: q.answer,
    players: room.getPlayersArray()
  });

  room.state = 'playing';
  room.currentQuestion = null;
  room.currentAnsweringPlayer = null;
  room.catInBagTarget = null;
  room.buzzerLocked = true;

  setTimeout(() => checkRoundEnd(room), 3000);
}

function finishAuction(room) {
  let maxBet = 0, winnerId = null;
  for (const [s, b] of room.auctionBets) {
    if (b.bet !== 'pass' && b.value > maxBet) { maxBet = b.value; winnerId = s; }
  }
  if (!winnerId) { winnerId = room.selectedByPlayer; maxBet = room.currentQuestion.value; }

  room.auctionPhase = false;
  room.state = 'question';
  room.currentQuestion.value = maxBet;

  io.to(room.id).emit('auction-result', {
    winnerId, winnerName: room.players.get(winnerId)?.name, bet: maxBet
  });

  setTimeout(() => {
    io.to(room.id).emit('question-show', makeQuestionPayload(room, room.currentQuestion, {
      value: maxBet, auction: true
    }));

    if (!room.autoHost) {
      io.to(room.getHostSocketId()).emit('host-answer', { answer: room.currentQuestion.answer });
    }

    setTimeout(() => {
      if (room.state === 'question') {
        room.currentAnsweringPlayer = winnerId;
        room.state = 'answering';
        io.to(room.id).emit('player-answering', {
          playerId: winnerId,
          playerName: room.players.get(winnerId)?.name
        });
        room.timer = setTimeout(() => {
          if (room.state === 'answering') {
            if (room.autoHost) autoJudgeAnswer(room, winnerId, '');
            else io.to(room.id).emit('answer-timeout');
          }
        }, 25000);
      }
    }, 3000);
  }, 2000);
}

function checkRoundEnd(room) {
  if (room.isRoundComplete()) {
    if (room.currentRound < room.rounds.length - 1) {
      io.to(room.id).emit('round-complete', {
        roundIndex: room.currentRound,
        players: room.getPlayersArray(),
        hasNextRound: true
      });
      if (room.autoHost) setTimeout(() => startNextRound(room), 5000);
    } else {
      startFinalRound(room);
    }
  } else {
    io.to(room.id).emit('show-board', {
      round: room.getRoundData(), roundIndex: room.currentRound,
      players: room.getPlayersArray(), choosingPlayer: room.selectedByPlayer,
      choosingPlayerName: room.players.get(room.selectedByPlayer)?.name
    });
  }
}

function startNextRound(room) {
  room.currentRound++;
  if (room.currentRound >= room.rounds.length) { startFinalRound(room); return; }
  room.state = 'playing';
  io.to(room.id).emit('new-round', {
    round: room.getRoundData(), roundIndex: room.currentRound,
    players: room.getPlayersArray(), choosingPlayer: room.selectedByPlayer,
    choosingPlayerName: room.players.get(room.selectedByPlayer)?.name
  });
}

function startFinalRound(room) {
  const fd = room.finalData || questionsData.finalRound;
  room.finalTheme = fd.theme;
  room.state = 'final-betting';
  room.finalBets = new Map();
  room.finalAnswers = new Map();

  const eligible = getEligibleFinalPlayers(room);
  if (eligible.length === 0) {
    room.state = 'finished';
    const pa = room.getPlayersArray().sort((a, b) => b.score - a.score);
    io.to(room.id).emit('game-over', { players: pa, winner: pa[0] });
    return;
  }

  io.to(room.id).emit('final-round', {
    theme: fd.theme, players: room.getPlayersArray(), eligiblePlayers: eligible
  });
}

function getEligibleFinalPlayers(room) {
  return Array.from(room.players.keys()).filter(id => {
    const p = room.players.get(id);
    return p.score > 0 && p.connected;
  });
}

function startFinalQuestion(room) {
  room.state = 'final-answering';
  const fd = room.finalData || questionsData.finalRound;
  io.to(room.id).emit('final-question', { theme: fd.theme, text: fd.text, timeLimit: 60 });
  room.timer = setTimeout(() => {
    if (room.state === 'final-answering') {
      if (room.autoHost) autoFinalJudge(room);
      else showFinalResults(room);
    }
  }, 65000);
}

function showFinalResults(room) {
  clearTimeout(room.timer);
  room.state = 'final-judging';
  const fd = room.finalData || questionsData.finalRound;
  const answers = [];
  for (const [s, a] of room.finalAnswers) {
    answers.push({
      playerId: s, playerName: room.players.get(s)?.name,
      answer: a, bet: room.finalBets.get(s) || 0
    });
  }
  io.to(room.getHostSocketId()).emit('final-judge', { answers, correctAnswer: fd.answer });
  for (const [s] of room.players) {
    const sock = room.getSocketId(s);
    if (sock) io.to(sock).emit('final-waiting', { message: 'Ведущий проверяет...' });
  }
}

// Очистка
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 5 * 60 * 60 * 1000) {
      rooms.delete(id);
      console.log(`Комната ${id} удалена`);
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  ⭐ СВОЯ ИГРА — сервер запущен');
  console.log(`  📡 Порт: ${PORT}`);
  console.log('  🤖 Авто-ведущий: включён');
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log('========================================');
});
