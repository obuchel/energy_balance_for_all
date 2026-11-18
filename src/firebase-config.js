import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// Firebase project settings come from .env (never commit .env). Either naming works:
//   VITE_FIREBASE_API_KEY=...            or   REACT_APP_FIREBASE_API_KEY=...
//   ..._AUTH_DOMAIN, ..._PROJECT_ID, ..._STORAGE_BUCKET, ..._MESSAGING_SENDER_ID, ..._APP_ID
// Get them from Firebase console > Project settings > General > Your apps > SDK setup and configuration.
// Set ALL of them when switching projects (a half-switched config mixes two projects).
// Anything unset falls back to the previous energy-project-62508 values.
const env = import.meta.env;
const pick = (name, fallback) =>
  env[`VITE_FIREBASE_${name}`] || env[`REACT_APP_FIREBASE_${name}`] || fallback;

const firebaseConfig = {
  apiKey: pick("API_KEY"),
  authDomain: pick("AUTH_DOMAIN", "energy-project-62508.firebaseapp.com"),
  projectId: pick("PROJECT_ID", "energy-project-62508"),
  storageBucket: pick("STORAGE_BUCKET", "energy-project-62508.firebasestorage.app"),
  messagingSenderId: pick("MESSAGING_SENDER_ID", "916569823995"),
  appId: pick("APP_ID", "1:916569823995:web:ddf82199b5a47c618c6e5e"),
};

if (!firebaseConfig.apiKey) {
  console.error(
    "Firebase API key missing: set VITE_FIREBASE_API_KEY (or REACT_APP_FIREBASE_API_KEY) in .env and restart the dev server."
  );
}
console.info("Firebase project:", firebaseConfig.projectId);

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
