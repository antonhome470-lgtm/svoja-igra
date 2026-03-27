const socket = io({
  reconnection: true,
  reconnectionAttempts: 50,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

let roomId = null;
let myName = '';
let myId = null; // это sessionId
let players = [];
let choosingPlayer = null;
let amChoosing = false;
let gameState = 'lobby';
let finalTimerInterval = null;
let answerTimerInterval = null;
let sessionId = null;
let isAutoHost = false;

// ===== ИНИЦИАЛИЗАЦИЯ =====
(function init() {
  const params = new URLSearchParams(window.location.search);
  roomId = params.get('room');
  myName = decodeURIComponent(params.get('name') || '');

  if (!roomId || !myName) {
    window.location.href = '/';
    return;
  }

  document.getElementById('room-code').textContent = roomId;
  document.getElementById('my-name').textContent = myName;

  // Проверяем, есть ли сохранённая сессия
  sessionId = localStorage.getItem(`session_${roomId}`);

  if (sessionId) {
    // Пытаемся переподключиться
    console.log('Пробуем переподключение, sessionId:', sessionId);
    socket.emit('player-reconnect', { sessionId, roomId });
  } else {
    // Новый вход
    socket.emit('join-room', { roomId, name: myName });
  }
})();

// ===== ПРИСОЕДИНЕНИЕ =====
socket.on('joined-room', (data) => {
  sessionId = data.sessionId;
  myId = data.sessionId;
  players = data.players;
  isAutoHost = data.autoHost || false;

  localStorage.setItem(`session_${roomId}`, sessionId);
  localStorage.setItem(`name_${roomId}`, myName);

  renderLobbyPlayers();
  showNotification('Вы присоединились к игре!', 'success');

  if (isAutoHost) {
    showNotification('🤖 Бот-ведущий. Игра начнётся автоматически!', 'info', 5000);
  }
});
// ===== ПЕРЕПОДКЛЮЧЕНИЕ =====
socket.on('reconnected', (data) => {
  sessionId = data.sessionId;
  myId = data.sessionId;
  myName = data.playerName;
  isAutoHost = data.autoHost || false;

  localStorage.setItem(`session_${roomId}`, sessionId);
  document.getElementById('my-name').textContent = myName;
  showNotification('🔄 Вы вернулись в игру!', 'success', 3000);
});

socket.on('reconnect-failed', (data) => {
  console.log('Переподключение не удалось:', data.message);
  // Очищаем старую сессию и входим заново
  localStorage.removeItem(`session_${roomId}`);
  sessionId = null;
  socket.emit('join-room', { roomId, name: myName });
});

socket.on('player-reconnected', (data) => {
  showNotification(`🔄 ${data.playerName} вернулся в игру`, 'info', 2000);
});

// Авто-переподключение при потере связи
socket.on('connect', () => {
  console.log('Socket подключён:', socket.id);
  if (sessionId && roomId) {
    console.log('Авто-переподключение...');
    socket.emit('player-reconnect', { sessionId, roomId });
  }
});

socket.on('disconnect', (reason) => {
  console.log('Отключение:', reason);
  showNotification('⚠️ Соединение потеряно. Переподключение...', 'error', 5000);
});

socket.on('reconnect_attempt', (attemptNumber) => {
  showNotification(`🔄 Переподключение... (${attemptNumber})`, 'info', 2000);
});

socket.on('players-update', (data) => {
  players = data.players;
  renderLobbyPlayers();
  renderPlayersBar();
});

function renderLobbyPlayers() {
  const container = document.getElementById('lobby-players');
  if (!container) return;
  container.innerHTML = '';

  players.forEach(p => {
    const isMe = p.id === myId || p.sessionId === myId;
    const card = document.createElement('div');
    card.className = `player-card ${isMe ? 'choosing' : ''} ${p.connected ? '' : 'disconnected'}`;
    card.style.borderColor = isMe ? 'var(--secondary)' : '';
    card.innerHTML = `
      <div class="player-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-name">${escapeHtml(p.name)} ${isMe ? '(Вы)' : ''}</div>
      <div class="player-score">${p.score}</div>
      ${!p.connected ? '<div style="color: var(--danger); font-size: 12px;">Отключён</div>' : ''}
    `;
    container.appendChild(card);
  });
}

// ===== НАЧАЛО ИГРЫ =====
socket.on('game-started', (data) => {
  gameState = 'playing';
  players = data.players;
  choosingPlayer = data.choosingPlayer;
  amChoosing = (choosingPlayer === myId);
  isAutoHost = data.autoHost || isAutoHost;

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);

  if (amChoosing) {
    showNotification('🎯 Ваша очередь выбирать вопрос!', 'info', 3000);
  }
});

// ===== ДОСКА =====
function renderBoard(round, roundIndex) {
  document.getElementById('round-title').textContent = round.name;

  const table = document.getElementById('board-table');
  table.innerHTML = '';

  const headerRow = document.createElement('tr');
  round.categories.forEach(cat => {
    const th = document.createElement('th');
    th.textContent = cat.name;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  const numQuestions = round.categories[0].questions.length;
  for (let qi = 0; qi < numQuestions; qi++) {
    const row = document.createElement('tr');
    round.categories.forEach((cat, ci) => {
      const td = document.createElement('td');
      const q = cat.questions[qi];
      td.className = `board-cell ${q.answered ? 'answered' : ''}`;
      td.textContent = q.answered ? '' : q.value;

      if (!q.answered && amChoosing) {
        td.onclick = () => selectQuestion(ci, qi);
        td.style.cursor = 'pointer';
      }

      row.appendChild(td);
    });
    table.appendChild(row);
  }
}

function selectQuestion(catIndex, qIndex) {
  if (!amChoosing) {
    showNotification('Сейчас не ваша очередь!', 'error');
    return;
  }
  socket.emit('select-question', { catIndex, qIndex });
}

function updateChoosingInfo(name) {
  const info = document.getElementById('choosing-info');
  if (info) {
    if (choosingPlayer === myId) {
      info.innerHTML = `<span class="player-name-highlight">⭐ Ваша очередь выбирать!</span>`;
    } else {
      info.innerHTML = `Выбирает: <span class="player-name-highlight">${escapeHtml(name || '...')}</span>`;
    }
  }
}

// ===== ВОПРОС =====
socket.on('question-show', (data) => {
  gameState = 'question';

  hideAllScreens();
  const screen = document.getElementById('question-screen');
  screen.classList.remove('hidden');

  document.getElementById('q-category').textContent = data.category;
  document.getElementById('q-value').textContent = data.value;
  document.getElementById('q-text').textContent = data.text;
  document.getElementById('q-answer-area').classList.add('hidden');
  document.getElementById('answering-info').classList.add('hidden');

  const buzzerArea = document.getElementById('buzzer-area');
  const buzzerBtn = document.getElementById('buzzer-btn');
  const buzzerStatus = document.getElementById('buzzer-status');
  const answerInputArea = document.getElementById('answer-input-area');

  answerInputArea.classList.add('hidden');
  clearAnswerTimer();

  if (data.catInBag && data.targetPlayer === myId) {
    buzzerArea.classList.remove('hidden');
    buzzerBtn.classList.add('hidden');
    buzzerStatus.textContent = '🐱 Кот в мешке — вы отвечаете!';
  } else if (data.auction) {
    buzzerArea.classList.remove('hidden');
    buzzerBtn.classList.add('hidden');
    buzzerStatus.textContent = '💰 Аукцион — ожидание...';
  } else {
    buzzerArea.classList.remove('hidden');
    buzzerBtn.classList.remove('hidden');
    buzzerBtn.disabled = true;
    buzzerBtn.classList.remove('active');
    buzzerStatus.textContent = 'Ожидание...';
  }
});

socket.on('buzzer-unlocked', () => {
  const buzzerBtn = document.getElementById('buzzer-btn');
  const buzzerStatus = document.getElementById('buzzer-status');

  buzzerBtn.classList.remove('hidden');
  buzzerBtn.disabled = false;
  buzzerBtn.classList.add('active');
  buzzerStatus.textContent = '🔔 Жмите кнопку, чтобы ответить!';

  if (navigator.vibrate) navigator.vibrate(100);
});

function pressBuzzer() {
  socket.emit('buzzer');
  const buzzerBtn = document.getElementById('buzzer-btn');
  buzzerBtn.disabled = true;
  buzzerBtn.classList.remove('active');
  document.getElementById('buzzer-status').textContent = '⏳ Ожидание...';

  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && gameState === 'question') {
    const buzzerBtn = document.getElementById('buzzer-btn');
    if (buzzerBtn && !buzzerBtn.disabled && !buzzerBtn.classList.contains('hidden')) {
      e.preventDefault();
      pressBuzzer();
    }
  }
});

// ===== ОТВЕТ =====
socket.on('player-answering', (data) => {
  document.getElementById('answering-info').classList.remove('hidden');

  const buzzerBtn = document.getElementById('buzzer-btn');
  buzzerBtn.disabled = true;
  buzzerBtn.classList.remove('active');

  const isMe = data.playerId === myId;

  if (isMe) {
    document.getElementById('answering-player-name').textContent = 'ВЫ';
    document.getElementById('buzzer-status').textContent = '🎤 Введите ваш ответ!';
    buzzerBtn.classList.add('hidden');

    const answerInputArea = document.getElementById('answer-input-area');
    answerInputArea.classList.remove('hidden');

    const input = document.getElementById('answer-text-input');
    input.value = '';
    input.disabled = false;
    input.focus();

    document.getElementById('send-answer-btn').disabled = false;
    startAnswerTimer(20);
  } else {
    document.getElementById('answering-player-name').textContent = data.playerName;
    document.getElementById('buzzer-status').textContent = `${data.playerName} пишет ответ...`;
    document.getElementById('answer-input-area').classList.add('hidden');
  }

  highlightPlayer(data.playerId, 'answering');
});

function sendTextAnswer() {
  const input = document.getElementById('answer-text-input');
  const answer = input.value.trim();

  if (!answer) {
    showNotification('Введите ответ!', 'error');
    input.focus();
    return;
  }

  socket.emit('text-answer', { answer });

  input.disabled = true;
  document.getElementById('send-answer-btn').disabled = true;
  document.getElementById('buzzer-status').textContent = '📩 Ответ отправлен! Ожидание...';

  clearAnswerTimer();
  if (navigator.vibrate) navigator.vibrate(100);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const answerInput = document.getElementById('answer-text-input');
    const answerArea = document.getElementById('answer-input-area');
    if (answerArea && !answerArea.classList.contains('hidden') && !answerInput.disabled) {
      e.preventDefault();
      sendTextAnswer();
    }
  }
});

