/* Koordinierung – Zeit-Weg-Diagramm, D3.js-Prototyp (siehe diagram.js für die
   "klassische" Variante, die dieses Modul NICHT ersetzt - beide laufen
   parallel, siehe Tabs "Diagramm" und "Diagramm (D3)"). Gleiche Eingabedaten,
   gleiche Geometrie UND dasselbe Interaktionsmodell wie diagram.js (natives
   Scrollen durch die Zeit inkl. Mausrad, sticky Kopf-/Fußzeile, Strg+Mausrad
   zoomt über einen von außen (app.js) übergebenen zoomLevel) - das war
   zunächst über d3-zoom (transform-basiertes Pan/Zoom, feste Viewport-Größe)
   gelöst, hat sich aber gegen die vom klassischen Diagramm geprägte Erwartung
   (Mausrad = durch die Zeit scrollen, Fußzeile immer sichtbar) als
   unpraktisch erwiesen - jetzt exakt dasselbe Modell wie diagram.js, nur mit
   D3 für Skalen (d3.scaleLinear) und DOM-Aufbau (d3.select) statt
   Handschrift-Formeln und reiner String-Konkatenation. */
(function (App) {
  'use strict';
  const { esc, fmtTimeShort, fmtDateTimeShort, fmtElapsed, clamp } = App.utils;

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

  function renderDiagram(container, o) {
    const d3 = window.d3;
    if (!d3) {
      container.innerHTML = '<div class="node-empty">D3.js konnte nicht geladen werden (lib/d3.v7.min.js fehlt oder blockiert).</div>';
      return null;
    }
    const { TU, showQualitative, showOptimum, showTimestamp, zoomLevel, globalTMin, globalTMax, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0 || !(globalTMax > globalTMin)) { container.innerHTML = ''; return null; }

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const corridor = sMax - sMin;
    const sMinPlot = sMin - STATION_VISUAL_BUFFER_M, sMaxPlot = sMax + STATION_VISUAL_BUFFER_M;

    const mL = 56, mR = 56, mT = 16;
    // 40px je Richtung statt der 26px im klassischen Diagramm: Platz für bis
    // zu zwei Namenszeilen (Knotennamen mit "/" brechen um) über der
    // Maßketten-Zeile.
    const FOOTER_ROW_H = 40;
    const footerBaseH = FOOTER_ROW_H + Math.max(0, dirs.length - 1) * FOOTER_ROW_H;
    const mB = footerBaseH + 16;
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);

    const VIEWPORT_PX = 560, CYCLES_VISIBLE = 3;
    const zoom = zoomLevel && zoomLevel > 0 ? zoomLevel : 1;
    const pxPerSec = Math.min(60, Math.max(0.01, (VIEWPORT_PX / (CYCLES_VISIBLE * TU)) * zoom));
    const totalSec = (globalTMax - globalTMin) / 1000;
    const plotH = totalSec * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH;

    const xScale = d3.scaleLinear().domain([sMinPlot, sMaxPlot]).range([mL, mL + plotW]);
    const X = s => xScale(s);
    // Nullpunkt unten (globalTMin), Zeit läuft nach oben - wie im klassischen Diagramm.
    const yScale = d3.scaleLinear().domain([globalTMin, globalTMax]).range([mT + plotH, mT]);
    const Y = t => yScale(t);
    const clipId = 'd3clip' + Math.random().toString(36).slice(2, 8);
    const clip = `url(#${clipId})`;

    function hatchDef(color, angleDeg, idSeed) {
      const id = 'd3hatch' + idSeed + Math.random().toString(36).slice(2, 8);
      const def = `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${angleDeg})">`
        + `<rect width="6" height="6" fill="${color}" fill-opacity="0.20"/>`
        + `<line x1="0" y1="0" x2="0" y2="6" stroke="${color}" stroke-width="2"/>`
        + `</pattern>`;
      return { def, url: `url(#${id})`, color };
    }
    const bandStyle = {
      H: { qual: hatchDef(bandColor.H.qual, 45, 'Hq'), opt: hatchDef(bandColor.H.opt, -45, 'Ho') },
      R: { qual: hatchDef(bandColor.R.qual, -45, 'Rq'), opt: hatchDef(bandColor.R.opt, 45, 'Ro') }
    };

    let svgInner = `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath>`
      + bandStyle.H.qual.def + bandStyle.H.opt.def + bandStyle.R.qual.def + bandStyle.R.opt.def + `</defs>`;
    svgInner += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    const gridStepS = TU ? pickTxGridStep(TU, pxPerSec, showTimestamp ? 54 : 30) : 60;
    const gridStepMs = gridStepS * 1000;
    const cycleMs = TU ? TU * 1000 : 0;
    for (let t = globalTMin; t <= globalTMax; t += gridStepMs) {
      if (cycleMs && Math.abs((t - globalTMin) % cycleMs) < 1) continue;
      const y = Y(t);
      const tx = TU ? Math.round((((t - globalTMin) / 1000) % TU + TU) % TU) : null;
      svgInner += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/>`;
      if (showTimestamp) {
        svgInner += `<text x="${mL - 6}" y="${(y - 1).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-faint)">TX ${tx}</text>`;
        svgInner += `<text x="${mL - 6}" y="${(y + 8).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--text-faint)">${fmtTimeShort(t)}</text>`;
      } else {
        svgInner += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-faint)">TX ${tx}</text>`;
      }
    }

    if (cycleMs) {
      for (let t = globalTMin + cycleMs; t <= globalTMax; t += cycleMs) {
        const y = Y(t);
        svgInner += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1.4"/>`;
        if (showTimestamp) {
          svgInner += `<text x="${mL - 6}" y="${(y - 1).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">TX ${TU}</text>`;
          svgInner += `<text x="${mL - 6}" y="${(y + 8).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--text-muted)">${fmtTimeShort(t)}</text>`;
        } else {
          svgInner += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">TX ${TU}</text>`;
        }
      }
      const totalCycles = Math.ceil((globalTMax - globalTMin) / cycleMs);
      for (let k = 0; k < totalCycles; k++) {
        const tMid = globalTMin + (k + 0.5) * cycleMs;
        if (tMid > globalTMax) break;
        const y = Y(tMid);
        svgInner += `<text x="${(mL + plotW + 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="9" font-weight="700" fill="var(--accent)">U${k}</text>`;
      }
    }
    const axisTitle = showTimestamp
      ? `Umlaufsekunde TX ↑ (Start ${esc(fmtDateTimeShort(globalTMin))})`
      : `Umlaufsekunde TX ↑ (t_U ${TU ?? '–'} s)`;
    svgInner += `<text x="12" y="${mT + plotH / 2}" font-size="10" fill="var(--text-muted)" transform="rotate(-90 12 ${mT + plotH / 2})" text-anchor="middle">${axisTitle}</text>`;

    dirs.forEach(d => {
      if (!(d.lTP > 0 && corridor > 0)) return;
      const dsMin = d.rows[0].station;
      for (let m = 0; dsMin + m * d.lTP <= sMax + 0.5; m++) {
        const s = dsMin + m * d.lTP;
        if (s < sMin - 0.5) continue;
        const x = X(s);
        svgInner += `<line x1="${x.toFixed(1)}" y1="${mT}" x2="${x.toFixed(1)}" y2="${mT + plotH}" stroke="${d.gridColor}" stroke-width="1" stroke-dasharray="2 4" opacity="0.5"/>`;
      }
    });

    dirs.forEach(d => {
      if (!showQualitative || !d.qualitativeBand) return;
      const style = bandStyle[d.tag].qual;
      let qSvg = '';
      d.qualitativeBand.segments.forEach(seg => {
        const xA = X(seg.a.station), xB = X(seg.b.station);
        seg.occurrences.forEach(occ => {
          const yFrontA = Y(occ.frontStart), yFrontB = Y(occ.backStart);
          const yBackA = Y(occ.frontEnd), yBackB = Y(occ.backEnd);
          if (Math.max(yFrontA, yFrontB, yBackA, yBackB) < mT || Math.min(yFrontA, yFrontB, yBackA, yBackB) > mT + plotH) return;
          const pts = [[xA, yFrontA], [xB, yFrontB], [xB, yBackB], [xA, yBackA]]
            .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
          qSvg += `<polygon points="${pts}" fill="${style.url}" stroke="${style.color}" stroke-width="1.2"><title>${esc(seg.a.name)}: An ${occ.an}-Ab ${occ.ab} bei ${seg.vp_kmh.toFixed(0)} km/h (Querschnitt, ohne Verengung)</title></polygon>`;
        });
      });
      svgInner += `<g clip-path="${clip}">${qSvg}</g>`;
    });

    dirs.forEach(d => {
      if (!showOptimum || !d.optimumBand) return;
      const style = bandStyle[d.tag].opt;
      let propSvg = '';
      d.optimumBand.segments.forEach(seg => {
        const xA = X(seg.a.station), xB = X(seg.b.station);
        seg.runs.forEach(run => {
          const yA0 = Y(run.frontStart), yA1 = Y(run.frontEnd);
          const yB0 = Y(run.backStart), yB1 = Y(run.backEnd);
          if (Math.max(yA0, yA1, yB0, yB1) < mT || Math.min(yA0, yA1, yB0, yB1) > mT + plotH) return;
          const pts = [[xA, yA0], [xA, yA1], [xB, yB1], [xB, yB0]]
            .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
          const widthS = (run.frontEnd - run.frontStart) / 1000;
          propSvg += `<polygon points="${pts}" fill="${style.url}" stroke="${style.color}" stroke-width="1.2"><title>${esc(seg.a.name)} -> ${esc(seg.b.name)}: ${widthS.toFixed(1)}s bei ${seg.vp_kmh.toFixed(0)} km/h (Optimum)</title></polygon>`;
        });
      });
      svgInner += `<g clip-path="${clip}">${propSvg}</g>`;
    });

    dirs.forEach(d => {
      d.rows.forEach(r => {
        const x = X(r.station);
        const yTop = Y(Math.min(r.tMax, globalTMax)), yBot = Y(Math.max(r.tMin, globalTMin));
        svgInner += `<line x1="${x.toFixed(1)}" y1="${yTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="var(--sig-red)" stroke-width="2.5"><title>${esc(r.name)} (${d.tag}): Aufzeichnung ${fmtDateTimeShort(r.tMin)} – ${fmtDateTimeShort(r.tMax)}</title></line>`;
        let overlay = '';
        (r.greenSegs || []).forEach(seg => {
          const ys = Y(seg.end), ye = Y(seg.start);
          if (ye < mT || ys > mT + plotH) return;
          const h = Math.max(1, ye - ys);
          overlay += `<rect x="${(x - 3).toFixed(1)}" y="${ys.toFixed(1)}" width="6" height="${h.toFixed(1)}" fill="var(--sig-green)"><title>${esc(r.name)} (${d.tag}): ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}</title></rect>`;
          const cs = App.parser.findEnclosingCycleStart(seg.start, r.cycleStarts);
          if (cs != null && TU) {
            const an = ((Math.round((seg.start - cs) / 1000) % TU) + TU) % TU;
            const tf = Math.round((seg.end - seg.start) / 1000);
            const ab = an + tf;
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(ye + 7).toFixed(1)}" font-size="7.5" fill="var(--text-faint)">${an}</text>`;
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(ys - 2).toFixed(1)}" font-size="7.5" fill="var(--text-faint)">${ab}</text>`;
          }
        });
        (r.detSegs || []).forEach((det, di) => {
          const xd = x + 18 + di * 7;
          det.segs.forEach(seg => {
            const ys = Y(seg.end), ye = Y(seg.start);
            if (ye < mT || ys > mT + plotH) return;
            const h = Math.max(1, ye - ys);
            overlay += `<rect x="${(xd - 2).toFixed(1)}" y="${ys.toFixed(1)}" width="4" height="${h.toFixed(1)}" fill="${DET_COLOR}"><title>${esc(det.name)} (${d.tag} ${esc(r.name)}): belegt ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}</title></rect>`;
          });
        });
        svgInner += `<g clip-path="${clip}">${overlay}</g>`;
      });
    });

    svgInner += `<line id="hoverLine" x1="${mL}" y1="0" x2="${mL + plotW}" y2="0" stroke="var(--text)" stroke-width="1" stroke-dasharray="4 3" opacity="0" pointer-events="none"/>`;

    // DOM-Aufbau über D3-Selections statt einem einzelnen innerHTML-String -
    // dieselbe Struktur wie im klassischen Diagramm (sticky Kopfzeile, das
    // Haupt-SVG, sticky Fußzeile, Tooltip-Div, in dieser Reihenfolge als
    // direkte Kinder des scrollenden Containers).
    container.innerHTML = '';
    const root = d3.select(container);

    const headerH = 20 + Math.max(0, dirs.length - 1) * 15;
    const header = root.append('div').attr('class', 'diagram-sticky-header')
      .style('width', W + 'px').style('height', headerH + 'px');
    dirs.forEach((d, di) => {
      d.rows.forEach(r => {
        header.append('span').attr('class', 'diagram-sg-label')
          .style('left', X(r.station).toFixed(1) + 'px').style('top', (2 + di * 15) + 'px').style('color', d.tagColor)
          .text(`${d.tag} ${r.sgName}`);
      });
    });

    const svg = root.append('svg').attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
      .attr('font-family', 'Consolas, ui-monospace, monospace').html(svgInner);

    // Sticky Fußzeile (x-Achse): Knotennamen (bricht bei "/" um) + Maßketten
    // + aktueller Signalzeitenplan je Knoten (aktualisiert sich beim Scrollen).
    const footerSvg = `<rect x="0" y="0" width="${W}" height="${mB}" fill="var(--bg-panel)"/>`;
    const footerDiv = root.append('div').attr('class', 'diagram-sticky-footer').style('width', W + 'px');
    const footer = footerDiv.append('svg').attr('class', 'diagram-footer-svg').attr('width', W).attr('height', mB)
      .attr('viewBox', `0 0 ${W} ${mB}`).attr('font-family', 'Consolas, ui-monospace, monospace').html(footerSvg);
    dirs.forEach((d, di) => {
      const labelY = 14 + di * FOOTER_ROW_H;
      d.rows.forEach(r => {
        const x = X(r.station);
        const parts = String(r.name).split('/');
        const label = footer.append('text').attr('text-anchor', 'middle')
          .attr('font-size', 10).attr('font-weight', 700).attr('fill', d.tagColor);
        label.append('tspan').attr('x', x).attr('y', labelY).text(`${d.tag} ${parts[0]}`);
        for (let pi = 1; pi < parts.length; pi++) label.append('tspan').attr('x', x).attr('dy', 11).text(parts[pi]);
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
        footer.append('line').attr('x1', xLeft).attr('x2', xRight).attr('y1', y).attr('y2', y).attr('stroke', d.tagColor);
        footer.append('polyline')
          .attr('points', pointRight
            ? `${xRight - ah},${y - 3} ${xRight},${y} ${xRight - ah},${y + 3}`
            : `${xLeft + ah},${y - 3} ${xLeft},${y} ${xLeft + ah},${y + 3}`)
          .attr('fill', 'none').attr('stroke', d.tagColor);
        footer.append('rect').attr('x', midX - 16).attr('y', y - 7).attr('width', 32).attr('height', 11).attr('fill', 'var(--bg-panel)');
        footer.append('text').attr('x', midX).attr('y', y + 2).attr('text-anchor', 'middle').attr('font-size', 8.5).attr('fill', d.tagColor).text(`${dist} m`);
      }
    });
    footer.append('text').attr('x', mL + plotW / 2).attr('y', footerBaseH - 4).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', 'var(--text-muted)').text('Weg s [m]');
    const splLiveEl = footer.append('text').attr('x', mL).attr('y', mB - 4).attr('font-size', 9).attr('fill', 'var(--text-muted)');

    const tooltipEl = root.append('div').attr('class', 'diagram-tooltip').node();

    // Bildlaufposition über ein Neu-Rendern hinweg beibehalten - identisch
    // zum klassischen Diagramm (dasselbe Verfahren, dieselbe Semantik).
    const prevState = container._diagramScrollState;
    if (prevState) {
      const tAtPrevTop = prevState.globalTMin + (prevState.mT + prevState.plotH - prevState.scrollTop) / prevState.pxPerSec * 1000;
      const newScrollTop = mT + plotH - (tAtPrevTop - globalTMin) / 1000 * pxPerSec;
      container.scrollTop = clamp(newScrollTop, 0, container.scrollHeight);
    } else {
      container.scrollTop = container.scrollHeight;
    }

    function updateSplLive() {
      const tAtViewTop = globalTMin + (mT + plotH - container.scrollTop) / pxPerSec * 1000;
      const parts = [];
      dirs.forEach(d => {
        d.rows.forEach(r => {
          if (tAtViewTop < r.tMin || tAtViewTop > r.tMax) return;
          const period = (r.splPeriods || []).find(p => tAtViewTop >= p.start && tAtViewTop < p.end);
          if (period) parts.push(`${d.tag} ${r.name}: SPL ${period.spl}`);
        });
      });
      splLiveEl.text(`${fmtElapsed(tAtViewTop - globalTMin)}` + (parts.length ? ` · ${parts.join(' · ')}` : ''));
    }
    container._diagramScrollState = { globalTMin, mT, plotH, pxPerSec, scrollTop: container.scrollTop };
    let scrollScheduled = false;
    container.addEventListener('scroll', () => {
      container._diagramScrollState.scrollTop = container.scrollTop;
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(() => { updateSplLive(); scrollScheduled = false; });
    });
    updateSplLive();

    function scrollToTime(tMs) {
      const viewportH = container.clientHeight || plotH;
      const target = mT + plotH - (tMs - globalTMin) / 1000 * pxPerSec - viewportH / 2;
      container.scrollTop = clamp(target, 0, container.scrollHeight);
    }

    const svgNode = svg.node();
    const hoverLineEl = svgNode.querySelector('#hoverLine');
    svg.on('mousemove', (event) => {
      const rect = svgNode.getBoundingClientRect();
      const scaleX = W / (rect.width || W), scaleY = H / (rect.height || H);
      const localX = (event.clientX - rect.left) * scaleX;
      const localY = (event.clientY - rect.top) * scaleY;
      if (localX < mL || localX > mL + plotW || localY < mT || localY > mT + plotH) {
        tooltipEl.style.display = 'none';
        if (hoverLineEl) hoverLineEl.setAttribute('opacity', '0');
        return;
      }
      const tMs = globalTMin + (mT + plotH - localY) / pxPerSec * 1000;
      const sVal = Math.round(xScale.invert(localX));
      tooltipEl.textContent = `t = ${fmtElapsed(tMs - globalTMin)} · s = ${sVal} m`;
      const hostRect = container.getBoundingClientRect();
      tooltipEl.style.left = (event.clientX - hostRect.left + container.scrollLeft + 14) + 'px';
      tooltipEl.style.top = (event.clientY - hostRect.top + container.scrollTop - 26) + 'px';
      tooltipEl.style.display = 'block';
      if (hoverLineEl) {
        hoverLineEl.setAttribute('y1', localY.toFixed(1));
        hoverLineEl.setAttribute('y2', localY.toFixed(1));
        hoverLineEl.setAttribute('opacity', '0.8');
      }
    });
    svg.on('mouseleave', () => {
      tooltipEl.style.display = 'none';
      if (hoverLineEl) hoverLineEl.setAttribute('opacity', '0');
    });

    return { scrollToTime };
  }

  App.diagramD3 = { renderDiagram };
})(window.App = window.App || {});
