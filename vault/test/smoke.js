'use strict';
// Проверка основных сценариев: node --no-warnings test/smoke.js
// Поднимает сервер на временной базе и проходит путь игрока и администратора.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
Object.assign(process.env, { DATA_DIR: dir, DEV_LOGIN: '1', ADMIN_PASSWORD: 'secret-pass', PORT: '0', BASE_URL: 'http://test' });
const { server, db, bots } = require('../server');
const { normalize, timeValue, finalPoints } = require('../lib/scoring');

function client(base) {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    return { status: r.status, body: await r.json() };
  };
}

(async () => {
  // --- правила подсчёта ---
  assert.equal(normalize('  Ёлка-2024! '), 'елка2024');
  const pz = { max_points: 100, min_points: 30, decay_minutes: 60 };
  assert.equal(timeValue(pz, 0), 100);
  assert.equal(timeValue(pz, 30 * 60000), 65);
  assert.equal(timeValue(pz, 999 * 60000), 30);
  assert.equal(finalPoints({ timePts: 100, place: 1, wrong: 0, hintCost: 0 }), 130);
  assert.equal(finalPoints({ timePts: 30, place: 9, wrong: 50, hintCost: 30 }), 10);

  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = client(base), a = client(base), b = client(base), anon = client(base);

  // --- админка закрыта без пароля ---
  assert.equal((await anon('/api/admin/overview')).status, 401);
  assert.equal((await admin('/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await admin('/api/admin/login', { password: 'secret-pass' })).status, 200);

  const t = Date.now();
  const mk = (num, opens, extra = {}) => admin('/api/admin/puzzle', { num, title: 'Тайна ' + num, body: '<p>Секретный текст ' + num + '</p>', opens_at: opens,
    max_points: 100, min_points: 30, decay_minutes: 60, answers: ['Тюльпан', '1637'], hints: [{ text: 'Голландия', cost: 15 }], published: true, ...extra });
  assert.equal((await mk(1, t - 60000)).status, 200);
  assert.equal((await mk(2, t + 3600000)).status, 200);
  assert.equal((await mk(3, t - 60000, { published: false })).status, 200);
  assert.equal((await mk(4, t - 60000, { answers: [] })).status, 400, 'замок без ответа публиковать нельзя');

  // --- до входа и до открытия ничего не утекает ---
  let st = (await anon('/api/state')).body;
  assert.deepEqual(st.puzzles.map(p => p.num), [1, 2], 'черновик не виден');
  assert.equal(st.puzzles[1].title, null, 'название закрытого замка скрыто');
  assert.ok(!JSON.stringify(st).includes('Секретный'), 'текст не утекает в состояние');
  assert.ok(!JSON.stringify(st).includes('Тюльпан'), 'ответ не утекает');
  assert.equal((await anon('/api/puzzle/1')).status, 401);

  // --- вход и профиль ---
  await a('/api/auth/dev', { name: 'alice' });
  assert.equal((await a('/api/puzzle/1')).status, 403, 'без профиля нельзя');
  assert.equal((await a('/api/profile', { nick: 'Алиса', group: 'Ф-21' })).status, 200);
  await b('/api/auth/dev', { name: 'bob' });
  assert.equal((await b('/api/profile', { nick: 'алиса', group: 'Ф-22' })).status, 409, 'ник уникален без учёта регистра');
  await b('/api/profile', { nick: 'Боб', group: 'Ф-22' });

  assert.equal((await a('/api/puzzle/2')).status, 404, 'закрытый замок не отдаётся');
  assert.equal((await a('/api/puzzle/3')).status, 404, 'черновик не отдаётся');
  const p1 = (await a('/api/puzzle/1')).body;
  assert.ok(p1.body.includes('Секретный текст 1'));
  assert.ok(!JSON.stringify(p1).includes('Голландия'), 'подсказка скрыта, пока не куплена');
  assert.ok(!JSON.stringify(p1).includes('Тюльпан'));

  // --- ответы ---
  assert.equal((await a('/api/puzzle/2/answer', { answer: 'тюльпан' })).status, 404);
  let r = await a('/api/puzzle/1/answer', { answer: 'роза' });
  assert.equal(r.body.correct, false);
  r = await a('/api/puzzle/1/answer', { answer: 'тюльпан' });
  assert.equal(r.status, 429, 'пауза между попытками');
  db.prepare('UPDATE attempts SET created_at = created_at - 30000').run(); // перематываем паузу
  r = await a('/api/puzzle/1/hint', {});
  assert.equal(r.body.text, 'Голландия');
  assert.equal((await a('/api/puzzle/1/hint', {})).status, 404, 'подсказки кончились');
  r = await a('/api/puzzle/1/answer', { answer: '  ТЮЛЬПАН!!! ' });
  assert.equal(r.body.correct, true);
  assert.equal(r.body.place, 1);
  // ~1 минута из 60: цена ≈ 99; +30 за первое место, −2 за ошибку, −15 за подсказку
  assert.ok(r.body.points >= 110 && r.body.points <= 112, 'баллы Алисы: ' + r.body.points);
  assert.equal((await a('/api/puzzle/1/answer', { answer: 'тюльпан' })).status, 409, 'повторно решить нельзя');

  r = await b('/api/puzzle/1/answer', { answer: '1637' });
  assert.equal(r.body.place, 2);
  assert.ok(r.body.points >= 118 && r.body.points <= 119, 'баллы Боба: ' + r.body.points);

  // --- таблица ---
  let lb = (await anon('/api/leaderboard')).body;
  assert.deepEqual(lb.rows.map(x => x.nick), ['Боб', 'Алиса']);
  const bobId = lb.rows[0].id;
  await admin('/api/admin/ban', { id: bobId, banned: true });
  lb = (await anon('/api/leaderboard')).body;
  assert.deepEqual(lb.rows.map(x => x.nick), ['Алиса'], 'заблокированный пропадает из таблицы');
  assert.equal((await b('/api/puzzle/1')).status, 403);

  // --- вход по коду через бота (сам мессенджер здесь заменён прямым вызовом) ---
  const v = client(base);
  const start = (await v('/api/auth/start', {})).body;
  assert.match(start.code, /^[A-Z0-9]{6}$/);
  assert.equal((await v('/api/auth/poll')).body.status, 'waiting');
  assert.match(bots.replyFor('привет', 'vk', '777', 'Вера'), /пришли мне код/);
  assert.match(bots.replyFor('ZZZZZZ', 'vk', '777', 'Вера'), /не найден/);
  assert.match(bots.replyFor(' ' + start.code.toLowerCase() + ' ', 'vk', '777', 'Вера'), /Готово/);
  assert.match(bots.replyFor(start.code, 'tg', '999', 'Чужой'), /не найден/, 'код одноразовый');
  const polled = (await v('/api/auth/poll')).body;
  assert.equal(polled.status, 'ok');
  assert.equal(polled.user.provider, 'vk');
  assert.equal((await v('/api/state')).body.user.needs_profile, true);

  // --- конец игры ---
  await admin('/api/admin/puzzle', { num: 3, title: 'Тайна 3', body: 'x', opens_at: t - 1000, answers: ['да'], hints: [], published: true });
  await admin('/api/admin/settings', { ends_at: Date.now() - 1 });
  assert.equal((await a('/api/puzzle/3/answer', { answer: 'да' })).status, 403, 'после конца игры ответы не принимаются');

  // --- ловушка считает человека один раз ---
  const c = client(base);
  assert.equal((await c('/api/trap/hit', {})).body.count, 1);
  assert.equal((await c('/api/trap/hit', {})).body.count, 1);
  assert.equal((await anon('/api/trap/hit', {})).body.count, 2);

  // --- загрузка файлов ---
  assert.equal((await anon('/api/admin/upload', { name: 'x.png', data: 'AAAA' })).status, 401);
  assert.equal((await admin('/api/admin/upload', { name: 'x.exe', data: 'AAAA' })).status, 400);
  const up = await admin('/api/admin/upload', { name: 'x.png', data: 'AAAA' });
  assert.ok(/^\/uploads\/[0-9a-f]{20}\.png$/.test(up.body.url));
  assert.equal((await fetch(base + up.body.url)).status, 200);
  assert.equal((await fetch(base + '/uploads/..%2Fvault.db')).status, 404, 'базу нельзя скачать');
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 404);

  server.close(); db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Все проверки пройдены');
})().catch(e => { console.error(e); process.exit(1); });
