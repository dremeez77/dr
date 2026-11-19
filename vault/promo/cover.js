'use strict';
// Обложка сообщества ВКонтакте: 1920×768. Важное — в центре: на телефоне края обрезаются,
// а слева внизу на компьютере обложку перекрывает аватарка.
const path = require('node:path');
const { chromium } = require('playwright');
const { glyph, emblem, rng, COUNT } = require('./glyphs');
const BLUE = '#19b5fe';
const r = rng(1123);
const row = n => Array.from({ length: n }, () => `<span>${glyph(Math.floor(r() * COUNT), BLUE)}</span>`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 1920px; height: 768px; overflow: hidden; background: radial-gradient(1100px 600px at 50% 45%, #0e1c57, #040b2c 72%); color: #eef2fb; font-family: "Inter Display", Inter, sans-serif; position: relative; }
  .g { position: absolute; display: grid; grid-template-columns: repeat(3, 64px); gap: 26px; opacity: .22; }
  .g span { display: block; width: 64px; height: 64px; } .g svg { width: 100%; height: 100%; display: block; }
  .c { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -54%); display: flex; align-items: center; gap: 56px; }
  .emb { width: 230px; height: 230px; flex: none; }
  .k { font: 700 22px/1 "JetBrains Mono", monospace; letter-spacing: .32em; color: #93a5cf; }
  h1 { font-weight: 900; font-size: 104px; line-height: .95; letter-spacing: -.03em; margin: 18px 0 22px; text-transform: uppercase; white-space: nowrap; }
  .b { color: ${BLUE}; }
  .d { font: 700 30px/1 "JetBrains Mono", monospace; letter-spacing: .12em; color: #d5def3; }
  .p { position: absolute; right: 64px; bottom: 44px; font: 700 18px/1 "JetBrains Mono", monospace; letter-spacing: .26em; color: #93a5cf; }
</style>
<div class="g" style="left:60px;top:90px">${row(12)}</div>
<div class="g" style="right:60px;top:90px">${row(12)}</div>
<div class="c">
  <div class="emb">${emblem(BLUE, 5)}</div>
  <div>
    <div class="k">ХРАНИЛИЩЕ · СПбГАУ</div>
    <h1>Четыре замка.<br><span class="b">Один приз.</span></h1>
    <div class="d">23–27 НОЯБРЯ · hranilischespbgau.ru</div>
  </div>
</div>
<div class="p">ПРИ ПОДДЕРЖКЕ БАНКА ВТБ</div>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 768 }, deviceScaleFactor: 1 });
  await p.setContent(html); await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(__dirname, 'out', 'vk-cover.png') });
  await b.close();
  console.log('Готово: promo/out/vk-cover.png');
})();
