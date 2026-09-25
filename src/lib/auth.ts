import { auth, googleProvider, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { safeStorage } from './safe-storage';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ADMIN_CONFIG } from '../config';

export interface VirtualUser {
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  uid: string;
  getIdToken: () => Promise<string>;
}

// Cache the access token and refresh token in memory and local storage.
let cachedAccessToken: string | null = safeStorage.getItem('google_access_token');
let cachedRefreshToken: string | null = safeStorage.getItem('google_refresh_token');
let isSigningIn = false;

// Helpers to synchronize user Gemini API key to Firestore securely
export const syncUserKeyFromFirestore = async (email: string): Promise<string | null> => {
  if (!email) return null;
  const cleanEmail = email.trim().toLowerCase();
  try {
    const docRef = doc(db, 'user_keys', cleanEmail);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      if (data && data.apiKey) {
        safeStorage.setItem('user_gemini_api_key', data.apiKey);
        console.log('[KeySync] Successfully synchronized API key from Firestore for email:', cleanEmail);
        return data.apiKey;
      }
    }
  } catch (err) {
    console.warn('[KeySync] Failed to fetch user key from firestore:', err);
  }
  return null;
};

export const saveUserKeyToFirestore = async (email: string, apiKey: string): Promise<void> => {
  if (!email) return;
  const cleanEmail = email.trim().toLowerCase();
  const cleanKey = apiKey.trim();
  try {
    const docRef = doc(db, 'user_keys', cleanEmail);
    await setDoc(docRef, {
      apiKey: cleanKey,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    if (cleanKey) {
      safeStorage.setItem('user_gemini_api_key', cleanKey);
      console.log('[KeySync] Saved API key to Firestore for email:', cleanEmail);
    } else {
      safeStorage.removeItem('user_gemini_api_key');
    }
  } catch (err) {
    console.error('[KeySync] Failed to save user key to firestore:', err);
    throw err;
  }
};

export const syncTokensFromFirestore = async (email: string): Promise<void> => {
  if (!email) return;
  const cleanEmail = email.trim().toLowerCase();
  try {
    const docRef = doc(db, 'user_tokens', cleanEmail);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      if (data.refreshToken && !safeStorage.getItem('google_refresh_token')) {
        safeStorage.setItem('google_refresh_token', data.refreshToken);
        cachedRefreshToken = data.refreshToken;
      }
      if (data.clientId && !safeStorage.getItem('google_client_id')) {
        safeStorage.setItem('google_client_id', data.clientId);
      }
      if (data.accessToken && !safeStorage.getItem('google_access_token')) {
        safeStorage.setItem('google_access_token', data.accessToken);
        cachedAccessToken = data.accessToken;
      }
      console.log('[Auth] Tokens synchronized from Firestore for:', cleanEmail);
    }
  } catch (err) {
    console.warn('[Auth] Error syncing tokens from Firestore:', err);
  }
};

export const deleteUserKeyFromFirestore = async (email: string): Promise<void> => {
  if (!email) return;
  const cleanEmail = email.trim().toLowerCase();
  try {
    const docRef = doc(db, 'user_keys', cleanEmail);
    await setDoc(docRef, {
      apiKey: '',
      updatedAt: new Date().toISOString()
    }, { merge: true });
    safeStorage.removeItem('user_gemini_api_key');
    console.log('[KeySync] Cleared API key from Firestore for email:', cleanEmail);
  } catch (err) {
    console.error('[KeySync] Failed to delete user key from firestore:', err);
    throw err;
  }
};

export const initAuth = (
  onAuthSuccess?: (user: any, token: string) => void,
  onAuthFailure?: () => void
) => {
  // First, check if there is a local email login stored
  const localEmail = safeStorage.getItem('local_auth_user_email');
  if (localEmail) {
    const localName = safeStorage.getItem('local_auth_user_name') || localEmail.split('@')[0];
    const virtualUser: VirtualUser = {
      email: localEmail,
      displayName: localName,
      photoURL: null,
      uid: auth.currentUser ? auth.currentUser.uid : 'local-' + btoa(localEmail),
      getIdToken: async () => auth.currentUser ? auth.currentUser.getIdToken() : 'local-user-email:' + localEmail,
    };
    cachedAccessToken = 'local-dummy-token';

    // Synchronize Key & Tokens in background
    syncUserKeyFromFirestore(localEmail);
    syncTokensFromFirestore(localEmail);

    if (onAuthSuccess) {
      setTimeout(() => onAuthSuccess(virtualUser, 'local-dummy-token'), 50);
    }
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    const activeLocalEmail = safeStorage.getItem('local_auth_user_email');
    if (activeLocalEmail) {
      // If we have a local email login and an active firebase auth, sync the UID
      if (user && onAuthSuccess) {
        const localName = safeStorage.getItem('local_auth_user_name') || activeLocalEmail.split('@')[0];
        const updatedVirtualUser: VirtualUser = {
          email: activeLocalEmail,
          displayName: localName,
          photoURL: null,
          uid: user.uid,
          getIdToken: async () => user.getIdToken(),
        };
        onAuthSuccess(updatedVirtualUser, cachedAccessToken || 'local-dummy-token');
      }
      return;
    }

    if (user) {
      if (user.email) {
        syncUserKeyFromFirestore(user.email);
        syncTokensFromFirestore(user.email);
        // Attempt background silent token refresh on app init
        refreshAccessTokenServer(user.email).catch(e => console.warn('[AuthInit] Silent refresh warning:', e));
      }
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else {
        const storedToken = safeStorage.getItem('google_access_token');
        if (storedToken && onAuthSuccess) {
          cachedAccessToken = storedToken;
          onAuthSuccess(user, storedToken);
        } else if (onAuthFailure) {
          onAuthFailure();
        }
      }
    } else {
      cachedAccessToken = null;
      safeStorage.removeItem('google_access_token');
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string; refreshToken?: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Firebase Auth');
    }

    cachedAccessToken = credential.accessToken;
    safeStorage.setItem('google_access_token', cachedAccessToken);
    safeStorage.setItem('google_token_time', Date.now().toString());

    const tokenResponse = (result as any)._tokenResponse;
    const refreshToken = tokenResponse?.oauthRefreshToken || tokenResponse?.refreshToken || (credential as any)?.refreshToken || (result.user as any)?.stsTokenManager?.refreshToken;
    if (refreshToken) {
      cachedRefreshToken = refreshToken;
      safeStorage.setItem('google_refresh_token', refreshToken);
    }

    let clientId = tokenResponse?.clientId;
    const idTokenStr = tokenResponse?.idToken || tokenResponse?.oauthIdToken || (credential as any)?.idToken;
    if (!clientId && idTokenStr && typeof idTokenStr === 'string') {
      try {
        const parts = idTokenStr.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload && payload.aud) {
            clientId = payload.aud;
          }
        }
      } catch (e) {
        console.warn('[Auth] Error extracting client_id from idToken:', e);
      }
    }
    if (clientId) {
      safeStorage.setItem('google_client_id', clientId);
      console.log('[Auth] Google OAuth client_id extracted and saved:', clientId);
    }

    // Synchronize local / virtual session state with Google Login
    if (result.user.email) {
      const cleanEmail = result.user.email.trim().toLowerCase();
      safeStorage.setItem('local_auth_user_email', cleanEmail);
      if (result.user.displayName) {
        safeStorage.setItem('local_auth_user_name', result.user.displayName);
      }

      try {
        const docRef = doc(db, 'user_tokens', cleanEmail);
        await setDoc(docRef, {
          email: cleanEmail,
          accessToken: cachedAccessToken,
          refreshToken: cachedRefreshToken || '',
          clientId: clientId || safeStorage.getItem('google_client_id') || '',
          updatedAt: new Date().toISOString()
        }, { merge: true });
        console.log('[Auth] Google tokens saved to Firestore successfully for:', cleanEmail);
      } catch (err) {
        console.warn('[Auth] Failed to save user tokens to Firestore:', err);
      }

      // Fetch key from Firestore in background
      await syncUserKeyFromFirestore(cleanEmail);
    }

    return { user: result.user, accessToken: cachedAccessToken, refreshToken: cachedRefreshToken || undefined };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const emailSignIn = async (email: string, name?: string): Promise<{ user: VirtualUser; accessToken: string }> => {
  const cleanEmail = email.trim().toLowerCase();
  
  if (cleanEmail === ADMIN_CONFIG.email.toLowerCase() || cleanEmail === 'alwaelai2000@gmail.com') {
    throw new Error('غير مسموح بتسجيل الدخول كأدمن ببريد المسؤول إلا عبر حساب غوغل الرسمي لحماية الأمان!');
  }

  const cleanName = name?.trim() || cleanEmail.split('@')[0];

  safeStorage.setItem('local_auth_user_email', cleanEmail);
  safeStorage.setItem('local_auth_user_name', cleanName);

  const virtualUser: VirtualUser = {
    email: cleanEmail,
    displayName: cleanName,
    photoURL: null,
    uid: auth.currentUser ? auth.currentUser.uid : 'local-' + btoa(cleanEmail),
    getIdToken: async () => auth.currentUser ? auth.currentUser.getIdToken() : 'local-user-email:' + cleanEmail,
  };

  cachedAccessToken = 'local-dummy-token';
  safeStorage.setItem('google_access_token', 'local-dummy-token');

  // Fetch key from Firestore in background
  await syncUserKeyFromFirestore(cleanEmail);

  return { user: virtualUser, accessToken: 'local-dummy-token' };
};

export const getAccessToken = (): string | null => {
  const token = safeStorage.getItem('google_access_token');
  if (token && token !== 'local-dummy-token') {
    return token;
  }
  return cachedAccessToken;
};

export const getRefreshToken = (): string | null => {
  const token = safeStorage.getItem('google_refresh_token');
  return token || cachedRefreshToken;
};

export const updateAccessToken = (newToken: string) => {
  if (newToken && newToken !== 'local-dummy-token') {
    cachedAccessToken = newToken;
    safeStorage.setItem('google_access_token', newToken);
    safeStorage.setItem('google_token_time', Date.now().toString());
  }
};

/**
 * Ensures we have an active, non-expired Google OAuth access token.
 * If missing or expired (> 45 minutes old), attempts server refresh or googleSignIn interactive prompt.
 */
export const ensureValidAccessToken = async (forceInteractive = false): Promise<string | null> => {
  let currentToken = getAccessToken();
  const tokenTimeStr = safeStorage.getItem('google_token_time');
  const tokenTime = tokenTimeStr ? parseInt(tokenTimeStr, 10) : 0;
  const isExpiredOrStale = !tokenTime || (Date.now() - tokenTime > 45 * 60 * 1000); // older than 45 mins

  if (!currentToken || currentToken === 'local-dummy-token' || isExpiredOrStale || forceInteractive) {
    console.log('[Auth] Access token is missing, stale, or forced refresh requested. Attempting server silent refresh...');
    const refreshed = await refreshAccessTokenServer();
    if (refreshed) {
      return refreshed;
    }

    // If server refresh fails, attempt popup googleSignIn if user interaction is active or requested
    if (forceInteractive || isExpiredOrStale || !currentToken) {
      try {
        console.log('[Auth] Server refresh unavailable. Attempting popup googleSignIn renewal...');
        const res = await googleSignIn();
        if (res?.accessToken) {
          return res.accessToken;
        }
      } catch (e) {
        console.warn('[Auth] Interactive googleSignIn failed:', e);
      }
    }
  }

  return currentToken;
};

export const refreshAccessTokenServer = async (userEmail?: string): Promise<string | null> => {
  try {
    const refreshToken = getRefreshToken();
    const clientId = safeStorage.getItem('google_client_id') || undefined;
    const currentUser = getCurrentUser();
    const email = userEmail || currentUser?.email || safeStorage.getItem('local_auth_user_email') || '';

    const isNetlify = typeof window !== 'undefined' && window.location.hostname.includes('netlify');
    const isStaticHost = 
      !isNetlify && typeof window !== 'undefined' && (
        window.location.hostname.includes('github') || 
        window.location.hostname.includes('vercel') ||
        (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app'))
      );

    const backendBaseUrl = isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';

    console.log('[Auth] Executing silent server-side token refresh...');
    const res = await fetch(`${backendBaseUrl}/api/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, clientId, email })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.accessToken) {
        updateAccessToken(data.accessToken);
        console.log('[Auth] Access token refreshed silently via server backend!');
        return data.accessToken;
      }
    } else {
      console.warn('[Auth] Silent token refresh server endpoint returned status:', res.status);
    }
  } catch (err) {
    console.warn('[Auth] Exception during silent server token refresh:', err);
  }
  return null;
};

export const getCurrentUser = (): any => {
  const localEmail = safeStorage.getItem('local_auth_user_email');
  const firebaseUser = auth.currentUser;

  if (firebaseUser && (!localEmail || firebaseUser.email === localEmail)) {
    return firebaseUser;
  }

  if (localEmail) {
    const localName = safeStorage.getItem('local_auth_user_name') || localEmail.split('@')[0];
    const virtualUser: VirtualUser = {
      email: localEmail,
      displayName: localName,
      photoURL: null,
      uid: firebaseUser ? firebaseUser.uid : 'local-' + btoa(localEmail),
      getIdToken: async () => firebaseUser ? firebaseUser.getIdToken() : 'local-user-email:' + localEmail,
    };
    return virtualUser;
  }
  return firebaseUser;
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  cachedRefreshToken = null;
  safeStorage.removeItem('google_access_token');
  safeStorage.removeItem('google_refresh_token');
  safeStorage.removeItem('user_gemini_api_key');
  safeStorage.removeItem('local_auth_user_email');
  safeStorage.removeItem('local_auth_user_name');
};
