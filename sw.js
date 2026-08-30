// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — TRIOMPHANT MMB SERVICE
// Objectif : que l'app se charge INSTANTANÉMENT (shell HTML/CSS/JS/assets)
// même en 2G/connexion instable/coupure, pendant que les données métier
// (Firestore, via app.js) se synchronisent séparément en arrière-plan.
//
// ⚠️ CE SERVICE WORKER NE TOUCHE JAMAIS AUX DONNÉES MÉTIER :
// - Il n'intercepte QUE les requêtes same-origin (notre propre domaine).
// - Toutes les requêtes vers Firebase/Firestore/Auth/Storage (domaines
//   googleapis.com, firebaseio.com, cloudfunctions.net, gstatic.com) sont
//   cross-origin et donc jamais interceptées ici — elles passent normalement
//   et restent gérées par la persistance IndexedDB de Firestore elle-même.
// - Il ne fait AUCUN cache d'API, aucune donnée utilisateur : uniquement
//   les fichiers statiques qui composent l'interface.
// ═══════════════════════════════════════════════════════════════

// ⚠️ Incrémenter ce numéro à chaque déploiement pour forcer la mise à jour
// du shell chez les utilisateurs (sinon ils resteraient bloqués sur une
// version en cache). Ex : 'mmb-shell-v2', 'mmb-shell-v3', ...
const CACHE_NAME = 'mmb-shell-v10';

// Fichiers du shell applicatif à mettre en cache dès l'installation.
// Volontairement minimal et 100% same-origin (pas de CDN externe ici —
// Chart.js/polices restent gérés par le cache HTTP normal du navigateur,
// car les mettre en cache ici avec leur intégrité SRI est plus fragile).
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.min.js',
  './styles.min.css',
  './manifest.json',
  './logo.jpg',
  './icons/icon-192x192.png'
];

// ── INSTALL : précharge le shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        // Un seul fichier manquant (ex: icône renommée) ne doit pas empêcher
        // l'installation du Service Worker — on log et on continue.
        console.warn('[SW] Précache partiel (fichier(s) manquant(s) ignoré(s)) :', err);
      })
  );
  // ⚠️ On n'appelle PLUS self.skipWaiting() automatiquement ici : la nouvelle
  // version reste "en attente" (waiting) jusqu'à ce que l'utilisateur clique
  // sur "Mettre à jour" dans l'app (voir app.js). Ça évite de rafraîchir la
  // page brutalement pendant qu'un commercial est en train de saisir une
  // livraison ou une adhésion. Le passage à l'activation se fait via le
  // message 'SKIP_WAITING' ci-dessous.
});

// ── ACTIVATE : nettoie les anciens caches (versions précédentes) ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // prend le contrôle immédiatement, sans attendre un rechargement
});

// ── MESSAGE : reçoit l'ordre de l'utilisateur (via app.js) d'activer la
// nouvelle version en attente (bouton "Mettre à jour" dans l'app) ──
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FETCH : stratégie stale-while-revalidate pour le shell same-origin ──
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // On n'intercepte que le GET (jamais les écritures/POST/PUT — de toute
  // façon Firestore n'utilise pas de simples GET/POST classiques ici).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ⚠️ GARDE-FOU CRITIQUE : on ignore tout ce qui n'est pas notre propre
  // origine. Ça exclut explicitement Firebase/Firestore/Auth/Storage/CDN,
  // qui doivent toujours passer directement au réseau sans passer par ce
  // cache (sans quoi on risquerait de servir des données périmées ou de
  // casser l'authentification/la synchro temps réel).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);

      // Va chercher une version fraîche en tâche de fond, met à jour le
      // cache si ça réussit ; en cas d'échec réseau (coupure), on ignore
      // silencieusement l'erreur — la version en cache reste servie.
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      // Sert immédiatement le cache s'il existe (chargement instantané,
      // même hors-ligne ou en connexion très dégradée) ; sinon on attend
      // le réseau. Si les deux échouent (jamais visité + hors-ligne), la
      // page de secours ci-dessous est utilisée pour une navigation HTML.
      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;

      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('Hors-ligne — aucune version en cache disponible.', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })
  );
});
