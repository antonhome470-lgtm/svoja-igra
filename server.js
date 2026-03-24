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
app.use(express.json());

const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

const rooms = new Map();

// ===== Связь между sessionId и socket =====
// sessionId → { roomId, playerName, playerId (старый socketId) }
const sessions = new Map();

class GameRoom {
  constructor(id, hostId, hostName, hostSessionId) {
    this.id = id;
    this.hostId = hostId;
    this.hostName = hostName;
    this.hostSessionId = hostSessionId;
    this.players = new Map(); // sessionId → playerData
    this.playerSocketMap = new Map(); // sessionId → текущий socketId
    this.state = 'lobby';
    this.currentRound = 0;
    this.rounds = this.generateRounds();
    this.currentQuestion = null;
    this.buzzerLocked = true;
    this.currentAnsweringPlayer = null; // sessionId
    this.wrongAnswers = new Set(); // sessionId
    this.timer = null;
    this.questionTimer = null;
    this.selectedByPlayer = null; // sessionId
    this.lastCorrectPlayer = null;
    this.catInBagTarget = null; // sessionId
    this.auctionBets = new Map();
    this.auctionPhase = false;
    this.finalBets = new Map();
    this.finalAnswers = new Map();
    this.finalTheme = null;
    this.createdAt = Date.now();
  }

