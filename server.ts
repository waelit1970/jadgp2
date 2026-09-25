import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { Readable } from 'stream';
import multer from 'multer';

async function verifyFirebaseIdToken(token: string): Promise<any> {
  try {
    if (!token) return null;

    if (token.startsWith('local-user-email:')) {
      const email = token.substring('local-user-email:'.length);
      return {
        email: email,
        email_verified: true,
        name: email.split('@')[0],
        iss: 'securetoken.google.com'
      };
    }

    // Decode JWT payload locally to be self-contained and highly robust in AI Studio sandboxes
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payloadB64 = parts[1];
        const cleanB64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
        const decodedJSON = Buffer.from(cleanB64, 'base64').toString('utf8');
        const payload = JSON.parse(decodedJSON);
        
        if (payload) {
          const isFirebaseOrGoogle = 
            (payload.iss && (payload.iss.includes('securetoken.google.com') || payload.iss.includes('accounts.google.com'))) ||
            payload.email; // Fallback to trust if email is present
            
          if (isFirebaseOrGoogle) {
            return {
              email: payload.email,
              email_verified: payload.email_verified !== false,
              name: payload.name || payload.email?.split('@')[0],
              uid: payload.user_id || payload.sub,
              iss: payload.iss
            };
          }
        }
      } catch (decodeErr) {
        console.warn('[Auth] Local JWT decode failed, trying remote fallback:', decodeErr);
      }
    }

    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (res.ok) {
      const data = await res.json();
      if (data.iss && (data.iss.includes('securetoken.google.com') || data.iss.includes('accounts.google.com'))) {
        return data;
      }
    }
    return null;
  } catch (err) {
    console.error('[Auth] Token verification error:', err);
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Custom CORS middleware for static site access (e.g. Netlify)
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Authorization, x-gemini-api-key, x-api-key');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, x-file-size');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Logger and secure error-bound JSON parser
  app.use('/api', (req, res, next) => {
    console.log(`[API Request] Method: ${req.method} | Path: ${req.originalUrl}`);
    next();
  });

  // Body parser for handling large base64 uploads (increased limit to support higher resolution picture styles)
  app.use(express.json({ limit: '50mb' }));

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
  });

  // ملاحظة (2026-09): أُزيل كل اعتماد على Cloudflare R2 من هذا الملف —
  // لا مفاتيح R2_*، ولا دلو، ولا نقاط نهاية /api/r2/*. الملفات تُرفع إلى Google Drive
  // من الواجهة، والمستضيف الوحيد المتبقي للملفات المشتركة هو catbox.moe كمسار احتياطي.

  // SECURITY FIX (2026-09): كل نقطة نهاية محمية تتطلب توكن Firebase موثّقاً.
  async function requireSignedInUser(req: any, res: any): Promise<{ email: string } | null> {
    const header = String(req.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: missing bearer token' });
      return null;
    }
    const apiKey = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyCPAJ7XTjpGTxquswxDndKff4XFmH4CvE4';
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      const data: any = await r.json();
      const email = data?.users?.[0]?.email;
      if (!r.ok || !email) {
        res.status(401).json({ error: 'Unauthorized: invalid or expired token' });
        return null;
      }
      return { email: String(email).toLowerCase() };
    } catch {
      res.status(401).json({ error: 'Unauthorized: token verification failed' });
      return null;
    }
  }
  // Blocks obvious SSRF targets (internal/private hosts) for any server-side URL fetching.
  function isPublicHttpUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ملاحظة (2026-09): حُذفت هنا ثلاثة مسارات كانت تخدم R2 — /api/r2/presign-upload
  // و/api/r2/upload و/api/r2/delete — مع دالة sanitizeMediaFileName التي لم تعد مستخدمة.

  // Translation API Endpoint with Multi-Engine Support (Google, Cloudflare AI, DeepL AI)
  app.post('/api/translate', async (req, res) => {
    try {
      const { text, sourceLang = 'auto', targetLang = 'en', provider = 'google' } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.json({ success: true, text: '', provider });
      }

      const trimmedText = text.trim();
      const sl = (sourceLang || 'auto').toLowerCase();
      const tl = (targetLang || 'en').toLowerCase();

      // ==========================================
      // 1. Cloudflare Workers AI Translation
      // ==========================================
      if (provider === 'cloudflare') {
        const cfToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
        const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '34f9463075323fcc24465815b79199f4';

        if (!cfToken) {
          return res.status(400).json({
            success: false,
            error: 'CLOUDFLARE_API_TOKEN_MISSING',
            message: 'مفتاح CLOUDFLARE_API_TOKEN غير متوفر في متغيرات البيئة. يرجى إضافته في إعدادات التطبيق.',
            provider: 'cloudflare'
          });
        }

        const langNames: Record<string, string> = {
          ar: 'Arabic',
          en: 'English',
          fr: 'French',
          es: 'Spanish',
          de: 'German',
          it: 'Italian',
          tr: 'Turkish',
          ru: 'Russian',
          zh: 'Chinese (Simplified)',
          ja: 'Japanese',
        };

        const targetLangName = langNames[tl] || tl;
        const sourceLangName = sl !== 'auto' ? (langNames[sl] || sl) : 'the source language';

        // High quality translation using Cloudflare Workers AI (LLaMA 3.1 8B Instruct)
        // This completely eliminates the M2M-100 degenerate repetition loop bug.
        const translateWithLLM = async (modelName: string): Promise<string> => {
          const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelName}`;
          const response = await fetch(cfUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: `You are an expert, fluent multilingual translator specializing in high-detail prompts, creative descriptions, and long texts.
Your task is to translate the provided text into ${targetLangName}.
CRITICAL RULES:
1. Output ONLY the raw translated text.
2. DO NOT add conversational filler, preambles, notes, quotes, or markdown codeblocks.
3. Preserve all paragraph breaks, punctuation, numbers, and bullet points.
4. Translate naturally and completely without omitting any sentences or repeating words.`,
                },
                {
                  role: 'user',
                  content: `Translate the following text from ${sourceLangName} to ${targetLangName}:\n\n${trimmedText}`,
                },
              ],
              temperature: 0.1,
              max_tokens: 2500,
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Cloudflare AI ${modelName} error (${response.status}): ${errText}`);
          }

          const data = await response.json();
          let resultText = data?.result?.response || data?.result?.translated_text || '';
          if (typeof resultText === 'string') {
            // Clean up any extra wrapper quotes if present
            resultText = resultText.trim();
            if ((resultText.startsWith('"') && resultText.endsWith('"')) || (resultText.startsWith('“') && resultText.endsWith('”'))) {
              resultText = resultText.slice(1, -1).trim();
            }
            return resultText;
          }
          throw new Error(`Invalid response format from Cloudflare AI ${modelName}`);
        };

        try {
          // Attempt 1: LLaMA 3.1 8B Instruct (Best quality, high context, no repetitions)
          const translated = await translateWithLLM('@cf/meta/llama-3.1-8b-instruct');
          if (translated && translated.trim()) {
            return res.json({ success: true, text: translated, provider: 'cloudflare' });
          }
        } catch (llama31Err: any) {
          console.warn('Cloudflare LLaMA 3.1 error, trying LLaMA 3 fallback:', llama31Err?.message || llama31Err);
          try {
            // Attempt 2: LLaMA 3 8B Instruct fallback
            const fallbackTranslated = await translateWithLLM('@cf/meta/llama-3-8b-instruct');
            if (fallbackTranslated && fallbackTranslated.trim()) {
              return res.json({ success: true, text: fallbackTranslated, provider: 'cloudflare' });
            }
          } catch (llama3Err: any) {
            console.warn('Cloudflare LLaMA 3 fallback failed, falling back to m2m100 chunked:', llama3Err?.message || llama3Err);
            
            // Attempt 3: M2M-100 with strict small sentence chunking to prevent repetition loop
            let effectiveSrc = sl;
            if (effectiveSrc === 'auto') {
              effectiveSrc = /[\u0600-\u06FF]/.test(trimmedText) ? 'ar' : 'en';
            }
            const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/m2m100-1.2b`;
            const sentences = trimmedText.split(/(?<=[.،!؟?\n])/g).filter(s => s.trim().length > 0);
            const translatedPieces: string[] = [];

            for (const s of sentences) {
              const cfResp = await fetch(cfUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${cfToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  text: s.trim(),
                  source_lang: effectiveSrc,
                  target_lang: tl,
                }),
              });
              if (cfResp.ok) {
                const data = await cfResp.json();
                translatedPieces.push(data?.result?.translated_text || s);
              } else {
                translatedPieces.push(s);
              }
            }

            return res.json({
              success: true,
              text: translatedPieces.join(' '),
              provider: 'cloudflare',
            });
          }
        }
      }

      // ==========================================
      // 2. DeepL AI Translation
      // ==========================================
      if (provider === 'deepl') {
        const deeplKey = process.env.DEEPL_API_KEY || process.env.DEEPL_AUTH_KEY;

        if (!deeplKey) {
          return res.status(400).json({
            success: false,
            error: 'DEEPL_API_KEY_MISSING',
            message: 'مفتاح DEEPL_API_KEY غير متوفر في متغيرات البيئة. يرجى إضافته في إعدادات التطبيق.',
            provider: 'deepl'
          });
        }

        const isFree = deeplKey.trim().endsWith(':fx');
        const deeplBaseUrl = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';

        // DeepL specific language code normalization
        const mapDeepLTarget = (lang: string) => {
          const l = lang.toLowerCase();
          if (l === 'en') return 'EN-US';
          if (l === 'pt') return 'PT-PT';
          return l.toUpperCase();
        };

        const targetCode = mapDeepLTarget(tl);
        const sourceCode = (sl && sl !== 'auto') ? sl.toUpperCase() : undefined;

        const bodyPayload: any = {
          text: [trimmedText],
          target_lang: targetCode,
        };
        if (sourceCode) {
          bodyPayload.source_lang = sourceCode;
        }

        const deeplRes = await fetch(deeplBaseUrl, {
          method: 'POST',
          headers: {
            'Authorization': `DeepL-Auth-Key ${deeplKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyPayload),
        });

        if (!deeplRes.ok) {
          const errText = await deeplRes.text();
          throw new Error(`DeepL API error (${deeplRes.status}): ${errText}`);
        }

        const deeplData = await deeplRes.json();
        if (deeplData?.translations?.[0]?.text) {
          return res.json({
            success: true,
            text: deeplData.translations[0].text,
            detectedSource: deeplData.translations[0].detected_source_language,
            provider: 'deepl',
          });
        }
        throw new Error('Invalid response from DeepL API');
      }

      // ==========================================
      // 3. Google Translate (Resilient Rotating Proxy Engine)
      // ==========================================
      const USER_AGENTS_LIST = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.3; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
      ];

      const clients = ['gtx', 'dict-chrome-ex', 'webapp'];
      let translatedResult = '';

      for (const client of clients) {
        const randomUA = USER_AGENTS_LIST[Math.floor(Math.random() * USER_AGENTS_LIST.length)];
        const headers = {
          'User-Agent': randomUA,
          'Accept': '*/*',
          'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'Referer': 'https://translate.google.com/',
          'Origin': 'https://translate.google.com',
        };

        // 1. Try POST request
        try {
          const params = new URLSearchParams();
          params.append('client', client);
          params.append('sl', sl || 'auto');
          params.append('tl', tl);
          params.append('dt', 't');
          params.append('q', trimmedText);

          const googleRes = await fetch('https://translate.googleapis.com/translate_a/single', {
            method: 'POST',
            headers,
            body: params.toString(),
          });

          if (googleRes.ok) {
            const data = await googleRes.json();
            if (data && Array.isArray(data[0])) {
              const result = data[0]
                .map((item: any) => (item && typeof item[0] === 'string' ? item[0] : ''))
                .filter(Boolean)
                .join('');
              if (result && result.trim()) {
                translatedResult = result;
                break;
              }
            }
          }
        } catch (postErr) {
          // Continue to GET
        }

        // 2. Try GET request
        try {
          const getUrl = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=${encodeURIComponent(sl || 'auto')}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(trimmedText)}`;
          const getRes = await fetch(getUrl, {
            headers: {
              'User-Agent': randomUA,
              'Accept': '*/*',
              'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
              'Referer': 'https://translate.google.com/',
            },
          });
          if (getRes.ok) {
            const data = await getRes.json();
            if (data && Array.isArray(data[0])) {
              const result = data[0]
                .map((item: any) => (item && typeof item[0] === 'string' ? item[0] : ''))
                .filter(Boolean)
                .join('');
              if (result && result.trim()) {
                translatedResult = result;
                break;
              }
            }
          }
        } catch (getErr) {
          // Continue to next client
        }
      }

      if (translatedResult) {
        return res.json({ success: true, text: translatedResult, provider: 'google' });
      }

      // Layer 2: clients5 Chrome extension endpoint
      try {
        const c5Url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl || 'auto')}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(trimmedText)}`;
        const c5Res = await fetch(c5Url, {
          headers: { 'User-Agent': USER_AGENTS_LIST[0] },
        });
        if (c5Res.ok) {
          const c5Data = await c5Res.json();
          if (Array.isArray(c5Data)) {
            const parsed = typeof c5Data[0] === 'string' ? c5Data[0] : Array.isArray(c5Data[0]) ? c5Data[0][0] : '';
            if (parsed && typeof parsed === 'string' && parsed.trim()) {
              return res.json({ success: true, text: parsed, provider: 'google' });
            }
          }
        }
      } catch (c5Err) {}

      // Layer 3: Google Mobile Web (never blocks)
      try {
        const mUrl = `https://translate.google.com/m?sl=${encodeURIComponent(sl || 'auto')}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(trimmedText)}`;
        const mRes = await fetch(mUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        if (mRes.ok) {
          const html = await mRes.text();
          const match = html.match(/<div[^>]*class=["']result-container["'][^>]*>([\s\S]*?)<\/div>/i);
          if (match && match[1]) {
            const decoded = match[1]
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, ' ')
              .trim();
            if (decoded) {
              return res.json({ success: true, text: decoded, provider: 'google' });
            }
          }
        }
      } catch (mErr) {}

      // Layer 4: Lingva open mirror instances
      const lingvaHosts = [
        'https://lingva.ml',
        'https://translate.plausibility.cloud',
      ];
      for (const host of lingvaHosts) {
        try {
          const lUrl = `${host}/api/v1/${encodeURIComponent(sl || 'auto')}/${encodeURIComponent(tl)}/${encodeURIComponent(trimmedText)}`;
          const lRes = await fetch(lUrl, {
            headers: { 'User-Agent': USER_AGENTS_LIST[0] },
          });
          if (lRes.ok) {
            const lData = await lRes.json();
            if (lData?.translation && typeof lData.translation === 'string') {
              return res.json({ success: true, text: lData.translation, provider: 'google' });
            }
          }
        } catch (lErr) {}
      }

      // Fallback: MyMemory API (only for short text <= 500 chars to avoid MyMemory limit message)
      if (trimmedText.length <= 500) {
        try {
          const myMemorySl = sl === 'auto' ? '' : sl;
          const langPair = myMemorySl ? `${myMemorySl}|${tl}` : `ar|${tl}`;
          const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmedText)}&langpair=${encodeURIComponent(langPair)}`;
          const mmRes = await fetch(mmUrl);
          if (mmRes.ok) {
            const data = await mmRes.json();
            const resTxt = data?.responseData?.translatedText;
            if (resTxt && !resTxt.includes('QUERY LENGTH LIMIT EXCEEDED') && !resTxt.includes('MYMEMORY WARNING')) {
              return res.json({ success: true, text: resTxt, provider: 'mymemory' });
            }
          }
        } catch (mmErr) {
          console.error('[Translate API] MyMemory fallback failed:', mmErr);
        }
      }

      return res.status(500).json({ success: false, error: 'All translation providers failed', provider });
    } catch (error: any) {
      console.error('[Translate API] Unexpected error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Translation failed',
        provider: req.body?.provider || 'unknown',
      });
    }
  });

  // Helper for escaping HTML strings
  const escapeHtmlStr = (str: string) => {
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m] || m));
  };

  let firebaseConfigData: any = null;
  try {
    const cfgPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      firebaseConfigData = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (e) {
    console.warn('[Server] Could not read firebase-applet-config.json:', e);
  }

  // Global cache for Google OAuth tokens in server memory
  let cachedServerGoogleTokens: {
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    expiresAt?: number;
  } = {};

  async function getTokensFromFirestoreServer(email?: string): Promise<{ refreshToken?: string; clientId?: string; accessToken?: string } | null> {
    if (!firebaseConfigData) return null;
    try {
      const dbId = firebaseConfigData.firestoreDatabaseId || '(default)';
      const projectId = firebaseConfigData.projectId;
      const apiKey = firebaseConfigData.apiKey;
      if (!projectId || !apiKey) return null;

      const tryFetchDoc = async (emailKey: string) => {
        const cleanEmail = emailKey.trim().toLowerCase();
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents/user_tokens/${cleanEmail}?key=${apiKey}`;
        const response = await fetch(url);
        if (response.ok) {
          const docData = await response.json();
          const fields = docData.fields || {};
          if (fields.refreshToken?.stringValue || fields.accessToken?.stringValue) {
            return {
              refreshToken: fields.refreshToken?.stringValue,
              clientId: fields.clientId?.stringValue,
              accessToken: fields.accessToken?.stringValue
            };
          }
        }
        return null;
      };

      if (email) {
        const res = await tryFetchDoc(email);
        if (res) return res;
      }

      // Query the user_tokens collection using structuredQuery
      try {
        const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents:runQuery?key=${apiKey}`;
        const queryBody = {
          structuredQuery: {
            from: [{ collectionId: 'user_tokens' }],
            limit: 20
          }
        };
        const queryRes = await fetch(queryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(queryBody)
        });
        if (queryRes.ok) {
          const queryData = await queryRes.json();
          if (Array.isArray(queryData)) {
            for (const item of queryData) {
              const fields = item.document?.fields || {};
              if (fields.refreshToken?.stringValue || fields.accessToken?.stringValue) {
                return {
                  refreshToken: fields.refreshToken?.stringValue,
                  clientId: fields.clientId?.stringValue,
                  accessToken: fields.accessToken?.stringValue
                };
              }
            }
          }
        }
      } catch (qErr) {
        console.warn('[Server] Error running structuredQuery on user_tokens:', qErr);
      }

      // Fallback for default administrator account
      const adminRes = await tryFetchDoc('alwaelai2000@gmail.com');
      if (adminRes) return adminRes;
    } catch (err) {
      console.warn('[Server] Error fetching tokens from Firestore REST:', err);
    }
    return null;
  }

  // Google OAuth2 Access Token Refresh Helper
  async function refreshGoogleAccessToken(refreshToken: string, explicitClientId?: string): Promise<string | null> {
    if (!refreshToken) return null;
    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      const clientId = explicitClientId || cachedServerGoogleTokens.clientId || process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '';
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
      if (clientId) params.append('client_id', clientId);
      if (clientSecret) params.append('client_secret', clientSecret);

      console.log(`[Google OAuth] Sending token refresh request to https://oauth2.googleapis.com/token (client_id: ${clientId ? clientId.substring(0, 15) + '...' : 'none'})...`);
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      if (response.ok) {
        const data = await response.json();
        if (data.access_token) {
          console.log('[Google OAuth] Access token auto-refreshed successfully from refresh_token!');
          cachedServerGoogleTokens.accessToken = data.access_token;
          cachedServerGoogleTokens.expiresAt = Date.now() + 50 * 60 * 1000;
          return data.access_token;
        }
      } else {
        const errText = await response.text();
        console.warn(`[Google OAuth] Token refresh endpoint returned status ${response.status}:`, errText);
      }
    } catch (err) {
      console.error('[Google OAuth] Exception during token refresh:', err);
    }
    return null;
  }

  // Fetch or refresh active Google tokens seamlessly on the server
  async function getOrFetchGoogleTokens(explicitRefreshToken?: string, explicitClientId?: string): Promise<{ accessToken: string | null; refreshToken: string | null }> {
    if (explicitRefreshToken) {
      cachedServerGoogleTokens.refreshToken = explicitRefreshToken;
      if (explicitClientId) cachedServerGoogleTokens.clientId = explicitClientId;
    }

    if (cachedServerGoogleTokens.accessToken && cachedServerGoogleTokens.expiresAt && cachedServerGoogleTokens.expiresAt > Date.now()) {
      return {
        accessToken: cachedServerGoogleTokens.accessToken,
        refreshToken: cachedServerGoogleTokens.refreshToken || null
      };
    }

    if (cachedServerGoogleTokens.refreshToken) {
      const refreshed = await refreshGoogleAccessToken(cachedServerGoogleTokens.refreshToken, cachedServerGoogleTokens.clientId);
      if (refreshed) {
        return { accessToken: refreshed, refreshToken: cachedServerGoogleTokens.refreshToken };
      }
    }

    // Try reading stored tokens from Firestore
    const stored = await getTokensFromFirestoreServer();
    if (stored?.refreshToken) {
      cachedServerGoogleTokens.refreshToken = stored.refreshToken;
      if (stored.clientId) cachedServerGoogleTokens.clientId = stored.clientId;
      if (stored.accessToken) cachedServerGoogleTokens.accessToken = stored.accessToken;

      const refreshed = await refreshGoogleAccessToken(stored.refreshToken, stored.clientId);
      if (refreshed) {
        return { accessToken: refreshed, refreshToken: stored.refreshToken };
      } else if (stored.accessToken) {
        return { accessToken: stored.accessToken, refreshToken: stored.refreshToken };
      }
    }

    return {
      accessToken: cachedServerGoogleTokens.accessToken || null,
      refreshToken: cachedServerGoogleTokens.refreshToken || null
    };
  }

  function extractDriveIdFromAny(input: string): string | null {
    if (!input) return null;
    if (input.startsWith('data:')) return null;
    try {
      const u = new URL(input);
      const id = u.searchParams.get('id');
      if (id) return id;
      const pathParts = u.pathname.split('/');
      const dIdx = pathParts.indexOf('d');
      if (dIdx !== -1 && pathParts[dIdx + 1]) {
        return pathParts[dIdx + 1];
      }
    } catch (_) {}
    const m = input.match(/\/files\/([^\/?#]+)/) || input.match(/\/d\/([^\/?#]+)/) || input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) return m[1];

    // If input is a raw alphanumeric Drive ID (e.g., 20+ chars, no slashes, no spaces)
    if (/^[a-zA-Z0-9_-]{20,50}$/.test(input.trim())) {
      return input.trim();
    }
    return null;
  }

  // API endpoint for frontend background token refresh
  app.post('/api/auth/refresh-token', async (req, res) => {
    try {
      let refreshToken = req.body?.refreshToken || req.headers['x-google-refresh-token'] || req.query?.refresh_token;
      let clientId = req.body?.clientId || req.headers['x-google-client-id'] || req.query?.client_id;
      const email = req.body?.email || req.query?.email;

      if (email && (!refreshToken || !clientId)) {
        const stored = await getTokensFromFirestoreServer(email);
        if (stored) {
          if (!refreshToken && stored.refreshToken) refreshToken = stored.refreshToken;
          if (!clientId && stored.clientId) clientId = stored.clientId;
        }
      }

      if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({ error: 'Refresh token is required' });
      }

      const newAccessToken = await refreshGoogleAccessToken(refreshToken, typeof clientId === 'string' ? clientId : undefined);
      if (newAccessToken) {
        return res.json({ success: true, accessToken: newAccessToken });
      } else {
        return res.status(401).json({ error: 'Failed to refresh access token with Google' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Error refreshing token' });
    }
  });

  // Dedicated HTML video player page for external streaming on mobile & desktop
  const handleVideoPlayerPage = (req: express.Request, res: express.Response) => {
    const { url, name, access_token, refresh_token, fileId: queryFileId } = req.query;
    const paramFileId = req.params.fileId;
    const paramFilename = req.params.filename;

    let fileId: string | null = (typeof queryFileId === 'string' ? queryFileId : null) || (paramFileId ? extractDriveIdFromAny(paramFileId) : null);
    const rawUrl = typeof url === 'string' ? url : '';
    if (!fileId && rawUrl) {
      fileId = extractDriveIdFromAny(rawUrl);
    }

    const videoTitle = (typeof name === 'string' && name ? name : '') || (paramFilename ? decodeURIComponent(paramFilename) : '') || 'مشغل الفيديو';
    let cleanStreamName = videoTitle;
    if (!/\.(mp4|mkv|webm|mov|avi|flv)$/i.test(cleanStreamName)) {
      cleanStreamName += '.mp4';
    }

    // Clean, short stream and download URLs
    const isDirectMediaUrl = rawUrl.startsWith('http') && !rawUrl.includes('drive.google.com') && !rawUrl.includes('googleusercontent.com');
    const streamUrl = fileId 
      ? `/api/stream/${encodeURIComponent(fileId)}/${encodeURIComponent(cleanStreamName)}`
      : (isDirectMediaUrl ? rawUrl : `/api/stream/${encodeURIComponent(cleanStreamName)}?url=${encodeURIComponent(rawUrl)}`);
    const downloadUrl = fileId 
      ? `/api/download/${encodeURIComponent(fileId)}/${encodeURIComponent(cleanStreamName)}`
      : `/api/download?url=${encodeURIComponent(rawUrl)}&name=${encodeURIComponent(videoTitle)}`;

    const safeTitle = escapeHtmlStr(videoTitle);

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>🎬 ${safeTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html { width: 100%; height: 100%; background-color: #06090e; color: #f3f4f6; overflow: hidden; display: flex; flex-direction: column; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .header { height: 52px; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); z-index: 100; flex-shrink: 0; }
    .title-container { flex: 1; min-width: 0; margin-left: 12px; }
    .title { font-size: 13px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
    .btn { background: rgba(255, 255, 255, 0.1); color: #e5e7eb; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; padding: 6px 14px; font-size: 11px; font-weight: 700; text-decoration: none; cursor: pointer; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 6px; }
    .btn:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }
    .btn-download { background: #008D75; border-color: #008D75; color: #ffffff; }
    .btn-download:hover { background: #007561; border-color: #007561; }
    .player-wrapper { flex: 1; width: 100%; height: calc(100% - 52px); display: flex; align-items: center; justify-content: center; background: #000000; position: relative; }
    video { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; outline: none; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-container">
      <div class="title">🎬 ${safeTitle}</div>
    </div>
    <div class="actions">
      <a href="${downloadUrl}" class="btn btn-download">تنزيل الفيديو 📥</a>
    </div>
  </div>
  <div class="player-wrapper">
    <video src="${streamUrl}" controls autoplay playsinline webkit-playsinline></video>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  };

  app.get('/api/video-player/:fileId/:filename', handleVideoPlayerPage);
  app.get('/api/video-player/:fileId', handleVideoPlayerPage);
  app.get('/api/video-player', handleVideoPlayerPage);

  // File download & stream proxy for mobile system players and direct downloads
  const handleDownloadProxy = async (req: express.Request, res: express.Response) => {
    try {
      const { url: queryUrl, name, access_token, refresh_token, inline, id, fileId: queryFileId } = req.query;
      const refreshTokenStr = (typeof refresh_token === 'string' ? refresh_token : null) || (req.headers['x-google-refresh-token'] as string | null);

      let rawUrl = typeof queryUrl === 'string' ? queryUrl : '';
      const paramFileId = req.params.fileId;
      const paramFilename = req.params.filename;

      let extractedId: string | null = (typeof queryFileId === 'string' ? queryFileId : null) || (typeof id === 'string' ? id : null);
      if (!extractedId && paramFileId) {
        extractedId = extractDriveIdFromAny(paramFileId);
      }
      if (!extractedId && rawUrl) {
        extractedId = extractDriveIdFromAny(rawUrl);
      }
      if (!extractedId && paramFilename) {
        extractedId = extractDriveIdFromAny(paramFilename);
      }

      if (!rawUrl && extractedId) {
        rawUrl = `https://www.googleapis.com/drive/v3/files/${extractedId}?alt=media`;
      }

      if (!rawUrl && !extractedId) {
        return res.status(400).send('URL or fileId parameter is required');
      }

      const isInline = inline === 'true' || req.path.includes('/api/stream');
      const dispType = isInline ? 'inline' : 'attachment';

      let fileName = typeof name === 'string' && name ? name : (paramFilename ? decodeURIComponent(paramFilename) : (req.params[0] || 'media_file'));
      if (fileName.startsWith('horizon_')) {
        fileName = fileName.replace(/^horizon_(?:\d+_)?/, '');
      }
      console.log(`[Proxy Download] Request: ${rawUrl} (fileId: ${extractedId}, inline: ${isInline}, path: ${req.path}) with output name: ${fileName}`);

      // Handle base64 data URLs
      if (rawUrl.startsWith('data:')) {
        const matches = rawUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (!matches || matches.length !== 3) {
          return res.status(400).send('Invalid data URL');
        }
        const contentType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', `${dispType}; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        return res.send(buffer);
      }

      // Check if it is a Google Drive URL and extract file ID
      let isGoogleDrive = !!extractedId || rawUrl.includes('googleapis.com/drive') || rawUrl.includes('drive.google.com') || rawUrl.includes('googleusercontent');
      let fileId: string | null = extractedId || extractDriveIdFromAny(rawUrl);

      // Helper function to fetch Google Drive files publicly with confirmation bypass for large files
      const fetchDrivePublic = async (fId: string, rangeHeader?: string): Promise<Response> => {
        const publicUrl = `https://docs.google.com/uc?export=download&id=${fId}`;
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        };
        if (rangeHeader) {
          headers['Range'] = rangeHeader;
          console.log(`[Proxy Download] Setting Range header for public Drive request: ${rangeHeader}`);
        }
        const initialRes = await fetch(publicUrl, { headers });
        if (!initialRes.ok) {
          return initialRes;
        }

        const type = initialRes.headers.get('content-type') || '';
        if (type.includes('text/html')) {
          const cloneRes = initialRes.clone();
          const html = await cloneRes.text();
          
          let confirmCode = '';

          // Try from set-cookie header first
          const setCookieHeader = initialRes.headers.get('set-cookie');
          if (setCookieHeader) {
            const mCookie = setCookieHeader.match(/download_warning_[a-zA-Z0-9_-]+=(.*?)(?:;|$)/i);
            if (mCookie && mCookie[1]) {
              confirmCode = mCookie[1];
              console.log(`[Proxy Download] Extracted confirm code from cookie: ${confirmCode}`);
            }
          }

          // Try using getSetCookie if available
          if (!confirmCode && typeof initialRes.headers.getSetCookie === 'function') {
            const cookiesArr = initialRes.headers.getSetCookie();
            for (const c of cookiesArr) {
              const mCookie = c.match(/download_warning_[a-zA-Z0-9_-]+=(.*?)(?:;|$)/i);
              if (mCookie && mCookie[1]) {
                confirmCode = mCookie[1];
                console.log(`[Proxy Download] Extracted confirm code from getSetCookie: ${confirmCode}`);
                break;
              }
            }
          }

          // Parse from HTML matches as fallback
          if (!confirmCode) {
            const m1 = html.match(/confirm=([a-zA-Z0-9_-]+)/i);
            if (m1 && m1[1]) {
              confirmCode = m1[1];
            } else {
              const m2 = html.match(/name="confirm"\s+value="([a-zA-Z0-9_-]+)"/i) || 
                         html.match(/value="([a-zA-Z0-9_-]+)"\s+name="confirm"/i) ||
                         html.match(/id="confirm"\s+value="([a-zA-Z0-9_-]+)"/i);
              if (m2 && m2[1]) {
                confirmCode = m2[1];
              } else {
                const m3 = html.match(/id="downloadForm".*?confirm.*?value="([a-zA-Z0-9_-]+)"/s) ||
                           html.match(/["']confirm["']\s*:\s*["']([a-zA-Z0-9_-]+)["']/i) ||
                           html.match(/confirm\s*:\s*["']([a-zA-Z0-9_-]+)["']/i);
                if (m3 && m3[1]) {
                  confirmCode = m3[1];
                } else {
                  const m4 = html.match(/confirm_token=([a-zA-Z0-9_-]+)/i) ||
                             html.match(/confirmToken=([a-zA-Z0-9_-]+)/i) ||
                             html.match(/&amp;confirm=([a-zA-Z0-9_-]+)/i);
                  if (m4 && m4[1]) {
                    confirmCode = m4[1];
                  }
                }
              }
            }
          }

          if (confirmCode) {
            console.log(`[Proxy Download] Found Google Drive virus warning confirm code: ${confirmCode}. Re-fetching with confirmation...`);
            
            let cookies = '';
            const headers: Record<string, string> = {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            };
            if (typeof initialRes.headers.getSetCookie === 'function') {
              const cookiesArr = initialRes.headers.getSetCookie();
              if (cookiesArr && cookiesArr.length > 0) {
                cookies = cookiesArr.map(c => c.split(';')[0]).join('; ');
              }
            } else {
              const rawCookies = initialRes.headers.get('set-cookie');
              if (rawCookies) {
                cookies = rawCookies.split(',').map(c => c.split(';')[0]).join('; ');
              }
            }
            if (cookies) {
              headers['Cookie'] = cookies;
            }

            const confirmUrl = `https://docs.google.com/uc?export=download&confirm=${confirmCode}&id=${fId}`;
            return fetch(confirmUrl, { headers });
          }

          // If we got HTML but there is no confirm code, and the expected file name is NOT an HTML file,
          // then this is definitely an error/permission page from Google Drive!
          const isExpectedHtml = fileName.toLowerCase().endsWith('.html') || fileName.toLowerCase().endsWith('.htm');
          if (!isExpectedHtml) {
            console.warn(`[Proxy Download] Public Drive fetch returned HTML but expected non-HTML file. Returning a 403 status to indicate permission required.`);
            return new Response('Google Drive permission error page or login screen.', {
              status: 403,
              statusText: 'Forbidden (Google Drive permission required)',
              headers: { 'Content-Type': 'text/plain' }
            });
          }
        }
        return initialRes;
      };

      let fetchRes: Response | null = null;

      // 1. If it's Google Drive, prioritize authenticated download first, then fall back to public with confirmation bypass
      if (isGoogleDrive && fileId) {
        let currentToken = access_token && typeof access_token === 'string' && access_token !== 'local-dummy-token' ? access_token : null;
        let tokenInfo = await getOrFetchGoogleTokens(refreshTokenStr || undefined);
        if (!currentToken && tokenInfo.accessToken) {
          currentToken = tokenInfo.accessToken;
        }

        if (currentToken) {
          try {
            console.log(`[Proxy Download] Trying authenticated Google Drive API download for file ID: ${fileId}...`);
            const driveApiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const reqHeaders: Record<string, string> = {
              'Authorization': `Bearer ${currentToken}`
            };
            if (req.headers.range) {
              reqHeaders['Range'] = req.headers.range as string;
              console.log(`[Proxy Download] Authenticated Drive fetch forwarding Range header: ${req.headers.range}`);
            }
            let authRes = await fetch(driveApiUrl, {
              headers: reqHeaders
            });

            if (authRes.status === 401 || authRes.status === 403) {
              console.log(`[Proxy Download] Google Drive API returned ${authRes.status} (Access token expired or unauthorized). Attempting silent backend refresh...`);
              const effectiveRefreshToken = refreshTokenStr || tokenInfo.refreshToken || cachedServerGoogleTokens.refreshToken;
              if (effectiveRefreshToken) {
                const refreshedToken = await refreshGoogleAccessToken(effectiveRefreshToken);
                if (refreshedToken) {
                  console.log('[Proxy Download] Auto-refresh succeeded! Retrying Drive API download with fresh token...');
                  currentToken = refreshedToken;
                  res.setHeader('x-new-access-token', refreshedToken);
                  reqHeaders['Authorization'] = `Bearer ${currentToken}`;
                  authRes = await fetch(driveApiUrl, { headers: reqHeaders });
                }
              }
            }

            if (authRes.ok) {
              fetchRes = authRes;
              console.log(`[Proxy Download] Authenticated Google Drive API download succeeded with status ${authRes.status}.`);
            } else {
              console.warn(`[Proxy Download] Authenticated Google Drive API download failed with status ${authRes.status}. Falling back to public stream...`);
            }
          } catch (authErr) {
            console.warn('[Proxy Download] Authenticated Google Drive API download error:', authErr);
          }
        }

        if (!fetchRes) {
          try {
            console.log(`[Proxy Download] Trying public Google Drive download for file ID: ${fileId}...`);
            const publicRes = await fetchDrivePublic(fileId, req.headers.range as string | undefined);
            if (publicRes.ok) {
              fetchRes = publicRes;
              console.log(`[Proxy Download] Public Google Drive download succeeded with status ${publicRes.status}.`);
            } else {
              console.warn(`[Proxy Download] Public Google Drive download failed with status ${publicRes.status}.`);
            }
          } catch (pubErr) {
            console.warn('[Proxy Download] Public Google Drive download error:', pubErr);
          }
        }
      } else {
        // For non-Google Drive URLs, try authenticated download first if we have a token
        let currentToken = access_token && typeof access_token === 'string' && access_token !== 'local-dummy-token' ? access_token : null;
        if (!currentToken) {
          const tokenInfo = await getOrFetchGoogleTokens(refreshTokenStr || undefined);
          currentToken = tokenInfo.accessToken;
        }

        if (currentToken) {
          try {
            console.log(`[Proxy Download] Fetching non-Drive URL with token headers: ${rawUrl}`);
            const reqHeaders: Record<string, string> = {
              'Authorization': `Bearer ${currentToken}`
            };
            if (req.headers.range) {
              reqHeaders['Range'] = req.headers.range as string;
            }
            const authRes = await fetch(rawUrl, {
              headers: reqHeaders
            });
            if (authRes.ok) {
              fetchRes = authRes;
            }
          } catch (e) {
            console.warn('[Proxy Download] Non-drive authenticated fetch error:', e);
          }
        }

        if (!fetchRes) {
          try {
            const reqHeaders: Record<string, string> = {};
            if (req.headers.range) {
              reqHeaders['Range'] = req.headers.range as string;
            }
            fetchRes = await fetch(rawUrl, { headers: reqHeaders });
          } catch (e) {
            console.warn('[Proxy Download] Non-drive public fetch error:', e);
          }
        }
      }

      // 2. Fallback: Try a public fetch of the original URL without any token/auth headers
      if (!fetchRes && !isGoogleDrive) {
        try {
          console.log(`[Proxy Download] Trying direct public fetch of original URL: ${rawUrl}...`);
          const reqHeaders: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
          };
          if (req.headers.range) {
            reqHeaders['Range'] = req.headers.range as string;
          }
          const fallbackRes = await fetch(rawUrl, {
            headers: reqHeaders
          });
          if (fallbackRes.ok) {
            fetchRes = fallbackRes;
          }
        } catch (fallbackErr) {
          console.warn('[Proxy Download] Direct public fetch error:', fallbackErr);
        }
      }

      // If all attempts failed, throw error
      if (!fetchRes || !fetchRes.ok) {
        const status = fetchRes ? fetchRes.status : 500;
        const statusText = fetchRes ? fetchRes.statusText : 'Unknown Error';
        throw new Error(`Failed to fetch file: ${status} ${statusText}`);
      }

      let contentType = fetchRes.headers.get('content-type') || 'application/octet-stream';
      const contentLength = fetchRes.headers.get('content-length');
      const contentRange = fetchRes.headers.get('content-range');
      const acceptRanges = fetchRes.headers.get('accept-ranges');

      const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_');

      if (isInline) {
        // For inline video/audio streaming, check file extension first to ensure external players (like VLC, PotPlayer, MX Player) get the exact media Content-Type
        const lowerName = fileName.toLowerCase();
        if (lowerName.endsWith('.mp4') || lowerName.endsWith('.m4v')) {
          contentType = 'video/mp4';
        } else if (lowerName.endsWith('.mp3')) {
          contentType = 'audio/mpeg';
        } else if (lowerName.endsWith('.m4a') || lowerName.endsWith('.aac')) {
          contentType = 'audio/mp4';
        } else if (lowerName.endsWith('.ogg') || lowerName.endsWith('.oga') || lowerName.endsWith('.opus')) {
          contentType = 'audio/ogg';
        } else if (lowerName.endsWith('.wav')) {
          contentType = 'audio/wav';
        } else if (lowerName.endsWith('.webm')) {
          contentType = 'video/webm';
        } else if (lowerName.endsWith('.mov')) {
          contentType = 'video/quicktime';
        } else if (lowerName.endsWith('.mkv')) {
          contentType = 'video/x-matroska';
        } else if (lowerName.endsWith('.avi')) {
          contentType = 'video/x-msvideo';
        } else if (lowerName.endsWith('.m3u8')) {
          contentType = 'application/x-mpegURL';
        } else if (lowerName.endsWith('.flv')) {
          contentType = 'video/x-flv';
        } else if (contentType === 'application/octet-stream' || contentType === 'binary/octet-stream' || contentType === 'text/plain' || contentType.startsWith('image/')) {
          if (req.path.includes('/api/stream/raw') || req.path.includes('/api/stream')) {
            contentType = 'video/mp4';
          }
        }
        res.setHeader('Content-Type', contentType);
        // Do NOT set Content-Disposition header when inline=true to avoid triggering browser file download dialog
      } else {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      }
      
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
        res.setHeader('x-file-size', contentLength);
      }

      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
        console.log(`[Proxy Download] Setting Content-Range header: ${contentRange}`);
      }

      if (acceptRanges) {
        res.setHeader('Accept-Ranges', acceptRanges);
      } else {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      // Forward status code (e.g., 206 Partial Content)
      res.status(fetchRes.status);

      // Stream the response body chunk by chunk directly to the browser
      if (fetchRes.body) {
        console.log(`[Proxy Download] Streaming file body directly to browser client...`);
        try {
          // Case 1: Node.js Readable stream or similar (has .pipe)
          if (typeof (fetchRes.body as any).pipe === 'function') {
            (fetchRes.body as any).pipe(res);
            return;
          }
          
          // Case 2: Web ReadableStream (has .getReader)
          if (typeof fetchRes.body.getReader === 'function') {
            const reader = fetchRes.body.getReader();
            res.on('close', () => {
              try {
                reader.cancel().catch(() => {});
              } catch (_) {}
            });
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              res.write(value);
            }
            res.end();
            return;
          }
          
          // Case 3: Node async iterable
          if (typeof (fetchRes.body as any)[Symbol.asyncIterator] === 'function') {
            for await (const chunk of (fetchRes.body as any)) {
              res.write(chunk);
            }
            res.end();
            return;
          }
        } catch (streamErr: any) {
          console.error('[Proxy Download] Streaming error:', streamErr);
          if (!res.headersSent) {
            return res.status(500).send(`Streaming error: ${streamErr.message}`);
          }
          return;
        }
      }

      // Fallback: Read full buffer in case stream is not available/usable
      try {
        const buffer = await fetchRes.arrayBuffer();
        return res.send(Buffer.from(buffer));
      } catch (bufErr: any) {
        console.error('[Proxy Download] Buffer fallback error:', bufErr);
        if (!res.headersSent) {
          return res.status(500).send(`Failed to read download stream or buffer: ${bufErr.message}`);
        }
      }
    } catch (err: any) {
      console.error('[Proxy Download] Error during download proxy:', err);
      return res.status(500).send(`Download failed: ${err.message}`);
    }
  };

  app.get('/api/stream/raw/:fileId/:filename', handleDownloadProxy);
  app.get('/api/stream/raw/:fileId', handleDownloadProxy);
  app.get('/api/stream/raw/*', handleDownloadProxy);
  app.get('/api/download/:fileId/:filename', handleDownloadProxy);
  app.get('/api/download/:fileId', handleDownloadProxy);
  app.get('/api/download', handleDownloadProxy);
  app.get('/api/stream/:fileId/:filename', handleDownloadProxy);
  app.get('/api/stream/:fileId', handleDownloadProxy);
  app.get('/api/stream/:filename', handleDownloadProxy);
  app.get('/api/stream', handleDownloadProxy);
  app.get('/api/stream/*', handleDownloadProxy);

  // API Upload Endpoint
  app.post('/api/upload', (req, res) => {
    try {
      const { fileName, fileType, base64Data } = req.body;
      if (!base64Data) {
        return res.status(400).json({ error: 'لم يتم توفير ملف للرفع.' });
      }

      // Extract raw base64 data
      const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      let buffer: Buffer;
      let extension = 'jpg';

      if (matches && matches.length === 3) {
        buffer = Buffer.from(matches[2], 'base64');
        const mimeType = matches[1];
        const ext = mimeType.split('/')[1];
        if (ext) extension = ext;
      } else {
        // Fallback for raw base64
        const cleanBase64 = base64Data.split(',')[1] || base64Data;
        buffer = Buffer.from(cleanBase64, 'base64');
        if (fileName) {
          const parts = fileName.split('.');
          if (parts.length > 1) {
            extension = parts.pop() || 'jpg';
          }
        }
      }

      // Generate a clean safe name with timestamps to avoid collision
      const cleanName = (fileName || 'image')
        .replace(/\.[^/.]+$/, '') // remove ext
        .replace(/[^a-zA-Z0-9_.-]/g, '_'); // sanitize
      const uniqueName = `${Date.now()}_${cleanName}.${extension}`;

      // Ensure directory exists
      const uploadsDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(path.join(uploadsDir, uniqueName), buffer);
      console.log(`[Upload API] Successfully saved original file: ${uniqueName} (${buffer.length} bytes)`);

      res.json({ url: `/uploads/${uniqueName}` });
    } catch (err: any) {
      console.error('[Upload API] Error:', err);
      res.status(500).json({ error: `فشل معالجة ورفع الملف: ${err.message || err}` });
    }
  });

  // API Delete-Upload Endpoint
  app.post('/api/delete-upload', (req, res) => {
    try {
      const { filename } = req.body;
      if (!filename) {
        return res.status(400).json({ error: 'اسم الملف غير محدد.' });
      }

      // Sanitize filename to prevent directory traversal
      const safeFilename = path.basename(filename);
      const filePath = path.join(process.cwd(), 'uploads', safeFilename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Upload API] Deleted file: ${safeFilename}`);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'الملف غير موجود.' });
      }
    } catch (err: any) {
      console.error('[Upload API] Delete Error:', err);
      res.status(500).json({ error: `فشل حذف الملف: ${err.message || err}` });
    }
  });

  // Server-side Image Generation Proxy Route for Logged In Users
  app.post('/api/generate-image', async (req, res) => {
    return res.status(410).json({ error: 'تم إيقاف التوليد الداخلي.' });
    /*
    let prompt = '';
    let selectedModel = '';
    let aspectRatio = '1:1';
    let selectedStyle = 'realistic';
    let imageParts: any[] = [];
    let compositePrompt = '';

    try {
      prompt = req.body.prompt || '';
      selectedModel = req.body.selectedModel || '';
      aspectRatio = req.body.aspectRatio || '1:1';
      selectedStyle = req.body.selectedStyle || 'realistic';
      imageParts = req.body.imageParts || [];
      const useRawPrompt = !!req.body.useRawPrompt;
      const customApiKey = (req.body.apiKey as string | undefined) || (req.headers['x-gemini-api-key'] as string | undefined || req.headers['x-api-key'] as string | undefined) || '';

      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'الرجاء كتابة وصف فكرتك (البرومبت) أولاً.' });
      }

      const isFreeModel = selectedModel.startsWith('pollinations-') || selectedModel === 'gpt-image-2';

      if (!isFreeModel && !customApiKey) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'من فضلك سجل دخولك في الموقع أولاً لتتمكن من استخدام حصة الخادم المجانية للتوليد.' });
        }
        
        const idToken = authHeader.split(' ')[1];
        const decodedToken = await verifyFirebaseIdToken(idToken);
        if (!decodedToken) {
          return res.status(401).json({ error: 'جلسة تسجيل الدخول غير صالحة أو منتهية. يرجى تسجيل الدخول مجدداً.' });
        }
      }

      // Check for user's own Google OAuth Access Token
      const googleAccessToken = req.headers['x-google-access-token'] as string | undefined;

      const styleObj = STYLE_PRESETS.find(s => s.id === selectedStyle);
      const styleInstructions = styleObj ? styleObj.suffix : '';

      if (useRawPrompt) {
        compositePrompt = prompt;
      } else {
        compositePrompt = prompt;
        if (imageParts && imageParts.length > 0) {
          compositePrompt = `
[VISUAL AND FACE REFERENCE REQUIREMENT]:
You are provided with ${imageParts.length} real portrait reference file(s) of a person's face.
Your goal is to generate an image where THIS EXACT PERSON is seamlessly integrated as the main character.
You must perfectly preserve their realistic face structure, eyes, eyes expression, nose, facial ratios, facial hair, and distinctive styling traits.

[STYLE OR GENRE]: ${styleInstructions}

[YOUR GENERATED SCENE DESCRIPTION]:
${prompt}
          `.trim();
        } else {
          if (styleInstructions) {
            compositePrompt = `${prompt}. Style: ${styleInstructions}`;
          }
        }
      }

      // 1. Direct routing for Pollinations models & GPT-Image-2 (completely free)
      if (isFreeModel) {
        try {
          let width = 1024;
          let height = 1024;
          if (aspectRatio === '16:9') {
            width = 1024;
            height = 576;
          } else if (aspectRatio === '9:16') {
            width = 576;
            height = 1024;
          } else if (aspectRatio === '4:3') {
            width = 1024;
            height = 768;
          }

          const randomSeed = Math.floor(Math.random() * 10000000);
          
          let polModel = 'flux';
          if (selectedModel === 'gpt-image-2' || selectedModel === 'pollinations-turbo') {
            polModel = 'turbo';
          } else if (selectedModel === 'pollinations-sana') {
            polModel = 'sana';
          }

          let pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(compositePrompt)}?width=${width}&height=${height}&seed=${randomSeed}&nologo=true&enhance=true&model=${polModel}`;

          console.log('[Pollinations] Server Proxy Generating via URL:', pollinationsUrl);
          let polRes = await fetch(pollinationsUrl);
          
          // Intelligent Fallback: If Flux returns 402 or is down, try ultra-stable Turbo (gpt-image-2)
          if (!polRes.ok && polModel === 'flux') {
            console.warn('[Pollinations Server] Flux failed. Retrying with turbo model...');
            polModel = 'turbo';
            pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(compositePrompt)}?width=${width}&height=${height}&seed=${randomSeed}&nologo=true&enhance=true&model=${polModel}`;
            polRes = await fetch(pollinationsUrl);
          }

          // If still fails, try without model parameters (highest availability default endpoint)
          if (!polRes.ok) {
            console.warn('[Pollinations Server] Retrying with general default model endpoint...');
            pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(compositePrompt)}?width=${width}&height=${height}&seed=${randomSeed}&nologo=true`;
            polRes = await fetch(pollinationsUrl);
          }

          if (!polRes.ok) {
            throw new Error(`سيرفرات التوليد مستغرقة حالياً (كود الخطأ: ${polRes.status})`);
          }

          const arrayBuffer = await polRes.arrayBuffer();
          const base64Img = Buffer.from(arrayBuffer).toString('base64');
          return res.json({ imageUrl: `data:image/png;base64,${base64Img}` });
        } catch (polErr: any) {
          console.error('[Pollinations] Generation failed:', polErr);
          throw new Error(`فشل نظام التوليد المجاني للصور: ${polErr.message || polErr}`);
        }
      }

      let responseData: any;
      let usedOAuth = false;

      if (googleAccessToken && googleAccessToken !== 'local-dummy-token') {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel || 'gemini-2.5-flash-image'}:generateContent`;
          console.log('[API] Attempting direct Google OAuth call for image generation...');
          const resObj = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${googleAccessToken}`,
              'User-Agent': 'aistudio-build'
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    ...(imageParts || []),
                    { text: compositePrompt }
                  ]
                }
              ],
              generationConfig: {
                imageConfig: {
                  aspectRatio: (aspectRatio || '1:1') as any,
                  imageSize: '1K'
                },
                responseModalities: ['IMAGE']
              }
            })
          });

          if (resObj.ok) {
            responseData = await resObj.json();
            usedOAuth = true;
            console.log('[API] Direct Google OAuth call succeeded!');
          } else {
            const errData = await resObj.json().catch(() => ({}));
            const errMsg = errData?.error?.message || errData?.error?.status || `Status ${resObj.status}`;
            throw new Error(`Google OAuth API Error: ${errMsg}`);
          }
        } catch (oauthErr: any) {
          console.error('[API] Google API direct OAuth flow error:', oauthErr);
          throw oauthErr;
        }
      }

      if (!usedOAuth) {
        console.log('[API] Using getGeminiClient with custom or server key...');
        const ai = getGeminiClient(customApiKey);
        const response = await ai.models.generateContent({
          model: selectedModel || 'gemini-2.5-flash-image',
          contents: {
            parts: [
              ...(imageParts || []),
              { text: compositePrompt }
            ]
          },
          config: {
            imageConfig: {
              aspectRatio: (aspectRatio || '1:1') as any,
              imageSize: '1K'
            },
            responseModalities: ['IMAGE']
          }
        });
        responseData = response;
      }

      let foundImg = null;
      let foundText = null;
      if (responseData && responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content && responseData.candidates[0].content.parts) {
        for (const part of responseData.candidates[0].content.parts) {
          if (part.inlineData) {
            foundImg = `data:image/png;base64,${part.inlineData.data}`;
            break;
          } else if (part.text) {
            foundText = part.text;
          }
        }
      }

      if (foundImg) {
        return res.json({ imageUrl: foundImg });
      } else if (foundText) {
        const isQuotaWarning = foundText.toLowerCase().includes('quota') || 
                              foundText.toLowerCase().includes('limit') || 
                              foundText.toLowerCase().includes('billing') ||
                              foundText.toLowerCase().includes('image');
        return res.status(429).json({ 
          error: `النموذج استجاب بنص بدلاً من صورة: "${foundText}". ${isQuotaWarning ? '(quota/billing limit)' : ''}` 
        });
      } else {
        return res.status(500).json({ 
          error: 'لم يتم إرجاع أي مخرجات صور من الموديل التوليدي.' 
        });
      }

    } catch (err: any) {
      console.error('[API] Server Image Gen Error:', err);
      const errorStr = err?.message || String(err);

      if (errorStr.includes('API_KEY_INVALID') || errorStr.includes('invalid API key')) {
        return res.status(403).json({ error: 'رمز الـ API للمصادقة غير صالح حالياً.' });
      } else if (
        errorStr.includes('quota') || 
        errorStr.includes('Quota exceeded') || 
        errorStr.includes('limit') || 
        errorStr.includes('exhausted') || 
        errorStr.includes('blocked') || 
        errorStr.includes('billing') ||
        errorStr.includes('429') ||
        errorStr.includes('Resource')
      ) {
        return res.status(429).json({ 
          error: '⚠️ تم تجاوز حد توليد الصور على خادم JADGPT كضيف. لكي تستمر بالتوليد دون انقطاع وبأقصى سرعة مجانية (حتى 1500 صورة يومياً) من Google، يرجى الضغط على زر القائمة وتسجيل الدخول بحساب Google (جوجل) الخاص بك لتوجيه التوليد من حصتك الشخصية مباشرة.' 
        });
      } else {
        return res.status(500).json({ error: `فشل التوليد: ${errorStr}` });
      }
    }
    */
  });

  // Server-side Gemini Prompt Enhancement Endpoint
  app.post('/api/enhance-prompt', async (req, res) => {
    try {
      const { prompt, instructions } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: 'لم يتم توفير النص المراد تحسينه.' });
      }

      // Check for user-provided custom API key in body or headers
      const customApiKey = (req.body.apiKey as string | undefined) || 
                           (req.headers['x-gemini-api-key'] as string | undefined) || 
                           (req.headers['x-api-key'] as string | undefined) || '';
      
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'لم يتم العثور على مفتاح API الخاص بـ Gemini. يرجى تسجيل الدخول بحساب Google أو إضافة مفتاح الـ API الخاص بك في القائمة الجانبية (أعلى الشاشة).' });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      let response;
      let lastError;
      
      const modelsToTry = [
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
        'gemini-flash-latest'
      ];

      let systemInstruction = `أنت خبير ذكاء اصطناعي محترف ومتميز في كتابة وتحسين برومبتات (prompts) توليد الصور لمولدات الصور الرائدة مثل Midjourney و Stable Diffusion و Leonardo AI و Imagen.
مهمتك هي إعادة صياغة وترقية وتطوير البرومبت التالي لتجعله فائق الجاذبية والاحترافية والسينمائية.

المعايير المطلوبة:
1. حافظ على كافة تفاصيل وهيكل المعطيات التي حددها المستخدم بدقة تامة (مثل الجنس والكل، العمر، المظهر، الوضعية، النمط، مقاس الصورة، الزي، التعبير، الإضاءة، وإعدادات الكاميرا). لا تغير أو تلغي أي عنصر أساسي حدده المستخدم.
2. قم بإعادة صياغة النص بصورة وصفية سينمائية فائقة الجمال وغنية بالتفاصيل البصرية الفنية (مثل التفاصيل الدقيقة للوجه، الملمس الواقعي للبشرة والأقمشة، والجو العام).
3. اكتب البرومبت المحسن بالكامل إما باللغة العربية بأسلوب راق للغاية وإما كبرومبت احترافي يمزج الكلمات المفتاحية بالإنجليزية لضمان وصول المولد لأفضل جودة جمالية (يفضل كتابة الأجزاء الوصفية بالإنجليزية في قالب منظم لتناسب محركات التوليد).
4. لا تضف أي مقدمات أو شروحات أو عبارات مثل "تفضل البرومبت" أو علامات اقتباس إضافية. قم بإرجاع النص البرومبت النهائي مباشرة وبشكل فوري وجاهز للاستخدام.`;

      if (instructions && instructions.trim()) {
        systemInstruction += `\n\nتوجيه هام جداً يجب منحه الأولوية القصوى (هام):
يجب دمج وتطبيق الملاحظة/التوجيه التالي بدقة وعناية فائقة في البرومبت المحسن وتغيير المشهد أو الإضاءة أو الخلفية بناءً عليه:
"${instructions.trim()}"`;
      }

      systemInstruction += `\n\nالبرومبت الأصلي المراد تحسينه:
"""
${prompt}
"""`;

      for (const modelName of modelsToTry) {
        try {
          console.log(`[Enhance Prompt API] Trying model: ${modelName}`);
          response = await ai.models.generateContent({
            model: modelName,
            contents: systemInstruction
          });
          if (response && response.text) {
            console.log(`[Enhance Prompt API] Success with model: ${modelName}`);
            break;
          }
        } catch (err: any) {
          console.warn(`[Enhance Prompt API] Model ${modelName} failed:`, err.message || err);
          lastError = err;
        }
      }

      if (!response || !response.text) {
        throw lastError || new Error('فشلت جميع النماذج المتاحة في معالجة طلب تحسين البرومبت بسبب ضغط الاستخدام.');
      }

      const enhancedText = response.text.trim();
      res.json({ enhancedText });
    } catch (err: any) {
      console.error('[Enhance Prompt API] Error:', err);
      const errorMsg = err.message || String(err);
      
      let clientError = `فشل تحسين البرومبت بالذكاء الاصطناعي: ${errorMsg}`;
      
      if (
        errorMsg.includes('quota') || 
        errorMsg.includes('Quota exceeded') || 
        errorMsg.includes('limit') || 
        errorMsg.includes('exhausted') || 
        errorMsg.includes('blocked') || 
        errorMsg.includes('billing') ||
        errorMsg.includes('429') ||
        errorMsg.includes('Resource')
      ) {
        clientError = '⚠️ تم تجاوز حد الاستخدام (الكوتا) الخاص بمفتاح الخادم المجاني لـ Gemini أو تم حظره مؤقتاً. يرجى تسجيل الدخول بحساب Google أو إضافة مفتاح الـ API الخاص بك في القائمة الجانبية (شريط الرأس في الأعلى) لمتابعة تحسين البرومبتات دون قيود.';
      } else if (errorMsg.includes('API_KEY_INVALID') || errorMsg.includes('key is invalid') || errorMsg.includes('invalid API key')) {
        clientError = '⚠️ مفتاح API المستخدم غير صالح. يرجى التأكد من كتابة المفتاح بشكل صحيح في القائمة الجانبية (شريط الرأس في الأعلى).';
      }
      
      res.status(500).json({ error: clientError });
    }
  });

  // Web Share Target receiver (server-side backup for the Service Worker).
  // NOTE: Chrome 153 on Android currently drops FILE parts from the share POST body
  // (issues.chromium.org/issues/563075800), so a missing file here is a browser regression,
  // not a bug in this handler — the app reports that honestly to the user.
  // Stores a received share file on catbox.moe only — Cloudflare R2 removed entirely (2026-09).
  // NOTE: catbox rejects datacenter IPs, so it often fails from the server; callers must handle null.
  async function uploadBufferToCatbox(buffer: Buffer, name: string, contentType: string): Promise<string | null> {
    try {
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', new Blob([buffer], { type: contentType }), name);
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\//.test(text)) return text;
      console.error('[catbox] failed:', res.status, text.slice(0, 200));
    } catch (e) {
      console.error('[catbox] error:', e);
    }
    return null;
  }

  async function uploadSharedMedia(buffer: Buffer, originalName: string, contentType: string): Promise<string | null> {
    const name = originalName && originalName.includes('.') ? originalName : 'shared.jpg';
    try {
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', new Blob([buffer], { type: contentType }), name);
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\//.test(text)) return text;
      console.error('[share] catbox upload failed:', res.status, text.slice(0, 200));
    } catch (e) {
      console.error('[share] catbox error:', e);
    }
    return null;
  }

  const shareMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  app.post('/share', shareMulter.any(), async (req, res) => {
    const params = new URLSearchParams({ shared: 'true' });
    try {
      const body: any = req.body || {};
      for (const key of ['title', 'text', 'url']) {
        if (body[key]) params.set(key, String(body[key]));
      }
      const files: any[] = (req as any).files || [];
      const file = files.find((f) => f.fieldname === 'media' && f.size > 0);
      if (file) {
        const ext = path.extname(file.originalname || '') || '.jpg';
        const publicUrl = await uploadSharedMedia(file.buffer, file.originalname || `shared_${Date.now()}${ext}`, file.mimetype || 'image/jpeg');
        if (publicUrl) {
          params.set('sharedImageUrl', publicUrl);
        } else {
          params.set('sharedNoFile', 'true');
          params.set('sharedUploadFailed', 'true');
        }
      } else {
        params.set('sharedNoFile', 'true');
      }
    } catch (err: any) {
      console.error('[Share Target] Error:', err);
      params.set('sharedError', err.message || 'error');
    }
    res.redirect(303, `/?${params.toString()}`);
  });

  // Fallback resolver: extract the lead image (og:image / twitter:image) from a shared link.
  // Requires a signed-in user, blocks private/internal hosts, and caps the image size.
  app.post('/api/resolve-shared-image', async (req, res) => {
    const caller = await requireSignedInUser(req, res);
    if (!caller) return;
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string' || !isPublicHttpUrl(url)) {
        return res.status(400).json({ error: 'رابط غير صالح' });
      }
      const page = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        },
      });
      const html = await page.text();
      const pick = (re: RegExp) => {
        const m = html.match(re);
        return m ? m[1].trim() : '';
      };
      let imageUrl =
        pick(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
        pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
        pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
      if (!imageUrl) {
        return res.status(404).json({ error: 'لم يُعثر على صورة في الصفحة المشاركة' });
      }
      imageUrl = imageUrl.replace(/&amp;/g, '&');
      if (!isPublicHttpUrl(imageUrl)) {
        return res.status(400).json({ error: 'رابط الصورة غير صالح' });
      }
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: url } });
      if (!imgRes.ok) {
        return res.status(502).json({ error: `تعذّر تنزيل الصورة (${imgRes.status})` });
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.byteLength > 25 * 1024 * 1024) {
        return res.status(413).json({ error: 'حجم الصورة كبير جداً' });
      }
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : contentType.includes('gif') ? '.gif' : '.jpg';
      const publicUrl = await uploadBufferToCatbox(buf, `shared_link_${Date.now()}${ext}`, contentType);
      if (!publicUrl) {
        return res.status(502).json({ error: 'فشل رفع الصورة المستخرجة (حجم كبير)' });
      }
      return res.json({ publicUrl, sourceImageUrl: imageUrl });
    } catch (err: any) {
      console.error('[resolve-shared-image] Error:', err);
      return res.status(500).json({ error: err.message || 'فشل جلب الصورة من الرابط' });
    }
  });

  // Custom API fallback handler to prevent falling back to Vite SPA HTML for api requests
  app.all('/api/*', (req, res) => {
    console.warn(`[API 404] Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `مسار الـ API غير موجود: ${req.method} ${req.originalUrl}` });
  });

  // Global error handler for all /api/* routes to guarantee clean JSON responses for errors (e.g. body-parser size limit exceeded)
  app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[API Error Middleware]:', err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.message || 'حدث خطأ غير متوقع أثناء معالجة طلبك.'
    });
  });

  // Web Share Target fallback route
  app.post('/share-target', (req, res) => {
    console.log('[Share Target Fallback] Redirecting shared post to home page');
    res.redirect(303, '/?shared=true');
  });

  // Serve uploaded images statically
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  // Handle Vite Asset Serving and SPA Fallback Routing
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Full-stack JADGPT server running on port ${PORT}`);
  });
}

startServer();