function startAnswerTimer(seconds) {
  clearAnswerTimer();
  let timeLeft = seconds;
  const timerEl = document.getElementById('answer-timer');
  timerEl.textContent = timeLeft;
  timerEl.classList.remove('warning');

  answerTimerInterval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = timeLeft;
    if (timeLeft <= 5) timerEl.classList.add('warning');
    if (timeLeft <= 0) {
      clearAnswerTimer();
      const input = document.getElementById('answer-text-input');
      if (!input.disabled) sendTextAnswer();
    }
  }, 1000);
}

function clearAnswerTimer() {
  if (answerTimerInterval) {
    clearInterval(answerTimerInterval);
    answerTimerInterval = null;
  }
  const timerEl = document.getElementById('answer-timer');
  if (timerEl) {
    timerEl.textContent = '';
    timerEl.classList.remove('warning');
  }
}

// ===== РЕЗУЛЬТАТЫ =====
socket.on('answer-result', (data) => {
  players = data.players;
  renderPlayersBar();
  clearAnswerTimer();
  document.getElementById('answer-input-area').classList.add('hidden');

  if (data.correct) {
    showNotification(`✅ ${data.playerName} +${data.value}!`, 'success');
    highlightPlayer(data.playerId, 'correct');
    if (data.playerId === myId && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } else {
    showNotification(`❌ ${data.playerName} ${data.value}`, 'error');
    highlightPlayer(data.playerId, 'wrong');
  }

  if (data.correct && data.answer) {
    setTimeout(() => {
      document.getElementById('q-answer-area').classList.remove('hidden');
      document.getElementById('q-answer').textContent = data.answer;
    }, 500);
  }
});

socket.on('answer-timeout', () => {
  showNotification('⏰ Время вышло!', 'warning');
  clearAnswerTimer();
  document.getElementById('answer-input-area').classList.add('hidden');
});

socket.on('question-end', (data) => {
  players = data.players;
  renderPlayersBar();
  clearAnswerTimer();

  document.getElementById('q-answer-area').classList.remove('hidden');
  document.getElementById('q-answer').textContent = data.answer;

  const buzzerBtn = document.getElementById('buzzer-btn');
  buzzerBtn.disabled = true;
  buzzerBtn.classList.remove('active');
  document.getElementById('buzzer-status').textContent = 'Вопрос завершён';
  document.getElementById('answer-input-area').classList.add('hidden');
});

// ===== ДОСКА ОБНОВЛЕНИЕ =====
socket.on('show-board', (data) => {
  gameState = 'playing';
  players = data.players;
  choosingPlayer = data.choosingPlayer;
  amChoosing = (choosingPlayer === myId);

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);

  if (amChoosing) {
    showNotification('🎯 Ваша очередь выбирать вопрос!', 'info', 3000);
    if (navigator.vibrate) navigator.vibrate(200);
  }
});

