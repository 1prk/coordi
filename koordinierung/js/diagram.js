/* Koordinierung – Zeit-Weg-Diagramm (SVG): durchgehende Zeitachse über die
   gesamte Aufzeichnung (nicht nach Umlaufzeit gestapelt) - zeigt reale
   Grünsegmente aus den Rohdaten, damit sich die Koordinierung tatsächlich
   über die Zeit durchblättern (scrollen) lässt. Nullpunkt der Zeitachse
   (00:00:00) liegt unten, die Zeit läuft nach oben - je weiter oben, desto
   später. Hin- und Gegenrichtung kombiniert auf gemeinsamer Zeit-/Weg-Achse. */
(function (App) {
  'use strict';
  const { esc, fmtTimeShort, fmtDateTimeShort, fmtElapsed, clamp } = App.utils;

  // Rein visueller Randabstand am Anfang/Ende der Weg-Achse (in Metern) -
  // rückt die äußersten Knoten von den Diagrammrändern ab. Fließt NICHT in
  // Streckenlänge/Teilpunktabstand/Bandberechnung ein (die nutzen weiterhin
  // die echten Stationswerte aus coordination.js/app.js), nur in die
  // Pixel-Abbildung hier.
  const STATION_VISUAL_BUFFER_M = 10;

  // Rasterschritt als (nette) Bruchteil der Umlaufzeit TU - so landen die
  // Gitterlinien exakt auf TX-Werten (Sekunde im Umlauf) statt auf
  // beliebigen "runden" Sekundenzahlen ohne Bezug zum Umlauf.
  const TU_FRACS = [60, 40, 20, 10, 8, 5, 4, 2, 1];
  function pickTxGridStep(TU, pxPerSec, minPx) {
    for (const f of TU_FRACS) {
      const step = TU / f;
      if (step * pxPerSec >= minPx) return step;
    }
    return TU;
  }

  // dir: {rows, lTP, qualitativeBand, optimumBand, bandFill, bandStroke,
  //       tag: 'H'|'R', tagColor, gridColor} oder null
  function renderDiagram(container, o) {
    const { TU, showQualitative, showOptimum, showTimestamp, globalTMin, globalTMax, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0 || !(globalTMax > globalTMin)) { container.innerHTML = ''; return null; }

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const corridor = sMax - sMin;
    // Nur für die Pixel-Abbildung (X/sx/Tooltip) gepuffert - Streckenlänge
    // etc. bleiben unverändert die echten Werte.
    const sMinPlot = sMin - STATION_VISUAL_BUFFER_M, sMaxPlot = sMax + STATION_VISUAL_BUFFER_M;
    const corridorPlot = sMaxPlot - sMinPlot;

    // mR großzügig bemessen (nicht nur ein schmaler Rand): die letzte
    // Stationsbeschriftung (Kopf-/Fußzeile, mittig über der Station
    // zentriert) reicht sonst über den Zeichenbereich hinaus und erzwingt
    // horizontales Scrollen im Diagramm-Container.
    const mL = 56, mR = 56, mT = 16;
    const footerBaseH = 36 + Math.max(0, dirs.length - 1) * 26;
    const mB = footerBaseH + 16; // + Zeile für aktuellen Signalzeitenplan je Knoten
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);

    // Zoomstufe an der Umlaufzeit ausgerichtet, nicht an der Gesamtdauer -
    // mindestens ~3 Umläufe sollen ohne Scrollen im sichtbaren Bereich
    // Platz haben, egal wie lang die Aufzeichnung insgesamt ist.
    const VIEWPORT_PX = 560, CYCLES_VISIBLE = 3;
    const pxPerSec = Math.min(8, Math.max(0.02, VIEWPORT_PX / (CYCLES_VISIBLE * TU)));
    const totalSec = (globalTMax - globalTMin) / 1000;
    const plotH = totalSec * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH;
    const sx = corridorPlot > 0 ? plotW / corridorPlot : 0;
    const X = s => mL + (s - sMinPlot) * sx;
    // Nullpunkt unten (globalTMin), Zeit läuft nach oben.
    const Y = tMs => mT + plotH - (tMs - globalTMin) / 1000 * pxPerSec;
    const clipId = 'coordClip' + Math.random().toString(36).slice(2, 8);
    const clip = `url(#${clipId})`;

    // Grünband-Füllung: je Richtung (H/R) UND Bandart (Querschnitt/Optimum)
    // eine eigene Schraffur - unterscheidbare Farbe (H dunkelgrün/neongrün,
    // R dunkelblau/neonblau) UND unterschiedliche Schraffurrichtung
    // (Querschnitt und Optimum laufen je Richtung entgegengesetzt schräg),
    // damit sich alle vier Bänder auch ohne Legende auf einen Blick
    // unterscheiden lassen. Durchgehende (nicht gestrichelte) Randlinie in
    // derselben Farbe wie die Schraffur.
    function makeHatchPattern(color, angleDeg, idSeed) {
      const id = 'hatch' + idSeed + Math.random().toString(36).slice(2, 8);
      const def = `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${angleDeg})">`
        + `<rect width="6" height="6" fill="${color}" fill-opacity="0.20"/>`
        + `<line x1="0" y1="0" x2="0" y2="6" stroke="${color}" stroke-width="2"/>`
        + `</pattern>`;
      return { def, url: `url(#${id})`, color };
    }
    const bandStyle = {
      H: {
        qual: makeHatchPattern('#1b5e20', 45, 'Hq'),   // Hin Querschnitt: dunkelgrün, Schraffur nach rechts
        opt: makeHatchPattern('#39ff14', -45, 'Ho')    // Hin Optimum: neongrün, Schraffur nach links
      },
      R: {
        qual: makeHatchPattern('#0b3d91', -45, 'Rq'),  // Rück Querschnitt: dunkelblau, Schraffur nach links
        opt: makeHatchPattern('#00e5ff', 45, 'Ro')     // Rück Optimum: neonblau, Schraffur nach rechts
      }
    };

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas, ui-monospace, monospace">`;
    svg += `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath>`;
    svg += bandStyle.H.qual.def + bandStyle.H.opt.def + bandStyle.R.qual.def + bandStyle.R.opt.def;
    svg += `</defs>`;
    svg += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    // Gitterlinien nach TX (Sekunde im Umlauf, 0..TU) statt Uhrzeit/verstri-
    // chener Zeit - die für die Koordinierung relevante Größe. Schrittweite
    // als Bruchteil von TU gewählt, damit die Linien exakt auf TX-Werten
    // liegen; der reale Zeitstempel kann optional zusätzlich angezeigt
    // werden (Checkbox "Zeitstempel anzeigen").
    const gridStepS = TU ? pickTxGridStep(TU, pxPerSec, showTimestamp ? 54 : 30) : 60;
    const gridStepMs = gridStepS * 1000;
    const cycleMs = TU ? TU * 1000 : 0;
    const firstGrid = Math.ceil(globalTMin / gridStepMs) * gridStepMs;
    for (let t = firstGrid; t <= globalTMax; t += gridStepMs) {
      // Umlaufgrenze (Vielfaches von TU) wird unten als eigene, hervorgeho-
      // bene Linie mit Label "TX {TU}" (Umlaufende) gezeichnet statt hier
      // als normale Gitterlinie mit Label "TX 0" - Doppelung vermeiden.
      if (cycleMs && Math.abs(t % cycleMs) < 1) continue;
      const y = Y(t);
      const tx = TU ? Math.round((((t - globalTMin) / 1000) % TU + TU) % TU) : null;
      svg += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/>`;
      if (showTimestamp) {
        svg += `<text x="${mL - 6}" y="${(y - 1).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-faint)">TX ${tx}</text>`;
        svg += `<text x="${mL - 6}" y="${(y + 8).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--text-faint)">${fmtTimeShort(t)}</text>`;
      } else {
        svg += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-faint)">TX ${tx}</text>`;
      }
    }

    // Umlaufende-Linien: an jedem Vielfachen von TU - NICHT als TX 0 (Beginn
    // des nächsten Umlaufs), sondern als TX {TU} (Ende des laufenden
    // Umlaufs) beschriftet - deutlich abgesetzt (durchgezogen, kräftiger)
    // vom übrigen gestrichelten Raster, damit Umlaufgrenzen beim Scrollen
    // durch die Historie klar erkennbar bleiben.
    if (cycleMs) {
      const firstCycleEnd = Math.ceil(globalTMin / cycleMs) * cycleMs;
      for (let t = firstCycleEnd; t <= globalTMax; t += cycleMs) {
        const y = Y(t);
        svg += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL + plotW}" y2="${y.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1.4"/>`;
        if (showTimestamp) {
          svg += `<text x="${mL - 6}" y="${(y - 1).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">TX ${TU}</text>`;
          svg += `<text x="${mL - 6}" y="${(y + 8).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--text-muted)">${fmtTimeShort(t)}</text>`;
        } else {
          svg += `<text x="${mL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">TX ${TU}</text>`;
        }
      }
    }
    const axisTitle = showTimestamp
      ? `Umlaufsekunde TX ↑ (Start ${esc(fmtDateTimeShort(globalTMin))})`
      : `Umlaufsekunde TX ↑ (t_U ${TU ?? '–'} s)`;
    svg += `<text x="12" y="${mT + plotH / 2}" font-size="10" fill="var(--text-muted)" transform="rotate(-90 12 ${mT + plotH / 2})" text-anchor="middle">${axisTitle}</text>`;

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

    // "Querschnitts"-Band (qualitativ): je Abschnitt einfach die Grünzeit des
    // abfahrenden Knotens, ohne Verengung - zeigt auf einen Blick, ob das
    // Band jede einzelne (reale) Grünzeit im Streckenzug überhaupt berührt.
    // Gezeichnet direkt aus den realen Vorkommen (occurrences) des
    // abfahrenden Knotens - kein periodisch wiederholter Medianwert, daher
    // keine künstliche Drift gegenüber der Realität.
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
      svg += `<g clip-path="${clip}">${qSvg}</g>`;
    });

    // Optimum-Band: aus der REALEN Intervall-Verschneidung (siehe
    // computeOptimumBand) - keine periodische Wiederholung/Modellannahme
    // mehr nötig, jeder Lauf trägt bereits seine tatsächlichen absoluten
    // Zeitstempel. Jeder Abschnitt ist ein echtes Parallelogramm (konstante
    // Breite, kein Tapern) - die bis einschließlich des ABFAHRENDEN Knotens
    // gültige (kumulierte) Breite; ein nachfolgender Knoten mit engerer/
    // versetzter Grünzeit verengt das Band daher erst AB seiner eigenen
    // Position als sichtbare Stufe - der Abschnitt davor kann seine
    // tatsächliche Grünzeit sichtbar über- oder unterschreiten.
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
      svg += `<g clip-path="${clip}">${propSvg}</g>`;
    });

    // Knotenlinien: Sperrzeit-Grundlinie nur über den TATSÄCHLICHEN
    // Aufzeichnungszeitraum dieses Knotens (kürzere/versetzte Abdeckung wird
    // so als Lücke sichtbar), reale Grünsegmente direkt aus den Rohdaten.
    dirs.forEach(d => {
      d.rows.forEach(r => {
        const x = X(r.station);
        const yTop = Y(Math.min(r.tMax, globalTMax)), yBot = Y(Math.max(r.tMin, globalTMin));
        svg += `<line x1="${x.toFixed(1)}" y1="${yTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="var(--sig-red)" stroke-width="2.5"><title>${esc(r.name)} (${d.tag}): Aufzeichnung ${fmtDateTimeShort(r.tMin)} – ${fmtDateTimeShort(r.tMax)}</title></line>`;
        let overlay = '';
        (r.greenSegs || []).forEach(seg => {
          const ys = Y(seg.end), ye = Y(seg.start);
          if (ye < mT || ys > mT + plotH) return;
          const h = Math.max(1, ye - ys);
          overlay += `<rect x="${(x - 3).toFixed(1)}" y="${ys.toFixed(1)}" width="6" height="${h.toFixed(1)}" fill="var(--sig-green)"><title>${esc(r.name)} (${d.tag}): ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)}</title></rect>`;
          // An-/Abwurfzeitpunkt (Sekunde im Umlauf) je realem Grünsegment -
          // relativ zum nächstgelegenen eigenen Umlaufbeginn dieses Knotens.
          // "an" (Anwurf/Start) unten am Grünbalken - Zeit läuft nach oben,
          // der untere Rand (ye) ist also der frühere/Start-Zeitpunkt;
          // "ab" (Abwurf/Ende) entsprechend oben (ys).
          const cs = App.parser.findEnclosingCycleStart(seg.start, r.cycleStarts);
          if (cs != null && TU) {
            const an = ((Math.round((seg.start - cs) / 1000) % TU) + TU) % TU;
            const tf = Math.round((seg.end - seg.start) / 1000);
            const ab = an + tf;
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(ye + 7).toFixed(1)}" font-size="7.5" fill="var(--text-faint)">${an}</text>`;
            overlay += `<text x="${(x + 6).toFixed(1)}" y="${(ys - 2).toFixed(1)}" font-size="7.5" fill="var(--text-faint)">${ab}</text>`;
          }
        });
        svg += `<g clip-path="${clip}">${overlay}</g>`;
      });
    });

    // Horizontale Orientierungslinie, die der Maus beim Überfahren des
    // Diagramms folgt (siehe mousemove weiter unten) - erleichtert das
    // Vergleichen einer Zeitposition über mehrere Knoten/Stationen hinweg.
    svg += `<line id="hoverLine" x1="${mL}" y1="0" x2="${mL + plotW}" y2="0" stroke="var(--text)" stroke-width="1" stroke-dasharray="4 3" opacity="0" pointer-events="none"/>`;

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

    // Bildlaufposition über ein Neu-Rendern hinweg beibehalten (z. B. beim
    // Umschalten der Grünband-Checkboxen) - nur beim ALLERERSTEN Rendern
    // dieses Containers (kein vorheriger Zustand vorhanden) wird an den
    // Nullpunkt (00:00:00, unterer Rand) gescrollt, da die Zeit hier nach
    // oben läuft.
    const prevState = container._diagramScrollState;
    if (prevState) {
      const tAtPrevTop = prevState.globalTMin + (prevState.mT + prevState.plotH - prevState.scrollTop) / prevState.pxPerSec * 1000;
      const newScrollTop = mT + plotH - (tAtPrevTop - globalTMin) / 1000 * pxPerSec;
      container.scrollTop = clamp(newScrollTop, 0, container.scrollHeight);
    } else {
      container.scrollTop = container.scrollHeight;
    }

    // Aktuellen Signalzeitenplan je Knoten anzeigen - bezogen auf die Zeit
    // am oberen Rand des sichtbaren Ausschnitts, aktualisiert beim Scrollen.
    const splLiveEl = container.querySelector('#diagramSplLive');
    function updateSplLive() {
      if (!splLiveEl) return;
      const tAtViewTop = globalTMin + (mT + plotH - container.scrollTop) / pxPerSec * 1000;
      const parts = [];
      dirs.forEach(d => {
        d.rows.forEach(r => {
          if (tAtViewTop < r.tMin || tAtViewTop > r.tMax) return;
          const period = (r.splPeriods || []).find(p => tAtViewTop >= p.start && tAtViewTop < p.end);
          if (period) parts.push(`${d.tag} ${r.name}: SPL ${period.spl}`);
        });
      });
      splLiveEl.textContent = `${fmtElapsed(tAtViewTop - globalTMin)}` + (parts.length ? ` · ${parts.join(' · ')}` : '');
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

    // Zu einem bestimmten Zeitpunkt springen (z. B. aus der
    // Koordinationsstatistik heraus) - zentriert den Zeitpunkt im
    // sichtbaren Ausschnitt.
    function scrollToTime(tMs) {
      const viewportH = container.clientHeight || plotH;
      const target = mT + plotH - (tMs - globalTMin) / 1000 * pxPerSec - viewportH / 2;
      container.scrollTop = clamp(target, 0, container.scrollHeight);
    }

    // Snappy Tooltip: zeigt beim Bewegen der Maus die verstrichene Zeit und
    // den vollen Meter an der Cursorposition an - plus eine horizontale
    // Orientierungslinie über die gesamte Diagrammbreite an derselben
    // Y-Position, damit sich eine Zeitposition über mehrere Stationen
    // hinweg vergleichen lässt.
    const svgEl = container.querySelector('svg');
    const tooltipEl = container.querySelector('.diagram-tooltip');
    const hoverLineEl = container.querySelector('#hoverLine');
    if (svgEl && tooltipEl) {
      svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const scaleX = W / (rect.width || W), scaleY = H / (rect.height || H);
        const localX = (e.clientX - rect.left) * scaleX;
        const localY = (e.clientY - rect.top) * scaleY;
        if (localX < mL || localX > mL + plotW || localY < mT || localY > mT + plotH) {
          tooltipEl.style.display = 'none';
          if (hoverLineEl) hoverLineEl.setAttribute('opacity', '0');
          return;
        }
        const tMs = globalTMin + (mT + plotH - localY) / pxPerSec * 1000;
        const sVal = Math.round(sMinPlot + (localX - mL) / (sx || 1e-6));
        tooltipEl.textContent = `t = ${fmtElapsed(tMs - globalTMin)} · s = ${sVal} m`;
        const hostRect = container.getBoundingClientRect();
        tooltipEl.style.left = (e.clientX - hostRect.left + container.scrollLeft + 14) + 'px';
        tooltipEl.style.top = (e.clientY - hostRect.top + container.scrollTop - 26) + 'px';
        tooltipEl.style.display = 'block';
        if (hoverLineEl) {
          hoverLineEl.setAttribute('y1', localY.toFixed(1));
          hoverLineEl.setAttribute('y2', localY.toFixed(1));
          hoverLineEl.setAttribute('opacity', '0.8');
        }
      });
      svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        if (hoverLineEl) hoverLineEl.setAttribute('opacity', '0');
      });
    }

    return { scrollToTime };
  }

  App.diagram = { renderDiagram };
})(window.App = window.App || {});
