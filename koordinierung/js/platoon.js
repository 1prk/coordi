/* Koordinierung - EXPERIMENTAL platoon simulation (Nagel-Schreckenberg model).

   Idea: the lead vehicle is the deterministic vehicle of vehicle.js. A queue
   of followers stands behind it at the stop line of the start node. The
   signal turns green and the queue drives off. The followers use a
   Nagel-Schreckenberg (NaSch) cellular automaton on a 1 s time step.

   Rules for each follower in each time step (parallel update, all cars use
   the state at the start of the step):
   1. Acceleration: v = min(v + inc, vMax). The increment inc follows the
      acceleration model of the car (see below) and is a whole number of
      cells. A fraction is rounded up with the probability of the fraction
      (stochastic rounding). So the mean acceleration is exact.
   2. Braking: the car must not drive into the car ahead or into a red stop
      line. Hard limit: v <= gap (classic NaSch rule). Comfort limit: v is
      also limited so the car can stop with the deceleration b. The comfort
      limit assumes the leader brakes with b too.
   3. Randomization: with probability p the car slows down by one cell/step.
      A car that stands still uses the higher probability p0 (slow-to-start
      rule). This models the start-up delay of a queue.
   4. Movement: x = x + v.

   Signals: a red stop line acts as a standing obstacle. A car that cannot
   stop with the comfort deceleration when the signal is red drives through
   (dilemma zone). A signal is green from the start of a real green window to
   its end plus the yellow tolerance.

   Acceleration model (params.accelProfile, see vehicle.js): 'linear' =
   a(v) = a0 * (1 - v / vl), highest at standstill and falling with the
   speed (Drew 1968; Long 2000). 'constant' = a(v) = a. Each follower has its
   own driver factor f = 1 + sigma * z, where z is a normal random number
   cut at +-2. The factor scales the acceleration of that driver for the whole
   run. sigma = 0.13 follows the driver reduction factor of the Virginia Tech
   vehicle dynamics model (normal distribution, mean 0.60, sd 0.08, so 13 %
   relative spread). The lead vehicle has the nominal factor 1.

   Units: the cell length is set so that an acceleration of one cell per step
   is the MEAN acceleration of the user (cell = a * 1 s * 1 s). The speed grid
   is then a * 1 s. Target speeds are rounded to this grid. This model is
   experimental. Results are one random sample. Use runBatch for statistics.

   Sources of the method (checked by web search; the original papers could
   not be opened in the build environment, so the exact rule text comes from
   the standard description of the model):
   - Nagel and Schreckenberg 1992, J. Phys. I France 2, 2221 (the model).
   - Knospe, Santen, Schadschneider, Schreckenberg 2000, "Towards a realistic
     microscopic description of highway traffic" (arXiv cond-mat/0012204):
     finer grid with 1.5 m cells, which gives about 1.5 m/s2 for one cell
     per step, and the slow-to-start rule.
   - Brockfeld et al. 2001, "Optimizing traffic lights in a cellular automaton
     model for city traffic" (arXiv cond-mat/0107056): traffic lights in a
     NaSch model.
   - Highway Capacity Manual: ideal saturation flow 1800 veh/h/lane (about
     2.0 s per vehicle) and a start-up lost time of about 2 s. The defaults
     of p and p0 are calibrated to the 2.0 s (see DEFAULTS). */