// ===== КОТ В МЕШКЕ =====
socket.on('cat-in-bag', (data) => {
  hideAllScreens();
  const screen = document.getElementById('cat-screen');
  screen.classList.remove('hidden');

  document.getElementById('cat-theme').textContent = `Тема: ${data.catTheme}`;
  document.getElementById('cat-value').textContent = `Стоимость: ${data.value}`;

  const selectArea = document.getElementById('cat-select-area');

  console.log('Кот в мешке. myId:', myId, 'choosingPlayer:', data.choosingPlayer);

  if (data.choosingPlayer === myId) {
    // Я выбираю, кому отдать
    let html = '<div style="margin-top: 20px; font-size: 18px;">Выберите игрока:</div>';
    html += '<div class="player-select-grid">';

    let count = 0;
    data.players.forEach(p => {
      const playerId = p.id || p.sessionId;
      if (playerId === myId) return; // нельзя себе
      html += `
        <div class="player-select-btn" onclick="selectCatPlayer('${playerId}')">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="score">${p.score}</div>
        </div>
      `;
      count++;
    });

    // Если один игрок — можно себе
    if (count === 0) {
      data.players.forEach(p => {
        const playerId = p.id || p.sessionId;
        html += `
          <div class="player-select-btn" onclick="selectCatPlayer('${playerId}')">
            <div class="name">${escapeHtml(p.name)}</div>
            <div class="score">${p.score}</div>
          </div>
        `;
      });
    }

    html += '</div>';
    selectArea.innerHTML = html;
  } else {
    selectArea.innerHTML = `
      <div style="margin-top: 20px; font-size: 18px; color: var(--text-secondary);">
        ${escapeHtml(data.choosingPlayerName)} выбирает, кому отдать кота...
      </div>
    `;
  }
});

