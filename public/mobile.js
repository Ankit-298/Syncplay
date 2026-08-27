const socket = io();

// ─── DOM REFS ─────────────────────────────────────────────────
const hostStatus       = document.getElementById('hostStatus');
const statusLabel      = document.getElementById('statusLabel');
const clientCountEl    = document.getElementById('clientCount');
const clientList       = document.getElementById('clientList');
const deviceBadge      = document.getElementById('deviceBadge');

const mobileLiveBtn      = document.getElementById('mobileLiveBtn');
const mobileLiveFileInput= document.getElementById('mobileLiveFileInput');
const mobileActiveControls = document.getElementById('mobileActiveControls');

const mobileNpTitle     = document.getElementById('mobileNpTitle');
const trackStatusLine   = document.getElementById('trackStatusLine');
const trackStatusText   = document.getElementById('trackStatusText');
const mobileProgTrack   = document.getElementById('mobileProgTrack');
const mobileProgFill    = document.getElementById('mobileProgFill');
const mobileProgThumb   = document.getElementById('mobileProgThumb');
const mobileTimeElapsed = document.getElementById('mobileTimeElapsed');
const mobileTimeDuration= document.getElementById('mobileTimeDuration');
const mobileTimeRemaining=document.getElementById('mobileTimeRemaining');

const mobilePlayPauseBtn= document.getElementById('mobilePlayPauseBtn');
const mobilePlayIcon    = document.getElementById('mobilePlayIcon');
const mobileSeekBackBtn = document.getElementById('mobileSeekBackBtn');
const mobileSeekFwdBtn  = document.getElementById('mobileSeekFwdBtn');
const mobileStopBtn     = document.getElementById('mobileStopBtn');

const mobileVizIdle    = document.getElementById('mobileVizIdle');
const mobileWaveCanvas = document.getElementById('mobileWaveCanvas');
const mobileWaveCtx    = mobileWaveCanvas ? mobileWaveCanvas.getContext('2d') : null;
const mobileAudioPlayer= document.getElementById('mobileAudioPlayer');
const albumThumb       = document.querySelector('.m-album-thumb');
const volumeSlider     = document.getElementById('volumeSlider');
const volPct           = document.getElementById('volPct');

const showQrBtn  = document.getElementById('showQrBtn');
const closeQrBtn = document.getElementById('closeQrBtn');
const qrModal    = document.getElementById('qrModal');
const qrCodeImg  = document.getElementById('qrCodeImg');

// Playlist DOM refs
const playlistToggleBtn = document.getElementById('playlistToggleBtn');
const playlistPanel     = document.getElementById('playlistPanel');
const playlistList      = document.getElementById('playlistList');
const playlistBadge     = document.getElementById('playlistBadge');
const playlistCount     = document.getElementById('playlistCount');
const playlistClearBtn  = document.getElementById('playlistClearBtn');

// ─── STATE ────────────────────────────────────────────────────
let connectedClients = [];
let peerConnections  = {};
let localStream      = null;
let isPaused         = false;
let mobileWaveAnimId = null;
let mobileFakeWaveT  = 0;
let timeOffset       = 0;
let rtt              = 0;
let playTimeout      = null;
let progressRAF      = null;

// Playlist state
let playlist         = [];  // Array of { file: File, name: string, url: string }
let currentTrackIdx  = -1;
let playlistVisible  = false;

const PLAY_SVG  = `<polygon points="5 3 19 12 5 21 5 3"/>`;
const PAUSE_SVG = `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`;

// Volume
if (volumeSlider) {
  volumeSlider.addEventListener('input', () => {
    const v = volumeSlider.value;
    mobileAudioPlayer.volume = v / 100;
    if (volPct) volPct.textContent = v + '%';
    // Update track fill colour dynamically
    volumeSlider.style.background = `linear-gradient(to right, #8b5cf6 0%, #22d3ee ${v}%, rgba(255,255,255,.08) ${v}%)`;
  });
}

// ─── TIME SYNC ────────────────────────────────────────────────
function syncTime() { socket.emit('time-sync-request', { clientSendTime: Date.now() }); }
setInterval(syncTime, 5000); syncTime();
socket.on('time-sync-response', (data) => {
  const now = Date.now();
  rtt = now - data.clientSendTime;
  timeOffset = (data.serverTime + rtt / 2) - now;
});
function getServerTime() { return Date.now() + timeOffset; }

