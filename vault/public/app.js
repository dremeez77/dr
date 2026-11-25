'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;        // состояние с сервера
let offset = 0;      // разница между часами сервера и телефона
let P = null;        // открытая загадка
let board = null;
let pollTimer = null;

const serverNow = () => Date.now() + offset;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Ошибка сети'); Object.assign(e, j, { status: r.status }); throw e; }
  return j;
}

function fmtLeft(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  const p = n => String(n).padStart(2, '0');
  const hms = `${p(Math.floor(s % 86400 / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`;
  return d > 0 ? `${d} д ${hms}` : hms;
}
const fmtWhen = ts => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function valueNow(p) {
  const f = Math.min(1, Math.max(0, (serverNow() - p.opens_at) / (p.decay_minutes * 60000)));
  return Math.round(p.max_points - (p.max_points - p.min_points) * f);
}
const ICON_C = '<svg class="li" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>', ICON_O = '<svg class="li" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg>';
let firstPaint = true; // плавное появление — только при первой отрисовке, а не при каждом обновлении
function parts(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 86400), Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60]; }
const p2 = n => String(n).padStart(2, '0');
// Короткий таймер для карточек: «1д 00:45» или «00:45:12», всегда в одну строку.
function fmtShort(ms) { const [d, h, m, s] = parts(ms); return d ? `${d}д ${p2(h)}:${p2(m)}` : `${p2(h)}:${p2(m)}:${p2(s)}`; }
const tilesHtml = ts => `<div class="tiles" data-tiles="${ts}">${['дней', 'часов', 'минут', 'секунд'].map(l => `<div class="tile"><b>00</b><span>${l}</span></div>`).join('')}</div>`;
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11) ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? b : c;
const over = () => S && S.ends_at > 0 && serverNow() >= S.ends_at;

// ---------- Загрузка ----------
// Хранитель «врывается» на экран, когда в игре что-то происходит: открылся замок, его вскрыли, начался аукцион.
function keeperEvents(prev, cur) {
  if (!prev || !cur) return;
  const msgs = [];
  for (const p of cur.puzzles) {
    const o = prev.puzzles.find(x => x.num === p.num);
    const name = p.kind === 'flash' ? `Молниеносный замок` : p.kind === 'warmup' ? null : `Замок №${p.num}`;
    if (!name) continue;
    if (!o) { if (p.open) msgs.push(`${name} открыт. Двадцать минут. Время пошло. — Х.`); continue; }
    if (!o.open && p.open) msgs.push(`${name} открыт. Я жду. — Х.`);
    else if (o.open && !o.solvers && p.solvers > 0 && !p.solved) msgs.push(`${name} вскрыт. Кто-то оказался быстрее тебя. — Х.`);
  }
  if (cur.auction && !cur.auction.settled && (!prev.auction || prev.auction.id !== cur.auction.id)) msgs.push('Аукцион открыт. Сколько стоит знание? — Х.');
  msgs.slice(0, 2).forEach((m, i) => setTimeout(() => keeperToast(m, true), i * 3400));
}

async function refresh() {
  try {
    const prevS = S;
    S = await api('/api/state');
    keeperEvents(prevS, S);
    offset = S.now - Date.now();
    board = await api('/api/leaderboard');
  } catch (e) { /* сеть моргнула — попробуем в следующий раз */ }
  renderHeader();
  if (currentRoute().name === 'home') renderHome();
}

