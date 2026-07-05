const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;
const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const COMICS_DIR = path.join(DATA_DIR, 'comics');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');

// Ensure directories exist
[DATA_DIR, COMICS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Library management ──

function loadLibrary() {
  if (fs.existsSync(LIBRARY_FILE)) {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  }
  return { comics: [], nextId: 1 };
}

function saveLibrary(lib) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
}

// ── MIME types ──

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.cbr': 'application/x-cbr',
  '.rar': 'application/x-cbr',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

// ── Request body helper ──

function readBody(req, maxSize = 500 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('File too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Display-Name');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    try {
      await handleAPI(req, res, pathname, parsedUrl.searchParams);
    } catch (e) {
      console.error('API Error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let filePath = path.join(BASE_DIR, pathname === '/' ? 'index.html' : pathname);
  const resolved = path.resolve(filePath);

  // Security: prevent path traversal outside BASE_DIR
  if (!resolved.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) filePath = path.join(resolved, 'index.html');
    else filePath = resolved;

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(filePath).size });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

async function handleAPI(req, res, pathname, query) {
  const sendJSON = (data, status = 200) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };

  // ── GET /api/comics ── List all comics with existence status
  if (pathname === '/api/comics' && req.method === 'GET') {
    const lib = loadLibrary();
    const comics = lib.comics.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      pageCount: c.pageCount || 0,
      cover: c.cover || null,
      size: c.size || 0,
      exists: fs.existsSync(c.filePath),
      filePath: c.filePath,
    }));
    return sendJSON(comics);
  }

  // ── POST /api/comics ── Upload a new comic file
  if (pathname === '/api/comics' && req.method === 'POST') {
    const fileName = decodeURIComponent(req.headers['x-file-name'] || 'unknown');
    const displayName = decodeURIComponent(req.headers['x-display-name'] || fileName.replace(/\.[^.]+$/, ''));

    const body = await readBody(req);
    const lib = loadLibrary();
    const id = lib.nextId++;
    const ext = path.extname(fileName).toLowerCase();
    const safeName = `${id}_${fileName.replace(/[^a-zA-Z0-9._\-()[\] ]/g, '_')}`;
    const filePath = path.join(COMICS_DIR, safeName);

    fs.writeFileSync(filePath, body);

    const entry = {
      id,
      name: displayName,
      fileName: safeName,
      filePath,
      type: (ext === '.cbr' || ext === '.rar') ? 'cbr' : 'pdf',
      size: body.length,
      pageCount: 0,
      cover: null,
    };
    lib.comics.push(entry);
    saveLibrary(lib);

    console.log(`[UPLOAD] "${displayName}" (${(body.length / 1024 / 1024).toFixed(1)} MB) -> ${safeName}`);
    return sendJSON(entry);
  }

  // ── GET /api/comics/:id/file ── Serve the comic file
  const fileMatch = pathname.match(/^\/api\/comics\/(\d+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const id = Number(fileMatch[1]);
    const lib = loadLibrary();
    const comic = lib.comics.find(c => c.id === id);
    if (!comic) return sendJSON({ error: 'Not found' }, 404);
    if (!fs.existsSync(comic.filePath)) return sendJSON({ error: 'File missing' }, 404);

    const ext = path.extname(comic.filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(comic.filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(comic.fileName)}"`,
    });
    fs.createReadStream(comic.filePath).pipe(res);
    return;
  }

  // ── PUT /api/comics/:id ── Update metadata (name, pageCount, cover)
  const updateMatch = pathname.match(/^\/api\/comics\/(\d+)$/);
  if (updateMatch && req.method === 'PUT') {
    const id = Number(updateMatch[1]);
    const body = JSON.parse((await readBody(req)).toString());
    const lib = loadLibrary();
    const comic = lib.comics.find(c => c.id === id);
    if (!comic) return sendJSON({ error: 'Not found' }, 404);

    if (body.name !== undefined) comic.name = body.name;
    if (body.pageCount !== undefined) comic.pageCount = body.pageCount;
    if (body.cover !== undefined) comic.cover = body.cover;
    saveLibrary(lib);
    return sendJSON({ ok: true });
  }

  // ── DELETE /api/comics/:id ── Delete comic
  const deleteMatch = pathname.match(/^\/api\/comics\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = Number(deleteMatch[1]);
    const lib = loadLibrary();
    const idx = lib.comics.findIndex(c => c.id === id);
    if (idx === -1) return sendJSON({ error: 'Not found' }, 404);

    const comic = lib.comics[idx];
    try {
      if (fs.existsSync(comic.filePath)) fs.unlinkSync(comic.filePath);
    } catch (e) {
      console.error('Delete file failed:', e);
    }
    lib.comics.splice(idx, 1);
    saveLibrary(lib);
    console.log(`[DELETE] "${comic.name}"`);
    return sendJSON({ ok: true });
  }

  // ── POST /api/comics/:id/reassign ── Re-upload file for existing entry
  const reassignMatch = pathname.match(/^\/api\/comics\/(\d+)\/reassign$/);
  if (reassignMatch && req.method === 'POST') {
    const id = Number(reassignMatch[1]);
    const lib = loadLibrary();
    const comic = lib.comics.find(c => c.id === id);
    if (!comic) return sendJSON({ error: 'Not found' }, 404);

    const body = await readBody(req);
    fs.writeFileSync(comic.filePath, body);
    comic.size = body.length;
    saveLibrary(lib);
    console.log(`[REASSIGN] "${comic.name}" (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
    return sendJSON({ ok: true });
  }

  // ── GET /api/mappings ── Get all saved mappings
  if (pathname === '/api/mappings' && req.method === 'GET') {
    const lib = loadLibrary();
    return sendJSON(lib.mappings || []);
  }

  // ── POST /api/mappings ── Save all mappings (full sync from client)
  if (pathname === '/api/mappings' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString());
    const lib = loadLibrary();
    lib.mappings = body;
    saveLibrary(lib);
    console.log(`[MAPPINGS] ${body.length} Zuweisungen gespeichert`);
    return sendJSON({ ok: true });
  }

  // ── GET /api/ping ── Health check / detect local server
  if (pathname === '/api/ping') {
    return sendJSON({ ok: true, server: 'comicflow-local' });
  }

  sendJSON({ error: 'Unknown endpoint' }, 404);
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   ComicFlow Local Server gestartet    ║');
  console.log(`  ║   http://localhost:${PORT}               ║`);
  console.log('  ╠═══════════════════════════════════════╣');
  console.log(`  ║   Comics: ${COMICS_DIR}`);
  console.log('  ║   Strg+C zum Beenden                  ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});