// ─── SOCKET REGISTRATION ──────────────────────────────────────
const roomCode = Math.random().toString(36).substring(2, 8); // Generate 6-char room code
socket.emit('register-host', { room: roomCode });

socket.on('host-registered', () => {
  hostStatus.className = 'm-status-chip connected';
  statusLabel.textContent = 'Online';
});

socket.on('client-connected', (id) => {
  if (!connectedClients.includes(id)) {
    connectedClients.push(id);
    updateClientCount();
    
    if (clientList && !document.getElementById(`client-${id}`)) {
      const emptyState = clientList.querySelector('.m-empty-state');
      if (emptyState) emptyState.remove();
      const li = document.createElement('li');
      li.id = `client-${id}`;
      li.innerHTML = `<span class="client-id">Device ${id.substring(0,5).toUpperCase()}</span><span class="client-status">connected</span>`;
      clientList.appendChild(li);
    }
    
    if (localStream) createPeerConnection(id);
  }
});

socket.on('client-disconnected', (id) => {
  connectedClients = connectedClients.filter(c => c !== id);
  if (peerConnections[id]) { peerConnections[id].close(); delete peerConnections[id]; }
  updateClientCount();
  
  if (clientList) {
    const li = document.getElementById(`client-${id}`);
    if (li) li.remove();
    if (clientList.children.length === 0) {
      clientList.innerHTML = `<li class="m-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg><span>No devices. Ask friends to join your hotspot.</span></li>`;
    }
  }
});

function updateClientCount() {
  if (clientCountEl) clientCountEl.textContent = connectedClients.length;
  if (deviceBadge)   deviceBadge.textContent   = connectedClients.length;
}

function updateClientStatus(clientId, status) {
  const li = document.getElementById(`client-${clientId}`);
  if (!li) return;
  const s = li.querySelector('.client-status');
  s.textContent = status;
  s.className = `client-status ${status==='connected'?'':'status-failed'}`;
}

// ─── TRACK STATUS HELPERS ────────────────────────────────────
function setTrackStatus(text, isPlaying) {
  if (trackStatusText) trackStatusText.textContent = text;
  if (trackStatusLine) {
    trackStatusLine.className = isPlaying ? 'm-track-status playing' : 'm-track-status';
  }
  if (albumThumb) {
    isPlaying ? albumThumb.classList.add('spinning') : albumThumb.classList.remove('spinning');
  }
  if (hostStatus) {
    hostStatus.className = isPlaying ? 'm-status-chip live' : 'm-status-chip connected';
    statusLabel.textContent = isPlaying ? 'Live' : 'Online';
  }
}

// ─── PROGRESS & TIME FORMATTING ──────────────────────────────
function fmt(s) {
  if (!isFinite(s) || s<0) s=0;
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

function startProgress() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  (function tick() {
    progressRAF = requestAnimationFrame(tick);
    const cur = mobileAudioPlayer.currentTime  || 0;
    const dur = mobileAudioPlayer.duration     || 0;
    if (dur > 0 && isFinite(dur)) {
      const pct = Math.min((cur/dur)*100, 100);
      if (mobileProgFill) mobileProgFill.style.width  = pct + '%';
      if (mobileProgThumb) mobileProgThumb.style.left  = pct + '%';
      if (mobileTimeElapsed) mobileTimeElapsed.textContent   = fmt(cur);
      if (mobileTimeDuration) mobileTimeDuration.textContent  = fmt(dur);
      if (mobileTimeRemaining) mobileTimeRemaining.textContent = '-' + fmt(dur - cur);
    }
  })();
}

function stopProgress() { 
  if (progressRAF) cancelAnimationFrame(progressRAF); 
  progressRAF = null; 
}

