'use strict';
// «Хранилище» — сайт с загадками для Недели финансовой грамотности.
// Без внешних зависимостей: нужен только Node.js 22.13 или новее.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./lib/db');
const { Bots } = require('./lib/bots');
const { normalize, timeValue, finalPoints } = require('./lib/scoring');

// ---------- Настройки ----------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = process.env;
const cfg = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  adminPassword: env.ADMIN_PASSWORD || '',
  devLogin: env.DEV_LOGIN === '1',
  tgToken: env.TG_BOT_TOKEN || '',
  tgUser: (env.TG_BOT_USERNAME || '').replace(/^@/, ''),
  tgApiBase: env.TG_API_BASE || '',
  vkToken: env.VK_GROUP_TOKEN || '',
  vkGroupId: env.VK_GROUP_ID || '',
  vkScreen: env.VK_GROUP_SCREEN || '',
};

const ATTEMPT_COOLDOWN_MS = 20000;
const LOGIN_CODE_TTL_MS = 15 * 60000;
const SOON_MS = 15 * 60000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(cfg.dataDir, 'uploads');

const db = openDb(cfg.dataDir);
// Пасхалка: секретный замок №9. Не показывается среди замков, найти его можно только по цепочке
// robots.txt → /keeper → консоль браузера. Даёт фиксированные 15 баллов и значок «Любопытный».
// Ответ задаётся в .env (SECRET_WORD) и в коде не хранится: репозиторий открытый. На сервере замок уже лежит в базе.
const SECRET_NUM = 9, SECRET_WORD = String(env.SECRET_WORD || '').trim();
if (SECRET_WORD) db.prepare(`INSERT OR IGNORE INTO puzzles(num,kind,title,body,opens_at,max_points,min_points,decay_minutes,answers,hints,published,notified_open,notified_soon)
  VALUES(?, 'secret', 'Секретный замок', '', 0, 15, 15, 1, ?, '[]', 1, 1, 1)`).run(SECRET_NUM, JSON.stringify([SECRET_WORD]));
const q = sql => db.prepare(sql);
const now = () => Date.now();
const rand = n => crypto.randomBytes(n).toString('hex');

const kvGet = k => { const r = q('SELECT value FROM kv WHERE key=?').get(k); return r ? r.value : null; };
const kvSet = (k, v) => q('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
if (!kvGet('secret')) kvSet('secret', rand(32));
const adminToken = () => crypto.createHmac('sha256', kvGet('secret')).update('admin:' + cfg.adminPassword).digest('hex');
const endsAt = () => Number(kvGet('ends_at') || 0);

// ---------- Боты ----------
function bindCode(code, provider, providerId, name) {
  const r = q('UPDATE login_codes SET provider=?, provider_id=?, display_name=? WHERE code=? AND provider IS NULL AND created_at>?')
    .run(provider, providerId, name || '', code, now() - LOGIN_CODE_TTL_MS);
  return r.changes > 0;
}
const bots = new Bots(cfg, bindCode);
// Хранитель пишет всем игрокам от первого лица, когда в игре что-то происходит.
const pickOne = a => a[Math.floor(Math.random() * a.length)];
function keeper(text) {
  const users = q("SELECT provider, provider_id FROM users WHERE banned=0 AND provider IN ('tg','vk')").all();
  bots.broadcast(users, '🗝 ' + text);
}
const mins = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; };

// ---------- HTTP-помощники ----------
class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const fail = (code, msg, extra) => { throw new HttpError(code, msg, extra); };

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const secure = cfg.baseUrl.startsWith('https') ? '; Secure' : '';
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  const prev = res.getHeader('set-cookie') || [];
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : [prev]), c]);
}
function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

// Простое ограничение частоты запросов в памяти: key -> [метки времени]
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const arr = (buckets.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Слишком часто. Подожди немного.');
  arr.push(t); buckets.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, a] of buckets) if (!a.some(x => t - x < 600000)) buckets.delete(k); }, 600000).unref();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

