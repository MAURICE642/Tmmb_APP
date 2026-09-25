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
const CACHE_NAME = 'mmb-shell-v17';

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
  event.waitUntil((async () => {
    // Nettoyage des anciennes versions du cache.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    );

    // ── NAVIGATION PRELOAD ──
    // Sans cela, une navigation attend que le Service Worker démarre AVANT
    // que la requête réseau ne parte : sur un téléphone lent, le démarrage
    // du worker coûte à lui seul plusieurs centaines de millisecondes, et
    // ce temps est perdu. Avec le preload, le navigateur lance la requête
    // EN PARALLÈLE du démarrage du worker. Ignoré silencieusement par les
    // navigateurs qui ne le supportent pas (Safari).
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* non supporté */ }
    }

    // clients.claim() DANS le waitUntil : sinon l'activation pouvait être
    // considérée terminée avant que la prise de contrôle soit effective.
    await self.clients.claim();
  })());
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
      //
      // ⚠️ On réutilise la réponse du NAVIGATION PRELOAD quand elle existe
      // (voir activate) : sans cela, la requête lancée en parallèle par le
      // navigateur serait purement et simplement gaspillée, et on en
      // referait une seconde.
      const network = Promise.resolve(event.preloadResponse)
        .then((pre) => pre || fetch(req))
        .then((res) => {
          // ⚠️ `res.ok` est vrai pour TOUT le 2xx, y compris 206 Partial
          // Content (requête Range). Mettre un fragment en cache puis le
          // servir en réponse à une requête complète donnerait un fichier
          // TRONQUÉ — JavaScript coupé au milieu, page cassée, et le cache
          // est persistant donc la panne survivrait aux rechargements.
          // On n'accepte donc QUE les réponses 200 complètes.
          if (res && res.status === 200 && res.type !== 'opaque') {
            cache.put(req, res.clone());
          }
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
