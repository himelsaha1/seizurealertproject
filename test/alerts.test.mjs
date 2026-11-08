import assert from 'node:assert/strict';
import RequestClient from 'twilio/lib/base/RequestClient.js';
import handler from '../api/alert.js';
import { createAlerts } from '../src/alerts.js';

// Intercept the SDK transport: no live credentials or network requests.
const requests = [];
let rejectCalls = false;
RequestClient.prototype.request = async options => {
  requests.push(options);
  if (rejectCalls && options.uri.includes('/Calls')) throw new Error('Trial call rejected');
  return { statusCode: 201, body: { sid: 'mock', status: 'queued' } };
};
process.env.TWILIO_ACCOUNT_SID = `AC${'0'.repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = 'mock';
process.env.CONTACTS = '+15555550123';
delete process.env.TWILIO_TRIAL_MODE;
process.env.TWILIO_FROM = '+15555550100';
process.env.TWILIO_SMS_FROM = '+15555550101';
delete process.env.NTFY_TOPIC;
async function invoke(kind = 'test') {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', body: { kind } }, res);
  return res;
}
let res = await invoke();
assert.equal(res.code, 200);
assert.equal(res.body.ok, true);
assert.equal(requests.length, 2);
assert.deepEqual(requests[0].data, { To: '+15555550123', From: '+15555550101', Body: 'sms_internal_alerts' });
assert.deepEqual(requests[1].data, { To: '+15555550123', From: '+15555550100', Url: 'https://webhooks.twilio.com/v1/Voice/Template/voice_speech_recognition' });
assert.equal(requests[1].headers['Content-Type'], 'application/x-www-form-urlencoded');
rejectCalls = true;
res = await invoke('start');
assert.equal(res.code, 502);
assert.match(res.body.error, /Trial call rejected/);
const count = requests.length;
delete process.env.CONTACTS;
res = await invoke();
assert.equal(res.code, 503);
assert.equal(requests.length, count);
res = await invoke('invalid');
assert.equal(res.code, 400);
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
const alerts = createAlerts({ getName: () => 'Demo', onUi() {} });
assert.equal((await alerts.send('test')).ok, false);
globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'Trial rejected' }) });
assert.equal((await alerts.send('test')).error, 'Trial rejected');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
assert.equal((await alerts.send('test')).ok, true);
console.log('Alert trial payload, failure, missing configuration, and client response checks passed.');