function currentRoute() {
  const m = location.hash.match(/^#\/lock\/(\d+)/);
  return m ? { name: 'lock', num: Number(m[1]) } : { name: 'home' };
}

async function go() {
  const r = currentRoute();
  P = null;
  if (r.name === 'lock') await renderLock(r.num); else renderHome();
  window.scrollTo(0, 0);
}

// ---------- Шапка ----------
function renderHeader() {
  const el = $('#me');
  if (!S) return;
  if (S.user && S.user.nick) {
    el.innerHTML = `<span class="pill gold"><span data-count="me" data-v="${S.total}">${S.total}</span> ${plural(S.total, 'балл', 'балла', 'баллов')}</span><b>${esc(S.user.nick)}</b><button class="ghost small" id="logout">Выйти</button>`;
    $('#logout').onclick = async () => { await api('/api/auth/logout', {}); await refresh(); go(); };
    FX.count(el);
  } else {
    el.innerHTML = `<button class="small" id="login">Войти</button>`;
    $('#login').onclick = openLogin;
  }
}

// ---------- Главная ----------
const BADGES = {
  first: ['🥇', 'Первооткрыватель', 'Первым открыл замок'],
  fast: ['⚡', 'Молния', 'Открыл замок за 30 минут после старта'],
  clean: ['🧠', 'Своим умом', 'Два замка без подсказок'],
  all: ['🔓', 'Взломщик', 'Открыл все замки'],
  warm: ['☕', 'Разогретый', 'Решил три разминки'],
  friends: ['🤝', 'Душа компании', 'Привёл трёх друзей'],
  vigilant: ['🛡', 'Бдительный', 'Не дал себя обмануть'],
  curious: ['🗝', 'Любопытный', 'Нашёл то, что не показывали'],
};
const badgeIcons = list => (list || []).filter(b => BADGES[b]).map(b => `<span title="${BADGES[b][1]}: ${BADGES[b][2]}">${BADGES[b][0]}</span>`).join('');

function myPlace() {
  if (!board || !S || !S.user) return null;
  const r = board.rows.find(x => x.id === S.user.id) || (board.staff || []).find(x => x.id === S.user.id);
  return r ? { rank: r.rank, staff: !board.rows.includes(r), of: board.rows.includes(r) ? board.players : (board.staff || []).length } : null;
}

function meHtml() {
  if (!S || !S.user || !S.user.nick) return '';
  const mine = S.badges || [];
  return `<h2>Твои значки</h2><div class="badges">${Object.entries(BADGES).map(([k, [ic, name, how]]) => {
    const on = mine.includes(k), secret = k === 'curious' && !on;
    return `<div class="badge ${on ? 'on' : ''}"><span class="bi">${secret ? '❔' : ic}</span><b>${secret ? 'Секретный' : name}</b><span>${secret ? 'Как получить — секрет' : how}</span></div>`;
  }).join('')}</div>
  <p style="margin-top:14px"><button id="cardBtn" class="ghost">📸 Карточка для сторис</button></p>`;
}

// Четыре засова вокруг сферы: серый — замок закрыт, синий — идёт взлом, зелёный — кто-то уже взломал.
const LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path class="sh" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
function vaultLocks() { return S ? S.puzzles.filter(p => p.kind === 'lock').slice(0, 4) : []; }
function vaultOpen() { const l = vaultLocks(); return l.length === 4 && l.every(p => p.open && p.solvers > 0); }
let seenCracked = (() => { try { return JSON.parse(localStorage.getItem('cracked') || '[]'); } catch { return []; } })();
function boltsHtml() {
  const locks = vaultLocks(); if (!locks.length) return '';
  const fresh = [];
  const html = locks.map((p, i) => {
    const cracked = p.open && p.solvers > 0, st = cracked ? 'cracked' : p.open ? 'hacking' : 'shut';
    if (cracked && !seenCracked.includes(p.num)) fresh.push(p.num);
    return `<span class="bolt ${st}${fresh.includes(p.num) ? ' just' : ''}" style="--a:${i * 90 - 135}deg" title="Замок №${p.num}: ${cracked ? 'взломан' : p.open ? 'идёт взлом' : 'закрыт'}">${LOCK_SVG}<i>${p.num}</i></span>`;
  }).join('');
  if (fresh.length) { seenCracked = seenCracked.concat(fresh); try { localStorage.setItem('cracked', JSON.stringify(seenCracked)); } catch { /* без памяти анимация повторится */ } }
  return html;
}

function auctionHtml() {
  const a = S && S.auction; if (!a) return '';
  const left = a.ends_at - serverNow();
  if (a.settled || left <= 0) {
    if (!a.settled) return `<h2>🔨 Аукцион подсказки</h2><div class="rules"><div class="rule" style="grid-column:1/-1"><b>Торги закрыты</b><span>Хранитель подводит итог…</span></div></div>`;
    return `<h2>🔨 Аукцион подсказки</h2><div class="rules"><div class="rule" style="grid-column:1/-1">
      <b>${a.winner ? `Подсказку к замку №${a.num} забрал ${esc(a.winner.nick)} за ${a.price} баллов` : `Подсказку к замку №${a.num} никто не купил`}</b>
      <span>Ставок: ${a.bids}.${a.won ? ' Это ты!' : ''}</span>${a.won ? `<div class="hint open" style="margin-top:10px">${esc(a.text)}</div>` : ''}</div></div>`;
  }
  const solved = S.puzzles.find(p => p.num === a.num && p.solved);
  return `<h2>🔨 Аукцион подсказки</h2><div class="rules"><div class="rule" style="grid-column:1/-1;border-color:var(--gold)">
    <b>Хранитель продаёт подсказку к замку №${a.num}${a.title ? ` «${esc(a.title)}»` : ''}</b>
    <span>Ставки вслепую: никто не видит чужих сумм. Подсказку получит тот, кто предложит больше всех, и заплатит свою ставку. Остальные ничего не теряют. Сколько стоит знание?</span>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin:12px 0 4px" class="mono"><span>⏳ <span data-cds="${a.ends_at}">${fmtShort(left)}</span></span><span>ставок: ${a.bids}</span>${a.my_bid ? `<span class="gold">твоя ставка: ${a.my_bid}</span>` : ''}</div>
    ${!S.user || !S.user.nick ? '<span class="muted">Войди в игру, чтобы сделать ставку.</span>'
      : solved ? '<span class="muted">Этот замок ты уже открыл.</span>'
      : S.deposit && S.deposit.amount ? '<span class="muted">Пока открыт вклад, подсказки недоступны — и на аукционе тоже.</span>'
      : `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px"><input id="bidAmt" type="number" min="${a.min}" max="${a.free}" value="${a.my_bid || a.min}" style="width:120px">
        <button id="bidGo">${a.my_bid ? 'Изменить ставку' : 'Сделать ставку'}</button>${a.my_bid ? '<button id="bidDel" class="ghost">Отозвать</button>' : ''}<span class="muted" style="font-size:14px">свободно ${a.free} · минимум ${a.min}</span></div>`}
  </div></div>`;
}

// Операция «Осколки»
function shardsHtml() {
  const g = S && S.shards; if (!g || g.state === 'scheduled') return '';
  const bar = `<div class="sh-bar">${Array.from({ length: g.n }, (_, i) => `<i class="${i < g.best ? 'on' : ''}"></i>`).join('')}</div>`;
  if (g.state === 'solved') return `<section class="shards solved"><div class="sh-k">ОПЕРАЦИЯ «ОСКОЛКИ» · КЛЮЧ СОБРАН</div>
    <div class="sh-phrase">«${esc(g.phrase)}»</div><p>Последний осколок вставил <b>${esc(g.solved_by)}</b>. Хранитель сдался. Каждый, кто держал осколок, получил +10 баллов. В пятницу на сцене вы узнаете, кто он.</p></section>`;
  if (g.state === 'failed') return `<section class="shards failed"><div class="sh-k">ОПЕРАЦИЯ «ОСКОЛКИ» · ПРОВАЛ</div><p>Лучшая попытка — ${g.best} из ${g.n}. Ключ уничтожен. Хранитель остался неразоблачённым.</p></section>`;
  const me = g.my;
  return `<section class="shards"><div class="sh-k"><i class="pulse-dot red"></i>ТРЕВОГА · ОПЕРАЦИЯ «ОСКОЛКИ»</div>
    <h2 class="sh-h">Хранитель уничтожит код от кейса через <span data-cds="${g.ends_at}">${fmtShort(g.ends_at - serverNow())}</span></h2>
    <p class="sh-p">Ключ разбит на ${g.n} осколков. У каждого игрока — свой. Соберите фразу целиком, и Хранитель сдастся. Одному это не под силу: ищите остальных в комментариях ВК и в чатах групп.</p>
    ${me ? `<div class="sh-mine"><span>ТВОЙ ОСКОЛОК</span><b>№${me.pos} из ${g.n}</b><div class="sh-word">${esc(me.word)}</div>
      <button class="ghost small" id="shCopy">Скопировать для комментария</button></div>`
    : `<div class="sh-mine"><span>ТВОЙ ОСКОЛОК</span><div class="sh-word" style="font-size:20px">Войди в игру, чтобы получить осколок</div>${S.user ? '' : '<button class="small" id="shLogin">Войти</button>'}</div>`}
    <div class="sh-prog"><span>Лучшая попытка: <b>${g.best} из ${g.n}</b> слов на своих местах · попыток: ${g.tries}</span>${bar}</div>
    ${me ? `<form id="shForm" class="answer"><input id="shIn" autocomplete="off" placeholder="Вся фраза по порядку"><button>Собрать</button></form><div class="msg" id="shMsg">${g.my_best ? `Твой лучший результат: ${g.my_best} из ${g.n}` : ''}</div>` : ''}
  </section>`;
}

function flashHtml(list) {
  if (!list.length) return '';
  return `<h2>⚡ Молниеносный замок</h2><div class="locks">${list.map(p => p.solved
    ? `<a class="lock solved" href="#/lock/${p.num}"><span class="n">МОЛНИЕНОСНЫЙ · ОТКРЫТ ТОБОЙ</span><span class="t">${esc(p.title)}</span><span class="big">+${p.solved.points}</span><span class="sub">решили: ${p.solvers}</span></a>`
    : `<a class="lock open flash" href="#/lock/${p.num}"><span class="n">МОЛНИЕНОСНЫЙ · ИСЧЕЗНЕТ ЧЕРЕЗ</span><span class="t">${esc(p.title)}</span><span class="big" data-cds="${p.closes_at}">${fmtShort(p.closes_at - serverNow())}</span><span class="sub">сейчас стоит ${valueNow(p)} баллов · решили: ${p.solvers}</span></a>`).join('')}</div>`;
}

function depositHtml() {
  const d = S && S.deposit; if (!d || over() && !d.amount) return '';
  const pct = Math.round(d.rate * 100);
  if (d.amount) {
    const days = Math.floor((serverNow() - d.since) / 86400000);
    return `<h2>Твой вклад</h2><div class="rules"><div class="rule" style="grid-column:1/-1;border-color:var(--green)">
      <b>${d.amount} баллов под ${pct}% в сутки</b>
      <span>Прошло полных суток: ${days}. Проценты уже: <b class="green">+${d.interest}</b>. ${over() ? 'Игра завершена — проценты в итоге.' : `Следующие +${Math.floor(d.amount * d.rate)} через <span data-cds="${d.next_at}">${fmtShort(d.next_at - serverNow())}</span>.`}</span>
      <span class="muted" style="font-size:14px;margin-top:6px">Пока вклад открыт, платные подсказки недоступны. Проценты уже учтены в таблице лидеров.</span>
      ${over() ? '' : '<p style="margin:12px 0 0"><button id="depClose" class="ghost">Закрыть вклад</button></p>'}</div></div>`;
  }
  const can = d.free >= d.min;
  return `<h2>Вклад</h2><div class="rules"><div class="rule" style="grid-column:1/-1">
    <b>Баллы тоже могут работать: +${pct}% за каждые сутки</b>
    <span>Положи часть баллов на вклад. За каждые полные сутки начисляется ${pct}% от суммы, до конца игры. Но пока вклад открыт, платные подсказки недоступны. Копить или тратить — решать тебе.</span>
    ${can ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px"><input id="depAmt" type="number" min="${d.min}" max="${d.free}" value="${d.free}" style="width:130px">
      <button id="depOpen">Открыть вклад</button><span class="muted" style="font-size:14px">доступно ${d.free} · минимум ${d.min}</span></div>`
    : `<span class="muted" style="font-size:14px;margin-top:8px">Нужно хотя бы ${d.min} баллов. Реши разминку или замок.</span>`}</div></div>`;
}

function feedbackHtml() {
  if (!S || !S.feedback_on) return '';
  return `<a href="/feedback" style="display:block;margin:22px 0 0;padding:18px;border:1px solid var(--gold);border-radius:16px;background:var(--panel);text-decoration:none;color:var(--text)">
    <span class="muted" style="font:600 12px var(--mono);letter-spacing:.14em">АНКЕТА · 1 МИНУТА</span><b style="display:block;font-size:20px;margin:6px 0 4px">Как тебе неделя? →</b>
    <span class="muted" style="font-size:14px">Оцени мероприятия — это поможет сделать следующую неделю лучше</span></a>`;
}

async function makeCard() {
  const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), F = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', M = 'ui-monospace, Menlo, Consolas, monospace';
  const g = c.createRadialGradient(W * .5, H * .32, 50, W * .5, H * .4, 1200); g.addColorStop(0, '#13277a'); g.addColorStop(1, '#040b2c');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const rr = (x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
  c.strokeStyle = 'rgba(25,181,254,.25)'; c.lineWidth = 3; rr(40, 40, W - 80, H - 80, 36); c.stroke();
  c.textAlign = 'center'; c.fillStyle = '#93a5cf'; c.font = `700 34px ${M}`; c.fillText('Х Р А Н И Л И Щ Е', W / 2, 170);
  c.font = `500 30px ${F}`; c.fillText('Неделя финансовой грамотности СПбГАУ', W / 2, 225);
  const cx = W / 2, cy = 470; c.strokeStyle = '#19b5fe'; c.lineWidth = 10; c.beginPath(); c.arc(cx, cy, 150, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(25,181,254,.3)'; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy, 190, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#19b5fe'; c.beginPath(); c.arc(cx, cy - 30, 42, 0, Math.PI * 2); c.fill(); c.beginPath(); c.moveTo(cx, cy - 10); c.lineTo(cx - 34, cy + 85); c.lineTo(cx + 34, cy + 85); c.closePath(); c.fill();
  const pl = myPlace(), total = S.total, nick = S.user.nick, grp = S.user.group || '';
  c.fillStyle = '#e9edf1'; let nf = 92; c.font = `800 ${nf}px ${F}`; while (c.measureText(nick).width > W - 160 && nf > 40) { nf -= 4; c.font = `800 ${nf}px ${F}`; }
  c.fillText(nick, W / 2, 790); c.fillStyle = '#93a5cf'; c.font = `500 40px ${F}`; c.fillText(grp, W / 2, 850);
  const box = (x, y, w, h, big, small, col) => { c.fillStyle = 'rgba(10,21,67,.9)'; c.strokeStyle = '#1d2f73'; c.lineWidth = 3; rr(x, y, w, h, 30); c.fill(); c.stroke();
    c.fillStyle = col; c.font = `800 120px ${M}`; c.fillText(big, x + w / 2, y + 160); c.fillStyle = '#93a5cf'; c.font = `500 34px ${F}`; c.fillText(small, x + w / 2, y + 220); };
  box(100, 920, 420, 270, pl ? '#' + pl.rank : '—', pl ? `место из ${pl.of}` : 'место', '#19b5fe');
  box(560, 920, 420, 270, String(total), 'баллов', '#3ddc84');
  const locks = S.puzzles.filter(p => p.kind === 'lock'), opened = locks.filter(p => p.solved).length;
  c.fillStyle = '#e9edf1'; c.font = `700 48px ${F}`; c.fillText(`Замков открыто: ${opened} из ${locks.length}`, W / 2, 1300);
  const mine = (S.badges || []).filter(b => BADGES[b]);
  if (mine.length) {
    c.font = `90px ${F}`; c.fillText(mine.map(b => BADGES[b][0]).join('  '), W / 2, 1460);
    c.fillStyle = '#93a5cf'; c.font = `500 32px ${F}`; c.fillText(mine.map(b => BADGES[b][1]).join(' · '), W / 2, 1520, W - 140);
  } else { c.fillStyle = '#93a5cf'; c.font = `500 38px ${F}`; c.fillText('Значки ещё впереди', W / 2, 1450); }
  c.fillStyle = '#19b5fe'; c.font = `700 52px ${M}`; c.fillText(location.host || 'hranilischespbgau.ru', W / 2, 1700);
  c.fillStyle = '#93a5cf'; c.font = `600 28px ${M}`; c.fillText('ПРИ ПОДДЕРЖКЕ БАНКА ВТБ', W / 2, 1770);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png')), url = URL.createObjectURL(blob);
  const file = new File([blob], 'hranilische.png', { type: 'image/png' });
  modal(`<h3>Твоя карточка</h3><img src="${url}" alt="Карточка игрока" style="width:100%;border-radius:14px;border:1px solid var(--line)">
    <p style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 0">${navigator.canShare && navigator.canShare({ files: [file] }) ? '<button id="cShare">Поделиться</button>' : ''}<a class="btn" href="${url}" download="hranilische.png" style="display:inline-block;padding:12px 16px;background:var(--gold);color:#111;border-radius:10px;text-decoration:none;font-weight:600">Скачать</a></p>
    <p class="muted" style="font-size:14px">Выложи в сторис и добавь стикер «Ссылка» на сайт: друзья смогут вступить в игру.</p>`);
  const sb = $('#cShare'); if (sb) sb.onclick = () => navigator.share({ files: [file], title: 'Хранилище' }).catch(() => {});
}

async function showQr() {
  const url = S.invite.url, qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  // Картинка для сохранения: QR на белом фоне с подписью, чтобы её можно было переслать или распечатать.
  const n = qr.getModuleCount(), cell = Math.floor(760 / (n + 8)), size = cell * (n + 8), W = 1080, H = 1350;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
  c.fillStyle = '#040b2c'; c.fillRect(0, 0, W, H);
  c.textAlign = 'center'; c.fillStyle = '#93a5cf'; c.font = '700 34px ui-monospace, Menlo, monospace'; c.fillText('Х Р А Н И Л И Щ Е', W / 2, 110);
  c.fillStyle = '#e9edf1'; c.font = '800 54px system-ui, -apple-system, Roboto, Arial, sans-serif'; c.fillText(`${S.user.nick} зовёт тебя в игру`, W / 2, 190, W - 100);
  const x0 = Math.round((W - size) / 2), y0 = 250; c.fillStyle = '#fff'; c.fillRect(x0, y0, size, size); c.fillStyle = '#040b2c';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) c.fillRect(x0 + (k + 4) * cell, y0 + (r + 4) * cell, cell, cell);
  c.fillStyle = '#3ddc84'; c.font = '700 44px system-ui, -apple-system, Roboto, Arial, sans-serif'; c.fillText(`+${S.invite.per} баллов вам обоим`, W / 2, y0 + size + 80);
  c.fillStyle = '#93a5cf'; c.font = '500 30px system-ui, -apple-system, Roboto, Arial, sans-serif'; c.fillText('Загадки с призом от банка ВТБ · выключи VPN, если не открывается', W / 2, y0 + size + 135, W - 80);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png')), img = URL.createObjectURL(blob);
  const file = new File([blob], 'hranilische-qr.png', { type: 'image/png' });
  modal(`<h3>Твой QR-код</h3><p class="muted" style="margin:0 0 12px">Дай другу отсканировать камерой телефона или отправь картинку.</p>
    <div style="background:#fff;padding:14px;border-radius:14px">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
    <p style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 0">${navigator.canShare && navigator.canShare({ files: [file] }) ? '<button id="qShare">Поделиться</button>' : ''}<a class="btn" href="${img}" download="hranilische-qr.png" style="display:inline-block;padding:12px 16px;background:var(--gold);color:#111;border-radius:10px;text-decoration:none;font-weight:600">Скачать картинку</a></p>`);
  const sb = $('#qShare'); if (sb) sb.onclick = () => navigator.share({ files: [file], title: 'Хранилище' }).catch(() => {});
}

