import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { db } from '../lib/firebase';
import { collection, query, orderBy, onSnapshot, where, getDocs } from 'firebase/firestore';
import { Post, OperationType, Board } from '../types';
import PostCard from './PostCard';
import { Loader2, CameraOff, Search, X } from 'lucide-react';
import { handleFirestoreError } from '../lib/error-handler';
import { AnimatePresence } from 'motion/react';
import {
  getLocalUserPostsIndexedDB,
  saveLocalUserPostsIndexedDB,
  getBoardPostsCache,
  saveBoardPostsCache,
  getAllBoardPostsCaches,
} from '../lib/indexedDbService';
import { decryptText, decryptArray } from '../lib/encryption';
import { installPostHighlight, glowPost } from '../lib/activePost';

interface FeedProps {
  key?: React.Key;
  isAdmin: boolean;
  boardId: string | null;
  subBoardId?: string | null;
  /** هل اللوحة نشِطة الآن؟ اللوحات غير النشِطة تبقى في DOM بلا أي قراءة من Firestore. */
  isActive?: boolean;
  boards: Board[];
  onTestPrompt: (text: string) => void;
  isDarkMode?: boolean;
  onSelectBoard?: (boardId: string | null, subBoardId?: string | null) => void;
}

// Arabic text normalizer for comprehensive smart text searching
const normalizeArabic = (text: string) => {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '') // remove Arabic tashkeel / diacritics
    .trim();
};

/**
 * توحيد مفتاح اللوحة الفرعية: يزيل المحارف الخفية والتشكيل ويطوي المسافات ويوحّد الحالة،
 * حتى لا يُخفق التطابق بسبب فرق نصي أو مسافة بين معرّف المنشور ومعرّف التبويب.
 */
const canonicalKey = (value?: string | null) =>
  String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** مطابقة مرنة وآمنة: لا تُصفّي شيئاً إن لم تُحدَّد لوحة فرعية. */
const matchSubBoard = (postSubBoardId?: string | null, activeSubBoardId?: string | null) => {
  if (!activeSubBoardId) return true;
  return canonicalKey(postSubBoardId) === canonicalKey(activeSubBoardId);
};

