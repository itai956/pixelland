'use strict';
/* אדמת פיקסלים - שרת. כל חוקי המשחק רצים כאן, והדפדפנים רק מציגים ושולחים בקשות. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/* ---------- הגדרות (אפשר לשנות כאן) ---------- */
const PORT = +process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const W = 160, H = 96;                                   // גודל הזירה
const GH = +process.env.GAME_HOUR_MS || 60000;           // שעת משחק אחת באלפיות שנייה (60000 = דקה אמיתית)
const CLAIM_MIN = 5, CLAIM_PCT = 1.2;                    // עלות קניית מגרש פנוי
const BONUS_EVERY = 8 * GH, BONUS_PCT = 3, BONUS_MIN = 5; // בונוס
const RANGE = 2;                                         // מרחק מקסימלי מהשטח שלך לקנייה/תקיפה
const HOSTILE_CD = 3000;                                 // זמן המתנה בין תקיפות (אלפיות שנייה)
const MINHUE = 7;                                        // מרחק מינימלי בין צבעים של שחקנים שונים
const START_INV = 20;
const BOTS_ON = process.env.BOTS !== '0';                // BOTS=0 מכבה בוטים
const BOT_DEFS = [
  { id: 'bot-0', name: 'דני (בוט)', hue: 350 }, { id: 'bot-1', name: 'מיה (בוט)', hue: 205 },
  { id: 'bot-2', name: 'רוני (בוט)', hue: 140 }, { id: 'bot-3', name: 'אסף (בוט)', hue: 45 },
  { id: 'bot-4', name: 'נוי (בוט)', hue: 285 }, { id: 'bot-5', name: 'עידו (בוט)', hue: 170 }
];
const BOT_MAX_CELLS = 70;

/* ---------- מצב העולם ---------- */
const cells = new Array(W * H).fill(null);   // {o: מזהה בעלים, n: שם, c: גוון, s: זמן כיבוש}
const players = new Map();                   // id -> {id,name,em,hue,joinedAt,inv,collectedAt,bonusAt,token,bot}
const tokenToId = new Map();
const sockets = new Map();                   // id -> Set(ws)
const lastHostile = new Map();
let dirty = false;

/* ---------- חוקי המשחק (חייבים להתאים למה שהלקוח מציג) ---------- */
const now = () => Date.now();
const ageDays = c => Math.max(0, (now() - c.s) / (24 * GH));
const fairValue = c => Math.round(5 + ageDays(c) * 4);
const stealCost = c => Math.max(10, Math.ceil(fairValue(c) * 1.6));
const destroyCost = c => Math.max(8, Math.ceil(fairValue(c) * 0.6));
function nbOwn(x, y, o) {
  let n = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = x + dx, b = y + dy;
    if (a >= 0 && b >= 0 && a < W && b < H) { const c = cells[b * W + a]; if (c && c.o === o) n++; }
  }
  return n;
}
const cellYield = (x, y, c) => 1 + Math.min(ageDays(c), 20) * 0.15 + (nbOwn(x, y, c.o) >= 2 ? 0.5 : 0);
const seniority = p => 1 + Math.min((now() - p.joinedAt) / (24 * GH), 30) * 0.02;
function rateOf(p) {
  let y = 0;
  for (let i = 0; i < cells.length; i++) { const c = cells[i]; if (c && c.o === p.id) y += cellYield(i % W, Math.floor(i / W), c); }
  return y * seniority(p);
}
const claimCost = p => Math.max(CLAIM_MIN, Math.ceil(rateOf(p) * CLAIM_PCT));
const bonusAmt = p => Math.max(BONUS_MIN, Math.round(rateOf(p) * BONUS_PCT));
const pendingOf = p => Math.min(rateOf(p) * 8, rateOf(p) * Math.max(0, now() - p.collectedAt) / GH);
function hasNeighbor(x, y, o) {
  for (let dy = -RANGE; dy <= RANGE; dy++) for (let dx = -RANGE; dx <= RANGE; dx++) {
    const a = x + dx, b = y + dy;
    if (a < 0 || b < 0 || a >= W || b >= H) continue;
    const c = cells[b * W + a]; if (c && c.o === o) return true;
  }
  return false;
}

