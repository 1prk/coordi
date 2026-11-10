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
    const segsByCol = new Map();
    parsed.columns.forEach(col => {
      segsByCol.set(col.index, buildSegments(parsed.times, parsed.seriesByCol.get(col.index)));
    });
    const splPeriods = computeSplPeriods(parsed.times, parsed.splValues);

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

    return assembleIntersection(fileName, {
      knotenName: parsed.knotenName,
      knotenNr: parsed.knotenNr,
      columns: parsed.columns,
      segsByCol,
      detColumns,
      detSegsByCol,
      apwColumns,
      apwSegsByCol,
      times: parsed.times,
      cycleStarts: parsed.cycleStarts,
      splPeriods
    });
  }

  // Aus einem Datenpaket (App.datapack.unpack, Import ohne CSV) - dieselbe
  // Struktur wie buildIntersection, nur sind columns/detColumns/apwColumns
  // auf das beschränkt, was der Export mitgenommen hat, und times enthält
  // nur den ersten und letzten Zeitstempel.
  function restoreIntersection(fileName, parts) {
    return assembleIntersection(fileName, parts);
  }

  // Gemeinsamer Aufbau des Knoteneintrags aus bereits segmentierten Daten:
  // leitet Umlaufzeit, Signalplan je Spalte (planByCol) und die Standard-
  // Hauptsignal-Wahl ab. Beide Wege (CSV und Datenpaket) laufen hier durch,
  // damit die abgeleiteten Werte identisch berechnet werden.
  function assembleIntersection(fileName, p) {
    const TU = computeGlobalTU(p.cycleStarts);
    const planByCol = computePlans(p.columns, p.segsByCol, p.cycleStarts, TU);
    const defaultCol = p.columns.find(c => planByCol.get(c.index))?.index ?? null;
    return {
      id: uid(),
      fileName,
      knotenName: p.knotenName,
      knotenNr: p.knotenNr,
      columns: p.columns,
      planByCol,
      segsByCol: p.segsByCol,
      detColumns: p.detColumns,
      detSegsByCol: p.detSegsByCol,
      apwColumns: p.apwColumns,
      apwSegsByCol: p.apwSegsByCol,
      // Zuordnung DET-/APW-Spalte -> Signalgruppe: { [Spaltenindex]: 'hin' |
      // 'rev' }, vom Nutzer je Signalgruppe vergeben (siehe Setup-Tab). Strikt
      // 1:1 - eine Spalte fehlt hier, wenn sie keiner Richtung zugeordnet ist,
      // und kann nie beiden Richtungen gleichzeitig zugeordnet sein (siehe
      // app.js renderNodeList()/trackPickerHtml).
      assignedTracks: {},
      times: p.times,
      cycleStarts: p.cycleStarts,
      // Umlaufbeginne aus der Datei (TX=0). Bleiben unverändert, wenn der
      // Nutzer t_U von Hand setzt (setManualCycle) - so lässt sich die
      // Handeingabe wieder zurücknehmen, und der Export (app.js exportConfig)
      // legt diese Werte ins Datenpaket statt der berechneten.
      autoCycleStarts: p.cycleStarts,
      // Handeingabe { tu [s], anchorSec [s seit Mitternacht] | null } oder
      // null = automatisch aus TX. Siehe setManualCycle.
      manualCycle: null,
      splPeriods: p.splPeriods,
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

  // Signalplan (An/Ab/TF) je Signalgruppen-Spalte; null, wenn es keine TU gibt
  // oder die Spalte keine verwertbare Grünphase hat.
  function computePlans(columns, segsByCol, cycleStarts, TU) {
    const planByCol = new Map();
    columns.forEach(col => {
      planByCol.set(col.index, TU ? computeSignalplanRow(segsByCol.get(col.index), cycleStarts, TU) : null);
    });
    return planByCol;
  }

  // Umlaufbeginne im festen Raster anchor + k * TU, die die ganze Aufnahme
  // abdecken: der erste Beginn liegt höchstens auf dem ersten Zeitstempel,
  // der letzte nach dem letzten - damit gibt es immer mindestens zwei und
  // findEnclosingCycleStart() findet für jede Zeit einen Umlaufbeginn.
  function gridCycleStarts(tFirst, tLast, tuMs, anchorMs) {
    const k0 = Math.floor((tFirst - anchorMs) / tuMs);
    const out = [];
    for (let t = anchorMs + k0 * tuMs; ; t += tuMs) {
      out.push(t);
      if (t > tLast) break;
    }
    return out;
  }

  // Für CSV-Dateien aus alten Steuergeräten ohne TX-Spalte: Umlaufzeit tu [s]
  // und optional die Uhrzeit eines Umlaufbeginns anchorSec [s seit Mitternacht
  // des ersten Aufnahmetags] von Hand vorgeben. Ohne Anker beginnt das Raster
  // am ersten Zeitstempel. tu leer/0 = Handeingabe zurücknehmen (zurück auf
  // die TX-Werte aus der Datei). Setzt Umlaufbeginne, TU, Signalpläne und
  // - falls noch keine gültige Wahl da ist - die Hauptsignale neu.
  // Liefert false, wenn tu ungültig ist (dann bleibt alles unverändert).
  function setManualCycle(node, tu, anchorSec) {
    const hasTu = Number.isFinite(tu) && tu > 0;
    if (tu && !(hasTu && tu <= 3600)) return false;
    if (hasTu) {
      const tFirst = node.times[0], tLast = node.times[node.times.length - 1];
      const tuMs = Math.round(tu) * 1000;
      let anchorMs = tFirst;
      if (Number.isFinite(anchorSec)) {
        const day = new Date(tFirst);
        day.setHours(0, 0, 0, 0);
        anchorMs = day.getTime() + Math.round(anchorSec) * 1000;
      }
      node.cycleStarts = gridCycleStarts(tFirst, tLast, tuMs, anchorMs);
      node.TU = Math.round(tu);
      node.manualCycle = { tu: Math.round(tu), anchorSec: Number.isFinite(anchorSec) ? Math.round(anchorSec) : null };
    } else {
      node.cycleStarts = node.autoCycleStarts;
      node.TU = computeGlobalTU(node.cycleStarts);
      node.manualCycle = null;
    }
    node.planByCol = computePlans(node.columns, node.segsByCol, node.cycleStarts, node.TU);
    const defaultCol = node.columns.find(c => node.planByCol.get(c.index))?.index ?? null;
    if (node.mainColHin == null || !node.planByCol.get(node.mainColHin)) node.mainColHin = defaultCol;
    if (node.mainColRev == null || !node.planByCol.get(node.mainColRev)) node.mainColRev = defaultCol;
    return true;
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
    intersections, buildIntersection, restoreIntersection, addIntersection, removeIntersection, moveIntersection,
    clearIntersections, setManualCycle
  };
})(window.App = window.App || {});