// ─── PLAYBACK SYNC LOGIC ──────────────────────────────────────
function playMobileSync() {
  if (!mobileAudioPlayer.src) return;
  resumeAudioCtx();
  if (playTimeout) clearTimeout(playTimeout);
  const pos = mobileAudioPlayer.currentTime;
  const delayMs = 2000;
  const targetTime = getServerTime() + delayMs;

  socket.emit('sync-play', { file: "Mobile Live Stream", position: pos, targetTime });

  const timeToPlay = targetTime - getServerTime();
  playTimeout = setTimeout(() => {
    mobileAudioPlayer.play().catch(console.error);
    if (mobilePlayIcon) mobilePlayIcon.innerHTML = PAUSE_SVG;
    isPaused = false;
    startProgress();
    setTrackStatus('Playing', true);
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
  }, timeToPlay > 0 ? timeToPlay : 0);

  setTrackStatus('Syncing…', false);
}

function pauseMobileSync() {
  if (playTimeout) clearTimeout(playTimeout);
  mobileAudioPlayer.pause();
  if (mobilePlayIcon) mobilePlayIcon.innerHTML = PLAY_SVG;
  isPaused = true;
  stopProgress();
  socket.emit('sync-pause', { position: mobileAudioPlayer.currentTime });
  setTrackStatus('Paused', false);
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
}

function resumeMobileSync() {
  if (!mobileAudioPlayer.src) return;
  resumeAudioCtx();
  if (playTimeout) clearTimeout(playTimeout);
  const pos = mobileAudioPlayer.currentTime;
  const delayMs = 2000;
  const targetTime = getServerTime() + delayMs;

  socket.emit('sync-resume', { position: pos, targetTime, serverTime: getServerTime() });

  const timeToPlay = targetTime - getServerTime();
  playTimeout = setTimeout(() => {
    mobileAudioPlayer.play().catch(console.error);
    if (mobilePlayIcon) mobilePlayIcon.innerHTML = PAUSE_SVG;
    isPaused = false;
    startProgress();
    setTrackStatus('Playing', true);
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
  }, timeToPlay > 0 ? timeToPlay : 0);

  setTrackStatus('Syncing…', false);
}

function seekBy(delta) {
  if (!mobileAudioPlayer.src) return;
  const wasPlaying = !mobileAudioPlayer.paused && !isPaused;
  if (wasPlaying) pauseMobileSync();
  mobileAudioPlayer.currentTime = Math.max(0, (mobileAudioPlayer.currentTime||0) + delta);
  socket.emit('sync-seek', { position: mobileAudioPlayer.currentTime, serverTime: getServerTime() });
  if (wasPlaying) {
    setTimeout(() => playMobileSync(), 200); // Resume shortly after
  }
}

if (mobileProgTrack) {
  mobileProgTrack.addEventListener('click', (e) => {
    if (!mobileAudioPlayer.src) return;
    const rect = mobileProgTrack.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const dur  = mobileAudioPlayer.duration;
    if (dur && isFinite(dur)) {
      const wasPlaying = !mobileAudioPlayer.paused && !isPaused;
      mobileAudioPlayer.currentTime = pct * dur;
      socket.emit('sync-seek', { position: mobileAudioPlayer.currentTime, serverTime: getServerTime() });
      if (wasPlaying) playMobileSync();
    }
  });
}

// ─── MOBILE LIVE STREAMING ─────────────────────────────────────
if (mobileLiveBtn && mobileLiveFileInput) {
  mobileLiveBtn.addEventListener('click', () => mobileLiveFileInput.click());
  
  mobileLiveFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    files.forEach(file => {
      playlist.push({ file, name: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file) });
    });
    
    renderPlaylist();
    
    // If nothing is playing, start the first new track
    if (currentTrackIdx === -1) {
      playTrack(playlist.length - files.length);
    }
    
    mobileLiveFileInput.value = ''; // Reset so same files can be re-added
  });
}

