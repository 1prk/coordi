/* Koordinierung – Zeit-Weg-Diagramm (D3.js): durchgehende Zeitachse über die
   gesamte Aufzeichnung (nicht nach Umlaufzeit gestapelt) - zeigt reale
   Grünsegmente aus den Rohdaten, damit sich die Koordinierung tatsächlich
   über die Zeit durchblättern (scrollen) lässt. Nullpunkt der Zeitachse
   (00:00:00) liegt unten, die Zeit läuft nach oben - je weiter oben, desto
   später. Hin- und Gegenrichtung kombiniert auf gemeinsamer Zeit-/Weg-Achse.

   Interaktionsmodell: natives Scrollen durch die Zeit (inkl. Mausrad), sticky
   Kopf-/Fußzeile, Strg+Mausrad zoomt über einen von außen (app.js)
   übergebenen zoomLevel. Ein transform-basiertes d3-zoom (Pan/Zoom in einem
   festen Viewport) hat sich dafür als unpraktisch erwiesen (Mausrad soll
   durch die Zeit scrollen, die Fußzeile immer sichtbar bleiben) - D3 dient
   hier für Skalen (d3.scaleLinear) und den DOM-Aufbau (d3.select). */
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

  // Grünband-Farben je Richtung (H: grün, R: blau) und Bandart: Querschnitt
  // (dunkel), Optimum vollständig (neon) und Optimum unvollständig (part -
  // dieselbe Farbfamilie wie das vollständige Optimum, aber gestrichelt und
  // ohne Schraffur, siehe bandStyle in renderDiagram).
  const bandColor = {
    H: { qual: '#1b5e20', opt: '#39ff14', part: '#1fd10a' },
    R: { qual: '#0b3d91', opt: '#00e5ff', part: '#00a8c8' }
  };
  // Track-Spuren neben der Knotenlinie (siehe app.js collectRows, tracks):
  // DET und APW werden identisch als Balken mit Wert-Label gezeichnet - eigene
  // Farbe, damit beide auch ohne Legende unterscheidbar sind.
  const DET_COLOR = '#6a3fa0';
  const APW_COLOR = '#b5670a';
  const TRACK_LANE_STEP = 11;

  // dir (hin/rev): {rows, lTP, qualitativeBand, optimumBand, tag: 'H'|'R',
  //                 tagColor, gridColor} oder null
  function renderDiagram(container, o) {
    const d3 = window.d3;
    if (!d3) {
      container.innerHTML = '<div class="node-empty">D3.js konnte nicht geladen werden (lib/d3.v7.min.js fehlt oder blockiert).</div>';
      return null;
    }
    const { TU, showQualitative, showOptimum, showPartial, showTimestamp, zoomLevel, globalTMin, globalTMax, hin, rev } = o;
    const dirs = [hin, rev].filter(Boolean);
    if (dirs.length === 0 || !(globalTMax > globalTMin)) { container.innerHTML = ''; return null; }

    const allRows = dirs.flatMap(d => d.rows);
    const sMin = Math.min(...allRows.map(r => r.station));
    const sMax = Math.max(...allRows.map(r => r.station));
    const corridor = sMax - sMin;
    const sMinPlot = sMin - STATION_VISUAL_BUFFER_M, sMaxPlot = sMax + STATION_VISUAL_BUFFER_M;

    // mR großzügig bemessen (nicht nur ein schmaler Rand): die letzte
    // Stationsbeschriftung (Kopf-/Fußzeile, mittig über der Station
    // zentriert) reicht sonst über den Zeichenbereich hinaus und erzwingt
    // horizontales Scrollen im Diagramm-Container.
    const mL = 56, mR = 56, mT = 16;
    // 40px je Richtung: Platz für bis zu zwei Namenszeilen (Knotennamen mit
    // "/" brechen um) über der Maßketten-Zeile.
    const FOOTER_ROW_H = 40;
    const footerBaseH = FOOTER_ROW_H + Math.max(0, dirs.length - 1) * FOOTER_ROW_H;
    const mB = footerBaseH + 16;
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);

    // Zoomstufe an der Umlaufzeit ausgerichtet, nicht an der Gesamtdauer -
    // mindestens ~3 Umläufe sollen ohne Scrollen im sichtbaren Bereich
    // Platz haben, egal wie lang die Aufzeichnung insgesamt ist. `zoomLevel`
    // (>0, Default 1) skaliert diese Basis-Zoomstufe interaktiv (Zoom-Buttons
    // / Strg+Mausrad in app.js) - 1 = Basisstufe (~3 Umläufe sichtbar), >1
    // näher heran (weniger Umläufe, mehr Detail), <1 weiter heraus.
    const VIEWPORT_PX = 560, CYCLES_VISIBLE = 3;
    const zoom = zoomLevel && zoomLevel > 0 ? zoomLevel : 1;
    const pxPerSec = Math.min(60, Math.max(0.01, (VIEWPORT_PX / (CYCLES_VISIBLE * TU)) * zoom));
    const totalSec = (globalTMax - globalTMin) / 1000;
    const plotH = totalSec * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH;

    const xScale = d3.scaleLinear().domain([sMinPlot, sMaxPlot]).range([mL, mL + plotW]);
    const X = s => xScale(s);
    // Nullpunkt unten (globalTMin), Zeit läuft nach oben.
    const yScale = d3.scaleLinear().domain([globalTMin, globalTMax]).range([mT + plotH, mT]);
    const Y = t => yScale(t);
    const clipId = 'coordClip' + Math.random().toString(36).slice(2, 8);
    const clip = `url(#${clipId})`;

    // Grünband-Füllung: je Richtung (H/R) UND Bandart (Querschnitt/Optimum)
    // eine eigene Schraffur - unterscheidbare Farbe (H dunkelgrün/neongrün,
    // R dunkelblau/neonblau) UND unterschiedliche Schraffurrichtung
    // (Querschnitt und Optimum laufen je Richtung entgegengesetzt schräg),
    // damit sich die Bänder auch ohne Legende auf einen Blick unterscheiden
    // lassen. Durchgehende (nicht gestrichelte) Randlinie in derselben Farbe
    // wie die Schraffur.
    function hatchDef(color, angleDeg, idSeed) {
      const id = 'hatch' + idSeed + Math.random().toString(36).slice(2, 8);
      const def = `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${angleDeg})">`
        + `<rect width="6" height="6" fill="${color}" fill-opacity="0.20"/>`
        + `<line x1="0" y1="0" x2="0" y2="6" stroke="${color}" stroke-width="2"/>`
        + `</pattern>`;
      return { def, url: `url(#${id})`, color };
    }
    // part (Optimum unvollständig): keine Schraffur, sondern eine zarte
    // Vollton-Tönung mit gestrichelter Randlinie - bewusst leiser als das
    // vollständige Optimum, damit die durchgehende Grüne Welle weiterhin
    // zuerst ins Auge fällt, die Teilkoordinierung aber klar als dieselbe
    // Richtung/Farbfamilie erkennbar bleibt.
    const bandStyle = {
      H: {
        qual: hatchDef(bandColor.H.qual, 45, 'Hq'),   // Hin Querschnitt: dunkelgrün, Schraffur nach rechts
        opt: hatchDef(bandColor.H.opt, -45, 'Ho'),    // Hin Optimum: neongrün, Schraffur nach links
        part: { color: bandColor.H.part }             // Hin Optimum unvollständig: grün, gestrichelt
      },
      R: {
        qual: hatchDef(bandColor.R.qual, -45, 'Rq'),  // Rück Querschnitt: dunkelblau, Schraffur nach links
        opt: hatchDef(bandColor.R.opt, 45, 'Ro'),     // Rück Optimum: neonblau, Schraffur nach rechts
        part: { color: bandColor.R.part }             // Rück Optimum unvollständig: blau, gestrichelt
      }
    };
    // APW-Wert 0 ist laut OCIT-Spezifikation ein Sonderfall, keine "normale"
    // Zahl wie jeder andere Wert (und ausdrücklich etwas anderes als "kein
    // Wert"/leer) - daher schraffiert statt Vollton, analog zu den
    // Grünband-Schraffuren oben.
    const apwZeroPattern = hatchDef(APW_COLOR, 45, 'Apw0');

    let svgInner = `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath>`
      + bandStyle.H.qual.def + bandStyle.H.opt.def + bandStyle.R.qual.def + bandStyle.R.opt.def + apwZeroPattern.def + `</defs>`;
    svgInner += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    // Gitterlinien nach TX (Sekunde im Umlauf, 0..TU) statt Uhrzeit/verstri-
    // chener Zeit - die für die Koordinierung relevante Größe. Schrittweite
    // als Bruchteil von TU gewählt, damit die Linien exakt auf TX-Werten
    // liegen; der reale Zeitstempel kann optional zusätzlich angezeigt
    // werden (Checkbox "Zeitstempel anzeigen"). Alle Gitterlinien sind ab
    // globalTMin verankert (nicht an der rohen Unix-Epoche) - so beginnt
    // "Umlauf 0"/TX 0 exakt an der verstrichenen Zeit 00:00:00 (unterer Rand).
    const gridStepS = TU ? pickTxGridStep(TU, pxPerSec, showTimestamp ? 54 : 30) : 60;
    const gridStepMs = gridStepS * 1000;
    const cycleMs = TU ? TU * 1000 : 0;
    for (let t = globalTMin; t <= globalTMax; t += gridStepMs) {
      // Umlaufgrenze (Vielfaches von TU) wird unten als eigene, hervorgeho-
      // bene Linie mit Label "TX {TU}" (Umlaufende) gezeichnet statt hier
      // als normale Gitterlinie mit Label "TX 0" - Doppelung vermeiden.
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

    // Umlaufende-Linien: an jedem Vielfachen von TU ab globalTMin - NICHT
    // als TX 0 (Beginn des nächsten Umlaufs), sondern als TX {TU} (Ende des
    // laufenden Umlaufs) beschriftet - deutlich abgesetzt (durchgezogen,
    // kräftiger) vom übrigen gestrichelten Raster, damit Umlaufgrenzen beim
    // Scrollen durch die Historie klar erkennbar bleiben. Zusätzlich trägt
    // jeder Umlauf (zwischen zwei solchen Grenzen) einen fortlaufenden
    // Index "U{n}" - rechts am Rand, mittig im jeweiligen Umlauf platziert:
    // Umlauf 0 = [globalTMin, globalTMin+TU), Umlauf 1 = das nächste
    // TU-Intervall usw.
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
      svgInner += `<g clip-path="${clip}">${qSvg}</g>`;
    });

    // Optimum-Band (vollständig): aus der REALEN Intervall-Verschneidung
    // (siehe computeOptimumBand) - keine periodische Wiederholung/
    // Modellannahme, jeder Lauf trägt bereits seine tatsächlichen absoluten
    // Zeitstempel. Je Umlauf, der durchgehend bis zum letzten Knoten kommt,
    // ein echtes Parallelogramm (konstante Breite, kein Tapern) über jeden
    // Abschnitt.
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

    // Optimum-Band (unvollständig): die Umläufe, die NICHT bis zum letzten
    // Knoten durchkommen - dieselbe Geometrie wie oben, aber nur bis zum
    // letzten Knoten, den der Umlauf noch durchgehend erreicht (gestrichelter
    // Rand, zarte Tönung). Der Abschnitt dahinter (run.blocked) ist nur als
    // gestrichelte Kontur mit minimaler Tönung gezeichnet: das Band, wie es
    // ohne Halt weiterlaufen würde, bis es am nächsten Knoten auf Rot trifft
    // - zeigt, WO die Koordinierung abreißt. Die Tönung ist nicht null, damit
    // die Fläche den Tooltip (Hover) trägt.
    dirs.forEach(d => {
      if (!showPartial || !d.optimumBand) return;
      const style = bandStyle[d.tag].part;
      let partSvg = '';
      d.optimumBand.segments.forEach(seg => {
        const xA = X(seg.a.station), xB = X(seg.b.station);
        seg.partialRuns.forEach(run => {
          const yA0 = Y(run.frontStart), yA1 = Y(run.frontEnd);
          const yB0 = Y(run.backStart), yB1 = Y(run.backEnd);
          if (Math.max(yA0, yA1, yB0, yB1) < mT || Math.min(yA0, yA1, yB0, yB1) > mT + plotH) return;
          const pts = [[xA, yA0], [xA, yA1], [xB, yB1], [xB, yB0]]
            .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
          const widthS = (run.frontEnd - run.frontStart) / 1000;
          const fillOpacity = run.blocked ? 0.10 : 0.32;
          const dash = run.blocked ? '3 3' : '6 3';
          const title = run.blocked
            ? `Umlauf ${run.cycleIdx}: ${widthS.toFixed(0)}s breit, trifft vor ${seg.b.name} auf Rot - Koordinierung endet nach ${run.reachedNode.name}`
            : `Umlauf ${run.cycleIdx}: ${seg.a.name} -> ${seg.b.name}, ${widthS.toFixed(0)}s bei ${seg.vp_kmh.toFixed(0)} km/h - unvollständig, scheitert an ${run.failedAt.name}`;
          // Weißer Halo unter der gestrichelten Kontur: hebt sie vom dichten
          // Querschnitts-Raster darunter ab, das sonst die Striche verschluckt.
          partSvg += `<polygon points="${pts}" fill="none" stroke="#fff" stroke-width="3.6" stroke-opacity="0.9" pointer-events="none"/>`
            + `<polygon points="${pts}" fill="${style.color}" fill-opacity="${fillOpacity}" stroke="${style.color}" stroke-width="1.7" stroke-dasharray="${dash}"><title>${esc(title)}</title></polygon>`;
        });
      });
      svgInner += `<g clip-path="${clip}">${partSvg}</g>`;
    });

    // Knotenlinien: Sperrzeit-Grundlinie nur über den TATSÄCHLICHEN
    // Aufzeichnungszeitraum dieses Knotens (kürzere/versetzte Abdeckung wird
    // so als Lücke sichtbar), reale Grünsegmente direkt aus den Rohdaten.
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
        // Zugeordnete Det/APW-Spuren dieser Signalgruppe (siehe Setup-Tab,
        // "+ Det/APW hinzufügen" je Richtung): je Spur eine eigene schmale
        // Spur rechts neben der Knotenlinie (jenseits der An/Ab-Beschriftung
        // bei x+6), DET und APW identisch gezeichnet (Balken über die reale
        // Dauer je Wert-Segment, mit dem Wert als Label) - nur die Farbe und
        // die "0"-Schraffur unterscheiden sie, siehe pushRow-Filterung in
        // app.js. Bewusst KEIN dauerhaftes Namens-Label (weder in der
        // Kopfzeile noch gedreht) - stattdessen eine dünne, durchgehende
        // Führungslinie über die volle Aufzeichnungsdauer dieser Zeile (auch
        // dort, wo gerade kein Segment liegt), deren Name/Richtung sich per
        // Hover/Title erschließt; eine breitere unsichtbare Linie darunter
        // vergrößert die Trefferfläche, ohne die sichtbare Linie dick wirken
        // zu lassen. Direkt aufeinanderfolgende, einzeln zu kurze Segmente
        // (z. B. ein schnell tickender Countdown) verschmelzen bei diesem
        // Zoom bewusst zu einem durchgehenden Balken statt beschriftete
        // Segmente zu erzwingen, die sich sonst gegenseitig überlappen
        // würden - der Wert jedes einzelnen Segments bleibt per Tooltip
        // abrufbar, ein Reinzoomen zeigt die Beschriftung wieder direkt.
        (r.tracks || []).forEach((tr, di) => {
          const xd = x + 18 + di * TRACK_LANE_STEP;
          const color = tr.kind === 'DET' ? DET_COLOR : APW_COLOR;
          const yTopRow = Y(Math.min(r.tMax, globalTMax)), yBotRow = Y(Math.max(r.tMin, globalTMin));
          const lineTitle = `<title>${esc(tr.name)} (${d.tag} ${esc(r.name)})</title>`;
          overlay += `<line x1="${xd.toFixed(1)}" y1="${yTopRow.toFixed(1)}" x2="${xd.toFixed(1)}" y2="${yBotRow.toFixed(1)}" stroke="transparent" stroke-width="10">${lineTitle}</line>`;
          overlay += `<line x1="${xd.toFixed(1)}" y1="${yTopRow.toFixed(1)}" x2="${xd.toFixed(1)}" y2="${yBotRow.toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.35" pointer-events="none"/>`;
          tr.segs.forEach(seg => {
            const ys = Y(seg.end), ye = Y(seg.start);
            if (ye < mT || ys > mT + plotH) return;
            const h = Math.max(1, ye - ys);
            const fill = seg.cat === '0' ? apwZeroPattern.url : color;
            overlay += `<rect x="${(xd - 3).toFixed(1)}" y="${ys.toFixed(1)}" width="6" height="${h.toFixed(1)}" fill="${fill}" stroke="#fff" stroke-width="0.6"><title>${esc(tr.name)} (${d.tag} ${esc(r.name)}): ${esc(seg.cat)} (${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)})</title></rect>`;
            if (h >= 9) {
              overlay += `<text x="${xd.toFixed(1)}" y="${(ys + h / 2 + 3).toFixed(1)}" font-size="8" text-anchor="middle" fill="#fff" font-weight="700" paint-order="stroke" stroke="${color}" stroke-width="2.5">${esc(seg.cat)}</text>`;
            }
          });
        });
        svgInner += `<g clip-path="${clip}">${overlay}</g>`;
      });
    });

    // Horizontale Orientierungslinie, die der Maus beim Überfahren des
    // Diagramms folgt (siehe mousemove weiter unten) - erleichtert das
    // Vergleichen einer Zeitposition über mehrere Knoten/Stationen hinweg.
    svgInner += `<line id="hoverLine"x1="${mL}" y1="0" x2="${mL + plotW}" y2="0" stroke="var(--text)" stroke-width="1" stroke-dasharray="4 3" opacity="0" pointer-events="none"/>`;

    // DOM-Aufbau über D3-Selections statt einem einzelnen innerHTML-String:
    // sticky Kopfzeile, das Haupt-SVG, sticky Fußzeile, Tooltip-Div, in
    // dieser Reihenfolge als direkte Kinder des scrollenden Containers.
    container.innerHTML = '';
    const root = d3.select(container);

    // Sticky Kopfzeile mit Signalgruppennamen je Knoten/Richtung. Bewusst
    // KEIN eigenes Label je Det/APW-Spur hier (siehe Track-Zeichnung oben) -
    // die Führungslinie plus ihre breite Hover-Trefferfläche übernehmen die
    // Identifikation, ohne die Kopfzeile mit wachsender Spurzahl breiter/
    // höher werden zu lassen.
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
    // (Abschnittsabstand, Hin -> rechts, Rück -> links) sowie eine Zeile mit
    // dem je Knoten AKTUELL (an der Bildlaufposition) geltenden
    // Signalzeitenplan - aktualisiert sich beim Scrollen durch die Historie.
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

  App.diagram = { renderDiagram };
})(window.App = window.App || {});
