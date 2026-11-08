// main.js: camera, pose tracking, drawing, settings, and wiring detector -> alerts
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { createDetector, DEFAULT_CONFIG, JOINTS } from './detector.js';
import { createAlerts } from './alerts.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const drawer = new DrawingUtils(ctx);

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm';
const LEVEL_COLOR = { calm: '#e5e7eb', moving: '#facc15', seizure: '#ef4444' };
// bone -> the joint whose state colors it (the joint at the far end of the bone)
const LIMB_BONES = [
  [11, 13, 'leftElbow'], [13, 15, 'leftWrist'], [12, 14, 'rightElbow'], [14, 16, 'rightWrist'],
  [23, 25, 'leftKnee'], [25, 27, 'leftAnkle'], [24, 26, 'rightKnee'], [26, 28, 'rightAnkle'],
];

// ---------- alerts ----------
const alerts = createAlerts({
  getName: () => $('name').value.trim() || 'the person',
  onUi: ui => {
    $('alarm').classList.toggle('hidden', !ui.alarmVisible);
    $('alarmTitle').textContent = ui.title;
    $('alarmText').innerHTML = ui.text;
    $('seizureTimer').textContent = ui.timer;
    $('cancel').classList.toggle('hidden', !ui.cancelVisible);
  },
});
$('cancel').onclick = () => alerts.cancel();

// ---------- detector ----------
// Local development (npm run dev / vercel dev) alarms after 4s so testing is quick.
// Deployed builds keep the safer DEFAULT_CONFIG value (10s).
const DEFAULTS = { ...DEFAULT_CONFIG, ...(import.meta.env.DEV ? { startAfterSec: 4 } : {}) };
const detector = createDetector({
  onSeizureStart: e => alerts.seizureStarted(e),
  onSeizureEnd: e => alerts.seizureEnded(e),
  config: { ...DEFAULTS, ...loadSettings() },
});

// ---------- settings panel ----------
const SETTINGS = [
  { key: 'energyThreshold', label: 'Movement strength needed', min: 0.2, max: 1.5, step: 0.05,
    hint: 'Lower = more sensitive, but more false alarms', fmt: v => v.toFixed(2) },
  { key: 'startAfterSec', label: 'Seconds of shaking before alarm', min: 3, max: 30, step: 1,
    hint: 'Longer = fewer false alarms, slower alert', fmt: v => `${v}s` },
  { key: 'rhythmThreshold', label: 'How steady the rhythm must be', min: 0.2, max: 0.6, step: 0.01,
    hint: 'Higher = only very regular jerking counts', fmt: v => v.toFixed(2) },
  { key: 'minActiveJoints', label: 'Joints needed (full body in view)', min: 2, max: 8, step: 1, fmt: v => v },
  { key: 'minActiveJointsUpper', label: 'Joints needed (upper body only)', min: 1, max: 4, step: 1, fmt: v => v },
  { key: 'requireBothSides', type: 'checkbox', label: 'Both sides of the body must shake',
    hint: 'Ignores one-arm movements like waving or brushing teeth' },
  { key: 'requireLyingDown', type: 'checkbox', label: 'Bed mode: only count shaking while lying down',
    hint: 'Only use with the camera at the side of the bed' },
];

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('detectorSettings') || '{}');
    return Object.fromEntries(SETTINGS.filter(s => s.key in saved).map(s => [s.key, saved[s.key]]));
  } catch { return {}; }
}

function saveSettings() {
  try {
    localStorage.setItem('detectorSettings',
      JSON.stringify(Object.fromEntries(SETTINGS.map(s => [s.key, detector.config[s.key]]))));
  } catch { /* storage unavailable: settings last for this session only */ }
}

function renderSettings() {
  const root = $('settings');
  root.innerHTML = '';
  for (const s of SETTINGS) {
    const row = document.createElement('label');
    row.className = s.type === 'checkbox' ? 'setting check' : 'setting';
    const input = document.createElement('input');
    const value = document.createElement('span');
    value.className = 'setting-value';
    if (s.type === 'checkbox') {
      input.type = 'checkbox';
      input.checked = detector.config[s.key];
      input.onchange = () => { detector.config[s.key] = input.checked; saveSettings(); };
    } else {
      Object.assign(input, { type: 'range', min: s.min, max: s.max, step: s.step, value: detector.config[s.key] });
      value.textContent = s.fmt(detector.config[s.key]);
      input.oninput = () => {
        detector.config[s.key] = Number(input.value);
        value.textContent = s.fmt(detector.config[s.key]);
        saveSettings();
      };
    }
    const text = document.createElement('span');
    text.className = 'setting-text';
    text.innerHTML = `<span class="setting-label"></span>${s.hint ? '<span class="setting-hint muted"></span>' : ''}`;
    text.querySelector('.setting-label').textContent = s.label;
    if (s.hint) text.querySelector('.setting-hint').textContent = s.hint;
    if (s.type === 'checkbox') row.append(input, text);
    else { const head = document.createElement('span'); head.className = 'setting-head'; head.append(text, value); row.append(head, input); }
    root.append(row);
  }
}
renderSettings();
$('resetSettings').onclick = () => {
  for (const s of SETTINGS) detector.config[s.key] = DEFAULTS[s.key];
  saveSettings();
  renderSettings();
};

