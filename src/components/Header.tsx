import React, { useState, useEffect } from 'react';
import { auth, googleProvider } from '../lib/firebase';
import { googleSignIn, logout as authLogout, saveUserKeyToFirestore } from '../lib/auth';
import { safeStorage } from '../lib/safe-storage';
import { User } from 'firebase/auth';
import { LogIn, LogOut, ShieldCheck, User as UserIcon, Menu, X, PlusCircle, Edit, LayoutGrid, Key, Trash2, ChevronDown, ChevronUp, AlertTriangle, Type, Moon, Sun, Bell, BellOff, RefreshCw, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Board } from '../types';
import BoardModals from './BoardModals';
import { db } from '../lib/firebase';
import { collection, addDoc, updateDoc, setDoc, doc, serverTimestamp, deleteDoc } from 'firebase/firestore';
import { handleFirestoreError } from '../lib/error-handler';
import { OperationType } from '../types';
import TextEditorModal from './TextEditorModal';
import RecycleBinModal from './RecycleBinModal';
import { ADMIN_CONFIG } from '../config';
import { GlobalSettings, License } from '../types';
import OwnerLicensePanel from './OwnerLicensePanel';
import { showToast } from './Toast';
import { isNotificationSupported, requestNotificationPermission } from '../lib/notifications';
import { normalizeBoardName } from '../lib/deduplication';


interface HeaderProps {
  user: User | null;
  isAdmin: boolean;
  currentBoard?: Board;
  activeBoardId: string | null;
  boards: Board[];
  onSelectBoard: (id: string | null) => void;
  globalSettings?: GlobalSettings;
  onUpdateSettings?: (newSettings: Partial<GlobalSettings>) => Promise<void>;
  isDarkMode?: boolean;
  setIsDarkMode?: (val: boolean) => void;
  userLicense?: License | null;
}

