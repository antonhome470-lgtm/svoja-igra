const socket = io();

let roomId = null;
let myName = '';
let myId = null;
let players = [];
let choosingPlayer = null;
let amChoosing = false;
let gameState = 'lobby';
let finalTimerInterval = null;
let answerTimerInterval = null;

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

  socket.emit('join-room', { roomId, name: myName });
})();

// ===== ПРИСОЕДИНЕНИЕ =====
socket.on('joined-room', (data) => {
  myId = socket.id;
  players = data.players;
  renderLobbyPlayers();
  showNotification('Вы присоединились к игре!', 'success');
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
    const card = document.createElement('div');
    card.className = `player-card ${p.id === myId ? 'choosing' : ''} ${p.connected ? '' : 'disconnected'}`;
    card.style.borderColor = p.id === myId ? 'var(--secondary)' : '';
    card.innerHTML = `
      <div class="player-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-name">${escapeHtml(p.name)} ${p.id === myId ? '(Вы)' : ''}</div>
      <div class="player-score">${p.score}</div>
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
      } else if (!q.answered) {
        td.style.cursor = 'default';
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

  // Скрываем поле ввода и кнопку
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

// Пробел/Enter для buzzer
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && gameState === 'question') {
    const buzzerBtn = document.getElementById('buzzer-btn');
    if (buzzerBtn && !buzzerBtn.disabled && !buzzerBtn.classList.contains('hidden')) {
      e.preventDefault();
      pressBuzzer();
    }
  }
});

// ===== ОТВЕТ ИГРОКА =====
socket.on('player-answering', (data) => {
  document.getElementById('answering-info').classList.remove('hidden');

  const buzzerBtn = document.getElementById('buzzer-btn');
  buzzerBtn.disabled = true;
  buzzerBtn.classList.remove('active');

  if (data.playerId === myId) {
    // Я отвечаю — показываем поле ввода
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

    // Таймер 20 секунд на ответ
    startAnswerTimer(20);

  } else {
    // Другой игрок отвечает
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

  // Отправляем ответ на сервер
  socket.emit('text-answer', { answer: answer });

  // Блокируем ввод
  input.disabled = true;
  document.getElementById('send-answer-btn').disabled = true;
  document.getElementById('buzzer-status').textContent = '📩 Ответ отправлен! Ожидание...';

  clearAnswerTimer();

  if (navigator.vibrate) navigator.vibrate(100);
}

// Enter для отправки ответа
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

    if (timeLeft <= 5) {
      timerEl.classList.add('warning');
    }

    if (timeLeft <= 0) {
      clearAnswerTimer();
      // Авто-отправка пустого ответа
      const input = document.getElementById('answer-text-input');
      if (!input.disabled) {
        sendTextAnswer();
      }
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

// ===== РЕЗУЛЬТАТЫ ОТВЕТА =====
socket.on('answer-result', (data) => {
  players = data.players;
  renderPlayersBar();
  clearAnswerTimer();

  // Скрываем поле ввода
  document.getElementById('answer-input-area').classList.add('hidden');

  if (data.correct) {
    showNotification(`✅ ${data.playerName} +${data.value}!`, 'success');
    highlightPlayer(data.playerId, 'correct');
    if (data.playerId === myId) {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
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

// ===== ДОСКА (обновление) =====
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

  if (data.choosingPlayer === myId) {
    let html = '<div style="margin-top: 20px; font-size: 18px;">Выберите игрока:</div>';
    html += '<div class="player-select-grid">';

    data.players.forEach(p => {
      if (p.id === myId) return;
      html += `
        <div class="player-select-btn" onclick="selectCatPlayer('${p.id}')">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="score">${p.score}</div>
        </div>
      `;
    });

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

function selectCatPlayer(playerId) {
  socket.emit('cat-select-player', { playerId });
}

// ===== АУКЦИОН =====
socket.on('auction-start', (data) => {
  hideAllScreens();
  const screen = document.getElementById('auction-screen');
  screen.classList.remove('hidden');

  document.getElementById('auction-info').textContent =
    `Минимальная ставка: ${data.value}`;

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
  showNotification('💰 Ва-банк!', 'info');
}

function passBet() {
  socket.emit('auction-bet', { pass: true });
  document.getElementById('auction-controls').classList.add('hidden');
  document.getElementById('auction-waiting').classList.remove('hidden');
  showNotification('Вы спасовали', 'info');
}

socket.on('auction-result', (data) => {
  showNotification(
    data.winnerId === myId
      ? `💰 Вы выиграли аукцион! Ставка: ${data.bet}`
      : `💰 ${data.winnerName} выигрывает аукцион: ${data.bet}`,
    'info', 3000
  );
});

socket.on('auction-bet-placed', () => {});

// ===== КОНЕЦ РАУНДА =====
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

  if (amChoosing) {
    showNotification('🎯 Ваша очередь выбирать вопрос!', 'info', 3000);
  }
});

// ===== ФИНАЛЬНЫЙ РАУНД =====
socket.on('final-round', (data) => {
  hideAllScreens();
  const screen = document.getElementById('final-screen');
  screen.classList.remove('hidden');

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
    showNotification('Введите корректную ставку!', 'error');
    return;
  }
  socket.emit('final-bet', { bet });
}

socket.on('final-bet-accepted', (data) => {
  showNotification(`Ставка принята: ${data.bet}`, 'success');
  document.getElementById('final-bet-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML =
    '<div style="font-size: 20px; color: var(--text-secondary);">Ожидание других игроков...</div>';
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
    if (timeLeft <= 0) {
      clearInterval(finalTimerInterval);
      submitFinalAnswer();
    }
  }, 1000);
});

function submitFinalAnswer() {
  if (finalTimerInterval) clearInterval(finalTimerInterval);

  const answer = document.getElementById('final-answer-input').value.trim();
  socket.emit('final-answer', { answer });

  document.getElementById('final-question-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML =
    '<div style="font-size: 20px; color: var(--text-secondary); animation: pulse 2s infinite;">Ведущий проверяет ответы...</div>';
}

socket.on('final-waiting', (data) => {
  document.getElementById('final-question-area')?.classList.add('hidden');
  document.getElementById('final-waiting-area')?.classList.remove('hidden');
  if (document.getElementById('final-waiting-area')) {
    document.getElementById('final-waiting-area').innerHTML =
      `<div style="font-size: 20px; color: var(--text-secondary); animation: pulse 2s infinite;">${escapeHtml(data.message)}</div>`;
  }
});

// ===== РЕЗУЛЬТАТЫ =====
socket.on('game-over', (data) => {
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  clearAnswerTimer();

  hideAllScreens();
  const screen = document.getElementById('results-screen');
  screen.classList.remove('hidden');

  let html = `<div class="results-title">🏆 Итоги игры</div>`;

  if (data.players.length >= 1) {
    html += '<div class="podium">';

    if (data.players[1]) {
      html += `
        <div class="podium-place second">
          <div class="podium-name">${escapeHtml(data.players[1].name)}</div>
          <div class="podium-score">${data.players[1].score}</div>
          <div class="podium-bar second"><div class="podium-position">2</div></div>
        </div>
      `;
    }

    const isWinner = data.players[0].id === myId;
    html += `
      <div class="podium-place first">
        <div class="podium-name">${isWinner ? '👑 ' : ''}${escapeHtml(data.players[0].name)}${isWinner ? ' (ВЫ!)' : ''}</div>
        <div class="podium-score">${data.players[0].score}</div>
        <div class="podium-bar first"><div class="podium-position">1</div></div>
      </div>
    `;

    if (data.players[2]) {
      html += `
        <div class="podium-place third">
          <div class="podium-name">${escapeHtml(data.players[2].name)}</div>
          <div class="podium-score">${data.players[2].score}</div>
          <div class="podium-bar third"><div class="podium-position">3</div></div>
        </div>
      `;
    }

    html += '</div>';
  }

  html += '<div style="max-width: 500px; width: 100%;">';
  data.players.forEach((p, i) => {
    const isMe = p.id === myId;
    html += `
      <div style="display: flex; align-items: center; gap: 15px; padding: 12px; background: rgba(255,255,255,${isMe ? '0.1' : '0.05'}); border-radius: 10px; margin: 5px 0; ${isMe ? 'border: 2px solid var(--secondary);' : ''}">
        <div style="font-family: 'Russo One'; font-size: 20px; color: var(--text-secondary); width: 30px;">${i + 1}</div>
        <div class="player-bar-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
        <div style="flex: 1; font-weight: 700;">${escapeHtml(p.name)} ${isMe ? '(Вы)' : ''}</div>
        <div class="player-bar-score ${p.score < 0 ? 'negative' : ''}">${p.score}</div>
      </div>
    `;
  });
  html += '</div>';

  html += `
    <button class="btn btn-primary btn-large" onclick="window.location.href='/'" style="margin-top: 30px;">
      🏠 На главную
    </button>
  `;

  screen.innerHTML = html;

  if (data.players[0]?.id === myId && navigator.vibrate) {
    navigator.vibrate([200, 100, 200, 100, 200]);
  }
});

// ===== ПАНЕЛЬ ИГРОКОВ =====
function renderPlayersBar() {
  const bar = document.getElementById('players-bar');
  if (!bar) return;
  bar.innerHTML = '';

  players.forEach(p => {
    const item = document.createElement('div');
    item.className = 'player-bar-item';
    item.id = `player-bar-${p.id}`;
    if (p.id === choosingPlayer) item.classList.add('choosing');
    if (p.id === myId) item.style.borderColor = 'rgba(255, 214, 0, 0.5)';

    item.innerHTML = `
      <div class="player-bar-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-bar-info">
        <div class="player-bar-name">${escapeHtml(p.name)}${p.id === myId ? ' ⭐' : ''}</div>
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
  if (msg) {
    socket.emit('chat-message', { message: msg });
    input.value = '';
  }
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

// ===== ОШИБКИ =====
socket.on('error-msg', (data) => {
  showNotification(data.message, 'error');
});

socket.on('host-disconnected', () => {
  showNotification('⚠️ Ведущий отключился!', 'error', 10000);
});

socket.on('player-disconnected', (data) => {
  players = data.players;
  renderPlayersBar();
});

socket.on('disconnect', () => {
  showNotification('⚠️ Потеряно соединение с сервером...', 'error', 10000);
});

socket.on('connect', () => {
  if (roomId && myName) {
    socket.emit('join-room', { roomId, name: myName });
  }
});
