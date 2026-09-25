/**
 * JADGPT — Cloudflare Worker API layer (Router + Handlers)
 * =======================================================
 * يضيف هذا الملف المسارات التي يحتاجها التطبيق على الإنتاج، ويعيد كل ما عداها
 * إلى الأصول الثابتة (env.ASSETS) — أي أنه لا يلمس الطريقة الحالية لخدمة الموقع.
 *
 *   POST /api/resolve-shared-image   → استخراج صورة (og:image) من رابط مشارك
 *   POST /api/share-diag             → تقارير تشخيص المشاركة (تظهر في wrangler tail)
 *   POST /share                      → مستقبِل هدف المشاركة (Web Share Target)
 *   أي مسار آخر                     → env.ASSETS.fetch()  (الموقع + sw.js + الأيقونات)
 *
 * الأسرار: FIREBASE_WEB_API_KEY فقط (عبر wrangler secret put) — لا مفاتيح داخل الكود.
 *
 * التخزين (2026-09): أُزيل كل اعتماد على Cloudflare R2 — لا Binding ولا مفاتيح S3 ولا
 * دلو. الملفات المستخرجة تُرفع إلى catbox.moe كمسار احتياطي، وإن فشل نُعيد الملف
 * مضمّناً (base64) ليرفعه الهاتف عبر مساره الطبيعي. لذلك لا يحتاج النشر أي تخزين خارجي.
 *
 * لا يحتوي هذا الملف على أي اعتماد على Node.js — يعمل كما هو على Workers.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_BYTES = 3_500_000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

/** يمنع SSRF: يسمح فقط بـ http/https العام، ويرفض الشبكات الداخلية والعناوين الخاصة. */
export function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host === '::1') return false;
  return true;
}

/** يستخرج رابط الصورة الرئيسية من HTML الصفحة. */
export function pickOgImage(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : '';
  };
  return (
    pick(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
  );
}

function toBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/**
 * يتحقق من أن الطلب صادر عن مستخدم مسجّل، عبر التحقق من توكن Firebase.
 * يعيد false (بدل رمي خطأ) حتى لا يتعطل المسار.
 */
async function isSignedIn(request, env) {
  const key = env.FIREBASE_WEB_API_KEY;
  const auth = request.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!key || !token) return false;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return Array.isArray(d.users) && d.users.length > 0;
  } catch (e) {
    console.error('[auth] lookup failed', e && e.message);
    return false;
  }
}

/**
 * رفع احتياطي إلى catbox.moe — المستضيف الوحيد المتبقي بعد إزالة R2 (بطلب صاحب الموقع).
 * تحذير مُختبر: catbox يرفض الطلبات القادمة من مراكز البيانات، لذا يفشل غالباً من الخادم
 * وينجح من متصفح المستخدم. لذلك وجوده هنا احتياطي فقط ولا يُعتمد عليه.
 */