function inviteHtml() {
  const i = S.invite; if (!i) return '';
  const left = Math.max(0, i.max - i.friends);
  return `<h2>Позови друга</h2><div class="rules"><div class="rule" style="grid-column:1/-1">
    <b>+${i.per} баллов тебе и другу</b><span>Отправь свою ссылку. Когда друг войдёт в игру и решит хотя бы разминку, вы оба получите по ${i.per} баллов (тебе — за ${i.max} друзей максимум).</span>
    <input readonly value="${esc(i.url)}" onclick="this.select()" style="margin:12px 0 10px;font-family:var(--mono)">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button id="invCopy">Поделиться ссылкой</button><button id="invQr" class="ghost">Мой QR</button>
    <span class="muted" style="font-size:14px">Пришли по твоей ссылке: ${i.friends}${i.pending ? ` · ещё ${i.pending} не решили ни одной загадки` : ''}${left ? '' : ' · лимит бонусов набран'}</span></div></div></div>`;
}

function renderHome() {
  if (!S) return;
  const flash = S.puzzles.filter(p => p.kind === 'flash'), ps = S.puzzles.filter(p => p.kind !== 'warmup' && p.kind !== 'flash'), warm = S.puzzles.filter(p => p.kind === 'warmup' && p.open);
  const next = ps.find(p => !p.open && p.opens_at > serverNow());
  let nextHtml;
  if (over()) nextHtml = `<div class="next"><span class="lbl">Игра завершена</span><span class="cd">Итоги ниже</span></div>`;
  else if (next) nextHtml = `<div class="next"><span class="lbl"><i class="pulse-dot"></i>Замок №${next.num} откроется через</span>${tilesHtml(next.opens_at)}<span class="muted" style="font-size:13px">${esc(fmtWhen(next.opens_at))}</span></div>`;
  else if (ps.length) nextHtml = `<div class="next"><span class="lbl">Все замки открыты</span><span class="cd">Успей решить</span></div>`;
  else nextHtml = `<div class="next"><span class="lbl">Скоро</span><span class="cd">Ждите сигнала</span></div>`;

  const locks = ps.map(p => {
    if (!p.open && p.draft && p.opens_at <= serverNow()) return `<div class="lock closed">${ICON_C}<span class="n">ЗАМОК №${p.num}</span><span class="t">Хранитель готовит замок</span>
      <span class="big">скоро</span><span class="sub">бот напишет, когда откроется</span></div>`;
    if (!p.open) return `<div class="lock closed">${ICON_C}<span class="n">ЗАМОК №${p.num}</span><span class="t">Закрыт</span>
      <span class="big" data-cds="${p.opens_at}">${fmtShort(p.opens_at - serverNow())}</span><span class="sub">${esc(fmtWhen(p.opens_at))}</span></div>`;
    if (p.solved) return `<a class="lock solved" href="#/lock/${p.num}">${ICON_O}<span class="n">ЗАМОК №${p.num} · ОТКРЫТ ТОБОЙ</span><span class="t">${esc(p.title)}</span>
      <span class="big">+${p.solved.points}</span><span class="sub">Ты решил ${p.solved.place}-м · всего решили: ${p.solvers}</span></a>`;
    return `<a class="lock open" href="#/lock/${p.num}">${ICON_C}<span class="n">ЗАМОК №${p.num} · ИДЁТ ВЗЛОМ</span><span class="t">${esc(p.title)}</span>
      <span class="big"><span data-val="${p.num}">${valueNow(p)}</span></span><span class="sub">баллов сейчас · решили: ${p.solvers}</span></a>`;
  }).join('');

  const cta = S.user && S.user.nick ? '' : `<p style="margin-top:22px"><button id="cta">Вступить в игру</button></p>`;

  const before = FX.capture($('#view'));
  document.body.classList.toggle('alarm', !!(S.shards && S.shards.state === 'active'));
  $('#view').innerHTML = `${shardsHtml()}
    <section class="hero">
      <div class="orb-wrap${vaultOpen() ? ' vopen' : ''}" aria-hidden="true"><div class="orb"></div><div class="orbit"></div><div class="orbit o2"></div>${boltsHtml()}
        <svg class="keyhole" viewBox="0 0 54 80"><circle cx="27" cy="22" r="16"/><path d="M27 30 L14 74 L40 74 Z"/></svg></div>
      <h1>Четыре замка.<br><span class="grad">Один приз.</span></h1>
      <p>Приз от банка ВТБ заперт в хранилище. Каждый день открывается новая загадка. Кто решает раньше, получает больше баллов. Нейросеть не поможет: думать придётся самому.</p>
      ${nextHtml}${cta}
      <p style="margin-top:18px;font-size:13px;letter-spacing:.08em">ПРИ ПОДДЕРЖКЕ БАНКА ВТБ</p>
    </section>
    ${feedbackHtml()}${flashHtml(flash)}${auctionHtml()}${depositHtml()}${meHtml()}${inviteHtml()}
    <h2>Как это устроено</h2>
    <div class="steps">
      <div class="step"><span class="sn">01</span><b>Войди через ВКонтакте</b><span>Вступи в сообщество и пришли боту код. Это 30 секунд.</span></div>
      <div class="step"><span class="sn">02</span><b>Жди сигнала</b><span>Бот напишет, когда откроется новый замок. Каждый день в своё время.</span></div>
      <div class="step"><span class="sn">03</span><b>Решай быстрее всех</b><span>Чем раньше ответ, тем больше баллов. Нейросеть не поможет.</span></div>
    </div>
    <h2>Замки</h2>
    <div class="locks">${locks || '<p class="muted">Замки появятся здесь после открытия недели.</p>'}</div>
    ${warm.length ? `<h2>Разминка дня</h2><div class="locks">${warm.map(p => p.solved
      ? `<a class="lock solved" href="#/lock/${p.num}"><span class="n">РАЗМИНКА · РЕШЕНО</span><span class="t">${esc(p.title)}</span><span class="big">+${p.solved.points}</span><span class="sub">ответили верно: ${p.solvers}</span></a>`
      : `<a class="lock open" href="#/lock/${p.num}"><span class="n">РАЗМИНКА · БЕЗ СПЕШКИ</span><span class="t">${esc(p.title)}</span><span class="big">${p.max_points}</span><span class="sub">баллов каждому · ответили: ${p.solvers}</span></a>`).join('')}</div>` : ''}
    <h2>Лидеры${board ? ` · участников: ${board.players}` : ''}</h2>
    ${boardHtml(15)}
    ${groupsHtml()}
    <h2>Правила</h2>
    <div class="rules">
      <div class="rule"><b>Скорость решает</b><span>Каждый замок сначала стоит максимум баллов, и цена падает с каждой минутой. Счётчик видно на карточке.</span></div>
      <div class="rule"><b>Бонус первым</b><span>Первый решивший получает +30 баллов, второй +20, третий +10.</span></div>
      <div class="rule"><b>Ошибки стоят баллов</b><span>За каждый неверный ответ −2 балла (не больше −20). Между попытками пауза 20 секунд.</span></div>
      <div class="rule"><b>Подсказки платные</b><span>Подсказку можно открыть в любой момент, но её цена вычтется из баллов за этот замок.</span></div>
      <div class="rule"><b>Разминка для всех</b><span>Каждый день есть простой вопрос на 10 баллов. Скорость не важна: баллы получает каждый, кто ответил верно.</span></div>
      <div class="rule"><b>Группа против группы</b><span>Баллы пяти лучших игроков группы идут в командный зачёт. Преподаватели играют одной командой.</span></div>
      <div class="rule"><b>Играем по одному</b><span>Один человек — один аккаунт. Приз вручается лично, поэтому передавать ответы нет смысла.</span></div>
      <div class="rule"><b>Смотри вокруг</b><span>Не все ключи лежат в интернете. Некоторые прозвучали на открытии и на мероприятиях недели.</span></div>
    </div>`;
  const c = $('#cta'); if (c) c.onclick = openLogin;
  const dOpen = $('#depOpen'); if (dOpen) dOpen.onclick = async () => {
    const a = Number($('#depAmt').value);
    if (!confirm(`Положить ${a} баллов на вклад? Пока вклад открыт, подсказки недоступны.`)) return;
    try { await api('/api/deposit', { action: 'open', amount: a }); await refresh(); go(); } catch (e) { alert(e.message); }
  };
  const dClose = $('#depClose'); if (dClose) dClose.onclick = async () => {
    const d = S.deposit;
    if (!confirm(d.interest ? `Закрыть вклад? Проценты (+${d.interest}) станут обычными баллами, а подсказки снова откроются.` : 'Закрыть вклад? Полных суток ещё не прошло, проценты будут 0.')) return;
    try { await api('/api/deposit', { action: 'close' }); await refresh(); go(); } catch (e) { alert(e.message); }
  };
  const bg = $('#bidGo'); if (bg) bg.onclick = async () => {
    try { await api('/api/auction/bid', { amount: Number($('#bidAmt').value) }); await refresh(); go(); keeperToast('Ставка принята. Я никому не скажу. — Х.'); } catch (e) { alert(e.message); } };
  const bd = $('#bidDel'); if (bd) bd.onclick = async () => { try { await api('/api/auction/bid', { amount: 0 }); await refresh(); go(); } catch (e) { alert(e.message); } };
  const shf = $('#shForm'); if (shf) shf.onsubmit = async e => {
    e.preventDefault(); const v = $('#shIn').value.trim(); if (!v) return;
    try { const r = await api('/api/shards/try', { phrase: v });
      if (r.solved) { FX.burst(20); keeperToast('Ключ собран. Я сдаюсь. — Х.', true); await refresh(); return; }
      $('#shMsg').innerHTML = `<span class="${r.hit >= r.n - 2 ? 'gold' : 'muted'}">На своих местах: <b>${r.hit} из ${r.n}</b>.</span> <span class="muted">Ищите недостающие осколки.</span>`;
    } catch (err) { $('#shMsg').innerHTML = `<span class="red">${esc(err.message)}</span>`; }
  };
  const shc = $('#shCopy'); if (shc) shc.onclick = async () => {
    const t = `🧩 Осколок №${S.shards.my.pos} из ${S.shards.n}: «${S.shards.my.word}» #ХранилищеОсколки`;
    try { await navigator.clipboard.writeText(t); shc.textContent = 'Скопировано ✓'; } catch { prompt('Скопируй', t); }
  };
  const shl = $('#shLogin'); if (shl) shl.onclick = openLogin;
  const cb = $('#cardBtn'); if (cb) cb.onclick = () => makeCard().catch(e => alert('Не получилось: ' + e.message));
  const qb = $('#invQr'); if (qb) qb.onclick = () => showQr().catch(e => alert('Не получилось: ' + e.message));
  const ib = $('#invCopy'); if (ib) ib.onclick = async () => {
    const url = S.invite.url, text = `Я играю в «Хранилище» — загадки с призом от ВТБ. Заходи по моей ссылке, получим оба +${S.invite.per} баллов: ${url}`;
    try { if (navigator.share) await navigator.share({ title: 'Хранилище', text, url }); else { await navigator.clipboard.writeText(text); ib.textContent = 'Скопировано ✓'; } }
    catch { prompt('Скопируй ссылку', url); }
  };
  $('#view').classList.toggle('appear', firstPaint);
  if (firstPaint) FX.reveal($('#view')); else FX.play($('#view'), before);
  firstPaint = false;
  tick();
}

