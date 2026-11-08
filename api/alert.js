// api/alert.js: Vercel serverless function. Sends a push (ntfy), texts and calls (Twilio).
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, CONTACTS (comma separated, +1...), NTFY_TOPIC
import twilio from 'twilio';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { kind = 'start', name = 'the person', durationSec, lat, lng } = req.body || {};
  if (!['start', 'long', 'end', 'test'].includes(kind)) return res.status(400).json({ error: 'Unknown alert kind' });
  const trial = process.env.TWILIO_TRIAL_MODE !== 'false';
  const contacts = (process.env.CONTACTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const map = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : 'location not available';

  const spoken = {
    start: `This is an automated seizure alert. A possible seizure was detected for ${name}. Please check on them right now, and call 9 1 1 if they need help.`,
    long: `Urgent. ${name}'s possible seizure has lasted more than 5 minutes. Call 9 1 1 now.`,
    test: `This is a test of the seizure alert system for ${name}. No action is needed.`,
  };
  const texts = {
    start: `SEIZURE ALERT: possible seizure detected for ${name}. Check on them now and call 911 if needed. Location: ${map}`,
    long: `URGENT: ${name}'s possible seizure has lasted over 5 minutes. Call 911 now. Location: ${map}`,
    end: `Update: ${name}'s shaking stopped after about ${durationSec ?? '?'} seconds. Please still check on them.`,
    test: `Test alert from the seizure monitor for ${name}. No action needed.`,
  };
  const text = texts[kind] ?? texts.start;
  const jobs = [];
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !contacts.length || !process.env.TWILIO_FROM) {
    return res.status(503).json({ error: 'Twilio settings are missing from the backend. Restart with .env.local loaded.' });
  }

  // 1. Push notification backup (free, no account; phones subscribe to the topic in the ntfy app)
  if (process.env.NTFY_TOPIC) {
    jobs.push(['push', fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST',
      body: text,
      headers: { Title: 'Seizure alert', Priority: kind === 'end' || kind === 'test' ? 'default' : 'urgent', Tags: 'rotating_light' },
    }).then(response => {
      if (!response.ok) throw new Error(`Push service returned ${response.status}`);
      return response;
    })]);
  }

  // 2. Twilio texts and phone calls
  if (process.env.TWILIO_ACCOUNT_SID && contacts.length) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    for (const [index, to] of contacts.entries()) {
      jobs.push([`sms contact ${index + 1}`, client.messages.create(trial
        ? { to, from: process.env.TWILIO_SMS_FROM || process.env.TWILIO_FROM, body: 'sms_internal_alerts' }
        : { to, from: process.env.TWILIO_FROM, body: text })]);
      if (spoken[kind]) {
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say(spoken[kind]);
        twiml.pause({ length: 1 });
        twiml.say(spoken[kind]); // say it twice
        // Match the Console request. The SDK sets form encoding and headers.
        const call = client.calls.create(trial
          ? { to, from: process.env.TWILIO_FROM, url: 'https://webhooks.twilio.com/v1/Voice/Template/voice_speech_recognition' }
          : { to, from: process.env.TWILIO_FROM, twiml: twiml.toString() });
        jobs.push([`call contact ${index + 1}`, call]);
      }
    }
  }

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  const report = Object.fromEntries(results.map((r, i) => [jobs[i][0], r.status === 'fulfilled' ? 'accepted' : String(r.reason?.message || r.reason).replace(/\+\d{8,15}/g, '[phone]')]));
  const ok = results.length > 0 && results.every(r => r.status === 'fulfilled');
  const error = Object.entries(report).filter(([, result]) => result !== 'accepted').map(([channel, result]) => `${channel}: ${result}`).join('; ');
  console.log('alert', kind, report);
  res.status(ok ? 200 : 502).json({ ok, kind, trial, report, ...(ok ? {} : { error: error || 'No notifications configured' }) });
}
