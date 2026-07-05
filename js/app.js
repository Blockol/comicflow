// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Toast notifications
function showToast(msg, type = 'success') {
  const container = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Library page
async function waitForAutoImport(timeout = 15000) {
  const IMPORT_KEY = 'comicflow_music_imported_v1';
  if (localStorage.getItem(IMPORT_KEY)) return;
  // Wait for auto-import to finish
  return new Promise(resolve => {
    const handler = () => { window.removeEventListener('music-imported', handler); resolve(); };
    window.addEventListener('music-imported', handler);
    setTimeout(() => { window.removeEventListener('music-imported', handler); resolve(); }, timeout);
  });
}

async function loadLibrary() {
  const grid = document.getElementById('library');
  const empty = document.getElementById('emptyState');
  if (!grid) return;

  // Wait for auto-import to finish first (so music exists in DB for mapping sync)
  await waitForAutoImport();

  // Sync from server if local (re-imports files + mappings lost from IndexedDB)
  try {
    await ServerSync.syncToIndexedDB();
    await ServerSync.restoreMappingsFromServer();
  } catch(e) { console.log('Server sync skipped:', e.message); }

  // Sync from GitHub (mappings, sort order, descriptions)
  try {
    if (GitHubSync.isConfigured()) {
      const remote = await GitHubSync.loadFromGitHub();
      if (remote) await GitHubSync.applySyncData(remote);
    }
  } catch(e) { console.log('GitHub sync skipped:', e.message); }

  const pdfs = (await dbGetAll('pdfs')).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));

  // Check for missing files from registry
  await FileRegistry.syncFromDB();
  const missing = await FileRegistry.getMissing();

  if (pdfs.length === 0 && missing.length === 0) {
    empty.style.display = 'block';
    grid.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = '';

  for (const pdf of pdfs) {
    const card = document.createElement('div');
    card.className = 'card fade-in';
    card.onclick = () => window.location.href = `reader.html?id=${pdf.id}`;

    let coverHtml;
    if (pdf.cover) {
      coverHtml = `<img src="${pdf.cover}" alt="${pdf.name}">`;
    } else {
      coverHtml = `<div class="card-cover-placeholder">PDF</div>`;
    }

    card.innerHTML = `
      <div class="card-cover">
        ${coverHtml}
        <div class="card-overlay">
          <button class="card-overlay-btn">Lesen</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${pdf.name}</div>
        <div class="card-meta">${pdf.pageCount || '?'} Seiten</div>
      </div>
    `;
    grid.appendChild(card);
  }

  // Show missing files from registry
  for (const m of missing.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))) {
    const card = document.createElement('div');
    card.className = 'card fade-in card-missing';

    let coverHtml;
    if (m.cover) {
      coverHtml = `<img src="${m.cover}" alt="${m.name}" style="opacity:0.4;filter:grayscale(1);">`;
    } else {
      coverHtml = `<div class="card-cover-placeholder">?</div>`;
    }

    card.innerHTML = `
      <div class="card-cover">
        ${coverHtml}
        <div class="card-overlay card-overlay-missing">
          <span class="card-missing-label">Datei fehlt</span>
          <button class="card-overlay-btn" onclick="event.stopPropagation();window.location.href='admin.html'">Zur Verwaltung</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${m.name}</div>
        <div class="card-meta card-meta-missing">Nicht gefunden</div>
      </div>
    `;
    grid.appendChild(card);
  }
}

document.addEventListener('DOMContentLoaded', loadLibrary);
