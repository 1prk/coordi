/* Koordinierung – Zustand: Liste der Knoten (je ein importiertes CSV) */
(function (App) {
  'use strict';
  const { uid } = App.utils;
  const { parseOcitText, buildSegments, computeGlobalTU, computeSignalplanRow, computeSplPeriods } = App.parser;

  const intersections = [];

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
    return {
      id: uid(),
      fileName,
      knotenName: parsed.knotenName,
      knotenNr: parsed.knotenNr,
      columns: parsed.columns,
      planByCol,
      segsByCol,
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

  App.state = { intersections, buildIntersection, addIntersection, removeIntersection, moveIntersection };
})(window.App = window.App || {});
