/* Koordinierung – gemeinsame Hilfsfunktionen */
(function (App) {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtTimeShort(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtDateTimeShort(ms) {
    const d = new Date(ms);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${fmtTimeShort(ms)}`;
  }

  // Verstrichene Zeit ab einem Nullpunkt (nicht Uhrzeit) - HH:MM:SS, Stunden
  // laufen über 24 hinaus weiter statt zu wrappen (für lange Aufzeichnungen).
  function fmtElapsed(ms) {
    const sTotal = Math.round(ms / 1000);
    const h = Math.floor(sTotal / 3600), m = Math.floor((sTotal % 3600) / 60), s = sTotal % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

  function median(a) {
    const s = [...a].sort((x, y) => x - y), m = s.length;
    return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function uid() { return Math.random().toString(36).slice(2, 10); }

  App.utils = { esc, pad, fmtTimeShort, fmtDateTimeShort, fmtElapsed, mean, median, clamp, uid };
})(window.App = window.App || {});
