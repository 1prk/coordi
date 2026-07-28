/* Koordinierung – Zustand: Liste der Knoten (je ein importiertes CSV) */
(function (App) {
  'use strict';
  const { uid } = App.utils;
  const { parseOcitText, buildSegments, computeGlobalTU, computeSignalplanRow, computeSplPeriods } = App.parser;

  const intersections = [];

  // Rohwert einer DET-Spalte (Kategorie DETEKTOR, OCIT-Typname single_loop):
  // 0 = frei, 1 = belegt, sonst Belegungsgrad in % (Stufen 1-24...) - für die
  // Diagramm-Überlagerung reicht die binäre Unterscheidung frei/belegt, ob
  // die Anlage nur 0/1 oder einen abgestuften Belegungsgrad liefert.
  function categorizeDetRaw(raw) {
    if (!raw || raw.toUpperCase() === 'INV') return 'UNBEKANNT';
    const num = Number(raw);
    return Number.isFinite(num) ? (num > 0 ? 'BELEGT' : 'FREI') : 'UNBEKANNT';
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
      detSegsByCol.set(col.index, buildSegments(parsed.times, parsed.seriesByCol.get(col.index), categorizeDetRaw));
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
