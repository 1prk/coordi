/* Koordinierung – Zeit-Weg-Berechnung über mehrere Knoten */
(function (App) {
  'use strict';

  // Grün-Zugehörigkeit mit Umlauf-Wrap: Grün deckt [an, an+tf) modulo TU ab.
  function inGreen(t, an, tf, TU) {
    const d = (((t - an) % TU) + TU) % TU;
    return d < tf;
  }

  function greenCenter(r, TU) { return (((r.an + r.tf / 2) % TU) + TU) % TU; }

  // Progressionsgeschwindigkeit aus den Grünlagen benachbarter Knoten:
  // Bandachse = Verbindung der Grünmitten. v_p = ΣΔl / ΣΔt.
  function deriveVp(rows, TU, dir) {
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    let sumL = 0, sumT = 0;
    const segs = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i], b = ordered[i + 1];
      const dl = Math.abs(b.station - a.station);
      let dt = (((greenCenter(b, TU) - greenCenter(a, TU)) % TU) + TU) % TU;
      if (dt < 1e-6) dt = TU;
      sumL += dl; sumT += dt;
      segs.push({ from: a.name, to: b.name, dl, dt, vp_kmh: dt > 0 ? dl / dt * 3.6 : 0 });
    }
    const vp_ms = sumT > 0 ? sumL / sumT : 0;
    return { vp_ms, vp_kmh: vp_ms * 3.6, sumL, sumT, segs };
  }

  function teilpunktabstand(TU, vpFwdKmh, vpRevKmh) {
    const VR = vpFwdKmh, VG = vpRevKmh;
    if (VR > 0 && VG > 0) return TU * VR * VG / (3.6 * (VR + VG));
    const V = VR > 0 ? VR : VG;
    return V > 0 ? V * TU / 7.2 : 0;
  }

  function lageLabel(E) {
    const f = E - Math.floor(E);
    if (f < 0.05 || f > 0.95) return 'Teilpunkt';
    if (f >= 0.4 && f <= 0.6) return 'Teilpunktferne';
    return f < 0.5 ? 'Teilpunktnähe (rechts)' : 'Teilpunktnähe (links)';
  }

  // Zusammenhängende (zirkuläre) True-Läufe in einem Bool-Array.
  function circularRuns(mask) {
    const n = mask.length;
    if (n === 0) return [];
    if (mask.every(Boolean)) return [{ start: 0, len: n }];
    if (!mask.some(Boolean)) return [];
    let origin = mask.findIndex((v, i) => v && !mask[(i - 1 + n) % n]);
    if (origin === -1) origin = 0;
    const runs = [];
    let i = 0;
    while (i < n) {
      if (mask[(origin + i) % n]) {
        let len = 0;
        while (len < n && mask[(origin + i + len) % n]) len++;
        runs.push({ start: (origin + i) % n, len });
        i += len;
      } else i++;
    }
    return runs;
  }

  // Gemeinsame Reisezeit-Kette (je Abschnitt eigene Geschwindigkeit) - von
  // beiden Bandarten genutzt. null, wenn eine Geschwindigkeit fehlt/0 ist.
  function computeTau(ordered, vpKmhArray) {
    const tau = [0];
    for (let i = 1; i < ordered.length; i++) {
      const vp = Number(vpKmhArray[i - 1]);
      if (!vp || vp <= 0) return null;
      const dl = Math.abs(ordered[i].station - ordered[i - 1].station);
      tau.push(tau[i - 1] + dl / (vp / 3.6));
    }
    return tau;
  }

  // An/Ab EINES realen Grünsegments, relativ zum eigenen (nächstgelegenen)
  // Umlaufbeginn des Knotens - im Gegensatz zum Medianwert im Signalplan
  // (planByCol) gibt das die TATSÄCHLICHE Lage genau dieses Vorkommens
  // wieder (inkl. etwaiger Schwankung/Planwechsel über den Tag).
  function realAnAb(cycleStarts, TU, g) {
    const cs = App.parser.findEnclosingCycleStart(g.start, cycleStarts);
    if (cs == null) return null;
    const an = ((Math.round((g.start - cs) / 1000) % TU) + TU) % TU;
    const tf = Math.round((g.end - g.start) / 1000);
    return { an, ab: an + tf, tf };
  }

  // "Querschnitts"-Band (qualitativ): je Abschnitt einfach die Grünzeit des
  // ABFAHRENDEN Knotens, unabhängig von den übrigen Knoten - keine
  // Verengung, keine Kumulierung. Gezeichnet wird direkt aus den REALEN
  // Grünsegmenten des abfahrenden Knotens (nicht aus einem periodisch
  // wiederholten Medianwert) - jedes tatsächliche Vorkommen bekommt sein
  // eigenes Parallelogramm, verschoben um die Reisezeit dieses Abschnitts.
  // Das zeigt auf einen Blick, ob das Band jede einzelne (reale) Grünzeit im
  // Streckenzug überhaupt berührt/schneidet, inklusive etwaiger realer
  // Schwankungen zwischen den Knoten, statt eine idealisierte Periodizität
  // vorauszusetzen.
  function computeQualitativeBand(rows, vpKmhArray, TU, dir) {
    if (!TU || rows.length < 2) return null;
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    if (!vpKmhArray || vpKmhArray.length < ordered.length - 1) return null;
    const tau = computeTau(ordered, vpKmhArray);
    if (!tau) return null;

    const segments = [];
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1];
      const dtSeg = tau[i] - tau[i - 1];
      const dtSegMs = dtSeg * 1000;
      const occurrences = (a.greenSegs || []).map(g => {
        const meta = realAnAb(a.cycleStarts, TU, g) || { an: a.an, ab: a.an + a.tf, tf: a.tf };
        return {
          frontStart: g.start, frontEnd: g.end,
          backStart: g.start + dtSegMs, backEnd: g.end + dtSegMs,
          an: meta.an, ab: meta.ab
        };
      });
      segments.push({ a, b: ordered[i], dtSeg, occurrences, vp_kmh: Number(vpKmhArray[i - 1]) });
    }
    return { ordered, segments };
  }

  // "Optimum"-Band: das Band, das JEDE Grünzeit im Streckenzug durchgehend
  // durchläuft - für eine je Abschnitt eigene (feste) Progressionsgeschwin-
  // digkeit, an welchen Abfahrtszeiten t0 am Bezugsknoten ein Fahrzeug an
  // JEDEM vorherigen Knoten noch auf Grün getroffen hat. Der gültige
  // Zeitbereich kann sich von Knoten zu Knoten nur verengen (nie
  // vergrößern). Jeder Abschnitt ist ein ECHTES Parallelogramm - konstante
  // Breite über den gesamten Abschnitt, kein Tapern innerhalb eines
  // Abschnitts. Die Breite eines Abschnitts ist die bis einschließlich des
  // ABFAHRENDEN Knotens gültige (kumulierte) Breite; ein Knoten mit
  // engerer Grünzeit verengt das Band daher sichtbar als Stufe an seiner
  // eigenen Position, nicht rückwirkend im Abschnitt davor.
  //
  // Die zugrunde liegende Verengungs-Maske ist ein periodisches (mod TU)
  // Modell relativ zur Uhr des Bezugsknotens (ordered[0]) - für die
  // Positionierung in absoluter Zeit wird sie aber NICHT einfach an den
  // realen Umlaufgrenzen des Bezugsknotens wiederholt (das koppelt jeden
  // Abschnitt fälschlich an die Uhr eines ANDEREN, ggf. leicht
  // asynchronen Knotens und lässt den Versatz über viele Umläufe sichtbar
  // "auseinanderlaufen"). Stattdessen wird je Abschnitt die Phase relativ
  // zum eigenen Umlauf des ABFAHRENDEN Knotens berechnet (localA0, mod TU)
  // und an dessen EIGENEN realen Umlaufgrenzen (a.cycleStarts) wiederholt -
  // nur die Reisezeit DIESES Abschnitts (dtSeg) wird für die Gegenseite
  // hinzuaddiert, nicht die kumulierte Reisezeit über den ganzen Streckenzug.
  function computeProposedBand(rows, vpKmhArray, TU, dir) {
    if (!TU || rows.length < 2) return null;
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    if (!vpKmhArray || vpKmhArray.length < ordered.length - 1) return null;
    const step = 0.25;
    const nS = Math.max(4, Math.round(TU / step));
    const ref = ordered[0];
    const tau = computeTau(ordered, vpKmhArray);
    if (!tau) return null;

    let mask = new Array(nS);
    for (let s = 0; s < nS; s++) mask[s] = inGreen(s * step, ref.an, ref.tf, TU);
    const stageMasks = [mask];
    for (let i = 1; i < ordered.length; i++) {
      const r = ordered[i];
      const prev = stageMasks[i - 1];
      const next = new Array(nS);
      for (let s = 0; s < nS; s++) {
        next[s] = prev[s] && inGreen(s * step + tau[i], r.an, r.tf, TU);
      }
      stageMasks.push(next);
    }

    const segments = [];
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1];
      const tauA = tau[i - 1], dtSeg = tau[i] - tau[i - 1];
      const runs = circularRuns(stageMasks[i - 1]).map(run => {
        const t0 = run.start * step;
        const localA0 = (((t0 + tauA) % TU) + TU) % TU;
        return { localA0, width: run.len * step };
      });
      segments.push({ a, b: ordered[i], dtSeg, runs, vp_kmh: Number(vpKmhArray[i - 1]) });
    }

    const finalRuns = circularRuns(stageMasks[stageMasks.length - 1]);
    const bandwidth = finalRuns.reduce((sum, r) => sum + r.len * step, 0);

    return { ordered, tau, segments, bandwidth };
  }

  App.coordination = {
    inGreen, greenCenter, deriveVp, teilpunktabstand, lageLabel, circularRuns,
    computeQualitativeBand, computeProposedBand
  };
})(window.App = window.App || {});
