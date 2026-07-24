/* Koordinierung – UI-Verdrahtung */
(function (App) {
  'use strict';
  const { esc, clamp } = App.utils;
  const { deriveVp, teilpunktabstand, lageLabel, computeProposedBand } = App.coordination;
  const { renderDiagram } = App.diagram;
  const state = App.state;

  const els = {
    btnAddFile: document.getElementById('btnAddFile'),
    fileInput: document.getElementById('fileInput'),
    dirSelect: document.getElementById('dirSelect'),
    cyclesInput: document.getElementById('cyclesInput'),
    bandSelect: document.getElementById('bandSelect'),
    baseStationInput: document.getElementById('baseStationInput'),
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
  function sigOptions(n, selectedCol) {
    return n.columns.map(c => {
      const hasGreen = !!n.planByCol.get(c.index);
      return `<option value="${c.index}" ${!hasGreen ? 'disabled' : ''} ${c.index === selectedCol ? 'selected' : ''}>${esc(c.name)}${hasGreen ? '' : ' ✕'}</option>`;
    }).join('');
  }

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
      const vpHinField = hinDisabled ? '' : `<div class="node-field hin">
            <label>V_p Hin [km/h]</label>
            <input type="number" class="node-dist-input node-vp-hin" min="1" step="1" value="${n.vpHin || 50}">
          </div>`;
      const revOffsetField = isLast
        ? `<div class="node-field rev">
            <label>Versatz Rück [m]</label>
            <input type="number" class="node-dist-input node-rev-offset" step="1" value="${n.revOffset || 0}" title="Positionsunterschied der Rück- zur Hin-Signalgruppe an diesem (letzten) Knoten">
          </div>`
        : `<div class="node-field rev">
            <label>Abstand Rück [m]</label>
            <input type="number" class="node-dist-input node-dist-rev" min="0" step="10" value="${distRev}">
          </div>
          <div class="node-field rev">
            <label>V_p Rück [km/h]</label>
            <input type="number" class="node-dist-input node-vp-rev" min="1" step="1" value="${n.vpRev || 50}">
          </div>`;
      return `<div class="node-card" data-id="${n.id}">
        <div class="node-order">
          <button type="button" class="icon-btn node-up" ${i === 0 ? 'disabled' : ''} title="nach oben">▲</button>
          <button type="button" class="icon-btn node-down" ${i === nodes.length - 1 ? 'disabled' : ''} title="nach unten">▼</button>
        </div>
        <div class="node-main">
          <div class="node-file">${esc(label)}${sub ? `<small>${sub}</small>` : ''}</div>
          <div class="node-file"><small>${esc(n.fileName)} · TU ${n.TU ?? '–'} s</small></div>
        </div>
        <div class="node-dir-fields">
          <div class="node-field hin">
            <label>Hauptsignal Hin</label>
            <select class="node-sig-select node-sig-hin">${sigOptions(n, n.mainColHin)}</select>
          </div>
          <div class="node-field hin">
            <label>Abstand Hin [m]</label>
            <input type="number" class="node-dist-input node-dist-hin" min="0" step="10" value="${distHin}" ${hinDisabled ? 'disabled' : ''}>
          </div>
          ${vpHinField}
          <div class="node-field rev">
            <label>Hauptsignal Rück</label>
            <select class="node-sig-select node-sig-rev">${sigOptions(n, n.mainColRev)}</select>
          </div>
          ${revOffsetField}
        </div>
        <button type="button" class="icon-btn node-remove" title="entfernen">×</button>
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
        an: plan.an, ab: plan.ab, tf: plan.tf
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
    const proposedBand = computeProposedBand(rows, vpArray, TU, dirTag);
    const ref = dirTag === 'fwd' ? rows[0] : rows[rows.length - 1];

    return { ok: true, dirKey, dirTag, rows, orderedRows, TU, tus, corridor, sMin, sMax, der, lTP, bw, bottleneck, spd, spdSpread, vpArray, proposedBand, ref };
  }

  function recompute() {
    if (state.intersections.length === 0) { hidePanels(); showHint(''); return; }

    const dirMode = els.dirSelect.value;
    const hinEnabled = dirMode !== 'rev';
    const revEnabled = dirMode !== 'fwd';
    const resHin = computeDirection('Hin', 'fwd', hinEnabled);
    const resRev = computeDirection('Rev', 'rev', revEnabled);

    if (!resHin.ok && !resRev.ok) {
      hidePanels();
      showHint('Mindestens zwei Knoten mit gültigem Hauptsignal und einem Abstand größer 0 (je Richtung) auswählen.', true);
      return;
    }

    const msgs = [];
    [['Hinrichtung', resHin], ['Gegenrichtung', resRev]].forEach(([label, res]) => {
      if (!res.ok) return;
      const uniqueTus = [...new Set(res.tus)];
      if (uniqueTus.length > 1 && (Math.max(...uniqueTus) - Math.min(...uniqueTus)) > 1) {
        msgs.push(`${label}: Umlaufzeiten der Knoten weichen voneinander ab (${uniqueTus.join(', ')} s).`);
      }
      if (res.spdSpread > 15) {
        msgs.push(`${label}: Progressionsgeschwindigkeit schwankt abschnittsweise deutlich (${Math.min(...res.spd).toFixed(0)}–${Math.max(...res.spd).toFixed(0)} km/h).`);
      }
      if (!res.proposedBand) {
        msgs.push(`${label}: V_p (Vorschlag) fehlt oder ist 0 auf mindestens einem Abschnitt – kein Grünband berechenbar.`);
      }
    });
    showHint(msgs.join(' '), msgs.length > 0);

    els.kpiPanel.style.display = 'block';
    els.diagramPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';

    /* ---- Kenngrößen ---- */
    const kpis = [{ label: 'System-Umlaufzeit t_U', value: (resHin.ok ? resHin.TU : resRev.TU) + ' s' }];
    [['Hin', resHin], ['Rück', resRev]].forEach(([tag, res]) => {
      if (!res.ok) return;
      kpis.push({ label: `Knoten im Zug ${tag}`, value: res.rows.length });
      kpis.push({ label: `Streckenlänge ${tag}`, value: res.corridor + ' m' });
      kpis.push({ label: `Teilpunktabstand l_TP ${tag}`, value: Math.round(res.lTP) + ' m', cls: 'accent' });
      kpis.push({ label: `V_p ${tag} (gemessen)`, value: res.der.vp_kmh.toFixed(1) + ' km/h', cls: 'accent' });
      if (res.bottleneck) kpis.push({ label: `Engste Stelle ${tag}`, value: res.bw.toFixed(0) + ' s', sub: res.bottleneck.name });
      if (res.proposedBand) {
        const vps = res.vpArray.filter(v => v > 0);
        const vpSub = vps.length
          ? (vps.every(v => v === vps[0]) ? `bei ${vps[0]} km/h` : `bei ${Math.min(...vps)}–${Math.max(...vps)} km/h je Abschnitt`)
          : '';
        kpis.push({
          label: `Bandbreite ${tag} (Vorschlag)`,
          value: res.proposedBand.bandwidth.toFixed(1) + ' s',
          sub: res.proposedBand.bandwidth <= 0 ? 'kein durchgehendes Band bei dieser Geschwindigkeit' : vpSub
        });
      }
    });
    els.kpiGrid.innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls || ''}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        ${k.sub ? `<div class="k-sub">${esc(k.sub)}</div>` : ''}
      </div>`).join('');

    /* ---- Diagramm ---- */
    const Ncyc = clamp(parseInt(els.cyclesInput.value, 10) || 6, 1, 16);
    const drawBand = els.bandSelect.value === 'on';
    const TU = resHin.ok ? resHin.TU : resRev.TU;
    const toDirGeom = (res, tag, tagColor, gridColor, bandFill, bandStroke) => res.ok ? {
      rows: res.rows, lTP: res.lTP,
      proposedBand: res.proposedBand, bandFill, bandStroke, tag, tagColor, gridColor
    } : null;
    renderDiagram(els.diagram, {
      TU, Ncyc, drawBand,
      hin: toDirGeom(resHin, 'H', '#8a5a00', 'rgba(211,161,37,0.6)', 'rgba(211,161,37,0.35)', 'rgba(138,90,0,0.7)'),
      rev: toDirGeom(resRev, 'R', '#2b6ca3', 'rgba(43,108,163,0.6)', 'rgba(43,108,163,0.30)', 'rgba(43,108,163,0.75)')
    });
    const parts = [];
    if (resHin.ok) parts.push(`Hin: ${resHin.rows.length} Knoten, l_TP ${Math.round(resHin.lTP)} m`);
    if (resRev.ok) parts.push(`Rück: ${resRev.rows.length} Knoten, l_TP ${Math.round(resRev.lTP)} m`);
    els.diagramInfo.textContent = `${parts.join(' · ')} · ${Ncyc} Umläufe`;

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

  [els.dirSelect, els.cyclesInput, els.bandSelect, els.baseStationInput].forEach(el => el.addEventListener('change', recompute));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(recompute, 150);
  });

  renderNodeList();
  recompute();
})(window.App = window.App || {});
