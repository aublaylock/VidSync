'use strict';

(function () {
  if (window.__vidSyncLoaded) return;
  window.__vidSyncLoaded = true;

  const isTopFrame = window === window.top;

  // ---------- State ----------

  let video = null;
  let inSession = false;
  let isHost = false;
  let heartbeatInterval = null;
  let applyingRemote = false;
  let suppressTimer = null;

  function setApplyingRemote(ms = 800) {
    applyingRemote = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { applyingRemote = false; }, ms);
  }

  // ---------- Init ----------

  function init() {
    if (isTopFrame) {
      // Keep-alive port and session join only from top frame
      try { chrome.runtime.connect({ name: 'keep-alive' }); } catch (_) {}

      const syncRoom = new URLSearchParams(window.location.search).get('sync');
      if (syncRoom) {
        inSession = true;
        chrome.runtime.sendMessage({ type: 'join-session', room: syncRoom }).catch(() => {});
      }

      // Top frame receives commands from background and fans them out to child iframes
      chrome.runtime.onMessage.addListener(onBackgroundMessage);
    }

    // All frames: receive commands relayed down from the parent frame
    window.addEventListener('message', onParentMessage);

    findVideo();
  }

  // ---------- Video discovery ----------

  function findVideo() {
    const found = document.querySelector('video');
    if (found) { attachToVideo(found); return; }

    const observer = new MutationObserver(() => {
      const v = document.querySelector('video');
      if (v && v !== video) { observer.disconnect(); attachToVideo(v); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function attachToVideo(v) {
    if (video === v) return;
    video = v;
    v.addEventListener('play',   onLocalPlay);
    v.addEventListener('pause',  onLocalPause);
    v.addEventListener('seeked', onLocalSeeked);
    // If session already active by the time video is found, start heartbeat
    if (inSession && isHost) startHeartbeat();
  }

  // ---------- Local video event handlers ----------
  // chrome.runtime.sendMessage works from any frame directly to the background.

  function onLocalPlay()   { if (!applyingRemote && inSession) send(isHost ? 'play'  : 'request-play',  video.currentTime); }
  function onLocalPause()  { if (!applyingRemote && inSession) send(isHost ? 'pause' : 'request-pause', video.currentTime); }
  function onLocalSeeked() { if (!applyingRemote && inSession) send(isHost ? 'seek'  : 'request-seek',  video.currentTime); }

  function send(type, t) {
    chrome.runtime.sendMessage({ type, t }).catch(() => {});
  }

  // ---------- Apply a remote command to the local video ----------

  function applyCommand(msg) {
    if (!video) return;
    setApplyingRemote(800);
    switch (msg.type) {
      case 'play':
        video.currentTime = msg.t;
        video.play().catch(() => {});
        break;
      case 'pause':
        video.currentTime = msg.t;
        video.pause();
        break;
      case 'seek':
        if (Math.abs(video.currentTime - msg.t) > 0.1) video.currentTime = msg.t;
        break;
      case 'heartbeat':
        if (Math.abs(video.currentTime - msg.t) > 0.5) video.currentTime = msg.t;
        break;
    }
  }

  // ---------- Relay a message into every direct child iframe ----------
  // Each iframe's content.js will re-relay to its own children, handling
  // arbitrary nesting depth without any extra logic here.

  function relayDown(msg) {
    for (const iframe of document.querySelectorAll('iframe')) {
      try { iframe.contentWindow.postMessage({ __vidSync: true, ...msg }, '*'); } catch (_) {}
    }
  }

  // ---------- Message from background (top frame only) ----------

  function onBackgroundMessage(msg) {
    switch (msg.type) {
      case 'session-started':
        inSession = true;
        isHost = msg.isHost;
        if (!new URLSearchParams(window.location.search).has('sync')) {
          const url = new URL(window.location.href);
          url.searchParams.set('sync', msg.room);
          history.replaceState(null, '', url.toString());
        }
        if (isHost && video) startHeartbeat();
        showIndicatorOrToast(msg);
        relayDown(msg); // iframes learn about the session
        break;

      case 'promoted-to-host':
        isHost = true;
        if (video) startHeartbeat();
        showToast('You are now the host');
        relayDown(msg);
        break;

      case 'play':
      case 'pause':
      case 'seek':
        if (!isHost) { applyCommand(msg); relayDown(msg); }
        break;

      case 'heartbeat':
        applyCommand(msg);
        relayDown(msg);
        break;

      case 'peer-joined':
        showToast(`Peer connected · ${msg.peerCount} in session`);
        break;

      case 'peer-left':
        showToast(msg.wasHost ? 'Host left — you are now the host' : 'Peer disconnected');
        break;

      case 'connection-lost':
        showToast('VidSync: reconnecting…');
        break;
    }
  }

  // ---------- Message relayed from parent frame ----------

  function onParentMessage(event) {
    const msg = event.data;
    if (!msg || msg.__vidSync !== true) return;

    switch (msg.type) {
      case 'session-started':
        inSession = true;
        isHost = msg.isHost;
        if (isHost && video) startHeartbeat();
        break;

      case 'promoted-to-host':
        isHost = true;
        if (video) startHeartbeat();
        break;

      case 'play':
      case 'pause':
      case 'seek':
        if (!isHost) applyCommand(msg);
        break;

      case 'heartbeat':
        applyCommand(msg);
        break;
    }

    // Relay further down for nested iframes
    relayDown(msg);
  }

  // ---------- Heartbeat (host only, sent from whichever frame has the video) ----------

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (video && inSession) send('heartbeat', video.currentTime);
    }, 5000);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // ---------- UI (top frame only — iframes are typically tiny/hidden) ----------

  function showIndicatorOrToast(msg) {
    if (!isTopFrame) return;
    if (!video) showToast('VidSync active — video is in a page frame');
    else showIndicator(msg.isHost ? 'Host' : 'Guest');
  }

  function showIndicator(role) {
    if (!isTopFrame) return;
    const id = 'vidsync-indicator';
    document.getElementById(id)?.remove();
    const el = make('div', id, `
      position:fixed;top:16px;right:16px;
      background:rgba(10,10,20,0.88);color:#e2e8f0;
      padding:6px 14px;border-radius:20px;
      font:600 12px/1.5 system-ui,sans-serif;letter-spacing:.02em;
      z-index:2147483647;pointer-events:none;
      border:1px solid rgba(255,255,255,0.08);box-shadow:0 2px 8px rgba(0,0,0,.4);
    `);
    el.textContent = `VidSync · ${role}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function showToast(message) {
    if (!isTopFrame) return;
    const el = make('div', null, `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
      background:rgba(10,10,20,0.92);color:#e2e8f0;
      padding:10px 20px;border-radius:10px;
      font:13px/1.5 system-ui,sans-serif;
      z-index:2147483647;pointer-events:none;
      border:1px solid rgba(255,255,255,0.08);box-shadow:0 4px 16px rgba(0,0,0,.5);
      transition:opacity 0.4s;
    `);
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 3200);
  }

  function make(tag, id, css) {
    const el = document.createElement(tag);
    if (id) el.id = id;
    el.style.cssText = css;
    return el;
  }

  // ---------- Go ----------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
