'use strict';
// Правила начисления баллов. Вынесены отдельно, чтобы их можно было проверить тестами.

const FIRST_BONUS = [30, 20, 10]; // бонус первым трём решившим
const WRONG_PENALTY = 2;          // штраф за неверную попытку
const WRONG_PENALTY_CAP = 20;     // максимум штрафа за попытки
const FLOOR = 10;                 // меньше этого за решённый замок не бывает

/** Приводит ответ к виду для сравнения: регистр, ё/е, пробелы и знаки не важны. */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Сколько «стоит» замок в данный момент: от max_points плавно падает до min_points. */
function timeValue(p, elapsedMs) {
  const decay = Math.max(1, p.decay_minutes) * 60000;
  const f = Math.min(1, Math.max(0, elapsedMs / decay));
  return Math.round(p.max_points - (p.max_points - p.min_points) * f);
}

/** Итог за решение: стоимость по времени + бонус за место − штрафы − подсказки. */
function finalPoints({ timePts, place, wrong, hintCost }) {
  const bonus = FIRST_BONUS[place - 1] || 0;
  const penalty = Math.min(WRONG_PENALTY_CAP, wrong * WRONG_PENALTY);
  return Math.max(FLOOR, timePts + bonus - penalty - hintCost);
}

module.exports = { normalize, timeValue, finalPoints, FIRST_BONUS, WRONG_PENALTY, WRONG_PENALTY_CAP, FLOOR };
