/* Koordinierung – Zeit-Weg-Diagramm (SVG), eine Richtung je Aufruf */
(function (App) {
  'use strict';
  const { esc } = App.utils;

  // rows: aufsteigend nach Station sortiert (x-Achse). orderedRows: gleiche
  // Knoten in tatsächlicher Fahrtrichtung (für Band-Konstruktion).
  function renderDiagram(container, rows, o) {
    const {
      TU, lTP, Ncyc, drawBand, orderedRows, measuredSegs,
      proposedBand, bandFill, bandStroke
    } = o;
    const sMin = rows[0].station, sMax = rows[rows.length - 1].station;
    const corridor = sMax - sMin;

    const mL = 56, mR = 18, mT = 16, mB = 48;
    const wrapWidth = container.clientWidth || 800;
    const plotW = Math.max(240, wrapWidth - mL - mR - 4);
    const pxPerSec = Math.max(1.6, 150 / TU);
    const Ttot = Ncyc * TU;
    const plotH = Ttot * pxPerSec;
    const W = mL + plotW + mR, H = mT + plotH + mB;
    const sx = corridor > 0 ? plotW / corridor : 0;
    const X = s => mL + (s - sMin) * sx;
    const Y = t => mT + plotH - t * pxPerSec;
    const clip = 'url(#coordClip' + Math.random().toString(36).slice(2, 8) + ')';
    const clipId = clip.slice(5, -1);
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas, ui-monospace, monospace">`;
    svg += `<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`;
    svg += `<rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#fff" stroke="var(--border-strong)"/>`;

    const half = Math.round(TU / 2);
    for (let k = 0; k <= Ncyc; k++) {
      const yB = Y(k * TU);
      svg += `<line x1="${mL}" y1="${yB.toFixed(1)}" x2="${mL + plotW}" y2="${yB.toFixed(1)}" stroke="var(--border-strong)"/>`;
      svg += `<text x="${mL - 6}" y="${(yB + 3).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="var(--text-muted)">0</text>`;
    }
    for (let k = 0; k < Ncyc; k++) {
      const yMid = Y(k * TU + TU / 2), yBottom = Y(k * TU);
      svg += `<line x1="${mL}" y1="${yMid.toFixed(1)}" x2="${mL + plotW}" y2="${yMid.toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/>`;
      svg += `<text x="${mL - 6}" y="${(yMid + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--text-faint)">${half}</text>`;
      svg += `<text x="${(mL + 4).toFixed(1)}" y="${(yBottom - 4).toFixed(1)}" font-size="8" fill="var(--text-faint)">Umlauf ${k + 1}</text>`;
    }
    svg += `<text x="12" y="${mT + plotH / 2}" font-size="10" fill="var(--text-muted)" transform="rotate(-90 12 ${mT + plotH / 2})" text-anchor="middle">Zeit t [s] je Umlauf (0…${TU})</text>`;

    if (lTP > 0 && corridor > 0) {
      for (let m = 0; sMin + m * lTP <= sMax + 0.5; m++) {
        const x = X(sMin + m * lTP);
        svg += `<line x1="${x.toFixed(1)}" y1="${mT}" x2="${x.toFixed(1)}" y2="${mT + plotH}" stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="2 4" opacity="0.55"/>`;
      }
    }

    if (drawBand && orderedRows && orderedRows.length >= 2) {
      let bandSvg = '';
      for (let k = -1; k <= Ncyc; k++) {
        for (let i = 0; i < orderedRows.length - 1; i++) {
          const a = orderedRows[i], b = orderedRows[i + 1];
          const dt = measuredSegs[i] ? measuredSegs[i].dt : 0;
          const xA = X(a.station), xB = X(b.station);
          const yFrontA = Y(a.an + k * TU), yFrontB = Y(a.an + dt + k * TU);
          const yBackA = Y(a.an + a.tf + k * TU), yBackB = Y(a.an + dt + a.tf + k * TU);
          const pts = [[xA, yFrontA], [xB, yFrontB], [xB, yBackB], [xA, yBackA]]
            .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
          bandSvg += `<polygon points="${pts}" fill="rgba(46,125,70,0.20)" stroke="rgba(46,125,70,0.55)" stroke-width="1"><title>${esc(a.name)} -> ${esc(b.name)}: ${a.tf}s</title></polygon>`;
          const yMidA = Y(a.an + a.tf / 2 + k * TU), yMidB = Y(a.an + dt + a.tf / 2 + k * TU);
          bandSvg += `<line x1="${xA.toFixed(1)}" y1="${yMidA.toFixed(1)}" x2="${xB.toFixed(1)}" y2="${yMidB.toFixed(1)}" stroke="var(--accent)" stroke-width="1.4"/>`;
        }
      }
      svg += `<g clip-path="${clip}">${bandSvg}</g>`;
    }

    // Band bei vorgegebener (fester) Progressionsgeschwindigkeit: je Abschnitt
    // der kumulierte Gültigkeitsbereich - zeigt an jedem Knoten sichtbar, ob
    // und wie stark die Grünzeit das Band dort beschneidet.
    if (proposedBand) {
      let propSvg = '';
      for (let k = -1; k <= Ncyc; k++) {
        proposedBand.segments.forEach(seg => {
          const xA = X(seg.a.station), xB = X(seg.b.station);
          seg.runs.forEach(run => {
            const yA0 = Y(run.t0a + seg.tauA + k * TU), yA1 = Y(run.t0b + seg.tauA + k * TU);
            const yB0 = Y(run.t0a + seg.tauB + k * TU), yB1 = Y(run.t0b + seg.tauB + k * TU);
            const pts = [[xA, yA0], [xA, yA1], [xB, yB1], [xB, yB0]]
              .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
            propSvg += `<polygon points="${pts}" fill="${bandFill}" stroke="${bandStroke}" stroke-width="1"><title>${esc(seg.a.name)} -> ${esc(seg.b.name)}: ${run.width.toFixed(1)}s bei ${proposedBand.Vp_kmh} km/h</title></polygon>`;
          });
        });
      }
      svg += `<g clip-path="${clip}">${propSvg}</g>`;
    }

    rows.forEach(r => {
      const x = X(r.station);
      svg += `<line x1="${x.toFixed(1)}" y1="${mT}" x2="${x.toFixed(1)}" y2="${mT + plotH}" stroke="var(--sig-red)" stroke-width="2.5"/>`;
      let overlay = '';
      for (let k = -1; k <= Ncyc; k++) {
        const gs = r.an + k * TU, ge = gs + r.tf;
        const cs = Math.max(gs, 0), ce = Math.min(ge, Ttot);
        if (ce <= cs) continue;
        const yTop = Y(ce), yBot = Y(cs);
        overlay += `<rect x="${(x - 3).toFixed(1)}" y="${yTop.toFixed(1)}" width="6" height="${(yBot - yTop).toFixed(1)}" fill="var(--sig-green)"><title>${esc(r.name)}: An ${r.an}s, Ab ${r.ab}s, TF ${r.tf}s</title></rect>`;
        if (k >= 0 && k < Ncyc) {
          overlay += `<text x="${(x + 6).toFixed(1)}" y="${(yBot + 3).toFixed(1)}" font-size="7.5" fill="var(--text-muted)">${r.an}</text>`;
          overlay += `<text x="${(x + 6).toFixed(1)}" y="${(yTop - 2).toFixed(1)}" font-size="7.5" fill="var(--text-muted)">${r.ab}</text>`;
        }
      }
      svg += `<g clip-path="${clip}">${overlay}</g>`;
      svg += `<text x="${x.toFixed(1)}" y="${mT + plotH + 18}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(r.name)}</text>`;
      svg += `<text x="${x.toFixed(1)}" y="${mT + plotH + 30}" text-anchor="middle" font-size="8.5" fill="var(--text-faint)">${r.station} m</text>`;
    });

    svg += `<text x="${mL + plotW / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--text-muted)">Weg s [m]</text>`;
    svg += `</svg>`;
    container.innerHTML = svg;
    container.scrollTop = container.scrollHeight;
  }

  App.diagram = { renderDiagram };
})(window.App = window.App || {});
