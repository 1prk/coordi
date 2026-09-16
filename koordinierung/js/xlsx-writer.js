/* Minimaler, abhängigkeitsfreier XLSX-Writer (schreibt ein ungestyltes
   OOXML-Workbook direkt als ZIP - keine externe Library nötig, funktioniert
   daher auch unter file://, genau wie der Rest der App). Deckt bewusst nur
   das ab, was die Exporte hier brauchen: mehrere Blätter aus einfachen
   Zeilen (Array aus Arrays), Zellen als Zahl/Text/Bool/leer - keine
   Formatierung, keine Formeln, keine Shared-Strings-Tabelle (inline
   Strings genügen für diese Datenmengen). */
(function (App) {
  'use strict';

  function crcTable() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }
  const CRC_TABLE = crcTable();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
    return { time, date };
  }

  // ZIP im "store"-Verfahren (unkomprimiert) - gültiges ZIP/XLSX, spart aber
  // eine Deflate-Implementierung; bei den hier erzeugten Dateigrößen
  // irrelevant für die Downloadgröße.
  function buildZip(files) {
    const { time, date } = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    files.forEach(f => {
      const nameBytes = f.nameBytes;
      const data = f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    });

    const centralStart = offset;
    const centralSize = centralParts.reduce((a, c) => a + c.length, 0);

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);

    return new Blob([...localParts, ...centralParts, end], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  }

  function colLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function cellXml(value, colIdx, rowIdx) {
    const ref = colLetter(colIdx) + rowIdx;
    if (value == null || value === '') return `<c r="${ref}"/>`;
    if (typeof value === 'number' && isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }

  function sheetXml(rows) {
    let body = '';
    rows.forEach((row, ri) => {
      let cells = '';
      row.forEach((val, ci) => { cells += cellXml(val, ci + 1, ri + 1); });
      body += `<row r="${ri + 1}">${cells}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${body}</sheetData></worksheet>`;
  }

  // Blattnamen: Excel erlaubt max. 31 Zeichen und keine [ ] * ? / \ : -
  // reale Knotennamen können z. B. "/" enthalten (siehe D3-Diagramm-Footer),
  // daher hier ersetzen statt anzunehmen, dass Namen schon "sauber" sind.
  function safeSheetName(name, used) {
    let base = String(name).replace(/[[\]*?/\\:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let n = base, i = 2;
    while (used.has(n)) {
      const suffix = ` (${i})`;
      n = base.slice(0, 31 - suffix.length) + suffix;
      i++;
    }
    used.add(n);
    return n;
  }

  function buildWorkbook(sheets) {
    const used = new Set();
    const names = sheets.map(s => safeSheetName(s.name, used));

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      `</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      `</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `</Relationships>`;

    const enc = new TextEncoder();
    const toFile = (name, xml) => ({ nameBytes: enc.encode(name), data: enc.encode(xml) });
    const files = [
      toFile('[Content_Types].xml', contentTypes),
      toFile('_rels/.rels', rootRels),
      toFile('xl/workbook.xml', workbookXml),
      toFile('xl/_rels/workbook.xml.rels', workbookRels)
    ];
    sheets.forEach((s, i) => files.push(toFile(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))));
    return buildZip(files);
  }

  // sheets: [{ name, rows }], rows[0] = Kopfzeile, Zellen: string|number|boolean|null.
  function download(filename, sheets) {
    const blob = buildWorkbook(sheets);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  App.xlsxWriter = { download };
})(window.App = window.App || {});
