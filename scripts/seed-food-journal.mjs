#!/usr/bin/env node
/**
 * seed-food-journal.mjs
 *
 * Fills users/{uid}/food_journal with ~30 days of realistic, habit-driven meals so the
 * Food Journal / Analysis tabs have history to show and a reminder service has habits to learn from.
 *
 * Entries match exactly what FoodTrackerPage.handleLogFood() writes (same fields, same
 * 'YYYY-MM-DD' date and 'hh:mm AM' time formats), plus two marker fields:
 *     seeded: true, seedBatch: 'demo-habits-v1'
 * Document IDs are deterministic (seed_<date>_<slot>_<n>), so re-running overwrites instead
 * of duplicating, and --clear removes only seeded documents.
 *
 * USAGE (from the project root):
 *   node scripts/seed-food-journal.mjs --dry-run              # no Firebase needed; prints a summary
 *   node scripts/seed-food-journal.mjs                         # writes to Firestore
 *   node scripts/seed-food-journal.mjs --clear                 # deletes seeded entries only
 *
 * WRITING needs firebase-admin and a service-account key (kept OUTSIDE the repo):
 *   npm i -D firebase-admin
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/keys/energy-project-62508-admin.json
 *
 * Options:
 *   --email obuchel@gmail.com   account to fill (looked up in Firebase Auth)
 *   --uid <uid>                 skip the email lookup
 *   --days 30                   number of past days
 *   --include-today             also generate entries for today (default: stop at yesterday so
 *                               "today" is empty and reminders have something to nudge about)
 *   --tz America/Toronto        timezone the dates/times are generated in
 *   --seed 17                   change the random pattern
 *   --foods <path>              path to foods_updated.json
 *   --out <file>                (dry-run) also save every generated entry as JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const EMAIL = opt('email', 'obuchel@gmail.com');
const UID_OVERRIDE = opt('uid', null);
if (UID_OVERRIDE && UID_OVERRIDE.includes('@') && !argv.includes('--clear')) {
  console.error('ERROR: --uid must be the Firebase Auth User UID (a ~28-character string), not an email.\n' +
    'Find it in Firebase console > Authentication > Users, or omit --uid and use --email.');
  process.exit(1);
}
const FORCE = argv.includes('--force');
const DAYS = parseInt(opt('days', '30'), 10);
const TZ = opt('tz', 'America/Toronto');
const SEED = parseInt(opt('seed', '17'), 10);
const DRY = flag('dry-run');
const CLEAR = flag('clear');
const INCLUDE_TODAY = flag('include-today');
const FOODS_PATH = path.resolve(
  opt('foods', path.join(__dirname, '../src/components/FoodTracker/foods_updated.json'))
);
const OUT = opt('out', null);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'energy-project-62508';
const SEED_BATCH = 'demo-habits-v1';

// ── Habit model ───────────────────────────────────────────────────────────────
// Each spec is one "slot" in the day. `food` = a fixed habit (same food every time);
// `options` = a rotation (one weighted pick). `p` = probability it is logged on that kind of day.
// Strong, consistent items (egg, tomato, green tea, coffee, toast) are what a reminder service
// should learn: "you usually eat this around this time".
const W = { weekday: 'weekday', weekend: 'weekend' };
const SPECS = [
  // Breakfast
  { id: 'egg',    meal: 'Breakfast', time: '07:30', jitter: 20, p: { weekday: 0.88, weekend: 0.70 },
    food: 'Egg, whole, boiled or poached', grams: 130 },
  { id: 'toast',  meal: 'Breakfast', time: '07:35', jitter: 15, p: { weekday: 0.80, weekend: 0.60 },
    food: 'Bread, whole wheat, toasted', grams: 40 },
  { id: 'bfast-extra', meal: 'Breakfast', time: '07:45', jitter: 20, p: { weekday: 0.75, weekend: 0.75 },
    options: [
      { food: 'Yogurt, Greek, whole milk, plain', grams: 150, w: 2 },
      { food: 'Blueberries, raw', grams: 80, w: 2 },
      { food: 'Banana, raw', grams: 118, w: 1 },
    ] },
  { id: 'coffee', meal: 'Breakfast', time: '08:00', jitter: 20, p: { weekday: 0.92, weekend: 0.90 },
    food: 'Coffee, brewed', grams: 240 },

  // Morning snack
  { id: 'am-snack', meal: 'Morning Snack', time: '10:30', jitter: 25, p: { weekday: 0.45, weekend: 0.35 },
    options: [
      { food: 'Orange, raw', grams: 130, w: 1 },
      { food: 'Apple, raw', grams: 180, w: 1 },
      { food: 'Carrots, raw', grams: 70, w: 1 },
    ] },

  // Lunch
  { id: 'lunch-main', meal: 'Lunch', time: '12:30', jitter: 30, p: { weekday: 0.93, weekend: 0.55 },
    options: [
      { food: 'Soup, chicken noodle', grams: 300, w: 3 },
      { food: 'Soup, lentil', grams: 300, w: 2 },
      { food: 'Chicken breast, baked, broiled, or roasted, skin not eaten, from raw', grams: 120, w: 2 },
      { food: 'Hummus, plain', grams: 60, w: 1 },
    ] },
  { id: 'tomato', meal: 'Lunch', time: '12:35', jitter: 15, p: { weekday: 0.78, weekend: 0.70 },
    food: 'Tomatoes, raw', grams: 90 },
  { id: 'lunch-salad', meal: 'Lunch', time: '12:40', jitter: 15, p: { weekday: 0.50, weekend: 0.40 },
    food: 'Lettuce, salad with assorted vegetables including tomatoes and/or carrots, no dressing', grams: 120 },
  { id: 'weekend-pizza', meal: 'Lunch', time: '13:15', jitter: 30, p: { weekday: 0, weekend: 0.35 },
    food: 'Pizza, cheese, from restaurant or fast food, thin crust', grams: 200 },

  // Afternoon snack
  { id: 'green-tea', meal: 'Afternoon Snack', time: '15:30', jitter: 25, p: { weekday: 0.82, weekend: 0.70 },
    food: 'Tea, hot, leaf, green', grams: 240 },
  { id: 'pm-snack', meal: 'Afternoon Snack', time: '15:45', jitter: 25, p: { weekday: 0.50, weekend: 0.50 },
    options: [
      { food: 'Almonds, unsalted', grams: 28, w: 2 },
      { food: 'Apple, raw', grams: 180, w: 2 },
      { food: 'Cheese, Cheddar', grams: 30, w: 1 },
      { food: 'Peanut butter', grams: 32, w: 1 },
    ] },

  // Dinner
  { id: 'dinner-main', meal: 'Dinner', time: '18:45', jitter: 30, p: { weekday: 0.95, weekend: 0.92 },
    options: [
      { food: 'Fish, salmon, baked or broiled', grams: 140, w: 2 },
      { food: 'Chicken breast, baked, broiled, or roasted, skin not eaten, from raw', grams: 150, w: 3 },
      { food: 'Lentils, from dried, no added fat', grams: 200, w: 2 },
      { food: 'Pasta, whole grain, with tomato-based sauce, home recipe', grams: 250, w: 2 },
    ] },
  { id: 'dinner-side', meal: 'Dinner', time: '18:50', jitter: 20, p: { weekday: 0.80, weekend: 0.80 },
    options: [
      { food: 'Broccoli, cooked, from restaurant', grams: 120, w: 3 },
      { food: 'Sweet potato, baked, no added fat', grams: 150, w: 2 },
      { food: 'Green beans, fresh, cooked, no added fat', grams: 100, w: 2 },
      { food: 'Rice, brown, cooked, no added fat', grams: 150, w: 2 },
      { food: 'Spinach, raw', grams: 60, w: 1 },
    ] },

  // Late night
  { id: 'late', meal: 'Late Night Snack', time: '21:20', jitter: 25, p: { weekday: 0.25, weekend: 0.35 },
    options: [
      { food: 'Dark chocolate candy', grams: 20, w: 2 },
      { food: 'Ice cream, vanilla', grams: 90, w: 1 },
    ] },
];

const P_DAY_LOGGED = 0.94; // ~2 days out of 30 the user simply didn't log anything

// ── Small utilities ───────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = parseInt(p.value, 10);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute };
}
/** Wall-clock time in `tz` -> real Date (UTC instant). */
function zonedToDate(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    guess -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - want;
  }
  return new Date(guess);
}
function fmtTime12(h, mi) {
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${pad(hh)}:${pad(mi)} ${ap}`; // matches toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
}

// ── Nutrition helpers (mirror healthDataAdapter.jsx / FoodTrackerPage.jsx) ────
const MICRO_KEYS = [
  'calcium', 'iron', 'magnesium', 'phosphorus', 'potassium', 'sodium', 'zinc',
  'copper', 'selenium', 'vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e',
  'vitamin_k', 'thiamin', 'riboflavin', 'niacin', 'vitamin_b6', 'folate',
  'vitamin_b12', 'choline',
];
const parseServingAmount = (s) => {
  if (!s) return { weight: 100, unit: 'g' };
  const m = s.match(/(\d+)(ml|g|oz)/i);
  return m ? { weight: parseFloat(m[1]), unit: m[2].toLowerCase() } : { weight: 100, unit: 'g' };
};
const benefitsOf = (f) => f?.healthBenefits || f?.longCovidBenefits || [];
const cautionsOf = (f) => f?.healthCautions || f?.longCovidCautions || [];
const relevanceOf = (f) => f?.healthRelevance || f?.longCovidRelevance || {};

function metabolicEfficiency(entry, profile) {
  const m = (entry.time || '').match(/(\d+):/);
  const hour = m ? parseInt(m[1], 10) : 12;
  const isPM = entry.time.toLowerCase().includes('pm');
  let h24 = hour;
  if (isPM && hour !== 12) h24 += 12;
  if (!isPM && hour === 12) h24 = 0;

  const f = (entry.protein || 0) * 0.2 + (entry.carbs || 0) * 0.1 + (entry.fat || 0) * 0.15;
  let timeFactor = 1.0;
  if (h24 < 6 || h24 > 20) timeFactor = 0.7;
  else if (h24 >= 7 && h24 <= 10) timeFactor = 1.2;
  else if (h24 >= 17 && h24 <= 19) timeFactor = 0.9;
  const mealFactors = {
    Breakfast: 1.3, 'Morning Snack': 0.9, Lunch: 1.1, 'Afternoon Snack': 0.8,
    Dinner: 0.9, 'Late Night Snack': 0.6, Snack: 0.8,
  };
  let eff = Math.min(100, f * 10) * timeFactor * (mealFactors[entry.mealType] || 1.0);

  if (profile?.hasCondition || profile?.hasLongCovid) {
    const sev = { mild: 0.95, moderate: 0.85, severe: 0.75, 'very severe': 0.65 };
    const s = profile.conditionSeverity || profile.longCovidSeverity || 'moderate';
    eff *= sev[s] || 0.85;
    if (benefitsOf(entry).length > 0) eff *= 1.1;
    if (cautionsOf(entry).length > 0) eff *= 0.9;
  }
  return Math.min(100, Math.max(0, eff));
}

function buildEntry(food, grams, meal, h, mi, date, profile) {
  const per = food.nutrients?.per100g || {};
  const r = grams / 100;
  const val = (k) => (per[k]?.value || 0) * r;

  const micronutrients = {};
  for (const k of MICRO_KEYS) {
    if (per[k] && typeof per[k].value === 'number') micronutrients[k] = { ...per[k], value: per[k].value * r };
  }

  // Borrow serving wording from the food's own recommended servings when one is close in size.
  let sv = null;
  let best = Infinity;
  for (const s of food.longCovidServings || []) {
    const { weight, unit } = parseServingAmount(s.amount);
    if (unit === 'oz') continue;
    const diff = Math.abs(weight - grams) / grams;
    if (diff < best) { best = diff; sv = s; }
  }
  if (best > 0.35) sv = null;

  const entry = {
    name: food.name,
    protein: Number(val('protein').toFixed(1)),
    carbs: Number(val('carbs').toFixed(1)),
    fat: Number(val('fat').toFixed(1)),
    calories: Math.round(val('calories')),
    serving: grams,
    servingUnit: 'g',
    servingDisplayed: grams,
    servingDisplayedUnit: 'g',
    servingDescription: sv?.name || null,
    visualEquivalent: sv?.visualEquivalent || null,
    servingReason: sv?.reason || null,
    servingTiming: sv?.timing || null,
    micronutrients,
    mealType: meal,
    time: fmtTime12(h, mi),
    date,
    healthBenefits: benefitsOf(food),
    healthCautions: cautionsOf(food),
    healthRelevance: relevanceOf(food),
    longCovidBenefits: benefitsOf(food),
    longCovidCautions: cautionsOf(food),
    longCovidRelevance: relevanceOf(food),
    mealId: null, // the FNDDS database has no document ids; the app stores null in this case
  };
  entry.metabolicEfficiency = metabolicEfficiency(entry, profile);
  return entry;
}

// ── Generation ────────────────────────────────────────────────────────────────
function pickWeighted(options, rng) {
  const total = options.reduce((s, o) => s + o.w, 0);
  let x = rng() * total;
  for (const o of options) { if ((x -= o.w) < 0) return o; }
  return options[options.length - 1];
}

function listDates() {
  const t = tzParts(new Date(), TZ);
  const out = [];
  const startOffset = INCLUDE_TODAY ? 0 : 1;
  for (let i = startOffset + DAYS - 1; i >= startOffset; i--) {
    const d = new Date(Date.UTC(t.y, t.mo - 1, t.d - i));
    out.push({ iso: isoOf(d), y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() });
  }
  return out;
}

function generate(foodsByName, profile) {
  const entries = [];
  const missing = new Set();
  const lookup = (n) => {
    const f = foodsByName.get(n);
    if (!f) missing.add(n);
    return f;
  };

  for (const day of listDates()) {
    const rng = mulberry32(hashStr(`${day.iso}|${SEED}`)); // stable per day, independent of run date
    if (rng() > P_DAY_LOGGED) continue; // a day with nothing logged
    const kind = day.dow === 0 || day.dow === 6 ? W.weekend : W.weekday;
    const slotCount = {};

    for (const spec of SPECS) {
      const roll = rng();
      const jit = Math.round((rng() * 2 - 1) * spec.jitter);
      const gramJit = 1 + (rng() * 2 - 1) * 0.12;
      if (roll >= spec.p[kind]) continue;

      const choice = spec.options ? pickWeighted(spec.options, rng) : spec;
      const food = lookup(choice.food);
      if (!food) continue;

      const [bh, bm] = spec.time.split(':').map(Number);
      const total = Math.max(0, Math.min(23 * 60 + 59, bh * 60 + bm + jit));
      const h = Math.floor(total / 60), mi = total % 60;
      const grams = Math.max(5, Math.round((choice.grams * gramJit) / 5) * 5);

      const entry = buildEntry(food, grams, spec.meal, h, mi, day.iso, profile);
      const n = (slotCount[spec.meal] = (slotCount[spec.meal] || 0) + 1);
      entry._id = `seed_${day.iso}_${spec.meal.toLowerCase().replace(/\s+/g, '-')}_${n}`;
      entry._createdAt = zonedToDate(day.y, day.mo, day.d, h, mi, TZ);
      entries.push(entry);
    }
  }
  if (missing.size) {
    throw new Error(
      'These food names were not found in foods_updated.json (fix SPECS):\n  - ' + [...missing].join('\n  - ')
    );
  }
  return entries;
}

// ── Summary (also previews what a reminder service would learn) ───────────────
function summarize(entries) {
  const days = new Set(entries.map((e) => e.date));
  console.log(`\nGenerated ${entries.length} entries across ${days.size} logged days (${DAYS} requested).`);
  console.log(`Average ${(entries.length / days.size).toFixed(1)} entries per logged day.\n`);

  const byFood = new Map();
  for (const e of entries) {
    if (!byFood.has(e.name)) byFood.set(e.name, { days: new Set(), mins: [], meal: e.mealType });
    const g = byFood.get(e.name);
    g.days.add(e.date);
    const m = e.time.match(/(\d+):(\d+) (AM|PM)/);
    let h = parseInt(m[1], 10) % 12; if (m[3] === 'PM') h += 12;
    g.mins.push(h * 60 + parseInt(m[2], 10));
  }
  const rows = [...byFood.entries()]
    .map(([name, g]) => {
      g.mins.sort((a, b) => a - b);
      const med = g.mins[Math.floor(g.mins.length / 2)];
      return { name, days: g.days.size, meal: g.meal, typical: `${pad(Math.floor(med / 60))}:${pad(med % 60)}` };
    })
    .sort((a, b) => b.days - a.days);

  console.log('Most repeated foods (what a reminder service would treat as habits):');
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${String(r.days).padStart(2)} days  ~${r.typical}  ${r.meal.padEnd(15)} ${r.name.slice(0, 60)}`);
  }
  console.log(`\n${rows.length} distinct foods in total.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function loadFoods() {
  if (!fs.existsSync(FOODS_PATH)) throw new Error(`Food database not found: ${FOODS_PATH} (use --foods)`);
  console.log(`Loading food database ${FOODS_PATH} ...`);
  const arr = JSON.parse(fs.readFileSync(FOODS_PATH, 'utf8'));
  const map = new Map();
  for (const f of arr) map.set(f.name, f);
  console.log(`  ${map.size} foods`);
  return map;
}

async function main() {
  console.log(`Account: ${UID_OVERRIDE ? `uid ${UID_OVERRIDE}` : EMAIL} | tz ${TZ} | ${DAYS} days | seed ${SEED}${DRY ? ' | DRY RUN' : ''}`);

  let db = null, Timestamp = null, uid = UID_OVERRIDE, profile = null;

  if (!DRY) {
    let admin;
    try {
      admin = await import('firebase-admin');
    } catch {
      throw new Error('firebase-admin is not installed. Run: npm i -D firebase-admin   (or use --dry-run)');
    }
    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, Timestamp: TS } = await import('firebase-admin/firestore');
    void admin;
    initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
    db = getFirestore();
    Timestamp = TS;

    if (!uid) {
      const rec = await getAuth().getUserByEmail(EMAIL);
      uid = rec.uid;
      console.log(`Resolved ${EMAIL} -> uid ${uid}`);
    }
    const prof = await db.doc(`users/${uid}`).get();
    if (prof.exists) {
      profile = prof.data();
      console.log('Found users/{uid} profile (used for the metabolic-efficiency score).');
    } else if (!CLEAR && !FORCE) {
      throw new Error(
        `users/${uid} does not exist, so this uid is probably wrong (or the account was never registered in the app).\n` +
        'Check Authentication > Users in the console, or pass --force to write anyway.');
    } else {
      console.warn(`WARNING: users/${uid} does not exist.`);
    }
  }

  const col = db ? db.collection(`users/${uid}/food_journal`) : null;

  if (CLEAR) {
    if (DRY) { console.log('--clear with --dry-run: nothing to do.'); return; }
    const snap = await col.where('seeded', '==', true).get();
    console.log(`Deleting ${snap.size} seeded entries ...`);
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
    console.log('Done.');
    return;
  }

  const foods = loadFoods();
  const entries = generate(foods, profile);
  summarize(entries);

  if (DRY) {
    if (OUT) {
      fs.writeFileSync(OUT, JSON.stringify(entries.map((e) => ({ ...e, _createdAt: e._createdAt.toISOString() })), null, 2));
      console.log(`\nWrote preview to ${OUT}`);
    }
    console.log('\nDry run only - nothing was written to Firebase.');
    return;
  }

  console.log(`\nWriting ${entries.length} documents to users/${uid}/food_journal ...`);
  for (let i = 0; i < entries.length; i += 400) {
    const b = db.batch();
    for (const e of entries.slice(i, i + 400)) {
      const { _id, _createdAt, ...data } = e;
      b.set(col.doc(_id), { ...data, createdAt: Timestamp.fromDate(_createdAt), seeded: true, seedBatch: SEED_BATCH });
    }
    await b.commit();
  }
  console.log('Done. Reload the Food Tracker > Journal tab to see the history.');
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
