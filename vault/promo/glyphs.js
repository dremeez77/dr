'use strict';
// Алфавит Хранителя: 48 значков (8 фигур × 6 меток) и эмблема игры.
// Всё рисуется линиями в квадрате 100×100, поэтому значки одинаково выглядят в любом размере.

const BASES = [
  f => `<circle cx="50" cy="50" r="34" fill="${f}"/>`,
  f => `<rect x="18" y="18" width="64" height="64" fill="${f}"/>`,
  f => `<path d="M50 14 L88 82 L12 82 Z" fill="${f}"/>`,
  f => `<path d="M12 18 L88 18 L50 86 Z" fill="${f}"/>`,
  f => `<path d="M50 10 L88 50 L50 90 L12 50 Z" fill="${f}"/>`,
  f => `<path d="M30 16 L70 16 L90 50 L70 84 L30 84 L10 50 Z" fill="${f}"/>`,
  f => `<path d="M18 16 L18 54 A32 32 0 0 0 82 54 L82 16" fill="${f}"/>`,
  f => `<path d="M12 84 L50 16 L88 84" fill="none"/><path d="M30 84 L50 48 L70 84" fill="${f}"/>`,
];
const MARKS = [
  () => '',
  c => `<circle cx="50" cy="52" r="8" fill="${c}" stroke="none"/>`,
  () => `<path d="M50 4 L50 96"/>`,
  () => `<path d="M4 50 L96 50"/>`,
  () => `<path d="M50 4 L50 96 M4 50 L96 50"/>`,
  null, // пятая метка — заливка фигуры
];
const COUNT = BASES.length * MARKS.length;

/** Содержимое значка №i (0…47) для вставки внутрь <svg viewBox="0 0 100 100">. */
function glyphInner(i, color = 'currentColor') {
  const base = BASES[i % BASES.length], mark = Math.floor(i / BASES.length) % MARKS.length;
  const filled = mark === 5;
  return `<g fill="none" stroke="${color}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round">${base(filled ? color : 'none')}${filled ? '' : MARKS[mark](color)}</g>`;
}
const glyph = (i, color) => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${glyphInner(i, color)}</svg>`;

/** Эмблема: замочная скважина в круге с четырьмя засечками — по числу замков. */
function emblem(color = 'currentColor', stroke = 5) {
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round">
    <circle cx="100" cy="100" r="72"/>
    <path d="M100 6 L100 44 M100 156 L100 194 M6 100 L44 100 M156 100 L194 100"/>
    <circle cx="100" cy="88" r="15" fill="${color}" stroke="none"/>
    <path d="M100 92 L88 134 L112 134 Z" fill="${color}" stroke="${color}" stroke-linejoin="round"/></g></svg>`;
}

/** Генератор случайных чисел с зерном: один и тот же шифр получается при каждом запуске. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

module.exports = { glyph, glyphInner, emblem, rng, COUNT };
