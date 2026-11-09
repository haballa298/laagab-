#!/usr/bin/env node
/*
 * لعگابْ 🦅 — Laagab internal server (Garde nationale)
 * Serves the Laagab web app and provides unit-to-unit chat + position sharing.
 * Pure Node.js (>= 18), no external packages.
 *
 *   node server.js                      start the server
 *   node server.js adduser <user> "<display name>" "<unit>" [admin]
 *   node server.js passwd <user>
 *   node server.js deluser <user>
 *   node server.js users
 *
 * 2.3: first-run setup and full server control from the phone (command panel).
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const os = require('os');
const VERSION = '2.3.0', STARTED = Date.now();

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(DATA, { recursive: true });

/* ---------------- config ---------------- */
const CFG_FILE = path.join(ROOT, 'config.json');
const CFG = Object.assign({
  port: 8443,
  host: '0.0.0.0',
  name: 'لعگابْ 🦅 — الحرس الوطني',
  tls: { key: 'certs/server.key', cert: 'certs/server.crt' },
  corsOrigins: [],            // e.g. ["https://haballa298.github.io"] if the app is hosted elsewhere
  sessionDays: 30,
  historyPerChannel: 2000,
  positionMaxAgeHours: 12
}, fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {});

/* ---------------- tiny JSON store ---------------- */
function load(name, def) { const f = path.join(DATA, name); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
const saveTimers = {};
function save(name, obj) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const f = path.join(DATA, name), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f);
  }, 200);
}
function saveNow(name, obj) { const f = path.join(DATA, name), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); }

let USERS = load('users.json', {});          // u -> {u,name,unit,role,salt,hash,created}
let SESS = load('sessions.json', {});        // token -> {u,exp}
let POS = load('positions.json', {});        // u -> {u,lat,lon,acc,hdg,t}
const MSG_FILE = path.join(DATA, 'messages.jsonl');
let MSGS = [];                                // all messages in memory (trimmed per channel)
let SEQ = 0;
if (fs.existsSync(MSG_FILE)) {
  fs.readFileSync(MSG_FILE, 'utf8').split('\n').forEach(l => { if (!l.trim()) return; try { const m = JSON.parse(l); MSGS.push(m); if (m.id > SEQ) SEQ = m.id; } catch (e) {} });
}
function trimHistory() {
  const per = {};
  for (let i = MSGS.length - 1; i >= 0; i--) { const c = MSGS[i].ch; per[c] = (per[c] || 0) + 1; if (per[c] > CFG.historyPerChannel) MSGS[i] = null; }
  MSGS = MSGS.filter(Boolean);
}
trimHistory();

/* first-run setup code: printed on the server console, asked once in the app */
let SETUP_CODE = null;
function ensureSetupCode() {
  if (Object.keys(USERS).length) { SETUP_CODE = null; try { fs.unlinkSync(path.join(DATA, 'setup-code.txt')); } catch (e) {} return; }
  if (!SETUP_CODE) SETUP_CODE = String(crypto.randomInt(100000, 1000000));
  try { fs.writeFileSync(path.join(DATA, 'setup-code.txt'), SETUP_CODE + '\n'); } catch (e) {}
}
function lanUrls(proto) {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(n => { if (n.family === 'IPv4' && !n.internal) out.push(proto + '://' + n.address + ':' + CFG.port); }));
  return out;
}
function rewriteMessages() { const tmp = MSG_FILE + '.tmp'; fs.writeFileSync(tmp, MSGS.map(m => JSON.stringify(m)).join('\n') + (MSGS.length ? '\n' : '')); fs.renameSync(tmp, MSG_FILE); }
function dirSize(d) { let n = 0; try { fs.readdirSync(d).forEach(f => { try { n += fs.statSync(path.join(d, f)).size; } catch (e) {} }); } catch (e) {} return n; }
function saveConfig() {
  const keep = {}; ['port', 'host', 'name', 'tls', 'corsOrigins', 'sessionDays', 'historyPerChannel', 'positionMaxAgeHours'].forEach(k => keep[k] = CFG[k]);
  const tmp = CFG_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(keep, null, 2)); fs.renameSync(tmp, CFG_FILE);
}
let PROTO = 'http';