function playTrack(idx) {
  if (idx < 0 || idx >= playlist.length) return;
  currentTrackIdx = idx;
  const track = playlist[idx];
  
  mobileAudioPlayer.src = track.url;
  setupAnalyser();
  
  mobileAudioPlayer.onloadedmetadata = () => {
    if (mobileNpTitle) mobileNpTitle.textContent = track.name;
    if (mobileTimeDuration) mobileTimeDuration.textContent = fmt(mobileAudioPlayer.duration);
  };
  
  // Capture Stream
  if (mobileAudioPlayer.captureStream) {
    localStream = mobileAudioPlayer.captureStream();
  } else if (mobileAudioPlayer.mozCaptureStream) {
    localStream = mobileAudioPlayer.mozCaptureStream();
  } else {
    alert("captureStream not supported in this mobile browser.");
    return;
  }
  
  // Update UI
  mobileLiveBtn.style.display = 'none';
  mobileActiveControls.style.display = 'flex';
  if (mobileVizIdle) mobileVizIdle.style.display = 'none';
  setTrackStatus('Playing', true);
  startMobileFakeWave();
  
  // Broadcast to all clients
  connectedClients.forEach(id => createPeerConnection(id));
  
  // Play with sync logic
  playMobileSync();
  renderPlaylist();
  
  // Auto-play next track when current ends
  mobileAudioPlayer.onended = () => {
    if (currentTrackIdx < playlist.length - 1) {
      playTrack(currentTrackIdx + 1);
    } else {
      stopCasting();
    }
  };
}

// ─── CONTROLS ──────────────────────────────────────────────────
if (mobilePlayPauseBtn) {
  mobilePlayPauseBtn.addEventListener('click', () => {
    if (!mobileAudioPlayer.src) return;
    if (mobileAudioPlayer.paused || isPaused) {
      if (mobileAudioPlayer.currentTime === 0) playMobileSync();
      else resumeMobileSync();
    } else {
      pauseMobileSync();
    }
  });
}

if (mobileSeekBackBtn) {
  mobileSeekBackBtn.addEventListener('click', () => seekBy(-10));
}

if (mobileSeekFwdBtn) {
  mobileSeekFwdBtn.addEventListener('click', () => seekBy(10));
}

if (mobileStopBtn) {
  mobileStopBtn.addEventListener('click', stopCasting);
}

if (showQrBtn) {
  let globalClientUrl = window.location.origin + '/client?room=' + roomCode;
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    fetch('/api/ip').then(res => res.json()).then(data => {
      globalClientUrl = `http://${data.ip}:${data.port}/client?room=` + roomCode;
    }).catch(() => {});
  }

  showQrBtn.addEventListener('click', () => {
    qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(globalClientUrl)}`;
    const urlEl = document.getElementById('clientUrlText');
    if (urlEl) { urlEl.textContent = globalClientUrl; urlEl.href = globalClientUrl; }
    qrModal.style.display = 'flex';
  });
}

if (closeQrBtn) {
  closeQrBtn.addEventListener('click', () => {
    qrModal.style.display = 'none';
  });
}

if (qrModal) {
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) {
      qrModal.style.display = 'none';
    }
  });
}

// Keep WebRTC latency in check by forcing clients to flush buffers
setInterval(() => {
  if (mobileAudioPlayer && !mobileAudioPlayer.paused && localStream) {
    socket.emit('force-sync');
  }
}, 10000);


function stopCasting() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (mobileAudioPlayer) {
    mobileAudioPlayer.pause();
    mobileAudioPlayer.src = "";
    mobileAudioPlayer.onended = null;
  }
  
  if (playTimeout) clearTimeout(playTimeout);
  stopProgress();
  isPaused = false;
  socket.emit('sync-stop');
  
  if (mobileWaveAnimId) cancelAnimationFrame(mobileWaveAnimId);
  if (mobileWaveCtx) mobileWaveCtx.clearRect(0, 0, mobileWaveCanvas.width, mobileWaveCanvas.height);

  Object.keys(peerConnections).forEach(id => {
    peerConnections[id].close();
    delete peerConnections[id];
  });

  if (mobileVizIdle) mobileVizIdle.style.display = 'flex';
  setTrackStatus('Ready', false);
  currentTrackIdx = -1;
  renderPlaylist();
  if (mobileLiveFileInput) mobileLiveFileInput.value = '';
}

// ─── PLAYLIST LOGIC ────────────────────────────────────────────
if (playlistToggleBtn) {
  playlistToggleBtn.addEventListener('click', () => {
    playlistVisible = !playlistVisible;
    if (playlistPanel) playlistPanel.style.display = playlistVisible ? 'block' : 'none';
    playlistToggleBtn.classList.toggle('active', playlistVisible);
  });
}

if (playlistClearBtn) {
  playlistClearBtn.addEventListener('click', () => {
    const wasPlaying = currentTrackIdx >= 0;
    if (wasPlaying) stopCasting();
    playlist.forEach(t => URL.revokeObjectURL(t.url));
    playlist = [];
    currentTrackIdx = -1;
    renderPlaylist();
    if (mobileLiveBtn) mobileLiveBtn.style.display = '';
    if (mobileActiveControls) mobileActiveControls.style.display = '';
  });
}

function renderPlaylist() {
  if (!playlistList) return;
  if (playlistBadge) playlistBadge.textContent = playlist.length;
  if (playlistCount) playlistCount.textContent = playlist.length + ' track' + (playlist.length !== 1 ? 's' : '');
  
  if (playlist.length === 0) {
    playlistList.innerHTML = '<li class="m-pl-empty">No tracks added yet. Tap upload to add music.</li>';
    return;
  }
  
  playlistList.innerHTML = '';
  playlist.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = 'm-pl-item' + (i === currentTrackIdx ? ' playing' : '');
    li.draggable = true;
    li.dataset.idx = i;
    li.innerHTML = `
      <span class="m-pl-drag-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
          <line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
        </svg>
      </span>
      <span class="m-pl-num">${i + 1}</span>
      <span class="m-pl-name">${track.name}</span>
      <button class="m-pl-remove" data-idx="${i}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    
    // Tap to play this track
    li.addEventListener('click', (e) => {
      if (e.target.closest('.m-pl-remove') || e.target.closest('.m-pl-drag-handle')) return;
      playTrack(i);
    });
    
    // Remove button
    li.querySelector('.m-pl-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrack(i);
    });
    
    // Drag events
    li.addEventListener('dragstart', handleDragStart);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('dragleave', handleDragLeave);
    li.addEventListener('drop', handleDrop);
    li.addEventListener('dragend', handleDragEnd);
    
    // Touch drag events (for mobile)
    li.addEventListener('touchstart', handleTouchStart, { passive: false });
    li.addEventListener('touchmove', handleTouchMove, { passive: false });
    li.addEventListener('touchend', handleTouchEnd);
    
    playlistList.appendChild(li);
  });
}

