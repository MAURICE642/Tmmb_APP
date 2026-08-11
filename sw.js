// ============================================================
// Service Worker — Triomphant MMB Service
// Stratégie : cache du shell applicatif (HTML/CSS/JS/icônes),
// réseau prioritaire pour les requêtes Firebase / API (jamais
// mises en cache), repli sur le cache si hors-ligne.
// ============================================================

// ✅ v3 : version incrémentée suite aux optimisations de performance
// (app.js/styles.css minifiés, Chart.js chargé à la demande au lieu
// d'être précaché en dur, preconnect ajoutés dans index.html). Le
// contenu de app.js/styles.css a changé même si leur nom de fichier
// reste identique — sans ce changement de version, les utilisateurs
// garderaient l'ancien contenu en cache (stratégie "cache d'abord").
const CACHE_NAME = 'mmb-service-v3'; // ⚠️ incrémentez (v4, v5, ...) à chaque déploiement pour forcer la mise à jour

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png'
];

// ── Installation : mise en cache du shell ─────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activation : suppression des anciens caches ───────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch : ne jamais intercepter Firebase / domaines externes ─
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Laisser passer directement (réseau) tout ce qui n'est pas
  // une requête GET same-origin : API Firebase, Firestore,
  // appels POST/PUT, CDN externes utilisés par l'app, etc.
  const isExternal = url.origin !== self.location.origin;
  const isGet = event.request.method === 'GET';

  if (isExternal || !isGet) {
    return; // pas de event.respondWith() => comportement réseau normal
  }

  // Pour les fichiers du shell applicatif : cache d'abord,
  // puis réseau en repli, et mise à jour silencieuse du cache.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // hors-ligne : on retombe sur le cache

      return cached || networkFetch;
    })
  );
});
