// ── GitHub Sync ──
// Stores mappings, file registry, and settings in the GitHub repo
// so everything syncs across devices.

const GitHubSync = (() => {
  const REPO_OWNER = 'Blockol';
  const REPO_NAME = 'comicflow';
  const SYNC_FILE = 'sync-data.json';
  const TOKEN_KEY = 'comicflow_github_token';
  const API_BASE = 'https://api.github.com';

  let _fileSha = null; // needed for updates

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  }

  function removeToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function isConfigured() {
    return !!getToken();
  }

  function headers() {
    return {
      'Authorization': `token ${getToken()}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  // Read sync data from GitHub
  async function loadFromGitHub() {
    try {
      const res = await fetch(
        `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${SYNC_FILE}`,
        { headers: headers() }
      );

      if (res.status === 404) {
        _fileSha = null;
        return null; // file doesn't exist yet
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'GitHub API error');
      }

      const data = await res.json();
      _fileSha = data.sha;

      // Content is base64 encoded
      const content = atob(data.content.replace(/\n/g, ''));
      return JSON.parse(content);
    } catch (e) {
      console.error('[GITHUB] Load failed:', e);
      throw e;
    }
  }

  // Write sync data to GitHub
  async function saveToGitHub(syncData) {
    const token = getToken();
    if (!token) throw new Error('Kein GitHub Token konfiguriert');

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(syncData, null, 2))));

    const body = {
      message: 'Sync: update comicflow data',
      content: content,
      committer: {
        name: 'ComicFlow Sync',
        email: 'comicflow@sync.local',
      },
    };

    // Include SHA if updating existing file
    if (_fileSha) {
      body.sha = _fileSha;
    }

    const res = await fetch(
      `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${SYNC_FILE}`,
      {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If SHA mismatch, reload and retry once
      if (res.status === 409) {
        console.log('[GITHUB] SHA conflict, reloading...');
        await loadFromGitHub(); // refreshes _fileSha
        body.sha = _fileSha;
        const retry = await fetch(
          `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${SYNC_FILE}`,
          { method: 'PUT', headers: headers(), body: JSON.stringify(body) }
        );
        if (!retry.ok) throw new Error('Sync fehlgeschlagen nach Retry');
        const retryData = await retry.json();
        _fileSha = retryData.content.sha;
        return;
      }
      throw new Error(err.message || 'GitHub API error');
    }

    const result = await res.json();
    _fileSha = result.content.sha;
    console.log('[GITHUB] Sync gespeichert');
  }

  // Build sync data from current IndexedDB state
  async function buildSyncData() {
    const pdfs = await dbGetAll('pdfs');
    const mappings = await dbGetAll('mappings');
    const music = await dbGetAll('music');

    // Build name-based mappings (device-independent)
    const syncMappings = [];
    for (const m of mappings) {
      const pdf = pdfs.find(p => p.id === m.pdfId);
      const mus = music.find(mu => mu.id === m.musicId);
      if (pdf && mus) {
        syncMappings.push({
          pdfName: pdf.name,
          page: m.page,
          musicName: mus.name,
        });
      }
    }

    // Build file registry (name-based)
    const syncRegistry = pdfs.map(p => ({
      name: p.name,
      type: p.type || 'pdf',
      pageCount: p.pageCount || 0,
      sortOrder: p.sortOrder ?? 9999,
      cover: p.cover || null,
    }));

    // Build music descriptions
    const musicDescriptions = music
      .filter(m => m.description)
      .map(m => ({ name: m.name, description: m.description }));

    return {
      version: 1,
      lastSync: new Date().toISOString(),
      mappings: syncMappings,
      fileRegistry: syncRegistry,
      musicDescriptions: musicDescriptions,
    };
  }

  // Apply sync data to local IndexedDB
  async function applySyncData(syncData) {
    if (!syncData) return;

    const pdfs = await dbGetAll('pdfs');
    const music = await dbGetAll('music');

    // Apply file registry (sortOrder, cover for existing entries)
    for (const sr of syncData.fileRegistry || []) {
      const local = pdfs.find(p => p.name === sr.name);
      if (local) {
        let changed = false;
        if (sr.sortOrder !== undefined && local.sortOrder !== sr.sortOrder) {
          local.sortOrder = sr.sortOrder;
          changed = true;
        }
        if (changed) await dbUpdate('pdfs', local);
      }
    }

    // Apply mappings: add only where no local mapping exists for that pdf+page
    const localMappings = await dbGetAll('mappings');
    let mappingsAdded = 0;
    for (const sm of syncData.mappings || []) {
      const pdf = pdfs.find(p => p.name === sm.pdfName);
      const mus = music.find(m => m.name === sm.musicName);
      if (pdf && mus) {
        // Only add if no local mapping exists for this pdf+page
        const existing = localMappings.find(lm =>
          lm.pdfId === pdf.id && lm.page === sm.page
        );
        if (!existing) {
          await dbAdd('mappings', {
            pdfId: pdf.id,
            page: sm.page,
            musicId: mus.id,
          });
          mappingsAdded++;
        }
      }
    }
    if (mappingsAdded > 0) {
      console.log(`[GITHUB] ${mappingsAdded} Zuweisungen synchronisiert`);
    }

    // Apply music descriptions
    for (const md of syncData.musicDescriptions || []) {
      const mus = music.find(m => m.name === md.name);
      if (mus && mus.description !== md.description) {
        mus.description = md.description;
        await dbUpdate('music', mus);
      }
    }

    // Update file registry in localStorage too
    for (const sr of syncData.fileRegistry || []) {
      const local = pdfs.find(p => p.name === sr.name);
      if (local) {
        FileRegistry.register({
          dbId: local.id,
          name: local.name,
          type: local.type,
          pageCount: local.pageCount,
          cover: local.cover,
          sortOrder: sr.sortOrder ?? local.sortOrder,
        });
      }
    }
  }

  // Full sync: load from GitHub, merge, save back
  async function sync() {
    if (!isConfigured()) return;

    try {
      const remote = await loadFromGitHub();
      if (remote) {
        await applySyncData(remote);
      }

      // Save current state back
      const local = await buildSyncData();
      await saveToGitHub(local);
      return true;
    } catch (e) {
      console.error('[GITHUB] Sync error:', e);
      throw e;
    }
  }

  // Quick save (just push current state, no merge)
  async function quickSave() {
    if (!isConfigured()) return;
    try {
      // Reload SHA first to avoid conflicts
      try { await loadFromGitHub(); } catch {}
      const data = await buildSyncData();
      await saveToGitHub(data);
    } catch (e) {
      console.error('[GITHUB] Quick save failed:', e);
    }
  }

  // Test if token works
  async function testToken() {
    try {
      const res = await fetch(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}`, {
        headers: headers(),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.permissions?.push === true;
    } catch {
      return false;
    }
  }

  return {
    getToken,
    setToken,
    removeToken,
    isConfigured,
    testToken,
    loadFromGitHub,
    saveToGitHub,
    buildSyncData,
    applySyncData,
    sync,
    quickSave,
  };
})();
