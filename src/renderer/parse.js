'use strict';
// 一行录入：从标题末尾解析时长，例如「写周报 25分」「读论文 1h30」「备课 1.5小时」「散步 半小时」
(function (root) {
  const H = '(?:hours?|hrs?|h|个小时|小时|时)';
  const M = '(?:minutes?|mins?|m|分钟|分)';
  const PRE = '(?<=^|\\s|[^\\x00-\\x7f])';
  const RE_HM = new RegExp(`${PRE}(\\d+(?:\\.\\d+)?)\\s*${H}\\s*(?:(\\d{1,2})\\s*${M}?)?$`, 'i');
  const RE_M = new RegExp(`${PRE}(\\d{1,4})\\s*${M}$`, 'i');
  const RE_HALF = /半个?小时$/;

  function parseQuick(input) {
    const s = String(input || '').trim();
    let m;
    let minutes = null;
    if ((m = RE_HM.exec(s))) minutes = Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
    else if ((m = RE_M.exec(s))) minutes = Number(m[1]);
    else if ((m = RE_HALF.exec(s))) minutes = 30;
    if (!m) return null;
    const title = s.slice(0, m.index).trim();
    if (!title || !(minutes >= 1 && minutes <= 1440)) return null;
    return { title, minutes };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseQuick };
  else root.parseQuick = parseQuick;
})(typeof window !== 'undefined' ? window : globalThis);