/* ---------- צבעים ייחודיים ---------- */
const hd = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
function freeHue(h, exceptId) { for (const p of players.values()) if (p.id !== exceptId && hd(p.hue, h) < MINHUE) return false; return true; }
function nearestFree(h, exceptId) {
  h = ((Math.round(h) % 360) + 360) % 360;
  if (freeHue(h, exceptId)) return h;
  for (let d = 1; d < 180; d++) for (const k of [d, -d]) { const t = ((h + k) % 360 + 360) % 360; if (freeHue(t, exceptId)) return t; }
  return h;
}

/* ---------- שמירה לדיסק ---------- */
function save() {
  if (!dirty) return;
  dirty = false;
  const out = { cells: [], players: [...players.values()] };
  cells.forEach((c, i) => { if (c) out.cells.push([i, c.o, c.n, c.c, c.s]); });
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
  catch (e) { console.error('שמירה נכשלה:', e.message); dirty = true; }
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (d.players || []).forEach(p => { players.set(p.id, p); if (p.token) tokenToId.set(p.token, p.id); });
    (d.cells || []).forEach(([i, o, n, c, s]) => { if (i >= 0 && i < cells.length) cells[i] = { o, n, c, s }; });
    console.log('נטענו', players.size, 'שחקנים ו', d.cells.length, 'תאים');
  } catch (e) { console.log('מתחילים עולם חדש'); }
}
setInterval(save, 5000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

/* ---------- שליחה ללקוחות ---------- */
const pub = p => ({ name: p.name, em: p.em, hue: p.hue, inv: Math.round(p.inv) });
const meView = p => ({ name: p.name, em: p.em, hue: p.hue, joinedAt: p.joinedAt, inv: Math.round(p.inv * 100) / 100, collectedAt: p.collectedAt, bonusAt: p.bonusAt });
function sendTo(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function broadcast(m) { const s = JSON.stringify(m); wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(s); }); }
function toPlayer(id, m) { const set = sockets.get(id); if (set) set.forEach(ws => sendTo(ws, m)); }
function pushMe(p) { toPlayer(p.id, { t: 'me', uid: p.id, me: meView(p) }); broadcast({ t: 'p', id: p.id, p: pub(p) }); dirty = true; }
function pushCell(x, y) {
  const c = cells[y * W + x];
  broadcast({ t: 'c', x, y, c: c ? { o: c.o, n: c.n, c: c.c, s: c.s } : null });
  dirty = true;
}
function pushOnline() { let n = 0; sockets.forEach((set, id) => { if (set.size && !players.get(id)?.bot) n++; }); broadcast({ t: 'online', n }); }

/* ---------- יצירת בסיס ---------- */
function free2(x, y) {
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const a = x + dx, b = y + dy; if (a < 0 || b < 0 || a >= W || b >= H || cells[b * W + a]) return false;
  }
  return true;
}
function pickSpot() {
  const occ = []; cells.forEach((c, i) => { if (c) occ.push(i); });
  for (let t = 0; t < 300; t++) {
    let x, y;
    if (occ.length && t < 200) {
      const s = occ[Math.floor(Math.random() * occ.length)], a = Math.random() * 6.28, d = 7 + Math.random() * 10;
      x = Math.round(s % W + Math.cos(a) * d); y = Math.round(Math.floor(s / W) + Math.sin(a) * d);
    } else { x = 2 + Math.floor(Math.random() * (W - 5)); y = 2 + Math.floor(Math.random() * (H - 5)); }
    if (x < 1 || y < 1 || x > W - 3 || y > H - 3) continue;
    if (free2(x, y) && free2(x - 1, y - 1) && free2(x + 1, y + 1)) return { x, y };
  }
  return null;
}
function spawnBase(p) {
  const sp = pickSpot(); if (!sp) return null;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    cells[(sp.y + dy) * W + sp.x + dx] = { o: p.id, n: p.name, c: p.hue, s: now() };
    pushCell(sp.x + dx, sp.y + dy);
  }
  return sp;
}

