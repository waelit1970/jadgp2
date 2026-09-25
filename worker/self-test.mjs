/**
 * اختبار ذاتي لطبقة الـ Worker — يعمل محلياً بلا نشر وبلا اتصال بخدمات خارجية.
 * التشغيل من جذر المشروع:      node worker/self-test.mjs
 * نجاحه يعني أن الموجّه (Router) والمصادقة وحماية SSRF ومسار catbox والمسار المضمّن تعمل.
 *
 * محدَّث 2026-09: أُزيل Cloudflare R2 بالكامل — لم يعد الاختبار يمرّر MEDIA_BUCKET ولا
 * R2_PUBLIC_URL، ويغطّي مساري catbox (نجاح/فشل) والمسار المضمّن (base64).
 */
import worker, { isPublicHttpUrl, pickOgImage } from './index.js';

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
};

// ---- أدوات محاكاة -------------------------------------------------------------
const CATBOX_OK_URL = 'https://files.catbox.moe/abc123.jpg';
let catboxMode = 'fail'; // 'fail' | 'ok'

/** بيئة بلا أي تخزين: لا R2 ولا Binding ولا مفاتيح — فقط مفتاح Firebase والأصول. */
const makeEnv = () => ({
  FIREBASE_WEB_API_KEY: 'test-key',
  ASSETS: { async fetch() { return new Response('<html>SHELL</html>', { status: 200 }); } },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('identitytoolkit')) {
    return new Response(JSON.stringify({ users: [{ localId: 'u1' }] }), { status: 200 });
  }
  if (url.includes('catbox.moe')) {
    if (catboxMode === 'ok') return new Response(CATBOX_OK_URL, { status: 200 });
    return new Response('bad request', { status: 412 }); // catbox يرفض مراكز البيانات
  }
  if (url.startsWith('https://news.example.com/article')) {
    return new Response(
      '<html><head><meta property="og:image" content="https://news.example.com/pic.jpg"></head></html>',
      { status: 200 }
    );
  }
  if (url === 'https://news.example.com/pic.jpg') {
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  return new Response('not found', { status: 404 });
};

const call = (path, init = {}) =>
  worker.fetch(new Request('https://wael.jadgp2.workers.dev' + path, init), makeEnv(), {});
const auth = { authorization: 'Bearer test-token' };
const postJson = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// ---- ١) دوال مساعدة خالصة -----------------------------------------------------
console.log('\n[1] isPublicHttpUrl (حماية SSRF)');
for (const bad of ['http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://localhost/x', 'file:///etc/passwd', 'http://192.168.1.1/', 'not-a-url']) {
  check('يرفض ' + bad, isPublicHttpUrl(bad) === false);
}
check('يقبل رابطاً عاماً', isPublicHttpUrl('https://www.bbc.com/arabic') === true);

console.log('\n[2] pickOgImage (استخراج الصورة)');
check('og:image', pickOgImage('<meta property="og:image" content="https://a/x.jpg">') === 'https://a/x.jpg');
check('twitter:image', pickOgImage('<meta name="twitter:image" content="https://b/y.png">') === 'https://b/y.png');
check('ترتيب معكوس', pickOgImage('<meta content="https://c/z.jpg" property="og:image">') === 'https://c/z.jpg');
check('صفحة بلا صورة', pickOgImage('<html><body>hi</body></html>') === '');

// ---- ٣) الموجّه -----------------------------------------------------------------
console.log('\n[3] Router');
let r = await worker.fetch(new Request('https://x/assets/index-abc.js'), makeEnv(), {});
check('مسار ثابت → ASSETS', (await r.text()) === '<html>SHELL</html>');

r = await call('/api/resolve-shared-image', { method: 'GET' });
check('GET على مسار POST → 405', r.status === 405);

r = await call('/api/resolve-shared-image', postJson({ url: 'https://news.example.com/article' }));
check('بلا توكن → 401', r.status === 401, 'got ' + r.status);
const errBody = await r.json();
check('رسالة 401 عربية واضحة', String(errBody.error || '').includes('تسجيل الدخول'));

// ---- ٤) catbox يفشل → النقل المضمّن --------------------------------------------
console.log('\n[4] resolve-shared-image — catbox يفشل → dataUrl مضمّن');
catboxMode = 'fail';
r = await call('/api/resolve-shared-image', postJson({ url: 'http://127.0.0.1/x' }, auth));
check('رابط داخلي مع توكن → 400 (SSRF محجوب)', r.status === 400, 'got ' + r.status);

r = await call('/api/resolve-shared-image', postJson({ url: 'https://news.example.com/article' }, auth));
const inlineBody = await r.json().catch(() => ({}));
check('رابط صحيح → 200', r.status === 200, 'got ' + r.status);
check(
  'يعيد dataUrl عند فشل catbox',
  String(inlineBody.dataUrl || '').startsWith('data:image/jpeg;base64,'),
  'status ' + r.status
);
check('base64 صحيح الطول', String(inlineBody.dataUrl || '').endsWith('AQIDBAU='), String(inlineBody.dataUrl || '').slice(-12));
check('يعلن inline=true', inlineBody.inline === true);
check('يعيد رابط الصورة المصدر', inlineBody.sourceImageUrl === 'https://news.example.com/pic.jpg');

// ---- ٥) catbox ينجح → رابط عام --------------------------------------------------
console.log('\n[5] resolve-shared-image — catbox ينجح → publicUrl');
catboxMode = 'ok';
r = await call('/api/resolve-shared-image', postJson({ url: 'https://news.example.com/article' }, auth));
const okBody = await r.json().catch(() => ({}));
check('يعيد 200', r.status === 200, 'got ' + r.status);
check('publicUrl من catbox', okBody.publicUrl === CATBOX_OK_URL, okBody.publicUrl);
check('لا dataUrl في مسار النجاح', okBody.dataUrl === undefined);

// ---- ٦) مستقبِل المشاركة --------------------------------------------------------
console.log('\n[6] POST /share');
catboxMode = 'ok';
const fd = new FormData();
fd.append('title', 'الرئيسية - BBC News عربي');
fd.append('text', 'https://www.bbc.com/arabic');
fd.append('media', new File([new Uint8Array([9, 9, 9])], 'photo.jpg', { type: 'image/jpeg' }));
r = await worker.fetch(new Request('https://x/share', { method: 'POST', body: fd }), makeEnv(), {});
check('يحوّل بـ 303', r.status === 303, 'got ' + r.status);
let loc = r.headers.get('location') || '';
check('يحمل sharedImageUrl', loc.includes('sharedImageUrl='), loc);
check('يحمل العنوان العربي', (new URL(loc).searchParams.get('title') || '').includes('BBC News'), loc);

catboxMode = 'fail';
r = await worker.fetch(new Request('https://x/share', { method: 'POST', body: fd }), makeEnv(), {});
loc = r.headers.get('location') || '';
check('فشل catbox → sharedNoFile', loc.includes('sharedNoFile=true'), loc);
check('فشل catbox → sharedUploadFailed', loc.includes('sharedUploadFailed=true'), loc);

const fd2 = new FormData();
fd2.append('text', 'نص فقط');
r = await worker.fetch(new Request('https://x/share', { method: 'POST', body: fd2 }), makeEnv(), {});
check('بلا ملف → sharedNoFile', (r.headers.get('location') || '').includes('sharedNoFile=true'));

// ---- ٧) التشخيص -----------------------------------------------------------------
console.log('\n[7] POST /api/share-diag');
r = await call('/api/share-diag', postJson({ stage: 'self-test' }));
check('يردّ ok', r.status === 200 && (await r.json()).ok === true);

globalThis.fetch = realFetch;
console.log(`\n===== النتيجة: ${passed} ناجح، ${failed} فاشل =====`);
process.exit(failed === 0 ? 0 : 1);
