import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';

const env = import.meta.env;

/**
 * Firebase WEB config — supplied entirely through environment variables.
 *
 * There is deliberately NO hard-coded fallback project: copy `.env.example` to
 * `.env` and fill in the values from your own Firebase Console
 * (Project Settings → General → Your apps → Web app → SDK setup and
 * configuration). Without them the app falls back to local mock data.
 */
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

/** True only when every required Firebase env var is present. */
const HAS_FIREBASE_CONFIG = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId,
);

// Allow forcing local mock mode via ?mock=1 (used for isolated QA runs so tests
// never touch real Firestore). Only honored in dev builds.
const forceMock =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('mock') === '1';

// Mock mode when explicitly requested, or whenever no Firebase project has been
// configured yet — so a fresh checkout still runs instead of crashing on boot.
export const USE_MOCK = forceMock || env.VITE_USE_MOCK === 'true' || !HAS_FIREBASE_CONFIG;

// A production build that asked for real Firebase but has no config to use.
export const MISCONFIGURED_PROD =
  !import.meta.env.DEV && env.VITE_USE_MOCK !== 'true' && !HAS_FIREBASE_CONFIG;

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

if (!USE_MOCK) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Offline-first: IndexedDB cache with multi-tab sync. Writes queue while
  // offline and flush automatically when connectivity returns.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
}

export { app, auth, db };
