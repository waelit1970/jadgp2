import { showToast } from '../components/Toast';

export type TranslationProvider = 'google' | 'cloudflare' | 'deepl';

export const TRANSLATION_PROVIDERS: {
  id: TranslationProvider;
  name: string;
  shortName: string;
  badge: string;
}[] = [
  { id: 'google', name: 'Google Translate', shortName: 'Google', badge: 'الافتراضي' },
  { id: 'cloudflare', name: 'Cloudflare AI', shortName: 'Cloudflare AI', badge: 'M2M-100' },
  { id: 'deepl', name: 'DeepL AI', shortName: 'DeepL AI', badge: 'دقة عالية' },
];

export function getSavedTranslationProvider(): TranslationProvider {
  try {
    const saved = localStorage.getItem('preferred_translation_provider');
    if (saved === 'cloudflare' || saved === 'deepl' || saved === 'google') {
      return saved;
    }
  } catch {}
  return 'google';
}

export function saveTranslationProvider(provider: TranslationProvider): void {
  try {
    localStorage.setItem('preferred_translation_provider', provider);
  } catch {}
}

/**
 * Robust multi-fallback online translation supporting:
 * 1. Server-side Proxy (/api/translate) with multi-layer Google & Open engines
 * 2. Client-side Google Translate Direct POST
 * 3. Client-side Google Translate Direct GET
 * 4. Client-side Lingva open-source mirrors
 * 5. Client-side MyMemory API
 */
export async function translateTextOnline(
  text: string,
  sl: string,
  tl: string,
  provider: TranslationProvider = 'google',
  signal?: AbortSignal
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // 1. Primary: High-speed Server-side Proxy (/api/translate)
  try {
    const srvRes = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: trimmed,
        sourceLang: sl,
        targetLang: tl,
        provider: provider,
      }),
      signal,
    });

    const data = await srvRes.json().catch(() => null);
    if (data && data.success && typeof data.text === 'string' && data.text.trim()) {
      return data.text;
    }

    if (data && !data.success && (provider === 'cloudflare' || provider === 'deepl')) {
      if (data.error === 'CLOUDFLARE_API_TOKEN_MISSING') {
        showToast('⚠️ يرجى ضبط CLOUDFLARE_API_TOKEN في السيرفر لتفعيل ترجمة Cloudflare AI.', 4000);
      } else if (data.error === 'DEEPL_API_KEY_MISSING') {
        showToast('⚠️ يرجى ضبط DEEPL_API_KEY في السيرفر لتفعيل ترجمة DeepL AI.', 4000);
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[Translation] Server proxy /api/translate failed, falling back to direct browser endpoints:`, err);
  }

  // 2. Client-side Fallback: Google Translate POST endpoint
  try {
    const params = new URLSearchParams();
    params.append('client', 'gtx');
    params.append('sl', sl || 'auto');
    params.append('tl', tl);
    params.append('dt', 't');
    params.append('q', text);

    const res = await fetch('https://translate.googleapis.com/translate_a/single', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: params.toString(),
      signal,
    });

    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data[0])) {
        const result = data[0]
          .map((item: any) => (item && typeof item[0] === 'string' ? item[0] : ''))
          .filter(Boolean)
          .join('');
        if (result && result.trim()) return result;
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
  }

  // 3. Client-side Fallback: Google Translate GET endpoint
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl || 'auto')}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data[0])) {
        const result = data[0]
          .map((item: any) => (item && typeof item[0] === 'string' ? item[0] : ''))
          .filter(Boolean)
          .join('');
        if (result && result.trim()) return result;
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
  }

  // 4. Client-side Fallback: Lingva Open Mirror endpoints
  const lingvaEndpoints = [
    'https://lingva.ml',
    'https://translate.plausibility.cloud',
  ];
  for (const host of lingvaEndpoints) {
    try {
      const lUrl = `${host}/api/v1/${encodeURIComponent(sl || 'auto')}/${encodeURIComponent(tl)}/${encodeURIComponent(trimmed)}`;
      const lRes = await fetch(lUrl, { signal });
      if (lRes.ok) {
        const lData = await lRes.json();
        if (lData && typeof lData.translation === 'string' && lData.translation.trim()) {
          return lData.translation;
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
    }
  }

  // 5. Client-side Fallback: MyMemory API (short phrases only)
  if (trimmed.length <= 500) {
    try {
      const myMemorySl = sl === 'auto' ? '' : sl;
      const langPair = myMemorySl ? `${myMemorySl}|${tl}` : `ar|${tl}`;
      const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${encodeURIComponent(langPair)}`;
      const res = await fetch(mmUrl, { signal });
      if (res.ok) {
        const data = await res.json();
        if (data && data.responseData && typeof data.responseData.translatedText === 'string') {
          const resTxt = data.responseData.translatedText;
          if (!resTxt.includes('QUERY LENGTH LIMIT EXCEEDED') && !resTxt.includes('MYMEMORY WARNING')) {
            return resTxt;
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
    }
  }

  return '';
}