  generateRounds() {
    const rounds = [];
    for (let r = 0; r < questionsData.rounds.length; r++) {
      const roundData = questionsData.rounds[r];
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
    const colors = [
      '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
      '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  addPlayer(sessionId, name) {
    if (this.players.size >= 6) return false;
    if (this.state !== 'lobby') return false;
    this.players.set(sessionId, {
      sessionId: sessionId,
      name: name,
      score: 0,
      avatarColor: this.getRandomColor(),
      connected: true
    });
    return true;
  }

  getPlayersArray() {
    return Array.from(this.players.values()).map(p => ({
      ...p,
      id: p.sessionId // клиент использует id для идентификации
    }));
  }

  getRoundData() {
    if (this.currentRound >= this.rounds.length) return null;
    const round = this.rounds[this.currentRound];
    return {
      name: round.name,
      categories: round.categories.map(cat => ({
        name: cat.name,
        questions: cat.questions.map(q => ({
          value: q.value,
          answered: q.answered,
          type: q.type
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
    this.rounds[this.currentRound]
      .categories[catIndex].questions[qIndex].answered = true;
  }

  isRoundComplete() {
    const round = this.rounds[this.currentRound];
    return round.categories.every(cat =>
      cat.questions.every(q => q.answered)
    );
  }

  // Получить socketId по sessionId
  getSocketId(sessionId) {
    return this.playerSocketMap.get(sessionId);
  }

  // Получить sessionId по socketId
  getSessionBySocket(socketId) {
    for (const [sessId, sockId] of this.playerSocketMap) {
      if (sockId === socketId) return sessId;
    }
    return null;
  }

  // Отправить всем в комнате
  getHostSocketId() {
    return this.playerSocketMap.get(this.hostSessionId) || this.hostId;
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateSessionId() {
  return uuidv4();
}

// ===== API =====
app.get('/api/rooms', (req, res) => {
  const roomList = [];
  for (const [id, room] of rooms) {
    if (room.state === 'lobby') {
      roomList.push({
        id: room.id,
        hostName: room.hostName,
        players: room.players.size,
        maxPlayers: 6
      });
    }
  }
  res.json(roomList);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log(`Подключение: ${socket.id}`);

  // --- Создание комнаты (ведущий) ---
  socket.on('create-room', (data) => {
    const roomId = generateRoomCode();
    const sessionId = data.sessionId || generateSessionId();
    const room = new GameRoom(roomId, socket.id, data.name, sessionId);

    room.playerSocketMap.set(sessionId, socket.id);
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.sessionId = sessionId;
    socket.isHost = true;

    sessions.set(sessionId, {
      roomId,
      playerName: data.name,
      isHost: true
    });

    socket.emit('room-created', {
      roomId,
      hostName: data.name,
      sessionId
    });
    console.log(`Комната ${roomId} создана: ${data.name}`);
  });

  // --- Переподключение ведущего ---
  socket.on('host-reconnect', (data) => {
    const { sessionId, roomId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('reconnect-failed', { message: 'Комната не найдена' });
      return;
    }

    if (room.hostSessionId !== sessionId) {
      socket.emit('reconnect-failed', { message: 'Неверная сессия' });
      return;
    }

    // Обновляем socketId ведущего
    room.hostId = socket.id;
    room.playerSocketMap.set(sessionId, socket.id);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.sessionId = sessionId;
    socket.isHost = true;

    console.log(`Ведущий переподключился к ${roomId}`);

    // Отправляем текущее состояние
    sendFullStateToHost(socket, room);
  });

  // --- Вход в комнату (игрок) ---
  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('error-msg', { message: 'Комната не найдена' });
      return;
    }

    // Проверяем, есть ли sessionId — может быть переподключение
    if (data.sessionId) {
      const existing = room.players.get(data.sessionId);
      if (existing) {
        // Переподключение!
        return handlePlayerReconnect(socket, room, data.sessionId, existing);
      }
    }

    // Новый игрок
    if (room.state !== 'lobby') {
      socket.emit('error-msg', { message: 'Игра уже началась. Если вы были в игре, обновите страницу — система попробует вас вернуть.' });
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

    sessions.set(sessionId, {
      roomId: data.roomId,
      playerName: data.name,
      isHost: false
    });

    socket.emit('joined-room', {
      roomId: data.roomId,
      playerName: data.name,
      sessionId: sessionId,
      avatarColor: room.players.get(sessionId).avatarColor,
      players: room.getPlayersArray()
    });

    io.to(data.roomId).emit('players-update', {
      players: room.getPlayersArray()
    });

    console.log(`${data.name} → комната ${data.roomId} (session: ${sessionId})`);
  });

  // --- Переподключение игрока ---
  socket.on('player-reconnect', (data) => {
    const { sessionId, roomId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('reconnect-failed', { message: 'Комната не найдена' });
      return;
    }

    const player = room.players.get(sessionId);
    if (!player) {
      socket.emit('reconnect-failed', { message: 'Игрок не найден в комнате' });
      return;
    }

    handlePlayerReconnect(socket, room, sessionId, player);
  });

  function handlePlayerReconnect(socket, room, sessionId, player) {
    // Обновляем socket
    room.playerSocketMap.set(sessionId, socket.id);
    player.connected = true;

    socket.join(room.id);
    socket.roomId = room.id;
    socket.sessionId = sessionId;
    socket.isHost = false;
    socket.playerName = player.name;

    console.log(`Игрок ${player.name} переподключился к ${room.id}`);

    // Отправляем текущее состояние
    socket.emit('reconnected', {
      roomId: room.id,
      sessionId: sessionId,
      playerName: player.name,
      avatarColor: player.avatarColor
    });

    sendFullStateToPlayer(socket, room, sessionId);

    // Уведомляем остальных
    io.to(room.id).emit('players-update', {
      players: room.getPlayersArray()
    });

    io.to(room.id).emit('player-reconnected', {
      playerName: player.name
    });
  }

  // --- Отправка полного состояния ведущему ---
  function sendFullStateToHost(socket, room) {
    socket.emit('reconnected-host', {
      roomId: room.id,
      sessionId: room.hostSessionId,
      state: room.state,
      players: room.getPlayersArray()
    });

    if (room.state === 'lobby') {
      socket.emit('players-update', {
        players: room.getPlayersArray()
      });
    } else if (room.state === 'playing') {
      socket.emit('show-board', {
        round: room.getRoundData(),
        roundIndex: room.currentRound,
        players: room.getPlayersArray(),
        choosingPlayer: room.selectedByPlayer,
        choosingPlayerName:
          room.players.get(room.selectedByPlayer)?.name
      });
    } else if (room.state === 'question' || room.state === 'answering') {
      if (room.currentQuestion) {
        const q = room.currentQuestion;
        const categoryName =
          room.rounds[room.currentRound].categories[q.catIndex].name;
        socket.emit('question-show', {
          category: categoryName,
          value: q.value,
          text: q.text,
          catIndex: q.catIndex,
          qIndex: q.qIndex
        });
        socket.emit('host-answer', { answer: q.answer });

        if (room.state === 'answering' && room.currentAnsweringPlayer) {
          const ansPlayer = room.players.get(room.currentAnsweringPlayer);
          socket.emit('player-answering', {
            playerId: room.currentAnsweringPlayer,
            playerName: ansPlayer?.name
          });
        }
      }
    } else if (room.state === 'finished') {
      const playersArr = room.getPlayersArray()
        .sort((a, b) => b.score - a.score);
      socket.emit('game-over', {
        players: playersArr,
        winner: playersArr[0]
      });
    }
  }

  // --- Отправка полного состояния игроку ---
  function sendFullStateToPlayer(socket, room, sessionId) {
    if (room.state === 'lobby') {
      socket.emit('players-update', {
        players: room.getPlayersArray()
      });
    } else if (room.state === 'playing') {
      socket.emit('game-started', {
        round: room.getRoundData(),
        roundIndex: room.currentRound,
        players: room.getPlayersArray(),
        choosingPlayer: room.selectedByPlayer,
        choosingPlayerName:
          room.players.get(room.selectedByPlayer)?.name
      });
    } else if (room.state === 'question' || room.state === 'answering') {
      if (room.currentQuestion) {
        const q = room.currentQuestion;
        const categoryName =
          room.rounds[room.currentRound].categories[q.catIndex].name;
        socket.emit('question-show', {
          category: categoryName,
          value: q.value,
          text: q.text,
          catIndex: q.catIndex,
          qIndex: q.qIndex
        });

        if (room.state === 'question' && !room.buzzerLocked) {
          if (!room.wrongAnswers.has(sessionId)) {
            socket.emit('buzzer-unlocked');
          }
        }

        if (room.state === 'answering' && room.currentAnsweringPlayer) {
          const ansPlayer = room.players.get(room.currentAnsweringPlayer);
          socket.emit('player-answering', {
            playerId: room.currentAnsweringPlayer,
            playerName: ansPlayer?.name
          });
        }
      }
    } else if (room.state === 'cat-select') {
      if (room.currentQuestion) {
        socket.emit('cat-in-bag', {
          catTheme: room.currentQuestion.catTheme,
          value: room.currentQuestion.value,
          choosingPlayer: room.selectedByPlayer,
          choosingPlayerName:
            room.players.get(room.selectedByPlayer)?.name,
          players: room.getPlayersArray()
        });
      }
    } else if (room.state === 'auction') {
      const q = room.currentQuestion;
      const categoryName =
        room.rounds[room.currentRound].categories[q.catIndex].name;
      socket.emit('auction-start', {
        category: categoryName,
        value: q.value,
        players: room.getPlayersArray()
      });
    } else if (room.state === 'final-betting') {
      socket.emit('final-round', {
        theme: room.finalTheme,
        players: room.getPlayersArray(),
        eligiblePlayers: getEligibleFinalPlayers(room)
      });
    } else if (room.state === 'final-answering') {
      socket.emit('final-question', {
        theme: room.finalTheme,
        text: questionsData.finalRound.text,
        timeLimit: 30
      });
    } else if (room.state === 'finished') {
      const playersArr = room.getPlayersArray()
        .sort((a, b) => b.score - a.score);
      socket.emit('game-over', {
        players: playersArr,
        winner: playersArr[0]
      });
    }
  }

  // --- Получить sessionId из socket ---
  function getSessionId(socket) {
    return socket.sessionId;
  }

  function getRoom(socket) {
    return rooms.get(socket.roomId);
  }

  // --- Начало игры ---
  socket.on('start-game', () => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    if (room.players.size < 1) {
      socket.emit('error-msg', { message: 'Нужен хотя бы 1 игрок' });
      return;
    }

    room.state = 'playing';
    room.currentRound = 0;

    const sessionIds = Array.from(room.players.keys());
    room.selectedByPlayer =
      sessionIds[Math.floor(Math.random() * sessionIds.length)];

    io.to(socket.roomId).emit('game-started', {
      round: room.getRoundData(),
      roundIndex: room.currentRound,
      players: room.getPlayersArray(),
      choosingPlayer: room.selectedByPlayer,
      choosingPlayerName:
        room.players.get(room.selectedByPlayer)?.name
    });
  });

  // --- Выбор вопроса ---
  socket.on('select-question', (data) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing') return;

    const sessId = getSessionId(socket);
    if (sessId !== room.selectedByPlayer && !socket.isHost) return;

    const { catIndex, qIndex } = data;
    const question = room.getQuestion(catIndex, qIndex);
    if (!question || question.answered) return;

    room.currentQuestion = { catIndex, qIndex, ...question };
    room.wrongAnswers = new Set();
    room.currentAnsweringPlayer = null;
    room.catInBagTarget = null;

    const categoryName =
      room.rounds[room.currentRound].categories[catIndex].name;

    if (question.type === 'cat') {
      room.state = 'cat-select';
      io.to(socket.roomId).emit('cat-in-bag', {
        catTheme: question.catTheme,
        value: question.value,
        choosingPlayer: room.selectedByPlayer,
        choosingPlayerName:
          room.players.get(room.selectedByPlayer)?.name,
        players: room.getPlayersArray()
      });
      return;
    }

    if (question.type === 'auction') {
      room.state = 'auction';
      room.auctionBets = new Map();
      room.auctionPhase = true;
      io.to(socket.roomId).emit('auction-start', {
        category: categoryName,
        value: question.value,
        players: room.getPlayersArray()
      });
      return;
    }

    room.state = 'question';
    room.buzzerLocked = true;

    io.to(socket.roomId).emit('question-show', {
      category: categoryName,
      value: question.value,
      text: question.text,
      catIndex, qIndex
    });

    io.to(room.getHostSocketId()).emit('host-answer', {
      answer: question.answer
    });

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
    const room = getRoom(socket);
    if (!room || room.state !== 'cat-select') return;

    const sessId = getSessionId(socket);
    if (sessId !== room.selectedByPlayer && !socket.isHost) return;

    // data.playerId тут это sessionId
    const targetSessionId = data.playerId;
    if (!room.players.has(targetSessionId)) return;

    room.catInBagTarget = targetSessionId;
    room.state = 'question';
    room.buzzerLocked = true;

    const question = room.currentQuestion;
    const categoryName =
      room.rounds[room.currentRound].categories[question.catIndex].name;

    io.to(socket.roomId).emit('question-show', {
      category: question.catTheme || categoryName,
      value: question.value,
      text: question.text,
      catIndex: question.catIndex,
      qIndex: question.qIndex,
      catInBag: true,
      targetPlayer: targetSessionId,
      targetPlayerName: room.players.get(targetSessionId)?.name
    });

    io.to(room.getHostSocketId()).emit('host-answer', {
      answer: question.answer
    });

    setTimeout(() => {
      if (room.state === 'question') {
        room.currentAnsweringPlayer = targetSessionId;
        room.state = 'answering';
        io.to(socket.roomId).emit('player-answering', {
          playerId: targetSessionId,
          playerName: room.players.get(targetSessionId)?.name
        });
        room.timer = setTimeout(() => {
          if (room.state === 'answering') {
            io.to(room.id).emit('answer-timeout');
          }
        }, 20000);
      }
    }, 3000);
  });

  // --- Аукцион ---
  socket.on('auction-bet', (data) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'auction') return;

    const sessId = getSessionId(socket);
    if (!room.players.has(sessId)) return;

    const player = room.players.get(sessId);

    if (data.allIn) {
      room.auctionBets.set(sessId, {
        bet: 'all-in',
        value: Math.max(player.score, room.currentQuestion.value)
      });
    } else if (data.pass) {
      room.auctionBets.set(sessId, { bet: 'pass', value: 0 });
    } else {
      const bet = parseInt(data.bet);
      room.auctionBets.set(sessId, { bet, value: bet });
    }

    io.to(socket.roomId).emit('auction-bet-placed', {
      playerId: sessId,
      playerName: player.name,
      betCount: room.auctionBets.size,
      totalPlayers: room.players.size
    });

    if (room.auctionBets.size >= room.players.size) {
      finishAuction(room);
    }
  });

  socket.on('finish-auction', () => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    if (room.state !== 'auction') return;
    finishAuction(room);
  });

  // --- Buzzer ---
  socket.on('buzzer', () => {
    const room = getRoom(socket);
    if (!room || room.state !== 'question') return;
    if (room.buzzerLocked) return;

    const sessId = getSessionId(socket);
    if (!room.players.has(sessId)) return;
    if (room.wrongAnswers.has(sessId)) return;

    room.buzzerLocked = true;
    room.currentAnsweringPlayer = sessId;
    room.state = 'answering';

    clearTimeout(room.questionTimer);

    const player = room.players.get(sessId);
    io.to(socket.roomId).emit('player-answering', {
      playerId: sessId,
      playerName: player.name
    });

    room.timer = setTimeout(() => {
      if (room.state === 'answering' &&
          room.currentAnsweringPlayer === sessId) {
        io.to(room.id).emit('answer-timeout');
      }
    }, 20000);
  });

  // --- Текстовый ответ ---
  socket.on('text-answer', (data) => {
    const room = getRoom(socket);
    if (!room) return;

    const sessId = getSessionId(socket);
    if (room.currentAnsweringPlayer !== sessId) return;

    const answer = (data.answer || '').substring(0, 200);
    const player = room.players.get(sessId);

    io.to(room.getHostSocketId()).emit('player-text-answer', {
      playerId: sessId,
      playerName: player.name,
      answer: answer
    });
  });

  // --- Оценка ответа ---
  socket.on('judge-answer', (data) => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    if (!room.currentAnsweringPlayer) return;

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
        correct: true,
        playerId: sessId,
        playerName: player.name,
        value,
        answer: question.answer,
        players: room.getPlayersArray()
      });

      room.state = 'playing';
      room.currentQuestion = null;
      room.currentAnsweringPlayer = null;

      setTimeout(() => checkRoundEnd(room), 2000);

    } else {
      player.score -= value;
      room.wrongAnswers.add(sessId);

      io.to(socket.roomId).emit('answer-result', {
        correct: false,
        playerId: sessId,
        playerName: player.name,
        value: -value,
        players: room.getPlayersArray()
      });

      room.currentAnsweringPlayer = null;

      if (room.catInBagTarget) {
        endQuestion(room);
        return;
      }

      const activePlayers = Array.from(room.players.keys())
        .filter(id => !room.wrongAnswers.has(id));

      if (activePlayers.length === 0) {
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
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    if (!room.currentQuestion) return;
    endQuestion(room);
  });

  // --- Следующий раунд ---
  socket.on('next-round', () => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    startNextRound(room);
  });

  // --- Финал ---
  socket.on('final-bet', (data) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'final-betting') return;

    const sessId = getSessionId(socket);
    if (!room.players.has(sessId)) return;

    const player = room.players.get(sessId);
    const bet = Math.min(
      Math.max(0, parseInt(data.bet) || 0),
      Math.max(player.score, 0)
    );
    room.finalBets.set(sessId, bet);
    socket.emit('final-bet-accepted', { bet });

    io.to(room.getHostSocketId()).emit('final-bet-update', {
      playerId: sessId,
      playerName: player.name,
      totalBets: room.finalBets.size,
      totalPlayers: getEligibleFinalPlayers(room).length
    });

    if (room.finalBets.size >= getEligibleFinalPlayers(room).length) {
      startFinalQuestion(room);
    }
  });

