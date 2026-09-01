/* ============================================================
   SyncPlay Host – Advanced JS
   ============================================================ */
const socket = io();

// ─── DOM REFS ─────────────────────────────────────────────────
// Tab mode
const startBtn      = document.getElementById('startBtn');
const activeControls= document.getElementById('activeControls');
const syncLiveBtn   = document.getElementById('syncLiveBtn');
const pauseBtn      = document.getElementById('pauseBtn');
const stopBtn       = document.getElementById('stopBtn');
const hostStatus    = document.getElementById('hostStatus');
const statusLabel   = document.getElementById('statusLabel');
const vizIdle       = document.getElementById('vizIdle');
const vizActive     = document.getElementById('vizActive');
const vizLabel      = document.getElementById('vizLabel');

// Header
const clientUrl     = document.getElementById('clientUrl');
const copyBtn       = document.getElementById('copyBtn');
const clientCountEl = document.getElementById('clientCount');
const clientCountEl2= document.getElementById('clientCountBadge2');

// Tabs
const tabModeBtn    = document.getElementById('tabModeBtn');
const localModeBtn  = document.getElementById('localModeBtn');
const tabMode       = document.getElementById('tabMode');
const localMode     = document.getElementById('localMode');

// Player card
const playerCard    = document.getElementById('playerCard');
const noPlayerHint  = document.getElementById('noPlayerHint');
const miniVinyl     = document.getElementById('miniVinyl');
const npTitle       = document.getElementById('npTitle');
const npStatus      = document.getElementById('npStatus');

// Controls
const localPlayPauseBtn = document.getElementById('localPlayPauseBtn');
const hostPlayIcon      = document.getElementById('hostPlayIcon');
const localPrevBtn      = document.getElementById('localPrevBtn');
const localNextBtn      = document.getElementById('localNextBtn');
const localStopBtn      = document.getElementById('localStopBtn');
const hostSeekBackBtn   = document.getElementById('hostSeekBackBtn');
const hostSeekFwdBtn    = document.getElementById('hostSeekFwdBtn');
const hostShuffleBtn    = document.getElementById('hostShuffleBtn');

// Progress
const hostProgFill  = document.getElementById('hostProgFill');
const hostProgThumb = document.getElementById('hostProgThumb');
const hostProgTrack = document.getElementById('hostProgTrack');
const hostTimeElapsed  = document.getElementById('hostTimeElapsed');
const hostTimeDuration = document.getElementById('hostTimeDuration');
const hostTimeRemaining= document.getElementById('hostTimeRemaining');

// Volume
const hostMuteBtn   = document.getElementById('hostMuteBtn');
const hostVolIcon   = document.getElementById('hostVolIcon');
const hostVolSlider = document.getElementById('hostVolumeSlider');
const hostVolFill   = document.getElementById('hostVolFill');
const hostVolPct    = document.getElementById('hostVolPct');

// Waveform
const hostWaveCanvas= document.getElementById('hostWaveCanvas');
const hostWaveCtx   = hostWaveCanvas ? hostWaveCanvas.getContext('2d') : null;

// File list
const fileList      = document.getElementById('fileList');
const refreshFilesBtn= document.getElementById('refreshFilesBtn');
const broadcastToggle= document.getElementById('broadcastToggle');
const localAudioPlayer= document.getElementById('localAudioPlayer');
const clientList    = document.getElementById('clientList');

// ─── STATE ────────────────────────────────────────────────────
let localStream     = null;
let isPaused        = false;
const peerConnections = {};
const connectedClients = new Set();
let currentMode     = 'tab';
let timeOffset      = 0;
let rtt             = 0;
let isShuffle       = false;
let isMuted         = false;
let prevVol         = 1.0;
let progressRAF     = null;
let waveAnimId      = null;
let fakeWaveT       = 0;
let audioCtx        = null;
let analyser        = null;

// ─── LOCAL STATE ──────────────────────────────────────────────
const localState = {
  files: [], currentIndex: -1, currentFile: null, playTimeout: null
};

