import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, getDocs, doc, setDoc, Timestamp } from 'firebase/firestore';
import { auth, db } from '../../firebase-config';

/**
 * /quick-log?food=<name>&meal=<mealType>
 * Target of the "Yes, log it" button in reminder emails. Copies the person's most recent entry for that
 * food into today's journal (same serving and nutrients), stamped with the current time.
 *
 * Safety: it runs in the browser as the signed-in user, so Firestore rules decide what is allowed (a user can
 * only write their own journal). The entry id is derived from the date and food, so clicking the link twice,
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

export default function QuickLog() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const food = (params.get('food') || '').trim();
  const meal = (params.get('meal') || '').trim();

  const [status, setStatus] = useState('working'); // working | done | already | missing | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!food) { setStatus('error'); setMessage('This link is missing the food name.'); return undefined; }

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        // Not signed in: remember where to come back to, then sign in.
        try {
          sessionStorage.setItem('postLoginRedirect', `/quick-log${location.search}`);
          // Firebase says nobody is signed in; drop any stale local copy so /login does not bounce us to the dashboard.
          localStorage.removeItem('userData');
        } catch { /* ignore */ }
        navigate('/login', { replace: true });
        return;
      }
      try {
        const col = collection(db, 'users', user.uid, 'food_journal');
        const snap = await getDocs(query(col, where('name', '==', food)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const today = todayLocal();

        if (rows.some((r) => r.date === today)) {
          setStatus('already');
          setMessage(`${food} is already in today's journal.`);
          return;
        }
        if (!rows.length) {
          setStatus('missing');
          setMessage(`I couldn't find an earlier entry for ${food} to copy.`);
          return;
        }

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
        setStatus('done');
        setMessage(`Logged ${food} for today.`);
      } catch (err) {
        console.error('Quick log failed:', err);
        setStatus('error');
        setMessage(err.code === 'permission-denied'
          ? 'You are not allowed to do that. Please sign in with the account that received the email.'
          : 'Something went wrong. Please open the app and log it there.');
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [food, meal]);

  const box = { maxWidth: 440, margin: '12vh auto', padding: 28, background: '#fff', borderRadius: 16,
    boxShadow: '0 4px 24px rgba(30,50,120,.12)', textAlign: 'center', fontFamily: 'inherit' };
  const btn = { marginTop: 18, padding: '10px 18px', border: 'none', borderRadius: 10, background: '#3b6ef5',
    color: '#fff', fontSize: 15, cursor: 'pointer' };

  return (
    <div style={box}>
      {status === 'working' && <p>Logging…</p>}
      {status !== 'working' && (
        <>
          <div style={{ fontSize: 40 }}>{status === 'done' ? '✅' : status === 'already' ? '👍' : '⚠️'}</div>
          <h2 style={{ margin: '8px 0' }}>{status === 'done' ? 'Done' : status === 'already' ? 'Already logged' : 'Could not log'}</h2>
          <p>{message}</p>
          <button style={btn} onClick={() => navigate('/food-tracker')}>
            {status === 'done' || status === 'already' ? 'Open my journal' : 'Open Add Food'}
          </button>
        </>
      )}
    </div>
  );
}
