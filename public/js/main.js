const socket = io();

// ===== УТИЛИТЫ =====
function showModal(type) {
  document.getElementById(`modal-${type}`).classList.remove('hidden');
  const input = type === 'host' ? document.getElementById('host-name') : document.getElementById('player-name');
  setTimeout(() => input.focus(), 100);
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

// ===== СОЗДАНИЕ КОМНАТЫ =====
function createRoom() {
  const name = document.getElementById('host-name').value.trim();
  if (!name) {
    showNotification('Введите ваше имя!', 'error');
    return;
  }

  // Проверяем, есть ли кастомные вопросы
  const useCustom = sessionStorage.getItem('useCustomQuestions');
  const customQuestions = sessionStorage.getItem('customQuestions');

  const data = { name };
  if (useCustom && customQuestions) {
    data.customQuestions = JSON.parse(customQuestions);
    sessionStorage.removeItem('useCustomQuestions');
    // НЕ удаляем customQuestions — пригодится для повторной игры
  }

  socket.emit('create-room', data);
}

// Если пришли из редактора — сразу показываем модалку ведущего
(function checkCustom() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('custom') === '1') {
    showModal('host');
    showNotification('📝 Свои вопросы загружены! Введите имя и создайте игру.', 'success', 5000);
  }
})();

// ===== ПРИСОЕДИНЕНИЕ =====
function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();

  if (!name) {
    showNotification('Введите ваше имя!', 'error');
    return;
  }
  if (!code || code.length < 4) {
    showNotification('Введите код комнаты!', 'error');
    return;
  }

  sessionStorage.setItem('playerData', JSON.stringify({ name, roomId: code }));
  window.location.href = `/game.html?room=${code}&name=${encodeURIComponent(name)}`;
}

// ===== ОБРАБОТКА ENTER =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const hostModal = document.getElementById('modal-host');
    const playerModal = document.getElementById('modal-player');

    if (!hostModal.classList.contains('hidden')) {
      createRoom();
    } else if (!playerModal.classList.contains('hidden')) {
      joinRoom();
    }
  }
});

// ===== ОШИБКИ =====
socket.on('error-msg', (data) => {
  showNotification(data.message, 'error');
});
