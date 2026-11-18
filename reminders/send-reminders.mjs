#!/usr/bin/env node
/**
 * send-reminders.mjs - email people who usually log a food around now but haven't today.
 *
 * Run on a schedule (see .github/workflows/reminders.yml) or by hand:
 *   node reminders/send-reminders.mjs --dry-run                       # real data, prints emails, sends nothing
 *   node reminders/send-reminders.mjs --dry-run --now 2026-11-18T14:00   # pretend it is 2:00 pm (user's local time)
 *   node reminders/send-reminders.mjs --demo preview.json --now 2026-11-17T09:30
 *        # no Firebase needed: uses entries from `seed-food-journal.mjs --dry-run --out preview.json`
 *
 * Who gets emails: only users whose profile has remindersEnabled == true (the Settings toggle),
 * and, if REMINDER_ALLOWED_EMAILS is set, only addresses on that comma-separated list (use it while testing).
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS   path to a service-account JSON (or FIREBASE_SERVICE_ACCOUNT_JSON with its contents)
 *   FIREBASE_PROJECT_ID              default long-covid-8f42d
 *   RESEND_API_KEY                   required unless --dry-run / --demo
 *   REMINDER_FROM                    default "Energy Balance <onboarding@resend.dev>" (Resend's test sender can only
 *                                    deliver to your own Resend account email until you verify a domain)
 *   APP_URL                          where the app lives, e.g. https://obuchel.github.io/energy_balance_for_all
 *   DEFAULT_TZ                       fallback time zone for users without a saved one (default America/Toronto)
 *   REMINDER_ALLOWED_EMAILS          optional allow-list
 *
 * Options: --dry-run  --demo <file>  --now <YYYY-MM-DDTHH:MM local>  --email <only this user>  --force (ignore "already sent")
 */