// ---------- setup screen ----------
$('name').value = localStorage.getItem('name') || '';
$('testAlert').onclick = async () => {
  $('testAlert').disabled = true;
  $('setupMsg').textContent = 'Sending test alert...';
  const r = await alerts.send('test');
  $('setupMsg').textContent = r.ok ? 'Twilio accepted the test requests. Check your phone; trial content is generic. Delivery is not yet confirmed.' : `Test incomplete: ${r.error}`;
  $('testAlert').disabled = false;
};
$('start').onclick = async () => {
  localStorage.setItem('name', $('name').value.trim());
  alerts.unlockAudio();       // browsers only allow sound after a click
  alerts.requestLocation();   // ask now, not during an emergency
  alerts.keepAwake();         // Screen Wake Lock
  $('setup').classList.add('hidden');
  $('monitor').classList.remove('hidden');
  try {
    await loadModel();
  } catch (err) {
    console.error(err);
    setBanner('Could not load the pose model. Check your internet connection and reload the page.', 'bad');
    setHint(`Details: ${err.message || err}`);
    return;
  }
  requestAnimationFrame(loop);
  await useCamera();
};

// ---------- model ----------
let landmarker = null;
async function loadModel() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = delegate => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate failed, falling back to CPU', err);
    landmarker = await PoseLandmarker.createFromOptions(vision, options('CPU'));
  }
  setBanner('Starting camera...', 'ok');
}

// ---------- video sources ----------
let stream = null;
async function useCamera() {
  try {
    stream?.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.removeAttribute('src');
    video.srcObject = stream;
    await video.play();
    $('stage').classList.add('mirror');
    detector.reset();
    setHint(null);
  } catch (err) {
    console.error(err);
    setBanner(cameraErrorMessage(err), 'bad');
    setHint('You can still test detection with a video file below.');
  }
}

function cameraErrorMessage(err) {
  if (!navigator.mediaDevices) return 'Camera needs a secure page: open this on localhost or an https:// address.';
  switch (err.name) {
    case 'NotAllowedError': return 'Camera permission was blocked. Click the camera icon in the address bar, allow it, then press "Use webcam".';
    case 'NotFoundError': return 'No camera found. Plug one in, then press "Use webcam".';
    case 'NotReadableError': return 'The camera is being used by another app (Zoom, Teams, etc.). Close it, then press "Use webcam".';
    default: return `Could not start the camera: ${err.message || err.name}`;
  }
}

$('useCamera').onclick = useCamera;
$('fileInput').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.play().catch(err => setBanner(`Could not play this video: ${err.message}`, 'bad'));
  $('stage').classList.remove('mirror');
  detector.reset();
  setHint(null);
};
video.addEventListener('seeked', () => detector.reset()); // timestamps jump on seek
// resize the box to the video's shape (webcam 4:3, screen recording 16:9, phone portrait 9:16...)
video.addEventListener('loadedmetadata', () => {
  if (video.videoWidth && video.videoHeight) {
    $('stage').style.setProperty('--ar', `${video.videoWidth} / ${video.videoHeight}`);
  }
});
$('fakeTrigger').onclick = () => alerts.seizureStarted({ startedAt: performance.now() });

// ---------- main loop ----------
let lastVideoTime = -1, frames = 0, fps = 0, fpsT = performance.now();
function loop() {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    try {
      const result = landmarker.detectForVideo(video, now);
      const lm = result.landmarks[0];

      // webcam: wall clock; file: the video's own clock (accurate even if frames drop)
      const t = video.srcObject ? now : video.currentTime * 1000;
      const status = detector.update(lm, t);

      draw(lm, status);
      showStatus(status, !!lm);
    } catch (err) {
      console.error('frame failed', err); // keep the loop alive; one bad frame should not stop monitoring
    }
    frames++;
    if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; }
  }
  requestAnimationFrame(loop);
}