// ===== АУКЦИОН =====
socket.on('auction-start', (data) => {
  hideAllScreens();
  const screen = document.getElementById('auction-screen');
  screen.classList.remove('hidden');

  document.getElementById('auction-info').textContent = `Минимальная ставка: ${data.value}`;
  document.getElementById('auction-controls').classList.remove('hidden');
  document.getElementById('auction-waiting').classList.add('hidden');

  const myPlayer = data.players.find(p => p.id === myId);
  const input = document.getElementById('auction-bet-input');
  input.min = data.value;
  input.max = Math.max(myPlayer?.score || 0, data.value);
  input.value = data.value;
});

function placeBet() {
  const bet = parseInt(document.getElementById('auction-bet-input').value);
  if (isNaN(bet) || bet < 0) {
    showNotification('Введите корректную ставку!', 'error');
    return;
  }
  socket.emit('auction-bet', { bet });
  document.getElementById('auction-controls').classList.add('hidden');
  document.getElementById('auction-waiting').classList.remove('hidden');
}

function allIn() {
  socket.emit('auction-bet', { allIn: true });
  document.getElementById('auction-controls').classList.add('hidden');
  document.getElementById('auction-waiting').classList.remove('hidden');
}

function passBet() {
  socket.emit('auction-bet', { pass: true });
  document.getElementById('auction-controls').classList.add('hidden');
  document.getElementById('auction-waiting').classList.remove('hidden');
}

