/* Koordinierung – kompaktes Datenpaket je Knoten (Export/Import OHNE die
   ursprüngliche CSV). Eine CSV hat 15-25 MB (ca. 1 Tag @ 1 Hz, viele
   Spalten), das Datenpaket nur wenige hundert KB - weil
   - der Zustand (state.js) nach dem Parsen ohnehin keine Rohwerte mehr hält,
     sondern nur Segmente je Spalte (Ereignisse statt Abtastraster),
   - bewusst nur mitgenommen wird, was Diagramm/Statistik brauchen: die
     gewählten Hauptsignale (Hin/Rück) mit allen Phasen und ALLE DET-/APW-
     Spalten (damit sich die Zuordnung nach dem Import noch ändern lässt) -
     alle übrigen Signalgruppen entfallen (destruktiv, gewollt),
   - DET/APW so gespeichert werden, wie das Diagramm sie bekommt (siehe
     app.js pushRow): DET ohne "0"/frei und "INV", APW ohne "INV". Die
     Lücken dazwischen sind implizit (Abstand zum vorigen Ende) - die weit
     überwiegende Frei-Grundlast der Detektoren kostet so nichts.

   Kodierung (je Knoten, vor gzip): Varints (LEB128, vorzeichenbehaftete
   Werte als ZigZag), Zeit in "Einheiten" = größter gemeinsamer Teiler aller
   Zeitstempel in ms (praktisch immer 1000 = Sekunden, bei ungewöhnlicher
   Abtastrate automatisch feiner - so bleibt die Rekonstruktion exakt). Je
   Segmentliste ein Wörterbuch der vorkommenden Werte (Lookup-Table) und drei
   getrennte Ströme - alle Abstände, alle Dauern, alle Wert-IDs (spaltenweise
   statt zeilenweise: das fängt gzip deutlich besser). Ein tickender
   APW-Countdown (Abstand 1, Dauer 1, Wert -1, ...) braucht dadurch keine
   Sonderbehandlung - gzip reduziert die Wiederholung auf fast nichts.
   Zyklusstarts als Delta-der-Deltas (meist 0, da Umlaufzeit konstant).
   Anschließend gzip (CompressionStream, im Browser eingebaut, auch unter
   file://) und Base64, damit alles in der Export-JSON Platz hat. */