// ---------- Пользователи ----------
function currentUser(cookies) {
  if (!cookies.sid) return null;
  return q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(cookies.sid) || null;
}
const publicUser = u => u && ({ id: u.id, nick: u.nick, group: u.group_name, staff: !!u.is_staff, provider: u.provider, needs_profile: !u.nick, banned: !!u.banned });
function requirePlayer(ctx) {
  const u = ctx.user;
  if (!u) fail(401, 'Сначала войди');
  if (u.banned) fail(403, 'Аккаунт заблокирован организаторами');
  if (!u.nick) fail(403, 'Сначала заполни профиль');
  return u;
}
function requireAdmin(ctx) {
  if (!cfg.adminPassword) fail(403, 'Админка выключена: не задан ADMIN_PASSWORD');
  const a = Buffer.from(String(ctx.cookies.adm || '')), b = Buffer.from(adminToken());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(401, 'Нужен вход администратора');
}
function loginAs(res, provider, providerId, name, cookies = {}) {
  let u = q('SELECT * FROM users WHERE provider=? AND provider_id=?').get(provider, providerId);
  if (!u) {
    const ref = Number(cookies.ref) || null;
    const refOk = ref && q('SELECT 1 FROM users WHERE id=?').get(ref) ? ref : null;
    q('INSERT INTO users(provider,provider_id,display_name,created_at,src,ref_by) VALUES(?,?,?,?,?,?)')
      .run(provider, providerId, name || '', now(), String(cookies.src || 'direct').slice(0, 20), refOk);
    u = q('SELECT * FROM users WHERE provider=? AND provider_id=?').get(provider, providerId);
  }
  const sid = rand(24);
  q('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(sid, u.id, now());
  setCookie(res, 'sid', sid, 60 * 60 * 24 * 30);
  return u;
}

// ---------- Загадки ----------
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
function openPuzzle(num) {
  const p = q('SELECT * FROM puzzles WHERE num=? AND published=1').get(Number(num));
  if (!p || p.opens_at > now()) fail(404, 'Этот замок ещё закрыт');
  return p;
}
// Молниеносный замок живёт decay_minutes минут после открытия, потом ответы не принимаются.
const flashEnd = p => p.opens_at + p.decay_minutes * 60000;
const flashClosed = p => p.kind === 'flash' && now() >= flashEnd(p);
const hintsUsed = (uid, pid) => q('SELECT COUNT(*) c FROM hint_uses WHERE user_id=? AND puzzle_id=?').get(uid, pid).c;
const wrongCount = (uid, pid) => q('SELECT COUNT(*) c FROM attempts WHERE user_id=? AND puzzle_id=? AND correct=0').get(uid, pid).c;
const contestOver = () => { const e = endsAt(); return e > 0 && now() >= e; };

// ---------- Приглашения друзей ----------
// Бонус начисляется, когда приглашённый решит хоть что-то (даже разминку): так нельзя накрутить баллы пустыми аккаунтами.
const REF_BONUS = 5, REF_MAX = 10;
function creditReferral(u) {
  if (!u.ref_by || u.ref_done || u.ref_by === u.id) return;
  q('UPDATE users SET ref_done=1, bonus=bonus+? WHERE id=?').run(REF_BONUS, u.id);
  const done = q('SELECT COUNT(*) c FROM users WHERE ref_by=? AND ref_done=1').get(u.ref_by).c;
  if (done <= REF_MAX) q('UPDATE users SET bonus=bonus+? WHERE id=? AND banned=0').run(REF_BONUS, u.ref_by);
}

// ---------- Вклад ----------
// Игрок кладёт баллы на вклад: 5% за каждые полные сутки, простые проценты. Пока вклад открыт, подсказки недоступны.
const DEP_RATE = 0.05, DEP_MIN = 10, DAY = 86400000;
function interestOf(u, t = now()) {
  if (!u || !u.deposit || !u.dep_at) return 0;
  const end = endsAt() > 0 ? Math.min(t, endsAt()) : t;
  return Math.floor(u.deposit * DEP_RATE * Math.max(0, Math.floor((end - u.dep_at) / DAY)));
}
const baseTotal = u => q('SELECT COALESCE(SUM(points),0) t FROM solves WHERE user_id=?').get(u.id).t + (u.bonus || 0);
// Сортировка таблицы с учётом процентов по вкладу: проценты считаются на лету, поэтому их нельзя добавить в SQL.
const withInterest = rows => rows.map(r => ({ ...r, total: r.total + interestOf(r) })).sort((a, b) => b.total - a.total || a.last - b.last);

// ---------- Значки ----------
// Считаются на лету из решений, поэтому их не нужно хранить и пересчитывать.
function badgesMap() {
  const m = new Map(), add = (id, b) => { const a = m.get(id) || []; if (!a.includes(b)) a.push(b); m.set(id, a); };
  const lockTotal = q("SELECT COUNT(*) c FROM puzzles WHERE published=1 AND kind='lock'").get().c;
  const locks = new Map(), warms = new Map(), hinted = new Set();
  for (const h of q('SELECT DISTINCT user_id, puzzle_id FROM hint_uses').all()) hinted.add(h.user_id + ':' + h.puzzle_id);
  for (const r of q('SELECT s.user_id, s.puzzle_id, s.place, s.solved_at, p.kind, p.opens_at FROM solves s JOIN puzzles p ON p.id=s.puzzle_id').all()) {
    if (r.kind === 'secret') add(r.user_id, 'curious');
    else if (r.kind === 'warmup') warms.set(r.user_id, (warms.get(r.user_id) || 0) + 1);
    else {
      const l = locks.get(r.user_id) || { n: 0, clean: 0 }; l.n++; if (!hinted.has(r.user_id + ':' + r.puzzle_id)) l.clean++; locks.set(r.user_id, l);
      if (r.place === 1) add(r.user_id, 'first');
      if (r.solved_at - r.opens_at <= 30 * 60000) add(r.user_id, 'fast');
    }
  }
  for (const [id, l] of locks) { if (l.clean >= 2) add(id, 'clean'); if (lockTotal >= 2 && l.n >= lockTotal) add(id, 'all'); }
  for (const [id, n] of warms) if (n >= 3) add(id, 'warm');
  for (const r of q('SELECT id FROM users WHERE phish_reported IS NOT NULL AND phish_clicked IS NULL').all()) add(r.id, 'vigilant');
  for (const r of q('SELECT ref_by id, COUNT(*) c FROM users WHERE ref_done=1 AND ref_by IS NOT NULL GROUP BY ref_by').all()) if (r.c >= 3) add(r.id, 'friends');
  return m;
}

// ---------- Статистика посещений ----------
const mskDay = t => new Date(t + 3 * 3600000).toISOString().slice(0, 10);
function sourceOf(url, req) {
  const tag = (url.searchParams.get('src') || url.searchParams.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (tag) return tag;
  if (url.searchParams.get('r')) return 'friend';
  let host = ''; try { host = new URL(req.headers.referer || '').hostname; } catch { /* нет реферера */ }
  if (!host || host === new URL(cfg.baseUrl).hostname) return 'direct';
  if (/(^|\.)(vk\.com|vk\.ru|vk\.me)$/.test(host)) return 'vk';
  if (/instagram|ig\.me/.test(host)) return 'instagram';
  if (/(^|\.)t\.me$|telegram/.test(host)) return 'telegram';
  if (/yandex|google|bing/.test(host)) return 'search';
  return 'other';
}
function trackVisit(req, res, url, pathname) {
  try {
    const cookies = parseCookies(req), t = now(), day = mskDay(t);
    let vid = cookies.v, first = 0;
    if (!/^[a-f0-9]{20}$/.test(vid || '')) { vid = rand(10); first = 1; setCookie(res, 'v', vid, 60 * 60 * 24 * 365); }
    const src = sourceOf(url, req);
    if (!cookies.src || src !== 'direct') setCookie(res, 'src', cookies.src && src === 'direct' ? cookies.src : src, 60 * 60 * 24 * 30);
    const r = Number(url.searchParams.get('r'));
    if (r > 0 && !cookies.sid) setCookie(res, 'ref', String(r), 60 * 60 * 24 * 30);
    q('INSERT OR IGNORE INTO visits(day,vid,src,first) VALUES(?,?,?,?)').run(day, vid, src === 'direct' && cookies.src ? cookies.src : src, first);
    q('INSERT INTO pageviews(day,path,n) VALUES(?,?,1) ON CONFLICT(day,path) DO UPDATE SET n=n+1').run(day, pathname);
  } catch (e) { console.error('trackVisit', e.message); }
}

// ---------- Маршруты ----------
const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

route('GET', /^\/api\/state$/, ctx => {
  const t = now(), u = ctx.user;
  // Черновые замки тоже показываем — как закрытые, с таймером, но без названия. Открыться они не могут,
  // пока организатор не опубликует их (так замок №1 виден до шоу, хотя шифр в него вписывают после).
  const puzzles = q("SELECT * FROM puzzles WHERE (published=1 OR kind='lock') AND kind NOT IN ('secret','page') ORDER BY num").all()
    .filter(p => p.kind !== 'flash' || (p.opens_at <= t && (t < flashEnd(p) || (u && q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id))))).map(p => {
    const open = p.published === 1 && p.opens_at <= t;
    const mine = u ? q('SELECT points, place FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id) : null;
    return {
      num: p.num, kind: p.kind, opens_at: p.opens_at, open, draft: p.published !== 1, closes_at: p.kind === 'flash' ? flashEnd(p) : 0,
      title: open ? p.title : null,
      max_points: p.max_points, min_points: p.min_points, decay_minutes: p.decay_minutes,
      solvers: open ? q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0').get(p.id).c : 0,
      solved: mine || null,
    };
  });
  const total = u ? baseTotal(u) + interestOf(u) : 0;
  const deposit = u && u.nick ? { amount: u.deposit, since: u.dep_at, interest: interestOf(u), rate: DEP_RATE, min: DEP_MIN, free: baseTotal(u), next_at: u.deposit ? u.dep_at + (Math.floor((now() - u.dep_at) / DAY) + 1) * DAY : 0 } : null;
  const invite = u && u.nick ? { url: `${cfg.baseUrl}/?r=${u.id}`, friends: q('SELECT COUNT(*) c FROM users WHERE ref_by=? AND ref_done=1').get(u.id).c, pending: q('SELECT COUNT(*) c FROM users WHERE ref_by=? AND ref_done=0').get(u.id).c, per: REF_BONUS, max: REF_MAX } : null;
  return { now: t, ends_at: endsAt(), user: publicUser(u), total, puzzles, invite, deposit, auction: (a => a && (!a.settled || now() - a.ends_at < 12 * 3600000) ? auctionView(a, u) : null)(curAuction()), badges: u ? (badgesMap().get(u.id) || []) : [], feedback_on: kvGet('feedback_on') === '1',
    login: { tg: !!(cfg.tgToken && cfg.tgUser), vk: !!(cfg.vkToken && cfg.vkScreen), dev: cfg.devLogin } };
});

route('GET', /^\/api\/leaderboard$/, () => {
  const all = withInterest(q(`SELECT u.id, u.nick, u.group_name, u.is_staff, u.deposit, u.dep_at, COALESCE(SUM(s.points),0) + u.bonus total, COALESCE(MAX(s.solved_at), 9e15) last
                  FROM users u LEFT JOIN solves s ON s.user_id=u.id WHERE u.banned=0 AND u.nick IS NOT NULL
                  GROUP BY u.id HAVING total > 0 ORDER BY total DESC, last ASC`).all());
  const rows = all.filter(r => !r.is_staff), staffRows = all.filter(r => r.is_staff);
  const per = {}, warm = {}, secret = {}, bm = badgesMap();
  for (const r of q('SELECT s.user_id, p.num, p.kind, s.points, s.place FROM solves s JOIN puzzles p ON p.id=s.puzzle_id').all()) {
    if (r.kind === 'secret') secret[r.user_id] = true;
    else if (r.kind === 'warmup') warm[r.user_id] = (warm[r.user_id] || 0) + r.points;
    else (per[r.user_id] = per[r.user_id] || {})[r.num] = { points: r.points, place: r.place };
  }
  // Зачёт групп: сумма баллов пяти лучших игроков. «Ф-21», «ф 21» и «Ф21» считаются одной группой.
  const gmap = new Map();
  for (const r of all) {
    // Все преподаватели — одна команда, которая соревнуется с группами.
    const key = r.is_staff ? '#STAFF' : String(r.group_name || '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!key) continue;
    const g = gmap.get(key) || { name: r.is_staff ? 'Преподаватели' : r.group_name, staff: !!r.is_staff, players: 0, top: [] };
    g.players++; if (g.top.length < 5) g.top.push(r.total); // rows уже отсортированы по убыванию
    gmap.set(key, g);
  }
  const groups = [...gmap.values()].map(g => ({ name: g.name, staff: g.staff, players: g.players, total: g.top.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total).slice(0, 30).map((g, i) => ({ rank: i + 1, ...g }));
  return {
    now: now(),
    players: q('SELECT COUNT(*) c FROM users WHERE nick IS NOT NULL AND banned=0').get().c,
    groups,
    staff: staffRows.slice(0, 50).map((r, i) => ({ rank: i + 1, id: r.id, nick: r.nick, group: r.group_name, total: r.total, badges: bm.get(r.id) || [] })),
    rows: rows.slice(0, 200).map((r, i) => ({ rank: i + 1, id: r.id, nick: r.nick, group: r.group_name, total: r.total, locks: per[r.id] || {}, warm: warm[r.id] || 0, curious: !!secret[r.id], badges: bm.get(r.id) || [] })),
  };
});

// --- Вход ---
route('POST', /^\/api\/auth\/start$/, ctx => {
  // Лимит щедрый: в зале все сидят через один Wi-Fi и для сервера выглядят как один адрес.
  rateLimit('auth:' + ctx.ip, 600, 60000);
  q('DELETE FROM login_codes WHERE created_at<?').run(now() - LOGIN_CODE_TTL_MS);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join(''); }
  while (q('SELECT 1 FROM login_codes WHERE code=?').get(code));
  const pending = rand(16);
  q('INSERT INTO login_codes(code,pending,created_at) VALUES(?,?,?)').run(code, pending, now());
  setCookie(ctx.res, 'pending', pending, LOGIN_CODE_TTL_MS / 1000);
  return {
    code,
    tg: cfg.tgToken && cfg.tgUser ? `https://t.me/${cfg.tgUser}?start=${code}` : null,
    vk: cfg.vkToken && cfg.vkScreen ? `https://vk.me/${cfg.vkScreen}` : null,
  };
});

route('GET', /^\/api\/auth\/poll$/, ctx => {
  const row = ctx.cookies.pending && q('SELECT * FROM login_codes WHERE pending=?').get(ctx.cookies.pending);
  if (!row || row.created_at < now() - LOGIN_CODE_TTL_MS) return { status: 'expired' };
  if (!row.provider) return { status: 'waiting' };
  const u = loginAs(ctx.res, row.provider, row.provider_id, row.display_name, ctx.cookies);
  q('DELETE FROM login_codes WHERE code=?').run(row.code);
  setCookie(ctx.res, 'pending', '', 0);
  return { status: 'ok', user: publicUser(u) };
});

route('POST', /^\/api\/auth\/dev$/, async ctx => {
  if (!cfg.devLogin) fail(404, 'Не найдено');
  const { name } = await ctx.body();
  const id = normalize(name).slice(0, 30);
  if (!id) fail(400, 'Нужно имя');
  return { status: 'ok', user: publicUser(loginAs(ctx.res, 'dev', id, String(name), ctx.cookies)) };
});

route('POST', /^\/api\/auth\/logout$/, ctx => {
  if (ctx.cookies.sid) q('DELETE FROM sessions WHERE token=?').run(ctx.cookies.sid);
  setCookie(ctx.res, 'sid', '', 0);
  return { ok: true };
});

route('POST', /^\/api\/profile$/, async ctx => {
  const u = ctx.user; if (!u) fail(401, 'Сначала войди');
  const b = await ctx.body();
  const nick = String(b.nick || '').trim().replace(/\s+/g, ' ');
  const group = String(b.group || '').trim().replace(/\s+/g, ' ');
  if (nick.length < 2 || nick.length > 20) fail(400, 'Ник: от 2 до 20 символов');
  if (group.length < 1 || group.length > 20) fail(400, 'Укажи группу (до 20 символов)');
  // SQLite не умеет приводить кириллицу к нижнему регистру, поэтому ключ для сравнения считаем здесь.
  const key = nick.toLowerCase().replace(/ё/g, 'е');
  if (q('SELECT 1 FROM users WHERE nick_key=? AND id<>?').get(key, u.id)) fail(409, 'Такой ник уже занят');
  const staff = b.staff ? 1 : 0;
  q('UPDATE users SET nick=?, nick_key=?, group_name=?, is_staff=? WHERE id=?').run(nick, key, group, staff, u.id);
  return { user: publicUser({ ...u, nick, group_name: group, is_staff: staff }) };
});

// --- Игра ---
route('GET', /^\/api\/puzzle\/(\d+)$/, ctx => {
  const u = requirePlayer(ctx), p = openPuzzle(ctx.params[0]);
  const hints = parse(p.hints, []), used = hintsUsed(u.id, p.id);
  const last = q('SELECT MAX(created_at) t FROM attempts WHERE user_id=? AND puzzle_id=?').get(u.id, p.id).t || 0;
  return {
    auction_hint: (q('SELECT text FROM auctions WHERE puzzle_num=? AND winner_id=? AND settled=1').get(p.num, u.id) || {}).text || null,
    num: p.num, kind: p.kind, title: p.title, body: p.body, opens_at: p.opens_at, closes_at: p.kind === 'flash' ? flashEnd(p) : 0,
    max_points: p.max_points, min_points: p.min_points, decay_minutes: p.decay_minutes,
    solved: q('SELECT points, place, solved_at FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id) || null,
    wrong: wrongCount(u.id, p.id),
    cooldown_until: last + ATTEMPT_COOLDOWN_MS,
    hints: hints.map((h, i) => i < used ? { text: h.text, cost: h.cost, open: true } : { cost: h.cost, open: false }),
    over: contestOver(), now: now(),
  };
});

route('POST', /^\/api\/puzzle\/(\d+)\/answer$/, async ctx => {
  const u = requirePlayer(ctx), p = openPuzzle(ctx.params[0]);
  const { answer } = await ctx.body();
  if (contestOver()) fail(403, 'Игра завершена, ответы больше не принимаются');
  if (flashClosed(p)) fail(403, 'Молниеносный замок уже закрылся');
  if (q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id)) fail(409, 'Этот замок ты уже открыл');
  const raw = String(answer || '').trim().slice(0, 200), norm = normalize(raw);
  if (!norm) fail(400, 'Пустой ответ');
  const t = now();
  const last = q('SELECT MAX(created_at) t FROM attempts WHERE user_id=? AND puzzle_id=?').get(u.id, p.id).t || 0;
  if (t - last < ATTEMPT_COOLDOWN_MS) fail(429, 'Не так быстро', { cooldown_until: last + ATTEMPT_COOLDOWN_MS });
  const correct = parse(p.answers, []).some(a => normalize(a) === norm);
  if (!correct) {
    const near = Object.entries(parse(p.near, {})).find(([k]) => normalize(k) === norm);
    if (near) return { correct: false, near: near[1], wrong: wrongCount(u.id, p.id), cooldown_until: last + ATTEMPT_COOLDOWN_MS };
  }
  // Всё ниже выполняется синхронно, поэтому два игрока не могут получить одно и то же место.
  q('INSERT INTO attempts(user_id,puzzle_id,answer,correct,created_at) VALUES(?,?,?,?,?)').run(u.id, p.id, raw, correct ? 1 : 0, t);
  if (!correct) return { correct: false, wrong: wrongCount(u.id, p.id), cooldown_until: t + ATTEMPT_COOLDOWN_MS };
  // Места студентов и преподавателей считаются отдельно: преподаватель не забирает бонус у студента.
  const place = q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0 AND u.is_staff=?').get(p.id, u.is_staff).c + 1;
  const hints = parse(p.hints, []);
  const hintCost = hints.slice(0, hintsUsed(u.id, p.id)).reduce((s, h) => s + (Number(h.cost) || 0), 0);
  // Разминка стоит одинаково для всех: без скорости, бонусов и штрафов.
  const points = p.kind === 'warmup' || p.kind === 'secret' ? p.max_points
    : finalPoints({ timePts: timeValue(p, t - p.opens_at), place, wrong: wrongCount(u.id, p.id), hintCost });
  q('INSERT INTO solves(user_id,puzzle_id,solved_at,points,place) VALUES(?,?,?,?,?)').run(u.id, p.id, t, points, place);
  creditReferral(u);
  if (p.kind === 'secret') {
    keeper(`Кто-то нашёл то, что я не показывал. ${u.nick} теперь «Любопытный». Остальные даже не знают, о чём я.`);
  } else if (p.kind !== 'warmup' && u.is_staff) {
    const students = q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0 AND u.is_staff=0').get(p.id).c;
    if (place === 1) keeper(students
      ? `Преподаватели вступили в игру: ${u.nick} открыл замок №${p.num}.`
      : `Замок №${p.num} открыт. И первым был не студент, а преподаватель: ${u.nick}. Студенты, вам не стыдно?`);
  } else if (p.kind !== 'warmup') {
    if (place === 1) keeper(pickOne([
      `Замок №${p.num} вскрыт. Первым был ${u.nick} (${u.group_name}): ${mins(t - p.opens_at)}. Остальные, вы вообще стараетесь?`,
      `${u.nick} из ${u.group_name} открыл замок №${p.num} за ${mins(t - p.opens_at)}. Я думал, продержусь дольше. Бонус за второе и третье место ещё свободен.`,
    ]));
    else if (place === 3) keeper(`Замок №${p.num}: все три бонусных места заняты. Дальше только баллы за скорость, и они тают.`);
  }
  return { correct: true, points, place };
});

route('POST', /^\/api\/puzzle\/(\d+)\/hint$/, ctx => {
  const u = requirePlayer(ctx), p = openPuzzle(ctx.params[0]);
  if (ctx.user.deposit > 0) fail(403, 'Пока открыт вклад, подсказки недоступны. Закрой вклад, если подсказка нужнее.');
  if (contestOver()) fail(403, 'Игра завершена');
  if (q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id)) fail(409, 'Замок уже открыт');
  const hints = parse(p.hints, []), used = hintsUsed(u.id, p.id);
  if (used >= hints.length) fail(404, 'Подсказок больше нет');
  q('INSERT INTO hint_uses(user_id,puzzle_id,idx,created_at) VALUES(?,?,?,?)').run(u.id, p.id, used, now());
  return { idx: used, text: hints[used].text, cost: hints[used].cost };
});

// --- Скрытые страницы ---
// Слой цепочки: страница существует, но ссылки на неё нет. Адрес — ответ предыдущего шага (/v/<адрес>).
// Пока замок-родитель не открылся, страницы «нет» — как и любой несуществующей.
route('GET', /^\/api\/page\/([^/]{1,60})$/, ctx => {
  const slug = normalize(decodeURIComponent(ctx.params[0]));
  const p = q("SELECT * FROM puzzles WHERE kind='page' AND published=1 AND opens_at<=?").all(now()).find(x => normalize(x.title) === slug);
  if (!p) fail(404, 'Здесь ничего нет');
  return { body: p.body };
});

// --- Вклад ---
route('POST', /^\/api\/deposit$/, async ctx => {
  const u = requirePlayer(ctx);
  if (contestOver()) fail(403, 'Игра завершена: вклады заморожены, проценты уже в итоге');
  const { action, amount } = await ctx.body();
  if (action === 'open') {
    if (u.deposit > 0) fail(409, 'Вклад уже открыт');
    const a = Math.floor(Number(amount)), free = baseTotal(u);
    if (!(a >= DEP_MIN)) fail(400, `Минимальная сумма вклада — ${DEP_MIN} баллов`);
    if (a > free) fail(400, `У тебя только ${free} баллов`);
    q('UPDATE users SET deposit=?, dep_at=? WHERE id=?').run(a, now(), u.id);
    return { ok: true };
  }
  if (action === 'close') {
    if (!u.deposit) fail(409, 'Вклада нет');
    const gain = interestOf(u);
    q('UPDATE users SET deposit=0, dep_at=NULL, bonus=bonus+? WHERE id=?').run(gain, u.id);
    return { ok: true, interest: gain };
  }
  fail(400, 'Неизвестное действие');
});

// --- Аукцион подсказки ---
// Хранитель продаёт одну сильную подсказку. Ставки вслепую, побеждает самая высокая (при равенстве — ранняя),
// победитель платит свою ставку. Это продолжение аукциона с открытия: сколько вы готовы переплатить?
const AUC_MIN = 5;
const curAuction = () => q('SELECT * FROM auctions ORDER BY id DESC LIMIT 1').get() || null;
const freePoints = u => baseTotal(u) - (u.deposit || 0);
function auctionView(a, u) {
  if (!a) return null;
  const mine = u ? q('SELECT amount FROM bids WHERE auction_id=? AND user_id=?').get(a.id, u.id) : null;
  const winner = a.winner_id ? q('SELECT nick, group_name FROM users WHERE id=?').get(a.winner_id) : null;
  const p = q('SELECT title, hints FROM puzzles WHERE num=?').get(a.puzzle_num);
  return { id: a.id, num: a.puzzle_num, title: p ? p.title : '', starts_at: a.starts_at, ends_at: a.ends_at, settled: !!a.settled, min: AUC_MIN,
    bids: a.settled ? a.bids_count : q('SELECT COUNT(*) c FROM bids WHERE auction_id=?').get(a.id).c,
    my_bid: mine ? mine.amount : null, free: u ? freePoints(u) : 0,
    winner: winner && { nick: winner.nick, group: winner.group_name }, price: a.settled ? a.price : null,
    won: !!(u && a.winner_id === u.id), text: u && a.winner_id === u.id ? a.text : null };
}
function settleAuctions() {
  for (const a of q('SELECT * FROM auctions WHERE settled=0 AND ends_at<=?').all(now())) {
    const bids = q('SELECT b.*, u.nick, u.group_name, u.provider, u.provider_id FROM bids b JOIN users u ON u.id=b.user_id WHERE b.auction_id=? AND u.banned=0 ORDER BY b.amount DESC, b.created_at ASC').all(a.id);
    // Если у лидера баллов уже не хватает (потратил или положил на вклад), подсказка уходит следующему.
    let win = null;
    for (const b of bids) { const u = q('SELECT * FROM users WHERE id=?').get(b.user_id); if (freePoints(u) >= b.amount) { win = b; break; } }
    q('UPDATE auctions SET settled=1, winner_id=?, price=?, bids_count=? WHERE id=?').run(win ? win.user_id : null, win ? win.amount : null, bids.length, a.id);
    if (!win) { keeper(`Аукцион закрыт. Подсказку к замку №${a.puzzle_num} никто не купил. Значит, справитесь сами. Посмотрим.`); continue; }
    q('UPDATE users SET bonus=bonus-? WHERE id=?').run(win.amount, win.user_id);
    const second = bids.find(b => b.user_id !== win.user_id);
    const p = q('SELECT hints FROM puzzles WHERE num=?').get(a.puzzle_num), costs = parse(p ? p.hints : '[]', []).map(h => Number(h.cost) || 0);
    const usual = costs.length ? Math.max(...costs) : 0;
    keeper(`Аукцион закрыт. Подсказку к замку №${a.puzzle_num} забрал ${win.nick} (${win.group_name}) за ${win.amount} баллов. Ставок: ${bids.length}.`
      + (second ? (second.amount === win.amount ? ` ${second.nick} предлагал столько же, но позже.` : ` Второе место предлагало ${second.amount}.`) : '')
      + (usual && win.amount > usual ? ` Обычная подсказка к этому замку стоит ${usual}. Переплата — ${win.amount - usual}. Знакомо, правда?` : ''));
    bots.send(win, `🔨 Ты выиграл аукцион! Подсказка к замку №${a.puzzle_num}:\n\n${a.text}\n\nСписано ${win.amount} баллов.`).catch(() => {});
  }
}
route('POST', /^\/api\/auction\/bid$/, async ctx => {
  const u = requirePlayer(ctx), a = curAuction();
  if (!a || a.settled || a.ends_at <= now()) fail(409, 'Сейчас аукциона нет');
  if (contestOver()) fail(403, 'Игра завершена');
  if (u.deposit > 0) fail(403, 'Пока открыт вклад, подсказки недоступны — и на аукционе тоже');
  const p = q('SELECT id FROM puzzles WHERE num=?').get(a.puzzle_num);
  if (p && q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id)) fail(409, 'Этот замок ты уже открыл — подсказка тебе ни к чему');
  const { amount } = await ctx.body();
  const v = Math.floor(Number(amount));
  if (v === 0) { q('DELETE FROM bids WHERE auction_id=? AND user_id=?').run(a.id, u.id); return { ok: true, my_bid: null }; }
  if (!(v >= AUC_MIN)) fail(400, `Минимальная ставка — ${AUC_MIN} баллов`);
  if (v > freePoints(u)) fail(400, `У тебя только ${freePoints(u)} свободных баллов`);
  q('INSERT INTO bids(auction_id,user_id,amount,created_at) VALUES(?,?,?,?) ON CONFLICT(auction_id,user_id) DO UPDATE SET amount=excluded.amount, created_at=excluded.created_at').run(a.id, u.id, v, now());
  return { ok: true, my_bid: v };
});
route('POST', /^\/api\/admin\/auction$/, async ctx => {
  requireAdmin(ctx);
  const b = await ctx.body();
  const cur = curAuction();
  if (cur && !cur.settled) fail(409, 'Предыдущий аукцион ещё идёт');
  const num = Number(b.num), text = String(b.text || '').trim(), minutes = Math.max(10, Math.min(1440, Number(b.minutes) || 120));
  const p = q("SELECT * FROM puzzles WHERE num=? AND published=1").get(num);
  if (!p) fail(400, 'Нет такого опубликованного замка');
  if (!text) fail(400, 'Нужен текст подсказки');
  const t = now(), ends = t + minutes * 60000;
  q('INSERT INTO auctions(puzzle_num,text,starts_at,ends_at) VALUES(?,?,?,?)').run(num, text.slice(0, 2000), t, ends);
  const hhmm = new Date(ends).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  keeper(`🔨 Аукцион! Я продаю одну подсказку к замку №${num}. Ставки вслепую до ${hhmm}, получит тот, кто предложит больше всех. Сколько вы готовы заплатить за знание?\n${cfg.baseUrl}`);
  return { ok: true };
});
route('GET', /^\/api\/admin\/auction$/, ctx => {
  requireAdmin(ctx);
  const a = curAuction();
  return { auction: a, bids: a ? q('SELECT b.amount, b.created_at, u.nick, u.group_name FROM bids b JOIN users u ON u.id=b.user_id WHERE b.auction_id=? ORDER BY b.amount DESC, b.created_at').all(a.id) : [] };
});

// --- Учебный фишинг ---
// Организатор запускает учения: бот присылает каждому «щедрое предложение» с личной ссылкой.
// Кто перешёл — видит разбор, как его обманули. Кто написал боту «фишинг» и не переходил — получает значок «Бдительный» и 5 баллов.
// Никакие данные на странице не вводятся и не собираются.
const PHISH_WINDOW = 48 * 3600000;
const phishSig = id => crypto.createHmac('sha256', kvGet('secret')).update('phish:' + id).digest('hex').slice(0, 12);
const phishActive = () => { const t = Number(kvGet('phish_at') || 0); return t > 0 && now() - t < PHISH_WINDOW; };
function phishStats() {
  const at = Number(kvGet('phish_at') || 0);
  return { at, sent: Number(kvGet('phish_sent') || 0), clicked: q('SELECT COUNT(*) c FROM users WHERE phish_clicked IS NOT NULL').get().c,
    reported: q('SELECT COUNT(*) c FROM users WHERE phish_reported IS NOT NULL AND phish_clicked IS NULL').get().c };
}
bots.onText = (provider, id, text) => {
  if (!/фишинг|мошен|развод|скам|scam|phish|обман|подозрит/i.test(text) || !Number(kvGet('phish_at') || 0)) return null;
  const u = q('SELECT * FROM users WHERE provider=? AND provider_id=?').get(provider, id);
  if (!u || !u.nick) return 'Сначала войди в игру на сайте. Но за бдительность хвалю.';
  if (u.phish_clicked) return 'Поздно: по ссылке ты уже перешёл. Разбор ошибок — на той странице. В следующий раз будь внимательнее.';
  if (u.phish_reported) return 'Ты уже сообщил. Значок «Бдительный» твой.';
  if (!phishActive()) return 'Учения уже закончились, но привычка правильная.';
  q('UPDATE users SET phish_reported=?, bonus=bonus+5 WHERE id=?').run(now(), u.id);
  return '🛡 Верно, это была учебная фишинговая рассылка. Ты не перешёл по ссылке и сообщил о ней — так и нужно делать с подозрительными сообщениями, даже от знакомых. +5 баллов и значок «Бдительный».';
};
route('POST', /^\/api\/admin\/phish$/, async ctx => {
  requireAdmin(ctx);
  const { text } = await ctx.body();
  if (phishActive()) fail(409, 'Учения уже идут');
  const users = q("SELECT id, provider, provider_id FROM users WHERE banned=0 AND nick IS NOT NULL AND provider IN ('tg','vk')").all();
  kvSet('phish_at', now()); kvSet('phish_sent', users.length);
  const tpl = String(text || '').trim() || '🎁 Хранитель расщедрился: первые 30 игроков получают +50 баллов! Подтверди участие до 23:59 по ссылке: {link}';
  (async () => {
    for (const u of users) {
      const link = `${cfg.baseUrl}/bonus/${u.id}-${phishSig(u.id)}`;
      try { await bots.send(u, tpl.includes('{link}') ? tpl.replace('{link}', link) : tpl + '\n' + link); } catch { /* недоставленные пропускаем */ }
      await new Promise(r => setTimeout(r, 60));
    }
  })();
  return { ok: true, sent: users.length };
});
route('POST', /^\/api\/bonus\/(\d+)-([a-f0-9]{12})$/, ctx => {
  const id = Number(ctx.params[0]);
  if (ctx.params[1] !== phishSig(id)) return { ok: false };
  q('UPDATE users SET phish_clicked=COALESCE(phish_clicked, ?) WHERE id=?').run(now(), id);
  return { ok: true };
});

// --- Сцена: QR-ловушка «бесплатный кофе» ---
route('POST', /^\/api\/trap\/hit$/, ctx => {
  rateLimit('trap:' + ctx.ip, 3000, 60000); // весь зал приходит с одного адреса Wi-Fi
  if (!ctx.cookies.trap) {
    kvSet('trap_count', Number(kvGet('trap_count') || 0) + 1);
    setCookie(ctx.res, 'trap', '1', 60 * 60 * 24);
  }
  return { count: Number(kvGet('trap_count') || 0) };
});
route('GET', /^\/api\/trap$/, () => ({ count: Number(kvGet('trap_count') || 0) }));

// --- Сцена: история с голосованием зала ---
// Сюжет лежит в story.json. Голоса хранятся в памяти: они нужны только на время одного вопроса.
const STORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'story.json'), 'utf8'));
const storyFresh = () => ({ phase: 'idle', scene: -1, debt: 0, picks: [] });
let story = parse(kvGet('story'), null) || storyFresh();
let votes = new Map(); // id зрителя -> номер варианта в текущем вопросе
const saveStory = () => kvSet('story', JSON.stringify(story));
const isAdmin = ctx => { try { requireAdmin(ctx); return true; } catch { return false; } };
function tally() {
  const sc = STORY.scenes[story.scene];
  const c = sc ? sc.choices.map(() => 0) : [];
  for (const v of votes.values()) if (c[v] !== undefined) c[v]++;
  return c;
}
function storyStep() {
  const last = STORY.scenes.length - 1;
  if (story.phase === 'idle') { story = { ...storyFresh(), phase: 'voting', scene: 0 }; votes = new Map(); }
  else if (story.phase === 'voting') {
    const counts = tally(), sc = STORY.scenes[story.scene];
    // Побеждает вариант с большинством; при равенстве — тот, что дороже для героя.
    let pick = 0;
    sc.choices.forEach((c, i) => { if (counts[i] > counts[pick] || (counts[i] === counts[pick] && c.debt > sc.choices[pick].debt)) pick = i; });
    story.picks[story.scene] = pick; story.counts = counts; story.debt += sc.choices[pick].debt; story.phase = 'result';
  }
  else if (story.phase === 'result') {
    if (story.scene >= last) story.phase = 'final';
    else { story.scene++; story.phase = 'voting'; story.counts = null; votes = new Map(); }
  }
  saveStory();
}

