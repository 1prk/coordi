/* Koordinierung – UI-Verdrahtung */
(function (App) {
  'use strict';
  const { esc, clamp } = App.utils;
  const { deriveVp, teilpunktabstand, lageLabel } = App.coordination;
  const { renderDiagram } = App.diagram;
  const state = App.state;

  const els = {
    btnAddFile: document.getElementById('btnAddFile'),
    fileInput: document.getElementById('fileInput'),
    dirSelect: document.getElementById('dirSelect'),
    cyclesInput: document.getElementById('cyclesInput'),
    bandSelect: document.getElementById('bandSelect'),
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
  };

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.style.display = 'block';
  }
  function clearError() {
    els.errorBox.style.display = 'none';
    els.errorBox.textContent = '';
  }
  function showHint(msg, warn) {
    els.hintBox.textContent = msg;
    els.hintBox.className = 'hint-box' + (warn ? ' warn' : '');
    els.hintBox.style.display = msg ? 'block' : 'none';
  }
  function hidePanels() {
    els.kpiPanel.style.display = 'none';
    els.diagramPanel.style.display = 'none';
    els.tablePanel.style.display = 'none';
  }

  /* ---------------- Datei-Import ---------------- */
  els.btnAddFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    for (const file of files) {
      try {
        const text = await file.text();
        const entry = state.buildIntersection(file.name, text);
        state.addIntersection(entry);
        clearError();
      } catch (e) {
        showError(`${file.name}: ${e.message}`);
      }
    }
    renderNodeList();
    recompute();
  });

  /* ---------------- Knotenliste ---------------- */
  function renderNodeList() {
    const nodes = state.intersections;
    if (nodes.length === 0) {
      els.nodeList.innerHTML = '<div class="node-empty">Noch keine Knoten – über "+" eine OCIT-CSV je Knoten hinzufügen.</div>';
      hidePanels();
      showHint('');
      return;
    }
    els.nodeList.innerHTML = nodes.map((n, i) => {
      const label = n.knotenName || n.fileName;
      const sub = n.knotenNr ? `Nr. ${esc(n.knotenNr)}` : '';
      const options = n.columns.map(c => {
        const hasGreen = !!n.planByCol.get(c.index);
        return `<option value="${c.index}" ${!hasGreen ? 'disabled' : ''} ${c.index === n.mainCol ? 'selected' : ''}>${esc(c.name)}${hasGreen ? '' : ' (keine Grünlage)'}</option>`;
      }).join('');
      const distDisabled = i === 0 ? 'disabled' : '';
      const distVal = i === 0 ? 0 : n.distance;
      return `<div class="node-card" data-id="${n.id}">
        <div class="node-order">
          <button type="button" class="icon-btn node-up" ${i === 0 ? 'disabled' : ''} title="nach oben">▲</button>
          <button type="button" class="icon-btn node-down" ${i === nodes.length - 1 ? 'disabled' : ''} title="nach unten">▼</button>
        </div>
        <div class="node-main">
          <div class="node-file">${esc(label)}${sub ? `<small>${sub}</small>` : ''}</div>
          <div class="node-file"><small>${esc(n.fileName)} · TU ${n.TU ?? '–'} s</small></div>
        </div>
        <div class="node-field">
          <label>Hauptsignal</label>
          <select class="node-main-select">${options}</select>
        </div>
        <div class="node-field">
          <label>Abstand z. Vorgänger [m]</label>
          <input type="number" class="node-distance" min="0" step="10" value="${distVal}" ${distDisabled}>
        </div>
        <button type="button" class="icon-btn node-remove" title="entfernen">×</button>
      </div>`;
    }).join('');

    els.nodeList.querySelectorAll('.node-card').forEach(card => {
      const id = card.dataset.id;
      const node = nodes.find(n => n.id === id);
      card.querySelector('.node-main-select').addEventListener('change', (e) => {
        node.mainCol = Number(e.target.value);
        recompute();
      });
      card.querySelector('.node-distance').addEventListener('change', (e) => {
        node.distance = Number(e.target.value) || 0;
        recompute();
      });
      card.querySelector('.node-remove').addEventListener('click', () => {
        state.removeIntersection(id);
        renderNodeList();
        recompute();
      });
      const upBtn = card.querySelector('.node-up');
      const downBtn = card.querySelector('.node-down');
      if (upBtn) upBtn.addEventListener('click', () => { state.moveIntersection(id, -1); renderNodeList(); recompute(); });
      if (downBtn) downBtn.addEventListener('click', () => { state.moveIntersection(id, 1); renderNodeList(); recompute(); });
    });
  }

  /* ---------------- Berechnung & Darstellung ---------------- */
  function collectRows() {
    const nodes = state.intersections;
    let station = 0;
    const rows = [];
    let TUref = null;
    const tus = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (i > 0) station += Number(n.distance) || 0;
      const plan = n.mainCol != null ? n.planByCol.get(n.mainCol) : null;
      if (!plan || !n.TU) continue;
      tus.push(n.TU);
      if (TUref == null) TUref = n.TU;
      const col = n.columns.find(c => c.index === n.mainCol);
      rows.push({
        name: n.knotenName || n.fileName,
        sgName: col ? col.name : '',
        station,
        an: plan.an, ab: plan.ab, tf: plan.tf
      });
    }
    return { rows, TU: TUref, tus };
  }

  function recompute() {
    if (state.intersections.length === 0) { hidePanels(); showHint(''); return; }

    const { rows, TU, tus } = collectRows();

    if (!TU) { hidePanels(); showHint('Keine System-Umlaufzeit ermittelbar – zu wenige Umlaufgrenzen (TX=0) in den Daten.', true); return; }
    if (rows.length < 2) { hidePanels(); showHint('Mindestens zwei Knoten mit gültigem Hauptsignal auswählen.', true); return; }

    const uniqueTus = [...new Set(tus)];
    let tuWarn = '';
    if (uniqueTus.length > 1 && (Math.max(...uniqueTus) - Math.min(...uniqueTus)) > 1) {
      tuWarn = `Hinweis: Die Umlaufzeiten der Knoten weichen voneinander ab (${uniqueTus.join(', ')} s) – es wird t_U = ${TU} s (erster Knoten) verwendet.`;
    }

    const Ncyc = clamp(parseInt(els.cyclesInput.value, 10) || 6, 1, 16);
    const dirMode = els.dirSelect.value;
    const drawBand = els.bandSelect.value === 'measured';

    const sMin = rows[0].station, sMax = rows[rows.length - 1].station;
    const corridor = sMax - sMin;
    const anRef = rows[0].an;

    if (corridor <= 0) { hidePanels(); showHint('Bitte unterschiedliche Abstände (in Metern) für die Knoten eintragen.', true); return; }

    const derFwd = deriveVp(rows, TU, 'fwd');
    const derRev = deriveVp(rows, TU, 'rev');
    const useFwd = dirMode !== 'rev';
    const useRev = dirMode !== 'fwd';
    const lTP = teilpunktabstand(TU, useFwd ? derFwd.vp_kmh : 0, useRev ? derRev.vp_kmh : 0);

    const fwdEntryRows = rows.slice(0, rows.length - 1);
    const revEntryRows = rows.slice(1);
    const bwFwd = fwdEntryRows.length ? Math.min(...fwdEntryRows.map(r => r.tf)) : 0;
    const bwRev = revEntryRows.length ? Math.min(...revEntryRows.map(r => r.tf)) : 0;
    const bottleneckFwd = fwdEntryRows.length ? fwdEntryRows.reduce((a, b) => b.tf < a.tf ? b : a, fwdEntryRows[0]) : null;
    const bottleneckRev = revEntryRows.length ? revEntryRows.reduce((a, b) => b.tf < a.tf ? b : a, revEntryRows[0]) : null;

    const refSegs = useFwd ? derFwd.segs : derRev.segs;
    const spd = refSegs.map(s => s.vp_kmh).filter(v => v > 0);
    const spdSpread = spd.length > 1 ? (Math.max(...spd) - Math.min(...spd)) : 0;
    let warnMsg = tuWarn;
    if (spdSpread > 15) {
      warnMsg += (warnMsg ? ' ' : '') + `Die abschnittsweise Progressionsgeschwindigkeit schwankt deutlich (${Math.min(...spd).toFixed(0)}–${Math.max(...spd).toFixed(0)} km/h).`;
    }
    showHint(warnMsg, !!warnMsg);

    els.kpiPanel.style.display = 'block';
    els.diagramPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';

    const kpis = [
      { label: 'System-Umlaufzeit t_U', value: TU + ' s' },
      { label: 'Teilpunktabstand l_TP', value: Math.round(lTP) + ' m', cls: 'accent' },
      { label: 'Knoten im Zug', value: rows.length },
      { label: 'Streckenlänge', value: corridor + ' m' },
    ];
    if (useFwd) kpis.push({ label: 'V_p Hinrichtung', value: derFwd.vp_kmh.toFixed(1) + ' km/h', cls: 'accent' });
    if (useRev) kpis.push({ label: 'V_p Gegenrichtung', value: derRev.vp_kmh.toFixed(1) + ' km/h', cls: 'accent' });
    if (useFwd && bottleneckFwd) kpis.push({ label: 'Engste Stelle Hinrichtung', value: bwFwd.toFixed(0) + ' s', sub: bottleneckFwd.name });
    if (useRev && bottleneckRev) kpis.push({ label: 'Engste Stelle Gegenrichtung', value: bwRev.toFixed(0) + ' s', sub: bottleneckRev.name });
    els.kpiGrid.innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls || ''}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        ${k.sub ? `<div class="k-sub">${esc(k.sub)}</div>` : ''}
      </div>`).join('');

    renderDiagram(els.diagram, rows, { TU, lTP, Ncyc, sMin, sMax, corridor, drawBand, useFwd, useRev, segsFwd: derFwd.segs, segsRev: derRev.segs });
    els.diagramInfo.textContent = `${rows.length} Knoten · l_TP ${Math.round(lTP)} m · ${Ncyc} Umläufe`;

    els.tableBody.innerHTML = rows.map((r, i) => {
      const abstand = i === 0 ? '–' : (r.station - rows[i - 1].station) + ' m';
      const versatz = (((r.an - anRef) % TU) + TU) % TU;
      const E = corridor > 0 && lTP > 0 ? (r.station - sMin) / lTP : 0;
      const lage = lageLabel(E);
      return `<tr>
        <td>${esc(r.name)} <span style="color:var(--text-faint);font-family:var(--sans)">${esc(r.sgName)}</span></td>
        <td>${r.station} m</td><td>${abstand}</td>
        <td>${r.an}</td><td>${r.ab}</td><td>${r.tf} s</td>
        <td>${i === 0 ? '0 (Bezug)' : '+' + versatz + ' s'}</td>
        <td>${E.toFixed(2)}</td><td>${lage}</td>
      </tr>`;
    }).join('');
  }

  [els.dirSelect, els.cyclesInput, els.bandSelect].forEach(el => el.addEventListener('change', recompute));

  renderNodeList();
  recompute();
})(window.App = window.App || {});
