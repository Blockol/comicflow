// ── File Registry ──
// Stores a lightweight backup of all uploaded files in localStorage.
// If IndexedDB is cleared, the registry knows what's missing and allows re-upload.
// localStorage survives "clear site data" in most browsers (unlike IndexedDB).

const FileRegistry = (() => {
  const STORAGE_KEY = 'comicflow_file_registry';

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function save(entries) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  // Register a file after upload (call from admin.js after savePDF/saveCBR)
  function register(entry) {
    // entry: { dbId, name, type, pageCount, cover, sortOrder }
    const entries = load();
    // Update existing or add new
    const idx = entries.findIndex(e => e.dbId === entry.dbId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...entry };
    } else {
      entries.push(entry);
    }
    save(entries);
  }

  // Update an existing entry (e.g. after rename or sort change)
  function update(dbId, changes) {
    const entries = load();
    const entry = entries.find(e => e.dbId === dbId);
    if (entry) {
      Object.assign(entry, changes);
      save(entries);
    }
  }

  // Remove from registry
  function remove(dbId) {
    const entries = load().filter(e => e.dbId !== dbId);
    save(entries);
  }

  // Get all registered files
  function getAll() {
    return load();
  }

  // Find files that are in registry but missing from IndexedDB
  async function getMissing() {
    const registered = load();
    if (registered.length === 0) return [];

    const existing = await dbGetAll('pdfs');
    const existingIds = new Set(existing.map(p => p.id));

    return registered.filter(r => !existingIds.has(r.dbId));
  }

  // Sync registry FROM IndexedDB (initial population for existing users)
  async function syncFromDB() {
    const pdfs = await dbGetAll('pdfs');
    const entries = load();

    for (const p of pdfs) {
      const exists = entries.find(e => e.dbId === p.id);
      if (!exists) {
        entries.push({
          dbId: p.id,
          name: p.name,
          type: p.type || 'pdf',
          pageCount: p.pageCount || 0,
          cover: p.cover || null,
          sortOrder: p.sortOrder ?? 9999,
        });
      }
    }
    save(entries);
  }

  return { register, update, remove, getAll, getMissing, syncFromDB };
})();
