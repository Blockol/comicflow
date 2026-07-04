// Auto-imports bundled music files into IndexedDB on first visit
(async function autoImportMusic() {
  const IMPORT_KEY = 'comicflow_music_imported_v1';
  if (localStorage.getItem(IMPORT_KEY)) return;

  const musicFiles = [
    'A_Pending_Breakdown.mp3',
    'Beneath_the_Partition.mp3',
    'Hydraulic_Seizure.mp3',
    'The Final Stand (1).mp3',
    'The Final Stand.mp3',
    'The_Distant_Siege.mp3',
    'The_Iron_Pulse.mp3',
    'The_Last_Unanswered_Note.mp3',
    'The_Room_Next_Door.mp3',
    'Titanium_Stride (1).mp3',
    'Titanium_Stride.mp3',
    'beneath the floor.mp3',
    'calm, light dramtic then action drop later.mp3',
    'emotional, quit, light.mp3',
    'light dramatic, long walk, building up but no drop, evil plan.mp3',
    'mid dramatik, long walk, building up, but no drop.mp3',
  ];

  // Wait for DB to be ready
  let retries = 0;
  while (typeof dbGetAll === 'undefined' && retries < 20) {
    await new Promise(r => setTimeout(r, 250));
    retries++;
  }
  if (typeof dbGetAll === 'undefined') return;

  console.log('[AutoImport] Importiere Musik-Dateien...');

  let imported = 0;
  for (const filename of musicFiles) {
    try {
      const resp = await fetch('music/' + encodeURIComponent(filename));
      if (!resp.ok) continue;
      const arrayBuffer = await resp.arrayBuffer();
      const name = filename.replace(/\.mp3$/i, '').replace(/_/g, ' ');
      await dbAdd('music', { name, data: arrayBuffer, type: 'audio/mpeg' });
      imported++;
      console.log(`[AutoImport] ${imported}/${musicFiles.length}: ${name}`);
    } catch(e) {
      console.warn('[AutoImport] Fehler bei', filename, e);
    }
  }

  if (imported > 0) {
    console.log(`[AutoImport] Fertig! ${imported} Musik-Dateien importiert`);
    localStorage.setItem(IMPORT_KEY, '1');
    // Notify admin page to refresh music list
    window.dispatchEvent(new Event('music-imported'));
  }
})();
