// JADGPT Service Worker — PWA compliance + Web Share Target receiver
// v3 (2026-09): reports ground-truth diagnostics to the server so a phone can be measured
// without a computer. NOTE: Chrome 153 on Android has a regression that drops FILE parts
// from the share POST body (issues.chromium.org/issues/563075800).
const SW_VERSION = 'jadgpt-sw-v4';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => { if (key !== 'shared-data') return caches.delete(key); }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      const cache = await caches.open('shared-data');
      const meta = {
        swVersion: SW_VERSION, title: '', text: '', url: '',
        hasFile: false, fileCount: 0, fileBytes: 0,
        parts: [], sharingError: null, timestamp: Date.now(),
        contentLen: event.request.headers.get('content-length') || '',
        contentType: event.request.headers.get('content-type') || ''
      };

      try {
        const formData = await event.request.formData();
        for (const [key, value] of formData.entries()) {
          if (value instanceof File) {
            meta.parts.push(key + ': FILE(type=' + value.type + ', size=' + value.size + ', name=' + value.name + ')');
            if (key === 'media' && value.size > 0) {
              meta.hasFile = true;
              meta.fileCount += 1;
              meta.fileBytes += value.size;
              await cache.put('shared-file', new Response(value));
            }
          } else {
            meta.parts.push(key + ': ' + String(value).slice(0, 120));
          }
        }
        meta.title = String(formData.get('title') || '');
        meta.text = String(formData.get('text') || '');
        meta.url = String(formData.get('url') || '');
        if (!meta.hasFile) await cache.delete('shared-file');
        console.log('[SHARE-RECEIVER] ' + JSON.stringify(meta));
      } catch (error) {
        meta.sharingError = String((error && error.message) || error);
        console.error('[SHARE-RECEIVER] failed to read body:', meta.sharingError);
      }

      // Ground-truth diagnostic: uploaded from the receiver itself (fire-and-forget).
      try {
        await fetch('/api/share-diag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'sw-received', swVersion: SW_VERSION,
          ua: (self.navigator && self.navigator.userAgent) || '', meta: meta })
        });
      } catch (e) {
        console.error('[SHARE-RECEIVER] diag report failed:', e);
      }

      try {
        await cache.put('shared-meta', new Response(JSON.stringify(meta)));
      } catch (e) {
        console.error('[SHARE-RECEIVER] failed to store metadata:', e);
      }

      const q = new URLSearchParams({ shared: 'true' });
      if (meta.title) q.set('title', meta.title);
      if (meta.text) q.set('text', meta.text);
      if (meta.url) q.set('url', meta.url);
      if (!meta.hasFile) q.set('sharedNoFile', 'true');
      return Response.redirect('/?' + q.toString(), 303);
    })());
    return;
  }
});
