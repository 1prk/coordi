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
    vpFwdInput: document.getElementById('vpFwdInput'),
    vpRevInput: document.getElementById('vpRevInput'),
    errorBox: document.getElementById('errorBox'),
    nodeList: document.getElementById('nodeList'),
    hintBox: document.getElementById('hintBox'),
  };

  // Je Richtung ein identischer Satz von DOM-Referenzen (Suffix Hin/Rev).
  function dirEls(suffix) {
    return {
      section: document.getElementById('section' + suffix),
      kpiGrid: document.getElementById('kpiGrid' + suffix),
      diagramInfo: document.getElementById('diagramInfo' + suffix),
      diagram: document.getElementById('diagram' + suffix),
      tableBody: document.getElementById('tableBody' + suffix),
    };
  }
  const dirHin = dirEls('Hin');
  const dirRev = dirEls('Rev');

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
      dirHin.section.style.display = 'none';
      dirRev.section.style.display = 'none';
      showHint('');
      return;
    }
    els.nodeList.innerHTML = nodes.map((n, i) => {
      const label = n.knotenName || n.fileName;
      const sub = n.knotenNr ? `Nr. ${esc(n.knotenNr)}` : '';
      const disabled = i === 0 ? 'disabled' : '';
      const distHin = i === 0 ? 0 : n.distanceHin;
      const distRev = i === 0 ? 0 : n.distanceRev;
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
            <input type="number" class="node-dist-input node-dist-hin" min="0" step="10" value="${distHin}" ${disabled}>
          </div>
          <div class="node-field rev">
            <label>Hauptsignal Rück</label>
            <select class="node-sig-select node-sig-rev">${sigOptions(n, n.mainColRev)}</select>
          </div>
          <div class="node-field rev">
            <label>Abstand Rück [m]</label>
            <input type="number" class="node-dist-input node-dist-rev" min="0" step="10" value="${distRev}" ${disabled}>
          </div>
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
      card.querySelector('.node-dist-rev').addEventListener('change', (e) => { node.distanceRev = Number(e.target.value) || 0; recompute(); });
      card.querySelector('.node-remove').addEventListener('click', () => { state.removeIntersection(id); renderNodeList(); recompute(); });
      const upBtn = card.querySelector('.node-up');
      const downBtn = card.querySelector('.node-down');
      if (upBtn) upBtn.addEventListener('click', () => { state.moveIntersection(id, -1); renderNodeList(); recompute(); });
      if (downBtn) downBtn.addEventListener('click', () => { state.moveIntersection(id, 1); renderNodeList(); recompute(); });
    });
  }

  /* ---------------- Berechnung & Darstellung ---------------- */
  // dirKey: 'Hin' -> mainColHin/distanceHin, gefahren aufsteigend (dir='fwd')
  //         'Rev' -> mainColRev/distanceRev, gefahren absteigend (dir='rev')
  function collectRows(dirKey) {
    const colField = dirKey === 'Hin' ? 'mainColHin' : 'mainColRev';
    const distField = dirKey === 'Hin' ? 'distanceHin' : 'distanceRev';
    const nodes = state.intersections;
    let station = 0;
    const rows = [];
    let TUref = null;
    const tus = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (i > 0) station += Number(n[distField]) || 0;
      const col = n[colField];
      const plan = col != null ? n.planByCol.get(col) : null;
      if (!plan || !n.TU) continue;
      tus.push(n.TU);
      if (TUref == null) TUref = n.TU;
      const colInfo = n.columns.find(c => c.index === col);
      rows.push({
        name: n.knotenName || n.fileName,
        sgName: colInfo ? colInfo.name : '',
        station,
        an: plan.an, ab: plan.ab, tf: plan.tf
      });
    }
    return { rows, TU: TUref, tus };
  }

  // Rendert Kenngrößen, Diagramm und Tabelle für eine Richtung.
  function renderDirection(dirKey, dirTag, dirEl, vpProposedInput, bandFill, bandStroke) {
    const enabled = dirKey === 'Hin' ? (els.dirSelect.value !== 'rev') : (els.dirSelect.value !== 'fwd');
    if (!enabled) { dirEl.section.style.display = 'none'; return { ok: false }; }

    const { rows, TU, tus } = collectRows(dirKey);
    if (!TU || rows.length < 2) { dirEl.section.style.display = 'none'; return { ok: false, reason: rows.length < 2 ? 'nodes' : 'tu' }; }

    const sMin = rows[0].station, sMax = rows[rows.length - 1].station;
    const corridor = sMax - sMin;
    if (corridor <= 0) { dirEl.section.style.display = 'none'; return { ok: false, reason: 'corridor' }; }

    dirEl.section.style.display = 'block';

    const Ncyc = clamp(parseInt(els.cyclesInput.value, 10) || 6, 1, 16);
    const drawBand = els.bandSelect.value === 'measured';
    const der = deriveVp(rows, TU, dirTag);
    const lTP = teilpunktabstand(TU, dirTag === 'fwd' ? der.vp_kmh : 0, dirTag === 'rev' ? der.vp_kmh : 0);

    const entryRows = dirTag === 'fwd' ? rows.slice(0, rows.length - 1) : rows.slice(1);
    const bw = entryRows.length ? Math.min(...entryRows.map(r => r.tf)) : 0;
    const bottleneck = entryRows.length ? entryRows.reduce((a, b) => b.tf < a.tf ? b : a, entryRows[0]) : null;

    const spd = der.segs.map(s => s.vp_kmh).filter(v => v > 0);
    const spdSpread = spd.length > 1 ? (Math.max(...spd) - Math.min(...spd)) : 0;

    const kpis = [
      { label: 'System-Umlaufzeit t_U', value: TU + ' s' },
      { label: 'Teilpunktabstand l_TP', value: Math.round(lTP) + ' m', cls: 'accent' },
      { label: 'Knoten im Zug', value: rows.length },
      { label: 'Streckenlänge', value: corridor + ' m' },
      { label: 'V_p (gemessen)', value: der.vp_kmh.toFixed(1) + ' km/h', cls: 'accent' },
    ];
    if (bottleneck) kpis.push({ label: 'Engste Stelle', value: bw.toFixed(0) + ' s', sub: bottleneck.name });

    const vpProposed = Number(vpProposedInput.value) || 0;
    const proposedBand = vpProposed > 0 ? computeProposedBand(rows, vpProposed, TU, dirTag) : null;
    if (proposedBand) {
      kpis.push({
        label: 'Bandbreite (Vorschlag)',
        value: proposedBand.bandwidth.toFixed(1) + ' s',
        sub: proposedBand.bandwidth <= 0 ? 'kein durchgehendes Band bei dieser Geschwindigkeit' : `bei ${vpProposed} km/h`
      });
    }

    dirEl.kpiGrid.innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls || ''}">
        <div class="k-label">${k.label}</div>
        <div class="k-value">${k.value}</div>
        ${k.sub ? `<div class="k-sub">${esc(k.sub)}</div>` : ''}
      </div>`).join('');

    const orderedRows = dirTag === 'fwd' ? rows : rows.slice().reverse();
    renderDiagram(dirEl.diagram, rows, {
      TU, lTP, Ncyc, drawBand, orderedRows, measuredSegs: der.segs,
      proposedBand, bandFill, bandStroke
    });
    dirEl.diagramInfo.textContent = `${rows.length} Knoten · l_TP ${Math.round(lTP)} m · ${Ncyc} Umläufe`;

    const ref = dirTag === 'fwd' ? rows[0] : rows[rows.length - 1];
    dirEl.tableBody.innerHTML = rows.map((r, i) => {
      const abstand = i === 0 ? '–' : (r.station - rows[i - 1].station) + ' m';
      const versatz = (((r.an - ref.an) % TU) + TU) % TU;
      const E = corridor > 0 && lTP > 0 ? (r.station - sMin) / lTP : 0;
      const lage = lageLabel(E);
      return `<tr>
        <td>${esc(r.name)} <span style="color:var(--text-faint);font-family:var(--sans)">${esc(r.sgName)}</span></td>
        <td>${r.station} m</td><td>${abstand}</td>
        <td>${r.an}</td><td>${r.ab}</td><td>${r.tf} s</td>
        <td>${r === ref ? '0 (Bezug)' : '+' + versatz + ' s'}</td>
        <td>${E.toFixed(2)}</td><td>${lage}</td>
      </tr>`;
    }).join('');

    return { ok: true, tus, spdSpread, spd };
  }

  function recompute() {
    if (state.intersections.length === 0) {
      dirHin.section.style.display = 'none';
      dirRev.section.style.display = 'none';
      showHint('');
      return;
    }

    const resHin = renderDirection('Hin', 'fwd', dirHin, els.vpFwdInput, 'rgba(211,161,37,0.35)', 'rgba(138,90,0,0.7)');
    const resRev = renderDirection('Rev', 'rev', dirRev, els.vpRevInput, 'rgba(43,108,163,0.30)', 'rgba(43,108,163,0.75)');

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
    });
    if (!resHin.ok && !resRev.ok) {
      msgs.push('Mindestens zwei Knoten mit gültigem Hauptsignal und unterschiedlichem Abstand (je Richtung) auswählen.');
    }
    showHint(msgs.join(' '), msgs.length > 0);
  }

  [els.dirSelect, els.cyclesInput, els.bandSelect, els.vpFwdInput, els.vpRevInput].forEach(el => el.addEventListener('change', recompute));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(recompute, 150);
  });

  renderNodeList();
  recompute();
})(window.App = window.App || {});
