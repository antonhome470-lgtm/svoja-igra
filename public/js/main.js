const socket = io();

function showModal(type) {
  document.getElementById(`modal-${type}`).classList.remove('hidden');
  const inputIds = { host: 'host-name', player: 'player-name', auto: 'auto-name' };
  const input = document.getElementById(inputIds[type]);
  if (input) setTimeout(() => input.focus(), 100);
}

function hideModal(type) {
  document.getElementById(`modal-${type}`).classList.add('hidden');
}

function closeModal(event, type) {
  if (event.target.classList.contains('modal-overlay')) {
    hideModal(type);
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

// Создание обычной комнаты (ведущий)
function createRoom() {
  const name = document.getElementById('host-name').value.trim();
  if (!name) { showNotification('Введите имя!', 'error'); return; }

  const useCustom = sessionStorage.getItem('useCustomQuestions');
  const customQuestions = sessionStorage.getItem('customQuestions');

  const data = { name };
  if (useCustom && customQuestions) {
    data.customQuestions = JSON.parse(customQuestions);
    sessionStorage.removeItem('useCustomQuestions');
  }

  socket.emit('create-room', data);
}

// Создание авто-комнаты (бот-ведущий)
function createAutoRoom() {
  const name = document.getElementById('auto-name').value.trim();
  if (!name) { showNotification('Введите имя!', 'error'); return; }

  const useCustom = sessionStorage.getItem('useCustomQuestions');
  const customQuestions = sessionStorage.getItem('customQuestions');

  const data = { playerName: name, autoHost: true };
  if (useCustom && customQuestions) {
    data.customQuestions = JSON.parse(customQuestions);
    sessionStorage.removeItem('useCustomQuestions');
  }

  socket.emit('create-auto-room', data);
}

socket.on('room-created', (data) => {
  sessionStorage.setItem('hostData', JSON.stringify(data));
  window.location.href = `/host.html?room=${data.roomId}`;
});

socket.on('auto-room-created', (data) => {
  // Переходим как игрок в авто-комнату
  window.location.href = `/game.html?room=${data.roomId}&name=${encodeURIComponent(data.playerName)}&auto=1`;
});

function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!name) { showNotification('Введите имя!', 'error'); return; }
  if (!code || code.length < 4) { showNotification('Введите код комнаты!', 'error'); return; }

  window.location.href = `/game.html?room=${code}&name=${encodeURIComponent(name)}`;
}

// Enter
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!document.getElementById('modal-host').classList.contains('hidden')) createRoom();
    else if (!document.getElementById('modal-player').classList.contains('hidden')) joinRoom();
    else if (!document.getElementById('modal-auto').classList.contains('hidden')) createAutoRoom();
  }
});

// Из редактора
(function checkCustom() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('custom') === '1') {
    showModal('auto');
    showNotification('📝 Свои вопросы загружены! Выберите режим игры.', 'success', 5000);
  }
})();

socket.on('error-msg', (data) => showNotification(data.message, 'error'));