/* ---------- פעולות שחקן ---------- */
const cleanName = s => String(s || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const validEm = e => typeof e === 'string' && /^[01]{25}$/.test(e) && e.includes('1');
const inGrid = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;
const err = (ws, m) => sendTo(ws, { t: 'err', m });

function doJoin(ws, m) {
  if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 80) return err(ws, 'מזהה לא תקין');
  if (tokenToId.has(m.token)) return err(ws, 'כבר יש לך שחקן');
  const name = cleanName(m.name); if (!name) return err(ws, 'צריך כינוי');
  if (players.size >= 5000) return err(ws, 'העולם מלא');
  const id = 'u' + require('crypto').randomBytes(6).toString('hex');
  const p = {
    id, name, em: validEm(m.em) ? m.em : '0010001110011100111000100', hue: nearestFree(+m.hue || 0, id),
    joinedAt: now(), inv: START_INV, collectedAt: now(), bonusAt: 0, token: m.token
  };
  const sp = spawnBase(p); if (!sp) return err(ws, 'אין מקום לבסיס חדש');
  players.set(id, p); tokenToId.set(m.token, id);
  bind(ws, id);
  pushMe(p);
  sendTo(ws, { t: 'spawn', x: sp.x, y: sp.y });
  pushOnline();
}
function bind(ws, id) {
  ws.pid = id;
  if (!sockets.has(id)) sockets.set(id, new Set());
  sockets.get(id).add(ws);
}
function doClaim(p, ws, m) {
  if (!inGrid(m.x, m.y)) return err(ws, 'מיקום לא תקין');
  if (cells[m.y * W + m.x]) return err(ws, 'התא כבר תפוס');
  if (!hasNeighbor(m.x, m.y, p.id)) return err(ws, 'אפשר לקנות רק עד ' + RANGE + ' תאים מהשטח שלך');
  const cost = claimCost(p); if (p.inv < cost) return err(ws, 'אין מספיק פיקסלים. צריך ' + cost);
  p.inv -= cost; cells[m.y * W + m.x] = { o: p.id, n: p.name, c: p.hue, s: now() };
  pushCell(m.x, m.y); pushMe(p);
  sendTo(ws, { t: 'ok', k: 'claim', x: m.x, y: m.y });
  broadcast({ t: 'ev', k: 'claim', x: m.x, y: m.y, n: p.name });
}
function doAttack(p, ws, m) {
  const kind = m.kind;
  if (kind !== 'steal' && kind !== 'destroy') return err(ws, 'פעולה לא תקינה');
  if (!inGrid(m.x, m.y)) return err(ws, 'מיקום לא תקין');
  const wait = HOSTILE_CD - (now() - (lastHostile.get(p.id) || 0));
  if (wait > 0) return err(ws, 'תקיפה הבאה בעוד ' + Math.ceil(wait / 1000) + ' שניות');
  const c = cells[m.y * W + m.x];
  if (!c || c.o === p.id) return err(ws, 'אין כאן מה לתקוף');
  if (!hasNeighbor(m.x, m.y, p.id)) return err(ws, 'אפשר לתקוף רק עד ' + RANGE + ' תאים מהשטח שלך');
  const cost = kind === 'steal' ? stealCost(c) : destroyCost(c);
  if (p.inv < cost) return err(ws, 'אין מספיק פיקסלים. צריך ' + cost);
  const victim = c.o, vn = c.n;
  p.inv -= cost; lastHostile.set(p.id, now());
  cells[m.y * W + m.x] = kind === 'steal' ? { o: p.id, n: p.name, c: p.hue, s: now() } : null;
  pushCell(m.x, m.y); pushMe(p);
  sendTo(ws, { t: 'ok', k: kind, x: m.x, y: m.y });
  toPlayer(victim, { t: 'note', why: kind, n: p.name, x: m.x, y: m.y });
  broadcast({ t: 'ev', k: kind, x: m.x, y: m.y, n: p.name, vn, v: victim, a: cost });
}
function doHarvest(p, ws) {
  const amt = Math.floor(pendingOf(p)); if (amt < 1) return err(ws, 'עוד אין מה לקצור');
  p.inv += amt; p.collectedAt = now(); pushMe(p); sendTo(ws, { t: 'ok', k: 'harvest', amt });
}
function doBonus(p, ws) {
  const w = BONUS_EVERY - (now() - p.bonusAt); if (w > 0) return err(ws, 'הבונוס הבא בעוד ' + Math.ceil(w / GH * 60) + ' דקות');
  const amt = bonusAmt(p); p.inv += amt; p.bonusAt = now(); pushMe(p); sendTo(ws, { t: 'ok', k: 'bonus', amt });
}
function doProfile(p, ws, m) {
  if (!validEm(m.em)) return err(ws, 'סמל לא תקין');
  p.em = m.em; p.hue = nearestFree(+m.hue || 0, p.id);
  for (let i = 0; i < cells.length; i++) if (cells[i] && cells[i].o === p.id) { cells[i].c = p.hue; }
  pushMe(p);
  for (let i = 0; i < cells.length; i++) if (cells[i] && cells[i].o === p.id) pushCell(i % W, Math.floor(i / W));
  sendTo(ws, { t: 'ok', k: 'profile' });
}

