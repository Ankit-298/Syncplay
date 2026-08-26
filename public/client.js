/* ============================================================
   SyncPlay Client – Advanced JS
   ============================================================ */
const socket = io();

// ─── DOM REFS ─────────────────────────────────────────────────
const remoteAudio      = document.getElementById('remoteAudio');
const connectionScreen = document.getElementById('connectionScreen');
const nowPlaying       = document.getElementById('nowPlaying');
const statusText       = document.getElementById('statusText');
const loadingDots      = document.getElementById('loadingDots');
const unmuteBtn        = document.getElementById('unmuteBtn');
const albumInner       = document.getElementById('albumInner');

// Track info
const trackTitle    = document.getElementById('trackTitle');
const trackArtist   = document.getElementById('trackArtist');

// Progress
const progressFill  = document.getElementById('progressFill');
const progressThumb = document.getElementById('progressThumb');
const progressTrack = document.getElementById('progressTrack');
const timeElapsed   = document.getElementById('timeElapsed');
const timeRemaining = document.getElementById('timeRemaining');
const timeLiveMode  = document.getElementById('timeLiveMode');


// Volume
const muteToggleBtn = document.getElementById('muteToggleBtn');
const volIcon       = document.getElementById('volIcon');
const volumeSlider  = document.getElementById('volumeSlider');
const volFill       = document.getElementById('volFill');
const volPct        = document.getElementById('volPct');

// Stats
const syncErrorEl   = document.getElementById('syncError');
const modeDisplay   = document.getElementById('modeDisplay');
const qualityDisplay= document.getElementById('qualityDisplay');

// Bluetooth
const btBadge       = document.getElementById('btBadge');
const btDeviceCard  = document.getElementById('btDeviceCard');
const btDeviceName  = document.getElementById('btDeviceName');

// Canvas
const waveCanvas    = document.getElementById('waveCanvas');
const waveCtx       = waveCanvas ? waveCanvas.getContext('2d') : null;

// ─── STATE ────────────────────────────────────────────────────
let pc           = null;
let hostSocketId = null;
let audioReady   = false;
let currentMode  = 'tab';
let timeOffset   = 0;
let rtt          = 0;
let playTimeout  = null;
let isMuted      = false;
let prevVol      = 1.0;
let trackDuration= 0;  // seconds, 0 = unknown (live/tab mode)
let isPlaying    = false;

// Audio analyser
let audioCtx   = null;
let analyser   = null;
let sourceNode = null;
let animFrameId= null;
let fakeWaveT  = 0;

// Progress animation
let progressRAF = null;