function boardHtml(limit) {
  if (!board || !board.rows.length) return '<p class="muted">Пока никто не открыл ни одного замка. Стань первым.</p>';
  const nums = S ? S.puzzles.filter(p => p.kind !== 'warmup').map(p => p.num) : [];
  const hasWarm = S && S.puzzles.some(p => p.kind === 'warmup');
  const myId = S && S.user ? S.user.id : -1;
  let rows = board.rows.slice(0, limit);
  const mine = board.rows.find(r => r.id === myId);
  if (mine && !rows.includes(mine)) rows = rows.concat(mine);
  return `<div class="tbl-scroll"><table class="tbl"><thead><tr><th>#</th><th>Игрок</th>${nums.map(n => `<th class="r">№${n}</th>`).join('')}${hasWarm ? '<th class="r" title="Разминки">Р</th>' : ''}<th class="r">Итого</th></tr></thead><tbody>${
    rows.map(r => `<tr data-k="p${r.id}" data-rank="${r.rank}" class="${r.id === myId ? 'me-row' : ''}"><td class="rank ${r.rank === 1 ? 'rank-1' : ''}">${r.rank}</td>
      <td class="nick">${esc(r.nick)} ${badgeIcons(r.badges)} <span class="grp">${esc(r.group)}</span></td>
      ${nums.map(n => `<td class="r">${r.locks[n] ? r.locks[n].points : '<span class="muted">·</span>'}</td>`).join('')}${hasWarm ? `<td class="r">${r.warm || '<span class="muted">·</span>'}</td>` : ''}
      <td class="r ${r.rank === 1 ? 'rank-1' : ''}"><b data-count="p${r.id}" data-v="${r.total}">${r.total}</b></td></tr>`).join('')
  }</tbody></table></div>`;
}