route('GET', /^\/api\/story$/, ctx => {
  let vid = ctx.cookies.vid;
  if (!vid) { vid = rand(10); setCookie(ctx.res, 'vid', vid, 60 * 60 * 12); }
  const sc = STORY.scenes[story.scene] || null;
  const out = { phase: story.phase, scene: story.scene, total: STORY.scenes.length, debt: story.debt,
    name: STORY.title, hero: STORY.hero, heroGen: STORY.heroGen || STORY.hero, income: STORY.income, intro: STORY.intro, voters: votes.size };
  if (sc && story.phase !== 'final') {
    Object.assign(out, { title: sc.title, text: sc.text, choices: sc.choices.map(c => c.label), my: votes.has(vid) ? votes.get(vid) : null });
    if (story.phase === 'result') {
      const pick = story.picks[story.scene];
      Object.assign(out, { counts: story.counts || tally(), pick, outcome: sc.choices[pick].outcome, delta: sc.choices[pick].debt });
    } else if (isAdmin(ctx)) out.counts = tally(); // живые столбики видит только экран на сцене
  }
  if (story.phase === 'final') {
    out.ending = (STORY.endings.find(e => story.debt <= e.max) || {}).text || '';
    out.picks = story.picks.map((p, i) => ({ title: STORY.scenes[i].title, label: STORY.scenes[i].choices[p].label, delta: STORY.scenes[i].choices[p].debt }));
  }
  return out;
});

