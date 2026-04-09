'use strict';

const log = (...args) => console.log('[VidSync popup]', ...args);
log('popup loaded');

// ---------- State ----------

let state = {
  room: null,
  isHost: false,
  peerCount: 0,
  connected: false,
  connecting: false,
};

// ---------- Background port (live updates) ----------

let port;
try {
  port = chrome.runtime.connect({ name: 'popup' });
  log('port connected to background');
  port.onMessage.addListener((msg) => {
    log('port msg from bg:', msg);
    if (msg.type === 'status-update') {
      Object.assign(state, msg);
      render();
    }
  });
  port.onDisconnect.addListener(() => {
    log('port disconnected from background (bg may have crashed):', chrome.runtime.lastError?.message);
  });
} catch (e) {
  log('failed to connect port to background:', e.message);
}

// ---------- Render ----------

function render() {
  const main = document.getElementById('main');

  if (state.connecting) {
    main.innerHTML = `
      <p class="hint" style="text-align:center">
        <span class="spinner"></span>Connecting…
      </p>
    `;
    return;
  }

  if (!state.room) {
    main.innerHTML = `
      <p class="hint">Watch any video and start a session. Share the link — your friend joins instantly, no account needed.</p>
      <button class="btn-primary" id="startBtn">Start Session</button>
      <div id="error-msg"></div>
    `;
    document.getElementById('startBtn').onclick = startSession;
    return;
  }

  // In session
  const dotClass = state.connected ? 'green' : 'amber';
  const statusText = state.connected
    ? (state.isHost ? 'Host · Connected' : 'Guest · Connected')
    : 'Reconnecting…';
  const peerText = state.peerCount === 0
    ? 'Waiting for peers…'
    : `${state.peerCount} peer${state.peerCount !== 1 ? 's' : ''} connected`;

  main.innerHTML = `
    <div class="status-row">
      <div class="dot ${dotClass}"></div>
      <span>${statusText}</span>
    </div>
    <div class="meta">
      <div class="meta-row">
        <span>Room</span>
        <span>${state.room}</span>
      </div>
      <div class="meta-row">
        <span>Peers</span>
        <span>${peerText}</span>
      </div>
    </div>
    <button class="btn-ghost" id="copyBtn">Copy Invite Link</button>
    <button class="btn-danger" id="leaveBtn">Leave Session</button>
    <div id="error-msg"></div>
  `;

  document.getElementById('copyBtn').onclick = copyLink;
  document.getElementById('leaveBtn').onclick = leaveSession;
}

// ---------- Actions ----------

async function startSession() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    showError('Could not read the current tab.');
    return;
  }

  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
    showError('VidSync only works on regular web pages.');
    return;
  }

  const roomId    = generateRoomId();
  const hostToken = generateRoomId(); // secret token — only the host knows it
  log('startSession  room=%s  tabId=%s  url=%s', roomId, tab.id, tab.url);
  state.connecting = true;
  render();

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'start-session', room: roomId, hostToken, tabId: tab.id });
    log('start-session response:', resp);
    state.room = roomId;
    state.connecting = false;
    render();
  } catch (e) {
    log('start-session sendMessage threw:', e.message);
    state.connecting = false;
    showError('Failed to reach background. Check about:debugging.');
    render();
  }
}

async function copyLink() {
  if (!state.room) return;

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { return; }

  if (!tab?.url) return;

  const url = new URL(tab.url);
  url.searchParams.set('sync', state.room);
  const shareUrl = url.toString();

  try {
    await navigator.clipboard.writeText(shareUrl);
    const btn = document.getElementById('copyBtn');
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { if (btn) btn.textContent = 'Copy Invite Link'; }, 2000);
    }
  } catch (_) {
    showError('Could not copy to clipboard.');
  }
}

async function leaveSession() {
  await chrome.runtime.sendMessage({ type: 'leave-session' }).catch(() => {});
  state = { room: null, isHost: false, peerCount: 0, connected: false, connecting: false };
  render();
}

// ---------- Helpers ----------

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) el.textContent = msg;
}

function generateRoomId() {
  const seg = () => Math.random().toString(36).slice(2, 5).padStart(3, '0');
  return `${seg()}-${seg()}-${seg()}`;
}

// ---------- Init ----------

render(); // Show idle state immediately; port will push live status shortly
