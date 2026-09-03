'use strict';
// Minimal SMS via Twilio's REST API (no SDK). Configure with env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
// If unset, it logs the message instead of sending (dev fallback).
const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;
const smsConfigured = !!(SID && AUTH && FROM);

async function sendSms(to, body) {
  if (!smsConfigured) { console.log('[sms] (not configured) ->', to, ':', body); return { sent: false, configured: false }; }
  try {
    const auth = Buffer.from(SID + ':' + AUTH).toString('base64');
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: FROM, Body: body }).toString(),
    });
    if (!r.ok) { console.error('[sms] twilio', r.status); return { sent: false, configured: true }; }
    return { sent: true, configured: true };
  } catch (e) { console.error('[sms] error', e.message); return { sent: false, configured: true }; }
}
module.exports = { sendSms, smsConfigured };
