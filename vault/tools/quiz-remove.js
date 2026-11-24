'use strict';
// Убрать игрока из квиза по части имени: node --no-warnings tools/quiz-remove.js "Ваня"
// Запускать при ОСТАНОВЛЕННОМ сайте (systemctl stop vault), иначе сайт перезапишет квиз из памяти.
const fs = require('node:fs'), path = require('node:path');
const { openDb } = require('../lib/db');
const root = path.join(__dirname, '..'), envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]; }
const db = openDb(process.env.DATA_DIR || path.join(root, 'data'));
const part = String(process.argv[2] || '').toLowerCase();
const row = db.prepare("SELECT value FROM kv WHERE key='quiz'").get();
if (!row) { console.log('Квиз ещё не запускался'); process.exit(0); }
const quiz = JSON.parse(row.value);
const list = () => Object.values(quiz.players).sort((a, b) => b.score - a.score).map((p, i) => `${i + 1}. ${p.name} — ${p.score}`).join('\n');
if (!part) { console.log('Игроки квиза:\n' + list() + '\n\nУкажи часть имени: node --no-warnings tools/quiz-remove.js "Ваня"'); process.exit(0); }
const ids = Object.keys(quiz.players).filter(id => quiz.players[id].name.toLowerCase().includes(part));
if (!ids.length) { console.log('Никого не нашёл. Игроки:\n' + list()); process.exit(1); }
for (const id of ids) { console.log('Убираю: ' + quiz.players[id].name); delete quiz.players[id]; delete quiz.answers[id]; }
db.prepare("UPDATE kv SET value=? WHERE key='quiz'").run(JSON.stringify(quiz));
console.log('\nНовый рейтинг:\n' + list());
