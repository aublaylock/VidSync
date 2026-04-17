'use strict';

// Development: 'wss://localhost:8443'  (Firefox requires WSS even for localhost)
// Production:  'wss://vidsync-xqk0.onrender.com'
const SERVER_URL = 'wss://vidsync-xqk0.onrender.com';

let ws = null;
let room = null;
let hostToken = null; // only set on the host's browser; null for guests
let isHost = false;
let myId = null;
let peerCount = 0;
let activeTabId = null;
let reconnectTimer = null;
let popupPort = null;

const log = (...args) => console.log('[VidSync bg]', ...args);

// This fires the instant the background script loads — if you don't see this
// line in about:debugging → Inspect, the script isn't running at all.
log('background script loaded, SERVER_URL =', SERVER_URL);

// ---------- State persistence across SW restarts ----------

async function saveState() {
  try {
    await chrome.storage.session.set({ room, hostToken, activeTabId, isHost });
  } catch (e) {
    log('saveState failed (storage.session unavailable?):', e.message);
  }
}

async function restoreState() {
  try {
    const data = await chrome.storage.session.get(['room', 'hostToken', 'activeTabId', 'isHost']);
    log('restoreState ->', data);
    if (data.room) {
      room = data.room;
      hostToken = data.hostToken ?? null;
      activeTabId = data.activeTabId ?? null;
      isHost = data.isHost ?? false;
      connect();
    }
  } catch (e) {
    log('restoreState failed (storage.session unavailable?):', e.message);
  }
}

// ---------- WebSocket management ----------

function ensureConnected() {
  if (!room) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log('ensureConnected: WS dead, reconnecting');
  connect();
}

function connect() {
  if (!room) return;
  clearTimeout(reconnectTimer);

  log(`connect() -> ${SERVER_URL}  room=${room}`);

  try {
    ws = new WebSocket(SERVER_URL);
  } catch (e) {
    log('new WebSocket() threw:', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log('WS open, joining room', room, hostToken ? '(host)' : '(guest)');
    ws.send(JSON.stringify({ type: 'join', room, ...(hostToken ? { hostToken } : {}) }));
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    log('WS recv:', msg);
    handleServerMessage(msg);
  };

  ws.onclose = (evt) => {
    log(`WS closed  code=${evt.code}  reason="${evt.reason}"  wasClean=${evt.wasClean}`);
    notifyTab({ type: 'connection-lost' });
    if (room) scheduleReconnect();
  };

  ws.onerror = (evt) => {
    log('WS error:', evt.message ?? evt.type);
  };
}

function scheduleReconnect() {
  log('scheduling reconnect in 3s');
  reconnectTimer = setTimeout(connect, 3000);
}

function sendToServer(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    log('sendToServer: WS not open (state=' + ws?.readyState + '), dropping', msg.type);
  }
}

// ---------- Server message handling ----------

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'joined':
      isHost = msg.isHost;
      myId = msg.id;
      peerCount = msg.peers;
      saveState();
      notifyTab({ type: 'session-started', room, isHost, peerCount });
      notifyPopup({ room, isHost, peerCount, connected: true });
      break;

    case 'peer-joined':
      peerCount++;
      notifyTab({ type: 'peer-joined', peerCount });
      notifyPopup({ peerCount });
      break;

    case 'peer-left':
      peerCount = Math.max(0, peerCount - 1);
      notifyTab({ type: 'peer-left', peerCount, wasHost: msg.wasHost });
      notifyPopup({ peerCount });
      break;

    case 'promoted-to-host':
      isHost = true;
      saveState();
      notifyTab({ type: 'promoted-to-host' });
      notifyPopup({ isHost: true });
      break;

    case 'play':
    case 'pause':
    case 'seek':
    case 'heartbeat':
      notifyTab(msg);
      break;

    // Host handles guest requests and rebroadcasts as authoritative commands
    case 'request-play':
    case 'request-pause':
    case 'request-seek':
      if (isHost) {
        const cmdType = msg.type.replace('request-', '');
        const cmd = { type: cmdType, t: msg.t };
        sendToServer(cmd);   // Broadcast to all guests
        notifyTab(cmd);      // Apply to host's own video (with suppression in CS)
      }
      break;
  }
}

function notifyTab(msg) {
  if (activeTabId != null) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
  }
}

function notifyPopup(update) {
  if (popupPort) {
    popupPort.postMessage({ type: 'status-update', ...update });
  }
}

// ---------- Keep-alive (MV3 service worker) ----------

// Long-lived port from content script keeps SW alive while the page is open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    // Send current status immediately to the newly opened popup
    popupPort.postMessage({
      type: 'status-update',
      room,
      isHost,
      peerCount,
      connected: ws?.readyState === WebSocket.OPEN,
    });
    port.onDisconnect.addListener(() => { popupPort = null; });
    return;
  }

  if (port.name === 'keep-alive') {
    port.onDisconnect.addListener(() => {
      // Tab closed or navigated away
    });
  }
});

// Alarm as secondary keep-alive (fires every ~24s)
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') ensureConnected();
});

// ---------- Extension message handler ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  log('msg from', sender.tab ? `tab ${senderTabId}` : 'popup/bg', '->', msg.type);

  switch (msg.type) {
    case 'start-session':
      room = msg.room;
      hostToken = msg.hostToken ?? null;
      activeTabId = msg.tabId ?? senderTabId;
      isHost = true;
      log('start-session  room=%s  activeTabId=%s', room, activeTabId);
      connect();
      sendResponse({ ok: true });
      break;

    case 'join-session':
      room = msg.room;
      hostToken = null; // guests never have the host token
      activeTabId = senderTabId;
      log('join-session  room=%s  activeTabId=%s', room, activeTabId);
      connect();
      sendResponse({ ok: true });
      break;

    case 'leave-session':
      room = null;
      isHost = false;
      peerCount = 0;
      myId = null;
      clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
      chrome.storage.session.clear();
      notifyPopup({ room: null, isHost: false, peerCount: 0, connected: false });
      sendResponse({ ok: true });
      break;

    case 'get-status':
      sendResponse({
        room,
        isHost,
        myId,
        peerCount,
        connected: ws?.readyState === WebSocket.OPEN,
      });
      break;

    // Video control events forwarded from content script to server
    case 'play':
    case 'pause':
    case 'seek':
    case 'heartbeat':
    case 'request-play':
    case 'request-pause':
    case 'request-seek':
      sendToServer(msg);
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'unknown message type' });
  }

  return true; // Keep channel open for async sendResponse
});

// Restore state if SW was terminated while in a session
restoreState();
