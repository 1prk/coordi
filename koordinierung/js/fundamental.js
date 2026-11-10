/* Koordinierung - EXPERIMENTAL plausibility check of the platoon model with
   the fundamental diagram of traffic flow.

   Method: a closed ring road (periodic boundary) without signals. N cars drive
   on the ring. They use exactly the speed rules of the platoon model
   (App.platoon.chooseSpeed): same acceleration profile, driver spread,
   random slowdown p, slow-to-start p0, comfort braking, vehicle length and
   standstill gap. For each density the simulation runs a warm-up and then
   measures the mean speed. The flow follows from q = k * v.
   The result is the flow-density diagram q(k) and the speed-density diagram
   v(k) of the model. The evaluation compares the diagram with reference
   values from the literature.

   Triangular fundamental diagram (theory): Q(k) = min(vf * k, w * (kj - k)).
   vf = free-flow speed, kj = jam density, w = speed of the backward wave.
   Capacity qMax = vf * kc, critical density kc = w * kj / (vf + w).

   Reference values and how well each one is founded (see REFERENCES):
   - Jam density: 1000 / spacing. The spacing comes from the assumptions
     (vehicle length, standstill gap). Plausible range 100 to 160 veh/km
     (literature examples: 120 and 150 veh/km/lane).
   - Capacity: the HCM ideal saturation flow is about 1800 veh/h/lane, that is
     a saturation headway of about 2 s. The band 1500 to 2200 veh/h is a
     plausibility range chosen here, not a published limit.
   - Wave speed: stop-and-go waves move against the traffic with 15 +- 5 km/h
     (Kerner and Rehborn; survey by Schoenhof and Helbing). Measured on
     freeways. For urban roads no verified value was found.
   - Triangular consistency: pure theory (internal check of the model).
   - Free-flow speed: the model must reach the target speed at low density
     (internal check). */
