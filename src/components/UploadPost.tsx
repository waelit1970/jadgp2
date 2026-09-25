import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { db, auth } from '../lib/firebase';

// Bump on every client deploy so the phone reports exactly which bundle ran.
const APP_BUILD = 'app-2026-09-24-e';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { Image as ImageIcon, Send, X, Loader2, RefreshCw, ChevronDown } from 'lucide-react';
import { getCurrentUser, googleSignIn, getAccessToken, refreshAccessTokenServer } from '../lib/auth';
import { motion, AnimatePresence } from 'motion/react';
import { handleFirestoreError } from '../lib/error-handler';
import { OperationType, Board } from '../types';

import { uploadPostImage } from '../lib/upload-helper';
import { isMediaFile } from '../lib/r2';
import { normalizePostText } from '../lib/deduplication';
import { ADMIN_CONFIG } from '../config';
import { compressImage, smartCompressImage, downloadAndSmartCompressImageFromUrl, extractImageUrlsFromText } from '../lib/imageCompressor';
import { saveLocalUserPostsIndexedDB, getLocalUserPostsIndexedDB } from '../lib/indexedDbService';
import { showToast } from './Toast';
import { encryptText, encryptArray } from '../lib/encryption';
import AudioPlayer from './AudioPlayer';
import VideoPlayer from './VideoPlayer';

interface UploadPostProps {
  activeBoardId: string | null;
  activeBoardName?: string;
  boards?: Board[];
  onUploadSuccess?: (boardId: string | null, subBoardId?: string | null) => void;
  isDarkMode?: boolean;
}

