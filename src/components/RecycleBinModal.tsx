import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';
import { X, Trash2, RotateCcw, FileText, Image as ImageIcon, LayoutGrid, AlertTriangle, Sparkles, Folder, Volume2, Video, FileSpreadsheet } from 'lucide-react';
import { restoreRecycleBinItem, deleteRecycleBinItemPermanently, emptyRecycleBin } from '../lib/recycle-bin';
import { getAccessToken } from '../lib/auth';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';
import { showToast } from './Toast';

function isPostUrlAnImage(post: any, url: string, index: number): boolean {
  if (!post) return false;
  const type = post.fileTypes?.[index];
  if (type) {
    return type.startsWith('image/');
  }
  const name = post.fileNames?.[index];
  if (name) {
    return /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(name);
  }
  if (url.includes('drive.google.com/thumbnail') || url.includes('/thumbnail?id=')) {
    return true;
  }
  if (url.startsWith('data:image/')) {
    return true;
  }
  return /\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)/i.test(url);
}

function getPostInfo(post: any) {
  if (!post) return { label: 'منشور مصور', icon: <ImageIcon size={18} className="text-purple-500" /> };
  
  const types = post.fileTypes || [];
  const names = post.fileNames || [];
  const urls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
  
  const hasAudio = types.some((t: string) => t.startsWith('audio/')) || 
                    names.some((n: string) => /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(n)) ||
                    urls.some((url: string, idx: number) => {
                      const name = names[idx] || '';
                      const type = types[idx] || '';
                      const isImg = isPostUrlAnImage(post, url, idx);
                      return !isImg && (
                        type.startsWith('audio/') || 
                        /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(name) ||
                        /\.(mp3|wav|ogg|m4a|aac|webm)/i.test(url)
                      );
                    });
                    
  if (hasAudio) {
    return { label: 'منشور صوتي 🎙️', icon: <Volume2 size={18} className="text-emerald-600 animate-pulse" /> };
  }
  
  const hasVideo = types.some((t: string) => t.startsWith('video/')) || 
                    names.some((n: string) => /\.(mp4|mov|avi|mkv|webm)$/i.test(n)) ||
                    urls.some((url: string, idx: number) => {
                      const name = names[idx] || '';
                      const type = types[idx] || '';
                      const isImg = isPostUrlAnImage(post, url, idx);
                      return !isImg && (
                        type.startsWith('video/') || 
                        /\.(mp4|mov|avi|mkv|webm)$/i.test(name) ||
                        /\.(mp4|mov|avi|mkv|webm)/i.test(url)
                      );
                    });
                    
  if (hasVideo) {
    return { label: 'منشور مرئي 🎥', icon: <Video size={18} className="text-amber-500" /> };
  }

  const hasDocs = types.some((t: string) => !t.startsWith('image/')) || 
                   names.some((n: string) => !/\.(jpeg|jpg|gif|png|webp|bmp|svg|tiff)$/i.test(n)) ||
                   urls.some((url: string, idx: number) => !isPostUrlAnImage(post, url, idx));
                   
  if (hasDocs && urls.length > 0) {
    return { label: 'منشور يحتوي على ملفات 📂', icon: <FileSpreadsheet size={18} className="text-blue-500" /> };
  }
  
  return { label: 'منشور مصور', icon: <ImageIcon size={18} className="text-purple-500" /> };
}