  socket.on('final-answer', (data) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'final-answering') return;

    const sessId = getSessionId(socket);
    if (!room.players.has(sessId)) return;

    room.finalAnswers.set(sessId, data.answer || '');

    const eligible = getEligibleFinalPlayers(room);
    io.to(room.getHostSocketId()).emit('final-answer-update', {
      answersCount: room.finalAnswers.size,
      totalPlayers: eligible.length
    });

    if (room.finalAnswers.size >= eligible.length) {
      showFinalResults(room);
    }
  });

  socket.on('judge-final', (data) => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;

    for (const result of data.results) {
      const player = room.players.get(result.playerId);
      if (!player) continue;
      const bet = room.finalBets.get(result.playerId) || 0;
      player.score += result.correct ? bet : -bet;
    }

    room.state = 'finished';
    const playersArr = room.getPlayersArray()
      .sort((a, b) => b.score - a.score);

    io.to(socket.roomId).emit('game-over', {
      players: playersArr,
      winner: playersArr[0]
    });
  });

  // --- Корректировка очков ---
  socket.on('adjust-score', (data) => {
    const room = getRoom(socket);
    if (!room || !socket.isHost) return;
    // data.playerId = sessionId
    const player = room.players.get(data.playerId);
    if (player) {
      player.score += data.amount;
      io.to(socket.roomId).emit('players-update', {
        players: room.getPlayersArray()
      });
    }
  });

  // --- Чат ---
  socket.on('chat-message', (data) => {
    const room = getRoom(socket);
    if (!room) return;

    const sessId = getSessionId(socket);
    const name = socket.isHost
      ? `🎤 ${room.hostName}`
      : (room.players.get(sessId)?.name || 'Аноним');

    io.to(socket.roomId).emit('chat-message', {
      name,
      message: data.message.substring(0, 200),
      timestamp: Date.now()
    });
  });

  // --- Отключение ---
  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;

    const sessId = getSessionId(socket);

    if (socket.isHost) {
      console.log(`Ведущий отключился от ${socket.roomId}`);
      io.to(socket.roomId).emit('host-disconnected');
      // НЕ удаляем комнату — даём время на reconnect
    } else {
      if (sessId && room.players.has(sessId)) {
        room.players.get(sessId).connected = false;
        console.log(`Игрок ${room.players.get(sessId).name} отключился от ${socket.roomId}`);
        io.to(socket.roomId).emit('player-disconnected', {
          playerName: room.players.get(sessId).name,
          players: room.getPlayersArray()
        });
      }
    }
  });
});

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function endQuestion(room) {
  clearTimeout(room.timer);
  clearTimeout(room.questionTimer);

  const question = room.currentQuestion;
  if (!question) return;

  room.markQuestionAnswered(question.catIndex, question.qIndex);

  io.to(room.id).emit('question-end', {
    answer: question.answer,
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
  let maxBet = 0;
  let winnerId = null;

  for (const [sessId, betData] of room.auctionBets) {
    if (betData.bet !== 'pass' && betData.value > maxBet) {
      maxBet = betData.value;
      winnerId = sessId;
    }
  }

  if (!winnerId) {
    winnerId = room.selectedByPlayer;
    maxBet = room.currentQuestion.value;
  }

  room.auctionPhase = false;
  room.state = 'question';
  room.currentQuestion.value = maxBet;

  const question = room.currentQuestion;
  const categoryName =
    room.rounds[room.currentRound].categories[question.catIndex].name;

  io.to(room.id).emit('auction-result', {
    winnerId,
    winnerName: room.players.get(winnerId)?.name,
    bet: maxBet
  });

  setTimeout(() => {
    io.to(room.id).emit('question-show', {
      category: categoryName,
      value: maxBet,
      text: question.text,
      catIndex: question.catIndex,
      qIndex: question.qIndex,
      auction: true
    });

    io.to(room.getHostSocketId()).emit('host-answer', {
      answer: question.answer
    });

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
            io.to(room.id).emit('answer-timeout');
          }
        }, 20000);
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
    } else {
      startFinalRound(room);
    }
  } else {
    io.to(room.id).emit('show-board', {
      round: room.getRoundData(),
      roundIndex: room.currentRound,
      players: room.getPlayersArray(),
      choosingPlayer: room.selectedByPlayer,
      choosingPlayerName:
        room.players.get(room.selectedByPlayer)?.name
    });
  }
}

