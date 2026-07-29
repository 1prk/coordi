/* Koordinierung – Zeit-Weg-Diagramm, D3.js-Prototyp (siehe diagram.js für die
   "klassische" Variante, die dieses Modul NICHT ersetzt - beide laufen
   parallel, siehe Tabs "Diagramm" und "Diagramm (D3)"). Gleiche Eingabedaten
   und Geometrie wie diagram.js, aber andere Rendertechnik:

   - EIN <svg> in fester Größe statt einem wachsenden SVG in einem
     scrollenden Container. Nur die Zeitachse (Y) ist zoombar/verschiebbar,
     über d3-zoom + transform.rescaleY() - die Weg-Achse (X) bleibt fix, da
     d3.zoom's x-Anteil des Transforms hier nie angewendet wird (dadurch
     wirkt Ziehen nur vertikal, "kostenlos" ohne eigene Constraint-Logik).
   - Kopf-/Fußzeile sind dadurch normale (nicht "sticky") SVG-Gruppen im
     selben Canvas - sie hängen nur von der (fixen) Weg-Achse ab, nicht von
     der Zeitachse, brauchen also kein eigenes Scroll-Sync mehr.
   - Bänder/Knotenlinien/Detektor-Marken werden über d3-Data-Joins
     (enter/update/exit) neu positioniert statt den kompletten SVG-String
     neu zusammenzusetzen; auf jeden Zoom-Tick per requestAnimationFrame
     gedrosselt. */