export default function Feed({ isAdmin, boardId, subBoardId, boards, onTestPrompt, isDarkMode, onSelectBoard, isActive = true }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // الحد الأولي المطلوب: ٦ منشورات، ثم يُجلب المزيد عند التمرير للأسفل
  const PAGE_SIZE = 6;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const observerTargetRef = React.useRef<HTMLDivElement | null>(null);

  // Search state across all posts
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMatchedBoardId, setSelectedMatchedBoardId] = useState<string>('all');
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [loadingAllPosts, setLoadingAllPosts] = useState(false);
  const allPostsFetchedRef = useRef(false);

  // البحث يعمل من حرفين أو أكثر فقط (ولا يُجلب شيء من قاعدة البيانات قبل ذلك).
  const isSearchActive = normalizeArabic(searchQuery).length >= 2;

  // Reset search & pagination when active board changes
  useEffect(() => {
    setSearchQuery('');
    setSelectedMatchedBoardId('all');
    allPostsFetchedRef.current = false;
    setVisibleCount(PAGE_SIZE);
  }, [boardId, subBoardId]);

  const getPostMillis = (p: Post) => {
    if (p.createdAtMillis) return p.createdAtMillis;
    if (!p.createdAt) return Date.now();
    if (typeof p.createdAt === 'number') return p.createdAt;
    if (typeof p.createdAt === 'string') {
      const parsed = Date.parse(p.createdAt);
      if (!isNaN(parsed)) return parsed;
    }
    if (typeof p.createdAt.toMillis === 'function') {
      try {
        return p.createdAt.toMillis();
      } catch (e) {}
    }
    if (typeof p.createdAt.toDate === 'function') {
      try {
        return p.createdAt.toDate().getTime();
      } catch (e) {}
    }
    const anyCreated = p.createdAt as any;
    if (anyCreated && anyCreated.seconds !== undefined) {
      return anyCreated.seconds * 1000 + (anyCreated.nanoseconds || 0) / 1000000;
    }
    if (p.createdAt instanceof Date) {
      return p.createdAt.getTime();
    }
    return Date.now();
  };

  const getSortValue = (p: Post) => {
    if (p.customOrder !== undefined) return p.customOrder;
    return getPostMillis(p);
  };

  const comparePosts = (a: Post, b: Post) => {
    const pinA = a.isPinned ? 1 : 0;
    const pinB = b.isPinned ? 1 : 0;
    if (pinA !== pinB) {
      return pinB - pinA;
    }
    const valA = getSortValue(a);
    const valB = getSortValue(b);
    return valB - valA;
  };

  const handleMovePost = async (postId: string, direction: 'up' | 'down') => {
    // Find index of the post in the current posts array
    const idx = posts.findIndex(p => p.id === postId);
    if (idx === -1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= posts.length) return; // Out of bounds

    const currentPost = posts[idx];
    const siblingPost = posts[targetIdx];

    // Safety guard: cannot swap posts of different pinning status (priority to pinning)
    if (!!currentPost.isPinned !== !!siblingPost.isPinned) return;

    const currentVal = getSortValue(currentPost);
    const siblingVal = getSortValue(siblingPost);

    let newCurrentOrder = siblingVal;
    let newSiblingOrder = currentVal;

    if (currentVal === siblingVal) {
      if (direction === 'up') {
        newCurrentOrder = siblingVal + 1;
      } else {
        newCurrentOrder = siblingVal - 1;
      }
    }

    // 1. Optimistic UI Update: immediately swap positions in state for absolute zero latency
    const updatedPosts = [...posts];
    updatedPosts[idx] = { ...currentPost, customOrder: newCurrentOrder, isPinned: !!currentPost.isPinned };
    updatedPosts[targetIdx] = { ...siblingPost, customOrder: newSiblingOrder, isPinned: !!siblingPost.isPinned };
    
    // Sort descending
    updatedPosts.sort(comparePosts);
    setPosts(updatedPosts);

    try {
      if (boardId === 'user-board') {
        const parsed = await getLocalUserPostsIndexedDB();
        const updated = parsed.map((p: any) => {
          if (p.id === currentPost.id) {
            return { ...p, customOrder: newCurrentOrder };
          }
          if (p.id === siblingPost.id) {
            return { ...p, customOrder: newSiblingOrder };
          }
          return p;
        });
        await saveLocalUserPostsIndexedDB(updated);
        window.dispatchEvent(new Event('reload_local_posts'));
      } else {
        const { doc, writeBatch, serverTimestamp } = await import('firebase/firestore');
        
        // Update both in Firestore atomically using a writeBatch to prevent intermediate inconsistent renders
        const batch = writeBatch(db);
        batch.update(doc(db, 'posts', currentPost.id), { 
          customOrder: newCurrentOrder,
          updatedAt: serverTimestamp()
        });
        batch.update(doc(db, 'posts', siblingPost.id), { 
          customOrder: newSiblingOrder,
          updatedAt: serverTimestamp()
        });
        await batch.commit();
      }
    } catch (err) {
      console.error('[Feed] Error reordering posts:', err);
      // Revert in case of failure
      setPosts(posts);
    }
  };

  // 1. Fetch Board Posts
  useEffect(() => {
    if (boardId === 'user-board') {
      setLoading(true);
      const loadLocalPosts = async () => {
        try {
          const parsed = await getLocalUserPostsIndexedDB();

          // Filter out posts that belong to real Firestore boards mistakenly saved to IndexedDB
          const filteredLocal = parsed.filter((p: any) => !p.boardId || p.boardId === 'user-board');
          
          // Automatically clean up IndexedDB if any non-local posts were stored there
          if (filteredLocal.length !== parsed.length) {
            await saveLocalUserPostsIndexedDB(filteredLocal);
          }

          let mapped: Post[] = filteredLocal.map((p: any) => {
            let timeMs = p.createdAtMillis;
            if (!timeMs) {
              if (typeof p.createdAt === 'string') {
                const parsedDate = Date.parse(p.createdAt);
                if (!isNaN(parsedDate)) timeMs = parsedDate;
              } else if (typeof p.createdAt === 'number') {
                timeMs = p.createdAt;
              } else if (p.createdAt?.seconds) {
                timeMs = p.createdAt.seconds * 1000;
              } else if (typeof p.createdAt?.toMillis === 'function') {
                try { timeMs = p.createdAt.toMillis(); } catch (e) {}
              }
            }
            if (!timeMs || isNaN(timeMs)) {
              timeMs = Date.now();
            }

            return {
              id: p.id,
              text: p.text,
              imageUrl: p.imageUrl,
              imageUrls: p.imageUrls || (p.imageUrl ? [p.imageUrl] : []),
              imageModels: p.imageModels || [],
              imageCaptions: p.imageCaptions || [],
              fileNames: p.fileNames || [],
              boardId: 'user-board',
              subBoardId: p.subBoardId || null,
              authorId: p.authorId || 'local-user',
              authorEmail: p.authorEmail || 'local-user@local.com',
              isPinned: !!p.isPinned,
              customOrder: p.customOrder,
              createdAtMillis: timeMs,
              createdAt: {
                toMillis: () => timeMs,
                toDate: () => new Date(timeMs),
                seconds: Math.floor(timeMs / 1000),
                nanoseconds: 0,
              } as any,
            };
          });

          // لا تصفية هنا: نحتفظ بكل المنشورات، والتصفية تتم عند العرض عبر matchSubBoard
          mapped.sort(comparePosts);

          setPosts(mapped);
          setLoading(false);
        } catch (err) {
          console.error(err);
          setPosts([]);
          setLoading(false);
        }
      };

      loadLocalPosts();
      window.addEventListener('reload_local_posts', loadLocalPosts);
      return () => {
        window.removeEventListener('reload_local_posts', loadLocalPosts);
      };
    }

    let initialCachedLoaded = false;
    const cacheKey = boardId ? `posts_cache_${boardId}` : `posts_cache_main`;
    const applyCached = (rows: any[]) => {
      if (!Array.isArray(rows) || rows.length === 0) return false;
      const list = [...rows] as Post[];
      list.sort(comparePosts);
      setPosts(list);           // كل منشورات اللوحة — بلا تصفية
      setLoading(false);
      return true;
    };
    // Cache-First، المستوى ١: الذاكرة المحلية السريعة.
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) initialCachedLoaded = applyCached(JSON.parse(cached));
    } catch (e) {
      console.warn('[Feed] Error reading local posts cache:', e);
    }
    // Cache-First، المستوى ٢: IndexedDB — يحتفظ باللوحة كاملة ويتجاوز حدود حصة localStorage.
    if (!initialCachedLoaded) {
      getBoardPostsCache(boardId || 'main')
        .then((rows) => {
          if (rows && rows.length) applyCached(rows);
        })
        .catch(() => {});
    }

    if (!initialCachedLoaded) {
      setLoading(true);
    }

    const targetBoard = boards?.find(b => b.id === boardId);
    if (!isAdmin && targetBoard?.hidden) {
      setPosts([]);
      setLoading(false);
      return;
    }

    if (boardId === 'safe-board' && !sessionStorage.getItem('safe_vault_password')) {
      setPosts([]);
      setLoading(false);
      return;
    }

    const postsCollection = collection(db, 'posts');
    
    // حماية حصة القراءة (2026-09): اللوحات غير النشِطة تحتفظ بالـ DOM (Keep-Alive) بلا أي قراءة.
    // قبل ذلك كان لكل لوحة زُرتها مشترك حيّ يقرأ استعلامه كاملاً — وفرع اللوحة الرئيسية بلا
    // where وبلا limit — فتُستهلك الحصة المجانية (50,000 قراءة/يوم) بمجرّد فتح التطبيق والتنقّل.
    if (isActive === false) {
      setLoading(false);
      return;
    }

    const q = boardId
      ? query(postsCollection, where('boardId', '==', boardId))
      : postsCollection;

    const unsubscribe = onSnapshot(q, (snapshot) => {
      let postsData: Post[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          isPinned: !!data.isPinned,
        } as Post;
      });
      
      // If on main board (boardId is null), filter to only main board posts
      if (boardId === null) {
        postsData = postsData.filter(p => !p.boardId || p.boardId === null || p.boardId === '');
      }

      if (!isAdmin) {
        const hiddenIds = new Set(boards?.filter(b => b.hidden).map(b => b.id) || []);
        if (hiddenIds.size > 0) {
          postsData = postsData.filter(p => !p.boardId || !hiddenIds.has(p.boardId));
        }
      }

      // تُحفظ اللوحة كاملة بكل لوحاتها الفرعية — التصفية تحدث عند العرض فقط (matchSubBoard).
      postsData.sort(comparePosts);

      setPosts(postsData);
      setLoading(false);

      try {
        localStorage.setItem(cacheKey, JSON.stringify(postsData));
      } catch (e) {
        // حصة localStorage صغيرة — النسخة الدائمة في IndexedDB أدناه.
        console.warn('[Feed] localStorage cache write failed (quota?), IndexedDB kept it:', e);
      }
      saveBoardPostsCache(boardId || 'main', postsData).catch(() => {});
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'posts');
      setLoading(false);
    });

    return () => unsubscribe();
    // اعتماد على مفتاح نصّي مستقر بدل هوية مصفوفة boards المتغيّرة في كل إعادة رسم:
    // بدون ذلك يُلغى المشترك ويُنشأ من جديد = إعادة قراءة الاستعلام كاملاً بلا داعٍ.
  }, [boardId, subBoardId, (boards || []).map((b) => `${b.id}:${b.hidden ? 1 : 0}`).join('|'), isAdmin, isActive]);

  // 2. جلب منشورات البحث الشامل — كسول: لا يبدأ إلا عند بحث فعلي (حرفان أو أكثر)
  useEffect(() => {
    if (!isSearchActive || allPostsFetchedRef.current) return;
    allPostsFetchedRef.current = true;
    let cancelled = false;
    setLoadingAllPosts(true);

    (async () => {
      try {
        const snap = await getDocs(collection(db, 'posts'));
        let fetched: Post[] = snap.docs.map((d) => {
          const data = d.data();
          return { id: d.id, ...data, isPinned: !!data.isPinned } as Post;
        });

        try {
          const local = await getLocalUserPostsIndexedDB();
          if (Array.isArray(local) && local.length > 0) {
            const mappedLocal: Post[] = local.map((p: any) => ({
              id: p.id,
              text: p.text,
              imageUrl: p.imageUrl,
              imageUrls: p.imageUrls || (p.imageUrl ? [p.imageUrl] : []),
              imageModels: p.imageModels || [],
              imageCaptions: p.imageCaptions || [],
              fileNames: p.fileNames || [],
              boardId: 'user-board',
              subBoardId: p.subBoardId || null,
              authorId: p.authorId || 'local-user',
              authorEmail: p.authorEmail || 'local-user@local.com',
              isPinned: !!p.isPinned,
              customOrder: p.customOrder,
              createdAtMillis: p.createdAtMillis || Date.now(),
              createdAt: p.createdAt || null,
            } as Post));
            fetched = [...fetched, ...mappedLocal];
          }
        } catch (e) {
          console.warn('Failed to load local posts for search:', e);
        }

        if (cancelled) return;
        fetched.sort(comparePosts);
        setAllPosts(fetched);
      } catch (error) {
        handleFirestoreError(error as any, OperationType.LIST, 'posts');
      } finally {
        if (!cancelled) setLoadingAllPosts(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSearchActive]);

  // Listen for direct post text replacements from TextEditorModal or other editors
  useEffect(() => {
    const handlePostTextUpdated = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { postId, newText } = customEvent?.detail || {};
      if (postId && newText !== undefined) {
        setPosts((prevPosts) => {
          const updated = prevPosts.map((p) => (p.id === postId ? { ...p, text: newText } : p));
          if (boardId) {
            try {
              localStorage.setItem(`posts_cache_${boardId}`, JSON.stringify(updated));
            } catch (err) {}
          }
          return updated;
        });
        setAllPosts((prevAll) => prevAll.map((p) => (p.id === postId ? { ...p, text: newText } : p)));
      }
    };

    window.addEventListener('post_text_updated', handlePostTextUpdated);
    return () => {
      window.removeEventListener('post_text_updated', handlePostTextUpdated);
    };
  }, [boardId]);

  // Highlight post card helper
  const highlightPostCard = useCallback((targetPostId: string) => {
    if (!targetPostId) return;

    let attempts = 0;
    const maxAttempts = 30;

    const executeScrollAndHighlight = () => {
      const cleanId = String(targetPostId);
      const targetPost = document.getElementById(`post-${cleanId}`);

      if (targetPost) {
        const performCenteredScroll = () => {
          const el = document.getElementById(`post-${cleanId}`);
          if (!el) return;
          el.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center'
          });
        };

        performCenteredScroll();

        const highlightClasses = [
          '!border-4',
          '!border-red-600',
          '!shadow-[inset_0_0_30px_rgba(239,68,68,0.5)]',
          'ring-2',
          'ring-red-500',
          'ring-inset',
          'bg-red-500/5',
          'scale-[1.01]',
          'transition-all',
          'duration-300'
        ];

        targetPost.classList.add(...highlightClasses);

        const reScrollTimer1 = setTimeout(performCenteredScroll, 300);
        const reScrollTimer2 = setTimeout(performCenteredScroll, 600);

        const removeTimer = setTimeout(() => {
          const el = document.getElementById(`post-${cleanId}`);
          if (el) {
            el.classList.remove(...highlightClasses);
          }
        }, 15000);

        (window as any).__pendingHighlightPostId = null;

        return () => {
          clearTimeout(reScrollTimer1);
          clearTimeout(reScrollTimer2);
          clearTimeout(removeTimer);
        };
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(executeScrollAndHighlight, 200);
      }
    };

    setTimeout(executeScrollAndHighlight, 300);
  }, []);

  // 3. Filter posts based on search query


  // Find all matching posts across all boards
  const allMatchingPosts = useMemo(() => {
    if (!isSearchActive) return [];
    const sourcePosts = allPosts.length > 0 ? allPosts : posts;
    const queryNormalized = normalizeArabic(searchQuery);
    if (!queryNormalized) return [];

    const hiddenIds = new Set(boards?.filter(b => b.hidden).map(b => b.id) || []);
    const vaultKey = sessionStorage.getItem('safe_vault_password') || '';

    return sourcePosts.filter((rawPost) => {
      if (!isAdmin && rawPost.boardId && hiddenIds.has(rawPost.boardId)) {
        return false;
      }

      // If post is in safe-board and vault is locked, NEVER include in search results
      if (rawPost.boardId === 'safe-board' && !vaultKey) {
        return false;
      }

      // If post is in safe-board and vault is unlocked, decrypt it before checking matches
      let p = rawPost;
      if (rawPost.boardId === 'safe-board' && vaultKey) {
        p = {
          ...rawPost,
          text: decryptText(rawPost.text, vaultKey),
          imageCaptions: decryptArray(rawPost.imageCaptions, vaultKey),
          fileNames: decryptArray(rawPost.fileNames, vaultKey),
        };
      }

      const textMatch = normalizeArabic(p.text || '').includes(queryNormalized);
      const titleMatch = normalizeArabic((p as any).title || '').includes(queryNormalized);
      const promptMatch = normalizeArabic((p as any).prompt || '').includes(queryNormalized);
      const descMatch = normalizeArabic((p as any).description || '').includes(queryNormalized);
      const tagsMatch = Array.isArray((p as any).tags) && (p as any).tags.some((t: string) => normalizeArabic(t).includes(queryNormalized));
      const modelsMatch = Array.isArray(p.imageModels) && p.imageModels.some((m) => normalizeArabic(m).includes(queryNormalized));
      const captionsMatch = Array.isArray(p.imageCaptions) && p.imageCaptions.some((c) => normalizeArabic(c).includes(queryNormalized));
      const fileNamesMatch = Array.isArray(p.fileNames) && p.fileNames.some((f) => normalizeArabic(f).includes(queryNormalized));

      return textMatch || titleMatch || promptMatch || descMatch || tagsMatch || modelsMatch || captionsMatch || fileNamesMatch;
    });
  }, [isSearchActive, searchQuery, allPosts, posts, boards, isAdmin]);

  // Identify the exact boards where matches were found
  const matchedBoardsList = useMemo(() => {
    if (!isSearchActive || allMatchingPosts.length === 0) return [];
    
    const boardMap: Record<string, { id: string; name: string; count: number }> = {};
    
    allMatchingPosts.forEach((p) => {
      const bId = p.boardId || 'main';
      let bName = 'الرئيسية';
      if (bId === 'user-board') {
        bName = 'لوحة المستخدم';
      } else if (p.boardId) {
        const found = boards?.find((b) => b.id === p.boardId);
        if (found) {
          bName = found.name;
        }
      }

      if (!boardMap[bId]) {
        boardMap[bId] = { id: bId, name: bName, count: 0 };
      }
      boardMap[bId].count += 1;
    });

    return Object.values(boardMap);
  }, [isSearchActive, allMatchingPosts, boards]);

  // Filter matching posts by selected board pill if clicked
  const filteredPosts = useMemo(() => {
    if (!isSearchActive) return posts;
    if (selectedMatchedBoardId === 'all') return allMatchingPosts;
    return allMatchingPosts.filter((p) => (p.boardId || 'main') === selectedMatchedBoardId);
  }, [isSearchActive, selectedMatchedBoardId, allMatchingPosts, posts]);

  // التصفية باللوحة الفرعية تتم هنا عند العرض فقط، والذاكرة تبقى كاملة.
  const boardPosts = useMemo(
    () => posts.filter((p) => matchSubBoard(p.subBoardId, subBoardId)),
    [posts, subBoardId]
  );

  const activePostsToRender = isSearchActive ? filteredPosts : boardPosts;

  // Reset selected board filter when query changes
  useEffect(() => {
    setSelectedMatchedBoardId('all');
  }, [searchQuery]);

  // Infinite scroll intersection observer
  useEffect(() => {
    if (loading || visibleCount >= activePostsToRender.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, activePostsToRender.length));
        }
      },
      { rootMargin: '300px' }
    );

    const currentTarget = observerTargetRef.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [loading, visibleCount, activePostsToRender.length]);

  // Handle post highlight events
  useEffect(() => {
    const handleHighlight = (e: CustomEvent<{ postId: string }>) => {
      const postId = e.detail?.postId;
      if (!postId) return;
      (window as any).__pendingHighlightPostId = postId;
      const targetIndex = activePostsToRender.findIndex((p) => p.id === postId);
      if (targetIndex !== -1 && targetIndex >= visibleCount) {
        setVisibleCount(targetIndex + 3);
      }
      highlightPostCard(postId);
    };

    window.addEventListener('highlight_post' as any, handleHighlight);
    return () => {
      window.removeEventListener('highlight_post' as any, handleHighlight);
    };
  }, [highlightPostCard, activePostsToRender, visibleCount]);

  // تمييز المنشور عند النقر على (تعديل / عرض المزيد / تشغيل ميديا) + لون التوهّج حسب المظهر
  useEffect(() => installPostHighlight(), []);
  useEffect(() => {
    document.documentElement.setAttribute('data-jadgpt-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // الاسترجاع الشامل: إن كانت اللوحة الفرعية المختارة بلا منشورات في الذاكرة الحالية،
  // نفتش كل مفاتيح localStorage وIndexedDB لاسترجاع منشوراتها فوراً.
  useEffect(() => {
    if (loading || !subBoardId || boardPosts.length > 0) return;
    let cancelled = false;

    (async () => {
      const wanted = canonicalKey(subBoardId);
      const found = new Map<string, Post>();

      const consider = (row: any) => {
        if (!row || typeof row !== 'object') return;
        if (canonicalKey(row.subBoardId) !== wanted) return;
        const id = String(row.id ?? '');
        if (!id) return;
        found.set(id, row as Post);
      };

      // ١) مسح شامل لكل مفاتيح الذاكرة المحلية
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith('posts_cache_')) continue;
          try {
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(arr)) arr.forEach(consider);
          } catch {
            /* مفتاح تالف — نتجاوزه */
          }
        }
      } catch (e) {
        console.warn('[Recovery] localStorage sweep failed:', e);
      }

      // ٢) مسح شامل لذاكرة IndexedDB
      try {
        const caches = await getAllBoardPostsCaches();
        caches.forEach((c) => (c.posts || []).forEach(consider));
      } catch (e) {
        console.warn('[Recovery] IndexedDB sweep failed:', e);
      }

      // ٣) منشورات المستخدم المحلية
      try {
        const local = await getLocalUserPostsIndexedDB();
        (local || []).forEach(consider);
      } catch {
        /* لا شيء */
      }

      if (cancelled || found.size === 0) return;

      const recovered = Array.from(found.values()).sort(comparePosts);
      console.log(`[Recovery] restored ${recovered.length} posts for sub-board ${subBoardId}`);
      setPosts((prev) => {
        const map = new Map(prev.map((p) => [String(p.id), p]));
        recovered.forEach((p) => map.set(String(p.id), p));
        return Array.from(map.values()).sort(comparePosts);
      });
      // نحفظ الناتج في ذاكرة اللوحة الأصلية ليكون الفتح القادم فورياً
      setPosts((prev) => {
        saveBoardPostsCache(boardId || 'main', prev).catch(() => {});
        return prev;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [subBoardId, loading, boardPosts.length, boardId]);

  // سهم الأعلى يعتمد على المنشور النشِط
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.postId) glowPost(detail.postId);
    };
    window.addEventListener('jadgpt_active_post', handler as EventListener);
    return () => window.removeEventListener('jadgpt_active_post', handler as EventListener);
  }, []);

  const visiblePosts = activePostsToRender.slice(0, visibleCount);

  return (
    <div className="pb-12">
      {/* 1. Global Search Box directly above the posts feed */}
      <div className="mx-auto mb-3.5 w-full max-w-xl px-0.5" dir="rtl">
        <div className={`relative flex items-center rounded-2xl border transition-all shadow-xs ${
          isDarkMode 
            ? 'bg-[#151D2A] border-[#2C374E] text-white focus-within:border-[#008D75] focus-within:ring-1 focus-within:ring-[#008D75]' 
            : 'bg-white border-natural-border text-natural-text focus-within:border-natural-primary focus-within:ring-1 focus-within:ring-natural-primary'
        }`}>
          <Search 
            size={18} 
            className={`mr-3.5 shrink-0 pointer-events-none ${
              isDarkMode ? 'text-gray-400' : 'text-gray-500'
            }`} 
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث في نصوص المنشورات عبر كل اللوحات"
            className="w-full bg-transparent py-2.5 pr-2 pl-10 text-xs sm:text-sm font-bold focus:outline-none placeholder:text-gray-400 placeholder:font-normal"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className={`absolute left-3 p-1 rounded-lg transition-colors cursor-pointer ${
                isDarkMode ? 'text-gray-400 hover:text-white hover:bg-[#1A212E]' : 'text-gray-500 hover:text-gray-900 hover:bg-neutral-100'
              }`}
              title="مسح البحث"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {searchQuery.trim().length === 1 && (
          <div
            className={`mt-1.5 pr-3.5 text-[11px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}
            dir="rtl"
          >
            اكتب حرفين على الأقل لبدء البحث
          </div>
        )}

        {/* Results Counter & Scope Toggle Bar */}
        {isSearchActive && (
          <div className={`mt-2 flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-xs border animate-fadeIn transition-colors ${
            isDarkMode 
              ? 'bg-[#111822] border-[#2C374E] text-gray-300' 
              : 'bg-neutral-50 border-natural-border/60 text-natural-text'
          }`}>
            <div className="flex items-center gap-2 font-bold flex-wrap">
              {loadingAllPosts ? (
                <span className="flex items-center gap-1.5 text-natural-accent">
                  <Loader2 size={14} className="animate-spin" />
                  <span>جاري البحث وفحص نصوص كافة المنشورات...</span>
                </span>
              ) : allMatchingPosts.length === 0 ? (
                <span className="flex items-center gap-1.5 text-gray-500">
                  <span className="text-sm">🔍</span>
                  <span>لم يتم العثور على أي نتائج</span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm">🔍</span>
                  <span>
                    تم العثور على{' '}
                    <strong className="text-red-600 dark:text-red-400 font-black px-1 text-sm">
                      {selectedMatchedBoardId === 'all' ? allMatchingPosts.length : filteredPosts.length}
                    </strong>{' '}
                    {(() => {
                      const count = selectedMatchedBoardId === 'all' ? allMatchingPosts.length : filteredPosts.length;
                      return count === 1 ? 'منشور' : count === 2 ? 'منشوران' : count <= 10 ? 'منشورات' : 'منشوراً';
                    })()}
                  </span>
                  <span className="text-gray-400 text-[11px] font-normal">
                    {matchedBoardsList.length === 1 ? (
                      <>(في <strong className="text-natural-primary dark:text-[#52c29c] font-bold">لوحة "{matchedBoardsList[0].name}"</strong>)</>
                    ) : selectedMatchedBoardId === 'all' ? (
                      <>(في {matchedBoardsList.map((b, i) => (
                        <span key={b.id}>
                          {i > 0 && ' و '}
                          <strong className="text-natural-primary dark:text-[#52c29c] font-bold">لوحة "{b.name}"</strong>
                        </span>
                      ))})</>
                    ) : (
                      <>(في <strong className="text-natural-primary dark:text-[#52c29c] font-bold">لوحة "{matchedBoardsList.find(b => b.id === selectedMatchedBoardId)?.name || ''}"</strong>)</>
                    )}
                  </span>
                </span>
              )}
            </div>

            {/* Scope Toggles & Clear Button */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {matchedBoardsList.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => setSelectedMatchedBoardId('all')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                      selectedMatchedBoardId === 'all'
                        ? (isDarkMode ? 'bg-[#008D75] text-white shadow-xs' : 'bg-natural-primary text-white shadow-xs')
                        : (isDarkMode ? 'bg-[#1A212E] text-gray-400 hover:text-white' : 'bg-neutral-200/70 text-natural-muted hover:text-natural-text')
                    }`}
                  >
                    كل النتائج ({allMatchingPosts.length})
                  </button>
                  {matchedBoardsList.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        if (b.id === 'safe-board') {
                          const isUnlocked = !!sessionStorage.getItem('safe_vault_password');
                          if (!isUnlocked) {
                            if (onSelectBoard) onSelectBoard('safe-board');
                            return;
                          }
                        }
                        setSelectedMatchedBoardId(b.id);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                        selectedMatchedBoardId === b.id
                          ? (isDarkMode ? 'bg-[#008D75] text-white shadow-xs' : 'bg-natural-primary text-white shadow-xs')
                          : (isDarkMode ? 'bg-[#1A212E] text-gray-400 hover:text-white' : 'bg-neutral-200/70 text-natural-muted hover:text-natural-text')
                      }`}
                    >
                      {b.name} ({b.count})
                    </button>
                  ))}
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedMatchedBoardId('all');
                }}
                className="mr-1 px-2 py-1 rounded-lg text-[11px] font-bold text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer flex items-center gap-1"
                title="إلغاء البحث"
              >
                <X size={13} />
                <span>إلغاء</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 2. Loading State (Initial) */}
      {loading && !isSearchActive && (
        <div className={`flex h-72 w-full flex-col items-center justify-center gap-3 transition-colors ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>
          <Loader2 className="animate-spin text-natural-accent" size={36} />
          <p className="text-sm font-black whitespace-nowrap">جاري تحميل المنشورات...</p>
        </div>
      )}

      {/* 3. Empty Search Results State */}
      {isSearchActive && filteredPosts.length === 0 && !loadingAllPosts && (
        <div className={`mx-auto my-8 flex max-w-md flex-col items-center justify-center rounded-3xl border-2 border-dashed p-10 text-center transition-colors ${
          isDarkMode ? 'border-[#2C374E] bg-[#111822]' : 'border-natural-border bg-white'
        }`} dir="rtl">
          <div className={`mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
            isDarkMode ? 'bg-[#1A212E] text-[#B4C6D8]' : 'bg-natural-bg text-natural-muted'
          }`}>
            <Search size={28} />
          </div>
          <h3 className={`mb-1.5 text-base font-black ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>
            لا توجد منشورات مطابقة
          </h3>
          <p className={`text-xs ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'} mb-4 leading-relaxed`}>
            لم يتم العثور على أي منشور يحتوي على النص «<strong className="text-red-500">{searchQuery}</strong>».
          </p>
          <button
            onClick={() => {
              setSearchQuery('');
              setSelectedMatchedBoardId('all');
            }}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all cursor-pointer ${
              isDarkMode ? 'bg-[#008D75] text-white hover:bg-[#007662]' : 'bg-natural-primary text-white hover:bg-[#3d3d2a]'
            }`}
          >
            مسح كلمة البحث والعودة
          </button>
        </div>
      )}

      {/* 4. Normal Empty Board State */}
      {!loading && !isSearchActive && boardPosts.length === 0 && (
        <div className={`mx-auto mt-12 flex max-w-sm flex-col items-center justify-center rounded-3xl border-2 border-dashed p-12 text-center transition-colors ${
          isDarkMode 
            ? 'border-[#2C374E] bg-[#111822]' 
            : 'border-natural-border bg-white'
        }`} dir="rtl">
          <div className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full ${
            isDarkMode ? 'bg-[#1A212E] text-[#B4C6D8]' : 'bg-natural-bg text-natural-muted'
          }`}>
            <CameraOff size={32} />
          </div>
          <h3 className={`mb-1 text-lg font-black ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>لا توجد منشورات بعد</h3>
          <p className={`text-sm ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>
            {isAdmin 
              ? "الصفحة فارغة" 
              : "لم يقم المسؤول بمشاركة أي تحديثات مؤخراً. عُد لاحقاً!"}
          </p>
        </div>
      )}

      {/* 5. Render Post Cards */}
      {visiblePosts.map((post, index) => {
        const postBoard = boards?.find(b => b.id === post.boardId);
        const boardLabel = post.boardId === 'user-board' 
          ? 'لوحة المستخدم' 
          : (postBoard?.name || 'الرئيسية');
        const subBoardLabel = post.subBoardId && postBoard?.subBoards?.find(s => s.id === post.subBoardId)?.name;

        return (
          <div key={post.id} className="transition-all duration-300">
            {isSearchActive && (
              <div className="max-w-xl mx-auto px-1 mb-1.5 flex items-center justify-between text-[11px] font-black" dir="rtl">
                <span className="inline-flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 px-2.5 py-0.5 rounded-lg border border-emerald-200/60 dark:border-emerald-800/40 shadow-2xs">
                  <span>📍</span>
                  <span>لوحة: <strong>{boardLabel}</strong></span>
                  {subBoardLabel && <span className="text-emerald-600 dark:text-emerald-400 font-normal">({subBoardLabel})</span>}
                </span>
              </div>
            )}
            <PostCard 
              id={`post-${post.id}`}
              post={post} 
              isAdmin={isAdmin} 
              boards={boards} 
              onTestPrompt={onTestPrompt} 
              isDarkMode={isDarkMode} 
              onMovePost={handleMovePost}
              canMoveUp={!isSearchActive && index > 0 && !!posts[index - 1]?.isPinned === !!post.isPinned}
              canMoveDown={!isSearchActive && index < posts.length - 1 && !!posts[index + 1]?.isPinned === !!post.isPinned}
            />
          </div>
        );
      })}

      {/* 6. Sentinel element for infinite scroll */}
      {visibleCount < activePostsToRender.length && (
        <div ref={observerTargetRef} className="py-6 flex justify-center items-center gap-2 text-xs font-bold opacity-75">
          <Loader2 className="animate-spin" size={18} />
          <span>جاري تحميل المزيد من المنشورات...</span>
        </div>
      )}
    </div>
  );
}
