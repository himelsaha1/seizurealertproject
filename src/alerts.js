// alerts.js: alarm sound, cancel countdown, seizure timer, calls to /api/alert
const COUNTDOWN_SEC = 15;
const URGENT_AFTER_SEC = 5 * 60; // seizures over 5 minutes are generally treated as emergencies

export function createAlerts({ getName, onUi }) {
  let state = 'idle';          // idle | countdown | sent
  let seizureStartMs = null, seizureEndedSec = null;
  let countdownLeft = 0;
  let tick = null, urgentTimer = null, beep = null;
  let audio = null, location = null;
  let notificationText = '';
  let generation = 0;

  // ---------- public ----------
  function seizureStarted() {
    if (state !== 'idle') return;
    state = 'countdown';
    generation++;
    notificationText = '';
    seizureStartMs = Date.now();
    seizureEndedSec = null;
    countdownLeft = COUNTDOWN_SEC;
    startAlarm();
    tick = setInterval(onTick, 1000);
    urgentTimer = setTimeout(() => send('long'), URGENT_AFTER_SEC * 1000);
    render();
  }

  function seizureEnded({ durationSec }) {
    clearTimeout(urgentTimer);
    seizureEndedSec = durationSec;
    // keep the countdown running: the person may be unresponsive after the shaking stops
    if (state === 'sent') {
      send('end', durationSec);
      stopAlarm();
    }
    render();
  }

  function cancel() {
    generation++;
    clearInterval(tick); clearTimeout(urgentTimer);
    stopAlarm();
    state = 'idle';
    seizureStartMs = null;
    render();
  }

  async function send(kind, durationSec) {
    try {
      const res = await fetch('/api/alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: getName(), durationSec, lat: location?.lat, lng: location?.lng }),
      });
      const data = await res.json().catch(() => ({}));
      return res.ok && data.ok === true ? { ok: true, data } : { ok: false, error: data.error || 'The backend did not confirm notification acceptance' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---------- setup helpers ----------
  function unlockAudio() {
    audio = audio || new AudioContext();
    audio.resume();
  }

  function requestLocation() {
    navigator.geolocation?.getCurrentPosition(
      p => { location = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => { location = null; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function keepAwake() {
    try {
      let lock = await navigator.wakeLock?.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
      });
    } catch { /* not supported or denied: keep the screen on manually */ }
  }

  // ---------- internals ----------
  function onTick() {
    if (state === 'countdown') {
      countdownLeft--;
      if (countdownLeft <= 0) {
        state = 'sending';
        const current = generation;
        send('start').then(result => {
          if (current !== generation) return;
          state = result.ok ? 'sent' : 'failed';
          notificationText = result.ok ? 'Notification requests accepted. Delivery is not confirmed.' : `Notification failed: ${result.error}`;
          if (result.ok && seizureEndedSec !== null) send('end', seizureEndedSec);
          render();
        });
      }
    }
    render();
  }

  function startAlarm() {
    if (!audio) return;
    const ping = () => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.6;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.4);
    };
    ping();
    beep = setInterval(ping, 700);
  }

  function stopAlarm() { clearInterval(beep); beep = null; }

  function render() {
    const elapsed = seizureStartMs ? Math.floor((Date.now() - seizureStartMs) / 1000) : 0;
    const timer = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    if (state === 'idle') {
      clearInterval(tick);
      onUi({ alarmVisible: false, title: '', text: '', timer, cancelVisible: false });
    } else if (state === 'countdown') {
      onUi({ alarmVisible: true, title: 'Possible seizure detected',
        text: `Calling emergency contacts in <span>${countdownLeft}</span> seconds`, timer, cancelVisible: true });
    } else {
      onUi({ alarmVisible: true, title: state === 'sending' ? 'Sending demo notifications' : state === 'failed' ? 'Notification failed' : 'Notification requests accepted',
        text: state === 'sending' ? 'Waiting for the notification service...' : escapeHtml(notificationText),
        timer, cancelVisible: true });
    }
  }

  return { seizureStarted, seizureEnded, cancel, send, unlockAudio, requestLocation, keepAwake };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
