import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ArrowLeftRight, Copy, Loader2, Columns, Rows, Trash2, Save, Globe, Zap, Sparkles, ChevronDown, Check, AlertCircle } from 'lucide-react';
import { showToast } from './Toast';
import { collection, addDoc, doc, updateDoc, getDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { User } from 'firebase/auth';
import { Board } from '../types';
import { getLocalUserPostsIndexedDB, saveLocalUserPostsIndexedDB } from '../lib/indexedDbService';
import { normalizePostText } from '../lib/deduplication';
import { uploadPostImage } from '../lib/upload-helper';
import { downloadAndSmartCompressImageFromUrl, extractImageUrlsFromText } from '../lib/imageCompressor';
import { 
  translateTextOnline, 
  TranslationProvider, 
  getSavedTranslationProvider, 
  saveTranslationProvider,
  TRANSLATION_PROVIDERS 
} from '../lib/translation';

// ==========================================
// القيمة القابلة للتعديل لبعد النافذة عن أعلى الصفحة
// يمكنك تعديل هذه القيمة (مثلاً '10px' أو '15px' أو '30px') حسب رغبتك لاحقاً
// ==========================================
const MODAL_TOP_OFFSET = '20px';

interface TextEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  isAdmin: boolean;
  activeBoardId: string | null;
  boards: Board[];
  user: User | null;
  onSelectBoard?: (id: string | null) => void;
  isDarkMode?: boolean;
}

