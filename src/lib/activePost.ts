/**
 * تتبّع المنشور النشِط + توهّج التمييز.
 * ملاحظة مهمة: عدة لوحات تبقى مركّبة معاً (Keep-Alive) ويُخفى غير النشِط بـ display:none،
 * فيوجد أكثر من عنصر بنفس المعرّف post-<id> — لذلك نختار النسخة المرئية دائماً.
 * يُستخدم من: الفيد (تركيب المستمع) وسهم العودة للأعلى (قراءة المنشور الحالي).
 * سبب وجوده: زر التعديل / عرض المزيد / تشغيل ميديا كلها داخل PostCard، وهذا الملف يمنحنا
 * نقطة واحدة نعرف منها أي منشور يتفاعل معه المستخدم دون تعديل ملف المنشور الضخم.
 */
const ACTIVE_KEY = '__jadgptActivePostId';
const GLOW_LIGHT = 'post-active-glow-light';
const GLOW_DARK = 'post-active-glow-dark';

// كلمات تدل على الأفعال المطلوب تمييز منشورها
const ACTION_WORDS = ['تعديل', 'المزيد', 'عرض المزيد', 'تشغيل', 'play', 'edit', 'more', 'media'];

export const setActivePost = (postId: string | null) => {
  (window as any)[ACTIVE_KEY] = postId;
  window.dispatchEvent(new CustomEvent('jadgpt_active_post', { detail: { postId } }));
};

export const getActivePost = (): string | null => (window as any)[ACTIVE_KEY] ?? null;

const isDarkUi = () => document.documentElement.getAttribute('data-jadgpt-theme') === 'dark';

export const clearGlow = () => {
  document.querySelectorAll('.' + GLOW_LIGHT + ', .' + GLOW_DARK).forEach((el) => {
    el.classList.remove(GLOW_LIGHT, GLOW_DARK);
  });
};

/**
 * يعيد نسخة المنشور الظاهرة فعلياً على الشاشة.
 *
 * لماذا هذا ضروري: App.tsx يبقي عدة لوحات مركّبة معاً (Keep-Alive) ويُخفي غير النشِط
 * بـ display:none، فيوجد أكثر من عنصر بنفس المعرّف post-<id> في الصفحة. ودالة
 * document.getElementById تُعيد أول نسخة في ترتيب الصفحة — وهي غالباً نسخة اللوحة العامة
 * المخفية — لذلك كان التوهّج يظهر في اللوحات العامة وحدها ولا يظهر في اللوحات الفرعية.
 * الحل: نبحث عن النسخة المرئية (offsetParent !== null).
 */
export const findPostElement = (postId: string | null): HTMLElement | null => {
  if (!postId) return null;
  const wanted = 'post-' + postId;
  // لا نستخدم getElementById لأنها تُعيد أول تطابق (قد يكون داخل لوحة مخفية).
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[id^="post-"]')).filter(
    (el) => el.id === wanted
  );
  if (matches.length === 0) return null;
  // offsetParent === null يعني أن العنصر أو أحد آبائه display:none (لوحة غير نشِطة)
  return matches.find((el) => el.offsetParent !== null) || null;
};

export const glowPost = (postId: string | null) => {
  clearGlow();
  const el = findPostElement(postId);
  if (!el) return false;
  el.classList.add(isDarkUi() ? GLOW_DARK : GLOW_LIGHT);
  return true;
};

let installed = false;
/** مستمع واحد على مستوى الصفحة يمنح المنشور توهّجاً عند التعديل/المزيد/تشغيل الميديا. */
export const installPostHighlight = () => {
  if (installed) return () => {};
  installed = true;

  const handler = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const card = target.closest('[id^="post-"]') as HTMLElement | null;
    if (!card) return;
    const clickable = target.closest('button, a, [role="button"]') as HTMLElement | null;
    if (!clickable) return;

    const haystack = [
      clickable.getAttribute('title') || '',
      clickable.getAttribute('aria-label') || '',
      clickable.textContent || '',
      String(clickable.className || ''),
    ]
      .join(' ')
      .toLowerCase();

    if (!ACTION_WORDS.some((w) => haystack.includes(w.toLowerCase()))) return;

    const postId = card.id.replace(/^post-/, '');
    glowPost(postId);
    setActivePost(postId);
  };

  document.addEventListener('click', handler, true);
  return () => {
    document.removeEventListener('click', handler, true);
    installed = false;
  };
};
