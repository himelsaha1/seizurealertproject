// Synthetic motion tests for the detector. Run: npm run test:detector
// Each case says whether it should trigger; the script exits 1 if any case is wrong.
import { createDetector } from '../src/detector.js';

const TORSO = 0.25; // torso length in image units
const LIMB_IDX = { 13: 'le', 14: 're', 15: 'lw', 16: 'rw', 25: 'lk', 26: 'rk', 27: 'la', 28: 'ra' };
const LEG_IDX = [25, 26, 27, 28];
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function basePose(lying, legsHidden) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
  const set = (i, dx, dy) => {
    // dx, dy in torso lengths for an upright body; rotate 90 deg if lying
    const [rx, ry] = lying ? [dy, -dx] : [dx, dy];
    lm[i] = { x: 0.5 + rx * TORSO, y: 0.5 + ry * TORSO, visibility: legsHidden && LEG_IDX.includes(i) ? 0.1 : 0.95 };
  };
  set(11, -0.3, -1); set(12, 0.3, -1); set(23, -0.2, 0); set(24, 0.2, 0);
  set(13, -0.5, -0.6); set(14, 0.5, -0.6); set(15, -0.6, -0.2); set(16, 0.6, -0.2);
  set(25, -0.2, 0.8); set(26, 0.2, 0.8); set(27, -0.2, 1.6); set(28, 0.2, 1.6);
  return lm;
}

let failures = 0;
// motion(t, limbKey) -> [dx, dy] offset in torso lengths
function run(name, expectTrigger, { secs = 50, fps = 30, jitterFps = false, lying = true, legsHidden = false, noise = 0.003, motion = () => [0, 0], config = {} }) {
  const events = [];
  const det = createDetector({
    onSeizureStart: e => events.push(`start@${(e.startedAt / 1000).toFixed(1)}s`),
    onSeizureEnd: e => events.push(`end dur=${e.durationSec}s`),
    config,
  });
  let maxActive = 0, triggered = false;
  let t = 0;
  while (t < secs * 1000) {
    const lm = basePose(lying, legsHidden).map((p, i) => {
      const [mx, my] = LIMB_IDX[i] ? motion(t / 1000, LIMB_IDX[i]) : [0, 0];
      return { x: p.x + mx * TORSO + gauss() * noise, y: p.y + my * TORSO + gauss() * noise, visibility: p.visibility };
    });
    const s = det.update(lm, t);
    maxActive = Math.max(maxActive, s.activeJoints);
    if (s.inSeizure) triggered = true;
    t += jitterFps ? (1000 / fps) * (0.6 + rand() * 0.8) : 1000 / fps;
  }
  const ok = triggered === expectTrigger;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} maxActive=${maxActive} events=[${events.join(', ')}]`);
}

const phase = {};
const ph = k => (phase[k] ??= rand() * 2 * Math.PI);
const seizureMotion = (from, to, amp = 0.08, only = null) => (t, k) => {
  if (t < from || t > to || (only && !only.includes(k))) return [0, 0];
  // instantaneous frequency 4 Hz slowing linearly to 2.5 Hz
  const tau = t - from, D = to - from;
  const cyc = 4 * tau - (1.5 / (2 * D)) * tau * tau;
  const a = amp * Math.sin(2 * Math.PI * cyc + ph(k));
  return [a * 0.6, a];
};
const runningInPlace = (t, k) => [0, 0.2 * Math.sin(2 * Math.PI * 2.7 * t + (k[0] === 'l' ? 0 : Math.PI))];

console.log('--- should trigger ---');
run('seizure lying, 30fps', true, { motion: seizureMotion(5, 35) });
run('seizure lying, 15fps uneven frames', true, { fps: 15, jitterFps: true, motion: seizureMotion(5, 35) });
run('seizure lying, small jerks (amp 0.05)', true, { motion: seizureMotion(5, 35, 0.05) });
run('seizure lying, noisy tracking', true, { noise: 0.008, motion: seizureMotion(5, 35) });
run('seizure upright (camera above bed)', true, { lying: false, motion: seizureMotion(5, 35) });
run('seizure, upper body only (desk)', true, { lying: false, legsHidden: true, motion: seizureMotion(5, 35) });
run('seizure, bed mode on, lying', true, { config: { requireLyingDown: true }, motion: seizureMotion(5, 35) });

console.log('--- should NOT trigger ---');
run('lying still', false, {});
run('lying still, noisy tracking', false, { noise: 0.008 });
run('sitting still, upper body only', false, { lying: false, legsHidden: true, noise: 0.006 });
run('waving one arm 1.5 Hz', false, { lying: false, motion: (t, k) => (k === 'rw' || k === 're') ? [0.5 * Math.sin(2 * Math.PI * 1.5 * t), 0] : [0, 0] });
run('shaking one arm 4 Hz, upper body only', false, { lying: false, legsHidden: true, motion: seizureMotion(5, 35, 0.1, ['rw', 're']) });
run('jumping jacks 1.2 Hz', false, { lying: false, motion: (t, k) => { const a = Math.sin(2 * Math.PI * 1.2 * t); return k.endsWith('w') || k.endsWith('e') ? [0.4 * a, -0.6 * a] : [0.2 * a, 0]; } });
run('brushing teeth 4 Hz one arm', false, { lying: false, motion: (t, k) => k === 'rw' ? [0.05 * Math.sin(2 * Math.PI * 4 * t), 0] : [0, 0] });
run('shivering 9 Hz tiny', false, { motion: (t, k) => [0, 0.01 * Math.sin(2 * Math.PI * 9 * t + ph(k))] });
run('rolling over in bed (slow)', false, { motion: (t, k) => [0.4 * Math.sin(2 * Math.PI * 0.2 * t), 0.3 * Math.sin(2 * Math.PI * 0.2 * t)] });
run('running in place, bed mode on', false, { lying: false, config: { requireLyingDown: true }, motion: runningInPlace });

console.log('--- known limitation (documents current behaviour) ---');
run('running in place, bed mode off', true, { lying: false, motion: runningInPlace });

console.log(failures ? `\n${failures} case(s) failed` : '\nall cases passed');
process.exit(failures ? 1 : 0);