route('POST', /^\/api\/story\/vote$/, async ctx => {
  const { choice } = await ctx.body();
  const sc = STORY.scenes[story.scene];
  if (story.phase !== 'voting' || !sc) fail(409, 'Голосование сейчас закрыто');
  if (!ctx.cookies.vid) fail(400, 'Обнови страницу');
  if (!Number.isInteger(choice) || !sc.choices[choice]) fail(400, 'Нет такого варианта');
  votes.set(ctx.cookies.vid, choice); // передумать можно, пока вопрос открыт
  return { ok: true, my: choice };
});

route('POST', /^\/api\/story\/control$/, async ctx => {
  requireAdmin(ctx);
  const { action } = await ctx.body();
  if (action === 'next') storyStep();
  else if (action === 'reset') { story = storyFresh(); votes = new Map(); saveStory(); }
  else fail(400, 'Неизвестная команда');
  return { phase: story.phase, scene: story.scene };
});

// --- Квиз на телефонах (пятница) ---
// Вопросы — в quiz.json. Игроки входят по имени, без ВКонтакте. Состояние хранится в kv, чтобы пережить перезапуск.
const QUIZ = JSON.parse(fs.readFileSync(path.join(__dirname, 'quiz.json'), 'utf8'));
const quizFresh = () => ({ phase: 'idle', idx: -1, endsAt: 0, startedAt: 0, players: {}, answers: {} });
let quiz = parse(kvGet('quiz'), null) || quizFresh();
let quizDirty = false;
const saveQuiz = () => { quizDirty = true; };
setInterval(() => { if (quizDirty) { quizDirty = false; try { kvSet('quiz', JSON.stringify(quiz)); } catch { /* база закрыта при остановке */ } } }, 1000).unref();
const QUIZ_MS = (QUIZ.seconds || 20) * 1000;
const quizTop = n => Object.entries(quiz.players).map(([id, p]) => ({ id, name: p.name, score: p.score }))
  .sort((a, b) => b.score - a.score).slice(0, n).map((p, i) => ({ rank: i + 1, ...p }));
