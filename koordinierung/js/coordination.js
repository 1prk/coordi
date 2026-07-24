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

  App.coordination = { inGreen, greenCenter, deriveVp, teilpunktabstand, lageLabel };
})(window.App = window.App || {});
