/* Koordinierung - vehicle simulation.
   One vehicle drives through the signalized corridor. The module has no DOM
   access. All distances are in meters, all speeds in m/s, all accelerations
   in m/s2. Times that leave this module are absolute milliseconds (the same
   scale as the diagram). Times inside the module are seconds since the
   start time (tOrigin).

   Vehicle model:
   1. The vehicle stands at the stop line of the start node.
   2. It waits for the start-up lost time after the green start.
   3. It accelerates to the target speed (see "Acceleration models").
   4. It keeps the target speed until the next stop line.
   5. At each next node it checks the real green windows of that node.
      - Arrival in green: the vehicle drives through without a stop.
      - Arrival in red: the vehicle brakes with a constant deceleration,
        stops at the stop line, waits for the next real green, and starts
        again (step 2).
   The vehicle is alone on the road. There is no queue and no other vehicle.

   Acceleration models (params.accelProfile):
   - 'constant': a(v) = a. The old model. Speed changes abruptly at the end.
   - 'linear': a(v) = a0 * (1 - v / vl). The acceleration is highest at
     standstill and falls linearly with the speed. vl is the speed at which
     the acceleration would be zero. This is the "linearly decreasing"
     model (Drew 1968; Long 2000, Transportation Research Record 1737, who
     found it fits vehicle capability and driver behavior better than a
     constant rate).
   The user gives the MEAN acceleration "a" from standstill to the highest
   target speed. The module computes a0 and vl from it. The ratio
   a(target) / a0 is ACCEL_RATIO_AT_TARGET. This ratio is an assumption: the
   literature search found no verified value for passenger cars. */