(function (App) {
  'use strict';

  const STEP_MS = 1000;
  const VEH_LEN_M = 7.5;        // effective vehicle length (vehicle + standstill gap)
  const MAX_STEPS = 1500;       // upper limit of the simulated time (seconds)
  const RUNOUT_M = 150;         // cars drive on this far behind the last node

  // Default probabilities. They are calibrated so that a standing queue
  // discharges with a steady headway of about 2.0 s per vehicle (HCM ideal
  // saturation flow 1800 veh/h/lane). Without randomization the headway
  // would be 1.6 s (too fast). With p = 0.05 and p0 = 0.2 it is 2.0 s.
  const DEFAULTS = { p: 0.05, p0: 0.2, nCars: 8, seed: 1, sigma: 0.13 };

  // Random number generator with a seed (same seed = same result).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Distance (cells) that a car covers while it brakes from the speed v to
  // zero with the deceleration b (cells per step per step). The first braking
  // step is the NEXT step, so the sum starts with v - b.
  function tail(v, b) {
    const m = Math.floor((v - 1) / b);
    return m > 0 ? m * v - b * m * (m + 1) / 2 : 0;
  }

  // Acceleration of one car in whole cells for this step. The model gives the
  // acceleration in m/s2 for the current speed. A fraction of a cell is
  // rounded up with the probability of the fraction (stochastic rounding),
  // so the mean over many steps is exactly the model acceleration.
  function accelIncrement(model, vCells, cell, dtS, rand) {
    const x = App.vehicle.accelAt(model, vCells * cell / dtS) * dtS * dtS / cell;
    const whole = Math.floor(x);
    return rand() < x - whole ? whole + 1 : whole;
  }

  // Largest speed w (0..wMax) so that the car moves w cells now and can still
  // stop within the budget (cells) with the deceleration b.
  function safeSpeed(budget, b, wMax) {
    if (budget <= 0) return 0;
    let w = wMax;
    while (w > 0 && w + tail(w, b) > budget) w--;
    return w;
  }

  // input:
  //   nodes, startIdx, tGreenStart: as for App.vehicle.simulate.
  //   lead: result of App.vehicle.simulate (the deterministic lead vehicle).
  //   params: { accel (mean), accelProfile, decel, yellowTolS, targetKmh,
  //             nCars (lead + followers), p, p0, sigma (driver spread), seed }
  //   keepTrace: false = no point lists (used by runBatch).
  function simulate(input) {
    const { nodes, startIdx, tGreenStart, lead, params } = input;
    const keepTrace = input.keepTrace !== false;
    const N = nodes.length;
    const nCars = Math.max(1, Math.round(params.nCars));
    const nF = nCars - 1;
    const rand = mulberry32(params.seed == null ? 1 : params.seed);
    const p = Math.min(1, Math.max(0, params.p));
    const p0 = Math.min(1, Math.max(0, params.p0));
    const tolMs = Math.max(0, Number(params.yellowTolS) || 0) * 1000;
    const dtS = STEP_MS / 1000;

    // Grid: one cell per step of acceleration = the acceleration of the user.
    const cell = Math.min(3, Math.max(0.5, params.accel * dtS * dtS));
    const bCells = Math.max(1, Math.round(params.decel * dtS * dtS / cell));
    const lenCells = Math.max(1, Math.round(VEH_LEN_M / cell));
    const sign = lead.sign;
    const station0 = nodes[startIdx].station;

    const targetMs = (j) => {
      const raw = Array.isArray(params.targetKmh) ? params.targetKmh[j] : params.targetKmh;
      const v = Number(raw) / 3.6;
      if (!(v > 0)) throw new Error(`Wunschgeschwindigkeit fehlt oder ist 0 (Abschnitt ${j + 1}).`);
      return v;
    };
    const vMaxCells = [];
    for (let j = startIdx; j < N - 1; j++) vMaxCells[j] = Math.max(1, Math.round(targetMs(j) * dtS / cell));
    // Acceleration model and driver factor of each follower.
    let vTargetMax = 0;
    for (let j = startIdx; j < N - 1; j++) vTargetMax = Math.max(vTargetMax, targetMs(j));
    const sigma = Math.max(0, Number(params.sigma) || 0);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const nominal = App.vehicle.makeAccelModel(params, vTargetMax, 1);
    const factors = [];
    for (let i = 0; i < nF; i++) factors.push(1 + sigma * Math.max(-2, Math.min(2, gauss())));
    const lineX = nodes.map((n, j) => (j < startIdx ? -Infinity : Math.floor(Math.abs(n.station - station0) / cell + 1e-9)));
    const lastLine = lineX[N - 1];
    const exitX = lastLine + Math.ceil(RUNOUT_M / cell);
    const greens = nodes.map(n => (n.greenSegs || []).slice().sort((x, y) => x.start - y.start));
    const isGreen = (j, tMs) => !!App.vehicle.greenAt(greens[j], tMs, tolMs);
    const vMaxAt = (x) => {
      for (let j = N - 2; j > startIdx; j--) if (x >= lineX[j]) return vMaxCells[j];
      return vMaxCells[startIdx];
    };

    // Window of the lead green at the start node (for the "first green" check).
    const leadWin = App.vehicle.greenAt(greens[startIdx], tGreenStart, tolMs);
    const firstGreenEnd = leadWin ? leadWin.end + tolMs : tGreenStart;

    // Lead vehicle position in cells. It is an obstacle while it is on the road.
    const leadEnd = lead.summary.tEnd;
    let leadLeaveMs = leadEnd;
    const lastEv = lead.events[lead.events.length - 1];
    if (lead.ended || !lead.reachedEnd) leadLeaveMs = Infinity;
    else if (lastEv && lastEv.stopped) {
      const g = App.vehicle.nextGreen(greens[N - 1], leadEnd);
      leadLeaveMs = g ? Math.max(leadEnd, g.start) + 2000 : Infinity;
    }
    const leadX = (tMs) => Math.floor(App.vehicle.stateAt(lead, tMs).s / cell + 1e-9);

    // Followers: standing queue behind the lead, bumper to bumper.
    const cars = [];
    for (let i = 0; i < nF; i++) {
      cars.push({
        x: -(i + 1) * lenCells, v: 0, gone: false,
        factor: factors[i], model: App.vehicle.makeAccelModel(params, vTargetMax, factors[i]),
        committed: new Array(N).fill(false),
        crossT: new Array(N).fill(null), stops: 0, trace: [], hardBrakes: 0, maxDecel: 0
      });
    }
    const toStation = (x) => station0 + sign * x * cell;
    const pushTrace = (car, k) => {
      if (keepTrace) car.trace.push({ tMs: tGreenStart + k * STEP_MS, station: toStation(car.x), v: car.v * cell / dtS });
    };
    cars.forEach(c => pushTrace(c, 0));

    let leadPrevX = 0;
    let steps = 0;
    for (let k = 0; k < MAX_STEPS; k++) {
      const tMs = tGreenStart + k * STEP_MS;
      const leadOn = tMs < leadLeaveMs;
      const xl = leadOn ? leadX(tMs) : null;
      const vl = leadOn ? Math.max(0, xl - leadPrevX) : 0;
      leadPrevX = leadOn ? xl : leadPrevX;
      // State at the start of the step for every car (index -1 = lead).
      const prev = cars.map(c => ({ x: c.x, v: c.v, gone: c.gone }));
      if (cars.every(c => c.gone)) { steps = k; break; }

      for (let i = 0; i < nF; i++) {
        const c = cars[i];
        if (c.gone) continue;
        const x = prev[i].x, v = prev[i].v;
        // Leader: the car ahead (rear bumper), or null.
        let leaderX = null, leaderV = 0;
        if (i === 0) { if (leadOn) { leaderX = xl; leaderV = vl; } }
        else if (!prev[i - 1].gone) { leaderX = prev[i - 1].x; leaderV = prev[i - 1].v; }
        const gapLead = leaderX == null ? Infinity : Math.max(0, leaderX - lenCells - x);

        // Nearest red stop line ahead that the car can still stop at.
        let gapSig = Infinity;
        for (let j = startIdx; j < N; j++) {
          if (x > lineX[j]) continue;                       // line already crossed
          if (isGreen(j, tMs) || c.committed[j]) continue;
          const d = lineX[j] - x;
          if (tail(v, bCells) > d) { c.committed[j] = true; continue; }   // cannot stop: drives through
          gapSig = d;
          break;
        }

        const vMax = vMaxAt(x);
        let w = Math.min(v + accelIncrement(c.model, v, cell, dtS, rand), vMax);
        w = Math.min(w, gapLead, gapSig);
        if (gapLead !== Infinity) w = Math.min(w, safeSpeed(gapLead + tail(leaderV, bCells), bCells, w));
        if (gapSig !== Infinity) w = Math.min(w, safeSpeed(gapSig, bCells, w));
        w = Math.max(0, w);
        // Hard braking = the rules (before the random slowdown) need more than
        // the comfort deceleration. One extra cell is tolerated: the lead
        // position is rounded to the grid, so its speed jitters by one cell.
        if (v - w > bCells + 1) c.hardBrakes++;
        const pr = v === 0 ? p0 : p;
        if (w > 0 && rand() < pr) w = Math.max(0, w - 1);

        const decel = v - w;
        if (decel > c.maxDecel) c.maxDecel = decel;
        c.v = w;
        c.x = x + w;
        if (v > 0 && w === 0 && c.x > 0) c.stops++;
        for (let j = startIdx; j < N; j++) {
          if (c.crossT[j] == null && c.x > lineX[j]) {
            // Linear interpolation inside the step.
            const frac = c.x > x ? (lineX[j] + 0.5 - x) / (c.x - x) : 1;
            c.crossT[j] = tMs + Math.min(1, Math.max(0, frac)) * STEP_MS;
          }
        }
        if (c.x > exitX) c.gone = true;
        pushTrace(c, k + 1);
      }
      steps = k + 1;
    }

    // Results for each car (index 0 = lead from vehicle.js).
    const lastNodeIdx = N - 1;
    // The lead front passes the stop line when it has covered half a cell
    // (same rule as for the followers, see crossT).
    const leadCross0 = App.vehicle.timeAtDistance(lead, 0.5 * cell);
    const list = [{
      index: 0, isLead: true,
      cross0: leadCross0, crossLast: lead.reachedEnd ? lead.summary.tEnd : null,
      stops: lead.summary.stops, missedFirstGreen: false, finished: lead.reachedEnd,
      travelS: lead.summary.travelS, hardBrakes: 0
    }];
    cars.forEach((c, i) => {
      const cross0 = c.crossT[startIdx];
      const crossLast = c.crossT[lastNodeIdx];
      list.push({
        index: i + 1, isLead: false, cross0, crossLast,
        stops: c.stops,
        missedFirstGreen: cross0 == null || cross0 > firstGreenEnd,
        finished: crossLast != null,
        travelS: cross0 != null && crossLast != null ? (crossLast - cross0) / 1000 : null,
        hardBrakes: c.hardBrakes
      });
    });
    list.forEach(c => {
      c.through = c.finished && c.stops === 0 && !c.missedFirstGreen;
    });
    const crossings0 = list.map(c => c.cross0).filter(t => t != null).sort((a, b) => a - b);
    const headways = [];
    for (let i = 1; i < crossings0.length; i++) headways.push((crossings0[i] - crossings0[i - 1]) / 1000);
    const travel = list.filter(c => c.travelS != null).map(c => c.travelS);
    const summary = {
      nCars, throughCount: list.filter(c => c.through).length,
      finishedCount: list.filter(c => c.finished).length,
      missedFirstGreenCount: list.filter(c => c.missedFirstGreen).length,
      meanHeadwayS: headways.length ? headways.reduce((a, b) => a + b, 0) / headways.length : null,
      meanTravelS: travel.length ? travel.reduce((a, b) => a + b, 0) / travel.length : null,
      hardBrakeCount: list.reduce((s, c) => s + c.hardBrakes, 0),
      cellM: cell, bCells, lenCells,
      accel: {
        kind: nominal.kind, a0: App.vehicle.accelAt(nominal, 0), aAtTarget: App.vehicle.accelAt(nominal, vTargetMax),
        sigma, factorMin: factors.length ? Math.min(...factors) : 1, factorMax: factors.length ? Math.max(...factors) : 1,
        factorMean: factors.length ? factors.reduce((a, b) => a + b, 0) / factors.length : 1
      },
      vMaxKmh: vMaxCells.filter(v => v != null).map(v => v * cell / dtS * 3.6),
      queueLengthM: nF * lenCells * cell,
      steps
    };
    return {
      cars: list,
      traces: keepTrace ? cars.map(c => c.trace) : null,
      summary, sign, station0, tOrigin: tGreenStart
    };
  }

  // Run the simulation for several seeds and summarize how many cars drive
  // through. This shows how stable the result is (the model is random).
  function runBatch(input, runs) {
    const base = input.params.seed == null ? 1 : input.params.seed;
    const through = [];
    const missed = [];
    for (let r = 0; r < runs; r++) {
      const res = simulate({ ...input, keepTrace: false, params: { ...input.params, seed: base + r } });
      through.push(res.summary.throughCount);
      missed.push(res.summary.missedFirstGreenCount);
    }
    const sorted = through.slice().sort((a, b) => a - b);
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * f)))];
    return {
      runs, mean: through.reduce((a, b) => a + b, 0) / runs,
      min: sorted[0], max: sorted[sorted.length - 1], p10: q(0.1), p90: q(0.9),
      meanMissedFirstGreen: missed.reduce((a, b) => a + b, 0) / runs
    };
  }

  App.platoon = { simulate, runBatch, tail, safeSpeed, accelIncrement, mulberry32, DEFAULTS };
})(window.App = window.App || {});
