# نسخة Cloudflare Worker الجاهزة — دليل الدمج والتشغيل

> ⚠️ **تحديث (2026-09) — إزالة R2:** أُزيل Cloudflare R2 بالكامل من المشروع. لا دلو، ولا مفاتيح، ولا Binding. **لا تنشئ أي دلو R2 ولا تضبط أي متغير `R2_*`** (R2 يتطلب بطاقة دفع حتى داخل الحد المجاني). الملفات كلها (صور/فيديو/صوت) تُرفع إلى Google Drive، والمستضيف الاحتياطي للملفات المستخرجة من الروابط هو catbox.moe ثم النقل المضمّن (base64). كل ما يلزم النشر هو `FIREBASE_WEB_API_KEY` فقط.


الموقع النهائي: `https://wael.jadgp2.workers.dev`
الموقع التجريبي (يبقى): `https://jadgp5.netlify.app`

## ما هذه الحزمة؟

طبقة API كاملة للـ Worker، تنقل إليها ما كان يعمل على Netlify فقط. الفحص أظهر أن
الإنتاج لا يحتوي هذه المسارات حالياً:

| المسار | الوضع قبل | المطلوب بعد |
|---|---|---|
| `POST /api/resolve-shared-image` | `405` | `401` بلا توكن / `200` مع توكن |
| `POST /api/share-diag` | `405` | `200 {ok:true}` |
| `POST /share` | غير مفعّل | `303` مع `sharedImageUrl` |
| `GET /sw.js` | بلا إصدارنا | يحتوي `jadgpt-sw-v4` |
| `GET /favicon-32.png` | يردّ HTML | يردّ `image/png` |

## الملفات

| الملف | الوظيفة |
|---|---|
| `worker/index.js` | الموجّه (Router) + كل المعالجات — يعمل كما هو بلا تعديل |
| `worker/self-test.mjs` | اختبار ذاتي يعمل محلياً بلا نشر (١٨ فحصاً) |
| `WORKER-SETUP.md` | هذا الملف |

## الخطوات

### ١. انسخ الملفات
```
worker/index.js
worker/self-test.mjs
```
إلى مجلد المشروع، فوق ما هو موجود.

### ٢. ادمج إعدادات wrangler
**لا تستبدل ملفك الحالي** — أضف ما ينقص.

### ٣. اضبط السرّ (إلزامي)
```bash
npx wrangler secret put FIREBASE_WEB_API_KEY
```
القيمة = نفس مفتاح Firebase Web الموجود في `src/lib/firebase.ts`.
**بدونه يرفض مسار استخراج الصورة كل الطلبات بحالة 401** — وهذا كان أحد أعطال الليلة.

```bash
```

### ٥. تأكد من ملف `_headers`
يجب أن يكون ضمن الأصول المنشورة:
```
/sw.js
  Cache-Control: no-cache, must-revalidate
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
```
هذا ما يضمن وصول تحديثات الـ Service Worker والواجهة فوراً بدل الانتظار ساعات.

### ٦. شغّل الاختبار الذاتي قبل النشر
```bash
node worker/self-test.mjs
```
المسار المضمّن، واستقبال المشاركة.

### ٧. انشر
```bash
npx wrangler deploy
```

### ٨. تحقّق من الإنتاج (الأوامر والنتائج المتوقعة)
```bash
# يجب أن يظهر jadgpt-sw-v4
curl -s https://wael.jadgp2.workers.dev/sw.js | grep -o "jadgpt-sw-v[0-9]*"

# يجب أن يرد image/png (حالياً يرد HTML)
curl -sI https://wael.jadgp2.workers.dev/favicon-32.png | grep -i content-type

# يجب أن يرد 401 JSON — وليس 405
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' \
  https://wael.jadgp2.workers.dev/api/resolve-shared-image
```
ثم من الهاتف: شارك رابط مقال عادي (لا فيسبوك ولا يوتيوب) إلى التطبيق، وتأكد من ظهور الصورة.

### ٩. متابعة السجلات
```bash
npx wrangler tail
```
كل سطر مفيد للتشخيص:
- `[resolve-shared-image] OK {src, publicUrl, bytes}` → نجح
- `[resolve-shared-image] NO_OGIMAGE …` → الصفحة لا تحتوي صورة
- `[resolve-shared-image] UPLOAD_FAIL_INLINE …` → لا مستضيف، فأُرسلت الصورة مضمّنة
- `[resolve-shared-image] UNAUTHORIZED hasBearer=… hasKey=…` → توكن ناقص أو سرّ غير مضبوط
- `[SHARE-DIAG] {…}` → تقارير المشاركة من الهاتف

## ملاحظات يجب أن يعرفها المطوّر

  هذا يلغي نهائياً مشكلة المفاتيح المسرَّبة في هذه الطبقة.
- **catbox احتياطي لا أساسي:** مُختبر وثابت أنه **يرفض الطلبات من مراكز البيانات**، فيعمل من
- **حد النقل المضمّن 3.5 ميجابايت** — أكبر من ذلك يعيد رسالة واضحة.
- **الواجهة (React) تصل لمتصفح الزائر بطبيعتها ولا يمكن إخفاؤها.** الحماية الحقيقية:
  أسرار على الخادم + قواعد Firestore مشددة + مصادقة على كل مسار + تحديد معدل الطلبات.
- **يُنصح بإضافة rate limiting** على مسار الاستخراج (مثلاً Cloudflare Rate Limiting Rules)
  لمنع استغلاله كوسيط جلب.
- **لو كنت تستخدم Cloudflare Pages** بدل Workers: أنشئ `functions/api/resolve-shared-image.js`
  و`functions/share.js` بنفس منطق `worker/index.js` (دوال Pages تستخدم `onRequestPost`)،
  والملف يعمل كمرجع مباشر للنقل.
- **القائمة الكاملة للأعطال الخمسة** في مسار مشاركة الروابط تجدها في `APPLY-FIXES.md`.
