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

  // Rohwert einer APW-Spalte (Kategorie APW_WERT, OCIT-Typname ta/firmware):
  // ein kontinuierlicher Wert, kein Zustand wie bei DET - JEDER Wert (auch
  // "0", ein laut Spezifikation eigener Sonderfall) ist bedeutungstragend,
  // daher wird der Rohwert selbst (getrimmt) als Segment-Kategorie verwendet:
  // ein neues Segment beginnt, sobald sich der Wert ändert. "INV" bekommt
  // eine eigene Kategorie und wird beim Zeichnen ausgefiltert (siehe
  // app.js pushRow). Eine leere Zelle erzeugt gar kein Segment -
  // buildSegments() überspringt leere Rohwerte bereits selbst, und das ist
  // für APW korrekt: leer ("kein Wert") ist ausdrücklich etwas anderes als 0.
  function categorizeApwRaw(raw) {
    const s = String(raw ?? '').trim();
    return s.toUpperCase() === 'INV' ? 'INV' : s;
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

    // APW: je Spalte die Wert-Segmente vorab berechnen (siehe
    // categorizeApwRaw) - analog zu DET, aber ohne die leer->"0"-Umwandlung,
    // da bei APW eine leere Zelle bewusst KEIN Segment erzeugen soll.
    const apwColumns = parsed.otherColumns.filter(c => c.kuerzel === 'APW');
    const apwSegsByCol = new Map();
    apwColumns.forEach(col => {
      apwSegsByCol.set(col.index, buildSegments(parsed.times, parsed.seriesByCol.get(col.index), categorizeApwRaw));
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
      apwColumns,
      apwSegsByCol,
      // Zuordnung DET-/APW-Spalte -> Signalgruppe: { [Spaltenindex]: 'hin' |
      // 'rev' }, vom Nutzer je Signalgruppe vergeben (siehe Setup-Tab). Strikt
      // 1:1 - eine Spalte fehlt hier, wenn sie keiner Richtung zugeordnet ist,
      // und kann nie beiden Richtungen gleichzeitig zugeordnet sein (siehe
      // app.js renderNodeList()/trackPickerHtml).
      assignedTracks: {},
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
