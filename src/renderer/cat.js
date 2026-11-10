'use strict';
// 小猫插画：full 饱饱的 / hungry 有点饿 / hunting 外出打猎
window.catSvg = function catSvg(status, size = 120) {
  if (status === 'hunting') {
    return `<svg viewBox="0 0 120 100" width="${size}" height="${size * 100 / 120}" aria-label="小猫外出打猎">
      <ellipse cx="60" cy="86" rx="40" ry="7" fill="rgba(0,0,0,.08)"/>
      <g fill="#c98a4b" opacity=".75">
        ${[[30, 70], [50, 54], [72, 62], [90, 44]].map(([x, y]) => `<g transform="translate(${x} ${y})"><ellipse cx="0" cy="4" rx="5" ry="4"/><circle cx="-5" cy="-2" r="2"/><circle cx="0" cy="-4" r="2"/><circle cx="5" cy="-2" r="2"/></g>`).join('')}
      </g></svg>`;
  }
  const eyes = status === 'full'
    ? '<path d="M44 46 q5 -6 10 0 M66 46 q5 -6 10 0" stroke="#4a3320" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
    : '<ellipse cx="49" cy="45" rx="3.2" ry="4.2" fill="#4a3320"/><ellipse cx="71" cy="45" rx="3.2" ry="4.2" fill="#4a3320"/><circle cx="50" cy="43.5" r="1" fill="#fff"/><circle cx="72" cy="43.5" r="1" fill="#fff"/>';
  const mouth = status === 'full'
    ? '<path d="M55 55 q5 5 10 0" stroke="#4a3320" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    : '<path d="M56 57 q4 -3 8 0" stroke="#4a3320" stroke-width="1.8" fill="none" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 120 100" width="${size}" height="${size * 100 / 120}" aria-label="小猫">
    <ellipse cx="60" cy="92" rx="38" ry="6" fill="rgba(0,0,0,.10)"/>
    <path class="cat-tail" d="M92 80 q22 -4 14 -26" stroke="#e8a55c" stroke-width="8" fill="none" stroke-linecap="round"/>
    <ellipse cx="60" cy="76" rx="30" ry="18" fill="#f2b56b"/>
    <path d="M34 30 L30 8 L50 22 Z M86 30 L90 8 L70 22 Z" fill="#f2b56b"/>
    <path d="M36 24 L34 14 L44 21 Z M84 24 L86 14 L76 21 Z" fill="#f7cfc0"/>
    <ellipse cx="60" cy="46" rx="30" ry="25" fill="#f6c27c"/>
    <path d="M52 23 l2 9 M60 21 l0 10 M68 23 l-2 9" stroke="#d98f45" stroke-width="3" stroke-linecap="round"/>
    <g class="cat-eyes">${eyes}</g>
    <path d="M57.5 51 h5 l-2.5 3 z" fill="#e07a6a"/>
    ${mouth}
    <path d="M40 52 h-12 M40 56 l-11 3 M80 52 h12 M80 56 l11 3" stroke="#b9895a" stroke-width="1.2" stroke-linecap="round"/>
    <ellipse cx="46" cy="90" rx="8" ry="5" fill="#f6c27c"/><ellipse cx="74" cy="90" rx="8" ry="5" fill="#f6c27c"/>
  </svg>`;
};
