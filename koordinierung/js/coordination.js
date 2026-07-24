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

  // "Optimum"-Band: EINE feste Breite für den GESAMTEN Streckenzug - die
  // schmalste Grünzeit unter allen durchfahrenen Knoten (der Engpass, das
  // Minimum, das ein Fahrzeug durch JEDEN Knoten hindurch nutzen kann).
  // Nicht abschnittsweise verengt/gestuft, sondern konstant über alle
  // Abschnitte hinweg. Gerechnet im 1-Sekunden-Raster (kleinste Einheit),
  // passend zur Auflösung der realen Signaldaten (An/Ab/TF sind immer
  // ganzzahlige Sekunden) - auch die Reisezeit je Abschnitt wird dafür auf
  // ganze Sekunden gerundet.
  //
  // Statt eines periodischen (mod TU) Modells mit einem Median-An/Ab-Wert
  // wird mit den REALEN Grünvorkommen jedes Knotens gerechnet: je Knoten
  // wird zunächst das gültige Startzeitfenster ermittelt, in dem ein
  // minTf-breites Fenster überhaupt in dieses reale Grünvorkommen passt
  // (Vorkommen kürzer als minTf liefert kein gültiges Startfenster). Diese
  // Startzeitfenster werden - wie zuvor - Abschnitt für Abschnitt um die
  // (gerundete) Reisezeit verschoben und mit denen des nächsten Knotens
  // geschnitten. Übrig bleiben die Startzeitpunkte, an denen ein
  // minTf-breites Fenster real durchgehend Grün hätte - ohne Periodizität
  // vorauszusetzen, daher unempfindlich gegenüber realem Zeitversatz/
  // Jitter zwischen den Knoten und gegenüber Planwechseln.
  //
  // Nebenbei liefert dieselbe Rechnung die Grundlage für die
  // Koordinationsstatistik: je Knoten, wie viele der am ersten Knoten
  // gestarteten Startfenster dort noch gültig sind ("erfolgreiche"/
  // "gescheiterte" Koordination je Station).
  function computeOptimumBand(rows, vpKmhArray, TU, dir) {
    if (!TU || rows.length < 2) return null;
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    if (!vpKmhArray || vpKmhArray.length < ordered.length - 1) return null;
    const tauRaw = computeTau(ordered, vpKmhArray);
    if (!tauRaw) return null;
    // Reisezeit je Abschnitt auf ganze Sekunden gerundet (1s-Schrittweite).
    const tau = [0];
    for (let i = 1; i < ordered.length; i++) tau.push(tau[i - 1] + Math.round(tauRaw[i] - tauRaw[i - 1]));

    // Engpass: die schmalste Grünzeit unter allen Knoten im Streckenzug -
    // diese (und nur diese) Breite gilt für das ganze Band.
    const minTf = Math.min(...ordered.map(r => r.tf));
    if (!(minTf > 0)) return null;

    // Gültiges Startzeitfenster je realem Grünvorkommen: [g.start, g.end -
    // minTf], d. h. alle Zeitpunkte, an denen ein minTf-breites Fenster
    // noch vollständig in dieses Vorkommen passt. Vorkommen kürzer als
    // minTf liefern kein gültiges Fenster (fallen komplett weg).
    function validStartsFor(node) {
      return (node.greenSegs || [])
        .filter(g => Math.round((g.end - g.start) / 1000) >= minTf)
        .map(g => ({ start: g.start, end: g.end - minTf * 1000, segStart: g.start, segEnd: g.end }));
    }

    let stage = validStartsFor(ordered[0]).map((iv, idx) => ({ ...iv, origin: idx }));
    const stages = [stage];
    for (let i = 1; i < ordered.length; i++) {
      const dtMs = (tau[i] - tau[i - 1]) * 1000;
      const shifted = stage.map(iv => ({ start: iv.start + dtMs, end: iv.end + dtMs, origin: iv.origin }));
      const nodeValid = validStartsFor(ordered[i]);
      const next = [];
      shifted.forEach(iv => { intersectIntervalWithList(iv, nodeValid).forEach(r => next.push({ ...r, origin: iv.origin })); });
      stages.push(next);
      stage = next;
    }

    // Je Abschnitt EIN minTf-breites Fenster pro noch gültigem Startfenster
    // (verankert am frühestmöglichen Startzeitpunkt darin) - überall
    // dieselbe (konstante) Breite minTf, kein Tapern/Verengen.
    const segments = [];
    const perStation = [];
    for (let i = 1; i < ordered.length; i++) {
      const tauA = tau[i - 1], tauB = tau[i];
      const runs = stages[i - 1].map(iv => {
        const frontStart = iv.start + tauA * 1000, frontEnd = frontStart + minTf * 1000;
        const backStart = iv.start + tauB * 1000, backEnd = backStart + minTf * 1000;
        return { frontStart, frontEnd, backStart, backEnd };
      });
      segments.push({ a: ordered[i - 1], b: ordered[i], runs, vp_kmh: Number(vpKmhArray[i - 1]) });

      const entering = stages[i - 1].length, surviving = stages[i].length;
      perStation.push({
        a: ordered[i - 1], b: ordered[i],
        entering, surviving, failed: entering - surviving,
        rate: entering ? surviving / entering : 0
      });
    }

    const finalStage = stages[stages.length - 1];
    const overall = {
      totalCycles: stages[0].length,
      successCount: finalStage.length,
      failCount: stages[0].length - finalStage.length,
      rate: stages[0].length ? finalStage.length / stages[0].length : 0,
      bandwidth: minTf
    };

    // Je Ursprungs-Umlauf (reales Grünfenster am ersten Knoten) der
    // Ausgang über den ganzen Streckenzug - Basis für die "Sprung"-Tabelle:
    // erfolgreich (durchgehend bis zum letzten Knoten) oder gescheitert
    // (mit Angabe, an welchem Knoten es zuerst nicht mehr passte).
    const cycles = stages[0].map(start0 => {
      let survivedIdx = 0;
      for (let s = 1; s < stages.length; s++) {
        const found = stages[s].find(iv => iv.origin === start0.origin);
        if (!found) break;
        survivedIdx = s;
      }
      const success = survivedIdx === stages.length - 1;
      return {
        start: start0.segStart, end: start0.segEnd,
        success,
        failedAt: success ? null : ordered[survivedIdx + 1],
        finalWidth: success ? minTf : null
      };
    });

    return { ordered, tau, minTf, segments, perStation, overall, cycles };
  }

  App.coordination = {
    greenCenter, deriveVp, teilpunktabstand, lageLabel,
    computeQualitativeBand, computeOptimumBand
  };
})(window.App = window.App || {});