function quizCounts() {
  const q = QUIZ.questions[quiz.idx]; const c = q ? q.a.map(() => 0) : [];
  for (const v of Object.values(quiz.answers)) if (c[v.choice] !== undefined) c[v.choice]++;
  return c;
}

route('GET', /^\/api\/quiz$/, ctx => {
  let qid = ctx.cookies.qid;
  if (!qid) { qid = rand(10); setCookie(ctx.res, 'qid', qid, 60 * 60 * 12); }
  const me = quiz.players[qid] || null, q = QUIZ.questions[quiz.idx] || null;
  const out = { phase: quiz.phase, idx: quiz.idx, total: QUIZ.questions.length, now: now(), endsAt: quiz.endsAt,
    players: Object.keys(quiz.players).length, answered: Object.keys(quiz.answers).length, title: QUIZ.title,
    me: me && { name: me.name, score: me.score, rank: quizTop(1e6).find(p => p.id === qid)?.rank || null } };
  if (q && (quiz.phase === 'question' || quiz.phase === 'reveal')) {
    Object.assign(out, { round: q.round, q: q.q, a: q.a, my: quiz.answers[qid] || null });
    if (quiz.phase === 'reveal') Object.assign(out, { correct: q.correct, note: q.note || '', counts: quizCounts(), top: quizTop(5) });
  }
  if (quiz.phase === 'final') out.top = quizTop(10);
  return out;
});

route('POST', /^\/api\/quiz\/join$/, async ctx => {
  rateLimit('qjoin:' + ctx.ip, 600, 60000);
  const { name } = await ctx.body();
  const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (n.length < 2) fail(400, 'Имя: хотя бы 2 символа');
  if (!ctx.cookies.qid) fail(400, 'Обнови страницу');
  if (!quiz.players[ctx.cookies.qid]) quiz.players[ctx.cookies.qid] = { name: n, score: 0 };
  else quiz.players[ctx.cookies.qid].name = n;
  saveQuiz();
  return { ok: true };
});

