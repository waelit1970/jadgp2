import { uploadToDrive, deleteFromDrive, extractFileIdFromUrl } from './drive';
import { getAccessToken, ensureValidAccessToken, googleSignIn } from './auth';
import { injectPromptIntoImage } from './metadata-injector';
import { smartCompressImage } from './imageCompressor';

/**
 * Safely upload an image with 100% original dimensions and smart loss-free compression directly to Google Drive.
 * Media files (video and audio) take the same Google Drive path — Cloudflare R2 was REMOVED (2026-09),
 * so there is no other storage backend, no R2 keys and no bucket to bind.
 * Includes optional prompt metadata injection into PNG/JPEG files prior to upload.
 */
export async function uploadPostImage(file: File, userId: string, prompt?: string, onProgress?: (percent: number) => void): Promise<string> {
  let token = await ensureValidAccessToken();
  if (!token || token === 'local-dummy-token') {
    console.log('[UploadHelper] No active token found, attempting popup googleSignIn...');
    try {
      const signRes = await googleSignIn();
      if (signRes?.accessToken) {
        token = signRes.accessToken;
      }
    } catch (e) {
      console.warn('[UploadHelper] Popup googleSignIn failed:', e);
    }
  }

  if (!token || token === 'local-dummy-token') {
    throw new Error('لم يتم العثور على جلسة غوغل نشطة. يرجى تسجيل الدخول بحساب غوغل أولاً.');
  }

  try {
    let finalFile = file;

    // Apply smart in-browser compression to images (preserves 100% width/height dimensions while slashing file size)
    if (file.type && file.type.startsWith('image/') && file.type !== 'image/gif' && file.type !== 'image/svg+xml') {
      try {
        finalFile = await smartCompressImage(file, file.name);
      } catch (compErr) {
        console.warn('[UploadHelper] Smart compress fallback to original file:', compErr);
      }
    }

    if (prompt && prompt.trim()) {
      console.log('[UploadHelper] Injecting prompt metadata for file:', finalFile.name);
      finalFile = await injectPromptIntoImage(finalFile, prompt);
    }

    console.log('[UploadHelper] Uploading to Google Drive at 100% original resolution:', finalFile.name, `(${(finalFile.size / 1024).toFixed(1)} KB)`);
    const driveUrl = await uploadToDrive(finalFile, token, onProgress);
    console.log('[UploadHelper] Google Drive upload succeeded:', driveUrl);
    return driveUrl;
  } catch (error: any) {
    console.error('[UploadHelper] Google Drive upload failed:', error);
    const errMsg = error.message || '';
    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('token') || errMsg.includes('expired') || errMsg.includes('UNAUTHENTICATED') || errMsg === 'AUTH_EXPIRED') {
      console.log('[UploadHelper] Access token expired during upload. Attempting interactive token renewal...');
      let newToken = await ensureValidAccessToken(true);
      if (!newToken) {
        try {
          const signRes = await googleSignIn();
          if (signRes?.accessToken) {
            newToken = signRes.accessToken;
          }
        } catch (authErr) {
          console.warn('[UploadHelper] Interactive renewal failed:', authErr);
        }
      }

      if (newToken) {
        console.log('[UploadHelper] Token renewed successfully! Retrying upload...');
        const driveUrl = await uploadToDrive(file, newToken, onProgress);
        return driveUrl;
      }
    }
    throw new Error(`فشل رفع الملف إلى Google Drive بالدقة الكاملة: ${error.message || error}`);
  }
}

/**
 * Safely delete any post file (images, videos, audio, documents, archives, etc.) from Google Drive.
 * Cloudflare R2 handling was REMOVED (2026-09): links left over from R2 simply cannot be deleted
 * anymore (the bucket is gone), so they are skipped instead of calling a dead endpoint.
 */
export async function deletePostImage(url: string, accessToken?: string | null): Promise<void> {
  if (!url) return;

  if (url.startsWith('data:image') || url.startsWith('data:')) {
    console.log('[UploadHelper] Delete: local Base64 content, skipping deletion');
    return;
  }

  const fileId = extractFileIdFromUrl(url);
  const isGoogleDriveUrl = fileId !== null || 
                           url.includes('drive.google.com') || 
                           url.includes('googleusercontent.com') || 
                           url.includes('googleapis.com') || 
                           url.includes('docs.google.com') ||
                           url.includes('/thumbnail?id=');

  if (isGoogleDriveUrl) {
    const activeToken = accessToken || getAccessToken();
    if (activeToken && activeToken !== 'local-dummy-token') {
      try {
        console.log('[UploadHelper] Delete: Removing file from Google Drive (ID:', fileId || 'unknown', '):', url);
        await deleteFromDrive(url, activeToken);
        console.log('[UploadHelper] Delete: Succeeded removing from Google Drive');
      } catch (err: any) {
        console.warn('[UploadHelper] Delete: Failed to remove from Google Drive:', err);
      }
    } else {
      console.log('[UploadHelper] Delete: Skipping Google Drive removal due to missing session token');
    }
  }
}