(function (App) {
  'use strict';

  const PACK_VERSION = 1;
  const TEXT_ENC = new TextEncoder();
  const TEXT_DEC = new TextDecoder();

  /* ---------------- Byte-Writer/-Reader (Varint) ---------------- */
  class ByteWriter {
    constructor() { this.buf = new Uint8Array(4096); this.len = 0; }
    byte(b) {
      if (this.len === this.buf.length) {
        const bigger = new Uint8Array(this.buf.length * 2);
        bigger.set(this.buf);
        this.buf = bigger;
      }
      this.buf[this.len++] = b;
    }
    // Unsigned LEB128; Division statt Bit-Operationen, damit auch Werte
    // jenseits von 32 Bit (Zeitstempel in Einheiten) exakt bleiben.
    uvar(n) {
      while (n >= 128) { this.byte((n % 128) | 128); n = Math.floor(n / 128); }
      this.byte(n);
    }
    svar(n) { this.uvar(n < 0 ? -2 * n - 1 : 2 * n); }
    str(s) {
      const b = TEXT_ENC.encode(s);
      this.uvar(b.length);
      for (let i = 0; i < b.length; i++) this.byte(b[i]);
    }
    bytes() { return this.buf.subarray(0, this.len); }
  }

  class ByteReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; }
    byte() {
      if (this.pos >= this.b.length) throw new Error('Datenpaket abgeschnitten oder beschädigt');
      return this.b[this.pos++];
    }
    uvar() {
      let result = 0, mul = 1, b;
      do { b = this.byte(); result += (b & 127) * mul; mul *= 128; } while (b & 128);
      return result;
    }
    svar() { const u = this.uvar(); return u % 2 === 0 ? u / 2 : -(u + 1) / 2; }
    str() {
      const n = this.uvar();
      if (this.pos + n > this.b.length) throw new Error('Datenpaket abgeschnitten oder beschädigt');
      const s = TEXT_DEC.decode(this.b.subarray(this.pos, this.pos + n));
      this.pos += n;
      return s;
    }
  }

  function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

  /* ---------------- Segmentliste: [{<labelKey>, start, end}] ---------------- */
  // Je Eintrag (Abstand zum vorigen Ende, Dauer, Wert-ID) - Abstand/Dauer als
  // ZigZag, damit auch unsortierte/überlappende Rohdaten exakt zurückkommen.
  // Bei lückenlos aneinanderhängenden Segmenten (SG-Phasen) ist der Abstand 0.
  function writeSegList(w, items, labelKey, unit, origin) {
    const dict = [], ids = new Map();
    const idOf = (s) => {
      if (!ids.has(s)) { ids.set(s, dict.length); dict.push(s); }
      return ids.get(s);
    };
    const gaps = [], durs = [], labels = [];
    let prevEnd = origin;
    for (const it of items) {
      const s = Math.round(it.start) / unit, e = Math.round(it.end) / unit;
      gaps.push(s - prevEnd);
      durs.push(e - s);
      labels.push(idOf(String(it[labelKey])));
      prevEnd = e;
    }
    w.uvar(items.length);
    w.uvar(dict.length);
    dict.forEach(d => w.str(d));
    gaps.forEach(v => w.svar(v));
    durs.forEach(v => w.svar(v));
    labels.forEach(v => w.uvar(v));
  }

  function readSegList(r, labelKey, unit, origin) {
    const n = r.uvar();
    const dictSize = r.uvar();
    const dict = [];
    for (let i = 0; i < dictSize; i++) dict.push(r.str());
    const gaps = new Array(n), durs = new Array(n);
    for (let i = 0; i < n; i++) gaps[i] = r.svar();
    for (let i = 0; i < n; i++) durs[i] = r.svar();
    const out = new Array(n);
    let prevEnd = origin;
    for (let i = 0; i < n; i++) {
      const id = r.uvar();
      if (id >= dictSize) throw new Error('Datenpaket beschädigt (ungültiger Wert-Index)');
      const s = prevEnd + gaps[i], e = s + durs[i];
      out[i] = { [labelKey]: dict[id], start: s * unit, end: e * unit };
      prevEnd = e;
    }
    return out;
  }

  /* ---------------- gzip + Base64 ---------------- */
  async function transformBytes(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function toBase64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }
  function fromBase64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- pack / unpack ---------------- */
  // n: Zustandseintrag (siehe state.js). Liefert ein JSON-taugliches Objekt:
  // lesbare Metadaten (Namen, Spalten) + komprimierter Datenblock.
  async function pack(n) {
    // Nur die tatsächlich gewählten Hauptsignale (Hin/Rück, ggf. dieselbe
    // Spalte) - in der Reihenfolge der Original-Spalten.
    const keep = new Set([n.mainColHin, n.mainColRev].filter(c => c != null));
    const sgCols = n.columns.filter(c => keep.has(c.index));
    const detCols = n.detColumns || [], apwCols = n.apwColumns || [];
    // Dieselbe Filterung wie app.js pushRow (siehe dort) - was dort
    // ausgeblendet wird, braucht das Paket nicht.
    const lists = [
      ...sgCols.map(c => n.segsByCol.get(c.index) || []),
      ...detCols.map(c => (n.detSegsByCol.get(c.index) || []).filter(s => s.cat !== '0' && s.cat !== 'INV')),
      ...apwCols.map(c => (n.apwSegsByCol.get(c.index) || []).filter(s => s.cat !== 'INV'))
    ];

    const tMin = Math.round(n.times[0]), tMax = Math.round(n.times[n.times.length - 1]);
    let g = 0;
    const add = (v) => { if (g !== 1) g = gcd(g, Math.abs(Math.round(v))); };
    add(tMin); add(tMax);
    n.cycleStarts.forEach(add);
    n.splPeriods.forEach(p => { add(p.start); add(p.end); });
    lists.forEach(l => l.forEach(s => { add(s.start); add(s.end); }));
    const unit = g > 0 ? g : 1;
    const U = (ms) => Math.round(ms) / unit;
    const origin = U(tMin);

    const w = new ByteWriter();
    w.uvar(unit);
    w.svar(origin);
    w.svar(U(tMax) - origin);
    // Zyklusstarts: Delta der Deltas (Umlaufzeit konstant -> fast nur 0).
    w.uvar(n.cycleStarts.length);
    let prev = origin, prevDelta = 0;
    n.cycleStarts.forEach(c => {
      const u = U(c), delta = u - prev;
      w.svar(delta - prevDelta);
      prev = u; prevDelta = delta;
    });
    writeSegList(w, n.splPeriods, 'spl', unit, origin);
    lists.forEach(l => writeSegList(w, l, 'cat', unit, origin));

    let encoding = 'base64', payload = w.bytes();
    if (typeof CompressionStream === 'function') {
      payload = await transformBytes(payload, new CompressionStream('gzip'));
      encoding = 'gzip+base64';
    }
    return {
      v: PACK_VERSION,
      knotenName: n.knotenName,
      knotenNr: n.knotenNr,
      columns: sgCols.map(c => ({ ...c })),
      detColumns: detCols.map(c => ({ ...c })),
      apwColumns: apwCols.map(c => ({ ...c })),
      encoding,
      data: toBase64(payload)
    };
  }

  // Gegenstück zu pack(): liefert die Teile für state.restoreIntersection().
  async function unpack(p) {
    if (!p || typeof p.data !== 'string') throw new Error('Datenpaket fehlt');
    if (p.v !== PACK_VERSION) throw new Error(`Datenpaket-Version ${p.v} wird nicht unterstützt`);
    if (p.encoding !== 'gzip+base64' && p.encoding !== 'base64') throw new Error(`Unbekannte Datenpaket-Kodierung "${p.encoding}"`);
    if (p.encoding === 'gzip+base64' && typeof DecompressionStream !== 'function') throw new Error('Dieser Browser kann gzip nicht entpacken (DecompressionStream fehlt)');
    // base64/gzip melden Beschädigungen nur mit technischen Meldungen
    // ("Failed to fetch", "InvalidCharacterError") - hier verständlich machen.
    let bytes;
    try {
      bytes = fromBase64(p.data);
      if (p.encoding === 'gzip+base64') bytes = await transformBytes(bytes, new DecompressionStream('gzip'));
    } catch (e) {
      throw new Error('Datenpaket beschädigt (Entpacken fehlgeschlagen)');
    }
    const r = new ByteReader(bytes);
    const unit = r.uvar();
    const origin = r.svar();
    const tMaxU = origin + r.svar();
    const cycleStarts = [];
    const nCycles = r.uvar();
    let prev = origin, prevDelta = 0;
    for (let i = 0; i < nCycles; i++) {
      const delta = prevDelta + r.svar();
      prev += delta; prevDelta = delta;
      cycleStarts.push(prev * unit);
    }
    const splPeriods = readSegList(r, 'spl', unit, origin);
    const columns = p.columns || [], detColumns = p.detColumns || [], apwColumns = p.apwColumns || [];
    const segsByCol = new Map(), detSegsByCol = new Map(), apwSegsByCol = new Map();
    columns.forEach(c => segsByCol.set(c.index, readSegList(r, 'cat', unit, origin)));
    detColumns.forEach(c => detSegsByCol.set(c.index, readSegList(r, 'cat', unit, origin)));
    apwColumns.forEach(c => apwSegsByCol.set(c.index, readSegList(r, 'cat', unit, origin)));
    return {
      knotenName: p.knotenName, knotenNr: p.knotenNr,
      columns, segsByCol, detColumns, detSegsByCol, apwColumns, apwSegsByCol,
      // Nur erster/letzter Zeitstempel (= Aufzeichnungsbereich) - mehr nutzt
      // die App von der Zeitreihe nach dem Parsen nicht (siehe app.js collectRows).
      times: [origin * unit, tMaxU * unit],
      cycleStarts, splPeriods
    };
  }

  App.datapack = { pack, unpack, PACK_VERSION };
})(window.App = window.App || {});
