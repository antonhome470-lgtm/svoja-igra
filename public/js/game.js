const socket = io({
  reconnection: true,
  reconnectionAttempts: 50,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

let roomId = null;
let myName = '';
let myId = null;
let players = [];
let choosingPlayer = null;
let amChoosing = false;
let gameState = 'lobby';
let finalTimerInterval = null;
let answerTimerInterval = null;
let questionTimerInterval = null;
let sessionId = null;
let isAutoHost = false;

// ===== ИНИЦИАЛИЗАЦИЯ =====
(function init() {
  const params = new URLSearchParams(window.location.search);
  roomId = params.get('room');
  myName = decodeURIComponent(params.get('name') || '');
  isAutoHost = params.get('auto') === '1';

  if (!roomId || !myName) {
    window.location.href = '/';
    return;
  }

  document.getElementById('room-code').textContent = roomId;
  document.getElementById('my-name').textContent = myName;

  // Проверяем сохранённую сессию
  sessionId = localStorage.getItem(`session_${roomId}`);

  if (sessionId) {
    // Пробуем переподключиться
    console.log('Пробуем переподключение, sessionId:', sessionId);
    socket.emit('player-reconnect', { sessionId, roomId });
  } else {
    // Новый вход
    socket.emit('join-room', { roomId, name: myName });
  }
})();

// ===== ВЫХОД =====
function exitGame() {
  const modal = document.createElement('div');
  modal.className = 'exit-modal';
  modal.innerHTML = `
    <div class="exit-modal-content">
      <h2>🚪 Выйти из игры?</h2>
      <p>Вы сможете вернуться по той же ссылке, пока игра идёт.</p>
      <div class="exit-modal-buttons">
        <button class="btn btn-danger" onclick="confirmExit()">Выйти</button>
        <button class="btn btn-secondary" onclick="this.closest('.exit-modal').remove()">Остаться</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function confirmExit() {
  // НЕ удаляем сессию — чтобы можно было вернуться!
  // localStorage.removeItem(`session_${roomId}`);  ← закомментировано
  // localStorage.removeItem(`name_${roomId}`);     ← закомментировано
  window.location.href = '/';
}

// ===== ТАЙМЕР ВОПРОСА =====
function startQuestionTimer(seconds) {
  clearQuestionTimer();

  // Создаём элементы таймера
  let bar = document.getElementById('question-timer-bar');
  let text = document.getElementById('question-timer-text');

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'question-timer-bar';
    bar.className = 'question-timer-bar';
    bar.innerHTML = '<div class="question-timer-fill" id="question-timer-fill"></div>';
    document.body.appendChild(bar);
  }

  if (!text) {
    text = document.createElement('div');
    text.id = 'question-timer-text';
    text.className = 'question-timer-text';
    document.body.appendChild(text);
  }

  bar.style.display = 'block';
  text.style.display = 'block';

  let timeLeft = seconds;
  const fill = document.getElementById('question-timer-fill');
  fill.style.width = '100%';
  fill.className = 'question-timer-fill';
  text.textContent = timeLeft;
  text.className = 'question-timer-text';

  questionTimerInterval = setInterval(() => {
    timeLeft--;
    const pct = (timeLeft / seconds) * 100;
    fill.style.width = pct + '%';
    text.textContent = timeLeft;

    if (timeLeft <= 5) {
      fill.className = 'question-timer-fill critical';
      text.className = 'question-timer-text critical';
    } else if (timeLeft <= 10) {
      fill.className = 'question-timer-fill warning';
      text.className = 'question-timer-text warning';
    }

    if (timeLeft <= 0) {
      clearQuestionTimer();
    }
  }, 1000);
}

function clearQuestionTimer() {
  if (questionTimerInterval) {
    clearInterval(questionTimerInterval);
    questionTimerInterval = null;
  }
  const bar = document.getElementById('question-timer-bar');
  const text = document.getElementById('question-timer-text');
  if (bar) bar.style.display = 'none';
  if (text) text.style.display = 'none';
}

// ===== ПРИСОЕДИНЕНИЕ =====
socket.on('joined-room', (data) => {
  sessionId = data.sessionId;
  myId = data.sessionId;
  players = data.players;
  isAutoHost = data.autoHost || isAutoHost;
  localStorage.setItem(`session_${roomId}`, sessionId);
  localStorage.setItem(`name_${roomId}`, myName);
  renderLobbyPlayers();
  showNotification('Вы присоединились к игре!', 'success');
  if (isAutoHost) showNotification('🤖 Бот-ведущий. Игра начнётся автоматически!', 'info', 5000);
});

socket.on('reconnected', (data) => {
  sessionId = data.sessionId; myId = data.sessionId; myName = data.playerName;
  isAutoHost = data.autoHost || isAutoHost;
  localStorage.setItem(`session_${roomId}`, sessionId);
  document.getElementById('my-name').textContent = myName;
  showNotification('🔄 Вы вернулись в игру!', 'success', 3000);
});

socket.on('reconnect-failed', (data) => {
  console.log('Переподключение не удалось:', data.message);
  localStorage.removeItem(`session_${roomId}`);
  sessionId = null;
  // Пробуем войти как новый игрок
  socket.emit('join-room', { roomId, name: myName });
});

socket.on('player-reconnected', (data) => {
  showNotification(`🔄 ${data.playerName} вернулся`, 'info', 2000);
});

socket.on('connect', () => {
  console.log('Socket подключён:', socket.id);
  // Если есть сессия — переподключаемся
  if (sessionId && roomId) {
    console.log('Авто-переподключение...');
    socket.emit('player-reconnect', { sessionId, roomId });
  }
});

socket.on('disconnect', () => {
  showNotification('⚠️ Соединение потеряно. Переподключение...', 'error', 5000);
  clearQuestionTimer();
});

socket.on('players-update', (data) => {
  players = data.players;
  renderLobbyPlayers();
  renderPlayersBar();
  renderAutoStartButton();
});

socket.on('auto-waiting', (data) => {
  renderAutoStartButton();
});

socket.on('auto-countdown', (data) => {
  showNotification(`🤖 ${data.message}`, 'info', data.seconds * 1000);
});

function renderAutoStartButton() {
  if (!isAutoHost || gameState !== 'lobby') return;

  const lobby = document.getElementById('lobby');
  if (!lobby) return;

  const old = document.getElementById('auto-start-btn');
  if (old) old.remove();

  const oldWait = document.getElementById('auto-waiting-text');
  if (oldWait) oldWait.remove();

  if (players.length >= 1) {
    const wrapper = document.createElement('div');
    wrapper.id = 'auto-waiting-text';
    wrapper.style.cssText = 'text-align: center; margin-top: 20px;';
    wrapper.innerHTML = `
      <div style="color: var(--text-secondary); font-size: 16px; margin-bottom: 15px;">
        🤖 Бот-ведущий | Игроков: <strong style="color: var(--secondary);">${players.length}</strong>/6
      </div>
      <div style="color: var(--text-secondary); font-size: 14px; margin-bottom: 15px;">
        Поделитесь кодом комнаты с друзьями.<br>Когда все подключатся — нажмите кнопку.
      </div>
    `;
    lobby.appendChild(wrapper);

    const btn = document.createElement('button');
    btn.id = 'auto-start-btn';
    btn.className = 'btn btn-primary btn-large';
    btn.innerHTML = '🚀 Начать игру';
    btn.style.marginTop = '10px';
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = '⏳ Запуск...';
      socket.emit('auto-start-now');
    };
    lobby.appendChild(btn);
  }
}

function renderLobbyPlayers() {
  const c = document.getElementById('lobby-players');
  if (!c) return;
  c.innerHTML = '';

  players.forEach(p => {
    const isMe = p.id === myId;
    const card = document.createElement('div');
    card.className = `player-card ${isMe ? 'choosing' : ''} ${p.connected ? '' : 'disconnected'}`;
    card.style.borderColor = isMe ? 'var(--secondary)' : '';
    card.innerHTML = `
      <div class="player-avatar" style="background:${p.avatarColor}">${p.name[0].toUpperCase()}</div>
      <div class="player-name">${esc(p.name)} ${isMe ? '(Вы)' : ''}</div>
      <div class="player-score">${p.score}</div>
      ${!p.connected ? '<div style="color:var(--danger);font-size:12px;">Отключён</div>' : ''}
    `;
    c.appendChild(card);
  });

  const waitText = document.querySelector('.waiting-text');
  if (waitText && !isAutoHost) {
    waitText.textContent = players.length > 0
      ? `Игроков: ${players.length}/6 — ожидание ведущего...`
      : 'Ожидание игроков...';
  } else if (waitText && isAutoHost) {
    waitText.textContent = '';
  }
}

  const waitText = document.querySelector('.waiting-text');
  if (waitText && !isAutoHost) {
    waitText.textContent = players.length > 0
      ? `Игроков: ${players.length}/6 — ожидание ведущего...`
      : 'Ожидание игроков...';
  } else if (waitText && isAutoHost) {
    waitText.textContent = '';
  }

// ===== ИГРА =====
socket.on('game-started', (data) => {
  gameState = 'playing'; players = data.players;
  choosingPlayer = data.choosingPlayer;
  amChoosing = (choosingPlayer === myId);
  isAutoHost = data.autoHost || isAutoHost;
  hideAllScreens();
  document.getElementById('game-board-screen').classList.remove('hidden');
  renderBoard(data.round); renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);
  if (amChoosing) showNotification('🎯 Ваша очередь выбирать!', 'info', 3000);
});

function renderBoard(round) {
  document.getElementById('round-title').textContent = round.name;
  const table = document.getElementById('board-table');
  table.innerHTML = '';
  const hr = document.createElement('tr');
  round.categories.forEach(cat => { const th = document.createElement('th'); th.textContent = cat.name; hr.appendChild(th); });
  table.appendChild(hr);
  const nq = round.categories[0].questions.length;
  for (let qi = 0; qi < nq; qi++) {
    const row = document.createElement('tr');
    round.categories.forEach((cat, ci) => {
      const td = document.createElement('td');
      const q = cat.questions[qi];
      td.className = `board-cell ${q.answered ? 'answered' : ''}`;
      td.textContent = q.answered ? '' : q.value;
      if (!q.answered && amChoosing) { td.onclick = () => selectQuestion(ci, qi); td.style.cursor = 'pointer'; }
      row.appendChild(td);
    });
    table.appendChild(row);
  }
}

function selectQuestion(ci, qi) {
  if (!amChoosing) { showNotification('Не ваша очередь!', 'error'); return; }
  socket.emit('select-question', { catIndex: ci, qIndex: qi });
}

function updateChoosingInfo(name) {
  const info = document.getElementById('choosing-info');
  if (info) {
    info.innerHTML = choosingPlayer === myId
      ? '<span class="player-name-highlight">⭐ Ваша очередь выбирать!</span>'
      : `Выбирает: <span class="player-name-highlight">${esc(name || '...')}</span>`;
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
  const optionsArea = document.getElementById('answer-options-area');

  answerInputArea.classList.add('hidden');
  optionsArea?.remove();
  clearAnswerTimer();
  clearQuestionTimer();

  // Таймер чтения вопроса (3 сек)
  startQuestionTimer(3);

  if (data.catInBag && data.targetPlayer === myId) {
    buzzerArea.classList.remove('hidden'); buzzerBtn.classList.add('hidden');
    buzzerStatus.textContent = '🐱 Кот в мешке — вы отвечаете!';
  } else if (data.auction) {
    buzzerArea.classList.remove('hidden'); buzzerBtn.classList.add('hidden');
    buzzerStatus.textContent = '💰 Аукцион — ожидание...';
  } else {
    buzzerArea.classList.remove('hidden'); buzzerBtn.classList.remove('hidden');
    buzzerBtn.disabled = true; buzzerBtn.classList.remove('active');
    buzzerStatus.textContent = 'Читайте вопрос...';
  }

  // Сохраняем options
  if (data.options) {
    screen.dataset.options = JSON.stringify(data.options);
  } else {
    delete screen.dataset.options;
  }
});

socket.on('buzzer-unlocked', () => {
  const buzzerBtn = document.getElementById('buzzer-btn');
  const buzzerStatus = document.getElementById('buzzer-status');
  buzzerBtn.classList.remove('hidden'); buzzerBtn.disabled = false;
  buzzerBtn.classList.add('active');
  buzzerStatus.textContent = '🔔 Жмите кнопку!';
  clearQuestionTimer();
  startQuestionTimer(15);
  if (navigator.vibrate) navigator.vibrate(100);
});

function pressBuzzer() {
  socket.emit('buzzer');
  document.getElementById('buzzer-btn').disabled = true;
  document.getElementById('buzzer-btn').classList.remove('active');
  document.getElementById('buzzer-status').textContent = '⏳ Ожидание...';
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && gameState === 'question') {
    const btn = document.getElementById('buzzer-btn');
    if (btn && !btn.disabled && !btn.classList.contains('hidden')) {
      e.preventDefault(); pressBuzzer();
    }
  }
});

// ===== ОТВЕТ =====
socket.on('player-answering', (data) => {
  document.getElementById('answering-info').classList.remove('hidden');
  const buzzerBtn = document.getElementById('buzzer-btn');
  buzzerBtn.disabled = true; buzzerBtn.classList.remove('active');
  clearQuestionTimer();

  const isMe = data.playerId === myId;

  if (isMe) {
    document.getElementById('answering-player-name').textContent = 'ВЫ';
    document.getElementById('buzzer-status').textContent = '🎤 Ответьте!';
    buzzerBtn.classList.add('hidden');

    // Проверяем — есть ли варианты ответа
    const screen = document.getElementById('question-screen');
    const optionsJson = screen.dataset.options;

    if (optionsJson) {
      showAnswerOptions(JSON.parse(optionsJson));
    } else {
      showTextInput();
    }

    startAnswerTimer(20);
  } else {
    document.getElementById('answering-player-name').textContent = data.playerName;
    document.getElementById('buzzer-status').textContent = `${data.playerName} отвечает...`;
    document.getElementById('answer-input-area').classList.add('hidden');
    const existing = document.getElementById('answer-options-area');
    if (existing) existing.remove();
  }

  highlightPlayer(data.playerId, 'answering');
});

function showTextInput() {
  const answerInputArea = document.getElementById('answer-input-area');
  answerInputArea.classList.remove('hidden');
  const input = document.getElementById('answer-text-input');
  input.value = ''; input.disabled = false; input.focus();
  document.getElementById('send-answer-btn').disabled = false;
}

function showAnswerOptions(options) {
  document.getElementById('answer-input-area').classList.add('hidden');

  // Удаляем старые
  const existing = document.getElementById('answer-options-area');
  if (existing) existing.remove();

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const shuffled = [...options].sort(() => Math.random() - 0.5);

  const container = document.createElement('div');
  container.id = 'answer-options-area';
  container.className = 'answer-options';

  shuffled.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'answer-option-btn';
    btn.innerHTML = `<span class="option-letter">${letters[i]}</span>${esc(opt)}`;
    btn.onclick = () => selectOption(btn, opt, container);
    container.appendChild(btn);
  });

  // Вставляем после buzzer-area
  const buzzerArea = document.getElementById('buzzer-area');
  buzzerArea.parentNode.insertBefore(container, buzzerArea.nextSibling);
}

function selectOption(btn, answer, container) {
  container.querySelectorAll('.answer-option-btn').forEach(b => {
    b.classList.remove('selected');
    b.disabled = true;
  });
  btn.classList.add('selected');

  socket.emit('text-answer', { answer });
  document.getElementById('buzzer-status').textContent = '📩 Ответ отправлен!';
  clearAnswerTimer();
  if (navigator.vibrate) navigator.vibrate(100);
}

function sendTextAnswer() {
  const input = document.getElementById('answer-text-input');
  const answer = input.value.trim();
  if (!answer) { showNotification('Введите ответ!', 'error'); input.focus(); return; }

  socket.emit('text-answer', { answer });
  input.disabled = true;
  document.getElementById('send-answer-btn').disabled = true;
  document.getElementById('buzzer-status').textContent = '📩 Ответ отправлен!';
  clearAnswerTimer();
  if (navigator.vibrate) navigator.vibrate(100);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const input = document.getElementById('answer-text-input');
    const area = document.getElementById('answer-input-area');
    if (area && !area.classList.contains('hidden') && !input.disabled) {
      e.preventDefault(); sendTextAnswer();
    }
  }
});

function startAnswerTimer(seconds) {
  clearAnswerTimer();
  startQuestionTimer(seconds);
  let timeLeft = seconds;
  const timerEl = document.getElementById('answer-timer');
  timerEl.textContent = timeLeft; timerEl.classList.remove('warning');

  answerTimerInterval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = timeLeft;
    if (timeLeft <= 5) timerEl.classList.add('warning');
    if (timeLeft <= 0) {
      clearAnswerTimer();
      const input = document.getElementById('answer-text-input');
      if (input && !input.disabled) sendTextAnswer();
      // Авто-клик по варианту если не выбрали
      const optArea = document.getElementById('answer-options-area');
      if (optArea) {
        const btns = optArea.querySelectorAll('.answer-option-btn:not(:disabled)');
        if (btns.length > 0) {
          const random = btns[Math.floor(Math.random() * btns.length)];
          random.click();
        }
      }
    }
  }, 1000);
}

function clearAnswerTimer() {
  if (answerTimerInterval) { clearInterval(answerTimerInterval); answerTimerInterval = null; }
  const el = document.getElementById('answer-timer');
  if (el) { el.textContent = ''; el.classList.remove('warning'); }
}

// ===== РЕЗУЛЬТАТ =====
socket.on('answer-result', (data) => {
  players = data.players; renderPlayersBar();
  clearAnswerTimer(); clearQuestionTimer();
  document.getElementById('answer-input-area').classList.add('hidden');
  const optArea = document.getElementById('answer-options-area');
  if (optArea) optArea.remove();

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

socket.on('auto-wrong-detail', (data) => {
  showNotification(`❌ ${data.playerName}: "${data.playerAnswer}" → Правильно: "${data.correctAnswer}"`, 'error', 5000);
});

socket.on('answer-timeout', () => {
  showNotification('⏰ Время вышло!', 'warning');
  clearAnswerTimer(); clearQuestionTimer();
  document.getElementById('answer-input-area').classList.add('hidden');
  const optArea = document.getElementById('answer-options-area');
  if (optArea) optArea.remove();
});

socket.on('question-end', (data) => {
  players = data.players; renderPlayersBar();
  clearAnswerTimer(); clearQuestionTimer();
  document.getElementById('q-answer-area').classList.remove('hidden');
  document.getElementById('q-answer').textContent = data.answer;
  document.getElementById('buzzer-btn').disabled = true;
  document.getElementById('buzzer-btn').classList.remove('active');
  document.getElementById('buzzer-status').textContent = 'Вопрос завершён';
  document.getElementById('answer-input-area').classList.add('hidden');
  const optArea = document.getElementById('answer-options-area');
  if (optArea) optArea.remove();
});

// ===== ДОСКА =====
socket.on('show-board', (data) => {
  gameState = 'playing'; players = data.players;
  choosingPlayer = data.choosingPlayer; amChoosing = (choosingPlayer === myId);
  hideAllScreens(); clearQuestionTimer();
  document.getElementById('game-board-screen').classList.remove('hidden');
  renderBoard(data.round); renderPlayersBar();
  updateChoosingInfo(data.choosingPlayerName);
  if (amChoosing) { showNotification('🎯 Ваша очередь!', 'info', 3000); if (navigator.vibrate) navigator.vibrate(200); }
});

// ===== КОТ =====
socket.on('cat-in-bag', (data) => {
  hideAllScreens();
  document.getElementById('cat-screen').classList.remove('hidden');
  document.getElementById('cat-theme').textContent = `Тема: ${data.catTheme}`;
  document.getElementById('cat-value').textContent = `Стоимость: ${data.value}`;
  const sel = document.getElementById('cat-select-area');
  if (data.choosingPlayer === myId) {
    let html = '<div style="margin-top:20px;font-size:18px;">Выберите игрока:</div><div class="player-select-grid">';
    let count = 0;
    data.players.forEach(p => {
      if (p.id === myId) return;
      html += `<div class="player-select-btn" onclick="selectCatPlayer('${p.id}')"><div class="name">${esc(p.name)}</div><div class="score">${p.score}</div></div>`;
      count++;
    });
    if (count === 0) data.players.forEach(p => { html += `<div class="player-select-btn" onclick="selectCatPlayer('${p.id}')"><div class="name">${esc(p.name)}</div><div class="score">${p.score}</div></div>`; });
    html += '</div>';
    sel.innerHTML = html;
  } else {
    sel.innerHTML = `<div style="margin-top:20px;font-size:18px;color:var(--text-secondary);">${esc(data.choosingPlayerName)} выбирает...</div>`;
  }
});

socket.on('auto-cat-in-bag', (data) => {
  showNotification(`🐱 Кот в мешке! ${data.catTheme}. Отвечает: ${data.targetPlayerName}`, 'info', 3000);
});

function selectCatPlayer(id) { socket.emit('cat-select-player', { playerId: id }); }

// ===== АУКЦИОН =====
socket.on('auction-start', (data) => {
  hideAllScreens();
  document.getElementById('auction-screen').classList.remove('hidden');
  document.getElementById('auction-info').textContent = `Мин. ставка: ${data.value}`;
  document.getElementById('auction-controls').classList.remove('hidden');
  document.getElementById('auction-waiting').classList.add('hidden');
  const mp = data.players.find(p => p.id === myId);
  const inp = document.getElementById('auction-bet-input');
  inp.min = data.value; inp.max = Math.max(mp?.score || 0, data.value); inp.value = data.value;
});

socket.on('auto-auction', (data) => { showNotification(`💰 Аукцион! ${data.category}`, 'info', 2000); });

function placeBet() {
  const b = parseInt(document.getElementById('auction-bet-input').value);
  if (isNaN(b) || b < 0) { showNotification('Ошибка ставки!', 'error'); return; }
  socket.emit('auction-bet', { bet: b });
  document.getElementById('auction-controls').classList.add('hidden');
  document.getElementById('auction-waiting').classList.remove('hidden');
}
function allIn() { socket.emit('auction-bet', { allIn: true }); document.getElementById('auction-controls').classList.add('hidden'); document.getElementById('auction-waiting').classList.remove('hidden'); }
function passBet() { socket.emit('auction-bet', { pass: true }); document.getElementById('auction-controls').classList.add('hidden'); document.getElementById('auction-waiting').classList.remove('hidden'); }

socket.on('auction-result', (data) => { showNotification(data.winnerId === myId ? `💰 Вы: ${data.bet}` : `💰 ${data.winnerName}: ${data.bet}`, 'info', 3000); });
socket.on('auction-bet-placed', () => {});

// ===== РАУНДЫ =====
socket.on('round-complete', (data) => { players = data.players; showNotification('🏁 Раунд завершён!', 'info', 3000); });
socket.on('new-round', (data) => {
  gameState = 'playing'; players = data.players; choosingPlayer = data.choosingPlayer; amChoosing = (choosingPlayer === myId);
  hideAllScreens(); document.getElementById('game-board-screen').classList.remove('hidden');
  renderBoard(data.round); renderPlayersBar(); updateChoosingInfo(data.choosingPlayerName);
  showNotification(`🎯 ${data.round.name}`, 'info', 3000);
});

// ===== ФИНАЛ =====
socket.on('final-round', (data) => {
  hideAllScreens(); document.getElementById('final-screen').classList.remove('hidden');
  document.getElementById('final-theme').textContent = `Тема: ${data.theme}`;
  players = data.players; renderPlayersBar();
  const ok = data.eligiblePlayers.includes(myId);
  document.getElementById('final-bet-area').classList.toggle('hidden', !ok);
  document.getElementById('final-question-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.toggle('hidden', ok);
  if (ok) { const mp = players.find(p => p.id === myId); document.getElementById('my-score-final').textContent = mp?.score || 0; document.getElementById('final-bet-input').max = Math.max(mp?.score || 0, 0); }
});

function placeFinalBet() {
  const b = parseInt(document.getElementById('final-bet-input').value);
  if (isNaN(b) || b < 0) { showNotification('Ошибка!', 'error'); return; }
  socket.emit('final-bet', { bet: b });
}

socket.on('final-bet-accepted', (data) => {
  showNotification(`Ставка: ${data.bet}`, 'success');
  document.getElementById('final-bet-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML = '<div style="font-size:20px;color:var(--text-secondary);">Ожидание...</div>';
});

socket.on('final-question', (data) => {
  document.getElementById('final-bet-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.add('hidden');
  document.getElementById('final-question-area').classList.remove('hidden');
  document.getElementById('final-q-text').textContent = data.text;
  let tl = data.timeLimit; const te = document.getElementById('final-timer'); te.textContent = tl;
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  finalTimerInterval = setInterval(() => { tl--; te.textContent = tl; if (tl <= 10) te.style.color = 'var(--danger)'; if (tl <= 0) { clearInterval(finalTimerInterval); submitFinalAnswer(); } }, 1000);
});

function submitFinalAnswer() {
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  socket.emit('final-answer', { answer: document.getElementById('final-answer-input').value.trim() });
  document.getElementById('final-question-area').classList.add('hidden');
  document.getElementById('final-waiting-area').classList.remove('hidden');
  document.getElementById('final-waiting-area').innerHTML = '<div style="font-size:20px;color:var(--text-secondary);animation:pulse 2s infinite;">Проверка ответов...</div>';
}

socket.on('final-waiting', (data) => {
  document.getElementById('final-question-area')?.classList.add('hidden');
  const wa = document.getElementById('final-waiting-area');
  if (wa) { wa.classList.remove('hidden'); wa.innerHTML = `<div style="font-size:20px;color:var(--text-secondary);animation:pulse 2s infinite;">${esc(data.message)}</div>`; }
});

socket.on('auto-final-results', (data) => {
  let msg = `Ответ: ${data.correctAnswer}\n`;
  data.results.forEach(r => { msg += `${r.correct ? '✅' : '❌'} ${r.playerName}: "${r.answer}"\n`; });
  showNotification(msg, 'info', 8000);
});

// ===== GAME OVER =====
socket.on('game-over', (data) => {
  if (finalTimerInterval) clearInterval(finalTimerInterval);
  clearAnswerTimer(); clearQuestionTimer();
  localStorage.removeItem(`session_${roomId}`);
  hideAllScreens();
  const s = document.getElementById('results-screen'); s.classList.remove('hidden');
  let h = '<div class="results-title">🏆 Итоги игры</div>';
  if (data.players.length >= 1) {
    h += '<div class="podium">';
    if (data.players[1]) h += `<div class="podium-place second"><div class="podium-name">${esc(data.players[1].name)}</div><div class="podium-score">${data.players[1].score}</div><div class="podium-bar second"><div class="podium-position">2</div></div></div>`;
    const w = data.players[0].id === myId;
    h += `<div class="podium-place first"><div class="podium-name">${w?'👑 ':''}${esc(data.players[0].name)}${w?' (ВЫ!)':''}</div><div class="podium-score">${data.players[0].score}</div><div class="podium-bar first"><div class="podium-position">1</div></div></div>`;
    if (data.players[2]) h += `<div class="podium-place third"><div class="podium-name">${esc(data.players[2].name)}</div><div class="podium-score">${data.players[2].score}</div><div class="podium-bar third"><div class="podium-position">3</div></div></div>`;
    h += '</div>';
  }
  h += '<div style="max-width:500px;width:100%;">';
  data.players.forEach((p,i) => { const m = p.id === myId; h += `<div style="display:flex;align-items:center;gap:15px;padding:12px;background:rgba(255,255,255,${m?'0.1':'0.05'});border-radius:10px;margin:5px 0;${m?'border:2px solid var(--secondary);':''}"><div style="font-family:'Russo One';font-size:20px;color:var(--text-secondary);width:30px;">${i+1}</div><div class="player-bar-avatar" style="background:${p.avatarColor}">${p.name[0].toUpperCase()}</div><div style="flex:1;font-weight:700;">${esc(p.name)} ${m?'(Вы)':''}</div><div class="player-bar-score ${p.score<0?'negative':''}">${p.score}</div></div>`; });
  h += '</div>';
  h += '<button class="btn btn-primary btn-large" onclick="window.location.href=\'/\'" style="margin-top:30px;">🏠 На главную</button>';
  s.innerHTML = h;
  if (data.players[0]?.id === myId && navigator.vibrate) navigator.vibrate([200,100,200,100,200]);
});

// ===== ПАНЕЛЬ ИГРОКОВ =====
function renderPlayersBar() {
  const bar = document.getElementById('players-bar'); if (!bar) return;
  bar.innerHTML = '';
  players.forEach(p => {
    const m = p.id === myId;
    const item = document.createElement('div');
    item.className = 'player-bar-item'; item.id = `player-bar-${p.id}`;
    if (p.id === choosingPlayer) item.classList.add('choosing');
    if (m) item.style.borderColor = 'rgba(255,214,0,0.5)';
    item.innerHTML = `<div class="player-bar-avatar" style="background:${p.avatarColor}">${p.name[0].toUpperCase()}</div><div class="player-bar-info"><div class="player-bar-name">${esc(p.name)}${m?' ⭐':''}${!p.connected?' 🔴':''}</div><div class="player-bar-score ${p.score<0?'negative':''}">${p.score}</div></div>`;
    bar.appendChild(item);
  });
}

function highlightPlayer(id, type) {
  const el = document.getElementById(`player-bar-${id}`);
  if (el) { el.classList.remove('choosing','answering','correct','wrong'); el.classList.add(type); setTimeout(() => el.classList.remove(type), 2000); }
}

// ===== ЧАТ =====
function toggleChat() { const c = document.getElementById('chat'); c.classList.toggle('minimized'); document.getElementById('chat-toggle-btn').textContent = c.classList.contains('minimized') ? '+' : '−'; }
function sendChat() { const i = document.getElementById('chat-input'); const m = i.value.trim(); if (m) { socket.emit('chat-message', { message: m }); i.value = ''; } }
document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
socket.on('chat-message', (data) => { const c = document.getElementById('chat-messages'); const d = document.createElement('div'); d.className = 'chat-message'; d.innerHTML = `<span class="name">${esc(data.name)}:</span> <span class="text">${esc(data.message)}</span>`; c.appendChild(d); c.scrollTop = c.scrollHeight; });

socket.on('auto-countdown', (data) => { showNotification(`🤖 ${data.message}`, 'info', data.seconds * 1000); });

// ===== УТИЛИТЫ =====
function hideAllScreens() {
  ['lobby','game-board-screen','question-screen','cat-screen','auction-screen','final-screen','results-screen'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
}
function esc(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function showNotification(msg, type = 'info', dur = 3000) {
  const ex = document.querySelector('.notification'); if (ex) ex.remove();
  const n = document.createElement('div'); n.className = `notification ${type}`; n.textContent = msg;
  document.body.appendChild(n); setTimeout(() => n.remove(), dur);
}
socket.on('error-msg', d => showNotification(d.message, 'error'));
socket.on('host-disconnected', () => showNotification('⚠️ Ведущий отключился!', 'error', 10000));
socket.on('player-disconnected', d => { players = d.players; renderPlayersBar(); });