interface RecycleBinModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function RecycleBinModal({ isOpen, onClose }: RecycleBinModalProps) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmptyOpen, setConfirmEmptyOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<any | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    const q = query(collection(db, 'recycle_bin'), orderBy('deletedAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetched = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setItems(fetched);
      setLoading(false);
    }, (error) => {
      console.error('Error fetching recycle bin:', error);
      setLoading(false);
    });

    return unsubscribe;
  }, [isOpen]);

  // Back gesture / browser back history integration to close modal without exiting the app
  useEffect(() => {
    if (!isOpen) return;

    const modalState = { modalId: 'recycle-bin-' + Date.now() };
    window.history.pushState(modalState, '');

    const handlePopState = (e: PopStateEvent) => {
      onClose();
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (window.history.state && window.history.state.modalId === modalState.modalId) {
        window.history.back();
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleRestore = async (item: any) => {
    setActionLoading(item.id);
    try {
      await restoreRecycleBinItem(item);
      showToast('🔄 تم استعادة العنصر بنجاح إلى مكانه الأصلي!');
    } catch (err: any) {
      showToast('⚠️ فشل في استعادة العنصر: ' + (err.message || err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeletePermanently = (item: any) => {
    setItemToDelete(item);
  };

  const handleEmptyTrash = async () => {
    setActionLoading('empty-all');
    try {
      const token = getAccessToken();
      await emptyRecycleBin(items, token);
      showToast('🧹 تم إفراغ سلة المحذوفات بالكامل بنجاح!');
      setConfirmEmptyOpen(false);
    } catch (err: any) {
      showToast('⚠️ فشل في إفراغ السلة: ' + (err.message || err));
    } finally {
      setActionLoading(null);
    }
  };

  const formatDeletedAt = (timestamp: any) => {
    if (!timestamp) return 'الآن';
    try {
      const dateObj = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
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
    } catch {
      return 'تاريخ غير صالح';
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        />

        {/* Modal Container */}
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 15 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 15 }}
          className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden border border-natural-border flex flex-col max-h-[85vh]"
          dir="rtl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-2 py-2 border-b border-natural-border/60 bg-neutral-50/50">
            <div className="flex items-center gap-1 text-natural-primary">
              <Trash2 className="text-red-500 animate-bounce" size={20} />
              <h3 className="text-lg font-black text-[#4A4A35]">لوحة الإدارة</h3>
            </div>
            
            <div className="flex items-center gap-4">
              {items.length > 0 && (
                <button
                  type="button"
                  disabled={actionLoading !== null}
                  onClick={() => setConfirmEmptyOpen(true)}
                  className="bg-red-50 text-red-700 hover:bg-red-100 font-bold text-xs pt-2 pr-3 pb-2 pl-3 rounded-xl border border-red-200/60 flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Trash2 size={13} />
                  <span>إفراغ السلة</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="pt-1 pr-3 pb-1 pl-2 text-natural-muted hover:bg-natural-secondary-bg rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Modal Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-natural-primary border-t-transparent" />
                <p className="text-xs text-natural-muted font-bold">جاري تحميل المحذوفات...</p>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#F4F4EB] text-natural-primary shadow-sm">
                  <Folder size={32} className="opacity-60" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-black text-natural-primary">سلة المحذوفات فارغة حالياً 🌱</p>
                  <p className="text-xs text-natural-muted leading-relaxed max-w-md">
                    عند قيامك بحذف أي منشور، أو نص أصلي في صانع البرومبت، أو لوحة تبويب كاملة، سيتم إرسالها إلى هنا مؤقتاً لتتمكن من استرجاعها أو حذفها نهائياً.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="group border border-natural-border/60 hover:border-natural-primary/30 rounded-2xl p-4 bg-white hover:bg-neutral-50/20 transition-all shadow-sm flex flex-col gap-3 relative"
                  >
                    {/* Item Header Info */}
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-0">
                        <div className="p-1 rounded-xl bg-[#F4F4EB] text-natural-primary shrink-0">
                          {item.type === 'prompt' && <FileText size={18} />}
                          {item.type === 'post' && getPostInfo(item.data?.post).icon}
                          {item.type === 'board' && <LayoutGrid size={18} />}
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-natural-primary">
                              {item.type === 'prompt' && 'نص برومبت أصلي'}
                              {item.type === 'post' && getPostInfo(item.data?.post).label}
                              {item.type === 'board' && 'لوحة تبويب كاملة'}
                            </span>
                            <span className="pt-1 text-[10px] text-natural-muted/800">
                             حُذف من {item.deletedFrom}
                            </span>
                          </div>
                          <p className="text-[10px] text-natural-muted/800 font-medium pr-3 mt-0.5">
                            {formatDeletedAt(item.deletedAt)}
                          </p>
                        </div>
                      </div>

                      {/* Item Actions */}
                      <div className="flex items-center pr-3 gap-1.5 self-center sm:self-auto shrink-0">
                        <button
                          type="button"
                          disabled={actionLoading !== null}
                          onClick={() => handleRestore(item)}
                          className="bg-natural-primary text-white hover:bg-[#4A4A35] font-bold text-xs px-3 py-2 rounded-xl flex items-center gap-1 shadow-sm transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                          title="استرجاع إلى المكان الأصلي"
                        >
                          <RotateCcw size={13} />
                          <span>استرجاع</span>
                        </button>
                        <button
                          type="button"
                          disabled={actionLoading !== null}
                          onClick={() => handleDeletePermanently(item)}
                          className="bg-white border border-red-200 text-red-600 hover:bg-red-50 font-bold text-xs px-3 py-2 rounded-xl flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                          title="حذف نهائي دون رجعة"
                        >
                          <Trash2 size={13} />
                          <span>حذف نهائي</span>
                        </button>
                      </div>
                    </div>

                    {/* Preview Area */}
                    <div className="border border-neutral-100 bg-[#FAF9F5] rounded-xl p-3.5 text-right text-xs leading-relaxed text-natural-text overflow-hidden">
                      {item.type === 'prompt' && (
                        <div className="space-y-1">
                          <p className="font-mono text-[11px] whitespace-pre-wrap text-[#5A5A40]">
                            {item.data?.promptText}
                          </p>
                          {item.data?.options && (
                            <div className="pt-2 border-t border-natural-border/20 mt-2 flex flex-wrap gap-1.5">
                              {Object.entries(item.data.options).map(([key, val]) => (
                                val && val !== 'يتبع الصورة المرجعية' && val !== 'حجم تلقائي' && (
                                  <span key={key} className="text-[9px] bg-white border border-natural-border/30 text-natural-muted px-1.5 py-0.5 rounded-md font-bold">
                                    {key}: {String(val)}
                                  </span>
                                )
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {item.type === 'post' && (
                        <div className="space-y-2">
                          <p className="whitespace-pre-wrap font-bold text-natural-text">
                            {item.data?.post?.text}
                          </p>
                          {/* Attachments (Separated into Images & Files) */}
                          {item.data?.post && (
                            <div className="space-y-2 pt-1">
                              {/* Images */}
                              {(() => {
                                const urls = item.data.post.imageUrls || (item.data.post.imageUrl ? [item.data.post.imageUrl] : []);
                                const imagesOnly = urls.filter((url: string, index: number) => isPostUrlAnImage(item.data.post, url, index));
                                if (imagesOnly.length === 0) return null;
                                return (
                                  <div className="flex flex-wrap gap-1.5">
                                    {imagesOnly.map((url: string, index: number) => (
                                      <div key={index} className="relative h-14 w-14 rounded-lg overflow-hidden border border-natural-border bg-white shadow-sm shrink-0">
                                        <img
                                          src={url}
                                          referrerPolicy="no-referrer"
                                          className="h-full w-full object-cover"
                                          alt="Preview"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                );
                              })()}

                              {/* Files / Audio */}
                              {(() => {
                                const urls = item.data.post.imageUrls || (item.data.post.imageUrl ? [item.data.post.imageUrl] : []);
                                const filesOnly = urls
                                  .map((url: string, index: number) => ({ url, index, name: item.data.post.fileNames?.[index], type: item.data.post.fileTypes?.[index] }))
                                  .filter(fileObj => !isPostUrlAnImage(item.data.post, fileObj.url, fileObj.index));
                                
                                if (filesOnly.length === 0) return null;
                                return (
                                  <div className="flex flex-col gap-1.5 border-t border-neutral-100 pt-2 mt-2">
                                    <span className="text-[10px] font-black text-amber-600 block">
                                      📎 المرفقات المحذوفة ({filesOnly.length}):
                                    </span>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                      {filesOnly.map((fileObj, idx) => {
                                        const isAudio = fileObj.type?.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(fileObj.name || '');
                                        const isApk = fileObj.name?.toLowerCase().endsWith('.apk') || fileObj.type?.includes('vnd.android.package-archive');
                                        return (
                                          <div
                                            key={idx}
                                            className="flex items-center gap-2 p-1.5 rounded-xl border border-natural-border/60 bg-white text-natural-text text-[11px]"
                                          >
                                            <span className="text-xl shrink-0">
                                              {isAudio ? '🎙️' : isApk ? '🤖' : '📄'}
                                            </span>
                                            <div className="flex-1 min-w-0 text-right">
                                              <p className="font-bold truncate text-[10px]" title={fileObj.name || 'ملف'}>
                                                {fileObj.name || 'ملف بدون اسم'}
                                              </p>
                                              <p className="text-[9px] text-natural-muted leading-none mt-0.5">
                                                {isAudio ? 'ملف صوتي' : isApk ? 'تطبيق أندرويد' : (fileObj.type || 'ملف')}
                                              </p>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      )}

                      {item.type === 'board' && (
                        <div className="space-y-1">
                          <p className="font-black text-sm text-natural-primary">
                            📁 {item.data?.board?.name}
                          </p>
                          <p className="text-[11px] text-natural-muted">
                            تحتوي هذه اللوحة على ({item.data?.posts?.length || 0}) من المنشورات المصاحبة التي سيتم استرجاعها معها تلقائياً.
                          </p>
                          {item.data?.posts && item.data.posts.length > 0 && (
                            <div className="flex flex-col gap-1.5 mt-2.5 pt-2 border-t border-natural-border/20">
                              <span className="text-[10px] font-black text-natural-muted">عينة من منشورات اللوحة:</span>
                              {item.data.posts.slice(0, 3).map((p: any, i: number) => (
                                <div key={i} className="bg-white/80 p-2 rounded-lg border border-neutral-100 text-[11px] text-natural-muted truncate">
                                  - {p.text}
                                </div>
                              ))}
                              {item.data.posts.length > 3 && (
                                <span className="text-[9px] text-natural-muted/60 pr-1">وغيرها من المنشورات...</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Confirmation Overlay for Empty Trash */}
      {confirmEmptyOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setConfirmEmptyOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 text-right z-10 border border-red-100"
            dir="rtl"
          >
            <div className="flex items-center gap-2 text-red-600 pb-3 border-b border-neutral-100 mb-4">
              <AlertTriangle size={24} className="text-red-500 animate-pulse" />
              <h4 className="text-base font-black">تحذير أمان صارم! ⚠️</h4>
            </div>
            
            <p className="text-xs text-natural-text leading-relaxed mb-6">
              هل أنت متأكد تماماً من **إفراغ سلة المحذوفات بالكامل**؟ 
              <br />
              <span className="font-black text-red-600">
                هذه الخطوة نهائية تماماً ولا يمكن الرجوع عنها مطلقاً! 
              </span>
              سيتم محو جميع النصوص والبيانات وملفات الصور المحفوظة في حساب Google Drive نهائياً وتفريغ المساحة المرتبطة بها.
            </p>

            <div className="flex gap-2.5 justify-end">
              <button
                type="button"
                disabled={actionLoading === 'empty-all'}
                onClick={handleEmptyTrash}
                className="bg-red-600 hover:bg-red-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-md transition-all active:scale-95 cursor-pointer disabled:opacity-50"
              >
                {actionLoading === 'empty-all' ? 'جاري الإفراغ...' : 'نعم، إفراغ السلة بالكامل 🧹'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmEmptyOpen(false)}
                className="bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold text-xs px-4 py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                تراجع
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Confirmation Overlay for Permanent Delete of Single Item */}
      {itemToDelete && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setItemToDelete(null)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 text-right z-10 border border-red-100"
            dir="rtl"
          >
            <div className="flex items-center gap-2 text-red-600 pb-3 border-b border-neutral-100 mb-4">
              <AlertTriangle size={24} className="text-red-500 animate-pulse" />
              <h4 className="text-base font-black">تأكيد الحذف النهائي! ⚠️</h4>
            </div>
            
            <p className="text-xs text-natural-text leading-relaxed mb-6">
              هل أنت متأكد تماماً من **حذف هذا العنصر نهائياً**؟
              <br />
              <span className="font-black text-red-600 mt-1 block">
                هذه الخطوة نهائية تماماً ولا يمكن الرجوع عنها مطلقاً!
              </span>
              سيتم مسح جميع النصوص والملفات والصور المرفقة المرتبطة بهذا العنصر من حساب Google Drive وتفريغ المساحة.
            </p>

            <div className="flex gap-2.5 justify-end">
              <button
                type="button"
                disabled={actionLoading !== null}
                onClick={async () => {
                  const item = itemToDelete;
                  setItemToDelete(null);
                  setActionLoading(item.id);
                  try {
                    const token = getAccessToken();
                    await deleteRecycleBinItemPermanently(item, token);
                    showToast('🗑️ تم الحذف النهائي بنجاح!');
                  } catch (err: any) {
                    showToast('⚠️ فشل في الحذف النهائي: ' + (err.message || err));
                  } finally {
                    setActionLoading(null);
                  }
                }}
                className="bg-red-600 hover:bg-red-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow-md transition-all active:scale-95 cursor-pointer"
              >
                {actionLoading === itemToDelete.id ? 'جاري الحذف...' : 'نعم، احذف نهائياً 🗑️'}
              </button>
              <button
                type="button"
                onClick={() => setItemToDelete(null)}
                className="bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold text-xs px-4 py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                تراجع
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