// ---------- drawing ----------
function draw(lm, status) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;

  const W = canvas.width, H = canvas.height;
  const scale = Math.max(1, W / 640);
  const minVis = detector.config.minVisibility;
  const seen = i => (lm[i].visibility ?? 1) >= minVis;
  const levelOf = name => status.joints[name]?.level ?? 'calm';

  // base skeleton
  drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: 'rgba(255,255,255,0.45)', lineWidth: 2 * scale });

  // limb bones light up with the state of the joint they lead to
  ctx.lineCap = 'round';
  for (const [a, b, name] of LIMB_BONES) {
    const level = levelOf(name);
    if (level === 'calm' || !seen(a) || !seen(b)) continue;
    ctx.strokeStyle = LEVEL_COLOR[level];
    ctx.lineWidth = (level === 'seizure' ? 6 : 4) * scale;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * W, lm[a].y * H);
    ctx.lineTo(lm[b].x * W, lm[b].y * H);
    ctx.stroke();
  }

  // the 8 joints the detector watches, colored by state
  for (const [name, idx] of Object.entries(JOINTS)) {
    if (!seen(idx)) continue;
    const level = levelOf(name);
    const x = lm[idx].x * W, y = lm[idx].y * H;
    if (level === 'seizure') {
      ctx.beginPath();
      ctx.arc(x, y, 13 * scale, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(239,68,68,0.35)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, 6 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = LEVEL_COLOR[level];
    ctx.fill();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = '#111827';
    ctx.stroke();
  }
}

// ---------- status ----------
function showStatus(s, personFound) {
  const cfg = detector.config;

  // banner
  if (s.inSeizure) setBanner(`Possible seizure: ${Math.round(s.seizureSec)}s`, 'bad');
  else if (!personFound) setBanner('No person in view', 'warn');
  else if (s.warmingUp) setBanner(`Calibrating... ${Math.max(1, Math.ceil(cfg.windowSec - s.warmupSec))}s`, 'ok');
  else if (s.seizureLike) setBanner(`Rhythmic shaking for ${s.sustainedSec.toFixed(0)}s`, 'warn');
  else setBanner('Monitoring', 'ok');

  // cards
  const ready = personFound && !s.warmingUp;
  $('activeCount').textContent = ready ? s.activeJoints : '-';
  $('activeCount').className = ready && s.activeJoints >= s.requiredJoints ? 'alert-text' : '';
  $('requiredCount').textContent = s.requiredJoints;
  $('visibleCount').textContent = ready ? s.visibleJoints : '-';
  $('viewMode').textContent = !ready ? '' : s.upperBodyOnly ? 'Upper body only' : 'Full body';

  // alarm progress
  const progress = s.inSeizure ? 1 : Math.min(1, s.sustainedSec / cfg.startAfterSec);
  $('meterFill').style.width = `${progress * 100}%`;
  $('meterFill').className = s.inSeizure ? 'bad' : '';
  $('meterText').textContent = s.inSeizure ? 'Alarm triggered'
    : s.seizureLike ? `Alarm in ${Math.max(0, Math.ceil(cfg.startAfterSec - s.sustainedSec))}s if shaking continues`
    : 'No seizure-like movement';

  // hint: tell the user why detection may not be working
  if (!personFound) setHint('Make sure the person is in frame: at least the shoulders, hips and both arms.');
  else if (s.blockedBy) setHint(`Shaking detected but not counted: ${s.blockedBy}.`);
  else if (ready && s.visibleJoints < s.requiredJoints) setHint('Too few joints are visible to detect a seizure. Move the camera back or improve the lighting.');
  else setHint(null);

  // technical details
  const rows = Object.entries(s.joints).map(([name, f]) =>
    f ? `${name.padEnd(11)} energy ${f.energy.toFixed(2).padStart(5)}  freq ${f.peakFreq.toFixed(2).padStart(5)} Hz  rhythm ${f.rhythm.toFixed(2)}  ${f.level.toUpperCase()}`
      : `${name.padEnd(11)} not visible`);
  $('debug').textContent =
    `fps ${fps} | active ${s.activeJoints}/${s.requiredJoints} needed | visible ${s.visibleJoints}/${s.totalJoints} | lying ${s.lying} | sustained ${s.sustainedSec.toFixed(1)}s\n` + rows.join('\n');
}

function setBanner(text, kind) {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
}

function setHint(text) {
  const h = $('hint');
  h.classList.toggle('hidden', !text);
  if (text) h.textContent = text;
}