function groupsHtml() {
  if (!board || !board.groups || !board.groups.length) return '';
  const mine = S && S.user ? (S.user.staff ? 'Преподаватели' : S.user.group) : null;
  const g = `<h2>Зачёт групп</h2><div class="tbl-scroll"><table class="tbl"><thead><tr><th>#</th><th>Команда</th><th class="r">Игроков</th><th class="r">Баллы топ-5</th></tr></thead><tbody>${
    board.groups.slice(0, 10).map(x => `<tr class="${x.name === mine ? 'me-row' : ''}"><td class="rank ${x.rank === 1 ? 'rank-1' : ''}">${x.rank}</td><td>${esc(x.name)}${x.staff ? ' <span class="pill" style="font-size:11px;padding:4px 8px">команда преподавателей</span>' : ''}</td><td class="r">${x.players}</td><td class="r"><b>${x.total}</b></td></tr>`).join('')
  }</tbody></table></div>`;
  const st = board.staff && board.staff.length ? `<h2>Преподаватели</h2><div class="tbl-scroll"><table class="tbl"><thead><tr><th>#</th><th>Игрок</th><th class="r">Итого</th></tr></thead><tbody>${
    board.staff.slice(0, 10).map(r => `<tr><td class="rank">${r.rank}</td><td class="nick">${esc(r.nick)} <span class="grp">${esc(r.group)}</span></td><td class="r"><b>${r.total}</b></td></tr>`).join('')
  }</tbody></table></div>` : '';
  return g + st;
}

