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
const fmtWhen = ts => new Date(ts).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function valueNow(p) {
  const f = Math.min(1, Math.max(0, (serverNow() - p.opens_at) / (p.decay_minutes * 60000)));
  return Math.round(p.max_points - (p.max_points - p.min_points) * f);
}
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11) ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? b : c;
const over = () => S && S.ends_at > 0 && serverNow() >= S.ends_at;

// ---------- Загрузка ----------
async function refresh() {
  try {
    S = await api('/api/state');
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
    el.innerHTML = `<span class="pill gold">${S.total} ${plural(S.total, 'балл', 'балла', 'баллов')}</span><b>${esc(S.user.nick)}</b><button class="ghost small" id="logout">Выйти</button>`;
    $('#logout').onclick = async () => { await api('/api/auth/logout', {}); await refresh(); go(); };
  } else {
    el.innerHTML = `<button class="small" id="login">Войти</button>`;
    $('#login').onclick = openLogin;
  }
}

// ---------- Главная ----------
function renderHome() {
  if (!S) return;
  const ps = S.puzzles.filter(p => p.kind !== 'warmup'), warm = S.puzzles.filter(p => p.kind === 'warmup' && p.open);
  const next = ps.find(p => !p.open);
  let nextHtml;
  if (over()) nextHtml = `<div class="next"><span class="lbl">Игра завершена</span><span class="cd">Итоги ниже</span></div>`;
  else if (next) nextHtml = `<div class="next"><span class="lbl">Замок №${next.num} откроется через</span><span class="cd" data-cd="${next.opens_at}">${fmtLeft(next.opens_at - serverNow())}</span><span class="muted" style="font-size:13px">${esc(fmtWhen(next.opens_at))}</span></div>`;
  else if (ps.length) nextHtml = `<div class="next"><span class="lbl">Все замки открыты</span><span class="cd">Успей решить</span></div>`;
  else nextHtml = `<div class="next"><span class="lbl">Скоро</span><span class="cd">Ждите сигнала</span></div>`;

  const locks = ps.map(p => {
    if (!p.open) return `<div class="lock closed"><span class="n">ЗАМОК №${p.num}</span><span class="t">Закрыт</span>
      <span class="big" data-cd="${p.opens_at}">${fmtLeft(p.opens_at - serverNow())}</span><span class="sub">${esc(fmtWhen(p.opens_at))}</span></div>`;
    if (p.solved) return `<a class="lock solved" href="#/lock/${p.num}"><span class="n">ЗАМОК №${p.num} · ОТКРЫТ ТОБОЙ</span><span class="t">${esc(p.title)}</span>
      <span class="big">+${p.solved.points}</span><span class="sub">Ты решил ${p.solved.place}-м · всего решили: ${p.solvers}</span></a>`;
    return `<a class="lock open" href="#/lock/${p.num}"><span class="n">ЗАМОК №${p.num} · ИДЁТ ВЗЛОМ</span><span class="t">${esc(p.title)}</span>
      <span class="big"><span data-val="${p.num}">${valueNow(p)}</span></span><span class="sub">баллов сейчас · решили: ${p.solvers}</span></a>`;
  }).join('');

  const cta = S.user && S.user.nick ? '' : `<p style="margin-top:22px"><button id="cta">Вступить в игру</button></p>`;

  $('#view').innerHTML = `
    <section class="hero">
      <h1>Четыре замка.<br>Один приз.</h1>
      <p>Приз от банка ВТБ заперт в хранилище. Каждый день открывается новая загадка. Кто решает раньше, получает больше баллов. Нейросеть не поможет: думать придётся самому.</p>
      ${nextHtml}${cta}
    </section>
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
      <div class="rule"><b>Смотри вокруг</b><span>Не все ключи лежат в интернете. Некоторые спрятаны в колледже и в том, что звучало на открытии.</span></div>
    </div>`;
  const c = $('#cta'); if (c) c.onclick = openLogin;
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
    rows.map(r => `<tr class="${r.id === myId ? 'me-row' : ''}"><td class="rank ${r.rank === 1 ? 'rank-1' : ''}">${r.rank}</td>
      <td class="nick">${esc(r.nick)} <span class="grp">${esc(r.group)}</span></td>
      ${nums.map(n => `<td class="r">${r.locks[n] ? r.locks[n].points : '<span class="muted">·</span>'}</td>`).join('')}${hasWarm ? `<td class="r">${r.warm || '<span class="muted">·</span>'}</td>` : ''}
      <td class="r ${r.rank === 1 ? 'rank-1' : ''}"><b>${r.total}</b></td></tr>`).join('')
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
      <span class="mono muted" style="font-size:12px;letter-spacing:.18em">${P.kind === 'warmup' ? 'РАЗМИНКА ДНЯ' : 'ЗАМОК №' + P.num}</span>
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
      <span class="muted">${P.kind === 'warmup' ? 'Разминка засчитана.' : `Ты решил ${P.solved.place}-м. Ответ никому не рассказывай: приз один.`}</span></div>`;
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
        P.solved = { points: r.points, place: r.place };
        renderAnswer(); renderHints(); refresh();
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
  if (!P.hints.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const firstClosed = P.hints.findIndex(h => !h.open);
  el.innerHTML = `<b>Подсказки</b>` + P.hints.map((h, i) => h.open
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
      ${L.vk ? '<button data-p="vk" class="ghost">Войти через ВКонтакте</button>' : ''}
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
      : 'Открой сообщения сообщества и отправь боту этот код одним сообщением.'}</p>
    <div class="code" id="code">${esc(r.code)}</div>
    <a class="btn" style="width:100%" target="_blank" rel="noopener" href="${esc(isTg ? r.tg : r.vk)}">${isTg ? 'Открыть бота в Telegram' : 'Открыть сообщения ВКонтакте'}</a>
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
  if (S) document.querySelectorAll('[data-val]').forEach(el => {
    const p = S.puzzles.find(x => x.num === Number(el.dataset.val)); if (p) el.textContent = valueNow(p);
  });
  if (P && $('#meta')) {
    const wait = Math.ceil((P.cooldown_until - serverNow()) / 1000);
    $('#meta').innerHTML = P.solved ? `<span class="pill green">Решено</span>` :
      P.kind === 'warmup' ? `<span class="pill gold">${P.max_points} баллов за верный ответ</span><span class="pill">Скорость не важна</span>` :
      `<span class="pill gold">Сейчас стоит ${valueNow(P)} ${plural(valueNow(P), 'балл', 'балла', 'баллов')}</span><span class="pill">Ошибок: ${P.wrong}</span>`;
    const btn = $('#send');
    if (btn) { btn.disabled = wait > 0; btn.textContent = wait > 0 ? `Подожди ${wait} с` : 'Проверить'; }
  }
  if (reload && !tick.busy) { tick.busy = true; setTimeout(async () => { await refresh(); tick.busy = false; }, 1200); }
}

window.addEventListener('hashchange', go);
(async () => {
  await refresh(); await go();
  if (S && S.user && !S.user.nick) openProfile();
  setInterval(tick, 1000);
  setInterval(refresh, 15000);
})();