/* ---------------- passwords & sessions ---------------- */
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64, { N: 16384 }).toString('hex'); }
function checkPw(user, pw) {
  const h = Buffer.from(hashPw(pw, user.salt), 'hex'), ref = Buffer.from(user.hash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}
function setPw(user, pw) { user.salt = crypto.randomBytes(16).toString('hex'); user.hash = hashPw(pw, user.salt); }
function validUser(u) { return /^[a-z0-9._-]{2,32}$/.test(u); }
function publicUser(x) { return { u: x.u, name: x.name, unit: x.unit, role: x.role }; }
function adminUser(x) { return { u: x.u, name: x.name, unit: x.unit, role: x.role, created: x.created || null, seen: x.seen || null, disabled: !!x.disabled, online: isOnline(x.u) }; }
function isOnline(u) { for (const s of STREAMS) if (s.user.u === u) return true; return false; }
function adminCount() { return Object.values(USERS).filter(x => x.role === 'admin' && !x.disabled).length; }
function newSession(u) {
  const tok = crypto.randomBytes(32).toString('base64url');
  SESS[tok] = { u, exp: Date.now() + CFG.sessionDays * 864e5 }; save('sessions.json', SESS);
  return tok;
}
function auth(req, url) {
  let tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok && url) tok = url.searchParams.get('token') || '';
  const s = tok && SESS[tok];
  if (!s || s.exp < Date.now() || !USERS[s.u] || USERS[s.u].disabled) return null;
  const user = USERS[s.u], now = Date.now();
  if (!user.seen || now - user.seen > 60000) { user.seen = now; save('users.json', USERS); }
  return { tok, user };
}
setInterval(() => { let ch = false; for (const k in SESS) if (SESS[k].exp < Date.now()) { delete SESS[k]; ch = true; } if (ch) save('sessions.json', SESS); }, 3600e3);

/* login throttling: 6 failures / 15 min per (ip,user) */
const FAILS = {};
function throttled(key) { const f = FAILS[key]; return f && f.n >= 6 && Date.now() - f.t < 15 * 60e3; }
function fail(key) { const f = FAILS[key] || { n: 0, t: Date.now() }; if (Date.now() - f.t > 15 * 60e3) { f.n = 0; f.t = Date.now(); } f.n++; FAILS[key] = f; }

/* ---------------- channels ---------------- */
// 'all'            everyone
// 'unit:<unit>'    members of that unit (+ admins)
// 'dm:<a>:<b>'     two users (sorted)
function canAccess(user, ch) {
  if (ch === 'all') return true;
  if (ch.startsWith('unit:')) return user.role === 'admin' || user.unit === ch.slice(5);
  if (ch.startsWith('dm:')) { const p = ch.split(':'); return p.length === 3 && (p[1] === user.u || p[2] === user.u) && USERS[p[1]] && USERS[p[2]]; }
  return false;
}
function channelsFor(user) {
  const out = [{ id: 'all', type: 'all' }];
  const units = new Set();
  if (user.role === 'admin') Object.values(USERS).forEach(x => x.unit && units.add(x.unit)); else if (user.unit) units.add(user.unit);
  units.forEach(u => out.push({ id: 'unit:' + u, type: 'unit', name: u }));
  const dms = new Set();
  MSGS.forEach(m => { if (m.ch.startsWith('dm:') && canAccess(user, m.ch)) dms.add(m.ch); });
  dms.forEach(c => { const p = c.split(':'), other = p[1] === user.u ? p[2] : p[1]; out.push({ id: c, type: 'dm', name: USERS[other] ? USERS[other].name : other, with: other }); });
  return out;
}

/* ---------------- live streams (SSE) ---------------- */
const STREAMS = new Set();   // {res,user}
function sse(res, ev, data) { try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {} }
function broadcastMsg(m) { STREAMS.forEach(s => { if (canAccess(s.user, m.ch)) sse(s.res, 'msg', m); }); }
function broadcastPos(p) { STREAMS.forEach(s => { if (s.user.u !== p.u) sse(s.res, 'pos', p); }); }
setInterval(() => STREAMS.forEach(s => { try { s.res.write(': ping\n\n'); } catch (e) {} }), 20000);