(function (App) {
  'use strict';
  const { fmtTimeShort, fmtDateTimeShort, fmtElapsed } = App.utils;

  const STATION_VISUAL_BUFFER_M = 10;
  const TU_FRACS = [60, 40, 20, 10, 8, 5, 4, 2, 1];
  function pickTxGridStep(TU, pxPerSec, minPx) {
    for (const f of TU_FRACS) {
      const step = TU / f;
      if (step * pxPerSec >= minPx) return step;
    }
    return TU;
  }

  const bandColor = {
    H: { qual: '#1b5e20', opt: '#39ff14' },
    R: { qual: '#0b3d91', opt: '#00e5ff' }
  };
  const DET_COLOR = '#6a3fa0';
  const ZOOM_MIN = 0.1, ZOOM_MAX = 30;

  function renderDiagram(container, o) {
    const d3 = window.d3;
    container.innerHTML = '';
    if (!d3) {
      container.innerHTML = '<div class="node-empty">D3.js konnte nicht geladen werden (lib/d3.v7.min.js fehlt oder blockiert).</div>';
      return null;
    }
    const { TU, showQualitative, showOptimum, showTimestamp, globalTMin, globalTMax, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0 || !(globalTMax > globalTMin)) return null;

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const sMinPlot = sMin - STATION_VISUAL_BUFFER_M, sMaxPlot = sMax + STATION_VISUAL_BUFFER_M;

    const mL = 56, mR = 56;
    const headerH = 20 + Math.max(0, dirs.length - 1) * 15;
    const mT = headerH + 8;
    const VIEWPORT_H = 560;
    // 40px je Richtung statt 26px: Platz für bis zu zwei Namenszeilen (Knoten-
    // namen mit "/" brechen um, siehe Fußzeile unten) über der Maßketten-Zeile.
    const FOOTER_ROW_H = 40;
    const footerH = FOOTER_ROW_H + Math.max(0, dirs.length - 1) * FOOTER_ROW_H + 16;
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);
    const W = mL + plotW + mR;
    const H = mT + VIEWPORT_H + footerH;

    const xScale = d3.scaleLinear().domain([sMinPlot, sMaxPlot]).range([mL, mL + plotW]);
    const X = s => xScale(s);

    const CYCLES_VISIBLE = 3;
    const basePxPerSec = Math.min(60, Math.max(0.01, VIEWPORT_H / (CYCLES_VISIBLE * TU)));
    const totalSec = (globalTMax - globalTMin) / 1000;
    const fullContentH = Math.max(VIEWPORT_H, totalSec * basePxPerSec);
    // Basis-Skala über die GESAMTE Aufzeichnung auf ihre "natürliche" (meist
    // viel größere als der Viewport) Pixelhöhe - der Zoom-Transform
    // (rescaleY) blendet daraus jeweils den sichtbaren Ausschnitt in den
    // festen Viewport ein/aus. tMin unten (großer Pixelwert), tMax oben -
    // wie im klassischen Diagramm läuft die Zeit nach oben.
    const yScale0 = d3.scaleLinear().domain([globalTMin, globalTMax]).range([fullContentH, 0]);

    const svg = d3.select(container).append('svg')
      .attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
      .style('font-family', 'Consolas, ui-monospace, monospace').style('display', 'block').style('background', '#fff');

    const defs = svg.append('defs');
    const clipId = 'd3clip' + Math.random().toString(36).slice(2, 8);
    defs.append('clipPath').attr('id', clipId).append('rect')
      .attr('x', 0).attr('y', mT).attr('width', W).attr('height', VIEWPORT_H);

    function hatchPattern(id, color, angleDeg) {
      const p = defs.append('pattern').attr('id', id).attr('width', 6).attr('height', 6)
        .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', `rotate(${angleDeg})`);
      p.append('rect').attr('width', 6).attr('height', 6).attr('fill', color).attr('fill-opacity', 0.2);
      p.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', color).attr('stroke-width', 2);
      return `url(#${id})`;
    }
    const hatchId = 'd3h' + Math.random().toString(36).slice(2, 8);
    const bandFill = {
      H: { qual: hatchPattern(hatchId + 'Hq', bandColor.H.qual, 45), opt: hatchPattern(hatchId + 'Ho', bandColor.H.opt, -45) },
      R: { qual: hatchPattern(hatchId + 'Rq', bandColor.R.qual, -45), opt: hatchPattern(hatchId + 'Ro', bandColor.R.opt, 45) }
    };

    svg.append('rect').attr('x', mL).attr('y', mT).attr('width', plotW).attr('height', VIEWPORT_H)
      .attr('fill', '#fff').attr('stroke', 'var(--border-strong)');

    // Teilpunkt-Raster: hängt nur von der (fixen) Weg-Achse ab, einmalig.
    const gTeilpunkt = svg.append('g').attr('clip-path', `url(#${clipId})`);
    dirs.forEach(d => {
      if (!(d.lTP > 0 && (sMax - sMin) > 0)) return;
      const dsMin = d.rows[0].station;
      const xs = [];
      for (let m = 0; dsMin + m * d.lTP <= sMax + 0.5; m++) {
        const s = dsMin + m * d.lTP;
        if (s < sMin - 0.5) continue;
        xs.push(X(s));
      }
      gTeilpunkt.selectAll(null).data(xs).enter().append('line')
        .attr('x1', x => x).attr('x2', x => x).attr('y1', mT).attr('y2', mT + VIEWPORT_H)
        .attr('stroke', d.gridColor).attr('stroke-width', 1).attr('stroke-dasharray', '2 4').attr('opacity', 0.5);
    });

    // Kopfzeile (SG-Namen je Knoten/Richtung) und Fußzeile (Knotennamen +
    // Maßketten) hängen nur von X (Weg-Achse) ab - fix, kein erneutes
    // Zeichnen beim Zoomen nötig (anders als im klassischen Diagramm gibt es
    // hier keine "sticky" Divs, sondern normale, feste SVG-Gruppen).
    const gHeader = svg.append('g');
    dirs.forEach((d, di) => {
      d.rows.forEach(r => {
        gHeader.append('text').attr('x', X(r.station)).attr('y', 2 + di * 15 + 9)
          .attr('font-size', 10).attr('font-weight', 800).attr('fill', d.tagColor)
          .text(`${d.tag} ${r.sgName}`);
      });
    });

    const gFooter = svg.append('g').attr('transform', `translate(0,${mT + VIEWPORT_H})`);
    gFooter.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', footerH).attr('fill', 'var(--bg-panel)');
    dirs.forEach((d, di) => {
      const labelY = 14 + di * FOOTER_ROW_H;
      d.rows.forEach(r => {
        // Knotenname bricht bei "/" um (z. B. "Bahnhofstraße/Musterstraße") -
        // die Richtungs-Kennung (H/R) bleibt auf der ersten Zeile.
        const x = X(r.station);
        const parts = String(r.name).split('/');
        const label = gFooter.append('text').attr('text-anchor', 'middle')
          .attr('font-size', 10).attr('font-weight', 700).attr('fill', d.tagColor);
        label.append('tspan').attr('x', x).attr('y', labelY).text(`${d.tag} ${parts[0]}`);
        for (let pi = 1; pi < parts.length; pi++) {
          label.append('tspan').attr('x', x).attr('dy', 11).text(parts[pi]);
        }
      });
    });
    dirs.forEach((d, di) => {
      const y = 14 + 22 + di * FOOTER_ROW_H;
      const pointRight = d.tag === 'H';
      const ah = 4;
      for (let i = 0; i < d.rows.length - 1; i++) {
        const a = d.rows[i], b = d.rows[i + 1];
        const xA = X(a.station), xB = X(b.station);
        const dist = Math.round(b.station - a.station);
        const xLeft = Math.min(xA, xB), xRight = Math.max(xA, xB);
        const midX = (xLeft + xRight) / 2;
        gFooter.append('line').attr('x1', xLeft).attr('x2', xRight).attr('y1', y).attr('y2', y).attr('stroke', d.tagColor);
        gFooter.append('polyline')
          .attr('points', pointRight
            ? `${xRight - ah},${y - 3} ${xRight},${y} ${xRight - ah},${y + 3}`
            : `${xLeft + ah},${y - 3} ${xLeft},${y} ${xLeft + ah},${y + 3}`)
          .attr('fill', 'none').attr('stroke', d.tagColor);
        gFooter.append('rect').attr('x', midX - 16).attr('y', y - 7).attr('width', 32).attr('height', 11).attr('fill', 'var(--bg-panel)');
        gFooter.append('text').attr('x', midX).attr('y', y + 2).attr('text-anchor', 'middle').attr('font-size', 8.5).attr('fill', d.tagColor).text(`${dist} m`);
      }
    });
    gFooter.append('text').attr('x', mL + plotW / 2).attr('y', footerH - 20).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', 'var(--text-muted)').text('Weg s [m]');
    const splLiveText = gFooter.append('text').attr('x', mL).attr('y', footerH - 4).attr('font-size', 9).attr('fill', 'var(--text-muted)');

    const axisTitle = svg.append('text').attr('x', 12).attr('y', mT + VIEWPORT_H / 2)
      .attr('font-size', 10).attr('fill', 'var(--text-muted)').attr('text-anchor', 'middle')
      .attr('transform', `rotate(-90 12 ${mT + VIEWPORT_H / 2})`);

    // Alles Zeit-(Y-)abhängige lebt in dieser geclippten Gruppe und wird bei
    // jedem Zoom/Pan neu positioniert (draw()).
    const plot = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const gGrid = plot.append('g');
    const gCycle = plot.append('g');
    const gULabels = plot.append('g');
    const gQual = plot.append('g');
    const gOpt = plot.append('g');
    const gNodes = plot.append('g');

    const hoverLine = svg.append('line').attr('x1', mL).attr('x2', mL + plotW)
      .attr('stroke', 'var(--text)').attr('stroke-width', 1).attr('stroke-dasharray', '4 3').attr('opacity', 0).attr('pointer-events', 'none');

    let currentYScale = yScale0;

    function draw(yScale, k) {
      currentYScale = yScale;
      const pxPerSec = basePxPerSec * k;
      const yTop = mT, yBot = mT + VIEWPORT_H;

      const gridStepS = TU ? pickTxGridStep(TU, pxPerSec, showTimestamp ? 54 : 30) : 60;
      const gridStepMs = gridStepS * 1000;
      const cycleMs = TU ? TU * 1000 : 0;
      const tVisMin = Math.max(globalTMin, yScale.invert(yBot) - gridStepMs);
      const tVisMax = Math.min(globalTMax, yScale.invert(yTop) + gridStepMs);

      // Gitterlinien (gestrichelt, TX-Raster) - ab globalTMin verankert.
      const gridTicks = [];
      if (gridStepMs > 0) {
        const nStart = Math.floor((tVisMin - globalTMin) / gridStepMs);
        const nEnd = Math.ceil((tVisMax - globalTMin) / gridStepMs);
        for (let n = Math.max(0, nStart); n <= nEnd; n++) {
          const t = globalTMin + n * gridStepMs;
          if (t > globalTMax) break;
          if (cycleMs && Math.abs((t - globalTMin) % cycleMs) < 1) continue; // eigene (hervorgehobene) Umlaufgrenze, s.u.
          gridTicks.push(t);
        }
      }
      gGrid.selectAll('line.tick').data(gridTicks, t => t).join(
        enter => enter.append('line').attr('class', 'tick')
      ).attr('x1', mL).attr('x2', mL + plotW).attr('y1', t => yScale(t)).attr('y2', t => yScale(t))
        .attr('stroke', 'var(--border)').attr('stroke-dasharray', '2 4');
      gGrid.selectAll('text.tick').data(gridTicks, t => t).join(
        enter => enter.append('text').attr('class', 'tick').attr('text-anchor', 'end').attr('fill', 'var(--text-faint)')
      ).attr('x', mL - 6)
        .attr('y', t => showTimestamp ? yScale(t) - 1 : yScale(t) + 3)
        .attr('font-size', 9).attr('font-weight', showTimestamp ? 700 : 400)
        .text(t => `TX ${TU ? Math.round((((t - globalTMin) / 1000) % TU + TU) % TU) : ''}`);
      gGrid.selectAll('text.tickTime').data(showTimestamp ? gridTicks : [], t => t).join(
        enter => enter.append('text').attr('class', 'tickTime').attr('text-anchor', 'end').attr('fill', 'var(--text-faint)')
      ).attr('x', mL - 6).attr('y', t => yScale(t) + 8).attr('font-size', 7.5).text(t => fmtTimeShort(t));

      // Umlaufgrenzen (durchgezogen, kräftiger) + U{k}-Beschriftung rechts.
      const cycleTicks = [];
      const uLabels = [];
      if (cycleMs) {
        const nStart = Math.max(1, Math.floor((tVisMin - globalTMin) / cycleMs));
        const nEnd = Math.ceil((tVisMax - globalTMin) / cycleMs);
        for (let n = nStart; n <= nEnd; n++) {
          const t = globalTMin + n * cycleMs;
          if (t > globalTMax) break;
          cycleTicks.push(t);
        }
        const kStart = Math.max(0, Math.floor((tVisMin - globalTMin) / cycleMs));
        const kEnd = Math.ceil((tVisMax - globalTMin) / cycleMs);
        for (let kk = kStart; kk <= kEnd; kk++) {
          const tMid = globalTMin + (kk + 0.5) * cycleMs;
          if (tMid > globalTMax) break;
          uLabels.push({ k: kk, t: tMid });
        }
      }
      gCycle.selectAll('line').data(cycleTicks, t => t).join('line')
        .attr('x1', mL).attr('x2', mL + plotW).attr('y1', t => yScale(t)).attr('y2', t => yScale(t))
        .attr('stroke', 'var(--border-strong)').attr('stroke-width', 1.4);
      gCycle.selectAll('text').data(showTimestamp ? cycleTicks : [], t => t).join(
        enter => enter.append('text').attr('text-anchor', 'end').attr('fill', 'var(--text-muted)').attr('font-weight', 700)
      ).attr('x', mL - 6).attr('y', t => yScale(t) - 1).attr('font-size', 9).text(`TX ${TU}`);
      gULabels.selectAll('text').data(uLabels, d => d.k).join('text')
        .attr('x', mL + plotW + 4).attr('y', d => yScale(d.t) + 3)
        .attr('font-size', 9).attr('font-weight', 700).attr('fill', 'var(--accent)')
        .text(d => `U${d.k}`);

      axisTitle.text(showTimestamp
        ? `Umlaufsekunde TX ↑ (Start ${fmtDateTimeShort(globalTMin)})`
        : `Umlaufsekunde TX ↑ (t_U ${TU ?? '–'} s)`);

      // Grünband Querschnitt (qualitativ).
      const qualData = [];
      if (showQualitative) {
        dirs.forEach(d => {
          if (!d.qualitativeBand) return;
          d.qualitativeBand.segments.forEach(seg => {
            seg.occurrences.forEach(occ => {
              if (occ.frontEnd < tVisMin || occ.backStart > tVisMax) return;
              qualData.push({ d, seg, occ });
            });
          });
        });
      }
      gQual.selectAll('polygon').data(qualData, dd => `${dd.d.tag}-${dd.occ.frontStart}`).join('polygon')
        .attr('points', dd => {
          const xA = X(dd.seg.a.station), xB = X(dd.seg.b.station);
          const yFrontA = yScale(dd.occ.frontStart), yFrontB = yScale(dd.occ.backStart);
          const yBackA = yScale(dd.occ.frontEnd), yBackB = yScale(dd.occ.backEnd);
          return `${xA},${yFrontA} ${xB},${yFrontB} ${xB},${yBackB} ${xA},${yBackA}`;
        })
        .attr('fill', dd => bandFill[dd.d.tag].qual).attr('stroke', dd => bandColor[dd.d.tag].qual).attr('stroke-width', 1.2)
        .each(function (dd) {
          let title = this.querySelector('title');
          if (!title) { title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); this.appendChild(title); }
          title.textContent = `${dd.seg.a.name}: An ${dd.occ.an}-Ab ${dd.occ.ab} bei ${dd.seg.vp_kmh.toFixed(0)} km/h (Querschnitt, ohne Verengung)`;
        });

      // Grünband Optimum.
      const optData = [];
      if (showOptimum) {
        dirs.forEach(d => {
          if (!d.optimumBand) return;
          d.optimumBand.segments.forEach(seg => {
            seg.runs.forEach(run => {
              if (run.frontEnd < tVisMin || run.backStart > tVisMax) return;
              optData.push({ d, seg, run });
            });
          });
        });
      }
      gOpt.selectAll('polygon').data(optData, dd => `${dd.d.tag}-${dd.seg.a.name}-${dd.run.frontStart}`).join('polygon')
        .attr('points', dd => {
          const xA = X(dd.seg.a.station), xB = X(dd.seg.b.station);
          const yA0 = yScale(dd.run.frontStart), yA1 = yScale(dd.run.frontEnd);
          const yB0 = yScale(dd.run.backStart), yB1 = yScale(dd.run.backEnd);
          return `${xA},${yA0} ${xA},${yA1} ${xB},${yB1} ${xB},${yB0}`;
        })
        .attr('fill', dd => bandFill[dd.d.tag].opt).attr('stroke', dd => bandColor[dd.d.tag].opt).attr('stroke-width', 1.2)
        .each(function (dd) {
          let title = this.querySelector('title');
          if (!title) { title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); this.appendChild(title); }
          const widthS = (dd.run.frontEnd - dd.run.frontStart) / 1000;
          title.textContent = `${dd.seg.a.name} -> ${dd.seg.b.name}: ${widthS.toFixed(1)}s bei ${dd.seg.vp_kmh.toFixed(0)} km/h (Optimum)`;
        });

      // Knotenlinien (Sperrzeit rot, reale Grünsegmente, An/Ab-Beschriftung, Detektoren).
      const nodeData = [];
      dirs.forEach(d => d.rows.forEach(r => nodeData.push({ d, r })));
      const gNode = gNodes.selectAll('g.node').data(nodeData, dd => `${dd.d.tag}-${dd.r.nodeId}`).join(
        enter => enter.append('g').attr('class', 'node')
      );
      gNode.each(function (dd) {
        const g = d3.select(this);
        g.selectAll('*').remove();
        const { d, r } = dd;
        const x = X(r.station);
        const yTopN = yScale(Math.min(r.tMax, globalTMax)), yBotN = yScale(Math.max(r.tMin, globalTMin));
        g.append('line').attr('x1', x).attr('x2', x).attr('y1', yTopN).attr('y2', yBotN)
          .attr('stroke', 'var(--sig-red)').attr('stroke-width', 2.5)
          .append('title').text(`${r.name} (${d.tag}): Aufzeichnung ${fmtDateTimeShort(r.tMin)} – ${fmtDateTimeShort(r.tMax)}`);

        (r.greenSegs || []).forEach(seg => {
          const ys = yScale(seg.end), ye = yScale(seg.start);
          if (ye < mT || ys > mT + VIEWPORT_H) return;
          const h = Math.max(1, ye - ys);
          g.append('rect').attr('x', x - 3).attr('y', ys).attr('width', 6).attr('height', h).attr('fill', 'var(--sig-green)')
            .append('title').text(`${r.name} (${d.tag}): ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}`);
          const cs = App.parser.findEnclosingCycleStart(seg.start, r.cycleStarts);
          if (cs != null && TU) {
            const an = ((Math.round((seg.start - cs) / 1000) % TU) + TU) % TU;
            const tf = Math.round((seg.end - seg.start) / 1000);
            const ab = an + tf;
            g.append('text').attr('x', x + 6).attr('y', ye + 7).attr('font-size', 7.5).attr('fill', 'var(--text-faint)').text(an);
            g.append('text').attr('x', x + 6).attr('y', ys - 2).attr('font-size', 7.5).attr('fill', 'var(--text-faint)').text(ab);
          }
        });
        (r.detSegs || []).forEach((det, di) => {
          const xd = x + 18 + di * 7;
          det.segs.forEach(seg => {
            const ys = yScale(seg.end), ye = yScale(seg.start);
            if (ye < mT || ys > mT + VIEWPORT_H) return;
            const h = Math.max(1, ye - ys);
            g.append('rect').attr('x', xd - 2).attr('y', ys).attr('width', 4).attr('height', h).attr('fill', DET_COLOR)
              .append('title').text(`${det.name} (${d.tag} ${r.name}): belegt ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}`);
          });
        });
      });

      // Aktueller Signalzeitenplan je Knoten, bezogen auf die Zeit am OBEREN
      // Rand des sichtbaren Viewports (Entsprechung zur scrollTop-Auswertung
      // im klassischen Diagramm - hier einfach yScale.invert(mT)).
      const tAtViewTop = yScale.invert(mT);
      const splParts = [];
      dirs.forEach(d => {
        d.rows.forEach(r => {
          if (tAtViewTop < r.tMin || tAtViewTop > r.tMax) return;
          const period = (r.splPeriods || []).find(p => tAtViewTop >= p.start && tAtViewTop < p.end);
          if (period) splParts.push(`${d.tag} ${r.name}: SPL ${period.spl}`);
        });
      });
      splLiveText.text(`${fmtElapsed(tAtViewTop - globalTMin)}` + (splParts.length ? ` · ${splParts.join(' · ')}` : ''));
    }

    // Zoom/Pan: nur die Y-Komponente des Transforms wird verwendet
    // (rescaleY) - die X-Komponente wird nie gelesen, wodurch horizontales
    // Ziehen wirkungslos bleibt und die Weg-Achse automatisch fix bleibt,
    // ganz ohne eigene Constraint-Logik dafür.
    let rafPending = null, latestTransform = d3.zoomIdentity;
    function scheduleDraw(transform) {
      latestTransform = transform;
      if (rafPending) return;
      rafPending = requestAnimationFrame(() => {
        rafPending = null;
        draw(latestTransform.rescaleY(yScale0), latestTransform.k);
      });
    }
    // Pan-Grenzen bewusst NICHT über d3.zoom's eigene .extent()/.translateExtent()
    // gesetzt - deren Default-constrain() hat sich hier (mit einer echten
    // x-Box) beobachtbar falsch verhalten (Transform blieb bei jeder Geste
    // auf dem Startwert eingefroren). Stattdessen manuell klemmen: ty
    // (Y-Versatz) so begrenzen, dass weder vor den Beginn noch nach dem Ende
    // der Aufzeichnung "ins Leere" gezogen werden kann, und d3s internen
    // Zustand bei einer Klemmung per .transform() nachführen (sonst würde
    // die nächste Geste den alten, unklemmten Wert wiederverwenden).
    function clampY(t) {
      const tyMin = mT + VIEWPORT_H - t.k * fullContentH, tyMax = mT;
      const ty = Math.max(Math.min(tyMin, tyMax), Math.min(Math.max(tyMin, tyMax), t.y));
      return ty === t.y ? t : d3.zoomIdentity.translate(0, ty).scale(t.k);
    }
    const zoomBehavior = d3.zoom()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      // Reines Mausrad soll die Seite normal scrollen können (wie überall
      // sonst) statt vom Diagramm für Zoom "gekapert" zu werden - nur mit
      // gedrückter Strg/Cmd-Taste zoomt das Mausrad, exakt wie beim
      // klassischen Diagramm (dort: Strg+Mausrad). Ziehen (Drag) bleibt
      // unabhängig davon immer aktiv (linke Maustaste, !event.button).
      .filter((event) => event.type === 'wheel' ? (event.ctrlKey || event.metaKey) : !event.button)
      .on('zoom', (event) => {
        const clamped = clampY(event.transform);
        if (clamped !== event.transform) { svg.call(zoomBehavior.transform, clamped); return; }
        scheduleDraw(clamped);
      });
    svg.call(zoomBehavior);

    // Startansicht: Beginn der Aufzeichnung (globalTMin) am unteren Rand des
    // Viewports - deckungsgleich mit "scrollTop = scrollHeight" im
    // klassischen Diagramm. Transform-Update UND ersten draw() synchron
    // ausführen (nicht nur über den 'zoom'-Event/rAF warten), damit das
    // Diagramm nicht für einen Frame leer aufblitzt.
    const initialTy = (mT + VIEWPORT_H) - fullContentH;
    latestTransform = d3.zoomIdentity.translate(0, initialTy);
    svg.call(zoomBehavior.transform, latestTransform);
    draw(latestTransform.rescaleY(yScale0), latestTransform.k);

    function resetZoom() {
      svg.transition().duration(200).call(zoomBehavior.transform, d3.zoomIdentity.translate(0, initialTy));
    }

    function scrollToTime(tMs) {
      const k = latestTransform.k;
      const ty = (mT + VIEWPORT_H / 2) - yScale0(tMs) * k;
      svg.transition().duration(250).call(zoomBehavior.transform, d3.zoomIdentity.translate(0, ty).scale(k));
    }

    // Fadenkreuz + Tooltip beim Bewegen der Maus (t/s an Cursorposition).
    let tooltipEl = container.querySelector('.diagram-tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'diagram-tooltip';
      container.appendChild(tooltipEl);
    }
    // Namespaced (".tooltip") - a plain 'mousemove'/'mouseleave' would strip
    // d3-zoom's own internal listeners on this same <svg> (its drag-based
    // panning relies on them), silently breaking drag-to-pan.
    svg.on('mousemove.tooltip', (event) => {
      const [localX, localY] = d3.pointer(event, svg.node());
      if (localX < mL || localX > mL + plotW || localY < mT || localY > mT + VIEWPORT_H) {
        tooltipEl.style.display = 'none';
        hoverLine.attr('opacity', 0);
        return;
      }
      const tMs = currentYScale.invert(localY);
      const sVal = Math.round(xScale.invert(localX));
      tooltipEl.textContent = `t = ${fmtElapsed(tMs - globalTMin)} · s = ${sVal} m`;
      tooltipEl.style.left = (localX + 14) + 'px';
      tooltipEl.style.top = (localY - 26) + 'px';
      tooltipEl.style.display = 'block';
      hoverLine.attr('y1', localY).attr('y2', localY).attr('opacity', 0.8);
    });
    svg.on('mouseleave.tooltip', () => { tooltipEl.style.display = 'none'; hoverLine.attr('opacity', 0); });

    return { scrollToTime, resetZoom };
  }

  App.diagramD3 = { renderDiagram };
})(window.App = window.App || {});
