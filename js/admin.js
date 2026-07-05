document.addEventListener('DOMContentLoaded', async () => {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // Sync from GitHub on admin page load (so assignments from other devices appear)
  try {
    const remote = await GitHubSync.loadFromGitHub();
    if (remote) await GitHubSync.applySyncData(remote);
    console.log('[ADMIN] GitHub sync done');
  } catch(e) { console.log('[ADMIN] GitHub sync skipped:', e.message); }

  // ── State ──
  let selectedPages = new Set();
  let lastClickedPage = null;
  let currentAssignPdfId = null;
  let currentMappings = [];
  let allMusic = [];
  let currentPdfRecord = null;  // full record for thumbnail/preview
  let currentPdfDoc = null;     // PDF.js document for PDF types
  let thumbCache = {};          // page number -> dataURL

  function showToast(msg, type = 'success') {
    const container = document.getElementById('toasts');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'assign') loadAssignTab();
    });
  });

  // ══════════════════════════════
  // ── PDFs / CBR ──
  // ══════════════════════════════

  document.getElementById('addPdfBtn').addEventListener('click', () => {
    document.getElementById('pdfModal').classList.add('active');
    document.getElementById('pdfName').value = '';
    document.getElementById('pdfFile').value = '';
  });

  window.closePdfModal = () => {
    document.getElementById('pdfModal').classList.remove('active');
  };

  document.getElementById('pdfSaveBtn').addEventListener('click', async () => {
    const nameField = document.getElementById('pdfName').value.trim();
    const files = document.getElementById('pdfFile').files;
    if (!files.length) {
      showToast('Datei(en) erforderlich', 'error');
      return;
    }

    const btn = document.getElementById('pdfSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Wird verarbeitet...';

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Use custom name for single file, otherwise filename
        const name = (files.length === 1 && nameField) ? nameField : file.name.replace(/\.[^.]+$/, '');
        await uploadComicFile(file, name);
        showToast(`"${name}" hinzugefügt`);
      }
      closePdfModal();
      loadPdfList();
    } catch (e) {
      console.error('Save failed:', e);
      showToast('Fehler: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Speichern';
    }
  });

  // ── Unified upload: saves to server (if local) + IndexedDB ──
  async function uploadComicFile(file, name) {
    const ext = file.name.split('.').pop().toLowerCase();
    const isCBR = ext === 'cbr' || ext === 'rar';
    let serverId = null;

    // Upload to server if running locally
    if (await ServerSync.isLocalServer()) {
      const result = await ServerSync.uploadComic(file);
      serverId = result.id;
    }

    if (isCBR) {
      await saveCBR(name, file, serverId);
    } else {
      await savePDF(name, file, serverId);
    }

    // Re-sync mappings from GitHub for this newly uploaded file
    try {
      const remote = await GitHubSync.loadFromGitHub();
      if (remote) await GitHubSync.applySyncData(remote);
    } catch(e) { console.log('Post-upload sync skipped:', e.message); }
  }

  // ── Drag & Drop for PDFs/CBRs (same pattern as working music drop) ──
  const pdfDropTarget = document.getElementById('tab-pdfs');
  const pdfDropZone = document.getElementById('pdfDropZone');

  // Only react to external file drops (from OS), not internal reorder drags
  function isFileDrag(e) {
    return e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/plain');
  }

  pdfDropTarget.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (pdfDropZone) pdfDropZone.classList.add('drag-over');
  });

  pdfDropTarget.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (pdfDropZone) pdfDropZone.classList.remove('drag-over');
  });

  pdfDropTarget.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (pdfDropZone) pdfDropZone.classList.remove('drag-over');

    const allFiles = [...e.dataTransfer.files];
    console.log('[DROP] Dateien:', allFiles.map(f => `${f.name} (type=${f.type})`));

    const files = allFiles.filter(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      return ext === 'pdf' || ext === 'cbr' || ext === 'rar'
        || f.type === 'application/pdf'
        || f.type === 'application/x-cbr'
        || f.type === 'application/x-rar-compressed'
        || f.type === 'application/vnd.rar';
    });

    if (files.length === 0) {
      showToast(`Keine PDF/CBR-Dateien erkannt (${allFiles.length} Datei(en) ignoriert)`, 'error');
      return;
    }

    showToast(`${files.length} Datei(en) werden importiert...`);

    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '');
      try {
        await uploadComicFile(file, name);
        showToast(`"${name}" hinzugefügt`);
      } catch (err) {
        console.error('Upload failed:', file.name, err);
        showToast(`Fehler bei "${name}": ${err.message}`, 'error');
      }
    }

    loadPdfList();
  });

  async function savePDF(name, file, serverId) {
    const arrayBuffer = await file.arrayBuffer();
    const storageBuffer = arrayBuffer.slice(0);
    let pageCount = 0;
    let cover = null;
    try {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      pageCount = pdf.numPages;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.5 });
      const cvs = document.createElement('canvas');
      cvs.width = viewport.width;
      cvs.height = viewport.height;
      const cctx = cvs.getContext('2d');
      await page.render({ canvasContext: cctx, viewport }).promise;
      cover = cvs.toDataURL('image/jpeg', 0.7);
    } catch (e) {
      console.error('PDF processing error:', e);
    }
    const dbId = await dbAdd('pdfs', { name, type: 'pdf', data: storageBuffer, pageCount, cover, serverId: serverId || null });

    // Register in localStorage backup
    FileRegistry.register({ dbId, name, type: 'pdf', pageCount, cover, sortOrder: 9999 });

    // Update server metadata
    if (serverId && (pageCount || cover)) {
      try { await ServerSync.updateComic(serverId, { pageCount, cover }); } catch {}
    }
  }

  async function saveCBR(name, file, serverId) {
    showToast('CBR wird verarbeitet...');
    try {
      const arrayBuffer = await file.arrayBuffer();

      const wasmResp = await fetch('lib/unrar.wasm');
      const wasmBinary = await wasmResp.arrayBuffer();

      const extractor = await createExtractorFromData({
        wasmBinary,
        data: arrayBuffer,
      });

      const { files } = extractor.extract();
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
      const images = [];

      for (const entry of files) {
        const fName = entry.fileHeader.name;
        const fExt = fName.split('.').pop().toLowerCase();
        if (imageExts.includes(fExt) && entry.extraction) {
          images.push({
            name: fName,
            data: entry.extraction,
          });
        }
      }

      images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      if (images.length === 0) {
        showToast('Keine Bilder im Archiv gefunden', 'error');
        return;
      }

      function getMime(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', bmp:'image/bmp', webp:'image/webp' };
        return map[ext] || 'image/jpeg';
      }

      const pages = images.map(img => ({
        data: img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength),
        type: getMime(img.name),
      }));

      let cover = null;
      try {
        const firstBlob = new Blob([pages[0].data], { type: pages[0].type });
        cover = await blobToDataURL(firstBlob, 300);
      } catch (e) {
        console.error('CBR cover generation failed', e);
      }

      const dbId = await dbAdd('pdfs', {
        name, type: 'cbr', data: null,
        pages, pageCount: pages.length, cover, serverId: serverId || null
      });

      // Register in localStorage backup
      FileRegistry.register({ dbId, name, type: 'cbr', pageCount: pages.length, cover, sortOrder: 9999 });

      if (serverId && (pages.length || cover)) {
        try { await ServerSync.updateComic(serverId, { pageCount: pages.length, cover }); } catch {}
      }
    } catch (e) {
      console.error('CBR processing failed', e);
      showToast('CBR-Fehler: ' + e, 'error');
    }
  }

  function blobToDataURL(blob, maxWidth) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxWidth / img.width, 1);
        const cvs = document.createElement('canvas');
        cvs.width = img.width * scale;
        cvs.height = img.height * scale;
        cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
        resolve(cvs.toDataURL('image/jpeg', 0.7));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(blob);
    });
  }

  // ── PDF List ──
  let serverComicsCache = [];

  async function loadPdfList() {
    const pdfs = await dbGetAll('pdfs');
    const list = document.getElementById('pdfList');
    const empty = document.getElementById('pdfEmpty');

    // Fetch server status if local
    let serverComics = [];
    const isLocal = await ServerSync.isLocalServer();
    if (isLocal) {
      try {
        serverComics = await ServerSync.getComics();
        serverComicsCache = serverComics;
      } catch {}
    }

    // Sync registry from current DB (populates for existing users)
    await FileRegistry.syncFromDB();

    // Merge: IndexedDB + server + registry (missing files)
    const merged = [];
    const seenServerIds = new Set();
    const seenDbIds = new Set();

    // First: IndexedDB entries with server link
    for (const p of pdfs) {
      const sc = p.serverId ? serverComics.find(s => s.id === p.serverId) : null;
      merged.push({
        ...p,
        serverEntry: sc || null,
        fileExists: sc ? sc.exists : true,
        source: 'indexeddb',
      });
      if (sc) seenServerIds.add(sc.id);
      seenDbIds.add(p.id);
    }

    // Then: server-only entries (not yet in IndexedDB)
    for (const sc of serverComics) {
      if (!seenServerIds.has(sc.id)) {
        merged.push({
          id: null,
          name: sc.name,
          type: sc.type,
          pageCount: sc.pageCount || '?',
          serverId: sc.id,
          serverEntry: sc,
          fileExists: sc.exists,
          source: 'server-only',
        });
      }
    }

    // Then: registry entries missing from IndexedDB (browser data cleared)
    const missingFromRegistry = await FileRegistry.getMissing();
    for (const m of missingFromRegistry) {
      // Skip if already shown via server
      const alreadyShown = merged.find(x => x.name === m.name && x.source !== 'indexeddb');
      if (alreadyShown) continue;
      merged.push({
        id: null,
        name: m.name,
        type: m.type,
        pageCount: m.pageCount || '?',
        cover: m.cover || null,
        sortOrder: m.sortOrder ?? 9999,
        registryDbId: m.dbId,
        fileExists: false,
        source: 'registry-missing',
      });
    }

    if (merged.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    // Sort by sortOrder
    merged.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));

    empty.style.display = 'none';
    list.innerHTML = '';

    // Store merged for reorder access
    list._mergedItems = merged;

    merged.forEach((p, index) => {
      const isMissing = !p.fileExists;
      const isServerOnly = p.source === 'server-only';
      const statusClass = isMissing ? 'pdf-item-missing' : (isServerOnly ? 'pdf-item-server-only' : '');

      let statusBadge = '';
      if (isMissing) {
        statusBadge = '<span class="pdf-status-badge missing">Datei nicht gefunden</span>';
      } else if (isServerOnly) {
        statusBadge = '<span class="pdf-status-badge server-only">Nur auf Server</span>';
      } else if (isLocal && p.serverId) {
        statusBadge = '<span class="pdf-status-badge synced">Gespeichert</span>';
      }

      let actions = '';
      if (p.source === 'registry-missing') {
        actions = `
          <button class="btn btn-accent btn-sm" onclick="reuploadFromRegistry(${p.registryDbId})">Neu hochladen</button>
          <button class="btn btn-danger btn-sm" onclick="removeFromRegistry(${p.registryDbId})">Entfernen</button>
        `;
      } else if (isMissing) {
        actions = `
          <button class="btn btn-accent btn-sm" onclick="reassignFile(${p.serverId})">Neu zuweisen</button>
          <button class="btn btn-danger btn-sm" onclick="deletePdf(${p.id || 'null'}, ${p.serverId || 'null'})">Entfernen</button>
        `;
      } else if (isServerOnly) {
        actions = `
          <button class="btn btn-accent btn-sm" onclick="importFromServer(${p.serverId})">Importieren</button>
          <button class="btn btn-danger btn-sm" onclick="deletePdf(null, ${p.serverId})">Entfernen</button>
        `;
      } else {
        actions = `
          <button class="btn btn-sm" onclick="renamePdf(${p.id})">Umbenennen</button>
          <button class="btn btn-danger btn-sm" onclick="deletePdf(${p.id}, ${p.serverId || 'null'})">L&ouml;schen</button>
        `;
      }

      const div = document.createElement('div');
      div.className = `pdf-item ${statusClass}`;
      div.dataset.index = index;
      div.dataset.pdfId = p.id || '';
      div.innerHTML = `
        <div class="pdf-item-drag-handle" title="Ziehen zum Sortieren">&#9776;</div>
        <div class="pdf-item-icon">${(p.type || 'pdf').toUpperCase()}</div>
        <div class="pdf-item-info">
          <div class="pdf-item-name" id="pdf-name-${p.id || 'srv-' + p.serverId}">${p.name}</div>
          <div class="pdf-item-meta">${p.pageCount || '?'} Seiten ${statusBadge}</div>
        </div>
        <div class="pdf-item-actions">${actions}</div>
      `;

      list.appendChild(div);
    });

    // ── Reorder via drag handle (mousedown-based) ──
    setupReorderDrag(list);
  }

  // ── Reorder: mouse-based drag (works reliably, no HTML5 drag API) ──
  function setupReorderDrag(listEl) {
    let dragEl = null;
    let placeholder = null;
    let startY = 0;
    let offsetY = 0;

    listEl.querySelectorAll('.pdf-item-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragEl = handle.closest('.pdf-item');
        if (!dragEl) return;

        const rect = dragEl.getBoundingClientRect();
        offsetY = e.clientY - rect.top;
        startY = e.clientY;

        // Create placeholder
        placeholder = document.createElement('div');
        placeholder.className = 'pdf-item-placeholder';
        placeholder.style.height = rect.height + 'px';
        dragEl.parentNode.insertBefore(placeholder, dragEl);

        // Make drag element floating
        dragEl.classList.add('reorder-dragging');
        dragEl.style.width = rect.width + 'px';
        dragEl.style.top = rect.top + 'px';
        dragEl.style.left = rect.left + 'px';
        document.body.appendChild(dragEl);

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });

    function onMouseMove(e) {
      if (!dragEl) return;
      dragEl.style.top = (e.clientY - offsetY) + 'px';

      // Find the item we're hovering over
      const items = [...listEl.querySelectorAll('.pdf-item:not(.reorder-dragging)')];
      let insertBefore = null;

      for (const item of items) {
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          insertBefore = item;
          break;
        }
      }

      // Move placeholder
      if (insertBefore) {
        listEl.insertBefore(placeholder, insertBefore);
      } else {
        listEl.appendChild(placeholder);
      }
    }

    async function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!dragEl || !placeholder) return;

      // Insert drag element at placeholder position
      dragEl.classList.remove('reorder-dragging');
      dragEl.style.width = '';
      dragEl.style.top = '';
      dragEl.style.left = '';
      listEl.insertBefore(dragEl, placeholder);
      placeholder.remove();

      // Read new order from DOM and save
      const items = [...listEl.querySelectorAll('.pdf-item')];
      const merged = listEl._mergedItems;
      if (!merged) return;

      let changed = false;
      for (let i = 0; i < items.length; i++) {
        const pdfId = Number(items[i].dataset.pdfId);
        if (!pdfId) continue;
        const record = await dbGet('pdfs', pdfId);
        if (record && record.sortOrder !== i) {
          record.sortOrder = i;
          await dbUpdate('pdfs', record);
          FileRegistry.update(pdfId, { sortOrder: i });
          changed = true;
        }
      }

      dragEl = null;
      placeholder = null;

      if (changed) {
        showToast('Reihenfolge aktualisiert');
        GitHubSync.quickSave();
        loadPdfList();
      }
    }
  }

  window.reuploadFromRegistry = async (registryDbId) => {
    const registry = FileRegistry.getAll();
    const entry = registry.find(e => e.dbId === registryDbId);
    if (!entry) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.cbr,.rar';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;

      showToast(`"${entry.name}" wird neu hochgeladen...`);
      try {
        await uploadComicFile(file, entry.name);
        // Remove old registry entry (new one was created by uploadComicFile)
        FileRegistry.remove(registryDbId);
        showToast(`"${entry.name}" wiederhergestellt`);
        loadPdfList();
      } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
      }
    };
    input.click();
  };

  window.removeFromRegistry = (registryDbId) => {
    if (!confirm('Eintrag aus der Liste entfernen?')) return;
    FileRegistry.remove(registryDbId);
    showToast('Entfernt');
    loadPdfList();
  };

  window.renamePdf = async (id) => {
    const record = await dbGet('pdfs', id);
    if (!record) return;
    const newName = prompt('Neuer Name:', record.name);
    if (!newName || !newName.trim() || newName.trim() === record.name) return;
    record.name = newName.trim();
    await dbUpdate('pdfs', record);
    FileRegistry.update(id, { name: record.name });

    // Also update on server
    if (record.serverId) {
      try { await ServerSync.updateComic(record.serverId, { name: record.name }); } catch {}
    }
    showToast(`Umbenannt zu "${record.name}"`);
    loadPdfList();
  };

  window.deletePdf = async (id, serverId) => {
    if (!confirm('Wirklich löschen? Alle Zuweisungen gehen verloren.')) return;
    if (id) {
      await dbDelete('pdfs', id);
      await dbClearByIndex('mappings', 'pdfId', id);
      FileRegistry.remove(id);
    }
    if (serverId) {
      try { await ServerSync.deleteComic(serverId); } catch {}
    }
    showToast('Gelöscht');
    loadPdfList();
  };

  window.reassignFile = async (serverId) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.cbr,.rar';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;

      showToast('Datei wird neu zugewiesen...');
      try {
        await ServerSync.reassignComic(serverId, file);

        const serverComics = await ServerSync.getComics();
        const sc = serverComics.find(s => s.id === serverId);
        if (!sc) { showToast('Server-Eintrag nicht gefunden', 'error'); return; }

        const arrayBuffer = await ServerSync.fetchComicFile(serverId);
        if (!arrayBuffer) { showToast('Datei konnte nicht geladen werden', 'error'); return; }

        // Find existing IndexedDB entry to preserve its ID (and thus mappings)
        const allPdfs = await dbGetAll('pdfs');
        const existing = allPdfs.find(p => p.serverId === serverId);

        if (existing) {
          // UPDATE existing record in-place (keeps same ID → mappings stay intact)
          const ext = file.name.split('.').pop().toLowerCase();
          const isCBR = ext === 'cbr' || ext === 'rar';

          if (isCBR) {
            const wasmResp = await fetch('lib/unrar.wasm');
            const wasmBinary = await wasmResp.arrayBuffer();
            const extractor = await createExtractorFromData({ wasmBinary, data: arrayBuffer });
            const { files } = extractor.extract();
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
            const images = [];
            for (const entry of files) {
              const fExt = entry.fileHeader.name.split('.').pop().toLowerCase();
              if (imageExts.includes(fExt) && entry.extraction) {
                images.push({ name: entry.fileHeader.name, data: entry.extraction });
              }
            }
            images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            function getMime(n) {
              const e = n.split('.').pop().toLowerCase();
              return { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', bmp:'image/bmp', webp:'image/webp' }[e] || 'image/jpeg';
            }
            existing.type = 'cbr';
            existing.data = null;
            existing.pages = images.map(img => ({
              data: img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength),
              type: getMime(img.name),
            }));
            existing.pageCount = existing.pages.length;
            try {
              const blob = new Blob([existing.pages[0].data], { type: existing.pages[0].type });
              existing.cover = await blobToDataURL(blob, 300);
            } catch { existing.cover = null; }
          } else {
            const buf = arrayBuffer.slice(0);
            existing.type = 'pdf';
            existing.data = buf;
            existing.pages = undefined;
            try {
              const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
              existing.pageCount = pdf.numPages;
              const page = await pdf.getPage(1);
              const vp = page.getViewport({ scale: 0.5 });
              const cvs = document.createElement('canvas');
              cvs.width = vp.width; cvs.height = vp.height;
              await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
              existing.cover = cvs.toDataURL('image/jpeg', 0.7);
            } catch { existing.pageCount = 0; existing.cover = null; }
          }

          await dbUpdate('pdfs', existing);
          try { await ServerSync.updateComic(serverId, { pageCount: existing.pageCount, cover: existing.cover }); } catch {}
        } else {
          // No existing entry → create new
          if (sc.type === 'cbr') {
            await ServerSync.importCBRFromBuffer(sc.name, arrayBuffer, serverId);
          } else {
            await ServerSync.importPDFFromBuffer(sc.name, arrayBuffer, serverId);
          }
        }

        showToast('Datei erfolgreich neu zugewiesen');
        loadPdfList();
      } catch (e) {
        console.error('Reassign failed:', e);
        showToast('Fehler: ' + e.message, 'error');
      }
    };
    input.click();
  };

  window.importFromServer = async (serverId) => {
    showToast('Wird importiert...');
    try {
      const serverComics = await ServerSync.getComics();
      const sc = serverComics.find(s => s.id === serverId);
      if (!sc) { showToast('Nicht gefunden', 'error'); return; }

      const arrayBuffer = await ServerSync.fetchComicFile(serverId);
      if (!arrayBuffer) { showToast('Datei konnte nicht geladen werden', 'error'); return; }

      if (sc.type === 'cbr') {
        await ServerSync.importCBRFromBuffer(sc.name, arrayBuffer, serverId);
      } else {
        await ServerSync.importPDFFromBuffer(sc.name, arrayBuffer, serverId);
      }

      showToast(`"${sc.name}" importiert`);
      loadPdfList();
    } catch (e) {
      showToast('Import-Fehler: ' + e.message, 'error');
    }
  };

  // ══════════════════════════════
  // ── Music ──
  // ══════════════════════════════

  document.getElementById('addMusicBtn').addEventListener('click', () => {
    document.getElementById('musicModal').classList.add('active');
    document.getElementById('musicName').value = '';
    document.getElementById('musicFile').value = '';
  });

  window.closeMusicModal = () => {
    document.getElementById('musicModal').classList.remove('active');
  };

  // Auto-fill music name from MP3 ID3 tags when file is selected
  document.getElementById('musicFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const checkbox = document.getElementById('musicUseFileTitle');
    if (!file || !checkbox.checked) return;

    const title = await readMP3Title(file);
    if (title) {
      document.getElementById('musicName').value = title;
    } else {
      // Fallback: use filename without extension
      document.getElementById('musicName').value = file.name.replace(/\.[^.]+$/, '');
    }
  });

  document.getElementById('musicUseFileTitle').addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    const file = document.getElementById('musicFile').files[0];
    if (!file) return;

    const title = await readMP3Title(file);
    if (title) {
      document.getElementById('musicName').value = title;
    } else {
      document.getElementById('musicName').value = file.name.replace(/\.[^.]+$/, '');
    }
  });

  // Read ID3v2 or ID3v1 title tag from MP3
  async function readMP3Title(file) {
    try {
      const buf = await file.slice(0, 4096).arrayBuffer();
      const view = new DataView(buf);

      // ID3v2 header check
      if (view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
        // Parse ID3v2 frames to find TIT2 (title)
        const flags = view.getUint8(5);
        let offset = 10;
        // Extended header?
        if (flags & 0x40) {
          offset += view.getUint32(10, false);
        }
        while (offset + 10 < buf.byteLength) {
          const frameId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
          const frameSize = view.getUint32(offset + 4, false);
          if (frameSize === 0 || frameSize > 4000) break;
          if (frameId === 'TIT2') {
            const encoding = view.getUint8(offset + 10);
            const textBytes = new Uint8Array(buf, offset + 11, frameSize - 1);
            if (encoding === 3 || encoding === 0) {
              return new TextDecoder('utf-8').decode(textBytes).replace(/\0/g, '').trim();
            } else if (encoding === 1) {
              return new TextDecoder('utf-16').decode(textBytes).replace(/\0/g, '').trim();
            }
          }
          offset += 10 + frameSize;
        }
      }

      // ID3v1 fallback (last 128 bytes)
      if (file.size > 128) {
        const tailBuf = await file.slice(file.size - 128, file.size).arrayBuffer();
        const tailView = new DataView(tailBuf);
        if (tailView.getUint8(0) === 0x54 && tailView.getUint8(1) === 0x41 && tailView.getUint8(2) === 0x47) {
          const titleBytes = new Uint8Array(tailBuf, 3, 30);
          return new TextDecoder('iso-8859-1').decode(titleBytes).replace(/\0/g, '').trim();
        }
      }
    } catch(e) {
      console.error('ID3 read failed:', e);
    }
    return null;
  }

  // ── Drag & Drop for music files ──
  const musicDropZone = document.getElementById('tab-music');

  musicDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    musicDropZone.classList.add('drag-over');
  });

  musicDropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    musicDropZone.classList.remove('drag-over');
  });

  musicDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    musicDropZone.classList.remove('drag-over');

    const files = [...e.dataTransfer.files].filter(f =>
      f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name)
    );

    if (files.length === 0) {
      showToast('Keine Audio-Dateien erkannt', 'error');
      return;
    }

    showToast(`${files.length} Datei(en) werden importiert...`);

    for (const file of files) {
      let name = await readMP3Title(file);
      if (!name) name = file.name.replace(/\.[^.]+$/, '');

      const arrayBuffer = await file.arrayBuffer();
      await dbAdd('music', { name, data: arrayBuffer, type: file.type });
    }

    showToast(`${files.length} Musik-Datei(en) hinzugefügt`);
    loadMusicList();
  });

  document.getElementById('musicSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('musicName').value.trim();
    const file = document.getElementById('musicFile').files[0];
    if (!name || !file) {
      showToast('Name und Audio-Datei erforderlich', 'error');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    await dbAdd('music', { name, data: arrayBuffer, type: file.type });
    showToast(`"${name}" hinzugefügt`);
    closeMusicModal();
    loadMusicList();
  });

  async function loadMusicList() {
    allMusic = await dbGetAll('music');
    const list = document.getElementById('musicList');
    const empty = document.getElementById('musicEmpty');

    if (allMusic.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = allMusic.map(m => `
      <li class="music-item">
        <div class="music-item-info">
          <div class="music-item-icon">&#9835;</div>
          <div class="music-item-text">
            <span class="music-item-name">${m.name}</span>
            ${m.description ? `<span class="music-item-desc">${m.description}</span>` : '<span class="music-item-desc music-item-desc-empty">Keine Beschreibung</span>'}
          </div>
        </div>
        <div class="music-item-actions">
          <button class="btn btn-sm" id="previewBtn-${m.id}" onclick="togglePreview(${m.id})">&#9654; Probe</button>
          <button class="btn btn-sm" onclick="editMusicDesc(${m.id})">Beschreibung</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMusic(${m.id})">L&ouml;schen</button>
        </div>
      </li>
    `).join('');
  }

  let previewAudio = null;
  let previewingId = null;

  window.togglePreview = async (id) => {
    const btn = document.getElementById(`previewBtn-${id}`);

    // If same track is playing, stop it
    if (previewAudio && previewingId === id) {
      previewAudio.pause();
      previewAudio = null;
      previewingId = null;
      if (btn) btn.innerHTML = '&#9654; Probe';
      return;
    }

    // Stop any playing track
    if (previewAudio) {
      previewAudio.pause();
      const oldBtn = document.getElementById(`previewBtn-${previewingId}`);
      if (oldBtn) oldBtn.innerHTML = '&#9654; Probe';
      previewAudio = null;
    }

    const m = await dbGet('music', id);
    if (!m) return;
    const blob = new Blob([m.data], { type: m.type || 'audio/mpeg' });
    previewAudio = new Audio(URL.createObjectURL(blob));
    previewAudio.volume = 0.5;
    previewingId = id;
    if (btn) btn.innerHTML = '&#9632; Stop';

    previewAudio.onended = () => {
      previewAudio = null;
      previewingId = null;
      if (btn) btn.innerHTML = '&#9654; Probe';
    };

    previewAudio.play();
  };

  window.editMusicDesc = async (id) => {
    const m = await dbGet('music', id);
    if (!m) return;
    const desc = prompt('Beschreibung:', m.description || '');
    if (desc === null) return; // cancelled
    m.description = desc.trim();
    await dbUpdate('music', m);
    showToast('Beschreibung gespeichert');
    loadMusicList();
    GitHubSync.quickSave();
  };

  window.deleteMusic = async (id) => {
    if (!confirm('Musik wirklich löschen?')) return;
    if (previewAudio) { previewAudio.pause(); previewAudio = null; previewingId = null; }
    await dbDelete('music', id);
    showToast('Musik gelöscht');
    loadMusicList();
  };

  // ══════════════════════════════
  // ── Assignments ──
  // ══════════════════════════════

  async function loadAssignTab() {
    const pdfs = await dbGetAll('pdfs');
    allMusic = await dbGetAll('music');

    const pdfSelect = document.getElementById('assignPdfSelect');
    pdfSelect.innerHTML = '<option value="">-- Comic/PDF wählen --</option>' +
      pdfs.map(p => `<option value="${p.id}">${p.name} (${p.pageCount} S.)</option>`).join('');

    const musicSelect = document.getElementById('assignMusicSelect');
    musicSelect.innerHTML = '<option value="">-- Musik wählen --</option>' +
      allMusic.map(m => `<option value="${m.id}">${m.name}${m.description ? ' — ' + m.description : ''}</option>`).join('');
  }

  document.getElementById('assignPdfSelect').addEventListener('change', async (e) => {
    const id = Number(e.target.value);
    const gridContainer = document.getElementById('pageGridContainer');
    const hint = document.getElementById('assignHint');

    if (!id) {
      gridContainer.style.display = 'none';
      hint.style.display = 'block';
      currentPdfRecord = null;
      currentPdfDoc = null;
      thumbCache = {};
      return;
    }

    currentAssignPdfId = id;
    currentPdfRecord = await dbGet('pdfs', id);
    if (!currentPdfRecord) return;

    // Load PDF.js doc for PDF types
    currentPdfDoc = null;
    thumbCache = {};
    if ((currentPdfRecord.type || 'pdf') === 'pdf' && currentPdfRecord.data) {
      try {
        const buf = currentPdfRecord.data.slice(0);
        currentPdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      } catch (e) {
        console.error('PDF load for thumbnails failed', e);
      }
    }

    currentMappings = await dbGetByIndex('mappings', 'pdfId', id);
    selectedPages.clear();
    lastClickedPage = null;
    updateAssignBar();

    hint.style.display = 'none';
    gridContainer.style.display = 'block';
    renderPageGrid(currentPdfRecord.pageCount);
  });

  async function getPageThumb(pageNum) {
    if (thumbCache[pageNum]) return thumbCache[pageNum];

    const type = currentPdfRecord.type || 'pdf';

    if (type === 'cbr' && currentPdfRecord.pages) {
      const pageData = currentPdfRecord.pages[pageNum - 1];
      if (!pageData) return null;
      const blob = new Blob([pageData.data], { type: pageData.type || 'image/jpeg' });
      const thumbSize = Math.round(200 * (window.devicePixelRatio || 1));
      const url = await blobToDataURL(blob, thumbSize);
      thumbCache[pageNum] = url;
      return url;
    }

    if (type === 'pdf' && currentPdfDoc) {
      try {
        const page = await currentPdfDoc.getPage(pageNum);
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: 0.3 * dpr });
        const cvs = document.createElement('canvas');
        cvs.width = vp.width;
        cvs.height = vp.height;
        await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
        const url = cvs.toDataURL('image/jpeg', 0.5);
        thumbCache[pageNum] = url;
        return url;
      } catch (e) {
        console.error('Thumb render failed for page', pageNum, e);
      }
    }
    return null;
  }

  async function getPagePreviewURL(pageNum) {
    const type = currentPdfRecord.type || 'pdf';

    if (type === 'cbr' && currentPdfRecord.pages) {
      const pageData = currentPdfRecord.pages[pageNum - 1];
      if (!pageData) return null;
      const blob = new Blob([pageData.data], { type: pageData.type || 'image/jpeg' });
      return URL.createObjectURL(blob);
    }

    if (type === 'pdf' && currentPdfDoc) {
      try {
        const page = await currentPdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: 1.5 });
        const cvs = document.createElement('canvas');
        cvs.width = vp.width;
        cvs.height = vp.height;
        await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
        return cvs.toDataURL('image/jpeg', 0.85);
      } catch (e) {
        console.error('Preview render failed', e);
      }
    }
    return null;
  }

  function renderPageGrid(pageCount) {
    const grid = document.getElementById('pageGrid');
    grid.innerHTML = '';

    for (let i = 1; i <= pageCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'page-cell';
      cell.dataset.page = i;

      const mapping = currentMappings.find(m => m.page === i);
      const musicEntry = mapping ? allMusic.find(m => m.id === mapping.musicId) : null;
      const musicName = musicEntry ? musicEntry.name : '';
      const musicDesc = musicEntry?.description || '';

      if (mapping) cell.classList.add('has-music');
      if (selectedPages.has(i)) cell.classList.add('selected');

      cell.innerHTML = `
        <div class="page-cell-thumb" id="thumb-${i}"></div>
        <div class="page-cell-info">
          <span class="page-cell-number">${i}</span>
          ${musicName ? `<span class="page-cell-music" title="${musicDesc}">${musicName}${musicDesc ? ' — ' + musicDesc : ''}</span>` : ''}
          <button class="page-cell-preview-btn" data-preview="${i}" title="Vorschau">&#9974;</button>
        </div>
      `;

      cell.addEventListener('click', (e) => {
        if (e.target.closest('.page-cell-preview-btn')) return;
        handlePageClick(i, e);
      });

      cell.querySelector('.page-cell-preview-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openPagePreview(i);
      });

      grid.appendChild(cell);

      // Load thumbnail async
      getPageThumb(i).then(url => {
        if (url) {
          const thumbEl = document.getElementById(`thumb-${i}`);
          if (thumbEl) thumbEl.style.backgroundImage = `url(${url})`;
        }
      });
    }
  }

  // ── Page Preview Lightbox ──
  let previewPage = 1;

  async function openPagePreview(pageNum) {
    previewPage = pageNum;
    const backdrop = document.getElementById('pagePreview');
    const img = document.getElementById('pagePreviewImg');
    const label = document.getElementById('previewPageLabel');
    const musicSelect = document.getElementById('previewMusicSelect');

    // Populate music select
    musicSelect.innerHTML = '<option value="">-- Musik --</option>' +
      allMusic.map(m => `<option value="${m.id}">${m.name}${m.description ? ' — ' + m.description : ''}</option>`).join('');

    // Set current music if assigned
    const mapping = currentMappings.find(m => m.page === pageNum);
    if (mapping) musicSelect.value = mapping.musicId;

    label.textContent = `Seite ${pageNum} / ${currentPdfRecord.pageCount}`;

    // Load preview image
    img.src = '';
    backdrop.classList.add('active');
    const url = await getPagePreviewURL(pageNum);
    if (url) img.src = url;
  }

  function closePagePreview() {
    document.getElementById('pagePreview').classList.remove('active');
    document.getElementById('pagePreviewImg').src = '';
  }

  document.getElementById('pagePreviewClose').addEventListener('click', closePagePreview);

  document.getElementById('pagePreview').addEventListener('click', (e) => {
    if (e.target === document.getElementById('pagePreview')) closePagePreview();
  });

  document.getElementById('previewPrev').addEventListener('click', () => {
    if (previewPage > 1) openPagePreview(previewPage - 1);
  });

  document.getElementById('previewNext').addEventListener('click', () => {
    if (previewPage < currentPdfRecord.pageCount) openPagePreview(previewPage + 1);
  });

  // Auto-assign when selecting music from dropdown
  document.getElementById('previewMusicSelect').addEventListener('change', async (e) => {
    const musicId = Number(e.target.value);
    if (!musicId) return;

    const existing = currentMappings.find(m => m.page === previewPage);
    if (existing) await dbDelete('mappings', existing.id);
    await dbAdd('mappings', { pdfId: currentAssignPdfId, page: previewPage, musicId });

    currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
    renderPageGrid(currentPdfRecord.pageCount);
    showToast(`Seite ${previewPage}: Musik zugewiesen`);
    ServerSync.saveMappingsToServer();
    GitHubSync.quickSave();
  });

  document.getElementById('previewAssignBtn').addEventListener('click', async () => {
    const musicId = Number(document.getElementById('previewMusicSelect').value);
    if (!musicId) { showToast('Bitte Musik wählen', 'error'); return; }

    const existing = currentMappings.find(m => m.page === previewPage);
    if (existing) await dbDelete('mappings', existing.id);
    await dbAdd('mappings', { pdfId: currentAssignPdfId, page: previewPage, musicId });

    currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
    renderPageGrid(currentPdfRecord.pageCount);
    showToast(`Seite ${previewPage}: Musik zugewiesen`);
    ServerSync.saveMappingsToServer();
    GitHubSync.quickSave();
  });

  document.getElementById('previewRemoveBtn').addEventListener('click', async () => {
    const existing = currentMappings.find(m => m.page === previewPage);
    if (existing) {
      await dbDelete('mappings', existing.id);
      currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
      renderPageGrid(currentPdfRecord.pageCount);
      document.getElementById('previewMusicSelect').value = '';
      showToast(`Seite ${previewPage}: Zuweisung entfernt`);
      ServerSync.saveMappingsToServer();
    GitHubSync.quickSave();
    }
  });

  // Keyboard navigation in preview
  document.addEventListener('keydown', (e) => {
    const preview = document.getElementById('pagePreview');
    if (!preview.classList.contains('active')) return;
    if (e.key === 'Escape') closePagePreview();
    if (e.key === 'ArrowLeft') document.getElementById('previewPrev').click();
    if (e.key === 'ArrowRight') document.getElementById('previewNext').click();
  });

  function handlePageClick(page, event) {
    if (event.ctrlKey || event.metaKey) {
      if (selectedPages.has(page)) {
        selectedPages.delete(page);
      } else {
        selectedPages.add(page);
      }
      lastClickedPage = page;
    } else if (event.shiftKey && lastClickedPage !== null) {
      const start = Math.min(lastClickedPage, page);
      const end = Math.max(lastClickedPage, page);
      for (let i = start; i <= end; i++) {
        selectedPages.add(i);
      }
    } else {
      selectedPages.clear();
      selectedPages.add(page);
      lastClickedPage = page;
    }

    document.querySelectorAll('.page-cell').forEach(cell => {
      const p = Number(cell.dataset.page);
      cell.classList.toggle('selected', selectedPages.has(p));
    });

    updateAssignBar();
  }

  function updateAssignBar() {
    const bar = document.getElementById('assignBar');
    const count = document.getElementById('selectedCount');
    if (selectedPages.size > 0) {
      bar.classList.add('active');
      count.textContent = selectedPages.size;
    } else {
      bar.classList.remove('active');
    }
  }

  document.getElementById('assignApplyBtn').addEventListener('click', async () => {
    const musicId = Number(document.getElementById('assignMusicSelect').value);
    if (!musicId) {
      showToast('Bitte Musik auswählen', 'error');
      return;
    }

    for (const page of selectedPages) {
      const existing = currentMappings.find(m => m.page === page);
      if (existing) await dbDelete('mappings', existing.id);
      await dbAdd('mappings', { pdfId: currentAssignPdfId, page, musicId });
    }

    currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
    const pdf = await dbGet('pdfs', currentAssignPdfId);
    selectedPages.clear();
    updateAssignBar();
    renderPageGrid(pdf.pageCount);
    showToast('Musik zugewiesen');
    ServerSync.saveMappingsToServer();
    GitHubSync.quickSave();
  });

  document.getElementById('assignRemoveBtn').addEventListener('click', async () => {
    for (const page of selectedPages) {
      const existing = currentMappings.find(m => m.page === page);
      if (existing) await dbDelete('mappings', existing.id);
    }

    currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
    const pdf = await dbGet('pdfs', currentAssignPdfId);
    selectedPages.clear();
    updateAssignBar();
    renderPageGrid(pdf.pageCount);
    showToast('Zuweisungen entfernt');
    ServerSync.saveMappingsToServer();
    GitHubSync.quickSave();
  });

  document.getElementById('assignCancelBtn').addEventListener('click', () => {
    selectedPages.clear();
    document.querySelectorAll('.page-cell').forEach(c => c.classList.remove('selected'));
    updateAssignBar();
  });

  // ══════════════════════════════
  // ── GitHub Sync Tab ──
  // ══════════════════════════════

  function updateSyncUI() {
    const tokenInput = document.getElementById('githubToken');
    const statusDiv = document.getElementById('syncStatus');
    const notConfigured = document.getElementById('syncNotConfigured');

    if (GitHubSync.isConfigured()) {
      tokenInput.value = '••••••••••••••••';
      statusDiv.style.display = 'block';
      notConfigured.style.display = 'none';
    } else {
      tokenInput.value = '';
      statusDiv.style.display = 'none';
      notConfigured.style.display = 'block';
    }
  }

  document.getElementById('githubTokenSave').addEventListener('click', async () => {
    const token = document.getElementById('githubToken').value.trim();
    if (!token || token === '••••••••••••••••') {
      showToast('Bitte Token eingeben', 'error');
      return;
    }

    GitHubSync.setToken(token);
    showToast('Token wird geprüft...');

    const ok = await GitHubSync.testToken();
    if (ok) {
      showToast('Token gültig! Sync wird gestartet...');
      updateSyncUI();
      try {
        await GitHubSync.sync();
        showToast('Sync erfolgreich!');
        document.getElementById('syncInfo').textContent = 'Letzter Sync: gerade eben';
        loadPdfList();
      } catch (e) {
        showToast('Sync-Fehler: ' + e.message, 'error');
      }
    } else {
      GitHubSync.removeToken();
      showToast('Token ungültig oder keine Schreibrechte (repo Berechtigung nötig)', 'error');
      updateSyncUI();
    }
  });

  document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
    showToast('Synchronisiere...');
    try {
      await GitHubSync.sync();
      showToast('Sync erfolgreich!');
      document.getElementById('syncInfo').textContent = 'Letzter Sync: gerade eben';
      loadPdfList();
    } catch (e) {
      showToast('Sync-Fehler: ' + e.message, 'error');
    }
  });

  document.getElementById('syncDisconnect')?.addEventListener('click', () => {
    if (!confirm('GitHub Sync trennen?')) return;
    GitHubSync.removeToken();
    updateSyncUI();
    showToast('Sync getrennt');
  });

  // ── Settings ──
  const pageTurnSelect = document.getElementById('pageTurnStyle');
  if (pageTurnSelect) {
    pageTurnSelect.value = localStorage.getItem('comicflow_page_turn_style') || 'none';
    pageTurnSelect.addEventListener('change', () => {
      localStorage.setItem('comicflow_page_turn_style', pageTurnSelect.value);
      // Migrate old setting
      localStorage.removeItem('comicflow_page_turn_anim');
      showToast('Animation: ' + (pageTurnSelect.value === 'none' ? 'Aus' : pageTurnSelect.selectedOptions[0].text));
    });
  }

  // ── Fullscreen Setting ──
  const fullscreenCheck = document.getElementById('fullscreenMode');
  if (fullscreenCheck) {
    fullscreenCheck.checked = localStorage.getItem('comicflow_fullscreen') === '1';
    fullscreenCheck.addEventListener('change', () => {
      localStorage.setItem('comicflow_fullscreen', fullscreenCheck.checked ? '1' : '0');
      showToast(fullscreenCheck.checked ? 'Vollbild-Modus aktiviert' : 'Vollbild-Modus deaktiviert');
    });
  }

  // ── Init ──
  loadPdfList();
  loadMusicList();
  updateSyncUI();

  // Refresh music list after auto-import
  window.addEventListener('music-imported', () => loadMusicList());
});