/* ---------------- HTTP helpers ---------------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function readBody(req, max) {
  max = max || 64 * 1024;
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max); }
function num(v, lo, hi) { v = Number(v); return isFinite(v) && v >= lo && v <= hi ? v : null; }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(f).toLowerCase();
    const fresh = ext === '.html' || f.endsWith('sw.js') || ext === '.webmanifest';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=86400', 'Content-Length': st.size });
    fs.createReadStream(f).pipe(res);
  });
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  const ip = req.socket.remoteAddress || '';

  if (p === '/api/ping') return send(res, 200, { ok: true, name: CFG.name, time: Date.now(), version: VERSION, setup: !Object.keys(USERS).length });

  /* first-run: create the commander account from the phone (needs the code shown on the server console) */
  if (p === '/api/setup' && M === 'POST') {
    if (Object.keys(USERS).length) return send(res, 409, { error: 'done' });
    const b = await readBody(req), key = ip + '|setup';
    if (throttled(key)) return send(res, 429, { error: 'throttled' });
    if (!SETUP_CODE || String(b.code || '').trim() !== SETUP_CODE) { fail(key); return send(res, 403, { error: 'bad_code' }); }
    const u = clean(b.u, 40).toLowerCase().trim();
    if (!validUser(u)) return send(res, 400, { error: 'bad_user' });
    if (String(b.p || '').length < 8) return send(res, 400, { error: 'weak' });
    const x = { u, name: clean(b.name, 60) || u, unit: clean(b.unit, 60) || 'QG', role: 'admin', created: Date.now() };
    setPw(x, b.p); USERS[u] = x; saveNow('users.json', USERS); ensureSetupCode();
    console.log('Setup done from the app — admin account:', u);
    return send(res, 200, { token: newSession(u), user: publicUser(x) });
  }

  if (p === '/api/login' && M === 'POST') {
    const b = await readBody(req), u = clean(b.u, 40).toLowerCase().trim(), key = ip + '|' + u;
    if (throttled(key)) return send(res, 429, { error: 'throttled' });
    const user = USERS[u];
    if (!user || !checkPw(user, b.p || '')) { fail(key); return send(res, 401, { error: 'bad_login' }); }
    if (user.disabled) return send(res, 403, { error: 'disabled' });
    delete FAILS[key]; user.seen = Date.now(); save('users.json', USERS);
    return send(res, 200, { token: newSession(u), user: publicUser(user) });
  }

  const a = auth(req, url);
  if (!a) return send(res, 401, { error: 'auth' });
  const me = a.user;

  if (p === '/api/logout' && M === 'POST') { delete SESS[a.tok]; save('sessions.json', SESS); return send(res, 200, { ok: true }); }
  if (p === '/api/me') return send(res, 200, { user: publicUser(me) });
  if (p === '/api/password' && M === 'POST') {
    const b = await readBody(req);
    if (!checkPw(me, b.old || '')) return send(res, 403, { error: 'bad_password' });
    if (String(b.new || '').length < 8) return send(res, 400, { error: 'weak' });
    setPw(me, b.new); save('users.json', USERS); return send(res, 200, { ok: true });
  }
  if (p === '/api/users') return send(res, 200, { users: Object.values(USERS).map(publicUser) });
  if (p === '/api/channels') return send(res, 200, { channels: channelsFor(me) });

  if (p === '/api/messages') {
    const ch = url.searchParams.get('ch') || 'all', after = +url.searchParams.get('after') || 0, before = +url.searchParams.get('before') || Infinity;
    const limit = Math.min(500, +url.searchParams.get('limit') || 200);
    if (!canAccess(me, ch)) return send(res, 403, { error: 'forbidden' });
    const list = MSGS.filter(m => m.ch === ch && m.id > after && m.id < before);
    return send(res, 200, { messages: list.slice(-limit) });
  }

  if (p === '/api/send' && M === 'POST') {
    const b = await readBody(req), ch = clean(b.ch, 120);
    if (!canAccess(me, ch)) return send(res, 403, { error: 'forbidden' });
    let type = ['text', 'loc', 'alert', 'notice'].includes(b.type) ? b.type : 'text';
    if (type === 'notice' && me.role !== 'admin') type = 'text';
    const cid = clean(b.cid, 40);
    if (cid) { const dup = MSGS.find(m => m.cid === cid && m.from === me.u); if (dup) return send(res, 200, { message: dup }); }
    const m = { id: ++SEQ, ch, from: me.u, fromName: me.name, unit: me.unit, type, text: clean(b.text, 2000), t: Date.now() };
    if (cid) m.cid = cid;
    if (type !== 'text') {
      const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
      if (lat == null || lon == null) return send(res, 400, { error: 'coords' });
      m.lat = lat; m.lon = lon; if (b.name) m.name = clean(b.name, 120);
    } else if (!m.text.trim()) return send(res, 400, { error: 'empty' });
    MSGS.push(m); fs.appendFile(MSG_FILE, JSON.stringify(m) + '\n', () => {});
    broadcastMsg(m);
    return send(res, 200, { message: m });
  }

  if (p === '/api/pos' && M === 'POST') {
    const b = await readBody(req), lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
    if (lat == null || lon == null) return send(res, 400, { error: 'coords' });
    if (b.off) { delete POS[me.u]; save('positions.json', POS); broadcastPos({ u: me.u, off: true }); return send(res, 200, { ok: true }); }
    const ps = { u: me.u, name: me.name, unit: me.unit, lat, lon, acc: num(b.acc, 0, 1e5), hdg: num(b.hdg, 0, 360), t: Date.now() };
    POS[me.u] = ps; save('positions.json', POS); broadcastPos(ps);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/pos/off' && M === 'POST') { delete POS[me.u]; save('positions.json', POS); broadcastPos({ u: me.u, off: true }); return send(res, 200, { ok: true }); }
  if (p === '/api/positions') {
    const lim = Date.now() - CFG.positionMaxAgeHours * 3600e3;
    return send(res, 200, { positions: Object.values(POS).filter(x => x.t > lim && x.u !== me.u) });
  }

  if (p === '/api/stream') {
    const since = +url.searchParams.get('since') || 0;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    sse(res, 'hello', { user: publicUser(me), channels: channelsFor(me) });
    if (since) MSGS.filter(m => m.id > since && canAccess(me, m.ch)).slice(-1000).forEach(m => sse(res, 'msg', m));
    const s = { res, user: me }; STREAMS.add(s);
    req.on('close', () => STREAMS.delete(s));
    return;
  }

  /* ---- admin (command panel) ---- */
  if (p.startsWith('/api/admin/')) {
    if (me.role !== 'admin') return send(res, 403, { error: 'forbidden' });
    const parts = p.split('/').filter(Boolean); // api admin <what> [id] [action]
    const what = parts[2];

    if (what === 'status' && M === 'GET') {
      const lim = Date.now() - CFG.positionMaxAgeHours * 3600e3, online = new Set();
      STREAMS.forEach(s => online.add(s.user.u));
      return send(res, 200, {
        version: VERSION, started: STARTED, uptime: Date.now() - STARTED, now: Date.now(),
        users: Object.keys(USERS).length, online: online.size, onlineUsers: [...online],
        messages: MSGS.length, positions: Object.values(POS).filter(x => x.t > lim).length,
        dataBytes: dirSize(DATA), node: process.version, host: os.hostname(), platform: os.platform(),
        urls: lanUrls(PROTO), https: PROTO === 'https',
        config: { name: CFG.name, sessionDays: CFG.sessionDays, positionMaxAgeHours: CFG.positionMaxAgeHours, historyPerChannel: CFG.historyPerChannel, port: CFG.port }
      });
    }

    if (what === 'config' && M === 'POST') {
      const b = await readBody(req);
      if (b.name != null) CFG.name = clean(b.name, 80) || CFG.name;
      const sd = num(b.sessionDays, 1, 365); if (sd != null) CFG.sessionDays = Math.round(sd);
      const pa = num(b.positionMaxAgeHours, 1, 168); if (pa != null) CFG.positionMaxAgeHours = Math.round(pa);
      const hp = num(b.historyPerChannel, 100, 20000); if (hp != null) { CFG.historyPerChannel = Math.round(hp); trimHistory(); rewriteMessages(); }
      saveConfig(); return send(res, 200, { ok: true });
    }

    if (what === 'broadcast' && M === 'POST') {
      const b = await readBody(req), text = clean(b.text, 2000).trim();
      if (!text) return send(res, 400, { error: 'empty' });
      const m = { id: ++SEQ, ch: 'all', from: me.u, fromName: me.name, unit: me.unit, type: 'notice', text, t: Date.now() };
      MSGS.push(m); fs.appendFile(MSG_FILE, JSON.stringify(m) + '\n', () => {}); broadcastMsg(m);
      return send(res, 200, { message: m });
    }

    if (what === 'positions' && parts[3] === 'clear' && M === 'POST') {
      Object.keys(POS).forEach(u => broadcastPos({ u, off: true })); POS = {}; saveNow('positions.json', POS);
      return send(res, 200, { ok: true });
    }

    if (what === 'history' && parts[3] === 'clear' && M === 'POST') {
      const b = await readBody(req), ch = b.ch ? clean(b.ch, 120) : null;
      MSGS = ch ? MSGS.filter(m => m.ch !== ch) : []; rewriteMessages();
      return send(res, 200, { ok: true, left: MSGS.length });
    }

    if (what === 'backup' && M === 'GET') {
      const body = JSON.stringify({ app: 'laagab-server', version: VERSION, exported: Date.now(), config: CFG, users: USERS, positions: POS, messages: MSGS });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="laagab-server-' + new Date().toISOString().slice(0, 10) + '.json"' });
      return res.end(body);
    }

    if (what === 'restore' && M === 'POST') {
      const b = await readBody(req, 64 * 1024 * 1024);
      if (b.app !== 'laagab-server' || !b.users || typeof b.users !== 'object') return send(res, 400, { error: 'bad_backup' });
      const users = {};
      Object.values(b.users).forEach(x => { if (x && validUser(x.u) && x.salt && x.hash) users[x.u] = x; });
      if (!Object.values(users).some(x => x.role === 'admin')) return send(res, 400, { error: 'no_admin' });
      USERS = users; saveNow('users.json', USERS);
      POS = b.positions && typeof b.positions === 'object' ? b.positions : {}; saveNow('positions.json', POS);
      MSGS = Array.isArray(b.messages) ? b.messages.filter(m => m && m.id && m.ch) : []; SEQ = MSGS.reduce((a, m) => Math.max(a, m.id), SEQ); trimHistory(); rewriteMessages();
      SESS = {}; SESS[a.tok] = { u: me.u, exp: Date.now() + CFG.sessionDays * 864e5 }; if (!USERS[me.u]) SESS = {}; saveNow('sessions.json', SESS);
      return send(res, 200, { ok: true, users: Object.keys(USERS).length, messages: MSGS.length });
    }

    if (what !== 'users') return send(res, 404, { error: 'not_found' });
    if (!parts[3] && M === 'GET') return send(res, 200, { users: Object.values(USERS).map(adminUser) });
    if (!parts[3] && M === 'POST') {
      const b = await readBody(req), u = clean(b.u, 40).toLowerCase().trim();
      if (!validUser(u)) return send(res, 400, { error: 'bad_user' });
      if (USERS[u]) return send(res, 409, { error: 'exists' });
      if (String(b.p || '').length < 8) return send(res, 400, { error: 'weak' });
      const x = { u, name: clean(b.name, 60) || u, unit: clean(b.unit, 60), role: b.role === 'admin' ? 'admin' : 'member', created: Date.now() };
      setPw(x, b.p); USERS[u] = x; save('users.json', USERS);
      return send(res, 200, { user: adminUser(x) });
    }
    const target = parts[3] && USERS[parts[3]];
    if (!target) return send(res, 404, { error: 'not_found' });
    const dropSessions = () => { for (const k in SESS) if (SESS[k].u === target.u) delete SESS[k]; STREAMS.forEach(s => { if (s.user.u === target.u) { try { s.res.end(); } catch (e) {} STREAMS.delete(s); } }); save('sessions.json', SESS); };
    if (parts[4] === 'password' && M === 'POST') {
      const b = await readBody(req); if (String(b.p || '').length < 8) return send(res, 400, { error: 'weak' });
      setPw(target, b.p); save('users.json', USERS); if (target.u !== me.u) dropSessions();
      return send(res, 200, { ok: true });
    }
    if (parts[4] === 'kick' && M === 'POST') {
      if (target.u === me.u) return send(res, 400, { error: 'self' });
      dropSessions(); return send(res, 200, { ok: true });
    }
    if (!parts[4] && M === 'POST') {   // edit name / unit / role / disabled
      const b = await readBody(req);
      const losesAdmin = target.role === 'admin' && !target.disabled && ((b.role && b.role !== 'admin') || b.disabled === true);
      if (losesAdmin && adminCount() <= 1) return send(res, 400, { error: 'last_admin' });
      if (target.u === me.u && b.disabled === true) return send(res, 400, { error: 'self' });
      if (b.name != null) target.name = clean(b.name, 60) || target.name;
      if (b.unit != null) target.unit = clean(b.unit, 60);
      if (b.role) target.role = b.role === 'admin' ? 'admin' : 'member';
      if (b.disabled != null) { target.disabled = !!b.disabled; if (target.disabled) dropSessions(); }
      save('users.json', USERS); return send(res, 200, { user: adminUser(target) });
    }
    if (!parts[4] && M === 'DELETE') {
      if (target.u === me.u) return send(res, 400, { error: 'self' });
      if (target.role === 'admin' && adminCount() <= 1 && !target.disabled) return send(res, 400, { error: 'last_admin' });
      dropSessions(); delete USERS[target.u]; delete POS[target.u];
      save('users.json', USERS); save('positions.json', POS); broadcastPos({ u: target.u, off: true });
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not_found' });
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (origin && CFG.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { if (!res.headersSent) send(res, 400, { error: 'bad_request' }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
}

/* ---------------- CLI ---------------- */
function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else rl.output.write(''); }; }
    rl.question(q, ans => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(ans); });
  });
}
async function askPw() {
  if (process.env.LAAGAB_PW) return process.env.LAAGAB_PW;
  const a = await ask('Password (min 8): ', true), b = await ask('Repeat password: ', true);
  if (a !== b) { console.error('Passwords do not match.'); process.exit(1); }
  if (a.length < 8) { console.error('Password too short.'); process.exit(1); }
  return a;
}
async function cli(args) {
  const cmd = args[0];
  if (cmd === 'adduser') {
    const [, u0, name, unit, role] = args, u = String(u0 || '').toLowerCase();
    if (!validUser(u)) { console.error('Usage: node server.js adduser <user> "<name>" "<unit>" [admin]   (user: a-z 0-9 . _ -)'); process.exit(1); }
    if (USERS[u]) { console.error('User exists.'); process.exit(1); }
    const x = { u, name: name || u, unit: unit || '', role: role === 'admin' ? 'admin' : 'member', created: Date.now() };
    setPw(x, await askPw()); USERS[u] = x; saveNow('users.json', USERS); ensureSetupCode();
    console.log('User created:', u, '(' + x.role + ')');
  } else if (cmd === 'passwd') {
    const x = USERS[String(args[1] || '').toLowerCase()]; if (!x) { console.error('No such user.'); process.exit(1); }
    setPw(x, await askPw()); saveNow('users.json', USERS); console.log('Password changed.');
  } else if (cmd === 'deluser') {
    const u = String(args[1] || '').toLowerCase(); if (!USERS[u]) { console.error('No such user.'); process.exit(1); }
    delete USERS[u]; saveNow('users.json', USERS); console.log('Deleted', u);
  } else if (cmd === 'code') {
    ensureSetupCode(); console.log(SETUP_CODE ? 'Setup code: ' + SETUP_CODE : 'Setup already done (users exist).');
  } else if (cmd === 'users') {
    Object.values(USERS).forEach(x => console.log(x.u.padEnd(20), x.role.padEnd(7), x.unit.padEnd(24), x.name));
  } else { console.error('Unknown command.'); process.exit(1); }
  process.exit(0);
}

