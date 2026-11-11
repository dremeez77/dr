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
function loginAs(res, provider, providerId, name) {
  let u = q('SELECT * FROM users WHERE provider=? AND provider_id=?').get(provider, providerId);
  if (!u) {
    q('INSERT INTO users(provider,provider_id,display_name,created_at) VALUES(?,?,?,?)').run(provider, providerId, name || '', now());
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
const hintsUsed = (uid, pid) => q('SELECT COUNT(*) c FROM hint_uses WHERE user_id=? AND puzzle_id=?').get(uid, pid).c;
const wrongCount = (uid, pid) => q('SELECT COUNT(*) c FROM attempts WHERE user_id=? AND puzzle_id=? AND correct=0').get(uid, pid).c;
const contestOver = () => { const e = endsAt(); return e > 0 && now() >= e; };

// ---------- Маршруты ----------
const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

route('GET', /^\/api\/state$/, ctx => {
  const t = now(), u = ctx.user;
  const puzzles = q('SELECT * FROM puzzles WHERE published=1 ORDER BY num').all().map(p => {
    const open = p.opens_at <= t;
    const mine = u ? q('SELECT points, place FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id) : null;
    return {
      num: p.num, kind: p.kind, opens_at: p.opens_at, open,
      title: open ? p.title : null,
      max_points: p.max_points, min_points: p.min_points, decay_minutes: p.decay_minutes,
      solvers: open ? q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0').get(p.id).c : 0,
      solved: mine || null,
    };
  });
  const total = u ? q('SELECT COALESCE(SUM(points),0) t FROM solves WHERE user_id=?').get(u.id).t : 0;
  return { now: t, ends_at: endsAt(), user: publicUser(u), total, puzzles,
    login: { tg: !!(cfg.tgToken && cfg.tgUser), vk: !!(cfg.vkToken && cfg.vkScreen), dev: cfg.devLogin } };
});

route('GET', /^\/api\/leaderboard$/, () => {
  const all = q(`SELECT u.id, u.nick, u.group_name, u.is_staff, SUM(s.points) total, MAX(s.solved_at) last
                  FROM solves s JOIN users u ON u.id=s.user_id WHERE u.banned=0
                  GROUP BY u.id ORDER BY total DESC, last ASC`).all();
  const rows = all.filter(r => !r.is_staff), staffRows = all.filter(r => r.is_staff);
  const per = {}, warm = {};
  for (const r of q('SELECT s.user_id, p.num, p.kind, s.points, s.place FROM solves s JOIN puzzles p ON p.id=s.puzzle_id').all()) {
    if (r.kind === 'warmup') warm[r.user_id] = (warm[r.user_id] || 0) + r.points;
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
    staff: staffRows.slice(0, 50).map((r, i) => ({ rank: i + 1, id: r.id, nick: r.nick, group: r.group_name, total: r.total })),
    rows: rows.slice(0, 200).map((r, i) => ({ rank: i + 1, id: r.id, nick: r.nick, group: r.group_name, total: r.total, locks: per[r.id] || {}, warm: warm[r.id] || 0 })),
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
  const u = loginAs(ctx.res, row.provider, row.provider_id, row.display_name);
  q('DELETE FROM login_codes WHERE code=?').run(row.code);
  setCookie(ctx.res, 'pending', '', 0);
  return { status: 'ok', user: publicUser(u) };
});

route('POST', /^\/api\/auth\/dev$/, async ctx => {
  if (!cfg.devLogin) fail(404, 'Не найдено');
  const { name } = await ctx.body();
  const id = normalize(name).slice(0, 30);
  if (!id) fail(400, 'Нужно имя');
  return { status: 'ok', user: publicUser(loginAs(ctx.res, 'dev', id, String(name))) };
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
    num: p.num, kind: p.kind, title: p.title, body: p.body, opens_at: p.opens_at,
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
  if (q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id)) fail(409, 'Этот замок ты уже открыл');
  const raw = String(answer || '').trim().slice(0, 200), norm = normalize(raw);
  if (!norm) fail(400, 'Пустой ответ');
  const t = now();
  const last = q('SELECT MAX(created_at) t FROM attempts WHERE user_id=? AND puzzle_id=?').get(u.id, p.id).t || 0;
  if (t - last < ATTEMPT_COOLDOWN_MS) fail(429, 'Не так быстро', { cooldown_until: last + ATTEMPT_COOLDOWN_MS });
  const correct = parse(p.answers, []).some(a => normalize(a) === norm);
  // Всё ниже выполняется синхронно, поэтому два игрока не могут получить одно и то же место.
  q('INSERT INTO attempts(user_id,puzzle_id,answer,correct,created_at) VALUES(?,?,?,?,?)').run(u.id, p.id, raw, correct ? 1 : 0, t);
  if (!correct) return { correct: false, wrong: wrongCount(u.id, p.id), cooldown_until: t + ATTEMPT_COOLDOWN_MS };
  // Места студентов и преподавателей считаются отдельно: преподаватель не забирает бонус у студента.
  const place = q('SELECT COUNT(*) c FROM solves s JOIN users u ON u.id=s.user_id WHERE s.puzzle_id=? AND u.banned=0 AND u.is_staff=?').get(p.id, u.is_staff).c + 1;
  const hints = parse(p.hints, []);
  const hintCost = hints.slice(0, hintsUsed(u.id, p.id)).reduce((s, h) => s + (Number(h.cost) || 0), 0);
  // Разминка стоит одинаково для всех: без скорости, бонусов и штрафов.
  const points = p.kind === 'warmup' ? p.max_points
    : finalPoints({ timePts: timeValue(p, t - p.opens_at), place, wrong: wrongCount(u.id, p.id), hintCost });
  q('INSERT INTO solves(user_id,puzzle_id,solved_at,points,place) VALUES(?,?,?,?,?)').run(u.id, p.id, t, points, place);
  if (p.kind !== 'warmup' && u.is_staff) {
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
  if (contestOver()) fail(403, 'Игра завершена');
  if (q('SELECT 1 FROM solves WHERE user_id=? AND puzzle_id=?').get(u.id, p.id)) fail(409, 'Замок уже открыт');
  const hints = parse(p.hints, []), used = hintsUsed(u.id, p.id);
  if (used >= hints.length) fail(404, 'Подсказок больше нет');
  q('INSERT INTO hint_uses(user_id,puzzle_id,idx,created_at) VALUES(?,?,?,?)').run(u.id, p.id, used, now());
  return { idx: used, text: hints[used].text, cost: hints[used].cost };
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
    final_question: kvGet('final_question') || '', final_answer: kvGet('final_answer') || '',
    puzzles: q('SELECT * FROM puzzles ORDER BY num').all().map(p => ({
      ...p, answers: parse(p.answers, []), hints: parse(p.hints, []),
      solvers: q('SELECT COUNT(*) c FROM solves WHERE puzzle_id=?').get(p.id).c,
      tries: q('SELECT COUNT(*) c FROM attempts WHERE puzzle_id=?').get(p.id).c,
    })),
    users: q(`SELECT u.id, u.provider, u.provider_id, u.display_name, u.nick, u.group_name, u.banned, u.created_at,
              u.is_staff, COALESCE((SELECT SUM(points) FROM solves WHERE user_id=u.id),0) total
              FROM users u ORDER BY total DESC, u.id`).all(),
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
  const kind = b.kind === 'warmup' ? 'warmup' : 'lock';
  const max = Math.max(1, Number(b.max_points) || 100), min = kind === 'warmup' ? max : Math.min(max, Math.max(0, Number(b.min_points) || 0));
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

route('POST', /^\/api\/admin\/puzzle\/(\d+)\/delete$/, ctx => {
  requireAdmin(ctx);
  const p = q('SELECT id FROM puzzles WHERE num=?').get(Number(ctx.params[0]));
  if (!p) fail(404, 'Нет такого замка');
  for (const t of ['attempts', 'solves', 'hint_uses']) q(`DELETE FROM ${t} WHERE puzzle_id=?`).run(p.id);
  q('DELETE FROM puzzles WHERE id=?').run(p.id);
  return { ok: true };
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
  if (b.final_question !== undefined) kvSet('final_question', String(b.final_question));
  if (b.final_answer !== undefined) kvSet('final_answer', String(b.final_answer));
  return { ok: true };
});

// Суперфинал: вопрос и код от кейса видит только экран на сцене (вход администратора).
route('GET', /^\/api\/admin\/final$/, ctx => {
  requireAdmin(ctx);
  const top = q(`SELECT u.nick, u.group_name, SUM(s.points) total, MAX(s.solved_at) last FROM solves s JOIN users u ON u.id=s.user_id
                 WHERE u.banned=0 AND u.is_staff=0 GROUP BY u.id ORDER BY total DESC, last ASC LIMIT 3`).all();
  return { top, question: kvGet('final_question') || '', answer: kvGet('final_answer') || '' };
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
  '/stage/hack': 'stage-hack.html', '/stage/trap': 'stage-trap.html', '/stage/story': 'stage-story.html', '/vote': 'vote.html', '/stage/final': 'stage-final.html' };

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
    } else if (serveFile(res, PUBLIC_DIR, PAGES[pathname] || pathname.slice(1))) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Страница не найдена');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера' });
  }
});

// ---------- Оповещения по расписанию ----------
function notifyTick() {
  const t = now();
  const users = () => q("SELECT provider, provider_id FROM users WHERE banned=0 AND provider IN ('tg','vk')").all();
  for (const p of q('SELECT * FROM puzzles WHERE published=1 AND notified_open=0 AND opens_at<=?').all(t)) {
    q('UPDATE puzzles SET notified_open=1, notified_soon=1 WHERE id=?').run(p.id);
    // Если сервер был выключен и замок открылся давно, запоздалое сообщение не шлём.
    if (t - p.opens_at < 30 * 60000) bots.broadcast(users(), p.kind === 'warmup'
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
