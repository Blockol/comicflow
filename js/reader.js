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

async function renderPage(num) {
  if (state.fileType === 'cbr') {
    await renderCBRPage(num);
  } else {
    await renderPDFPage(num);
  }

  document.getElementById('pageInfo').textContent = `${num} / ${state.totalPages}`;
  document.getElementById('prevBtn').disabled = num <= 1;
  document.getElementById('nextBtn').disabled = num >= state.totalPages;
  localStorage.setItem(`comicflow_page_${state.pdfId}`, num);
  scheduleMusic(num);
}

async function renderPDFPage(num) {
  const page = await state.pdfDoc.getPage(num);
  const scale = Math.min(
    (window.innerWidth * 0.9) / page.getViewport({ scale: 1 }).width,
    (window.innerHeight * 0.85) / page.getViewport({ scale: 1 }).height,
    2
  );
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;
}

async function renderCBRPage(num) {
  const pageData = state.cbrPages[num - 1];
  if (!pageData) return;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(
        (window.innerWidth * 0.9) / img.width,
        (window.innerHeight * 0.85) / img.height,
        2
      );

      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
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
      renderPage(state.currentPage);
    }
  };

  nextBtn.onclick = () => {
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage);
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

  // Touch/swipe support
  let touchStartX = 0;
  canvas.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  canvas.addEventListener('touchend', e => {
    const diff = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) prevBtn.click();
      else nextBtn.click();
    }
  }, { passive: true });

  // Click on canvas to resume AudioContext (autoplay policy)
  canvas.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  window.addEventListener('resize', () => renderPage(state.currentPage));
}

document.addEventListener('DOMContentLoaded', init);
