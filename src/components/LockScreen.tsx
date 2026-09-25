import React, { useState } from 'react';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { KeyRound, Lock, Sparkles, AlertCircle, LogOut, Loader2 } from 'lucide-react';
import { License } from '../types';

interface LockScreenProps {
  userEmail: string;
  userLicense: License | null;
  onLogout: () => Promise<void>;
  onActivationSuccess: () => void;
  onClose?: () => void;
}

export default function LockScreen({ userEmail, userLicense, onLogout, onActivationSuccess, onClose }: LockScreenProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Determine if closing is allowed (e.g. they are still in trial or it is forced display)
  const isCloseable = !!onClose;

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanCode = code.trim();
    if (!cleanCode) {
      setError('يرجى إدخال كود التفعيل المكون من 6 أرقام');
      return;
    }

    if (cleanCode.length !== 6 || isNaN(Number(cleanCode))) {
      setError('يجب أن يتكون كود التفعيل من 6 أرقام تماماً');
      return;
    }

    setLoading(true);
    try {
      if (cleanCode === userLicense?.activationCode) {
        // Correct code! Update the user's license document in Firestore
        const docRef = doc(db, 'licenses', userEmail.trim().toLowerCase());
        await setDoc(docRef, {
          activated: true,
          activatedAt: Date.now()
        }, { merge: true });
        
        onActivationSuccess();
      } else {
        setError('كود التفعيل المدخل غير صحيح! يرجى التحقق من الكود والمحاولة مجدداً.');
      }
    } catch (err: any) {
      console.error('Activation failed:', err);
      setError(`فشل الاتصال بخادم التنشيط: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[4000] flex items-center justify-center bg-[#FAF9F5] p-4 font-sans" dir="rtl">
      {/* Dynamic particles or clean aesthetic bg */}
      <div className="absolute inset-0 bg-radial-gradient from-white via-[#FAF9F5] to-[#EAE6D8] opacity-70" />

      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 15 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="relative w-full max-w-md bg-white rounded-3xl border border-natural-border shadow-2xl p-8 text-center space-y-6 z-10"
      >
        {/* Decorative Badge Icon */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 border border-rose-100 shadow-sm animate-pulse">
          <Lock size={28} />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-black text-[#4A4A35]">انتهت الفترة التجريبية المجانية ⏳</h2>
          <p className="text-xs text-natural-muted font-bold px-4 leading-relaxed">
            نشكرك على استخدام تطبيقنا! لقد انتهت صلاحية فترتك التجريبية الممنوحة. لتفعيل التطبيق والوصول للنسخة الكاملة، يرجى إدخال كود التفعيل الخاص بك.
          </p>
        </div>

        {/* User identification info */}
        <div className="bg-[#FAF9F5] rounded-2xl p-3 border border-natural-border/30 text-right space-y-1">
          <span className="text-[10px] text-natural-muted font-bold block">حسابك الحالي:</span>
          <span className="text-xs font-black text-[#4A4A35] font-mono break-all">{userEmail}</span>
        </div>

        {/* Activation Form */}
        <form onSubmit={handleActivate} className="space-y-4">
          <div className="space-y-1.5 text-right">
            <label className="block text-xs font-black text-[#4A4A35] pr-1 flex items-center gap-1.5">
              <KeyRound size={14} className="text-natural-primary" />
              <span>أدخل كود التفعيل المكون من 6 أرقام:</span>
            </label>
            <input
              type="text"
              pattern="[0-9]*"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9]/g, '');
                setCode(val);
                setError(null);
              }}
              className="w-full text-center tracking-[0.5em] font-mono text-2xl font-black py-3 border-2 border-natural-border/80 focus:border-natural-primary rounded-2xl bg-[#FAF9F5] focus:outline-none transition-all placeholder:tracking-normal placeholder:text-sm placeholder:font-sans"
              placeholder="000000"
              disabled={loading}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-100 text-rose-700 text-xs text-right p-3 rounded-2xl animate-headShake">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span className="font-bold leading-relaxed">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-natural-primary text-white py-3.5 rounded-2xl text-xs font-black shadow-lg hover:bg-[#3d3d2a] active:scale-[0.98] transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>جاري التحقق والتنشيط...</span>
              </>
            ) : (
              <>
                <Sparkles size={16} />
                <span>تفعيل النسخة الكاملة الآن ✨</span>
              </>
            )}
          </button>
        </form>

        {isCloseable && (
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-neutral-100 hover:bg-neutral-200 text-gray-700 py-3 rounded-2xl text-xs font-black transition-colors cursor-pointer block"
          >
            إلغاء ومتابعة التصفح التجريبي ↩
          </button>
        )}

        {/* Support or Logout Options */}
        <div className="pt-2 border-t border-natural-border/20 flex items-center justify-between">
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-natural-muted hover:text-rose-600 transition-colors font-bold cursor-pointer"
          >
            <LogOut size={14} />
            <span>تسجيل الخروج</span>
          </button>

          <a
            href={`mailto:${userLicense?.email || userEmail}?subject=طلب كود تفعيل لتطبيق الويب`}
            className="text-[11px] text-natural-primary hover:underline font-black"
          >
            طلب كود تفعيل من المالك ↗
          </a>
        </div>
      </motion.div>
    </div>
  );
}
