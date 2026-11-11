'use strict';
// Тизеры и афиша игры «Хранилище».
//   node promo/make.js                      — тизеры (без адреса сайта) и афиша без QR
//   node promo/make.js --url=https://сайт   — то же, но афиша с QR-кодом и адресом
// Результат — в promo/out: PDF для печати (A4/A3) и PNG для соцсетей и сторис.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const qrcode = require('../public/vendor/qrcode.js');
const { glyph, emblem, rng, COUNT } = require('./glyphs');

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const URL_ = arg('url').replace(/\/$/, '');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const GOLD = '#f5c542', BG = '#0a0c0f', MUTED = '#8793a1';
const ABC = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
// Простой шифр «буква → её номер в алфавите»: первая загадка ещё до старта игры.
const a1z33 = t => t.toLowerCase().split(' ').map(w => [...w].map(ch => ABC.indexOf(ch) + 1).join('-')).join('  ·  ');
const TEASE = a1z33('приходи в актовый зал');

function glyphRows(rows, cols, seed, size) {
  const r = rng(seed);
  let h = '';
  for (let y = 0; y < rows; y++) {
    h += '<div class="grow">';
    for (let x = 0; x < cols; x++) h += `<span style="width:${size};height:${size}">${glyph(Math.floor(r() * COUNT), GOLD)}</span>`;
    h += '</div>';
  }
  return h;
}

const CSS = `
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: ${BG}; color: #f2f4f6; font-family: "Inter Display", Inter, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; width: 100vw; height: 100vh; overflow: hidden; display: flex; flex-direction: column; padding: 7vw; }
  .page::before { content: ""; position: absolute; inset: 3.2vw; border: .22vw solid rgba(245,197,66,.45); pointer-events: none; }
  .mono { font-family: "JetBrains Mono", monospace; }
  .gold { color: ${GOLD}; }
  .top { display: flex; justify-content: space-between; align-items: center; font: 700 1.9vw/1 "JetBrains Mono", monospace; letter-spacing: .3em; color: ${MUTED}; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 4vw; }
  .date { font: 900 17vw/.82 "Inter Display", Inter, sans-serif; color: ${GOLD}; letter-spacing: -.03em; }
  .where { text-align: right; font: 600 2.3vw/1.45 "JetBrains Mono", monospace; color: #cfd6dd; }
  .where small { display: block; color: ${MUTED}; font-size: 1.7vw; }
  .tease { font: 600 1.75vw/1.6 "JetBrains Mono", monospace; color: ${MUTED}; letter-spacing: .04em; margin-top: 3vw; }
  h1 { font: 900 13.5vw/.9 "Inter Display", Inter, sans-serif; letter-spacing: -.035em; margin: 0; text-transform: uppercase; }
  .grow { display: flex; justify-content: space-between; margin-bottom: 1.6vw; }
  .grow span { display: block; } .grow svg { display: block; width: 100%; height: 100%; }
  .emb svg { display: block; width: 100%; height: 100%; }
`;

// ---------- Тизеры: до открытия, без адреса сайта и без объяснений ----------
const footer = `<div class="foot"><div class="date">23.11</div><div class="where">АКТОВЫЙ ЗАЛ<small>Неделя финансовой грамотности · СПбГАУ</small></div></div>`;
const head = n => `<div class="top"><span>ХРАНИЛИЩЕ</span><span>${n} / 3</span></div>`;

const TEASERS = {
  'teaser-1-symbol': `<div class="page">${head(1)}
    <div class="emb" style="width:52vw;height:52vw;margin:7vw auto 6vw;color:${GOLD}">${emblem(GOLD, 4)}</div>
    <h1 style="font-size:11.5vw;text-align:center">Четыре замка.<br><span class="gold">Один приз.</span></h1>
    ${footer}</div>`,
  'teaser-2-cipher': `<div class="page">${head(2)}
    <div style="margin-top:5vw;opacity:.9">${glyphRows(4, 10, 2311, '6.2vw')}</div>
    <h1 style="margin-top:4vw;font-size:12.4vw">Ты умеешь<br>думать <span class="gold">сам?</span></h1>
    <div style="margin-top:4.5vw;opacity:.9">${glyphRows(1, 10, 77, '6.2vw')}</div>
    <div class="tease">${TEASE}</div>
    ${footer}</div>`,
  'teaser-3-ai': `<div class="page">${head(3)}
    <h1 style="margin-top:11vw;font-size:11.7vw;white-space:nowrap">Нейросеть<br><span class="gold">не поможет.</span></h1>
    <p style="font:500 3.3vw/1.4 Inter,sans-serif;color:#cfd6dd;margin:6vw 0 0;max-width:70vw">Четыре загадки. Решить их сможет только тот, кто думает своей головой.</p>
    <div class="tease">${TEASE}</div>
    <div style="margin-top:7vw;opacity:.9">${glyphRows(2, 10, 404, '6.2vw')}</div>
    ${footer}</div>`,
};

