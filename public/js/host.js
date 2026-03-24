const socket = io();

let roomId = null;
let gameState = 'lobby';
let currentRound = null;
let players = [];
let currentQuestion = null;
let choosingPlayer = null;

// ===== ИНИЦИАЛИЗАЦИЯ =====
(function init() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  // Получаем имя ведущего
  const hostData = JSON.parse(sessionStorage.getItem('hostData') || '{}');
  const hostName = hostData.hostName || 'Ведущий';

  // Создаём комнату
  socket.emit('create-room', { name: hostName });
})();

socket.on('room-created', (data) => {
  roomId = data.roomId;
  document.getElementById('room-code').textContent = roomId;
  document.getElementById('lobby-room-code').textContent = roomId;

  // Обновляем URL
  window.history.replaceState({}, '', `/host.html?room=${roomId}`);
});

// ===== УТИЛИТЫ =====
function copyRoomCode() {
  if (roomId) {
    navigator.clipboard.writeText(roomId).then(() => {
      showNotification('Код скопирован!', 'success');
    }).catch(() => {
      // Fallback
      const input = document.createElement('input');
      input.value = roomId;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      showNotification('Код скопирован!', 'success');
    });
  }
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

// ===== ЛОББИ =====
socket.on('players-update', (data) => {
  players = data.players;
  renderLobbyPlayers();
  renderPlayersBar();
});

function renderLobbyPlayers() {
  const container = document.getElementById('lobby-players');
  container.innerHTML = '';

  players.forEach(p => {
    const card = document.createElement('div');
    card.className = `player-card ${p.connected ? '' : 'disconnected'}`;
    card.innerHTML = `
      <div class="player-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-score">${p.score}</div>
      ${p.connected ? '' : '<div style="color: var(--danger); font-size: 12px;">Отключён</div>'}
    `;
    container.appendChild(card);
  });

  const startBtn = document.getElementById('start-btn');
  const waitingText = document.getElementById('waiting-text');

  if (players.length >= 1) {
    startBtn.disabled = false;
    waitingText.textContent = `Игроков: ${players.length}/6`;
  } else {
    startBtn.disabled = true;
    waitingText.textContent = 'Ожидание игроков...';
  }
}

function startGame() {
  socket.emit('start-game');
}

// ===== НАЧАЛО ИГРЫ =====
socket.on('game-started', (data) => {
  gameState = 'playing';
  currentRound = data.round;
  players = data.players;
  choosingPlayer = data.choosingPlayer;

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);
});

