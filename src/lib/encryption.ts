import * as CryptoJSModule from 'crypto-js';

// Resolve default import differences (commonjs compatibility in Vite)
const CryptoJS = (CryptoJSModule as any).default || CryptoJSModule;

const E2EE_PREFIX = '__E2EE__:';

/**
 * Encrypts a string using AES-256 (via crypto-js) with a secret key.
 * Prepends our E2EE_PREFIX to identify the content as encrypted.
 */
export function encryptText(text: string, key: string): string {
  if (!text) return '';
  try {
    const encrypted = CryptoJS.AES.encrypt(text, key).toString();
    return E2EE_PREFIX + encrypted;
  } catch (err) {
    console.error('[E2EE] Encryption failed:', err);
    return text;
  }
}

/**
 * Decrypts a string using AES-256 (via crypto-js) if it is encrypted.
 * If the string doesn't start with E2EE_PREFIX, it is returned as is.
 * If decryption fails, returns a safe locked placeholder message.
 */
export function decryptText(cipherText: string, key: string): string {
  if (!cipherText) return '';
  if (!cipherText.startsWith(E2EE_PREFIX)) {
    return cipherText;
  }
  
  const rawCipher = cipherText.substring(E2EE_PREFIX.length);
  try {
    const decryptedBytes = CryptoJS.AES.decrypt(rawCipher, key);
    const plainText = decryptedBytes.toString(CryptoJS.enc.Utf8);
    if (!plainText) {
      // Empty string indicates wrong key/PIN or corrupt data
      return '🔒 منشور مشفر (يرجى التأكد من كلمة المرور)';
    }
    return plainText;
  } catch (err) {
    console.error('[E2EE] Decryption failed:', err);
    return '🔒 منشور مشفر (خطأ في فك التشفير)';
  }
}

/**
 * Encrypts an array of strings (e.g. fileNames, imageCaptions).
 */
export function encryptArray(arr: string[] | undefined | null, key: string): string[] {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map(item => encryptText(item, key));
}

/**
 * Decrypts an array of strings (e.g. fileNames, imageCaptions).
 */
export function decryptArray(arr: string[] | undefined | null, key: string): string[] {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map(item => decryptText(item, key));
}

/**
 * Hashes a string using SHA256 (via crypto-js).
 */
export function sha256(text: string): string {
  if (!text) return '';
  try {
    return CryptoJS.SHA256(text).toString();
  } catch (err) {
    console.error('[E2EE] Hashing failed:', err);
    return '';
  }
}

