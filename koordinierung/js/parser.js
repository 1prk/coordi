/* Koordinierung – OCIT-CSV-Import (Format unverändert aus dem
   Signalzeitenplan-Export: Zeile 1-7 Kopf, ab Zeile 8 Messdaten) */
(function (App) {
  'use strict';
  const { median } = App.utils;

  const STATE_CAT = {
    0: 'DUNKEL', 1: 'ROT', 2: 'ROT', 3: 'ROT',
    4: 'GELB', 8: 'GELB', 12: 'GELB',
    15: 'ROTGELB', 16: 'GRUEN', 32: 'GRUEN', 48: 'GRUEN'
  };

  const TYPNAME_TO_KUERZEL = {
    veh: 'SG', tram: 'SG', ped: 'SG', blind: 'SG', cyclist: 'SG', left: 'SG', right: 'SG',
    single_loop: 'DET',
    flasher: 'BLK',
    pt_dir: 'OEPNV',
    ta: 'APW', firmware: 'APW',
    none: 'N/A'
  };

  function looksLikeTimeOnly(s) {
    return /^\d{1,2}:\d{2}:\d{2}$/.test((s || '').trim());
  }

  function parseTimestamp(s) {
    const parts = s.trim().split(/\s+/);
    if (parts.length < 2) throw new Error('Zeitstempel "' + s + '" nicht im Format DD.MM.YY HH:MM:SS');
    const dmy = parts[0].split('.').map(Number);
    const hms = parts[1].split(':').map(Number);
    if (dmy.length < 3 || hms.length < 3 || dmy.some(isNaN) || hms.some(isNaN)) {
      throw new Error('Zeitstempel "' + s + '" nicht lesbar');
    }
    const [dd, mm, yy] = dmy, [hh, mi, ss] = hms;
    const year = yy >= 100 ? yy : 2000 + yy;
    return new Date(year, mm - 1, dd, hh, mi, ss).getTime();
  }

  function extractLabeledValue(row, label) {
    const idx = (row || []).findIndex(v => (v || '').trim().toLowerCase() === label.toLowerCase());
    return idx >= 0 ? (row[idx + 1] || '').trim() : '';
  }

  function findColumnByLabel(header, label) {
    for (const row of header) {
      const idx = (row || []).findIndex(v => (v || '').trim().toUpperCase() === label.toUpperCase());
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function splitLine(l) {
    const delim = l.includes('\t') ? '\t' : ',';
    const out = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (inQuote) {
        if (ch === '"') {
          if (l[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === delim) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function parseOcitText(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
    if (lines.length < 8) {
      throw new Error('Zu wenige Zeilen - erwartet 7 Kopfzeilen + mindestens 1 Messzeile.');
    }
    const rows = lines.map(splitLine);
    const header = rows.slice(0, 7);
    const dataRows = rows.slice(7);
    const nameRow = header[4] || [];
    const beschrRow = header[5] || [];
    const colCount = Math.max(...header.map(r => r.length));

    const knotenName = extractLabeledValue(header[0], 'Longname');
    const knotenNr = extractLabeledValue(header[0], 'No');

    let txCol = findColumnByLabel(header, 'TX');
    if (txCol === -1) txCol = 2;
    let tcCol = findColumnByLabel(header, 'TC');
    if (tcCol === -1) tcCol = 3;
    let splCol = findColumnByLabel(header, 'SP');
    if (splCol === -1) splCol = 4;

    const columns = [];
    const otherColumns = [];
    for (let c = 1; c < colCount; c++) {
      let kuerzel = '', typName = '';
      for (const row of header) {
        const val = (row[c] || '').trim().toLowerCase();
        if (TYPNAME_TO_KUERZEL[val]) {
          kuerzel = TYPNAME_TO_KUERZEL[val];
          typName = val;
          break;
        }
      }
      const name = (nameRow[c] || '').trim() || `Sp.${c + 1}`;
      const beschreibung = (beschrRow[c] || '').trim();
      if (kuerzel === 'SG') {
        columns.push({ index: c, typName, name, beschreibung });
      } else if (kuerzel) {
        otherColumns.push({ index: c, kuerzel, name, beschreibung });
      }
    }
    if (columns.length === 0) {
      throw new Error('Keine Signalgruppen gefunden - kein bekannter OCIT-Typname (z. B. "veh", "ped", "tram") in den Kopfzeilen erkannt.');
    }

    const times = [];
    const allCols = columns.concat(otherColumns);
    const seriesByCol = new Map(allCols.map(c => [c.index, []]));
    const splValues = [];
    const tcValues = [];
    const cycleStarts = [];
    let prevTx = null;
    let lastTc = '', lastSpl = '';
    let skippedRows = 0;
    for (const r of dataRows) {
      if (!r[0] || !r[0].trim()) { skippedRows++; continue; }
      const tsString = looksLikeTimeOnly(r[1]) ? (r[0] + ' ' + r[1]) : r[0];
      let t;
      try { t = parseTimestamp(tsString); } catch (e) { skippedRows++; continue; }
      times.push(t);
      for (const col of allCols) seriesByCol.get(col.index).push((r[col.index] || '').trim());
      const rawTc = (r[tcCol] || '').trim();
      if (rawTc !== '') lastTc = rawTc;
      tcValues.push(lastTc);
      const rawSpl = (r[splCol] || '').trim();
      if (rawSpl !== '') lastSpl = rawSpl;
      splValues.push(lastSpl);
      const txVal = (r[txCol] || '').trim();
      if (txVal === '0' && prevTx !== '0') cycleStarts.push(t);
      if (txVal !== '') prevTx = txVal;
    }
    if (times.length === 0) throw new Error('Keine gültigen Zeitstempel gefunden (Spalte A, ggf. + Spalte B als getrennte Uhrzeit).');

    return { columns, otherColumns, times, seriesByCol, splValues, tcValues, totalRows: dataRows.length, skippedRows, knotenName, knotenNr, cycleStarts };
  }

  function estimateStep(times) {
    if (times.length < 2) return 1000;
    const diffs = [];
    for (let i = 1; i < Math.min(times.length, 200); i++) {
      const d = times[i] - times[i - 1];
      if (d > 0) diffs.push(d);
    }
    return diffs.length ? median(diffs) : 1000;
  }

  function categorizeSgRaw(raw) {
    if (raw.toUpperCase() === 'INV') return 'INV';
    const num = Number(raw);
    return Number.isFinite(num) ? (STATE_CAT[num] ?? 'UNBEKANNT') : 'UNBEKANNT';
  }

  function buildSegments(times, rawValues, catFn) {
    const fn = catFn || categorizeSgRaw;
    const segs = [];
    const step = estimateStep(times);
    const gapThresh = Math.max(step * 5, 5000);
    let curCat = null, curStart = null, prevT = null;
    for (let i = 0; i < rawValues.length; i++) {
      const t = times[i];
      if (prevT !== null && (t - prevT) > gapThresh && curCat !== null) {
        const segEnd = prevT + step;
        segs.push({ cat: curCat, start: curStart, end: segEnd });
        segs.push({ cat: 'LUECKE', start: segEnd, end: t });
        curCat = null; curStart = null;
      }
      prevT = t;
      const raw = rawValues[i];
      if (raw === '') { continue; }
      const cat = fn(raw);
      if (cat !== curCat) {
        if (curCat !== null) segs.push({ cat: curCat, start: curStart, end: t });
        curCat = cat; curStart = t;
      }
    }
    if (curCat !== null) segs.push({ cat: curCat, start: curStart, end: times[times.length - 1] + estimateStep(times) });
    return segs;
  }

  function computeGlobalTU(cycleStarts) {
    if (!cycleStarts || cycleStarts.length < 2) return null;
    const diffs = [];
    for (let i = 1; i < cycleStarts.length; i++) diffs.push((cycleStarts[i] - cycleStarts[i - 1]) / 1000);
    return Math.round(median(diffs));
  }

  function findEnclosingCycleStart(t, cycleStarts) {
    let idx = -1;
    for (let k = 0; k < cycleStarts.length; k++) {
      if (cycleStarts[k] <= t) idx = k; else break;
    }
    return idx >= 0 ? cycleStarts[idx] : null;
  }

  // Typische (Median-)Werte An/Ab/TF einer Signalgruppe, relativ zur
  // System-Umlaufzeit TU und den TX=0-Umlaufgrenzen.
  function computeSignalplanRow(segs, cycleStarts, TU) {
    const ans = [], abs_ = [], tfs = [];
    segs.forEach((g) => {
      if (g.cat !== 'GRUEN') return;
      const csStart = findEnclosingCycleStart(g.start, cycleStarts);
      const csEnd = findEnclosingCycleStart(g.end, cycleStarts);
      if (csStart == null || csEnd == null) return;
      ans.push(Math.round((g.start - csStart) / 1000));
      abs_.push(Math.round((g.end - csEnd) / 1000));
      tfs.push((g.end - g.start) / 1000);
    });
    if (ans.length === 0) return null;
    return {
      an: ((Math.round(median(ans)) % TU) + TU) % TU,
      ab: ((Math.round(median(abs_)) % TU) + TU) % TU,
      tf: Math.round(median(tfs))
    };
  }

  App.parser = {
    parseOcitText, estimateStep, categorizeSgRaw, buildSegments,
    computeGlobalTU, computeSignalplanRow, findEnclosingCycleStart
  };
})(window.App = window.App || {});
