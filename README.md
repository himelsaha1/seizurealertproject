# Seizure Alert

A web app that watches a person through a webcam, detects convulsive (tonic-clonic) seizure movement with MediaPipe Pose, and alerts emergency contacts by phone call, text and push notification if nobody cancels within 15 seconds. Not a medical device.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in your values
npm install -g vercel
vercel dev                   # serves the page and /api/alert together
```

Open the URL vercel prints. The webcam only works on localhost or HTTPS.

`npm run dev` also works for the page alone, but `/api/alert` only runs under `vercel dev` or once deployed.

## Files

Twilio trial mode is enabled by default. SMS uses the predefined
`sms_internal_alerts` template, and calls use Twilio's `voice_speech_recognition`
trial webhook. These deliver generic demonstration content, not a custom
seizure warning. Only verified trial recipients can receive them. Set
`TWILIO_FROM` to the assigned Voice trial sender. If Messaging assigns a
different sender for the recipient, set `TWILIO_SMS_FROM` to that number.
Set
`TWILIO_TRIAL_MODE=false` only after upgrading to use custom content and
`TWILIO_FROM`. API acceptance does not confirm delivery.

If the local backend does not load `.env.local`, launch from PowerShell with:

```powershell
node --env-file=.env.local -e "require('child_process').spawnSync('npx.cmd', ['vercel', 'dev'], {stdio: 'inherit', shell: true})"
```

Use the Test alert button once to request a real demo call and SMS. Failures
now appear on the page. The simulated detection button exercises the same
notification endpoint after the countdown. Keep this prototype private;
the endpoint does not yet have authentication or rate limiting.

- `src/main.js` camera, pose tracking, drawing, wiring
- `src/detector.js` seizure detection rules (tune `DEFAULT_CONFIG`)
- `src/alerts.js` alarm, countdown, seizure timer, calls `/api/alert`
- `api/alert.js` Vercel function: ntfy push, Twilio texts and calls
- `test/detector.test.mjs` synthetic motion tests: `npm run test:detector`

## Deploy

Push to GitHub, import the repo on Vercel, add the variables from `.env.example` under Settings > Environment Variables, deploy.