export default function Header({ 
  user, 
  isAdmin, 
  currentBoard, 
  activeBoardId,
  boards, 
  onSelectBoard,
  globalSettings,
  onUpdateSettings,
  isDarkMode = false,
  setIsDarkMode,
  userLicense
}: HeaderProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isBoardsDrawerOpen, setIsBoardsDrawerOpen] = useState(false);
  const [boardsSearchQuery, setBoardsSearchQuery] = useState('');
  const [isTranslatorOpen, setIsTranslatorOpen] = useState(false);
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'create' | 'edit' | 'reorder';
    targetBoard?: Board;
  }>({
    isOpen: false,
    type: 'create',
    targetBoard: undefined
  });
  const [isBoardsManagerOpen, setIsBoardsManagerOpen] = useState(false);
  const [boardToDelete, setBoardToDelete] = useState<Board | null>(null);
  const [isDeletingBoard, setIsDeletingBoard] = useState(false);
  const [sidebarKey, setSidebarKey] = useState(safeStorage.getItem('user_gemini_api_key') || '');
  const [isEditingKey, setIsEditingKey] = useState(false);
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const [isRenewingAuth, setIsRenewingAuth] = useState(false);

  const handleRenewAuth = async () => {
    try {
      setIsRenewingAuth(true);
      const res = await googleSignIn();
      if (res) {
        showToast('🎉 تم تجديد الصلاحية وتسجيل الدخول بنجاح!');
        setTimeout(() => {
          window.location.reload();
        }, 400);
      }
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        showToast('⚠️ تعذر تجديد الصلاحية: ' + (err.message || ''));
      }
    } finally {
      setIsRenewingAuth(false);
    }
  };
  
  // Safe board password states
  const [showSafePasswordModal, setShowSafePasswordModal] = useState(false);
  const [safePasswordInput, setSafePasswordInput] = useState('');
  const [safePasswordError, setSafePasswordError] = useState(false);
  const [onSuccessCallback, setOnSuccessCallback] = useState<(() => void) | null>(null);
  
  const [postFontSize, setPostFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('post_font_size');
    return saved ? parseInt(saved, 10) : 14;
  });
  const [isTextSizeMenuOpen, setIsTextSizeMenuOpen] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'denied';
  });

  const handleIncreaseFontSize = () => {
    setPostFontSize(prev => {
      const next = Math.min(28, prev + 1);
      localStorage.setItem('post_font_size', String(next));
      window.dispatchEvent(new CustomEvent('post_font_size_changed', { detail: { size: next } }));
      return next;
    });
  };

  const handleDecreaseFontSize = () => {
    setPostFontSize(prev => {
      const next = Math.max(10, prev - 1);
      localStorage.setItem('post_font_size', String(next));
      window.dispatchEvent(new CustomEvent('post_font_size_changed', { detail: { size: next } }));
      return next;
    });
  };

  useEffect(() => {
    const handleCloseMenus = () => {
      setIsTextSizeMenuOpen(false);
    };
    window.addEventListener('click', handleCloseMenus);
    return () => {
      window.removeEventListener('click', handleCloseMenus);
    };
  }, []);
  
  useEffect(() => {
    const handleOpenBoardsDrawer = () => {
      setIsBoardsDrawerOpen(true);
    };
    const handleOpenTextEditor = () => {
      setIsTranslatorOpen(true);
    };
    const handleOpenEditBoardModal = (e: Event) => {
      const customEvt = e as CustomEvent;
      const targetB = customEvt.detail?.board || currentBoard;
      if (targetB) {
        setModalState({ isOpen: true, type: 'edit', targetBoard: targetB });
      }
    };
    window.addEventListener('open_boards_drawer', handleOpenBoardsDrawer);
    window.addEventListener('open_text_editor', handleOpenTextEditor);
    window.addEventListener('open_edit_board_modal', handleOpenEditBoardModal);
    return () => {
      window.removeEventListener('open_boards_drawer', handleOpenBoardsDrawer);
      window.removeEventListener('open_text_editor', handleOpenTextEditor);
      window.removeEventListener('open_edit_board_modal', handleOpenEditBoardModal);
    };
  }, [currentBoard]);

  // Lock body scroll when drawers or modals are open to prevent background posts from moving
  useEffect(() => {
    if (isBoardsDrawerOpen || isSidebarOpen || isRecycleBinOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isBoardsDrawerOpen, isSidebarOpen, isRecycleBinOpen]);
  


  const handleLogin = async () => {
    try {
      const res = await googleSignIn();
      if (res) {
        showToast('🎉 تم تسجيل الدخول بنجاح بحساب غوغل');
        window.location.reload();
      }
      setIsSidebarOpen(false);
    } catch (error: any) {
      console.error('Login failed:', error);
      const isPopupBlocked = error?.code === 'auth/popup-blocked' || error?.message?.toLowerCase().includes('popup-blocked') || error?.message?.toLowerCase().includes('popup');
      const isUnauthorizedDomain = error?.code === 'auth/unauthorized-domain' || error?.message?.toLowerCase().includes('unauthorized-domain') || error?.message?.toLowerCase().includes('authorized domain');
      if (isPopupBlocked) {
        showToast('⚠️ تم حظر النافذة المنبثقة من المتصفح. يرجى السماح بالنوافذ المنبثقة (Pop-ups) للتطبيق في المتصفح لتسجيل الدخول بـ Google.');
      } else if (isUnauthorizedDomain) {
        showToast('⚠️ النطاق الحالي غير مضاف في قائمة النطاقات المصرح بها في Firebase. يرجى إضافة النطاق (Authorized domain) في إعدادات Firebase Console.');
      } else {
        showToast(`❌ فشل تسجيل الدخول: ${error?.message || error}`);
      }
    }
  };



  const handleLogout = async () => {
    try {
      await authLogout();
      setIsSidebarOpen(false);
      window.location.reload();
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const handleSaveGeminiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = sidebarKey.trim();
    safeStorage.setItem('user_gemini_api_key', cleanKey);
    
    if (user && user.email) {
      try {
        await saveUserKeyToFirestore(user.email, cleanKey);
      } catch (err) {
        console.error(err);
      }
    }
    alert(cleanKey ? 'تم حفظ مفتاح Gemini API بنجاح 🎉' : 'تم تفريغ وحذف مفتاح Gemini API بنجاح.');
    setIsEditingKey(false);
  };

  const renderApiKeySection = () => (
    <div className="pt-1 border-t border-natural-border/60 text-right space-y-2">
      <div className="flex items-center gap-1 justify-between">
        <span className="text-xs font-normal text-[#B4C6D8]">إعدادات الذكاء الاصطناعي</span>
        <span className="text-[9px] bg-amber-100 text-amber-800 font-bold px-1 py-0.5 rounded-md">مفتاح Gemini</span>
      </div>
      <p className="text-[8px] text-natural-muted leading-relaxed">
        أدخل مفتاح Gemini API الخاص بك لتفعيل "تحسين البرومبت".
      </p>
      <form onSubmit={handleSaveGeminiKey} className="space-y-2">
        <div className="relative flex items-center">
          <input
            type="password"
            value={sidebarKey}
            onChange={(e) => setSidebarKey(e.target.value)}
            placeholder="AIzaSy..."
            className="w-full text-xs text-[#B4C6D8] rounded-xl pl-10 pr-3 py-2.5 bg-natural-primary font-mono text-left focus:outline-none focus:ring-1 focus:ring-natural-primary"
          />
          <Key size={14} className="absolute left-3 text-natural-muted/60" />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-xl bg-natural-primary text-white text-[11px] font-bold py-2 transition-all hover:bg-[#4A4A35] active:scale-95 cursor-pointer"
          >
            حفظ المفتاح 💾
          </button>
          {sidebarKey && (
            <button
              type="button"
              onClick={async () => {
                setSidebarKey('');
                safeStorage.removeItem('user_gemini_api_key');
                if (user && user.email) {
                  const { deleteUserKeyFromFirestore } = await import('../lib/auth');
                  await deleteUserKeyFromFirestore(user.email);
                }
                alert('تم حذف المفتاح وتصفير الحقل بنجاح.');
              }}
              className="px-2.5 rounded-xl bg-natural-primary text-white text-[11px] font-bold hover:bg-red-100 transition-colors"
            >
              حذف 🗑️
            </button>
          )}
        </div>
      </form>
      <div className="text-[9px] text-left">
        <a 
          href="https://aistudio.google.com/app/apikey" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-amber-700 font-bold hover:underline"
        >
          الحصول على مفتاح API مجاني من Google AI Studio ↗
        </a>
      </div>
    </div>
  );

  const handleBoardSubmit = async (data: any) => {
    console.log('Attempting board submit:', modalState.type, data);
    try {
      if (modalState.type === 'create') {
        if (!data.name?.trim()) {
          showToast('يرجى إدخال اسم اللوحة');
          return;
        }
        const cleanName = normalizeBoardName(data.name);
        const existingBoard = boards.find(b => normalizeBoardName(b.name) === cleanName);
        if (existingBoard) {
          showToast(`التبويب "${existingBoard.name}" موجود بالفعل! تم الانتقال إليه مباشرة.`);
          onSelectBoard(existingBoard.id);
          setModalState({ ...modalState, isOpen: false });
          return;
        }

        const boardData = {
          name: data.name.trim(),
          order: boards.length,
          createdAt: serverTimestamp(),
          locked: !!data.locked,
          hidden: !!data.hidden,
          subBoards: data.subBoards || []
        };
        console.log('Creating board with data:', boardData);
        const docRef = await addDoc(collection(db, 'boards'), boardData);
        onSelectBoard(docRef.id);
        showToast('تم إنشاء اللوحة بنجاح.. تم الانتقال إليها');
      } else if (modalState.type === 'edit' && (modalState.targetBoard || currentBoard)) {
        const boardToEdit = modalState.targetBoard || currentBoard;
        if (!boardToEdit) return;
        if (!data.name?.trim()) {
          showToast('يرجى إدخال اسم اللوحة');
          return;
        }
        await setDoc(doc(db, 'boards', boardToEdit.id), {
          name: data.name.trim(),
          locked: !!data.locked,
          hidden: !!data.hidden,
          subBoards: data.subBoards || [],
          order: typeof boardToEdit.order === 'number' ? boardToEdit.order : 999999
        }, { merge: true });
        showToast('تم تعديل اللوحة بنجاح!');
      } else if (modalState.type === 'reorder') {
        console.log('Reordering boards and sub-boards:', data);
        // data is array of {id, order, subBoards}
        for (const b of data) {
          const updatePayload: any = { order: b.order };
          if (b.subBoards !== undefined) {
            updatePayload.subBoards = b.subBoards;
          }
          await setDoc(doc(db, 'boards', b.id), updatePayload, { merge: true });
        }
        showToast('تم حفظ الترتيب الجديد بنجاح!');
      }
      setModalState({ ...modalState, isOpen: false });
    } catch (error) {
      console.error('Board operation error detail:', error);
      const msg = error instanceof Error ? error.message : String(error);
      showToast(`فشل تنفيذ العملية: ${msg}`);
      handleFirestoreError(error, OperationType.WRITE, 'boards');
    }
  };

  const handleDeleteBoard = async (board: Board) => {
    try {
      // 1. Fetch posts of the board
      const { collection, query, where, getDocs } = await import('firebase/firestore');
      const q = query(collection(db, 'posts'), where('boardId', '==', board.id));
      const querySnapshot = await getDocs(q);
      const postsList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as any[];
      
      // 2. Import moveBoardToRecycleBin and call it
      const { moveBoardToRecycleBin } = await import('../lib/recycle-bin');
      await moveBoardToRecycleBin(board, postsList);
      
      onSelectBoard(null);
      showToast('تم نقل اللوحة وجميع منشوراتها بنجاح إلى سلة المحذوفات! 🗑️');
    } catch (err: any) {
      console.error('Failed to delete board:', err);
      showToast('حدث خطأ أثناء حذف اللوحة: ' + (err.message || err));
    }
  };

  return (
    <>
      <header className={`sticky top-0 z-40 w-full border-b backdrop-blur-md shadow-sm shrink-0 transition-colors ${isDarkMode ? 'border-[#2C374E] bg-[#1A212E]/80' : 'border-natural-border bg-white/80'}`}>
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-1 relative">
          
          {/* Left Side: Settings Menu Button */}
          <button 
            onClick={() => setIsSidebarOpen(true)}
            className={`px-3 py-1 rounded-lg  transition-all z-10 cursor-pointer flex items-center justify-center h-8 whitespace-nowrap ${
              isDarkMode 
                ? 'text-emerald-50 ' 
                : 'text-[#000000] bg-[#ffffff] hover:bg-[#ffffff] hover:text-[#166534] '
            }`}
            title="الأدوات"
          >
            <Menu size={25} className={isDarkMode ? 'text-emerald-50' : 'text-[#15803d]'} />
          </button>

          {/* Absolute Centered Logo/Name */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-2 pointer-events-auto cursor-pointer" onClick={() => setIsTranslatorOpen(true)}>
              <div className="flex h-8 w-10 items-center justify-center overflow-hidden rounded-sm bg-natural-primary shadow-xs">
                <img 
                  src="/logo.png" 
                  alt="JADGPT Logo" 
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="text-white font-black text-base">J</div>';
                  }}
                />
              </div>
              <h1 className={`text-lg sm:text-xl font-black tracking-tight ${
                isDarkMode 
                  ? 'bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent' 
                  : 'text-[#15803d]'
              }`}>
                JADGPT
              </h1>
            </div>
          </div>
          
          {/* Right Side: Boards Drawer Button */}
          <button 
            onClick={() => setIsBoardsDrawerOpen(true)}
            className={`px-2 py-1 text-[12px] sm:text-xs md:text-sm font-bold rounded-lg border shadow-xs transition-all z-10 cursor-pointer flex items-center justify-center h-8 whitespace-nowrap ${
              isDarkMode 
                ? 'text-[#16af75] bg-[#00000029] hover:bg-[#007662] border-[#6980b0] pulsate-btn-dark' 
                : 'text-[#c26700] bg-[#fffaf5] shadow-md hover:bg-[#fef3e6] hover:border-[#c26700]/40 border border-[#cbd5e1] pulsate-btn-light'
            }`}
            title="لوحات كاملة"
          >
            لوحات كاملة
          </button>

        </div>
      </header>

      {/* Boards Drawer (Slides in from the right) */}
      <AnimatePresence>
        {isBoardsDrawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsBoardsDrawerOpen(false)}
              className="fixed inset-0 z-[1000] bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
              className={`fixed inset-y-0 right-0 z-[1001] w-72 sm:w-96 shadow-2xl transition-colors border-l ${
                isDarkMode 
                  ? "bg-[#151D2A] text-white border-[#2C374E]" 
                  : "bg-white text-natural-text border-natural-border"
              }`}
              dir="rtl"
            >
              <div className="flex flex-col h-full">
                {/* Header */}
                <div className={`relative flex items-center justify-center py-2.5 px-3 border-b transition-colors ${
                  isDarkMode 
                    ? "border-[#2C374E] bg-[#111822]" 
                    : "border-natural-border/40 bg-neutral-50/50"
                }`}>
                  <h2 className={`text-sm font-black text-center ${isDarkMode ? "text-white" : "text-[#3A3A28]"}`}>الأقسام واللوحات</h2>
                  <button 
                    onClick={() => setIsBoardsDrawerOpen(false)}
                    className={`absolute right-2.5 p-1.5 rounded-lg transition-colors cursor-pointer ${
                      isDarkMode ? "text-[#B4C6D8] hover:bg-[#1A212E]" : "text-natural-muted hover:bg-neutral-100"
                    }`}
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 overscroll-contain">
                  {/* Search Box in place of subtitle */}
                  <div className="relative mb-3">
                    <input
                      type="text"
                      value={boardsSearchQuery}
                      onChange={(e) => setBoardsSearchQuery(e.target.value)}
                      placeholder="بحث في الأقسام واللوحات..."
                      className={`w-full rounded-xl border py-2 pr-9 pl-8 text-xs font-bold transition-all focus:outline-none focus:ring-1 ${
                        isDarkMode
                          ? "border-[#2C374E] bg-[#111822] text-white placeholder-gray-500 focus:border-[#008D75] focus:ring-[#008D75]"
                          : "border-natural-border bg-white text-natural-text placeholder-gray-400 focus:border-natural-primary focus:ring-natural-primary"
                      }`}
                    />
                    <Search
                      size={15}
                      className={`absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none ${
                        isDarkMode ? "text-gray-400" : "text-gray-500"
                      }`}
                    />
                    {boardsSearchQuery && (
                      <button
                        onClick={() => setBoardsSearchQuery("")}
                        className={`absolute left-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md transition-colors cursor-pointer ${
                          isDarkMode ? "text-gray-400 hover:text-white" : "text-gray-500 hover:text-gray-800"
                        }`}
                        title="مسح البحث"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {/* Main Feed option */}
                    {(!boardsSearchQuery.trim() || "الرئيسية".includes(boardsSearchQuery.trim()) || "home".includes(boardsSearchQuery.toLowerCase().trim())) && (
                      <button
                        onClick={() => {
                          setIsBoardsDrawerOpen(false);
                          setBoardsSearchQuery("");
                          onSelectBoard(null);
                        }}
                        className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                          currentBoard === undefined && activeBoardId !== "prompt-builder" && activeBoardId !== "user-board"
                            ? (isDarkMode 
                                ? "bg-[#008D75] border-[#008D75] text-white shadow-md font-normal" 
                                : "bg-natural-primary border-natural-primary text-white shadow-md font-normal")
                            : (isDarkMode
                                ? "bg-[#111822] border-[#2C374E] hover:bg-[#1A212E] text-white font-normal"
                                : "bg-white border-natural-border hover:bg-natural-secondary-bg text-natural-text font-normal")
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-lg">🏡</span>
                          <span>الرئيسية</span>
                        </span>
                        {currentBoard === undefined && activeBoardId !== "prompt-builder" && activeBoardId !== "user-board" && (
                          <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                        )}
                      </button>
                    )}

                    {/* Dynamic Boards */}
                    {(() => {
                      const visibleBoards = (isAdmin ? boards : boards.filter(b => !b.hidden));
                      const queryClean = boardsSearchQuery.trim().toLowerCase();
                      const filteredBoards = queryClean
                        ? visibleBoards.filter(b => 
                            b.name.toLowerCase().includes(queryClean) ||
                            b.subBoards?.some(sub => sub.name.toLowerCase().includes(queryClean))
                          )
                        : visibleBoards;

                      if (filteredBoards.length === 0 && queryClean && !"الرئيسية".includes(queryClean) && !"home".includes(queryClean)) {
                        return (
                          <div className={`p-6 text-center text-xs font-bold rounded-2xl border ${
                            isDarkMode ? "bg-[#111822] border-[#2C374E] text-gray-400" : "bg-neutral-50 border-natural-border/60 text-natural-muted"
                          }`}>
                            <p className="text-base mb-1">🔍</p>
                            <span>لا توجد أقسام أو لوحات مطابقة لـ "${boardsSearchQuery}"</span>
                          </div>
                        );
                      }

                      return filteredBoards.map((board) => {
                        const isSelected = currentBoard?.id === board.id;
                        return (
                          <button
                            key={board.id}
                            onClick={() => {
                              setIsBoardsDrawerOpen(false);
                              setBoardsSearchQuery("");
                              onSelectBoard(board.id);
                            }}
                            className={`w-full flex items-center justify-between p-3 rounded-2xl border text-right transition-all cursor-pointer ${
                              isSelected
                                ? (isDarkMode 
                                    ? "bg-[#008D75] border-[#008D75] text-white shadow-md font-normal" 
                                    : "bg-natural-primary border-natural-primary text-white shadow-md font-normal")
                                : (isDarkMode
                                    ? "bg-[#111822] border-[#2C374E] hover:bg-[#1A212E] text-white font-normal"
                                    : "bg-white border-natural-border hover:bg-natural-secondary-bg text-natural-text font-normal")
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <span className="text-lg">{board.locked ? "🔒" : "📁"}</span>
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
                      });
                    })()}
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 z-[1000] bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
              className={`fixed inset-y-0 left-0 z-[1001] w-72 shadow-2xl transition-colors border-r ${
                isDarkMode 
                  ? 'bg-[#151D2A] text-white border-[#2C374E]' 
                  : 'bg-white text-natural-text border-natural-border'
              }`}
              dir="rtl"
            >
              <div className="flex flex-col h-full">
                {/* Sidebar Header */}
                <div className={`relative flex items-center justify-center py-2.5 px-3 border-b transition-colors ${
                  isDarkMode 
                    ? 'border-[#2C374E] bg-[#111822]' 
                    : 'border-natural-border/40 bg-neutral-50/50'
                }`}>
                  <h2 className={`text-sm font-black text-center ${isDarkMode ? 'text-white' : 'text-[#3A3A28]'}`}>القائمة</h2>
                  <button 
                    onClick={() => setIsSidebarOpen(false)}
                    className={`absolute left-2.5 p-1.5 rounded-lg transition-colors cursor-pointer ${
                      isDarkMode ? 'text-[#B4C6D8] hover:bg-[#1A212E]' : 'text-natural-muted hover:bg-neutral-100'
                    }`}
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Sidebar Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {user ? (
                    <div className="space-y-3">
                      {/* User Info */}
                      <div className="flex flex-col items-center text-center space-y-2">
                        <div>
                          <p className={`text-base font-bold ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>{user.displayName}</p>
                          <p className={`text-xs ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>{user.email}</p>
                        </div>
                        {userLicense?.activated === true && (
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-black transition-colors ${
                            isDarkMode 
                              ? 'bg-[#008D75]/15 text-[#00C4A3]' 
                              : 'bg-[#e6f4ea] text-[#008D75]'
                          }`}>
                            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse"></span>
                            مشترك بنسخة كاملة
                          </span>
                        )}
                        <div className="flex items-center justify-center gap-2 flex-wrap pt-0.5">
                          {isAdmin && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                              isDarkMode 
                                ? 'bg-[#F9F3DC] text-[#ca3500]' 
                                : 'bg-[#e6f4ea] text-[#ca3500]'
                            }`}>
                              <ShieldCheck size={12} /> المسؤول
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={handleRenewAuth}
                            disabled={isRenewingAuth}
                            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-all cursor-pointer bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 active:scale-95 border border-amber-500/20"
                            title="تجديد صلاحية الوصول وتسجيل الدخول كأدمن ببريد غوغل الرسمي"
                          >
                            <RefreshCw size={11} className={isRenewingAuth ? "animate-spin" : ""} />
                            {isRenewingAuth ? 'جاري التجديد...' : 'تجديد الصلاحية'}
                          </button>
                        </div>
                      </div>

                      {/* Dark Mode Switch */}
                      <div className={`flex items-center justify-between w-full p-3 rounded-2xl border transition-all ${
                        isDarkMode 
                          ? 'bg-[#111822] border-[#2C374E] text-white' 
                          : 'bg-[#FAF9F5] border-natural-border text-natural-text'
                      }`}>
                        <div className="flex items-center gap-2 font-sans">
                          {isDarkMode ? <Moon size={16} className="text-[#EEA396]" /> : <Sun size={16} className="text-[#008D75]" />}
                          <span className="text-xs font-black">المظهر الداكن</span>
                        </div>
                        <button
                          onClick={() => setIsDarkMode(!isDarkMode)}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            isDarkMode ? 'bg-[#008D75]' : 'bg-[#414C5D]/30'
                          }`}
                          dir="ltr"
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                              isDarkMode ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>

                      {/* Notifications Switch */}
                      {isNotificationSupported() && (
                        <div className={`flex flex-col gap-0 w-full p-3 rounded-2xl border transition-all ${
                          isDarkMode 
                            ? 'bg-[#111822] border-[#2C374E] text-white' 
                            : 'bg-[#FAF9F5] border-natural-border text-natural-text'
                        }`}>
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center gap-2 font-sans">
                              {notificationPermission === 'granted' ? (
                                <Bell size={16} className="text-[#008D75]" />
                              ) : (
                                <BellOff size={16} className="text-natural-muted" />
                              )}
                              <span className="text-xs font-black">إشعارات التطبيق</span>
                            </div>
                            <button
                              onClick={async () => {
                                if (notificationPermission === 'granted') {
                                  showToast('ℹ️ لتعديل الإشعارات أو إيقافها، يرجى تعديلها من إعدادات المتصفح أو الهاتف.');
                                  return;
                                }
                                const perm = await requestNotificationPermission();
                                setNotificationPermission(perm);
                              }}
                              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                notificationPermission === 'granted' ? 'bg-[#008D75]' : 'bg-[#414C5D]/30'
                              }`}
                              dir="ltr"
                            >
                              <span
                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                                  notificationPermission === 'granted' ? 'translate-x-5' : 'translate-x-0'
                                }`}
                              />
                            </button>
                          </div>
                          
                          <p className={`text-[9px] text-right font-bold leading-relaxed ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>
                            {notificationPermission === 'granted' 
                              ? 'الإشعارات مفعلة وتعمل تلقائياً✅'
                              : 'اضغط لتفعيل الإشعارات على أيقونة التطبيق'
                            }
                          </p>
                        </div>
                      )}

                      <div className="space-y-2">
                        {/* Always available tool for all logged-in users */}
                              <div className="flex items-center justify-between gap-2 w-full">
                            {/* Button 1: تعديل النص */}
                            <button
                              onClick={() => {
                                localStorage.removeItem('shared_text_editor_post_id');
                                setIsSidebarOpen(false);
                                setIsTranslatorOpen(true);
                                window.dispatchEvent(new CustomEvent('check_text_editor_text', { detail: { text: null, postId: null } }));
                              }}
                              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl transition-all border border-dashed text-xs font-bold cursor-pointer ${
                                isDarkMode 
                                  ? 'border-[#2C374E] text-white hover:bg-[#111822] hover:border-[#008D75]' 
                                  : 'border-natural-border text-natural-text hover:bg-natural-secondary-bg hover:border-natural-primary'
                              }`}
                            >
                              <Edit size={16} className={`${isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} animate-pulse`} />
                              <span className="whitespace-nowrap">تعديل النص</span>
                            </button>

                            {/* Button 2: حجم النصوص */}
                            <div className="relative flex-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setIsTextSizeMenuOpen(!isTextSizeMenuOpen);
                                }}
                                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl transition-all border border-dashed text-xs font-bold cursor-pointer ${
                                  isDarkMode
                                    ? (isTextSizeMenuOpen ? 'border-[#008D75] bg-[#111822] text-white' : 'border-[#2C374E] text-white hover:bg-[#111822]')
                                    : (isTextSizeMenuOpen ? 'border-natural-primary bg-natural-secondary-bg text-natural-text' : 'border-natural-border text-natural-text hover:bg-natural-secondary-bg hover:border-natural-primary')
                                }`}
                              >
                                <Type size={16} className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} />
                                <span className="whitespace-nowrap">حجم النصوص</span>
                              </button>

                              <AnimatePresence>
                                {isTextSizeMenuOpen && (
                                  <motion.div
                                    initial={{ opacity: 0, scale: 0.95, y: 5 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.95, y: 5 }}
                                    className={`absolute left-0 mt-1.5 z-50 min-w-[130px] border rounded-xl shadow-md p-2 flex items-center justify-between gap-2 transition-colors ${
                                      isDarkMode ? 'bg-[#111822] border-[#2C374E] text-white' : 'bg-white border-natural-border text-natural-text'
                                    }`}
                                    onClick={(e) => e.stopPropagation()}
                                    dir="ltr"
                                  >
                                    <button
                                      onClick={handleDecreaseFontSize}
                                      className={`w-7 h-7 flex items-center justify-center rounded-lg font-black transition-colors cursor-pointer text-sm ${
                                        isDarkMode ? 'bg-[#1A212E] hover:bg-[#151D2A] text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-natural-text'
                                      }`}
                                      title="تصغير"
                                    >
                                      -
                                    </button>
                                    <span className={`text-xs font-bold font-mono ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>
                                      {postFontSize}px
                                    </span>
                                    <button
                                      onClick={handleIncreaseFontSize}
                                      className={`w-7 h-7 flex items-center justify-center rounded-lg font-black transition-colors cursor-pointer text-sm ${
                                        isDarkMode ? 'bg-[#1A212E] hover:bg-[#151D2A] text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-natural-text'
                                      }`}
                                      title="تكبير"
                                    >
                                      +
                                    </button>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          </div>
                        </div>

                        {isAdmin && (
                          <div className={`space-y-2 w-full p-1 rounded-xl border border-solid transition-all duration-200 hover:border-dashed ${
                            isDarkMode 
                              ? 'border-[#2C374E] hover:border-[#008D75]' 
                              : 'border-[#efece1] hover:border-[#4A4A35] bg-[#FAF9F5]'
                          }`}>
                            {/* Toggle Button for Boards Management */}
                            <button
                              type="button"
                              onClick={() => setIsBoardsManagerOpen(!isBoardsManagerOpen)}
                              className={`flex w-full items-center justify-between p-2 rounded-xl transition-colors cursor-pointer text-right ${
                                isDarkMode ? 'hover:bg-[#111822] text-white' : ' text-natural-text'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <LayoutGrid size={16} className={`${isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} animate-pulse`} />
                                <span className={`text-sm font-black ${isDarkMode ? 'text-white' : 'text-[#4A4A35]'}`}>إدارة اللوحات</span>
                              </div>
                              {isBoardsManagerOpen ? (
                                <ChevronUp size={16} className="text-natural-muted" />
                              ) : (
                                <ChevronDown size={16} className="text-natural-muted" />
                              )}
                            </button>

                            {/* Collapsible Content */}
                            <AnimatePresence>
                              {isBoardsManagerOpen && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{ duration: 0.2 }}
                                  className="overflow-hidden space-y-2.5 pr-2 pl-1"
                                >
                                  {/* Quick Actions */}
                                  <div className="flex gap-2 mb-2 pt-1">
                                    <button
                                      onClick={() => {
                                        setModalState({ isOpen: true, type: 'create', targetBoard: undefined });
                                      }}
                                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
                                        isDarkMode 
                                          ? 'bg-[#111822] border-[#2C374E] text-white hover:bg-[#1A212E]' 
                                          : 'bg-[#FAF9F5] hover:bg-[#F4F4EB] text-natural-primary border border-natural-border/60'
                                      }`}
                                    >
                                      <PlusCircle size={14} />
                                      <span>لوحة جديدة</span>
                                    </button>
                                    <button
                                      onClick={() => {
                                        setModalState({ isOpen: true, type: 'reorder', targetBoard: undefined });
                                      }}
                                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
                                        isDarkMode 
                                          ? 'bg-[#111822] border-[#2C374E] text-white hover:bg-[#1A212E]' 
                                          : 'bg-[#FAF9F5] hover:bg-[#F4F4EB] text-natural-primary border border-natural-border/60'
                                      }`}
                                    >
                                      <LayoutGrid size={14} />
                                      <span>ترتيب اللوحات</span>
                                    </button>
                                  </div>

                                  {/* Boards List */}
                                  <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                                    {boards.map((b) => (
                                      <div
                                        key={b.id}
                                        className="flex items-center justify-between p-2 rounded-xl border border-natural-border bg-[#FAF9F5]/60 hover:bg-[#FAF9F5] hover:border-natural-primary/30 transition-all gap-2"
                                      >
                                        <span className="text-[13px] font-bold text-[#4A4A35] truncate flex-1 text-right flex items-center gap-1">
                                          {b.locked && <span className="text-xs shrink-0 select-none">🔒</span>}
                                          {b.hidden && <span className="text-xs shrink-0 select-none text-red-600 font-bold" title="مخفية للـ Admin فقط">👁️‍🗨️</span>}
                                          <span>{b.name}</span>
                                        </span>
                                        
                                        <div className="flex items-center gap-1 shrink-0">
                                          {/* Edit Name Button */}
                                          <button
                                            onClick={() => {
                                              setModalState({ isOpen: true, type: 'edit', targetBoard: b });
                                            }}
                                            className="p-1 text-natural-primary hover:bg-white hover:text-[#4A4A35] rounded-md border border-transparent hover:border-natural-border transition-all cursor-pointer"
                                            title="تعديل الاسم"
                                          >
                                            <Edit size={14} />
                                          </button>
                                          
                                          {/* Delete Button */}
                                          <button
                                            onClick={() => {
                                              setBoardToDelete(b);
                                            }}
                                            className="p-1 text-red-500 hover:bg-red-50 hover:text-red-700 rounded-md border border-transparent hover:border-red-200 transition-all cursor-pointer"
                                            title="حذف اللوحة"
                                          >
                                            <Trash2 size={14} />
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        )}

                        {isAdmin && globalSettings && onUpdateSettings && (
                          <div className="w-full">
                            <OwnerLicensePanel 
                              currentSettings={globalSettings} 
                              onUpdateSettings={onUpdateSettings} 
                              compact={true} 
                              isDarkMode={isDarkMode}
                            />
                          </div>
                        )}

                        {isAdmin && (
                          <div className={`space-y-2 w-full pt-0 ${isDarkMode ? 'border-[#2C374E]' : 'border-natural-border'}`}>
                            
                            <button
                              onClick={() => {
                                setIsSidebarOpen(false);
                                setIsRecycleBinOpen(true);
                              }}
                              className={`flex w-full items-center gap-3 p-2 rounded-xl transition-all border cursor-pointer shadow-sm font-black ${
                                isDarkMode 
                                  ? 'bg-[#1C1517] hover:bg-[#2A1D1F] text-red-400 border-red-900 border-dashed hover:border-dashed hover:border-red-500/50' 
                                  : 'bg-red-50/80 hover:bg-red-100 text-red-700 border-red-100 hover:border-dashed hover:border-red-300'
                              }`}
                            >
                              <Trash2 size={18} className="text-red-500 animate-pulse" />
                              <span className="text-sm">المحذوفات</span>
                            </button>
                          </div>
                        )}
                        
                        {renderApiKeySection()}

                        <button
                          onClick={handleLogout}
                          className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 p-4 text-sm font-bold text-red-600 transition-all hover:bg-red-100 active:scale-95"
                        >
                          <LogOut size={18} />
                          تسجيل الخروج
                        </button>
                      </div>
                  ) : (
                    <div className="flex flex-col items-center w-full space-y-3 text-center py-3">
                      <button
                        onClick={handleLogin}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-natural-primary p-4 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#4A4A35] active:scale-95 cursor-pointer"
                      >
                        <LogIn size={16} />
                        تسجيل الدخول عبر غوغل
                      </button>

                      {/* Dark Mode Switch for Guests */}
                      <div className={`flex items-center justify-between w-full p-3 rounded-2xl border transition-all ${
                        isDarkMode 
                          ? 'bg-[#111822] border-[#2C374E] text-white' 
                          : 'bg-[#FAF9F5] border-natural-border text-natural-text'
                      }`}>
                        <div className="flex items-center gap-2 font-sans">
                          {isDarkMode ? <Moon size={16} className="text-[#EEA396]" /> : <Sun size={16} className="text-[#008D75]" />}
                          <span className="text-xs font-black">المظهر الداكن</span>
                        </div>
                        <button
                          onClick={() => setIsDarkMode(!isDarkMode)}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            isDarkMode ? 'bg-[#008D75]' : 'bg-[#414C5D]/30'
                          }`}
                          dir="ltr"
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                              isDarkMode ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>

                      {/* Notifications Switch for Guests */}
                      {isNotificationSupported() && (
                        <div className={`flex flex-col gap-1.5 w-full p-3 rounded-2xl border transition-all ${
                          isDarkMode 
                            ? 'bg-[#111822] border-[#2C374E] text-white' 
                            : 'bg-[#FAF9F5] border-natural-border text-natural-text'
                        }`}>
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center gap-2 font-sans">
                              {notificationPermission === 'granted' ? (
                                <Bell size={16} className="text-[#008D75]" />
                              ) : (
                                <BellOff size={16} className="text-natural-muted" />
                              )}
                              <span className="text-xs font-black">إشعارات التطبيق</span>
                            </div>
                            <button
                              onClick={async () => {
                                if (notificationPermission === 'granted') {
                                  showToast('ℹ️ لتعديل أذونات الإشعارات أو إيقافها، الدخول لإعدادات المتصفح أو الهاتف.');
                                  return;
                                }
                                const perm = await requestNotificationPermission();
                                setNotificationPermission(perm);
                              }}
                              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                notificationPermission === 'granted' ? 'bg-[#008D75]' : 'bg-[#414C5D]/30'
                              }`}
                              dir="ltr"
                            >
                              <span
                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                                  notificationPermission === 'granted' ? 'translate-x-5' : 'translate-x-0'
                                }`}
                              />
                            </button>
                          </div>
                          
                          <p className={`text-[9px] text-right font-bold leading-relaxed ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>
                            {notificationPermission === 'granted' 
                              ? 'إشعارات الهاتف  مفعلة✅'
                              : 'اضغط لتفعيل الإشعارات'
                            }
                          </p>
                        </div>
                      )}

                      {/* Tool Button for Guests as well */}
                      <div className={`w-full pt-2 border-t space-y-2 ${isDarkMode ? 'border-[#2C374E]' : 'border-natural-border'}`}>
                        <h4 className={`text-[10px] font-bold uppercase tracking-widest text-right ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>الأدوات العامة</h4>
                        <div className="flex items-center justify-between gap-2 w-full">
                          {/* Button 1: تعديل النص */}
                          <button
                            onClick={() => {
                              localStorage.removeItem('shared_text_editor_post_id');
                              setIsSidebarOpen(false);
                              setIsTranslatorOpen(true);
                              window.dispatchEvent(new CustomEvent('check_text_editor_text', { detail: { text: null, postId: null } }));
                            }}
                            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl transition-all border border-dashed text-xs font-bold cursor-pointer ${
                              isDarkMode 
                                ? 'border-[#2C374E] text-white hover:bg-[#111822] hover:border-[#008D75]' 
                                : 'border-natural-border text-natural-text hover:bg-natural-secondary-bg hover:border-natural-primary'
                            }`}
                          >
                            <Edit size={16} className={`${isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} animate-pulse`} />
                            <span className="whitespace-nowrap">تعديل النص</span>
                          </button>

                          {/* Button 2: حجم النصوص */}
                          <div className="relative flex-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setIsTextSizeMenuOpen(!isTextSizeMenuOpen);
                              }}
                              className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl transition-all border border-dashed text-xs font-bold cursor-pointer ${
                                isDarkMode
                                  ? (isTextSizeMenuOpen ? 'border-[#008D75] bg-[#111822] text-white' : 'border-[#2C374E] text-white hover:bg-[#111822]')
                                  : (isTextSizeMenuOpen ? 'border-natural-primary bg-natural-secondary-bg text-natural-text' : 'border-natural-border text-natural-text hover:bg-natural-secondary-bg hover:border-natural-primary')
                              }`}
                            >
                              <Type size={16} className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} />
                              <span className="whitespace-nowrap">حجم النصوص</span>
                            </button>

                            <AnimatePresence>
                              {isTextSizeMenuOpen && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, y: 5 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.95, y: 5 }}
                                  className={`absolute left-0 mt-1.5 z-50 min-w-[130px] border rounded-xl shadow-md p-2 flex items-center justify-between gap-2 transition-colors ${
                                    isDarkMode ? 'bg-[#111822] border-[#2C374E] text-white' : 'bg-white border-natural-border text-natural-text'
                                  }`}
                                  onClick={(e) => e.stopPropagation()}
                                  dir="ltr"
                                >
                                  <button
                                    onClick={handleDecreaseFontSize}
                                    className={`w-7 h-7 flex items-center justify-center rounded-lg font-black transition-colors cursor-pointer text-sm ${
                                      isDarkMode ? 'bg-[#1A212E] hover:bg-[#151D2A] text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-natural-text'
                                    }`}
                                    title="تصغير"
                                  >
                                    -
                                  </button>
                                  <span className={`text-xs font-bold font-mono ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>
                                    {postFontSize}px
                                  </span>
                                  <button
                                    onClick={handleIncreaseFontSize}
                                    className={`w-7 h-7 flex items-center justify-center rounded-lg font-black transition-colors cursor-pointer text-sm ${
                                      isDarkMode ? 'bg-[#1A212E] hover:bg-[#151D2A] text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-natural-text'
                                    }`}
                                    title="تكبير"
                                  >
                                    +
                                  </button>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>
                      </div>

                      {renderApiKeySection()}
                    </div>
                  )}
                </div>

                {/* Sidebar Footer */}
                <div className="p-6 text-center border-t border-natural-border">
                  <p className="text-[10px] text-natural-muted uppercase tracking-widest">JADGPT CMS v1.7</p>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <BoardModals
        isOpen={modalState.isOpen}
        type={modalState.type}
        board={modalState.targetBoard || currentBoard}
        boards={boards}
        onClose={() => setModalState({ ...modalState, isOpen: false })}
        onSubmit={handleBoardSubmit}
      />

      <TextEditorModal
        isOpen={isTranslatorOpen}
        onClose={() => setIsTranslatorOpen(false)}
        isAdmin={isAdmin}
        activeBoardId={currentBoard?.id || null}
        boards={boards}
        user={user}
        onSelectBoard={onSelectBoard}
        isDarkMode={isDarkMode}
      />

      <RecycleBinModal
        isOpen={isRecycleBinOpen}
        onClose={() => setIsRecycleBinOpen(false)}
      />

      {/* Board Deletion Custom Confirmation Modal (Iframe Safe) */}
      <AnimatePresence>
        {boardToDelete && (
          <div className="fixed inset-0 z-[2600] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setBoardToDelete(null)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 text-right z-10 border border-red-100"
              dir="rtl"
            >
              <div className="flex items-center gap-2 text-red-600 pb-3 border-b border-neutral-100 mb-4">
                <AlertTriangle size={24} className="text-red-500 animate-pulse" />
                <h4 className="text-base font-black text-red-700">تنبيه أمان صارم! ⚠️</h4>
              </div>

              <div className="space-y-3 mb-6">
                <p className="text-xs text-natural-text leading-relaxed font-bold">
                  هل أنت متأكد من نقل لوحة <span className="font-black text-red-600 bg-red-50 px-1.5 py-0.5 rounded">"{boardToDelete.name}"</span> مع جميع منشوراتها ونقلها إلى سلة المحذوفات؟
                </p>
                <p className="text-[10px] text-natural-muted leading-relaxed font-medium">
                  * سيتم نقل اللوحة مع جميع محتوياتها مؤقتاً إلى سلة المحذوفات ويمكنك استعادتها من هناك لاحقاً إذا أردت.
                </p>
              </div>

              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  disabled={isDeletingBoard}
                  onClick={() => setBoardToDelete(null)}
                  className="px-4 py-2.5 rounded-xl border border-natural-border text-xs font-bold text-natural-text hover:bg-neutral-50 transition-colors cursor-pointer"
                >
                  إلغاء الأمر
                </button>
                <button
                  type="button"
                  disabled={isDeletingBoard}
                  onClick={async () => {
                    setIsDeletingBoard(true);
                    try {
                      await handleDeleteBoard(boardToDelete);
                    } finally {
                      setIsDeletingBoard(false);
                      setBoardToDelete(null);
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-700 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer flex items-center justify-center gap-1.5"
                >
                  {isDeletingBoard ? 'جاري النقل...' : 'نعم، انقل لسلة المحذوفات 🗑️'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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
    </>
  );
}
