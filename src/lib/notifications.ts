import { showToast } from '../components/Toast';

// Initialize the notification and badge managers
export const isNotificationSupported = () => {
  return typeof window !== 'undefined' && 'Notification' in window;
};

export const isBadgingSupported = () => {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
};

// Request user permission for notifications
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!isNotificationSupported()) {
    return 'denied';
  }
  
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      showToast('🔔 تم تفعيل الإشعارات . ستتلقى تنبيهات عند إضافة منشورات جديدة');
      // Show an immediate welcome notification to let the user experience it!
      sendLocalNotification('مرحباً بك في JADGPT! 🎉', {
        body: 'تم تفعيل نظام الإشعارات الذكي بنجاح. ستظهر لك التنبيهات ونقاط شارة التطبيق عند نشر منشورات جديدة من قبل المالك.',
        tag: 'welcome-notification',
      });
    } else if (permission === 'denied') {
      showToast('⚠️ تم رفض الإشعارات. يمكنك تفعيلها يدوياً من إعدادات المتصفح في هاتفك.');
    }
    return permission;
  } catch (error) {
    console.error('Error requesting notification permission:', error);
    return 'default';
  }
};

// Set App Badge count (the red dot with a number on the app icon)
export const updateAppBadge = async (count: number) => {
  if (!isBadgingSupported()) return;
  
  try {
    if (count > 0) {
      await (navigator as any).setAppBadge(count);
    } else {
      await (navigator as any).clearAppBadge();
    }
  } catch (error) {
    console.warn('Failed to set app badge:', error);
  }
};

// Send a local in-app/system notification
export const sendLocalNotification = (title: string, options?: NotificationOptions) => {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }
  
  try {
    // If we have an active service worker registration, use it to show the notification
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((registration) => {
        registration.showNotification(title, {
          icon: '/logo.png',
          badge: '/logo.png',
          vibrate: [100, 50, 100],
          ...options,
        } as any);
      }).catch(() => {
        // Fallback to standard web notification
        new Notification(title, {
          icon: '/logo.png',
          ...options,
        });
      });
    } else {
      // Fallback to standard web notification
      new Notification(title, {
        icon: '/logo.png',
        ...options,
      });
    }
  } catch (error) {
    console.error('Failed to send local notification:', error);
  }
};
