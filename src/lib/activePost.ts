/**
 * تتبّع المنشور النشِط + توهّج التمييز.
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

export const glowPost = (postId: string | null) => {
  clearGlow();
  if (!postId) return false;
  const el = document.getElementById('post-' + postId);
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
