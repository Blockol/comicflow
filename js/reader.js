pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function showToast(msg, type = 'success') {
  const container = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ══════════════════════════════
// ── Web Audio Crossfade Engine (AudioBuffer) ──
// ══════════════════════════════

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);
masterGain.gain.value = 0.5;

const FADE_SECONDS = 3;
const DEBOUNCE_MS = 350;

// activeTrack: { source: AudioBufferSourceNode, gain: GainNode, musicId }
let activeTrack = null;
let dyingTrack = null;

// Cache decoded AudioBuffers so we don't re-decode each time
const bufferCache = {};

function fadeGainTo(gainNode, targetValue, duration) {
  const now = audioCtx.currentTime;
  const currentVal = gainNode.gain.value;
  console.log(`[FADE] ${currentVal.toFixed(2)} → ${targetValue} über ${duration}s (audioCtx.currentTime=${now.toFixed(2)})`);
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(currentVal, now);
  gainNode.gain.linearRampToValueAtTime(targetValue, now + duration);
}

function stopTrack(track) {
  if (!track) return;
  try {
    track.source.stop();
  } catch(e) {}
  try {
    track.source.disconnect();
    track.gain.disconnect();
  } catch(e) {}
}

function createTrack(audioBuffer, musicId) {
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = true;

  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(masterGain);

  return { source, gain, musicId };
}

// ══════════════════════════════
// ── State ──
// ══════════════════════════════

const state = {
  pdfDoc: null,
  cbrPages: null,
  fileType: 'pdf',
  currentPage: 1,
  totalPages: 0,
  pdfId: null,
  mappings: [],
  musicCache: {},
  currentMusicId: null,
  volume: 0.5,
  debounceTimer: null,
};

const canvas = document.getElementById('pdfCanvas');
const ctx = canvas.getContext('2d');

async function init() {
  const params = new URLSearchParams(window.location.search);
  state.pdfId = Number(params.get('id'));
  if (!state.pdfId) {
    showToast('Keine Datei angegeben', 'error');
    return;
  }

  // Sync mappings from GitHub before loading (works without token via Pages fallback)
  try {
    const remote = await GitHubSync.loadFromGitHub();
    if (remote) await GitHubSync.applySyncData(remote);
  } catch(e) { console.log('GitHub sync skipped:', e.message); }

  let record = await dbGet('pdfs', state.pdfId);

  // If not in IndexedDB, try syncing from server
  if (!record && await ServerSync.isLocalServer()) {
    showToast('Lade vom Server...');
    await ServerSync.syncToIndexedDB();
    record = await dbGet('pdfs', state.pdfId);
  }

  if (!record) {
    showToast('Datei nicht gefunden', 'error');
    return;
  }

  document.title = `ComicFlow - ${record.name}`;
  state.fileType = record.type || 'pdf';
  state.mappings = await dbGetByIndex('mappings', 'pdfId', state.pdfId);

  if (state.fileType === 'cbr') {
    state.cbrPages = record.pages;
    state.totalPages = record.pages.length;
  } else {
    const typedArray = new Uint8Array(record.data);
    state.pdfDoc = await pdfjsLib.getDocument({ data: typedArray }).promise;
    state.totalPages = state.pdfDoc.numPages;
  }

  const saved = localStorage.getItem(`comicflow_page_${state.pdfId}`);
  if (saved) state.currentPage = Math.min(Number(saved), state.totalPages);

  renderPage(state.currentPage);
  setupControls();
}

// Page turn animation state
let turnAnimTimer = null;
let lastTurnTime = 0;
function getPageTurnStyle() {
  // Migrate old setting
  if (localStorage.getItem('comicflow_page_turn_anim') === '1') {
    localStorage.setItem('comicflow_page_turn_style', 'comic');
    localStorage.removeItem('comicflow_page_turn_anim');
  }
  return localStorage.getItem('comicflow_page_turn_style') || 'none';
}

