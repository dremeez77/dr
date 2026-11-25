'use strict';
// Анимации «Хранилища»: звёздное поле, наклон сферы, появление при прокрутке, взрыв при верном ответе,
// перестановка строк таблицы и набегающие числа. Без библиотек. Если в системе включено «уменьшить движение»,
// всё работает статично.
window.FX = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 1. Звёздное поле ----------
  function stars() {
    const cv = document.createElement('canvas'); cv.id = 'stars'; cv.setAttribute('aria-hidden', 'true');
    document.body.prepend(cv);
    const c = cv.getContext('2d'); let W, H, list = [], dpr = Math.min(2, devicePixelRatio || 1);
    const make = () => {
      W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(160, W * H / 9000));
      list = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + .2,
        s: Math.random() * .12 + .02, p: Math.random() * Math.PI * 2, b: Math.random() < .12 }));
    };
    const draw = t => {
      c.clearRect(0, 0, W, H);
      for (const s of list) {
        const a = .35 + .45 * Math.sin(t / 900 + s.p);
        c.fillStyle = s.b ? `rgba(25,181,254,${a})` : `rgba(200,220,255,${a * .8})`;
        c.beginPath(); c.arc(s.x, s.y, s.r, 0, 6.283); c.fill();
        if (!reduced) { s.y -= s.s; s.x += s.s * .3; if (s.y < -2) { s.y = H + 2; s.x = Math.random() * W; } if (s.x > W + 2) s.x = -2; }
      }
    };
    make(); addEventListener('resize', make);
    if (reduced) { draw(0); return; }
    const loop = t => { if (!document.hidden) draw(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------- 2. Сфера следит за мышкой и наклоном телефона ----------
  function orb() {
    if (reduced) return;
    let tx = 0, ty = 0, x = 0, y = 0;
    addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; tx = (e.clientX / innerWidth - .5) * 2; ty = (e.clientY / innerHeight - .5) * 2; });
    addEventListener('deviceorientation', e => { if (e.gamma == null) return; tx = Math.max(-1, Math.min(1, e.gamma / 30)); ty = Math.max(-1, Math.min(1, (e.beta - 40) / 30)); });
    const loop = () => {
      x += (tx - x) * .06; y += (ty - y) * .06;
      const o = document.querySelector('.orb-wrap .orb'), k = document.querySelector('.orb-wrap .keyhole');
      if (o) o.style.transform = `translate(${x * 8}px, ${y * 8}px) rotateX(${-y * 10}deg) rotateY(${x * 10}deg)`;
      if (k) k.style.translate = `${x * 14}px ${y * 14}px`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- 3. Появление при прокрутке ----------
  const io = 'IntersectionObserver' in window && !reduced ? new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('rv-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px' }) : null;
  function reveal(root) {
    if (!io) return;
    // Каскад: элементы одной сетки появляются друг за другом.
    root.querySelectorAll(':scope > h2, .locks > *, .badges > *, .rules > *, .steps > *, .tbl-scroll').forEach(el => {
      const sibs = el.parentElement ? [...el.parentElement.children] : [];
      el.style.setProperty('--d', Math.min(8, Math.max(0, sibs.indexOf(el))) * 70 + 'ms');
      el.classList.add('rv'); io.observe(el);
    });
  }

  // ---------- 6. Взрыв при верном ответе ----------
  function burst(points) {
    const ov = document.createElement('div'); ov.className = 'fx-burst';
    ov.innerHTML = `<canvas></canvas><div class="fx-ring"></div><svg class="fx-key" viewBox="0 0 54 80"><circle cx="27" cy="22" r="16"/><path d="M27 30 L14 74 L40 74 Z"/></svg>
      <div class="fx-txt"><span>ЗАМОК ОТКРЫТ</span><b>+0</b></div>`;
    document.body.appendChild(ov);
    const cv = ov.querySelector('canvas'), c = cv.getContext('2d'), W = cv.width = innerWidth, H = cv.height = innerHeight;
    const parts = reduced ? [] : Array.from({ length: 140 }, () => { const a = Math.random() * 6.283, v = Math.random() * 9 + 3;
      return { x: W / 2, y: H / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 3 + 1, c: ['#19b5fe', '#3ddc84', '#ffffff', '#7cc4ff'][Math.random() * 4 | 0] }; });
    const t0 = performance.now(), b = ov.querySelector('b');
    const step = t => {
      const e = t - t0;
      c.clearRect(0, 0, W, H);
      for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += .12; p.vx *= .985; c.globalAlpha = Math.max(0, 1 - e / 1800); c.fillStyle = p.c; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); }
      const k = Math.min(1, Math.max(0, (e - 350) / 900)); b.textContent = '+' + Math.round(points * (1 - Math.pow(1 - k, 3)));
      if (e < 2400) requestAnimationFrame(step); else { ov.classList.add('out'); setTimeout(() => ov.remove(), 500); }
    };
    requestAnimationFrame(step);
    ov.onclick = () => { ov.classList.add('out'); setTimeout(() => ov.remove(), 400); };
  }

  // ---------- 8–9. Перестановка строк и набегающие числа ----------
  // Перед перерисовкой запоминаем, где стояла каждая строка и какое у неё было число; после — плавно доводим.
  const lastVal = new Map();
  function capture(root) {
    const m = new Map();
    if (root) root.querySelectorAll('[data-k]').forEach(el => m.set(el.dataset.k, { top: el.getBoundingClientRect().top, rank: Number(el.dataset.rank) || 0 }));
    return m;
  }
  function play(root, before) {
    if (!root) return;
    root.querySelectorAll('[data-k]').forEach(el => {
      const b = before.get(el.dataset.k); if (!b || reduced) return;
      const dy = b.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) {
        el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform .8s cubic-bezier(.2,.8,.2,1)'; el.style.transform = ''; }));
      }
      const r = Number(el.dataset.rank) || 0;
      if (b.rank && r && r < b.rank) { el.classList.remove('fx-up'); void el.offsetWidth; el.classList.add('fx-up'); }
    });
    count(root);
  }
  function count(root) {
    (root || document).querySelectorAll('[data-count]').forEach(el => {
      const key = el.dataset.count, to = Number(el.dataset.v) || 0, from = lastVal.has(key) ? lastVal.get(key) : to;
      lastVal.set(key, to);
      if (from === to || reduced) { el.textContent = to; return; }
      const t0 = performance.now(), d = 900;
      const step = t => { const k = Math.min(1, (t - t0) / d); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
      el.textContent = from; requestAnimationFrame(step);
      el.classList.remove('fx-bump'); void el.offsetWidth; el.classList.add('fx-bump');
    });
  }

  // ---------- 4. Перекидка цифр ----------
  function flip(el, value) {
    if (el.textContent === value) return;
    el.textContent = value;
    if (reduced) return;
    el.classList.remove('fx-flip'); void el.offsetWidth; el.classList.add('fx-flip');
  }

  document.addEventListener('DOMContentLoaded', () => { stars(); orb(); });
  if (document.readyState !== 'loading') { stars(); orb(); }
  return { reveal, burst, capture, play, count, flip, reduced };
})();