async function uploadToCatbox(bytes, name, contentType) {
  try {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', new Blob([bytes], { type: contentType }), name);
    const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
    const text = (await res.text()).trim();
    if (res.ok && /^https?:\/\//.test(text)) return text;
    console.error('[catbox] failed:', res.status, text.slice(0, 200));
  } catch (e) {
    console.error('[catbox] error:', e && e.message);
  }
  return null;
}

async function handleResolve(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!(await isSignedIn(request, env))) {
    const bearer = request.headers.get('authorization') || '';
    console.warn(
      '[resolve-shared-image] UNAUTHORIZED hasBearer=' + !!bearer + ' hasKey=' + !!env.FIREBASE_WEB_API_KEY
    );
    return json({ error: 'يلزم تسجيل الدخول لاستخراج صورة من رابط.' }, 401);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url : '';
    if (!url || !isPublicHttpUrl(url)) return json({ error: 'رابط غير صالح' }, 400);

    const page = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' },
    });
    const html = await page.text();

    let imageUrl = pickOgImage(html);
    if (!imageUrl) {
      console.warn(`[resolve-shared-image] NO_OGIMAGE pageStatus=${page.status} htmlBytes=${html.length} url=${url}`);
      return json({ error: 'لم يُعثر على صورة في الصفحة المشاركة' }, 404);
    }
    imageUrl = imageUrl.replace(/&amp;/g, '&');
    if (!isPublicHttpUrl(imageUrl)) return json({ error: 'رابط الصورة غير صالح' }, 400);

    const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': UA, Referer: url } });
    if (!imgRes.ok) {
      console.warn(`[resolve-shared-image] IMG_FETCH_FAIL ${imgRes.status} ${imageUrl}`);
      return json({ error: `تعذّر تنزيل الصورة (${imgRes.status})` }, 502);
    }

    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: 'حجم الصورة كبير جداً' }, 413);

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png')
      ? '.png'
      : contentType.includes('webp')
        ? '.webp'
        : contentType.includes('gif')
          ? '.gif'
          : '.jpg';

    const publicUrl = await uploadToCatbox(bytes, `shared_link_${Date.now()}${ext}`, contentType);
    if (publicUrl) {
      console.log('[resolve-shared-image] OK ' + JSON.stringify({ src: imageUrl, publicUrl, bytes: bytes.byteLength }));
      return json({ publicUrl, sourceImageUrl: imageUrl });
    }

    // لا مستضيف متاح → نُعيد الصورة مضمّنة ليرفعها الهاتف عبر مساره الطبيعي.
    if (bytes.byteLength > MAX_INLINE_BYTES) {
      console.warn('[resolve-shared-image] UPLOAD_FAIL_INLINE_TOO_BIG bytes=' + bytes.byteLength);
      return json({ error: 'فشل رفع الصورة المستخرجة (حجم كبير)' }, 502);
    }
    console.warn('[resolve-shared-image] UPLOAD_FAIL_INLINE bytes=' + bytes.byteLength);
    return json({
      dataUrl: 'data:' + contentType + ';base64,' + toBase64(bytes),
      sourceImageUrl: imageUrl,
      inline: true,
    });
  } catch (e) {
    console.error('[resolve-shared-image] Error:', e && e.message);
    return json({ error: 'فشل جلب الصورة من الرابط' }, 500);
  }
}

/** مستقبِل مشاركة الويب: يستقبل النص/الرابط/الملف ثم يحوّل إلى الصفحة الرئيسية. */
async function handleShare(request) {
  const params = new URLSearchParams({ shared: 'true' });
  try {
    const form = await request.formData();
    for (const k of ['title', 'text', 'url']) {
      const v = form.get(k);
      if (v) params.set(k, String(v));
    }
    const file = form.get('media');
    const isFile = file && typeof file === 'object' && typeof file.arrayBuffer === 'function';
    if (isFile && file.size > 0) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name && file.name.includes('.') ? file.name : 'shared.jpg';
      const publicUrl = await uploadToCatbox(bytes, name, file.type || 'application/octet-stream');
      if (publicUrl) params.set('sharedImageUrl', publicUrl);
      else {
        params.set('sharedNoFile', 'true');
        params.set('sharedUploadFailed', 'true');
      }
    } else {
      params.set('sharedNoFile', 'true');
    }
  } catch (e) {
    params.set('sharedError', String((e && e.message) || e));
  }
  return Response.redirect(new URL('/?' + params.toString(), request.url).toString(), 303);
}

/** تقارير التشخيص من الـ Service Worker والواجهة — تُقرأ بـ: wrangler tail */
async function handleDiag(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const body = await request.json().catch(() => ({}));
    console.log('[SHARE-DIAG] ' + JSON.stringify(body));
  } catch (e) {
    console.error('[SHARE-DIAG] failed to parse payload', e && e.message);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/share') return handleShare(request);
    if (pathname === '/api/resolve-shared-image') return handleResolve(request, env);
    if (pathname === '/api/share-diag') return handleDiag(request, env);

    // كل ما عدا ذلك: الأصول الثابتة (الموقع، sw.js، الأيقونات، manifest.json)
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