/* ---------------- start ---------------- */
if (process.argv.length > 2) { cli(process.argv.slice(2)); }
else {
  const keyF = path.resolve(ROOT, CFG.tls.key || ''), certF = path.resolve(ROOT, CFG.tls.cert || '');
  let server, proto;
  if (CFG.tls && fs.existsSync(keyF) && fs.existsSync(certF)) {
    server = https.createServer({ key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) }, handler); proto = 'https';
  } else {
    server = http.createServer(handler); proto = 'http';
    console.warn('⚠ No TLS certificate found — running plain HTTP. Use HTTPS (certificate or reverse proxy) before real use.');
  }
  PROTO = proto; ensureSetupCode();
  server.keepAliveTimeout = 65000;
  server.listen(CFG.port, CFG.host, () => {
    console.log('');
    console.log('  لعگابْ 🦅  Laagab server ' + VERSION + '  ·  users: ' + Object.keys(USERS).length + '  ·  messages: ' + MSGS.length);
    const urls = lanUrls(proto);
    console.log('  Open on the phones:  ' + (urls.length ? urls.join('   ') : proto + '://<server-address>:' + CFG.port));
    if (SETUP_CODE) {
      console.log('');
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log('  │  FIRST SETUP — open the app on your phone,   │');
      console.log('  │  then enter this code:      ' + SETUP_CODE + '            │');
      console.log('  └──────────────────────────────────────────────┘');
      console.log('  (also saved in data/setup-code.txt)');
    }
    console.log('');
  });
}
