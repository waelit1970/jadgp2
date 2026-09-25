# النشر على Cloudflare Workers عبر GitHub — خطوة بخطوة

> ⚠️ **تحديث (2026-09) — إزالة R2:** أُزيل Cloudflare R2 بالكامل من المشروع. لا دلو، ولا مفاتيح، ولا Binding. **لا تنشئ أي دلو R2 ولا تضبط أي متغير `R2_*`** (R2 يتطلب بطاقة دفع حتى داخل الحد المجاني). الملفات كلها (صور/فيديو/صوت) تُرفع إلى Google Drive، والمستضيف الاحتياطي للملفات المستخرجة من الروابط هو catbox.moe ثم النقل المضمّن (base64). كل ما يلزم النشر هو `FIREBASE_WEB_API_KEY` فقط.


الهدف: رفع المشروع إلى GitHub، ثم ربطه بـ Cloudflare ليبني وينشر تلقائياً عند كل تعديل.

---

## ١) الرفع إلى GitHub

### الطريقة الأسهل — GitHub Desktop
1. حمّل `GitHub Desktop` وسجّل الدخول بحسابك.
2. `File` → `Add local repository` → اختر مجلد المشروع (بعد فكّ ضغط الحزمة).
3. سيسألك عن إنشاء مستودع → اختر `create a repository` → ثم `Publish repository`.
4. أزل علامة `Keep this code private` إن أردت مستودعاً عاماً، أو أبقها خاصاً (Cloudflare تقرأ الخاص أيضاً).

### طريقة الويب — بلا أي برنامج
1. افتح مستودعك الجديد على GitHub.
2. `Add file` → `Upload files`.
3. اسحب **محتويات** مجلد المشروع (لا المجلد نفسه) إلى الصفحة.
4. اكتب رسالة الالتزام ثم `Commit changes`.

> ⚠️ **مهم جداً:** لا ترفع ملف `.env` أبداً — فيه مفاتيح حقيقية. ملف `.gitignore` في المشروع
> يمنعه تلقائياً، لكن تأكد أنك لم تسحبه يدوياً.

---

## ٢) ربط Cloudflare بالمستودع

1. من لوحة Cloudflare: **Workers & Pages** → **Create application**.
2. اختر **Get started** بجانب **Import a repository**.
3. اختر **Git account** واربط حساب GitHub، ثم اختر المستودع.
4. في إعدادات المشروع:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
5. اضغط **Save and Deploy**.
6. بعد انتهاء البناء سيظهر رابطك على شكل: `https://jadgpt.<اسمك>.workers.dev`

> ملف `wrangler.toml` الموجود في المشروع يضبط كل شيء: نقطة الدخول `worker/index.js`،

---

## ٣) الأسرار (إلزامي)

من صفحة العامل: **Settings** → **Variables and Secrets** → أضف:

| الاسم | النوع | القيمة |
|---|---|---|
| `FIREBASE_WEB_API_KEY` | **Secret** | نفس مفتاح Firebase Web الموجود في `src/lib/firebase.ts` |

بدونه يرفض مسار استخراج صورة الرابط كل الطلبات بحالة `401`.

---

## ٤) دومين Firebase (إلزامي وإلا تعطّل تسجيل الدخول)

الرابط الجديد غير مصرّح به في Firebase، فتسجيل الدخول سيفشل حتى تضيفه:

1. [Firebase Console](https://console.firebase.google.com) → مشروعك.
2. **Authentication** → **Settings** → **Authorized domains** → `Add domain`.
3. أضف: `jadgpt.<اسمك>.workers.dev` (بدون `https://`).

---


- إن لم تفعّله: **لا شيء يتعطل** — الكود يعمل بالمسارات الاحتياطية (catbox ثم نقل الصورة مضمّنة).

---

## ٦) التحقق بعد النشر

```bash
# يجب أن يظهر jadgpt-sw-v4
curl -s https://<رابطك>.workers.dev/sw.js | grep -o "jadgpt-sw-v4"

# يجب أن يرد 401 JSON (وليس 405) — أي أن مسار الاستخراج يعمل
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' https://<رابطك>.workers.dev/api/resolve-shared-image

# يجب أن يرد image/png
curl -sI https://<رابطك>.workers.dev/favicon-32.png | grep -i content-type
```

ثم من الهاتف: سجّل الدخول، وتأكد من ظهور ٦ منشورات، ثم شارك رابط مقال عادي.

---

## حدود الخطة المجانية (للتخطيط)

| البند | المجاني |
|---|---|
| طلبات Workers | 100,000 طلب يومياً |
| زمن المعالجة | 10 ميلي ثانية لكل طلب |
| دقائق البناء | 3,000 دقيقة شهرياً |
| بناء متزامن | بناء واحد |

كافية جداً لموقع شخصي — لا كريدت يستهلك ولا رصيد ينتهي.

---

## ما لا يعالجه أي نشر (خارج الكود)

- مشاركة صورة من المعرض إلى التطبيق: انحدار في Chrome على أندرويد (مؤكد على 153 و155).
- مشاركة روابط فيسبوك (`400`) ويوتيوب/جوجل (`429`): حجب من المصدر.
- الحل المؤكد للمشاركة المباشرة: تطبيق أندرويد أصلي يقرأ `Intent.EXTRA_STREAM`.
