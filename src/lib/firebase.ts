import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

// Log config to debug injection
const config = firebaseConfig as any;
const dbId = config.firestoreDatabaseId || '(default)';

console.log('[Firebase] Project ID:', config.projectId);
console.log('[Firebase] Database ID:', dbId);

const app = initializeApp(config);

// Initialize Firestore with robust multi-tab persistent offline cache
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
}, dbId);

export const auth = getAuth(app);

// Enable browser local persistence so user stays signed in indefinitely across sessions
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('[Firebase Auth] Failed to set browserLocalPersistence:', err);
});

export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
// Request Google Drive file scope for permanent user storage
googleProvider.addScope('https://www.googleapis.com/auth/drive.file');
googleProvider.setCustomParameters({
  access_type: 'offline',
  prompt: 'select_account'
});