route('POST', /^\/api\/quiz\/answer$/, async ctx => {
  const { choice } = await ctx.body();
  const qid = ctx.cookies.qid, p = qid && quiz.players[qid], q = QUIZ.questions[quiz.idx];
  if (!p) fail(400, 'Сначала введи имя');
  if (quiz.phase !== 'question' || !q) fail(409, 'Сейчас нет вопроса');
  const t = now();
  if (t > quiz.endsAt) fail(409, 'Время вышло');
  if (quiz.answers[qid]) fail(409, 'Ответ уже принят');
  if (!Number.isInteger(choice) || !q.a[choice]) fail(400, 'Нет такого варианта');
  // За верный ответ 500 баллов и ещё до 500 за скорость.
  const pts = choice === q.correct ? 500 + Math.round(500 * Math.max(0, quiz.endsAt - t) / QUIZ_MS) : 0;
  quiz.answers[qid] = { choice, pts };
  p.score += pts;
  saveQuiz();
  return { ok: true, choice };
});

route('POST', /^\/api\/quiz\/control$/, async ctx => {
  requireAdmin(ctx);
  const { action } = await ctx.body();
  if (action === 'reset') quiz = quizFresh();
  else if (action === 'next') {
    if (quiz.phase === 'question') quiz.phase = 'reveal';
    else if (quiz.phase === 'final') { /* конец */ }
    else if (quiz.idx + 1 >= QUIZ.questions.length) quiz.phase = 'final';
    else { quiz.idx++; quiz.phase = 'question'; quiz.answers = {}; quiz.startedAt = now(); quiz.endsAt = now() + QUIZ_MS; }
  } else fail(400, 'Неизвестная команда');
  saveQuiz();
  return { phase: quiz.phase, idx: quiz.idx };
});

