import React, { useState, useEffect, useRef } from 'react';
import { ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { getActivePost, glowPost, findPostElement } from '../lib/activePost';

export default function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [hasActivePost, setHasActivePost] = useState(false);
  const clickTimerRef = useRef<number | null>(null);

  // Show button when page or container is scrolled down
  const toggleVisibility = () => {
    const winY = window.pageYOffset || document.documentElement.scrollTop || 0;
    const activeContainer = document.querySelector('.board-scroll-container:not([style*="display: none"]):not(.hidden)') as HTMLElement | null;
    const containerY = activeContainer?.scrollTop || 0;
    
    if (winY > 250 || containerY > 250) {
      setIsVisible(true);
    } else {
      setIsVisible(false);
    }
  };

  const scrollToTop = () => {
    // Scroll active container
    const activeContainers = document.querySelectorAll('.board-scroll-container') as NodeListOf<HTMLElement>;
    activeContainers.forEach(container => {
      if (container && container.offsetParent !== null) {
        container.scrollTo({
          top: 0,
          behavior: 'smooth',
        });
      }
    });

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  // نقرة واحدة: اذهب إلى المنشور الذي نقف عليه (تعديل / عرض المزيد / تشغيل ميديا)
  const scrollToActivePost = () => {
    const postId = getActivePost();
    const el = findPostElement(postId);
    if (!el) {
      scrollToTop();
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    glowPost(postId);
  };

  // نقرة واحدة → المنشور المحدَّد، نقرتان متتاليتان → أعلى القائمة
  const handleArrowClick = () => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      scrollToTop();
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      scrollToActivePost();
    }, 380);
  };

  const openBoards = () => {
    window.dispatchEvent(new Event('open_boards_drawer'));
  };

  useEffect(() => {
    const handleContainerScroll = (e: Event) => {
      const customEvt = e as CustomEvent;
      const top = customEvt.detail?.scrollTop ?? 0;
      if (top > 250) {
        setIsVisible(true);
      } else {
        toggleVisibility();
      }
    };

    const handleActivePost = () => setHasActivePost(!!getActivePost());
    window.addEventListener('jadgpt_active_post', handleActivePost);

    window.addEventListener('scroll', toggleVisibility, { passive: true });
    window.addEventListener('board_container_scroll', handleContainerScroll as EventListener);
    return () => {
      window.removeEventListener('jadgpt_active_post', handleActivePost);
      window.removeEventListener('scroll', toggleVisibility);
      window.removeEventListener('board_container_scroll', handleContainerScroll as EventListener);
    };
  }, []);

  useEffect(() => {
    const checkPopup = () => {
      const hasHiddenBody = document.body.style.overflow === 'hidden';
      setIsPopupOpen(hasHiddenBody);
    };

    const observer = new MutationObserver(() => {
      checkPopup();
    });

    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    checkPopup();

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <AnimatePresence>
      {isVisible && !isPopupOpen && (
        <>
          {/* Back to top button - now on the Left side */}
          <motion.button
            key="scroll-to-top-btn"
            initial={{ opacity: 0, scale: 0.5, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5, y: 20 }}
            onClick={handleArrowClick}
            className={`fixed bottom-6 left-6 p-3 bg-[#5A5A40]/30 text-white rounded-full shadow-lg hover:shadow-xl hover:bg-[#5A5A40]/80 backdrop-blur-md transition-all z-50 flex items-center justify-center group cursor-pointer ${
              hasActivePost ? 'ring-2 ring-violet-400/70 dark:ring-emerald-400/70' : ''
            }`}
            title={hasActivePost ? 'نقرة: اذهب إلى المنشور المحدَّد • نقرتان: أعلى القائمة' : 'نقرة: المنشور المحدَّد • نقرتان: أعلى القائمة'}
          >
            <ChevronUp size={24} className="group-hover:-translate-y-0.5 transition-transform" />
          </motion.button>

          {/* Boards floating button - now on the Right side */}
          <motion.button
            key="floating-boards-btn"
            initial={{ opacity: 0, scale: 0.5, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5, y: 20 }}
            onClick={openBoards}
            className="fixed bottom-6 right-6 px-4 py-2.5 bg-[#5A5A40]/30 text-white font-black rounded-full shadow-lg hover:shadow-xl hover:bg-[#5A5A40]/80 backdrop-blur-md transition-all z-50 flex items-center justify-center gap-1.5 cursor-pointer text-xs"
            title="اللوحات الكاملة"
            dir="rtl"
          >
            <span>اللوحات</span>
          </motion.button>
        </>
      )}
    </AnimatePresence>
  );
}
