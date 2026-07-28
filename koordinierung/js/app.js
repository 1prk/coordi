/* Koordinierung – UI-Verdrahtung */
(function (App) {
  'use strict';
  const { esc, fmtDateTimeShort, clamp } = App.utils;
  const { deriveVp, teilpunktabstand, lageLabel, computeQualitativeBand, computeOptimumBand } = App.coordination;
  const { renderDiagram } = App.diagram;
  const state = App.state;

  // Vom Diagramm zurückgegebene API (aktuelles renderDiagram-Ergebnis) -
  // erlaubt Sprünge zu einem bestimmten Zeitpunkt aus der Umlaufübersicht
  // heraus, ohne dass der Diagramm-Code selbst vom App-Code wissen muss.
  let diagramApi = null;

  // Y-Achsen-Zoom: 1 = Basisstufe (~3 Umläufe sichtbar), >1 näher heran, <1
  // weiter heraus. Wird als Faktor an renderDiagram gereicht (dort mit der
  // Basis-Pixel/Sekunde-Rate multipliziert) - Wert bleibt über Neu-Rendern
  // hinweg erhalten (Modul-Variable, nicht Teil des Diagramm-DOM-Zustands).
  let zoomLevel = 1;
  const ZOOM_MIN = 0.1, ZOOM_MAX = 30, ZOOM_STEP = 1.4;
  function setZoom(next) {
    zoomLevel = clamp(next, ZOOM_MIN, ZOOM_MAX);
    recompute();
  }

  // Filter der Umlaufübersicht-Tabelle (unterhalb des Diagramms):
  // 'all' | 'ja' (nur durchgefahrene Umläufe) | 'nein' (nur gescheiterte).
  let umlaufFilter = 'all';

  // Aktiver Tab: 'setup' | 'diagram' | 'stats'. Start bei 'setup', da die App
  // (anders als die Referenz) ohne vorgeladene Beispieldaten startet - ein
  // leerer Diagramm-Tab wäre der falsche erste Eindruck.
  let currentTab = 'setup';

  const els = {
    tabLinks: document.querySelectorAll('.nav-tab-link'),
    tabSetup: document.getElementById('tabSetup'),
    tabDiagram: document.getElementById('tabDiagram'),
    tabStats: document.getElementById('tabStats'),
    btnAddFile: document.getElementById('btnAddFile'),
    fileInput: document.getElementById('fileInput'),
    btnExport: document.getElementById('btnExport'),
    btnImport: document.getElementById('btnImport'),
    importInput: document.getElementById('importInput'),
    dirSelect: document.getElementById('dirSelect'),
    bandQualitativeInput: document.getElementById('bandQualitativeInput'),
    bandOptimumInput: document.getElementById('bandOptimumInput'),
    baseStationInput: document.getElementById('baseStationInput'),
    showTimestampInput: document.getElementById('showTimestampInput'),
    errorBox: document.getElementById('errorBox'),
    nodeList: document.getElementById('nodeList'),
    hintBox: document.getElementById('hintBox'),
    kpiPanel: document.getElementById('kpiPanel'),
    kpiGrid: document.getElementById('kpiGrid'),
    diagramPanel: document.getElementById('diagramPanel'),
    diagramInfo: document.getElementById('diagramInfo'),
    diagram: document.getElementById('diagram'),
    tablePanel: document.getElementById('tablePanel'),
    tableBody: document.getElementById('tableBody'),
    kmPanel: document.getElementById('kmPanel'),
    kmFrom1: document.getElementById('kmFrom1'),
    kmTo1: document.getElementById('kmTo1'),
    kmResult1: document.getElementById('kmResult1'),
    kmFrom2: document.getElementById('kmFrom2'),
    kmTo2: document.getElementById('kmTo2'),
    kmResult2: document.getElementById('kmResult2'),
    statsPanel: document.getElementById('statsPanel'),
    statsBody: document.getElementById('statsBody'),
    umlaufPanel: document.getElementById('umlaufPanel'),
    umlaufBody: document.getElementById('umlaufBody'),
    umlaufFilterSeg: document.getElementById('umlaufFilterSeg'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    zoomResetBtn: document.getElementById('zoomResetBtn'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    zoomLabel: document.getElementById('zoomLabel'),
  };

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.style.display = 'block';
  }
  function clearError() {
    els.errorBox.style.display = 'none';
    els.errorBox.textContent = '';
  }
  function showHint(msg) {
    els.hintBox.textContent = msg;
    els.hintBox.style.display = msg ? 'block' : 'none';
  }
  function hidePanels() {
    els.kpiPanel.style.display = 'none';
    els.diagramPanel.style.display = 'none';
    els.tablePanel.style.display = 'none';
    els.statsPanel.style.display = 'none';
    els.umlaufPanel.style.display = 'none';
    els.kmPanel.style.display = 'none';
  }

  /* ---------------- Tabs (Setup / Diagramm / Statistik) ---------------- */
  const TAB_CONTENT = { setup: els.tabSetup, diagram: els.tabDiagram, stats: els.tabStats };
  function setTab(tab) {
    currentTab = tab;
    Object.keys(TAB_CONTENT).forEach(t => { TAB_CONTENT[t].style.display = t === tab ? '' : 'none'; });
    els.tabLinks.forEach(a => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // Das Diagramm misst beim Rendern die Breite seines Containers - während
    // der Diagramm-Tab per display:none verborgen ist, liefert das 0 (Fallback
    // auf eine feste Breite). Ein Wechsel auf diesen Tab macht den Container
    // erst sichtbar, daher hier neu rendern, damit die volle Breite genutzt wird.
    if (tab === 'diagram') recompute();
  }
  els.tabLinks.forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); setTab(a.dataset.tab); }));

  // Beim Import einer Konfigurations-JSON zwischengespeichert, bis die
  // dazugehörigen CSV-Dateien (erneut) ausgewählt wurden - siehe
  // "Konfiguration exportieren/importieren" unten.
  let pendingImport = null;

  /* ---------------- Datei-Import ---------------- */
  els.btnAddFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    const importCtx = pendingImport;
    pendingImport = null;
    if (importCtx) state.clearIntersections();

    for (const file of files) {
      try {
        const text = await file.text();
        const entry = state.buildIntersection(file.name, text);
        if (importCtx) {
          const saved = importCtx.nodes.find(n => n.fileName === file.name);
          if (saved) {
            if (saved.mainColHin != null) entry.mainColHin = saved.mainColHin;
            if (saved.mainColRev != null) entry.mainColRev = saved.mainColRev;
            entry.distanceHin = Number(saved.distanceHin) || 0;
            entry.distanceRev = Number(saved.distanceRev) || 0;
            entry.revOffset = Number(saved.revOffset) || 0;
            entry.vpHin = Number(saved.vpHin) || 50;
            entry.vpRev = Number(saved.vpRev) || 50;
          }
        }
        state.addIntersection(entry);
        clearError();
      } catch (e) {
        showError(`${file.name}: ${e.message}`);
      }
    }

    if (importCtx) {
      // Reihenfolge der gespeicherten Konfiguration wiederherstellen (die
      // Auswahlreihenfolge im Datei-Dialog des Betriebssystems ist nicht
      // garantiert dieselbe) - Knoten, deren Datei nicht mit ausgewählt
      // wurde, fehlen und werden gemeldet; zusätzlich ausgewählte, nicht in
      // der Konfiguration enthaltene Dateien werden ans Ende angehängt.
      const orderedNames = importCtx.nodes.map(n => n.fileName);
      const current = state.intersections.slice();
      const reordered = [];
      orderedNames.forEach(fn => {
        const idx = current.findIndex(n => n.fileName === fn && !reordered.includes(n));
        if (idx >= 0) reordered.push(current[idx]);
      });
      current.forEach(n => { if (!reordered.includes(n)) reordered.push(n); });
      state.clearIntersections();
      reordered.forEach(n => state.addIntersection(n));

      if (importCtx.settings) {
        els.baseStationInput.value = importCtx.settings.baseStation ?? 0;
        els.dirSelect.value = importCtx.settings.dirMode ?? 'both';
        els.bandQualitativeInput.checked = !!importCtx.settings.showQualitative;
        els.bandOptimumInput.checked = !!importCtx.settings.showOptimum;
        els.showTimestampInput.checked = !!importCtx.settings.showTimestamp;
      }
      const missing = orderedNames.filter(fn => !reordered.some(n => n.fileName === fn));
      renderNodeList();
      recompute();
      // NACH recompute() gesetzt (nicht showHint) - recompute() überschreibt
      // den Hinweis-Kasten am Ende immer mit seinen eigenen Meldungen; die
      // Fehlerbox bleibt davon unberührt, daher hier für die
      // Import-spezifische Meldung verwendet.
      if (missing.length) {
        showError(`Import unvollständig: ${missing.length} Datei(en) aus der Konfiguration wurden nicht ausgewählt und fehlen: ${missing.join(', ')}`);
      }
      return;
    }

    renderNodeList();
    recompute();
  });

  /* ---------------- Konfiguration exportieren/importieren ---------------- */
  // Rein clientseitig, kein Netzwerkzugriff (kein CORS-Risiko), läuft daher
  // identisch unter file://. Der Export enthält NICHT die CSV-Rohdaten
  // selbst - nur den Dateinamen je Knoten plus alle Einstellungen
  // (Abstände, V_p, Hauptsignal-Wahl, Basis-Station, Anzeigeoptionen). Beim
  // Import müssen die referenzierten CSV-Dateien daher erneut ausgewählt
  // werden (der Browser kann aus Sicherheitsgründen nicht selbst auf
  // Dateipfade zugreifen) - die Einstellungen werden dann anhand des
  // Dateinamens wieder zugeordnet.
  function exportConfig() {
    const data = {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      settings: {
        baseStation: Number(els.baseStationInput.value) || 0,
        dirMode: els.dirSelect.value,
        showQualitative: els.bandQualitativeInput.checked,
        showOptimum: els.bandOptimumInput.checked,
        showTimestamp: els.showTimestampInput.checked
      },
      nodes: state.intersections.map(n => ({
        fileName: n.fileName,
        mainColHin: n.mainColHin,
        mainColRev: n.mainColRev,
        distanceHin: n.distanceHin,
        distanceRev: n.distanceRev,
        revOffset: n.revOffset,
        vpHin: n.vpHin,
        vpRev: n.vpRev
      }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `koordinierung-config-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  els.btnExport.addEventListener('click', exportConfig);
  els.btnImport.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files && els.importInput.files[0];
    els.importInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      showError(`Import fehlgeschlagen: ${e.message}`);
      return;
    }
    if (!data || !Array.isArray(data.nodes)) {
      showError('Import fehlgeschlagen: Datei enthält keine gültige Koordinierung-Konfiguration.');
      return;
    }
    pendingImport = data;
    showHint(`Konfiguration geladen (${data.nodes.length} Knoten). Bitte jetzt dieselben CSV-Dateien erneut auswählen: ${data.nodes.map(n => n.fileName).join(', ')}`);
    els.fileInput.click();
  });

  /* ---------------- Knotenliste ---------------- */
  function sigOptions(n, selectedCol) {
    return n.columns.map(c => {
      const hasGreen = !!n.planByCol.get(c.index);
      return `<option value="${c.index}" ${!hasGreen ? 'disabled' : ''} ${c.index === selectedCol ? 'selected' : ''}>${esc(c.name)}${hasGreen ? '' : ' ✕'}</option>`;
    }).join('');
  }

  function renderNodeList() {
    const nodes = state.intersections;
    if (nodes.length === 0) {
      els.nodeList.innerHTML = '<div class="node-empty">Noch keine Knoten – über "+ Knoten hinzufügen" eine OCIT-CSV je Knoten hinzufügen.</div>';
      hidePanels();
      showHint('');
      return;
    }
    els.nodeList.innerHTML = nodes.map((n, i) => {
      const label = n.knotenName || n.fileName;
      const sub = n.knotenNr ? ` <span class="tag tag-neutral">Nr. ${esc(n.knotenNr)}</span>` : '';
      // "Abstand Hin" auf Karte i = Abstand zur vorherigen Karte (deaktiviert
      // an Karte 0, kein Vorgänger). "Abstand Rück" ist dasselbe gespiegelt:
      // die Rückrichtung durchläuft die Liste von hinten nach vorn, ihr
      // "vorheriger" Knoten auf Karte i ist daher Karte i+1 - deaktiviert
      // (kein Nachfolger) an der LETZTEN Karte. Dort steht stattdessen
      // "Versatz Rück": der Positionsunterschied zwischen Rück- und
      // Hin-Signalgruppe an diesem Knoten, der einzige Ankerpunkt, der die
      // eigenständige Rück-Stationierung auf dieselbe Achse wie Hin legt.
      const hinDisabled = i === 0;
      const isLast = i === nodes.length - 1;
      const distHin = hinDisabled ? 0 : n.distanceHin;
      const distRev = isLast ? 0 : n.distanceRev;
      const vpHinField = hinDisabled ? '' : `<div class="field">
            <label>V_p Hin [km/h]</label>
            <input class="input node-vp-hin" type="number" min="1" step="1" value="${n.vpHin || 50}">
          </div>`;
      const revOffsetField = isLast
        ? `<div class="field">
            <label>Versatz Rück [m]</label>
            <input class="input node-rev-offset" type="number" step="1" value="${n.revOffset || 0}" title="Positionsunterschied der Rück- zur Hin-Signalgruppe an diesem (letzten) Knoten">
          </div>`
        : `<div class="field">
            <label>Abstand Rück [m]</label>
            <input class="input node-dist-rev" type="number" min="0" step="10" value="${distRev}">
          </div>
          <div class="field">
            <label>V_p Rück [km/h]</label>
            <input class="input node-vp-rev" type="number" min="1" step="1" value="${n.vpRev || 50}">
          </div>`;
      return `<div class="node-card card elev-sm" data-id="${n.id}">
        <div class="node-card-head">
          <div class="node-order">
            <button type="button" class="btn btn-secondary btn-icon node-up" ${i === 0 ? 'disabled' : ''} title="nach oben">▲</button>
            <button type="button" class="btn btn-secondary btn-icon node-down" ${i === nodes.length - 1 ? 'disabled' : ''} title="nach unten">▼</button>
          </div>
          <div class="node-main">
            <div class="node-title">${esc(label)}${sub}</div>
            <div class="node-file">${esc(n.fileName)} · t_U ${n.TU ?? '–'} s</div>
          </div>
          <button type="button" class="btn btn-ghost node-remove" title="entfernen">Entfernen ✕</button>
        </div>
        <div class="node-dirs">
          <div>
            <div class="tag tag-neutral">Hinrichtung</div>
            <div class="node-dir-fields">
              <div class="field field-wide">
                <label>Hauptsignal</label>
                <select class="input node-sig-select node-sig-hin">${sigOptions(n, n.mainColHin)}</select>
              </div>
              <div class="field">
                <label>Abstand [m]</label>
                <input class="input node-dist-hin" type="number" min="0" step="10" value="${distHin}" ${hinDisabled ? 'disabled' : ''}>
              </div>
              ${vpHinField}
            </div>
          </div>
          <div>
            <div class="tag tag-accent">Gegenrichtung</div>
            <div class="node-dir-fields">
              <div class="field field-wide">
                <label>Hauptsignal</label>
                <select class="input node-sig-select node-sig-rev">${sigOptions(n, n.mainColRev)}</select>
              </div>
              ${revOffsetField}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    els.nodeList.querySelectorAll('.node-card').forEach(card => {
      const id = card.dataset.id;
      const node = nodes.find(n => n.id === id);
      card.querySelector('.node-sig-hin').addEventListener('change', (e) => { node.mainColHin = Number(e.target.value); recompute(); });
      card.querySelector('.node-sig-rev').addEventListener('change', (e) => { node.mainColRev = Number(e.target.value); recompute(); });
      card.querySelector('.node-dist-hin').addEventListener('change', (e) => { node.distanceHin = Number(e.target.value) || 0; recompute(); });
      const distRevInput = card.querySelector('.node-dist-rev');
      if (distRevInput) distRevInput.addEventListener('change', (e) => { node.distanceRev = Number(e.target.value) || 0; recompute(); });
      const vpHinInput = card.querySelector('.node-vp-hin');
      if (vpHinInput) vpHinInput.addEventListener('change', (e) => { node.vpHin = Number(e.target.value) || 0; recompute(); });
      const vpRevInput = card.querySelector('.node-vp-rev');
      if (vpRevInput) vpRevInput.addEventListener('change', (e) => { node.vpRev = Number(e.target.value) || 0; recompute(); });
      const revOffsetInput = card.querySelector('.node-rev-offset');
      if (revOffsetInput) revOffsetInput.addEventListener('change', (e) => { node.revOffset = Number(e.target.value) || 0; recompute(); });
      card.querySelector('.node-remove').addEventListener('click', () => { state.removeIntersection(id); renderNodeList(); recompute(); });
      const upBtn = card.querySelector('.node-up');
      const downBtn = card.querySelector('.node-down');
      if (upBtn) upBtn.addEventListener('click', () => { state.moveIntersection(id, -1); renderNodeList(); recompute(); });
      if (downBtn) downBtn.addEventListener('click', () => { state.moveIntersection(id, 1); renderNodeList(); recompute(); });
    });
  }

  /* ---------------- Berechnung ---------------- */
  // Hin: "Abstand Hin" auf Karte i = Abstand zur vorherigen Karte (i-1),
  // deaktiviert an Karte 0 (kein Vorgänger). Station 0 an Karte 0, danach
  // aufsteigend.
  //
  // Rück durchläuft dieselbe Kartenliste rückwärts (von der letzten zur
  // ersten Karte) - ihr "vorheriger" Knoten auf Karte i ist daher Karte i+1:
  // "Abstand Rück" auf Karte i = Abstand zur NÄCHSTEN Karte, deaktiviert an
  // der LETZTEN Karte (kein Nachfolger). Für die kombinierte Darstellung
  // müssen beide Stationsketten trotzdem in derselben Reihenfolge wie die
  // Kartenliste aufsteigen (sonst lässt sich Rück nicht per Versatz auf die
  // Hin-Achse legen, ohne den Streckenabschnitt zu verdoppeln/spiegeln) -
  // die Rück-Kette wird daher rückwärts ab der letzten Karte aufgebaut, mit
  // "Versatz Rück" (Positionsunterschied Rück-/Hin-Signalgruppe an diesem
  // Knoten) als einzigem Ankerpunkt zur Hin-Achse.
  // Station des ersten Hin-Knotens - frei editierbar (z. B. um an eine reale
  // Stationierung/Kilometrierung anzuschließen), statt fest bei 0 zu
  // beginnen. Verschiebt Hin UND (über hinStationAt) Rück gemeinsam.
  function baseStation() {
    return Number(els.baseStationInput.value) || 0;
  }

  function hinStationAt(index) {
    const nodes = state.intersections;
    let total = baseStation();
    for (let i = 1; i <= index; i++) total += Number(nodes[i].distanceHin) || 0;
    return total;
  }

  function collectRows(dirKey) {
    const nodes = state.intersections;
    const rows = [];
    let TUref = null;
    const tus = [];
    const colField = dirKey === 'Hin' ? 'mainColHin' : 'mainColRev';

    const pushRow = (n, station) => {
      const col = n[colField];
      const plan = col != null ? n.planByCol.get(col) : null;
      if (!plan || !n.TU) return;
      tus.push(n.TU);
      if (TUref == null) TUref = n.TU;
      const colInfo = n.columns.find(c => c.index === col);
      rows.push({
        nodeId: n.id,
        name: n.knotenName || n.fileName,
        sgName: colInfo ? colInfo.name : '',
        station,
        an: plan.an, ab: plan.ab, tf: plan.tf,
        // Reale (nicht aggregierte) Daten des zugrundeliegenden Knotens -
        // für die Zeitleisten-Darstellung im Diagramm (echte Grünsegmente
        // über die gesamte Aufzeichnung statt eines wiederholten Medians).
        greenSegs: (n.segsByCol.get(col) || []).filter(s => s.cat === 'GRUEN'),
        tMin: n.times[0], tMax: n.times[n.times.length - 1],
        cycleStarts: n.cycleStarts, splPeriods: n.splPeriods
      });
    };

    if (dirKey === 'Hin') {
      let station = baseStation();
      for (let i = 0; i < nodes.length; i++) {
        if (i > 0) station += Number(nodes[i].distanceHin) || 0;
        pushRow(nodes[i], station);
      }
    } else {
      const N = nodes.length;
      const last = N - 1;
      const local = new Array(N);
      local[last] = 0;
      for (let i = last - 1; i >= 0; i--) {
        local[i] = local[i + 1] - (Number(nodes[i].distanceRev) || 0);
      }
      const anchor = hinStationAt(last) + (Number(nodes[last]?.revOffset) || 0);
      for (let i = 0; i < N; i++) pushRow(nodes[i], local[i] + anchor);
    }
    return { rows, TU: TUref, tus };
  }

  // V_p [km/h] je Abschnitt, in Fahrtrichtung: für orderedRows[i]->orderedRows[i+1]
  // steht der Wert auf dem Knoten, der in dieser Richtung ERREICHT wird -
  // dieselbe Karte, die auch den Abstand für dieses Segment trägt (vpHin auf
  // der ankommenden Karte in Hin-Richtung, vpRev auf der ankommenden Karte
  // in Rück-Richtung - siehe collectRows).
  function segmentVpArray(orderedRows, dirTag) {
    const field = dirTag === 'fwd' ? 'vpHin' : 'vpRev';
    return orderedRows.slice(1).map(r => {
      const node = state.intersections.find(n => n.id === r.nodeId);
      return node ? Number(node[field]) || 0 : 0;
    });
  }

  // Reine Berechnung (keine DOM-Zugriffe) für eine Richtung.
  function computeDirection(dirKey, dirTag, enabled) {
    if (!enabled) return { ok: false };
    const { rows, TU, tus } = collectRows(dirKey);
    if (!TU || rows.length < 2) return { ok: false, reason: rows.length < 2 ? 'nodes' : 'tu' };
    const sMin = rows[0].station, sMax = rows[rows.length - 1].station;
    const corridor = sMax - sMin;
    if (corridor <= 0) return { ok: false, reason: 'corridor' };

    const der = deriveVp(rows, TU, dirTag);
    const lTP = teilpunktabstand(TU, dirTag === 'fwd' ? der.vp_kmh : 0, dirTag === 'rev' ? der.vp_kmh : 0);
    const entryRows = dirTag === 'fwd' ? rows.slice(0, rows.length - 1) : rows.slice(1);
    const bw = entryRows.length ? Math.min(...entryRows.map(r => r.tf)) : 0;
    const bottleneck = entryRows.length ? entryRows.reduce((a, b) => b.tf < a.tf ? b : a, entryRows[0]) : null;
    const spd = der.segs.map(s => s.vp_kmh).filter(v => v > 0);
    const spdSpread = spd.length > 1 ? (Math.max(...spd) - Math.min(...spd)) : 0;

    const orderedRows = dirTag === 'fwd' ? rows : rows.slice().reverse();
    const vpArray = segmentVpArray(orderedRows, dirTag);
    // Zwei unabhängige Bänder: "Querschnitt" (qualitativ, je Abschnitt nur
    // die Grünzeit des abfahrenden Knotens - zeigt, ob das Band jede
    // Grünzeit im Zug überhaupt berührt) und "Optimum" (kumulativ, das Band,
    // das durchgehend durch JEDE Grünzeit passt).
    const qualitativeBand = computeQualitativeBand(rows, vpArray, TU, dirTag);
    const optimumBand = computeOptimumBand(rows, vpArray, TU, dirTag);
    const ref = dirTag === 'fwd' ? rows[0] : rows[rows.length - 1];

    // Zeitlicher Gesamtbereich dieser Richtung (Vereinigung über alle
    // enthaltenen Knoten) - Grundlage für die durchgehende Zeitachse im
    // Diagramm ("gesamte Historie" statt einzelner Umläufe).
    const tRangeMin = Math.min(...rows.map(r => r.tMin));
    const tRangeMax = Math.max(...rows.map(r => r.tMax));

    return { ok: true, dirKey, dirTag, rows, orderedRows, TU, tus, corridor, sMin, sMax, der, lTP, bw, bottleneck, spd, spdSpread, vpArray, qualitativeBand, optimumBand, ref, tRangeMin, tRangeMax };
  }

  function recompute() {
    if (state.intersections.length === 0) { hidePanels(); showHint(''); return; }

    const dirMode = els.dirSelect.value;
    const hinEnabled = dirMode !== 'rev';
    const revEnabled = dirMode !== 'fwd';
    const resHin = computeDirection('Hin', 'fwd', hinEnabled);
    const resRev = computeDirection('Rev', 'rev', revEnabled);

    const msgs = [];

    if (!resHin.ok && !resRev.ok) {
      hidePanels();
      msgs.push('Mindestens zwei Knoten mit gültigem Hauptsignal und einem Abstand größer 0 (je Richtung) auswählen.');
      showHint(msgs.join(' '));
      return;
    }

    [['Hinrichtung', resHin], ['Gegenrichtung', resRev]].forEach(([label, res]) => {
      if (!res.ok) return;
      const uniqueTus = [...new Set(res.tus)];
      if (uniqueTus.length > 1 && (Math.max(...uniqueTus) - Math.min(...uniqueTus)) > 1) {
        msgs.push(`${label}: Umlaufzeiten der Knoten weichen voneinander ab (${uniqueTus.join(', ')} s).`);
      }
      if (res.spdSpread > 15) {
        msgs.push(`${label}: Progressionsgeschwindigkeit schwankt abschnittsweise deutlich (${Math.min(...res.spd).toFixed(0)}–${Math.max(...res.spd).toFixed(0)} km/h).`);
      }
      if (!res.optimumBand) {
        msgs.push(`${label}: V_p (Vorschlag) fehlt oder ist 0 auf mindestens einem Abschnitt – kein Grünband berechenbar.`);
      }
      const overlapMin = Math.max(...res.rows.map(r => r.tMin));
      const overlapMax = Math.min(...res.rows.map(r => r.tMax));
      if (overlapMax <= overlapMin) {
        msgs.push(`${label}: Die Aufzeichnungszeiträume der Knoten überschneiden sich nicht (z. B. verschiedene Tage) – die Koordinierung ist zeitlich nicht validierbar.`);
      }
    });
    showHint(msgs.join(' '));

    els.kpiPanel.style.display = 'block';
    els.diagramPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';
    els.kmPanel.style.display = 'block';

    /* ---- Kenngrößen ---- */
    const kpis = [{ label: 'System-Umlaufzeit t_U', value: (resHin.ok ? resHin.TU : resRev.TU) + ' s' }];
    [['Hin', resHin], ['Rück', resRev]].forEach(([tag, res]) => {
      if (!res.ok) return;
      kpis.push({ label: `Knoten im Zug ${tag}`, value: res.rows.length });
      kpis.push({ label: `Streckenlänge ${tag}`, value: res.corridor + ' m' });
      kpis.push({ label: `Teilpunktabstand l_TP ${tag}`, value: Math.round(res.lTP) + ' m', cls: 'accent' });
      kpis.push({ label: `V_p ${tag} (gemessen)`, value: res.der.vp_kmh.toFixed(1) + ' km/h', cls: 'accent' });
      if (res.bottleneck) kpis.push({ label: `Engste Stelle ${tag}`, value: res.bw.toFixed(0) + ' s', sub: res.bottleneck.name });
      if (res.optimumBand) {
        const ov = res.optimumBand.overall;
        const vps = res.vpArray.filter(v => v > 0);
        const vpSub = vps.length
          ? (vps.every(v => v === vps[0]) ? `bei ${vps[0]} km/h` : `bei ${Math.min(...vps)}–${Math.max(...vps)} km/h je Abschnitt`)
          : '';
        kpis.push({
          label: `Bandbreite ${tag} (Optimum)`,
          value: `${ov.bandwidth} s`,
          sub: ov.successCount <= 0 ? 'kein durchgehendes Band bei dieser Geschwindigkeit (Engpass zu schmal)' : `Engpass-Grünzeit, konstant je Abschnitt · ${vpSub}`
        });
        kpis.push({
          label: `Koordinationserfolg ${tag}`,
          value: `${(ov.rate * 100).toFixed(0)} %`,
          cls: ov.rate >= 0.9 ? 'accent' : (ov.rate < 0.5 ? 'warn' : ''),
          sub: `${ov.successCount} von ${ov.totalCycles} Umläufen durchgehend`
        });
      }
    });
    els.kpiGrid.innerHTML = kpis.map(k => `
      <div class="kpi card elev-sm ${k.cls || ''}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        ${k.sub ? `<div class="k-sub">${esc(k.sub)}</div>` : ''}
      </div>`).join('');

    /* ---- Diagramm ---- */
    const showQualitative = els.bandQualitativeInput.checked;
    const showOptimum = els.bandOptimumInput.checked;
    const showTimestamp = els.showTimestampInput.checked;
    const TU = resHin.ok ? resHin.TU : resRev.TU;
    const toDirGeom = (res, tag, tagColor, gridColor) => res.ok ? {
      rows: res.rows, lTP: res.lTP,
      qualitativeBand: res.qualitativeBand, optimumBand: res.optimumBand,
      tag, tagColor, gridColor,
      tRangeMin: res.tRangeMin, tRangeMax: res.tRangeMax
    } : null;
    const hinGeom = toDirGeom(resHin, 'H', '#8a5a00', 'rgba(211,161,37,0.6)');
    const revGeom = toDirGeom(resRev, 'R', '#2b6ca3', 'rgba(43,108,163,0.6)');
    const rangeParts = [hinGeom, revGeom].filter(Boolean);
    const globalTMin = Math.min(...rangeParts.map(d => d.tRangeMin));
    const globalTMax = Math.max(...rangeParts.map(d => d.tRangeMax));
    diagramApi = renderDiagram(els.diagram, { TU, showQualitative, showOptimum, showTimestamp, zoomLevel, globalTMin, globalTMax, hin: hinGeom, rev: revGeom });
    els.zoomLabel.textContent = Math.round(zoomLevel * 100) + ' %';
    const parts = [];
    if (resHin.ok) parts.push(`Hin: ${resHin.rows.length} Knoten, l_TP ${Math.round(resHin.lTP)} m`);
    if (resRev.ok) parts.push(`Rück: ${resRev.rows.length} Knoten, l_TP ${Math.round(resRev.lTP)} m`);
    const durH = ((globalTMax - globalTMin) / 3600000).toFixed(1);
    els.diagramInfo.textContent = `${parts.join(' · ')} · gesamte Historie (${durH} h)`;

    /* ---- Koordinationsstatistik ---- */
    renderKm(resHin, resRev);
    renderStats(resHin, resRev);
    renderUmlaufTable(resHin, resRev);

    /* ---- Tabelle (eine Zeile je Knotenkarte, Hin/Rück nebeneinander) ---- */
    const nodes = state.intersections;
    els.tableBody.innerHTML = nodes.map(n => {
      const rHin = resHin.ok ? resHin.rows.find(r => r.nodeId === n.id) : null;
      const rRev = resRev.ok ? resRev.rows.find(r => r.nodeId === n.id) : null;
      const cellFor = (res, r) => {
        if (!res.ok || !r) return '<td>–</td><td>–</td><td>–</td><td>–</td>';
        const versatz = (((r.an - res.ref.an) % res.TU) + res.TU) % res.TU;
        const versLabel = r === res.ref ? '0 (Bezug)' : '+' + versatz + ' s';
        return `<td>${esc(r.sgName)}</td><td>${r.station} m</td><td>${r.an}–${r.ab} (${r.tf}s)</td><td>${versLabel}</td>`;
      };
      const label = n.knotenName || n.fileName;
      return `<tr>
        <td>${esc(label)}</td>
        ${cellFor(resHin, rHin)}
        ${cellFor(resRev, rRev)}
      </tr>`;
    }).join('');
  }

  /* ---------------- Koordinierungsmaß ---------------- */
  // Zwei frei einstellbare Zeitbänder (z. B. Vormittags-/Nachmittagsspitze),
  // je Band und Richtung ein Kachel-Ergebnis. Siehe
  // App.coordination.computeKoordinierungsmass für die Formel.
  function parseTimeToMinutes(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function renderKmBand(fromInput, toInput, targetEl, resHin, resRev) {
    const fromMin = parseTimeToMinutes(fromInput.value);
    const toMin = parseTimeToMinutes(toInput.value);
    if (fromMin == null || toMin == null) { targetEl.innerHTML = ''; return; }
    const tiles = [];
    [['Hin', resHin], ['Rück', resRev]].forEach(([tag, res]) => {
      if (!res.ok || !res.optimumBand) return;
      const r = App.coordination.computeKoordinierungsmass(res.optimumBand.cycles, res.optimumBand.ordered.length, fromMin, toMin);
      if (!r.n) {
        tiles.push({ label: `Koordinierungsmaß ${tag}`, value: '–', sub: 'keine Messfahrten in diesem Zeitband' });
        return;
      }
      const los = App.coordination.koordinierungsmassLos(r.pct);
      const lowN = r.n < 5 ? ` · n=${r.n} Messfahrten (< 5 empfohlen)` : ` · n=${r.n} Messfahrten`;
      tiles.push({
        label: `Koordinierungsmaß ${tag}`, value: `${r.pct.toFixed(0)} %`,
        subCls: los.cls, sub: `${los.label}${lowN}`
      });
    });
    targetEl.innerHTML = tiles.length
      ? tiles.map(t => `
        <div class="kpi card elev-sm">
          <div class="k-label">${t.label}</div>
          <div class="k-value">${t.value}</div>
          ${t.sub ? `<div class="k-sub ${t.subCls || ''}">${esc(t.sub)}</div>` : ''}
        </div>`).join('')
      : '<div class="node-empty">Keine Richtung aktiv.</div>';
  }
  function renderKm(resHin, resRev) {
    renderKmBand(els.kmFrom1, els.kmTo1, els.kmResult1, resHin, resRev);
    renderKmBand(els.kmFrom2, els.kmTo2, els.kmResult2, resHin, resRev);
  }
  [els.kmFrom1, els.kmTo1, els.kmFrom2, els.kmTo2].forEach(el => el.addEventListener('change', recompute));

  /* ---------------- Koordinationsstatistik ---------------- */
  // "Erfolgreiche" Koordination = das Optimum-Grünband durchläuft den
  // Umlauf durchgehend (ohne an einer Station zu "stoppen") bis zum
  // letzten Knoten. Je Übergang wird zusätzlich gezeigt, WO genau Umläufe
  // ausscheiden (Eintretend/Erfolgreich/Gescheitert je Station), damit sich
  // Engpässe im Streckenzug lokalisieren lassen - plus Breite (min/Ø/max)
  // des tatsächlich durchgehenden Bandes.
  function renderStats(resHin, resRev) {
    const dirs = [['Hinrichtung', resHin, '#8a5a00'], ['Gegenrichtung', resRev, '#2b6ca3']]
      .filter(([, res]) => res.ok && res.optimumBand);
    if (dirs.length === 0) { els.statsPanel.style.display = 'none'; return; }
    els.statsPanel.style.display = 'block';
    const pct = (r) => (r * 100).toFixed(0) + ' %';
    const rateCls = (r) => r >= 0.9 ? 'stat-ok' : (r < 0.5 ? 'stat-bad' : 'stat-warn');
    const rows = [];
    dirs.forEach(([label, res, color]) => {
      const bw = res.optimumBand.minTf;
      rows.push(`<tr class="stats-dir-row"><td colspan="6" style="color:${color}">${esc(label)} · Engpass-Bandbreite ${bw} s (konstant)</td></tr>`);
      res.optimumBand.perStation.forEach(st => {
        rows.push(`<tr>
          <td>${esc(st.a.name)} → ${esc(st.b.name)}</td>
          <td>${st.entering}</td>
          <td>${st.surviving}</td>
          <td>${st.failed}</td>
          <td class="${rateCls(st.rate)}">${pct(st.rate)}</td>
          <td>${st.surviving > 0 ? bw + ' s' : '–'}</td>
        </tr>`);
      });
      const ov = res.optimumBand.overall;
      const first = res.optimumBand.ordered[0], last = res.optimumBand.ordered[res.optimumBand.ordered.length - 1];
      rows.push(`<tr class="stats-total-row">
        <td>Gesamter Streckenzug (${esc(first.name)} → ${esc(last.name)})</td>
        <td>${ov.totalCycles}</td>
        <td>${ov.successCount}</td>
        <td>${ov.failCount}</td>
        <td class="${rateCls(ov.rate)}">${pct(ov.rate)}</td>
        <td>${ov.successCount > 0 ? bw + ' s' : '–'}</td>
      </tr>`);
    });
    els.statsBody.innerHTML = rows.join('');
  }

  /* ---------------- Umlaufübersicht ---------------- */
  // Eine Zeile je realem Umlauf (Ursprungsgrünfenster am ersten Knoten) mit
  // Erfolg/Misserfolg des Optimum-Bands über den ganzen Streckenzug - Klick
  // springt im Zeit-Weg-Diagramm direkt zu diesem Zeitpunkt. Umlauf-Nummer =
  // Index innerhalb der (ungefilterten) Zykluskette der jeweiligen Richtung.
  // Der Segment-Filter im Panel-Kopf (Alle/Durchfahrt/Gescheitert) grenzt auf
  // umlaufFilter ein. Bei sehr langen Aufzeichnungen wird die gefilterte
  // Liste je Richtung gekappt (Performance), mit Hinweis auf die Anzahl
  // ausgeblendeter Umläufe.
  const UMLAUF_TABLE_MAX = 500;
  function renderUmlaufTable(resHin, resRev) {
    const dirs = [['Hinrichtung', resHin, '#8a5a00'], ['Gegenrichtung', resRev, '#2b6ca3']]
      .filter(([, res]) => res.ok && res.optimumBand && res.optimumBand.cycles.length);
    if (dirs.length === 0) { els.umlaufPanel.style.display = 'none'; return; }
    els.umlaufPanel.style.display = 'block';
    const rows = [];
    dirs.forEach(([label, res, color]) => {
      const cycles = res.optimumBand.cycles;
      const filtered = cycles
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => umlaufFilter === 'all' || (umlaufFilter === 'ja' ? c.success : !c.success));
      const shown = filtered.slice(0, UMLAUF_TABLE_MAX);
      if (dirs.length > 1) {
        rows.push(`<tr class="stats-dir-row"><td colspan="5" style="color:${color}">${esc(label)} (${filtered.length} von ${cycles.length} Umläufen${filtered.length > UMLAUF_TABLE_MAX ? `, erste ${UMLAUF_TABLE_MAX} angezeigt` : ''})</td></tr>`);
      }
      shown.forEach(({ c, i }) => {
        const durchfahrtCls = c.success ? 'stat-ok' : 'stat-bad';
        rows.push(`<tr class="cycle-jump-row" data-t="${c.start}" tabindex="0">
          <td>Umlauf ${i}</td>
          <td>${esc(fmtDateTimeShort(c.start))}</td>
          <td>${esc(fmtDateTimeShort(c.end))}</td>
          <td class="${durchfahrtCls}">${c.success ? 'Ja' : 'Nein'}</td>
          <td>${c.success ? `${c.finalWidth} s` : '–'}</td>
        </tr>`);
      });
    });
    els.umlaufBody.innerHTML = rows.join('');
  }

  els.umlaufBody.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-t]');
    if (!row || !diagramApi) return;
    diagramApi.scrollToTime(Number(row.dataset.t));
  });
  els.umlaufBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-t]');
    if (!row || !diagramApi) return;
    e.preventDefault();
    diagramApi.scrollToTime(Number(row.dataset.t));
  });

  els.umlaufFilterSeg.addEventListener('change', (e) => {
    if (e.target.name !== 'umlaufFilter') return;
    umlaufFilter = e.target.value;
    recompute();
  });

  /* ---------------- Y-Achsen-Zoom ---------------- */
  els.zoomOutBtn.addEventListener('click', () => setZoom(zoomLevel / ZOOM_STEP));
  els.zoomInBtn.addEventListener('click', () => setZoom(zoomLevel * ZOOM_STEP));
  els.zoomResetBtn.addEventListener('click', () => setZoom(1));

  // Strg/Cmd+Mausrad über dem Diagramm zoomt interaktiv in die Zeitachse
  // hinein/heraus (wie in Karten-/Grafikwerkzeugen üblich) - normales
  // Scrollen (ohne Strg) bleibt unverändert das Scrollen/Blättern durch die
  // Historie. Mehrere Wheel-Events pro Geste werden gesammelt und erst im
  // nächsten Frame in EINE Neuberechnung umgesetzt (kein Reflow pro Tick).
  let zoomPendingDelta = 0, zoomRaf = null;
  els.diagram.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomPendingDelta += e.deltaY;
    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      const factor = Math.pow(1.0018, -zoomPendingDelta);
      zoomPendingDelta = 0;
      zoomRaf = null;
      setZoom(zoomLevel * factor);
    });
  }, { passive: false });

  [els.dirSelect, els.bandQualitativeInput, els.bandOptimumInput, els.baseStationInput, els.showTimestampInput].forEach(el => el.addEventListener('change', recompute));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(recompute, 150);
  });

  setTab(currentTab);
  renderNodeList();
  recompute();
})(window.App = window.App || {});
