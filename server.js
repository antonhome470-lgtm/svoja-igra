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
  // Важно для бесплатных хостингов — пинг чтобы не засыпал
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Загрузка вопросов
const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

// Хранилище комнат
const rooms = new Map();

// ===== КЛАСС КОМНАТЫ =====
class GameRoom {
  constructor(id, hostId, hostName) {
    this.id = id;
    this.hostId = hostId;
    this.hostName = hostName;
    this.players = new Map();
    this.state = 'lobby';
    this.currentRound = 0;
    this.rounds = this.generateRounds();
    this.answeredQuestions = new Set();
    this.currentQuestion = null;
    this.buzzerQueue = [];
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
        categories.push({
          name: cat.name,
          questions: questions
        });
      }
      rounds.push({
        name: roundData.name,
        categories: categories
      });
    }
    return rounds;
  }

  addPlayer(socketId, name, avatarColor) {
    if (this.players.size >= 6) return false;
    if (this.state !== 'lobby') return false;
    this.players.set(socketId, {
      id: socketId,
      name: name,
      score: 0,
      avatarColor: avatarColor || this.getRandomColor(),
      connected: true
    });
    return true;
  }

  getRandomColor() {
    const colors = [
      '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
      '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  getPlayersArray() {
    return Array.from(this.players.values());
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
}

// ===== ГЕНЕРАЦИЯ КОДА КОМНАТЫ =====
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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

// Health check для хостинга
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log(`Подключение: ${socket.id}`);

  // --- Создание комнаты ---
  socket.on('create-room', (data) => {
    const roomId = generateRoomCode();
    const room = new GameRoom(roomId, socket.id, data.name);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = true;

    socket.emit('room-created', {
      roomId: roomId,
      hostName: data.name
    });
    console.log(`Комната ${roomId} создана: ${data.name}`);
  });

  // --- Вход в комнату ---
  socket.on('join-room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('error-msg', { message: 'Комната не найдена' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('error-msg', { message: 'Игра уже началась' });
      return;
    }
    if (room.players.size >= 6) {
      socket.emit('error-msg', { message: 'Комната полная (макс. 6)' });
      return;
    }

    const avatarColor = room.getRandomColor();
    room.players.set(socket.id, {
      id: socket.id,
      name: data.name,
      score: 0,
      avatarColor: avatarColor,
      connected: true
    });

    socket.join(data.roomId);
    socket.roomId = data.roomId;
    socket.isHost = false;
    socket.playerName = data.name;

    socket.emit('joined-room', {
      roomId: data.roomId,
      playerName: data.name,
      avatarColor: avatarColor,
      players: room.getPlayersArray()
    });

    io.to(data.roomId).emit('players-update', {
      players: room.getPlayersArray()
    });
    console.log(`${data.name} → комната ${data.roomId}`);
  });

  // --- Начало игры ---
  socket.on('start-game', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.size < 1) {
      socket.emit('error-msg', { message: 'Нужен хотя бы 1 игрок' });
      return;
    }

    room.state = 'playing';
    room.currentRound = 0;

    const playerIds = Array.from(room.players.keys());
    room.selectedByPlayer =
      playerIds[Math.floor(Math.random() * playerIds.length)];

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
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'playing') return;
    if (socket.id !== room.selectedByPlayer &&
        socket.id !== room.hostId) return;

    const { catIndex, qIndex } = data;
    const question = room.getQuestion(catIndex, qIndex);
    if (!question || question.answered) return;

    room.currentQuestion = { catIndex, qIndex, ...question };
    room.buzzerQueue = [];
    room.wrongAnswers = new Set();
    room.currentAnsweringPlayer = null;
    room.catInBagTarget = null;

    const categoryName =
      room.rounds[room.currentRound].categories[catIndex].name;

    // Кот в мешке
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

    // Аукцион
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

    // Обычный вопрос
    room.state = 'question';
    room.buzzerLocked = true;

    io.to(socket.roomId).emit('question-show', {
      category: categoryName,
      value: question.value,
      text: question.text,
      catIndex, qIndex
    });

    // Ведущему показываем ответ
    io.to(room.hostId).emit('host-answer', {
      answer: question.answer
    });

    setTimeout(() => {
      if (room.currentQuestion && room.state === 'question') {
        room.buzzerLocked = false;
        io.to(socket.roomId).emit('buzzer-unlocked');

        room.questionTimer = setTimeout(() => {
          if (room.state === 'question') {
            endQuestion(room);
          }
        }, 15000);
      }
    }, 3000);
  });

  // --- Кот в мешке: выбор игрока ---
  socket.on('cat-select-player', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'cat-select') return;
    if (socket.id !== room.selectedByPlayer &&
        socket.id !== room.hostId) return;

    const targetId = data.playerId;
    if (!room.players.has(targetId)) return;

    room.catInBagTarget = targetId;
    room.state = 'question';
    room.buzzerLocked = true;

    const question = room.currentQuestion;
    const categoryName =
      room.rounds[room.currentRound]
        .categories[question.catIndex].name;

    io.to(socket.roomId).emit('question-show', {
      category: question.catTheme || categoryName,
      value: question.value,
      text: question.text,
      catIndex: question.catIndex,
      qIndex: question.qIndex,
      catInBag: true,
      targetPlayer: targetId,
      targetPlayerName: room.players.get(targetId)?.name
    });

    io.to(room.hostId).emit('host-answer', {
      answer: question.answer
    });

    setTimeout(() => {
      if (room.state === 'question') {
        room.currentAnsweringPlayer = targetId;
        room.state = 'answering';
        io.to(socket.roomId).emit('player-answering', {
          playerId: targetId,
          playerName: room.players.get(targetId)?.name
        });
        room.timer = setTimeout(() => {
          if (room.state === 'answering') {
            io.to(room.id).emit('answer-timeout');
          }
        }, 20000);
      }
    }, 3000);
  });

  // --- Аукцион: ставка ---
  socket.on('auction-bet', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'auction') return;
    if (!room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);

    if (data.allIn) {
      room.auctionBets.set(socket.id, {
        bet: 'all-in',
        value: Math.max(player.score, room.currentQuestion.value)
      });
    } else if (data.pass) {
      room.auctionBets.set(socket.id, { bet: 'pass', value: 0 });
    } else {
      const bet = parseInt(data.bet);
      room.auctionBets.set(socket.id, { bet, value: bet });
    }

    io.to(socket.roomId).emit('auction-bet-placed', {
      playerId: socket.id,
      playerName: player.name,
      betCount: room.auctionBets.size,
      totalPlayers: room.players.size
    });

    if (room.auctionBets.size >= room.players.size) {
      finishAuction(room);
    }
  });

  socket.on('finish-auction', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (room.state !== 'auction') return;
    finishAuction(room);
  });

  // --- Buzzer ---
  socket.on('buzzer', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'question') return;
    if (room.buzzerLocked) return;
    if (!room.players.has(socket.id)) return;
    if (room.wrongAnswers.has(socket.id)) return;

    room.buzzerLocked = true;
    room.currentAnsweringPlayer = socket.id;
    room.state = 'answering';

    clearTimeout(room.questionTimer);

    const player = room.players.get(socket.id);
    io.to(socket.roomId).emit('player-answering', {
      playerId: socket.id,
      playerName: player.name
    });

    room.timer = setTimeout(() => {
      if (room.state === 'answering' &&
          room.currentAnsweringPlayer === socket.id) {
        io.to(room.id).emit('answer-timeout');
      }
    }, 20000);
  });
  // --- Текстовый ответ игрока ---
  socket.on('text-answer', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.currentAnsweringPlayer !== socket.id) return;

    const answer = (data.answer || '').substring(0, 200);
    const player = room.players.get(socket.id);

    // Отправляем ведущему ответ игрока для оценки
    io.to(room.hostId).emit('player-text-answer', {
      playerId: socket.id,
      playerName: player.name,
      answer: answer
    });
  });
  
  // --- Оценка ответа ---
  socket.on('judge-answer', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (!room.currentAnsweringPlayer) return;

    clearTimeout(room.timer);

    const playerId = room.currentAnsweringPlayer;
    const player = room.players.get(playerId);
    const question = room.currentQuestion;
    const value = question.value;

    if (data.correct) {
      player.score += value;
      room.lastCorrectPlayer = playerId;
      room.selectedByPlayer = playerId;
      room.markQuestionAnswered(question.catIndex, question.qIndex);

      io.to(socket.roomId).emit('answer-result', {
        correct: true,
        playerId,
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
      room.wrongAnswers.add(playerId);

      io.to(socket.roomId).emit('answer-result', {
        correct: false,
        playerId,
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

  // --- Пропуск вопроса ---
  socket.on('skip-question', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
    if (!room.currentQuestion) return;
    endQuestion(room);
  });

  // --- Следующий раунд ---
  socket.on('next-round', () => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
    startNextRound(room);
  });

  // --- Финал: ставка ---
  socket.on('final-bet', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'final-betting') return;
    if (!room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    const bet = Math.min(
      Math.max(0, parseInt(data.bet) || 0),
      Math.max(player.score, 0)
    );
    room.finalBets.set(socket.id, bet);
    socket.emit('final-bet-accepted', { bet });

    io.to(room.hostId).emit('final-bet-update', {
      playerId: socket.id,
      playerName: player.name,
      totalBets: room.finalBets.size,
      totalPlayers: getEligibleFinalPlayers(room).length
    });

    if (room.finalBets.size >= getEligibleFinalPlayers(room).length) {
      startFinalQuestion(room);
    }
  });

  // --- Финал: ответ ---
  socket.on('final-answer', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== 'final-answering') return;
    if (!room.players.has(socket.id)) return;

    room.finalAnswers.set(socket.id, data.answer || '');

    const eligible = getEligibleFinalPlayers(room);
    io.to(room.hostId).emit('final-answer-update', {
      answersCount: room.finalAnswers.size,
      totalPlayers: eligible.length
    });

    if (room.finalAnswers.size >= eligible.length) {
      showFinalResults(room);
    }
  });

  // --- Финал: оценка ---
  socket.on('judge-final', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;

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
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.hostId) return;
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
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const name = socket.isHost
      ? `🎤 ${room.hostName}`
      : (room.players.get(socket.id)?.name || 'Аноним');

    io.to(socket.roomId).emit('chat-message', {
      name,
      message: data.message.substring(0, 200),
      timestamp: Date.now()
    });
  });

  // --- Отключение ---
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;

    if (socket.isHost) {
      io.to(socket.roomId).emit('host-disconnected');
      setTimeout(() => {
        const r = rooms.get(socket.roomId);
        if (r && r.hostId === socket.id) {
          rooms.delete(socket.roomId);
        }
      }, 120000);
    } else {
      if (room.players.has(socket.id)) {
        room.players.get(socket.id).connected = false;
        io.to(socket.roomId).emit('player-disconnected', {
          playerId: socket.id,
          playerName: room.players.get(socket.id).name,
          players: room.getPlayersArray()
        });
      }
    }
    console.log(`Отключение: ${socket.id}`);
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

  for (const [playerId, betData] of room.auctionBets) {
    if (betData.bet !== 'pass' && betData.value > maxBet) {
      maxBet = betData.value;
      winnerId = playerId;
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
    room.rounds[room.currentRound]
      .categories[question.catIndex].name;

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

    io.to(room.hostId).emit('host-answer', {
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
  for (const [playerId, answer] of room.finalAnswers) {
    answers.push({
      playerId,
      playerName: room.players.get(playerId)?.name,
      answer,
      bet: room.finalBets.get(playerId) || 0
    });
  }

  io.to(room.hostId).emit('final-judge', {
    answers,
    correctAnswer: questionsData.finalRound.answer
  });

  for (const pid of room.players.keys()) {
    if (pid !== room.hostId) {
      io.to(pid).emit('final-waiting', {
        message: 'Ведущий проверяет ответы...'
      });
    }
  }
}

// Очистка старых комнат
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) {
      rooms.delete(id);
      console.log(`Комната ${id} удалена (устарела)`);
    }
  }
}, 30 * 60 * 1000);

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`  ⭐ СВОЯ ИГРА — сервер запущен`);
  console.log(`  📡 Порт: ${PORT}`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`========================================`);
});
