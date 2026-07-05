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
async function loadLibrary() {
  const grid = document.getElementById('library');
  const empty = document.getElementById('emptyState');
  if (!grid) return;

  // Sync from server if local (re-imports files + mappings lost from IndexedDB)
  try {
    await ServerSync.syncToIndexedDB();
    await ServerSync.restoreMappingsFromServer();
  } catch(e) { console.log('Server sync skipped:', e.message); }

  const pdfs = (await dbGetAll('pdfs')).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
  if (pdfs.length === 0) {
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
}

document.addEventListener('DOMContentLoaded', loadLibrary);