import fs from 'node:fs';
import { detectHabits, localNow, zonedToDate, addDays, fmtMin } from './habits.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DEMO = opt('demo');
const DRY = flag('dry-run') || !!DEMO;
const FORCE = flag('force');
const ONLY_EMAIL = (opt('email') || '').toLowerCase() || null;
const NOW_ARG = opt('now');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'long-covid-8f42d';
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Toronto';
const APP_URL = (process.env.APP_URL || 'https://obuchel.github.io/energy_balance_for_all').replace(/\/$/, '');
const FROM = process.env.REMINDER_FROM || 'Energy Balance <onboarding@resend.dev>';
const ALLOWED = (process.env.REMINDER_ALLOWED_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_EMAILS_PER_DAY = 2;

// ── Email content ─────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// params: an object, or an array of [key, value] pairs (needed to repeat food= / meal= for several foods)
const link = (path, params = {}) => {
  const q = new URLSearchParams(Array.isArray(params) ? params : Object.entries(params)).toString();
  return `${APP_URL}${path}${q ? `?${q}` : ''}`;
};

export function composeEmail({ name, due }) {
  const first = (name || '').split(' ')[0];
  const hi = first ? `Hi ${esc(first)},` : 'Hi,';
  const subject = due.length === 1
    ? `Did you have your ${due[0].name.split(',')[0].toLowerCase()} today?`
    : 'Did you forget to log something today?';

  const items = due.map((h) => ({
    ...h,
    logUrl: link('/quick-log', { food: h.name, meal: h.mealType }),
    when: fmtMin(h.typicalMin),
  }));

  const many = items.length > 1;
  // One link for all foods (repeated food=/meal= pairs). Adding review=1 opens a checklist instead of logging at once.
  const pairs = items.flatMap((h) => [['food', h.name], ['meal', h.mealType]]);
  const logAllUrl = link('/quick-log', pairs);
  const reviewUrl = link('/quick-log', [...pairs, ['review', '1']]);

  const text = [
    hi, '',
    many
      ? 'These usual foods are not in your journal yet today:'
      : `You usually have ${due[0].name} around ${items[0].when}, but it isn't in your journal yet today.`,
    ...items.map((h) => (many
      ? `- ${h.name} (usually around ${h.when})`
      : `- ${h.name} (usually around ${h.when}): log it -> ${h.logUrl}`)),
    ...(many ? ['', `Log all ${items.length}: ${logAllUrl}`, `Choose which ones: ${reviewUrl}`] : []),
    '', `Open the app: ${link('/food-tracker')}`,
    '', `You get these because reminders are turned on in Settings: ${link('/personal-settings')}`,
  ].join('\n');

  const btnStyle = 'background:#3b6ef5;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px;display:inline-block';
  const rows = items.map((h) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #eef0f6">
      <div style="font-size:16px;color:#1b2559"><strong>${esc(h.name)}</strong></div>
      <div style="font-size:13px;color:#6b7280;margin:2px 0 ${many ? '0' : '10px'}">Usually around ${esc(h.when)} &middot; ${esc(h.mealType)}</div>
      ${many ? '' : `<a href="${esc(h.logUrl)}" style="${btnStyle}">Yes, log it</a>`}
    </td></tr>`).join('');

  const actions = many ? `
    <div style="padding:16px 0 0">
      <a href="${esc(logAllUrl)}" style="${btnStyle}">Yes, log all ${items.length}</a>
      <a href="${esc(reviewUrl)}" style="color:#3b6ef5;font-size:14px;margin-left:14px;white-space:nowrap">Choose which ones</a>
    </div>` : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 10px rgba(30,50,120,.08)">
      <p style="font-size:16px;color:#1b2559;margin:0 0 8px">${hi}</p>
      <p style="font-size:15px;color:#374151;margin:0 0 8px">${due.length === 1
        ? 'This usual food isn’t in your journal yet today. Did you have it?'
        : 'These usual foods aren’t in your journal yet today. Did you have them?'}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>
      ${actions}
      <p style="font-size:13px;color:#6b7280;margin:16px 0 0">Not today? Just ignore this email, or <a href="${esc(link('/food-tracker'))}" style="color:#3b6ef5">open the app</a> to log something else.</p>
    </div>
    <p style="font-size:12px;color:#9ca3af;text-align:center;margin:14px 0 0">You receive these because reminders are on in your
      <a href="${esc(link('/personal-settings'))}" style="color:#9ca3af">Settings</a>. Turn them off there any time.</p>
  </div></body></html>`;

  return { subject, text, html };
}

async function sendViaResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body}`);
  return body;
}

// ── Time ──────────────────────────────────────────────────────────────────────
function resolveNow(tz) {
  if (!NOW_ARG) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(NOW_ARG);
  if (!m) throw new Error('--now must look like 2026-11-18T14:00 (the user\'s local time)');
  return zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

// ── Per-user processing ───────────────────────────────────────────────────────
async function processUser({ uid, email, name, tz, entries, logRef, logData }) {
  const nowDate = resolveNow(tz);
  const { iso: todayIso, minutes: nowMin } = localNow(nowDate, tz);
  const label = `${email || uid} [${tz}, ${todayIso} ${fmtMin(nowMin)}]`;

  const { habits, due, skipped } = detectHabits(entries, { todayIso, nowMin });
  if (skipped) { console.log(`- ${label}: no reminder (${skipped}); ${habits.length} habits known`); return 'skipped'; }

  const already = logData?.items || {};
  const fresh = FORCE ? due : due.filter((h) => !already[h.key]);
  const emailsToday = logData?.emails || 0;
  if (!fresh.length) {
    console.log(`- ${label}: ${due.length ? `${due.length} due but already reminded today` : 'nothing due'}`);
    return 'none';
  }
  if (!FORCE && emailsToday >= MAX_EMAILS_PER_DAY) { console.log(`- ${label}: daily limit reached`); return 'limit'; }

  const mail = composeEmail({ name, due: fresh });
  console.log(`- ${label}: REMIND about ${fresh.map((h) => h.name).join(' | ')}`);

  if (DRY) {
    console.log(`    to: ${email}\n    subject: ${mail.subject}\n    ${mail.text.split('\n').join('\n    ')}`);
    return 'dry';
  }
  await sendViaResend({ to: email, ...mail });
  const sentAt = new Date().toISOString();
  const items = { ...already };
  for (const h of fresh) items[h.key] = sentAt;
  await logRef.set({ date: todayIso, emails: emailsToday + 1, items }, { merge: true });
  console.log('    sent.');
  return 'sent';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Reminders | ${DRY ? 'DRY RUN | ' : ''}project ${PROJECT_ID}${NOW_ARG ? ` | simulated time ${NOW_ARG}` : ''}`);

  if (DEMO) {
    const entries = JSON.parse(fs.readFileSync(DEMO, 'utf8'));
    await processUser({ uid: 'demo', email: ONLY_EMAIL || 'demo@example.com', name: 'Demo User', tz: DEFAULT_TZ, entries, logRef: null, logData: null });
    return;
  }

  const { initializeApp, applicationDefault, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  initializeApp({ credential: json ? cert(JSON.parse(json)) : applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  const snap = await db.collection('users').where('remindersEnabled', '==', true).get();
  console.log(`${snap.size} user(s) have reminders turned on.`);

  let sent = 0;
  for (const u of snap.docs) {
    const p = u.data();
    const email = (p.email || '').toLowerCase();
    if (!email) continue;
    if (ONLY_EMAIL && email !== ONLY_EMAIL) continue;
    if (ALLOWED.length && !ALLOWED.includes(email)) { console.log(`- ${email}: not on REMINDER_ALLOWED_EMAILS, skipped`); continue; }

    const tz = p.timezone || DEFAULT_TZ;
    const { iso: todayIso } = localNow(resolveNow(tz), tz);
    const start = addDays(todayIso, -31);
    const js = await u.ref.collection('food_journal').where('date', '>=', start).get();
    const entries = js.docs.map((d) => d.data());
    const logRef = u.ref.collection('reminder_log').doc(todayIso);
    const logSnap = await logRef.get();

    try {
      const r = await processUser({ uid: u.id, email, name: p.name, tz, entries, logRef, logData: logSnap.exists ? logSnap.data() : null });
      if (r === 'sent') sent++;
    } catch (e) {
      console.error(`- ${email}: FAILED - ${e.message}`);
    }
  }
  console.log(`Done. ${sent} email(s) sent.`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
