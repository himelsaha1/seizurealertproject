// api/alert.js: Vercel serverless function. Sends a push (ntfy), texts and calls (Twilio).
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, CONTACTS (comma separated, +1...), NTFY_TOPIC
import twilio from 'twilio';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { kind = 'start', name = 'the person', durationSec, lat, lng } = req.body || {};
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

  // 1. Push notification backup (free, no account; phones subscribe to the topic in the ntfy app)
  if (process.env.NTFY_TOPIC) {
    jobs.push(['push', fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST',
      body: text,
      headers: { Title: 'Seizure alert', Priority: kind === 'end' || kind === 'test' ? 'default' : 'urgent', Tags: 'rotating_light' },
    })]);
  }

  // 2. Twilio texts and phone calls
  if (process.env.TWILIO_ACCOUNT_SID && contacts.length) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    for (const to of contacts) {
      jobs.push([`sms ${to}`, client.messages.create({ to, from: process.env.TWILIO_FROM, body: text })]);
      if (spoken[kind]) {
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say(spoken[kind]);
        twiml.pause({ length: 1 });
        twiml.say(spoken[kind]); // say it twice
        jobs.push([`call ${to}`, client.calls.create({ to, from: process.env.TWILIO_FROM, twiml: twiml.toString() })]);
      }
    }
  }

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  const report = Object.fromEntries(results.map((r, i) => [jobs[i][0], r.status === 'fulfilled' ? 'ok' : String(r.reason?.message || r.reason)]));
  console.log('alert', kind, report);
  res.status(200).json({ kind, report });
}