function removeTrack(idx) {
  URL.revokeObjectURL(playlist[idx].url);
  playlist.splice(idx, 1);
  
  if (idx === currentTrackIdx) {
    // Currently playing track removed
    if (playlist.length > 0) {
      const nextIdx = Math.min(idx, playlist.length - 1);
      playTrack(nextIdx);
    } else {
      stopCasting();
      if (mobileLiveBtn) mobileLiveBtn.style.display = '';
      if (mobileActiveControls) mobileActiveControls.style.display = '';
    }
  } else if (idx < currentTrackIdx) {
    currentTrackIdx--;
    renderPlaylist();
  } else {
    renderPlaylist();
  }
}

// ─── DRAG & DROP REORDER ──────────────────────────────────────
let dragIdx = -1;

function handleDragStart(e) {
  dragIdx = parseInt(this.dataset.idx);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function handleDragLeave() {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const dropIdx = parseInt(this.dataset.idx);
  if (dragIdx === dropIdx) return;
  reorderPlaylist(dragIdx, dropIdx);
}

function handleDragEnd() {
  this.classList.remove('dragging');
  dragIdx = -1;
}

// ─── TOUCH DRAG (MOBILE) ──────────────────────────────────────
let touchDragIdx = -1;
let touchStartY = 0;
let touchHoldTimer = null;
let isTouchDragging = false;
let touchClone = null;

function handleTouchStart(e) {
  touchStartY = e.touches[0].clientY;
  touchDragIdx = parseInt(this.dataset.idx);
  isTouchDragging = false;
  
  // Long press to start drag
  touchHoldTimer = setTimeout(() => {
    isTouchDragging = true;
    this.classList.add('dragging');
    // Haptic feedback if available
    if (navigator.vibrate) navigator.vibrate(30);
  }, 300);
}

function handleTouchMove(e) {
  if (!isTouchDragging) {
    const diff = Math.abs(e.touches[0].clientY - touchStartY);
    if (diff > 10) { clearTimeout(touchHoldTimer); }
    return;
  }
  e.preventDefault();
  
  const touchY = e.touches[0].clientY;
  const items = playlistList.querySelectorAll('.m-pl-item');
  items.forEach(item => item.classList.remove('drag-over'));
  
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (touchY >= rect.top && touchY <= rect.bottom) {
      if (parseInt(item.dataset.idx) !== touchDragIdx) {
        item.classList.add('drag-over');
      }
      break;
    }
  }
}