export default function UploadPost({ activeBoardId, activeBoardName, boards = [], onUploadSuccess, isDarkMode }: UploadPostProps) {
  const [text, setText] = useState('');
  const [targetBoardId, setTargetBoardId] = useState<string | null>(activeBoardId || 'placeholder');
  const [targetSubBoardId, setTargetSubBoardId] = useState<string | null>(null);
  const [isSelectBoardDrawerOpen, setIsSelectBoardDrawerOpen] = useState(false);

  const [currentUser, setCurrentUser] = useState<any>(auth.currentUser);

  // Safe board password states
  const [showSafePasswordModal, setShowSafePasswordModal] = useState(false);
  const [safePasswordInput, setSafePasswordInput] = useState('');
  const [safePasswordError, setSafePasswordError] = useState(false);
  const [onSuccessCallback, setOnSuccessCallback] = useState<(() => void) | null>(null);

  // Smart Deduplication states
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [duplicateFoundPost, setDuplicateFoundPost] = useState<any | null>(null);
  const isBypassingDeduplicationRef = useRef(false);
  const processingUrlsRef = useRef<Set<string>>(new Set());

  const [downloadingImageLoading, setDownloadingImageLoading] = useState(false);
  const [previewModalUrl, setPreviewModalUrl] = useState<string | null>(null);

  const downloadAndAttachImageFromUrl = async (imageUrl: string) => {
    if (!imageUrl || downloadingImageLoading) return;
    if (processingUrlsRef.current.has('ATTACHED_IMG:' + imageUrl)) return;
    processingUrlsRef.current.add('ATTACHED_IMG:' + imageUrl);

    setDownloadingImageLoading(true);
    showToast('📸 جاري جلب وضغط الصورة الذكي...');

    try {
      const file = await downloadAndSmartCompressImageFromUrl(imageUrl);
      if (!file) {
        throw new Error('فشل تنزيل ملف الصورة من الرابط.');
      }

      const previewUrl = URL.createObjectURL(file);
      const fileSizeStr = formatFileSize(file.size);

      const formatCaptionSize = (bytes: number): string => {
        if (!bytes || bytes <= 0) return '';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const num = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
        // Put unit (KB) on the right of the number in RTL display: (KB 16.5)
        return `\u200F${sizes[i]} \u200E${num}\u200F`;
      };

      const captionSizeStr = formatCaptionSize(file.size);

      setImages(prev => [...prev, file]);
      setSelectedModels(prev => [...prev, '']);
      setImageCaptions(prev => [...prev, `صورة معالجة (${captionSizeStr})`]);
      setFileNames(prev => [...prev, file.name]);
      setFileTypes(prev => [...prev, file.type || 'image/jpeg']);
      setFileSizes(prev => [...prev, fileSizeStr]);

      const previewString = `file:${file.name}:${file.type || 'image/jpeg'}:${fileSizeStr}:${previewUrl}`;
      setPreviews(prev => [...prev, previewString]);

      showToast('✨ تم تنزيل وضغط الصورة بالدقة الكاملة بنجاح');
    } catch (err: any) {
      console.error('[DownloadImage] Error:', err);
      showToast(err.message || 'تعذر تنزيل ملف الصورة تلقائياً من الرابط');
      processingUrlsRef.current.delete('ATTACHED_IMG:' + imageUrl);
    } finally {
      setDownloadingImageLoading(false);
    }
  };

  const fetchUrlAsFile = async (url: string): Promise<File | null> => {
    try {
      // If it's an image URL, use smart compression
      const isImg = /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(url.split('?')[0]) ||
                    /(fbcdn\.net|cdninstagram\.com|instagram\.com\/p\/|facebook\.com\/photo|scontent[^\/]+\.net|imgur\.com)/i.test(url);
      if (isImg) {
        const smartCompressed = await downloadAndSmartCompressImageFromUrl(url);
        if (smartCompressed) return smartCompressed;
      }

      const isNetlify = typeof window !== 'undefined' && window.location.hostname.includes('netlify.app');
      const isStaticHost =
        typeof window !== 'undefined' &&
        !isNetlify &&
        (window.location.hostname.includes('workers.dev') ||
          window.location.hostname.includes('pages.dev') ||
          window.location.hostname.includes('github') ||
          window.location.hostname.includes('vercel') ||
          (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app')));
      const backendBaseUrl = isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';

      const downloadEndpoint = isNetlify
        ? `/.netlify/functions/download?url=${encodeURIComponent(url)}`
        : `${backendBaseUrl}/api/download?url=${encodeURIComponent(url)}`;

      let blob: Blob | null = null;
      try {
        const res = await fetch(downloadEndpoint);
        if (res.ok) {
          const b = await res.blob();
          if (b && b.size > 0) blob = b;
        }
      } catch (e) {
        console.warn('Proxy fetch failed in fetchUrlAsFile:', e);
      }

      if (!blob || blob.size === 0) {
        try {
          const direct = await fetch(url, { mode: 'cors' });
          if (direct.ok) {
            const b = await direct.blob();
            if (b && b.size > 0) blob = b;
          }
        } catch (e) {
          console.warn('Direct fetch failed in fetchUrlAsFile:', e);
        }
      }

      if (!blob || blob.size === 0) return null;

      const mimeType = blob.type || (url.match(/\.(mp4|mov|webm)$/i) ? 'video/mp4' : 'image/jpeg');
      const isVideo = mimeType.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(url);
      const ext = isVideo ? 'mp4' : (mimeType.includes('png') ? 'png' : 'jpg');
      const fileName = `media_${Date.now()}.${ext}`;

      const rawFile = new File([blob], fileName, { type: mimeType });
      if (mimeType.startsWith('image/')) {
        return await smartCompressImage(rawFile, fileName);
      }
      return rawFile;
    } catch (err) {
      console.warn('Error in fetchUrlAsFile:', err);
      return null;
    }
  };

  React.useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  const isAdmin = currentUser?.email === ADMIN_CONFIG.email;

  React.useEffect(() => {
    setTargetBoardId(activeBoardId || 'placeholder');
  }, [activeBoardId]);

  React.useEffect(() => {
    if (isSelectBoardDrawerOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      // Push a history state to capture back gestures/hardware back clicks
      window.history.pushState({ drawer: 'upload_select_board' }, '');

      const handlePopState = () => {
        setIsSelectBoardDrawerOpen(false);
        window.dispatchEvent(new Event('unlock_posts_layout'));
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        document.body.style.overflow = originalOverflow;
        window.removeEventListener('popstate', handlePopState);
        if (window.history.state?.drawer === 'upload_select_board') {
          window.history.back();
        }
      };
    }
  }, [isSelectBoardDrawerOpen]);

  const currentTargetBoard = boards.find(b => b.id === targetBoardId);
  const currentTargetSubBoard = currentTargetBoard?.subBoards?.find(s => s.id === targetSubBoardId);

  const getTargetBoardName = () => {
    if (!targetBoardId || targetBoardId === 'placeholder') return 'تحديد اللوحة الرئيسية';
    if (targetBoardId === 'user-board') return 'لوحة شخصية';
    if (targetBoardId === 'main-feed') return 'الرئيسية';
    return currentTargetBoard?.name || 'الرئيسية';
  };

  const getTargetSubBoardName = () => {
    if (!currentTargetBoard || !currentTargetBoard.subBoards || currentTargetBoard.subBoards.length === 0) return null;
    return currentTargetSubBoard ? currentTargetSubBoard.name : 'كل الفرعيات';
  };

  // Auto-detect direction helper: returns true if Arabic/RTL is matched
  const isRtl = (val: string): boolean => {
    if (!val) return true; // Default to natural Arabic direction
    let arabicCount = 0;
    let englishCount = 0;
    for (let i = 0; i < val.length; i++) {
      const charCode = val.charCodeAt(i);
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
    const rtlChar = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\uFE70-\uFEFC]/;
    return rtlChar.test(val);
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const [images, setImages] = useState<(File | string)[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [imageCaptions, setImageCaptions] = useState<string[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [fileTypes, setFileTypes] = useState<string[]>([]);
  const [fileSizes, setFileSizes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [postFontSize, setPostFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('post_font_size');
    return saved ? parseInt(saved, 10) : 14;
  });

  React.useEffect(() => {
    const handleFontSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && typeof customEvent.detail.size === 'number') {
        setPostFontSize(customEvent.detail.size);
      }
    };
    window.addEventListener('post_font_size_changed', handleFontSizeChange);
    return () => {
      window.removeEventListener('post_font_size_changed', handleFontSizeChange);
    };
  }, []);

  const processTextForImageUrls = async (inputText: string) => {
    const { foundUrls, cleanText } = extractImageUrlsFromText(inputText);
    if (foundUrls.length === 0) {
      setText(inputText);
      return;
    }

    setText(cleanText);

    for (const href of foundUrls) {
      const cleanUrl = href.split('?')[0].split('#')[0];
      if (!processingUrlsRef.current.has(href) && !processingUrlsRef.current.has(cleanUrl)) {
        processingUrlsRef.current.add(href);
        processingUrlsRef.current.add(cleanUrl);
        downloadAndAttachImageFromUrl(href);
      }
    }
  };

  React.useEffect(() => {
    const checkIncomingShare = async () => {
      // DIAGNOSTIC (2026-09): phones have no devtools console, so every share attempt is
      // reported to the server. Read it with: netlify logs:function share-diag
      const reportShareDiag = async (payload: Record<string, unknown>) => {
        try {
          await fetch('/api/share-diag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...payload,
              appBuild: APP_BUILD,
              swControlled: !!navigator.serviceWorker?.controller,
              query: window.location.search,
              ua: navigator.userAgent,
              at: new Date().toISOString(),
            }),
          });
        } catch {
          /* diagnostics must never break the flow */
        }
      };

      await reportShareDiag({ stage: 'app-loaded' });

      // Attach an image the server returned inline (base64). Used when the server could not host
      // the extracted image — the phone then attaches it and uploads via the app's own path.
      const attachInlineImage = async (dataUrl: string) => {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const mimeType = blob.type || 'image/jpeg';
        const extension = mimeType.includes('png')
          ? 'png'
          : mimeType.includes('webp')
            ? 'webp'
            : mimeType.includes('gif')
              ? 'gif'
              : 'jpg';
        const file = new File([blob], `link_${Date.now()}.${extension}`, { type: mimeType });
        setImages([file]);
        setSelectedModels(['']);
        setImageCaptions(['']);
        const reader = new FileReader();
        reader.onloadend = () => setPreviews([reader.result as string]);
        reader.readAsDataURL(file);
      };

      // 1. Check local storage for simple text shares
      const sharedText = localStorage.getItem('shared_incoming_post');
      if (sharedText) {
        setText(sharedText);
        localStorage.removeItem('shared_incoming_post');
        showToast('تم جلب النص بنجاح إلى حقل كتابة المنشور! ✍️');
      }

      // 2. Server-side share receiver (netlify/functions/share.ts or server.ts) may have
      // already uploaded the image and passed its URL in the query string.
      const qp = new URLSearchParams(window.location.search);
      const serverSharedImage = qp.get('sharedImageUrl');
      if (serverSharedImage) {
        await downloadAndAttachImageFromUrl(decodeURIComponent(serverSharedImage));
      }

      // 3. Check Cache Storage for PWA Web Share Target (images & metadata)
      if ('caches' in window) {
        try {
          const cache = await caches.open('shared-data');
          const metaRes = await cache.match('shared-meta');
          
          if (metaRes) {
            const meta = await metaRes.json();
            console.log('[PWA Share Target] Found metadata:', meta);
            
            let combinedText = meta.text || '';
            if (meta.title && meta.title !== 'undefined' && meta.title !== '') {
              combinedText = `${meta.title}\n${combinedText}`.trim();
            }
            if (meta.url && meta.url !== 'undefined' && !combinedText.includes(meta.url)) {
              combinedText = `${combinedText}\n${meta.url}`.trim();
            }
            
            if (combinedText) {
              setText(combinedText);
            }
            
            // Delete metadata from cache
            await cache.delete('shared-meta');
            
            // Get shared file (image)
            const fileRes = await cache.match('shared-file');
            if (fileRes) {
              const blob = await fileRes.blob();
              const mimeType = blob.type || 'image/png';
              let extension = 'png';
              if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
                extension = 'jpg';
              } else if (mimeType.includes('webp')) {
                extension = 'webp';
              } else if (mimeType.includes('gif')) {
                extension = 'gif';
              }
              // Construct a valid File object with proper extension
              const file = new File([blob], `shared_${Date.now()}.${extension}`, { type: mimeType });
              
              setImages([file]);
              setSelectedModels(['']);
              setImageCaptions(['']);
              
              const reader = new FileReader();
              reader.onloadend = () => {
                setPreviews([reader.result as string]);
              };
              reader.readAsDataURL(file);
              
              // Delete cached file
              await cache.delete('shared-file');
            }
            
            // FALLBACK: no file bytes arrived (Chrome regression drops the file part) but a link did —
            // ask the server to extract the lead image from that link.
            // Android may deliver the link in meta.url OR inside meta.text, so check both.
            const linkUrl =
              (meta.url && /^https?:\/\//.test(meta.url) ? meta.url : '') ||
              ((combinedText.match(/https?:\/\/[^\s]+/) || [])[0] || '');
            let linkImageAttached = false;
            if (!fileRes && !serverSharedImage && linkUrl) {
              try {
                await reportShareDiag({ stage: 'link-attempt', linkUrl });
                let token = '';
                try {
                  // Firebase restores the saved session asynchronously, so on a cold open
                  // auth.currentUser can still be null here — the server then answers 401.
                  const a: any = auth;
                  if (a && typeof a.authStateReady === 'function') await a.authStateReady();
                  let user = a?.currentUser;
                  if (!user) {
                    await new Promise((r) => setTimeout(r, 900));
                    user = a?.currentUser;
                  }
                  if (user) token = (await user.getIdToken()) || '';
                } catch { /* token is best-effort */ }
                const r = await fetch('/api/resolve-shared-image', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                  },
                  body: JSON.stringify({ url: linkUrl }),
                });
                const d: any = await r.json().catch(() => ({}));
                await reportShareDiag({
                  stage: 'link-result',
                  status: r.status,
                  ok: r.ok,
                  hasPublicUrl: !!d?.publicUrl,
                  hasDataUrl: !!d?.dataUrl,
                  error: d?.error,
                });
                if (r.ok && d && d.publicUrl) {
                  await downloadAndAttachImageFromUrl(d.publicUrl);
                  linkImageAttached = true;
                } else if (r.ok && d && d.dataUrl) {
                  await attachInlineImage(d.dataUrl);
                  linkImageAttached = true;
                } else {
                  showToast('⚠️ تعذّر استخراج صورة من الرابط: ' + (d?.error || r.status));
                }
              } catch (e) {
                console.error('[ShareFallback] resolve-shared-image failed:', e);
                showToast('⚠️ فشل طلب استخراج صورة الرابط.');
              }
            }

            await reportShareDiag({ stage: 'cache-meta-found', hadFile: !!fileRes, meta });

            if (fileRes) {
              showToast('📥 تم جلب الصورة والنص من المشاركة بنجاح!');
            } else if (linkImageAttached) {
              showToast('🖼️ تم استخراج صورة الرابط وإرفاقها تلقائياً.');
            } else if (meta.hasFile) {
              showToast('⚠️ وصلت إشارة بوجود صورة لكن ملف الصورة لم يصل (خلل Chrome 153) — أضف الصورة يدوياً.');
            } else if (combinedText) {
              showToast('📥 تم جلب النص فقط — التطبيق المُرسِل لم يرسل ملف صورة.');
            } else {
              showToast('⚠️ لم يصل أي محتوى من المشاركة.');
            }
          } else if (qp.get('sharedNoFile') === 'true' && !serverSharedImage) {
            await reportShareDiag({
              stage: 'no-cache-meta',
              sharedNoFile: qp.get('sharedNoFile'),
              sharedError: qp.get('sharedError'),
              sharedUploadFailed: qp.get('sharedUploadFailed'),
              serverSharedImage: !!serverSharedImage,
            });
            showToast('⚠️ Chrome أرسل المشاركة بدون ملف الصورة (خلل معروف في Chrome 153 على أندرويد) — أضف الصورة يدوياً من زر «إضافة ملفات أو صور».');
          }
        } catch (err) {
          console.error('[PWA Share Target] Error checking cache:', err);
        }
      }
    };

    // Android usually reuses the already-running instance instead of reloading it, so a
    // mount-time check alone misses shares that arrive while the app sits in the background.
    // Re-check whenever the app returns to the foreground and fresh share data is waiting.
    const recheckShare = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        const c = await caches.open('shared-data');
        if (await c.match('shared-meta')) await checkIncomingShare();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('storage', checkIncomingShare);
    document.addEventListener('visibilitychange', recheckShare);
    window.addEventListener('pageshow', recheckShare);
    checkIncomingShare();

    window.addEventListener('check_shared_post', checkIncomingShare);

    return () => {
      window.removeEventListener('storage', checkIncomingShare);
      window.removeEventListener('check_shared_post', checkIncomingShare);
    };
  }, []);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    const newImages = [...images];
    const newModels = [...selectedModels];
    const newCaptions = [...imageCaptions];
    const newFileNames = [...fileNames];
    const newFileTypes = [...fileTypes];
    const newFileSizes = [...fileSizes];

    files.forEach(file => {
      newImages.push(file);
      newModels.push(''); // No model selected initially
      newCaptions.push(''); // No caption initially
      newFileNames.push(file.name);
      newFileTypes.push(file.type || 'application/octet-stream');
      newFileSizes.push(formatFileSize(file.size));
      
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPreviews(prev => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      } else {
        const localUrl = URL.createObjectURL(file);
        setPreviews(prev => [...prev, `file:${file.name}:${file.type || 'application/octet-stream'}:${formatFileSize(file.size)}:${localUrl}`]);
      }
    });

    setImages(newImages);
    setSelectedModels(newModels);
    setImageCaptions(newCaptions);
    setFileNames(newFileNames);
    setFileTypes(newFileTypes);
    setFileSizes(newFileSizes);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    const previewToRemove = previews[index];
    if (previewToRemove && previewToRemove.startsWith('file:')) {
      const parts = previewToRemove.split(':');
      const objectUrl = parts.slice(4).join(':');
      if (objectUrl && objectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(objectUrl);
      }
    }
    const newImages = images.filter((_, i) => i !== index);
    const newPreviews = previews.filter((_, i) => i !== index);
    const newModels = selectedModels.filter((_, i) => i !== index);
    const newCaptions = imageCaptions.filter((_, i) => i !== index);
    const newFileNames = fileNames.filter((_, i) => i !== index);
    const newFileTypes = fileTypes.filter((_, i) => i !== index);
    const newFileSizes = fileSizes.filter((_, i) => i !== index);
    setImages(newImages);
    setPreviews(newPreviews);
    setSelectedModels(newModels);
    setImageCaptions(newCaptions);
    setFileNames(newFileNames);
    setFileTypes(newFileTypes);
    setFileSizes(newFileSizes);
    if (newPreviews.length === 0) {
      processingUrlsRef.current.clear();
    }
  };

  const [status, setStatus] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const targetProgressRef = useRef<number>(0);
  const imagesLengthRef = useRef<number>(images.length);
  imagesLengthRef.current = images.length;
  const [uploadError, setUploadError] = useState<{message: string, showRefresh?: boolean} | null>(null);

  React.useEffect(() => {
    if (!loading) {
      setUploadProgress(0);
      targetProgressRef.current = 0;
      return;
    }

    targetProgressRef.current = 5;
    let tickCount = 0;

    const interval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) return 100;

        const target = targetProgressRef.current;
        if (prev < target) {
          // Smoothly and continuously increment 1% or 2% to catch up to target without big jumps
          const diff = target - prev;
          const step = diff > 40 ? 2 : 1;
          return Math.min(100, prev + step);
        }
        return prev;
      });
    }, 15);

    return () => clearInterval(interval);
  }, [loading]);

  const handleAuthorize = async (shouldSetLoadingState = true): Promise<boolean> => {
    if (shouldSetLoadingState) setLoading(true);
    setStatus('طلب صلاحيات G-Drive للرفع والحفظ ');
    try {
      await googleSignIn();
      setUploadError(null);
      return true;
    } catch (err) {
      console.error('Sign in failed:', err);
      setUploadError({
        message: 'فشل الحصول على صلاحية الوصول إلى Google Drive. يرجى التأكد من السماح بالنوافذ المنبثقة من المتصفح والموافقة.',
        showRefresh: true
      });
      showToast('فشل الحصول على صلاحية الوصول. يرجى التأكد من السماح بالنوافذ المنبثقة.');
      return false;
    } finally {
      if (shouldSetLoadingState) {
        setLoading(false);
        setStatus('');
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let currentUser = getCurrentUser();
    
    const hasText = text.trim().length > 0;
    const hasImages = images.length > 0;

    if (!hasText && !hasImages) {
      showToast('لا يمكن نشر منشور فارغ (برجاء كتابة نص أو إضافة ملف/صورة)');
      return;
    }

    setLoading(true);
    setUploadError(null);

    // Smart Deduplication check
    if (!isBypassingDeduplicationRef.current && hasText) {
      const { cleanBody } = normalizePostText(text);
      if (cleanBody.length >= 5) {
        setStatus('جاري الفحص الذكي لتجنب التكرار...');
        let existingMatch: any = null;

        if (targetBoardId === 'user-board') {
          try {
            const localPosts = await getLocalUserPostsIndexedDB();
            for (const p of localPosts) {
              if (p && p.text) {
                const { cleanBody: existingBody } = normalizePostText(p.text);
                if (existingBody && existingBody === cleanBody) {
                  existingMatch = { ...p, boardId: 'user-board' };
                  break;
                }
              }
            }
          } catch (err) {
            console.warn('[UploadPost] Local deduplication check error:', err);
          }
        } else {
          try {
            const { collection, getDocs } = await import('firebase/firestore');
            const postsSnapshot = await getDocs(collection(db, 'posts'));
            postsSnapshot.forEach((docSnap) => {
              if (existingMatch) return;
              const pData = docSnap.data();
              if (pData.text) {
                const { cleanBody: existingBody } = normalizePostText(pData.text);
                if (existingBody && existingBody === cleanBody) {
                  existingMatch = { id: docSnap.id, ...pData };
                }
              }
            });
          } catch (err) {
            console.warn('[UploadPost] Firestore deduplication check error:', err);
          }
        }

        if (existingMatch) {
          setLoading(false);
          setStatus('');
          setDuplicateFoundPost(existingMatch);
          setDuplicateModalOpen(true);
          return;
        }
      }
    }
    isBypassingDeduplicationRef.current = false;

    // Intercept local posts
    if (targetBoardId === 'user-board') {
      try {
        const imageUrls: string[] = [];
        setUploadProgress(0);
        for (let i = 0; i < images.length; i++) {
          const file = images[i];
          for (let p = 1; p <= 100; p++) {
            setUploadProgress(Math.round(((i * 100) + p) / images.length));
            await new Promise(r => setTimeout(r, 6));
          }
          if (typeof file === 'string') {
            imageUrls.push(file);
          } else {
            if (file.type.startsWith('image/')) {
              const base64 = await compressImage(file);
              imageUrls.push(base64);
            } else {
              // Non-image files in local mode are kept as local ObjectURLs or marked as local files
              imageUrls.push(`data:${file.type};name=${encodeURIComponent(file.name)},local-file-placeholder`);
            }
          }
        }

        const payload = {
          id: 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
          text: text.trim(),
          imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
          imageUrls: imageUrls,
          imageModels: selectedModels,
          imageCaptions: imageCaptions,
          fileNames: fileNames,
          fileTypes: fileTypes,
          fileSizes: fileSizes,
          boardId: 'user-board',
          authorId: currentUser?.uid || 'local-user',
          authorEmail: currentUser?.email || 'local-user@local.com',
          createdAtMillis: Date.now(),
        };

        const parsed = await getLocalUserPostsIndexedDB();
        parsed.unshift(payload);
        
        const isSaved = await saveLocalUserPostsIndexedDB(parsed);
        if (isSaved) {
          setText('');
          setImages([]);
          setPreviews([]);
          setSelectedModels([]);
          setImageCaptions([]);
          setFileNames([]);
          setFileTypes([]);
          setFileSizes([]);
          setStatus('');
          processingUrlsRef.current.clear();
          window.dispatchEvent(new Event('reload_local_posts'));
          if (onUploadSuccess) {
            onUploadSuccess('user-board');
          }
          showToast('تم الحفظ والنشر في لوحتك الشخصية محلياً 🎉');
        }
      } catch (err: any) {
        console.error(err);
        showToast('حدث خطأ أثناء الحفظ محلياً: ' + err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!currentUser) {
      showToast('يجب تسجيل الدخول لنشر منشور في اللوحات العامة.');
      setLoading(false);
      return;
    }

    // Every uploaded file (image, video, audio, doc) goes to Google Drive now that R2 is removed,
    // so ensure we have a valid Google token or renew it before starting the uploads.
    const hasDriveFilesToUpload = images.some(img => typeof img !== 'string');
    if (hasDriveFilesToUpload) {
      const activeToken = getAccessToken();
      if (!activeToken || activeToken === 'local-dummy-token') {
        const refreshedToken = await refreshAccessTokenServer();
        if (refreshedToken) {
          currentUser = getCurrentUser();
        } else {
          // If silent server refresh failed, open Google Auth popup directly within user submit handler
          const ok = await handleAuthorize(false);
          if (!ok) {
            setLoading(false);
            return;
          }
          currentUser = getCurrentUser();
        }
      }
    }
    
    setLoading(true);
    setUploadError(null);
    setUploadProgress(5);
    targetProgressRef.current = 5;
    
    try {
      // 1. Upload files (Media -> Cloudflare R2, Images/Docs -> Google Drive)
      const imageUrls: string[] = [];
      if (images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          let file = images[i];

          // If file is a raw external URL string (e.g. from Meta / Facebook / Instagram), download it on the fly as a File object!
          if (typeof file === 'string' && (file.startsWith('http://') || file.startsWith('https://'))) {
            const downloadStatus = `جاري تنزيل الملف الخارجي للمعالجة (${i + 1}/${images.length})...`;
            console.log(`[UploadPost] Status: ${downloadStatus}`);
            setStatus(downloadStatus);

            const downloadedFile = await fetchUrlAsFile(file);
            if (downloadedFile) {
              file = downloadedFile;
              if (!fileNames[i] || fileNames[i] === 'ملف' || fileNames[i] === '') {
                fileNames[i] = downloadedFile.name;
              }
              if (!fileTypes[i] || fileTypes[i] === '' || fileTypes[i] === 'application/octet-stream') {
                fileTypes[i] = downloadedFile.type;
              }
              if (!fileSizes[i] || fileSizes[i] === '') {
                fileSizes[i] = formatFileSize(downloadedFile.size);
              }
            } else {
              imageUrls.push(file);
              continue;
            }
          }

          if (typeof file === 'string') {
            imageUrls.push(file);
            continue;
          }

          const isMedia = isMediaFile(file);
          const targetStorage = 'Google Drive';
          const currentStatus = `يتم رفع ${isMedia ? 'الميديا' : 'الملف'} ${i + 1} من ${images.length} إلى ${targetStorage}`;
          console.log(`[UploadPost] Status: ${currentStatus}`);
          setStatus(currentStatus);
          try {
            const url = await uploadPostImage(file, currentUser.uid, text, (percent) => {
              const overallPercent = Math.round(((i * 100) + percent) / images.length);
              targetProgressRef.current = Math.max(targetProgressRef.current, overallPercent);
            });
            imageUrls.push(url);
          } catch (uploadErr: any) {
            console.warn('[UploadPost] File upload error:', uploadErr);
            throw uploadErr;
          }
        }
      }

      // 2. Save document to Firestore
      targetProgressRef.current = 95;
      const postsPath = 'posts';
      const currentStatusSave = 'جاري الحفظ في قاعدة البيانات';
      console.log(`[UploadPost] Status: ${currentStatusSave}`);
      setStatus(currentStatusSave);
      
      // Always get the absolute latest user credentials before Firestore payload construction
      currentUser = getCurrentUser();
      
      const isSafeBoard = targetBoardId === 'safe-board';
      const vaultKey = sessionStorage.getItem('safe_vault_password') || '';

      const textToSave = isSafeBoard && vaultKey ? encryptText(text.trim(), vaultKey) : text.trim();
      const captionsToSave = isSafeBoard && vaultKey ? encryptArray(imageCaptions, vaultKey) : imageCaptions;
      const fileNamesToSave = isSafeBoard && vaultKey ? encryptArray(fileNames, vaultKey) : fileNames;
      const fileSizesToSave = isSafeBoard && vaultKey ? encryptArray(fileSizes, vaultKey) : fileSizes;

      const payload = {
        text: textToSave,
        imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
        imageUrls: imageUrls,
        imageModels: selectedModels,
        imageCaptions: captionsToSave,
        fileNames: fileNamesToSave,
        fileTypes: fileTypes,
        fileSizes: fileSizesToSave,
        boardId: (targetBoardId === 'placeholder' || targetBoardId === 'main-feed' || !targetBoardId) ? null : targetBoardId, // Explicitly null for main feed
        subBoardId: targetSubBoardId,
        authorId: currentUser.uid,
        authorEmail: currentUser.email,
        createdAt: serverTimestamp(),
      };

      console.log('[UploadPost] Payload to Firestore:', payload);
      
      try {
        const docRef = await addDoc(collection(db, postsPath), payload);
        console.log('[UploadPost] Success! Doc ID:', docRef.id);
        if (onUploadSuccess) {
          const successId = (targetBoardId === 'placeholder' || targetBoardId === 'main-feed') ? null : targetBoardId;
          onUploadSuccess(successId, targetSubBoardId);
        }
      } catch (err) {
        console.error('[UploadPost] Firestore Save Internal Error:', err);
        handleFirestoreError(err, OperationType.CREATE, postsPath);
      }

      // Complete to 100% smoothly
      targetProgressRef.current = 100;
      await new Promise(resolve => setTimeout(resolve, 450));

      // Reset form
      setText('');
      setImages([]);
      setPreviews([]);
      setSelectedModels([]);
      setImageCaptions([]);
      setFileNames([]);
      setFileTypes([]);
      setFileSizes([]);
      setStatus('');
      showToast('🎉تم نشر الملفات بنجاح');
    } catch (error) {
      console.error('Final upload error track:', error);
      const msg = error instanceof Error ? error.message : String(error);
      let isAuthErr = msg.includes('AUTH_REQUIRED') || msg.includes('AUTH_EXPIRED') || msg.includes('401') || msg.includes('403') || msg.includes('expired') || msg.includes('token');
      
      setUploadError({ 
         message: isAuthErr 
          ? 'انتهت صلاحية الاتصال بـ Google Drive أو لم يتم السماح بالوصول بالشكل الصحيح. الرجاء تجديد الصلاحية بضغطة واحدة للمحاولة مجدداً.' 
          : `حدث خطأ أثناء النشر والرفع: ${msg}`,
        showRefresh: isAuthErr
      });
      showToast(`حدث خطأ أثناء النشر: ${msg}`);
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

   {/* كلاس لوحة النشر كاملا*/}
  return (
    <div className="mx-auto mt-1 w-full max-w-xl">
      <div className={`overflow-hidden rounded-2xl border transition-colors relative ${
        isDarkMode 
          ? 'border-[#6980b0] bg-[#111822] shadow-[0_4px_12px_rgba(0,0,0,0.2)]' 
          : 'border-[#C1C3B8] bg-white shadow-[0_4px_12px_rgba(90,90,64,0.05)]'
      }`}>
        <form onSubmit={handleSubmit} className="p-2 sm:p-2 text-right">
          {uploadError && (
            <div className={`mb-4 rounded-lg p-4 border transition-all ${
              isDarkMode 
                ? 'bg-red-950/40 border-red-900/50 text-red-200' 
                : 'bg-red-50 border-red-200 text-red-800'
            }`} dir="rtl">
              <div className="flex items-start gap-3">
                <span className="text-lg">⚠️</span>
                <div className="flex-1">
                  <p className={`text-xs font-bold mb-2 ${isDarkMode ? 'text-red-300' : 'text-red-700'}`}>{uploadError.message}</p>
                  {uploadError.showRefresh && (
                    <button
                      type="button"
                      onClick={() => handleAuthorize()}
                      className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-[10px] font-bold text-white transition-all hover:bg-red-700 mt-2"
                    >
                      <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                      تجديد الصلاحية الآن
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <AnimatePresence>
            {previews.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3"
              >
                {previews.map((prev, index) => {
                  const models = ['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7', 'تغشية'];
                  const isFile = prev.startsWith('file:');
                  const parts = isFile ? prev.split(':') : [];
                  const fileName = isFile ? parts[1] : '';
                  const fileType = isFile ? parts[2] : '';
                  const fileSize = isFile ? parts[3] : '';
                  const fileUrl = isFile ? parts.slice(4).join(':') : prev;
                  const isImage = isFile ? (fileType.startsWith('image/') || /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(fileName)) : true;
                  const isApkFile = isFile && (fileName.toLowerCase().endsWith('.apk') || fileType.includes('vnd.android.package-archive'));
                  const isAudio = isFile && (fileType.startsWith('audio/') || /\.(mp3|wma|wav|aac|m4a|ogg|flac|amr)$/i.test(fileName));
                  const isVideo = isFile && (fileType.startsWith('video/') || /\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv)$/i.test(fileName));
                  
                  return (
                    <div
                      key={index}
                      className={`p-2.5 rounded-xl border transition-colors relative ${
                        isDarkMode 
                          ? 'border-[#2C374E] bg-[#111822]/40' 
                          : 'border-natural-border/60 bg-natural-bg/30'
                      }`}
                      dir="rtl"
                    >
                      {/* Side-by-side Container */}
                      <div className="flex gap-2 items-stretch" dir="rtl">
                        {/* Right side: Image/File and its note stacked vertically */}
                        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                          {/* Constrained Preview box */}
                          <div className={`relative w-full ${isAudio ? '' : 'aspect-video sm:aspect-[4/3] max-h-28 sm:max-h-32'} overflow-hidden rounded-lg border border-natural-border/30 bg-black/5 flex items-center justify-center shrink-0`}>
                            {isFile ? (
                              isImage ? (
                                <img 
                                  src={fileUrl} 
                                  alt={fileName || 'صورة'} 
                                  className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" 
                                  onClick={() => setPreviewModalUrl(fileUrl)}
                                  title="انقر لتكبير الصورة"
                                />
                              ) : isAudio ? (
                                <div className="w-full p-1.5" onClick={(e) => e.stopPropagation()}>
                                  <AudioPlayer src={fileUrl} name={fileName} size={fileSize} isDarkMode={isDarkMode} />
                                </div>
                              ) : isVideo ? (
                                <div className="w-full p-1.5" onClick={(e) => e.stopPropagation()}>
                                  <VideoPlayer src={fileUrl} name={fileName} size={fileSize} isDarkMode={isDarkMode} />
                                </div>
                              ) : (
                                <div className="flex flex-col items-center justify-center text-center p-2 min-w-0 w-full">
                                  <span className="text-2xl sm:text-3xl">{isApkFile ? '🤖' : '📄'}</span>
                                  <span className="text-[9px] font-black mt-1.5 leading-tight text-center break-all text-neutral-600 line-clamp-2 w-full px-1">
                                    {fileName}
                                  </span>
                                </div>
                              )
                            ) : (
                              <img 
                                src={prev} 
                                alt={`Preview ${index + 1}`} 
                                className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" 
                                onClick={() => setPreviewModalUrl(prev)}
                                title="انقر لتكبير الصورة"
                              />
                            )}
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => removeImage(index)}
                              className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur shadow-sm transition-transform hover:scale-110 active:scale-95 disabled:opacity-50 cursor-pointer z-10"
                            >
                              <X size={10} />
                            </button>
                          </div>
                          
                          {/* Note Input - directly below */}
                          <div className="flex flex-col gap-0.5 text-right">
                            <span className={`text-[8px] sm:text-[9px] font-black select-none ${isDarkMode ? 'text-gray-400' : 'text-[#4A4A35]'}`}>
                              ملاحظة حول {(!isFile || isImage) ? 'الصورة' : 'الملف'}:
                            </span>
                            <input
                              type="text"
                              placeholder={(!isFile || isImage) ? 'اكتب ملاحظة لهذه الصورة' : 'ملاحظة حول هذا الملف...'}
                              value={imageCaptions[index] || ''}
                              onChange={(e) => {
                                const updated = [...imageCaptions];
                                updated[index] = e.target.value;
                                setImageCaptions(updated);
                              }}
                              disabled={loading}
                              className={`w-full text-[9px] sm:text-[10px] font-medium border rounded-lg px-2 py-1 focus:outline-none focus:ring-1 ${
                                isDarkMode
                                  ? 'border-[#2C374E] bg-[#1a212e] text-white placeholder-gray-500 focus:ring-[#16af75]'
                                  : 'border-natural-border/60 bg-white text-natural-text placeholder-[#A1A18E] focus:ring-natural-primary'
                              }`}
                            />
                          </div>
                        </div>

                        {/* Left side: Attached Model Selector - Only for Images */}
                        {isImage && (
                          <div className="w-[105px] sm:w-[125px] shrink-0 flex flex-col justify-between border-r border-natural-border/20 pr-1.5" dir="rtl">
                            <span className={`text-[8px] sm:text-[9px] font-black select-none mb-0.5 text-center block ${isDarkMode ? 'text-gray-400' : 'text-[#4A4A35]'}`}>
                              إعدادات الصورة:
                            </span>
                            <div className="flex-1 flex flex-col gap-1 pb-1 justify-center">
                              {(() => {
                                const val = selectedModels[index] || '';
                                const isObscured = val.includes('تغشية');
                                const modelName = val.split('|').filter(p => p && p !== 'تغشية')[0] || '';
                                
                                return (
                                  <>
                                    {/* Obscure Button Toggle */}
                                    <button
                                      type="button"
                                      disabled={loading}
                                      onClick={() => {
                                        const nextObscured = !isObscured;
                                        const updated = [...selectedModels];
                                        updated[index] = nextObscured ? (modelName ? `${modelName}|تغشية` : 'تغشية') : modelName;
                                        setSelectedModels(updated);
                                      }}
                                      className={`w-full py-1 rounded text-[8px] sm:text-[9px] font-black cursor-pointer transition-all border text-center truncate whitespace-nowrap overflow-hidden ${
                                        isObscured
                                          ? 'bg-amber-600 text-white border-transparent shadow-xs'
                                          : isDarkMode
                                            ? 'bg-amber-955/40 text-amber-300 border-amber-900/50 hover:bg-amber-900/30'
                                            : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100/50'
                                      }`}
                                    >
                                      👁️ تغشية الصورة
                                    </button>
                                    
                                    <div className={`h-[1px] my-0.5 ${isDarkMode ? 'bg-gray-800' : 'bg-gray-200'}`} />
                                    
                                    <span className={`text-[7px] sm:text-[8px] font-bold text-center block ${isDarkMode ? 'text-gray-500' : 'text-[#8C8F7A]'}`}>
                                      اسم الموديل:
                                    </span>
                                    
                                    {['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7'].map((m) => {
                                      const isMSelected = modelName === m;
                                      return (
                                        <button
                                          key={m}
                                          type="button"
                                          disabled={loading}
                                          onClick={() => {
                                            const nextModel = isMSelected ? '' : m;
                                            const updated = [...selectedModels];
                                            updated[index] = isObscured ? (nextModel ? `${nextModel}|تغشية` : 'تغشية') : nextModel;
                                            setSelectedModels(updated);
                                          }}
                                          className={`w-full py-0.5 rounded text-[8px] sm:text-[9px] font-black cursor-pointer transition-all border text-center truncate whitespace-nowrap overflow-hidden ${
                                            isMSelected
                                              ? isDarkMode
                                                ? 'bg-[#16af75] text-white border-transparent shadow-xs'
                                                : 'bg-[#4A4A35] text-white border-transparent shadow-xs'
                                              : isDarkMode
                                                ? 'bg-[#1a212e] text-gray-300 border-[#656c74]/50 hover:bg-[#2C374E]'
                                                : 'bg-white text-natural-muted border-natural-border/60 hover:bg-natural-bg/80'
                                          }`}
                                          title={m}
                                        >
                                          {m}
                                        </button>
                                      );
                                    })}
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          {downloadingImageLoading && (
            <div className={`mt-2 p-3 rounded-xl border flex items-center gap-3 text-xs font-bold transition-all ${
              isDarkMode ? 'bg-[#182335] border-[#008D75] text-[#008D75]' : 'bg-[#e8f7f4] border-[#008D75] text-[#008D75]'
            }`} dir="rtl">
              <Loader2 size={16} className="animate-spin shrink-0" />
              <span>جاري تنزيل ملف الصورة الأصلي</span>
            </div>
          )}

          <div className="w-full mt-2 mb-2">
            <textarea
              value={text}
              onChange={(e) => processTextForImageUrls(e.target.value)}
              placeholder={` الصق النص للنشر في : ${getTargetBoardName()}`}
              className={`w-full resize-none rounded-xl border px-4 py-4 leading-normal focus:ring-1 focus:outline-none transition-all ${
                isDarkMode
                  ? 'font-normal border-[#6980b0] bg-[#111822] text-[#e4edf7] placeholder-[#B4C6D8]/50 focus:ring-[#008D75]'
                  : 'font-normal border-[#C1C3B8] bg-natural-bg text-natural-text placeholder-[#A1A18E] focus:ring-natural-primary'
              }`}
              rows={3}
              dir={isRtl(text) ? 'rtl' : 'ltr'}
              style={{ 
                textAlign: isRtl(text) ? 'right' : 'left', 
                lineHeight: '1.8',
                fontSize: `${postFontSize}px`,
                color: isDarkMode ? '#e4edf7' : '#2D2D2A'
              }}
              disabled={loading}
            />
          </div>

          <div className={`mt-0 pt-0 flex flex-col gap-2 transition-colors ${isDarkMode ? 'border-[#2C374E]' : 'border-natural-border/30'}`}>
            {isAdmin && (
              <>
                {/* Split Board Selection Button */}
                <div className="flex gap-1.5 w-full" dir="rtl">
                  {/* Left or Right Half: Main Board */}
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new Event('lock_posts_layout'));
                      setIsSelectBoardDrawerOpen(true);
                    }}
                    className={`flex-1 min-w-0 rounded-lg border px-2.5 h-10 text-xs sm:text-sm font-bold focus:outline-none cursor-pointer transition-all shadow-md flex items-center justify-between gap-1 ${
                      isDarkMode 
                        ? 'border-[#656c74] bg-[#111822] text-[#16af75] hover:bg-[#1a212e]' 
                        : 'border-[#cbd5e1] bg-[#fffaf5] text-[#c26700] hover:bg-[#fef3e6] hover:border-[#c26700]/40'
                    }`}
                  >
                    <span className="flex items-center gap-1 truncate">
                      <span>📁</span>
                      <span className="truncate">{getTargetBoardName()}</span>
                    </span>
                    <ChevronDown size={14} className="shrink-0" />
                  </button>

                  {/* Second Half: Sub-board selection if current board has sub-boards */}
                  {currentTargetBoard && currentTargetBoard.subBoards && currentTargetBoard.subBoards.length > 0 && (
                    <div className="relative flex-1 min-w-0">
                      <select
                        value={targetSubBoardId || ''}
                        onChange={(e) => setTargetSubBoardId(e.target.value || null)}
                        className={`w-full appearance-none rounded-lg border px-2.5 pr-1 h-10 text-xs sm:text-sm font-bold focus:outline-none cursor-pointer transition-all shadow-md truncate ${
                          isDarkMode 
                            ? 'border-[#656c74] bg-[#111822] text-[#16af75] hover:bg-[#1a212e]' 
                            : 'border-[#cbd5e1] bg-[#fffaf5] text-[#c26700] hover:bg-[#fef3e6] hover:border-[#c26700]/40'
                        }`}
                      >
                        <option value="">📂 لوحة فرعية: الكل</option>
                        {currentTargetBoard.subBoards.map((sub) => (
                          <option key={sub.id} value={sub.id}>
                            📂 {sub.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} className={`absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`} />
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex gap-2 w-full">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                className={`group flex-1 min-w-0 flex items-center justify-center gap-1 rounded-lg px-2 sm:px-3 h-10 py-0 text-[12px] sm:text-[12px] font-bold transition-all disabled:opacity-50 cursor-pointer ${
                  isDarkMode 
                    ? 'border border-[#656c74] text-[#16af75] bg-[#111822] hover:bg-[#1a212e]' 
                    : 'text-[#c26700] bg-[#fffaf5] shadow-md hover:bg-[#fef3e6] hover:border-[#c26700]/40 border border-[#cbd5e1]'
                }`}
              >
                <span className="md:hidden">إضافة ملفات أو صور {images.length > 0 ? `(${images.length})` : ''}</span>
                <span className="hidden md:inline">إضافـة ملفات أو صـور {images.length > 0 ? `(${images.length})` : ''}</span>
              </button>
              <input
                type="file"
                hidden
                multiple
                ref={fileInputRef}
                onChange={handleImageChange}
                disabled={loading}
              />

              <button
                type="submit"
                disabled={loading || (!text.trim() && images.length === 0)}
                className={`flex-1 min-w-0 px-2 sm:px-4 h-10 py-0 flex items-center justify-center rounded-lg text-xs sm:text-sm font-bold whitespace-nowrap transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer ${
                  isDarkMode 
                    ? 'border border-[#656c74] text-[#16af75] bg-[#111822] hover:bg-[#1a212e] shadow-md' 
                    : 'text-[#c26700] bg-[#fffaf5] shadow-md hover:bg-[#fef3e6] hover:border-[#c26700]/40 border border-[#cbd5e1]'
                }`}
              >
                {loading ? (
                  <div className="flex items-center gap-1.5">
                    <Loader2 size={16} className="animate-spin" />
                    <span>انتظر...</span>
                  </div>
                ) : (
                  'نشر الآن'
                )}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Elegant sliding status panel below the publication container */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ height: 0, opacity: 0, marginTop: 0 }}
            animate={{ height: 'auto', opacity: 1, marginTop: 12 }}
            exit={{ height: 0, opacity: 0, marginTop: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 180 }}
            className={`overflow-hidden rounded-xl border p-4 shadow-md flex items-center gap-4 transition-all ${
              isDarkMode 
                ? 'border-[#6980b0]/60 bg-[#111822]/90 backdrop-blur-xs text-white shadow-[0_4px_12px_rgba(0,0,0,0.15)]' 
                : 'border-[#C1C3B8] bg-[#fffaf5] text-[#c26700] shadow-[0_4px_12px_rgba(90,90,64,0.05)]'
            }`}
            dir="rtl"
          >
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${isDarkMode ? 'bg-[#16af75]/10' : 'bg-[#c26700]/10'}`}>
              <Loader2 size={24} className={`animate-spin ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`} />
            </div>
            <div className="flex-1 text-right min-w-0">
              <p className={`text-xs sm:text-sm font-extrabold truncate ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`}>
                {status || 'جاري معالجة المنشور ونشره...'}
              </p>
              
              {/* Real-time upload progress bar */}
              {images.some(img => typeof img !== 'string') && (
                <div className="mt-2 w-full">
                  <div className="flex justify-between items-center mb-1 text-[10px]">
                    <span className={`font-black ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`}>
                      {uploadProgress}%
                    </span>
                    <span className={isDarkMode ? 'text-gray-400' : 'text-neutral-500'}>
                      تقدم الرفع
                    </span>
                  </div>
                  <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDarkMode ? 'bg-[#1a212e]' : 'bg-gray-200'}`}>
                    <motion.div
                      className={`h-full rounded-full ${isDarkMode ? 'bg-[#16af75]' : 'bg-[#c26700]'}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${uploadProgress}%` }}
                      transition={{ duration: 0.1 }}
                    />
                  </div>
                </div>
              )}

              <p className={`text-[10px] sm:text-[11px] font-medium truncate mt-1.5 ${isDarkMode ? 'text-gray-400' : 'text-[#4A4A35]/80'}`}>
                برجاء عدم إغلاق الصفحة حتى تكتمل العملية بنجاح.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Elegant sliding drawer to select publishing board (Tablet and Mobile) */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {isSelectBoardDrawerOpen && (
            <>
            {/* Background Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setIsSelectBoardDrawerOpen(false);
                window.dispatchEvent(new Event('unlock_posts_layout'));
              }}
              className="fixed inset-0 z-[2000] bg-black/40 backdrop-blur-sm"
            />
            
            {/* Sliding Drawer Container */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className={`fixed inset-y-0 right-0 z-[2001] w-72 sm:w-96 shadow-2xl border-l transition-colors flex flex-col ${
                isDarkMode 
                  ? 'bg-[#151D2A] text-white border-[#2C374E]' 
                  : 'bg-white text-natural-text border-natural-border'
              }`}
              dir="rtl"
            >
              {/* Header */}
              <div className={`relative flex items-center justify-center py-2.5 px-3 border-b transition-colors ${
                isDarkMode 
                  ? 'border-[#2C374E] bg-[#111822]' 
                  : 'border-natural-border/40 bg-neutral-50/50'
              }`}>
                <h2 className={`text-sm font-black text-center ${isDarkMode ? 'text-white' : 'text-[#3A3A28]'}`}>
                  اختر لوحة للنشر
                </h2>
                <button 
                  type="button"
                  onClick={() => {
                    setIsSelectBoardDrawerOpen(false);
                    window.dispatchEvent(new Event('unlock_posts_layout'));
                  }}
                  className={`absolute right-2.5 p-1.5 rounded-lg transition-colors cursor-pointer ${
                    isDarkMode ? 'text-[#B4C6D8] hover:bg-[#1A212E]' : 'text-natural-muted hover:bg-neutral-100'
                  }`}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div className="space-y-2">
                  {/* User Board option */}
                  <button
                    type="button"
                    onClick={() => {
                      setTargetBoardId('user-board');
                      setIsSelectBoardDrawerOpen(false);
                      window.dispatchEvent(new Event('unlock_posts_layout'));
                    }}
                    className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                      targetBoardId === 'user-board'
                        ? (isDarkMode 
                            ? 'bg-[#008D75] border-[#008D75] text-white shadow-md font-bold' 
                            : 'bg-natural-primary border-natural-primary text-white shadow-md font-bold')
                        : (isDarkMode
                            ? 'bg-[#111822] border-[#2C374E] hover:bg-[#1A212E] text-white font-normal'
                            : 'bg-white border-natural-border hover:bg-natural-secondary-bg text-natural-text font-normal')
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-lg">👤</span>
                      <span> لوحة شخصية</span>
                    </span>
                    {targetBoardId === 'user-board' && (
                      <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                    )}
                  </button>

                  {/* Main Feed option */}
                  <button
                    type="button"
                    onClick={() => {
                      setTargetBoardId('main-feed');
                      setIsSelectBoardDrawerOpen(false);
                      window.dispatchEvent(new Event('unlock_posts_layout'));
                    }}
                    className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                      targetBoardId === 'main-feed'
                        ? (isDarkMode 
                            ? 'bg-[#008D75] border-[#008D75] text-[#e4edf7] shadow-md font-bold' 
                            : 'bg-natural-primary border-natural-primary text-white shadow-md font-bold')
                        : (isDarkMode
                            ? 'bg-[#111822] border-[#2C374E] hover:bg-[#1A212E] text-white font-normal'
                            : 'bg-white border-natural-border hover:bg-natural-secondary-bg text-natural-text font-normal')
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-lg">🏡</span>
                      <span> الرئيسية</span>
                    </span>
                    {targetBoardId === 'main-feed' && (
                      <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                    )}
                  </button>

                  {/* Dynamic Boards */}
                  {boards && (isAdmin ? boards : boards.filter(b => !b.hidden)).map((board) => {
                    const isSelected = targetBoardId === board.id;
                    return (
                      <button
                        key={board.id}
                        type="button"
                        onClick={() => {
                          if (board.id === 'safe-board') {
                            const savedPass = sessionStorage.getItem('safe_vault_password');
                            if (savedPass === '88775500') {
                              setTargetBoardId(board.id);
                              setIsSelectBoardDrawerOpen(false);
                              window.dispatchEvent(new Event('unlock_posts_layout'));
                            } else {
                              setOnSuccessCallback(() => () => {
                                setTargetBoardId(board.id);
                                setIsSelectBoardDrawerOpen(false);
                                window.dispatchEvent(new Event('unlock_posts_layout'));
                              });
                              setShowSafePasswordModal(true);
                            }
                          } else {
                            setTargetBoardId(board.id);
                            setIsSelectBoardDrawerOpen(false);
                            window.dispatchEvent(new Event('unlock_posts_layout'));
                          }
                        }}
                        className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                          isSelected
                            ? (isDarkMode 
                                ? 'bg-[#008D75] border-[#008D75] text-[#e4edf7] shadow-md font-bold' 
                                : 'bg-natural-primary border-natural-primary text-white shadow-md font-bold')
                            : (isDarkMode 
                                ? 'bg-[#111822] border-[#2C374E] hover:bg-[#1A212E] text-white font-normal'
                                : 'bg-white border-natural-border hover:bg-natural-secondary-bg text-natural-text font-normal')
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-lg">{board.locked ? '🔒' : '📁'}</span>
                          <span>{board.name}</span>
                          {board.hidden && (
                            <span className="text-[10px] bg-red-600/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded-md font-black flex items-center gap-1">
                             مخفية
                            </span>
                          )}
                        </span>
                        {isSelected && (
                          <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>,
      document.body
    )}

      {/* Password Modal for "الخزنة" */}
      <AnimatePresence>
        {showSafePasswordModal && (
          <>
            {/* Backdrop Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[3000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => {
                setShowSafePasswordModal(false);
                setSafePasswordInput('');
                setSafePasswordError(false);
              }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className={`relative w-full max-w-sm rounded-3xl p-6 shadow-2xl border text-right transition-colors ${
                  isDarkMode 
                    ? 'border-[#2C374E] bg-[#111822] text-white' 
                    : 'border-natural-border bg-white text-natural-text'
                }`}
                onClick={(e) => e.stopPropagation()}
                dir="rtl"
              >
                <div className="flex flex-col items-center text-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500 text-2xl animate-bounce">
                    🔒
                  </div>
                  <h3 className={`text-base font-black ${isDarkMode ? 'text-white' : 'text-[#3A3A28]'}`}>
                    قسم الخزنة مغلق
                  </h3>
                  <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-natural-muted'}`}>
                    هذه اللوحة محمية برقم سري، يرجى إدخال رقم المرور للمتابعة.
                  </p>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (safePasswordInput === '88775500') {
                      sessionStorage.setItem('safe_vault_password', safePasswordInput);
                      setShowSafePasswordModal(false);
                      setSafePasswordInput('');
                      setSafePasswordError(false);
                      if (onSuccessCallback) onSuccessCallback();
                    } else {
                      setSafePasswordError(true);
                    }
                  }}
                  className="mt-4 space-y-3"
                >
                  <input
                    type="password"
                    autoFocus
                    placeholder="أدخل كلمة السر..."
                    value={safePasswordInput}
                    onChange={(e) => {
                      setSafePasswordInput(e.target.value);
                      setSafePasswordError(false);
                    }}
                    className={`w-full text-center text-sm font-bold border rounded-xl px-4 py-2.5 focus:outline-none focus:ring-1 transition-all ${
                      safePasswordError
                        ? 'border-red-500 focus:ring-red-500 bg-red-500/5'
                        : isDarkMode
                          ? 'border-[#2C374E] bg-[#1a212e] text-white focus:ring-[#008D75]'
                          : 'border-natural-border bg-white text-natural-text focus:ring-natural-primary'
                    }`}
                  />
                  
                  {safePasswordError && (
                    <p className="text-red-500 text-[11px] font-bold text-center animate-pulse">
                      ❌ كلمة السر غير صحيحة، يرجى المحاولة مرة أخرى!
                    </p>
                  )}

                  <div className="flex gap-2 pt-2">
                    <button
                      type="submit"
                      className="flex-1 py-2 rounded-xl text-xs font-bold text-white bg-[#008D75] hover:bg-opacity-90 transition-colors cursor-pointer"
                    >
                      تأكيد
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSafePasswordModal(false);
                        setSafePasswordInput('');
                        setSafePasswordError(false);
                      }}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        isDarkMode
                          ? 'border-[#2C374E] bg-[#1a212e] text-gray-300 hover:bg-[#253042]'
                          : 'border-natural-border bg-white text-natural-muted hover:bg-neutral-50'
                      }`}
                    >
                      إلغاء
                    </button>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Smart Deduplication Interactive Modal */}
      <AnimatePresence>
        {duplicateModalOpen && duplicateFoundPost && (
          <>
            {/* Backdrop Overlay */}
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
                    ? 'border-[#2C374E] bg-[#111822] text-white' 
                    : 'border-natural-border bg-white text-natural-text'
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
                   
                  </p>
                </div>

                {/* Snippet preview of duplicate post */}
                <div className={`mt-3.5 p-3 rounded-2xl border text-xs max-h-24 overflow-y-auto leading-relaxed ${
                  isDarkMode ? 'bg-[#1A212E] border-[#2C374E] text-gray-300' : 'bg-neutral-50 border-neutral-200 text-neutral-700'
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
                      const targetBoard = duplicateFoundPost.boardId === 'user-board' 
                        ? 'user-board' 
                        : (duplicateFoundPost.boardId || null);
                      const targetSubBoard = duplicateFoundPost.subBoardId || null;
                      
                      const targetPostId = String(duplicateFoundPost.id);
                      (window as any).__pendingHighlightPostId = targetPostId;

                      if (onUploadSuccess) {
                        onUploadSuccess(targetBoard, targetSubBoard);
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
                    onClick={(e) => {
                      isBypassingDeduplicationRef.current = true;
                      setDuplicateModalOpen(false);
                      handleSubmit(e as any);
                    }}
                    className={`w-full py-2.5 px-4 rounded-xl text-xs font-black border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      isDarkMode
                        ? 'border-amber-500/40 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                        : 'border-amber-500/40 text-amber-700 bg-amber-50 hover:bg-amber-100'
                    }`}
                  >
                    <span>⚡</span>
                    <span>النشر على أي حال</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDuplicateModalOpen(false)}
                    className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      isDarkMode
                        ? 'border-[#2C374E] bg-[#1a212e] text-gray-400 hover:bg-[#253042]'
                        : 'border-natural-border bg-white text-natural-muted hover:bg-neutral-50'
                    }`}
                  >
                    <span>❌</span>
                    <span>إلغاء النشر</span>
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Full Size Image Preview Modal */}
      {previewModalUrl && createPortal(
        <div 
          className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 transition-all"
          onClick={() => setPreviewModalUrl(null)}
          dir="rtl"
        >
          <button
            type="button"
            onClick={() => setPreviewModalUrl(null)}
            className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/20 hover:bg-white/40 text-white transition-all shadow-xl cursor-pointer backdrop-blur-xs"
            title="إغلاق المعاينة"
          >
            <X size={24} />
          </button>

          <div 
            className="relative max-w-[95vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewModalUrl}
              alt="صورة بالحجم الكامل"
              className="max-w-[95vw] max-h-[85vh] object-contain rounded-2xl shadow-2xl border border-white/10"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
