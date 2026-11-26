// Service worker del ERP: SOLO notificaciones push. No guarda caché a propósito, para que nadie quede con
// una versión vieja de la aplicación.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    // Un reenvío del mismo aviso reemplaza al anterior en vez de duplicarse.
    tag: data.tag || undefined,
    data: { url: data.url || '/reservations' },
    requireInteraction: true,
  };
  // Con userVisibleOnly, cada push debe mostrar una notificación (iOS lo exige).
  event.waitUntil(self.registration.showNotification(data.title || 'Hotel Suite Ancla', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/reservations',
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(target);
            return;
          } catch {
            // Se abre una ventana nueva.
          }
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
