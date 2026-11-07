import { createDetector } from '../src/detector.js';

const TORSO = 0.25; // torso length in image units
const LIMB_IDX = { 13: 'le', 14: 're', 15: 'lw', 16: 'rw', 25: 'lk', 26: 'rk', 27: 'la', 28: 'ra' };
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function basePose(lying) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  const set = (i, dx, dy) => {
    // dx, dy in torso lengths for a standing body; rotate 90 deg if lying
    const [rx, ry] = lying ? [dy, -dx] : [dx, dy];
    lm[i] = { x: 0.5 + rx * TORSO, y: 0.5 + ry * TORSO, visibility: 0.95 };
  };
  set(11, -0.3, -1); set(12, 0.3, -1); set(23, -0.2, 0); set(24, 0.2, 0);
  set(13, -0.5, -0.6); set(14, 0.5, -0.6); set(15, -0.6, -0.2); set(16, 0.6, -0.2);
  set(25, -0.2, 0.8); set(26, 0.2, 0.8); set(27, -0.2, 1.6); set(28, 0.2, 1.6);
  return lm;
}

// motion(t, limbKey) -> [dx, dy] offset in torso lengths
function run(name, { secs = 50, fps = 30, jitterFps = false, lying = true, noise = 0.003, motion = () => [0, 0], config = {} }) {
  const events = [];
  const det = createDetector({
    onSeizureStart: e => events.push(`start@${(e.startedAt / 1000).toFixed(1)}s`),
    onSeizureEnd: e => events.push(`end dur=${e.durationSec}s`),
    config,
  });
  let maxActive = 0, firstTrigger = null;
  let t = 0;
  while (t < secs * 1000) {
    const lm = basePose(lying).map((p, i) => {
      const [mx, my] = LIMB_IDX[i] ? motion(t / 1000, LIMB_IDX[i]) : [0, 0];
      return { x: p.x + mx * TORSO + gauss() * noise, y: p.y + my * TORSO + gauss() * noise, visibility: p.visibility };
    });
    const s = det.update(lm, t);
    maxActive = Math.max(maxActive, s.activeLimbs);
    if (s.inSeizure && firstTrigger === null) firstTrigger = t / 1000;
    t += jitterFps ? (1000 / fps) * (0.6 + rand() * 0.8) : 1000 / fps;
  }
  console.log(`${name.padEnd(34)} maxActiveLimbs=${maxActive} events=[${events.join(', ')}]`);
}

const phase = {};
const ph = k => (phase[k] ??= rand() * 2 * Math.PI);
const seizureMotion = (from, to, amp = 0.08) => (t, k) => {
  if (t < from || t > to) return [0, 0];
  // instantaneous frequency 4 Hz slowing linearly to 2.5 Hz
  const tau = t - from, D = to - from;
  const cyc = 4 * tau - (1.5 / (2 * D)) * tau * tau;
  const a = amp * Math.sin(2 * Math.PI * cyc + ph(k));
  return [a * 0.6, a];
};

console.log('--- should trigger ---');
run('seizure 5-35s, 30fps', { motion: seizureMotion(5, 35) });
run('seizure, 15fps uneven frames', { fps: 15, jitterFps: true, motion: seizureMotion(5, 35) });
run('seizure, small jerks (amp 0.05)', { motion: seizureMotion(5, 35, 0.05) });
run('seizure, noisy tracking', { noise: 0.008, motion: seizureMotion(5, 35) });

console.log('--- should NOT trigger ---');
run('lying still', {});
run('lying still, noisy tracking', { noise: 0.008 });
run('waving one arm 1.5 Hz', { lying: false, motion: (t, k) => (k === 'rw' || k === 're') ? [0.5 * Math.sin(2 * Math.PI * 1.5 * t), 0] : [0, 0] });
run('jumping jacks 1.2 Hz', { lying: false, motion: (t, k) => { const a = Math.sin(2 * Math.PI * 1.2 * t); return k.endsWith('w') || k.endsWith('e') ? [0.4 * a, -0.6 * a] : [0.2 * a, 0]; } });
run('brushing teeth 4 Hz one arm', { lying: false, motion: (t, k) => k === 'rw' ? [0.05 * Math.sin(2 * Math.PI * 4 * t), 0] : [0, 0] });
run('shivering 9 Hz tiny', { motion: (t, k) => [0, 0.01 * Math.sin(2 * Math.PI * 9 * t + ph(k))] });
run('rolling over in bed (slow)', { motion: (t, k) => [0.4 * Math.sin(2 * Math.PI * 0.2 * t), 0.3 * Math.sin(2 * Math.PI * 0.2 * t)] });
run('running in place 2.7 Hz upright', { lying: false, motion: (t, k) => [0, 0.2 * Math.sin(2 * Math.PI * 2.7 * t + (k[0] === 'l' ? 0 : Math.PI))] });
run('running in place, requireLyingDown', { lying: false, config: { requireLyingDown: true }, motion: (t, k) => [0, 0.2 * Math.sin(2 * Math.PI * 2.7 * t + (k[0] === 'l' ? 0 : Math.PI))] });
run('seizure, requireLyingDown (lying)', { config: { requireLyingDown: true }, motion: seizureMotion(5, 35) });
