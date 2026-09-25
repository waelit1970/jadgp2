import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Edit2, Move, Trash2, Check, ChevronUp, ChevronDown, GripVertical, ChevronRight } from 'lucide-react';
import { Board, SubBoard } from '../types';

interface BoardModalsProps {
  isOpen: boolean;
  type: 'create' | 'edit' | 'reorder';
  board?: Board;
  boards?: Board[];
  onClose: () => void;
  onSubmit: (data: any) => void;
}

export default function BoardModals({ isOpen, type, board, boards, onClose, onSubmit }: BoardModalsProps) {
  const [name, setName] = useState('');
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [subBoards, setSubBoards] = useState<SubBoard[]>([]);
  const [newSubBoardName, setNewSubBoardName] = useState('');
  const [editingSubBoardId, setEditingSubBoardId] = useState<string | null>(null);
  const [editingSubBoardName, setEditingSubBoardName] = useState('');
  const [orderedBoards, setOrderedBoards] = useState<Board[]>([]);
  const [draggedSubIndex, setDraggedSubIndex] = useState<number | null>(null);
  const [expandedSubBoardsInReorder, setExpandedSubBoardsInReorder] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isOpen) {
      setName(board?.name || '');
      setLocked(board?.locked || false);
      setHidden(board?.hidden || false);
      setSubBoards(board?.subBoards || []);
      setNewSubBoardName('');
      setEditingSubBoardId(null);
      setEditingSubBoardName('');
      setOrderedBoards(boards || []);
      setDraggedSubIndex(null);
      setExpandedSubBoardsInReorder({});
    }
  }, [isOpen, board, boards]);

  const handleAddSubBoard = () => {
    if (!newSubBoardName.trim()) return;
    const newSub: SubBoard = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      name: newSubBoardName.trim(),
    };
    setSubBoards(prev => [...prev, newSub]);
    setNewSubBoardName('');
  };

  const handleStartEditSubBoard = (sub: SubBoard) => {
    setEditingSubBoardId(sub.id);
    setEditingSubBoardName(sub.name);
  };

  const handleSaveSubBoardName = (subId: string) => {
    const trimmed = editingSubBoardName.trim();
    if (!trimmed) return;
    setSubBoards(prev => prev.map(s => s.id === subId ? { ...s, name: trimmed } : s));
    setEditingSubBoardId(null);
    setEditingSubBoardName('');
  };

  const handleCancelEditSubBoard = () => {
    setEditingSubBoardId(null);
    setEditingSubBoardName('');
  };

  const handleRemoveSubBoard = (subId: string) => {
    setSubBoards(prev => prev.filter(s => s.id !== subId));
  };

  const handleMoveSubBoard = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= subBoards.length) return;
    const newSubs = [...subBoards];
    const [moved] = newSubs.splice(index, 1);
    newSubs.splice(targetIndex, 0, moved);
    setSubBoards(newSubs);
  };

  const handleSubDragStart = (e: React.DragEvent, index: number) => {
    setDraggedSubIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleSubDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedSubIndex === null || draggedSubIndex === index) return;
    const items = [...subBoards];
    const [draggedItem] = items.splice(draggedSubIndex, 1);
    items.splice(index, 0, draggedItem);
    setDraggedSubIndex(index);
    setSubBoards(items);
  };

  const handleSubDragEnd = () => {
    setDraggedSubIndex(null);
  };

  const handleReorder = (draggedId: string, overId: string) => {
    const items = [...orderedBoards];
    const fromIndex = items.findIndex(i => i.id === draggedId);
    const toIndex = items.findIndex(i => i.id === overId);
    const [removed] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, removed);
    setOrderedBoards(items);
  };

  const handleMoveSubBoardInReorder = (boardId: string, subIndex: number, direction: -1 | 1) => {
    setOrderedBoards(prev => prev.map(b => {
      if (b.id !== boardId || !b.subBoards) return b;
      const newSubs = [...b.subBoards];
      const targetIndex = subIndex + direction;
      if (targetIndex < 0 || targetIndex >= newSubs.length) return b;
      const [moved] = newSubs.splice(subIndex, 1);
      newSubs.splice(targetIndex, 0, moved);
      return { ...b, subBoards: newSubs };
    }));
  };

  const toggleSubBoardsExpansionInReorder = (boardId: string) => {
    setExpandedSubBoardsInReorder(prev => ({
      ...prev,
      [boardId]: !prev[boardId]
    }));
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[2500] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        />
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
          dir="rtl"
        >
          <div className="flex items-center justify-between border-b border-natural-border px-6 py-4">
            <h3 className="text-lg font-bold text-natural-text">
              {type === 'create' && 'إنشاء لوحة جديدة'}
              {type === 'edit' && 'تعديل اسم اللوحة واللوحات الفرعية'}
              {type === 'reorder' && 'ترتيب اللوحات والتبويبات الفرعية'}
            </h3>
            <button onClick={onClose} className="text-natural-muted hover:text-natural-text cursor-pointer">
              <X size={20} />
            </button>
          </div>

          <div className="p-6">
            {(type === 'create' || type === 'edit') && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-natural-text mb-2">اسم اللوحة</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-natural-border bg-natural-secondary-bg p-3 text-right focus:border-natural-primary focus:outline-none"
                    placeholder="مثال: استوديو، أطفال..."
                  />
                </div>

                {/* Sub-boards Management Section */}
                <div className="pt-1">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-natural-text">
                      اللوحات الفرعية (يمكنك سحبها أو استخدام الأسهم لتغيير الترتيب)
                    </label>
                    {subBoards.length > 0 && (
                      <span className="text-[10px] bg-natural-secondary-bg px-2 py-0.5 rounded-full font-bold text-natural-primary border border-natural-border/60">
                        {subBoards.length} تبويب
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={newSubBoardName}
                      onChange={(e) => setNewSubBoardName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddSubBoard();
                        }
                      }}
                      className="flex-1 rounded-xl border border-natural-border bg-natural-secondary-bg p-2.5 text-xs text-right focus:border-natural-primary focus:outline-none"
                      placeholder="أدخل اسم تبويب فرعي..."
                    />
                    <button
                      type="button"
                      onClick={handleAddSubBoard}
                      className="px-3 py-2 bg-natural-primary text-white rounded-xl text-xs font-bold hover:bg-[#4A4A35] transition-colors flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Plus size={14} />
                      <span>إضافة</span>
                    </button>
                  </div>

                  {subBoards.length > 0 ? (
                    <div className="flex flex-col gap-1.5 p-2 bg-neutral-50 rounded-xl border border-natural-border/60 max-h-56 overflow-y-auto">
                      {subBoards.map((sub, idx) => {
                        const isEditing = editingSubBoardId === sub.id;
                        return (
                          <div
                            key={sub.id}
                            draggable={!isEditing}
                            onDragStart={(e) => handleSubDragStart(e, idx)}
                            onDragOver={(e) => handleSubDragOver(e, idx)}
                            onDragEnd={handleSubDragEnd}
                            className={`group flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-bold transition-all shadow-2xs select-none ${
                              isEditing
                                ? 'bg-amber-50/90 border-amber-300'
                                : draggedSubIndex === idx
                                ? 'bg-amber-100/70 border-dashed border-amber-400 opacity-60'
                                : 'bg-white border-natural-border text-natural-text hover:border-natural-primary/40'
                            }`}
                          >
                            {isEditing ? (
                              <div className="flex items-center gap-1.5 w-full">
                                <input
                                  type="text"
                                  value={editingSubBoardName}
                                  onChange={(e) => setEditingSubBoardName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      handleSaveSubBoardName(sub.id);
                                    } else if (e.key === 'Escape') {
                                      handleCancelEditSubBoard();
                                    }
                                  }}
                                  className="flex-1 text-xs font-bold text-natural-text bg-white px-2 py-1 rounded border border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveSubBoardName(sub.id)}
                                  className="p-1.5 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors cursor-pointer shrink-0"
                                  title="حفظ الاسم الجديد"
                                >
                                  <Check size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancelEditSubBoard}
                                  className="p-1.5 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors cursor-pointer shrink-0"
                                  title="إلغاء"
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                  <span
                                    className="cursor-grab active:cursor-grabbing text-neutral-400 hover:text-natural-primary p-0.5 rounded transition-colors shrink-0"
                                    title="اسحب لتغيير الترتيب"
                                  >
                                    <GripVertical size={14} />
                                  </span>
                                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-natural-secondary-bg text-[10px] text-natural-muted font-bold shrink-0 border border-natural-border/60">
                                    {idx + 1}
                                  </span>
                                  <span className="truncate text-natural-text font-bold text-xs">{sub.name}</span>
                                </div>

                                <div className="flex items-center gap-0.5 shrink-0">
                                  {/* Move Up Button */}
                                  <button
                                    type="button"
                                    disabled={idx === 0}
                                    onClick={() => handleMoveSubBoard(idx, -1)}
                                    className="p-1 text-neutral-600 hover:text-natural-primary hover:bg-neutral-100 rounded disabled:opacity-20 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors cursor-pointer"
                                    title="تحريك لأعلى"
                                  >
                                    <ChevronUp size={14} />
                                  </button>

                                  {/* Move Down Button */}
                                  <button
                                    type="button"
                                    disabled={idx === subBoards.length - 1}
                                    onClick={() => handleMoveSubBoard(idx, 1)}
                                    className="p-1 text-neutral-600 hover:text-natural-primary hover:bg-neutral-100 rounded disabled:opacity-20 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors cursor-pointer"
                                    title="تحريك لأسفل"
                                  >
                                    <ChevronDown size={14} />
                                  </button>

                                  {/* Edit Name Button */}
                                  <button
                                    type="button"
                                    onClick={() => handleStartEditSubBoard(sub)}
                                    className="text-amber-600 hover:text-amber-800 p-1 rounded hover:bg-amber-100/60 transition-colors cursor-pointer ml-1"
                                    title="تعديل اسم اللوحة الفرعية"
                                  >
                                    <Edit2 size={13} />
                                  </button>

                                  {/* Delete Button */}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveSubBoard(sub.id)}
                                    className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 transition-colors cursor-pointer"
                                    title="حذف اللوحة الفرعية"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-natural-muted font-medium">لا توجد تبويبات فرعية مضافة بعد.</p>
                  )}
                </div>

                <div className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    id="board-locked"
                    checked={locked}
                    onChange={(e) => setLocked(e.target.checked)}
                    className="h-4.5 w-4.5 rounded text-natural-primary focus:ring-natural-primary border-natural-border cursor-pointer"
                  />
                  <label htmlFor="board-locked" className="text-sm font-bold text-[#4A4A35] cursor-pointer select-none">
                    لوحة مقفولة 🔒 (للمشتركين فقط)
                  </label>
                </div>

                <div className="flex items-center gap-2 py-1 bg-red-50/60 p-2.5 rounded-xl border border-red-100">
                  <input
                    type="checkbox"
                    id="board-hidden"
                    checked={hidden}
                    onChange={(e) => setHidden(e.target.checked)}
                    className="h-4.5 w-4.5 rounded text-red-600 focus:ring-red-500 border-red-200 cursor-pointer shrink-0"
                  />
                  <label htmlFor="board-hidden" className="text-sm font-bold text-red-800 cursor-pointer select-none flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span>إخفاء اللوحة</span>
                      <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.2 rounded font-black">Admin</span>
                    </span>
                    <span className="text-[11px] font-normal text-red-600/80 leading-snug">
                      تظهر للمالك فقط، ومخفية تماماً عن باقي المستخدمين والمشتركين
                    </span>
                  </label>
                </div>

                <button
                  onClick={() => onSubmit({ name, locked, hidden, subBoards })}
                  className="w-full rounded-xl bg-natural-primary py-3 font-bold text-white shadow-sm transition-all hover:bg-[#4A4A35] active:scale-95 cursor-pointer"
                >
                  {type === 'create' ? 'إنشاء' : 'حفظ التعديلات'}
                </button>
              </div>
            )}

            {type === 'reorder' && (
              <div className="space-y-4">
                <p className="text-xs text-natural-muted mb-3">
                  يمكنك تغيير ترتيب اللوحات الرئيسية وتبويباتها الفرعية كما تظهر في الواجهة والمنشورات.
                </p>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {orderedBoards.map((b, idx) => {
                    const hasSubs = b.subBoards && b.subBoards.length > 0;
                    const isExpanded = !!expandedSubBoardsInReorder[b.id];

                    return (
                      <div
                        key={b.id}
                        className="rounded-xl border border-natural-border bg-natural-secondary-bg overflow-hidden"
                      >
                        <div className="flex items-center justify-between p-3">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Move size={16} className="text-natural-muted shrink-0" />
                            <span className="font-bold text-sm text-natural-text truncate">{b.name}</span>
                            {hasSubs && (
                              <button
                                type="button"
                                onClick={() => toggleSubBoardsExpansionInReorder(b.id)}
                                className="flex items-center gap-1 text-[10px] font-bold bg-white text-natural-primary border border-natural-border/80 px-2 py-0.5 rounded-full hover:bg-neutral-50 transition-colors cursor-pointer shrink-0"
                              >
                                <span>{b.subBoards!.length} تبويب فرعي</span>
                                <ChevronRight
                                  size={12}
                                  className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                                />
                              </button>
                            )}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <button
                              disabled={idx === 0}
                              onClick={() => handleReorder(b.id, orderedBoards[idx - 1].id)}
                              className="px-2.5 py-1 bg-white rounded-lg border border-natural-border text-xs font-bold disabled:opacity-30 hover:bg-neutral-50 cursor-pointer disabled:cursor-not-allowed"
                            >
                              أعلى
                            </button>
                            <button
                              disabled={idx === orderedBoards.length - 1}
                              onClick={() => handleReorder(b.id, orderedBoards[idx + 1].id)}
                              className="px-2.5 py-1 bg-white rounded-lg border border-natural-border text-xs font-bold disabled:opacity-30 hover:bg-neutral-50 cursor-pointer disabled:cursor-not-allowed"
                            >
                              أسفل
                            </button>
                          </div>
                        </div>

                        {/* Expandable Sub-boards Reordering inside Reorder Modal */}
                        {hasSubs && isExpanded && (
                          <div className="border-t border-natural-border/60 bg-white/70 p-2.5 space-y-1.5">
                            <p className="text-[11px] font-bold text-natural-muted mb-1">
                              ترتيب اللوحات الفرعية لـ "{b.name}":
                            </p>
                            {b.subBoards!.map((sub, sIdx) => (
                              <div
                                key={sub.id}
                                className="flex items-center justify-between gap-2 px-2.5 py-1 rounded-md bg-white border border-natural-border/70 text-xs font-medium"
                              >
                                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                  <span className="w-4 h-4 rounded-full bg-natural-secondary-bg text-[9px] font-bold flex items-center justify-center text-natural-muted">
                                    {sIdx + 1}
                                  </span>
                                  <span className="truncate text-natural-text font-bold">{sub.name}</span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    disabled={sIdx === 0}
                                    onClick={() => handleMoveSubBoardInReorder(b.id, sIdx, -1)}
                                    className="p-1 text-neutral-600 hover:text-natural-primary hover:bg-neutral-100 rounded disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
                                    title="تحريك لأعلى"
                                  >
                                    <ChevronUp size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={sIdx === b.subBoards!.length - 1}
                                    onClick={() => handleMoveSubBoardInReorder(b.id, sIdx, 1)}
                                    className="p-1 text-neutral-600 hover:text-natural-primary hover:bg-neutral-100 rounded disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
                                    title="تحريك لأسفل"
                                  >
                                    <ChevronDown size={13} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => onSubmit(orderedBoards.map((b, i) => ({ id: b.id, order: i, subBoards: b.subBoards || [] })))}
                  className="w-full rounded-xl bg-natural-primary py-3 font-bold text-white shadow-sm transition-all hover:bg-[#4A4A35] active:scale-95 mt-4 cursor-pointer"
                >
                  حفظ الترتيب
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