// ---------- Загадка ----------
async function renderLock(num) {
  const v = $('#view');
  if (!S) await refresh();
  if (!S.user || !S.user.nick) {
    v.innerHTML = `<a class="back" href="#/">← Ко всем замкам</a><div class="puzzle"><h1>Замок №${num}</h1><p class="muted">Чтобы увидеть загадку, нужно войти в игру.</p><p><button id="cta">Войти</button></p></div>`;
    $('#cta').onclick = openLogin; return;
  }
  try { P = await api('/api/puzzle/' + num); }
  catch (e) { v.innerHTML = `<a class="back" href="#/">← Ко всем замкам</a><div class="puzzle"><h1>Замок №${num}</h1><p class="muted">${esc(e.message)}</p></div>`; return; }
  offset = P.now - Date.now();

  v.innerHTML = `
    <a class="back" href="#/">← Ко всем замкам</a>
    <div class="puzzle">
      <span class="mono muted" style="font-size:12px;letter-spacing:.18em">${P.kind === 'warmup' ? 'РАЗМИНКА ДНЯ' : P.kind === 'flash' ? '⚡ МОЛНИЕНОСНЫЙ ЗАМОК' : P.kind === 'secret' ? '🗝 ТАЙНАЯ ДВЕРЬ' : 'ЗАМОК №' + P.num}</span>
      <h1>${esc(P.title)}</h1>
      <div class="meta" id="meta"></div>
      <div class="body" id="body"></div>
      <div id="answerBox"></div>
      <div class="hints" id="hints"></div>
    </div>`;
  $('#body').innerHTML = P.body; // текст загадки пишет организатор в админке
  renderAnswer(); renderHints(); tick();
}

