// Phone dashboard service worker: shows the pushes the relay sends (cloud/worker.js /push/notify).
// No offline cache: the page is only useful live.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data?.json() ?? {};
  } catch {}
  // Every push must show a notification (iOS revokes the subscription otherwise).
  e.waitUntil(
    self.registration.showNotification(d.title || "MYG Deck", {
      body: d.body || "확인이 필요합니다",
      tag: d.tag || "mygdeck",
      renotify: !!d.urgent,
      silent: !d.urgent,
      icon: "/icon.png",
      badge: "/icon.png",
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ open: url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