function handleTouchEnd(e) {
  clearTimeout(touchHoldTimer);
  
  if (isTouchDragging) {
    const items = playlistList.querySelectorAll('.m-pl-item');
    let dropIdx = -1;
    items.forEach(item => {
      if (item.classList.contains('drag-over')) {
        dropIdx = parseInt(item.dataset.idx);
      }
      item.classList.remove('drag-over');
      item.classList.remove('dragging');
    });
    
    if (dropIdx >= 0 && dropIdx !== touchDragIdx) {
      reorderPlaylist(touchDragIdx, dropIdx);
    }
  }
  
  isTouchDragging = false;
  touchDragIdx = -1;
}

function reorderPlaylist(fromIdx, toIdx) {
  const [moved] = playlist.splice(fromIdx, 1);
  playlist.splice(toIdx, 0, moved);
  
  // Update currentTrackIdx
  if (currentTrackIdx === fromIdx) {
    currentTrackIdx = toIdx;
  } else if (fromIdx < currentTrackIdx && toIdx >= currentTrackIdx) {
    currentTrackIdx--;
  } else if (fromIdx > currentTrackIdx && toIdx <= currentTrackIdx) {
    currentTrackIdx++;
  }
  
  renderPlaylist();
}

// ─── WEBRTC (PEER CONNECTIONS) ─────────────────────────────────
const iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function createPeerConnection(clientId) {
  const pc = new RTCPeerConnection(iceServers);
  peerConnections[clientId] = pc;
  
  pc.onconnectionstatechange = () => updateClientStatus(clientId, pc.connectionState);
  
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: clientId, candidate: e.candidate });
  };
  
  try {
    let offer = await pc.createOffer();
    offer = new RTCSessionDescription({type:offer.type, sdp:offer.sdp.replace(/a=fmtp:111 .*/g, 'a=fmtp:111 minptime=10;useinbandfec=0;stereo=1;maxaveragebitrate=510000;cbr=1')});
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { to: clientId, offer: pc.localDescription });
  } catch(e) {
    console.error("Error creating offer:", e);
  }
}

socket.on('webrtc-answer', async (data) => {
  const pc = peerConnections[data.from];
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch(e) {
      console.error("Error setting remote description:", e);
    }
  }
});

socket.on('ice-candidate', (data) => {
  const pc = peerConnections[data.from];
  if (pc && data.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(console.error);
  }
});

// ─── BACKGROUND ANIMATION & WAVEFORM ──────────────────────────
const bgCanvas = document.getElementById('bgCanvas');
const bgCtx = bgCanvas ? bgCanvas.getContext('2d') : null;
let particles = [];
let bgTime = 0;

if (bgCanvas) {
  function resizeBg() {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeBg);
  resizeBg();
  
  for(let i=0; i<40; i++){
    particles.push({
      x: Math.random()*window.innerWidth,
      y: Math.random()*window.innerHeight,
      r: Math.random()*2+1,
      vx: (Math.random()-0.5)*0.5,
      vy: (Math.random()-0.5)*0.5
    });
  }
  
  function animBg() {
    requestAnimationFrame(animBg);
    if (!bgCtx) return;
    bgCtx.clearRect(0,0,bgCanvas.width,bgCanvas.height);
    bgCtx.fillStyle = 'rgba(255,255,255,0.15)';
    bgTime += 0.01;
    particles.forEach(p => {
      p.x += p.vx + Math.sin(bgTime)*0.2;
      p.y += p.vy;
      if(p.x<0) p.x=bgCanvas.width;
      if(p.x>bgCanvas.width) p.x=0;
      if(p.y<0) p.y=bgCanvas.height;
      if(p.y>bgCanvas.height) p.y=0;
      bgCtx.beginPath();
      bgCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      bgCtx.fill();
    });
  }
  animBg();
}

