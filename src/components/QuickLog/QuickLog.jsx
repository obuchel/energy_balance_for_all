import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, getDocs, doc, setDoc, Timestamp } from 'firebase/firestore';
import { auth, db } from '../../firebase-config';

/**
 * /quick-log?food=<name>&meal=<mealType>[&food=<name2>&meal=<meal2>...][&review=1]
 * Target of the buttons in reminder emails. Copies the person's most recent entry for each food
 * into today's journal (same serving and nutrients), stamped with the current time.
 *
 *   - one or more foods, no review=1  -> logs them all straight away ("Yes, log it" / "Log all")
 *   - review=1                        -> shows a checklist (all ticked) and logs only the ticked ones
 *
 * Safety: it runs in the browser as the signed-in user, so Firestore rules decide what is allowed (a user can
 * only write their own journal). The entry id is derived from the date and food, so clicking a link twice,
 * or reloading, never creates a duplicate.
 */

const pad = (n) => String(n).padStart(2, '0');
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeNow12 = () =>
  new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Log one food for today. Returns 'done' | 'already' | 'missing'.
async function logOne(user, food, meal) {
  const col = collection(db, 'users', user.uid, 'food_journal');
  const snap = await getDocs(query(col, where('name', '==', food)));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = todayLocal();

  if (rows.some((r) => r.date === today)) return 'already';
  if (!rows.length) return 'missing';

  const stamp = (r) => `${r.date || ''} ${r.createdAt?.seconds || 0}`;
  const last = rows.sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1))[0];
  // eslint-disable-next-line no-unused-vars
  const { id, createdAt, updatedAt, date, time, seeded, seedBatch, ...rest } = last;

  await setDoc(doc(col, `quick_${today}_${slug(food)}`), {
    ...rest,
    mealType: meal || rest.mealType || 'Snack',
    date: today,
    time: timeNow12(),
    createdAt: Timestamp.now(),
    loggedVia: 'reminder-email',
  });
  return 'done';
}

const LABEL = { done: 'Logged', already: "Already in today's journal", missing: 'No earlier entry to copy', error: 'Failed' };

export default function QuickLog() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const foods = params.getAll('food').map((s) => s.trim());
  const meals = params.getAll('meal').map((s) => s.trim());
  const review = params.get('review') === '1';
  const items = foods.map((food, i) => ({ food, meal: meals[i] || meals[0] || '' })).filter((x) => x.food);

  // working | review | done | error
  const [phase, setPhase] = useState('working');
  const [message, setMessage] = useState('');
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(() => items.map(() => true));
  const [results, setResults] = useState([]); // [{food, status}]
  const [busy, setBusy] = useState(false);

  const runLog = async (u, list) => {
    const out = [];
    for (const it of list) {
      try {
        out.push({ food: it.food, status: await logOne(u, it.food, it.meal) });
      } catch (err) {
        console.error('Quick log failed:', err);
        out.push({ food: it.food, status: 'error', code: err.code });
      }
    }
    setResults(out);
    setPhase('done');
  };

  useEffect(() => {
    if (!items.length) { setPhase('error'); setMessage('This link is missing the food name.'); return undefined; }

    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        // Not signed in: remember where to come back to, then sign in.
        try {
          sessionStorage.setItem('postLoginRedirect', `/quick-log${location.search}`);
          // Firebase says nobody is signed in; drop any stale local copy so /login does not bounce us to the dashboard.
          localStorage.removeItem('userData');
        } catch { /* ignore */ }
        navigate('/login', { replace: true });
        return;
      }
      setUser(u);
      if (review) { setPhase('review'); return; }
      await runLog(u, items);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const submitReview = async () => {
    const list = items.filter((_, i) => checked[i]);
    if (!list.length || !user) return;
    setBusy(true);
    setPhase('working');
    await runLog(user, list);
    setBusy(false);
  };

  const box = { maxWidth: 440, margin: '12vh auto', padding: 28, background: '#fff', borderRadius: 16,
    boxShadow: '0 4px 24px rgba(30,50,120,.12)', textAlign: 'left', fontFamily: 'inherit' };
  const btn = { marginTop: 18, padding: '10px 18px', border: 'none', borderRadius: 10, background: '#3b6ef5',
    color: '#fff', fontSize: 15, cursor: 'pointer' };
  const btn2 = { ...btn, background: '#eef0f6', color: '#1b2559', marginLeft: 8 };
  const center = { textAlign: 'center' };

  const anyDone = results.some((r) => r.status === 'done' || r.status === 'already');
  const denied = results.some((r) => r.code === 'permission-denied');

  return (
    <div style={box}>
      {phase === 'working' && <p style={center}>Logging…</p>}

      {phase === 'error' && (
        <div style={center}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <p>{message}</p>
          <button style={btn} onClick={() => navigate('/food-tracker')}>Open Add Food</button>
        </div>
      )}

      {phase === 'review' && (
        <>
          <h2 style={{ margin: '0 0 6px' }}>Did you have these today?</h2>
          <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 14 }}>Untick anything you skipped.</p>
          {items.map((it, i) => (
            <label key={`${it.food}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #eef0f6', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checked[i]}
                onChange={() => setChecked((c) => c.map((v, j) => (j === i ? !v : v)))}
                style={{ width: 20, height: 20 }}
              />
              <span style={{ fontSize: 16 }}>
                {it.food}
                {it.meal ? <span style={{ color: '#6b7280', fontSize: 13 }}> · {it.meal}</span> : null}
              </span>
            </label>
          ))}
          <button style={{ ...btn, opacity: checked.some(Boolean) && !busy ? 1 : 0.5 }}
            disabled={!checked.some(Boolean) || busy} onClick={submitReview}>
            Log selected ({checked.filter(Boolean).length})
          </button>
          <button style={btn2} onClick={() => navigate('/food-tracker')}>Cancel</button>
        </>
      )}

      {phase === 'done' && (
        <>
          <div style={{ ...center, fontSize: 40 }}>{anyDone ? '✅' : '⚠️'}</div>
          <h2 style={{ ...center, margin: '8px 0 12px' }}>{anyDone ? 'Done' : 'Could not log'}</h2>
          {results.map((r) => (
            <div key={r.food} style={{ padding: '6px 0', borderBottom: '1px solid #eef0f6' }}>
              <strong>{r.food}</strong>
              <span style={{ color: '#6b7280' }}> · {LABEL[r.status]}</span>
            </div>
          ))}
          {denied && (
            <p style={{ color: '#b45309', fontSize: 14 }}>
              You are not allowed to do that. Please sign in with the account that received the email.
            </p>
          )}
          <div style={center}>
            <button style={btn} onClick={() => navigate('/food-tracker')}>
              {anyDone ? 'Open my journal' : 'Open Add Food'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
