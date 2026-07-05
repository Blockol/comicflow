// ── Server Sync Layer ──
// Detects local server and provides API helpers.
// Falls back gracefully when running on GitHub Pages (no server).

const ServerSync = (() => {
  let _isLocal = null;

  async function isLocalServer() {
    if (_isLocal !== null) return _isLocal;
    try {
      const res = await fetch('/api/ping', { signal: AbortSignal.timeout(1000) });
      const data = await res.json();
      _isLocal = data.server === 'comicflow-local';
    } catch {
      _isLocal = false;
    }
    return _isLocal;
  }

  async function getComics() {
    const res = await fetch('/api/comics');
    return res.json();
  }

  async function uploadComic(file) {
    const res = await fetch('/api/comics', {
      method: 'POST',
      headers: {
        'X-File-Name': encodeURIComponent(file.name),
        'X-Display-Name': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')),
      },
      body: file,
    });
    return res.json();
  }

  async function updateComic(serverId, metadata) {
    const res = await fetch(`/api/comics/${serverId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    return res.json();
  }

  async function deleteComic(serverId) {
    const res = await fetch(`/api/comics/${serverId}`, { method: 'DELETE' });
    return res.json();
  }

  async function reassignComic(serverId, file) {
    const res = await fetch(`/api/comics/${serverId}/reassign`, {
      method: 'POST',
      body: file,
    });
    return res.json();
  }

  async function fetchComicFile(serverId) {
    const res = await fetch(`/api/comics/${serverId}/file`);
    if (!res.ok) return null;
    return res.arrayBuffer();
  }

  // Sync server comics into IndexedDB (for comics not yet in IndexedDB)
  async function syncToIndexedDB() {
    if (!(await isLocalServer())) return;

    const serverComics = await getComics();
    const localComics = await dbGetAll('pdfs');

    for (const sc of serverComics) {
      if (!sc.exists) continue;

      // Check if already in IndexedDB (by serverId)
      const existing = localComics.find(lc => lc.serverId === sc.id);
      if (existing) continue;

      // Also check by name to avoid duplicates
      const byName = localComics.find(lc => lc.name === sc.name);
      if (byName) {
        // Link existing entry to server
        byName.serverId = sc.id;
        await dbUpdate('pdfs', byName);
        continue;
      }

      // Fetch file from server and import
      console.log(`[SYNC] Importing "${sc.name}" from server...`);
      const arrayBuffer = await fetchComicFile(sc.id);
      if (!arrayBuffer) continue;

      if (sc.type === 'cbr') {
        await importCBRFromBuffer(sc.name, arrayBuffer, sc.id);
      } else {
        await importPDFFromBuffer(sc.name, arrayBuffer, sc.id);
      }
    }
  }

  // Import helpers (similar to admin.js but used for sync)
  async function importPDFFromBuffer(name, arrayBuffer, serverId) {
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
      await page.render({ canvasContext: cvs.getContext('2d'), viewport }).promise;
      cover = cvs.toDataURL('image/jpeg', 0.7);
    } catch (e) {
      console.error('PDF processing error during sync:', e);
    }
    const id = await dbAdd('pdfs', { name, type: 'pdf', data: storageBuffer, pageCount, cover, serverId });

    // Update server with metadata
    if (serverId && (pageCount || cover)) {
      try { await updateComic(serverId, { pageCount, cover }); } catch {}
    }
    return id;
  }

  async function importCBRFromBuffer(name, arrayBuffer, serverId) {
    try {
      const wasmResp = await fetch('lib/unrar.wasm');
      const wasmBinary = await wasmResp.arrayBuffer();
      const extractor = await createExtractorFromData({ wasmBinary, data: arrayBuffer });
      const { files } = extractor.extract();
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
      const images = [];

      for (const entry of files) {
        const fName = entry.fileHeader.name;
        const fExt = fName.split('.').pop().toLowerCase();
        if (imageExts.includes(fExt) && entry.extraction) {
          images.push({ name: fName, data: entry.extraction });
        }
      }
      images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (images.length === 0) return null;

      function getMime(n) {
        const ext = n.split('.').pop().toLowerCase();
        const map = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', bmp:'image/bmp', webp:'image/webp' };
        return map[ext] || 'image/jpeg';
      }

      const pages = images.map(img => ({
        data: img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength),
        type: getMime(img.name),
      }));

      let cover = null;
      try {
        const blob = new Blob([pages[0].data], { type: pages[0].type });
        cover = await blobToDataURLSync(blob, 300);
      } catch {}

      const id = await dbAdd('pdfs', {
        name, type: 'cbr', data: null,
        pages, pageCount: pages.length, cover, serverId,
      });

      if (serverId) {
        try { await updateComic(serverId, { pageCount: pages.length, cover }); } catch {}
      }
      return id;
    } catch (e) {
      console.error('CBR sync import failed:', e);
      return null;
    }
  }

  function blobToDataURLSync(blob, maxWidth) {
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

  // Save all mappings to server (call after any mapping change)
  async function saveMappingsToServer() {
    if (!(await isLocalServer())) return;
    try {
      const mappings = await dbGetAll('mappings');
      // Include serverId of the PDF for each mapping so we can restore by name
      const pdfs = await dbGetAll('pdfs');
      const enriched = mappings.map(m => {
        const pdf = pdfs.find(p => p.id === m.pdfId);
        return {
          ...m,
          pdfServerId: pdf?.serverId || null,
          pdfName: pdf?.name || null,
        };
      });
      await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enriched),
      });
    } catch (e) {
      console.error('Mapping sync failed:', e);
    }
  }

  // Restore mappings from server (call after syncing comics)
  async function restoreMappingsFromServer() {
    if (!(await isLocalServer())) return;
    try {
      const res = await fetch('/api/mappings');
      const serverMappings = await res.json();
      if (!serverMappings.length) return;

      const localMappings = await dbGetAll('mappings');
      if (localMappings.length > 0) return; // Don't overwrite existing mappings

      const pdfs = await dbGetAll('pdfs');

      for (const sm of serverMappings) {
        // Find the local PDF by serverId or name
        let pdf = null;
        if (sm.pdfServerId) pdf = pdfs.find(p => p.serverId === sm.pdfServerId);
        if (!pdf && sm.pdfName) pdf = pdfs.find(p => p.name === sm.pdfName);
        if (!pdf) continue;

        await dbAdd('mappings', {
          pdfId: pdf.id,
          page: sm.page,
          musicId: sm.musicId,
        });
      }
      console.log(`[SYNC] ${serverMappings.length} Zuweisungen wiederhergestellt`);
    } catch (e) {
      console.error('Mapping restore failed:', e);
    }
  }

  return {
    isLocalServer,
    getComics,
    uploadComic,
    updateComic,
    deleteComic,
    reassignComic,
    fetchComicFile,
    syncToIndexedDB,
    importPDFFromBuffer,
    importCBRFromBuffer,
    saveMappingsToServer,
    restoreMappingsFromServer,
  };
})();
