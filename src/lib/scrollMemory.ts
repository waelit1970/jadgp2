export interface BoardScrollState {
  scrollY: number;
  visibleCount: number;
  updatedAt?: number;
}

// Global in-memory Scroll Position Map
const boardScrollStates: Record<string, BoardScrollState> = {};

// Load existing scroll positions from sessionStorage if present
try {
  const stored = sessionStorage.getItem('jadgpt_board_scroll_map');
  if (stored) {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      Object.assign(boardScrollStates, parsed);
    }
  }
} catch (e) {
  // Ignore sessionStorage errors
}

export function getBoardKey(boardId: string | null | undefined, subBoardId?: string | null | undefined): string {
  const b = boardId ? String(boardId).trim() : '__main__';
  const s = subBoardId ? String(subBoardId).trim() : '__root__';
  return `${b}::${s}`;
}

export function saveBoardScroll(
  boardId: string | null | undefined,
  subBoardId?: string | null | undefined,
  visibleCount?: number,
  explicitY?: number
) {
  const key = getBoardKey(boardId, subBoardId);
  const currentY = explicitY !== undefined ? explicitY : (window.pageYOffset || document.documentElement.scrollTop || 0);
  
  const existing = boardScrollStates[key];
  const finalVisibleCount = visibleCount && visibleCount > 0 ? visibleCount : (existing?.visibleCount || 5);

  boardScrollStates[key] = {
    scrollY: Math.max(0, currentY),
    visibleCount: finalVisibleCount,
    updatedAt: Date.now(),
  };

  try {
    sessionStorage.setItem('jadgpt_board_scroll_map', JSON.stringify(boardScrollStates));
  } catch (e) {}
}

export function getBoardScroll(boardId: string | null | undefined, subBoardId?: string | null | undefined): BoardScrollState | undefined {
  const key = getBoardKey(boardId, subBoardId);
  return boardScrollStates[key];
}

export function setBoardScrollState(key: string, state: BoardScrollState) {
  boardScrollStates[key] = state;
  try {
    sessionStorage.setItem('jadgpt_board_scroll_map', JSON.stringify(boardScrollStates));
  } catch (e) {}
}

export function clearBoardScroll(boardId: string | null | undefined, subBoardId?: string | null | undefined) {
  const key = getBoardKey(boardId, subBoardId);
  delete boardScrollStates[key];
  try {
    sessionStorage.setItem('jadgpt_board_scroll_map', JSON.stringify(boardScrollStates));
  } catch (e) {}
}