async function renderPage(num, direction) {
  const style = direction ? getPageTurnStyle() : 'none';

  if (style === 'comic' && direction) {
    await animateComicFlip(num, direction);
  } else if (style === 'book' && direction) {
    await animateBookTurn(num, direction);
  } else {
    if (state.fileType === 'cbr') await renderCBRPage(num);
    else await renderPDFPage(num);
  }

  document.getElementById('pageInfo').textContent = `${num} / ${state.totalPages}`;
  document.getElementById('prevBtn').disabled = num <= 1;
  document.getElementById('nextBtn').disabled = num >= state.totalPages;
  localStorage.setItem(`comicflow_page_${state.pdfId}`, num);
  scheduleMusic(num);
}

async function animateComicFlip(num, direction) {
  const now = Date.now();
  const timeSinceLast = now - lastTurnTime;
  lastTurnTime = now;
  const speed = timeSinceLast < 600 ? '0.2s' : '0.4s';
  const halfSpeed = timeSinceLast < 600 ? 100 : 200;

  if (turnAnimTimer) { clearTimeout(turnAnimTimer); turnAnimTimer = null; }
  canvas.classList.remove('page-turn-next', 'page-turn-prev');
  void canvas.offsetWidth;

  canvas.style.setProperty('--turn-speed', speed);
  canvas.classList.add(direction === 'next' ? 'page-turn-next' : 'page-turn-prev');

  turnAnimTimer = setTimeout(async () => {
    if (state.fileType === 'cbr') await renderCBRPage(num);
    else await renderPDFPage(num);
  }, halfSpeed);

  setTimeout(() => {
    canvas.classList.remove('page-turn-next', 'page-turn-prev');
    turnAnimTimer = null;
  }, halfSpeed * 2 + 50);
}

async function animateBookTurn(num, direction) {
  const now = Date.now();
  const timeSinceLast = now - lastTurnTime;
  lastTurnTime = now;
  const fast = timeSinceLast < 600;
  const speed = fast ? '0.25s' : '0.5s';
  const duration = fast ? 250 : 500;

  // Remove any existing overlay
  const existing = document.querySelector('.page-turn-overlay');
  if (existing) existing.remove();

  // Capture current page as image
  const oldSnapshot = canvas.toDataURL('image/jpeg', 0.85);

  // Render new page on canvas
  if (state.fileType === 'cbr') await renderCBRPage(num);
  else await renderPDFPage(num);

  const wrapper = document.querySelector('.reader-canvas-wrapper');
  const overlay = document.createElement('div');
  overlay.className = 'page-turn-overlay';
  overlay.style.setProperty('--turn-speed', speed);
  overlay.style.width = canvas.style.width || (canvas.offsetWidth + 'px');
  overlay.style.height = canvas.style.height || (canvas.offsetHeight + 'px');
  overlay.style.position = 'absolute';

  // Position overlay on top of canvas
  const rect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  overlay.style.left = (rect.left - wrapperRect.left) + 'px';
  overlay.style.top = (rect.top - wrapperRect.top) + 'px';

  if (direction === 'next') {
    // Forward: old page peels away from right to left (pivot left/spine)
    const img = document.createElement('img');
    img.src = oldSnapshot;
    const shadow = document.createElement('div');
    shadow.className = 'page-shadow';
    overlay.appendChild(img);
    overlay.appendChild(shadow);
    overlay.classList.add('turn-next');
  } else {
    // Backward: new page swings in from the left (pivot left/spine)
    // Old page stays visible as static background
    const newSnapshot = canvas.toDataURL('image/jpeg', 0.85);

    const bgImg = document.createElement('img');
    bgImg.src = oldSnapshot;
    bgImg.className = 'page-turn-bg';

    const animImg = document.createElement('img');
    animImg.src = newSnapshot;
    animImg.className = 'page-turn-anim';

    const shadow = document.createElement('div');
    shadow.className = 'page-shadow';

    overlay.appendChild(bgImg);
    overlay.appendChild(animImg);
    overlay.appendChild(shadow);
    overlay.classList.add('turn-prev');
  }

  wrapper.appendChild(overlay);

  // Remove overlay after animation
  setTimeout(() => overlay.remove(), duration + 50);
}