socket.on('auction-result', (data) => {
  showNotification(
    data.winnerId === myId
      ? `💰 Вы выиграли аукцион: ${data.bet}`
      : `💰 ${data.winnerName}: ${data.bet}`,
    'info', 3000
  );
});

socket.on('auction-bet-placed', () => {});

// ===== РАУНДЫ =====
socket.on('round-complete', (data) => {
  players = data.players;
  showNotification('🏁 Раунд завершён!', 'info', 3000);
});

socket.on('new-round', (data) => {
  gameState = 'playing';
  players = data.players;
  choosingPlayer = data.choosingPlayer;
  amChoosing = (choosingPlayer === myId);

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);

  showNotification(`🎯 ${data.round.name}`, 'info', 3000);
  if (amChoosing) showNotification('Ваша очередь!', 'info', 3000);
});

// ===== ФИНАЛ =====
socket.on('final-round', (data) => {
  hideAllScreens();
  document.getElementById('final-screen').classList.remove('hidden');
  document.getElementById('final-theme').textContent = `Тема: ${data.theme}`;

  players = data.players;
  renderPlayersBar();

  const isEligible = data.eligiblePlayers.includes(myId);

  if (isEligible) {
    document.getElementById('final-bet-area').classList.remove('hidden');
    document.getElementById('final-question-area').classList.add('hidden');
    document.getElementById('final-waiting-area').classList.add('hidden');

    const myPlayer = players.find(p => p.id === myId);
    document.getElementById('my-score-final').textContent = myPlayer?.score || 0;
    document.getElementById('final-bet-input').max = Math.max(myPlayer?.score || 0, 0);
  } else {
    document.getElementById('final-bet-area').classList.add('hidden');
    document.getElementById('final-question-area').classList.add('hidden');
    document.getElementById('final-waiting-area').classList.remove('hidden');
  }
});

function placeFinalBet() {
  const bet = parseInt(document.getElementById('final-bet-input').value);
  if (isNaN(bet) || bet < 0) {
    showNotification('Введите ставку!', 'error');
    return;
  }
  socket.emit('final-bet', { bet });
}

socket.on('final-bet-accepted', (data) => {
  showNotification(`Ставка: ${data.bet}`, 'success');
  document.getElementById('final-bet-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML =
    '<div style="font-size: 20px; color: var(--text-secondary);">Ожидание...</div>';
});

socket.on('final-question', (data) => {
  document.getElementById('final-bet-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.add('hidden');
  document.getElementById('final-question-area').classList.remove('hidden');
  document.getElementById('final-q-text').textContent = data.text;

  let timeLeft = data.timeLimit;
  const timerEl = document.getElementById('final-timer');
  timerEl.textContent = timeLeft;

  if (finalTimerInterval) clearInterval(finalTimerInterval);
  finalTimerInterval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = timeLeft;
    if (timeLeft <= 10) timerEl.style.color = 'var(--danger)';
    if (timeLeft <= 0) { clearInterval(finalTimerInterval); submitFinalAnswer(); }
  }, 1000);
});