/* ---------- בוטים (מתפשטים בלבד, לא תוקפים) ---------- */
function botTick() {
  if (!BOTS_ON) return;
  for (const d of BOT_DEFS) {
    if (!players.has(d.id)) {
      const p = { id: d.id, name: d.name, em: '0100001110111110111000100', hue: d.hue, joinedAt: now(), inv: 0, collectedAt: now(), bonusAt: 0, bot: true };
      players.set(d.id, p); broadcast({ t: 'p', id: p.id, p: pub(p) });
    }
  }
  const d = BOT_DEFS[Math.floor(Math.random() * BOT_DEFS.length)], p = players.get(d.id);
  const mine = []; cells.forEach((c, i) => { if (c && c.o === p.id) mine.push(i); });
  if (!mine.length) { spawnBase(p); return; }
  if (mine.length >= BOT_MAX_CELLS) return;
  const s = mine[Math.floor(Math.random() * mine.length)];
  const x = s % W + Math.floor(Math.random() * 5) - 2, y = Math.floor(s / W) + Math.floor(Math.random() * 5) - 2;
  if (!inGrid(x, y) || cells[y * W + x]) return;
  cells[y * W + x] = { o: p.id, n: p.name, c: p.hue, s: now() }; pushCell(x, y);
}
setInterval(botTick, 2500);

/* ---------- שרת ווב ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(INDEX, (e, buf) => {
      if (e) { res.writeHead(500); return res.end('חסר הקובץ public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('לא נמצא');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function sendInit(ws, p) {
  const list = []; cells.forEach((c, i) => { if (c) list.push([i, c.o, c.n, c.c, c.s]); });
  const pl = {}; players.forEach((q, id) => { pl[id] = pub(q); });
  sendTo(ws, {
    t: 'init', now: now(), uid: p ? p.id : null, me: p ? meView(p) : null, cells: list, players: pl,
    cfg: { GH, CLAIM_MIN, CLAIM_PCT, BONUS_EVERY, BONUS_PCT, BONUS_MIN, RANGE, MINHUE, W, H }
  });
}
wss.on('connection', ws => {
  ws.pid = null; ws.hits = []; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    const t0 = now(); ws.hits = ws.hits.filter(t => t0 - t < 1000); ws.hits.push(t0);
    if (ws.hits.length > 20) return;                       // הגבלת קצב
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const id = typeof m.token === 'string' ? tokenToId.get(m.token) : null;
      const p = id ? players.get(id) : null;
      if (p) bind(ws, id);
      sendInit(ws, p); pushOnline(); return;
    }
    if (m.t === 'join') return doJoin(ws, m);
    const p = ws.pid ? players.get(ws.pid) : null;
    if (!p) return err(ws, 'צריך להצטרף קודם');
    if (m.t === 'claim') doClaim(p, ws, m);
    else if (m.t === 'attack') doAttack(p, ws, m);
    else if (m.t === 'harvest') doHarvest(p, ws);
    else if (m.t === 'bonus') doBonus(p, ws);
    else if (m.t === 'profile') doProfile(p, ws, m);
  });
  ws.on('close', () => {
    if (ws.pid && sockets.has(ws.pid)) { sockets.get(ws.pid).delete(ws); }
    pushOnline();
  });
  ws.on('error', () => {});
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) {} }); }, 30000);

load();
server.listen(PORT, () => console.log('אדמת פיקסלים רצה על פורט ' + PORT));
