import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Post, OperationType, Board } from '../types';
import { db, auth } from '../lib/firebase';
import { doc, deleteDoc, updateDoc, serverTimestamp, collection, getDocs, getDoc, query, orderBy, limit, where } from 'firebase/firestore';
import { MoreHorizontal, Trash2, Edit3, Check, X, Clock, Copy, Loader2, Image as ImageIcon, Plus, Sparkles, Pin, ArrowUp, ArrowDown, Move, EyeOff, ChevronDown, Download, Languages, FolderOutput, MoveRight, Search, GripHorizontal, ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';
import { motion, AnimatePresence } from 'motion/react';
import { handleFirestoreError } from '../lib/error-handler';
import { uploadPostImage, deletePostImage } from '../lib/upload-helper';
import { movePostToRecycleBin } from '../lib/recycle-bin';
import { getAccessToken, googleSignIn } from '../lib/auth';
import { compressImage, smartCompressImage, downloadAndSmartCompressImageFromUrl, extractImageUrlsFromText } from '../lib/imageCompressor';
import { getLocalUserPostsIndexedDB, saveLocalUserPostsIndexedDB } from '../lib/indexedDbService';
import { showToast } from './Toast';
import { encryptText, decryptText, encryptArray, decryptArray } from '../lib/encryption';
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import AudioPlayer from './AudioPlayer';
import VideoPlayer from './VideoPlayer';
import { isMediaAudioUrl, isMediaVideoUrl, getMediaNameFromUrl, hasMediaInText } from '../lib/r2';

function isImageUrl(url: string): boolean {
  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    return /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(cleanUrl);
  } catch {
    return false;
  }
}

function LinkImage({ src, originalText, href }: { src: string; originalText: string; href: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline break-all font-semibold inline cursor-pointer"
        onClick={(e) => e.stopPropagation()}
      >
        {originalText}
      </a>
    );
  }

  return (
    <span className="block my-2" onClick={(e) => e.stopPropagation()}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block relative overflow-hidden rounded-xl border border-natural-border/60 bg-neutral-100 hover:opacity-95 transition-opacity"
      >
        <img
          src={src}
          alt="Shared content"
          referrerPolicy="no-referrer"
          className="max-h-72 max-w-full rounded-xl object-contain shadow-sm"
          onError={() => setFailed(true)}
        />
      </a>
    </span>
  );
}

function renderTextWithLinks(text: string, isDarkMode = false) {
  if (!text) return '';
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (part.match(urlRegex)) {
      const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part;

      // 1. Audio Media URL (.mp3, .wav, .m4a, .aac, .ogg, etc.)
      if (isMediaAudioUrl(href)) {
        return (
          <span key={i} className="block my-2.5 w-full not-italic select-auto" onClick={(e) => e.stopPropagation()}>
            <AudioPlayer src={href} name={getMediaNameFromUrl(href, 'ملف صوتي')} isDarkMode={isDarkMode} />
          </span>
        );
      }

      // 2. Video Media URL (.mp4, .mkv, .webm, .m4v, or Cloudflare R2 links)
      if (isMediaVideoUrl(href)) {
        return (
          <span key={i} className="block my-2.5 w-full not-italic select-auto" onClick={(e) => e.stopPropagation()}>
            <VideoPlayer src={href} name={getMediaNameFromUrl(href, 'ملف فيديو')} isDarkMode={isDarkMode} />
          </span>
        );
      }

      // 3. Image URL
      if (isImageUrl(href)) {
        return (
          <React.Fragment key={i}>
            <LinkImage src={href} originalText={part} href={href} />
          </React.Fragment>
        );
      }

      // 4. Standard Link
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline break-all font-semibold inline cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

function LightboxBottomOverlay({ modelName, caption, slideSrc }: { modelName?: string; caption?: string; slideSrc: string }) {
  const [imgRect, setImgRect] = useState<{ bottom: number; left: number; width: number; height: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    let rafId: number;
    const updatePosition = () => {
      // 1. Try selecting the image within the current/active slide
      let activeImg = document.querySelector('.yarl__slide_current img') as HTMLImageElement | null;
      
      // 2. Fallback: if not found, try any image within the Lightbox container
      if (!activeImg) {
        activeImg = document.querySelector('.yarl__container img') as HTMLImageElement | null;
      }
      
      // 3. Last fallback: try any element with class .yarl__slide_image
      if (!activeImg) {
        activeImg = document.querySelector('.yarl__slide_image') as HTMLImageElement | null;
      }

      if (activeImg) {
        const rect = activeImg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          let containerHeight = 0;
          if (containerRef.current) {
            containerHeight = containerRef.current.getBoundingClientRect().height;
          }
          setImgRect({
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: containerHeight
          });
        }
      } else {
        setImgRect(null);
      }
      rafId = requestAnimationFrame(updatePosition);
    };

    updatePosition();
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [slideSrc]);

  if (!imgRect) return null;

  const cleanModelName = (modelName || '').split('|').filter(part => part && part !== 'تغشية')[0] || '';
  const hasModel = !!(cleanModelName && cleanModelName.trim());
  const hasCaption = !!(caption && caption.trim());

  if (!hasModel && !hasCaption) return null;

  const leftPos = imgRect.left < 0 ? 12 : Math.min(imgRect.left, window.innerWidth - 100);
  const widthPos = imgRect.left < 0 ? (window.innerWidth - 24) : Math.min(window.innerWidth - leftPos - 12, imgRect.width);
  
  // Decide if we should dock to bottom of viewport or stick to image bottom
  // We want to dock to bottom if image bottom + 4px + container height exceeds the viewport height (minus some bottom padding, e.g., 8px)
  const isCappedAtBottom = (imgRect.bottom + 4 + imgRect.height) >= (window.innerHeight - 8);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: `${leftPos}px`,
    width: `${widthPos}px`,
    zIndex: 9999,
    pointerEvents: 'none',
  };

  if (isCappedAtBottom) {
    style.bottom = '8px';
  } else {
    style.top = `${imgRect.bottom + 4}px`;
  }

  return (
    <div
      ref={containerRef}
      style={style}
      className="flex px-1 items-start gap-1 animate-fade-in"
      dir="rtl"
    >
      {/* Right side: Model Name (30% of width) */}
      <div className="w-[30%] flex justify-start pointer-events-auto shrink-0">
        {hasModel ? (
          <div className="bg-black/90 border border-orange-500 rounded-lg px-1 py-1 text-[7px] backdrop-blur-md shadow-2xl text-amber-200 flex items-center gap-1 w-full justify-center">
            <span className="text-white/70 font-black shrink-0 text-[7px]">⚙️ الموديل:</span>
            <span className="font-sans font-black truncate text-[7px]">{cleanModelName}</span>
          </div>
        ) : <div />}
      </div>

      {/* Left side: Notes/Caption (70% of width) */}
      <div className="w-[70%] flex justify-end pointer-events-auto shrink-0">
        {hasCaption ? (
          <div className="bg-black/90 border border-orange-500 rounded-lg px-1 py-1 text-[7px] backdrop-blur-md shadow-2xl text-white text-right w-full">
            <div className="max-h-24 overflow-y-auto no-scrollbar font-black leading-relaxed break-words text-[7px]">
              {caption}
            </div>
          </div>
        ) : <div />}
      </div>
    </div>
  );
}