function submitFinalAnswer() {
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  const answer = document.getElementById('final-answer-input').value.trim();
  socket.emit('final-answer', { answer });

  document.getElementById('final-question-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML =
    '<div style="font-size: 20px; color: var(--text-secondary); animation: pulse 2s infinite;">Ведущий проверяет...</div>';
}

socket.on('final-waiting', (data) => {
  document.getElementById('final-question-area')?.classList.add('hidden');
  const wa = document.getElementById('final-waiting-area');
  if (wa) { wa.classList.remove('hidden'); wa.innerHTML = `<div style="font-size: 20px; color: var(--text-secondary); animation: pulse 2s infinite;">${escapeHtml(data.message)}</div>`; }
});

// ===== GAME OVER =====
socket.on('game-over', (data) => {
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  clearAnswerTimer();

  // Очищаем сессию
  localStorage.removeItem(`session_${roomId}`);
  localStorage.removeItem(`name_${roomId}`);

  hideAllScreens();
  const screen = document.getElementById('results-screen');
  screen.classList.remove('hidden');

  let html = `<div class="results-title">🏆 Итоги игры</div>`;

  if (data.players.length >= 1) {
    html += '<div class="podium">';
    if (data.players[1]) {
      html += `<div class="podium-place second"><div class="podium-name">${escapeHtml(data.players[1].name)}</div><div class="podium-score">${data.players[1].score}</div><div class="podium-bar second"><div class="podium-position">2</div></div></div>`;
    }
    const isWinner = data.players[0].id === myId;
    html += `<div class="podium-place first"><div class="podium-name">${isWinner ? '👑 ' : ''}${escapeHtml(data.players[0].name)}${isWinner ? ' (ВЫ!)' : ''}</div><div class="podium-score">${data.players[0].score}</div><div class="podium-bar first"><div class="podium-position">1</div></div></div>`;
    if (data.players[2]) {
      html += `<div class="podium-place third"><div class="podium-name">${escapeHtml(data.players[2].name)}</div><div class="podium-score">${data.players[2].score}</div><div class="podium-bar third"><div class="podium-position">3</div></div></div>`;
    }
    html += '</div>';
  }

  html += '<div style="max-width: 500px; width: 100%;">';
  data.players.forEach((p, i) => {
    const isMe = p.id === myId;
    html += `<div style="display:flex;align-items:center;gap:15px;padding:12px;background:rgba(255,255,255,${isMe?'0.1':'0.05'});border-radius:10px;margin:5px 0;${isMe?'border:2px solid var(--secondary);':''}"><div style="font-family:'Russo One';font-size:20px;color:var(--text-secondary);width:30px;">${i+1}</div><div class="player-bar-avatar" style="background:${p.avatarColor}">${p.name[0].toUpperCase()}</div><div style="flex:1;font-weight:700;">${escapeHtml(p.name)} ${isMe?'(Вы)':''}</div><div class="player-bar-score ${p.score<0?'negative':''}">${p.score}</div></div>`;
  });
  html += '</div>';
  html += `<button class="btn btn-primary btn-large" onclick="window.location.href='/'" style="margin-top:30px;">🏠 На главную</button>`;

  screen.innerHTML = html;
});

// ===== ПАНЕЛЬ ИГРОКОВ =====
function renderPlayersBar() {
  const bar = document.getElementById('players-bar');
  if (!bar) return;
  bar.innerHTML = '';

  players.forEach(p => {
    const isMe = p.id === myId;
    const item = document.createElement('div');
    item.className = 'player-bar-item';
    item.id = `player-bar-${p.id}`;
    if (p.id === choosingPlayer) item.classList.add('choosing');
    if (isMe) item.style.borderColor = 'rgba(255, 214, 0, 0.5)';

    item.innerHTML = `
      <div class="player-bar-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-bar-info">
        <div class="player-bar-name">${escapeHtml(p.name)}${isMe ? ' ⭐' : ''}${!p.connected ? ' 🔴' : ''}</div>
        <div class="player-bar-score ${p.score < 0 ? 'negative' : ''}">${p.score}</div>
      </div>
    `;
    bar.appendChild(item);
  });
}

function highlightPlayer(playerId, type) {
  const item = document.getElementById(`player-bar-${playerId}`);
  if (item) {
    item.classList.remove('choosing', 'answering', 'correct', 'wrong');
    item.classList.add(type);
    setTimeout(() => item.classList.remove(type), 2000);
  }
}

// ===== ЧАТ =====
function toggleChat() {
  const chat = document.getElementById('chat');
  chat.classList.toggle('minimized');
  document.getElementById('chat-toggle-btn').textContent =
    chat.classList.contains('minimized') ? '+' : '−';
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (msg) { socket.emit('chat-message', { message: msg }); input.value = ''; }
}

document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat-message', (data) => {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `<span class="name">${escapeHtml(data.name)}:</span> <span class="text">${escapeHtml(data.message)}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
});