// ─── WEB AUDIO ANALYSER ──────────────────────────────────────
let audioCtx = null;
let analyser = null;
let audioSource = null;
let analyserData = null;

function setupAnalyser() {
  if (audioCtx) return; // already set up
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;            // 64 frequency bins — perfect for mobile bars
    analyser.smoothingTimeConstant = 0.82; // smooth transitions between beats
    analyserData = new Uint8Array(analyser.frequencyBinCount);

    audioSource = audioCtx.createMediaElementSource(mobileAudioPlayer);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch(e) {
    console.warn('[Analyser] Setup failed:', e);
  }
}

function resumeAudioCtx() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// ─── WAVEFORM ANIMATION ───────────────────────────────────────
function startMobileFakeWave() {
  if (!mobileWaveCtx) return;
  if (mobileWaveAnimId) cancelAnimationFrame(mobileWaveAnimId);

  // Try to use the real analyser; fall back to animated sine wave
  function frame() {
    mobileWaveAnimId = requestAnimationFrame(frame);
    let data;
    if (analyser && analyserData) {
      analyser.getByteFrequencyData(analyserData);
      data = analyserData;
    } else {
      // Fallback animated sine (no audio context)
      const numBars = 64;
      data = new Uint8Array(numBars);
      for (let i = 0; i < numBars; i++) {
        data[i] = 100
          + Math.sin(i * 0.18 + mobileFakeWaveT) * 60
          + Math.sin(i * 0.35 + mobileFakeWaveT * 1.3) * 30
          + Math.sin(i * 0.07 + mobileFakeWaveT * 0.6) * 20;
        data[i] = Math.max(0, Math.min(255, data[i]));
      }
      mobileFakeWaveT += 0.025;
    }
    renderMobileWave(data);
  }
  frame();
}

function renderMobileWave(data) {
  if (!mobileWaveCtx) return;
  const W = mobileWaveCanvas.offsetWidth || 360;
  const H = mobileWaveCanvas.height || 120;
  if (mobileWaveCanvas.width !== W) mobileWaveCanvas.width = W;
  mobileWaveCtx.clearRect(0, 0, W, H);

  const numBars = data.length;
  const gap = 2;
  const barW = Math.max(2, (W / numBars) - gap);
  const slot = W / numBars;

  // Create one bright neon horizontal gradient across the entire canvas
  const colGrad = mobileWaveCtx.createLinearGradient(0, 0, W, 0);
  colGrad.addColorStop(0,    '#fb923c'); // Bright Orange
  colGrad.addColorStop(0.25, '#fef08a'); // Bright Yellow
  colGrad.addColorStop(0.5,  '#4ade80'); // Neon Green
  colGrad.addColorStop(0.75, '#22d3ee'); // Bright Cyan
  colGrad.addColorStop(1,    '#818cf8'); // Indigo/Purple

  for (let i = 0; i < numBars; i++) {
    const amp = data[i] / 255;          // 0..1
    const barH = Math.max(3, amp * H * 0.92); // leave tiny gap at top

    const x = i * slot;
    const y = H - barH;                 // bars grow from BOTTOM up

    // Glow scales with amplitude
    mobileWaveCtx.shadowColor = colGrad;
    mobileWaveCtx.shadowBlur  = amp * 15;

    mobileWaveCtx.fillStyle = colGrad;
    mobileWaveCtx.beginPath();
    mobileWaveCtx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
    mobileWaveCtx.fill();
  }

  // Very subtle dark stroke just for separation, not too harsh
  mobileWaveCtx.shadowBlur  = 0;
  mobileWaveCtx.strokeStyle = 'rgba(0,0,0,0.3)';
  mobileWaveCtx.lineWidth   = 1;
  for (let i = 0; i < numBars; i++) {
    const amp2  = data[i] / 255;
    const barH2 = Math.max(3, amp2 * H * 0.92);
    mobileWaveCtx.beginPath();
    mobileWaveCtx.roundRect(i * slot, H - barH2, barW, barH2, [4, 4, 0, 0]);
    mobileWaveCtx.stroke();
  }
}