// ─── PARTICLES ────────────────────────────────────────────────
(function spawnParticles() {
  const c = document.getElementById('particles');
  if (!c) return;
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left:${Math.random()*100}%;
      animation-duration:${9+Math.random()*14}s;
      animation-delay:${Math.random()*12}s;
      width:${1.5+Math.random()*3}px;
      height:${1.5+Math.random()*3}px;
      background:${Math.random()>.5?'rgba(139,92,246,.4)':'rgba(6,182,212,.35)'};
    `;
    c.appendChild(p);
  }
})();

// ─── BG WAVE CANVAS ──────────────────────────────────────────
(function initBgWave() {
  const c = document.getElementById('bgWave');
  if (!c) return;
  const ctx = c.getContext('2d');
  let t = 0;
  const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
  window.addEventListener('resize', resize); resize();
  (function draw() {
    ctx.clearRect(0, 0, c.width, c.height);
    const W = c.width, H = c.height;
    [[0,'rgba(139,92,246,.4)'],[1,'rgba(6,182,212,.3)'],[2,'rgba(236,72,153,.25)']].forEach(([wi, col]) => {
      ctx.beginPath();
      const amp=30+wi*15, freq=.005+wi*.002, phase=t*(.3+wi*.15)+wi*Math.PI*.66, yBase=H*(.4+wi*.12);
      for (let x=0;x<=W;x+=2) {
        const y=yBase+Math.sin(x*freq+phase)*amp;
        wi===0&&x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.stroke();
    });
    t+=.01; requestAnimationFrame(draw);
  })();
})();

// ─── TIME FORMAT ─────────────────────────────────────────────
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

// ─── PROGRESS BAR UPDATE ─────────────────────────────────────
function updateProgress() {
  if (!isPlaying) return;
  const cur = remoteAudio.currentTime  || 0;
  const dur = remoteAudio.duration     || trackDuration || 0;

  if (dur > 0 && isFinite(dur)) {
    // Local mode: show real progress
    const pct = Math.min((cur / dur) * 100, 100);
    progressFill.style.width  = pct + '%';
    progressThumb.style.left  = pct + '%';
    timeElapsed.textContent   = fmt(cur);
    timeRemaining.textContent = '-' + fmt(dur - cur);
    timeLiveMode.textContent  = fmt(dur);
    timeLiveMode.style.color  = 'var(--tx3)';
  } else {
    // Live/tab mode: show running clock from audio.currentTime
    timeElapsed.textContent   = fmt(cur);
    timeRemaining.textContent = '';
    timeLiveMode.textContent  = 'LIVE STREAM';
    timeLiveMode.style.color  = 'var(--ok)';
    // Show shimmer pulse only; don't advance fill bar in live mode
    progressFill.style.width  = '0%';
    progressThumb.style.left  = '0%';
  }
  progressRAF = requestAnimationFrame(updateProgress);
}

function startProgress() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  progressRAF = requestAnimationFrame(updateProgress);
}
function stopProgress() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  progressRAF = null;
}

function setPlayState(playing) {
  isPlaying = playing;
  // No play/pause button on client — host controls playback
  if (playing) {
    nowPlaying.classList.remove('paused');
    startProgress();
  } else {
    nowPlaying.classList.add('paused');
    stopProgress();
  }
}


// Progress bar click (read-only on client — host controls seek)
// progressTrack.addEventListener('click', ...) removed

// ─── VOLUME ──────────────────────────────────────────────────
const VOL_ICONS = {
  mute:   `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`,
  low:    `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`,
  high:   `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`
};

function setVolume(v, skipSlider = false) {
  v = Math.max(0, Math.min(1, v));
  remoteAudio.volume = v;
  remoteAudio.muted  = false;
  isMuted = (v === 0);
  if (!skipSlider) volumeSlider.value = Math.round(v * 100);
  const pct = Math.round(v * 100);
  volPct.textContent   = pct + '%';
  volFill.style.width  = pct + '%';
  volIcon.innerHTML    = v === 0 ? VOL_ICONS.mute : v < .5 ? VOL_ICONS.low : VOL_ICONS.high;
  muteToggleBtn.classList.toggle('muted', v === 0);
}

volumeSlider.addEventListener('input', () => {
  const v = volumeSlider.value / 100;
  if (v > 0) prevVol = v;
  setVolume(v, true);
});

muteToggleBtn.addEventListener('click', () => {
  if (isMuted || remoteAudio.volume === 0) {
    setVolume(prevVol > 0 ? prevVol : 1.0);
  } else {
    prevVol = remoteAudio.volume;
    setVolume(0);
  }
});

// Init
setVolume(1.0);

// ─── BLUETOOTH DETECTION ─────────────────────────────────────
let btInterval = null;

async function detectBluetooth() {
  // Try Web Bluetooth API first
  if (navigator.bluetooth?.getDevices) {
    try {
      const devices = await navigator.bluetooth.getDevices();
      if (devices?.length) { showBT(devices[0].name || 'Bluetooth Device'); return; }
    } catch(e) {}
  }
  // Fallback: enumerateDevices
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const kws  = ['bluetooth','airpods','earbuds','earphone','headset','wireless','headphone','buds','pods'];
    for (const d of devs) {
      if (d.kind === 'audiooutput' && kws.some(k => d.label.toLowerCase().includes(k))) {
        showBT(d.label); return;
      }
    }
    // No BT found — hide if was showing
    hideBT();
  } catch(e) {}
}

function showBT(name) {
  btBadge.style.display      = 'flex';
  btDeviceCard.style.display = 'block';
  btDeviceName.textContent   = name || 'Wireless Earbuds';
}
function hideBT() {
  btBadge.style.display      = 'none';
  btDeviceCard.style.display = 'none';
}

function startBTPolling() {
  detectBluetooth();
  if (btInterval) clearInterval(btInterval);
  btInterval = setInterval(detectBluetooth, 8000);
}

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', detectBluetooth);
}
setTimeout(detectBluetooth, 1500);

// ─── WAVEFORM / ANALYSER ─────────────────────────────────────
function setupAnalyser(stream) {
  try {
    if (audioCtx) audioCtx.close();
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    if (stream) {
      sourceNode = audioCtx.createMediaStreamSource(stream);
    } else {
      sourceNode = audioCtx.createMediaElementSource(remoteAudio);
    }
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    drawRealWave();
  } catch(e) { drawFakeWave(); }
}

let waveTime = 0;

function drawRealWave() {
  if (!waveCtx || !analyser) { drawFakeWave(); return; }
  const buf = new Uint8Array(analyser.frequencyBinCount);
  function frame() {
    animFrameId = requestAnimationFrame(frame);
    analyser.getByteFrequencyData(buf);
    
    // Use lower 80 bins
    const activeBins = 80;
    const points = new Uint8Array(activeBins);
    for (let i=0; i<activeBins; i++) {
      points[i] = buf[i];
    }
    renderWave(points);
  }
  frame();
}

function drawFakeWave() {
  if (!waveCtx) return;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  function frame() {
    animFrameId = requestAnimationFrame(frame);
    const activeBins = 80;
    const points = new Uint8Array(activeBins);
    const simTime = Date.now() / 1000;
    for (let i = 0; i < activeBins; i++) {
      let val = 100 + Math.sin(i * 0.2 + simTime * 5) * 60 + Math.sin(i * 0.5 - simTime * 3) * 40;
      points[i] = Math.max(0, Math.min(255, val));
    }
    renderWave(points);
  }
  frame();
}

function renderWave(buf) {
  if (!waveCtx) return;
  const W = waveCanvas.offsetWidth || 360;
  const H = waveCanvas.offsetHeight || 120;
  if (waveCanvas.width !== W) waveCanvas.width = W;
  if (waveCanvas.height !== H) waveCanvas.height = H;

  waveTime += 2.0; // Color shifting speed

  // Clear canvas (pure black background)
  waveCtx.fillStyle = '#000';
  waveCtx.fillRect(0, 0, W, H);

  // We are receiving 90-128 bins (depending on what's passed from drawRealWave/FakeWave)
  const numBars = buf.length;
  // gap between bars
  const gap = 3; 
  const totalGap = gap * (numBars - 1);
  const barWidth = (W - totalGap) / numBars;
  
  const maxBarHeight = H * 0.95; // Leave a little padding at top

  // Draw bars
  waveCtx.lineCap = 'round';

  for (let i = 0; i < numBars; i++) {
    const val = buf[i]; // 0 to 255
    const barHeight = (val / 255) * maxBarHeight;
    
    const x = i * (barWidth + gap);
    // Minimum 2px height so we can always see the round dot even when silent
    const y = H - Math.max(2, barHeight); 
    
    // Shift color continuously (waveTime) and create a gradient across bars (i / numBars)
    const hue = (waveTime + (i / numBars) * 200) % 360;
    
    waveCtx.beginPath();
    waveCtx.lineWidth = barWidth;
    
    // Colors
    waveCtx.strokeStyle = `hsl(${hue}, 90%, 65%)`;
    waveCtx.shadowBlur = 10;
    waveCtx.shadowColor = `hsl(${hue}, 100%, 50%)`;
    
    // Draw a line from bottom to top of the bar
    waveCtx.moveTo(x + barWidth / 2, H);
    // Offset Y by barWidth/2 to compensate for the round cap sticking out
    waveCtx.lineTo(x + barWidth / 2, y + barWidth / 2);
    waveCtx.stroke();
  }
}

// ─── NTP TIME SYNC ───────────────────────────────────────────
function syncTime() { socket.emit('time-sync-request', { clientSendTime: Date.now() }); }
setInterval(syncTime, 5000);

socket.on('time-sync-response', (data) => {
  const now = Date.now();
  rtt = now - data.clientSendTime;
  timeOffset = (data.serverTime + rtt / 2) - now;
});

function getServerTime() { return Date.now() + timeOffset; }

// ─── WebRTC CONFIG ───────────────────────────────────────────
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 0
};

// ─── UI HELPERS ──────────────────────────────────────────────
function showNowPlaying(title = 'Live Audio Stream') {
  connectionScreen.style.display = 'none';
  nowPlaying.style.display = 'flex';
  setPlayState(true);

  const name = title.replace(/\.[^.]+$/, ''); // strip extension
  if (trackTitle)  trackTitle.textContent  = name;
  if (trackArtist) trackArtist.textContent = currentMode === 'tab' ? 'Live Broadcast from Host' : 'Streaming from Host';
  if (modeDisplay) modeDisplay.textContent = currentMode === 'tab' ? 'WebRTC' : 'Local';

  if (!analyser) drawFakeWave();

  startBTPolling();
}

function showConnectionScreen(msg) {
  nowPlaying.style.display = 'none';
  connectionScreen.style.display = 'flex';
  statusText.textContent = msg;
  loadingDots.style.display = 'flex';
  unmuteBtn.style.display = 'none';
  audioReady = false;
  setPlayState(false);
  stopProgress();
  if (remoteAudio) {
    remoteAudio.pause();
    if (currentMode === 'local') remoteAudio.src = '';
  }
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (btInterval)  { clearInterval(btInterval); btInterval = null; }
}

function showPlayButton(msg = '🎵 Audio ready!') {
  statusText.textContent = msg;
  loadingDots.style.display = 'none';
  unmuteBtn.style.display   = 'flex';
  audioReady = true;
}

// ─── TAP TO PLAY ────────────────────────────────────────────
unmuteBtn.addEventListener('click', () => {
  remoteAudio.muted  = false;
  setVolume(1.0);

  if (currentMode === 'tab') {
    remoteAudio.play()
      .then(() => showNowPlaying())
      .catch(e => console.error(e));
  } else {
    remoteAudio.play().then(() => {
      remoteAudio.pause();
      statusText.textContent = 'Ready! Waiting for host to play...';
      unmuteBtn.style.display = 'none';
      loadingDots.style.display = 'flex';
    }).catch(e => console.error(e));
  }
});

// ─── SOCKET EVENTS ───────────────────────────────────────────
socket.on('connect', () => {
  syncTime();
  statusText.textContent = 'Connected. Waiting for host...';
  socket.emit('register-client');
});

socket.on('network-error', (msg) => {
  showConnectionScreen(msg);
  statusText.style.color = '#ef4444'; // Red color for error
});

socket.on('disconnect', () => {
  showConnectionScreen('Disconnected. Reconnecting...');
  statusText.style.color = '#94a3b8'; // reset color
});
socket.on('host-available', () => {
  statusText.textContent = 'Host found! Connecting...';
  socket.emit('register-client');
});
socket.on('host-disconnected', () => {
  showConnectionScreen('Host disconnected. Waiting...');
  remoteAudio.srcObject = null;
  hostSocketId = null;
  if (pc) { pc.close(); pc = null; }
});

socket.on('force-sync', () => {
  if (currentMode === 'tab' && remoteAudio.srcObject && !remoteAudio.paused) {
    console.log('[SYNC] Force WebRTC audio sync');
    remoteAudio.pause();
    setTimeout(() => {
      remoteAudio.play().catch(e => console.error(e));
    }, 50);
  }
});

// ─── LOCAL SYNC ─────────────────────────────────────────────
socket.on('sync-load', (data) => {
  console.log('[SYNC] Load:', data.file);
  currentMode = 'local';
  remoteAudio.srcObject = null;
  if (pc) { pc.close(); pc = null; }

  trackDuration = 0;
  progressFill.style.width = '0%';
  progressThumb.style.left = '0%';
  timeElapsed.textContent   = '0:00';
  timeRemaining.textContent = '';
  timeLiveMode.textContent  = 'Loading...';

  remoteAudio.src     = `/media/${encodeURIComponent(data.file)}`;
  remoteAudio.preload = 'auto';
  remoteAudio.load();

  // Grab duration when metadata loads
  remoteAudio.onloadedmetadata = () => {
    trackDuration = remoteAudio.duration || 0;
    if (trackDuration > 0) timeLiveMode.textContent = fmt(trackDuration);
  };

  if (modeDisplay) modeDisplay.textContent = 'Local';
  showPlayButton(`Tap to allow playback for:\n${data.file}`);
});

socket.on('sync-play', (data) => {
  console.log('[SYNC] Play:', data);
  if (playTimeout) clearTimeout(playTimeout);

  showNowPlaying(data.file || 'Now Playing');
  setPlayState(true);

  const sTime   = getServerTime();
  const timeDiff = sTime - data.serverTime;

  const doPlay = () => {
    if (data.targetTime) {
      const delay = data.targetTime - getServerTime();
      try { if (remoteAudio.readyState >= 1) remoteAudio.currentTime = data.position; } catch(e){}
      if (delay > 0) {
        playTimeout = setTimeout(() => remoteAudio.play().catch(console.error), delay);
      } else {
        const missed = Math.abs(delay) / 1000;
        try { if (remoteAudio.readyState >= 1) remoteAudio.currentTime = data.position + missed; } catch(e){}
        remoteAudio.play().catch(console.error);
      }
    } else {
      const elapsed = timeDiff / 1000;
      try { if (remoteAudio.readyState >= 1) remoteAudio.currentTime = data.position + elapsed; } catch(e){}
      remoteAudio.play().catch(console.error);
    }
  };

  if (remoteAudio.readyState >= 1) doPlay();
  else {
    remoteAudio.addEventListener('loadedmetadata', doPlay, { once: true });
    setTimeout(doPlay, 2000);
  }
});

socket.on('sync-pause', (data) => {
  console.log('[SYNC] Pause:', data);
  if (playTimeout) clearTimeout(playTimeout);
  remoteAudio.pause();
  try { remoteAudio.currentTime = data.position; } catch(e){}
  setPlayState(false);
});

socket.on('sync-resume', (data) => {
  console.log('[SYNC] Resume:', data);
  if (playTimeout) clearTimeout(playTimeout);
  setPlayState(true);
  
  if (data.targetTime) {
    const delay = data.targetTime - getServerTime();
    try { if (remoteAudio.readyState >= 1) remoteAudio.currentTime = data.position; } catch(e){}
    
    if (delay > 0) {
      playTimeout = setTimeout(() => remoteAudio.play().catch(console.error), delay);
    } else {
      const missed = Math.abs(delay) / 1000;
      try { if (remoteAudio.readyState >= 1) remoteAudio.currentTime = data.position + missed; } catch(e){}
      remoteAudio.play().catch(console.error);
    }
  } else {
    const elapsed = (getServerTime() - data.serverTime) / 1000;
    try { remoteAudio.currentTime = data.position + elapsed; } catch(e){}
    remoteAudio.play().catch(console.error);
  }
});

socket.on('sync-seek', (data) => {
  const elapsed = (getServerTime() - data.serverTime) / 1000;
  try { remoteAudio.currentTime = data.position + elapsed; } catch(e){}
});

socket.on('sync-stop', () => {
  console.log('[SYNC] Stop');
  if (playTimeout) clearTimeout(playTimeout);
  remoteAudio.pause();
  try { remoteAudio.currentTime = 0; } catch(e){}
  setPlayState(false);
  progressFill.style.width = '0%';
  progressThumb.style.left = '0%';
  timeElapsed.textContent   = '0:00';
  timeRemaining.textContent = '';
  showConnectionScreen('Host stopped playback. Waiting...');
});

// ─── WEBRTC (Tab Capture) ────────────────────────────────────
socket.on('webrtc-offer', async (data) => {
  console.log('[Client] Offer from:', data.from);
  currentMode = 'tab';
  if (playTimeout) clearTimeout(playTimeout);
  if (modeDisplay) modeDisplay.textContent = 'WebRTC';
  trackDuration = 0;   // live — no duration
  statusText.textContent = 'Receiving audio...';

  if (hostSocketId !== data.from || !pc) {
    if (pc) { pc.close(); pc = null; }
    hostSocketId = data.from;
    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice-candidate', { to: hostSocketId, candidate: e.candidate });
    };

    pc.ontrack = (event) => {
      if (event.receiver?.playoutDelayHint !== undefined) event.receiver.playoutDelayHint = 0;
      const stream = event.streams[0] || new MediaStream([event.track]);
      remoteAudio.srcObject = stream;
      remoteAudio.muted  = false;
      remoteAudio.volume = volumeSlider.value / 100;

      try { setupAnalyser(stream); } catch(e) { drawFakeWave(); }

      const p = remoteAudio.play();
      if (p) p.then(() => showNowPlaying('Live Audio Broadcast')).catch(() => showPlayButton('🎵 Tap to Play'));
    };

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') {
        showConnectionScreen('Connection failed. Retrying...');
        pc.close(); pc = null; hostSocketId = null;
        setTimeout(() => socket.emit('register-client'), 1500);
      }
    };
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    let answer = await pc.createAnswer();
    let sdp = answer.sdp.replace(
      /a=fmtp:111 (.*)/g,
      'a=fmtp:111 minptime=10;useinbandfec=0;stereo=1;maxaveragebitrate=510000;cbr=1'
    );
    await pc.setLocalDescription(new RTCSessionDescription({ type: answer.type, sdp }));
    socket.emit('webrtc-answer', { to: hostSocketId, answer: pc.localDescription });
  } catch(err) { console.error('Offer error:', err); }
});

socket.on('ice-candidate', async (data) => {
  if (pc?.remoteDescription) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
  }
});

// ─── STATS UPDATE ─────────────────────────────────────────────
setInterval(async () => {
  if (currentMode === 'local') {
    if (rtt > 0 && syncErrorEl) syncErrorEl.textContent = Math.round(rtt);
    if (qualityDisplay) qualityDisplay.textContent = 'Local';
  } else if (pc?.connectionState === 'connected') {
    if (qualityDisplay) qualityDisplay.textContent = 'Hi-Fi';
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferDelay && r.jitterBufferEmittedCount > 0) {
          const ms = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
          if (syncErrorEl) syncErrorEl.textContent = Math.round(ms + 5);
        }
      });
    } catch(e){}
  }
}, 1000);