export default function TextEditorModal({ isOpen, onClose, isAdmin, boards = [], user, activeBoardId, onSelectBoard, isDarkMode }: TextEditorModalProps) {
  const [originalText, setOriginalText] = useState<string>(() => {
    try {
      return localStorage.getItem('text_editor_scratchpad_draft') || '';
    } catch {
      return '';
    }
  });
  const [translatedText, setTranslatedText] = useState<string>(() => {
    try {
      return localStorage.getItem('text_editor_scratchpad_translated_draft') || '';
    } catch {
      return '';
    }
  });
  const [srcLang, setSrcLang] = useState('auto');
  const [tgtLang, setTgtLang] = useState('en');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProvider, setTranslationProvider] = useState<TranslationProvider>('google');

  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('post_font_size');
    return saved ? parseInt(saved, 10) : 14;
  });

  const [initialText, setInitialText] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [isPasted, setIsPasted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingModification, setIsSavingModification] = useState(false);
  const [isSaveDropdownOpen, setIsSaveDropdownOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<'split' | 'stacked'>('split');

  // Smart Deduplication state
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [duplicateFoundPost, setDuplicateFoundPost] = useState<any | null>(null);
  const [pendingBoardIdToSave, setPendingBoardIdToSave] = useState<string | null>(null);

  // Translation engine dropdown state
  const [isProviderDropdownOpen, setIsProviderDropdownOpen] = useState(false);
  const providerDropdownRef = useRef<HTMLDivElement>(null);

  // Sync scratchpad draft to localStorage whenever text changes
  useEffect(() => {
    try {
      if (originalText) {
        localStorage.setItem('text_editor_scratchpad_draft', originalText);
      } else {
        localStorage.removeItem('text_editor_scratchpad_draft');
      }
    } catch (e) {}
  }, [originalText]);

  useEffect(() => {
    try {
      if (translatedText) {
        localStorage.setItem('text_editor_scratchpad_translated_draft', translatedText);
      } else {
        localStorage.removeItem('text_editor_scratchpad_translated_draft');
      }
    } catch (e) {}
  }, [translatedText]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
        setIsProviderDropdownOpen(false);
      }
    };
    if (isProviderDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isProviderDropdownOpen]);

  // Translation synchronization refs to eliminate race conditions during typing/deleting
  const abortControllerRef = useRef<AbortController | null>(null);
  const latestRequestIdRef = useRef<number>(0);

  const handleSelectProvider = (provider: TranslationProvider) => {
    setTranslationProvider(provider);
    saveTranslationProvider(provider);
    setIsProviderDropdownOpen(false);
    if (provider === 'cloudflare') {
      showToast('⚡ تم التبديل إلى ترجمة Cloudflare AI');
    } else if (provider === 'deepl') {
      showToast('🧠 تم التبديل إلى ترجمة DeepL AI');
    } else {
      showToast('🌐 تم تفعيل محرك Google الافتراضي');
    }
  };

  // Load shared incoming text from post translate action or external share
  useEffect(() => {
    const checkIncomingText = (textOverride?: string | null, postIdOverride?: string | null) => {
      const storedText = localStorage.getItem('shared_text_editor_text');
      const storedPostId = localStorage.getItem('shared_text_editor_post_id');

      // 1. Text handling - override text if specifically passed from post or external action
      if (textOverride !== undefined && textOverride !== null) {
        setOriginalText(textOverride);
        setInitialText(textOverride);
        setTranslatedText('');
        setIsPasted(false);
      } else if (storedText !== null) {
        setOriginalText(storedText);
        setInitialText(storedText);
        setTranslatedText('');
        setIsPasted(false);
        try {
          localStorage.removeItem('shared_text_editor_text');
        } catch (e) {}
      }

      // 2. Post ID handling
      if (postIdOverride !== undefined && postIdOverride !== null) {
        setEditingPostId(postIdOverride);
      } else if (storedPostId !== null) {
        setEditingPostId(storedPostId);
        try {
          localStorage.removeItem('shared_text_editor_post_id');
        } catch (e) {}
      } else if (postIdOverride === null) {
        // Explicitly cleared when opening without a post (e.g. from header 'تعديل النص')
        setEditingPostId(null);
      }

      // Revert translation provider back to Google default on new translation
      setTranslationProvider('google');
    };

    if (isOpen) {
      checkIncomingText();
    }

    const handleCustomCheck = (e: Event) => {
      const customEvent = e as CustomEvent;
      const text = customEvent?.detail?.text;
      const postId = customEvent?.detail?.postId;
      checkIncomingText(text, postId);
    };

    window.addEventListener('check_text_editor_text', handleCustomCheck);
    return () => {
      window.removeEventListener('check_text_editor_text', handleCustomCheck);
    };
  }, [isOpen]);

  const handleModalClose = () => {
    setEditingPostId(null);
    onClose();
  };

  // Back gesture / browser back history integration to close modal without exiting the app
  useEffect(() => {
    if (!isOpen) return;

    const modalState = { modalId: 'text-editor-' + Date.now() };
    window.history.pushState(modalState, '');

    const handlePopState = (e: PopStateEvent) => {
      handleModalClose();
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (window.history.state && window.history.state.modalId === modalState.modalId) {
        window.history.back();
      }
    };
  }, [isOpen, onClose]);

  // Save modified text back into existing post (replacement)
  const handleSaveModification = async () => {
    if (!editingPostId) {
      showToast('⚠️ لا يوجد منشور مرتبط لتعديله. استخدم "حفظ في لوحة" لحفظه كمنشور جديد.');
      return;
    }

    const textToSave = originalText.trim();
    if (!textToSave) {
      showToast('⚠️ لا يوجد نص أصلي أو رابط صورة لحفظه!');
      return;
    }

    if (!user) {
      showToast('⚠️ يجب تسجيل الدخول لحفظ التعديل.');
      return;
    }

    setIsSavingModification(true);
    try {
      let targetPostId = editingPostId || localStorage.getItem('shared_text_editor_post_id');

      // 0. Extract any image links pasted in the text and process smart compression + Drive upload
      const { foundUrls, cleanText } = extractImageUrlsFromText(textToSave);
      const finalTextToSave = cleanText;
      const newlyUploadedUrls: string[] = [];

      if (foundUrls.length > 0) {
        showToast(`📸 جاري ضغط ورفع ${foundUrls.length} صورة بالدقة الكاملة إلى Google Drive...`);
        for (const imgUrl of foundUrls) {
          try {
            const file = await downloadAndSmartCompressImageFromUrl(imgUrl);
            if (file) {
              const driveUrl = await uploadPostImage(file, user.uid, finalTextToSave);
              if (driveUrl) {
                newlyUploadedUrls.push(driveUrl);
              }
            }
          } catch (imgErr) {
            console.warn('[TextEditorModal] Failed to process image URL:', imgUrl, imgErr);
          }
        }
      }

      // If targetPostId is not set, search localStorage board caches & IndexedDB to find existing post
      let existingPostData: any = null;
      if (!targetPostId) {
        try {
          // 1. Check localStorage caches for activeBoardId or any board
          const cacheKey = activeBoardId ? `posts_cache_${activeBoardId}` : null;
          let candidatePosts: any[] = [];
          
          if (cacheKey) {
            const raw = localStorage.getItem(cacheKey);
            if (raw) candidatePosts = JSON.parse(raw);
          }
          if (!candidatePosts || candidatePosts.length === 0) {
            // Search all posts_cache_* in localStorage
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.startsWith('posts_cache_')) {
                try {
                  const arr = JSON.parse(localStorage.getItem(key) || '[]');
                  if (Array.isArray(arr)) candidatePosts.push(...arr);
                } catch (e) {}
              }
            }
          }

          if (Array.isArray(candidatePosts) && candidatePosts.length > 0) {
            let match = candidatePosts.find((p: any) =>
              initialText && p.text && p.text.trim() === initialText.trim()
            );
            if (!match && activeBoardId) {
              match = candidatePosts.find((p: any) => p.boardId === activeBoardId);
            }
            if (!match) {
              match = candidatePosts[0];
            }
            if (match && match.id) {
              targetPostId = match.id;
              existingPostData = match;
            }
          }

          // 2. Check IndexedDB if still not found
          if (!targetPostId) {
            const localPosts = await getLocalUserPostsIndexedDB();
            if (Array.isArray(localPosts) && localPosts.length > 0) {
              let match = localPosts.find((p: any) =>
                (activeBoardId ? p.boardId === activeBoardId : true) &&
                initialText && p.text && p.text.trim() === initialText.trim()
              );
              if (!match && activeBoardId) {
                match = localPosts.find((p: any) => p.boardId === activeBoardId);
              }
              if (!match) {
                match = localPosts[0];
              }
              if (match && match.id) {
                targetPostId = match.id;
                existingPostData = match;
              }
            }
          }
        } catch (e) {
          console.warn('[TextEditorModal] Error searching posts cache:', e);
        }
      }

      if (targetPostId) {
        // Retrieve existing post details if not already fetched
        if (!existingPostData) {
          try {
            const postDoc = await getDoc(doc(db, 'posts', targetPostId));
            if (postDoc.exists()) {
              existingPostData = postDoc.data();
            }
          } catch (e) {
            console.warn('[TextEditorModal] Error fetching post from Firestore:', e);
          }
        }

        // Build updated images list
        const existingImages: string[] = Array.isArray(existingPostData?.imageUrls)
          ? existingPostData.imageUrls
          : (existingPostData?.imageUrl ? [existingPostData.imageUrl] : []);
        const combinedImageUrls = [...existingImages, ...newlyUploadedUrls];

        const updatePayload: any = {
          text: finalTextToSave,
          updatedAt: serverTimestamp(),
        };

        if (newlyUploadedUrls.length > 0) {
          updatePayload.imageUrls = combinedImageUrls;
          if (!existingPostData?.imageUrl) {
            updatePayload.imageUrl = combinedImageUrls[0] || null;
          }
        }

        // 1. Update in Firestore
        try {
          await updateDoc(doc(db, 'posts', targetPostId), updatePayload);
        } catch (e) {
          console.warn('[TextEditorModal] Firestore update warning:', e);
        }

        // 2. Update in IndexedDB local storage
        try {
          const localPosts = await getLocalUserPostsIndexedDB();
          if (Array.isArray(localPosts) && localPosts.length > 0) {
            let foundInLocal = false;
            const updatedLocal = localPosts.map((p: any) => {
              if (p.id === targetPostId) {
                foundInLocal = true;
                return {
                  ...p,
                  text: finalTextToSave,
                  ...(newlyUploadedUrls.length > 0 ? {
                    imageUrls: combinedImageUrls,
                    imageUrl: p.imageUrl || combinedImageUrls[0] || null,
                  } : {}),
                  updatedAt: new Date().toISOString()
                };
              }
              return p;
            });
            if (foundInLocal) {
              await saveLocalUserPostsIndexedDB(updatedLocal);
            }
          }
        } catch (e) {
          console.warn('[TextEditorModal] IndexedDB update warning:', e);
        }

        // 3. Update in all localStorage posts caches
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('posts_cache_')) {
              const raw = localStorage.getItem(key);
              if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                  let updated = false;
                  const newArr = arr.map((p: any) => {
                    if (p.id === targetPostId) {
                      updated = true;
                      return {
                        ...p,
                        text: finalTextToSave,
                        ...(newlyUploadedUrls.length > 0 ? {
                          imageUrls: combinedImageUrls,
                          imageUrl: p.imageUrl || combinedImageUrls[0] || null,
                        } : {}),
                      };
                    }
                    return p;
                  });
                  if (updated) {
                    localStorage.setItem(key, JSON.stringify(newArr));
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn('[TextEditorModal] localStorage cache update warning:', e);
        }

        // 4. Dispatch events so UI & Feed update immediately
        window.dispatchEvent(new CustomEvent('post_text_updated', {
          detail: {
            postId: targetPostId,
            newText: finalTextToSave,
            newImages: combinedImageUrls
          }
        }));
        window.dispatchEvent(new Event('reload_local_posts'));

        setEditingPostId(targetPostId);
        setInitialText(finalTextToSave);
        setOriginalText(finalTextToSave);
        showToast('✅ تم استبدال النص وحفظ الصور المضغوطة في Google Drive بنجاح');
      } else {
        // Create new post in active board if no target post was found
        const payload: any = {
          text: finalTextToSave,
          imageUrl: newlyUploadedUrls[0] || null,
          imageUrls: newlyUploadedUrls,
          imageModels: newlyUploadedUrls.map(() => ''),
          imageCaptions: newlyUploadedUrls.map(() => 'صورة معالجة'),
          fileNames: newlyUploadedUrls.map((_, i) => `image_${Date.now()}_${i}.jpg`),
          fileTypes: newlyUploadedUrls.map(() => 'image/jpeg'),
          boardId: activeBoardId || null,
          authorId: user.uid,
          authorEmail: user.email || user.uid,
          createdAt: serverTimestamp(),
        };

        const newDocRef = await addDoc(collection(db, 'posts'), payload);
        setEditingPostId(newDocRef.id);
        setInitialText(finalTextToSave);
        setOriginalText(finalTextToSave);

        if (activeBoardId === 'user-board') {
          try {
            const localPosts = await getLocalUserPostsIndexedDB();
            const newPostObj = {
              id: newDocRef.id,
              ...payload,
              boardId: 'user-board',
              createdAtMillis: Date.now(),
              createdAt: new Date().toISOString(),
            };
            await saveLocalUserPostsIndexedDB([newPostObj, ...(Array.isArray(localPosts) ? localPosts : [])]);
          } catch (e) {
            console.warn('[TextEditorModal] IndexedDB insert warning:', e);
          }
        }

        window.dispatchEvent(new CustomEvent('post_text_updated', {
          detail: {
            postId: newDocRef.id,
            newText: finalTextToSave,
            newImages: newlyUploadedUrls
          }
        }));
        window.dispatchEvent(new Event('reload_local_posts'));
        showToast('📋 تم حفظ النص واستبداله في اللوحة بنجاح! 🎉');
      }
    } catch (err) {
      console.error('Failed to save text modification:', err);
      showToast('⚠️ فشل حفظ التعديل.');
    } finally {
      setIsSavingModification(false);
    }
  };

  const handleSaveToBoard = async (boardId: string | null, bypassDuplicateCheck: boolean = false) => {
    setIsSaveDropdownOpen(false);
    
    const textToSave = originalText.trim();
    if (!textToSave) {
      showToast('⚠️ لا يوجد نص أصلي لحفظه!');
      return;
    }

    if (!user) {
      showToast('⚠️ يجب تسجيل الدخول لحفظ المنشور.');
      return;
    }

    setIsSaving(true);
    try {
      // 0. Extract any image links pasted in the text and process smart compression + Drive upload
      const { foundUrls, cleanText } = extractImageUrlsFromText(textToSave);
      const finalTextToSave = cleanText;
      const newlyUploadedUrls: string[] = [];

      if (foundUrls.length > 0) {
        showToast(`📸 جاري ضغط ورفع ${foundUrls.length} صورة بالدقة الكاملة إلى Google Drive...`);
        for (const imgUrl of foundUrls) {
          try {
            const file = await downloadAndSmartCompressImageFromUrl(imgUrl);
            if (file) {
              const driveUrl = await uploadPostImage(file, user.uid, finalTextToSave);
              if (driveUrl) {
                newlyUploadedUrls.push(driveUrl);
              }
            }
          } catch (imgErr) {
            console.warn('[TextEditorModal] Failed to process image URL:', imgUrl, imgErr);
          }
        }
      }

      // Smart Deduplication check
      if (!bypassDuplicateCheck) {
        const { cleanBody } = normalizePostText(finalTextToSave);
        if (cleanBody && cleanBody.length >= 3) {
          let existingMatch: any = null;

          // 1. Search localStorage posts caches first (for ultra speed)
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('posts_cache_')) {
              try {
                const arr = JSON.parse(localStorage.getItem(key) || '[]');
                if (Array.isArray(arr)) {
                  for (const p of arr) {
                    if (p && p.text) {
                      const { cleanBody: existingBody } = normalizePostText(p.text);
                      if (existingBody && existingBody === cleanBody) {
                        existingMatch = p;
                        break;
                      }
                    }
                  }
                }
              } catch (e) {}
            }
            if (existingMatch) break;
          }

          // 2. Check IndexedDB
          if (!existingMatch) {
            try {
              const localPosts = await getLocalUserPostsIndexedDB();
              if (Array.isArray(localPosts)) {
                for (const p of localPosts) {
                  if (p && p.text) {
                    const { cleanBody: existingBody } = normalizePostText(p.text);
                    if (existingBody && existingBody === cleanBody) {
                      existingMatch = { ...p, boardId: p.boardId || 'user-board' };
                      break;
                    }
                  }
                }
              }
            } catch (e) {}
          }

          // 3. Check Firestore posts collection
          if (!existingMatch) {
            try {
              const postsSnapshot = await getDocs(collection(db, 'posts'));
              postsSnapshot.forEach((docSnap) => {
                if (existingMatch) return;
                const pData = docSnap.data();
                if (pData && pData.text) {
                  const { cleanBody: existingBody } = normalizePostText(pData.text);
                  if (existingBody && existingBody === cleanBody) {
                    existingMatch = { id: docSnap.id, ...pData };
                  }
                }
              });
            } catch (err) {
              console.warn('[TextEditorModal] Firestore deduplication check error:', err);
            }
          }

          if (existingMatch) {
            setIsSaving(false);
            setDuplicateFoundPost(existingMatch);
            setPendingBoardIdToSave(boardId);
            setDuplicateModalOpen(true);
            return;
          }
        }
      }

      // 1. Copy original text to clipboard
      try {
        await navigator.clipboard.writeText(finalTextToSave);
      } catch (copyErr) {
        console.error('Failed to copy text on save:', copyErr);
      }

      // 2. Save original text as a new post to Firestore
      const payload: any = {
        text: finalTextToSave,
        imageUrl: newlyUploadedUrls[0] || null,
        imageUrls: newlyUploadedUrls,
        imageModels: newlyUploadedUrls.map(() => ''),
        imageCaptions: newlyUploadedUrls.map(() => 'صورة معالجة'),
        fileNames: newlyUploadedUrls.map((_, i) => `image_${Date.now()}_${i}.jpg`),
        fileTypes: newlyUploadedUrls.map(() => 'image/jpeg'),
        boardId: boardId,
        authorId: user.uid,
        authorEmail: user.email || user.uid,
        createdAt: serverTimestamp(),
      };

      const newDocRef = await addDoc(collection(db, 'posts'), payload);

      if (boardId === 'user-board') {
        try {
          const localPosts = await getLocalUserPostsIndexedDB();
          const newPostObj = {
            id: newDocRef.id,
            ...payload,
            boardId: 'user-board',
            createdAtMillis: Date.now(),
            createdAt: new Date().toISOString(),
          };
          await saveLocalUserPostsIndexedDB([newPostObj, ...(Array.isArray(localPosts) ? localPosts : [])]);
          window.dispatchEvent(new Event('reload_local_posts'));
        } catch (e) {
          console.warn('[TextEditorModal] IndexedDB insert warning:', e);
        }
      }

      // 3. Transition to the selected board
      if (onSelectBoard) {
        onSelectBoard(boardId);
      }

      // 4. Close the modal
      onClose();

      // 5. Success toast
      showToast('📋 تم نسخ النص وحفظه بنجاح كمنشور جديد! 🎉');
    } catch (err) {
      console.error('Failed to save text to board:', err);
      showToast('⚠️ فشل حفظ المنشور في اللوحة.');
    } finally {
      setIsSaving(false);
    }
  };

  // Prevent background scrolling and content shifting when modal is open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  useEffect(() => {
    const handleFontSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && typeof customEvent.detail.size === 'number') {
        setFontSize(customEvent.detail.size);
      }
    };
    window.addEventListener('post_font_size_changed', handleFontSizeChange);
    return () => {
      window.removeEventListener('post_font_size_changed', handleFontSizeChange);
    };
  }, []);

  // Auto-detect direction helper: returns true if Arabic/RTL is matched
  const isRtl = (text: string): boolean => {
    if (!text) return true; // Default to natural Arabic direction
    let arabicCount = 0;
    let englishCount = 0;
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      if ((charCode >= 0x0600 && charCode <= 0x06FF) || 
          (charCode >= 0x0750 && charCode <= 0x077F) || 
          (charCode >= 0x08A0 && charCode <= 0x08FF) || 
          (charCode >= 0xFB50 && charCode <= 0xFDFF) || 
          (charCode >= 0xFE70 && charCode <= 0xFEFF)) {
        arabicCount++;
      } else if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) { // A-Z, a-z
        englishCount++;
      }
    }
    if (arabicCount > englishCount) return true;
    if (englishCount > arabicCount) return false;
    // If equal or no letter characters, check if any Arabic exists
    const rtlChar = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\uFE70-\uFEFC]/;
    return rtlChar.test(text);
  };

  // Auto-switch target language based on typed original text
  useEffect(() => {
    if (!originalText.trim()) return;
    const isOrigArabic = /[\u0600-\u06FF]/.test(originalText);
    
    if (!isOrigArabic) {
      // Original text is English / Non-Arabic
      if (tgtLang === 'en') {
        setTgtLang('ar');
      }
    } else {
      // Original text is Arabic
      if (tgtLang === 'ar') {
        setTgtLang('en');
      }
    }
  }, [originalText]);

  // Clear translated text when original text is emptied
  useEffect(() => {
    if (!originalText.trim()) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      latestRequestIdRef.current += 1;
      setTranslatedText('');
      setIsTranslating(false);
    }
  }, [originalText]);

  // Manual translation on-demand
  const handleDoTranslate = async (overrideText?: string, overrideProvider?: TranslationProvider) => {
    const text = (overrideText !== undefined ? overrideText : originalText).trim();
    if (!text) {
      showToast('⚠️ يرجى إدخال نص أولاً للترجمة');
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentRequestId = ++latestRequestIdRef.current;
    setIsTranslating(true);

    try {
      const provider = overrideProvider || translationProvider;
      const result = await translateTextOnline(text, srcLang, tgtLang, provider, controller.signal);
      
      if (currentRequestId === latestRequestIdRef.current) {
        setTranslatedText(result);
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.warn('[TextEditorModal] Translation error:', err);
        showToast('⚠️ تعذر إتمام الترجمة، يرجى المحاولة لاحقاً');
      }
    } finally {
      if (currentRequestId === latestRequestIdRef.current) {
        setIsTranslating(false);
      }
    }
  };

  const handleClearText = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    latestRequestIdRef.current += 1;
    setOriginalText('');
    setTranslatedText('');
    setInitialText('');
    setEditingPostId(null);
    setIsPasted(false);
    setIsTranslating(false);
    setSrcLang('auto');
    setTranslationProvider('google');
    try {
      localStorage.removeItem('text_editor_scratchpad_draft');
      localStorage.removeItem('text_editor_scratchpad_translated_draft');
      localStorage.removeItem('shared_text_editor_text');
      localStorage.removeItem('shared_text_editor_post_id');
    } catch (e) {}
  };

  const handleSwap = () => {
    const tempText = originalText;
    setOriginalText(translatedText);
    setTranslatedText(tempText);

    // Swap selected languages seamlessly
    const currentSrc = srcLang;
    const currentTgt = tgtLang;

    if (currentSrc === 'auto') {
      const detectedSrc = /[\u0600-\u06FF]/.test(tempText) ? 'ar' : 'en';
      setSrcLang(currentTgt);
      setTgtLang(detectedSrc);
    } else {
      setSrcLang(currentTgt);
      setTgtLang(currentSrc);
    }
  };

  const copyText = async (text: string, label: string) => {
    if (!text.trim()) {
      showToast('⚠️ النص فارغ!');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(`📋 تم نسخ ${label} بنجاح!`);
    } catch (err) {
      console.error('Failed to copy text:', err);
      showToast('⚠️ فشل نسخ النص.');
    }
  };

  if (!isOpen) return null;

  const isOriginalRtl = isRtl(originalText);
  const isTranslatedRtl = isRtl(translatedText);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[1000] flex items-start justify-center p-2 sm:p-4 overflow-hidden">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleModalClose}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        />

        {/* Modal Panel */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: 'spring', duration: 0.35 }}
          className={`relative w-[98%] sm:w-[98%] max-w-[1450px] rounded-2xl shadow-2xl border overflow-hidden flex flex-col transition-colors ${
            isDarkMode 
              ? 'bg-[#111822] border-[#6980b0] text-[#e4edf7]' 
              : 'bg-white border-[#A8AB9B] text-natural-text'
          }`}
          style={{
            marginTop: MODAL_TOP_OFFSET,
            height: `calc(100dvh - ${MODAL_TOP_OFFSET} - 20px)`,
          }}
          dir="rtl"
        >
          {/* Close button for mobile - placed top-left of the container with padding 0 */}
          <button
            type="button"
            onClick={handleModalClose}
            title="إغلاق النافذة"
            className={`sm:hidden absolute top-0 left-0 p-0 flex h-10 w-10 items-center justify-center transition-all z-50 cursor-pointer ${
              isDarkMode 
                ? 'text-red-400 hover:text-red-300 hover:bg-red-950/40' 
                : 'text-red-600 hover:text-red-800 hover:bg-red-50'
            }`}
          >
            <X size={20} />
          </button>

          {/* Translation Engine Dropdown Switcher & Translate Action Button (Mobile & Desktop friendly) */}
          <div className={`px-3 py-1.5 border-b flex items-center justify-between gap-2 select-none transition-colors ${
            isDarkMode 
              ? 'bg-[#151D2A] border-[#6980b0]' 
              : 'bg-[#f5f6f2] border-[#A8AB9B]'
          }`}>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Translate Action Button */}
              <button
                type="button"
                onClick={() => handleDoTranslate()}
                disabled={isTranslating || !originalText.trim()}
                className={`px-2 py-1 rounded-lg text-xs font-normal transition-all flex items-center gap-1 cursor-pointer border shadow-sm active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                  isDarkMode
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 ring-1 ring-emerald-400/40 shadow-emerald-950/40'
                    : 'bg-[#008D75] hover:bg-[#007562] text-white border-[#006e5b] ring-1 ring-emerald-500/30'
                }`}
                title="انقر لتنفيذ الترجمة"
              >
                {isTranslating ? (
                  <>
                    <Loader2 size={13} className="animate-spin text-white shrink-0" />
                    <span>جاري الترجمة...</span>
                  </>
                ) : (
                  <>
                    <Globe size={13} className="text-white shrink-0" />
                    <span>انقر للترجمة</span>
                  </>
                )}
              </button>

              {/* Provider Select Trigger Button */}
              <div className="relative inline-block" ref={providerDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsProviderDropdownOpen(!isProviderDropdownOpen)}
                  className={`px-1.5 py-1 rounded-lg text-[12px] font-normal transition-all flex items-center gap-1.5 cursor-pointer border shadow-xs ${
                    translationProvider === 'google'
                      ? (isDarkMode ? 'bg-emerald-600 text-white border-emerald-500 ring-1 ring-emerald-400/40' : 'bg-emerald-600 text-white border-emerald-700 ring-1 ring-emerald-400/40')
                      : translationProvider === 'cloudflare'
                        ? (isDarkMode ? 'bg-[#F38020] text-white border-[#D96A10] ring-1 ring-orange-400/50' : 'bg-[#F38020] text-white border-[#D96A10] ring-1 ring-orange-300')
                        : (isDarkMode ? 'bg-[#0F2B48] text-white border-[#3B82F6]/60 ring-1 ring-sky-400/50' : 'bg-[#0F2B48] text-white border-[#08182B] ring-1 ring-sky-300')
                  }`}
                >
                  {translationProvider === 'google' && (
                    <>
                      <Globe size={12} className="text-white" />
                      <span>Google</span>
                      <span className="text-[9px] opacity-85 font-normal">(الافتراضي)</span>
                    </>
                  )}
                  {translationProvider === 'cloudflare' && (
                    <>
                      <Zap size={12} className="text-white" />
                      <span>Cloudflare AI</span>
                    </>
                  )}
                  {translationProvider === 'deepl' && (
                    <>
                      <Sparkles size={12} className="text-cyan-300" />
                      <span>DeepL AI</span>
                    </>
                  )}
                  <ChevronDown size={13} className={`transition-transform duration-200 ${isProviderDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {/* Dropdown Menu */}
                {isProviderDropdownOpen && (
                  <div className={`absolute top-full mt-1.5 right-0 z-50 w-52 rounded-xl shadow-2xl border p-1.5 space-y-1 animate-in fade-in zoom-in-95 duration-150 ${
                    isDarkMode 
                      ? 'bg-[#1A212E] border-[#6980b0] text-white' 
                      : 'bg-white border-[#A8AB9B] text-neutral-800'
                  }`}>
                    <button
                      type="button"
                      onClick={() => handleSelectProvider('google')}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[11px] font-black transition-colors text-right cursor-pointer ${
                        translationProvider === 'google'
                          ? (isDarkMode ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/50' : 'bg-emerald-50 text-emerald-800 border border-emerald-300')
                          : (isDarkMode ? 'text-gray-300 hover:bg-[#222C3C]' : 'text-neutral-700 hover:bg-neutral-100')
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-md bg-emerald-600 text-white flex items-center justify-center shrink-0">
                          <Globe size={12} />
                        </div>
                        <div className="flex flex-col text-right">
                          <span>Google Translate</span>
                          <span className={`text-[9px] font-medium ${isDarkMode ? 'text-gray-400' : 'text-neutral-500'}`}>الافتراضي (فوري ومستقر)</span>
                        </div>
                      </div>
                      {translationProvider === 'google' && <Check size={14} className="text-emerald-400 shrink-0" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectProvider('cloudflare')}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[11px] font-black transition-colors text-right cursor-pointer ${
                        translationProvider === 'cloudflare'
                          ? (isDarkMode ? 'bg-orange-950/60 text-orange-300 border border-orange-500/50' : 'bg-orange-50 text-[#F38020] border border-orange-300')
                          : (isDarkMode ? 'text-gray-300 hover:bg-[#222C3C]' : 'text-neutral-700 hover:bg-orange-50/60')
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-md bg-[#F38020] text-white flex items-center justify-center shrink-0">
                          <Zap size={12} />
                        </div>
                        <div className="flex flex-col text-right">
                          <span>Cloudflare AI</span>
                          <span className={`text-[9px] font-medium ${isDarkMode ? 'text-gray-400' : 'text-neutral-500'}`}>نموذج LLaMA 3.1 فائق الدقة</span>
                        </div>
                      </div>
                      {translationProvider === 'cloudflare' && <Check size={14} className="text-[#F38020] shrink-0" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectProvider('deepl')}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[11px] font-black transition-colors text-right cursor-pointer ${
                        translationProvider === 'deepl'
                          ? (isDarkMode ? 'bg-sky-950/60 text-sky-300 border border-sky-500/50' : 'bg-sky-50 text-[#0F2B48] border border-sky-300')
                          : (isDarkMode ? 'text-gray-300 hover:bg-[#222C3C]' : 'text-neutral-700 hover:bg-sky-50/60')
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-md bg-[#0F2B48] text-white flex items-center justify-center shrink-0">
                          <Sparkles size={12} className="text-cyan-300" />
                        </div>
                        <div className="flex flex-col text-right">
                          <span>DeepL AI</span>
                          <span className={`text-[9px] font-medium ${isDarkMode ? 'text-gray-400' : 'text-neutral-500'}`}>ترجمة لغوية فائقة الدقة</span>
                        </div>
                      </div>
                      {translationProvider === 'deepl' && <Check size={14} className="text-sky-400 shrink-0" />}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {isTranslating && (
              <div className={`flex items-center gap-1 text-[10px] font-bold mr-1 animate-pulse ${
                isDarkMode ? 'text-emerald-400' : 'text-natural-primary'
              }`}>
                <Loader2 size={11} className="animate-spin" />
                <span className="hidden sm:inline">جاري الترجمة...</span>
              </div>
            )}
          </div>

          {/* Header Area */}
          <div className={`px-2 py-1 border-b flex items-stretch sm:items-center justify-between gap-0 transition-colors ${
            isDarkMode 
              ? 'bg-[#151D2A] border-[#6980b0]' 
              : 'bg-[#f5f6f2] border-[#A8AB9B]'
          }`}>
            
            {/* Right Side: Original Text Label & Language Selector */}
            <div className="flex-1 text-right flex flex-col items-start justify-end pt-6 sm:p-0">
              <span className={`text-xs font-bold block w-full max-w-[140px] text-center ${
                isDarkMode ? 'text-emerald-400' : 'text-[#016f4a]'
              }`}>
                النص الأصلي
              </span>
              <select
                value={srcLang}
                onChange={(e) => setSrcLang(e.target.value)}
                className={`mt-1 text-[11px] rounded-md border px-0.5 py-1 font-bold focus:outline-none cursor-pointer w-full max-w-[140px] transition-colors ${
                  isDarkMode 
                    ? 'bg-[#1A212E] text-white border-[#6980b0] focus:ring-1 focus:ring-[#008D75]' 
                    : 'bg-white text-natural-text border-[#A8AB9B] focus:ring-1 focus:ring-natural-primary'
                }`}
              >
                <option value="auto" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>تلقائي(Auto)</option>
                <option value="ar" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>العربية (Arabic)</option>
                <option value="en" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإنجليزية (English)</option>
                <option value="fr" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الفرنسية (French)</option>
                <option value="tr" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>التركية (Turkish)</option>
                <option value="de" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الألمانية (German)</option>
                <option value="es" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإسبانية (Spanish)</option>
                <option value="it" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإيطالية (Italian)</option>
                <option value="ru" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الروسية (Russian)</option>
                <option value="zh" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الصينية (Chinese)</option>
              </select>
            </div>

            {/* Middle Side: Swap button, Clear button, and Layout/Close controls */}
            <div className="relative flex-1 sm:flex-none flex flex-col justify-end items-center pt-6 pb-0.5 sm:p-0">

              {/* ===== حاوية منفصلة لزر (مسح) على الجوال لتسهيل تعديل موضعه يدوياً ===== */}
              {/* موقعه الابتدائي: في الأعلى فوق الزرين بمسافة كافية لمنع اللمس بالخطأ */}
              <div className="sm:hidden absolute top-0.5 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleClearText}
                  title="مسح النص الأصلي"
                  className={`px-2.5 py-1.5 text-[11px] font-black rounded-md shadow-xs transition-all cursor-pointer flex items-center gap-1 border ${
                    isDarkMode 
                      ? 'bg-red-950/40 text-red-400 hover:bg-red-900/50 border-red-700/60' 
                      : 'bg-red-50 text-red-600 hover:bg-red-100 border-red-300'
                  }`}
                >
                  <Trash2 size={11} className="shrink-0" />
                  <span>مسح</span>
                </button>
              </div>

              {/* حاوية الأزرار الملتصقة بأسفل الحاوية على الجوال */}
              <div className="flex items-center justify-center gap-1.5 mt-auto sm:mt-0">
                {/* Swap Button (تبديل نصي الترجمة) */}
                <button
                  type="button"
                  onClick={handleSwap}
                  title="تبديل النصوص واللغات"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all shadow-sm border shrink-0 cursor-pointer ${
                    isDarkMode 
                      ? 'bg-[#1A212E] text-white hover:bg-[#253042] hover:text-amber-300 border-[#6980b0]' 
                      : 'bg-white text-natural-primary hover:bg-natural-primary hover:text-white border-[#A8AB9B]'
                  }`}
                >
                  <ArrowLeftRight size={14} />
                </button>

                {/* Layout Toggle Button - Visible in place of close button on mobile (تبديل مكان النصين) */}
                <button
                  type="button"
                  onClick={() => setLayoutMode(layoutMode === 'split' ? 'stacked' : 'split')}
                  title={layoutMode === 'split' ? 'تبديل إلى عرض تحت بعض (Stacked)' : 'تبديل إلى عرض متقابل (Split)'}
                  className={`flex h-8 w-8 sm:hidden items-center justify-center rounded-lg transition-all shadow-sm border shrink-0 cursor-pointer ${
                    isDarkMode 
                      ? 'bg-[#1A212E] text-white hover:bg-[#253042] border-[#6980b0]' 
                      : 'bg-white text-natural-primary hover:bg-natural-primary hover:text-white border-[#A8AB9B]'
                  }`}
                >
                  {layoutMode === 'split' ? <Rows size={14} /> : <Columns size={14} />}
                </button>

                {/* Close Button - Visible only on desktop here */}
                <button
                  type="button"
                  onClick={handleModalClose}
                  title="إغلاق النافذة"
                  className={`hidden sm:flex h-8 w-8 items-center justify-center rounded-lg transition-all shadow-sm border shrink-0 cursor-pointer ${
                    isDarkMode 
                      ? 'bg-red-950/40 text-red-400 hover:bg-red-900/50 border-red-700/60' 
                      : 'bg-red-50 text-red-600 hover:bg-red-100 border-red-300'
                  }`}
                >
                  <X size={15} />
                </button>

                {/* زر مسح للتاب والكمبيوتر - يقع على يسار زر إغلاق النافذة */}
                <button
                  type="button"
                  onClick={handleClearText}
                  title="مسح النص الأصلي"
                  className={`hidden sm:flex h-8 px-2.5 items-center justify-center gap-1 rounded-lg transition-all shadow-sm border text-xs font-bold shrink-0 cursor-pointer ${
                    isDarkMode 
                      ? 'bg-red-950/40 text-red-400 hover:bg-red-900/50 border-red-700/60' 
                      : 'bg-red-50 text-red-600 hover:bg-red-100 border-red-300'
                  }`}
                >
                  <Trash2 size={13} />
                  <span>مسح</span>
                </button>
              </div>
            </div>

            {/* Left Side: Translation Label & Language Selector */}
            <div className="flex-1 text-left flex flex-col items-end justify-end pt-6 sm:p-0">
              <span className={`text-xs font-bold block w-full max-w-[140px] text-center ${
                isDarkMode ? 'text-emerald-400' : 'text-[#016f4a]'
              }`}>
                الترجمة
              </span>
              <select
                value={tgtLang}
                onChange={(e) => setTgtLang(e.target.value)}
                className={`mt-1 text-[11px] rounded-md border px-0.5 py-1 font-bold focus:outline-none cursor-pointer w-full max-w-[140px] text-right transition-colors ${
                  isDarkMode 
                    ? 'bg-[#1A212E] text-white border-[#6980b0] focus:ring-1 focus:ring-[#008D75]' 
                    : 'bg-white text-natural-text border-[#A8AB9B] focus:ring-1 focus:ring-natural-primary'
                }`}
              >
                <option value="en" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإنجليزية (English)</option>
                <option value="ar" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>العربية (Arabic)</option>
                <option value="fr" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الفرنسية (French)</option>
                <option value="tr" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>التركية (Turkish)</option>
                <option value="de" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الألمانية (German)</option>
                <option value="es" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإسبانية (Spanish)</option>
                <option value="it" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الإيطالية (Italian)</option>
                <option value="ru" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الروسية (Russian)</option>
                <option value="zh" className={isDarkMode ? 'bg-[#1A212E] text-white' : ''}>الصينية (Chinese)</option>
              </select>
            </div>

          </div>

          {/* Text Areas Section */}
          <div className={`flex-1 p-1 overflow-y-auto ${
            isDarkMode ? 'bg-[#0D131C]' : 'bg-neutral-50/50'
          } ${
            layoutMode === 'stacked' 
              ? 'flex flex-col gap-1 h-full' 
              : 'grid grid-cols-2 gap-1'
          }`}>
            
            {/* Right Column/Row: Original Input Area */}
            <div className={`flex flex-col min-h-[120px] ${
              layoutMode === 'stacked' ? 'flex-1 h-1/2' : 'h-full'
            }`}>
              <textarea
                value={originalText}
                onChange={(e) => {
                  setOriginalText(e.target.value);
                  if (!e.target.value.trim()) {
                    setIsPasted(false);
                  }
                }}
                onPaste={() => {
                  setIsPasted(true);
                }}
                placeholder="لصق أو كتابة النص الأصلي هنا..."
                dir={isOriginalRtl ? 'rtl' : 'ltr'}
                className={`w-full flex-1 p-3 rounded-lg border focus:outline-none font-medium leading-relaxed resize-none transition-colors ${
                  isDarkMode 
                    ? 'bg-[#1A212E] text-white border-[#6980b0] placeholder:text-gray-500 focus:ring-1 focus:ring-[#008D75]' 
                    : 'bg-white text-natural-text border-[#A8AB9B] placeholder:text-neutral-400 focus:ring-1 focus:ring-natural-primary'
                } ${
                  isOriginalRtl ? 'text-right' : 'text-left'
                }`}
                maxLength={20000}
                style={{ fontSize: `${fontSize}px` }}
              />
              {/* Character counter for original text */}
              <div className={`flex items-center justify-between px-2 pt-1 pb-0.5 text-[11px] font-medium select-none ${
                isDarkMode ? 'text-slate-400' : 'text-[#7A7A65]'
              }`}>
                <span>عدد الحروف: <span className={`font-bold ${originalText.length > 5000 ? 'text-amber-500 font-black' : isDarkMode ? 'text-slate-200' : 'text-neutral-700'}`}>{originalText.length.toLocaleString()}</span> حرف</span>
                {originalText.length > 5000 && (
                  <span className="text-[10px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                    ⚠️ أكثر من 5,000 حرف
                  </span>
                )}
              </div>
            </div>

            {/* Left Column/Row: Translation View Area */}
            <div className={`flex flex-col min-h-[120px] ${
              layoutMode === 'stacked' ? 'flex-1 h-1/2' : 'h-full'
            }`}>
              <div className="relative w-full flex-1 flex flex-col h-full">
                <textarea
                  readOnly
                  value={translatedText}
                  placeholder="الترجمة اللحظية ستظهر هنا..."
                  dir={isTranslatedRtl ? 'rtl' : 'ltr'}
                  className={`w-full flex-1 p-3 rounded-lg border font-medium leading-relaxed resize-none focus:outline-none transition-colors ${
                    isDarkMode 
                      ? 'bg-[#111822] text-white border-[#6980b0] placeholder:text-gray-600' 
                      : 'bg-[#fcfcfa] text-natural-text border-[#A8AB9B] placeholder:text-neutral-400'
                  } ${
                    isTranslatedRtl ? 'text-right' : 'text-left'
                  }`}
                  style={{ fontSize: `${fontSize}px` }}
                />

                {/* Loading indicator inside translation field */}
                {isTranslating && (
                  <div className={`absolute inset-0 backdrop-blur-[1px] flex items-center justify-center rounded-lg ${
                    isDarkMode ? 'bg-black/60' : 'bg-white/75'
                  }`}>
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-md border ${
                      isDarkMode 
                        ? 'bg-[#1A212E] text-emerald-400 border-[#6980b0]' 
                        : 'bg-white text-natural-primary border-[#A8AB9B]'
                    }`}>
                      <Loader2 size={14} className="animate-spin" />
                      <span className="text-xs font-bold">جاري الترجمة...</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Character counter for translated text */}
              <div className={`flex items-center justify-between px-2 pt-1 pb-0.5 text-[11px] font-medium select-none ${
                isDarkMode ? 'text-slate-400' : 'text-[#7A7A65]'
              }`}>
                <span>عدد الحروف: <span className={`font-bold ${translatedText.length > 5000 ? 'text-rose-500 font-black' : isDarkMode ? 'text-emerald-400' : 'text-[#016f4a]'}`}>{translatedText.length.toLocaleString()}</span> حرف</span>
                {translatedText.length > 5000 && (
                  <span className="text-[10px] font-bold text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">
                    ⚠️ تجاوزت 5,000 حرف
                  </span>
                )}
              </div>
            </div>

          </div>

          {/* Footer Action Buttons Section */}
          <div className={`px-2 py-2 border-t grid grid-cols-2 sm:flex sm:flex-row items-center justify-between gap-2 w-full transition-colors ${
            isDarkMode 
              ? 'bg-[#151D2A] border-[#6980b0]' 
              : 'bg-[#f5f6f2] border-[#A8AB9B]'
          }`}>
            
            {/* 1. نسخ الأصلي (الجوال: أفقياً يمين / Desktop: 1st on right) */}
            <button
              type="button"
              onClick={() => copyText(originalText, 'النص الأصلي')}
              disabled={!originalText.trim()}
              className={`order-1 sm:order-1 flex-1 h-8 flex items-center justify-center gap-1.5 rounded-lg border text-xs sm:text-sm font-bold shadow-sm transition-all disabled:opacity-50 active:scale-95 cursor-pointer whitespace-nowrap min-w-0 ${
                isDarkMode 
                  ? 'bg-[#1A212E] border-[#6980b0] hover:bg-[#253042] text-red-400' 
                  : 'bg-white border-[#A8AB9B] hover:bg-neutral-100 text-red-600'
              }`}
            >
              <Copy size={14} className="shrink-0" />
              <span className="truncate">نسخ الأصلي</span>
            </button>

            {/* 2. نسخ الترجمة (الجوال: أفقياً يسار - مقابل نسخ الأصلي / Desktop: 4th on left) */}
            <button
              type="button"
              onClick={() => copyText(translatedText, 'النص المترجم')}
              disabled={!translatedText.trim()}
              className={`order-2 sm:order-4 flex-1 h-8 flex items-center justify-center gap-1.5 rounded-lg border text-xs sm:text-sm font-bold shadow-sm transition-all disabled:opacity-50 active:scale-95 cursor-pointer whitespace-nowrap min-w-0 ${
                isDarkMode 
                  ? 'bg-[#1A212E] border-[#6980b0] hover:bg-[#253042] text-red-400' 
                  : 'bg-white border-[#A8AB9B] hover:bg-neutral-100 text-red-600'
              }`}
            >
              <Copy size={14} className="shrink-0" />
              <span className="truncate">نسخ الترجمة</span>
            </button>

            {/* 3. حفظ التعديل (الجوال: السطر الثاني يمين - تحت نسخ الأصلي / Desktop: 2nd) */}
            {(() => {
              const isNoPost = !editingPostId;
              const isSaveDisabled = isSavingModification || isSaving || !originalText.trim() || isNoPost;

              return (
                <button
                  type="button"
                  onClick={handleSaveModification}
                  disabled={isSaveDisabled}
                  title={
                    isNoPost
                      ? '⚠️ لا يوجد منشور مرتبط لتعديله (استخدم "حفظ في لوحة" لحفظه كمنشور جديد)'
                      : !originalText.trim()
                      ? '⚠️ يرجى إدخال نص أو رابط صورة أولاً'
                      : 'حفظ التعديل على المنشور الحالي'
                  }
                  className={`group order-3 sm:order-2 flex-1 h-8 flex items-center justify-center gap-1.5 rounded-lg text-xs sm:text-sm font-bold shadow-sm transition-all whitespace-nowrap min-w-0 ${
                    isSaveDisabled
                      ? isDarkMode
                        ? 'bg-[#151D2A] text-neutral-500 border border-[#6980b0]/40 cursor-not-allowed opacity-75 hover:border-red-500/80 hover:bg-red-950/20'
                        : 'bg-neutral-100 text-neutral-400 border border-neutral-300 cursor-not-allowed opacity-75 hover:border-red-500 hover:bg-red-50/50'
                      : isDarkMode 
                        ? 'bg-[#008D75] hover:bg-[#007662] text-white border border-[#008D75] cursor-pointer active:scale-95' 
                        : 'bg-[#016f4a] hover:bg-[#016f4a]/90 text-white border border-[#016f4a] cursor-pointer active:scale-95'
                  }`}
                >
                  {isSavingModification || isSaving ? (
                    <>
                      <Loader2 size={14} className="animate-spin shrink-0" />
                      <span className="truncate">جاري الحفظ...</span>
                    </>
                  ) : isNoPost && originalText.trim() ? (
                    <>
                      <AlertCircle size={14} className="text-red-500 shrink-0 transition-transform group-hover:scale-125 group-hover:animate-pulse drop-shadow-xs" />
                      <span className="truncate transition-colors group-hover:text-red-500">حفظ التعديل</span>
                    </>
                  ) : (
                    <>
                      <Save size={14} className="shrink-0" />
                      <span className="truncate">حفظ التعديل</span>
                    </>
                  )}
                </button>
              );
            })()}

            {/* 4. حفظ في لوحة (الجوال: السطر الثاني يسار - مقابل حفظ التعديل / Desktop: 3rd) */}
            <div className="order-4 sm:order-3 relative flex-1 min-w-0 w-full">
              <button
                type="button"
                onClick={() => setIsSaveDropdownOpen(!isSaveDropdownOpen)}
                disabled={isSaving || !originalText.trim()}
                className={`w-full h-8 flex items-center justify-center gap-1.5 rounded-lg text-white text-xs sm:text-sm font-bold shadow-sm transition-all disabled:opacity-50 active:scale-95 cursor-pointer whitespace-nowrap min-w-0 ${
                  isDarkMode 
                    ? 'bg-[#243B55] hover:bg-[#2D4869] border border-[#6980b0]' 
                    : 'bg-natural-primary hover:bg-natural-primary/95 border border-natural-primary'
                }`}
              >
                {isSaving ? (
                  <>
                    <Loader2 size={14} className="animate-spin shrink-0" />
                    <span className="truncate">جاري الحفظ...</span>
                  </>
                ) : (
                  <span className="truncate">حفظ في لوحة</span>
                )}
              </button>

              <AnimatePresence>
                {isSaveDropdownOpen && (
                  <>
                    <div 
                      className="fixed inset-0 z-10" 
                      onClick={() => setIsSaveDropdownOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className={`absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 max-h-60 overflow-y-auto border rounded-xl shadow-2xl z-20 py-1 ${
                        isDarkMode 
                          ? 'bg-[#1A212E] border-[#6980b0] text-white' 
                          : 'bg-white border-[#A8AB9B] text-natural-text'
                      }`}
                    >
                      <div className={`px-2 py-1 text-[10px] font-bold text-center border-b ${
                        isDarkMode 
                          ? 'bg-[#111822] text-[#B4C6D8] border-[#6980b0]/50' 
                          : 'bg-neutral-100 text-neutral-600 border-[#A8AB9B]/60'
                      }`}>
                        اختر لوحة لحفظ النص
                      </div>
                      
                      <button
                        type="button"
                        onClick={() => handleSaveToBoard(null)}
                        className={`w-full text-right px-3 py-2 text-xs font-bold border-b transition-colors ${
                          isDarkMode 
                            ? 'text-amber-400 hover:bg-[#253042] border-[#6980b0]/40' 
                            : 'text-[#c26700] hover:bg-[#fffaf5] border-[#A8AB9B]/40'
                        }`}
                      >
                        الرئيسية (العامة)
                      </button>

                      {(isAdmin ? boards : boards.filter(b => !b.hidden)).map((board) => (
                        <button
                          key={board.id}
                          type="button"
                          onClick={() => handleSaveToBoard(board.id)}
                          className={`w-full flex items-center justify-between px-3 py-2 text-xs font-bold transition-colors text-right ${
                            isDarkMode 
                              ? 'text-gray-200 hover:bg-[#253042]' 
                              : 'text-natural-text hover:bg-neutral-100'
                          }`}
                          title={board.name}
                        >
                          <span className="truncate">{board.name}</span>
                          {board.hidden && (
                            <span className="text-[10px] bg-red-600/20 text-red-600 border border-red-500/30 px-1.5 py-0.5 rounded-md font-black shrink-0 flex items-center gap-1">
                              مخفية
                            </span>
                          )}
                        </button>
                      ))}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

          </div>

        </motion.div>

        {/* Smart Deduplication Interactive Modal */}
        <AnimatePresence>
          {duplicateModalOpen && duplicateFoundPost && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[3000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setDuplicateModalOpen(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className={`relative w-full max-w-md rounded-3xl p-5 sm:p-6 shadow-2xl border text-right transition-colors ${
                  isDarkMode 
                    ? 'border-[#6980b0] bg-[#111822] text-white' 
                    : 'border-[#A8AB9B] bg-white text-natural-text'
                }`}
                onClick={(e) => e.stopPropagation()}
                dir="rtl"
              >
                <div className="flex flex-col items-center text-center gap-2.5">
                  <div className="h-12 w-12 rounded-full bg-amber-500/15 flex items-center justify-center text-amber-500 text-2xl">
                    ⚠️
                  </div>
                  <h3 className={`text-base sm:text-lg font-black ${isDarkMode ? 'text-white' : 'text-[#3A3A28]'}`}>
                   هذا المنشور موجود سابقاً
                  </h3>
                  <p className={`text-xs leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-natural-muted'}`}>
                   تم العثور على منشور مطابق تماماً في المحتوى داخل اللوحات
                  </p>
                </div>

                {/* Snippet preview of duplicate post */}
                <div className={`mt-3.5 p-3 rounded-2xl border text-xs max-h-24 overflow-y-auto leading-relaxed ${
                  isDarkMode ? 'bg-[#1A212E] border-[#6980b0] text-gray-300' : 'bg-neutral-50 border-[#A8AB9B] text-neutral-700'
                }`}>
                  <span className="font-bold block mb-1 text-[11px] text-amber-500">مضمون المنشور السابق:</span>
                  <p className="line-clamp-3">{duplicateFoundPost.text}</p>
                </div>

                {/* Options */}
                <div className="mt-5 space-y-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDuplicateModalOpen(false);
                      onClose();
                      const targetBoard = duplicateFoundPost.boardId === 'user-board' 
                        ? 'user-board' 
                        : (duplicateFoundPost.boardId || null);
                      const targetSubBoard = duplicateFoundPost.subBoardId || null;
                      
                      const targetPostId = String(duplicateFoundPost.id);
                      (window as any).__pendingHighlightPostId = targetPostId;

                      if (onSelectBoard) {
                        onSelectBoard(targetBoard);
                      }
                      
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('highlight_post', { 
                          detail: { postId: targetPostId, boardId: targetBoard, subBoardId: targetSubBoard } 
                        }));
                      }, 100);

                      showToast('تم الانتقال إلى المنشور السابق وتظليله بنجاح! 🎯');
                    }}
                    className="w-full py-2.5 px-4 rounded-xl text-xs font-black text-white bg-[#008D75] hover:bg-opacity-90 transition-all shadow-sm cursor-pointer flex items-center justify-center gap-2"
                  >
                    <span>📍</span>
                    <span>الذهاب للمنشور القديم</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setDuplicateModalOpen(false);
                      handleSaveToBoard(pendingBoardIdToSave, true);
                    }}
                    className={`w-full py-2.5 px-4 rounded-xl text-xs font-black border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      isDarkMode
                        ? 'border-amber-500/40 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                        : 'border-amber-500/40 text-amber-700 bg-amber-50 hover:bg-amber-100'
                    }`}
                  >
                    <span>⚡</span>
                    <span>الحفظ على أي حال</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDuplicateModalOpen(false)}
                    className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      isDarkMode
                        ? 'border-[#6980b0] bg-[#1A212E] text-gray-400 hover:bg-[#253042]'
                        : 'border-[#A8AB9B] bg-white text-natural-muted hover:bg-neutral-50'
                    }`}
                  >
                    <span>❌</span>
                    <span>إلغاء الحفظ</span>
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </AnimatePresence>
  );
}

