/* Koordinierung – Zeit-Weg-Berechnung über mehrere Knoten */
(function (App) {
  'use strict';

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

  function intervalsFromSegs(segs) {
    return (segs || []).map(g => ({ start: g.start, end: g.end }));
  }

  // Überlappung eines Intervalls mit einer Liste realer Intervalle (0..n
  // Treffer - üblicherweise 0 oder 1, da reale Grünfenster eines Knotens
  // sich nicht überschneiden).
  function intersectIntervalWithList(iv, list) {
    const out = [];
    for (const L of list) {
      const s = Math.max(iv.start, L.start), e = Math.min(iv.end, L.end);
      if (e > s) out.push({ start: s, end: e });
    }
    return out;
  }

  // "Optimum"-Band: das Band, das JEDE reale Grünzeit im Streckenzug
  // durchgehend durchläuft. Statt eines periodischen (mod TU) Modells mit
  // einem einzigen Median-An/Ab-Wert je Knoten wird direkt mit den REALEN
  // Grünvorkommen jedes Knotens gerechnet: die gültigen Abfahrtsintervalle
  // am ersten Knoten werden Abschnitt für Abschnitt um die Reisezeit
  // verschoben und mit den tatsächlichen (realen) Grünfenstern des
  // nächsten Knotens geschnitten. Was übrig bleibt, ist die kumulierte
  // Menge an Intervallen, die real durchgehend Grün hatten - ohne
  // Periodizität vorauszusetzen, daher unempfindlich gegenüber realem
  // Zeitversatz/Jitter zwischen den Knoten und gegenüber Planwechseln.
  //
  // Jeder Abschnitt ist ein ECHTES Parallelogramm (konstante Breite, kein
  // Tapern) - die bis einschließlich des ABFAHRENDEN Knotens gültige
  // (kumulierte) Breite; ein Knoten mit engerer/versetzter Grünzeit
  // verengt das Band daher sichtbar als Stufe an seiner eigenen Position.
  //
  // Nebenbei liefert dieselbe Rechnung die Grundlage für die
  // Koordinationsstatistik: je Knoten, wie viele der am ersten Knoten
  // gestarteten realen Grünfenster dort noch (durchgehend) Grün antreffen
  // ("erfolgreiche"/"gescheiterte" Koordination je Station), sowie die
  // Breite (min/mittel/max) des am Ende (über den GESAMTEN Streckenzug)
  // tatsächlich durchgehenden Bandes.
  function computeOptimumBand(rows, vpKmhArray, TU, dir) {
    if (!TU || rows.length < 2) return null;
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    if (!vpKmhArray || vpKmhArray.length < ordered.length - 1) return null;
    const tau = computeTau(ordered, vpKmhArray);
    if (!tau) return null;

    let stage = intervalsFromSegs(ordered[0].greenSegs);
    const stages = [stage];
    for (let i = 1; i < ordered.length; i++) {
      const dtMs = (tau[i] - tau[i - 1]) * 1000;
      const shifted = stage.map(iv => ({ start: iv.start + dtMs, end: iv.end + dtMs }));
      const realList = intervalsFromSegs(ordered[i].greenSegs);
      const next = [];
      shifted.forEach(iv => { intersectIntervalWithList(iv, realList).forEach(r => next.push(r)); });
      stages.push(next);
      stage = next;
    }

    const widthStats = (list) => {
      const widths = list.map(iv => (iv.end - iv.start) / 1000).filter(w => w > 0);
      return widths.length
        ? { min: Math.min(...widths), max: Math.max(...widths), mean: widths.reduce((a, b) => a + b, 0) / widths.length }
        : { min: 0, max: 0, mean: 0 };
    };

    const segments = [];
    const perStation = [];
    for (let i = 1; i < ordered.length; i++) {
      const dtSeg = tau[i] - tau[i - 1];
      const runs = stages[i - 1].map(iv => ({
        frontStart: iv.start, frontEnd: iv.end,
        backStart: iv.start + dtSeg * 1000, backEnd: iv.end + dtSeg * 1000
      }));
      segments.push({ a: ordered[i - 1], b: ordered[i], dtSeg, runs, vp_kmh: Number(vpKmhArray[i - 1]) });

      const entering = stages[i - 1].length, surviving = stages[i].length;
      perStation.push({
        a: ordered[i - 1], b: ordered[i],
        entering, surviving, failed: entering - surviving,
        rate: entering ? surviving / entering : 0,
        width: widthStats(stages[i])
      });
    }

    const finalStage = stages[stages.length - 1];
    const overall = {
      totalCycles: stages[0].length,
      successCount: finalStage.length,
      failCount: stages[0].length - finalStage.length,
      rate: stages[0].length ? finalStage.length / stages[0].length : 0,
      width: widthStats(finalStage)
    };

    return { ordered, tau, segments, perStation, overall };
  }

  App.coordination = {
    greenCenter, deriveVp, teilpunktabstand, lageLabel,
    computeQualitativeBand, computeOptimumBand
  };
})(window.App = window.App || {});