// ─── TIME SYNC ────────────────────────────────────────────────
function syncTime() { socket.emit('time-sync-request', { clientSendTime: Date.now() }); }
setInterval(syncTime, 5000); syncTime();
socket.on('time-sync-response', (data) => {
  const now = Date.now();
  rtt = now - data.clientSendTime;
  timeOffset = (data.serverTime + rtt / 2) - now;
});
function getServerTime() { return Date.now() + timeOffset; }

// ─── WebRTC ───────────────────────────────────────────────────
const rtcConfig = { iceServers:[{urls:'stun:stun.l.google.com:19302'}], iceCandidatePoolSize:0 };
function lowLatencySDP(sdp) {
  return sdp.replace(/a=fmtp:111 .*/g, 'a=fmtp:111 minptime=10;useinbandfec=0;stereo=1;maxaveragebitrate=510000;cbr=1');
}

// ─── BG WAVE CANVAS ──────────────────────────────────────────
(function initBgWave() {
  const c = document.getElementById('bgCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  let t = 0;
  const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
  window.addEventListener('resize', resize); resize();
  (function draw() {
    ctx.clearRect(0, 0, c.width, c.height);
    [[0,'rgba(139,92,246,.4)'],[1,'rgba(6,182,212,.3)'],[2,'rgba(236,72,153,.2)']].forEach(([wi, col]) => {
      ctx.beginPath();
      const amp=25+wi*12, freq=.005+wi*.002, phase=t*(.25+wi*.1)+wi*Math.PI*.6, yBase=c.height*(.4+wi*.1);
      for (let x=0; x<=c.width; x+=2) {
        const y = yBase + Math.sin(x*freq+phase)*amp;
        wi===0&&x===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      }
      ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.stroke();
    });
    t += .01; requestAnimationFrame(draw);
  })();
})();

// ─── HOST WAVEFORM ────────────────────────────────────────────
function setupHostAnalyser(stream) {
  try {
    if (audioCtx) audioCtx.close();
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    const src = stream
      ? audioCtx.createMediaStreamSource(stream)
      : audioCtx.createMediaElementSource(localAudioPlayer);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    drawRealWave();
  } catch(e) { startFakeWave(); }
}

let waveTime = 0;

function drawRealWave() {
  if (!hostWaveCtx || !analyser) { startFakeWave(); return; }
  const buf = new Uint8Array(analyser.frequencyBinCount);
  function frame() {
    waveAnimId = requestAnimationFrame(frame);
    analyser.getByteFrequencyData(buf);
    renderHostWave(buf);
  }
  frame();
}

function startFakeWave() {
  if (!hostWaveCtx) return;
  if (waveAnimId) cancelAnimationFrame(waveAnimId);
  function frame() {
    waveAnimId = requestAnimationFrame(frame);
    const buf = new Uint8Array(50);
    const simTime = Date.now() / 1000;
    // Simulate frequency data
    buf[2] = 128 + Math.sin(simTime * 2) * 80;
    buf[6] = 100 + Math.sin(simTime * 3) * 60;
    buf[12] = 80 + Math.sin(simTime * 5) * 50;
    buf[24] = 60 + Math.sin(simTime * 8) * 40;
    renderHostWave(buf);
  }
  frame();
}

function renderHostWave(buf) {
  if (!hostWaveCtx) return;
  const W = hostWaveCanvas.offsetWidth || 600;
  const H = hostWaveCanvas.height || 120;
  if (hostWaveCanvas.width !== W) hostWaveCanvas.width = W;

  waveTime += 2.0; // Color shifting speed

  // Clear canvas (pure black background)
  hostWaveCtx.fillStyle = '#000';
  hostWaveCtx.fillRect(0, 0, W, H);

  // We are receiving 90-128 bins (depending on what's passed from drawRealWave/FakeWave)
  const numBars = buf.length;
  // gap between bars
  const gap = 3; 
  const totalGap = gap * (numBars - 1);
  const barWidth = (W - totalGap) / numBars;
  
  const maxBarHeight = H * 0.95; // Leave a little padding at top

  // Draw bars
  hostWaveCtx.lineCap = 'round';

  for (let i = 0; i < numBars; i++) {
    const val = buf[i]; // 0 to 255
    const barHeight = (val / 255) * maxBarHeight;
    
    const x = i * (barWidth + gap);
    // Minimum 2px height so we can always see the round dot even when silent
    const y = H - Math.max(2, barHeight); 
    
    // Shift color continuously (waveTime) and create a gradient across bars (i / numBars)
    const hue = (waveTime + (i / numBars) * 200) % 360;
    
    hostWaveCtx.beginPath();
    hostWaveCtx.lineWidth = barWidth;
    
    // Colors
    hostWaveCtx.strokeStyle = `hsl(${hue}, 90%, 65%)`;
    hostWaveCtx.shadowBlur = 10;
    hostWaveCtx.shadowColor = `hsl(${hue}, 100%, 50%)`;
    
    // Draw a line from bottom to top of the bar
    hostWaveCtx.moveTo(x + barWidth / 2, H);
    // Offset Y by barWidth/2 to compensate for the round cap sticking out
    hostWaveCtx.lineTo(x + barWidth / 2, y + barWidth / 2);
    hostWaveCtx.stroke();
  }
}

// ─── TIME FORMAT ─────────────────────────────────────────────
function fmt(s) {
  if (!isFinite(s) || s<0) s=0;
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

// ─── PROGRESS LOOP ───────────────────────────────────────────
function startProgress() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  (function tick() {
    progressRAF = requestAnimationFrame(tick);
    const cur = localAudioPlayer.currentTime  || 0;
    const dur = localAudioPlayer.duration     || 0;
    if (dur > 0 && isFinite(dur)) {
      const pct = Math.min((cur/dur)*100, 100);
      hostProgFill.style.width  = pct + '%';
      hostProgThumb.style.left  = pct + '%';
      hostTimeElapsed.textContent   = fmt(cur);
      hostTimeDuration.textContent  = fmt(dur);
      hostTimeRemaining.textContent = '-' + fmt(dur - cur);
    } else {
      hostTimeElapsed.textContent   = fmt(cur);
      hostTimeDuration.textContent  = '—';
      hostTimeRemaining.textContent = '';
    }
  })();
}
function stopProgress() { if (progressRAF) cancelAnimationFrame(progressRAF); progressRAF = null; }

// ─── PLAY ICON HELPERS ────────────────────────────────────────
const PLAY_SVG  = `<polygon points="5 3 19 12 5 21 5 3"/>`;
const PAUSE_SVG = `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`;

function setHostPlaying(playing) {
  hostPlayIcon.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  if (playing) {
    playerCard.classList.remove('paused');
    npStatus.textContent = 'Playing';
    startProgress();
  } else {
    playerCard.classList.add('paused');
    npStatus.textContent = 'Paused';
    stopProgress();
  }
}

// ─── VOLUME ──────────────────────────────────────────────────
const VOL_ICONS = {
  mute: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`,
  low:  `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`,
  high: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`
};

function setHostVolume(v, skipSlider=false) {
  v = Math.max(0, Math.min(1, v));
  localAudioPlayer.volume = v;
  isMuted = (v===0);
  if (!skipSlider) hostVolSlider.value = Math.round(v*100);
  const pct = Math.round(v*100);
  hostVolPct.textContent  = pct + '%';
  hostVolFill.style.width = pct + '%';
  hostVolIcon.innerHTML   = v===0 ? VOL_ICONS.mute : v<.5 ? VOL_ICONS.low : VOL_ICONS.high;
  hostMuteBtn.classList.toggle('muted', v===0);
}

hostVolSlider.addEventListener('input', () => {
  const v = hostVolSlider.value / 100;
  if (v>0) prevVol = v;
  setHostVolume(v, true);
  hostVolFill.style.width = hostVolSlider.value + '%';
});

hostMuteBtn.addEventListener('click', () => {
  if (isMuted || localAudioPlayer.volume===0) setHostVolume(prevVol>0?prevVol:1);
  else { prevVol=localAudioPlayer.volume; setHostVolume(0); }
});

// Init
setHostVolume(1.0);
hostVolFill.style.width = '100%';

// ─── URL + COPY ───────────────────────────────────────────────
fetch('/api/ip')
  .then(res => res.json())
  .then(data => {
    clientUrl.textContent = `http://${data.ip}:${data.port}/client`;
  })
  .catch(() => {
    clientUrl.textContent = `${window.location.protocol}//${window.location.host}/client`;
  });
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(clientUrl.textContent).then(() => {
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`, 2000);
  });
});

// ─── SOCKET SETUP ─────────────────────────────────────────────
socket.emit('register-host');
socket.on('host-registered', () => {
  hostStatus.classList.add('connected');
  statusLabel.textContent = 'Server Connected';
});

// ─── MODE SWITCHING ───────────────────────────────────────────
tabModeBtn.addEventListener('click', () => {
  if (localState.currentFile && !localAudioPlayer.paused) stopLocalPlayback();
  currentMode = 'tab';
  tabModeBtn.classList.add('active'); localModeBtn.classList.remove('active');
  tabMode.style.display = 'block'; localMode.style.display = 'none';
});

localModeBtn.addEventListener('click', () => {
  if (localStream) stopCasting();
  currentMode = 'local';
  localModeBtn.classList.add('active'); tabModeBtn.classList.remove('active');
  localMode.style.display = 'block'; tabMode.style.display = 'none';
  fetchMediaFiles();
});

// ─── TAB CAPTURE ─────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:2, sampleRate:48000 }
    });
    if (localStream.getAudioTracks().length === 0) {
      localStream.getTracks().forEach(t=>t.stop()); localStream=null;
      alert('⚠ No audio detected!\n\nPlease check the "Share tab audio" checkbox when selecting what to share.');
      return;
    }
    startBtn.style.display = 'none';
    activeControls.style.display = 'flex';
    vizIdle.style.display = 'none';
    vizActive.style.display = 'flex';
    vizActive.classList.remove('paused');
    hostStatus.classList.remove('connected');
    hostStatus.classList.add('live');
    statusLabel.textContent = '● Broadcasting';
    localStream.getTracks().forEach(track => track.onended = stopCasting);
    connectedClients.forEach(id => createPeerConnection(id));
  } catch(err) { console.error('Error:', err); }
});

syncLiveBtn.addEventListener('click', () => {
  if (currentMode === 'tab' && localStream) {
    socket.emit('force-sync');
    // Button animation
    const oldHtml = syncLiveBtn.innerHTML;
    syncLiveBtn.innerHTML = `Syncing...`;
    syncLiveBtn.style.color = 'var(--a)';
    setTimeout(() => {
      syncLiveBtn.innerHTML = oldHtml;
      syncLiveBtn.style.color = '';
    }, 600);
  }
});

stopBtn.addEventListener('click', stopCasting);

pauseBtn.addEventListener('click', () => {
  if (!localStream) return;
  isPaused = !isPaused;
  localStream.getAudioTracks().forEach(track => track.enabled = !isPaused);
  if (isPaused) {
    pauseBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`;
    vizActive.classList.add('paused');
    statusLabel.textContent = '⏸ Paused';
  } else {
    pauseBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
    vizActive.classList.remove('paused');
    statusLabel.textContent = '● Broadcasting';
  }
});

