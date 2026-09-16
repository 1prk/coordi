/* Koordinierung – Zustand: Liste der Knoten (je ein importiertes CSV) */
(function (App) {
  'use strict';
  const { uid } = App.utils;
  const { parseOcitText, buildSegments, computeGlobalTU, computeSignalplanRow, computeSplPeriods } = App.parser;

  const intersections = [];

  // Rohwert einer DET- oder APW-Spalte als Segment-Kategorie: der Rohwert
  // selbst (getrimmt), nicht abstrahiert auf ein Zustandspaar wie belegt/
  // frei - ein neues Segment beginnt, sobald sich der Wert ändert. Gilt für
  // beide Spaltentypen gleich (siehe app.js trackPickerHtml/pushRow, die
  // DET und APW bewusst als denselben "Wert-Track" behandeln, nur mit
  // unterschiedlicher Filterung: DET blendet "0"/frei komplett aus, APW
  // zeigt "0" als Sonderfall weiterhin an - Belegungsgrad bei DET kann laut
  // OCIT-Spezifikation ohnehin gestuft sein (0/1 oder Text-Bereiche wie
  // "25-49"), nicht nur binär). "INV" bekommt eine eigene Kategorie und wird
  // in pushRow ausgefiltert. Eine leere Zelle erzeugt gar kein Segment -
  // buildSegments() überspringt leere Rohwerte bereits selbst.
  function categorizeValueRaw(raw) {
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

    // Detektoren (DET): je Spalte die Wert-Segmente vorab berechnen, damit
    // sich einzelne Detektoren später im Diagramm ohne Neuberechnung
    // ein-/ausblenden lassen (siehe app.js trackPickerHtml / diagram.js).
    const detColumns = parsed.otherColumns.filter(c => c.kuerzel === 'DET');
    const detSegsByCol = new Map();
    detColumns.forEach(col => {
      // buildSegments() überspringt Zeilen mit leerem Rohwert stillschweigend
      // (richtig für SG-Spalten, wo eine leere Zelle "keine neue Messung"
      // bedeutet) - für DET ist eine leere Zelle laut Spezifikation aber
      // nicht von "0"/frei unterschieden (anders als bei APW/OEPNV, wo das
      // ausdrücklich zwei verschiedene Bedeutungen sind). Ohne diese
      // Umwandlung würde ein Segment über eine leere Lücke hinweg fälschlich
      // zusammenlaufen, statt bei "0"/frei zu enden.
      const rawSeries = (parsed.seriesByCol.get(col.index) || []).map(v => (v === '' ? '0' : v));
      detSegsByCol.set(col.index, buildSegments(parsed.times, rawSeries, categorizeValueRaw));
    });

    // APW: je Spalte die Wert-Segmente vorab berechnen - analog zu DET,
    // aber ohne die leer->"0"-Umwandlung, da bei APW eine leere Zelle
    // bewusst KEIN Segment erzeugen soll (leer = kein Wert, ausdrücklich
    // etwas anderes als der Wert 0).
    const apwColumns = parsed.otherColumns.filter(c => c.kuerzel === 'APW');
    const apwSegsByCol = new Map();
    apwColumns.forEach(col => {
      apwSegsByCol.set(col.index, buildSegments(parsed.times, parsed.seriesByCol.get(col.index), categorizeValueRaw));
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