function renderAnswer() {
  const box = $('#answerBox');
  if (P.solved) {
    box.innerHTML = `<div class="solved-box"><b class="green">Замок открыт. +${P.solved.points} ${plural(P.solved.points, 'балл', 'балла', 'баллов')}</b><br>
      <span class="muted">${P.kind === 'warmup' ? 'Разминка засчитана.' : P.kind === 'secret' ? 'Ты успел. Никому не рассказывай, где эта дверь.' : `Ты решил ${P.solved.place}-м. Ответ никому не рассказывай: приз один.`}</span></div>`;
    return;
  }
  if (P.over) { box.innerHTML = `<div class="msg muted">Игра завершена, ответы больше не принимаются.</div>`; return; }
  box.innerHTML = `<form class="answer" id="form"><input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Твой ответ" maxlength="200" aria-label="Ответ"><button id="send">Проверить</button></form><div class="msg" id="msg" role="status"></div>`;
  $('#form').onsubmit = async e => {
    e.preventDefault();
    const val = $('#ans').value.trim(); if (!val) return;
    $('#send').disabled = true;
    try {
      const r = await api(`/api/puzzle/${P.num}/answer`, { answer: val });
      if (r.correct) {
        FX.burst(r.points);
        P.solved = { points: r.points, place: r.place };
        renderAnswer(); renderHints(); refresh();
      } else if (r.near) {
        $('#msg').innerHTML = `<span class="gold">🗝 ${esc(r.near)}</span>`;
      } else {
        P.wrong = r.wrong; P.cooldown_until = r.cooldown_until;
        $('#msg').innerHTML = `<span class="red">Неверно.</span> <span class="muted">Ошибок: ${r.wrong}</span>`;
        $('#ans').select();
      }
    } catch (err) {
      if (err.cooldown_until) P.cooldown_until = err.cooldown_until;
      $('#msg').innerHTML = `<span class="red">${esc(err.message)}</span>`;
      if (err.status === 409) renderLock(P.num);
    }
    tick();
  };
}

function renderHints() {
  const el = $('#hints');
  const won = P.auction_hint ? `<div class="hint open" style="border-color:var(--gold)"><span class="muted mono" style="font-size:12px">🔨 ПОДСКАЗКА С АУКЦИОНА</span><br>${esc(P.auction_hint)}</div>` : '';
  if (!P.hints.length) { el.innerHTML = won ? '<b>Подсказки</b>' + won : ''; el.classList.toggle('hidden', !won); return; }
  const firstClosed = P.hints.findIndex(h => !h.open);
  el.innerHTML = `<b>Подсказки</b>` + won + P.hints.map((h, i) => h.open
    ? `<div class="hint open"><span class="muted mono" style="font-size:12px">ПОДСКАЗКА ${i + 1} · −${h.cost}</span><br>${esc(h.text)}</div>`
    : `<div class="hint"><span>Подсказка ${i + 1} <span class="muted">· стоит ${h.cost} ${plural(h.cost, 'балл', 'балла', 'баллов')}</span></span>${
        i === firstClosed && !P.solved && !P.over ? `<button class="ghost small" data-hint="${i}">Открыть</button>` : ''}</div>`).join('');
  const b = el.querySelector('[data-hint]');
  if (b) b.onclick = async () => {
    const h = P.hints[firstClosed];
    if (!confirm(`Открыть подсказку за ${h.cost} ${plural(h.cost, 'балл', 'балла', 'баллов')}? Они вычтутся из награды за этот замок.`)) return;
    try { const r = await api(`/api/puzzle/${P.num}/hint`, {}); P.hints[r.idx] = { text: r.text, cost: r.cost, open: true }; renderHints(); }
    catch (e) { alert(e.message); }
  };
}