// ===== УТИЛИТЫ =====
function hideAllScreens() {
  ['lobby', 'game-board-screen', 'question-screen', 'cat-screen',
   'auction-screen', 'final-screen', 'results-screen'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNotification(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.textContent = message;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), duration);
}

// ===== АВТО-РЕЖИМ =====
socket.on('auto-countdown', (data) => {
  showNotification(`🤖 ${data.message}`, 'info', data.seconds * 1000);
});

socket.on('auto-start-now-btn', () => {
  // Кнопка для раннего старта — по желанию
});

socket.on('auto-cat-in-bag', (data) => {
  showNotification(`🐱 Кот в мешке! Тема: ${data.catTheme}. Отвечает: ${data.targetPlayerName}`, 'info', 3000);
});

socket.on('auto-auction', (data) => {
  showNotification(`💰 Аукцион! ${data.category} — ${data.value}`, 'info', 2000);
});

socket.on('auto-wrong-detail', (data) => {
  showNotification(`❌ ${data.playerName} ответил: "${data.playerAnswer}". Правильно: "${data.correctAnswer}"`, 'error', 5000);
});

socket.on('auto-final-results', (data) => {
  let msg = `Правильный ответ: ${data.correctAnswer}\n`;
  data.results.forEach(r => {
    msg += `${r.correct ? '✅' : '❌'} ${r.playerName}: "${r.answer}" (ставка: ${r.bet})\n`;
  });
  showNotification(msg, 'info', 8000);
});

// Кнопка "Начать сейчас" для авто-режима в лобби
socket.on('players-update', (data) => {
  players = data.players;
  renderLobbyPlayers();
  renderPlayersBar();

  // Добавляем кнопку старта в лобби для авто-режима
  if (isAutoHost && gameState === 'lobby') {
    let startBtn = document.getElementById('auto-start-btn');
    if (!startBtn && players.length >= 1) {
      const lobby = document.getElementById('lobby');
      if (lobby) {
        startBtn = document.createElement('button');
        startBtn.id = 'auto-start-btn';
        startBtn.className = 'btn btn-primary btn-large';
        startBtn.textContent = '🚀 Начать игру сейчас';
        startBtn.style.marginTop = '20px';
        startBtn.onclick = () => socket.emit('auto-start-now');
        lobby.appendChild(startBtn);
      }
    }
  }
});

socket.on('error-msg', (data) => showNotification(data.message, 'error'));
socket.on('host-disconnected', () => showNotification('⚠️ Ведущий отключился! Ожидание...', 'error', 10000));
socket.on('player-disconnected', (data) => { players = data.players; renderPlayersBar(); });