(function (App) {
  'use strict';

  const EPS = 1e-9;
  const KMH_TO_MS = 1 / 3.6;
  const ACCEL_RATIO_AT_TARGET = 0.5;
  // Firm braking for a stop at a signal (ITE, NCHRP 731: 10 ft/s2). The lead
  // uses it, if the comfort deceleration cannot stop it in the section.
  const MAX_DECEL_MS2 = 3.05;

  /* ---------------- Acceleration models ---------------- */

  // Model object. kind 'const': { kind, a }. kind 'linear': { kind, a0, vl }.
  // factor scales the acceleration (driver factor, 1 = nominal driver).
  function makeAccelModel(params, vTargetMax, factor) {
    const f = factor > 0 ? factor : 1;
    const mean = params.accel;
    if (params.accelProfile !== 'linear') return { kind: 'const', a: mean * f, mean };
    const r = ACCEL_RATIO_AT_TARGET;
    // Mean acceleration from 0 to the target: a0 * (1 - r) / ln(1 / r).
    const a0 = mean * Math.log(1 / r) / (1 - r) * f;
    return { kind: 'linear', a0, vl: vTargetMax / (1 - r), mean, r };
  }

  function accelAt(m, v) {
    return m.kind === 'const' ? m.a : Math.max(0, m.a0 * (1 - v / m.vl));
  }

  // Distance needed to accelerate from v0 to v1 (v1 >= v0).
  function accelDist(m, v0, v1) {
    if (m.kind === 'const') return (v1 * v1 - v0 * v0) / (2 * m.a);
    return (m.vl / m.a0) * ((v0 - v1) + m.vl * Math.log((m.vl - v0) / (m.vl - v1)));
  }

  // Time needed to accelerate from v0 to v1 (v1 >= v0).
  function accelTime(m, v0, v1) {
    if (m.kind === 'const') return (v1 - v0) / m.a;
    return (m.vl / m.a0) * Math.log((m.vl - v0) / (m.vl - v1));
  }

  // Speed after the distance L, if the vehicle accelerates from v0 (not more
  // than vCap). The distance grows with the speed, so bisection works.
  function accelSpeedAtDist(m, v0, L, vCap) {
    if (m.kind === 'const') return Math.min(vCap, Math.sqrt(v0 * v0 + 2 * m.a * L));
    let lo = v0, hi = vCap;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (accelDist(m, v0, mid) < L) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------------- Motion phases ---------------- */

  // A phase of acceleration from v0 to v1 with the model m.
  function accelPhase(m, v0, v1) {
    const ph = { kind: 'accel', dt: accelTime(m, v0, v1), ds: accelDist(m, v0, v1), v0, v1, a: accelAt(m, v0) };
    if (m.kind === 'linear') ph.lin = { a0: m.a0, vl: m.vl };
    return ph;
  }

  // A phase of braking with the constant deceleration b (positive number).
  function brakePhase(v0, v1, b) {
    return { kind: 'brake', dt: (v0 - v1) / b, ds: (v0 * v0 - v1 * v1) / (2 * b), v0, v1, a: -b };
  }

  // A phase with a constant speed over the distance ds.
  function cruise(v, ds) {
    return { kind: 'cruise', dt: ds / v, ds, v0: v, v1: v, a: 0 };
  }

  // State inside a phase, tr seconds after the start of the phase.
  // Returns { v, s (meters since the start of the phase), a }.
  function evalPhase(ph, tr) {
    if (ph.lin) {
      const lam = ph.lin.a0 / ph.lin.vl;
      const e = Math.exp(-lam * tr);
      const v = ph.lin.vl - (ph.lin.vl - ph.v0) * e;
      return { v, s: ph.lin.vl * tr - (ph.lin.vl - ph.v0) * (1 - e) / lam, a: ph.lin.a0 * (1 - v / ph.lin.vl) };
    }
    return { v: ph.v0 + ph.a * tr, s: ph.v0 * tr + 0.5 * ph.a * tr * tr, a: ph.a };
  }

  // Motion phases for one section.
  // v0: speed at the start of the section. L: section length.
  // vt: target speed. accel: acceleration model (or a number = constant
  // acceleration). b: deceleration (positive number).
  // stopAtEnd: true = the vehicle must stand still at the end of the section.
  // Returns { phases, vEnd, dt }. Returns null if the vehicle cannot stop
  // within the length L.
  function sectionProfile(v0, L, vt, accel, b, stopAtEnd) {
    const m = typeof accel === 'number' ? { kind: 'const', a: accel } : accel;
    const phases = [];
    if (!stopAtEnd) {
      if (v0 <= vt) {
        const dAcc = accelDist(m, v0, vt);
        if (dAcc >= L) {
          const v1 = accelSpeedAtDist(m, v0, L, vt);
          const ph = accelPhase(m, v0, v1);
          ph.ds = L;
          phases.push(ph);
        } else {
          if (dAcc > EPS) phases.push(accelPhase(m, v0, vt));
          phases.push(cruise(vt, L - dAcc));
        }
      } else {
        const dDec = (v0 * v0 - vt * vt) / (2 * b);
        if (dDec >= L) {
          phases.push(brakePhase(v0, Math.sqrt(Math.max(0, v0 * v0 - 2 * b * L)), b));
        } else {
          phases.push(brakePhase(v0, vt, b));
          phases.push(cruise(vt, L - dDec));
        }
      }
    } else {
      if (v0 * v0 / (2 * b) > L + 1e-6) return null;
      if (v0 >= vt) {
        let used = 0;
        if (v0 > vt + EPS) { phases.push(brakePhase(v0, vt, b)); used = (v0 * v0 - vt * vt) / (2 * b); }
        const rest = L - used - vt * vt / (2 * b);
        if (rest > EPS) phases.push(cruise(vt, rest));
        phases.push(brakePhase(vt, 0, b));
      } else if (accelDist(m, v0, vt) + vt * vt / (2 * b) <= L) {
        phases.push(accelPhase(m, v0, vt));
        const rest = L - accelDist(m, v0, vt) - vt * vt / (2 * b);
        if (rest > EPS) phases.push(cruise(vt, rest));
        phases.push(brakePhase(vt, 0, b));
      } else {
        // The target speed is not reached: accelerate to a peak speed, then brake.
        // The total distance grows with the peak speed, so bisection works.
        let lo = v0, hi = vt;
        for (let i = 0; i < 100; i++) {
          const mid = (lo + hi) / 2;
          if (accelDist(m, v0, mid) + mid * mid / (2 * b) < L) lo = mid; else hi = mid;
        }
        const vPeak = (lo + hi) / 2;
        if (vPeak - v0 > EPS) phases.push(accelPhase(m, v0, vPeak));
        phases.push(brakePhase(vPeak, 0, b));
      }
    }
    const last = phases[phases.length - 1];
    return { phases, vEnd: last.v1, dt: phases.reduce((s, p) => s + p.dt, 0) };
  }

  // The green window of a node that contains the time tMs.
  // tolMs extends the end of each window (yellow tolerance).
  function greenAt(greens, tMs, tolMs) {
    for (const g of greens) {
      if (tMs >= g.start && tMs <= g.end + tolMs) return g;
      if (g.start > tMs) break;
    }
    return null;
  }

  // The first green window that is not over at the time tMs.
  function nextGreen(greens, tMs) {
    for (const g of greens) if (g.end > tMs) return g;
    return null;
  }

  function checkParams(p) {
    if (!(p.accel > 0)) throw new Error('Beschleunigung muss größer 0 sein.');
    if (!(p.decel > 0)) throw new Error('Verzögerung muss größer 0 sein.');
  }

  // input:
  //   nodes: nodes in driving order. Each node: { name, station, greenSegs }.
  //          greenSegs: real green windows [{ start, end }] in ms.
  //   startIdx: index of the start node (the vehicle starts at its stop line).
  //   tGreenStart: start (ms) of the green window in which the vehicle starts.
  //   params: { accel (mean acceleration), accelProfile ('linear' | 'constant',
  //             default 'constant'), accelFactor (default 1), decel,
  //             lostTimeS, yellowTolS, targetKmh }
  //           targetKmh: one number, or one number per section
  //           (section j = node j to node j+1).
  //   freeFlow: true = ignore all signals (used for the reference time).
  function simulate(input) {
    const { nodes, startIdx, tGreenStart, params } = input;
    const freeFlow = !!input.freeFlow;
    checkParams(params);
    const N = nodes.length;
    if (!(startIdx >= 0 && startIdx < N - 1)) throw new Error('Der Startknoten braucht mindestens einen Folgeknoten.');
    const b = params.decel;
    const lostS = Math.max(0, Number(params.lostTimeS) || 0);
    const tolMs = Math.max(0, Number(params.yellowTolS) || 0) * 1000;
    const target = (j) => {
      const raw = Array.isArray(params.targetKmh) ? params.targetKmh[j] : params.targetKmh;
      const v = Number(raw) * KMH_TO_MS;
      if (!(v > 0)) throw new Error(`Wunschgeschwindigkeit fehlt oder ist 0 (Abschnitt ${j + 1}).`);
      return v;
    };
    let vTargetMax = 0;
    for (let j = startIdx; j < N - 1; j++) vTargetMax = Math.max(vTargetMax, target(j));
    const model = makeAccelModel(params, vTargetMax, params.accelFactor);
    const greens = nodes.map(n => (n.greenSegs || []).slice().sort((x, y) => x.start - y.start));
    const tOrigin = tGreenStart;
    const sign = nodes[startIdx + 1].station >= nodes[startIdx].station ? 1 : -1;
    const station0 = nodes[startIdx].station;

    const phases = [];
    const events = [];
    const warnings = [];
    let ended = null;
    let tS = 0, sAlong = 0, v = 0;

    const addPhase = (p, extra) => {
      const ph = { ...p, t0: tS, t1: tS + p.dt, s0: sAlong, s1: sAlong + p.ds, ...extra };
      phases.push(ph);
      tS = ph.t1; sAlong = ph.s1;
    };
    const wait = (untilS, initial) => {
      if (untilS - tS > EPS) addPhase({ kind: 'wait', dt: untilS - tS, ds: 0, v0: 0, v1: 0, a: 0 }, { initial: !!initial });
    };

    wait(lostS, true);
    const tDepartS = tS;

    for (let j = startIdx; j < N - 1; j++) {
      const L = Math.abs(nodes[j + 1].station - nodes[j].station);
      const next = nodes[j + 1];
      const isLast = j + 1 === N - 1;
      if (L < 1e-9) {
        events.push({ idx: j + 1, name: next.name, station: next.station, tArrive: tOrigin + tS * 1000, vArrive: v, passed: true, stopped: false, greenMarginS: null, sinceGreenS: null });
        continue;
      }
      const vt = target(j);
      const free = sectionProfile(v, L, vt, model, b, false);
      const tArrS = tS + free.dt;
      const tArrMs = tOrigin + tArrS * 1000;
      const win = freeFlow ? null : greenAt(greens[j + 1], tArrMs, tolMs);

      if (freeFlow || win) {
        free.phases.forEach(p => addPhase(p));
        v = free.vEnd;
        events.push({
          idx: j + 1, name: next.name, station: next.station, tArrive: tArrMs, vArrive: v, passed: true, stopped: false,
          greenMarginS: win ? (win.end - tArrMs) / 1000 : null,
          sinceGreenS: win ? (tArrMs - win.start) / 1000 : null
        });
        continue;
      }

      let stop = sectionProfile(v, L, vt, model, b, true);
      let firm = false;
      if (!stop) { stop = sectionProfile(v, L, vt, model, Math.max(b, MAX_DECEL_MS2), true); firm = !!stop; }
      if (!stop) {
        warnings.push(`${next.name}: Das Fahrzeug kann bei Rot nicht mehr anhalten (zu kurzer Abschnitt) und fährt durch.`);
        free.phases.forEach(p => addPhase(p));
        v = free.vEnd;
        events.push({ idx: j + 1, name: next.name, station: next.station, tArrive: tArrMs, vArrive: v, passed: true, stopped: false, redRun: true, greenMarginS: null, sinceGreenS: null });
        continue;
      }
      stop.phases.forEach(p => addPhase(p));
      v = 0;
      const tStopMs = tOrigin + tS * 1000;
      const ev = { idx: j + 1, name: next.name, station: next.station, tArrive: tStopMs, vArrive: 0, passed: false, stopped: true, firm, greenMarginS: null, sinceGreenS: null };
      events.push(ev);
      // The simulation ends when the vehicle reaches the last stop line.
      if (isLast) { ev.endsHere = true; break; }
      const g = nextGreen(greens[j + 1], tStopMs);
      if (!g) { ev.noMoreGreen = true; ended = 'Kein weiteres Grün in der Aufzeichnung'; break; }
      const tGoMs = Math.max(tStopMs, g.start);
      const tGoS = (tGoMs - tOrigin) / 1000 + lostS;
      ev.tDepart = tOrigin + tGoS * 1000;
      ev.waitS = tGoS - (tStopMs - tOrigin) / 1000;
      wait(tGoS, false);
    }

    const reachedEnd = !ended && events.length > 0 && events[events.length - 1].idx === N - 1;
    const travelS = tS - tDepartS;
    const result = {
      startIdx, sign, station0, tOrigin, phases, events, warnings, ended, reachedEnd,
      nodes: nodes.map(n => ({ name: n.name, station: n.station })),
      // Acceleration model of this run, for the display and for the platoon.
      accel: { ...model, a0Now: accelAt(model, 0), aAtTarget: accelAt(model, vTargetMax), vTargetMaxKmh: vTargetMax * 3.6 }
    };
    result.summary = {
      tStart: tOrigin, tDepart: tOrigin + tDepartS * 1000, tEnd: tOrigin + tS * 1000,
      distanceM: sAlong, travelS,
      stops: events.filter(e => e.stopped).length,
      waitS: phases.filter(p => p.kind === 'wait' && !p.initial).reduce((s, p) => s + p.dt, 0),
      vMaxKmh: Math.max(0, ...phases.map(p => Math.max(p.v0, p.v1))) * 3.6,
      avgKmh: travelS > 0 ? sAlong / travelS * 3.6 : 0,
      freeTravelS: null, delayS: null
    };
    if (!freeFlow && reachedEnd) {
      const ref = simulate({ ...input, freeFlow: true });
      result.summary.freeTravelS = ref.summary.travelS;
      result.summary.delayS = travelS - ref.summary.travelS;
    }
    return result;
  }

  // Samples of the trajectory for drawing and charts.
  // Each point: { tMs, s (meters since the start node), station, v (m/s), a (m/s2) }.
  // The points lie on the phase borders and every stepS seconds inside a phase.
  // The acceleration is constant inside most phases, so each phase border has
  // two points with the two accelerations (step shape).
  function samplePoints(result, stepS) {
    const step = stepS > 0 ? stepS : 0.5;
    const pts = [];
    const mk = (ph, tRel) => {
      const e = evalPhase(ph, tRel);
      const s = ph.s0 + e.s;
      return { tMs: result.tOrigin + (ph.t0 + tRel) * 1000, s, station: result.station0 + result.sign * s, v: e.v, a: e.a };
    };
    result.phases.forEach(ph => {
      pts.push(mk(ph, 0));
      if (ph.kind === 'accel' || ph.kind === 'brake') {
        for (let t = step; t < ph.dt - 1e-9; t += step) pts.push(mk(ph, t));
      }
      pts.push(mk(ph, ph.dt));
    });
    return pts;
  }

  // Position s (meters since the start node) and speed v (m/s) of a simulated
  // vehicle at the absolute time tMs. Before the start the vehicle stands at
  // s = 0. After the end it stays at the last position.
  function stateAt(result, tMs) {
    const t = (tMs - result.tOrigin) / 1000;
    const ph = result.phases;
    if (!ph.length || t <= 0) return { s: 0, v: 0 };
    const last = ph[ph.length - 1];
    if (t >= last.t1) return { s: last.s1, v: last.v1 };
    for (const q of ph) {
      if (t < q.t1) {
        const e = evalPhase(q, t - q.t0);
        return { s: q.s0 + e.s, v: e.v };
      }
    }
    return { s: last.s1, v: last.v1 };
  }

  // Absolute time (ms) at which the vehicle has covered the distance s
  // (meters since the start node), or null if it never does.
  function timeAtDistance(result, s) {
    for (const q of result.phases) {
      if (q.s1 + 1e-9 < s) continue;
      const ds = s - q.s0;
      if (ds <= 0) return result.tOrigin + q.t0 * 1000;
      let tr;
      if (q.lin) {
        // The distance grows with the time, so bisection works.
        let lo = 0, hi = q.dt;
        for (let i = 0; i < 100; i++) {
          const mid = (lo + hi) / 2;
          if (evalPhase(q, mid).s < ds) lo = mid; else hi = mid;
        }
        tr = (lo + hi) / 2;
      } else if (Math.abs(q.a) < 1e-12) tr = q.v0 > 0 ? ds / q.v0 : null;
      else tr = (-q.v0 + Math.sqrt(Math.max(0, q.v0 * q.v0 + 2 * q.a * ds))) / q.a;
      if (tr == null) continue;
      return result.tOrigin + (q.t0 + tr) * 1000;
    }
    return null;
  }

  App.vehicle = {
    simulate, samplePoints, sectionProfile, greenAt, nextGreen, stateAt, timeAtDistance,
    makeAccelModel, accelAt, accelDist, accelTime, evalPhase, ACCEL_RATIO_AT_TARGET
  };
})(window.App = window.App || {});
