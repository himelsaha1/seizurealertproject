// main.js: camera, pose tracking, drawing, and wiring detector -> alerts
import { PoseLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { createDetector } from './detector.js';
import { createAlerts } from './alerts.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const drawer = new DrawingUtils(ctx);

// ---------- alerts (Person B) ----------
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

// ---------- detector (Person A) ----------
const detector = createDetector({
  onSeizureStart: e => alerts.seizureStarted(e),
  onSeizureEnd: e => alerts.seizureEnded(e),
});

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
  await loadModel();
  await useCamera();
  requestAnimationFrame(loop);
};

// ---------- model ----------
let landmarker = null;
async function loadModel() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm'
  );
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  setBanner('Monitoring', 'ok');
}

// ---------- video sources ----------
async function useCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.src = '';
  video.srcObject = stream;
  await video.play();
  detector.reset();
}
$('useCamera').onclick = useCamera;
$('fileInput').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.play();
  detector.reset();
};
video.addEventListener('seeked', () => detector.reset()); // timestamps jump on seek
$('fakeTrigger').onclick = () => alerts.seizureStarted({ startedAt: performance.now() });

// ---------- main loop ----------
let lastVideoTime = -1, frames = 0, fps = 0, fpsT = performance.now();
function loop() {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const lm = result.landmarks[0];

    // webcam: wall clock; file: the video's own clock (accurate even if frames drop)
    const t = video.srcObject ? now : video.currentTime * 1000;
    const status = detector.update(lm, t);

    draw(lm);
    showStatus(status, !!lm);
    frames++;
    if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; }
  }
  requestAnimationFrame(loop);
}

function draw(lm) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;
  drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#3b82f6', lineWidth: 3 });
  drawer.drawLandmarks(lm, { color: '#ffffff', radius: 3 });
}

function showStatus(s, personFound) {
  $('meterFill').style.width = `${(s.activeLimbs / s.totalLimbs) * 100}%`;
  if (s.inSeizure) setBanner(`Possible seizure: ${Math.round(s.seizureSec)}s`, 'bad');
  else if (s.sustainedSec > 0) setBanner(`Rhythmic shaking for ${s.sustainedSec.toFixed(0)}s...`, 'warn');
  else setBanner(personFound ? 'Monitoring' : 'Monitoring (no person in view)', 'ok');

  const rows = Object.entries(s.limbs).map(([name, f]) =>
    f ? `${name.padEnd(11)} energy ${f.energy.toFixed(2).padStart(5)}  freq ${f.peakFreq.toFixed(2).padStart(5)} Hz  rhythm ${f.rhythm.toFixed(2)}  ${f.active ? 'ACTIVE' : ''}`
      : `${name.padEnd(11)} not visible`);
  $('debug').textContent =
    `fps ${fps} | active limbs ${s.activeLimbs}/${s.totalLimbs} | lying ${s.lying} | sustained ${s.sustainedSec.toFixed(1)}s\n` + rows.join('\n');
}

function setBanner(text, kind) {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
}
