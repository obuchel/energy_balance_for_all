/**
 * habits.mjs - learn a person's eating habits from their food journal and decide which usual
 * foods they have "forgotten" to log today. Pure functions: no Firebase, no network.
 *
 * A "habit" is a food that, on the same kind of day (weekday vs weekend), was logged on most of the
 * days the person logged anything at all, at a consistent time of day.
 *
 * A habit is "due" for a reminder when:
 *   - it has not been logged today,
 *   - it is now later than the usual time + a grace period (default 60 min),
 *   - but not more than `maxLateMin` after it (default 4 h; after that a reminder is just noise),
 *   - it is outside quiet hours, and the person has been logging recently (not on holiday / inactive).
 */

export const DEFAULTS = {
  windowDays: 30,      // how much history to learn from
  minLoggedDays: 6,    // need at least this many logged days of the same day-type
  minFoodDays: 4,      // food must appear on at least this many of them
  minFreq: 0.6,        // ...and on at least this share of them
  maxMadMin: 45,       // median absolute deviation of the eating time (minutes): "consistent time"
  graceMin: 60,        // wait this long past the usual time before nudging
  maxLateMin: 240,     // stop nudging this long after the usual time
  activityDays: 7,     // user must have logged on >= minActiveDays of the last N days
  minActiveDays: 3,
  quietStartMin: 21 * 60 + 30, // no reminders from 21:30 ...
  quietEndMin: 7 * 60,         // ... until 07:00 (local time)
  maxItems: 3,         // at most this many foods in one email
};

const pad = (n) => String(n).padStart(2, '0');

export function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = parseInt(p.value, 10);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute };
}

/** Local wall-clock time in `tz` -> real Date. */
export function zonedToDate(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    guess -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - want;
  }
  return new Date(guess);
}

export function localNow(date, tz) {
  const p = tzParts(date, tz);
  return { iso: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, minutes: p.h * 60 + p.mi };
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function dayTypeOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}

/** '07:30 AM' | '7:30pm' | '19:30' -> minutes after midnight (null if unparseable). */
export function parseTimeMin(t) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t || '');
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const ap = m[3] && m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}

export function fmtMin(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${pad(h % 12 === 0 ? 12 : h % 12)}:${pad(m)} ${ap}`;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

export const habitKey = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * @param entries  journal entries: { name, date:'YYYY-MM-DD', time:'07:30 AM', mealType }
 * @param ctx      { todayIso, nowMin }  (the person's local date and minutes after midnight)
 * @param options  overrides for DEFAULTS
 * @returns { habits, due, skipped }  `skipped` is a reason string when no reminders should be sent at all
 */
export function detectHabits(entries, ctx, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { todayIso, nowMin } = ctx;
  const dayType = dayTypeOf(todayIso);
  const start = addDays(todayIso, -o.windowDays);

  const past = entries.filter((e) => e.date && e.date >= start && e.date < todayIso);
  const todayNames = new Set(
    entries.filter((e) => e.date === todayIso).map((e) => String(e.name).toLowerCase().trim())
  );

  // Is the person actively logging?
  const recentStart = addDays(todayIso, -o.activityDays);
  const activeDays = new Set(past.filter((e) => e.date >= recentStart).map((e) => e.date)).size;
  if (activeDays < o.minActiveDays) {
    return { habits: [], due: [], skipped: `inactive (logged on ${activeDays} of the last ${o.activityDays} days)` };
  }

  // Only compare like with like: weekdays with weekdays, weekends with weekends.
  const same = past.filter((e) => dayTypeOf(e.date) === dayType);
  const loggedDays = new Set(same.map((e) => e.date)).size;
  if (loggedDays < o.minLoggedDays) {
    return { habits: [], due: [], skipped: `not enough ${dayType} history (${loggedDays} logged days)` };
  }

  const byFood = new Map();
  for (const e of same) {
    const name = String(e.name).trim();
    const k = name.toLowerCase();
    const min = parseTimeMin(e.time);
    if (min == null) continue;
    if (!byFood.has(k)) byFood.set(k, { name, days: new Set(), mins: [], meals: new Map() });
    const g = byFood.get(k);
    g.days.add(e.date);
    g.mins.push(min);
    g.meals.set(e.mealType, (g.meals.get(e.mealType) || 0) + 1);
  }

  const habits = [];
  for (const [k, g] of byFood) {
    const foodDays = g.days.size;
    const freq = foodDays / loggedDays;
    if (foodDays < o.minFoodDays || freq < o.minFreq) continue;
    const typical = median(g.mins);
    const mad = median(g.mins.map((m) => Math.abs(m - typical)));
    if (mad > o.maxMadMin) continue;
    const mealType = [...g.meals.entries()].sort((a, b) => b[1] - a[1])[0][0];
    habits.push({ key: habitKey(g.name), name: g.name, mealType, foodDays, loggedDays, freq, typicalMin: Math.round(typical), madMin: Math.round(mad), loggedToday: todayNames.has(k) });
  }
  habits.sort((a, b) => b.freq - a.freq || a.typicalMin - b.typicalMin);

  if (nowMin >= o.quietStartMin || nowMin < o.quietEndMin) {
    return { habits, due: [], skipped: 'quiet hours' };
  }

  const due = habits
    .filter((h) => !h.loggedToday)
    .filter((h) => nowMin >= h.typicalMin + o.graceMin && nowMin <= h.typicalMin + o.maxLateMin)
    .slice(0, o.maxItems);

  return { habits, due, skipped: null };
}