// ===== ДОСКА =====
function renderBoard(round, roundIndex) {
  document.getElementById('round-title').textContent = round.name;

  const table = document.getElementById('board-table');
  table.innerHTML = '';

  // Заголовки категорий
  const headerRow = document.createElement('tr');
  round.categories.forEach(cat => {
    const th = document.createElement('th');
    th.textContent = cat.name;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  // Строки с вопросами
  const numQuestions = round.categories[0].questions.length;
  for (let qi = 0; qi < numQuestions; qi++) {
    const row = document.createElement('tr');
    round.categories.forEach((cat, ci) => {
      const td = document.createElement('td');
      const q = cat.questions[qi];
      td.className = `board-cell ${q.answered ? 'answered' : ''}`;
      td.textContent = q.answered ? '' : q.value;
      td.dataset.cat = ci;
      td.dataset.q = qi;

      if (!q.answered) {
        td.onclick = () => selectQuestion(ci, qi);
      }

      row.appendChild(td);
    });
    table.appendChild(row);
  }
}

function selectQuestion(catIndex, qIndex) {
  socket.emit('select-question', { catIndex, qIndex });
}

function updateChoosingInfo(name) {
  document.getElementById('choosing-info').innerHTML =
    `Выбирает: <span class="player-name-highlight">${escapeHtml(name || '...')}</span>`;
}

// ===== ВОПРОС =====
socket.on('question-show', (data) => {
  gameState = 'question';
  currentQuestion = data;

  hideAllScreens();
  const screen = document.getElementById('question-screen');
  screen.classList.remove('hidden');

  document.getElementById('q-category').textContent = data.category;
  document.getElementById('q-value').textContent = data.value;
  document.getElementById('q-text').textContent = data.text;
  document.getElementById('q-answer-area').classList.add('hidden');
  document.getElementById('answering-info').classList.add('hidden');
  document.getElementById('judge-buttons').classList.add('hidden');
  document.getElementById('judge-buttons').style.display = 'none';
  document.getElementById('skip-btn').style.display = '';

  // Показываем правильный ответ ведущему
  // Ответ придёт с вопросом для ведущего — берём из серверного хранилища
  // Для простоты покажем после отправки
});

// Ведущий видит правильный ответ (сервер отправит)
socket.on('host-answer', (data) => {
  document.getElementById('host-correct-answer').textContent = data.answer;
});

socket.on('buzzer-unlocked', () => {
  showNotification('🔔 Кнопки разблокированы!', 'info', 1500);
});

socket.on('player-answering', (data) => {
  document.getElementById('answering-info').classList.remove('hidden');
  document.getElementById('answering-player-name').textContent = data.playerName;
  document.getElementById('judge-buttons').classList.remove('hidden');
  document.getElementById('judge-buttons').style.display = 'flex';

  // Подсвечиваем игрока
  highlightPlayer(data.playerId, 'answering');
});

function judgeAnswer(correct) {
  socket.emit('judge-answer', { correct });
  document.getElementById('judge-buttons').classList.add('hidden');
  document.getElementById('judge-buttons').style.display = 'none';
}

function skipQuestion() {
  socket.emit('skip-question');
}

socket.on('answer-result', (data) => {
  players = data.players;
  renderPlayersBar();

  if (data.correct) {
    showNotification(`✅ ${data.playerName} +${data.value}!`, 'success');
    highlightPlayer(data.playerId, 'correct');
  } else {
    showNotification(`❌ ${data.playerName} ${data.value}`, 'error');
    highlightPlayer(data.playerId, 'wrong');
  }

  if (data.correct) {
    setTimeout(() => {
      document.getElementById('q-answer-area').classList.remove('hidden');
      document.getElementById('q-answer').textContent = data.answer;
    }, 500);
  }
});

socket.on('answer-timeout', () => {
  showNotification('⏰ Время вышло!', 'warning');
});

socket.on('question-end', (data) => {
  players = data.players;
  renderPlayersBar();

  document.getElementById('q-answer-area').classList.remove('hidden');
  document.getElementById('q-answer').textContent = data.answer;
  document.getElementById('judge-buttons').classList.add('hidden');
  document.getElementById('judge-buttons').style.display = 'none';
});

// ===== ДОСКА (обновление) =====
socket.on('show-board', (data) => {
  gameState = 'playing';
  currentRound = data.round;
  players = data.players;
  choosingPlayer = data.choosingPlayer;

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);
});

// ===== КОТ В МЕШКЕ =====
socket.on('cat-in-bag', (data) => {
  hideAllScreens();
  const screen = document.getElementById('cat-screen');
  screen.classList.remove('hidden');

  document.getElementById('cat-theme').textContent = `Тема: ${data.catTheme}`;
  document.getElementById('cat-value').textContent = `Стоимость: ${data.value}`;

  const container = document.getElementById('cat-players');
  container.innerHTML = '';

  // Ведущий выбирает, кому отдать кота
  data.players.forEach(p => {
    if (p.id === data.choosingPlayer) return; // нельзя выбрать себя
    const btn = document.createElement('div');
    btn.className = 'player-select-btn';
    btn.innerHTML = `
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="score">${p.score}</div>
    `;
    btn.onclick = () => {
      socket.emit('cat-select-player', { playerId: p.id });
    };
    container.appendChild(btn);
  });
});

// ===== АУКЦИОН =====
socket.on('auction-start', (data) => {
  hideAllScreens();
  const screen = document.getElementById('auction-screen');
  screen.classList.remove('hidden');

  document.getElementById('auction-info').textContent =
    `Категория: ${data.category} | Минимальная ставка: ${data.value}`;
  document.getElementById('auction-bets-info').textContent = 'Ожидание ставок игроков...';
});

socket.on('auction-bet-placed', (data) => {
  document.getElementById('auction-bets-info').textContent =
    `Ставки: ${data.betCount}/${data.totalPlayers}`;
});

socket.on('auction-result', (data) => {
  showNotification(`💰 ${data.winnerName} выигрывает аукцион: ${data.bet}!`, 'info', 3000);
});

function finishAuction() {
  socket.emit('finish-auction');
}

// ===== КОНЕЦ РАУНДА =====
socket.on('round-complete', (data) => {
  hideAllScreens();
  const screen = document.getElementById('round-end-screen');
  screen.classList.remove('hidden');

  const container = document.getElementById('round-end-players');
  container.innerHTML = '';

  const sorted = [...data.players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div style="font-size: 24px; margin-bottom: 5px;">${i === 0 ? '👑' : i + 1}</div>
      <div class="player-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-score ${p.score < 0 ? 'negative' : ''}">${p.score}</div>
    `;
    container.appendChild(card);
  });
});

function nextRound() {
  socket.emit('next-round');
}

function skipToNextRound() {
  if (confirm('Перейти к следующему раунду?')) {
    socket.emit('next-round');
  }
}

socket.on('new-round', (data) => {
  gameState = 'playing';
  currentRound = data.round;
  players = data.players;
  choosingPlayer = data.choosingPlayer;

  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');

  renderBoard(data.round, data.roundIndex);
  renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);

  showNotification(`🎯 ${data.round.name}`, 'info', 3000);
});

// ===== ФИНАЛЬНЫЙ РАУНД =====
socket.on('final-round', (data) => {
  hideAllScreens();
  const screen = document.getElementById('final-screen');
  screen.classList.remove('hidden');

  document.getElementById('final-theme').textContent = `Тема: ${data.theme}`;

  const area = document.getElementById('final-host-area');
  area.innerHTML = `
    <div style="margin: 20px 0; font-size: 18px; color: var(--text-secondary);">
      Игроки делают ставки...
    </div>
    <div id="final-bets-status" style="font-size: 16px;"></div>
  `;

  players = data.players;
  renderPlayersBar();
});

socket.on('final-bet-update', (data) => {
  const status = document.getElementById('final-bets-status');
  if (status) {
    status.textContent = `Ставки: ${data.totalBets}/${data.totalPlayers}`;
  }
});

socket.on('final-question', (data) => {
  const area = document.getElementById('final-host-area');
  area.innerHTML = `
    <div class="question-text" style="font-size: 28px; margin: 30px 0;">${escapeHtml(data.text)}</div>
    <div style="font-size: 18px; color: var(--text-secondary);">Игроки записывают ответы (60 сек)...</div>
    <div id="final-answers-status" style="margin-top: 15px;"></div>
  `;
});

socket.on('final-answer-update', (data) => {
  const status = document.getElementById('final-answers-status');
  if (status) {
    status.textContent = `Ответы: ${data.answersCount}/${data.totalPlayers}`;
  }
});

socket.on('final-judge', (data) => {
  const area = document.getElementById('final-host-area');
  let html = `
    <div style="margin: 20px 0;">
      <div style="font-size: 20px; color: var(--success); margin-bottom: 20px;">
        Правильный ответ: <strong>${escapeHtml(data.correctAnswer)}</strong>
      </div>
  `;

  data.answers.forEach(a => {
    html += `
      <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 15px; margin: 10px 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div>
          <strong>${escapeHtml(a.playerName)}</strong>
          <div style="color: var(--text-secondary);">Ответ: "${escapeHtml(a.answer)}"</div>
          <div style="color: var(--secondary);">Ставка: ${a.bet}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-success" onclick="setFinalResult('${a.playerId}', true, this)">✅</button>
          <button class="btn btn-danger" onclick="setFinalResult('${a.playerId}', false, this)">❌</button>
        </div>
      </div>
    `;
  });

  html += `
    <button class="btn btn-primary btn-large" onclick="submitFinalResults()" style="margin-top: 20px;" id="submit-final-btn" disabled>
      Подтвердить результаты
    </button>
  `;

  area.innerHTML = html;

  window.finalResults = {};
  window.finalAnswersData = data.answers;
});

window.finalResults = {};

function setFinalResult(playerId, correct, btn) {
  window.finalResults[playerId] = correct;

  // Визуальная обратная связь
  const parent = btn.parentElement;
  parent.querySelectorAll('button').forEach(b => b.style.opacity = '0.3');
  btn.style.opacity = '1';

  // Проверяем, все ли оценены
  if (Object.keys(window.finalResults).length >= window.finalAnswersData.length) {
    document.getElementById('submit-final-btn').disabled = false;
  }
}

function submitFinalResults() {
  const results = Object.entries(window.finalResults).map(([playerId, correct]) => ({
    playerId, correct
  }));
  socket.emit('judge-final', { results });
}

// ===== РЕЗУЛЬТАТЫ =====
socket.on('game-over', (data) => {
  hideAllScreens();
  const screen = document.getElementById('results-screen');
  screen.classList.remove('hidden');

  let html = `<div class="results-title">🏆 Итоги игры</div>`;

  // Подиум
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

    html += `
      <div class="podium-place first">
        <div class="podium-name">👑 ${escapeHtml(data.players[0].name)}</div>
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

  // Полная таблица
  html += '<div style="max-width: 500px; width: 100%;">';
  data.players.forEach((p, i) => {
    html += `
      <div style="display: flex; align-items: center; gap: 15px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 10px; margin: 5px 0;">
        <div style="font-family: 'Russo One'; font-size: 20px; color: var(--text-secondary); width: 30px;">${i + 1}</div>
        <div class="player-bar-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
        <div style="flex: 1; font-weight: 700;">${escapeHtml(p.name)}</div>
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

    item.innerHTML = `
      <div class="player-bar-avatar" style="background: ${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-bar-info">
        <div class="player-bar-name">${escapeHtml(p.name)}</div>
        <div class="player-bar-score ${p.score < 0 ? 'negative' : ''}">${p.score}</div>
      </div>
      <div class="score-adjust">
        <button class="plus" onclick="adjustScore('${p.id}', 100)" title="+100">+</button>
        <button class="minus" onclick="adjustScore('${p.id}', -100)" title="-100">−</button>
      </div>
    `;
    bar.appendChild(item);
  });
}

function adjustScore(playerId, amount) {
  socket.emit('adjust-score', { playerId, amount });
}

function highlightPlayer(playerId, type) {
  const item = document.getElementById(`player-bar-${playerId}`);
  if (item) {
    item.classList.remove('choosing', 'answering', 'correct', 'wrong');
    item.classList.add(type);
    setTimeout(() => {
      item.classList.remove(type);
    }, 2000);
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
   'auction-screen', 'round-end-screen', 'final-screen', 'results-screen'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== ОБРАБОТКА ОШИБОК =====
socket.on('error-msg', (data) => {
  showNotification(data.message, 'error');
});

socket.on('host-disconnected', () => {
  showNotification('Соединение потеряно!', 'error', 5000);
});

socket.on('player-disconnected', (data) => {
  players = data.players;
  renderPlayersBar();
  showNotification(`${data.playerName} отключился`, 'warning');
});

socket.on('disconnect', () => {
  showNotification('Потеряно соединение с сервером...', 'error', 10000);
});

socket.on('connect', () => {
  if (roomId) {
    // Пересоздаём комнату (в реальном проекте нужна логика reconnect)
  }
});
