// ═══════════════════════════════════════════════════
//  TRIOMPHANT MMB SERVICE — Service Worker PWA
//  Cache-first pour les assets statiques,
//  Network-first pour Firebase (Firestore/Auth)
// ═══════════════════════════════════════════════════

const CACHE_NAME = 'mmb-service-v1';
const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap'
];

// ── INSTALL : mise en cache des assets statiques ──
self.addEventListener('install', event => {
  console.log('[SW] Install — cache des assets statiques');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Impossible de cacher:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE : suppression des anciens caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activate — nettoyage des anciens caches');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH : stratégie intelligente ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Firebase et APIs → Network-first (pas de cache)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('identitytoolkit') ||
    url.hostname.includes('securetoken')
  ) {
    return; // laisser passer directement
  }

  // Ressources statiques → Cache-first avec fallback réseau
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Mettre en cache uniquement les réponses valides
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback offline : retourner index.html pour la navigation
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── MESSAGE : forcer la mise à jour ──
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