async function renderPDFPage(num) {
  const page = await state.pdfDoc.getPage(num);
  const dpr = window.devicePixelRatio || 1;
  const cssScale = Math.min(
    (window.innerWidth * 0.95) / page.getViewport({ scale: 1 }).width,
    (window.innerHeight * 0.85) / page.getViewport({ scale: 1 }).height,
    2
  );
  const renderScale = cssScale * dpr;
  const viewport = page.getViewport({ scale: renderScale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = (viewport.width / dpr) + 'px';
  canvas.style.height = (viewport.height / dpr) + 'px';

  await page.render({ canvasContext: ctx, viewport }).promise;
}

async function renderCBRPage(num) {
  const pageData = state.cbrPages[num - 1];
  if (!pageData) return;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssScale = Math.min(
        (window.innerWidth * 0.95) / img.width,
        (window.innerHeight * 0.85) / img.height,
        2
      );

      canvas.width = img.width * cssScale * dpr;
      canvas.height = img.height * cssScale * dpr;
      canvas.style.width = (img.width * cssScale) + 'px';
      canvas.style.height = (img.height * cssScale) + 'px';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve();
    };
    img.onerror = () => {
      showToast(`Seite ${num} konnte nicht geladen werden`, 'error');
      resolve();
    };
    const blob = new Blob([pageData.data], { type: pageData.type || 'image/jpeg' });
    img.src = URL.createObjectURL(blob);
  });
}

// ══════════════════════════════
// ── Music Scheduling ──
// ══════════════════════════════

function scheduleMusic(pageNum) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    applyMusic(pageNum);
  }, DEBOUNCE_MS);
}

async function applyMusic(pageNum) {
  console.log(`[MUSIC] applyMusic(${pageNum}) aufgerufen. audioCtx.state=${audioCtx.state}, currentTime=${audioCtx.currentTime.toFixed(2)}`);

  if (audioCtx.state === 'suspended') {
    console.log('[MUSIC] AudioContext suspended → resume()');
    await audioCtx.resume();
    console.log(`[MUSIC] AudioContext resumed. state=${audioCtx.state}`);
  }

  const mapping = state.mappings.find(m => m.page === pageNum);
  console.log(`[MUSIC] Mapping für Seite ${pageNum}:`, mapping ? `musicId=${mapping.musicId}` : 'KEINE');
  console.log(`[MUSIC] Aktuell: currentMusicId=${state.currentMusicId}, activeTrack=${!!activeTrack}, dyingTrack=${!!dyingTrack}`);

  const indicator = document.getElementById('musicIndicator');
  const musicNameEl = document.getElementById('musicName');

  // ── No music for this page: fade out ──
  if (!mapping) {
    if (activeTrack) {
      console.log('[MUSIC] Kein Mapping → fade out activeTrack');
      fadeGainTo(activeTrack.gain, 0, FADE_SECONDS);
      const trackToKill = activeTrack;
      activeTrack = null;
      state.currentMusicId = null;
      setTimeout(() => stopTrack(trackToKill), FADE_SECONDS * 1000 + 200);
      indicator.style.display = 'none';
    } else {
      console.log('[MUSIC] Kein Mapping, kein activeTrack → nichts zu tun');
    }
    return;
  }

  // ── Same music already playing: keep it ──
  if (state.currentMusicId === mapping.musicId && activeTrack) {
    console.log('[MUSIC] Gleiche Musik läuft bereits → skip');
    return;
  }

  // ── Load and decode music data ──
  let audioBuffer = bufferCache[mapping.musicId];
  if (!audioBuffer) {
    let musicData = state.musicCache[mapping.musicId];
    if (!musicData) {
      musicData = await dbGet('music', mapping.musicId);
      if (musicData) state.musicCache[mapping.musicId] = musicData;
    }
    if (!musicData) {
      indicator.style.display = 'none';
      return;
    }
    try {
      // slice() to avoid detached buffer issues
      audioBuffer = await audioCtx.decodeAudioData(musicData.data.slice(0));
      bufferCache[mapping.musicId] = audioBuffer;
    } catch(e) {
      showToast('Musik konnte nicht dekodiert werden', 'error');
      return;
    }
  }

  // ── Build new track ──
  const newTrack = createTrack(audioBuffer, mapping.musicId);

  // ── Crossfade ──

  // 1. Kill any previously dying track immediately
  if (dyingTrack) {
    stopTrack(dyingTrack);
    dyingTrack = null;
  }

  // 2. Fade out old active track
  if (activeTrack) {
    dyingTrack = activeTrack;
    fadeGainTo(dyingTrack.gain, 0, FADE_SECONDS);
    const ref = dyingTrack;
    setTimeout(() => {
      stopTrack(ref);
      if (dyingTrack === ref) dyingTrack = null;
    }, FADE_SECONDS * 1000 + 200);
  }

  // 3. Start new track and fade in
  activeTrack = newTrack;
  state.currentMusicId = mapping.musicId;
  indicator.style.display = 'flex';
  musicNameEl.textContent = state.musicCache[mapping.musicId]?.name || 'Musik';

  console.log('[MUSIC] Starte neuen Track und fade in...');
  newTrack.source.start(0);
  fadeGainTo(newTrack.gain, 1, FADE_SECONDS);
  console.log('[MUSIC] Crossfade gestartet ✓');
}

