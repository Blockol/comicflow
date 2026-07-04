document.addEventListener('DOMContentLoaded', () => {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

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
    const name = document.getElementById('pdfName').value.trim();
    const file = document.getElementById('pdfFile').files[0];
    if (!name || !file) {
      showToast('Name und Datei erforderlich', 'error');
      return;
    }

    const btn = document.getElementById('pdfSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Wird verarbeitet...';

    try {
      const ext = file.name.split('.').pop().toLowerCase();
      const isCBR = ext === 'cbr' || ext === 'rar';

      if (isCBR) {
        await saveCBR(name, file);
      } else {
        await savePDF(name, file);
      }

      showToast(`"${name}" hinzugefügt`);
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

  async function savePDF(name, file) {
    const arrayBuffer = await file.arrayBuffer();
    const storageBuffer = arrayBuffer.slice(0); // Kopie, da PDF.js den Original-Buffer detached
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
    await dbAdd('pdfs', { name, type: 'pdf', data: storageBuffer, pageCount, cover });
  }

  async function saveCBR(name, file) {
    showToast('CBR wird verarbeitet...');
    try {
      const arrayBuffer = await file.arrayBuffer();

      // Load WASM binary
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
            data: entry.extraction,  // Uint8Array
          });
        }
      }

      images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      if (images.length === 0) {
        showToast('Keine Bilder im Archiv gefunden', 'error');
        return;
      }

      // Detect MIME type from extension
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

      await dbAdd('pdfs', {
        name, type: 'cbr', data: null,
        pages, pageCount: pages.length, cover
      });
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
  async function loadPdfList() {
    const pdfs = await dbGetAll('pdfs');
    const list = document.getElementById('pdfList');
    const empty = document.getElementById('pdfEmpty');

    if (pdfs.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = pdfs.map(p => `
      <div class="pdf-item">
        <div class="pdf-item-icon">${(p.type || 'pdf').toUpperCase()}</div>
        <div class="pdf-item-info">
          <div class="pdf-item-name" id="pdf-name-${p.id}">${p.name}</div>
          <div class="pdf-item-meta">${p.pageCount || '?'} Seiten</div>
        </div>
        <div class="pdf-item-actions">
          <button class="btn btn-sm" onclick="renamePdf(${p.id})">Umbenennen</button>
          <button class="btn btn-danger btn-sm" onclick="deletePdf(${p.id})">Löschen</button>
        </div>
      </div>
    `).join('');
  }

  window.renamePdf = async (id) => {
    const record = await dbGet('pdfs', id);
    if (!record) return;
    const newName = prompt('Neuer Name:', record.name);
    if (!newName || !newName.trim() || newName.trim() === record.name) return;
    record.name = newName.trim();
    await dbUpdate('pdfs', record);
    showToast(`Umbenannt zu "${record.name}"`);
    loadPdfList();
  };

  window.deletePdf = async (id) => {
    if (!confirm('Wirklich löschen? Alle Zuweisungen gehen verloren.')) return;
    await dbDelete('pdfs', id);
    await dbClearByIndex('mappings', 'pdfId', id);
    showToast('Gelöscht');
    loadPdfList();
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
          <span class="music-item-name">${m.name}</span>
        </div>
        <div class="music-item-actions">
          <button class="btn btn-sm" onclick="previewMusic(${m.id})">&#9654; Probe</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMusic(${m.id})">Löschen</button>
        </div>
      </li>
    `).join('');
  }

  let previewAudio = null;
  window.previewMusic = async (id) => {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    const m = await dbGet('music', id);
    if (!m) return;
    const blob = new Blob([m.data], { type: m.type || 'audio/mpeg' });
    previewAudio = new Audio(URL.createObjectURL(blob));
    previewAudio.volume = 0.5;
    previewAudio.play();
    setTimeout(() => { if (previewAudio) { previewAudio.pause(); previewAudio = null; } }, 15000);
  };

  window.deleteMusic = async (id) => {
    if (!confirm('Musik wirklich löschen?')) return;
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
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
      allMusic.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
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
      const url = await blobToDataURL(blob, 200);
      thumbCache[pageNum] = url;
      return url;
    }

    if (type === 'pdf' && currentPdfDoc) {
      try {
        const page = await currentPdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: 0.3 });
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
      const musicName = mapping ? (allMusic.find(m => m.id === mapping.musicId)?.name || '?') : '';

      if (mapping) cell.classList.add('has-music');
      if (selectedPages.has(i)) cell.classList.add('selected');

      cell.innerHTML = `
        <div class="page-cell-thumb" id="thumb-${i}"></div>
        <div class="page-cell-info">
          <span class="page-cell-number">${i}</span>
          ${musicName ? `<span class="page-cell-music">${musicName}</span>` : ''}
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
      allMusic.map(m => `<option value="${m.id}">${m.name}</option>`).join('');

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
  });

  document.getElementById('previewRemoveBtn').addEventListener('click', async () => {
    const existing = currentMappings.find(m => m.page === previewPage);
    if (existing) {
      await dbDelete('mappings', existing.id);
      currentMappings = await dbGetByIndex('mappings', 'pdfId', currentAssignPdfId);
      renderPageGrid(currentPdfRecord.pageCount);
      document.getElementById('previewMusicSelect').value = '';
      showToast(`Seite ${previewPage}: Zuweisung entfernt`);
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
  });

  document.getElementById('assignCancelBtn').addEventListener('click', () => {
    selectedPages.clear();
    document.querySelectorAll('.page-cell').forEach(c => c.classList.remove('selected'));
    updateAssignBar();
  });

  // ── Init ──
  loadPdfList();
  loadMusicList();
});
