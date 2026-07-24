/* Koordinierung – Zeit-Weg-Diagramm (SVG), Hin- und Gegenrichtung kombiniert
   auf gemeinsamer Zeit-/Weg-Achse (die Stationen je Richtung können leicht
   voneinander abweichen, z. B. bei versetzten Haltlinien). */
(function (App) {
  'use strict';
  const { esc } = App.utils;

  // dir: {rows, lTP, proposedBand, bandFill, bandStroke, tag: 'H'|'R',
  //       tagColor, gridColor} oder null
  function renderDiagram(container, o) {
    const { TU, Ncyc, drawBand, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0) { container.innerHTML = ''; return; }

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const corridor = sMax - sMin;

    const mL = 56, mR = 18, mT = 16, mB = 54 + Math.max(0, dirs.length - 1) * 26;
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);
    const pxPerSec = Math.max(1.6, 150 / TU);
    const Ttot = Ncyc * TU;
    const plotH = Ttot * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH;
    const sx = corridor > 0 ? plotW / corridor : 0;
    const X = s => mL + (s - sMin) * sx;
    const Y = t => mT + plotH - t * pxPerSec;
    const clipId = 'coordClip' + Math.random().toString(36).slice(2, 8);
    const clip = `url(#${clipId})`;
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas, ui-monospace, monospace">`;
    svg += `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`;
    svg += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    for (let k = 0; k <= Ncyc; k++) {
      const yB = Y(k * TU);
      svg += `<line x1="${mL}" y1="${yB.toFixed(1)}" x2="${mL + plotW}" y2="${yB.toFixed(1)}" stroke="var(--border-strong)"/>`;
      svg += `<text x="${mL - 6}" y="${(yB + 3).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">0</text>`;
    }
    // Gestrichelte Hilfslinien alle 10s innerhalb jedes Umlaufs.
    for (let k = 0; k < Ncyc; k++) {
      const yBottom = Y(k * TU);
      for (let t = 10; t < TU; t += 10) {
        const y = Y(k * TU + t);
        svg += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/>`;
        svg += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--text-faint)">${t}</text>`;
      }
      svg += `<text x="${(mL + 4).toFixed(1)}" y="${(yBottom - 4).toFixed(1)}" font-size="8" fill="var(--text-faint)">Umlauf ${k + 1}</text>`;
    }
    svg += `<text x="12" y="${mT + plotH / 2}" font-size="10" fill="var(--text-muted)" transform="rotate(-90 12 ${mT + plotH / 2})" text-anchor="middle">Zeit t [s] je Umlauf (0…${TU})</text>`;

    dirs.forEach(d => {
      if (!(d.lTP > 0 && corridor > 0)) return;
      const dsMin = d.rows[0].station;
      for (let m = 0; dsMin + m * d.lTP <= sMax + 0.5; m++) {
        const s = dsMin + m * d.lTP;
        if (s < sMin - 0.5) continue;
        const x = X(s);
        svg += `<line x1="${x.toFixed(1)}" y1="${mT}" x2="${x.toFixed(1)}" y2="${mT + plotH}" stroke="${d.gridColor}" stroke-width="1" stroke-dasharray="2 4" opacity="0.5"/>`;
      }
    });

    // Grünband bei der je Abschnitt vorgegebenen Progressionsgeschwindigkeit:
    // Breite startet bei der Grünzeit des Bezugsknotens und wird an jedem
    // weiteren Knoten auf dessen Grünzeit beschnitten (nie wieder
    // verbreitert) - zeigt als Overlay, ob/wo die gewählte Geschwindigkeit
    // eine durchgehende Welle ergibt.
    dirs.forEach(d => {
      if (!drawBand || !d.proposedBand) return;
      let propSvg = '';
      for (let k = -1; k <= Ncyc; k++) {
        d.proposedBand.segments.forEach(seg => {
          const xA = X(seg.a.station), xB = X(seg.b.station);
          seg.runs.forEach(run => {
            const yA0 = Y(run.t0a + seg.tauA + k * TU), yA1 = Y(run.t0b + seg.tauA + k * TU);
            const yB0 = Y(run.t0a + seg.tauB + k * TU), yB1 = Y(run.t0b + seg.tauB + k * TU);
            const pts = [[xA, yA0], [xA, yA1], [xB, yB1], [xB, yB0]]
              .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
            propSvg += `<polygon points="${pts}" fill="${d.bandFill}" stroke="${d.bandStroke}" stroke-width="1"><title>${esc(seg.a.name)} -> ${esc(seg.b.name)}: ${run.width.toFixed(1)}s bei ${seg.vp_kmh.toFixed(0)} km/h</title></polygon>`;
          });
        });
      }
      svg += `<g clip-path="${clip}">${propSvg}</g>`;
    });

    dirs.forEach(d => {
      d.rows.forEach(r => {
        const x = X(r.station);
        svg += `<line x1="${x.toFixed(1)}" y1="${mT}" x2="${x.toFixed(1)}" y2="${mT + plotH}" stroke="var(--sig-red)" stroke-width="2.5"/>`;
        let overlay = '';
        for (let k = -1; k <= Ncyc; k++) {
          const gs = r.an + k * TU, ge = gs + r.tf;
          const cs = Math.max(gs, 0), ce = Math.min(ge, Ttot);
          if (ce <= cs) continue;
          const yTop = Y(ce), yBot = Y(cs);
          overlay += `<rect x="${(x - 3).toFixed(1)}" y="${yTop.toFixed(1)}" width="6" height="${(yBot - yTop).toFixed(1)}" fill="var(--sig-green)"><title>${esc(r.name)} (${d.tag}): An ${r.an}s, Ab ${r.ab}s, TF ${r.tf}s</title></rect>`;
          if (k >= 0 && k < Ncyc) {
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(yBot + 3).toFixed(1)}" font-size="7.5" fill="var(--text-muted)">${r.an}</text>`;
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(yTop - 2).toFixed(1)}" font-size="7.5" fill="var(--text-muted)">${r.ab}</text>`;
          }
        }
        svg += `<g clip-path="${clip}">${overlay}</g>`;
      });
    });

    svg += `</svg>`;

    // Sticky Kopfzeile mit Signalgruppennamen je Knoten/Richtung - bleibt
    // beim vertikalen Scrollen im Diagramm sichtbar, scrollt aber mit dem
    // Diagramm horizontal mit (bleibt so über der jeweiligen Knotenlinie).
    const headerH = 20 + Math.max(0, dirs.length - 1) * 15;
    let header = `<div class="diagram-sticky-header" style="width:${W}px;height:${headerH}px;">`;
    dirs.forEach((d, di) => {
      d.rows.forEach(r => {
        const x = X(r.station);
        header += `<span class="diagram-sg-label" style="left:${x.toFixed(1)}px;top:${2 + di * 15}px;color:${d.tagColor}">${d.tag} ${esc(r.sgName)}</span>`;
      });
    });
    header += `</div>`;

    // Sticky Fußzeile (x-Achse): Knotennamen + Maßketten statt absoluter
    // Stationsangaben - je Richtung ein Pfeil pro Abschnitt (Hin -> rechts,
    // Rück -> links, entsprechend der Fahrtrichtung), beschriftet mit dem
    // tatsächlichen Abschnittsabstand. Der erste Hin-Knoten bleibt der
    // einzige Bezug zu einer absoluten Station (Basis-Station im
    // Werkzeugleisten-Feld). Bleibt wie die Kopfzeile beim vertikalen
    // Scrollen sichtbar (position:sticky; bottom:0).
    let footer = `<svg class="diagram-footer-svg" width="${W}" height="${mB}" viewBox="0 0 ${W} ${mB}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas, ui-monospace, monospace">`;
    footer += `<rect x="0" y="0" width="${W}" height="${mB}" fill="var(--bg-panel)"/>`;
    dirs.forEach((d, di) => {
      const labelY = 18 + di * 26;
      d.rows.forEach(r => {
        const x = X(r.station);
        footer += `<text x="${x.toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="10" font-weight="700" fill="${d.tagColor}">${d.tag} ${esc(r.name)}</text>`;
      });
    });
    dirs.forEach((d, di) => {
      const y = 32 + di * 26;
      const pointRight = d.tag === 'H';
      const ah = 4;
      for (let i = 0; i < d.rows.length - 1; i++) {
        const a = d.rows[i], b = d.rows[i + 1];
        const xA = X(a.station), xB = X(b.station);
        const dist = Math.round(b.station - a.station);
        const xLeft = Math.min(xA, xB), xRight = Math.max(xA, xB);
        const midX = (xLeft + xRight) / 2;
        footer += `<line x1="${xLeft.toFixed(1)}" y1="${y}" x2="${xRight.toFixed(1)}" y2="${y}" stroke="${d.tagColor}" stroke-width="1"/>`;
        footer += pointRight
          ? `<polyline points="${(xRight - ah).toFixed(1)},${y - 3} ${xRight.toFixed(1)},${y} ${(xRight - ah).toFixed(1)},${y + 3}" fill="none" stroke="${d.tagColor}" stroke-width="1"/>`
          : `<polyline points="${(xLeft + ah).toFixed(1)},${y - 3} ${xLeft.toFixed(1)},${y} ${(xLeft + ah).toFixed(1)},${y + 3}" fill="none" stroke="${d.tagColor}" stroke-width="1"/>`;
        footer += `<rect x="${(midX - 16).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="32" height="11" fill="var(--bg-panel)"/>`;
        footer += `<text x="${midX.toFixed(1)}" y="${(y + 2).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="${d.tagColor}">${dist} m</text>`;
      }
    });
    footer += `<text x="${mL + plotW / 2}" y="${mB - 4}" text-anchor="middle" font-size="10" fill="var(--text-muted)">Weg s [m]</text>`;
    footer += `</svg>`;

    container.innerHTML = header + svg
      + `<div class="diagram-sticky-footer" style="width:${W}px;">${footer}</div>`
      + `<div class="diagram-tooltip"></div>`;
    container.scrollTop = container.scrollHeight;

    // Snappy Tooltip: zeigt beim Bewegen der Maus die volle Sekunde (inkl.
    // Umlauf) und den vollen Meter an der Cursorposition an.
    const svgEl = container.querySelector('svg');
    const tooltipEl = container.querySelector('.diagram-tooltip');
    if (svgEl && tooltipEl) {
      svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const scaleX = W / (rect.width || W), scaleY = H / (rect.height || H);
        const localX = (e.clientX - rect.left) * scaleX;
        const localY = (e.clientY - rect.top) * scaleY;
        if (localX < mL || localX > mL + plotW || localY < mT || localY > mT + plotH) {
          tooltipEl.style.display = 'none';
          return;
        }
        const tAbs = Math.round((mT + plotH - localY) / pxPerSec);
        const cyc = Math.floor(tAbs / TU) + 1;
        const tInCyc = ((tAbs % TU) + TU) % TU;
        const sVal = Math.round(sMin + (localX - mL) / (sx || 1e-6));
        tooltipEl.textContent = `t = ${tInCyc}s · Umlauf ${cyc} · s = ${sVal} m`;
        const hostRect = container.getBoundingClientRect();
        tooltipEl.style.left = (e.clientX - hostRect.left + container.scrollLeft + 14) + 'px';
        tooltipEl.style.top = (e.clientY - hostRect.top + container.scrollTop - 26) + 'px';
        tooltipEl.style.display = 'block';
      });
      svgEl.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
    }
  }

  App.diagram = { renderDiagram };
})(window.App = window.App || {});