function startNextRound(room) {
  room.currentRound++;
  if (room.currentRound >= room.rounds.length) {
    startFinalRound(room);
    return;
  }
  room.state = 'playing';

  io.to(room.id).emit('new-round', {
    round: room.getRoundData(),
    roundIndex: room.currentRound,
    players: room.getPlayersArray(),
    choosingPlayer: room.selectedByPlayer,
    choosingPlayerName:
      room.players.get(room.selectedByPlayer)?.name
  });
}

function startFinalRound(room) {
  const finalData = questionsData.finalRound;
  room.finalTheme = finalData.theme;
  room.state = 'final-betting';
  room.finalBets = new Map();
  room.finalAnswers = new Map();

  const eligible = getEligibleFinalPlayers(room);

  if (eligible.length === 0) {
    room.state = 'finished';
    const playersArr = room.getPlayersArray()
      .sort((a, b) => b.score - a.score);
    io.to(room.id).emit('game-over', {
      players: playersArr,
      winner: playersArr[0]
    });
    return;
  }

  io.to(room.id).emit('final-round', {
    theme: finalData.theme,
    players: room.getPlayersArray(),
    eligiblePlayers: eligible
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
  const finalData = questionsData.finalRound;

  io.to(room.id).emit('final-question', {
    theme: finalData.theme,
    text: finalData.text,
    timeLimit: 60
  });

  room.timer = setTimeout(() => {
    if (room.state === 'final-answering') {
      showFinalResults(room);
    }
  }, 65000);
}

function showFinalResults(room) {
  clearTimeout(room.timer);
  room.state = 'final-judging';

  const answers = [];
  for (const [sessId, answer] of room.finalAnswers) {
    answers.push({
      playerId: sessId,
      playerName: room.players.get(sessId)?.name,
      answer,
      bet: room.finalBets.get(sessId) || 0
    });
  }

  io.to(room.getHostSocketId()).emit('final-judge', {
    answers,
    correctAnswer: questionsData.finalRound.answer
  });

  // Уведомляем игроков
  for (const [sessId] of room.players) {
    const sockId = room.getSocketId(sessId);
    if (sockId) {
      io.to(sockId).emit('final-waiting', {
        message: 'Ведущий проверяет ответы...'
      });
    }
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
  console.log(`========================================`);
  console.log(`  ⭐ СВОЯ ИГРА — сервер запущен`);
  console.log(`  📡 Порт: ${PORT}`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`========================================`);
});