function stopCasting() {
  if (localStream) { localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  startBtn.style.display='flex'; activeControls.style.display='none';
  vizIdle.style.display='flex'; vizActive.style.display='none';
  isPaused=false;
  hostStatus.classList.remove('live'); hostStatus.classList.add('connected');
  statusLabel.textContent = 'Server Connected';
  Object.values(peerConnections).forEach(pc=>pc.close());
  for (let k in peerConnections) delete peerConnections[k];
  connectedClients.forEach(id=>updateClientStatus(id,'waiting'));
}

async function createPeerConnection(clientId) {
  if (peerConnections[clientId]) { peerConnections[clientId].close(); delete peerConnections[clientId]; }
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[clientId] = pc;
  pc.onicecandidate = (e) => { if(e.candidate) socket.emit('ice-candidate',{to:clientId,candidate:e.candidate}); };
  pc.onconnectionstatechange = () => updateClientStatus(clientId, pc.connectionState);
  if (localStream) localStream.getAudioTracks().forEach(t=>pc.addTrack(t,localStream));
  try {
    let offer = await pc.createOffer();
    offer = new RTCSessionDescription({type:offer.type, sdp:lowLatencySDP(offer.sdp)});
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer',{to:clientId, offer:pc.localDescription});
  } catch(err){}
}
socket.on('webrtc-answer', async (data) => {
  const pc = peerConnections[data.from];
  if(pc) try { await pc.setRemoteDescription(new RTCSessionDescription(data.answer)); } catch(e){}
});
socket.on('ice-candidate', async (data) => {
  const pc = peerConnections[data.from];
  if(pc) try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
});

// ─── LOCAL FILES ─────────────────────────────────────────────
async function fetchMediaFiles() {
  try {
    const res = await fetch('/api/media');
    localState.files = await res.json();
    renderFileList();
  } catch(err) { console.error('Failed to load media files:', err); }
}
refreshFilesBtn.addEventListener('click', fetchMediaFiles);

function renderFileList() {
  fileList.innerHTML = '';
  if (localState.files.length === 0) {
    fileList.innerHTML = `<div class="file-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <p>No audio files found</p>
      <p class="file-hint">Add .mp3, .wav files to the <code>media/</code> folder and refresh</p>
    </div>`; return;
  }
  localState.files.forEach((file, index) => {
    const li = document.createElement('div');
    li.className = `file-item ${index===localState.currentIndex?'playing':''}`;
    li.innerHTML = `
      <div class="file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="file-details">
        <p class="file-name" title="${file.name}">${file.name}</p>
        <p class="file-size">${(file.size/1024/1024).toFixed(2)} MB</p>
      </div>
      <div class="file-play-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>`;
    li.addEventListener('click', () => loadLocalFile(index));
    fileList.appendChild(li);
  });
}

function loadLocalFile(index) {
  if (index<0 || index>=localState.files.length) return;
  if (localState.playTimeout) clearTimeout(localState.playTimeout);
  localAudioPlayer.pause();

  localState.currentIndex = index;
  localState.currentFile  = localState.files[index].name;

  localAudioPlayer.src     = `/media/${encodeURIComponent(localState.currentFile)}`;
  localAudioPlayer.preload = 'auto';
  localAudioPlayer.load();
  try { localAudioPlayer.currentTime = 0; } catch(e){}

  // Setup analyser on first load
  if (!analyser) {
    try { setupHostAnalyser(null); } catch(e) { startFakeWave(); }
  }

  renderFileList();
  playerCard.style.display    = 'block';
  noPlayerHint.style.display  = 'none';
  npTitle.textContent = localState.currentFile.replace(/\.[^.]+$/, '');
  setHostPlaying(false);

  hostProgFill.style.width  = '0%';
  hostProgThumb.style.left  = '0%';
  hostTimeElapsed.textContent   = '0:00';
  hostTimeDuration.textContent  = '—';
  hostTimeRemaining.textContent = '';

  localAudioPlayer.onloadedmetadata = () => {
    const dur = localAudioPlayer.duration || 0;
    if (dur>0) { hostTimeDuration.textContent=fmt(dur); hostTimeRemaining.textContent='-'+fmt(dur); }
  };

  if (broadcastToggle.checked) {
    socket.emit('sync-load', { file: localState.currentFile });
    hostStatus.classList.add('live');
    statusLabel.textContent = '● Syncing';
  }
}

function playLocalSync() {
  if (!localState.currentFile) return;
  if (localState.playTimeout) clearTimeout(localState.playTimeout);
  const pos = localAudioPlayer.currentTime;
  const delayMs = 2000;
  const targetTime = getServerTime() + delayMs;

  if (broadcastToggle.checked) {
    socket.emit('sync-play', { file:localState.currentFile, position:pos, targetTime });
  }

  const timeToPlay = targetTime - getServerTime();
  localState.playTimeout = setTimeout(() => {
    localAudioPlayer.play().catch(console.error);
    setHostPlaying(true);
    hostStatus.classList.add('live');
    statusLabel.textContent = '● Playing';
  }, timeToPlay>0 ? timeToPlay : 0);

  npStatus.textContent = 'Syncing...';
}

function pauseLocalSync() {
  if (localState.playTimeout) clearTimeout(localState.playTimeout);
  localAudioPlayer.pause();
  setHostPlaying(false);
  if (broadcastToggle.checked) socket.emit('sync-pause', { position:localAudioPlayer.currentTime });
}

function resumeLocalSync() {
  if (!localState.currentFile) return;
  if (localState.playTimeout) clearTimeout(localState.playTimeout);
  const pos = localAudioPlayer.currentTime;
  const delayMs = 2000;
  const targetTime = getServerTime() + delayMs;

  if (broadcastToggle.checked) {
    socket.emit('sync-resume', { position:pos, targetTime, serverTime:getServerTime() });
  }

  const timeToPlay = targetTime - getServerTime();
  localState.playTimeout = setTimeout(() => {
    localAudioPlayer.play().catch(console.error);
    setHostPlaying(true);
    statusLabel.textContent = '● Playing';
  }, timeToPlay>0 ? timeToPlay : 0);
}

function stopLocalPlayback() {
  if (localState.playTimeout) clearTimeout(localState.playTimeout);
  localAudioPlayer.pause();
  try { localAudioPlayer.currentTime = 0; } catch(e){}
  localState.currentFile = null; localState.currentIndex = -1;
  playerCard.style.display   = 'none';
  noPlayerHint.style.display = 'flex';
  renderFileList();
  setHostPlaying(false);
  stopProgress();
  hostStatus.classList.remove('live');
  statusLabel.textContent = 'Server Connected';
  if (broadcastToggle.checked) socket.emit('sync-stop');
}

function seekBy(delta) {
  if (!localState.currentFile) return;
  const wasPlaying = !localAudioPlayer.paused;
  if (wasPlaying) {
    localAudioPlayer.pause();
    if (localState.playTimeout) clearTimeout(localState.playTimeout);
  }
  localAudioPlayer.currentTime = Math.max(0, (localAudioPlayer.currentTime||0) + delta);
  if (broadcastToggle.checked) {
    socket.emit('sync-seek', { position:localAudioPlayer.currentTime, serverTime:getServerTime() });
  }
  if (wasPlaying) {
    setTimeout(() => {
      playLocalSync();
    }, 200);
  }
}

// ─── CONTROL LISTENERS ────────────────────────────────────────
localPlayPauseBtn.addEventListener('click', () => {
  if (!localState.currentFile) return;
  if (localAudioPlayer.paused) {
    // First play vs resume
    if (localAudioPlayer.currentTime === 0) playLocalSync();
    else resumeLocalSync();
  } else {
    pauseLocalSync();
  }
});

localPrevBtn.addEventListener('click', () => {
  if (localAudioPlayer.currentTime > 3) {
    // Restart current track
    localAudioPlayer.pause();
    localAudioPlayer.currentTime = 0;
    if (broadcastToggle.checked) socket.emit('sync-seek', { position:0, serverTime:getServerTime() });
    if (!localAudioPlayer.paused) playLocalSync();
  } else if (localState.currentIndex > 0) {
    loadLocalFile(localState.currentIndex - 1);
    setTimeout(() => playLocalSync(), 800);
  }
});

localNextBtn.addEventListener('click', () => {
  if (localState.currentIndex < localState.files.length - 1) {
    loadLocalFile(localState.currentIndex + 1);
    setTimeout(() => playLocalSync(), 800);
  }
});

localStopBtn.addEventListener('click', stopLocalPlayback);
hostSeekBackBtn.addEventListener('click', () => seekBy(-10));
hostSeekFwdBtn.addEventListener('click', () => seekBy(10));

hostShuffleBtn.addEventListener('click', () => {
  isShuffle = !isShuffle;
  hostShuffleBtn.classList.toggle('active', isShuffle);
});

// Click progress bar to seek
hostProgTrack.addEventListener('click', (e) => {
  if (!localState.currentFile) return;
  const rect = hostProgTrack.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  const dur  = localAudioPlayer.duration;
  if (dur && isFinite(dur)) {
    const wasPlaying = !localAudioPlayer.paused;
    localAudioPlayer.currentTime = pct * dur;
    if (broadcastToggle.checked) socket.emit('sync-seek', { position:localAudioPlayer.currentTime, serverTime:getServerTime() });
    if (wasPlaying) playLocalSync();
  }
});

// Auto-next on track end
localAudioPlayer.addEventListener('ended', () => {
  if (isShuffle && localState.files.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * localState.files.length); }
    while (next === localState.currentIndex);
    loadLocalFile(next);
    setTimeout(() => playLocalSync(), 1000);
  } else if (localState.currentIndex < localState.files.length - 1) {
    loadLocalFile(localState.currentIndex + 1);
    setTimeout(() => playLocalSync(), 1500);
  } else {
    stopLocalPlayback();
  }
});

