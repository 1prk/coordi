/* Koordinierung – Zustand: Liste der Knoten (je ein importiertes CSV) */
(function (App) {
  'use strict';
  const { uid } = App.utils;
  const { parseOcitText, buildSegments, computeGlobalTU, computeSignalplanRow, computeSplPeriods } = App.parser;

  const intersections = [];

  // Rohwert einer DET-Spalte (Kategorie DETEKTOR, OCIT-Typname single_loop):
  // 0 = frei, 1 = belegt, sonst Belegungsgrad in % (Stufen 1-24, 25-49,
  // 50-74, 75-99, >=100) - für die Diagramm-Überlagerung reicht die binäre
  // Unterscheidung frei/belegt, unabhängig davon, ob die Anlage nur 0/1
  // liefert oder einen abgestuften Belegungsgrad. Der Belegungsgrad kann
  // dabei entweder als Zahl (z. B. Prozentwert oder Stufen-Code) ODER als
  // Text-Bereich (z. B. "25-49") vorliegen - im zweiten Fall ist der Wert
  // nicht mit Number() parsbar, gilt aber trotzdem als belegt, solange er
  // nicht leer/"0"/"INV" ist.
  function categorizeDetRaw(raw) {
    const s = String(raw ?? '').trim();
    if (!s || s.toUpperCase() === 'INV') return 'UNBEKANNT';
    if (s === '0') return 'FREI';
    const num = Number(s);
    if (Number.isFinite(num)) return num > 0 ? 'BELEGT' : 'FREI';
    return 'BELEGT';
  }

  // Baut aus Rohtext (eine CSV-Datei = ein Knoten) einen Zustandseintrag.
  // Neben dem Gesamt-Mitschnitt-Plan (planByCol) bleiben times/splValues/
  // cycleStarts sowie die Segmente je Spalte (segsByCol) erhalten, damit sich
  // ein Plan später auch auf ein Zeitfenster (z. B. den Geltungszeitraum
  // eines einzelnen Signalzeitenplans) einschränken lässt - siehe
  // app.js/planForNode.
  function buildIntersection(fileName, text) {
    const parsed = parseOcitText(text);
    const TU = computeGlobalTU(parsed.cycleStarts);
    const segsByCol = new Map();
    const planByCol = new Map();
    parsed.columns.forEach(col => {
      const segs = buildSegments(parsed.times, parsed.seriesByCol.get(col.index));
      segsByCol.set(col.index, segs);
      const plan = TU ? computeSignalplanRow(segs, parsed.cycleStarts, TU) : null;
      planByCol.set(col.index, plan);
    });
    const splPeriods = computeSplPeriods(parsed.times, parsed.splValues);
    const defaultCol = parsed.columns.find(c => planByCol.get(c.index))?.index ?? null;

    // Detektoren (DET): je Spalte die belegt/frei-Segmente vorab berechnen,
    // damit sich einzelne Detektoren später im Diagramm ohne Neuberechnung
    // ein-/ausblenden lassen (siehe app.js onDetToggle / diagram.js).
    const detColumns = parsed.otherColumns.filter(c => c.kuerzel === 'DET');
    const detSegsByCol = new Map();
    detColumns.forEach(col => {
      // buildSegments() überspringt Zeilen mit leerem Rohwert stillschweigend
      // (richtig für SG-Spalten, wo eine leere Zelle "keine neue Messung"
      // bedeutet) - für DET ist eine leere Zelle laut Spezifikation aber
      // nicht von "0"/frei unterschieden (anders als bei APW/OEPNV, wo das
      // ausdrücklich zwei verschiedene Bedeutungen sind). Ohne diese
      // Umwandlung würde ein belegt-Segment über eine leere Lücke hinweg
      // fälschlich zusammenlaufen, statt bei "frei" zu enden.
      const rawSeries = (parsed.seriesByCol.get(col.index) || []).map(v => (v === '' ? '0' : v));
      detSegsByCol.set(col.index, buildSegments(parsed.times, rawSeries, categorizeDetRaw));
    });

    return {
      id: uid(),
      fileName,
      knotenName: parsed.knotenName,
      knotenNr: parsed.knotenNr,
      columns: parsed.columns,
      planByCol,
      segsByCol,
      detColumns,
      detSegsByCol,
      // Indizes der DET-Spalten, die im Diagramm an diesem Knoten überlagert
      // werden sollen (vom Nutzer je Knoten ausgewählt, siehe Setup-Tab).
      selectedDet: [],
      times: parsed.times,
      cycleStarts: parsed.cycleStarts,
      splPeriods,
      TU,
      mainColHin: defaultCol,
      mainColRev: defaultCol,
      distanceHin: 0,
      distanceRev: 0,
      // Nur relevant, wenn dieser Knoten der letzte in der Liste ist: Versatz
      // [m] zwischen der Rück- und der Hin-Signalgruppe an diesem Knoten
      // (z. B. versetzte Haltlinien) - verankert die sonst eigenständige
      // Rückrichtungs-Stationierung auf der Hinrichtungs-Achse.
      revOffset: 0,
      // Vorgeschlagene Progressionsgeschwindigkeit [km/h] je Abschnitt (zur
      // vorherigen Karte in Hin-, zur nächsten Karte in Rück-Richtung) -
      // bestimmt das Grünband für genau diesen Abschnitt.
      vpHin: 50,
      vpRev: 50
    };
  }

  function addIntersection(entry) { intersections.push(entry); }
  function removeIntersection(id) {
    const i = intersections.findIndex(x => x.id === id);
    if (i >= 0) intersections.splice(i, 1);
  }
  function moveIntersection(id, dir) {
    const i = intersections.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= intersections.length) return;
    [intersections[i], intersections[j]] = [intersections[j], intersections[i]];
  }
  function clearIntersections() { intersections.length = 0; }

  App.state = {
    intersections, buildIntersection, addIntersection, removeIntersection, moveIntersection,
    clearIntersections
  };
})(window.App = window.App || {});
