/**
 * أدوات تصنيف الميديا (فيديو / صوت) — ملف تصنيف نصي بحت.
 *
 * ملاحظة (2026-09): أُزيل كل اعتماد على Cloudflare R2 من التطبيق — لا رفع ولا حذف
 * ولا مفاتيح ولا دلو. الملفات (صور + فيديو + صوت) تُرفع إلى Google Drive من
 * upload-helper.ts، ولا يوجد في هذا الملف أي طلب شبكة إطلاقاً.
 *
 * تبقى دوال التصنيف لأن المنشورات القديمة قد تحتوي روابط r2.dev، ولا بد أن تُعرض
 * كفيديو/صوت كما كانت (isR2Url مطلوبة لـ isMediaVideoUrl فقط).
 */

export function isMediaFile(file: { name?: string; type?: string }): boolean {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  const isVideo = mime.startsWith('video/') || /\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv|m4v)$/i.test(name);
  const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|amr|wma|opus)$/i.test(name);

  return isVideo || isAudio;
}

/** روابط R2 القديمة (يرثها المنشورات السابقة) — للعرض فقط، بلا أي رفع أو حذف. */
export function isR2Url(url: string): boolean {
  if (!url) return false;
  return url.includes('r2.dev') || url.includes('r2.cloudflarestorage.com');
}

export function isMediaAudioUrl(url: string): boolean {
  if (!url) return false;
  try {
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    return /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|amr)($|\?)/i.test(cleanUrl) || /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|amr)($|\?)/i.test(url);
  } catch {
    return false;
  }
}

export function isMediaVideoUrl(url: string): boolean {
  if (!url) return false;
  try {
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    if (/\.(mp4|mkv|webm|m4v|mov|avi|3gp|wmv|flv|ogv)($|\?)/i.test(cleanUrl) || /\.(mp4|mkv|webm|m4v|mov|avi|3gp|wmv|flv|ogv)($|\?)/i.test(url)) {
      return true;
    }
    // روابط R2 القديمة بلا امتداد: نعتبرها فيديو ما لم تكن صوتاً أو صورة.
    if (isR2Url(url)) {
      if (isMediaAudioUrl(url)) return false;
      const isImg = /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)($|\?)/i.test(cleanUrl);
      if (isImg) return false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isMediaUrl(url: string): boolean {
  if (!url) return false;
  return isMediaVideoUrl(url) || isMediaAudioUrl(url);
}

export function getMediaNameFromUrl(url: string, defaultName = 'ملف ميديا'): string {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const rawName = cleanUrl.split('/').pop();
    if (!rawName) return defaultName;
    return decodeURIComponent(rawName);
  } catch {
    return defaultName;
  }
}

export function hasMediaInText(text: string): boolean {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const matches = text.match(urlRegex);
  if (!matches) return false;
  return matches.some(m => {
    const href = m.toLowerCase().startsWith('www.') ? `https://${m}` : m;
    return isMediaVideoUrl(href) || isMediaAudioUrl(href);
  });
}