// ─── CLIENT LIST ─────────────────────────────────────────────
function updateCount() {
  clientCountEl.textContent  = connectedClients.size;
  clientCountEl2.textContent = connectedClients.size;
}

socket.on('client-connected', (clientId) => {
  connectedClients.add(clientId);
  if (!document.getElementById(`client-${clientId}`)) {
    const emptyState = clientList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    const li = document.createElement('li');
    li.id = `client-${clientId}`;
    li.innerHTML = `<span class="client-id">Device ${clientId.substring(0,5).toUpperCase()}</span><span class="client-status">connected</span>`;
    clientList.appendChild(li);
  }
  updateCount();
  if (currentMode==='tab' && localStream) createPeerConnection(clientId);
});

socket.on('client-disconnected', (clientId) => {
  connectedClients.delete(clientId);
  const li = document.getElementById(`client-${clientId}`);
  if (li) li.remove();
  if (clientList.children.length === 0) {
    clientList.innerHTML = `<li class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg><span>No devices connected yet</span></li>`;
  }
  updateCount();
  if (peerConnections[clientId]) { peerConnections[clientId].close(); delete peerConnections[clientId]; }
});

function updateClientStatus(clientId, status) {
  const li = document.getElementById(`client-${clientId}`);
  if (!li) return;
  const s = li.querySelector('.client-status');
  s.textContent = status;
  s.className = `client-status ${status==='connected'?'status-connected':(status==='failed'?'status-failed':'')}`;
}

// ─── QR CODE MODAL ────────────────────────────────────────────
const showQrBtn  = document.getElementById('showQrBtn');
const qrModal    = document.getElementById('qrModal');
const qrImg      = document.getElementById('qrImg');
const qrUrlText  = document.getElementById('qrUrlText');

function openQr() {
  let url = clientUrl.textContent;
  if (!url || url === 'Loading...') {
    url = `${window.location.protocol}//${window.location.host}/client`;
  }
  // Use free QR code API — no install needed
  const encoded = encodeURIComponent(url);
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&color=000000&bgcolor=ffffff&data=${encoded}`;
  qrUrlText.textContent = url;
  qrModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeQr() {
  qrModal.style.display = 'none';
  document.body.style.overflow = '';
}

// Also close on Escape key
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQr(); });

if (showQrBtn) showQrBtn.addEventListener('click', openQr);
