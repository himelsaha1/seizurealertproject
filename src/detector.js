// detector.js
// Rule-based convulsive seizure detector on MediaPipe Pose landmarks.
// Usage:
//   const detector = createDetector({ onSeizureStart, onSeizureEnd });
//   every frame: const status = detector.update(landmarks, timestampMs);

// MediaPipe Pose landmark indices
const LIMBS = {
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
};
const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;

export const DEFAULT_CONFIG = {
  windowSec: 4,          // seconds of motion analyzed at once
  sampleHz: 30,          // motion is resampled to this rate before the FFT
  minFreq: 2.0,          // rhythmic jerking band, in Hz (tune on your clips)
  maxFreq: 7.0,
  energyThreshold: 0.6,  // RMS limb speed, in torso lengths per second
  rhythmThreshold: 0.35, // share of motion power near the dominant frequency
  minActiveLimbs: 3,     // how many limbs must look seizure-like at once
  startAfterSec: 10,     // seizure-like this long -> onSeizureStart
  endAfterSec: 5,        // calm this long -> onSeizureEnd
  minVisibility: 0.5,    // ignore landmarks MediaPipe is unsure about
  requireLyingDown: true, // only count shaking while the torso is near horizontal
                          // (blocks running in place, dancing; set false to test seated)
  analyzeEveryMs: 200,   // run the analysis 5 times per second
};

export function createDetector({ onSeizureStart = () => {}, onSeizureEnd = () => {}, config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let buffer = [];           // [{ t, pts: { name: {x, y} | null }, lying }]
  let seizureLikeSince = null;
  let calmSince = null;
  let inSeizure = false;
  let seizureStartT = null;
  let lastAnalysisT = -Infinity;
  let status = emptyStatus();

  function update(landmarks, t) {
    if (landmarks && landmarks.length >= 33) {
      const frame = normalize(landmarks, cfg);
      if (frame) buffer.push({ t, ...frame });
    }
    // keep only the analysis window
    const cutoff = t - cfg.windowSec * 1000;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();

    if (t - lastAnalysisT >= cfg.analyzeEveryMs) {
      lastAnalysisT = t;
      status = analyze(t);
    }
    return status;
  }

  function analyze(t) {
    const limbs = {};
    let active = 0;
    const span = buffer.length ? (buffer[buffer.length - 1].t - buffer[0].t) / 1000 : 0;

    if (span >= cfg.windowSec * 0.9) {
      for (const name of Object.keys(LIMBS)) {
        const f = limbFeatures(name);
        limbs[name] = f;
        if (f && f.active) active++;
      }
    }

    const lyingShare = buffer.length ? buffer.filter(f => f.lying).length / buffer.length : 0;
    const postureOk = !cfg.requireLyingDown || lyingShare > 0.5;
    const seizureLike = active >= cfg.minActiveLimbs && postureOk;

    // state machine
    if (seizureLike) {
      calmSince = null;
      if (seizureLikeSince === null) seizureLikeSince = t;
      if (!inSeizure && (t - seizureLikeSince) / 1000 >= cfg.startAfterSec) {
        inSeizure = true;
        seizureStartT = seizureLikeSince;
        onSeizureStart({ startedAt: seizureStartT });
      }
    } else {
      seizureLikeSince = null;
      if (inSeizure) {
        if (calmSince === null) calmSince = t;
        if ((t - calmSince) / 1000 >= cfg.endAfterSec) {
          inSeizure = false;
          const durationSec = Math.round((calmSince - seizureStartT) / 1000);
          onSeizureEnd({ startedAt: seizureStartT, durationSec });
          seizureStartT = null;
          calmSince = null;
        }
      }
    }

    return {
      activeLimbs: active,
      totalLimbs: Object.keys(LIMBS).length,
      limbs,
      lying: lyingShare > 0.5,
      sustainedSec: seizureLikeSince === null ? 0 : (t - seizureLikeSince) / 1000,
      inSeizure,
      seizureSec: inSeizure ? (t - seizureStartT) / 1000 : 0,
    };
  }

  function limbFeatures(name) {
    const samples = buffer.filter(f => f.pts[name]);
    if (samples.length < buffer.length * 0.7 || samples.length < 10) return null; // limb not visible enough

    const xs = resample(samples.map(f => f.t), samples.map(f => f.pts[name].x), cfg.sampleHz);
    const ys = resample(samples.map(f => f.t), samples.map(f => f.pts[name].y), cfg.sampleHz);
    const dx = detrend(xs), dy = detrend(ys);

    // energy: RMS speed in torso lengths per second
    // (lightly smoothed first so tracking jitter does not count as motion)
    const sx = smooth(dx), sy = smooth(dy);
    let sumSq = 0;
    for (let i = 1; i < sx.length; i++) {
      const vx = (sx[i] - sx[i - 1]) * cfg.sampleHz;
      const vy = (sy[i] - sy[i - 1]) * cfg.sampleHz;
      sumSq += vx * vx + vy * vy;
    }
    const energy = Math.sqrt(sumSq / Math.max(1, sx.length - 1));

    // rhythm: how concentrated the motion is at one frequency
    const { freqs, power } = spectrum(dx, dy, cfg.sampleHz);
    let total = 0, peakIdx = 0;
    for (let i = 0; i < power.length; i++) {
      total += power[i];
      if (power[i] > power[peakIdx]) peakIdx = i;
    }
    let near = 0;
    for (let i = 0; i < power.length; i++) {
      if (Math.abs(freqs[i] - freqs[peakIdx]) <= 0.5) near += power[i];
    }
    const peakFreq = freqs[peakIdx];
    const rhythm = total > 0 ? near / total : 0;

    const active =
      energy >= cfg.energyThreshold &&
      peakFreq >= cfg.minFreq && peakFreq <= cfg.maxFreq &&
      rhythm >= cfg.rhythmThreshold;

    return { energy, peakFreq, rhythm, active };
  }

  function reset() {
    buffer = []; seizureLikeSince = null; calmSince = null;
    inSeizure = false; seizureStartT = null; status = emptyStatus();
  }

  return { update, reset, config: cfg };
}

// ---------- helpers ----------

// Positions relative to the hips, scaled by torso length, so the result
// does not depend on how far the person is from the camera or where they stand.
function normalize(lm, cfg) {
  const sh = mid(lm[L_SHOULDER], lm[R_SHOULDER]);
  const hip = mid(lm[L_HIP], lm[R_HIP]);
  const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y);
  if (torso < 0.02) return null; // body too small or torso not found

  const pts = {};
  for (const [name, idx] of Object.entries(LIMBS)) {
    const p = lm[idx];
    pts[name] = (p.visibility ?? 1) >= cfg.minVisibility
      ? { x: (p.x - hip.x) / torso, y: (p.y - hip.y) / torso }
      : null;
  }
  // torso angle from vertical: near 0 when standing, near 90 when lying down
  const angle = Math.abs(Math.atan2(sh.x - hip.x, hip.y - sh.y)) * 180 / Math.PI;
  const lying = angle > 50 && angle < 130;
  return { pts, lying };
}

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// Linear interpolation onto an even time grid (webcam frames arrive unevenly).
function resample(times, values, hz) {
  const out = [];
  const step = 1000 / hz;
  let j = 0;
  for (let t = times[0]; t <= times[times.length - 1]; t += step) {
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const t0 = times[j], t1 = times[j + 1] ?? t0;
    const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out.push(values[j] + a * ((values[j + 1] ?? values[j]) - values[j]));
  }
  return out;
}