interface PostCardProps {
  id?: string;
  post: Post;
  isAdmin: boolean;
  boards: Board[];
  onTestPrompt: (text: string) => void;
  isDarkMode?: boolean;
  onMovePost?: (postId: string, direction: 'up' | 'down') => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

import { ADMIN_CONFIG } from '../config';

const DEFAULT_SITES = [
  { label: "بدون تسجيل دخول (انقر بالزر الأيمن  للتصفح الخفي )", url: "https://duck.ai" },
  { label: "وان (10 نقاط يومية)", url: "https://create.wan.video/generate/image/draft?model=wan2.7" },
  { label: "أرينا", url: "https://arena.ai/image/side-by-side" },
  { label: "كل ايميل له عدد نقاط", url: "https://promptsref.com/tool/AI-Image-Generator" },
  { label: "كل ايميل له عدد نقاط", url: "https://chataibot.pro" },
  { label: " جيميناي", url: "https://gemini.google.com/app?hl=ar" },
  { label: " notegpt.io ", url: "https://notegpt.io " },
  { label: " موقع أدوبي ( انقر بالزر الأيمن للتصفح الخفي) ", url: "https://firefly.adobe.com/generate/image?view=edit" },
  { label: "  موقع دولا الصيني المجاني ", url: "https://www.dola.com" },
  { label: "اسم الموقع هنا ", url: "https://عنوان الموفع" },
  { label: "اسم الموقع هنا ", url: "https://عنوان الموفع" }

];

export default function PostCard({ 
  id,
  post: originalPost, 
  isAdmin, 
  boards, 
  onTestPrompt, 
  isDarkMode,
  onMovePost,
  canMoveUp = false,
  canMoveDown = false
}: PostCardProps) {
  const post = React.useMemo(() => {
    const vaultKey = sessionStorage.getItem('safe_vault_password') || '';
    if (originalPost.boardId === 'safe-board' && vaultKey) {
      return {
        ...originalPost,
        text: decryptText(originalPost.text, vaultKey),
        imageCaptions: decryptArray(originalPost.imageCaptions, vaultKey),
        fileNames: decryptArray(originalPost.fileNames, vaultKey),
        fileSizes: decryptArray(originalPost.fileSizes || [], vaultKey),
      };
    }
    return originalPost;
  }, [originalPost]);

  const postBoard = boards.find(b => b.id === post.boardId);
  if (!isAdmin && postBoard?.hidden) {
    return null;
  }

  // If this post belongs to the safe board and vault is not unlocked, never render it
  if (post.boardId === 'safe-board' && !sessionStorage.getItem('safe_vault_password')) {
    return null;
  }

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

  const [currentUser, setCurrentUser] = useState<any>(auth.currentUser);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  const isPostFromAdmin = post.authorEmail === ADMIN_CONFIG.email;
  const isLocalPost = post.boardId === 'user-board';

  const displayEmailOrName = isLocalPost 
    ? (currentUser?.email || post.authorEmail || 'local-user@local.com')
    : (isPostFromAdmin ? ADMIN_CONFIG.displayName : post.authorEmail.split('@')[0]);

  const personName = isLocalPost 
    ? (currentUser?.displayName || (currentUser?.email || post.authorEmail || 'local-user@local.com').split('@')[0])
    : (isPostFromAdmin ? ADMIN_CONFIG.displayName : post.authorEmail.split('@')[0]);

  const avatarChar = isLocalPost 
    ? (currentUser?.email || post.authorEmail || 'U').charAt(0).toUpperCase()
    : (post.authorEmail || 'U').charAt(0).toUpperCase();

  const displayName = displayEmailOrName;

  const postSubBoard = postBoard?.subBoards?.find(s => s.id === post.subBoardId);

  const boardName = post.boardId 
    ? (postSubBoard ? `${postBoard?.name} › ${postSubBoard.name}` : (postBoard?.name || 'غير معروف'))
    : 'الرئيسية';
  
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('post_font_size');
    return saved ? parseInt(saved, 10) : 14;
  });

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

  const [isTransferDrawerOpen, setIsTransferDrawerOpen] = useState(false);
  const [isLayoutLocked, setIsLayoutLocked] = useState(false);

  // Safe board password states
  const [showSafePasswordModal, setShowSafePasswordModal] = useState(false);
  const [safePasswordInput, setSafePasswordInput] = useState('');
  const [safePasswordError, setSafePasswordError] = useState(false);
  const [onSuccessCallback, setOnSuccessCallback] = useState<(() => void) | null>(null);

  useEffect(() => {
    const handleLock = () => setIsLayoutLocked(true);
    const handleUnlock = () => setIsLayoutLocked(false);
    window.addEventListener('lock_posts_layout', handleLock);
    window.addEventListener('unlock_posts_layout', handleUnlock);
    return () => {
      window.removeEventListener('lock_posts_layout', handleLock);
      window.removeEventListener('unlock_posts_layout', handleUnlock);
    };
  }, []);

  useEffect(() => {
    if (isTransferDrawerOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      // Push a history state to capture back gestures/hardware back clicks
      window.history.pushState({ drawer: 'transfer_post_board' }, '');

      const handlePopState = () => {
        setIsTransferDrawerOpen(false);
        window.dispatchEvent(new Event('unlock_posts_layout'));
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        document.body.style.overflow = originalOverflow;
        window.removeEventListener('popstate', handlePopState);
        if (window.history.state?.drawer === 'transfer_post_board') {
          window.history.back();
        }
      };
    }
  }, [isTransferDrawerOpen]);

  const getEditedBoardName = () => {
    if (editedBoardId === null) return 'الرئيسية';
    if (editedBoardId === 'user-board') return 'لوحة شخصية';
    return boards?.find(b => b.id === editedBoardId)?.name || 'الرئيسية';
  };

  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(post.text);
  const [editTextareaHeight, setEditTextareaHeight] = useState<number | null>(null);
  const isResizingTextareaRef = useRef<boolean>(false);
  const resizeStartYRef = useRef<number>(0);
  const resizeStartHeightRef = useRef<number>(0);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [editedImageUrls, setEditedImageUrls] = useState<string[]>(post.imageUrls || (post.imageUrl ? [post.imageUrl] : []));
  const [editedBoardId, setEditedBoardId] = useState<string | null>(post.boardId || null);
  const [editedSubBoardId, setEditedSubBoardId] = useState<string | null>(post.subBoardId || null);
  const [newImages, setNewImages] = useState<(File | string)[]>([]);
  const [newPreviews, setNewPreviews] = useState<string[]>([]);
  const [removedImageUrls, setRemovedImageUrls] = useState<string[]>([]);
  const [editedImageModels, setEditedImageModels] = useState<string[]>(post.imageModels || []);
  const [newImageModels, setNewImageModels] = useState<string[]>([]);
  const [editedImageCaptions, setEditedImageCaptions] = useState<string[]>(post.imageCaptions || []);
  const [newImageCaptions, setNewImageCaptions] = useState<string[]>([]);
  const [editedFileNames, setEditedFileNames] = useState<string[]>(post.fileNames || []);
  const [editedFileTypes, setEditedFileTypes] = useState<string[]>(post.fileTypes || []);
  const [editedFileSizes, setEditedFileSizes] = useState<string[]>(post.fileSizes || []);
  const [newFileNames, setNewFileNames] = useState<string[]>([]);
  const [newFileTypes, setNewFileTypes] = useState<string[]>([]);
  const [newFileSizes, setNewFileSizes] = useState<string[]>([]);

  // States for drag & drop and swap reordering of thumbnails in edit mode
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null);
  const [dragOverImageIndex, setDragOverImageIndex] = useState<number | null>(null);
  const [swapSourceIndex, setSwapSourceIndex] = useState<number | null>(null);

  // States for newly added images drag reordering
  const [draggedNewIndex, setDraggedNewIndex] = useState<number | null>(null);
  const [dragOverNewIndex, setDragOverNewIndex] = useState<number | null>(null);
  const [swapNewSourceIndex, setSwapNewSourceIndex] = useState<number | null>(null);

  // Reordering helpers for existing attachments in edit mode
  const moveExistingImage = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= editedImageUrls.length || toIdx >= editedImageUrls.length) return;

    const reorderArr = <T,>(arr: T[], defaultVal: T): T[] => {
      const copy = [...arr];
      while (copy.length < editedImageUrls.length) copy.push(defaultVal);
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    };

    setEditedImageUrls(prev => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    });
    setEditedImageModels(prev => reorderArr(prev, ''));
    setEditedImageCaptions(prev => reorderArr(prev, ''));
    setEditedFileNames(prev => reorderArr(prev, ''));
    setEditedFileTypes(prev => reorderArr(prev, ''));
    setEditedFileSizes(prev => reorderArr(prev, ''));

    // Update selected indices to track their new positions
    setSelectedImageIndices(prev => {
      return prev.map(idx => {
        if (idx === fromIdx) return toIdx;
        if (fromIdx < toIdx && idx > fromIdx && idx <= toIdx) return idx - 1;
        if (fromIdx > toIdx && idx >= toIdx && idx < fromIdx) return idx + 1;
        return idx;
      });
    });

    setSwapSourceIndex(null);
  };

  const swapExistingImages = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= editedImageUrls.length || toIdx >= editedImageUrls.length) return;

    const swapArr = <T,>(arr: T[], defaultVal: T): T[] => {
      const copy = [...arr];
      while (copy.length < editedImageUrls.length) copy.push(defaultVal);
      const temp = copy[fromIdx];
      copy[fromIdx] = copy[toIdx];
      copy[toIdx] = temp;
      return copy;
    };

    setEditedImageUrls(prev => swapArr(prev, ''));
    setEditedImageModels(prev => swapArr(prev, ''));
    setEditedImageCaptions(prev => swapArr(prev, ''));
    setEditedFileNames(prev => swapArr(prev, ''));
    setEditedFileTypes(prev => swapArr(prev, ''));
    setEditedFileSizes(prev => swapArr(prev, ''));

    setSelectedImageIndices(prev => {
      return prev.map(idx => {
        if (idx === fromIdx) return toIdx;
        if (idx === toIdx) return fromIdx;
        return idx;
      });
    });

    setSwapSourceIndex(null);
  };

  const moveExistingStep = (idx: number, dir: -1 | 1) => {
    const targetIdx = idx + dir;
    if (targetIdx >= 0 && targetIdx < editedImageUrls.length) {
      moveExistingImage(idx, targetIdx);
    }
  };

  // Reordering helpers for newly added previews in edit mode
  const moveNewImage = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= newPreviews.length || toIdx >= newPreviews.length) return;

    const reorderArr = <T,>(arr: T[], defaultVal: T): T[] => {
      const copy = [...arr];
      while (copy.length < newPreviews.length) copy.push(defaultVal);
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    };

    setNewPreviews(prev => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    });
    setNewImages(prev => reorderArr(prev, ''));
    setNewImageModels(prev => reorderArr(prev, ''));
    setNewImageCaptions(prev => reorderArr(prev, ''));
    setNewFileNames(prev => reorderArr(prev, ''));
    setNewFileTypes(prev => reorderArr(prev, ''));
    setNewFileSizes(prev => reorderArr(prev, ''));
    setSwapNewSourceIndex(null);
  };

  const moveNewStep = (idx: number, dir: -1 | 1) => {
    const targetIdx = idx + dir;
    if (targetIdx >= 0 && targetIdx < newPreviews.length) {
      moveNewImage(idx, targetIdx);
    }
  };

  const handleStartEditing = () => {
    setEditedText(post.text);
    setEditTextareaHeight(null);
    setEditedImageUrls(post.imageUrls || (post.imageUrl ? [post.imageUrl] : []));
    setEditedImageModels(post.imageModels || []);
    setEditedImageCaptions(post.imageCaptions || []);
    setEditedFileNames(post.fileNames || []);
    setEditedFileTypes(post.fileTypes || []);
    setEditedFileSizes(post.fileSizes || []);
    setEditedBoardId(post.boardId || null);
    setEditedSubBoardId(post.subBoardId || null);
    setNewImages([]);
    setNewPreviews([]);
    setRemovedImageUrls([]);
    setSwapSourceIndex(null);
    setDraggedImageIndex(null);
    setDragOverImageIndex(null);
    setSwapNewSourceIndex(null);
    setDraggedNewIndex(null);
    setDragOverNewIndex(null);
    setIsEditing(true);
  };

  // Resize handler for edit textarea (both touch and mouse drag)
  const handleResizeStart = (clientY: number) => {
    isResizingTextareaRef.current = true;
    resizeStartYRef.current = clientY;
    const currentHeight = editTextareaRef.current ? editTextareaRef.current.offsetHeight : (editTextareaHeight || 120);
    resizeStartHeightRef.current = currentHeight;

    const handleMove = (moveClientY: number) => {
      if (!isResizingTextareaRef.current) return;
      const deltaY = moveClientY - resizeStartYRef.current;
      const newHeight = Math.max(90, Math.min(800, resizeStartHeightRef.current + deltaY));
      setEditTextareaHeight(newHeight);
    };

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      handleMove(e.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches && e.touches.length > 0) {
        handleMove(e.touches[0].clientY);
      }
    };

    const onEnd = () => {
      isResizingTextareaRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  };

  // Helper to smoothly return scroll position to the top of this card after saving or canceling edit
  const returnScrollToCard = () => {
    const performScroll = () => {
      if (cardRef.current) {
        const rect = cardRef.current.getBoundingClientRect();
        const currentScrollY = window.pageYOffset || document.documentElement.scrollTop;
        const targetScrollY = Math.max(0, currentScrollY + rect.top - 80);
        window.scrollTo({
          top: targetScrollY,
          behavior: 'smooth'
        });
      }
    };
    requestAnimationFrame(performScroll);
    setTimeout(performScroll, 60);
    setTimeout(performScroll, 180);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditTextareaHeight(null);
    setNewImages([]);
    setNewPreviews([]);
    setRemovedImageUrls([]);
    setSwapSourceIndex(null);
    setSelectedImageIndices([]);
    returnScrollToCard();
  };

  // States for selecting & moving images to another post
  const [selectedImageIndices, setSelectedImageIndices] = useState<number[]>([]);
  const [isMoveImagesModalOpen, setIsMoveImagesModalOpen] = useState(false);
  const [targetPostsList, setTargetPostsList] = useState<Post[]>([]);
  const [isLoadingTargetPosts, setIsLoadingTargetPosts] = useState(false);
  const [targetPostSearchQuery, setTargetPostSearchQuery] = useState('');
  const [selectedTargetPost, setSelectedTargetPost] = useState<Post | null>(null);
  const [isExecutingMoveImages, setIsExecutingMoveImages] = useState(false);

  // State for viewing full-size image during post editing
  const [editPreviewImageUrl, setEditPreviewImageUrl] = useState<string | null>(null);

  // Lock background scroll position when move images modal is open
  useEffect(() => {
    if (isMoveImagesModalOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      window.history.pushState({ modal: 'move_images_modal' }, '');

      const handlePopState = () => {
        setIsMoveImagesModalOpen(false);
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        document.body.style.overflow = originalOverflow;
        window.removeEventListener('popstate', handlePopState);
        if (window.history.state?.modal === 'move_images_modal') {
          window.history.back();
        }
      };
    }
  }, [isMoveImagesModalOpen]);

  // Lock background scroll position when image preview modal is open
  useEffect(() => {
    if (editPreviewImageUrl) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [editPreviewImageUrl]);

  const toggleSelectImage = (idx: number) => {
    setSelectedImageIndices(prev => 
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    );
  };

  const openMoveImagesModal = async () => {
    if (selectedImageIndices.length === 0) return;
    setIsMoveImagesModalOpen(true);
    setIsLoadingTargetPosts(true);
    setSelectedTargetPost(null);
    setTargetPostSearchQuery('');

    try {
      let postsList: Post[] = [];
      const isLocal = post.id.startsWith('local-') || post.boardId === 'user-board';

      if (isLocal) {
        // 1. Get local user posts from IndexedDB
        try {
          const localParsed = await getLocalUserPostsIndexedDB();
          if (Array.isArray(localParsed)) {
            const boardPosts = localParsed.filter((p: Post) => (p.boardId || 'user-board') === 'user-board');
            postsList.push(...boardPosts);
          }
        } catch (e) {
          console.warn('[MoveImages] Error loading local posts:', e);
        }
      } else {
        // 2. Check localStorage caches for instant fresh local cache matching current board or main feed
        try {
          const cacheKeys = [
            post.boardId ? `posts_cache_${post.boardId}` : `posts_cache_null`,
            'posts_cache_null',
            'posts_cache_main-feed'
          ];
          for (const key of cacheKeys) {
            const cachedStr = localStorage.getItem(key);
            if (cachedStr) {
              const parsed = JSON.parse(cachedStr);
              if (Array.isArray(parsed)) {
                parsed.forEach((p: Post) => {
                  const matchesBoard = (!post.boardId && (!p.boardId || p.boardId === 'main-feed' || p.boardId === 'placeholder'))
                    || (post.boardId && p.boardId === post.boardId);
                  if (matchesBoard && !postsList.some(existing => existing.id === p.id)) {
                    postsList.push(p);
                  }
                });
              }
            }
          }
        } catch (e) {
          console.warn('[MoveImages] Error reading localStorage cache:', e);
        }

        // 3. Query Firestore specifically for the current boardId
        try {
          const targetBoardQueryVal = post.boardId || null;
          const q = query(
            collection(db, 'posts'),
            where('boardId', '==', targetBoardQueryVal),
            limit(100)
          );
          const snap = await getDocs(q);
          const fetchedRemote = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Post);
          fetchedRemote.forEach(p => {
            if (!postsList.some(existing => existing.id === p.id)) {
              postsList.push(p);
            }
          });
        } catch (e) {
          console.warn('[MoveImages] Error querying Firestore by boardId:', e);
        }

        // 4. Fallback: Query latest posts from Firestore to ensure newly uploaded posts are captured
        try {
          const qLatest = query(
            collection(db, 'posts'),
            orderBy('createdAt', 'desc'),
            limit(50)
          );
          const snapLatest = await getDocs(qLatest);
          const fetchedLatest = snapLatest.docs.map(d => ({ id: d.id, ...d.data() }) as Post);
          fetchedLatest.forEach(p => {
            const matchesBoard = (!post.boardId && (!p.boardId || p.boardId === 'main-feed' || p.boardId === 'placeholder'))
              || (post.boardId && p.boardId === post.boardId);
            if (matchesBoard && !postsList.some(existing => existing.id === p.id)) {
              postsList.push(p);
            }
          });
        } catch (e) {
          console.warn('[MoveImages] Error querying latest Firestore posts:', e);
        }
      }

      // Sort all gathered candidate posts by creation time descending
      postsList.sort((a, b) => {
        const getMs = (p: Post) => {
          if (p.createdAt?.toMillis) return p.createdAt.toMillis();
          if (p.createdAt?.seconds) return p.createdAt.seconds * 1000;
          if (p.createdAtMillis) return p.createdAtMillis;
          return 0;
        };
        return getMs(b) - getMs(a);
      });

      // Filter out current post itself
      const filtered = postsList.filter(p => p.id !== post.id);
      setTargetPostsList(filtered);
    } catch (err) {
      console.error('[MoveImages] Error opening move modal:', err);
    } finally {
      setIsLoadingTargetPosts(false);
    }
  };

  const handleExecuteMoveImages = async () => {
    if (!selectedTargetPost || selectedImageIndices.length === 0) return;

    setIsExecutingMoveImages(true);
    try {
      const movedUrls = selectedImageIndices.map(i => editedImageUrls[i]);
      const movedModels = selectedImageIndices.map(i => editedImageModels[i] || '');
      const movedCaptions = selectedImageIndices.map(i => editedImageCaptions[i] || '');
      const movedNames = selectedImageIndices.map(i => editedFileNames[i] || '');
      const movedTypes = selectedImageIndices.map(i => editedFileTypes[i] || '');
      const movedSizes = selectedImageIndices.map(i => editedFileSizes[i] || '');

      const isTargetLocal = selectedTargetPost.boardId === 'user-board' || selectedTargetPost.id.startsWith('local-');

      if (isTargetLocal) {
        const localPosts = await getLocalUserPostsIndexedDB();
        const updatedLocal = localPosts.map((p: any) => {
          if (p.id === selectedTargetPost.id) {
            const currentUrls = p.imageUrls || (p.imageUrl ? [p.imageUrl] : []);
            const currentModels = p.imageModels || [];
            const currentCaptions = p.imageCaptions || [];
            const currentNames = p.fileNames || [];
            const currentTypes = p.fileTypes || [];
            const currentSizes = p.fileSizes || [];

            return {
              ...p,
              imageUrls: [...currentUrls, ...movedUrls],
              imageUrl: currentUrls.length > 0 ? currentUrls[0] : (movedUrls[0] || null),
              imageModels: [...currentModels, ...movedModels],
              imageCaptions: [...currentCaptions, ...movedCaptions],
              fileNames: [...currentNames, ...movedNames],
              fileTypes: [...currentTypes, ...movedTypes],
              fileSizes: [...currentSizes, ...movedSizes],
            };
          }
          return p;
        });
        await saveLocalUserPostsIndexedDB(updatedLocal);
      } else {
        const targetDocRef = doc(db, 'posts', selectedTargetPost.id);
        const targetSnap = await getDoc(targetDocRef);
        if (targetSnap.exists()) {
          const tData = targetSnap.data();
          const currentUrls = tData.imageUrls || (tData.imageUrl ? [tData.imageUrl] : []);
          const currentModels = tData.imageModels || [];
          const currentCaptions = tData.imageCaptions || [];
          const currentNames = tData.fileNames || [];
          const currentTypes = tData.fileTypes || [];
          const currentSizes = tData.fileSizes || [];

          await updateDoc(targetDocRef, {
            imageUrls: [...currentUrls, ...movedUrls],
            imageUrl: currentUrls.length > 0 ? currentUrls[0] : (movedUrls[0] || null),
            imageModels: [...currentModels, ...movedModels],
            imageCaptions: [...currentCaptions, ...movedCaptions],
            fileNames: [...currentNames, ...movedNames],
            fileTypes: [...currentTypes, ...movedTypes],
            fileSizes: [...currentSizes, ...movedSizes],
            updatedAt: serverTimestamp(),
          });
        }
      }

      // Remove moved images from current post edit state
      setEditedImageUrls(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));
      setEditedImageModels(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));
      setEditedImageCaptions(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));
      setEditedFileNames(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));
      setEditedFileTypes(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));
      setEditedFileSizes(prev => prev.filter((_, idx) => !selectedImageIndices.includes(idx)));

      // Dispatch events to notify feed
      window.dispatchEvent(new Event('reload_local_posts'));

      const count = selectedImageIndices.length;
      showToast(`✅ تم نقل ${count} ${count === 1 ? 'صورة/ملف' : 'صور/ملفات'} إلى المنشور الوجهة بنجاح! 🎉`);

      setSelectedImageIndices([]);
      setIsMoveImagesModalOpen(false);
      setSelectedTargetPost(null);
    } catch (err: any) {
      console.error('[MoveImages] Error executing move:', err);
      showToast('❌ حدث خطأ أثناء نقل الصور. يرجى المحاولة مرة أخرى.');
    } finally {
      setIsExecutingMoveImages(false);
    }
  };
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const targetProgressRef = React.useRef(0);
  const [downloadingFileUrl, setDownloadingFileUrl] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  React.useEffect(() => {
    if (!isSaving) {
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
  }, [isSaving]);
  const [failedImageUrls, setFailedImageUrls] = useState<Record<string, boolean>>({});
  const [revealedImages, setRevealedImages] = useState<Record<string, boolean>>({});
  
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  const [isMoveMode, setIsMoveMode] = useState(false);
  const longPressTimeoutRef = React.useRef<any>(null);
  const isLongPressingRef = React.useRef(false);
  const startPosRef = React.useRef({ x: 0, y: 0 });

  const isInteractive = (target: HTMLElement | null): boolean => {
    let current = target;
    while (current) {
      const tag = current.tagName.toLowerCase();
      if (
        tag === 'button' ||
        tag === 'a' ||
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        tag === 'iframe' ||
        tag === 'video' ||
        tag === 'audio' ||
        current.getAttribute('role') === 'button' ||
        current.onclick ||
        current.classList.contains('cursor-pointer') ||
        current.classList.contains('pointer-events-auto')
      ) {
        return true;
      }
      if (current.classList.contains('post-card-container')) {
        break;
      }
      current = current.parentElement;
    }
    return false;
  };

  const startLongPress = (e: React.PointerEvent) => {
    if (!hasManagePermissions) return;
    if (isInteractive(e.target as HTMLElement)) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    startPosRef.current = { x: e.clientX, y: e.clientY };
    isLongPressingRef.current = false;
    
    longPressTimeoutRef.current = setTimeout(() => {
      setIsMoveMode(true);
      isLongPressingRef.current = true;
      if (navigator.vibrate) {
        navigator.vibrate(80);
      }
    }, 600);
  };

  const cancelLongPress = () => {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const dx = Math.abs(e.clientX - startPosRef.current.x);
    const dy = Math.abs(e.clientY - startPosRef.current.y);
    if (dx > 10 || dy > 10) {
      cancelLongPress();
    }
  };

  const isUrlAnImage = (url: string, index: number) => {
    const type = editedFileTypes[index] || post.fileTypes?.[index];
    if (type) {
      if (type.startsWith('video/') || type.startsWith('audio/') || !type.startsWith('image/')) {
        return false;
      }
      if (type.startsWith('image/')) {
        return true;
      }
    }
    const name = editedFileNames[index] || post.fileNames?.[index];
    if (name) {
      if (/\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv|mp3|wma|wav|aac|m4a|ogg|flac|amr|pdf|apk|exe|zip|rar|7z|tar|gz|txt|json|doc|docx|xls|xlsx|ppt|pptx|csv|iso|bin|dmg|ipa|html|css|js|ts)$/i.test(name)) {
        return false;
      }
      if (/\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(name)) {
        return true;
      }
    }
    if (url.startsWith('data:image/')) {
      return true;
    }
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    if (/\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv|mp3|wma|wav|aac|m4a|ogg|flac|amr|pdf|apk|exe|zip|rar|7z|tar|gz|txt|json|doc|docx|xls|xlsx|ppt|pptx|csv|iso|bin|dmg|ipa|html|css|js|ts)$/i.test(cleanUrl)) {
      return false;
    }
    if (/\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(cleanUrl)) {
      return true;
    }
    if (url.includes('drive.google.com/thumbnail') || url.includes('/thumbnail?id=')) {
      return true;
    }
    return false;
  };

  const downloadAndAttachEditedImageFromUrl = async (imageUrl: string) => {
    if (!imageUrl) return;
    showToast('📸 جاري جلب وضغط الصورة الذكي بالابعاد الكاملة...');
    try {
      const file = await downloadAndSmartCompressImageFromUrl(imageUrl);
      if (!file) {
        throw new Error('فشل تنزيل ملف الصورة من الرابط.');
      }

      const previewUrl = URL.createObjectURL(file);
      const fileSizeStr = formatFileSize(file.size);

      setNewImages(prev => [...prev, file]);
      setNewPreviews(prev => [...prev, `file:${file.name}:${file.type || 'image/jpeg'}:${fileSizeStr}:${previewUrl}`]);
      setNewImageModels(prev => [...prev, '']);
      setNewImageCaptions(prev => [...prev, `صورة معالجة (${fileSizeStr})`]);
      setNewFileNames(prev => [...prev, file.name]);
      setNewFileTypes(prev => [...prev, file.type || 'image/jpeg']);
      setNewFileSizes(prev => [...prev, fileSizeStr]);

      showToast('✨ تم تنزيل وضغط الصورة بالدقة الكاملة بنجاح');
    } catch (err: any) {
      console.error('[PostCard DownloadImage] Error:', err);
      showToast(err.message || 'تعذر تنزيل ملف الصورة تلقائياً من الرابط');
    }
  };

  const processEditedTextForImageUrls = (inputText: string) => {
    const { foundUrls, cleanText } = extractImageUrlsFromText(inputText);
    if (foundUrls.length === 0) {
      setEditedText(inputText);
      return;
    }

    setEditedText(cleanText);

    for (const href of foundUrls) {
      downloadAndAttachEditedImageFromUrl(href);
    }
  };
  
  const hasManagePermissions = isAdmin || isLocalPost;
  
  const [isDeleting, setIsDeleting] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isPinning, setIsPinning] = useState(false);

  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasManagePermissions) return;
    try {
      setIsPinning(true);
      if (isLocalPost) {
        const parsed = await getLocalUserPostsIndexedDB();
        const updated = parsed.map((p: any) => {
          if (p.id === post.id) {
            return { ...p, isPinned: !p.isPinned };
          }
          return p;
        });
        await saveLocalUserPostsIndexedDB(updated);
        window.dispatchEvent(new Event('reload_local_posts'));
        setIsPinning(false);
        return;
      }
      const isPinnedNewValue = !post.isPinned;
      await updateDoc(doc(db, 'posts', post.id), {
        isPinned: isPinnedNewValue,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error('[PostCard] Error updating pin status:', err);
      handleFirestoreError(err, OperationType.UPDATE, `posts/${post.id}`);
    } finally {
      setIsPinning(false);
    }
  };

  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const [hasTextOverflow, setHasTextOverflow] = useState(false);
  const postTextContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkOverflow = () => {
      if (postTextContainerRef.current) {
        if (!isTextExpanded) {
          const el = postTextContainerRef.current;
          // Check if scrollHeight exceeds clientHeight (or scrollWidth exceeds clientWidth)
          const isOverflowing = el.scrollHeight > el.clientHeight + 1;
          setHasTextOverflow(isOverflowing);
        }
      }
    };

    checkOverflow();
    const frameId = requestAnimationFrame(checkOverflow);
    const timerId = setTimeout(checkOverflow, 120);

    let resizeObserver: ResizeObserver | null = null;
    if (postTextContainerRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        checkOverflow();
      });
      resizeObserver.observe(postTextContainerRef.current);
    }

    window.addEventListener('resize', checkOverflow);
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(timerId);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', checkOverflow);
    };
  }, [post.text, fontSize, isTextExpanded]);

  const [isCopied, setIsCopied] = useState(false);
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);

  useEffect(() => {
    const handleCloseCopyMenu = () => {
      setIsCopyMenuOpen(false);
    };
    if (isCopyMenuOpen) {
      window.addEventListener('click', handleCloseCopyMenu);
    }
    return () => {
      window.removeEventListener('click', handleCloseCopyMenu);
    };
  }, [isCopyMenuOpen]);

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxZoomRef = useRef<{ zoom: number; changeZoom: (target: number) => void } | null>(null);
  const lastLightboxClickTimeRef = useRef<number>(0);

  // States for the new prompt dropdown menu
  const [showDropdown, setShowDropdown] = useState(false);
  const [newSiteUrl, setNewSiteUrl] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [customSites, setCustomSites] = useState<{ label?: string; url: string }[]>(() => {
    try {
      const saved = localStorage.getItem('user_custom_generator_sites');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [visitedTrialUrls, setVisitedTrialUrls] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('user_trial_visited_sites_v2');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('user_trial_visited_sites_v2', JSON.stringify(visitedTrialUrls));
  }, [visitedTrialUrls]);

  // Lock body scroll when execution dropdown is open to prevent background scrolling/jitter
  useEffect(() => {
    if (showDropdown) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showDropdown]);

  const handleEditCustomSiteLabel = (url: string, newLabel: string) => {
    const updated = customSites.map(s => s.url === url ? { ...s, label: newLabel } : s);
    setCustomSites(updated);
    localStorage.setItem('user_custom_generator_sites', JSON.stringify(updated));
  };

  const handleTestPromptClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Copy the prompt text toclipboard automatically
    try {
      await navigator.clipboard.writeText(post.text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
      // Fallback
      try {
        const textArea = document.createElement('textarea');
        textArea.value = post.text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (fallbackErr) {
        console.warn('Fallback copy failed:', fallbackErr);
      }
    }

    setShowDropdown(prev => !prev);
  };

  const handleSaveCustomSite = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!newSiteUrl.trim()) return;
    
    let url = newSiteUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const label = newSiteName.trim();

    const updated = [...customSites, { label: label || undefined, url }];
    setCustomSites(updated);
    setNewSiteUrl('');
    setNewSiteName('');
    localStorage.setItem('user_custom_generator_sites', JSON.stringify(updated));
  };

  const handleDeleteCustomSite = (urlToDelete: string) => {
    const updated = customSites.filter(site => site.url !== urlToDelete);
    setCustomSites(updated);
    localStorage.setItem('user_custom_generator_sites', JSON.stringify(updated));
  };

  // Handle mobile back gesture to close lightbox
  useEffect(() => {
    if (!lightboxOpen) return;

    const handlePopState = () => {
      setLightboxOpen(false);
    };

    // Push a dummy state to history
    window.history.pushState({ lightboxId: post.id }, "");
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      // If we are closing via state change (not popstate), we need to clear our history entry
      if (window.history.state?.lightboxId === post.id) {
        window.history.back();
      }
    };
  }, [lightboxOpen, post.id]);

  useEffect(() => {
    if (isEditing) {
      setEditedText(post.text);
      const originalUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
      setEditedImageUrls(originalUrls);
      setEditedBoardId(post.boardId || null);
      setEditedSubBoardId(post.subBoardId || null);
      setNewImages([]);
      setNewPreviews([]);
      setRemovedImageUrls([]);
      
      const originalModels = Array(originalUrls.length).fill('').map((_, i) => post.imageModels?.[i] || '');
      setEditedImageModels(originalModels);
      setNewImageModels([]);
      
      const originalCaptions = Array(originalUrls.length).fill('').map((_, i) => post.imageCaptions?.[i] || '');
      setEditedImageCaptions(originalCaptions);
      setNewImageCaptions([]);

      const originalFileNames = Array(originalUrls.length).fill('').map((_, i) => post.fileNames?.[i] || '');
      setEditedFileNames(originalFileNames);
      setNewFileNames([]);

      const originalFileTypes = Array(originalUrls.length).fill('').map((_, i) => post.fileTypes?.[i] || '');
      setEditedFileTypes(originalFileTypes);
      setNewFileTypes([]);
      setSelectedImageIndices([]);
    }
  }, [isEditing]); // Only reset when toggling isEditing

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsCopyMenuOpen(!isCopyMenuOpen);
  };

  const handleCopyForTranslate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(post.text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      
      localStorage.setItem('shared_text_editor_text', post.text);
      localStorage.setItem('shared_text_editor_post_id', post.id);
      window.dispatchEvent(new Event('open_text_editor'));
      window.dispatchEvent(new CustomEvent('check_text_editor_text', { detail: { text: post.text, postId: post.id } }));
      setIsCopyMenuOpen(false);
    } catch (err) {
      console.error('Failed to copy for translate: ', err);
    }
  };

  const handleCopyOnly = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(post.text);
      setIsCopied(true);
      setIsCopyMenuOpen(false);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const handleCopyForEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(post.text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      
      localStorage.setItem('shared_incoming_prompt', post.text);
      window.dispatchEvent(new Event('check_shared_prompt'));
      window.dispatchEvent(new Event('switch_to_prompt_builder'));
      setIsCopyMenuOpen(false);
    } catch (err) {
      console.error('Failed to copy for edit: ', err);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    const postPath = `posts/${post.id}`;
    
    try {
      if (isLocalPost) {
        const parsed = await getLocalUserPostsIndexedDB();
        const filtered = parsed.filter((p: any) => p.id !== post.id);
        await saveLocalUserPostsIndexedDB(filtered);
        window.dispatchEvent(new Event('reload_local_posts'));
        showToast('تم حذف المنشور من لوحتك');
        setIsDeleting(false);
        setShowDeleteConfirm(false);
        return;
      }
      const boardName = post.boardId === null 
        ? 'الرئيسية' 
        : (boards.find(b => b.id === post.boardId)?.name || 'الرئيسية');
      await movePostToRecycleBin(post, boardName);
      showToast('تم نقل المنشور إلى سلة المحذوفات 🗑️');
    } catch (err) {
      console.error('Delete error:', err);
      showToast('حدث خطأ أثناء الحذف: ' + (err instanceof Error ? err.message : String(err)));
      handleFirestoreError(err, OperationType.DELETE, postPath);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleAuthorize = async (shouldSetLoadingState = true) => {
    if (shouldSetLoadingState) {
      setIsSaving(true);
    }
    setStatus('جاري طلب صلاحية الوصول...');
    try {
      await googleSignIn();
    } catch (err) {
      console.error('[PostCard] Authorization failed:', err);
      showToast('فشل الحصول على صلاحية الوصول. يرجى التأكد من السماح بالنوافذ المنبثقة.');
    } finally {
      if (shouldSetLoadingState) {
        setIsSaving(false);
        setStatus('');
      }
    }
  };

  const handleUpdate = async () => {
    console.log('[PostCard] Starting update check...');
    const totalCount = editedImageUrls.length + newImages.length;
    
    if (!editedText.trim() && totalCount === 0) {
      showToast('لا يمكن حفظ منشور فارغ (برجاء كتابة نص أو إضافة صورة)');
      return;
    }

    setIsSaving(true);
    setStatus('جاري الحفظ...');
    setUploadProgress(5);
    targetProgressRef.current = 5;

    try {
      // 0. Extract any raw image URLs from editedText as well
      const { foundUrls, cleanText } = extractImageUrlsFromText(editedText);
      const finalTextToSave = cleanText;

      const rawUrlsToProcess: string[] = [
        ...foundUrls,
        ...(newImages.filter(img => typeof img === 'string') as string[])
      ];

      const initialFiles: File[] = [
        ...(newImages.filter(img => typeof img !== 'string') as File[])
      ];

      if (rawUrlsToProcess.length > 0) {
        setStatus('جاري جلب وضغط الصور من الروابط بالابعاد الكاملة...');
        for (const rawUrl of rawUrlsToProcess) {
          try {
            const f = await downloadAndSmartCompressImageFromUrl(rawUrl);
            if (f) {
              initialFiles.push(f);
            }
          } catch (e) {
            console.warn('[PostCard] Failed to download/compress raw URL:', rawUrl, e);
          }
        }
      }

      if (isLocalPost) {
        setStatus('جاري حفظ التعديلات محلياً...');
        const newUrls: string[] = [];
        for (let i = 0; i < initialFiles.length; i++) {
          const file = initialFiles[i];
          for (let p = 1; p <= 100; p++) {
            targetProgressRef.current = Math.round(((i * 100) + p) / initialFiles.length);
            await new Promise(r => setTimeout(r, 6));
          }
          if (file.type.startsWith('image/')) {
            const base64 = await compressImage(file);
            newUrls.push(base64);
          } else {
            const base64 = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.readAsDataURL(file);
            });
            newUrls.push(base64);
          }
        }

        const remainingOldUrls = editedImageUrls.filter(url => !removedImageUrls.includes(url));
        const finalImageUrls = [...remainingOldUrls, ...newUrls];
        const finalImageModels = [...editedImageModels, ...newImageModels];
        const finalImageCaptions = [...editedImageCaptions, ...newImageCaptions];
        const finalFileNames = [...editedFileNames, ...newFileNames];
        const finalFileTypes = [...editedFileTypes, ...newFileTypes];

        const parsed = await getLocalUserPostsIndexedDB();
        const updated = parsed.map((p: any) => {
          if (p.id === post.id) {
            return {
              ...p,
              text: finalTextToSave,
              imageUrls: finalImageUrls,
              imageUrl: finalImageUrls.length > 0 ? finalImageUrls[0] : null,
              imageModels: finalImageModels,
              imageCaptions: finalImageCaptions,
              fileNames: finalFileNames,
              fileTypes: finalFileTypes,
              boardId: editedBoardId,
              subBoardId: editedSubBoardId || null,
            };
          }
          return p;
        });
        
        const isSaved = await saveLocalUserPostsIndexedDB(updated);
        if (isSaved) {
          window.dispatchEvent(new Event('reload_local_posts'));
          showToast('تم تحديث المنشور محلياً بنجاح✅');
        }

        // Complete progress to 100%
        targetProgressRef.current = 100;
        await new Promise(resolve => setTimeout(resolve, 450));

        setIsEditing(false);
        setNewImages([]);
        setNewPreviews([]);
        setRemovedImageUrls([]);
        setNewFileNames([]);
        setNewFileTypes([]);
        setIsSaving(false);
        setStatus('');
        returnScrollToCard();
        return;
      }

      setStatus('جاري معالجة الملفات...');
      const finalImageUrls = [...editedImageUrls.filter(url => !removedImageUrls.includes(url))];
      
      // 1. Upload new files if any
      const filesToUpload = initialFiles;

      if (filesToUpload.length > 0) {
        const activeToken = getAccessToken();
        if (!activeToken || activeToken === 'local-dummy-token') {
          showToast('يتطلب رفع ملفات جديدة تسجيل الدخول إلى Google Drive.');
          await handleAuthorize(false);
          const freshToken = getAccessToken();
          if (!freshToken || freshToken === 'local-dummy-token') {
            setIsSaving(false);
            setStatus('');
            return;
          }
        }

        for (let i = 0; i < filesToUpload.length; i++) {
          setStatus(`يتم رفع الملف ${i + 1}/${filesToUpload.length} إلى G-Drive`);
          try {
            const url = await uploadPostImage(filesToUpload[i], post.authorId, finalTextToSave, (percent) => {
              const overallPercent = Math.round(((i * 100) + percent) / filesToUpload.length);
              targetProgressRef.current = Math.max(targetProgressRef.current, overallPercent);
            });
            finalImageUrls.push(url);
          } catch (uploadErr: any) {
            console.warn('[PostCard] File upload error:', uploadErr);
            if (uploadErr.message === 'AUTH_REQUIRED' || uploadErr.message === 'AUTH_EXPIRED') {
              await handleAuthorize(false);
              const freshToken = getAccessToken();
              if (!freshToken || freshToken === 'local-dummy-token') {
                setIsSaving(false);
                setStatus('');
                return;
              }
              const url = await uploadPostImage(filesToUpload[i], post.authorId, finalTextToSave, (percent) => {
                const overallPercent = Math.round(((i * 100) + percent) / filesToUpload.length);
                targetProgressRef.current = Math.max(targetProgressRef.current, overallPercent);
              });
              finalImageUrls.push(url);
              continue;
            }
            throw uploadErr;
          }
        }
      }

      // 2. Delete removed images/files
      if (removedImageUrls.length > 0) {
        setStatus('جاري حذف الملفات القديمة...');
        const token = getAccessToken();
        for (const url of removedImageUrls) {
          try {
            await deletePostImage(url, token);
          } catch (deleteErr) {
            console.warn('[PostCard] Delete failed:', deleteErr);
          }
        }
      }

      setStatus('جاري الحفظ في Firestore...');
      // 3. Update Firestore
      targetProgressRef.current = 95;
       const finalImageModels = [...editedImageModels, ...newImageModels];
      const finalImageCaptions = [...editedImageCaptions, ...newImageCaptions];
      const finalFileNames = [...editedFileNames, ...newFileNames];
      const finalFileTypes = [...editedFileTypes, ...newFileTypes];
      const finalFileSizes = [...editedFileSizes, ...newFileSizes];

      const isSafeBoard = editedBoardId === 'safe-board';
      const vaultKey = sessionStorage.getItem('safe_vault_password') || '';

      const textToSave = isSafeBoard && vaultKey ? encryptText(finalTextToSave, vaultKey) : finalTextToSave;
      const captionsToSave = isSafeBoard && vaultKey ? encryptArray(finalImageCaptions, vaultKey) : finalImageCaptions;
      const fileNamesToSave = isSafeBoard && vaultKey ? encryptArray(finalFileNames, vaultKey) : finalFileNames;
      const fileSizesToSave = isSafeBoard && vaultKey ? encryptArray(finalFileSizes, vaultKey) : finalFileSizes;

      await updateDoc(doc(db, 'posts', post.id), {
        text: textToSave,
        imageUrls: finalImageUrls,
        imageUrl: finalImageUrls.length > 0 ? finalImageUrls[0] : null,
        imageModels: finalImageModels,
        imageCaptions: captionsToSave,
        fileNames: fileNamesToSave,
        fileTypes: finalFileTypes,
        fileSizes: fileSizesToSave,
        boardId: editedBoardId,
        subBoardId: editedSubBoardId || null,
        updatedAt: serverTimestamp(),
      });

      console.log('[PostCard] Update successful');

      // Complete progress to 100%
      targetProgressRef.current = 100;
      await new Promise(resolve => setTimeout(resolve, 450));

      setIsEditing(false);
      setEditTextareaHeight(null);
      setNewImages([]);
      setNewPreviews([]);
      setRemovedImageUrls([]);
      setNewFileNames([]);
      setNewFileTypes([]);
      setNewFileSizes([]);
      showToast('تم تحديث المنشور بنجاح✅');
      returnScrollToCard();
    } catch (err) {
      console.error('[PostCard] Fatal update error:', err);
      handleFirestoreError(err, OperationType.UPDATE, `posts/${post.id}`);
      showToast('حدث خطأ أثناء التحديث: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsSaving(false);
      setStatus('');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleImageAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    const nextNewImages = [...newImages];
    const nextNewModels = [...newImageModels];
    const nextNewCaptions = [...newImageCaptions];
    const nextNewFileNames = [...newFileNames];
    const nextNewFileTypes = [...newFileTypes];
    const nextNewFileSizes = [...newFileSizes];

    files.forEach(file => {
      nextNewImages.push(file);
      nextNewModels.push(''); 
      nextNewCaptions.push(''); 
      nextNewFileNames.push(file.name);
      nextNewFileTypes.push(file.type || 'application/octet-stream');
      nextNewFileSizes.push(formatFileSize(file.size));

      const isImg = file.type.startsWith('image/');
      if (isImg) {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) {
            setNewPreviews(prev => [...prev, reader.result as string]);
          }
        };
        reader.readAsDataURL(file);
      } else {
        const localUrl = URL.createObjectURL(file);
        const previewStr = `file:${file.name}:${file.type || 'application/octet-stream'}:${formatFileSize(file.size)}:${localUrl}`;
        setNewPreviews(prev => [...prev, previewStr]);
      }
    });

    setNewImages(nextNewImages);
    setNewImageModels(nextNewModels);
    setNewImageCaptions(nextNewCaptions);
    setNewFileNames(nextNewFileNames);
    setNewFileTypes(nextNewFileTypes);
    setNewFileSizes(nextNewFileSizes);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeExistingImage = (index: number) => {
    const url = editedImageUrls[index];
    setEditedImageUrls(editedImageUrls.filter((_, i) => i !== index));
    setEditedImageModels(editedImageModels.filter((_, i) => i !== index));
    setEditedImageCaptions(editedImageCaptions.filter((_, i) => i !== index));
    setEditedFileNames(editedFileNames.filter((_, i) => i !== index));
    setEditedFileTypes(editedFileTypes.filter((_, i) => i !== index));
    setEditedFileSizes(editedFileSizes.filter((_, i) => i !== index));
    setRemovedImageUrls([...removedImageUrls, url]);
  };

  const removeNewImage = (index: number) => {
    const previewToRemove = newPreviews[index];
    if (previewToRemove && previewToRemove.startsWith('file:')) {
      const parts = previewToRemove.split(':');
      const objectUrl = parts.slice(4).join(':');
      if (objectUrl && objectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(objectUrl);
      }
    }
    setNewImages(newImages.filter((_, i) => i !== index));
    setNewPreviews(newPreviews.filter((_, i) => i !== index));
    setNewImageModels(newImageModels.filter((_, i) => i !== index));
    setNewImageCaptions(newImageCaptions.filter((_, i) => i !== index));
    setNewFileNames(newFileNames.filter((_, i) => i !== index));
    setNewFileTypes(newFileTypes.filter((_, i) => i !== index));
    setNewFileSizes(newFileSizes.filter((_, i) => i !== index));
  };

  const extractFileIdFromUrl = (url: string): string | null => {
    try {
      if (!url) return null;
      if (url.startsWith('data:')) return null;
      const urlObj = new URL(url);
      const id = urlObj.searchParams.get('id');
      if (id) return id;
      
      const pathParts = urlObj.pathname.split('/');
      const dIdx = pathParts.indexOf('d');
      if (dIdx !== -1 && pathParts[dIdx + 1]) {
        return pathParts[dIdx + 1];
      }
    } catch (e) {
      // Ignore
    }
    return null;
  };

  const imageUrls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
  const fileNames = post.fileNames || [];
  const fileTypes = post.fileTypes || [];

  const isAudioFile = (name: string | undefined, type: string | undefined, url: string) => {
    if (type) {
      if (type.startsWith('audio/')) return true;
    }
    const filename = name || '';
    if (/\.(mp3|wma|wav|aac|m4a|ogg|flac|amr)$/i.test(filename)) return true;
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    return /\.(mp3|wma|wav|aac|m4a|ogg|flac|amr)$/i.test(cleanUrl);
  };

  const isVideoFile = (name: string | undefined, type: string | undefined, url: string) => {
    if (type) {
      if (type.startsWith('video/')) return true;
    }
    const filename = name || '';
    if (/\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv)$/i.test(filename)) return true;
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    return /\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv)$/i.test(cleanUrl);
  };

  const imagesList = imageUrls.filter((url, i) => isUrlAnImage(url, i));
  const attachmentsList = imageUrls
    .map((url, i) => {
      const fileId = extractFileIdFromUrl(url);
      const downloadUrl = fileId ? `https://drive.usercontent.google.com/download?id=${fileId}&export=download` : url;
      return { url, downloadUrl, name: fileNames[i], type: fileTypes[i], size: post.fileSizes?.[i], index: i };
    })
    .filter(item => !isUrlAnImage(item.url, item.index));

  const audioList = attachmentsList.filter(item => isAudioFile(item.name, item.type, item.url));
  const videoList = attachmentsList.filter(item => isVideoFile(item.name, item.type, item.url));
  const filesList = attachmentsList.filter(item => !isAudioFile(item.name, item.type, item.url) && !isVideoFile(item.name, item.type, item.url));

  const slides = imagesList.map((url) => {
    const origIdx = imageUrls.indexOf(url);
    return {
      src: url,
      modelName: post.imageModels?.[origIdx] || ''
    };
  });

  const handleDownloadFile = async (e: React.MouseEvent, url: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();

    // Prevent multiple simultaneous downloads for the same file
    if (downloadingFileUrl === url) return;

    // Sanitize the filename to strip any "horizon_" or "horizon_TIMESTAMP_" prefix
    let sanitizedName = name || 'file';
    if (sanitizedName.startsWith('horizon_')) {
      sanitizedName = sanitizedName.replace(/^horizon_(?:\d+_)?/, '');
    }

    const fileId = extractFileIdFromUrl(url);
    const isNetlify = window.location.hostname.includes('netlify');
    const isStaticHost = 
      !isNetlify && (
        window.location.hostname.includes('github') || 
        window.location.hostname.includes('vercel') ||
        (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app'))
      );

    // Helper to perform direct Google Drive download on static hostings or as a fallback
    const triggerDirectDriveDownload = (fId: string) => {
      const directUrl = `https://drive.usercontent.google.com/download?id=${fId}&export=download`;
      showToast('📥 جاري تنزيل الملف مباشرة...');
      
      // Download directly in the current page without opening a new tab/window.
      // Google Drive's download endpoint returns Content-Disposition: attachment,
      // which is native and doesn't disrupt the active page state.
      window.location.href = directUrl;
      
      setDownloadingFileUrl(null);
      setDownloadProgress(0);
    };

    let progressInterval: NodeJS.Timeout | null = null;
    const startProgressSimulation = () => {
      let currentProgress = 0;
      setDownloadProgress(0);
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(() => {
        // Smooth logarithmic visual curve with progressive slow-down so the progress bar never freezes
        let increment = 1;
        if (currentProgress < 50) {
          increment = Math.max(1.5, (50 - currentProgress) * 0.08);
        } else if (currentProgress < 80) {
          increment = Math.max(0.8, (80 - currentProgress) * 0.04);
        } else if (currentProgress < 95) {
          increment = Math.max(0.4, (95 - currentProgress) * 0.02);
        } else {
          // Crawl very slowly so it feels active but never exceeds 99% until fully done
          increment = 0.15;
        }

        currentProgress = Math.min(99, currentProgress + increment);
        const roundedProgress = currentProgress >= 95 ? parseFloat(currentProgress.toFixed(1)) : Math.round(currentProgress);
        setDownloadProgress(roundedProgress);
      }, 350);
    };

    const stopProgressSimulation = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    const startDownloadFlow = async (retryOn401 = true) => {
      // Determine the final URL to fetch/download
      let downloadUrl = url;
      const activeToken = getAccessToken();

      // Determine the backend base URL. If hosted on a static hosting platform (like Netlify),
      // point to our live secure Cloud Run backend deployment to perform proxying with CORS.
      const backendBaseUrl = isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';

      // Create a proxy URL pointing to our backend download proxy
      let proxyUrl = `${backendBaseUrl}/api/download?url=${encodeURIComponent(downloadUrl)}&name=${encodeURIComponent(sanitizedName)}`;
      if (activeToken && activeToken !== 'local-dummy-token') {
        proxyUrl += `&access_token=${encodeURIComponent(activeToken)}`;
      }

      setDownloadingFileUrl(url);
      startProgressSimulation();
      showToast('📥 بدء تنزيل الملف، يرجى الانتظار...');

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', proxyUrl, true);
        xhr.responseType = 'blob';

        xhr.onprogress = (event) => {
          let totalBytes = event.total;
          
          // Try to extract the original file size from custom header 'x-file-size' or standard 'Content-Length'
          if (!totalBytes || totalBytes <= 0) {
            const rawSize = xhr.getResponseHeader('x-file-size') || xhr.getResponseHeader('Content-Length');
            if (rawSize) {
              const parsed = parseInt(rawSize, 10);
              if (!isNaN(parsed) && parsed > 0) {
                totalBytes = parsed;
              }
            }
          }

          if (totalBytes && totalBytes > 0) {
            stopProgressSimulation();
            const percent = Math.min(100, Math.round((event.loaded / totalBytes) * 100));
            setDownloadProgress(percent);
          }
        };

        xhr.onload = async () => {
          stopProgressSimulation();
          if (xhr.status === 200) {
            const contentType = xhr.getResponseHeader('Content-Type') || '';
            const isHtml = contentType.includes('text/html');
            const isTargetHtml = sanitizedName.toLowerCase().endsWith('.html') || sanitizedName.toLowerCase().endsWith('.htm');
            if (isHtml && !isTargetHtml) {
              console.error('[Download] Received HTML content for a non-HTML file. This is likely a Google Drive permission error page or Netlify SPA fallback.');
              
              if (retryOn401 && activeToken && activeToken !== 'local-dummy-token') {
                console.log('[Download] Access might have expired or requires re-auth. Attempting silent/popup re-authorization...');
                showToast('🔑 انتهت صلاحية الصلاحيات، يرجى تسجيل الدخول مجدداً لتنزيل الملف بأمان...');
                try {
                  const authResult = await googleSignIn();
                  if (authResult && authResult.accessToken) {
                    showToast('🔄 تم تجديد الصلاحية بنجاح! جاري التنزيل...');
                    startDownloadFlow(false);
                    return;
                  }
                } catch (authErr) {
                  console.error('[Download] Re-authorization failed:', authErr);
                }
              }

              if (fileId) {
                console.log('[Download] Falling back to direct Google Drive download...');
                triggerDirectDriveDownload(fileId);
              } else {
                setDownloadingFileUrl(null);
                setDownloadProgress(0);
                showToast('⚠️ فشل التنزيل: يرجى تفعيل حساب G-Drive أو إعادة تسجيل الدخول لتنزيل الملف بالدقة الكاملة.');
              }
              return;
            }

            const blob = xhr.response;
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = sanitizedName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobUrl);
            
            setDownloadProgress(100);
            setTimeout(() => {
              setDownloadingFileUrl(null);
              setDownloadProgress(0);
              showToast('✅ تم تنزيل الملف بنجاح');
            }, 450);
          } else if (xhr.status === 401) {
            console.warn(`XHR download failed with 401 (Unauthorized)`);
            if (retryOn401) {
              console.log('[Download] Received 401. Attempting Google Sign In re-authorization...');
              showToast('🔑 انتهت صلاحية الصلاحيات، يرجى تسجيل الدخول مجدداً لتنزيل الملف بأمان...');
              try {
                const authResult = await googleSignIn();
                if (authResult && authResult.accessToken) {
                  showToast('🔄 تم تجديد الصلاحية بنجاح! جاري التنزيل...');
                  startDownloadFlow(false);
                  return;
                }
              } catch (authErr) {
                console.error('[Download] Re-authorization failed:', authErr);
              }
            }
            
            if (fileId) {
              console.log('[Download] Falling back to direct Google Drive download on failure status...');
              triggerDirectDriveDownload(fileId);
            } else {
              setDownloadingFileUrl(null);
              setDownloadProgress(0);
              showToast('⚠️ فشل التنزيل: يرجى تفعيل حساب G-Drive أو إعادة تسجيل الدخول لتنزيل الملف بالدقة الكاملة.');
            }
          } else {
            console.warn(`XHR download failed with status ${xhr.status}`);
            if (fileId) {
              console.log('[Download] Falling back to direct Google Drive download on failure status...');
              triggerDirectDriveDownload(fileId);
            } else {
              setDownloadingFileUrl(null);
              setDownloadProgress(0);
              showToast('⚠️ فشل التنزيل: يرجى تفعيل حساب G-Drive أو إعادة تسجيل الدخول لتنزيل الملف بالدقة الكاملة.');
            }
          }
        };

        xhr.onerror = () => {
          stopProgressSimulation();
          console.warn('XHR download error, falling back to direct navigation...');
          if (fileId) {
            triggerDirectDriveDownload(fileId);
          } else {
            fallbackDownload(proxyUrl);
          }
        };

        xhr.send();
      } catch (err) {
        stopProgressSimulation();
        console.warn('XHR setup failed, falling back to direct navigation:', err);
        if (fileId) {
          triggerDirectDriveDownload(fileId);
        } else {
          fallbackDownload(proxyUrl);
        }
      }
    };

    await startDownloadFlow(true);
  };

  const fallbackDownload = (proxyUrl: string) => {
    try {
      window.location.href = proxyUrl;
    } catch (err) {
      console.warn('Direct redirection failed, attempting hidden iframe download:', err);
      try {
        let iframe = document.getElementById('download-iframe') as HTMLIFrameElement | null;
        if (!iframe) {
          iframe = document.createElement('iframe');
          iframe.id = 'download-iframe';
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
        }
        iframe.src = proxyUrl;
      } catch (iframeErr) {
        console.error('All download methods failed:', iframeErr);
      }
    }
    // Clean up states after a short delay
    setTimeout(() => {
      setDownloadingFileUrl(null);
      setDownloadProgress(0);
    }, 2000);
  };

  const renderPostImage = (url: string, className: string, alt: string = "", extraProps: any = {}) => {
    if (failedImageUrls[url]) {
      let mainErrorMsg = 'رابط الصورة الخارجي غير متوفر';
      let subErrorMsg = '(قد يكون الرابط غير صالح أو تم حذفه)';
      
      const isDrive = url.includes('drive.google.com') || url.includes('googleusercontent');
      const isMeta = url.includes('fbcdn.net') || url.includes('facebook.com') || url.includes('instagram.com') || url.includes('scontent');

      if (isDrive) {
        mainErrorMsg = 'الصورة غير متوفرة';
        subErrorMsg = '(قد تكون حُذفت أو صلاحيات الوصول مقيدة)';
      } else if (isMeta) {
        mainErrorMsg = 'رابط فيسبوك انتهت صلاحيته';
        subErrorMsg = '(روابط فيسبوك تنتهي صلاحيتها تلقائياً بعد فترة)';
      } else {
        mainErrorMsg = 'رابط الصورة غير متوفر';
        subErrorMsg = '(روابط المواقع الخارجية قد تتغير أو تنتهي صلاحيتها بمرور الوقت)';
      }

      return (
        <div className={`flex flex-col items-center justify-center p-3 text-center bg-zinc-100/40 dark:bg-[#111822]/60 border border-dashed border-red-500/25 h-full w-full min-h-[120px] select-none ${className}`}>
          <span className="text-sm">⚠️</span>
          <p className="text-[10px] font-black text-red-500/90 dark:text-red-400/90 leading-snug px-1.5 mt-1" dir="rtl">
            {mainErrorMsg}
          </p>
          <p className="text-[8px] font-medium text-gray-400 dark:text-gray-500 mt-1 max-w-[90%]" dir="rtl">
            {subErrorMsg}
          </p>
        </div>
      );
    }

    const origIdx = imageUrls.indexOf(url);
    const isObscured = post.imageModels && post.imageModels[origIdx] && post.imageModels[origIdx].includes('تغشية');
    const isRevealed = revealedImages[url];

    if (isObscured && !isRevealed) {
      return (
        <div className={`relative overflow-hidden select-none ${className}`}>
          <img
            src={url}
            alt={alt}
            className="h-full w-full object-cover blur-xl scale-110 pointer-events-none brightness-75 transition-all duration-300"
            onError={() => setFailedImageUrls(prev => ({ ...prev, [url]: true }))}
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            {...extraProps}
          />
          <div 
            className="absolute inset-0 flex items-center justify-center bg-black/25 hover:bg-black/35 transition-colors cursor-pointer z-10"
            onClick={(e) => {
              e.stopPropagation();
              setRevealedImages(prev => ({ ...prev, [url]: true }));
            }}
            title="انقر لإظهار الصورة"
          >
            {/* Custom Fake Loading/Obscure Indicator */}
            <div className="relative w-10 h-10 rounded-full bg-black flex items-center justify-center shadow-2xl border border-white/15 overflow-hidden">
              {/* Small white dash rotating on the inside perimeter */}
              <div className="absolute inset-[2.5px] rounded-full border-[1.5px] border-transparent border-t-white animate-spin z-0" />
              
              {/* White 'x' inside the center */}
              <span className="text-white text-xs font-sans font-black select-none relative z-10 leading-none pb-0.5">x</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <img
        src={url}
        alt={alt}
        className={className}
        onError={() => setFailedImageUrls(prev => ({ ...prev, [url]: true }))}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        {...extraProps}
      />
    );
  };

  return (
    <>
      <motion.div
        ref={cardRef}
        id={id || `post-${originalPost.id}`}
        layout={!isLayoutLocked && !(window as any).lockLayoutAnimations}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onPointerDown={startLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerMove={handlePointerMove}
        style={isMoveMode ? { borderColor: '#EF4444', borderWidth: '3px' } : {}}
        className={`relative mx-auto mb-2.5 w-full max-w-xl rounded-2xl border transition-all post-card-container ${
          isMoveMode
            ? 'ring-4 ring-red-500/20 shadow-[0_0_20px_rgba(239,68,68,0.4)] scale-[1.01] select-none'
            : isDarkMode 
              ? 'border-[#6980b0] bg-[#111822] shadow-[0_4px_12px_rgba(0,0,0,0.15)]' 
              : 'border-[#C1C3B8] bg-white shadow-[0_4px_12px_rgba(90,90,64,0.03)]'
        } ${isDeleting ? 'opacity-50 grayscale pointer-events-none' : ''}`}
      >
        {isMoveMode && (
          <div className="relative z-30 flex items-center justify-between px-4 py-2.5 border-b-2 border-red-500 bg-red-500/10 text-red-600 text-xs font-black rounded-t-xl" dir="rtl">
            <div className="flex items-center gap-1.5">
              <Move size={14} className="animate-bounce text-red-500" />
              <span>المنشور في وضع تعديل الترتيب</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onMovePost && canMoveUp) {
                    onMovePost(post.id, 'up');
                    if (navigator.vibrate) navigator.vibrate(40);

                    // توسيط المنشور الجديد بنعومة في الشاشة بعد تحديث الـ DOM
                    setTimeout(() => {
                      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                  }
                }}
                disabled={!canMoveUp}
                className={`p-1 rounded-md transition-all ${
                  canMoveUp 
                    ? 'bg-red-500 text-white hover:bg-red-600 cursor-pointer shadow-sm' 
                    : 'bg-gray-300 text-gray-500 dark:bg-gray-800 dark:text-gray-600 cursor-not-allowed'
                }`}
                title="نقل للأعلى"
              >
                <ArrowUp size={14} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onMovePost && canMoveDown) {
                    onMovePost(post.id, 'down');
                    if (navigator.vibrate) navigator.vibrate(40);

                    // توسيط المنشور الجديد بنعومة في الشاشة بعد تحديث الـ DOM
                    setTimeout(() => {
                      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                  }
                }}
                disabled={!canMoveDown}
                className={`p-1 rounded-md transition-all ${
                  canMoveDown 
                    ? 'bg-red-500 text-white hover:bg-red-600 cursor-pointer shadow-sm' 
                    : 'bg-gray-300 text-gray-500 dark:bg-gray-800 dark:text-gray-600 cursor-not-allowed'
                }`}
                title="نقل للأسفل"
              >
                <ArrowDown size={14} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMoveMode(false);
                }}
                className="px-3 py-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-black transition-all cursor-pointer shadow-sm"
              >
                تم
              </button>
            </div>
          </div>
        )}

        {isMoveMode && (
          <div className="absolute inset-x-0 bottom-0 top-[45px] bg-white/65 dark:bg-black/70 backdrop-blur-[1.5px] z-20 rounded-b-xl flex flex-col items-center justify-center pointer-events-auto select-none border-t border-red-500/20">
            <div className="flex flex-col items-center gap-2 p-4 bg-white dark:bg-[#111822] rounded-2xl border-2 border-red-500 shadow-[0_10px_25px_-5px_rgba(239,68,68,0.3)] max-w-[85%] text-center">
              <div className="p-3 bg-red-500/10 dark:bg-red-500/20 rounded-full text-red-500 animate-pulse">
                <Move size={24} />
              </div>
              <p className="text-sm font-black text-red-600 dark:text-red-400">
                المنشور مقفل أثناء تغيير الترتيب
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-300 font-bold leading-relaxed">
               .-.-.-.-.-.
                <br />
                استخدم أزرار النقل بالأعلى ثم اضغط <span className="text-emerald-600 dark:text-emerald-400 font-black">"تم"</span>.
              </p>
            </div>
          </div>
        )}
        {/* Post Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-1" dir="rtl">
          <div className="flex items-center gap-3">
            <div className={`flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border shadow-md ${
              isDarkMode 
                ? 'bg-gradient-to-br from-[#008D75] to-[#414C5D] border-[#2C374E]' 
                : 'bg-gradient-to-br from-natural-primary to-natural-muted border-natural-border'
            }`}>
              {isPostFromAdmin && !isLocalPost ? (
                <img src={ADMIN_CONFIG.photoUrl} alt={displayName} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="font-bold text-white uppercase">{avatarChar}</span>
              )}
            </div>
            {/* حجم الايميل للمستخدم وماتحته */}
            <div className="text-right">
              <div className="flex items-center gap-1">
                <span className={`${isLocalPost ? 'text-[10px] font-semibold break-all' : 'text-sm font-bold'} ${
                  isDarkMode ? 'text-white' : 'text-natural-text'
                }`}>{displayName}</span>
              </div>
              
              {isLocalPost ? (
                <div className="flex flex-col gap-0.5 mt-0.5 mb-1">
                  <div className={`text-[10px] font-medium px-1.5 py-0.5 rounded leading-none border w-fit ${
                    isDarkMode 
                      ? 'text-[#16af75] bg-[#1A212E] border-[#2C374E]' 
                      : 'text-[#ca3500] bg-natural-secondary-bg border border-natural-border/30'
                  }`}>
                    المسؤول: {personName}
                  </div>
                  {post.isPinned && (
                    <span className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded leading-none border w-fit ${
                      isDarkMode 
                        ? 'text-[#ca3500] bg-[#1A212E] border-[#2C374E]' 
                        : 'text-[#ca3500] bg-red-50 border border-red-100/40'
                    }`}>
                      <Pin size={10} className={`shrink-0 select-none ${isDarkMode ? 'fill-[#EEA396] text-[#EEA396]' : 'fill-red-500 text-red-600'}`} />
                    </span>
                  )}
                </div>
              ) : (
                /* المسؤول ورمز التثبيت تحت الاسم لمنع التداخل */
                (isPostFromAdmin || post.isPinned) && (
                  <div className="flex items-center gap-1.5 mt-0.5 mb-1">
                    {isPostFromAdmin && (
                      <span className={`text-[10px] font-normal px-1.5 py-0.5 rounded leading-none border ${
                        isDarkMode 
                          ? 'text-[#ca3500] bg-[#F9F3DC] border-transparent font-normal' 
                          : 'text-[#ca3500] bg-red-50 border border-red-100/40'
                      }`}>
                        المسؤول
                      </span>
                    )}
                    {post.isPinned && (
                      <span className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded leading-none border ${
                        isDarkMode 
                          ? 'text-[#EEA396] bg-[#1A212E] border-[#2C374E]' 
                          : 'text-red-600 bg-red-50 border border-red-100/40'
                      }`}>
                        <Pin size={10} className={`shrink-0 select-none ${isDarkMode ? 'fill-[#EEA396] text-[#EEA396]' : 'fill-red-500 text-red-600'}`} />
                      </span>
                    )}
                  </div>
                )
              )}

              <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wide mt-0.5 flex-wrap ${
                isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'
              }`}>
                <span>
                  {(() => {
                    if (isLocalPost && post.createdAtMillis) {
                      const dateObj = new Date(post.createdAtMillis);
                      const now = new Date();
                      const diffTime = Math.abs(now.getTime() - dateObj.getTime());
                      const diffDays = diffTime / (1000 * 60 * 60 * 24);
                      
                      if (diffDays > 3) {
                        const day = String(dateObj.getDate()).padStart(2, '0');
                        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                        const year = dateObj.getFullYear();
                        return `${day}/${month}/${year}`;
                      }
                      
                      return formatDistanceToNow(dateObj, { addSuffix: true, locale: ar });
                    }

                    if (!post.createdAt) return 'الآن';
                    let dateObj: Date;
                    if (typeof post.createdAt.toDate === 'function') {
                      dateObj = post.createdAt.toDate();
                    } else if (post.createdAt.seconds !== undefined) {
                      dateObj = new Date(post.createdAt.seconds * 1000 + (post.createdAt.nanoseconds || 0) / 1000000);
                    } else {
                      dateObj = new Date(post.createdAt as any);
                    }
                    const now = new Date();
                    const diffTime = Math.abs(now.getTime() - dateObj.getTime());
                    const diffDays = diffTime / (1000 * 60 * 60 * 24);
                    
                    if (diffDays > 3) {
                      const day = String(dateObj.getDate()).padStart(2, '0');
                      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                      const year = dateObj.getFullYear();
                      return `${day}/${month}/${year}`;
                    }
                    
                    return formatDistanceToNow(dateObj, { addSuffix: true, locale: ar });
                  })()}
                </span>
                <span>•</span>
                {isLocalPost ? (
                  <span>لوحة شخصية</span>
                ) : postSubBoard ? (
                  <span className="inline-flex items-center gap-1">
                    <span>{postBoard?.name || 'غير معروف'}</span>
                    <span className="opacity-60 text-[10px]">›</span>
                    <span className={`text-[14px] font-bold ${
                      isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'
                    }`}>
                      {postSubBoard.name}
                    </span>
                  </span>
                ) : (
                  <span>{postBoard?.name || 'الرئيسية'}</span>
                )}
              </div>
            </div>
          </div>

          {hasManagePermissions && (
            <div className="absolute top-2.5 left-2.5 flex gap-0.5 z-10">
              {showDeleteConfirm ? (
                <div className="flex items-center gap-1 bg-red-50 rounded-lg px-2 py-1.5 animate-in fade-in slide-in-from-right-4 border border-red-200/40 shadow-xs">
                  <span className="text-[9px] font-bold text-red-600 ml-1">حذف؟</span>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="p-1.5 hover:bg-red-100 rounded text-red-600 transition-colors disabled:opacity-50"
                  >
                    {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="p-1.5 hover:bg-zinc-200 rounded text-natural-muted transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={handleTogglePin}
                    disabled={isPinning}
                    className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                      post.isPinned 
                        ? 'bg-red-50 hover:bg-red-100 text-red-600 shadow-xs' 
                        : 'hover:bg-natural-secondary-bg hover:text-natural-text text-[#B4C6D8]'
                    }`}
                    title={post.isPinned ? "إلغاء التثبيت" : "تثبيت المنشور في الأعلى"}
                  >
                    {isPinning ? (
                      <Loader2 size={14} className="animate-spin text-red-500" />
                    ) : (
                      <Pin size={14} className={post.isPinned ? 'fill-red-500 text-red-600' : ''} />
                    )}
                  </button>
                  <button 
                    onClick={handleStartEditing} 
                    className="p-1.5 hover:bg-natural-secondary-bg hover:text-natural-text rounded-lg text-[#B4C6D8] transition-all cursor-pointer"
                    title="تعديل المنشور"
                  >
                    <Edit3 size={14} />
                  </button>
                  <button 
                    onClick={() => setShowDeleteConfirm(true)} 
                    className="p-1.5 hover:bg-red-50 hover:text-red-600 rounded-lg text-red-400/80 transition-all cursor-pointer"
                    title="حذف المنشور"
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Post Content */}
        <div className="relative px-3 pb-3 pt-1 sm:px-5 sm:pb-5 sm:pt-1 text-right" dir="rtl">
          {isEditing ? (
            <div className="space-y-4">
              <div className="relative group/editarea">
                <textarea
                  ref={editTextareaRef}
                  value={editedText}
                  onChange={(e) => processEditedTextForImageUrls(e.target.value)}
                  className={`w-full resize-y min-h-[100px] max-h-[750px] rounded-xl border p-3.5 pb-6 focus:ring-1 focus:outline-none transition-all ${
                    isDarkMode
                      ? 'border-[#6980b0] bg-[#111822] focus:ring-[#008D75]'
                      : 'border-natural-border bg-natural-bg focus:ring-natural-primary'
                  }`}
                  rows={4}
                  autoFocus
                  dir={isRtl(editedText) ? 'rtl' : 'ltr'}
                  style={{ 
                    textAlign: isRtl(editedText) ? 'right' : 'left',
                    fontSize: `${fontSize}px`,
                    color: isDarkMode ? '#e4edf7' : '#4A4A35',
                    height: editTextareaHeight ? `${editTextareaHeight}px` : undefined
                  }}
                />
                
                {/* Touch & Mouse Bottom Drag Bar to Resize Height with Finger/Mouse */}
                <div 
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleResizeStart(e.clientY);
                  }}
                  onTouchStart={(e) => {
                    if (e.touches && e.touches.length > 0) {
                      handleResizeStart(e.touches[0].clientY);
                    }
                  }}
                  className={`w-full h-5 -mt-2.5 flex items-center justify-center cursor-row-resize select-none touch-none rounded-b-xl border-x border-b transition-colors ${
                    isDarkMode 
                      ? 'bg-[#182335]/90 hover:bg-[#223147] border-[#6980b0]/50 text-[#8EA2BF]' 
                      : 'bg-natural-secondary-bg hover:bg-[#EAECE4] border-natural-border text-natural-muted'
                  }`}
                  title="اسحب للأعلى أو الأسفل لتغيير ارتفاع مربع النص"
                >
                  <div className="flex items-center gap-1 opacity-70 group-hover/editarea:opacity-100 transition-opacity">
                    <div className="w-10 h-1 rounded-full bg-current opacity-40"></div>
                  </div>
                </div>
              </div>
              
              {/* Existing & New Images Preview in Edit Mode */}
              <div className="flex flex-col gap-2">
                {/* Top Quick Actions Bar for Long Post with Images */}
                {(editedImageUrls.length > 2 || newPreviews.length > 0) && (
                  <div className={`flex items-center justify-between px-3 py-1.5 rounded-xl border text-[11px] font-bold ${
                    isDarkMode ? 'bg-[#1A212E] border-[#2C374E]' : 'bg-natural-bg/60 border-natural-border/60'
                  }`} dir="rtl">
                    <span className={`text-[10px] font-black ${isDarkMode ? 'text-[#B4C6D8]' : 'text-neutral-600'}`}>
                      🖼️ المرفقات ({editedImageUrls.length + newPreviews.length})
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={isSaving}
                        className="flex items-center gap-1 rounded-lg border border-natural-border px-2.5 py-1 text-[11px] font-bold text-natural-muted hover:bg-natural-bg transition-colors cursor-pointer"
                      >
                        <X size={12} /> إلغاء
                      </button>
                      <button
                        type="button"
                        onClick={newImages.some(img => typeof img !== 'string') && !getAccessToken() ? handleAuthorize : handleUpdate}
                        disabled={isSaving}
                        className="flex items-center gap-1 rounded-lg bg-natural-primary hover:bg-[#4A4A35] px-3 py-1 text-[11px] font-bold text-white transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
                      >
                        {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        <span>{isSaving ? 'جاري الحفظ...' : 'حفظ التعديلات'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Reorder Guidance Banner */}
                {(editedImageUrls.length > 1 || newPreviews.length > 1) && (
                  <div className={`flex items-center justify-between px-3 py-2 rounded-xl border text-[11px] font-bold transition-all ${
                    isDarkMode ? 'bg-amber-955/30 border-amber-800/50 text-amber-300' : 'bg-amber-50/90 border-amber-200 text-amber-900'
                  }`} dir="rtl">
                    <div className="flex items-center gap-2">
                      <GripHorizontal size={13} className="text-amber-500 shrink-0" />
                      <span>
                        {swapSourceIndex !== null 
                          ? `🔄 انقر على أي صورة أخرى للتبديل مع المرفق #${swapSourceIndex + 1}` 
                          : 'انقر لتحديد صورة لنقلها الى منشور آخر،أو اسحب الصورة وأفلتها لتبديل مكانها'}
                      </span>
                    </div>
                    {swapSourceIndex !== null && (
                      <button
                        type="button"
                        onClick={() => setSwapSourceIndex(null)}
                        className="px-2 py-0.5 rounded-md bg-amber-200/80 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200 text-[10px] hover:bg-amber-300 transition-colors cursor-pointer"
                      >
                        إلغاء
                      </button>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2">
                  {editedImageUrls.map((url, i) => {
                    const isFile = !isUrlAnImage(url, i);
                    const fName = editedFileNames[i] || 'ملف';
                    const isApk = fName.toLowerCase().endsWith('.apk') || (editedFileTypes[i] || '').includes('vnd.android.package-archive');
                    const isSelected = selectedImageIndices.includes(i);
                    const isDragged = draggedImageIndex === i;
                    const isDragOver = dragOverImageIndex === i && draggedImageIndex !== i;
                    const isSwapSelected = swapSourceIndex === i;
                    const isSwapTarget = swapSourceIndex !== null && swapSourceIndex !== i;

                    return (
                      <div 
                        key={`existing-${i}`} 
                        draggable={true}
                        onDragStart={(e) => {
                          setDraggedImageIndex(i);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', i.toString());
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOverImageIndex !== i) {
                            setDragOverImageIndex(i);
                          }
                        }}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          setDragOverImageIndex(i);
                        }}
                        onDragLeave={(e) => {
                          // Only reset if exiting outer box
                          if (e.currentTarget === e.target) {
                            setDragOverImageIndex(null);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const rawIdx = e.dataTransfer.getData('text/plain');
                          const fromIdx = draggedImageIndex !== null ? draggedImageIndex : parseInt(rawIdx, 10);
                          if (!isNaN(fromIdx) && fromIdx !== i) {
                            moveExistingImage(fromIdx, i);
                            showToast(`تم تبديل موضع المرفق إلى الترتيب #${i + 1} ✨`);
                          }
                          setDraggedImageIndex(null);
                          setDragOverImageIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedImageIndex(null);
                          setDragOverImageIndex(null);
                        }}
                        onClick={() => {
                          if (swapSourceIndex !== null && swapSourceIndex !== i) {
                            swapExistingImages(swapSourceIndex, i);
                            showToast(`تم التبديل بين #${swapSourceIndex + 1} و #${i + 1} بنجاح ✨`);
                          }
                        }}
                        className={`group relative aspect-square overflow-hidden rounded-xl border flex items-center justify-center text-center p-1.5 transition-all select-none cursor-grab active:cursor-grabbing ${
                          isDragged 
                            ? 'opacity-30 scale-95 ring-2 ring-amber-400 border-amber-400' 
                            : ''
                        } ${
                          isDragOver 
                            ? 'ring-3 ring-emerald-500 border-emerald-500 scale-105 bg-emerald-50/40 shadow-lg z-20' 
                            : ''
                        } ${
                          isSwapSelected 
                            ? 'ring-3 ring-amber-500 border-amber-500 bg-amber-50/50 animate-pulse z-10' 
                            : (isSwapTarget 
                                ? 'hover:ring-2 hover:ring-emerald-400 hover:border-emerald-400 cursor-pointer' 
                                : '')
                        } ${
                          isSelected 
                            ? 'border-blue-500 ring-2 ring-blue-500/50 bg-blue-50/20' 
                            : (isDarkMode ? 'border-[#2C374E] bg-[#1A212E]' : 'border-natural-border bg-zinc-50')
                        }`}
                      >
                        {isFile ? (
                          <div className="flex flex-col items-center justify-center text-center w-full min-w-0 pointer-events-none">
                            <span className="text-xl">{isApk ? '🤖' : '📄'}</span>
                            <span className="text-[8px] font-black mt-1 leading-tight text-center break-all text-neutral-600 line-clamp-2 w-full px-1">
                              {fName}
                            </span>
                          </div>
                        ) : (
                          <img 
                            src={url} 
                            alt="" 
                            className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity pointer-events-none" 
                            referrerPolicy="no-referrer"
                          />
                        )}
                        
                        {/* Delete button (Top Right) */}
                        <button 
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeExistingImage(i);
                          }}
                          title="حذف المرفق"
                          className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white shadow-sm hover:scale-110 cursor-pointer z-10"
                        >
                          <X size={10} />
                        </button>

                        {/* Selection Checkbox (Top Left) */}
                        <button 
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectImage(i);
                          }}
                          title={isSelected ? 'إلغاء تحديد الصورة' : 'تحديد الصورة للنقل'}
                          className={`absolute top-1 left-1 flex h-5 w-5 items-center justify-center rounded-md border text-white shadow-md transition-all cursor-pointer z-10 ${
                            isSelected 
                              ? 'bg-blue-600 border-blue-400 scale-105' 
                              : 'bg-black/50 border-white/60 hover:bg-black/70'
                          }`}
                        >
                          {isSelected ? <Check size={12} className="stroke-[3]" /> : <div className="h-2 w-2 rounded-sm border border-white/80" />}
                        </button>

                        {/* Swap Button (Center / Top Center) */}
                        {editedImageUrls.length > 1 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (swapSourceIndex === null) {
                                setSwapSourceIndex(i);
                                showToast(`المرفق #${i + 1} محدد: انقر على أي صورة أخرى للتبديل معها`);
                              } else if (swapSourceIndex === i) {
                                setSwapSourceIndex(null);
                              } else {
                                swapExistingImages(swapSourceIndex, i);
                                showToast(`تم التبديل بين #${swapSourceIndex + 1} و #${i + 1} بنجاح ✨`);
                              }
                            }}
                            title={swapSourceIndex === i ? 'إلغاء وضع التبديل' : (swapSourceIndex !== null ? `تبديل مع #${swapSourceIndex + 1}` : 'انقر للتبديل مع صورة أخرى')}
                            className={`absolute top-1 left-7 flex h-5 items-center gap-1 px-1.5 rounded-md text-[8px] font-black shadow-md transition-all cursor-pointer z-10 ${
                              isSwapSelected
                                ? 'bg-amber-500 text-white ring-2 ring-white scale-105'
                                : (isSwapTarget
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white animate-bounce'
                                    : 'bg-black/60 hover:bg-black/85 text-white')
                            }`}
                          >
                            <ArrowLeftRight size={9} />
                            <span className="hidden sm:inline">{isSwapSelected ? 'إلغاء' : (isSwapTarget ? 'بدّل هنا' : 'تبديل')}</span>
                          </button>
                        )}

                        {/* Quick Step Buttons (Bottom Left: Prev / Next) */}
                        {editedImageUrls.length > 1 && (
                          <div className="absolute bottom-1 left-1 flex items-center gap-0.5 z-10" onClick={(e) => e.stopPropagation()}>
                            {i > 0 && (
                              <button
                                type="button"
                                onClick={() => moveExistingStep(i, -1)}
                                title="تقديم الموضع خطوة للأمام"
                                className="flex h-4.5 w-4.5 items-center justify-center rounded bg-black/70 hover:bg-blue-600 text-white transition-all shadow-xs cursor-pointer"
                              >
                                <ChevronRight size={11} />
                              </button>
                            )}
                            {i < editedImageUrls.length - 1 && (
                              <button
                                type="button"
                                onClick={() => moveExistingStep(i, 1)}
                                title="تأخير الموضع خطوة للخلف"
                                className="flex h-4.5 w-4.5 items-center justify-center rounded bg-black/70 hover:bg-blue-600 text-white transition-all shadow-xs cursor-pointer"
                              >
                                <ChevronLeft size={11} />
                              </button>
                            )}
                          </div>
                        )}

                        {/* Position Badge (Bottom Right) */}
                        <div className="absolute bottom-1 right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-md bg-black/75 px-1.5 text-[9px] font-black text-white shadow-sm pointer-events-none z-10">
                          #{i + 1}
                        </div>

                        {/* Drag Over Hint Overlay */}
                        {isDragOver && (
                          <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center pointer-events-none z-20">
                            <span className="bg-emerald-600 text-white font-black text-[9px] px-2 py-1 rounded-md shadow-md">
                              أفلت للتبديل هنا
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {newPreviews.map((prev, i) => {
                    const isFile = prev.startsWith('file:');
                    const parts = isFile ? prev.split(':') : [];
                    const fName = isFile ? parts[1] : (newFileNames[i] || 'ملف جديد');
                    const fType = isFile ? parts[2] : (newFileTypes[i] || '');
                    const fUrl = isFile ? parts.slice(4).join(':') : prev;
                    const isImage = isFile ? (fType.startsWith('image/') || /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(fName)) : true;
                    const isApk = fName.toLowerCase().endsWith('.apk') || fType.includes('vnd.android.package-archive');
                    const isDragged = draggedNewIndex === i;
                    const isDragOver = dragOverNewIndex === i && draggedNewIndex !== i;

                    return (
                      <div 
                        key={`new-${i}`} 
                        draggable={true}
                        onDragStart={(e) => {
                          setDraggedNewIndex(i);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (dragOverNewIndex !== i) setDragOverNewIndex(i);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedNewIndex !== null && draggedNewIndex !== i) {
                            moveNewImage(draggedNewIndex, i);
                            showToast(`تم تغيير موضع المرفق الجديد إلى #${i + 1} ✨`);
                          }
                          setDraggedNewIndex(null);
                          setDragOverNewIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedNewIndex(null);
                          setDragOverNewIndex(null);
                        }}
                        onClick={() => {
                          if (isImage) {
                            setEditPreviewImageUrl(fUrl);
                          }
                        }}
                        className={`group relative aspect-square overflow-hidden rounded-xl border border-green-200 bg-green-50 flex items-center justify-center text-center p-1.5 select-none cursor-grab active:cursor-grabbing transition-all ${
                          isDragged ? 'opacity-30 scale-95 ring-2 ring-emerald-400' : ''
                        } ${
                          isDragOver ? 'ring-3 ring-emerald-500 scale-105 shadow-md z-20' : ''
                        }`}
                      >
                        {isImage ? (
                          <img 
                            src={fUrl} 
                            alt="" 
                            className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditPreviewImageUrl(fUrl);
                            }}
                            title="انقر لمشاهدة الصورة بالحجم الكامل"
                          />
                        ) : (
                          <div className="flex flex-col items-center justify-center text-center w-full min-w-0 pointer-events-none">
                            <span className="text-xl">{isApk ? '🤖' : '📄'}</span>
                            <span className="text-[8px] font-black mt-1 leading-tight text-center break-all text-green-800 line-clamp-2 w-full px-1">
                              {fName}
                            </span>
                          </div>
                        )}
                        
                        <button 
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeNewImage(i);
                          }}
                          className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white shadow-sm hover:scale-110 cursor-pointer z-10"
                        >
                          <X size={10} />
                        </button>

                        {/* Quick Step Buttons for New Images */}
                        {newPreviews.length > 1 && (
                          <div className="absolute bottom-1 left-1 flex items-center gap-0.5 z-10" onClick={(e) => e.stopPropagation()}>
                            {i > 0 && (
                              <button
                                type="button"
                                onClick={() => moveNewStep(i, -1)}
                                title="تقديم الموضع"
                                className="flex h-4.5 w-4.5 items-center justify-center rounded bg-black/70 hover:bg-emerald-600 text-white transition-all shadow-xs cursor-pointer"
                              >
                                <ChevronRight size={11} />
                              </button>
                            )}
                            {i < newPreviews.length - 1 && (
                              <button
                                type="button"
                                onClick={() => moveNewStep(i, 1)}
                                title="تأخير الموضع"
                                className="flex h-4.5 w-4.5 items-center justify-center rounded bg-black/70 hover:bg-emerald-600 text-white transition-all shadow-xs cursor-pointer"
                              >
                                <ChevronLeft size={11} />
                              </button>
                            )}
                          </div>
                        )}

                        <div className="absolute top-1 left-1 bg-green-600 text-white text-[7px] px-1.5 py-0.5 rounded font-bold pointer-events-none">جديد #{i + 1}</div>
                      </div>
                    );
                  })}
                  <button 
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-square items-center justify-center rounded-xl border-2 border-dashed border-natural-border text-natural-muted hover:bg-natural-bg hover:text-natural-primary hover:border-blue-500 hover:text-blue-500 transition-all cursor-pointer"
                    title="إضافة صور أو مرفقات جديدة"
                  >
                    <Plus size={24} />
                  </button>
                </div>
              </div>

              {/* Selected Images Action Bar for Moving to another Post */}
              {selectedImageIndices.length > 0 && (
                <div className={`flex items-center justify-between p-2.5 rounded-xl border text-xs font-bold transition-all ${
                  isDarkMode ? 'bg-blue-950/50 border-blue-800/80 text-blue-200' : 'bg-blue-50 border-blue-200 text-blue-900'
                }`} dir="rtl">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white text-[11px] font-black">
                      {selectedImageIndices.length}
                    </span>
                    <span>تم تحديد {selectedImageIndices.length} {selectedImageIndices.length === 1 ? 'مرفق' : 'مرفقات'} للنقل</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedImageIndices([])}
                      className="px-2 py-1 rounded-lg text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/60 dark:hover:bg-neutral-800 transition-all text-[11px] cursor-pointer"
                    >
                      إلغاء التحديد
                    </button>
                    <button
                      type="button"
                      onClick={openMoveImagesModal}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition-all font-bold text-xs cursor-pointer"
                    >
                      <FolderOutput size={14} />
                      <span>نقل إلى منشور آخر</span>
                    </button>
                  </div>
                </div>
              )}
              
              <input 
                type="file" 
                hidden 
                multiple 
                accept="*" 
                ref={fileInputRef} 
                onChange={handleImageAdd} 
              />

              {/* اختيار موديلات الصور عند التعديل */}
              {(editedImageUrls.length > 0 || newPreviews.length > 0) && (
                <div className={`mt-4 border rounded-xl p-3 flex flex-col gap-3 text-right ${
                  isDarkMode 
                    ? 'border-[#2C374E] bg-[#111822]/60' 
                    : 'border-natural-border/30 bg-natural-bg/35'
                }`} dir="rtl">
                  <span className={`text-xs font-black flex items-center gap-1.5 ${
                    isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'
                  }`}>
                    ✨ ملاحظات وموديلات المرفقات المضافة:
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {/* Pictures currently in the post */}
                    {editedImageUrls.map((url, index) => {
                      const isFile = !isUrlAnImage(url, index);
                      const fName = editedFileNames[index] || 'ملف';
                      const isApk = fName.toLowerCase().endsWith('.apk') || (editedFileTypes[index] || '').includes('vnd.android.package-archive');
                      const models = ['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7', 'تغشية'];
                      
                      return (
                        <div key={`edit-model-exist-${index}`} className={`flex flex-col gap-1.5 p-2 rounded-lg border ${
                          isDarkMode ? 'border-[#2C374E] bg-[#1A212E]' : 'border-natural-border/40 bg-zinc-50'
                        }`}>
                          <div 
                            onClick={() => {
                              if (!isFile) {
                                setEditPreviewImageUrl(url);
                              }
                            }}
                            className={`relative aspect-video overflow-hidden rounded-md border flex items-center justify-center text-center p-1.5 ${
                              !isFile ? 'cursor-pointer hover:opacity-90 transition-opacity' : ''
                            } ${
                              isDarkMode ? 'border-[#2C374E]/40 bg-[#111822]' : 'border-natural-border/20 bg-natural-bg'
                            }`}
                            title={!isFile ? "انقر لمشاهدة الصورة بالحجم الكامل" : undefined}
                          >
                            {isFile ? (
                              <div className="flex flex-col items-center justify-center text-center w-full min-w-0">
                                <span className="text-xl">{isApk ? '🤖' : '📄'}</span>
                                <span className={`text-[9px] font-black mt-1 leading-tight text-center break-all line-clamp-2 w-full px-1 ${
                                  isDarkMode ? 'text-[#B4C6D8]' : 'text-neutral-600'
                                }`}>
                                  {fName}
                                </span>
                              </div>
                            ) : (
                              <img 
                                src={url} 
                                alt="" 
                                className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" 
                                referrerPolicy="no-referrer" 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditPreviewImageUrl(url);
                                }}
                                title="انقر لمشاهدة الصورة بالحجم الكامل"
                              />
                            )}
                          </div>
                          
                          {/* Caption Edit Field */}
                          <div className="flex flex-col gap-1 text-right">
                            <span className={`text-[9px] font-bold ${
                              isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'
                            }`}>
                              ملاحظة حول {isFile ? 'الملف' : 'الصورة'}:
                            </span>
                            <input
                              type="text"
                              placeholder={isFile ? 'اكتب ملاحظة حول هذا الملف...' : 'اكتب عبارة تعريفية لهذه الصورة'}
                              value={editedImageCaptions[index] || ''}
                              onChange={(e) => {
                                const updated = [...editedImageCaptions];
                                updated[index] = e.target.value;
                                setEditedImageCaptions(updated);
                              }}
                              className={`w-full text-[10px] font-medium border rounded-md px-2 py-1 focus:outline-none focus:ring-1 ${
                                isDarkMode 
                                  ? 'border-[#2C374E] bg-[#111822] text-[#e4edf7] focus:ring-[#16af75]' 
                                  : 'border-natural-border/60 bg-white text-natural-text focus:ring-natural-primary'
                              }`}
                            />
                          </div>

                          {!isFile && (
                            <div className="flex flex-col gap-1 text-right">
                              {(() => {
                                const val = editedImageModels[index] || '';
                                const isObscured = val.includes('تغشية');
                                const modelName = val.split('|').filter(p => p && p !== 'تغشية')[0] || '';
                                
                                return (
                                  <>
                                    <span className={`text-[9px] font-bold ${
                                      isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'
                                    }`}>إعدادات الصورة:</span>
                                    {/* Obscure Button Toggle */}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const nextObscured = !isObscured;
                                        const updated = [...editedImageModels];
                                        updated[index] = nextObscured ? (modelName ? `${modelName}|تغشية` : 'تغشية') : modelName;
                                        setEditedImageModels(updated);
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
                                    
                                    <span className={`text-[8px] font-bold ${
                                      isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'
                                    }`}>اسم الموديل:</span>
                                    
                                    <div className="grid grid-cols-2 gap-1 w-full">
                                      {['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7'].map((m) => {
                                        const isMSelected = modelName === m;
                                        return (
                                          <button
                                            key={m}
                                            type="button"
                                            onClick={() => {
                                              const nextModel = isMSelected ? '' : m;
                                              const updated = [...editedImageModels];
                                              updated[index] = isObscured ? (nextModel ? `${nextModel}|تغشية` : 'تغشية') : nextModel;
                                              setEditedImageModels(updated);
                                            }}
                                            className={`px-1.5 py-1 rounded text-[8px] font-black cursor-pointer transition-all border text-center truncate whitespace-nowrap overflow-hidden ${
                                              isMSelected
                                                ? isDarkMode
                                                  ? 'bg-[#16af75] text-white border-transparent shadow-xs'
                                                  : 'bg-[#4A4A35] text-white border-transparent shadow-xs'
                                                : isDarkMode
                                                  ? 'bg-[#1a212e] text-gray-300 border-[#2C374E] hover:bg-[#212B3B]'
                                                  : 'bg-white text-natural-muted border-natural-border/60 hover:bg-natural-bg/80'
                                            }`}
                                            title={m}
                                          >
                                            {m}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}

                     {/* Newly added images */}
                     {newPreviews.map((prev, index) => {
                       const isFile = prev.startsWith('file:');
                       const parts = isFile ? prev.split(':') : [];
                       const fName = isFile ? parts[1] : (newFileNames[index] || 'ملف جديد');
                       const fType = isFile ? parts[2] : (newFileTypes[index] || '');
                       const fSize = isFile ? parts[3] : (newFileSizes[index] || '');
                       const fUrl = isFile ? parts.slice(4).join(':') : prev;
                       const isImage = isFile ? (fType.startsWith('image/') || /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(fName)) : true;
                       const isApk = fName.toLowerCase().endsWith('.apk') || fType.includes('vnd.android.package-archive');
                       const isAudio = isFile && (fType.startsWith('audio/') || /\.(mp3|wma|wav|aac|m4a|ogg|flac|amr)$/i.test(fName));
                       const isVideo = isFile && (fType.startsWith('video/') || /\.(mp4|mkv|avi|mov|webm|3gp|wmv|flv|ogv)$/i.test(fName));
                       const models = ['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7', 'تغشية'];
                       
                       return (
                         <div key={`edit-model-new-${index}`} className={`flex flex-col gap-1.5 p-2 rounded-lg border ${
                           isDarkMode ? 'border-emerald-900/50 bg-emerald-950/10' : 'border-green-200 bg-green-50/20'
                         }`}>
                           <div className={`relative ${isAudio ? '' : 'aspect-video'} overflow-hidden rounded-md border flex items-center justify-center text-center p-1.5 w-full ${
                             isDarkMode ? 'border-emerald-900/40 bg-[#111822]' : 'border-green-200/55 bg-white'
                           }`}>
                             {isFile ? (
                               isImage ? (
                                 <img 
                                   src={fUrl} 
                                   alt="" 
                                   className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" 
                                   onClick={() => setEditPreviewImageUrl(fUrl)}
                                   title="انقر لمشاهدة الصورة بالحجم الكامل"
                                 />
                               ) : isAudio ? (
                                 <div className="w-full p-1.5" onClick={(e) => e.stopPropagation()}>
                                   <AudioPlayer src={fUrl} name={fName} size={fSize} isDarkMode={isDarkMode} />
                                 </div>
                               ) : isVideo ? (
                                 <div className="w-full p-1.5" onClick={(e) => e.stopPropagation()}>
                                   <VideoPlayer src={fUrl} name={fName} size={fSize} isDarkMode={isDarkMode} />
                                 </div>
                               ) : (
                                 <div className="flex flex-col items-center justify-center text-center w-full min-w-0">
                                   <span className="text-xl">{isApk ? '🤖' : '📄'}</span>
                                   <span className={`text-[9px] font-black mt-1 leading-tight text-center break-all line-clamp-2 w-full px-1 ${
                                     isDarkMode ? 'text-emerald-400' : 'text-green-800'
                                   }`}>
                                     {fName}
                                   </span>
                                 </div>
                                )
                             ) : (
                               <img 
                                 src={prev} 
                                 alt="" 
                                 className="h-full w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" 
                                 onClick={() => setEditPreviewImageUrl(prev)}
                                 title="انقر لمشاهدة الصورة بالحجم الكامل"
                               />
                             )}
                             <div className="absolute bottom-1 left-1 bg-green-600 text-[8px] text-white px-1 rounded font-black z-10">جديدة</div>
                           </div>

                          {/* New Image Caption Edit Field */}
                          <div className="flex flex-col gap-1 text-right">
                            <span className={`text-[9px] font-bold ${
                              isDarkMode ? 'text-emerald-400' : 'text-green-700'
                            }`}>
                              ملاحظة حول {(!isFile || isImage) ? 'الصورة الجديدة' : 'الملف الجديد'}:
                            </span>
                            <input
                              type="text"
                              placeholder={(!isFile || isImage) ? 'اكتب عبارة تعريفية لهذه الصورة الجديدة' : 'اكتب ملاحظة حول هذا الملف الجديد...'}
                              value={newImageCaptions[index] || ''}
                              onChange={(e) => {
                                const updated = [...newImageCaptions];
                                updated[index] = e.target.value;
                                setNewImageCaptions(updated);
                              }}
                              className={`w-full text-[10px] font-medium border rounded-md px-2 py-1 focus:outline-none focus:ring-1 ${
                                isDarkMode 
                                  ? 'border-emerald-900/50 bg-[#111822] text-[#e4edf7] focus:ring-emerald-500' 
                                  : 'border-green-200 bg-white text-natural-text focus:ring-green-700'
                              }`}
                            />
                          </div>

                          {isImage && (
                            <div className="flex flex-col gap-1 text-right">
                              {(() => {
                                const val = newImageModels[index] || '';
                                const isObscured = val.includes('تغشية');
                                const modelName = val.split('|').filter(p => p && p !== 'تغشية')[0] || '';
                                
                                return (
                                  <>
                                    <span className={`text-[9px] font-bold ${
                                      isDarkMode ? 'text-emerald-400' : 'text-green-700'
                                    }`}>إعدادات الصورة الجديدة:</span>
                                    {/* Obscure Button Toggle */}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const nextObscured = !isObscured;
                                        const updated = [...newImageModels];
                                        updated[index] = nextObscured ? (modelName ? `${modelName}|تغشية` : 'تغشية') : modelName;
                                        setNewImageModels(updated);
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
                                    
                                    <span className={`text-[9px] font-bold ${
                                      isDarkMode ? 'text-emerald-400' : 'text-green-700'
                                    }`}>اسم الموديل للصورة الجديدة:</span>
                                    
                                    <div className="grid grid-cols-2 gap-1 w-full">
                                      {['gpt-2', 'grok', 'banana-2', 'flux', 'wan 2.7'].map((m) => {
                                        const isMSelected = modelName === m;
                                        return (
                                          <button
                                            key={m}
                                            type="button"
                                            onClick={() => {
                                              const nextModel = isMSelected ? '' : m;
                                              const updated = [...newImageModels];
                                              updated[index] = isObscured ? (nextModel ? `${nextModel}|تغشية` : 'تغشية') : nextModel;
                                              setNewImageModels(updated);
                                            }}
                                            className={`px-1.5 py-1 rounded text-[8px] font-black cursor-pointer transition-all border text-center truncate whitespace-nowrap overflow-hidden ${
                                              isMSelected
                                                ? isDarkMode
                                                  ? 'bg-[#16af75] text-white border-transparent shadow-xs'
                                                  : 'bg-green-700 text-white border-transparent shadow-xs'
                                                : isDarkMode
                                                  ? 'bg-[#111822] text-gray-300 border-emerald-950 hover:bg-emerald-900/20'
                                                  : 'bg-white text-[#4A4A35] border-green-200 hover:bg-green-100/50'
                                            }`}
                                            title={m}
                                          >
                                            {m}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* خيار نقل المنشور لسبورة أخرى */}
              <div 
                className={`flex flex-col gap-2 rounded-xl border px-1 py-2.5 text-right ${
                  isDarkMode 
                    ? 'border-[#2C374E] bg-[#111822]/60' 
                    : 'border-[#8C8F7A] bg-natural-bg/50'
                }`} 
                dir="rtl"
              >
                <span className={`text-xs font-black flex items-center gap-1.5 ${isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'}`}>
                  📁 نقل المنشور إلى لوحة أخرى:
                </span>
                
                {/* Split Board Selection Button */}
                <div className="flex gap-1.5 w-full" dir="rtl">
                  {/* Main Board Button */}
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new Event('lock_posts_layout'));
                      setIsTransferDrawerOpen(true);
                    }}
                    className={`flex-1 min-w-0 rounded-lg border px-1.5 h-10 text-xs sm:text-sm font-bold focus:outline-none cursor-pointer transition-all shadow-md flex items-center justify-between gap-1 ${
                      isDarkMode 
                        ? 'border-[#2C374E] bg-[#111822] text-[#16af75] hover:bg-[#1a212e]' 
                        : 'border-[#8C8F7A] bg-[#fffaf5] text-[#c26700] hover:bg-[#fef3e6] hover:border-[#c26700]/40'
                    }`}
                  >
                    <span className="flex items-center gap-1 truncate">
                      <span>📁</span>
                      <span className="truncate">{getEditedBoardName()}</span>
                    </span>
                    <ChevronDown size={14} className="shrink-0" />
                  </button>

                  {/* Sub-board selector if current edited board has sub-boards */}
                  {(() => {
                    const currentEditedBoard = boards?.find(b => b.id === editedBoardId);
                    if (!currentEditedBoard?.subBoards || currentEditedBoard.subBoards.length === 0) return null;

                    return (
                      <div className="relative flex-1 min-w-0">
                        <select
                          value={editedSubBoardId || ''}
                          onChange={(e) => setEditedSubBoardId(e.target.value || null)}
                          className={`w-full appearance-none rounded-lg border px-1 pr-1 h-10 text-xs sm:text-sm font-bold focus:outline-none cursor-pointer transition-all shadow-md truncate ${
                            isDarkMode 
                              ? 'border-[#2C374E] bg-[#111822] text-[#16af75] hover:bg-[#1a212e]' 
                              : 'border-[#8C8F7A] bg-[#fffaf5] text-[#c26700] hover:bg-[#fef3e6] hover:border-[#c26700]/40'
                          }`}
                        >
                          <option value="">📂 لوحة فرعية: الكل</option>
                          {currentEditedBoard.subBoards.map((sub) => (
                            <option key={sub.id} value={sub.id}>
                              📂 {sub.name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={14} className={`absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`} />
                      </div>
                    );
                  })()}
                </div>
              </div>
              
              {/* Real-time upload progress bar */}
              {isSaving && newImages.some(img => typeof img !== 'string') && (
                <div className="w-full mt-2" dir="rtl">
                  <div className="flex justify-between items-center mb-1 text-[10px]">
                    <span className={`font-black ${isDarkMode ? 'text-[#16af75]' : 'text-natural-primary'}`}>
                      {uploadProgress}%
                    </span>
                    <span className={isDarkMode ? 'text-gray-400' : 'text-neutral-500'}>
                      تقدم معالجة ورفع الملفات
                    </span>
                  </div>
                  <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDarkMode ? 'bg-gray-800' : 'bg-gray-200'}`}>
                    <motion.div
                      className={`h-full rounded-full ${isDarkMode ? 'bg-[#16af75]' : 'bg-[#4A4A35]'}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${uploadProgress}%` }}
                      transition={{ duration: 0.1 }}
                    />
                  </div>
                </div>
              )}

              <div className="flex gap-2 justify-start pt-1">
                {(() => {
                  const hasNewFilesToUpload = newImages.some(img => typeof img !== 'string');
                  return (
                    <button 
                      type="button"
                      onClick={hasNewFilesToUpload && !getAccessToken() ? handleAuthorize : handleUpdate} 
                      disabled={isSaving}
                      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold text-white transition-colors disabled:opacity-50 ${
                        hasNewFilesToUpload && !getAccessToken() 
                          ? 'bg-amber-600 hover:bg-amber-700' 
                          : 'bg-natural-primary hover:bg-[#4A4A35]'
                      }`}
                    >
                      {isSaving ? <Loader2 size={14} className="animate-spin" /> : (hasNewFilesToUpload && !getAccessToken() ? <ImageIcon size={14} /> : <Check size={14} />)}
                      {isSaving ? (status || 'جاري الحفظ...') : (hasNewFilesToUpload && !getAccessToken() ? 'تفعيل Drive للحفظ' : 'حفظ التغييرات')}
                    </button>
                  );
                })()}
                <button 
                  type="button"
                  onClick={handleCancelEdit} 
                  disabled={isSaving}
                  className="flex items-center gap-1 rounded-lg border border-natural-border px-4 py-2 text-xs font-bold text-natural-muted transition-colors hover:bg-natural-bg disabled:opacity-50"
                >
                  <X size={14} /> إلغاء
                </button>
              </div>
            </div>
          ) : (
            <div className="group relative max-w-full">
              {(() => {
                const hasMediaInBody = hasMediaInText(post.text);
                return (
                  <>
                    <div 
                      ref={postTextContainerRef}
                      className={`transition-all duration-300 ${(!isTextExpanded && !hasMediaInBody) ? 'line-clamp-3' : ''} overflow-hidden max-w-full`}
                    >
                      <div 
                         className={`whitespace-pre-wrap leading-relaxed break-words transition-colors ${
                           isDarkMode ? 'text-[#e4edf7]' : 'text-[#4A4A35]'
                         }`}
                        dir={isRtl(post.text) ? 'rtl' : 'ltr'}
                        style={{ 
                          textAlign: isRtl(post.text) ? 'right' : 'left',
                          fontSize: `${fontSize}px`,
                          color: isDarkMode ? '#e4edf7' : '#4A4A35'
                        }}
                      >
                        {renderTextWithLinks(post.text, isDarkMode)}
                      </div>
                    </div>

                    {/* Audio Players */}
                    {audioList.length > 0 && (
                      <div className="mt-3 flex flex-col gap-2 w-full" onClick={(e) => e.stopPropagation()}>
                        {audioList.map((audioItem, idx) => (
                          <AudioPlayer
                            key={idx}
                            src={audioItem.url}
                            name={audioItem.name || 'ملف صوتي'}
                            size={audioItem.size}
                            isDarkMode={isDarkMode}
                          />
                        ))}
                      </div>
                    )}

                    {/* Video Players */}
                    {videoList.length > 0 && (
                      <div className="mt-3 flex flex-col gap-2.5 w-full" onClick={(e) => e.stopPropagation()}>
                        {videoList.map((videoItem, idx) => (
                          <VideoPlayer
                            key={idx}
                            src={videoItem.url}
                            name={videoItem.name || 'ملف فيديو'}
                            size={videoItem.size}
                            isDarkMode={isDarkMode}
                          />
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      {!hasMediaInBody && (hasTextOverflow || isTextExpanded || post.text.split('\n').length > 3) ? (
                        <button 
                          type="button"
                          onClick={() => setIsTextExpanded(!isTextExpanded)} 
                          className={`text-[10px] font-black hover:underline cursor-pointer transition-colors ${
                            isDarkMode ? 'text-[#EEA396]' : 'text-natural-primary'
                          }`}
                        >
                          {isTextExpanded ? 'عرض أقل ↑' : 'عرض المزيد ↓'}
                        </button>
                      ) : <div />}
                      {attachmentsList.length === 0 && !hasMediaInBody && (
                        <div className="flex items-center gap-1 relative">
                          <button 
                            onClick={handleTestPromptClick} 
                          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold transition-all ${
                            isDarkMode 
                              ? 'text-[#16af75] bg-[#111822] hover:bg-[#111822] hover:border-[#16af75]/50 border border-[#656c74] shadow-md pulsate-prompt-dark' 
                              : 'text-[#c26700] bg-[#fffaf5] shadow-md hover:bg-[#fef3e6] hover:border-[#c26700]/40 border border-[#cbd5e1] pulsate-prompt-light'
                          }`}
                        >
                          <Sparkles size={12} className="text-[#c26700]" />
                          <span>تجربة البرومبت</span>
                        </button>

                  <AnimatePresence>
                    {showDropdown && (
                      <div className="fixed inset-x-0 bottom-0 top-[115px] z-[120] flex items-start justify-center p-4 overflow-y-auto">
                        {/* Backdrop */}
                        <motion.div 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="fixed inset-x-0 bottom-0 top-[115px] bg-black/40 backdrop-blur-xs" 
                          onClick={() => setShowDropdown(false)} 
                        />

                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: 15 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 15 }}
                          transition={{ duration: 0.2 }}
                          className={`relative w-full max-w-[500px] rounded-3xl border p-6 shadow-2xl text-right z-50 overflow-hidden my-2 flex flex-col max-h-[80vh] transition-colors ${
                            isDarkMode 
                              ? 'border-[#2C374E] bg-[#111822]' 
                              : 'border-natural-border bg-white'
                          }`}
                          dir="rtl"
                        >
                          <div className={`flex items-center justify-between border-b pb-3 mb-3 shrink-0 ${
                            isDarkMode ? 'border-[#2C374E]' : 'border-natural-border/40'
                          }`}>
                            <div className="flex items-center gap-3">
                              <div className="h-7 w-7 rounded-lg bg-green-500/10 flex items-center justify-center text-green-600 shrink-0">
                                <Check size={16} className="animate-bounce" />
                              </div>
                              <div>
                                <h4 className={`text-sm font-black text-right leading-tight ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>
                                  البرومبت جاهز لتوليد الصورة
                                </h4>
                                <p className="text-xs text-green-500 font-bold text-center mt-0.5 leading-normal">
                                  تم نسخ النص للحافظة بنجاح
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setShowDropdown(false)}
                              className={`p-1.5 px-2 rounded-lg transition-colors cursor-pointer shrink-0 ${
                                isDarkMode 
                                  ? 'bg-[#1A212E] hover:bg-[#253042] text-zinc-400' 
                                  : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-500'
                              }`}
                            >
                              <X size={14} />
                            </button>
                          </div>

                          {/* Copied text display frame (Read Only, Small) */}
                          <div className={`mb-3 rounded-xl p-3 border text-xs font-mono whitespace-pre-wrap break-words max-h-24 overflow-y-auto shrink-0 leading-relaxed text-left ${
                            isDarkMode 
                              ? 'bg-[#1A212E] border-[#2C374E] text-[#B4C6D8]' 
                              : 'bg-neutral-50 border-natural-border/50 text-[#4A4A35]'
                          }`} dir="ltr">
                            {post.text}
                          </div>

                          {/* Websites list - identical styling to PromptBuilder sites directory */}
                          <div className="space-y-1.5 overflow-y-auto pr-1 text-right flex-1 scrollbar-thin my-1">
                            {/* Render Default Sites first */}
                            {DEFAULT_SITES.map((site, index) => {
                              const isVisited = visitedTrialUrls.includes(site.url);
                              const cleanDisplayUrl = site.url.replace(/^https?:\/\/(www\.)?/i, '');
                              return (
                                <div
                                  key={`default-${index}`}
                                  className={`flex items-start justify-between gap-2.5 p-2 md:p-2.5 rounded-xl border transition-all ${
                                    isDarkMode 
                                      ? isVisited
                                        ? 'bg-[#1A212E]/40 border-[#2C374E]/80 opacity-80'
                                        : 'bg-[#008D75]/5 border-[#2C374E] hover:bg-[#008D75]/10'
                                      : isVisited
                                        ? 'bg-neutral-50/50 border-natural-border/80 opacity-90'
                                        : 'bg-green-50/5 border-natural-border/90 hover:bg-green-50/10'
                                  }`}
                                >
                                  <div className="flex items-start gap-2.5 flex-1 min-w-0 text-right">
                                    <span className={`text-xs font-black w-5 h-5 flex items-center justify-center shrink-0 select-none rounded-md ${
                                      isDarkMode ? 'bg-[#4DD0E1]/10 text-[#4DD0E1]' : 'bg-natural-primary/10 text-[#4A4A35]'
                                    }`}>
                                      {index + 1}
                                    </span>
                                    <div className="flex-1 min-w-0 space-y-1.5 text-right overflow-hidden">
                                      <a
                                        href={site.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => {
                                          if (!visitedTrialUrls.includes(site.url)) {
                                            setVisitedTrialUrls(prev => [...prev, site.url]);
                                          }
                                          setShowDropdown(false);
                                        }}
                                        className={`block text-[14px] md:text-[14px] font-black hover:underline whitespace-nowrap overflow-hidden text-ellipsis text-left w-full transition-colors leading-normal cursor-pointer font-mono ${
                                          isDarkMode
                                            ? isVisited
                                              ? 'text-red-400 hover:text-red-300'
                                              : 'text-[#4DD0E1] hover:text-[#5ce0f1]'
                                            : isVisited
                                              ? 'text-red-700 hover:text-red-800'
                                              : 'text-emerald-950 hover:text-emerald-950'
                                        }`}
                                        title={`اضغط لزيارة: ${site.url}`}
                                        dir="ltr"
                                      >
                                        {cleanDisplayUrl}
                                      </a>
                                      <div className={`flex items-center gap-1 opacity-90 w-full border rounded-lg px-1 py-1 text-right ${
                                        isDarkMode 
                                          ? 'bg-[#1A212E] border-[#2C374E]' 
                                          : 'bg-[#4A4A35]/5 border-natural-border/50'
                                      }`}>
                                        <span className={`text-[10px] font-black shrink-0 select-none ${isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'}`}> الميزة : </span>
                                        <span className={`text-[11px] font-bold py-0 text-right truncate select-all flex-1 min-w-0 ${isDarkMode ? 'text-white' : 'text-[#3A3A28]'}`}>{site.label}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}

                            {/* Render Custom Sites next */}
                            {customSites.map((site, index) => {
                              const isVisited = visitedTrialUrls.includes(site.url);
                              const cleanDisplayUrl = site.url.replace(/^https?:\/\/(www\.)?/i, '');
                              const offsetIndex = DEFAULT_SITES.length + index;
                              return (
                                <div
                                  key={`custom-${index}`}
                                  className={`flex items-start justify-between gap-2.5 p-2 md:p-2.5 rounded-xl border transition-all ${
                                    isDarkMode 
                                      ? isVisited
                                        ? 'bg-[#1A212E]/40 border-[#2C374E]/80 opacity-80'
                                        : 'bg-[#008D75]/5 border-[#2C374E] hover:bg-[#008D75]/10'
                                      : isVisited
                                        ? 'bg-neutral-50/50 border-natural-border/80 opacity-90'
                                        : 'bg-green-50/5 border-natural-border/90 hover:bg-green-50/10'
                                  }`}
                                >
                                  <div className="flex items-start gap-2.5 flex-1 min-w-0 text-right">
                                    <span className={`text-xs font-black w-5 h-5 flex items-center justify-center shrink-0 select-none rounded-md ${
                                      isDarkMode ? 'bg-[#4DD0E1]/10 text-[#4DD0E1]' : 'bg-natural-primary/10 text-[#4A4A35]'
                                    }`}>
                                      {offsetIndex + 1}
                                    </span>
                                    <div className="flex-1 min-w-0 space-y-1.5 text-right overflow-hidden">
                                      <a
                                        href={site.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => {
                                          if (!visitedTrialUrls.includes(site.url)) {
                                            setVisitedTrialUrls(prev => [...prev, site.url]);
                                          }
                                          setShowDropdown(false);
                                        }}
                                        className={`block text-[14px] md:text-[14px] font-black hover:underline whitespace-nowrap overflow-hidden text-ellipsis text-left w-full transition-colors leading-normal cursor-pointer font-mono ${
                                          isDarkMode
                                            ? isVisited
                                              ? 'text-red-400 hover:text-red-300'
                                              : 'text-[#4DD0E1] hover:text-[#5ce0f1]'
                                            : isVisited
                                              ? 'text-red-700 hover:text-red-800'
                                              : 'text-emerald-950 hover:text-emerald-950'
                                        }`}
                                        title={`اضغط لزيارة: ${site.url}`}
                                        dir="ltr"
                                      >
                                        {cleanDisplayUrl}
                                      </a>
                                      <div className={`flex items-center gap-1 opacity-90 w-full border rounded-lg px-1 py-1 text-right ${
                                        isDarkMode 
                                          ? 'bg-[#1A212E] border-[#2C374E]' 
                                          : 'bg-[#4A4A35]/5 border-natural-border/50'
                                      }`}>
                                        <span className={`text-[10px] font-black shrink-0 select-none ${isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'}`}> الميزة : </span>
                                        <input
                                          type="text"
                                          value={site.label || ''}
                                          onChange={(e) => handleEditCustomSiteLabel(site.url, e.target.value)}
                                          placeholder="اضغط لتسمية الموقع..."
                                          className={`w-full bg-transparent text-[11px] font-bold focus:outline-none text-right border-none p-0 flex-1 min-w-0 ${
                                            isDarkMode ? 'text-white placeholder-zinc-500' : 'text-[#3A3A28] placeholder-zinc-400'
                                          }`}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteCustomSite(site.url);
                                    }}
                                    className={`p-1 px-1.5 rounded-md transition-colors border shrink-0 self-start mt-0.5 cursor-pointer ${
                                      isDarkMode 
                                        ? 'text-red-400 hover:bg-red-900/20 border-red-900/40' 
                                        : 'text-red-600 hover:bg-red-50 border border-red-200/60'
                                    }`}
                                    title="حذف هذا الموقع المخصص"
                                  >
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>

                          {/* Add custom site form */}
                          <div className={`mt-3 border-t pt-3 space-y-2 shrink-0 ${
                            isDarkMode ? 'border-[#2C374E]' : 'border-natural-border/50'
                          }`}>
                            <div className={`text-xs font-black ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-primary'}`}>
                              ➕ إضافة موقع تجريبي مخصص لملفك:
                            </div>
                            <div className="grid grid-cols-1 gap-1.5 text-right">
                              <input
                                type="text"
                                value={newSiteName}
                                onChange={(e) => setNewSiteName(e.target.value)}
                                placeholder="اسم الموقع المخصص (اختياري)"
                                className={`w-full text-right rounded-xl border px-3 py-2 text-xs font-black focus:ring-1 focus:outline-none transition-all ${
                                  isDarkMode
                                    ? 'border-[#2C374E] bg-[#1A212E] text-white focus:ring-[#008D75] placeholder-[#B4C6D8]/40'
                                    : 'border-natural-border bg-natural-bg/30 focus:ring-natural-primary placeholder:text-natural-muted/50'
                                }`}
                              />
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  value={newSiteUrl}
                                  onChange={(e) => setNewSiteUrl(e.target.value)}
                                  placeholder="رابط الموقع (example.com)"
                                  className={`flex-1 text-right rounded-xl border px-3 py-2 text-xs font-black focus:ring-1 focus:outline-none transition-all ${
                                    isDarkMode
                                      ? 'border-[#2C374E] bg-[#1A212E] text-white focus:ring-[#008D75] placeholder-[#B4C6D8]/40'
                                      : 'border-natural-border bg-natural-bg/30 focus:ring-natural-primary placeholder:text-natural-muted/50'
                                  }`}
                                  dir="ltr"
                                />
                                <button
                                  onClick={handleSaveCustomSite}
                                  className={`rounded-xl px-4 py-2 text-xs font-black transition-all whitespace-nowrap shadow-sm hover:shadow active:scale-95 cursor-pointer ${
                                    isDarkMode
                                      ? 'bg-[#008D75] text-white hover:bg-[#007460]'
                                      : 'bg-natural-primary text-white hover:bg-[#4A4A35]'
                                  }`}
                                >
                                  حفظ الموقع
                                </button>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      </div>
                    )}
                  </AnimatePresence>

                  <div className="relative">
                    <button 
                      onClick={handleCopy} 
                      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold transition-all cursor-pointer ${
                        isDarkMode 
                          ? 'text-[#16af75] bg-[#111822] hover:bg-[#111822] hover:border-[#16af75]/50 border border-[#656c74] shadow-md' 
                          : 'text-[#c26700] bg-[#fffaf5] shadow-md hover:bg-[#fef3e6] hover:border-[#c26700]/40 border border-[#cbd5e1]'
                      }`}
                    >
                      {isCopied ? (
                        <>
                          <Check size={12} className={isDarkMode ? 'text-green-400' : 'text-green-600'} />
                          <span className={isDarkMode ? 'text-green-400' : 'text-green-600'}>تم النسخ</span>
                        </>
                      ) : (
                        <>
                          <Copy size={12} className="text-[#c26700]" />
                          <span>نسخ النص</span>
                        </>
                      )}
                    </button>

                    <AnimatePresence>
                      {isCopyMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: -5 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -5 }}
                          className={`absolute bottom-full left-0 mb-1.5 z-[100] min-w-[135px] border rounded-xl shadow-md p-1.5 flex flex-col gap-1 text-right transition-colors ${
                            isDarkMode 
                              ? 'bg-[#111822] border-[#656c74]' 
                              : 'bg-[#fffaf5] border-[#cbd5e1]'
                          }`}
                          onClick={(e) => e.stopPropagation()}
                          dir="rtl"
                        >
                          <button
                            onClick={handleCopyForTranslate}
                            className={`w-full text-right px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
                              isDarkMode 
                                ? 'text-[#16af75] bg-[#111822] border-[#656c74]/40 hover:bg-[#16af75]/10 hover:border-[#16af75]/50 shadow-sm' 
                                : 'text-[#c26700] bg-[#fffaf5] border-[#cbd5e1]/40 hover:bg-[#fef3e6] hover:border-[#c26700]/50 shadow-sm'
                            }`}
                          >
                            <Languages size={12} className="text-[#c26700]" />
                            <span className="whitespace-nowrap">نسخ للترجمة </span>
                          </button>
                          <button
                            onClick={handleCopyOnly}
                            className={`w-full text-right px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
                              isDarkMode 
                                ? 'text-[#16af75] bg-[#111822] border-[#656c74]/40 hover:bg-[#16af75]/10 hover:border-[#16af75]/50 shadow-sm' 
                                : 'text-[#c26700] bg-[#fffaf5] border-[#cbd5e1]/40 hover:bg-[#fef3e6] hover:border-[#c26700]/50 shadow-sm'
                            }`}
                          >
                            <Copy size={12} className="text-[#c26700]" />
                            <span className="whitespace-nowrap">نسخ النص فقط</span>
                          </button>
                          <button
                            onClick={handleCopyForEdit}
                            className={`w-full text-right px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
                              isDarkMode 
                                ? 'text-[#16af75] bg-[#111822] border-[#656c74]/40 hover:bg-[#16af75]/10 hover:border-[#16af75]/50 shadow-sm' 
                                : 'text-[#c26700] bg-[#fffaf5] border-[#cbd5e1]/40 hover:bg-[#fef3e6] hover:border-[#c26700]/50 shadow-sm'
                            }`}
                          >
                            <Sparkles size={12} className="text-[#c26700]" />
                            <span className="whitespace-nowrap">نسخ للتحسين</span>
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  )}
</div>

        {/* Image Grid/Gallery */}
        {imagesList.length > 0 && (
          <div className={`grid gap-0.5 overflow-hidden transition-colors ${
            isDarkMode ? 'bg-[#2C374E]' : 'bg-natural-border'
          } ${filesList.length === 0 ? 'rounded-b-2xl' : ''}`}>
            {imagesList.length === 1 && (
              <div 
                className="relative aspect-video w-full bg-natural-secondary-bg overflow-hidden cursor-pointer"
                onClick={() => { setLightboxIndex(0); setLightboxOpen(true); }}
              >
                {renderPostImage(
                  imagesList[0],
                  "h-full w-full object-cover transition-transform duration-500 hover:scale-105",
                  "Post content",
                  { loading: "lazy" }
                )}
                {(() => {
                  const origIdx = imageUrls.indexOf(imagesList[0]);
                  return (
                    <>
                      {(() => {
                        const mVal = post.imageModels?.[origIdx] || '';
                        const cleanM = mVal.split('|').filter(part => part && part !== 'تغشية')[0] || '';
                        if (!cleanM) return null;
                        return (
                          <div className="absolute bottom-1 right-1.5 bg-black/60 text-[#F5F5EC] border border-white/10 rounded px-1.5 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10 font-sans font-bold" style={{ fontSize: '7px' }}>
                            ✨ {cleanM}
                          </div>
                        );
                      })()}
                      {post.imageCaptions && post.imageCaptions[origIdx] && (
                        <div className="absolute bottom-1 left-1.5 max-w-[55%] bg-black/60 text-[#F5F5EC] border border-white/10 rounded-md px-1 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10">
                          <p className="text-white font-bold leading-tight break-words whitespace-normal drop-shadow-md" style={{ fontSize: '5px' }} dir="rtl">
                            {post.imageCaptions[origIdx]}
                          </p>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            
            {imagesList.length === 2 && (
              <div className="grid grid-cols-2 gap-0.5">
                {imagesList.map((url, i) => {
                  const origIdx = imageUrls.indexOf(url);
                  return (
                    <div 
                      key={url + i} 
                      className="relative aspect-square bg-natural-secondary-bg overflow-hidden cursor-pointer"
                      onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
                    >
                      {renderPostImage(url, "h-full w-full object-cover")}
                      {(() => {
                        const mVal = post.imageModels?.[origIdx] || '';
                        const cleanM = mVal.split('|').filter(part => part && part !== 'تغشية')[0] || '';
                        if (!cleanM) return null;
                        return (
                          <div className="absolute bottom-1 right-1.5 bg-black/60 text-[#F5F5EC] border border-white/10 rounded px-1.5 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10 font-sans font-bold" style={{ fontSize: '7px' }}>
                            ✨ {cleanM}
                          </div>
                        );
                      })()}
                      {post.imageCaptions && post.imageCaptions[origIdx] && (
                        <div className="absolute bottom-1 left-1.5 max-w-[55%] bg-black/60 text-[#F5F5EC] border border-white/10 rounded-md px-1 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10">
                          <p className="text-white font-bold leading-tight break-words whitespace-normal drop-shadow-md" style={{ fontSize: '5px' }} dir="rtl">
                            {post.imageCaptions[origIdx]}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {imagesList.length === 3 && (
              <div className="grid grid-cols-2 gap-0.5">
                <div 
                  className="relative aspect-square bg-natural-secondary-bg row-span-2 overflow-hidden cursor-pointer"
                  onClick={() => { setLightboxIndex(0); setLightboxOpen(true); }}
                >
                  {renderPostImage(imagesList[0], "h-full w-full object-cover")}
                  {(() => {
                    const origIdx = imageUrls.indexOf(imagesList[0]);
                    return (
                      <>
                        {(() => {
                          const mVal = post.imageModels?.[origIdx] || '';
                          const cleanM = mVal.split('|').filter(part => part && part !== 'تغشية')[0] || '';
                          if (!cleanM) return null;
                          return (
                            <div className="absolute bottom-1 right-1.5 bg-black/60 text-[#F5F5EC] border border-white/10 rounded px-1.5 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10 font-sans font-bold" style={{ fontSize: '7px' }}>
                              ✨ {cleanM}
                            </div>
                          );
                        })()}
                        {post.imageCaptions && post.imageCaptions[origIdx] && (
                          <div className="absolute bottom-1 left-1.5 max-w-[55%] bg-black/60 text-[#F5F5EC] border border-white/10 rounded-md px-1 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10">
                            <p className="text-white font-bold leading-tight break-words whitespace-normal drop-shadow-md" style={{ fontSize: '5px' }} dir="rtl">
                              {post.imageCaptions[origIdx]}
                            </p>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
                <div className="grid grid-rows-2 gap-0.5">
                  {imagesList.slice(1).map((url, i) => {
                    const actualIndex = i + 1;
                    const origIdx = imageUrls.indexOf(url);
                    return (
                      <div 
                        key={url + actualIndex} 
                        className="relative aspect-square bg-natural-secondary-bg overflow-hidden cursor-pointer"
                        onClick={() => { setLightboxIndex(actualIndex); setLightboxOpen(true); }}
                      >
                        {renderPostImage(url, "h-full w-full object-cover")}
                        {(() => {
                          const mVal = post.imageModels?.[origIdx] || '';
                          const cleanM = mVal.split('|').filter(part => part && part !== 'تغشية')[0] || '';
                          if (!cleanM) return null;
                          return (
                            <div className="absolute bottom-1 right-1.5 bg-black/60 text-[#F5F5EC] border border-white/10 rounded px-1.5 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10 font-sans font-bold" style={{ fontSize: '7px' }}>
                              ✨ {cleanM}
                            </div>
                          );
                        })()}
                        {post.imageCaptions && post.imageCaptions[origIdx] && (
                          <div className="absolute bottom-1 left-1.5 max-w-[55%] bg-black/60 text-[#F5F5EC] border border-white/10 rounded-md px-1 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10">
                            <p className="text-white font-bold leading-tight break-words whitespace-normal drop-shadow-md" style={{ fontSize: '5px' }} dir="rtl">
                              {post.imageCaptions[origIdx]}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {imagesList.length >= 4 && (
              <div className="grid grid-cols-2 gap-0.5">
                {imagesList.slice(0, 4).map((url, i) => {
                  const origIdx = imageUrls.indexOf(url);
                  return (
                    <div 
                      key={url + i} 
                      className="relative aspect-square bg-natural-secondary-bg overflow-hidden cursor-pointer"
                      onClick={() => { setLightboxIndex(i); setLightboxOpen(true); }}
                    >
                      {renderPostImage(url, "h-full w-full object-cover")}
                      {(() => {
                        const mVal = post.imageModels?.[origIdx] || '';
                        const cleanM = mVal.split('|').filter(part => part && part !== 'تغشية')[0] || '';
                        if (!cleanM) return null;
                        return (
                          <div className="absolute bottom-1 right-1.5 bg-black/60 text-[#F5F5EC] border border-white/10 rounded px-1.5 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10 font-sans font-bold" style={{ fontSize: '7px' }}>
                            ✨ {cleanM}
                          </div>
                        );
                      })()}
                      {post.imageCaptions && post.imageCaptions[origIdx] && (
                        <div className="absolute bottom-1 left-1.5 max-w-[55%] bg-black/60 text-[#F5F5EC] border border-white/10 rounded-md px-1 py-0.5 backdrop-blur-xs select-none pointer-events-none z-10">
                          <p className="text-white font-bold leading-tight break-words whitespace-normal drop-shadow-md" style={{ fontSize: '5px' }} dir="rtl">
                            {post.imageCaptions[origIdx]}
                          </p>
                        </div>
                      )}
                      {i === 3 && imagesList.length > 4 && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white font-bold text-xl pointer-events-none z-10">
                          +{imagesList.length - 4}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Files Download Section */}
        {filesList.length > 0 && (
          <div className={`p-3 border-t flex flex-col gap-2 rounded-b-2xl ${
            isDarkMode ? 'border-[#2C374E] bg-[#111822]/60' : 'border-natural-border/40 bg-[#fffaf5]/40'
          }`} dir="rtl">
            <span className={`text-[10px] font-black select-none ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`}>
              📎 الملفات المرفقة ({filesList.length}):
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filesList.map((file, fIdx) => {
                const isApk = file.name?.toLowerCase().endsWith('.apk') || file.type?.includes('vnd.android.package-archive');
                return (
                  <a
                    key={fIdx}
                    href={file.downloadUrl}
                    download={file.name || 'file'}
                    onClick={(e) => handleDownloadFile(e, file.url, file.name || 'file')}
                    className={`relative overflow-hidden flex items-center gap-2.5 p-2 rounded-xl border transition-all hover:scale-[1.01] ${
                      isDarkMode
                        ? 'border-[#2C374E] bg-[#1a212e] text-white hover:bg-[#2C374E]'
                        : 'border-natural-border/60 bg-white text-natural-text hover:bg-natural-bg/40'
                    }`}
                  >
                    {/* Real-time background progress fill */}
                    {downloadingFileUrl === file.url && (
                      <div 
                        className={`absolute top-0 bottom-0 right-0 ${
                          isDarkMode ? 'bg-[#16af75]/15' : 'bg-[#c26700]/15'
                        } transition-all duration-150 ease-out z-0`}
                        style={{ width: `${downloadProgress}%` }}
                      />
                    )}

                    <span className="text-2xl shrink-0 z-10 flex items-center justify-center min-w-[28px] h-[28px]">
                      {downloadingFileUrl === file.url ? (
                        <span className={`text-[10px] font-black tracking-tighter ${isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'}`}>
                          {downloadProgress}%
                        </span>
                      ) : (
                        isApk ? '🤖' : '📄'
                      )}
                    </span>
                    <div className="flex-1 min-w-0 text-right z-10">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold truncate flex-1" title={file.name || 'ملف بدون اسم'}>
                          {file.name || 'ملف بدون اسم'}
                        </p>
                        {file.size && (
                          <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md ${
                            isDarkMode ? 'bg-[#2C374E]/80 text-[#16af75]' : 'bg-[#c26700]/10 text-[#c26700]'
                          } shrink-0`} dir="ltr">
                            {file.size}
                          </span>
                        )}
                      </div>
                      <p className={`text-[9px] font-medium mt-0.5 ${isDarkMode ? 'text-gray-400' : 'text-natural-muted'}`}>
                        {downloadingFileUrl === file.url ? (
                          <span className="animate-pulse font-black text-xs text-[#16af75]">جاري التنزيل...</span>
                        ) : (
                          isApk ? 'تطبيق أندرويد (APK)' : (file.type || 'ملف')
                        )}
                      </p>
                    </div>
                    {post.imageCaptions?.[file.index] && (
                      <span className="text-[10px] text-gray-500 italic truncate max-w-[80px] z-10">
                        {post.imageCaptions[file.index]}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </motion.div>

      <Lightbox
        open={lightboxOpen}
        close={() => setLightboxOpen(false)}
        index={lightboxIndex}
        on={{ 
          view: ({ index }) => setLightboxIndex(index),
          click: () => {
            const now = Date.now();
            if (now - lastLightboxClickTimeRef.current < 350) {
              lastLightboxClickTimeRef.current = 0;
              const currentZoom = lightboxZoomRef.current?.zoom ?? 1;
              if (currentZoom < 1.25) {
                // أول نقرتين: تكبير 50% (1.9x)
                lightboxZoomRef.current?.changeZoom(1.9);
              } else if (currentZoom < 1.95) {
                // ثاني نقرتين: تكبير 100% (3.0x)
                lightboxZoomRef.current?.changeZoom(3.0);
              } else if (currentZoom < 3.25) {
                // ثالث نقرتين: تكبير 150% (4.8x)
                lightboxZoomRef.current?.changeZoom(4.8);
              } else {
                // رابع نقرتين: تعود لحجمها الطبيعي (1.0x)
                lightboxZoomRef.current?.changeZoom(1.0);
              }
            } else {
              lastLightboxClickTimeRef.current = now;
            }
          }
        }}
        slides={slides}
        plugins={[Zoom]}
        carousel={{
          spacing: "0px",
          padding: "0px"
        }}
        controller={{ 
          closeOnBackdropClick: true,
          closeOnPullDown: true,
          closeOnPullUp: true 
        }}
        zoom={{
          ref: lightboxZoomRef as any,
          maxZoomPixelRatio: 10,
          scrollToZoom: true,
          doubleTapDelay: 0,
          doubleClickDelay: 0,
          doubleClickMaxStops: 0,
          zoomInMultiplier: 1.25,
          keyboardMoveDistance: 50,
          wheelZoomDistanceFactor: 100,
          pinchZoomDistanceFactor: 100,
        }}
        render={{
          buttonPrev: slides.length <= 1 ? () => null : undefined,
          buttonNext: slides.length <= 1 ? () => null : undefined,
          controls: () => {
            const activeImageUrl = imagesList[lightboxIndex];
            const origIdx = imageUrls.indexOf(activeImageUrl);
            const currentModel = post.imageModels?.[origIdx];
            const currentCaption = post.imageCaptions?.[origIdx];
            const name = post.fileNames?.[origIdx] || `image_${post.id}_${lightboxIndex + 1}.png`;
            const isDownloadingThis = downloadingFileUrl === activeImageUrl;

            return (
              <>
                {/* Custom Original Image Download Button - styled beautifully to merge with Close/Zoom controls */}
                <button
                  type="button"
                  onClick={(e) => handleDownloadFile(e, activeImageUrl, name)}
                  disabled={isDownloadingThis}
                  className="yarl__button absolute top-0 right-[144px] z-[999999] flex items-center justify-center text-white/85 hover:text-white active:scale-95 disabled:opacity-50 transition-all bg-transparent border-none outline-none cursor-pointer w-12 h-12 p-0"
                  title="تحميل الصورة الأصلية بكافة بايتاتها من Google Drive"
                >
                  {isDownloadingThis ? (
                    <div className="relative flex items-center justify-center">
                      <Loader2 className="animate-spin text-white" size={20} />
                      <span className="absolute text-[7px] font-black text-white">{downloadProgress}</span>
                    </div>
                  ) : (
                    <Download size={20} className="text-white" />
                  )}
                </button>

                <LightboxBottomOverlay 
                  modelName={currentModel} 
                  caption={currentCaption}
                  slideSrc={activeImageUrl} 
                />
              </>
            );
          }
        }}
      />

      {/* Dynamic Sliding Drawer to select board to transfer post to (Tablet and Mobile) */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {isTransferDrawerOpen && (
            <>
            {/* Background Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setIsTransferDrawerOpen(false);
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
                  نقل المنشور إلى لوحة أخرى
                </h2>
                <button 
                  type="button"
                  onClick={() => {
                    setIsTransferDrawerOpen(false);
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
                <p className={`text-xs font-bold mb-4 text-center leading-relaxed ${
                  isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'
                }`}>
                  اختر اللوحة التي تريد نقل هذا المنشور إليها
                </p>

                <div className="space-y-2">
                  {/* Main Feed option */}
                  <button
                    type="button"
                    onClick={() => {
                      setEditedBoardId(null);
                      setEditedSubBoardId(null);
                      setIsTransferDrawerOpen(false);
                      window.dispatchEvent(new Event('unlock_posts_layout'));
                    }}
                    className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                      editedBoardId === null
                        ? (isDarkMode 
                            ? 'bg-[#008D75] border-[#008D75] text-white shadow-md font-bold' 
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
                    {editedBoardId === null && (
                      <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                    )}
                  </button>

                  {/* Dynamic Boards */}
                  {boards && (isAdmin ? boards : boards.filter(b => !b.hidden)).map((board) => {
                    const isSelected = editedBoardId === board.id;
                    return (
                      <button
                        key={board.id}
                        type="button"
                        onClick={() => {
                          if (board.id === 'safe-board') {
                            const savedPass = sessionStorage.getItem('safe_vault_password');
                            if (savedPass === '88775500') {
                              setEditedBoardId(board.id);
                              setEditedSubBoardId(null);
                              setIsTransferDrawerOpen(false);
                              window.dispatchEvent(new Event('unlock_posts_layout'));
                            } else {
                              setOnSuccessCallback(() => () => {
                                setEditedBoardId(board.id);
                                setEditedSubBoardId(null);
                                setIsTransferDrawerOpen(false);
                                window.dispatchEvent(new Event('unlock_posts_layout'));
                              });
                              setShowSafePasswordModal(true);
                            }
                          } else {
                            setEditedBoardId(board.id);
                            setEditedSubBoardId(null);
                            setIsTransferDrawerOpen(false);
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

      {/* Target Post Selection Modal for Moving Selected Images */}
      {isMoveImagesModalOpen && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm dir-rtl" dir="rtl">
          <div className={`w-full max-w-md rounded-2xl p-5 shadow-2xl border flex flex-col max-h-[85vh] transition-all ${
            isDarkMode ? 'bg-[#182232] border-[#2C374E] text-white' : 'bg-white border-neutral-200 text-neutral-900'
          }`}>
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500 font-bold">
                  <FolderOutput size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-sm">نقل الصور المحددة</h3>
                  <p className="text-[11px] opacity-70">اختر المنشور الوجهة لنقل {selectedImageIndices.length} مرفق إليها</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsMoveImagesModalOpen(false)}
                className="p-1.5 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-800 opacity-70 hover:opacity-100 transition-all cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Search Input */}
            <div className="my-3 relative">
              <input
                type="text"
                value={targetPostSearchQuery}
                onChange={(e) => setTargetPostSearchQuery(e.target.value)}
                placeholder="ابحث عن منشور بالكلمات أو الملاحظات..."
                className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  isDarkMode ? 'bg-[#111822] border-[#2C374E] text-white' : 'bg-neutral-50 border-neutral-200 text-neutral-900'
                }`}
              />
            </div>

            {/* Candidate Posts List */}
            <div className="flex-1 overflow-y-auto space-y-2 my-1 pr-1 pl-1 custom-scrollbar">
              {isLoadingTargetPosts ? (
                <div className="flex flex-col items-center justify-center py-8 opacity-70 text-xs">
                  <Loader2 size={24} className="animate-spin mb-2 text-blue-500" />
                  <span>جاري تحميل المنشورات المتاحة...</span>
                </div>
              ) : targetPostsList.filter(p => {
                  if (!targetPostSearchQuery.trim()) return true;
                  const q = targetPostSearchQuery.toLowerCase().trim();
                  return (p.text || '').toLowerCase().includes(q) || (p.boardId || '').toLowerCase().includes(q);
                }).length === 0 ? (
                <div className="text-center py-8 opacity-60 text-xs">
                  لا توجد منشورات أخرى متاح النقل إليها حالياً.
                </div>
              ) : (
                targetPostsList.filter(p => {
                  if (!targetPostSearchQuery.trim()) return true;
                  const q = targetPostSearchQuery.toLowerCase().trim();
                  const textMatch = (p.text || '').toLowerCase().includes(q);
                  const boardMatch = (p.boardId || '').toLowerCase().includes(q);
                  const fileMatch = (p.fileNames || []).some(fn => (fn || '').toLowerCase().includes(q));
                  return textMatch || boardMatch || fileMatch;
                }).map((targetP) => {
                  const isSelected = selectedTargetPost?.id === targetP.id;
                  const previewText = targetP.text ? targetP.text.trim().substring(0, 80) : '';
                  const targetBoardObj = boards?.find(b => b.id === targetP.boardId);
                  const targetSubBoardObj = targetBoardObj?.subBoards?.find(s => s.id === targetP.subBoardId);
                  const boardLabel = targetP.boardId === 'user-board' 
                    ? 'لوحة شخصية' 
                    : (targetSubBoardObj ? `${targetBoardObj?.name || 'اللوحة'} › ${targetSubBoardObj.name}` : (targetBoardObj?.name || 'اللوحة الحالية'));
                  
                  const pUrls = targetP.imageUrls && targetP.imageUrls.length > 0 
                    ? targetP.imageUrls 
                    : (targetP.imageUrl ? [targetP.imageUrl] : []);

                  return (
                    <div
                      key={targetP.id}
                      onClick={() => setSelectedTargetPost(targetP)}
                      className={`p-3 rounded-2xl border text-right cursor-pointer transition-all flex flex-col gap-2 relative ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500/10 ring-2 ring-blue-500/40 shadow-md'
                          : isDarkMode
                          ? 'border-[#2C374E] bg-[#111822]/80 hover:bg-[#111822] hover:border-blue-500/50'
                          : 'border-neutral-200 bg-neutral-50 hover:bg-neutral-100 hover:border-blue-300'
                      }`}
                    >
                      {/* Post Header Info & Selection Circle */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-all ${
                            isSelected ? 'border-blue-500 bg-blue-600 text-white shadow-sm scale-110' : 'border-neutral-400 bg-transparent'
                          }`}>
                            {isSelected && <Check size={14} className="stroke-[3]" />}
                          </div>
                          <span className="font-bold text-xs text-blue-500 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md">
                            {boardLabel}
                          </span>
                        </div>
                        <span className="text-[11px] font-semibold opacity-70">
                          {pUrls.length > 0 ? `${pUrls.length} مرفق` : 'بدون مرفقات'}
                        </span>
                      </div>

                      {/* Text snippet if available */}
                      {previewText && (
                        <p className="text-xs font-medium line-clamp-2 leading-relaxed break-words opacity-90 px-0.5">
                          {previewText}
                        </p>
                      )}

                      {/* Visual Images Grid (Displaying up to 4 images/attachments) */}
                      {pUrls.length > 0 ? (
                        <div className="grid grid-cols-4 gap-1.5 mt-1">
                          {pUrls.slice(0, 4).map((url, idx) => {
                            const isMore = idx === 3 && pUrls.length > 4;
                            const remaining = pUrls.length - 3;
                            const fName = targetP.fileNames?.[idx] || '';
                            const fType = targetP.fileTypes?.[idx] || '';
                            const isNotImg = fType.startsWith('video/') || fType.startsWith('audio/') || fType.includes('pdf') || fType.includes('zip') || fName.match(/\.(mp4|pdf|zip|apk|mp3)$/i);

                            return (
                              <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-700 bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shadow-xs">
                                {!isNotImg ? (
                                  <img 
                                    src={url} 
                                    alt="" 
                                    className="w-full h-full object-cover" 
                                    referrerPolicy="no-referrer" 
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="flex flex-col items-center justify-center p-1 text-[10px] text-center w-full min-w-0">
                                    <span className="text-base">{fName.endsWith('.apk') ? '🤖' : '📄'}</span>
                                    <span className="truncate max-w-full opacity-75 text-[9px] font-semibold">{fName || 'ملف'}</span>
                                  </div>
                                )}
                                {isMore && (
                                  <div className="absolute inset-0 bg-black/75 backdrop-blur-[1px] flex items-center justify-center text-white font-black text-xs">
                                    +{remaining}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="py-2 px-3 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 text-center text-[11px] opacity-60">
                          لا توجد صور حالياً في هذا المنشور
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Actions */}
            <div className="pt-3 border-t border-neutral-200 dark:border-neutral-700 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsMoveImagesModalOpen(false)}
                className="px-4 py-2 rounded-xl border text-xs font-bold opacity-80 hover:opacity-100 transition-all cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleExecuteMoveImages}
                disabled={!selectedTargetPost || isExecutingMoveImages}
                className={`flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md transition-all cursor-pointer ${
                  (!selectedTargetPost || isExecutingMoveImages) ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {isExecutingMoveImages ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>جاري النقل...</span>
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    <span>تأكيد نقل الصور</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Full Size Image Preview Modal during editing */}
      {editPreviewImageUrl && createPortal(
        <div 
          className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 transition-all dir-rtl"
          onClick={() => setEditPreviewImageUrl(null)}
          dir="rtl"
        >
          {/* Close Button X */}
          <button
            type="button"
            onClick={() => setEditPreviewImageUrl(null)}
            className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/20 hover:bg-white/40 text-white transition-all shadow-xl cursor-pointer backdrop-blur-xs"
            title="إغلاق المعاينة"
          >
            <X size={24} />
          </button>

          {/* Centered Image */}
          <div 
            className="relative max-w-[95vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={editPreviewImageUrl}
              alt="صورة بالحجم الكامل"
              className="max-w-[95vw] max-h-[85vh] object-contain rounded-2xl shadow-2xl border border-white/10"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
