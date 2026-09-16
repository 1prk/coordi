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
  // sich nicht überschneiden). minWidthMs (Default 0) legt fest, wie breit
  // der Schnitt mindestens sein muss, um als Treffer zu zählen: 0 erlaubt
  // auch ein auf einen einzigen Zeitpunkt zusammengefallenes Intervall
  // (Breite 0) als Treffer - sinnvoll für ein reines Start-ZEITFENSTER
  // (das selbst schon eine vorgegebene Breite trägt, siehe minTf weiter
  // unten). Wird dagegen die reale grüne Breite selbst geschnitten (siehe
  // realStages unten), ist ein 0-Sekunden-Schnitt KEIN real durchfahrbares
  // Grün, sondern nur ein Berührpunkt zweier Intervallgrenzen (meist ein
  // Rundungsartefakt der auf ganze Sekunden gerundeten Reisezeit) - dafür
  // wird minWidthMs > 0 übergeben.
  function intersectIntervalWithList(iv, list, minWidthMs) {
    const minW = minWidthMs || 0;
    const out = [];
    for (const L of list) {
      const s = Math.max(iv.start, L.start), e = Math.min(iv.end, L.end);
      if (e - s >= minW) out.push({ start: s, end: e });
    }
    return out;
  }

  // "Optimum"-Band: die tatsächlich real durchfahrbare Bandbreite je Umlauf,
  // ermittelt durch Verschieben und Schneiden der REALEN Grünvorkommen jedes
  // Knotens (keine periodische mod-TU-Modellannahme). Je Knoten wird die
  // (um die kumulierte, auf ganze Sekunden gerundete Reisezeit verschobene)
  // Breite des Vorknotens mit der realen Grünzeit dieses Knotens geschnitten;
  // die Breite darf dabei an jedem Übergang schrumpfen - anders als in einer
  // früheren Fassung wird KEINE global konstante Breite (der Engpass minTf,
  // die schmalste Plan-Grünzeit im Streckenzug) vorausgesetzt. Ein Umlauf
  // gilt als "Durchfahrt", sobald am Ende ein nicht-leeres reales Grünfenster
  // übrig bleibt - unabhängig davon, ob es so breit wie der Engpass ist. Ein
  // schmaleres, aber real durchgehendes Band ist eine ebenso echte
  // Durchfahrt wie ein minTf-breites.
  //
  // REAL_MIN_WIDTH_MS erzwingt dabei mindestens 1 volle Sekunde realen
  // Überlapp: ein auf 0s (exakte Kantenberührung zweier Intervalle)
  // zusammengeschnittenes "Fenster" ist kein real durchfahrbares Grün,
  // sondern typischerweise ein Rundungsartefakt der auf ganze Sekunden
  // gerundeten Reisezeit - das zählt daher als gescheitert, nicht als
  // (unsinnig "0 Sekunden breite") erfolgreiche Durchfahrt.
  //
  // minTf (schmalste PLAN-Grünzeit im Streckenzug) bleibt als informativer
  // Kennwert ("Engpass-Bandbreite") erhalten, bestimmt aber nicht mehr, ob
  // oder wie breit ein Umlauf gezeichnet/gezählt wird.
  const REAL_MIN_WIDTH_MS = 1000;

  function computeOptimumBand(rows, vpKmhArray, TU, dir) {
    if (!TU || rows.length < 2) return null;
    const ordered = dir === 'fwd' ? rows : rows.slice().reverse();
    if (!vpKmhArray || vpKmhArray.length < ordered.length - 1) return null;
    const tauRaw = computeTau(ordered, vpKmhArray);
    if (!tauRaw) return null;
    // Reisezeit je Abschnitt auf ganze Sekunden gerundet (1s-Schrittweite,
    // passend zur Auflösung der realen Signaldaten - An/Ab/TF sind immer
    // ganzzahlige Sekunden).
    const tau = [0];
    for (let i = 1; i < ordered.length; i++) tau.push(tau[i - 1] + Math.round(tauRaw[i] - tauRaw[i - 1]));

    // Engpass: die schmalste PLAN-Grünzeit unter allen Knoten im
    // Streckenzug - rein informativer Kennwert (overall.bandwidth), siehe
    // Funktionskommentar oben.
    const minTf = Math.min(...ordered.map(r => r.tf));
    if (!(minTf > 0)) return null;

    function realIntervalsFor(node) {
      return (node.greenSegs || []).map(g => ({ start: g.start, end: g.end, segStart: g.start, segEnd: g.end }));
    }
    let realStage = realIntervalsFor(ordered[0]).map((iv, idx) => ({ ...iv, origin: idx }));
    const realStages = [realStage];
    for (let i = 1; i < ordered.length; i++) {
      const dtMs = (tau[i] - tau[i - 1]) * 1000;
      const shifted = realStage.map(iv => ({ start: iv.start + dtMs, end: iv.end + dtMs, origin: iv.origin }));
      const nodeReal = realIntervalsFor(ordered[i]);
      const next = [];
      shifted.forEach(iv => { intersectIntervalWithList(iv, nodeReal, REAL_MIN_WIDTH_MS).forEach(r => next.push({ ...r, origin: iv.origin })); });
      realStages.push(next);
      realStage = next;
    }
    const realFinalStage = realStages[realStages.length - 1];
    const widthsOf = (list) => list.map(iv => Math.round((iv.end - iv.start) / 1000));
    // 5-Zahlen-Zusammenfassung (min/Q1/Median/Q3/max) + Mittelwert der real
    // durchgehenden Breiten einer Stufe - Grundlage für den Mini-Boxplot in
    // der Koordinationsstatistik (siehe app.js renderStats). Lineare
    // Interpolation zwischen den beiden umgebenden Werten (wie
    // numpy/Excel PERCENTILE.INC) - für eine "Mini"-Visualisierung reicht
    // das, ohne eigene Ausreißer-Regel (kein Fence/Whisker-Cutoff nötig,
    // die Whisker reichen bewusst bis min/max).
    function quantile(sorted, q) {
      const pos = (sorted.length - 1) * q;
      const base = Math.floor(pos), rest = pos - base;
      return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
    }
    const widthStats = (list) => {
      const w = widthsOf(list).sort((a, b) => a - b);
      if (!w.length) return { n: 0, widthMin: null, widthQ1: null, widthMedian: null, widthQ3: null, widthMax: null, widthAvg: null };
      return {
        n: w.length,
        widthMin: w[0], widthMax: w[w.length - 1],
        widthQ1: quantile(w, 0.25), widthMedian: quantile(w, 0.5), widthQ3: quantile(w, 0.75),
        widthAvg: w.reduce((a, b) => a + b, 0) / w.length
      };
    };

    const overall = {
      totalCycles: realStages[0].length,
      successCount: realFinalStage.length,
      failCount: realStages[0].length - realFinalStage.length,
      rate: realStages[0].length ? realFinalStage.length / realStages[0].length : 0,
      bandwidth: minTf,
      ...widthStats(realFinalStage)
    };

    // Gezeichnetes Band je erfolgreichem Umlauf: verankert an der
    // tatsächlich bis zum letzten Knoten überlebenden realen Breite dieses
    // Umlaufs (NICHT mehr am globalen Engpass minTf) - zurückgerechnet auf
    // den Nullpunkt (abzüglich der gesamten Reisezeit) und nur um die
    // kumulierte Reisezeit je Knoten verschoben, dieselbe (konstante)
    // Breite an jedem Abschnitt. Das ist weiterhin an JEDER Zwischenstation
    // gültig, weil Schnittmengen nur enger werden können (die am Ende
    // überlebende Breite ist also an jedem vorherigen Knoten ebenfalls
    // innerhalb des realen Grüns) - siehe assertWithinRealGreen() unten.
    // Anders als zuvor ist die Breite NICHT mehr für alle Umläufe eines
    // Streckenzugs identisch, sondern je Umlauf seine eigene real erreichte
    // (ggf. schmalere) Breite.
    const tauLastMs = tau[tau.length - 1] * 1000;
    const survivorAnchors = realFinalStage.map(iv => ({
      origin: iv.origin,
      s0: iv.start - tauLastMs,
      widthMs: iv.end - iv.start
    }));

    if (typeof console !== 'undefined' && console.debug) {
      const bottleneckNode = ordered.find(r => r.tf === minTf);
      console.debug(`[Optimum] Engpass-Bandbreite (Plan-TF) minTf=${minTf}s (${bottleneckNode ? bottleneckNode.name : '?'}), real erfolgreiche Umläufe: ${overall.successCount}/${overall.totalCycles} für Streckenzug ${ordered.map(r => r.name).join(' -> ')}`);
    }

    // Laufzeit-Assert: jedes gezeichnete Fenster MUSS innerhalb eines realen
    // Grünsegments der jeweiligen Station liegen (per Konstruktion, s.o.).
    // Verletzung wird mit Knoten und Zeitstempel geloggt, damit sich eine
    // trotzdem auftretende Abweichung (z. B. ein Rundungs-/
    // Umlaufgrenzen-Sonderfall) in Sekunden statt durch Rätselraten
    // lokalisieren lässt.
    function assertWithinRealGreen(node, start, end, label) {
      const ok = (node.greenSegs || []).some(g => start >= g.start && end <= g.end);
      if (!ok && typeof console !== 'undefined') {
        console.warn(
          `[Optimum] AUSSERHALB der realen Freigabezeit an ${node.name} (${label}): ` +
          `Band [${new Date(start).toISOString()} – ${new Date(end).toISOString()}] ` +
          `liegt in KEINEM realen Grünsegment dieses Knotens.`
        );
      }
      return ok;
    }

    const segments = [];
    const perStation = [];
    for (let i = 1; i < ordered.length; i++) {
      const tauA = tau[i - 1], tauB = tau[i];
      const runs = survivorAnchors.map(a => {
        const frontStart = a.s0 + tauA * 1000, frontEnd = frontStart + a.widthMs;
        const backStart = a.s0 + tauB * 1000, backEnd = backStart + a.widthMs;
        return { frontStart, frontEnd, backStart, backEnd };
      });
      runs.forEach(run => {
        assertWithinRealGreen(ordered[i - 1], run.frontStart, run.frontEnd, 'Startseite');
        assertWithinRealGreen(ordered[i], run.backStart, run.backEnd, 'Zielseite');
      });

      segments.push({ a: ordered[i - 1], b: ordered[i], runs, vp_kmh: Number(vpKmhArray[i - 1]) });

      const entering = realStages[i - 1].length, surviving = realStages[i].length;
      perStation.push({
        a: ordered[i - 1], b: ordered[i],
        entering, surviving, failed: entering - surviving,
        rate: entering ? surviving / entering : 0,
        ...widthStats(realStages[i])
      });
    }

    // Je Ursprungs-Umlauf (reales Grünfenster am ersten Knoten) der
    // Ausgang über den ganzen Streckenzug - Basis für die "Sprung"-Tabelle:
    // erfolgreich (durchgehend bis zum letzten Knoten) oder gescheitert
    // (mit Angabe, an welchem Knoten es zuerst nicht mehr passte).
    // survivedIdx zählt zugleich die "Durchfahrten" dieses Umlaufs im Sinne
    // des Koordinierungsmaßes (siehe computeKoordinierungsmass): die Anzahl
    // der Knoten-Übergänge (von N_K,LSA - 1 möglichen), die ohne Halt
    // passiert wurden - 0, wenn schon der erste Folgeknoten nicht erreicht
    // wurde, bis maximal realStages.length - 1 (= ordered.length - 1) bei
    // vollständiger Durchfahrt.
    // stations: je Umlauf UND je Folgeknoten (nicht nur der Gesamtausgang)
    // erreicht/Breite - Grundlage für den "je LSA"-Export der
    // Umlaufübersicht (siehe app.js exportUmlaufXlsx). Einmal durch alle
    // Stufen gelaufen (kein Abbruch bei der ersten gescheiterten Station),
    // da spätere Stufen für einen dort bereits ausgeschiedenen Umlauf
    // ohnehin nie einen Treffer enthalten (realStages führt nur Origins
    // fort, die die vorherige Stufe überlebt haben) - .find() liefert dort
    // also von selbst "nicht erreicht".
    const cycles = realStages[0].map(start0 => {
      let survivedIdx = 0;
      let lastWidth = null;
      const stations = [];
      for (let s = 1; s < realStages.length; s++) {
        const found = realStages[s].find(iv => iv.origin === start0.origin);
        const width = found ? Math.round((found.end - found.start) / 1000) : null;
        stations.push({ node: ordered[s], reached: !!found, width });
        if (found) { survivedIdx = s; lastWidth = width; }
      }
      const success = survivedIdx === realStages.length - 1;
      return {
        start: start0.segStart, end: start0.segEnd,
        success,
        failedAt: success ? null : ordered[survivedIdx + 1],
        finalWidth: success ? lastWidth : null,
        durchfahrten: survivedIdx,
        stations
      };
    });

    return { ordered, tau, minTf, segments, perStation, overall, cycles };
  }

  // Koordinierungsmaß k [%]: der mittlere Anteil der Knotenpunkte mit LSA in
  // der koordinierten Folge, die im koordinierten Verkehrsstrom ohne Halt
  // passiert werden - nach Zeitraum eingegrenzt (z. B. Spitzenstunde), da
  // die App mit durchgehenden Aufzeichnungen statt einzelner Messfahrten
  // arbeitet: jeder reale Umlauf (cycle) aus computeOptimumBand, dessen
  // Start in [fromMin, toMin) liegt, zählt als eine Messfahrt.
  //   k = D_i / ((N_K,LSA - 1) * n) * 100
  // D_i = Summe der Durchfahrten (cycle.durchfahrten) über alle Messfahrten,
  // N_K,LSA = Anzahl Knoten im Koordinierungszug, n = Anzahl Messfahrten im
  // Zeitband. fromMin/toMin sind Minuten seit Mitternacht (0-1439); toMin <=
  // fromMin wird als über Mitternacht laufendes Band interpretiert.
  function computeKoordinierungsmass(cycles, totalKnoten, fromMin, toMin) {
    if (!cycles || totalKnoten < 2) return { n: 0 };
    const inBand = (ms) => {
      const d = new Date(ms);
      const mins = d.getHours() * 60 + d.getMinutes();
      return fromMin <= toMin ? (mins >= fromMin && mins < toMin) : (mins >= fromMin || mins < toMin);
    };
    const runs = cycles.filter(c => inBand(c.start));
    const n = runs.length;
    if (!n) return { n: 0 };
    const sumDurchfahrten = runs.reduce((a, c) => a + c.durchfahrten, 0);
    const pct = (sumDurchfahrten / ((totalKnoten - 1) * n)) * 100;
    return { n, sumDurchfahrten, totalKnoten, pct };
  }

  // Gütestufe (Qualitätsstufe) nach Koordinierungsmaß.
  function koordinierungsmassLos(pct) {
    if (pct >= 95) return { label: 'sehr gut', cls: 'stat-ok' };
    if (pct >= 85) return { label: 'gut', cls: 'stat-ok' };
    if (pct >= 75) return { label: 'mittel', cls: 'stat-warn' };
    if (pct >= 65) return { label: 'mäßig', cls: 'stat-bad' };
    return { label: 'unwirksam', cls: 'stat-bad' };
  }

  App.coordination = {
    greenCenter, deriveVp, teilpunktabstand, lageLabel,
    computeQualitativeBand, computeOptimumBand,
    computeKoordinierungsmass, koordinierungsmassLos
  };
})(window.App = window.App || {});