// ---------- Вход ----------
function closeModal() { clearInterval(pollTimer); $('#modal').innerHTML = ''; }
function modal(html) {
  $('#modal').innerHTML = `<div class="overlay" id="ov"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  $('#ov').onclick = e => { if (e.target.id === 'ov') closeModal(); };
}

async function openLogin() {
  if (S && S.user && !S.user.nick) return openProfile();
  const L = S ? S.login : {};
  modal(`<h3>Вход в игру</h3><p class="muted" style="margin:0">Вход идёт через бота: он же пришлёт сигнал, когда откроется новый замок.</p>
    <div class="row">
      ${L.tg ? '<button data-p="tg">Войти через Telegram</button>' : ''}
      ${L.vk ? `<button data-p="vk" class="${L.tg ? 'ghost' : ''}">Войти через ВКонтакте</button>` : ''}
      ${L.dev ? '<button data-p="dev" class="ghost">Тестовый вход (только для проверки)</button>' : ''}
      ${!L.tg && !L.vk && !L.dev ? '<p class="err">Вход пока не настроен. Организаторам: задайте токены ботов в файле .env.</p>' : ''}
    </div><div class="err" id="lerr"></div>`);
  document.querySelectorAll('#modal [data-p]').forEach(b => b.onclick = () => b.dataset.p === 'dev' ? devLogin() : startLogin(b.dataset.p));
}

async function devLogin() {
  const name = prompt('Тестовое имя (любое):'); if (!name) return;
  try { await api('/api/auth/dev', { name }); await afterLogin(); } catch (e) { $('#lerr').textContent = e.message; }
}

async function startLogin(provider) {
  let r;
  try { r = await api('/api/auth/start', {}); } catch (e) { $('#lerr').textContent = e.message; return; }
  const isTg = provider === 'tg';
  modal(`<h3>${isTg ? 'Telegram' : 'ВКонтакте'}</h3>
    <p class="muted" style="margin:0">${isTg
      ? 'Нажми кнопку ниже и в боте нажми «Запустить». Если код не отправился сам, пришли его боту сообщением.'
      : 'Вступи в сообщество, открой его сообщения и отправь боту этот код одним сообщением. Без вступления бот не пустит.'}</p>
    <div class="code" id="code">${esc(r.code)}</div>
    <a class="btn" style="width:100%" target="_blank" rel="noopener" href="${esc(isTg ? r.tg : r.vk)}">${isTg ? 'Открыть бота в Telegram' : 'Открыть сообщения ВКонтакте'}</a>
    ${isTg ? '' : `<a class="btn ghost" style="width:100%;margin-top:10px" target="_blank" rel="noopener" href="${esc(String(r.vk).replace('vk.me/', 'vk.com/'))}">Вступить в сообщество</a>`}
    <div class="wait"><span class="spin"></span>Жду подтверждения от бота… Код действует 15 минут.</div>
    <div class="err" id="lerr"></div>
    <p style="margin:14px 0 0"><button class="ghost small" id="backLogin">← Другой способ</button></p>`);
  $('#backLogin').onclick = () => { clearInterval(pollTimer); openLogin(); };
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const s = await api('/api/auth/poll');
      if (s.status === 'ok') { clearInterval(pollTimer); await afterLogin(); }
      else if (s.status === 'expired') { clearInterval(pollTimer); $('#lerr').textContent = 'Код устарел. Начни вход заново.'; }
    } catch { /* повторим */ }
  }, 2000);
}

async function afterLogin() {
  await refresh();
  if (S.user && !S.user.nick) openProfile(); else { closeModal(); go(); }
}

function openProfile() {
  modal(`<h3>Кто ты?</h3><p class="muted" style="margin:0">Ник увидят все в таблице лидеров. Группа нужна, чтобы найти победителя.</p>
    <form id="pf"><label for="nick">Ник</label><input id="nick" maxlength="20" required autocomplete="nickname">
    <label for="grp" id="grpLbl">Группа</label><input id="grp" maxlength="20" required placeholder="Например, Ф-21">
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);font-size:15px"><input type="checkbox" id="staff" style="width:auto"> Я преподаватель или сотрудник</label>
    <div class="err" id="perr"></div><button style="width:100%">Начать игру</button></form>`);
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/profile', { nick: $('#nick').value, group: $('#grp').value, staff: $('#staff').checked }); closeModal(); await refresh(); go(); }
    catch (err) { $('#perr').textContent = err.message; }
  };
  $('#staff').onchange = e => { $('#grpLbl').textContent = e.target.checked ? 'Кафедра' : 'Группа'; $('#grp').placeholder = e.target.checked ? 'Например, Финансы' : 'Например, Ф-21'; };
  $('#nick').focus();
}

// ---------- Таймеры ----------
function tick() {
  let reload = false;
  document.querySelectorAll('[data-cd]').forEach(el => {
    const left = Number(el.dataset.cd) - serverNow();
    el.textContent = fmtLeft(left);
    if (left <= 0) reload = true;
  });
  document.querySelectorAll('[data-tiles]').forEach(el => {
    const ms = Number(el.dataset.tiles) - serverNow(), v = parts(ms);
    el.querySelectorAll('b').forEach((b, i) => FX.flip(b, p2(v[i])));
    el.firstElementChild.style.display = v[0] ? '' : 'none'; // без дней — три плитки
    if (ms <= 0) reload = true;
  });
  document.querySelectorAll('[data-cds]').forEach(el => {
    const ms = Number(el.dataset.cds) - serverNow(); el.textContent = fmtShort(ms); if (ms <= 0) reload = true;
  });
  if (S) document.querySelectorAll('[data-val]').forEach(el => {
    const p = S.puzzles.find(x => x.num === Number(el.dataset.val)); if (p) el.textContent = valueNow(p);
  });
  if (P && $('#meta')) {
    const wait = Math.ceil((P.cooldown_until - serverNow()) / 1000);
    $('#meta').innerHTML = P.solved ? `<span class="pill green">Решено</span>` :
      P.kind === 'warmup' ? `<span class="pill gold">${P.max_points} баллов за верный ответ</span><span class="pill">Скорость не важна</span>` :
      P.kind === 'secret' ? `<span class="pill gold">${P.max_points} баллов</span><span class="pill">Только первым пятерым</span>` :
      `<span class="pill gold">Сейчас стоит ${valueNow(P)} ${plural(valueNow(P), 'балл', 'балла', 'баллов')}</span><span class="pill">Ошибок: ${P.wrong}</span>${P.closes_at ? (P.closes_at > serverNow() ? `<span class="pill red">Исчезнет через ${fmtShort(P.closes_at - serverNow())}</span>` : '<span class="pill red">Замок закрылся</span>') : ''}`;
    const btn = $('#send');
    if (btn) { btn.disabled = wait > 0; btn.textContent = wait > 0 ? `Подожди ${wait} с` : 'Проверить'; }
  }
  if (reload && !tick.busy) { tick.busy = true; setTimeout(async () => { await refresh(); tick.busy = false; }, 1200); }
}

// ---------- Пасхалки ----------
// 1. Сообщение в консоли браузера — последняя ступень цепочки к секретному замку.
console.log('%c ХРАНИЛИЩЕ ', 'background:#19b5fe;color:#04102e;font:800 16px monospace;padding:4px 8px;border-radius:4px');
console.log('%cТы открыл консоль. Значит, ты из тех, кто смотрит глубже.\nСлово для /keeper: ЛЮБОПЫТСТВО\n— Х.', 'color:#19b5fe;font:600 13px monospace;line-height:1.6');
function keeperToast(text, glitch) {
  if (glitch) { document.body.classList.add('glitching'); const g = document.createElement('div'); g.className = 'fx-glitch'; document.body.appendChild(g);
    setTimeout(() => { document.body.classList.remove('glitching'); g.remove(); }, 750); }
  const t = document.createElement('div'); t.className = 'keeper-toast'; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600); setTimeout(() => t.remove(), 3200);
}
// 2. Семь кликов по шару подряд.
let orbClicks = [], orbBusy = false;
document.addEventListener('click', e => {
  const o = e.target.closest('.orb-wrap'); if (!o || orbBusy) return;
  const t = Date.now(); orbClicks = orbClicks.filter(x => t - x < 2500); orbClicks.push(t);
  o.classList.remove('tap'); void o.offsetWidth; o.classList.add('tap');
  if (orbClicks.length >= 7) { orbClicks = []; orbBusy = true; o.classList.add('cracked'); keeperToast('Сила — не метод. Думай. — Х.');
    setTimeout(() => { o.classList.remove('cracked'); orbBusy = false; }, 2400); }
});
// 3. Набрать на клавиатуре «хранитель» (в русской или английской раскладке).
let typed = '';
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea') || e.key.length !== 1) return;
  typed = (typed + e.key.toLowerCase()).slice(-9);
  if (typed === 'хранитель' || typed === '[hfybntkm') { typed = ''; keeperToast('Ты меня звал? — Х.', true); }
});

window.addEventListener('hashchange', go);
(async () => {
  await refresh(); await go();
  if (S && S.user && !S.user.nick) openProfile();
  setInterval(tick, 1000);
  setInterval(refresh, 15000);
})();