// ---------- Афиша: после открытия, с расписанием и QR ----------
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
const qrBlock = URL_
  ? `<div style="background:#fff;padding:1.2vw;border-radius:1.4vw;width:22vw">${qrSvg(URL_ + '/')}</div>
     <div class="mono" style="font-weight:700;font-size:2.5vw;margin-top:1.6vw;color:${GOLD}">${URL_.replace(/^https?:\/\//, '')}</div>`
  : `<div style="width:22vw;height:22vw;border:.3vw dashed ${MUTED};border-radius:1.4vw;display:flex;align-items:center;justify-content:center;text-align:center;color:${MUTED};font:600 1.9vw/1.4 'JetBrains Mono',monospace;padding:2vw">ЗДЕСЬ БУДЕТ QR<br>запусти с --url</div>`;
const sched = [['ПН 23.11', '20:00', 'Замок №1'], ['ВТ 24.11', '20:00', 'Замок №2'], ['СР 25.11', '12:00', 'Замок №3'], ['ЧТ 26.11', '20:00', 'Замок №4'], ['ПТ 27.11', 'финал', 'Хранилище откроют']];
const POSTER = `<div class="page">
  <div class="top"><span>ХРАНИЛИЩЕ</span><span>23–27.11</span></div>
  <div style="display:flex;gap:5vw;align-items:center;margin-top:5vw">
    <div class="emb" style="width:19vw;height:19vw;flex:none">${emblem(GOLD, 5)}</div>
    <h1 style="font-size:6.9vw;white-space:nowrap">Четыре замка.<br><span class="gold">Один приз.</span></h1>
  </div>
  <p style="font:500 3vw/1.42 Inter,sans-serif;color:#cfd6dd;margin:4vw 0 0">Приз от банка ВТБ заперт в хранилище. Каждый день открывается новая загадка. Кто решит раньше, получит больше баллов. Нейросеть не поможет.</p>
  <div style="margin-top:3.5vw;border-top:.2vw solid #262e38">
    ${sched.map(([d, t, n], i) => `<div style="display:flex;align-items:baseline;gap:3vw;padding:1.55vw 0;border-bottom:.2vw solid #262e38;font:700 3.3vw/1 'JetBrains Mono',monospace">
      <span style="width:24vw;color:${MUTED}">${d}</span><span style="width:17vw;color:${GOLD}">${t}</span><span style="font-family:Inter,sans-serif;font-weight:${i === 4 ? 800 : 600};color:${i === 4 ? GOLD : '#f2f4f6'}">${n}</span></div>`).join('')}
  </div>
  <div class="foot" style="align-items:center">
    <div>${qrBlock}</div>
    <div style="font:500 2.3vw/1.45 Inter,sans-serif;color:#cfd6dd;max-width:50vw">
      <div style="font:700 1.8vw/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:${MUTED};margin-bottom:1.6vw">КАК ИГРАТЬ</div>
      1. Сканируй код и войди через Telegram или ВКонтакте.<br>2. Жди сигнала от бота: замок открыт.<br>3. Решай быстрее всех. Играем по одному.
      <div style="margin-top:2.4vw;color:${MUTED};font-size:1.9vw">Неделя финансовой грамотности · СПбГАУ</div>
    </div>
  </div></div>`;

const doc = body => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const render = async (name, html, { pdf, w, h }) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await page.setContent(doc(html)); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    if (pdf) await page.pdf({ path: path.join(OUT, name + '.pdf'), format: pdf, printBackground: true });
    await page.close();
  };
  for (const [name, html] of Object.entries(TEASERS)) {
    await render(name, html, { pdf: 'A4', w: 794, h: 1123 });          // печать A4 и картинка для поста
    await render(name + '-story', html, { w: 540, h: 960 });           // сторис 1080×1920
  }
  await render('poster', POSTER, { pdf: 'A3', w: 794, h: 1123 });
  await browser.close();
  console.log('Готово:', fs.readdirSync(OUT).join(', '));
  console.log('Шифр на тизерах:', TEASE, '→ «приходи в актовый зал»');
})();
