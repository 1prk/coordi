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
  // Dasselbe für den D3-Diagramm-Prototyp (eigener Tab, eigenes Modul
  // js/diagram-d3.js) - identisches Interaktionsmodell wie das klassische
  // Diagramm (natives Scrollen/Mausrad durch die Zeit, eigener zoomLevel für
  // Strg+Mausrad/Zoom-Buttons), daher auch eine eigene API-Variable analog
  // zu diagramApi statt einer d3-zoom-eigenen Lösung.
  let diagramD3Api = null;

  // Letztes recompute()-Ergebnis je Richtung - für die XLSX-Exportbuttons
  // (Umlaufübersicht/Koordinationsstatistik), die außerhalb von recompute()
  // ausgelöst werden und daher keinen Zugriff auf dessen lokale resHin/
  // resRev hätten.
  let lastResHin = null, lastResRev = null;

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
  // Eigener Zoom-Zustand für das D3-Diagramm (unabhängig vom klassischen
  // Diagramm - beide Tabs können unterschiedlich weit gezoomt sein).
  let zoomLevelD3 = 1;
  function setZoomD3(next) {
    zoomLevelD3 = clamp(next, ZOOM_MIN, ZOOM_MAX);
    recompute();
  }

  // Filter der Umlaufübersicht-Tabelle (unterhalb des klassischen Diagramms).
  // 'all' | 'ja' (nur durchgefahrene Umläufe) | 'nein' (nur gescheiterte).
  let umlaufFilter = 'all';
  // Dasselbe für die (unabhängige) Umlaufübersicht neben dem D3-Diagramm.
  let umlaufFilterD3 = 'all';

  // Aktiver Tab: 'setup' | 'diagram' | 'stats'. Start bei 'setup', da die App
  // (anders als die Referenz) ohne vorgeladene Beispieldaten startet - ein
  // leerer Diagramm-Tab wäre der falsche erste Eindruck.
  let currentTab = 'setup';

  const els = {
    tabLinks: document.querySelectorAll('.nav-tab-link'),
    tabSetup: document.getElementById('tabSetup'),
    tabDiagram: document.getElementById('tabDiagram'),
    tabD3Diagram: document.getElementById('tabD3Diagram'),
    tabStats: document.getElementById('tabStats'),
    d3Panel: document.getElementById('d3Panel'),
    d3Diagram: document.getElementById('d3Diagram'),
    d3ZoomOutBtn: document.getElementById('d3ZoomOutBtn'),
    d3ZoomResetBtn: document.getElementById('d3ZoomResetBtn'),
    d3ZoomInBtn: document.getElementById('d3ZoomInBtn'),
    d3ZoomLabel: document.getElementById('d3ZoomLabel'),
    d3UmlaufPanel: document.getElementById('d3UmlaufPanel'),
    d3UmlaufBody: document.getElementById('d3UmlaufBody'),
    d3UmlaufFilterSeg: document.getElementById('d3UmlaufFilterSeg'),
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
    btnExportStats: document.getElementById('btnExportStats'),
    umlaufPanel: document.getElementById('umlaufPanel'),
    umlaufBody: document.getElementById('umlaufBody'),
    umlaufFilterSeg: document.getElementById('umlaufFilterSeg'),
    btnExportUmlauf: document.getElementById('btnExportUmlauf'),
    d3BtnExportUmlauf: document.getElementById('d3BtnExportUmlauf'),
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
    els.d3Panel.style.display = 'none';
    els.d3UmlaufPanel.style.display = 'none';
  }

  /* ---------------- Tabs (Setup / Diagramm / Diagramm (D3) / Statistik) ---------------- */
  const TAB_CONTENT = { setup: els.tabSetup, diagram: els.tabDiagram, d3diagram: els.tabD3Diagram, stats: els.tabStats };
  function setTab(tab) {
    currentTab = tab;
    Object.keys(TAB_CONTENT).forEach(t => { TAB_CONTENT[t].style.display = t === tab ? '' : 'none'; });
    els.tabLinks.forEach(a => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // Beide Diagramme messen beim Rendern die Breite ihres Containers -
    // während ihr Tab per display:none verborgen ist, liefert das 0
    // (Fallback auf eine feste Breite). Ein Wechsel auf den jeweiligen Tab
    // macht den Container erst sichtbar, daher hier neu rendern.
    if (tab === 'diagram' || tab === 'd3diagram') recompute();
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
            // Nur Zuordnungen übernehmen, deren Spaltenindex in DIESER
            // (neu geparsten) Datei tatsächlich noch eine DET-/APW-Spalte
            // ist - sonst könnten abweichende Spaltenlayouts (andere CSV
            // unter demselben Dateinamen) unbemerkt eine falsche Spalte
            // zuordnen. Alte Exporte ohne assignedTracks (vor dieser
            // Funktion) importieren dadurch einfach ohne Zuordnung - der
            // Nutzer wählt dann neu, statt dass geraten wird.
            const validIdxs = new Set(trackOptions(entry).map(c => c.index));
            entry.assignedTracks = {};
            Object.entries(saved.assignedTracks || {}).forEach(([idx, dir]) => {
              if (validIdxs.has(Number(idx)) && (dir === 'hin' || dir === 'rev')) entry.assignedTracks[Number(idx)] = dir;
            });
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
        vpRev: n.vpRev,
        assignedTracks: n.assignedTracks || {}
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

  // Alle DET- + APW-Spalten eines Knotens als eine gemeinsame Liste - Basis
  // für den Det/APW-Zuordner je Signalgruppe (siehe trackPickerHtml).
  function trackOptions(n) {
    return [
      ...(n.detColumns || []).map(c => ({ ...c, trackKind: 'DET' })),
      ...(n.apwColumns || []).map(c => ({ ...c, trackKind: 'APW' }))
    ];
  }

  // "+ Det/APW hinzufügen" je Signalgruppe (dir: 'hin' | 'rev'). Strikt 1:1:
  // eine Spalte, die bereits der ANDEREN Richtung zugeordnet ist, erscheint
  // in der Liste ausgegraut/deaktiviert statt wählbar - eine Spalte kann nie
  // beiden Richtungen gleichzeitig zugeordnet sein (siehe node.assignedTracks
  // in state.js). Oberhalb der (auf-/zuklappbaren) Auswahlliste stehen die
  // dieser Richtung bereits zugeordneten Spalten als Chips, damit der
  // aktuelle Stand auch ohne Aufklappen sichtbar ist.
  function trackPickerHtml(n, dir) {
    const opts = trackOptions(n);
    if (!opts.length) return '';
    const assigned = n.assignedTracks || {};
    const mine = opts.filter(c => assigned[c.index] === dir);
    const otherDir = dir === 'hin' ? 'rev' : 'hin';
    const otherLabel = dir === 'hin' ? 'Rück' : 'Hin';
    const rows = opts.map(c => {
      const takenByOther = assigned[c.index] === otherDir;
      const checked = assigned[c.index] === dir;
      return `<label class="radio track-picker-row ${takenByOther ? 'is-taken' : ''}">
        <input type="checkbox" class="node-track-check" data-dir="${dir}" value="${c.index}" ${checked ? 'checked' : ''} ${takenByOther ? 'disabled' : ''}>
        <span class="dot" style="border-radius:2px;"></span>
        <span class="tag tag-neutral track-kind-tag">${c.trackKind}</span> ${esc(c.name)}
        ${takenByOther ? `<em class="track-taken-note">— an ${otherLabel} vergeben</em>` : ''}
      </label>`;
    }).join('');
    const openAttr = n[`_trackPickerOpen_${dir}`] ? ' open' : '';
    return `<details class="track-picker" data-dir="${dir}"${openAttr}>
        <summary class="add-track-btn">+ Det/APW hinzufügen${mine.length ? ` (${mine.length})` : ''}</summary>
        <div class="track-picker-list">${rows}</div>
      </details>
      ${mine.length ? `<div class="track-chip-row">${mine.map(c => `<span class="track-chip track-chip-${c.trackKind.toLowerCase()}">${c.trackKind} ${esc(c.name)}</span>`).join('')}</div>` : ''}`;
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
              ${trackPickerHtml(n, 'hin')}
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
              ${trackPickerHtml(n, 'rev')}
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
      // Det/APW-Zuordnung je Signalgruppe (siehe trackPickerHtml): Ankreuzen
      // trägt die Spalte strikt 1:1 in node.assignedTracks ein (die andere
      // Richtung kann dieselbe Spalte danach nicht mehr wählen), Abwählen
      // entfernt die Zuordnung wieder. renderNodeList() (nicht nur
      // recompute()) ist hier nötig, damit die jeweils ANDERE Spalten-Picker-
      // Liste im selben Knoten sofort "vergeben" zeigt.
      card.querySelectorAll('.node-track-check').forEach(chk => {
        chk.addEventListener('change', (e) => {
          const idx = Number(e.target.value);
          const dir = e.target.dataset.dir;
          node.assignedTracks = node.assignedTracks || {};
          if (e.target.checked) node.assignedTracks[idx] = dir;
          else delete node.assignedTracks[idx];
          renderNodeList();
          recompute();
        });
      });
      // Auf-/zugeklappt-Status je Picker am Knoten selbst gemerkt (nicht
      // Teil der exportierten Konfiguration) - überlebt so den
      // renderNodeList()-Neuaufbau, den jede Zuordnungsänderung auslöst.
      card.querySelectorAll('.track-picker').forEach(det => {
        det.addEventListener('toggle', () => { node[`_trackPickerOpen_${det.dataset.dir}`] = det.open; });
      });
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
    const trackKey = dirKey === 'Hin' ? 'hin' : 'rev';

    const pushRow = (n, station) => {
      const col = n[colField];
      const plan = col != null ? n.planByCol.get(col) : null;
      if (!plan || !n.TU) return;
      tus.push(n.TU);
      if (TUref == null) TUref = n.TU;
      const colInfo = n.columns.find(c => c.index === col);
      // Det/APW dieser Signalgruppe (siehe renderNodeList/trackPickerHtml) -
      // strikt 1:1 zugeordnet (node.assignedTracks), daher hier direktionsgenau
      // gefiltert statt wie früher pauschal für den ganzen Knoten. DET und APW
      // liefern beide JEDES Wert-Segment außer "INV" (siehe state.js
      // categorizeValueRaw) und werden im Diagramm identisch als Balken mit
      // Wert-Label gezeichnet - DET blendet zusätzlich "0" (frei) komplett
      // aus, sonst würde die weit überwiegende Frei-Grundlast das Diagramm
      // zupflastern; APW zeigt "0" (laut Spezifikation ein Sonderfall,
      // nicht "kein Wert") weiterhin, nur schraffiert statt Vollton. Kind
      // bleibt am Track dran, nur für Farbe/diese eine Ausnahme.
      const assignedIdxs = Object.keys(n.assignedTracks || {})
        .map(Number)
        .filter(idx => n.assignedTracks[idx] === trackKey);
      const tracks = assignedIdxs.map(idx => {
        const detInfo = (n.detColumns || []).find(c => c.index === idx);
        if (detInfo) return { kind: 'DET', name: detInfo.name, segs: (n.detSegsByCol.get(idx) || []).filter(s => s.cat !== '0' && s.cat !== 'INV') };
        const apwInfo = (n.apwColumns || []).find(c => c.index === idx);
        if (apwInfo) return { kind: 'APW', name: apwInfo.name, segs: (n.apwSegsByCol.get(idx) || []).filter(s => s.cat !== 'INV') };
        return null;
      }).filter(Boolean);
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
        cycleStarts: n.cycleStarts, splPeriods: n.splPeriods,
        tracks
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
    if (state.intersections.length === 0) { hidePanels(); showHint(''); lastResHin = null; lastResRev = null; return; }

    const dirMode = els.dirSelect.value;
    const hinEnabled = dirMode !== 'rev';
    const revEnabled = dirMode !== 'fwd';
    const resHin = computeDirection('Hin', 'fwd', hinEnabled);
    const resRev = computeDirection('Rev', 'rev', revEnabled);
    lastResHin = resHin; lastResRev = resRev;

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
    els.d3Panel.style.display = 'block';
    els.d3UmlaufPanel.style.display = 'block';
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
          label: `Engpass-Bandbreite ${tag}`,
          value: `${ov.bandwidth} s`,
          sub: ov.successCount <= 0
            ? 'kein Umlauf durchgehend - keine reale Durchfahrt gefunden'
            : `schmalste Plan-Grünzeit im Streckenzug (Referenzwert) · reale Bänder ${ov.widthMin === ov.widthMax ? ov.widthMin + ' s' : ov.widthMin + '–' + ov.widthMax + ' s'} · ${vpSub}`
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

    diagramD3Api = App.diagramD3.renderDiagram(els.d3Diagram, { TU, showQualitative, showOptimum, showTimestamp, zoomLevel: zoomLevelD3, globalTMin, globalTMax, hin: hinGeom, rev: revGeom });
    els.d3ZoomLabel.textContent = Math.round(zoomLevelD3 * 100) + ' %';

    /* ---- Koordinationsstatistik ---- */
    renderKm(resHin, resRev);
    renderStats(resHin, resRev);
    renderUmlaufTable(resHin, resRev, umlaufFilter, els.umlaufPanel, els.umlaufBody);
    renderUmlaufTable(resHin, resRev, umlaufFilterD3, els.d3UmlaufPanel, els.d3UmlaufBody);

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
  // "Erfolgreiche" Koordination = der reale Umlauf (tatsächliches
  // Grünfenster am ersten Knoten) erreicht durchgehend Grün bis zum letzten
  // Knoten - unabhängig davon, ob die dabei real nutzbare Bandbreite so
  // breit wie der Streckenzug-Engpass (minTf) ist; ein schmaleres, aber
  // durchgehendes reales Band zählt genauso als Durchfahrt. Je Übergang
  // wird zusätzlich gezeigt, WO genau Umläufe ausscheiden (Eintretend/
  // Erfolgreich/Gescheitert je Station), damit sich Engpässe im
  // Streckenzug lokalisieren lassen - plus die Bandbreite als Mini-Boxplot
  // (siehe svgBoxplot()) der tatsächlich durchgehenden (realen) Umläufe.
  //
  // svgBoxplot: Whisker min–max, Box Q1–Q3, Strich bei Median - kann je
  // Übergang/Umlauf streuen und muss NICHT der konstanten Engpass-
  // Bandbreite (minTf) entsprechen; siehe computeOptimumBand()'s
  // realStages-Kette/widthStats(). Bewusst schlank gehalten: nur min/max
  // als sichtbare Zahlen, der Rest (Q1/Median/Q3/Ø/n) steckt im Tooltip
  // statt die Zelle zuzupflastern. Ohne Streuung (n<2 oder min===max)
  // genügt reiner Text.
  function svgBoxplot(st) {
    if (!st || !st.n) return '–';
    if (st.n < 2 || st.widthMin === st.widthMax) return `${st.widthMin} s`;
    const plotW = 60, h = 14, padSide = 13, w = plotW + padSide * 2;
    const x = (v) => padSide + (v - st.widthMin) / (st.widthMax - st.widthMin) * plotW;
    const midY = h / 2, boxH = 8, capH = 4;
    const xMin = x(st.widthMin), xMax = x(st.widthMax), xQ1 = x(st.widthQ1), xQ3 = x(st.widthQ3), xMed = x(st.widthMedian);
    const title = `min ${st.widthMin} s · Q1 ${st.widthQ1.toFixed(1)} s · Median ${st.widthMedian.toFixed(1)} s · Q3 ${st.widthQ3.toFixed(1)} s · max ${st.widthMax} s · Ø ${st.widthAvg.toFixed(1)} s · n=${st.n}`;
    return `<svg class="boxplot" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>${esc(title)}</title>` +
      `<text x="0" y="${midY + 3}" font-size="8">${st.widthMin}</text>` +
      `<line x1="${xMin.toFixed(1)}" y1="${midY}" x2="${xMax.toFixed(1)}" y2="${midY}" stroke="currentColor"/>` +
      `<line x1="${xMin.toFixed(1)}" y1="${(midY - capH / 2).toFixed(1)}" x2="${xMin.toFixed(1)}" y2="${(midY + capH / 2).toFixed(1)}" stroke="currentColor"/>` +
      `<line x1="${xMax.toFixed(1)}" y1="${(midY - capH / 2).toFixed(1)}" x2="${xMax.toFixed(1)}" y2="${(midY + capH / 2).toFixed(1)}" stroke="currentColor"/>` +
      `<rect x="${Math.min(xQ1, xQ3).toFixed(1)}" y="${(midY - boxH / 2).toFixed(1)}" width="${Math.max(1, Math.abs(xQ3 - xQ1)).toFixed(1)}" height="${boxH}" fill="var(--color-accent-100)" stroke="currentColor"/>` +
      `<line x1="${xMed.toFixed(1)}" y1="${(midY - boxH / 2).toFixed(1)}" x2="${xMed.toFixed(1)}" y2="${(midY + boxH / 2).toFixed(1)}" stroke="currentColor" stroke-width="1.5"/>` +
      `<text x="${w}" y="${midY + 3}" font-size="8" text-anchor="end">${st.widthMax}</text>` +
      `</svg>`;
  }
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
      rows.push(`<tr class="stats-dir-row"><td colspan="6" style="color:${color}">${esc(label)} · Engpass-Bandbreite ${bw} s (schmalste Plan-Grünzeit, Referenzwert - reale Bänder s. Spalte „Bandbreite")</td></tr>`);
      res.optimumBand.perStation.forEach(st => {
        rows.push(`<tr>
          <td>${esc(st.a.name)} → ${esc(st.b.name)}</td>
          <td>${st.entering}</td>
          <td>${st.surviving}</td>
          <td>${st.failed}</td>
          <td class="${rateCls(st.rate)}">${pct(st.rate)}</td>
          <td>${svgBoxplot(st)}</td>
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
        <td>${svgBoxplot(ov)}</td>
      </tr>`);
    });
    els.statsBody.innerHTML = rows.join('');
  }

  const round1 = (v) => v == null ? null : Math.round(v * 10) / 10;

  // XLSX-Export der Koordinationsstatistik: je Richtung ein Block (Übergänge
  // + Gesamtzeile), mit der vollen Bandbreiten-Kennzahl (min/Q1/Median/Q3/
  // max/Ø/n) statt nur des im Boxplot sichtbaren Ausschnitts.
  function exportStatsXlsx() {
    const dirs = [['Hinrichtung', lastResHin], ['Gegenrichtung', lastResRev]]
      .filter(([, res]) => res && res.ok && res.optimumBand);
    if (!dirs.length) { window.alert('Keine Koordinationsstatistik zum Exportieren vorhanden.'); return; }
    const header = [
      'Richtung', 'Übergang', 'Eintretend', 'Erfolgreich', 'Gescheitert', 'Quote (%)',
      'Breite Min (s)', 'Breite Q1 (s)', 'Breite Median (s)', 'Breite Q3 (s)', 'Breite Max (s)', 'Breite Ø (s)', 'n',
      'Engpass-Bandbreite Referenz (s)'
    ];
    const rows = [header];
    dirs.forEach(([label, res]) => {
      const bw = res.optimumBand.minTf;
      const widthRow = (st) => [st.widthMin, round1(st.widthQ1), round1(st.widthMedian), round1(st.widthQ3), st.widthMax, round1(st.widthAvg), st.n];
      res.optimumBand.perStation.forEach(st => {
        rows.push([label, `${st.a.name} → ${st.b.name}`, st.entering, st.surviving, st.failed, round1(st.rate * 100), ...widthRow(st), bw]);
      });
      const ov = res.optimumBand.overall;
      const first = res.optimumBand.ordered[0], last = res.optimumBand.ordered[res.optimumBand.ordered.length - 1];
      rows.push([label, `Gesamt (${first.name} → ${last.name})`, ov.totalCycles, ov.successCount, ov.failCount, round1(ov.rate * 100), ...widthRow(ov), bw]);
    });
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    App.xlsxWriter.download(`koordinationsstatistik-${ts}.xlsx`, [{ name: 'Koordinationsstatistik', rows }]);
  }
  els.btnExportStats.addEventListener('click', exportStatsXlsx);

  /* ---------------- Umlaufübersicht ---------------- */
  // Eine Zeile je realem Umlauf (Ursprungsgrünfenster am ersten Knoten) mit
  // Erfolg/Misserfolg der REALEN Durchfahrt über den ganzen Streckenzug
  // (unabhängig von der konstanten Optimum-Bandbreite, siehe
  // computeOptimumBand()'s realStages-Kette) - Klick
  // springt im Zeit-Weg-Diagramm direkt zu diesem Zeitpunkt. Umlauf-Nummer =
  // Index innerhalb der (ungefilterten) Zykluskette der jeweiligen Richtung.
  // Der Segment-Filter im Panel-Kopf (Alle/Durchfahrt/Gescheitert) grenzt auf
  // umlaufFilter ein. Bei sehr langen Aufzeichnungen wird die gefilterte
  // Liste je Richtung gekappt (Performance), mit Hinweis auf die Anzahl
  // ausgeblendeter Umläufe.
  const UMLAUF_TABLE_MAX = 500;
  // panelEl/bodyEl/filterValue parametrisiert, damit dieselbe Tabelle sowohl
  // neben dem klassischen als auch neben dem D3-Diagramm gerendert werden
  // kann (siehe die beiden Aufrufe in recompute()) - jede Instanz hat ihren
  // eigenen Filter-Zustand (umlaufFilter / umlaufFilterD3).
  function renderUmlaufTable(resHin, resRev, filterValue, panelEl, bodyEl) {
    const dirs = [['Hinrichtung', resHin, '#8a5a00'], ['Gegenrichtung', resRev, '#2b6ca3']]
      .filter(([, res]) => res.ok && res.optimumBand && res.optimumBand.cycles.length);
    if (dirs.length === 0) { panelEl.style.display = 'none'; return; }
    panelEl.style.display = 'block';
    const rows = [];
    dirs.forEach(([label, res, color]) => {
      const cycles = res.optimumBand.cycles;
      const filtered = cycles
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => filterValue === 'all' || (filterValue === 'ja' ? c.success : !c.success));
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
    bodyEl.innerHTML = rows.join('');
  }

  function wireUmlaufJump(bodyEl, getDiagramApi) {
    bodyEl.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-t]');
      const api = getDiagramApi();
      if (!row || !api) return;
      api.scrollToTime(Number(row.dataset.t));
    });
    bodyEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('tr[data-t]');
      const api = getDiagramApi();
      if (!row || !api) return;
      e.preventDefault();
      api.scrollToTime(Number(row.dataset.t));
    });
  }
  wireUmlaufJump(els.umlaufBody, () => diagramApi);
  wireUmlaufJump(els.d3UmlaufBody, () => diagramD3Api);

  function fmtDateTimeFull(ms) {
    const d = new Date(ms);
    const p = App.utils.pad;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // XLSX-Export der Umlaufübersicht: ALLE Umläufe (unabhängig vom
  // Bildschirmfilter/der Anzeige-Kappung UMLAUF_TABLE_MAX), je Richtung ein
  // Blatt, und - anders als die Bildschirmtabelle, die nur den
  // Gesamtausgang zeigt - je Umlauf zusätzlich ein Spaltenpaar
  // (erreicht/Breite) für JEDEN einzelnen Knoten (LSA) im Streckenzug, aus
  // cycles[].stations (siehe computeOptimumBand).
  function exportUmlaufXlsx() {
    const dirs = [['Hinrichtung', lastResHin], ['Gegenrichtung', lastResRev]]
      .filter(([, res]) => res && res.ok && res.optimumBand && res.optimumBand.cycles.length);
    if (!dirs.length) { window.alert('Keine Umlaufdaten zum Exportieren vorhanden.'); return; }
    const sheets = dirs.map(([label, res]) => {
      const stations = res.optimumBand.ordered.slice(1);
      const header = ['Umlauf', 'Start', 'Ende', 'Durchfahrt (gesamt)', 'Bandbreite gesamt (s)'];
      stations.forEach(n => header.push(`${n.name} erreicht`, `${n.name} Breite (s)`));
      const rows = [header];
      res.optimumBand.cycles.forEach((c, i) => {
        const row = [i, fmtDateTimeFull(c.start), fmtDateTimeFull(c.end), c.success ? 'Ja' : 'Nein', c.success ? c.finalWidth : null];
        c.stations.forEach(st => row.push(st.reached ? 'Ja' : 'Nein', st.width));
        rows.push(row);
      });
      return { name: `Umlaufübersicht ${label}`, rows };
    });
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    App.xlsxWriter.download(`umlaufuebersicht-${ts}.xlsx`, sheets);
  }
  els.btnExportUmlauf.addEventListener('click', exportUmlaufXlsx);
  els.d3BtnExportUmlauf.addEventListener('click', exportUmlaufXlsx);

  els.umlaufFilterSeg.addEventListener('change', (e) => {
    if (e.target.name !== 'umlaufFilter') return;
    umlaufFilter = e.target.value;
    recompute();
  });
  els.d3UmlaufFilterSeg.addEventListener('change', (e) => {
    if (e.target.name !== 'd3UmlaufFilter') return;
    umlaufFilterD3 = e.target.value;
    recompute();
  });

  /* ---------------- Y-Achsen-Zoom ---------------- */
  els.zoomOutBtn.addEventListener('click', () => setZoom(zoomLevel / ZOOM_STEP));
  els.zoomInBtn.addEventListener('click', () => setZoom(zoomLevel * ZOOM_STEP));
  els.zoomResetBtn.addEventListener('click', () => setZoom(1));
  els.d3ZoomOutBtn.addEventListener('click', () => setZoomD3(zoomLevelD3 / ZOOM_STEP));
  els.d3ZoomInBtn.addEventListener('click', () => setZoomD3(zoomLevelD3 * ZOOM_STEP));
  els.d3ZoomResetBtn.addEventListener('click', () => setZoomD3(1));

  // Strg/Cmd+Mausrad über dem Diagramm zoomt interaktiv in die Zeitachse
  // hinein/heraus (wie in Karten-/Grafikwerkzeugen üblich) - normales
  // Scrollen (ohne Strg) bleibt unverändert das Scrollen/Blättern durch die
  // Historie. Mehrere Wheel-Events pro Geste werden gesammelt und erst im
  // nächsten Frame in EINE Neuberechnung umgesetzt (kein Reflow pro Tick).
  function wireWheelZoom(el, getLevel, setLevel) {
    let pendingDelta = 0, raf = null;
    el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pendingDelta += e.deltaY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const factor = Math.pow(1.0018, -pendingDelta);
        pendingDelta = 0;
        raf = null;
        setLevel(getLevel() * factor);
      });
    }, { passive: false });
  }
  wireWheelZoom(els.diagram, () => zoomLevel, setZoom);
  wireWheelZoom(els.d3Diagram, () => zoomLevelD3, setZoomD3);

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
