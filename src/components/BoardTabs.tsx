import React from 'react';
import { Board } from '../types';
import { getLocalUserPostsIndexedDB } from '../lib/indexedDbService';

interface BoardTabsProps {
  boards: Board[];
  activeBoardId: string | null;
  activeSubBoardId?: string | null;
  onSelectBoard: (boardId: string | null, subBoardId?: string | null) => void;
  onSelectSubBoard?: (subBoardId: string | null) => void;
  postCounts: Record<string, number>;
  lastDynamicBoardId?: string | null;
  isDarkMode?: boolean;
  isAdmin?: boolean;
}

export default function BoardTabs({ 
  boards, 
  activeBoardId, 
  activeSubBoardId, 
  onSelectBoard, 
  onSelectSubBoard, 
  postCounts, 
  lastDynamicBoardId, 
  isDarkMode,
  isAdmin 
}: BoardTabsProps) {
  const [localCount, setLocalCount] = React.useState(0);

  // Ultra-smooth drag-to-scroll for sub-boards (no jumps, zero-latency 1:1 movement)
  const subTabsContainerRef = React.useRef<HTMLDivElement | null>(null);
  const isDraggingRef = React.useRef(false);
  const lastClientXRef = React.useRef(0);
  const hasDraggedRef = React.useRef(false);
  const [isDraggingState, setIsDraggingState] = React.useState(false);

  const handleSubTabsMouseDown = (e: React.MouseEvent) => {
    if (!subTabsContainerRef.current) return;
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    lastClientXRef.current = e.clientX;
    setIsDraggingState(true);
  };

  React.useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !subTabsContainerRef.current) return;
      const deltaX = e.clientX - lastClientXRef.current;
      if (Math.abs(deltaX) > 0) {
        if (Math.abs(deltaX) > 2) {
          hasDraggedRef.current = true;
        }
        subTabsContainerRef.current.scrollLeft -= deltaX;
        lastClientXRef.current = e.clientX;
      }
    };

    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDraggingState(false);
        // keep hasDraggedRef true for a short tick to prevent triggering button onClick
        setTimeout(() => {
          hasDraggedRef.current = false;
        }, 80);
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove, { passive: true });
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  const handleSubTabsWheel = (e: React.WheelEvent) => {
    if (!subTabsContainerRef.current) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
      subTabsContainerRef.current.scrollLeft += e.deltaY;
    }
  };

  React.useEffect(() => {
    const updateLocalCount = async () => {
      try {
        const parsed = await getLocalUserPostsIndexedDB();
        const localOnly = parsed.filter((p: any) => !p.boardId || p.boardId === 'user-board');
        setLocalCount(localOnly.length);
      } catch (err) {
        setLocalCount(0);
      }
    };
    updateLocalCount();
    window.addEventListener('reload_local_posts', updateLocalCount);
    return () => {
      window.removeEventListener('reload_local_posts', updateLocalCount);
    };
  }, []);

  const handleTabClick = (boardId: string | null | 'prompt-builder') => {
    onSelectBoard(boardId);
  };

  const dynamicBoard = lastDynamicBoardId ? boards.find(b => b.id === lastDynamicBoardId) : null;
  const currentActiveBoard = boards.find(b => b.id === activeBoardId);
  
  // Responsive text sizes depending on whether we have 3 or 4 tabs
  const buttonTextClass = dynamicBoard
    ? `text-[13.5px] sm:text-[14px] md:text-[15px] px-1.5 py-1.5 sm:py-2 ${isDarkMode ? 'font-normal' : 'font-normal'}`
    : `text-[14.5px] sm:text-[15.5px] md:text-[16.5px] px-1.5 py-1.5 sm:py-2 ${isDarkMode ? 'font-normal' : 'font-normal'}`;

  return (
    <div className="w-full max-w-xl mx-auto py-0.5 select-none px-1.5 font-sans" dir="rtl">
      <div className={`grid ${dynamicBoard ? 'grid-cols-4' : 'grid-cols-3'} gap-1.5 w-full`}>
        {/* 1. صانع البرومبت */}
        <button
          onClick={() => handleTabClick('prompt-builder')}
          className={`relative flex items-center justify-center rounded-full transition-all shadow-xs cursor-pointer ${buttonTextClass} ${
            activeBoardId === 'prompt-builder'
              ? isDarkMode
                ? 'bg-[#1A212E] text-[#e4edf7] scale-[1.03] border border-dashed border-[#e4edf7]'
                : 'bg-orange-50 text-orange-700 border border-orange-300/80 scale-[1.03] shadow-xs'
              : isDarkMode
                ? 'bg-[#1A212E] text-[#16af75] border border-[#2C374E] hover:bg-[#212B3B]'
                : 'bg-white text-natural-text hover:bg-natural-secondary-bg border border-[#B5B8AB]'
          }`}
        >
          <span className="text-center break-words leading-tight">صانع البرومبت</span>
        </button>

        {/* 2. لوحة شخصية */}
        <button
          onClick={() => handleTabClick('user-board')}
          className={`relative flex items-center justify-center rounded-full transition-all shadow-xs cursor-pointer ${buttonTextClass} ${
            activeBoardId === 'user-board'
              ? isDarkMode
                ? 'bg-[#1A212E] text-[#e4edf7] scale-[1.03] border border-dashed border-[#e4edf7]'
                : 'bg-orange-50 text-orange-700 border border-orange-300/80 scale-[1.03] shadow-xs'
              : isDarkMode
                ? 'bg-[#1A212E] text-[#16af75] border border-[#2C374E] hover:bg-[#212B3B]'
                : 'bg-white text-natural-text hover:bg-natural-secondary-bg border border-[#B5B8AB]'
          }`}
        >
          <span className="text-center break-words leading-tight">لوحة شخصية</span>
          {localCount > 0 && (
            <span className="absolute -top-1 -left-1 flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-red-500 text-[9px] sm:text-[10px] font-bold text-white shadow-xs">
              {localCount}
            </span>
          )}
        </button>

        {/* 3. الرئيسية */}
        <button
          onClick={() => handleTabClick(null)}
          className={`relative flex items-center justify-center rounded-full transition-all shadow-xs cursor-pointer ${buttonTextClass} ${
            activeBoardId === null
              ? isDarkMode
                ? 'bg-[#1A212E] text-[#e4edf7] scale-[1.03] border border-dashed border-[#e4edf7]'
                : 'bg-orange-50 text-orange-700 border border-orange-300/80 scale-[1.03] shadow-xs'
              : isDarkMode
                ? 'bg-[#1A212E] text-[#16af75] border border-[#2C374E] hover:bg-[#212B3B]'
                : 'bg-white text-natural-text hover:bg-natural-secondary-bg border border-[#B5B8AB]'
          }`}
        >
          <span className="text-center break-words leading-tight">الرئيسية</span>
          {postCounts['null'] > 0 && (
            <span className="absolute -top-1 -left-1 flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-red-500 text-[9px] sm:text-[10px] font-bold text-white shadow-xs">
              {postCounts['null']}
            </span>
          )}
        </button>

        {/* 4. التبويب الديناميكي (النشط حالياً أو المختار مؤخراً) */}
        {dynamicBoard && (
          <button
            onClick={() => handleTabClick(dynamicBoard.id)}
            className={`relative flex items-center justify-center rounded-full transition-all shadow-xs cursor-pointer ${buttonTextClass} ${
              activeBoardId === dynamicBoard.id
                ? isDarkMode
                  ? 'bg-[#1A212E] text-[#e4edf7] scale-[1.03] border border-dashed border-[#e8f7e4]'
                  : 'bg-orange-50 text-orange-700 border border-orange-300/80 scale-[1.03] shadow-xs'
                : isDarkMode
                  ? 'bg-[#1A212E] text-[#16af75] border border-[#2C374E] hover:bg-[#212B3B]'
                  : 'bg-white text-natural-text hover:bg-natural-secondary-bg border border-[#B5B8AB]'
            }`}
          >
            <span className="text-center break-words leading-tight">{dynamicBoard.name}</span>
            {postCounts[dynamicBoard.id] > 0 && (
              <span className="absolute -top-1 -left-1 flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-red-500 text-[9px] sm:text-[10px] font-bold text-white shadow-xs">
                {postCounts[dynamicBoard.id]}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Sub-tabs bar under main tabs when active board has subBoards */}
      {currentActiveBoard && currentActiveBoard.subBoards && currentActiveBoard.subBoards.length > 0 && (
        <div
          ref={subTabsContainerRef}
          onMouseDown={handleSubTabsMouseDown}
          onWheel={handleSubTabsWheel}
          className={`mt-2 flex items-center justify-start gap-1.5 overflow-x-auto no-scrollbar py-1 px-1 sm:px-1.5 touch-pan-x select-none w-full ${
            isDraggingState ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{ scrollBehavior: 'auto' }}
        >
          {currentActiveBoard.subBoards.map((sub) => {
            const isSubActive = activeSubBoardId === sub.id;
            return (
              <button
                key={sub.id}
                type="button"
                onClick={(e) => {
                  if (hasDraggedRef.current) {
                    e.preventDefault();
                    return;
                  }
                  onSelectSubBoard?.(isSubActive ? null : sub.id);
                }}
                className={`px-2.5 py-0.5 rounded-full transition-all cursor-pointer whitespace-nowrap shadow-2xs shrink-0 ${
                  isSubActive
                    ? (isDarkMode 
                        ? 'text-xs font-bold bg-[#008D75] text-white border border-[#008D75] shadow-xs px-3 py-1' 
                        : 'text-xs font-bold bg-[#c26700] text-white border border-[#c26700] shadow-xs px-3 py-1')
                    : (isDarkMode 
                        ? 'text-[11px] font-normal bg-[#1A212E] text-[#16af75] border border-[#445577] hover:border-[#6077a3] hover:bg-[#212B3B]' 
                        : 'text-[11px] font-normal bg-white text-natural-text hover:bg-natural-secondary-bg border border-[#CBD0BE] hover:border-[#9AA08F]')
                }`}
              >
                {sub.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