// ══════════════════════════════
// ── Controls ──
// ══════════════════════════════

function setupControls() {
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const volumeSlider = document.getElementById('volumeSlider');

  prevBtn.onclick = () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderPage(state.currentPage, 'prev');
    }
  };

  nextBtn.onclick = () => {
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage, 'next');
    }
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      prevBtn.click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      nextBtn.click();
    }
  });

  volumeSlider.value = state.volume;
  volumeSlider.oninput = e => {
    state.volume = parseFloat(e.target.value);
    masterGain.gain.setValueAtTime(state.volume, audioCtx.currentTime);
  };

  // ── Two reading modes ──
  // Mode 1 (normal): nav + controls visible, swipe left/right = page change
  // Mode 2 (immersive): swipe DOWN to enter → UI hidden, swipe left/right = page change
  //                      pinch-to-zoom + pan works in this mode
  //                      swipe UP to exit → back to mode 1

  let immersive = false;
  let currentZoom = 1;
  let initialPinchDist = 0;
  let pinchStartZoom = 1;
  let panX = 0, panY = 0, panStartX = 0, panStartY = 0;
  let isPanning = false;
  const wrapper = document.querySelector('.reader-canvas-wrapper');
  const container = document.getElementById('readerContainer');
  const nav = document.querySelector('.nav');
  const controls = document.querySelector('.reader-controls');

  // Add transition styles for smooth animation
  nav.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
  controls.style.transition = 'transform 0.35s ease, opacity 0.35s ease';

  function enterImmersive() {
    if (immersive) return;
    immersive = true;
    currentZoom = 1; panX = 0; panY = 0;

    // Slide nav up, controls down
    nav.style.transform = 'translateY(-100%)';
    nav.style.opacity = '0';
    controls.style.transform = 'translateY(100%)';
    controls.style.opacity = '0';

    // Slight zoom-in pulse animation
    canvas.classList.add('animating');
    canvas.style.transform = 'scale(1.02)';
    setTimeout(() => { canvas.style.transform = ''; }, 350);
    setTimeout(() => canvas.classList.remove('animating'), 700);

    container.style.paddingTop = '0';
    document.body.style.overflow = 'hidden';
    wrapper.style.height = '100vh';
    wrapper.style.alignItems = 'center';
  }

  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    currentZoom = 1; panX = 0; panY = 0;

    // Slide nav back down, controls back up
    nav.style.transform = '';
    nav.style.opacity = '';
    controls.style.transform = '';
    controls.style.opacity = '';

    canvas.style.transform = '';
    container.style.paddingTop = '';
    document.body.style.overflow = '';
    wrapper.style.height = '';
    wrapper.style.alignItems = '';
  }

  function applyTransform() {
    canvas.style.transform = currentZoom > 1.01
      ? `scale(${currentZoom}) translate(${panX}px, ${panY}px)`
      : '';
    canvas.style.transformOrigin = 'center center';
  }

  // Pinch-to-zoom (both modes) + pan when zoomed
  let didPinchOrPan = false;

  wrapper.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      didPinchOrPan = true;
      initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchStartZoom = currentZoom;
    } else if (e.touches.length === 1 && currentZoom > 1.05) {
      isPanning = true;
      didPinchOrPan = true;
      panStartX = e.touches[0].clientX - panX * currentZoom;
      panStartY = e.touches[0].clientY - panY * currentZoom;
    }
  }, { passive: false });

  wrapper.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && initialPinchDist > 0) {
      e.preventDefault();
      didPinchOrPan = true;
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      currentZoom = Math.max(1, Math.min(pinchStartZoom * (dist / initialPinchDist), 5));
      applyTransform();
    } else if (e.touches.length === 1 && isPanning && currentZoom > 1.05) {
      e.preventDefault();
      didPinchOrPan = true;
      panX = (e.touches[0].clientX - panStartX) / currentZoom;
      panY = (e.touches[0].clientY - panStartY) / currentZoom;
      applyTransform();
    }
  }, { passive: false });

  wrapper.addEventListener('touchend', e => {
    if (e.touches.length < 2) initialPinchDist = 0;
    if (e.touches.length === 0) {
      isPanning = false;
      // Smooth snap back to center when zoomed out to 1x
      if (currentZoom <= 1.01 && (panX !== 0 || panY !== 0)) {
        canvas.classList.add('animating');
        panX = 0; panY = 0;
        currentZoom = 1;
        applyTransform();
        setTimeout(() => canvas.classList.remove('animating'), 350);
      }
    }
  });

  // Swipe gestures: left/right = page, down = immersive, up = exit immersive
  let touchStartX = 0;
  let touchStartY = 0;

  wrapper.addEventListener('touchstart', e => {
    if (e.touches.length === 1 && currentZoom <= 1.05) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      didPinchOrPan = false;
    }
  }, { passive: true });

  wrapper.addEventListener('touchend', e => {
    if (e.touches.length > 0) return;
    // Skip if we were zooming or panning
    if (didPinchOrPan) { didPinchOrPan = false; return; }

    const diffX = e.changedTouches[0].clientX - touchStartX;
    const diffY = e.changedTouches[0].clientY - touchStartY;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);

    if (absX > absY && absX > 50) {
      // Horizontal swipe: page change (both modes)
      if (diffX > 0) goPrev(); else goNext();
    } else if (absY > absX && absY > 60) {
      // Vertical swipe
      if (diffY > 0 && !immersive) {
        // Swipe DOWN: enter immersive
        enterImmersive();
      } else if (diffY < 0 && immersive && currentZoom <= 1.05) {
        // Swipe UP: exit immersive (only when not zoomed)
        exitImmersive();
      }
    }
  }, { passive: true });

  function goPrev() {
    if (state.currentPage > 1) {
      if (immersive) { currentZoom = 1; panX = 0; panY = 0; applyTransform(); }
      state.currentPage--;
      renderPage(state.currentPage, 'prev');
    }
  }

  function goNext() {
    if (state.currentPage < state.totalPages) {
      if (immersive) { currentZoom = 1; panX = 0; panY = 0; applyTransform(); }
      state.currentPage++;
      renderPage(state.currentPage, 'next');
    }
  }

  // Click on canvas to resume AudioContext (autoplay policy)
  canvas.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  // ── Pause music when app goes to background ──
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (activeTrack) {
        activeTrack.gain.gain.setValueAtTime(0, audioCtx.currentTime);
      }
      audioCtx.suspend();
    } else {
      audioCtx.resume().then(() => {
        if (activeTrack) {
          activeTrack.gain.gain.setValueAtTime(1, audioCtx.currentTime);
        }
      });
    }
  });

  window.addEventListener('resize', () => renderPage(state.currentPage));
}

document.addEventListener('DOMContentLoaded', init);
