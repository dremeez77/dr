'use strict';
// Именные сертификаты Хранителя (A4, альбомная).
//   node promo/certificate.js                 — пример на трёх тестовых именах
//   node promo/certificate.js people.json     — по списку: [{ "name": "…", "group": "…", "place": 5, "locks": 3, "points": 217 }]
// Результат: promo/out/certificates.pdf (все листы подряд) и promo/out/certificate-preview.png (первый лист).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { glyph, emblem, rng, COUNT } = require('./glyphs');

const BLUE = '#19b5fe';
const people = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : [
  { name: 'Имя Фамилия', group: 'Ф-21', place: 5, locks: 3, points: 312 },
  { name: 'Имя Фамилия', group: 'Э-32', place: 6, locks: 3, points: 288 },
  { name: 'Имя Фамилия', group: 'Б-11', place: 7, locks: 2, points: 241 },
];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const word = n => (n % 10 === 1 && n % 100 !== 11) ? 'замок' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'замка' : 'замков';

function sheet(p, i) {
  const r = rng(500 + i);
  const strip = Array.from({ length: 18 }, () => `<span>${glyph(Math.floor(r() * COUNT), BLUE)}</span>`).join('');
  return `<section class="s">
    <div class="frame"></div>
    <div class="top"><span>ХРАНИЛИЩЕ · СПбГАУ</span><span>№ ${String(i + 1).padStart(3, '0')}</span></div>
    <div class="body">
      <div class="emb">${emblem(BLUE, 5)}</div>
      <div class="txt">
        <div class="k">СЕРТИФИКАТ</div>
        <h1>Хранитель признаёт</h1>
        <div class="name">${esc(p.name)}</div>
        <div class="grp">${esc(p.group || '')}</div>
        <p><b class="blue">${esc(p.place)}-е место</b> в игре «Хранилище»${p.locks != null ? ` · взломано <b>${p.locks} ${word(p.locks)} из четырёх</b>` : ''}${p.points ? ` · <b>${esc(p.points)} баллов</b>` : ''}.<br>Лучший ключ к любому хранилищу — своя голова.</p>
      </div>
    </div>
    <div class="strip">${strip}</div>
    <div class="foot">
      <div>Неделя финансовой грамотности СПбГАУ<br>23–27 ноября 2026 · при поддержке банка ВТБ</div>
      <div class="sig"><span class="line"></span>Хранитель</div>
    </div>
  </section>`;
}

const css = `@page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; } html, body { margin: 0; }
  body { font-family: "Inter Display", Inter, sans-serif; color: #eef2fb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .s { width: 297mm; height: 210mm; position: relative; overflow: hidden; page-break-after: always;
       background: radial-gradient(160mm 110mm at 30% 35%, #0e1c57, #040b2c 72%); padding: 18mm 22mm; display: flex; flex-direction: column; }
  .frame { position: absolute; inset: 9mm; border: .5mm solid rgba(25,181,254,.45); border-radius: 3mm; }
  .top { display: flex; justify-content: space-between; font: 700 3.6mm/1 "JetBrains Mono", monospace; letter-spacing: .3em; color: #93a5cf; }
  .body { display: flex; gap: 14mm; align-items: center; margin-top: 14mm; }
  .emb { width: 58mm; height: 58mm; flex: none; }
  .k { font: 700 4mm/1 "JetBrains Mono", monospace; letter-spacing: .4em; color: ${BLUE}; }
  h1 { font-weight: 800; font-size: 10mm; letter-spacing: -.02em; margin: 3mm 0 6mm; }
  .name { font-weight: 900; font-size: 17mm; line-height: 1; letter-spacing: -.03em; }
  .grp { font: 700 5mm/1 "JetBrains Mono", monospace; color: #93a5cf; margin-top: 3mm; letter-spacing: .1em; }
  p { font-size: 5.4mm; line-height: 1.45; color: #d5def3; margin: 7mm 0 0; max-width: 165mm; }
  b { color: #fff; } .blue { color: ${BLUE}; }
  .strip { display: flex; justify-content: space-between; margin-top: auto; opacity: .35; }
  .strip span { width: 9mm; height: 9mm; display: block; } .strip svg { width: 100%; height: 100%; display: block; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 7mm; font-size: 3.8mm; line-height: 1.5; color: #93a5cf; }
  .sig { text-align: center; font: 700 4mm/1 "JetBrains Mono", monospace; letter-spacing: .25em; color: #d5def3; }
  .line { display: block; width: 55mm; border-bottom: .4mm solid #93a5cf; margin-bottom: 3mm; }`;

(async () => {
  const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${css}</style></head><body>${people.map(sheet).join('')}</body></html>`;
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 2 });
  await pg.setContent(html); await pg.evaluate(() => document.fonts.ready);
  await pg.pdf({ path: path.join(out, 'certificates.pdf'), width: '297mm', height: '210mm', printBackground: true });
  await pg.screenshot({ path: path.join(out, 'certificate-preview.png'), clip: { x: 0, y: 0, width: 1123, height: 794 } });
  await b.close();
  console.log(`Готово: ${people.length} сертификат(а) → promo/out/certificates.pdf`);
})();
