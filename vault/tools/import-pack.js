'use strict';
// Загрузка набора загадок прямо в базу, без админки.
//   node --no-warnings tools/import-pack.js путь/к/набору.json
// Формат тот же, что у кнопки «Импортировать набор»: { files: { имя: base64 }, puzzles: [...] }.
// Замки, по которым уже были попытки игроков, не перезаписываются.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../lib/db');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const file = process.argv[2];
if (!file) { console.error('Укажи файл набора: node tools/import-pack.js набор.json'); process.exit(1); }

const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = openDb(dataDir);
const uploads = path.join(dataDir, 'uploads');
const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'ogg', 'mp4', 'pdf'];

const urls = {};
for (const [name, data] of Object.entries(pack.files || {})) {
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  if (!allowed.includes(ext)) { console.error('Пропущен файл недопустимого типа: ' + name); continue; }
  const fname = `${crypto.randomBytes(10).toString('hex')}.${ext}`; // случайное имя: файл нельзя угадать заранее
  fs.writeFileSync(path.join(uploads, fname), Buffer.from(String(data), 'base64'));
  urls[name] = '/uploads/' + fname;
}

let done = 0, skipped = 0;
for (const p of pack.puzzles || []) {
  const num = Number(p.num), opens = new Date(p.opens_at).getTime();
  if (!(num >= 1 && num <= 99) || !(opens > 0) || !p.title) { console.error('Ошибка в наборе, пропущен замок ' + p.num); continue; }
  const old = db.prepare('SELECT id FROM puzzles WHERE num=?').get(num);
  if (old && db.prepare('SELECT 1 FROM attempts WHERE puzzle_id=?').get(old.id)) {
    console.log(`№${num}: по нему уже отвечали игроки, оставлен как есть`); skipped++; continue;
  }
  if (old) db.prepare('DELETE FROM puzzles WHERE id=?').run(old.id);
  const kind = ['warmup', 'flash', 'page', 'secret'].includes(p.kind) ? p.kind : 'lock';
  const max = Number(p.max_points) || 100, min = kind === 'warmup' || kind === 'secret' ? max : Number(p.min_points) || 0;
  const body = String(p.body || '').replace(/\{\{file:([^}]+)\}\}/g, (m, f) => urls[f] || m);
  db.prepare(`INSERT INTO puzzles(num,kind,title,body,opens_at,max_points,min_points,decay_minutes,answers,hints,published,near)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(num, kind, String(p.title), body, opens, max, min, Number(p.decay_minutes) || 720,
      JSON.stringify(p.answers || []), JSON.stringify(p.hints || []), p.published ? 1 : 0, JSON.stringify(p.near || {}));
  if (p.max_solvers) db.prepare('UPDATE puzzles SET max_solvers=? WHERE num=?').run(Number(p.max_solvers), num);
  if (kind === 'secret') db.prepare('UPDATE puzzles SET notified_open=1, notified_soon=1 WHERE num=?').run(num);
  const when = new Date(opens).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  console.log(`№${num} ${kind === 'warmup' ? 'разминка' : kind === 'flash' ? 'молния  ' : kind === 'page' ? 'страница' : kind === 'secret' ? 'пасхалка' : 'замок   '} «${p.title}» — ${when} МСК${p.published ? '' : ' (черновик)'}`);
  done++;
}
db.close();
console.log(`Готово: загружено ${done}, пропущено ${skipped}, файлов ${Object.keys(urls).length}.`);
