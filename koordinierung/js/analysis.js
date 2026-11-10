/* Koordinierung - vehicle analysis panel: figures, node table and charts.
   The module draws the result of App.vehicle.simulate. It has no state.
   The panel shows a speed chart v(t) and an acceleration chart a(t). Both
   charts use the same time axis (seconds since the start of the vehicle). */
(function (App) {
  'use strict';
  const { esc, fmtTimeShort } = App.utils;

  const f0 = (x) => Number(x).toFixed(0);
  const f1 = (x) => Number(x).toFixed(1);

  // Figure tiles above the charts.
  function kpiHtml(sim) {
    const s = sim.summary;
    const tiles = [];
    const outcome = sim.reachedEnd
      ? (s.stops === 0 ? { v: 'Durchgehend', cls: 'accent', sub: 'ohne Halt bis zum letzten Knoten' }
        : { v: `${s.stops} Halt${s.stops > 1 ? 'e' : ''}`, cls: 'warn', sub: 'bis zum letzten Knoten' })
      : { v: 'Abgebrochen', cls: 'warn', sub: sim.ended || 'Ziel nicht erreicht' };
    tiles.push({ label: 'Ergebnis', value: outcome.v, cls: outcome.cls, sub: outcome.sub });
    tiles.push({ label: 'Reisezeit', value: `${f0(s.travelS)} s`, sub: `ab Abfahrt, ${f0(s.distanceM)} m` });
    tiles.push({ label: 'Ø Geschwindigkeit', value: `${f1(s.avgKmh)} km/h`, sub: `Maximum ${f0(s.vMaxKmh)} km/h` });
    if (s.delayS != null) {
      tiles.push({
        label: 'Verlustzeit', value: `${f0(s.delayS)} s`, cls: s.delayS > 1 ? 'warn' : '',
        sub: `gegenüber freier Fahrt (${f0(s.freeTravelS)} s)`
      });
    }
    tiles.push({ label: 'Wartezeit im Halt', value: `${f0(s.waitS)} s`, sub: 'ohne Anfahrverlustzeit am Start' });
    return tiles.map(t => `
      <div class="kpi card elev-sm ${t.cls || ''}">
        <div class="k-label">${esc(t.label)}</div>
        <div class="k-value">${esc(t.value)}</div>
        ${t.sub ? `<div class="k-sub">${esc(t.sub)}</div>` : ''}
      </div>`).join('');
  }

  // One row for each node that the vehicle reached.
  function eventsHtml(sim) {
    const rows = sim.events.map(e => {
      const t = (e.tArrive - sim.tOrigin) / 1000;
      let result;
      if (e.redRun) result = '<span class="stat-bad">Rotlichtverstoß (kann nicht anhalten)</span>';
      else if (e.stopped) {
        result = `<span class="stat-bad">Halt bei Rot</span>`
          + (e.waitS != null ? `, Wartezeit ${f0(e.waitS)} s` : '')
          + (e.endsHere ? ' (Ende der Simulation)' : '')
          + (e.noMoreGreen ? ' (kein weiteres Grün)' : '');
      } else {
        result = `<span class="stat-ok">Durchfahrt</span>, ${f0(e.sinceGreenS)} s nach Grünbeginn, Rest-Grün ${f0(e.greenMarginS)} s`;
      }
      return `<tr>
        <td>${esc(e.name)}</td>
        <td>${f0(e.station)} m</td>
        <td>${fmtTimeShort(e.tArrive)} (+${f1(t)} s)</td>
        <td>${f0(e.vArrive * 3.6)} km/h</td>
        <td>${result}</td>
      </tr>`;
    });
    const start = sim.nodes[sim.startIdx];
    rows.unshift(`<tr>
        <td>${esc(start.name)}</td><td>${f0(start.station)} m</td>
        <td>${fmtTimeShort(sim.summary.tDepart)} (+${f1((sim.summary.tDepart - sim.tOrigin) / 1000)} s)</td>
        <td>0 km/h</td><td>Start (Fahrzeug steht an der Haltlinie)</td>
      </tr>`);
    return rows.join('');
  }

  // EXPERIMENTAL platoon (see platoon.js): figure tiles.
  // pl = { res, batch } (result of one run and statistics over several seeds).
  function platoonKpiHtml(pl) {
    const s = pl.res.summary, b = pl.batch;
    const tiles = [
      {
        label: 'Ohne Halt durch', value: `${s.throughCount} von ${s.nCars}`,
        cls: s.throughCount === s.nCars ? 'accent' : (s.throughCount < s.nCars / 2 ? 'warn' : ''),
        sub: `dieser Lauf · Ø ${f1(b.mean)} in ${b.runs} Läufen (10–90 %: ${b.p10}–${b.p90})`
      },
      {
        label: 'Start verpasst', value: `${s.missedFirstGreenCount}`, cls: s.missedFirstGreenCount ? 'warn' : '',
        sub: 'kamen im ersten Grün nicht über die erste Haltlinie'
      },
      {
        label: 'Abfluss-Zeitabstand', value: s.meanHeadwayS != null ? `${f1(s.meanHeadwayS)} s` : '–',
        sub: 'Ø an der ersten Haltlinie (Richtwert ca. 2 s)'
      },
      {
        label: 'Ø Reisezeit', value: s.meanTravelS != null ? `${f0(s.meanTravelS)} s` : '–',
        sub: 'ab erster Haltlinie, nur angekommene Fahrzeuge'
      },
      {
        label: 'Beschleunigung', value: s.accel.kind === 'linear' ? `${f1(s.accel.a0)} → ${f1(s.accel.aAtTarget)} m/s²` : `${f1(s.accel.a0)} m/s²`,
        sub: `${s.accel.kind === 'linear' ? 'linear fallend' : 'konstant'} · Fahrer ${f0(s.accel.factorMin * 100)}–${f0(s.accel.factorMax * 100)} % (σ ${f0(s.accel.sigma * 100)} %)`
      },
      {
        label: 'Modellraster', value: `${f1(s.cellM)} m`,
        sub: `v_max ${s.vMaxKmh.map(v => f1(v)).join(' / ')} km/h (auf das Raster gerundet)`
      }
    ];
    return tiles.map(t => `
      <div class="kpi card elev-sm ${t.cls || ''}">
        <div class="k-label">${esc(t.label)}</div>
        <div class="k-value">${esc(t.value)}</div>
        <div class="k-sub">${esc(t.sub)}</div>
      </div>`).join('');
  }

  // One row for each car of the platoon.
  function platoonCarsHtml(pl, tOrigin) {
    const at = (t) => (t == null ? '–' : `${fmtTimeShort(t)} (+${f1((t - tOrigin) / 1000)} s)`);
    return pl.res.cars.map(c => {
      let result;
      if (c.through) result = '<span class="stat-ok">ohne Halt durch</span>';
      else if (c.missedFirstGreen) result = '<span class="stat-bad">Start verpasst</span> (hält am ersten Knoten erneut)';
      else if (!c.finished) result = '<span class="stat-bad">nicht angekommen</span>';
      else result = `<span class="stat-warn">${c.stops} Halt${c.stops > 1 ? 'e' : ''}</span>`;
      return `<tr>
        <td>${c.isLead ? '1 (Führung)' : c.index + 1}</td>
        <td>${at(c.cross0)}</td>
        <td>${c.stops}</td>
        <td>${at(c.crossLast)}</td>
        <td>${c.travelS != null ? f0(c.travelS) + ' s' : '–'}</td>
        <td>${result}</td>
      </tr>`;
    }).join('');
  }

  // Draw the two charts into the element `el`.
  // handlers.onHover(point | null): called when the mouse moves over a chart.
  // The point has { tMs, s, station, v, a }.
  function renderCharts(el, sim, handlers, platoon) {
    const d3 = window.d3;
    el.innerHTML = '';
    if (!d3) { el.textContent = 'D3.js konnte nicht geladen werden.'; return; }
    const pts = App.vehicle.samplePoints(sim, 0.25);
    const tS = (p) => (p.tMs - sim.tOrigin) / 1000;
    let tEnd = Math.max(1, tS(pts[pts.length - 1]));
    // Experimental platoon: the follower speeds are drawn as thin grey lines.
    // The time axis reaches until the last car has crossed the last node.
    const plTraces = platoon && platoon.res.traces ? platoon.res.traces : null;
    if (plTraces) {
      const fin = platoon.res.cars.map(c => c.crossLast).filter(t => t != null);
      if (fin.length) tEnd = Math.max(tEnd, (Math.max(...fin) - sim.tOrigin) / 1000 + 8);
    }
    const W = Math.max(420, el.clientWidth || 800);
    const m = { l: 56, r: 14, t: 10, b: 36 };
    const innerW = W - m.l - m.r;
    const x = d3.scaleLinear().domain([0, tEnd]).range([m.l, m.l + innerW]);

    const vMaxKmh = Math.max(10, ...pts.map(p => p.v * 3.6));
    const aAbs = Math.max(0.5, ...pts.map(p => Math.abs(p.a)));
    const charts = [
      { key: 'v', title: 'Geschwindigkeit v [km/h]', h: 170, domain: [0, vMaxKmh * 1.12], val: p => p.v * 3.6, step: false },
      { key: 'a', title: 'Beschleunigung a [m/s²]', h: 120, domain: [-aAbs * 1.25, aAbs * 1.25], val: p => p.a, step: true }
    ];

    const cursorLines = [];
    if (plTraces) {
      d3.select(el).append('div').attr('class', 'analysis-readout')
        .html('<span style="color:#14181f;font-weight:700;">━</span> Führungsfahrzeug &nbsp; <span style="color:#5b6b8a;font-weight:700;">━</span> Pulk (EXPERIMENTELL, 1 Zufallslauf)');
    }
    const readout = d3.select(el).append('div').attr('class', 'analysis-readout').text('Maus über ein Diagramm bewegen');
    const bisect = d3.bisector(p => tS(p)).center;

    function update(point) {
      cursorLines.forEach(c => {
        if (!point) { c.attr('opacity', 0); return; }
        c.attr('x1', x(tS(point))).attr('x2', x(tS(point))).attr('opacity', 0.85);
      });
      readout.text(point
        ? `t = ${f1(tS(point))} s · Weg = ${f0(point.s)} m · v = ${f1(point.v * 3.6)} km/h · a = ${(point.a >= 0 ? '+' : '') + point.a.toFixed(2)} m/s²`
        : 'Maus über ein Diagramm bewegen');
      if (handlers && handlers.onHover) handlers.onHover(point);
    }

    charts.forEach((c, ci) => {
      const H = c.h + m.t + m.b;
      const y = d3.scaleLinear().domain(c.domain).range([m.t + c.h, m.t]);
      const svg = d3.select(el).append('svg').attr('class', 'analysis-chart').attr('width', W).attr('height', H)
        .attr('viewBox', `0 0 ${W} ${H}`).attr('font-family', 'Consolas, ui-monospace, monospace');
      svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', innerW).attr('height', c.h).attr('fill', '#fff').attr('stroke', 'var(--border-strong)');

      // Grey areas: the vehicle waits (red phase at a stop line).
      sim.phases.filter(p => p.kind === 'wait' && !p.initial).forEach(p => {
        svg.append('rect').attr('x', x(p.t0)).attr('y', m.t).attr('width', Math.max(1, x(p.t1) - x(p.t0))).attr('height', c.h)
          .attr('fill', 'var(--sig-red)').attr('opacity', 0.10)
          .append('title').text(`Halt: ${f0(p.t1 - p.t0)} s`);
      });

      svg.append('g').attr('transform', `translate(0,${m.t + c.h})`).call(d3.axisBottom(x).ticks(Math.min(12, Math.max(4, Math.floor(innerW / 70)))).tickSizeOuter(0))
        .selectAll('text').attr('font-size', 9);
      svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSizeOuter(0))
        .selectAll('text').attr('font-size', 9);
      svg.selectAll('.domain, .tick line').attr('stroke', 'var(--text-faint)');
      svg.append('text').attr('x', 8).attr('y', m.t + c.h / 2).attr('font-size', 10).attr('fill', 'var(--text-muted)')
        .attr('transform', `rotate(-90 8 ${m.t + c.h / 2})`).attr('text-anchor', 'middle').text(c.title);
      if (ci === charts.length - 1) {
        svg.append('text').attr('x', m.l + innerW / 2).attr('y', H - 2).attr('font-size', 10).attr('text-anchor', 'middle')
          .attr('fill', 'var(--text-muted)').text('Zeit seit Grünbeginn [s]');
      }
      if (c.domain[0] < 0) {
        svg.append('line').attr('x1', m.l).attr('x2', m.l + innerW).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'var(--text-faint)').attr('stroke-dasharray', '3 3');
      }

      // Lines at the arrival at each node (red = stop, grey = pass).
      sim.events.forEach(e => {
        const xe = x((e.tArrive - sim.tOrigin) / 1000);
        svg.append('line').attr('x1', xe).attr('x2', xe).attr('y1', m.t).attr('y2', m.t + c.h)
          .attr('stroke', e.stopped ? 'var(--sig-red)' : 'var(--text-faint)').attr('stroke-dasharray', '2 3');
        if (ci === 0) {
          const nearRight = xe > m.l + innerW - 90;
          svg.append('text').attr('x', nearRight ? xe - 3 : xe + 3).attr('y', m.t + 10).attr('font-size', 9)
            .attr('text-anchor', nearRight ? 'end' : 'start')
            .attr('fill', e.stopped ? 'var(--sig-red)' : 'var(--text-muted)').text(e.name);
        }
      });

      if (c.key === 'v' && plTraces) {
        const clipId = 'plClip' + Math.random().toString(36).slice(2, 8);
        svg.append('clipPath').attr('id', clipId).append('rect').attr('x', m.l).attr('y', m.t).attr('width', innerW).attr('height', c.h);
        const gPl = svg.append('g').attr('clip-path', `url(#${clipId})`);
        const plLine = d3.line().x(p => x((p.tMs - sim.tOrigin) / 1000)).y(p => y(p.v * 3.6));
        plTraces.forEach(tr => gPl.append('path').attr('d', plLine(tr)).attr('fill', 'none')
          .attr('stroke', '#5b6b8a').attr('stroke-width', 1).attr('stroke-opacity', 0.65).attr('stroke-linejoin', 'round'));
      }
      const line = d3.line().x(p => x(tS(p))).y(p => y(c.val(p)));
      svg.append('path').datum(pts).attr('d', line).attr('fill', 'none').attr('stroke', '#000').attr('stroke-width', 1.8).attr('stroke-linejoin', 'round');

      const cur = svg.append('line').attr('y1', m.t).attr('y2', m.t + c.h).attr('stroke', '#ff9800').attr('stroke-width', 1.5).attr('opacity', 0).attr('pointer-events', 'none');
      cursorLines.push(cur);
      svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', innerW).attr('height', c.h).attr('fill', 'transparent')
        .on('mousemove', (event) => {
          const rect = svg.node().getBoundingClientRect();
          const px = (event.clientX - rect.left) * (W / (rect.width || W));
          const t = Math.min(tEnd, Math.max(0, x.invert(px)));
          update(pts[bisect(pts, t)]);
        })
        .on('mouseleave', () => update(null));
    });
  }

  App.analysis = { kpiHtml, eventsHtml, renderCharts, platoonKpiHtml, platoonCarsHtml };
})(window.App = window.App || {});