// --- Админка ---
route('POST', /^\/api\/admin\/login$/, async ctx => {
  rateLimit('adm:' + ctx.ip, 8, 60000);
  if (!cfg.adminPassword) fail(403, 'Админка выключена: не задан ADMIN_PASSWORD');
  const { password } = await ctx.body();
  const a = Buffer.from(String(password || '')), b = Buffer.from(cfg.adminPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(401, 'Неверный пароль');
  setCookie(ctx.res, 'adm', adminToken(), 60 * 60 * 24 * 14);
  return { ok: true };
});

route('GET', /^\/api\/admin\/overview$/, ctx => {
  requireAdmin(ctx);
  return {
    now: now(), ends_at: endsAt(), base_url: cfg.baseUrl,
    bots: { tg: !!cfg.tgToken, vk: !!cfg.vkToken },
    trap_count: Number(kvGet('trap_count') || 0),
    feedback_on: kvGet('feedback_on') === '1', final_question: kvGet('final_question') || '', final_answer: kvGet('final_answer') || '',
    show_team: kvGet('show_team') || '', show_vtb: kvGet('show_vtb') || '', auction_price: kvGet('auction_price') || '', show_photos: parse(kvGet('show_photos'), {}), show_group: kvGet('show_group') || '',
    puzzles: q('SELECT * FROM puzzles ORDER BY num').all().map(p => ({
      ...p, answers: parse(p.answers, []), hints: parse(p.hints, []),
      solvers: q('SELECT COUNT(*) c FROM solves WHERE puzzle_id=?').get(p.id).c,
      tries: q('SELECT COUNT(*) c FROM attempts WHERE puzzle_id=?').get(p.id).c,
    })),
    users: withInterest(q(`SELECT u.id, u.provider, u.provider_id, u.display_name, u.nick, u.group_name, u.banned, u.created_at,
              u.is_staff, u.src, u.ref_by, u.deposit, u.dep_at, 0 last, COALESCE((SELECT SUM(points) FROM solves WHERE user_id=u.id),0) + u.bonus total
              FROM users u ORDER BY total DESC, u.id`).all()),
    phish: phishStats(),
  };
});

route('POST', /^\/api\/admin\/puzzle$/, async ctx => {
  requireAdmin(ctx);
  const b = await ctx.body(1024 * 1024);
  const num = Number(b.num), opens = Number(b.opens_at);
  if (!(num >= 1 && num <= 99)) fail(400, 'Номер замка: от 1 до 99');
  if (!String(b.title || '').trim()) fail(400, 'Нужно название');
  if (!(opens > 0)) fail(400, 'Укажи время открытия');
  const answers = (b.answers || []).map(a => String(a).trim()).filter(Boolean);
  if (b.published && !answers.length) fail(400, 'Нельзя публиковать замок без ответа');
  const hints = (b.hints || []).filter(h => h && String(h.text || '').trim()).map(h => ({ text: String(h.text).trim(), cost: Math.max(0, Number(h.cost) || 0) }));
  const kind = ['warmup', 'secret', 'flash', 'page'].includes(b.kind) ? b.kind : 'lock';
  const max = Math.max(1, Number(b.max_points) || 100), min = kind !== 'lock' && kind !== 'flash' ? max : Math.min(max, Math.max(0, Number(b.min_points) || 0));
  const vals = [String(b.title).trim(), String(b.body || ''), opens, max, min, Math.max(1, Number(b.decay_minutes) || 720),
    JSON.stringify(answers), JSON.stringify(hints), b.published ? 1 : 0];
  const old = q('SELECT * FROM puzzles WHERE num=?').get(num);
  if (old) {
    // Если время открытия перенесли в будущее, оповещения отправятся заново.
    const reset = opens > now() ? 0 : old.notified_open;
    q(`UPDATE puzzles SET title=?, body=?, opens_at=?, max_points=?, min_points=?, decay_minutes=?, answers=?, hints=?, published=?,
       notified_open=?, notified_soon=? WHERE num=?`).run(...vals, reset, opens - SOON_MS > now() ? 0 : old.notified_soon, num);
  } else {
    q(`INSERT INTO puzzles(title,body,opens_at,max_points,min_points,decay_minutes,answers,hints,published,num)
       VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...vals, num);
  }
  q('UPDATE puzzles SET kind=? WHERE num=?').run(kind, num);
  return { ok: true };
});

// Молниеносный замок запускается одной кнопкой: открывается прямо сейчас, бот сразу пишет всем.
route('POST', /^\/api\/admin\/puzzle\/(\d+)\/launch$/, ctx => {
  requireAdmin(ctx);
  const p = q('SELECT * FROM puzzles WHERE num=?').get(Number(ctx.params[0]));
  if (!p || p.kind !== 'flash') fail(404, 'Молниеносный замок не найден');
  if (!parse(p.answers, []).length) fail(400, 'У замка нет ответа');
  if (p.published && p.opens_at <= now()) fail(409, 'Этот замок уже запускали');
  q('UPDATE puzzles SET opens_at=?, published=1, notified_open=0, notified_soon=1 WHERE id=?').run(now(), p.id);
  notifyTick();
  return { ok: true, closes_at: now() + p.decay_minutes * 60000 };
});

route('POST', /^\/api\/admin\/puzzle\/(\d+)\/delete$/, ctx => {
  requireAdmin(ctx);
  const p = q('SELECT id FROM puzzles WHERE num=?').get(Number(ctx.params[0]));
  if (!p) fail(404, 'Нет такого замка');
  for (const t of ['attempts', 'solves', 'hint_uses']) q(`DELETE FROM ${t} WHERE puzzle_id=?`).run(p.id);
  q('DELETE FROM puzzles WHERE id=?').run(p.id);
  return { ok: true };
});

// Импорт готового набора загадок одним файлом: { files: { имя: base64 }, puzzles: [...] }.
// В тексте загадки {{file:имя}} заменяется на адрес загруженного файла.
route('POST', /^\/api\/admin\/import$/, async ctx => {
  requireAdmin(ctx);
  const pack = await ctx.body(60 * 1024 * 1024);
  const urls = {};
  for (const [name, data] of Object.entries(pack.files || {})) {
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'ogg', 'mp4', 'pdf'].includes(ext.toLowerCase())) fail(400, 'Недопустимый файл в наборе: ' + name);
    const fname = `${rand(10)}.${ext.toLowerCase()}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(String(data), 'base64'));
    urls[name] = '/uploads/' + fname;
  }
  let n = 0;
  for (const p of pack.puzzles || []) {
    const num = Number(p.num), opens = new Date(p.opens_at).getTime();
    if (!(num >= 1 && num <= 99) || !(opens > 0) || !p.title) fail(400, 'Ошибка в наборе: замок ' + p.num);
    const body = String(p.body || '').replace(/\{\{file:([^}]+)\}\}/g, (m, f) => urls[f] || m);
    const kind = p.kind === 'warmup' ? 'warmup' : 'lock';
    const max = Number(p.max_points) || 100, min = kind === 'warmup' ? max : Number(p.min_points) || 0;
    q('DELETE FROM puzzles WHERE num=? AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.puzzle_id=puzzles.id)').run(num);
    if (q('SELECT 1 FROM puzzles WHERE num=?').get(num)) fail(409, `Замок №${num} уже есть, и по нему были попытки. Удали его вручную, если это точно нужно.`);
    q(`INSERT INTO puzzles(num,kind,title,body,opens_at,max_points,min_points,decay_minutes,answers,hints,published) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(num, kind, String(p.title), body, opens, max, min, Number(p.decay_minutes) || 720, JSON.stringify(p.answers || []), JSON.stringify(p.hints || []), p.published ? 1 : 0);
    n++;
  }
  return { imported: n, files: Object.keys(urls).length };
});

route('GET', /^\/api\/admin\/attempts$/, ctx => {
  requireAdmin(ctx);
  return { rows: q(`SELECT a.created_at, a.answer, a.correct, p.num, u.nick, u.group_name
                    FROM attempts a JOIN users u ON u.id=a.user_id JOIN puzzles p ON p.id=a.puzzle_id
                    ORDER BY a.id DESC LIMIT 300`).all() };
});

route('POST', /^\/api\/admin\/upload$/, async ctx => {
  requireAdmin(ctx);
  const b = await ctx.body(12 * 1024 * 1024);
  const ext = (String(b.name || '').match(/\.([a-z0-9]+)$/i) || [])[1];
  const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'ogg', 'mp4', 'pdf'];
  if (!ext || !allowed.includes(ext.toLowerCase())) fail(400, 'Можно загружать: ' + allowed.join(', '));
  const buf = Buffer.from(String(b.data || ''), 'base64');
  if (!buf.length) fail(400, 'Пустой файл');
  const name = `${rand(10)}.${ext.toLowerCase()}`; // случайное имя: файл нельзя угадать до открытия замка
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: '/uploads/' + name };
});

route('POST', /^\/api\/admin\/ban$/, async ctx => {
  requireAdmin(ctx);
  const b = await ctx.body();
  q('UPDATE users SET banned=? WHERE id=?').run(b.banned ? 1 : 0, Number(b.id));
  return { ok: true };
});

route('POST', /^\/api\/admin\/settings$/, async ctx => {
  requireAdmin(ctx);
  const b = await ctx.body();
  if (b.ends_at !== undefined) kvSet('ends_at', Number(b.ends_at) || 0);
  if (b.reset_trap) kvSet('trap_count', 0);
  if (b.feedback_on !== undefined) kvSet('feedback_on', b.feedback_on ? '1' : '0');
  if (b.final_question !== undefined) kvSet('final_question', String(b.final_question));
  for (const k of ['show_team', 'show_vtb', 'auction_price']) if (b[k] !== undefined) kvSet(k, String(b[k]).slice(0, 2000));
  // Фото команды для слайда «Кто мы»: { «Имя Фамилия»: «/uploads/…» }. Принимаем только загруженные на сайт файлы.
  if (b.show_photos && typeof b.show_photos === 'object') {
    const ph = {}; for (const [k, v] of Object.entries(b.show_photos)) if (/^\/uploads\/[0-9a-f]{20}\.(png|jpe?g|webp|gif)$/.test(String(v))) ph[String(k).slice(0, 60)] = String(v);
    kvSet('show_photos', JSON.stringify(ph));
  }
  // Общее фото команды: если задано, слайд «Кто мы» показывает его вместо карточек.
  if (b.show_group !== undefined) kvSet('show_group', /^\/uploads\/[0-9a-f]{20}\.(png|jpe?g|webp)$/.test(String(b.show_group)) ? String(b.show_group) : '');
  if (b.final_answer !== undefined) kvSet('final_answer', String(b.final_answer));
  return { ok: true };
});

// Суперфинал: вопрос и код от кейса видит только экран на сцене (вход администратора).
route('GET', /^\/api\/admin\/vault$/, ctx => {
  requireAdmin(ctx);
  const locks = q("SELECT p.num, p.title, (SELECT COUNT(*) FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=p.id AND u.banned=0) solvers FROM puzzles p WHERE p.kind='lock' ORDER BY p.num").all();
  const top = withInterest(q(`SELECT u.nick, u.group_name, u.deposit, u.dep_at, COALESCE(SUM(s.points),0) + u.bonus total, COALESCE(MAX(s.solved_at), 9e15) last FROM users u LEFT JOIN solves s ON s.user_id=u.id
                 WHERE u.banned=0 AND u.is_staff=0 AND u.nick IS NOT NULL GROUP BY u.id HAVING total > 0`).all()).slice(0, 3);
  return { locks, top: top.map(t => ({ nick: t.nick, group: t.group_name, total: t.total })), players: q('SELECT COUNT(*) c FROM users WHERE nick IS NOT NULL AND banned=0').get().c };
});

route('GET', /^\/api\/admin\/final$/, ctx => {
  requireAdmin(ctx);
  const top = withInterest(q(`SELECT u.nick, u.group_name, u.deposit, u.dep_at, COALESCE(SUM(s.points),0) + u.bonus total, COALESCE(MAX(s.solved_at), 9e15) last FROM users u LEFT JOIN solves s ON s.user_id=u.id
                 WHERE u.banned=0 AND u.is_staff=0 AND u.nick IS NOT NULL GROUP BY u.id HAVING total > 0`).all()).slice(0, 3).map(({ nick, group_name, total }) => ({ nick, group_name, total }));
  return { top, question: kvGet('final_question') || '', answer: kvGet('final_answer') || '' };
});

// Данные для презентации открытия: состав команды, проверки перед стартом, время первого замка (даже если он ещё черновик).
route('GET', /^\/api\/admin\/show$/, ctx => {
  requireAdmin(ctx);
  const t = now();
  const first = q("SELECT num, opens_at, published FROM puzzles WHERE kind='lock' AND opens_at>? ORDER BY opens_at LIMIT 1").get(t)
    || q("SELECT num, opens_at, published FROM puzzles WHERE kind='lock' ORDER BY opens_at LIMIT 1").get();
  return { team: kvGet('show_team') || '', vtb: kvGet('show_vtb') || '', auction_price: kvGet('auction_price') || '', photos: parse(kvGet('show_photos'), {}), group: kvGet('show_group') || '',
    trap_count: Number(kvGet('trap_count') || 0), story_phase: story.phase, first_lock: first || null,
    base_url: cfg.baseUrl, vk: !!cfg.vkToken };
});

// --- Анкета после недели ---
const FB_LEARNED = ['yes', 'some', 'no'], FB_AGAIN = ['yes', 'maybe', 'no'];
const FB_USEFUL = ['show', 'masterclass', 'debates', 'credit', 'deal', 'quiz', 'puzzles'];
route('GET', /^\/api\/feedback$/, ctx => {
  let vid = ctx.cookies.v;
  if (!/^[a-f0-9]{20}$/.test(vid || '')) { vid = rand(10); setCookie(ctx.res, 'v', vid, 60 * 60 * 24 * 365); }
  return { done: !!q('SELECT 1 FROM feedback WHERE vid=?').get(vid) };
});
route('POST', /^\/api\/feedback$/, async ctx => {
  rateLimit('fb:' + ctx.ip, 300, 60000);
  const vid = ctx.cookies.v;
  if (!/^[a-f0-9]{20}$/.test(vid || '')) fail(400, 'Обнови страницу');
  const b = await ctx.body();
  const rating = Number(b.rating);
  if (!(rating >= 1 && rating <= 5)) fail(400, 'Поставь оценку от 1 до 5');
  const learned = FB_LEARNED.includes(b.learned) ? b.learned : null, again = FB_AGAIN.includes(b.again) ? b.again : null;
  const useful = Array.isArray(b.useful) ? b.useful.filter(x => FB_USEFUL.includes(x)) : [];
  const text = String(b.text || '').trim().slice(0, 1000);
  q(`INSERT INTO feedback(vid,user_id,rating,learned,useful,again,text,created_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(vid) DO UPDATE SET user_id=excluded.user_id, rating=excluded.rating, learned=excluded.learned, useful=excluded.useful, again=excluded.again, text=excluded.text, created_at=excluded.created_at`)
    .run(vid, ctx.user ? ctx.user.id : null, Math.round(rating), learned, JSON.stringify(useful), again, text, now());
  return { ok: true };
});
function feedbackStats() {
  const rows = q('SELECT * FROM feedback ORDER BY created_at DESC').all();
  const cnt = (key, vals) => Object.fromEntries(vals.map(v => [v, rows.filter(r => r[key] === v).length]));
  const useful = Object.fromEntries(FB_USEFUL.map(v => [v, 0]));
  for (const r of rows) for (const u of parse(r.useful, [])) if (useful[u] !== undefined) useful[u]++;
  return { count: rows.length, avg: rows.length ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : 0,
    ratings: [1, 2, 3, 4, 5].map(n => rows.filter(r => r.rating === n).length),
    learned: cnt('learned', FB_LEARNED), again: cnt('again', FB_AGAIN), useful,
    comments: rows.filter(r => r.text).slice(0, 100).map(r => ({ rating: r.rating, text: r.text, at: r.created_at })) };
}

// Отчёт для партнёра (ВТБ): все цифры недели на одной странице.
route('GET', /^\/api\/admin\/report$/, ctx => {
  requireAdmin(ctx);
  const one = (sql, ...a) => q(sql).get(...a).c;
  const players = 'nick IS NOT NULL AND banned=0';
  const days = {};
  const day = d => (days[d] = days[d] || { day: d, visitors: 0, new_visitors: 0, players: 0, attempts: 0, solves: 0, views: 0 });
  for (const r of q('SELECT day, COUNT(*) c, SUM(first) f FROM visits GROUP BY day').all()) Object.assign(day(r.day), { visitors: r.c, new_visitors: r.f });
  for (const r of q('SELECT day, SUM(n) c FROM pageviews GROUP BY day').all()) day(r.day).views = r.c;
  for (const r of q(`SELECT created_at t FROM users WHERE ${players}`).all()) day(mskDay(r.t)).players++;
  for (const r of q('SELECT created_at t FROM attempts').all()) day(mskDay(r.t)).attempts++;
  for (const r of q('SELECT solved_at t FROM solves').all()) day(mskDay(r.t)).solves++;
  const groups = new Set(q(`SELECT group_name g FROM users WHERE ${players} AND is_staff=0`).all().map(r => String(r.g || '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean));
  return {
    now: now(), base_url: cfg.baseUrl,
    totals: {
      visitors: one('SELECT COUNT(DISTINCT vid) c FROM visits'),
      views: one('SELECT COALESCE(SUM(n),0) c FROM pageviews'),
      players: one(`SELECT COUNT(*) c FROM users WHERE ${players}`),
      staff: one(`SELECT COUNT(*) c FROM users WHERE ${players} AND is_staff=1`),
      groups: groups.size,
      active: one(`SELECT COUNT(DISTINCT s.user_id) c FROM solves s JOIN users u ON u.id=s.user_id WHERE u.banned=0`),
      attempts: one('SELECT COUNT(*) c FROM attempts'),
      solves: one("SELECT COUNT(*) c FROM solves s JOIN puzzles p ON p.id=s.puzzle_id WHERE p.kind='lock'"),
      warmups: one("SELECT COUNT(*) c FROM solves s JOIN puzzles p ON p.id=s.puzzle_id WHERE p.kind='warmup'"),
      referrals: one('SELECT COUNT(*) c FROM users WHERE ref_done=1'),
      trap: Number(kvGet('trap_count') || 0),
      quiz: Object.keys(quiz.players).length,
      auctions: one('SELECT COUNT(*) c FROM auctions WHERE settled=1'), auction_bids: one('SELECT COUNT(*) c FROM bids'),
      deposits: one('SELECT COUNT(*) c FROM users WHERE deposit>0'), deposit_sum: one('SELECT COALESCE(SUM(deposit),0) c FROM users'),
      vk_bot: one(`SELECT COUNT(*) c FROM users WHERE ${players} AND provider='vk'`),
    },
    days: Object.values(days).sort((a, b) => a.day < b.day ? -1 : 1),
    sources_visitors: q('SELECT COALESCE(src,\'direct\') src, COUNT(DISTINCT vid) c FROM visits GROUP BY src ORDER BY c DESC').all(),
    sources_players: q(`SELECT COALESCE(src,'direct') src, COUNT(*) c FROM users WHERE ${players} GROUP BY src ORDER BY c DESC`).all(),
    puzzles: q("SELECT p.num, p.kind, p.title, p.opens_at, (SELECT COUNT(*) FROM solves WHERE puzzle_id=p.id) solvers, (SELECT COUNT(*) FROM attempts WHERE puzzle_id=p.id) tries, (SELECT COUNT(DISTINCT user_id) FROM attempts WHERE puzzle_id=p.id) triers FROM puzzles p WHERE p.published=1 AND p.kind NOT IN ('secret','page') ORDER BY p.opens_at").all(),
    feedback: feedbackStats(), phish: phishStats(),
    pages: q('SELECT path, SUM(n) c FROM pageviews GROUP BY path ORDER BY c DESC LIMIT 10').all(),
  };
});

route('POST', /^\/api\/admin\/broadcast$/, async ctx => {
  requireAdmin(ctx);
  const { text } = await ctx.body();
  if (!String(text || '').trim()) fail(400, 'Пустое сообщение');
  const users = q("SELECT provider, provider_id FROM users WHERE banned=0 AND provider IN ('tg','vk')").all();
  bots.broadcast(users, String(text).trim());
  return { queued: users.length };
});

// ---------- Статика ----------
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', pdf: 'application/pdf', json: 'application/json' };
const PAGES = { '/': 'index.html', '/board': 'board.html', '/admin': 'admin.html', '/coffee': 'coffee.html',
  '/stage/hack': 'stage-hack.html', '/stage/trap': 'stage-trap.html', '/stage/story': 'stage-story.html', '/vote': 'vote.html', '/stage/final': 'stage-final.html', '/show': 'show.html', '/quiz': 'quiz.html', '/stage/quiz': 'stage-quiz.html', '/keeper': 'keeper.html', '/report': 'report.html', '/feedback': 'feedback.html', '/stage/vault': 'stage-vault.html' };
const pageFor = p => PAGES[p] || (/^\/bonus\/\d+-[a-f0-9]{12}$/.test(p) ? 'bonus.html' : /^\/v\/[^/]{1,60}$/.test(p) ? 'hidden.html' : null);

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size,
    'x-content-type-options': 'nosniff', 'cache-control': root === UPLOAD_DIR ? 'public, max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = req.method === r.method && pathname.match(r.re);
        if (!m) continue;
        const cookies = parseCookies(req);
        const ctx = { req, res, cookies, params: m.slice(1), query: url.searchParams, ip: clientIp(req),
          user: currentUser(cookies), body: limit => readJson(req, limit) };
        return send(res, 200, await r.handler(ctx));
      }
      return send(res, 404, { error: 'Не найдено' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (pathname.startsWith('/uploads/')) {
      if (serveFile(res, UPLOAD_DIR, pathname.slice('/uploads/'.length))) return;
    } else {
      if (pageFor(pathname) && req.method === 'GET' && !pathname.startsWith('/stage') && pathname !== '/admin' && pathname !== '/report') trackVisit(req, res, url, pathname);
      if (serveFile(res, PUBLIC_DIR, pageFor(pathname) || pathname.slice(1))) return;
    }
    // Страница «не найдено» от Хранителя
    const nf = path.join(PUBLIC_DIR, '404.html');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(nf).on('error', () => res.end('Страница не найдена')).pipe(res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера' });
  }
});

// ---------- Оповещения по расписанию ----------
function notifyTick() {
  const t = now();
  try { settleAuctions(); } catch (e) { console.error('auction', e.message); }
  const users = () => q("SELECT provider, provider_id FROM users WHERE banned=0 AND provider IN ('tg','vk')").all();
  for (const p of q('SELECT * FROM puzzles WHERE published=1 AND notified_open=0 AND opens_at<=?').all(t)) {
    q('UPDATE puzzles SET notified_open=1, notified_soon=1 WHERE id=?').run(p.id);
    // Если сервер был выключен и замок открылся давно, запоздалое сообщение не шлём.
    if (t - p.opens_at < 30 * 60000) bots.broadcast(users(), p.kind === 'flash'
      ? `⚡ Молниеносный замок! Он исчезнет через ${p.decay_minutes} мин. Успеешь?\n${cfg.baseUrl}/#/lock/${p.num}`
      : p.kind === 'warmup'
      ? `☕ Разминка дня открыта: ${p.max_points} баллов каждому, кто ответит верно. Спешить не нужно.\n${cfg.baseUrl}/#/lock/${p.num}`
      : `🔓 Замок №${p.num} открыт! Чем быстрее решишь, тем больше баллов.\n${cfg.baseUrl}/#/lock/${p.num}`);
  }
  // Через час после открытия замка Хранитель подводит промежуточный итог.
  for (const p of q("SELECT * FROM puzzles WHERE published=1 AND kind='lock' AND opens_at<=? AND opens_at>?").all(t - 3600000, t - 2 * 3600000)) {
    if (kvGet('hour_' + p.id)) continue;
    kvSet('hour_' + p.id, 1);
    const solved = q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0').get(p.id).c;
    const all = q('SELECT COUNT(*) c FROM users WHERE nick IS NOT NULL AND banned=0').get().c;
    keeper(solved ? `Прошёл час. Замок №${p.num} открыли ${solved} из ${all}. Он всё ещё стоит баллов, но с каждой минутой меньше.`
                  : `Прошёл час. Замок №${p.num} не открыл никто из ${all}. Я начинаю думать, что переоценил вас.`);
  }
  for (const p of q("SELECT * FROM puzzles WHERE published=1 AND kind='lock' AND notified_soon=0 AND opens_at>? AND opens_at<=?").all(t, t + SOON_MS)) {
    q('UPDATE puzzles SET notified_soon=1 WHERE id=?').run(p.id);
    bots.broadcast(users(), `⏳ Замок №${p.num} откроется через ${Math.max(1, Math.round((p.opens_at - t) / 60000))} мин. Будь готов: ${cfg.baseUrl}`);
  }
}

if (require.main === module) {
  server.listen(cfg.port, () => {
    console.log(`«Хранилище» запущено: ${cfg.baseUrl} (порт ${cfg.port})`);
    console.log(`Telegram-бот: ${cfg.tgToken ? 'включён' : 'выключен'}, VK-бот: ${cfg.vkToken ? 'включён' : 'выключен'}, админка: ${cfg.adminPassword ? 'включена' : 'ВЫКЛЮЧЕНА (нет ADMIN_PASSWORD)'}`);
    if (cfg.devLogin) console.log('ВНИМАНИЕ: включён тестовый вход DEV_LOGIN=1. На боевом сервере его нужно выключить.');
  });
  bots.start();
  setInterval(notifyTick, 15000);
}

module.exports = { server, db, cfg, bots, notifyTick };
