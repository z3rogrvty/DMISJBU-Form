'use strict';
/* ------------------------------------------------------------------
   DMI – St. John the Baptist University :: application server
   Run:  npm install && node server.js
   Env:  PORT=3000 ADMIN_TOKEN=some-long-secret node server.js
------------------------------------------------------------------- */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app         = express();
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-please';
const MAX_PHOTO   = 4 * 1024 * 1024;              // 4 MB decoded

const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE   = path.join(DATA_DIR, 'submissions.json');

fs.mkdirSync(PHOTO_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

/* ---------------- tiny JSON store (swap for SQLite/Postgres later) ---------------- */
let db = [];
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = []; }
if (!Array.isArray(db)) db = [];

/* serialise writes so two simultaneous submissions can't clobber the file */
let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain
    .then(() => fs.promises.writeFile(DB_FILE + '.tmp', snapshot))
    .then(() => fs.promises.rename(DB_FILE + '.tmp', DB_FILE))
    .catch(err => console.error('persist failed:', err));
  return writeChain;
}

/* ---------------- middleware ---------------- */
app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));

// never expose backend files or stored applications
app.use(['/data', '/server.js', '/package.json', '/package-lock.json', '/node_modules'],
        (req, res) => res.status(403).end());

// serve index.html, style.css, logo.png, admin.html
app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));

/* crude per-IP rate limit: max 5 submissions / minute */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 5;
}

/* ---------------- POST /api/submit ---------------- */
app.post('/api/submit', async (req, res) => {
  try {
    if (rateLimited(req.ip))
      return res.status(429).json({ error: 'Too many submissions. Try again in a minute.' });

    const fields = req.body && req.body.fields;
    if (!fields || typeof fields !== 'object')
      return res.status(400).json({ error: 'Missing fields object.' });

    /* --- sanitise: flat key/value, max 40-char keys, 300-char values --- */
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof k !== 'string' || k.length > 40) continue;
      if (typeof v === 'boolean') { clean[k] = v; continue; }
      clean[k] = String(v ?? '').slice(0, 300);
    }

    /* --- server-side validation (never trust the browser) --- */
    const joinRange = (prefix, from, to) => {
      let s = '';
      for (let i = from; i <= to; i++) s += clean[prefix + i] || '';
      return s.trim();
    };
    const surname   = joinRange('n1_', 0, 6);
    const firstName = joinRange('n1_', 16, 21);
    const fullName  = (joinRange('n1_', 0, 25) + ' ' + joinRange('n2_', 0, 25)).trim();

    if (fullName.length < 2)
      return res.status(400).json({ error: 'Applicant name is required.' });
    if (!clean.level)
      return res.status(400).json({ error: 'Diploma / Bachelor Degree must be selected.' });

    /* --- ids --- */
    const id    = crypto.randomUUID();
    const year  = new Date().getFullYear();
    const appNo = `${year}-${String(db.length + 1).padStart(5, '0')}`;

    /* --- optional passport photo (base64 data URL) --- */
    let photoFile = null;
    const photo = req.body.photo;
    if (typeof photo === 'string' && photo.startsWith('data:image/')) {
      const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(photo);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_PHOTO)
          return res.status(413).json({ error: 'Photo is too large (max 4 MB).' });
        const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
        photoFile = `${appNo}_${id.slice(0, 8)}.${ext}`;
        await fs.promises.writeFile(path.join(PHOTO_DIR, photoFile), buf);
      }
    }

    const record = {
      id,
      appNo,
      submittedAt: new Date().toISOString(),
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      name: fullName,
      surname,
      firstName,
      level: clean.level,
      photo: photoFile,
      fields: clean
    };

    db.push(record);
    await persist();

    console.log(`[submit] ${appNo}  ${fullName}`);
    res.status(201).json({ ok: true, id, appNo });
  } catch (err) {
    console.error('[submit] error', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

/* ---------------- admin routes ---------------- */
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!token || token !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorised' });
  next();
}

app.get('/api/submissions', requireAdmin, (req, res) => {
  if (req.query.full === '1') return res.json(db);
  res.json(db.map(r => ({
    id: r.id, appNo: r.appNo, submittedAt: r.submittedAt,
    name: r.name, level: r.level, hasPhoto: !!r.photo
  })));
});

app.get('/api/submissions/:id', requireAdmin, (req, res) => {
  const r = db.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.get('/api/submissions/:id/photo', requireAdmin, (req, res) => {
  const r = db.find(x => x.id === req.params.id);
  if (!r || !r.photo) return res.status(404).end();
  res.sendFile(path.join(PHOTO_DIR, path.basename(r.photo)));
});

app.get('/api/export.csv', requireAdmin, (req, res) => {
  const keys = new Set();
  db.forEach(r => Object.keys(r.fields || {}).forEach(k => keys.add(k)));
  const cols = ['appNo', 'submittedAt', 'name', 'level', ...keys];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map(esc).join(',')];
  for (const r of db) {
    lines.push(cols.map(c =>
      esc(c === 'appNo' ? r.appNo :
          c === 'submittedAt' ? r.submittedAt :
          c === 'name' ? r.name :
          c === 'level' ? r.level : (r.fields || {})[c])
    ).join(','));
  }
  res.type('text/csv').attachment('dmi-applications.csv').send(lines.join('\r\n'));
});

/* ---------------- misc ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, count: db.length }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

app.listen(PORT, () => {
  console.log(`DMI application server running on http://localhost:${PORT}`);
  console.log(`Admin token: ${ADMIN_TOKEN === 'change-me-please' ? '(default — set ADMIN_TOKEN!)' : 'set'}`);
});