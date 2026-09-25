import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query } from 'firebase/firestore';
import { 
  Users, Settings, Key, Trash2, Check, AlertCircle, 
  Shield, Clock, Search, ChevronDown, ChevronUp 
} from 'lucide-react';
import { GlobalSettings, License } from '../types';
import { sha256 } from '../lib/encryption';

interface OwnerLicensePanelProps {
  currentSettings: GlobalSettings;
  onUpdateSettings: (newSettings: Partial<GlobalSettings>) => Promise<void>;
  compact?: boolean;
  isDarkMode?: boolean;
}

export default function OwnerLicensePanel({ currentSettings, onUpdateSettings, compact = false, isDarkMode = false }: OwnerLicensePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [trialDaysInput, setTrialDaysInput] = useState(currentSettings.trialDays);
  const [allFreeState, setAllFreeState] = useState(currentSettings.allFree);
  const [targetEmail, setTargetEmail] = useState('');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [subscribers, setSubscribers] = useState<License[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [subscriberToDelete, setSubscriberToDelete] = useState<License | null>(null);
  const [newVaultPassword, setNewVaultPassword] = useState('');

  useEffect(() => {
    setTrialDaysInput(currentSettings.trialDays);
    setAllFreeState(currentSettings.allFree);
  }, [currentSettings]);

  // Real-time listener for subscribers
  useEffect(() => {
    if (!isOpen) return;

    const q = query(collection(db, 'licenses'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({
        ...doc.data()
      })) as License[];
      setSubscribers(docs);
    }, (err) => {
      console.error('Failed to fetch subscribers:', err);
    });

    return unsubscribe;
  }, [isOpen]);

  const handleSaveSettings = async () => {
    setLoading(true);
    try {
      await onUpdateSettings({
        trialDays: Number(trialDaysInput),
        allFree: allFreeState
      });
      alert('تم حفظ الإعدادات بنجاح!');
    } catch (err: any) {
      alert(`فشل حفظ الإعدادات: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveVaultPassword = async () => {
    const cleanPassword = newVaultPassword.trim();
    if (!cleanPassword) {
      alert('يرجى إدخال كلمة مرور جديدة!');
      return;
    }
    setLoading(true);
    try {
      const passwordHash = sha256(cleanPassword);
      await onUpdateSettings({
        vaultPasswordHash: passwordHash
      });
      setNewVaultPassword('');
      alert('تم تحديث كلمة مرور الخزنة بنجاح وحمايتها بتشفير آمن! 🔒');
    } catch (err: any) {
      alert(`فشل تحديث كلمة المرور: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = targetEmail.trim().toLowerCase();
    if (!email) {
      alert('يرجى إدخال البريد الإلكتروني للمشترك');
      return;
    }

    setLoading(true);
    try {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      
      const docRef = doc(db, 'licenses', email);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        await updateDoc(docRef, {
          activationCode: code
        });
      } else {
        await setDoc(docRef, {
          email,
          activationCode: code,
          activated: false,
          trialStartDate: Date.now(),
          expiryDate: null,
          activatedAt: null
        });
      }

      setGeneratedCode(code);
      setTargetEmail('');
      alert(`تم توليد كود التفعيل بنجاح للبريد الإلكتروني: ${email}`);
    } catch (err: any) {
      alert(`فشل توليد الكود: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSubscriber = async (subscriber: License) => {
    try {
      await deleteDoc(doc(db, 'licenses', subscriber.email));
      setSubscriberToDelete(null);
      alert(`تم حذف المشترك ${subscriber.email} بنجاح!`);
    } catch (err: any) {
      alert(`فشل الحذف: ${err.message || err}`);
    }
  };

  const getStatusBadge = (sub: License) => {
    if (sub.activated) {
      return (
        <span className="inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-md text-[9px] font-black border border-emerald-100 shadow-sm shrink-0">
          <Check size={9} />
          <span>نشط كامل 🟢</span>
        </span>
      );
    }

    const trialDays = currentSettings.trialDays;
    const elapsed = Date.now() - sub.trialStartDate;
    const trialDuration = trialDays * 24 * 60 * 60 * 1000;
    const timeLeft = trialDuration - elapsed;

    if (timeLeft > 0) {
      const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
      return (
        <span className="inline-flex items-center gap-0.5 bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-md text-[9px] font-black border border-amber-100 shadow-sm animate-pulse shrink-0">
          <Clock size={9} />
          <span>تجريبي ({daysLeft} يوم ) ⏳</span>
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-0.5 bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded-md text-[9px] font-black border border-rose-100 shadow-sm shrink-0">
        <AlertCircle size={9} />
        <span>منتهي 🔴</span>
      </span>
    );
  };

  const filteredSubscribers = subscribers.filter(sub => {
    const isOwnerEmail = sub.email.trim().toLowerCase() === currentSettings.ownerEmail.trim().toLowerCase();
    if (isOwnerEmail) return false;
    return (
      sub.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.activationCode.includes(searchQuery)
    );
  });

  return (
    <div className={`mb-2 rounded-2xl border border-solid transition-all duration-200 hover:border-dashed ${
      isDarkMode 
        ? 'border-[#2C374E] hover:border-[#008D75] bg-[#151D2A]' 
        : 'border-[#15803D] hover:border-[#15803D] bg-[#f9fafa]'
    } ${compact ? 'p-2' : 'p-4'} overflow-hidden`} dir="rtl">
      {/* Header Toggle */}
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between text-right cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-lg shrink-0 ${
            isDarkMode ? 'bg-[#008D75]/10 text-[#008D75]' : 'bg-natural-primary/10 text-natural-primary'
          }`}>
            <Shield size={14} />
          </div>
          <div>
            <h3 className={`text-xs font-black ${isDarkMode ? 'text-white' : 'text-[#4A4A35]'}`}>إدارة الإشتراكات</h3>
            {!compact && (
              <p className={`text-[10px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>توليد أكواد التفعيل وتتبع فترات التجربة للمشتركين</p>
            )}
          </div>
        </div>
        <div className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'}>
          {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </div>
      </button>

      {isOpen && (
        <div className={`mt-2.5 space-y-3.5 border-t pt-2.5 animate-fadeIn ${
          isDarkMode ? 'border-[#2C374E]/30' : 'border-natural-border/20'
        }`}>
          {/* Configuration Grid */}
          <div className={compact ? "space-y-3" : "grid grid-cols-1 md:grid-cols-2 gap-3"}>
            
            {/* General Settings */}
            <div className={`p-2.5 rounded-xl border space-y-2.5 ${
              isDarkMode ? 'bg-[#111822] border-[#2C374E]' : 'bg-neutral-50/50 border-natural-border/30'
            }`}>
              <h4 className={`text-[10px] font-black flex items-center gap-1 border-b pb-1 ${
                isDarkMode ? 'text-[#008D75] border-[#2C374E]/30' : 'text-[#4A4A35] border-natural-border/10'
              }`}>
                <Settings size={11} className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} />
                <span>الإعدادات العامة</span>
              </h4>

              <div className="space-y-1">
                <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-text'}`}>الأيام التجريبية الافتراضية</label>
                <div className="flex gap-1.5">
                  <input 
                    type="number" 
                    value={trialDaysInput}
                    onChange={(e) => setTrialDaysInput(Math.max(1, Number(e.target.value)))}
                    className={`w-16 rounded-lg border px-2 py-1 text-center text-[10px] font-bold focus:outline-none ${
                      isDarkMode 
                        ? 'border-[#2C374E] bg-[#1A212E] text-white focus:border-[#008D75]' 
                        : 'border-natural-border/40 bg-white text-natural-text focus:border-natural-primary'
                    }`}
                    min="1"
                  />
                  <span className={`self-center text-[10px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>أيام</span>
                </div>
              </div>

              <div className={`flex items-center justify-between py-1 border-t ${isDarkMode ? 'border-[#2C374E]/30' : 'border-natural-border/5'}`}>
                <div>
                  <label className={`block text-[10px] font-black ${isDarkMode ? 'text-white' : 'text-natural-text'}`}>تعطيل نظام الدفع (مجاني للجميع) 🎁</label>
                  <p className={`text-[8px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>تفعيل النسخة الكاملة بدون طلب أكواد تفعيل</p>
                </div>
                <input 
                  type="checkbox" 
                  checked={allFreeState}
                  onChange={(e) => setAllFreeState(e.target.checked)}
                  className={`h-4 w-4 rounded cursor-pointer shrink-0 ${
                    isDarkMode ? 'text-[#008D75] focus:ring-[#008D75] border-[#2C374E] bg-[#1A212E]' : 'text-natural-primary focus:ring-natural-primary border-natural-border'
                  }`}
                />
              </div>

              <button
                onClick={handleSaveSettings}
                disabled={loading}
                className={`w-full py-1.5 rounded-lg text-[10px] font-black shadow-sm transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                  isDarkMode 
                    ? 'bg-[#008D75] hover:bg-[#007460] text-white' 
                    : 'bg-[#4A4A35] hover:bg-natural-primary text-white'
                }`}
              >
                {loading ? 'جاري الحفظ...' : 'حفظ الإعدادات'}
              </button>
            </div>

            {/* Code Generator */}
            <div className={`p-2.5 rounded-xl border space-y-2.5 ${
              isDarkMode ? 'bg-[#111822] border-[#2C374E]' : 'bg-neutral-50/50 border-natural-border/30'
            }`}>
              <h4 className={`text-[10px] font-black flex items-center gap-1 border-b pb-1 ${
                isDarkMode ? 'text-[#008D75] border-[#2C374E]/30' : 'text-[#4A4A35] border-natural-border/10'
              }`}>
                <Key size={11} className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} />
                <span>توليد كود تفعيل</span>
              </h4>

              <form onSubmit={handleGenerateCode} className="space-y-2">
                <div className="space-y-1">
                  <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-text'}`}>البريد الإلكتروني للمشترك</label>
                  <input 
                    type="email" 
                    required
                    placeholder="example@gmail.com"
                    value={targetEmail}
                    onChange={(e) => setTargetEmail(e.target.value)}
                    className={`w-full rounded-lg border px-2 py-1 text-right text-[10px] focus:outline-none font-sans ${
                      isDarkMode 
                        ? 'border-[#2C374E] bg-[#1A212E] text-white focus:border-[#008D75]' 
                        : 'border-natural-border/40 bg-white text-natural-text focus:border-natural-primary'
                    }`}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className={`w-full py-1.5 rounded-lg text-[10px] font-black shadow-sm transition-all cursor-pointer ${
                    isDarkMode 
                      ? 'bg-[#008D75] hover:bg-[#007460] text-white' 
                      : 'bg-natural-primary hover:bg-[#3d3d2a] text-white'
                  }`}
                >
                  {loading ? 'جاري التوليد...' : 'توليد الكود 🔑'}
                </button>
              </form>

              {generatedCode && (
                <div className={`p-2 rounded-lg border text-center space-y-0.5 animate-fadeIn ${
                  isDarkMode 
                    ? 'bg-[#008D75]/10 border-[#008D75]/30' 
                    : 'bg-emerald-50 border-emerald-100'
                }`}>
                  <p className={`text-[9px] font-bold ${isDarkMode ? 'text-[#008D75]' : 'text-emerald-800'}`}>كود التفعيل جاهز:</p>
                  <div className={`font-mono text-sm font-black tracking-widest select-all ${
                    isDarkMode ? 'text-white' : 'text-emerald-700'
                  }`}>
                    {generatedCode}
                  </div>
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(generatedCode);
                      alert('تم نسخ الكود!');
                    }}
                    className={`text-[8px] underline font-black cursor-pointer ${
                      isDarkMode ? 'text-[#008D75] hover:text-[#00a88c]' : 'text-emerald-600 hover:text-emerald-800'
                    }`}
                  >
                    نسخ الكود 📋
                  </button>
                </div>
              )}
            </div>

            {/* Vault Password Changer */}
            <div className={`p-2.5 rounded-xl border space-y-2.5 ${
              isDarkMode ? 'bg-[#111822] border-[#2C374E]' : 'bg-neutral-50/50 border-natural-border/30'
            }`}>
              <h4 className={`text-[10px] font-black flex items-center gap-1 border-b pb-1 ${
                isDarkMode ? 'text-[#008D75] border-[#2C374E]/30' : 'text-[#4A4A35] border-natural-border/10'
              }`}>
                <span className="text-xs">🔒</span>
                <span>تغيير كلمة مرور الخزنة</span>
              </h4>

              <div className="space-y-1">
                <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-text'}`}>
                  كلمة المرور الجديدة لخزنة الصور
                </label>
                <input 
                  type="password" 
                  placeholder="أدخل كلمة المرور الجديدة..."
                  value={newVaultPassword}
                  onChange={(e) => setNewVaultPassword(e.target.value)}
                  className={`w-full rounded-lg border px-2 py-1 text-right text-[10px] focus:outline-none font-sans ${
                    isDarkMode 
                      ? 'border-[#2C374E] bg-[#1A212E] text-white focus:border-[#008D75]' 
                      : 'border-natural-border/40 bg-white text-natural-text focus:border-natural-primary'
                  }`}
                />
              </div>

              <button
                type="button"
                onClick={handleSaveVaultPassword}
                disabled={loading}
                className={`w-full py-1.5 rounded-lg text-[10px] font-black shadow-sm transition-all cursor-pointer ${
                  isDarkMode 
                    ? 'bg-[#008D75] hover:bg-[#007460] text-white' 
                    : 'bg-natural-primary hover:bg-[#3d3d2a] text-white'
                }`}
              >
                {loading ? 'جاري الحفظ...' : 'حفظ كلمة المرور الجديدة 🔒'}
              </button>
            </div>

          </div>

          {/* Subscribers List */}
          <div className={`p-2 rounded-xl border space-y-2.5 ${
            isDarkMode ? 'bg-[#111822] border-[#2C374E]' : 'bg-white border-natural-border/30'
          }`}>
            <div className={`flex flex-col gap-1.5 border-b pb-2 ${
              isDarkMode ? 'border-[#2C374E]/30' : 'border-natural-border/10'
            }`}>
              <h4 className={`text-[10px] font-black flex items-center gap-1 ${isDarkMode ? 'text-white' : 'text-[#4A4A35]'}`}>
                <Users size={11} className={isDarkMode ? 'text-[#008D75]' : 'text-natural-primary'} />
                <span>قائمة المشتركين ومراقبة فترات التجربة</span>
              </h4>

              {/* Search */}
              <div className="relative w-full">
                <Search className={`absolute right-2 top-2 ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`} size={10} />
                <input 
                  type="text"
                  placeholder="ابحث بالبريد أو الكود..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full rounded-lg border pr-7 pl-2 py-1 text-right text-[10px] focus:outline-none ${
                    isDarkMode 
                      ? 'border-[#2C374E] bg-[#1A212E] text-white focus:border-[#008D75]' 
                      : 'border-natural-border/30 bg-neutral-50 focus:border-natural-primary text-natural-text'
                  }`}
                />
              </div>
            </div>

            {/* List Table */}
            <div className="overflow-x-auto max-h-56 overflow-y-auto">
              <table className="w-full text-right text-[9px] border-collapse min-w-[280px]">
                <thead>
                  <tr className={`border-b font-bold ${isDarkMode ? 'border-[#2C374E]/30 text-[#B4C6D8]' : 'border-natural-border/10 text-natural-muted'}`}>
                    <th className="py-1.5 px-1.5">البريد الإلكتروني</th>
                    <th className="py-1.5 px-1.5 text-center">الكود</th>
                    <th className="py-1.5 px-1.5 text-center">الحالة</th>
                    <th className="py-1.5 px-1.5 text-left">إجراء</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDarkMode ? 'divide-[#2C374E]/30' : 'divide-natural-border/5'}`}>
                  {filteredSubscribers.length === 0 ? (
                    <tr>
                      <td colSpan={4} className={`py-4 text-center font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-natural-muted'}`}>
                        لا يوجد مشتركين حالياً.
                      </td>
                    </tr>
                  ) : (
                    filteredSubscribers.map((sub) => (
                      <tr key={sub.email} className={`transition-colors ${isDarkMode ? 'hover:bg-[#1A212E]' : 'hover:bg-neutral-50'}`}>
                        <td className={`py-1.5 px-1.5 font-medium select-all truncate max-w-[120px] ${isDarkMode ? 'text-white' : 'text-[#4A4A35]'}`} title={sub.email}>
                          {sub.email}
                        </td>
                        <td className={`py-1.5 px-1.5 text-center font-mono font-bold select-all ${isDarkMode ? 'text-white' : 'text-gray-700'}`}>
                          {sub.activationCode || '—'}
                        </td>
                        <td className="py-1.5 px-1.5 text-center">
                          {getStatusBadge(sub)}
                        </td>
                        <td className="py-1.5 px-1.5 text-left">
                          <button
                            onClick={() => setSubscriberToDelete(sub)}
                            className={`p-1 rounded transition-colors cursor-pointer ${
                              isDarkMode ? 'text-rose-400 hover:bg-rose-950/40' : 'text-rose-600 hover:bg-rose-50'
                            }`}
                            title="حذف"
                          >
                            <Trash2 size={11} />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* Deletion Dialog */}
      {subscriberToDelete && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4">
          <div 
            onClick={() => setSubscriberToDelete(null)}
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
          />
          <div className={`relative w-full max-w-xs rounded-xl shadow-xl p-4 border border-transparent z-10 space-y-3 ${
            isDarkMode ? 'bg-[#151D2A] border-[#2C374E] text-white' : 'bg-white border-natural-border text-black'
          }`} dir="rtl">
            <div className="flex items-center gap-2 text-rose-500">
              <AlertCircle size={18} className="animate-pulse" />
              <h3 className="text-xs font-black">حذف المشترك؟</h3>
            </div>
            <p className={`text-[10px] leading-relaxed font-bold ${isDarkMode ? 'text-[#B4C6D8]' : 'text-[#4A4A35]'}`}>
              هل أنت متأكد من حذف المشترك <span className="font-mono text-rose-500 break-all">{subscriberToDelete.email}</span> نهائياً؟
            </p>
            <div className="flex gap-1.5 justify-end pt-1">
              <button
                onClick={() => setSubscriberToDelete(null)}
                className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black cursor-pointer ${
                  isDarkMode ? 'bg-[#111822] hover:bg-[#1A212E] text-white' : 'bg-neutral-100 hover:bg-neutral-200 text-gray-700'
                }`}
              >
                تراجع
              </button>
              <button
                onClick={() => handleDeleteSubscriber(subscriberToDelete)}
                className="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 rounded-lg text-[9px] font-black text-white shadow-sm cursor-pointer"
              >
                نعم، احذف
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
