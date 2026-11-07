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

- `src/main.js` camera, pose tracking, drawing, wiring
- `src/detector.js` seizure detection rules (tune `DEFAULT_CONFIG`)
- `src/alerts.js` alarm, countdown, seizure timer, calls `/api/alert`
- `api/alert.js` Vercel function: ntfy push, Twilio texts and calls
- `test/detector.test.mjs` synthetic motion tests: `npm run test:detector`

## Deploy

Push to GitHub, import the repo on Vercel, add the variables from `.env.example` under Settings > Environment Variables, deploy.