// Remove the straight-line drift (slow posture changes) so only shaking remains.
function detrend(v) {
  const n = v.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxx += i * i; sxy += i * v[i]; }
  const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  const icpt = (sy - slope * sx) / n;
  return v.map((y, i) => y - (slope * i + icpt));
}

// 3-sample moving average: removes frame-to-frame jitter, keeps 2 to 7 Hz shaking.
function smooth(v) {
  return v.map((_, i) => (v[Math.max(0, i - 1)] + v[i] + v[Math.min(v.length - 1, i + 1)]) / 3);
}

// Power spectrum from 0.5 to 10 Hz (Hann window, plain DFT; small enough to be fast).
function spectrum(dx, dy, hz) {
  const n = dx.length;
  const freqs = [], power = [];
  for (let f = 0.5; f <= 10; f += 0.25) {
    let rx = 0, ix = 0, ry = 0, iy = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const ang = (2 * Math.PI * f * i) / hz;
      const c = Math.cos(ang) * w, s = Math.sin(ang) * w;
      rx += dx[i] * c; ix -= dx[i] * s;
      ry += dy[i] * c; iy -= dy[i] * s;
    }
    freqs.push(f);
    power.push(rx * rx + ix * ix + ry * ry + iy * iy);
  }
  return { freqs, power };
}

function emptyStatus() {
  return { activeLimbs: 0, totalLimbs: 8, limbs: {}, lying: false, sustainedSec: 0, inSeizure: false, seizureSec: 0 };
}
