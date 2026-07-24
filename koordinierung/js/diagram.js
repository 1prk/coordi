/* Koordinierung – Zeit-Weg-Diagramm (SVG): durchgehende Zeitachse über die
   gesamte Aufzeichnung (nicht nach Umlaufzeit gestapelt) - zeigt reale
   Grünsegmente aus den Rohdaten, damit sich die Koordinierung tatsächlich
   über die Zeit durchblättern (scrollen) lässt. Hin- und Gegenrichtung
   kombiniert auf gemeinsamer Zeit-/Weg-Achse. */
(function (App) {
  'use strict';
  const { esc, fmtTimeShort, fmtDateTimeShort } = App.utils;

  const NICE_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  function pickGridStepS(pxPerSec, minPx) {
    for (const s of NICE_STEPS_S) if (s * pxPerSec >= minPx) return s;
    return NICE_STEPS_S[NICE_STEPS_S.length - 1];
  }

  // dir: {rows, refCycleStarts, lTP, proposedBand, bandFill, bandStroke,
  //       tag: 'H'|'R', tagColor, gridColor, tRangeMin, tRangeMax} oder null
  function renderDiagram(container, o) {
    const { TU, drawBand, globalTMin, globalTMax, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0 || !(globalTMax > globalTMin)) { container.innerHTML = ''; return; }

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const corridor = sMax - sMin;

    const mL = 56, mR = 18, mT = 16;
    const footerBaseH = 36 + Math.max(0, dirs.length - 1) * 26;
    const mB = footerBaseH + 16; // + Zeile für aktuellen Signalzeitenplan je Knoten
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);

    const totalSec = (globalTMax - globalTMin) / 1000;
    const TARGET_HEIGHT = 18000;
    const pxPerSec = Math.min(4, Math.max(0.03, TARGET_HEIGHT / Math.max(totalSec, 1)));
    const plotH = totalSec * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH;
    const sx = corridor > 0 ? plotW / corridor : 0;
    const X = s => mL + (s - sMin) * sx;
    const Y = tMs => mT + (tMs - globalTMin) / 1000 * pxPerSec;
    const clipId = 'coordClip' + Math.random().toString(36).slice(2, 8);
    const clip = `url(#${clipId})`;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas, ui-monospace, monospace">`;
    svg += `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`;
    svg += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    // Gitterlinien mit echten Uhrzeiten - Schrittweite so gewählt, dass der
    // Abstand zwischen zwei Linien lesbar bleibt, unabhängig von der
    // Gesamtdauer der Aufzeichnung.
    const gridStepS = pickGridStepS(pxPerSec, 42);
    const gridStepMs = gridStepS * 1000;
    const firstGrid = Math.ceil(globalTMin / gridStepMs) * gridStepMs;
    let lastDateLabel = '';
    for (let t = firstGrid; t <= globalTMax; t += gridStepMs) {
      const y = Y(t);
      svg += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/>`;
      const dateLabel = fmtDateTimeShort(t).split(' ')[0];
      const showDate = dateLabel !== lastDateLabel;
      lastDateLabel = dateLabel;
      svg += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-faint)">${showDate ? esc(fmtDateTimeShort(t)) : fmtTimeShort(t)}</text>`;
    }
    svg += `<text x="12" y="${mT + plotH / 2}" font-size="10" fill="var(--text-muted)" transform="rotate(-90 12 ${mT + plotH / 2})" text-anchor="middle">Zeit (durchgehend) ↓</text>`;

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
    // dieselbe (umlaufperiodische) Maske wie zuvor, aber wiederholt an den
    // ECHTEN Umlaufgrenzen des Bezugsknotens über die gesamte Aufzeichnung -
    // Breite startet bei dessen Grünzeit und wird an jedem weiteren Knoten
    // auf dessen (typische) Grünzeit beschnitten (nie wieder verbreitert).
    dirs.forEach(d => {
      if (!drawBand || !d.proposedBand || !d.refCycleStarts || !d.refCycleStarts.length) return;
      let propSvg = '';
      d.refCycleStarts.forEach(cs => {
        d.proposedBand.segments.forEach(seg => {
          const xA = X(seg.a.station), xB = X(seg.b.station);
          seg.runs.forEach(run => {
            const yA0 = Y(cs + (run.t0a + seg.tauA) * 1000), yA1 = Y(cs + (run.t0b + seg.tauA) * 1000);
            const yB0 = Y(cs + (run.t0a + seg.tauB) * 1000), yB1 = Y(cs + (run.t0b + seg.tauB) * 1000);
            if (Math.max(yA0, yA1, yB0, yB1) < mT || Math.min(yA0, yA1, yB0, yB1) > mT + plotH) return;
            const pts = [[xA, yA0], [xA, yA1], [xB, yB1], [xB, yB0]]
              .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
            propSvg += `<polygon points="${pts}" fill="${d.bandFill}" stroke="${d.bandStroke}" stroke-width="1"><title>${esc(seg.a.name)} -> ${esc(seg.b.name)}: ${run.width.toFixed(1)}s bei ${seg.vp_kmh.toFixed(0)} km/h</title></polygon>`;
          });
        });
      });
      svg += `<g clip-path="${clip}">${propSvg}</g>`;
    });

    // Knotenlinien: Sperrzeit-Grundlinie nur über den TATSÄCHLICHEN
    // Aufzeichnungszeitraum dieses Knotens (kürzere/versetzte Abdeckung wird
    // so als Lücke sichtbar), reale Grünsegmente direkt aus den Rohdaten.
    dirs.forEach(d => {
      d.rows.forEach(r => {
        const x = X(r.station);
        const yTop = Y(Math.max(r.tMin, globalTMin)), yBot = Y(Math.min(r.tMax, globalTMax));
        svg += `<line x1="${x.toFixed(1)}" y1="${yTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="var(--sig-red)" stroke-width="2.5"><title>${esc(r.name)} (${d.tag}): Aufzeichnung ${fmtDateTimeShort(r.tMin)} – ${fmtDateTimeShort(r.tMax)}</title></line>`;
        let overlay = '';
        (r.greenSegs || []).forEach(seg => {
          const ys = Y(seg.start), ye = Y(seg.end);
          if (ye < mT || ys > mT + plotH) return;
          overlay += `<rect x="${(x - 3).toFixed(1)}" y="${ys.toFixed(1)}" width="6" height="${Math.max(1, ye - ys).toFixed(1)}" fill="var(--sig-green)"><title>${esc(r.name)} (${d.tag}): ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}</title></rect>`;
        });
        svg += `<g clip-path="${clip}">${overlay}</g>`;
      });
    });

    svg += `</svg>`;

    // Sticky Kopfzeile mit Signalgruppennamen je Knoten/Richtung.
    const headerH = 20 + Math.max(0, dirs.length - 1) * 15;
    let header = `<div class="diagram-sticky-header" style="width:${W}px;height:${headerH}px;">`;
    dirs.forEach((d, di) => {
      d.rows.forEach(r => {
        const x = X(r.station);
        header += `<span class="diagram-sg-label" style="left:${x.toFixed(1)}px;top:${2 + di * 15}px;color:${d.tagColor}">${d.tag} ${esc(r.sgName)}</span>`;
      });
    });
    header += `</div>`;

    // Sticky Fußzeile (x-Achse): Knotennamen + Maßketten (Abschnittsabstand,
    // Hin -> rechts, Rück -> links) sowie eine Zeile mit dem je Knoten AKTUELL
    // (an der Bildlaufposition) geltenden Signalzeitenplan - aktualisiert
    // sich beim Scrollen durch die Historie.
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
    footer += `<text x="${mL + plotW / 2}" y="${footerBaseH - 4}" text-anchor="middle" font-size="10" fill="var(--text-muted)">Weg s [m]</text>`;
    footer += `<text id="diagramSplLive" x="${mL}" y="${mB - 4}" font-size="9" font-family="Consolas, ui-monospace, monospace" fill="var(--text-muted)"></text>`;
    footer += `</svg>`;

    container.innerHTML = header + svg
      + `<div class="diagram-sticky-footer" style="width:${W}px;">${footer}</div>`
      + `<div class="diagram-tooltip"></div>`;

    // Aktuellen Signalzeitenplan je Knoten anzeigen - bezogen auf die Zeit
    // am oberen Rand des sichtbaren Ausschnitts, aktualisiert beim Scrollen.
    const splLiveEl = container.querySelector('#diagramSplLive');
    function updateSplLive() {
      if (!splLiveEl) return;
      const tAtTop = globalTMin + (container.scrollTop / pxPerSec) * 1000;
      const parts = [];
      dirs.forEach(d => {
        d.rows.forEach(r => {
          if (tAtTop < r.tMin || tAtTop > r.tMax) return;
          const period = (r.splPeriods || []).find(p => tAtTop >= p.start && tAtTop < p.end);
          if (period) parts.push(`${d.tag} ${r.name}: SPL ${period.spl}`);
        });
      });
      splLiveEl.textContent = parts.length
        ? `${fmtDateTimeShort(tAtTop)} · ${parts.join(' · ')}`
        : fmtDateTimeShort(tAtTop);
    }
    let scrollScheduled = false;
    container.addEventListener('scroll', () => {
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(() => { updateSplLive(); scrollScheduled = false; });
    });
    updateSplLive();

    // Snappy Tooltip: zeigt beim Bewegen der Maus die Uhrzeit und den vollen
    // Meter an der Cursorposition an.
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
        const tMs = globalTMin + (localY - mT) / pxPerSec * 1000;
        const sVal = Math.round(sMin + (localX - mL) / (sx || 1e-6));
        tooltipEl.textContent = `t = ${fmtDateTimeShort(tMs)} · s = ${sVal} m`;
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