(function (App) {
  'use strict';

  const REFERENCES = {
    capacity: { lo: 1500, hi: 2200, unit: 'Fz/h', basis: 'HCM: ideale Sättigungsverkehrsstärke ca. 1800 Fz/h je Fahrstreifen (≈ 2 s Zeitlücke); Band 1500–2200 ist eine hier gewählte Plausibilitätsspanne', certainty: 'Richtwert' },
    jam: { lo: 100, hi: 160, unit: 'Fz/km', basis: 'Beispielwerte 120 und 150 Fz/km je Fahrstreifen; Long 2002: Stauabstand = Fahrzeuglänge + ca. 3,7 m', certainty: 'Richtwert' },
    wave: { lo: 10, hi: 20, unit: 'km/h', basis: 'Rückwärtswelle 15 ± 5 km/h (Kerner/Rehborn; Schönhof/Helbing) – gemessen auf Autobahnen, für Stadtstraßen nicht belegt', certainty: 'belegt (Autobahn)' },
    triangle: { lo: 0, hi: 15, unit: '%', basis: 'Dreiecksdiagramm: q_max = v_f · w · k_j / (v_f + w) – reine Theorie', certainty: 'Theorie' },
    free: { lo: 90, hi: 110, unit: '%', basis: 'Das Modell muss bei kleiner Dichte die Wunschgeschwindigkeit erreichen', certainty: 'interne Prüfung' }
  };

  // One run on the ring road with nCars cars. Returns { k [veh/km], v [km/h], q [veh/h] }.
  function ringRun(params, nCars, o) {
    const g = App.platoon.makeGrid(params);
    const rand = App.platoon.mulberry32(o.seed == null ? 1 : o.seed);
    const L = Math.round(o.ringM / g.cell);
    const N = Math.max(1, Math.round(nCars));
    const vTargetMs = Number(params.targetKmh) / 3.6;
    if (!(vTargetMs > 0)) throw new Error('Wunschgeschwindigkeit fehlt oder ist 0.');
    const vMax = Math.max(1, Math.round(vTargetMs * g.dtS / g.cell));
    const p = Math.min(1, Math.max(0, params.p)), p0 = Math.min(1, Math.max(0, params.p0));
    const sigma = Math.max(0, Number(params.sigma) || 0);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const models = [];
    for (let i = 0; i < N; i++) {
      const f = 1 + sigma * Math.max(-2, Math.min(2, gauss()));
      models.push(App.vehicle.makeAccelModel(params, vTargetMs, f));
    }
    const x = new Array(N), v = new Array(N).fill(0), nv = new Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.floor(i * L / N);
    const warm = o.warmSteps, meas = o.measSteps;
    let sumV = 0;
    for (let step = 0; step < warm + meas; step++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const raw = N === 1 ? L : (((x[j] - x[i]) % L) + L) % L;
        const gap = Math.max(0, raw - g.lenCells - g.g0Cells);
        nv[i] = App.platoon.chooseSpeed(g, v[i], models[i], vMax, gap, v[j], Infinity, p, p0, rand);
      }
      for (let i = 0; i < N; i++) { x[i] = (x[i] + nv[i]) % L; v[i] = nv[i]; if (step >= warm) sumV += nv[i]; }
    }
    const vMean = sumV / (N * meas) * g.cell / g.dtS;           // m/s
    const k = N / (L * g.cell) * 1000;                           // veh/km
    return { k, v: vMean * 3.6, q: k * vMean * 3.6 };
  }

  // Fundamental diagram of the model.
  // params: as for the platoon (p, p0, sigma, accel, accelProfile, decel,
  //         lengthM, standGapM) plus targetKmh (one number).
  // opts: { ringM (default 1500), warmSteps (250), measSteps (350), seeds (2), seed0 (1) }
  function compute(params, opts) {
    const o = { ringM: 1500, warmSteps: 250, measSteps: 350, seeds: 2, seed0: 1, ...(opts || {}) };
    const g = App.platoon.makeGrid(params);
    const L = Math.round(o.ringM / g.cell);
    const nMax = Math.floor(L / (g.lenCells + g.g0Cells));
    const fr = [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.23, 0.26, 0.30, 0.35, 0.40, 0.46, 0.52, 0.58, 0.65, 0.72, 0.80, 0.88, 0.95];
    const ns = [...new Set(fr.map(f => Math.max(1, Math.round(f * nMax))))].filter(n => n < nMax);
    const points = ns.map(n => {
      let k = 0, v = 0, q = 0;
      for (let s = 0; s < o.seeds; s++) {
        const r = ringRun(params, n, { ...o, seed: o.seed0 + s * 1009 + n });
        k = r.k; v += r.v / o.seeds; q += r.q / o.seeds;
      }
      return { k, v, q, n };
    });
    return {
      points, ringM: o.ringM, nMax, seeds: o.seeds,
      spacingM: g.spacingM, jamDensityPerKm: 1000 / g.spacingM,
      vMaxKmh: Math.max(1, Math.round(Number(params.targetKmh) / 3.6 * g.dtS / g.cell)) * g.cell / g.dtS * 3.6
    };
  }

  // Least squares line y = a + b * x.
  function fitLine(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((s, t) => s + t, 0) / n, my = ys.reduce((s, t) => s + t, 0) / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const b = sxx > 0 ? sxy / sxx : 0;
    return { a: my - b * mx, b };
  }

  // Key figures of the diagram and the comparison with the references.
  function evaluate(fd) {
    const pts = fd.points.slice().sort((a, b) => a.k - b.k);
    const qMaxPt = pts.reduce((m, p) => (p.q > m.q ? p : m), pts[0]);
    const kJ = fd.jamDensityPerKm;
    const low = pts.filter(p => p.k <= 0.12 * kJ);
    const vF = (low.length ? low : pts.slice(0, 2)).reduce((s, p) => s + p.v, 0) / (low.length || 2);
    const cong = pts.filter(p => p.k >= 1.25 * qMaxPt.k && p.k <= 0.92 * kJ);
    let w = null;
    if (cong.length >= 3) w = -fitLine(cong.map(p => p.k), cong.map(p => p.q)).b;
    const kC = qMaxPt.k, qMax = qMaxPt.q;
    let qTri = null, triErr = null;
    if (w != null && w > 0 && vF > 0) {
      const kcTri = w * kJ / (vF + w);
      qTri = vF * kcTri;
      triErr = Math.abs(qTri - qMax) / qMax * 100;
    }
    const R = REFERENCES;
    const mk = (id, label, value, ref, extra) => {
      const ok = value == null ? null : (value >= ref.lo && value <= ref.hi);
      return { id, label, value, unit: ref.unit, lo: ref.lo, hi: ref.hi, ok, basis: ref.basis, certainty: ref.certainty, ...extra };
    };
    const checks = [
      mk('capacity', 'Kapazität q_max', qMax, R.capacity, { note: `Zeitlücke bei Kapazität ${(3600 / qMax).toFixed(2)} s bei ${kC.toFixed(0)} Fz/km` }),
      mk('jam', 'Staudichte k_j (aus dem Fahrzeugabstand)', kJ, R.jam, { note: `Abstand ${fd.spacingM.toFixed(1)} m` }),
      mk('wave', 'Rückwärts-Wellengeschwindigkeit w', w, R.wave, { note: w == null ? 'zu wenige Punkte im gestauten Ast' : 'Steigung des gestauten Astes' }),
      mk('triangle', 'Abweichung vom Dreiecksdiagramm', triErr, R.triangle, { note: qTri == null ? '' : `q_Dreieck ${qTri.toFixed(0)} Fz/h` }),
      mk('free', 'Freie Geschwindigkeit / Wunsch', vF / fd.vMaxKmh * 100, R.free, { note: `${vF.toFixed(1)} km/h bei kleiner Dichte` })
    ];
    return { qMax, kC, vF, w, kJ, qTri, checks, passed: checks.filter(c => c.ok === true).length, failed: checks.filter(c => c.ok === false).length };
  }

  // Sensitivity of the key figures to the standstill gap (the distance
  // assumption). One row for each gap [m]. The spacing front to front is the
  // vehicle length plus the gap.
  function sensitivity(params, gapsM, opts) {
    return gapsM.map(gap => {
      const fd = compute({ ...params, standGapM: gap }, { seeds: 1, ...(opts || {}) });
      const ev = evaluate(fd);
      return { standGapM: gap, spacingM: fd.spacingM, kJ: fd.jamDensityPerKm, qMax: ev.qMax, kC: ev.kC, w: ev.w, passed: ev.passed, failed: ev.failed };
    });
  }

  App.fundamental = { ringRun, compute, evaluate, sensitivity, fitLine, REFERENCES };
})(window.App = window.App || {});
