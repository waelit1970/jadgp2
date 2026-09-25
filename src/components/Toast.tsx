import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Loader2, AlertCircle } from 'lucide-react';

export interface ToastEventDetail {
  message: string;
  duration?: number;
}

export function showToast(message: string, duration?: number) {
  const event = new CustomEvent<ToastEventDetail>('show-toast', {
    detail: { message, duration }
  });
  window.dispatchEvent(event);
}

export default function ToastContainer() {
  const [toast, setToast] = useState<{ message: string; id: number; isLoading?: boolean; isError?: boolean } | null>(null);

  useEffect(() => {
    let currentTimer: any = null;

    const handleToast = (e: Event) => {
      const customEvent = e as CustomEvent<ToastEventDetail>;
      const { message, duration } = customEvent.detail;
      const id = Date.now();
      
      const isLoading = message.includes('جاري') || message.includes('بدء تنزيل') || message.includes('📸') || message.includes('⏳') || message.includes('🔄');
      const isError = message.includes('خطأ') || message.includes('فشل') || message.includes('تعذر') || message.includes('❌') || message.includes('⚠️');

      // Loading messages stay active for up to 3 minutes unless superseded by another toast
      const effectiveDuration = duration !== undefined ? duration : (isLoading ? 180000 : 2800);

      if (currentTimer) {
        clearTimeout(currentTimer);
      }

      setToast({ message, id, isLoading, isError });

      currentTimer = setTimeout(() => {
        setToast((prev) => (prev?.id === id ? null : prev));
      }, effectiveDuration);
    };

    window.addEventListener('show-toast', handleToast);
    return () => {
      if (currentTimer) clearTimeout(currentTimer);
      window.removeEventListener('show-toast', handleToast);
    };
  }, []);

  return (
    <AnimatePresence>
      {toast && (
        <div className="fixed inset-x-0 bottom-8 pointer-events-none z-[9999] flex items-end justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', duration: 0.4 }}
            className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3 rounded-2xl shadow-xl border max-w-sm sm:max-w-md text-center text-white ${
              toast.isLoading 
                ? 'bg-blue-600 border-blue-400/80 shadow-blue-900/30' 
                : toast.isError 
                  ? 'bg-red-600 border-red-400/80 shadow-red-900/30' 
                  : 'bg-emerald-600 border-emerald-500 shadow-emerald-900/30'
            }`}
            dir="rtl"
          >
            {toast.isLoading ? (
              <Loader2 size={19} className="shrink-0 text-white animate-spin" />
            ) : toast.isError ? (
              <AlertCircle size={19} className="shrink-0 text-white" />
            ) : (
              <Check size={19} className="shrink-0 text-white" />
            )}
            <span className="text-xs font-bold leading-relaxed">{toast.message}</span>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
