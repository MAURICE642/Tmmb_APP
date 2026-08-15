import { initializeApp, getApps, getApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, where, limit, startAfter, serverTimestamp, writeBatch, Timestamp, getAggregateFromServer, sum } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const TODAY = new Date().toISOString().split('T')[0];

// ✅ Centralisation des rôles utilisateur : évite qu'une future faute de
// frappe dans un littéral ('secretaire' vs 'secrétaire', etc.) casse
// silencieusement une vérification de permission. Utiliser ROLES.XXX au lieu
// de chaînes en dur partout où c'est syntaxiquement sûr de le faire.
const ROLES = Object.freeze({
  ADMIN: 'admin',
  COMMERCIAL: 'commercial',
  SECRETAIRE: 'secretaire',
  CHEF_AGENCE: 'chef_agence',
  GESTIONNAIRE_STOCK: 'gestionnaire_stock',
  CONTROLEUR: 'controleur',
  COMPTABLE: 'comptable',
});

// Retourne la date effective de saisie pour un commercial (toujours aujourd'hui).
function getDateEffectiveCommercial(comId) {
  return TODAY;
}
let db_fs = null, auth = null, storage = null;
let session = null, payCtx = null, adhCtx = null;
let isOnline = false;

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: CONFIG                                               ║
// ║  Extraction: node extract-modules.js → js/config.js          ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= LOCAL CACHE =========
let DB = {
  agences: [],
  commerciaux: [],
  clients: [],
  paiements: [],
  articles: [],
  produits: [],
  stockMvts: [],
  livraisons: [],
  adhesionPays: [],
  mises: [],
  primesPaliers: [],
  pointsJour: [],
  versements: [],
  transferts: [],
  recus: []
};

// ═══════════════ GESTION DES TÂCHES LONGUES (imports, etc.) ═══════════════
// Permet : 1) d'interrompre proprement une opération en cours (ex: import
// jugé erroné) sans perdre ce qui a déjà été traité ; 2) de lancer plusieurs
// opérations de même nature en parallèle sans que leurs barres de
// progression ne se superposent (elles s'empilent verticalement).
let _activeProgressTasks = new Map(); // id -> {stopRequested}
let _progressTaskSeq = 0;

function _ensureProgressContainer(){
  let container = document.getElementById('progress-tasks-container');
  if(!container){
    container = document.createElement('div');
    container.id = 'progress-tasks-container';
    container.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column-reverse;align-items:center;gap:10px;pointer-events:none;';
    document.body.appendChild(container);
  }
  return container;
}

// Démarre une tâche longue avec barre de progression empilable + bouton
// "Interrompre". label: texte affiché. total: nombre d'éléments à traiter.
// Retourne {update(count, extra), stopped(), finish()}.
function startProgressTask(label, total){
  const container = _ensureProgressContainer();
  const id = 'ptask-' + (++_progressTaskSeq);
  const el = document.createElement('div');
  el.className = 'progress-task';
  el.id = id;
  el.style.cssText = 'pointer-events:auto;background:var(--card);border:1px solid var(--border);padding:10px 14px;border-radius:10px;font-size:13px;width:280px;max-width:88vw;box-shadow:0 6px 20px rgba(0,0,0,0.35);';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;">
      <span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">⏳ ${esc(label)}</span>
      <button class="ptask-stop-btn" style="flex-shrink:0;background:rgba(224,92,82,0.12);color:var(--danger);border:1px solid rgba(224,92,82,0.3);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer;">✖ Interrompre</button>
    </div>
    <div class="ptask-text" style="font-size:11px;color:var(--muted);margin-bottom:5px;">0 / ${total}</div>
    <div style="height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">
      <div class="ptask-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.15s;"></div>
    </div>`;
  container.appendChild(el);

  const state = { stopRequested: false };
  _activeProgressTasks.set(id, state);

  el.querySelector('.ptask-stop-btn').onclick = ()=>{
    if(state.stopRequested) return;
    state.stopRequested = true;
    const btn = el.querySelector('.ptask-stop-btn');
    btn.textContent = '⏳ Arrêt…';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'default';
  };

  return {
    update(count, extra){
      const textEl = el.querySelector('.ptask-text');
      const barEl = el.querySelector('.ptask-bar');
      if(textEl) textEl.textContent = `${count} / ${total}` + (extra?` ${extra}`:'');
      if(barEl) barEl.style.width = (total>0 ? Math.min(100, Math.round(count/total*100)) : 0)+'%';
    },
    stopped(){ return state.stopRequested; },
    finish(){
      _activeProgressTasks.delete(id);
      el.remove();
    }
  };
}

// ── PERF : compteur de version pour invalider les index mémo (stats/cumulLivraisons) ──
// Incrémenté à chaque mutation de DB.paiements / DB.livraisons (ajout, modif, suppression,
// snapshot Firestore). Permet à stats() d'éviter un .filter() sur TOUTE la collection
// pour CHAQUE client affiché (gain majeur sur la page "Tous les clients").
const _dbVer = { paiements: 0, livraisons: 0, commerciaux: 0, produits: 0, articles: 0, clients: 0 };
function _touchVer(col){ if(_dbVer[col] !== undefined) _dbVer[col]++; }


// ========= SETUP & CONFIG =========
window.useLocalMode = function() {
  isOnline = false;
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('mode-badge').textContent = 'Mode local — données sur cet appareil';
  document.querySelector('.online-dot').style.background = 'var(--danger)';
  loadLocalData();
  _loadOfflineQueue();
  showLogin();
};

// ========= CHIFFREMENT CONFIG FIREBASE (AES-GCM) =========
// La config Firebase est chiffrée avant stockage dans localStorage.
// La clé AES est dérivée d'un secret persistant propre à l'appareil (stocké en sessionStorage).
// FIX 1 : cle unique par appareil (plus de cle codee en dur)
function _getOrCreateDeviceSecret() {
  const KEY = 'gestcom_device_secret';
  let secret = localStorage.getItem(KEY);
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
    localStorage.setItem(KEY, secret);
  }
  return secret;
}
async function _getCfgKey() {
  const enc = new TextEncoder();
  const secret = _getOrCreateDeviceSecret();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: enc.encode('gestcom-cfg-salt-v2'), iterations: 100000, hash:'SHA-256' },
    keyMaterial,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}
async function _saveCfgEncrypted(cfg) {
  try {
    const key = await _getCfgKey();
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(JSON.stringify(cfg)));
    const ivHex = Array.from(iv).map(b=>b.toString(16).padStart(2,'0')).join('');
    const dataHex = Array.from(new Uint8Array(cipherBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    localStorage.setItem('gestcom_firebase_cfg', ivHex + ':' + dataHex);
  } catch(e) {
    // Fallback : stockage obfusqué (base64) si SubtleCrypto indisponible
    localStorage.setItem('gestcom_firebase_cfg', btoa(JSON.stringify(cfg)));
  }
}
async function _loadCfgDecrypted() {
  const stored = localStorage.getItem('gestcom_firebase_cfg');
  if (!stored) return null;
  try {
    if (stored.includes(':')) {
      // Format chiffré AES-GCM
      const [ivHex, dataHex] = stored.split(':');
      const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b=>parseInt(b,16)));
      const data = new Uint8Array(dataHex.match(/.{2}/g).map(b=>parseInt(b,16)));
      const key = await _getCfgKey();
      const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, data);
      return JSON.parse(new TextDecoder().decode(plain));
    } else {
      // Format base64 legacy ou JSON brut
      try { return JSON.parse(atob(stored)); } catch(e2) { return JSON.parse(stored); }
    }
  } catch(e) {
    // Echec dechiffrement (ex: ancienne cle sessionStorage) — effacer et laisser le fallback hardcode prendre le relais
    localStorage.removeItem('gestcom_firebase_cfg');
    return null;
  }
}

window.connectFirebase = async function() {
  const cfg = {
    apiKey: document.getElementById('cfg-apiKey').value.trim(),
    authDomain: document.getElementById('cfg-authDomain').value.trim(),
    projectId: document.getElementById('cfg-projectId').value.trim(),
    storageBucket: document.getElementById('cfg-storageBucket').value.trim(),
    messagingSenderId: document.getElementById('cfg-messagingSenderId').value.trim(),
    appId: document.getElementById('cfg-appId').value.trim()
  };
  if (!cfg.apiKey || !cfg.projectId) {
    document.getElementById('setup-err').style.display = 'block';
    document.getElementById('setup-err').textContent = '⚠️ API Key et Project ID sont obligatoires.';
    return;
  }
  await _saveCfgEncrypted(cfg);
  await initFB(cfg);
};

async function initFB(cfg) {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('loading-screen').classList.remove('hidden');
  document.getElementById('load-text').textContent = 'Connexion à Firebase...';
  try {
    // Évite l'erreur "Firebase App named '[DEFAULT]' already exists" :
    // si une app par défaut existe déjà (ex: init automatique au chargement
    // de la page), on la réutilise si la config est identique, sinon on la
    // supprime proprement avant de réinitialiser avec la nouvelle config.
    const existing = getApps();
    let app;
    if (existing.length > 0) {
      const current = getApp();
      const sameCfg = current.options && current.options.apiKey === cfg.apiKey && current.options.projectId === cfg.projectId;
      if (sameCfg) {
        app = current;
      } else {
        try { await deleteApp(current); } catch(e) { /* ignore */ }
        app = initializeApp(cfg);
      }
    } else {
      app = initializeApp(cfg);
    }
    db_fs = getFirestore(app);
    auth = getAuth(app);
    storage = getStorage(app);
    _registerAuthStateListener(); // FIX BLOCAGE UI : enregistrer le listener maintenant que 'auth' existe
    // Auth Firebase réelle : la connexion se fait via doLogin() (email + mot de passe)
    // On ne fait plus de signInAnonymously ici.
    isOnline = true;
    // ✅ ORDRE CONNEXION CORRIGÉ : on n'essaie plus de charger les données
    // avant authentification (évite la collision avec les règles Firestore isAuth()).
    // Les collections sont chargées dans doLogin() après signInWithEmailAndPassword().
    document.getElementById('loading-screen').classList.add('hidden');
    showLogin();
  } catch(e) {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
    document.getElementById('setup-err').style.display = 'block';
    document.getElementById('setup-err').textContent = '❌ Erreur : ' + e.message + '. Vérifiez votre configuration.';
  }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: FIREBASE_CORE                                        ║
// ║  Extraction: node extract-modules.js → js/firebase_core.js   ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= FIREBASE DATA =========
// Collections déjà chargées en mémoire
const _loadedCols = new Set();

// ── Taille de page pour les collections volumineuses (admin) ──
// ✅ FIX COÛT : réduit de 2000 à 500. Le chargement initial automatique
// (ouverture de page) est donc 4x moins coûteux en lectures facturées.
// Pour les collections qui dépassent 500 documents, le bouton admin
// "charger plus" (loadMoreCol) permet de charger les pages suivantes à la
// demande, sans payer ce coût pour tout le monde à chaque ouverture de page.
const _PAGE_SIZE = 500;

// ── FIX FIABILITÉ (admin/secrétaire/contrôleur) ──────────────────
// 'clients' et 'paiements' alimentent des vues qui doivent être exactes
// (dashboard, registre, historique, recouvrement...) : on les charge donc
// intégralement en boucle automatique dès qu'on en a besoin, au lieu de
// s'arrêter après une seule page de _PAGE_SIZE et d'attendre un clic manuel
// sur "charger plus". Les autres grosses collections (pointsJour,
// versements, stockMvts...) restent en pagination manuelle pour contenir le
// coût, car elles ne sont pas utilisées pour des totaux affichés partout.
const _AUTO_FULL_LOAD_COLS = new Set(['clients','paiements','livraisons','recus']);
// Garde-fou : nombre max de pages chargées en boucle synchrone en un seul
// appel (évite de bloquer l'UI si le volume est extrême). Si dépassé, le
// reste se charge en tâche de fond via un rappel automatique.
const _MAX_AUTO_PAGES = 10;

// ── PERF / COÛT : fenêtre du listener temps réel admin (collections volumineuses) ──
// Le chargement initial complet (pagination "charger plus") utilise _PAGE_SIZE (2000)
// pour parcourir tout l'historique. Le LISTENER temps réel, lui, n'a besoin de
// surveiller qu'une fenêtre récente pour détecter les nouveaux docs/modifs — il
// n'a pas besoin de relire 2000 docs à chaque connexion. Réduire cette fenêtre
// réduit fortement les lectures Firestore facturées à chaque login admin, sans
// rien retirer au chargement complet par pagination.
const _LISTENER_WINDOW = 200;

// Collections "légères" — toujours chargées en entier (peu de documents)
const _SMALL_COLS = new Set(['commerciaux','agences','articles','produits','primesPaliers']);

// ── COÛT : collections sans listener temps réel ──
// Pour ces collections, pas d'abonnement onSnapshot persistant : les données
// sont simplement (re)chargées via getDocs() à chaque ouverture de la page qui
// en a besoin. Adapté aux données peu consultées / peu critiques en temps réel
// (ex. historique des transferts), pour éviter le coût d'un listener ouvert
// toute la session pour une collection rarement modifiée pendant qu'on regarde
// d'autres pages.
const _NO_REALTIME_COLS = new Set(['transferts']);

// ── COÛT : collections sans listener temps réel, MAIS UNIQUEMENT pour le
// staff (admin/secrétaire/contrôleur/gestionnaire_stock) ──
// 'pointsJour' et 'versements' sont des collections volumineuses dont le
// staff n'a pas besoin d'un suivi seconde par seconde (contrairement à
// 'clients'/'paiements'). Sur 'admin-dashboard' notamment, chaque listener
// ouvert facture une lecture supplémentaire à CHAQUE écriture faite par
// N'IMPORTE QUEL commercial pendant que l'admin est connecté (effet de
// fan-out propre à onSnapshot) — réduire le nombre de listeners permanents
// réduit directement la taille des pics observés lors des heures de pointe.
// Pour les commerciaux, ces deux collections restent en temps réel (ils ont
// besoin de voir leurs propres saisies se refléter immédiatement) — voir
// l'utilisation conditionnelle au rôle ci-dessous dans _queryForCol /
// _listenerCoversFullLoad.
const _NO_REALTIME_FOR_STAFF = new Set(['pointsJour','versements']);

// Curseurs de pagination pour l'admin (collections volumineuses)
const _pageCursors = {};

// ✅ FIX DOUBLE LECTURE : timestamp _ts le plus récent déjà chargé en mémoire
// (via getDocs) pour chaque collection volumineuse côté admin/secrétaire/etc.
// Sert à éviter que le listener temps réel ne relise (et refacture) les mêmes
// documents que ceux déjà obtenus par le chargement paginé initial : au lieu
// de toujours relire une fenêtre fixe des _LISTENER_WINDOW derniers documents,
// le listener ne lira que les documents créés/modifiés APRÈS ce timestamp.
const _maxTsLoaded = {};

function _trackMaxTs(col, docs) {
  for (const d of docs) {
    const ts = d._ts && typeof d._ts.toMillis === 'function' ? d._ts.toMillis() : null;
    if (ts === null) continue;
    if (!_maxTsLoaded[col] || ts > _maxTsLoaded[col]) _maxTsLoaded[col] = ts;
  }
}

// Charger une collection en tenant compte du rôle
// ✅ FIX LATENCE + COÛT : cache localStorage avec durée de vie (TTL), au lieu
// de sessionStorage. sessionStorage est perdu à chaque nouvel onglet/nouvelle
// connexion, donc 2 admins (ou 1 admin sur 2 onglets) repayaient le getDocs()
// complet chacun. localStorage est partagé entre onglets et survit aux
// reconnexions rapprochées : tant que le TTL n'est pas expiré, on réutilise
// les données déjà lues sans repayer de lecture Firestore. Le TTL borne le
// risque de données obsolètes (au-delà, on relit). Toujours invalidé à la
// déconnexion via doLogout() (_cacheClear).
const _SS_PREFIX = 'gestcom_cache_';
const _CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
function _cacheWrite(col, data) {
  try {
    localStorage.setItem(_SS_PREFIX + col, JSON.stringify({ t: Date.now(), d: data }));
  } catch(e) {}
}
// ✅ FIX RECHARGEMENT INUTILE : le cache ne périme plus avec le temps (TTL
// supprimé). Une fois chargées, les grosses collections restent en cache
// localStorage indéfiniment d'une connexion à l'autre — c'est le listener
// onSnapshot (voir setupPageListeners) qui garde les données à jour en
// tâche de fond ET réécrit le cache à chaque changement réel reçu (voir
// _cacheWrite appelé dans le handler onSnapshot). Le cache n'est donc plus
// invalidé par le temps qui passe, seulement par : (a) une mise à jour
// effective de la donnée, ou (b) une déconnexion (_cacheClear dans
// doLogout), ou (c) le bouton "recharger" existant.
function _cacheRead(col) {
  try {
    const raw = localStorage.getItem(_SS_PREFIX + col);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Compat anciens caches sessionStorage (format brut sans { t, d })
    if (!parsed || typeof parsed !== 'object' || !('t' in parsed)) return null;
    return parsed.d;
  } catch(e) { return null; }
}
function _cacheClear() {
  Object.keys(localStorage).filter(k => k.startsWith(_SS_PREFIX))
    .forEach(k => localStorage.removeItem(k));
  // Nettoie aussi l'ancien sessionStorage au cas où (migration douce)
  try {
    Object.keys(sessionStorage).filter(k => k.startsWith(_SS_PREFIX))
      .forEach(k => sessionStorage.removeItem(k));
  } catch(e) {}
}
async function _loadCol(col) {
  if (!db_fs) return;
  const role = session ? session.role : null;
  const uid  = session ? session.userId : null;

  // Collections légères → chargement complet (avec cache localStorage avec TTL)
  if (_SMALL_COLS.has(col)) {
    const cached = _cacheRead(col);
    if (cached) { DB[col] = cached; _loadedCols.add(col); return; }
    const snap = await getDocs(collection(db_fs, col));
    DB[col] = snap.docs.map(d => ({...d.data(), _id: d.id}));
    _cacheWrite(col, DB[col]);
    _loadedCols.add(col);
    return;
  }

  // Collections volumineuses : filtrage par rôle
  const colRef = collection(db_fs, col);

  if (role ===ROLES.COMMERCIAL) {
    // ✅ FIX COÛT : cache TTL réutilisé pour les requêtes simples du
    // commercial (auparavant aucune mise en cache ici → relecture Firestore
    // garantie à chaque navigation, notamment pour 'transferts' qui était
    // invalidé de force à chaque ouverture de page).
    const _commercialCacheKey = col + ':' + uid;
    // Commercial → uniquement SES données
    let q;
    if (col === 'clients') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'paiements') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'mises') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'adhesionPays') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'rachatCarnetPays') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'livraisons') {
      // Livraisons filtrées par clients du commercial
      const clientIds = DB.clients.map(c => c._id);
      if (!clientIds.length) { DB[col] = []; _loadedCols.add(col); return; }
      // Firestore limite 'in' à 30 éléments — on charge par tranches
      const chunks = [];
      for (let i = 0; i < clientIds.length; i += 30) chunks.push(clientIds.slice(i, i+30));
      const results = [];
      for (const chunk of chunks) {
        const snap = await getDocs(query(colRef, where('clientId', 'in', chunk)));
        snap.docs.forEach(d => results.push({...d.data(), _id: d.id}));
      }
      DB[col] = results;
      _loadedCols.add(col);
      return;
    } else if (col === 'pointsJour') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'versements') {
      q = query(colRef, where('commercialId', '==', uid));
    } else if (col === 'transferts') {
      q = query(colRef, where('operateurId', '==', uid));
    } else if (col === 'stockMvts') {
      q = query(colRef, limit(_PAGE_SIZE));
    } else {
      q = query(colRef, limit(_PAGE_SIZE));
    }
    const cached = _cacheRead(_commercialCacheKey);
    // ✅ FIX SYNCHRO CACHE : sans ce _trackMaxTs, _maxTsLoaded[col] restait
    // vide après une restauration depuis le cache (au lieu d'un getDocs()) —
    // le listener onSnapshot (_queryForCol) ne pouvait alors pas distinguer
    // "collection chargée en entier via cache" de "jamais chargée", et
    // retombait sur une relecture de _LISTENER_WINDOW documents à chaque
    // fois au lieu d'un vrai delta (uniquement ce qui a changé).
    if (cached) { DB[col] = cached; _loadedCols.add(col); _trackMaxTs(col, cached); return; }
    const snap = await getDocs(q);
    DB[col] = snap.docs.map(d => ({...d.data(), _id: d.id}));
    _cacheWrite(_commercialCacheKey, DB[col]);
    _loadedCols.add(col);

  } else {
    // Admin / Secrétaire / Contrôleur / Gestionnaire stock
    // ── PERF / COÛT : si cette collection a déjà été entièrement chargée
    // pendant cette session navigateur (cache localStorage avec TTL), on la restaure
    // depuis le cache au lieu de relire toutes les pages Firestore — gain
    // important lors d'un rafraîchissement de page (F5) en cours de session.
    // Le cache est invalidé par les mécanismes existants (logout, bouton
    // "recharger" qui fait localStorage.removeItem(_SS_PREFIX+col)).
    if (!_pageCursors[col] && (!DB[col] || !DB[col].length)) {
      const cached = _cacheRead(col);
      // ✅ FIX SYNCHRO CACHE : idem chemin commercial ci-dessus — sans ce
      // _trackMaxTs, le listener temps réel ne connaît pas le point de
      // reprise et relit une fenêtre entière au lieu du delta réel.
      if (cached) { DB[col] = cached; _loadedCols.add(col); _trackMaxTs(col, cached); return; }
    }
    // Chargement paginé (500 à la fois) — les données précédentes sont conservées
    if (!DB[col]) DB[col] = [];

    // ✅ FIX FIABILITÉ : pour 'clients'/'paiements' (voir _AUTO_FULL_LOAD_COLS),
    // on boucle sur les pages jusqu'à tout charger au lieu de s'arrêter après
    // une seule page — sinon les vues (dashboard, registre, historique...)
    // affichaient des totaux/listes calculés sur une fraction arbitraire des
    // données tant que l'admin n'avait pas cliqué "charger plus" autant de
    // fois que nécessaire.
    const autoFull = _AUTO_FULL_LOAD_COLS.has(col);
    let pagesLoaded = 0;
    let fullyLoaded = false;

    do {
      let q;
      const cursor = _pageCursors[col];
      if (cursor) {
        q = query(colRef, orderBy('__name__'), startAfter(cursor), limit(_PAGE_SIZE));
      } else {
        q = query(colRef, orderBy('__name__'), limit(_PAGE_SIZE));
      }
      const snap = await getDocs(q);
      const newDocs = snap.docs.map(d => ({...d.data(), _id: d.id}));
      _trackMaxTs(col, newDocs); // ✅ FIX DOUBLE LECTURE : mémorise le _ts max déjà lu

      // Fusionner sans doublons
      const existing = new Map(DB[col].map(d => [d._id, d]));
      newDocs.forEach(d => existing.set(d._id, d));
      DB[col] = [...existing.values()];

      pagesLoaded++;

      if (snap.docs.length === _PAGE_SIZE) {
        // Il y a peut-être plus de données — sauvegarder le curseur
        _pageCursors[col] = snap.docs[snap.docs.length - 1];
      } else {
        // Tout est chargé — on met en cache pour éviter de relire au prochain F5
        delete _pageCursors[col];
        _loadedCols.add(col);
        _cacheWrite(col, DB[col]);
        fullyLoaded = true;
      }
    } while (autoFull && !fullyLoaded && pagesLoaded < _MAX_AUTO_PAGES);

    // Garde-fou atteint mais il reste des pages : on continue en tâche de
    // fond (sans bloquer l'appel courant) et on rafraîchit l'affichage à la
    // volée quand ces pages supplémentaires arrivent.
    if (autoFull && !fullyLoaded && _pageCursors[col]) {
      setTimeout(() => {
        _loadCol(col).then(() => {
          if (session && curPg) renderPg(curPg);
        });
      }, 50);
    }
  }
}

// ── FIX FIABILITÉ VUES "DU JOUR" ────────────────────────────────
// Problème résolu : 'registre' et 'fiche du jour' filtraient DB.paiements /
// DB.adhesionPays, des tableaux qui ne contiennent que les pages déjà
// chargées en mémoire (pagination par _PAGE_SIZE sur des collections pouvant
// dépasser le million de documents). Un paiement du jour pouvait donc être
// absent de la vue tant qu'il n'avait pas été rattrapé par le chargement
// paginé complet — d'où des données "pas conformes tout de suite".
// Solution : interroger Firestore directement avec where('date','==',date).
// Le volume renvoyé pour UN seul jour reste petit (quelques centaines de
// documents au plus, même à 25 commerciaux actifs), donc c'est rapide et peu
// coûteux, et surtout TOUJOURS exact — indépendamment de la taille totale de
// la collection ou de ce qui a déjà été chargé en mémoire.
// ── FIX PERFORMANCE : totaux du dashboard admin ─────────────────
// Avant : totalGlobal ("CA total recouvré") = somme de TOUS les paiements
// présents en mémoire, ce qui suppose la collection entière (jusqu'à 1M de
// documents) chargée côté client. Après : requête d'agrégation Firestore
// (SUM calculé côté serveur) qui ne transfère qu'un seul nombre.
// NB : nécessite éventuellement un index composite si Firestore le demande
// au premier lancement (un lien de création directe apparaît dans l'erreur
// console) — à tester en environnement de dev avant la mise en prod.
function _chunkArray(arr, size) {
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}
async function _sumPaiementsMontant(commercialIds, dateFrom, dateTo) {
  if (!db_fs) {
    let arr = DB.paiements || [];
    if (commercialIds) arr = arr.filter(p=>commercialIds.includes(p.commercialId));
    if (dateFrom) arr = arr.filter(p=>p.date>=dateFrom);
    if (dateTo) arr = arr.filter(p=>p.date<=dateTo);
    return arr.reduce((a,p)=>a+(p.montant||0),0);
  }
  const colRef = collection(db_fs, 'paiements');
  // Firestore limite les clauses 'in' à 30 valeurs : on découpe en tranches.
  const idChunks = commercialIds ? _chunkArray(commercialIds, 30) : [null];
  let total = 0;
  for (const chunk of idChunks) {
    const constraints = [];
    if (chunk) constraints.push(where('commercialId','in', chunk));
    if (dateFrom) constraints.push(where('date','>=', dateFrom));
    if (dateTo) constraints.push(where('date','<=', dateTo));
    const q = constraints.length ? query(colRef, ...constraints) : query(colRef);
    const snap = await getAggregateFromServer(q, { total: sum('montant') });
    total += snap.data().total || 0;
  }
  return total;
}
// Récupère les documents 'paiements' d'une plage de dates (ex: le mois en
// cours) et les fusionne dans DB.paiements — utile quand on a besoin du
// détail (pas juste d'un total), ex: répartition par commercial.
// ✅ FIX COÛT/LATENCE : cache TTL (30s, même logique que _fetchColByDate).
// Sans ce cache, le dashboard admin relançait cette requête (jusqu'à 366+
// jours de paiements) à CHAQUE re-rendu déclenché par le listener temps réel
// sur 'paiements' — lequel n'est pas filtré par agence et se déclenche donc
// à CHAQUE paiement saisi par N'IMPORTE QUEL commercial du système pendant
// que l'admin regarde son dashboard. Résultat : lectures Firestore
// redondantes et ralentissement perceptible du tableau de bord à chaque
// synchro terrain, même sans action de l'admin.
const _rangeFetchCache = {}; // clé: "dateFrom:dateTo" -> timestamp du dernier fetch
const _RANGE_FETCH_TTL_MS = 30 * 1000; // 30 secondes
async function _fetchPaiementsDateRange(dateFrom, dateTo) {
  if (!db_fs) return (DB.paiements||[]).filter(p=>p.date>=dateFrom && p.date<=dateTo);
  const cacheKey = dateFrom + ':' + dateTo;
  const lastFetch = _rangeFetchCache[cacheKey];
  if (lastFetch && (Date.now() - lastFetch) <= _RANGE_FETCH_TTL_MS) {
    // Fetch récent pour cette plage : on réutilise DB.paiements sans repayer
    // de lecture Firestore.
    return (DB.paiements||[]).filter(p=>p.date>=dateFrom && p.date<=dateTo);
  }
  const colRef = collection(db_fs, 'paiements');
  const snap = await getDocs(query(colRef, where('date','>=', dateFrom), where('date','<=', dateTo)));
  const docs = snap.docs.map(d => ({...d.data(), _id: d.id}));
  if (!DB.paiements) DB.paiements = [];
  const existing = new Map(DB.paiements.map(d => [d._id, d]));
  docs.forEach(d => existing.set(d._id, d));
  DB.paiements = [...existing.values()];
  _rangeFetchCache[cacheKey] = Date.now();
  return docs;
}

// Récupère TOUS les paiements historiques enregistrés au nom d'un
// commercial donné (peu importe la date), directement depuis Firestore —
// utilisé pour le "Contrôle avant départ" où il faut la liste complète des
// clients ayant réellement payé avec lui, même des mois/années en arrière,
// sans dépendre de ce qui est déjà chargé en mémoire dans DB.paiements.
async function _fetchPaiementsParCommercial(comId){
  if (!db_fs) return (DB.paiements||[]).filter(p=>p.commercialId===comId);
  const colRef = collection(db_fs, 'paiements');
  const snap = await getDocs(query(colRef, where('commercialId','==', comId)));
  return snap.docs.map(d => ({...d.data(), _id: d.id}));
}

let _dateQueryToken = 0;
let _ficheDateQueryToken = 0;
// ✅ FIX COÛT : cache court (par collection+date) pour _fetchColByDate.
// Plusieurs pages différentes (Registre, Fiche, Historique, Recouvrement,
// Dashboard) demandent souvent la MÊME date (ex: TODAY) à quelques secondes
// d'intervalle en naviguant. Sans ce cache, chaque page relançait un
// getDocs() Firestore identique. TTL volontairement court (30s) car ces
// données (paiements/adhésions du jour) peuvent changer en cours de journée.
const _dateFetchCache = {}; // clé: "col:date" -> timestamp du dernier fetch
const _DATE_FETCH_TTL_MS = 30 * 1000; // 30 secondes

async function _fetchColByDate(col, date) {
  if (!db_fs) {
    // Mode démo / hors-ligne (pas de Firestore) : on retombe sur la mémoire.
    return (DB[col]||[]).filter(d => d.date === date);
  }
  const cacheKey = col + ':' + date;
  const lastFetch = _dateFetchCache[cacheKey];
  if (lastFetch && (Date.now() - lastFetch) <= _DATE_FETCH_TTL_MS) {
    // Fetch récent pour cette collection+date : on réutilise DB[col] sans
    // repayer de lecture Firestore.
    return (DB[col]||[]).filter(d => d.date === date);
  }
  const colRef = collection(db_fs, col);
  // FIX TIMEOUT : limite la requête à 15 secondes pour éviter un blocage infini.
  // Si Firestore ne répond pas (réseau lent, règles bloquantes, index manquant),
  // on affiche un message d'erreur clair plutôt que rester bloqué indéfiniment.
  const fetchPromise = getDocs(query(colRef, where('date','==', date)));
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Délai dépassé (15s) — vérifiez votre connexion ou les règles Firestore')), 15000)
  );
  const snap = await Promise.race([fetchPromise, timeoutPromise]);
  const docs = snap.docs.map(d => ({...d.data(), _id: d.id}));
  // Fusion (sans doublons) dans DB[col] : le reste de l'appli qui lit
  // DB[col] bénéficie aussi de données fraîches pour cette date.
  if (!DB[col]) DB[col] = [];
  const existing = new Map(DB[col].map(d => [d._id, d]));
  docs.forEach(d => existing.set(d._id, d));
  DB[col] = [...existing.values()];
  _dateFetchCache[cacheKey] = Date.now();
  return docs;
}

// ✅ PERF/COÛT : verrou "chargement en cours" par collection. Sans ça, deux
// appels à ensureCollectionsLoaded() pour la même collection avant que le
// premier _loadCol() ait fini (ex: deux recherches rapides, deux pages
// ouvertes coup sur coup) déclenchaient CHACUN leur propre getDocs() en
// double, puisque _loadedCols n'est marqué qu'à la fin du chargement. On
// fait maintenant attendre la même promesse en cours au lieu d'en relancer
// une nouvelle.
const _loadColInFlight = new Map(); // col -> Promise en cours
function _loadColOnce(col) {
  if (_loadColInFlight.has(col)) return _loadColInFlight.get(col);
  const p = _loadCol(col).finally(() => _loadColInFlight.delete(col));
  _loadColInFlight.set(col, p);
  return p;
}

async function ensureCollectionsLoaded(cols) {
  const missing = cols.filter(c => !_loadedCols.has(c));
  if (!missing.length) return;
  // ✅ FIX LATENCE : toutes les collections chargées en parallèle (Promise.all).
  // Avant : les big cols étaient séquentielles (chacune attendait la précédente).
  // ✅ FIX FIABILITÉ : Promise.allSettled au lieu de Promise.all — si UNE collection
  // échoue (permission refusée, réseau, index manquant...), les autres se chargent
  // quand même et la page s'affiche avec ce qui a pu être récupéré, au lieu de
  // rester entièrement vide à cause d'un seul échec.
  const results = await Promise.allSettled(missing.map(c => _loadColOnce(c)));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(missing[i]);
      console.error(`[ensureCollectionsLoaded] Échec du chargement de "${missing[i]}" :`, r.reason);
    }
  });
  if (failed.length) {
    notify(`⚠️ Certaines données n'ont pas pu être chargées (${failed.join(', ')}). La page peut être incomplète.`, 'err');
  }
}

// Charger la page suivante d'une collection volumineuse (bouton admin "charger plus")
window.loadMoreCol = async function(col) {
  if (!_pageCursors[col]) { notify('Toutes les données sont chargées'); return; }
  await _loadColOnce(col);
  if (session && curPg) renderPg(curPg);
  notify(`${DB[col].length} enregistrements chargés`);
};

// ── Fusion commerciaux + commerciauxPrive ───────────────────────
// commerciauxPrive contient les champs sensibles (tel, zone, codePrefix, clientSeq)
// commerciaux contient les champs publics (nom, role, email, agenceId)
// Après chargement des deux collections, on fusionne sur l'_id commun.
// Les champs de commerciauxPrive écrasent ceux de commerciaux si présents.
function _mergeCommerciaux() {
  if (!DB.commerciaux) return;
  // ✅ FIX _mergeCommerciaux : fusion complète des deux collections.
  // commerciaux (public)  : nom, role, email, agenceId
  // commerciauxPrive (privé) : tel, zone, codePrefix, clientSeq
  // Règle : commerciauxPrive a la priorité sur les champs sensibles.
  // Si commerciauxPrive n'est pas encore chargé, on garde les champs
  // publics tels quels (évite une régression si appelé trop tôt).
  if (!DB.commerciauxPrive || DB.commerciauxPrive.length === 0) return;
  const priveMap = new Map(DB.commerciauxPrive.map(p => [p._id, p]));
  DB.commerciaux = DB.commerciaux.map(c => {
    const prive = priveMap.get(c._id);
    if (!prive) return c; // pas de données privées pour ce commercial
    // Merge : tous les champs publics + champs sensibles de commerciauxPrive
    // Les champs privés ont la priorité (??= : on ne les écrase pas si déjà définis)
    return {
      ...c,                                          // nom, role, email, agenceId (public)
      tel:        prive.tel        ?? c.tel        ?? '',
      zone:       prive.zone       ?? c.zone       ?? '',
      codePrefix: prive.codePrefix ?? c.codePrefix ?? '',
      clientSeq:  prive.clientSeq  ?? c.clientSeq  ?? 0,
      // Propager tout champ supplémentaire présent dans commerciauxPrive
      // (ex: champs futurs ajoutés sans modifier cette fonction)
      ...Object.fromEntries(
        Object.entries(prive)
          .filter(([k]) => !['_id','nom','role','email','agenceId'].includes(k))
          .map(([k,v]) => [k, v ?? c[k]])
      ),
    };
  });
  // ✅ Mettre à jour le cache localStorage après fusion
  _cacheWrite('commerciaux', DB.commerciaux);
}

// Conservé pour la compatibilité avec initDemoFirebase (appelé au premier login)
async function loadFirebaseData() {
  // FIX : ne charger QUE 'commerciaux' avant la connexion. 'commerciauxPrive'
  // et 'agences' exigent un utilisateur authentifié (règles Firestore) et
  // sont déjà rechargées correctement après connexion dans doLogin().
  // Les charger ici provoquait "Missing or insufficient permissions" pour
  // TOUT LE MONDE, avant même d'atteindre l'écran de connexion.
  await ensureCollectionsLoaded(['commerciaux']);
  _mergeCommerciaux();
  if (DB.commerciaux.length === 0) await initDemoFirebase();
}

// Mapping : quelles collections déclenchent un re-rendu par page
const _PAGE_DEPS = {
  'admin-dashboard':    ['clients','paiements','mises','adhesionPays','commerciaux','agences','primesPaliers','pointsJour','versements'],
  'tous-clients':       ['paiements','commerciaux'],
  // ✅ FIX PAGE_DEPS : 'controle' affichait retard/niveau via stats(c), qui a
  // besoin de DB.paiements (_payIndex) et DB.livraisons (cumulLivraisons).
  // Ces deux collections n'étaient pas listées comme dépendance de la page :
  // rien ne garantissait qu'elles soient chargées avant le premier rendu,
  // donc retard/niveau pouvaient s'afficher à 0/faux jusqu'à ce qu'une AUTRE
  // page les charge en arrière-plan et déclenche un re-render tardif —
  // donnant l'impression que la page "rattrape" son retard après un délai.
  'controle':           ['clients','commerciaux','paiements','livraisons'],
  'articles':           ['articles'],
  'produits':           ['produits','articles'],
  'catalogue':          ['articles'],
  'stock':              ['articles','stockMvts'],
  'livraisons':         ['livraisons','clients','commerciaux','paiements','produits','agences'],
  'historique':         ['paiements','clients','commerciaux','adhesionPays','mises','agences'],
  'registre':           ['paiements','clients','commerciaux','adhesionPays','mises','pointsJour','versements','agences'],
  'commerciaux':        ['commerciaux','agences'],
  'agences':            ['agences','commerciaux'],
  'recouvrement':       ['clients','paiements','commerciaux'],
  'fiche':              ['paiements','livraisons','adhesionPays','rachatCarnetPays','mises','versements','clients','commerciaux'],
  'saisie-mises':       ['mises','clients','commerciaux','primesPaliers','versements'],
  'saisie-adhesions':   ['adhesionPays','rachatCarnetPays','clients','commerciaux'],
  'com-clients':        ['clients','paiements','commerciaux'],
  'com-nouveau-client': ['commerciaux','agences'],
  'transfert-resiliation': ['clients','paiements','commerciaux','transferts'],
  'depenses-commerciaux':  ['depenses','commerciaux','agences','primesPaliers'],
  'historique-recus':      ['recus','commerciaux','agences'],
  'controle-depart':       ['clients','commerciaux','agences'], // paiements chargés à la demande (voir _fetchPaiementsParCommercial)
  // ✅ FIX PAGE_DEPS : 'rapport-activite' était ABSENTE de cet objet →
  // setupPageListeners() ne déclenchait AUCUN chargement pour cette page,
  // le rapport se calculait uniquement sur ce qui était déjà en mémoire
  // (souvent incomplet pour rachatCarnetPays/stockMvts, jamais préchargées
  // ailleurs de façon fiable) → sections du rapport à 0 silencieusement.
  'rapport-activite':      ['paiements','adhesionPays','rachatCarnetPays','livraisons','mises','stockMvts','clients','agences','commerciaux','primesPaliers'],
  // ✅ FIX PAGE_DEPS : même problème pour 'gstock-periode' (Suivi de
  // période, gestionnaire de stock) — dépend de stockMvts/livraisons/
  // articles mais n'avait aucune entrée ici.
  'gstock-periode':        ['stockMvts','livraisons','articles'],
};

// ✅ FIX 10 : constantes nommées pour tous les délais setTimeout
const DELAY_CHART_RENDER_MS  = 80;  // attendre le layout DOM avant de dessiner un canvas
const DELAY_CODE_SUGGEST_MS  = 100; // délai avant suggestion de code client
const DELAY_CODE_SUGGEST2_MS = 300; // délai suggestion code client (saisie lente)
const DELAY_NOTIFY_HIDE_MS   = 2500;// durée affichage notification ok
const DELAY_ANIM_RESET_MS    = 700; // reset animation bouton
const DELAY_RENDER_DEBOUNCE_MS = 300; // debounce re-render onSnapshot

// ✅ FIX 11 : debounce par page (Map) au lieu d'un timer global partagé.
// Avant : deux pages déclenchant un re-render simultané s'annulaient mutuellement.
// ── FIX VISIBILITÉ SYNCHRO TEMPS RÉEL ──────────────────────────
// Le mécanisme de re-rendu automatique (listener → _debouncedRenderPg)
// existait déjà, mais il agissait silencieusement : rien n'indiquait à
// l'admin qu'une donnée venait d'arriver du terrain. On ajoute un badge
// visuel discret, qui apparaît brièvement à chaque synchronisation reçue
// pendant que l'admin consulte registre / fiche du jour / historique /
// recouvrement.
const _LIVE_SYNC_PAGES = new Set(['registre','fiche','historique','recouvrement']);
let _liveSyncBadgeTimer = null;
function _signalLiveSync(pageId, pending) {
  if (!_LIVE_SYNC_PAGES.has(pageId)) return;
  let badge = document.getElementById('_live-sync-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = '_live-sync-badge';
    badge.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;'
      + 'background:rgba(34,212,160,0.95);color:#0a0e17;font-size:12px;font-weight:700;'
      + 'padding:8px 14px;border-radius:20px;box-shadow:0 4px 16px rgba(0,0,0,0.3);'
      + 'display:flex;align-items:center;gap:6px;opacity:0;transition:opacity 0.3s;pointer-events:none;';
    badge.innerHTML = '<span id="_live-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#0a0e17;display:inline-block;"></span><span id="_live-sync-badge-txt"></span>';
    document.body.appendChild(badge);
  }
  const now = new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  if (pending) {
    // Mise à jour reçue mais pas encore affichée (utilisateur actif)
    document.getElementById('_live-sync-badge-txt').textContent = `Mise à jour terrain en attente — ${now}`;
    badge.style.background = 'rgba(201,168,76,0.95)';
  } else {
    // Rendu effectué — données à jour
    document.getElementById('_live-sync-badge-txt').textContent = `Terrain synchronisé — ${now}`;
    badge.style.background = 'rgba(34,212,160,0.95)';
  }
  badge.style.opacity = '1';
  if (_liveSyncBadgeTimer) clearTimeout(_liveSyncBadgeTimer);
  _liveSyncBadgeTimer = setTimeout(() => { badge.style.opacity = '0'; }, 3500);
}

const _renderDebounceTimers = new Map();
// ✅ FIX CLIGNOTEMENT : le re-rendu complet à chaque synchro terrain
// effaçait/réécrivait tout le DOM → clignotement visible et désagréable.
// Solution : on diffère le re-rendu pendant que l'utilisateur est actif
// (mouvement souris / frappe clavier récente dans les 4 dernières secondes).
// Dès qu'il s'arrête, le rendu se fait silencieusement. Le badge de synchro
// reste affiché sans déclencher de re-rendu parasite.
let _lastUserActivity = 0;
['mousemove','keydown','touchstart','scroll'].forEach(ev =>
  document.addEventListener(ev, () => { _lastUserActivity = Date.now(); }, {passive:true})
);
function _isUserActive() { return Date.now() - _lastUserActivity < 4000; }

function _debouncedRenderPg(id) {
  if (_renderDebounceTimers.has(id)) clearTimeout(_renderDebounceTimers.get(id));
  const attempt = () => {
    if (!session || curPg !== id) return;
    if (_isUserActive()) {
      // L'utilisateur est actif : signaler "en attente" et reporter de 1s
      _signalLiveSync(id, true);
      _renderDebounceTimers.set(id, setTimeout(attempt, 1000));
    } else {
      _renderDebounceTimers.delete(id);
      renderPg(id);
      _signalLiveSync(id, false);
    }
  };
  _renderDebounceTimers.set(id, setTimeout(attempt, DELAY_RENDER_DEBOUNCE_MS));
}

// ── Listeners temps-réel persistants, indexés par collection ──
// ✅ FIX LECTURES FIRESTORE (v2) : un listener, une fois ouvert pour une
// collection, reste actif pour TOUTE la durée de la session — il n'est plus
// jamais coupé lors de la navigation entre pages (seul doLogout() les ferme
// tous via _unsubscribeAll()). Avant, on ne gardait que les listeners utiles
// à la page courante et on coupait les autres : avec des dépendances de pages
// très disjointes (ex: 'articles' n'apparaît que dans 4 pages sur 19), cela
// provoquait une destruction/recréation permanente — donc une relecture
// complète de la collection — à chaque fois qu'on quittait puis revenait sur
// une page. Garder tous les listeners ouverts ne coûte qu'une lecture initiale
// par collection (une seule fois par session), au lieu de dizaines de
// relectures au fil d'une navigation normale.
let _activeListeners = new Map(); // col -> fonction de désinscription

function _unsubscribeAll() {
  _activeListeners.forEach(unsub => { try { unsub(); } catch(_){} });
  _activeListeners.clear();
}

// Retourne la query Firestore filtrée selon le rôle pour un listener temps-réel
function _queryForCol(col) {
  if (!db_fs || !session) return null;
  if (_NO_REALTIME_COLS.has(col)) return null; // pas de listener pour cette collection
  if (_NO_REALTIME_FOR_STAFF.has(col) && session.role !== 'commercial') return null; // pas de listener temps réel pour le staff sur ces collections (cache TTL à la place)
  const colRef = collection(db_fs, col);
  const uid  = session.userId;
  const role = session.role;

  // Collections légères → listener complet
  if (_SMALL_COLS.has(col)) return colRef;

  if (role ===ROLES.COMMERCIAL) {
    if (col === 'clients')     return query(colRef, where('commercialId','==',uid));
    if (col === 'paiements')   return query(colRef, where('commercialId','==',uid));
    if (col === 'mises')       return query(colRef, where('commercialId','==',uid));
    if (col === 'adhesionPays')return query(colRef, where('commercialId','==',uid));
    if (col === 'rachatCarnetPays')return query(colRef, where('commercialId','==',uid));
    if (col === 'pointsJour')  return query(colRef, where('commercialId','==',uid));
    if (col === 'versements')  return query(colRef, where('commercialId','==',uid));
    if (col === 'transferts')  return query(colRef, where('operateurId','==',uid));
    // livraisons : listener sur ses clients uniquement (jusqu'à 30)
    if (col === 'livraisons') {
      const clientIds = DB.clients.map(c => c._id).slice(0, 30);
      if (!clientIds.length) return null;
      return query(colRef, where('clientId','in',clientIds));
    }
    return query(colRef, limit(200));
  }

  // ✅ FIX LISTENER ADMIN : on écoute les _LISTENER_WINDOW derniers docs par _ts desc.
  // Avant : orderBy('__name__') + limit(200) manquait les nouveaux docs créés
  // après le chargement initial s'ils tombaient hors des 200 premiers.
  // Avec _ts desc, les nouveaux docs (qui ont le _ts le plus récent) sont
  // toujours dans la fenêtre du listener.
  // (Fenêtre réduite à _LISTENER_WINDOW, distincte de _PAGE_SIZE utilisé pour
  // le chargement complet par pagination — le listener n'a pas besoin de
  // relire 2000 docs pour simplement détecter les nouveaux/modifiés.)
  //
  // ✅ FIX DOUBLE LECTURE (v2) : si le chargement paginé (getDocs) a déjà eu
  // lieu pour cette collection, on connaît le _ts le plus récent déjà en
  // mémoire (_maxTsLoaded). Dans ce cas, on n'a plus besoin de relire les
  // _LISTENER_WINDOW derniers documents (qui sont déjà connus) : on écoute
  // uniquement les documents STRICTEMENT PLUS RÉCENTS que ce timestamp. Le
  // premier snapshot du listener ne coûte alors quasiment aucune lecture
  // facturée (au lieu de jusqu'à 200), au lieu de dupliquer le travail déjà
  // payé par le getDocs() de chargement initial.
  // ✅ FIX SYNCHRO (v3) — BUG TROUVÉ : _maxTsLoaded[col] était calculé à
  // partir de la PREMIÈRE PAGE seulement (pagination par __name__, un ordre
  // arbitraire sans rapport avec le temps), pas de la collection entière.
  // Pour une grosse collection (ex: paiements à 1M docs) où l'admin n'a
  // encore chargé que 500 docs sur 1 000 000, ce "max" n'est qu'un
  // timestamp pris au hasard — souvent bien plus ancien que le vrai document
  // le plus récent. Le résultat : la requête where('_ts','>',cutoff) SANS
  // LIMITE pouvait alors tenter de suivre en temps réel des centaines de
  // milliers de documents d'un coup → ralentissement sévère de la synchro
  // et du navigateur.
  // Correction : on ne fait confiance à _maxTsLoaded que si la collection a
  // été chargée EN ENTIER (_loadedCols.has(col) — donc que le max est bien
  // le vrai maximum, pas celui d'un échantillon), et on borne systématiquement
  // la requête par _LISTENER_WINDOW dans tous les cas.
  if (_maxTsLoaded[col] && _loadedCols.has(col)) {
    const cutoff = Timestamp.fromMillis(_maxTsLoaded[col]);
    return query(colRef, where('_ts', '>', cutoff), orderBy('_ts', 'desc'), limit(_LISTENER_WINDOW));
  }
  return query(colRef, orderBy('_ts', 'desc'), limit(_LISTENER_WINDOW));
}

// ✅ FIX LECTURES FIRESTORE (v2) : vrai si la requête du listener temps-réel
// (_queryForCol) couvre exactement les mêmes données qu'un chargement complet
// pour cette collection — donc pas besoin d'un getDocs() séparé en plus de
// l'abonnement : son premier snapshot suffit comme chargement initial.
// - Collections "légères" (_SMALL_COLS) : le listener lit toute la collection,
//   tout comme getDocs(collection(...)) — identique.
// - Rôle 'commercial' (hors 'livraisons') : le listener et _loadCol()
//   appliquent exactement le même filtre where(commercialId/operateurId==uid)
//   — identique.
// - Faux pour les grosses collections en pagination admin/secrétaire/
//   contrôleur/gestionnaire_stock (orderBy __name__ + curseur "charger plus",
//   incompatible avec la fenêtre orderBy(_ts desc) du listener) et pour
//   'livraisons' côté commercial (le listener ne couvre que les 30 premiers
//   clients, alors que _loadCol() couvre tous les clients par tranches de 30).
function _listenerCoversFullLoad(col) {
  if (!session) return false;
  if (_NO_REALTIME_COLS.has(col)) return false;
  if (_NO_REALTIME_FOR_STAFF.has(col) && session.role !== 'commercial') return false;
  if (_SMALL_COLS.has(col)) return true;
  if (session.role ===ROLES.COMMERCIAL && col !== 'livraisons') return true;
  return false;
}

async function setupPageListeners(pageId) {
  const cols = _PAGE_DEPS[pageId] || [];
  if (!db_fs) return;

  // ✅ FIX LECTURES FIRESTORE (v2) : plus de désinscription ici — les
  // listeners ouverts restent actifs jusqu'à la déconnexion (voir
  // _unsubscribeAll() dans doLogout()). Naviguer vers une page qui ne dépend
  // pas d'une collection ne coûte donc plus aucune lecture pour celle-ci.

  if (!cols.length) { if (session && curPg === pageId) renderPg(pageId); return; }

  // ✅ FIX RECHARGEMENT INUTILE : le rechargement forcé basé sur un TTL a été
  // retiré (voir _cacheRead). Pour les collections sans listener temps réel
  // (_NO_REALTIME_COLS, ou _NO_REALTIME_FOR_STAFF pour le staff), le cache
  // localStorage est maintenant réutilisé indéfiniment tant qu'aucune mise à
  // jour n'est détectée. Ces collections n'ayant justement pas de listener
  // pour se tenir à jour toutes seules, leur fraîcheur repose sur : (a) leur
  // propre réécriture explicite après une action d'écriture réussie côté
  // app (ex: _cacheWrite appelé après un ajout/modif), ou (b) le bouton
  // "recharger" existant, ou (c) une déconnexion (_cacheClear).

  // Collections qui ont besoin d'un getDocs() préalable (pagination admin/
  // secrétaire, ou 'livraisons' côté commercial) — les autres (légères, ou
  // filtrées par rôle commercial) seront chargées directement par le premier
  // snapshot de leur listener, ci-dessous, sans lecture redondante.
  const colsNeedingEagerLoad = cols.filter(c => _loadedCols.has(c) || !_listenerCoversFullLoad(c));
  await ensureCollectionsLoaded(colsNeedingEagerLoad);
  if (session && curPg === pageId) renderPg(pageId);

  cols.forEach(col => {
    if (_activeListeners.has(col)) return; // déjà actif : on le conserve, aucune nouvelle lecture

    const q = _queryForCol(col);
    if (!q) return; // pas de listener pour ce col (ex: livraisons sans clients)

    // Si cette collection n'a pas été chargée par getDocs() ci-dessus, ce
    // listener est son UNIQUE source de données : son premier snapshot doit
    // déclencher le rendu initial (sinon la page resterait vide).
    const isSoleLoadSource = !_loadedCols.has(col);

    let _firstSnap = true;
    const unsub = onSnapshot(q, snap => {
      // Mettre à jour uniquement les documents reçus (pas écraser toute la collection)
      snap.docChanges().forEach(change => {
        const d = {...change.doc.data(), _id: change.doc.id};
        if (change.type === 'removed') {
          DB[col] = (DB[col]||[]).filter(x => x._id !== d._id);
        } else {
          const idx = (DB[col]||[]).findIndex(x => x._id === d._id);
          if (idx >= 0) DB[col][idx] = d;
          else { DB[col] = DB[col]||[]; DB[col].push(d); }
        }
        _touchVer(col);
      });
      setSyncStatus(true);
      _loadedCols.add(col); // les données de cette collection sont maintenant fiables en mémoire

      // ✅ FIX PERSISTANCE CACHE : sans ceci, un changement reçu en direct
      // (fait par un AUTRE utilisateur/appareil) restait uniquement en
      // mémoire — le cache localStorage sur disque n'était mis à jour que
      // par les écritures LOCALES (_syncLocalAfterWrite). À la prochaine
      // connexion, le cache aurait donc pu être relu sans ces changements.
      // On ne réécrit QUE si DB[col] représente bien l'intégralité de la
      // collection à cet instant, sinon le cache serait corrompu par une
      // vue partielle :
      //  - _listenerCoversFullLoad(col) : listener seul = source complète
      //    (collections légères, ou rôle commercial hors 'livraisons').
      //  - Sinon (grosses collections paginées admin/staff) : sûr UNIQUEMENT
      //    une fois la pagination entièrement terminée (_loadedCols.has(col)
      //    && plus de curseur en attente) — les deltas du listener viennent
      //    alors garder ce jeu complet à jour sans jamais le tronquer.
      //    Exclu explicitement : rôle commercial sur 'livraisons', dont le
      //    listener ne couvre que les 30 premiers clients (vue volontairement
      //    partielle, voir _queryForCol) — ne jamais l'écrire en cache.
      const isCommercialLivraisonsPartialView = session && session.role === ROLES.COMMERCIAL && col === 'livraisons';
      const safeToWriteCache = !isCommercialLivraisonsPartialView
        && (_listenerCoversFullLoad(col) || (_loadedCols.has(col) && !_pageCursors[col]));
      if (safeToWriteCache) {
        const cacheKey = (session && session.role ===ROLES.COMMERCIAL) ? (col + ':' + session.userId) : col;
        _cacheWrite(cacheKey, DB[col]);
      }

      if (_firstSnap) {
        _firstSnap = false;
        if (isSoleLoadSource && session && curPg === pageId) renderPg(pageId);
        return;
      }

      // ✅ FIX SYNCHRO FICHE CLIENT : la « fiche complète du client » (modal
      // m-fiche-client) est un écran de LECTURE (pas un formulaire de saisie).
      // Elle ne doit donc pas être bloquée par la règle générale ci-dessous
      // qui suspend tout re-rendu tant qu'un modal est ouvert (règle pensée
      // pour ne pas perturber un formulaire en cours de remplissage). Si ce
      // modal est ouvert et que la collection modifiée fait partie de ses
      // données (paiements, adhésions, livraisons, infos client), on la
      // rafraîchit directement, pour refléter en temps réel un paiement
      // saisi ailleurs (autre appareil / autre utilisateur) pendant qu'on
      // consulte la fiche de ce client.
      const ficheClientModalOuvert = document.getElementById('m-fiche-client')?.classList.contains('open');
      if (ficheClientModalOuvert && typeof _ficheClientCtxId !== 'undefined' && _ficheClientCtxId
          && ['paiements','adhesionPays','rachatCarnetPays','livraisons','clients'].includes(col)
          && typeof ouvrirFicheClient === 'function') {
        ouvrirFicheClient(_ficheClientCtxId);
      }

      const modalOuvert = document.querySelector('.modal-overlay.open, .md.open, [id^="m-"][style*="flex"], [id^="m-"][style*="block"]');
      if (modalOuvert) return;

      if (curPg === 'com-nouveau-client') {
        const champs = ['com-ncl-nom','com-ncl-tel','com-ncl-ville','com-ncl-qrt','com-ncl-contrat','com-ncl-note','com-ncl-montant','com-ncl-seq'];
        if (champs.some(id => { const el = document.getElementById(id); return el && el.value && el.value.trim() !== ''; })) return;
      }

      // Le listener peut avoir été ouvert par une autre page : on ne re-rend
      // que si la page actuellement affichée dépend bien de cette collection.
      if (session && (_PAGE_DEPS[curPg]||[]).includes(col)) _debouncedRenderPg(curPg);
    }, err => {
      // ✅ FIX ERREUR SILENCIEUSE : sans ce gestionnaire, un échec du listener
      // (permission-denied, index manquant, quota dépassé, réseau) ne provoquait
      // RIEN — pas de message, pas de log — et la page restait bloquée en
      // attente indéfinie du premier snapshot si ce listener était sa seule
      // source de données.
      console.error(`[onSnapshot] Erreur sur la collection "${col}" :`, err);
      _activeListeners.delete(col); // permet une nouvelle tentative de connexion plus tard
      setSyncStatus(false);
      if (isSoleLoadSource && session && curPg === pageId) {
        // Cette collection était l'UNIQUE source de données de la page : sans
        // rendu de secours, la page resterait vide indéfiniment.
        notify(`⚠️ Impossible de charger "${col}" (${err.code||err.message||'erreur inconnue'}). Réessayez ou contactez l'administrateur si le problème persiste.`, 'err');
        renderPg(pageId); // rendu avec les données déjà disponibles (partielles ou vides), plutôt qu'un blocage silencieux
      }
    });
    _activeListeners.set(col, unsub);
  });
}

// Appelé une seule fois après la connexion — pas de listeners globaux ici
function setupRealtimeListeners() {
  // Les listeners sont désormais créés/détruits dans go() via setupPageListeners().
  // Cette fonction est conservée pour compatibilité avec l'appel existant après loadFirebaseData.
  // Rien à faire : go() appellera setupPageListeners() à la première navigation.
}

// ========= GARDE RÔLES — opérations d'écriture =========
// Définit quels rôles peuvent écrire dans chaque collection
const _WRITE_ROLES = {
  agences:       ['admin','secretaire'],
  commerciaux:   ['admin','secretaire'],
  commerciauxPrive: ['admin','secretaire'], // Étape 1 du point 2 de l'audit — collection miroir, non encore utilisée en lecture
  articles:      ['admin','gestionnaire_stock','secretaire','chef_agence'],
  produits:      ['admin','gestionnaire_stock','chef_agence'],
  stockMvts:     ['admin','gestionnaire_stock','secretaire'],
  clients:       ['admin','commercial','secretaire','controleur','chef_agence'],
  paiements:     ['admin','commercial','secretaire','chef_agence'],
  livraisons:    ['admin','commercial','secretaire','chef_agence'],
  adhesionPays:  ['admin','commercial','secretaire','chef_agence'],
  rachatCarnetPays: ['admin','secretaire','chef_agence'],
  mises:         ['admin','commercial','secretaire','chef_agence'],
  primesPaliers: ['admin','secretaire'],
  pointsJour:    ['admin','commercial','secretaire','chef_agence'],
  versements:    ['admin','secretaire','chef_agence'],
  transferts:    ['admin','secretaire','chef_agence'],
  depenses:      ['admin','chef_agence'],
  recus:         ['admin','commercial','secretaire','chef_agence'],
};
function _checkWriteRole(col) {
  if (!session) { notify('Accès refusé — non connecté', 'err'); throw new Error('NOT_AUTHENTICATED'); }
  const allowed = _WRITE_ROLES[col];
  if (allowed && !allowed.includes(session.role)) {
    notify(`Accès refusé — rôle insuffisant (${session.role})`, 'err');
    throw new Error('INSUFFICIENT_ROLE');
  }
}

// ═══════════════════════════════════════════════════════
// FILE OFFLINE — opérations en attente de synchronisation
// Survit aux rechargements (stockée dans localStorage)
// ═══════════════════════════════════════════════════════
const _OFFLINE_QUEUE_KEY = 'gestcom_offline_queue';
let _offlineQueue = [];

async function _loadOfflineQueue() {
  try {
    const raw = localStorage.getItem(_OFFLINE_QUEUE_KEY + '_enc');
    if (raw && _localKey) {
      _offlineQueue = await _decryptOfflineQueue(raw);
    } else {
      // Fallback non chiffré (mode local / migration)
      const plain = localStorage.getItem(_OFFLINE_QUEUE_KEY);
      _offlineQueue = plain ? JSON.parse(plain) : [];
    }
  } catch(e) { _offlineQueue = []; }
}
async function _saveOfflineQueue() {
  try {
    if (_localKey) {
      const enc = await _encryptLocal(_offlineQueue);
      if (enc) { localStorage.setItem(_OFFLINE_QUEUE_KEY + '_enc', enc); }
    } else {
      localStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(_offlineQueue));
    }
  } catch(e) {}
  _updateOfflineBadge();
}
function _updateOfflineBadge() {
  const badge = document.getElementById('offline-badge');
  const count = document.getElementById('offline-badge-count');
  const badgeM = document.getElementById('offline-badge-mobile');
  const countM = document.getElementById('offline-badge-mobile-count');
  const hasPending = _offlineQueue.length > 0;
  const txt = _offlineQueue.length + ' en attente';
  if (badge && count) {
    if (hasPending) { badge.classList.add('visible'); count.textContent = txt; }
    else { badge.classList.remove('visible'); }
  }
  if (badgeM && countM) {
    if (hasPending) { badgeM.classList.add('visible'); countM.textContent = txt; }
    else { badgeM.classList.remove('visible'); }
  }
}
async function _enqueueOp(op, col, data, id) {
  // M2 — offlineId stable : UUID v4 généré une seule fois par opération 'add'.
  // Stocké dans le document Firestore (_offlineId) pour détecter les doublons au replay.
  const offlineId = (op === 'add')
    ? ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))
    : null;
  _offlineQueue.push({ op, col, data: data || null, id: id || null, offlineId, ts: Date.now() });
  await _saveOfflineQueue();
}

// Rejoue la file vers Firebase au retour du réseau
// ✅ GESTION CONFLITS OFFLINE : retry exponentiel + détection conflit update
// Stratégie : last-write-wins avec détection du document supprimé entre-temps.
// Un 'update' sur un doc inexistant (supprimé par un autre utilisateur) est
// traité comme un conflit non-bloquant : on logue et on passe à l'opération suivante.
// Un 'add' avec _offlineId déjà présent dans Firestore est dédoublonné proprement.
const _REPLAY_MAX_RETRIES = 3;
const _REPLAY_BACKOFF_MS  = [1000, 3000, 8000]; // délais entre tentatives

async function _replayOfflineQueue() {
  if (!_offlineQueue.length || !db_fs) return;
  const queue = [..._offlineQueue];
  setSyncStatus(false);
  notify('🔄 Synchronisation en cours (' + queue.length + ' opération(s))…');
  const colsAffected = new Set();
  let errors = 0, conflicts = 0;

  for (let qi = 0; qi < queue.length; qi++) {
    const op = queue[qi];
    let success = false;

    for (let attempt = 0; attempt <= _REPLAY_MAX_RETRIES; attempt++) {
      try {
        if (op.op === 'add') {
          const { _id, ...clean } = op.data;
          // Anti-doublon : chercher un doc existant avec le même _offlineId
          let alreadyExists = false;
          if (op.offlineId) {
            try {
              const dupSnap = await getDocs(query(
                collection(db_fs, op.col),
                where('_offlineId', '==', op.offlineId),
                limit(1)
              ));
              alreadyExists = !dupSnap.empty;
            } catch(e) {
              // where sur _offlineId peut échouer si pas indexé — fallback local
              alreadyExists = DB[op.col]?.some(d => d._offlineId === op.offlineId);
            }
          }
          if (!alreadyExists) {
            await addDoc(collection(db_fs, op.col), {
              ...clean, _offlineId: op.offlineId || null, _ts: serverTimestamp()
            });
          }

        } else if (op.op === 'update') {
          // ✅ FIX CONFLIT OFFLINE : détection last-write-wins via _ts
          // Si le document a été modifié par quelqu'un d'autre pendant l'offline
          // (son _ts Firestore > notre timestamp d'enqueue), on loggue le conflit
          // mais on applique quand même notre update (last-write-wins).
          // Le message de sync indique le nombre de conflits détectés.
          const docRef = doc(db_fs, op.col, op.id);
          const snap = await getDoc(docRef);
          if (!snap.exists()) {
            // Document supprimé entre-temps → conflit non-bloquant, on skip
            console.warn('[offline] Conflit update — doc supprimé:', op.col, op.id);
            conflicts++;
          } else {
            // Détecter si modifié par un autre utilisateur pendant l'offline
            const serverTs = snap.data()._ts?.toMillis?.() || 0;
            if (serverTs > op.ts) {
              // Conflit détecté — doc modifié côté serveur après notre enqueue
              console.warn('[offline] Conflit _ts détecté sur', op.col, op.id,
                '— serverTs:', serverTs, 'opTs:', op.ts, '— last-write-wins appliqué');
              conflicts++;
            }
            // Appliquer quand même (stratégie last-write-wins)
            await updateDoc(docRef, {...op.data, _ts: serverTimestamp()});
          }

        } else if (op.op === 'delete') {
          const docRef = doc(db_fs, op.col, op.id);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            await deleteDoc(docRef);
          }
          // Si déjà supprimé → ok, on considère l'op réussie
        }

        // Succès ou conflit traité : retirer de la queue
        _offlineQueue.splice(_offlineQueue.findIndex(o => o === op), 1);
        _saveOfflineQueue();
        colsAffected.add(op.col);
        success = true;
        break;

      } catch(e) {
        if (attempt < _REPLAY_MAX_RETRIES) {
          // Retry avec backoff exponentiel
          await new Promise(r => setTimeout(r, _REPLAY_BACKOFF_MS[attempt]));
        } else {
          console.error('[offline] Échec définitif après ' + _REPLAY_MAX_RETRIES + ' tentatives:', op, e);
          errors++;
        }
      }
    }
  }

  // Recharger les collections affectées — mais seulement celles qui n'ont
  // PAS de listener temps-réel actif ET FIABLE. ✅ FIX LECTURES FIRESTORE (v2) :
  // avec des listeners désormais persistants pour toute la session, une
  // collection déjà écoutée par un listener qui couvre TOUTES ses données
  // (_listenerCoversFullLoad) reçoit automatiquement les écritures qu'on
  // vient de rejouer (Firestore notifie aussi l'auteur de ses propres
  // écritures) — un nouveau getDocs() complet serait alors une lecture en
  // pure perte. En revanche, pour 'livraisons' côté commercial, le listener
  // ne couvre que les 30 premiers clients : on doit garder le rechargement
  // complet par _loadCol() pour ne pas perdre les écritures sur les clients
  // au-delà du 30e (même chose pour les grosses collections paginées admin).
  for (const col of colsAffected) {
    if (_activeListeners.has(col) && _listenerCoversFullLoad(col)) continue; // déjà synchronisé en temps réel, en intégralité
    try {
      _loadedCols.delete(col);
      try { localStorage.removeItem(_SS_PREFIX + col); } catch(e) {}
      await _loadCol(col);
    } catch(e) { console.error('[offline] Rechargement collection échoué:', col, e); }
  }

  setSyncStatus(true);
  if (errors === 0 && conflicts === 0) {
    notify('✅ Synchronisation terminée — ' + colsAffected.size + ' collection(s) mise(s) à jour');
  } else if (conflicts > 0 && errors === 0) {
    notify('✅ Synchronisation terminée avec ' + conflicts + ' conflit(s) résolus (document(s) modifié(s) par un autre utilisateur)');
  } else {
    notify('⚠️ Synchronisation partielle — ' + errors + ' opération(s) échouée(s), ' + _offlineQueue.length + ' restante(s)', 'err');
  }
  if (session && curPg) renderPg(curPg);
}

// Détection réseau en temps réel
window.addEventListener('online', async () => {
  isOnline = true;
  document.querySelector('.online-dot').style.background = 'var(--accent2)';
  setSyncStatus(true);
  if (_offlineQueue.length > 0) await _replayOfflineQueue();
});
window.addEventListener('offline', () => {
  isOnline = false;
  document.querySelector('.online-dot').style.background = 'var(--danger)';
  setSyncStatus(false);
  notify('📵 Connexion perdue — mode hors-ligne activé');
});

// M5 — helper : met à jour DB en mémoire et sauvegarde chiffré si commercial
function _syncLocalAfterWrite(col) {
  // ✅ FIX CACHE : invalider le cache localStorage de la collection modifiée.
  // Sans ça, un rechargement de page lisait l'ancienne valeur du cache
  // au lieu des données fraîches post-écriture. On invalide les deux formes
  // de clé possibles (admin: 'col', commercial: 'col:uid' — voir _loadCol).
  try {
    localStorage.removeItem(_SS_PREFIX + col);
    if (session && session.userId) localStorage.removeItem(_SS_PREFIX + col + ':' + session.userId);
  } catch(e) {}
  _loadedCols.delete(col); // forcer un re-fetch Firestore au prochain accès
  // Invalider aussi le cache court _fetchColByDate (voir plus haut) pour
  // cette collection : une écriture vient de changer les données, on ne
  // doit pas continuer à servir une réponse mise en cache il y a <30s.
  Object.keys(_dateFetchCache).forEach(k => {
    if (k.startsWith(col + ':')) delete _dateFetchCache[k];
  });
  // Idem pour le cache court de _fetchPaiementsDateRange (dashboard admin) :
  // une écriture sur 'paiements' invalide toute plage en cache, pour ne pas
  // resservir un total obsolète pendant les 30s suivant l'écriture locale.
  if (col === 'paiements') {
    Object.keys(_rangeFetchCache).forEach(k => delete _rangeFetchCache[k]);
  }
  if (session?.role ===ROLES.COMMERCIAL && _localKey) saveLocalEncrypted();
}

// ── POINT 6 CORRIGÉ : protection des opérations d'écriture ──
// Vérifie que la session Firebase Auth est toujours active AVANT toute
// opération destructive. Empêche un appel console direct à fbDelete()
// si la session a expiré ou a été révoquée.
// ✅ FIX LATENCE ÉCRITURE : on évite getIdToken(true) à chaque écriture.
// Le token Firebase dure 1h. On force le refresh seulement si le token
// expire dans moins de 5 minutes. Sinon, getIdToken(false) est instantané
// (lecture du cache mémoire, 0ms réseau).
let _lastTokenCheck = 0;
let _sessionInvalidHandled = false; // ✅ FIX : évite les appels en cascade à doLogout()

async function _assertFirebaseSession() {
  if (!auth || !auth.currentUser) {
    if(!_sessionInvalidHandled){
      _sessionInvalidHandled = true;
      notify('Session expirée — veuillez vous reconnecter', 'err');
      window.doLogout();
    }
    throw new Error('SESSION_EXPIRED');
  }
  try {
    const now = Date.now();
    // Vérifier l'expiration du token sans appel réseau
    const tokenResult = await auth.currentUser.getIdTokenResult(false);
    const expiresAt = new Date(tokenResult.expirationTime).getTime();
    const msLeft = expiresAt - now;
    if (msLeft < 5 * 60 * 1000) {
      // Token expire dans moins de 5 min → forcer le refresh (appel réseau)
      // ✅ FIX : un aléa réseau ponctuel ne doit plus déconnecter l'utilisateur.
      // On retente une fois avant de considérer la session comme invalide.
      try {
        await auth.currentUser.getIdToken(true);
      } catch(refreshErr) {
        await new Promise(r => setTimeout(r, 800));
        await auth.currentUser.getIdToken(true); // 2e tentative — si ça échoue aussi, on tombe dans le catch externe
      }
    }
    // Sinon : token valide, 0ms réseau
  } catch(e) {
    // Ne déconnecter réellement que si l'utilisateur n'est plus authentifié du tout,
    // pas pour un simple raté de rafraîchissement réseau (ex: pendant un gros import).
    if (!auth.currentUser) {
      if(!_sessionInvalidHandled){
        _sessionInvalidHandled = true;
        notify('Session invalide — veuillez vous reconnecter', 'err');
        window.doLogout();
      }
      throw new Error('SESSION_INVALID');
    }
    // currentUser existe encore : on laisse passer, l'écriture suivante retentera son propre refresh.
    console.warn('Rafraîchissement du token Firebase temporairement indisponible, poursuite avec le token actuel.', e);
  }
}

// ── FIX PERFORMANCE (point faible #3) : dénormalisation de agenceId ──
// Avant : les règles Firestore devaient faire un get() supplémentaire sur
// 'commerciaux' pour connaître l'agence du propriétaire de chaque client/
// paiement lu (coûteux : double le nombre de lectures facturées + latence).
// Après : agenceId est recopié directement sur le document client/paiement
// dès sa création (basé sur l'agence du commercialId), donc la règle peut
// comparer resource.data.agenceId directement, sans lecture supplémentaire.
const _AGENCE_DENORM_COLS = new Set(['clients','paiements']);
function _withAgenceId(col, data){
  if(!_AGENCE_DENORM_COLS.has(col)) return data;
  if(data.agenceId !== undefined) return data; // déjà fourni explicitement
  const uid = data.commercialId;
  if(!uid) return data;
  const owner = DB.commerciaux?.find(c => c._id === uid);
  return {...data, agenceId: owner?.agenceId ?? null};
}
async function fbAdd(col, data) {
  _checkWriteRole(col);
  data = _withAgenceId(col, data);
  if (!isOnline) {
    const item = localAdd(col, data);
    await _enqueueOp('add', col, item);
    return item;
  }
  await _assertFirebaseSession();
  setSyncStatus(false);
  const ref = await addDoc(collection(db_fs, col), {...data, _ts: serverTimestamp()});
  const item = {...data, _id: ref.id};
  const idx = DB[col]?.findIndex(d => d._id === ref.id);
  if (idx === -1 || idx === undefined) DB[col]?.push(item);
  _touchVer(col);
  _syncLocalAfterWrite(col);
  setSyncStatus(true);
  return item;
}

// ── OUTIL DE MIGRATION UNIQUE (admin) : backfill agenceId sur les documents ──
// existants créés AVANT le correctif de dénormalisation. À exécuter UNE FOIS,
// connecté en tant qu'admin, en tapant `migrerAgenceId()` dans la console du
// navigateur (F12). Sans cette migration, les nouvelles règles Firestore
// empêcheront le staff non-admin de voir leurs propres anciens clients/paiements.
window.migrerAgenceId = async function(){
  if(!session || session.role !== 'admin'){ console.error('Réservé à l\'admin.'); return; }
  await ensureCollectionsLoaded(['clients','paiements','commerciaux']);
  const agenceOf = new Map(DB.commerciaux.map(c => [c._id, c.agenceId ?? null]));
  let done = 0, skipped = 0, errors = 0;
  for(const col of ['clients','paiements']){
    for(const item of DB[col]){
      if(item.agenceId !== undefined){ skipped++; continue; }
      const agenceId = agenceOf.get(item.commercialId) ?? null;
      try{
        await updateDoc(doc(db_fs, col, item._id), { agenceId });
        item.agenceId = agenceId;
        done++;
      }catch(e){ errors++; console.error('Échec migration', col, item._id, e); }
    }
  }
  notify(`Migration agenceId : ${done} document(s) mis à jour, ${skipped} déjà à jour, ${errors} erreurs`, 'success');
};

async function fbUpdate(col, id, data) {
  _checkWriteRole(col);
  // Si le client change de commercial (transfert), on resynchronise agenceId
  // pour que la règle de sécurité (qui compare agenceId sans get() supplémentaire)
  // reste exacte après le transfert.
  if (_AGENCE_DENORM_COLS.has(col) && data.commercialId !== undefined && data.agenceId === undefined) {
    const owner = DB.commerciaux?.find(c => c._id === data.commercialId);
    data = {...data, agenceId: owner?.agenceId ?? null};
  }
  if (!isOnline) {
    localUpdate(col, id, data);
    await _enqueueOp('update', col, data, id);
    return;
  }
  await _assertFirebaseSession();
  setSyncStatus(false);
  await updateDoc(doc(db_fs, col, id), data);
  const i = DB[col]?.findIndex(x => x._id === id);
  if (i >= 0) DB[col][i] = {...DB[col][i], ...data};
  _touchVer(col);
  _syncLocalAfterWrite(col);
  setSyncStatus(true);
}

async function fbDelete(col, id) {
  _checkWriteRole(col);
  if (!isOnline) {
    localDelete(col, id);
    await _enqueueOp('delete', col, null, id);
    return;
  }
  await _assertFirebaseSession();
  setSyncStatus(false);
  await deleteDoc(doc(db_fs, col, id));
  if (DB[col]) DB[col] = DB[col].filter(x => x._id !== id);
  _touchVer(col);
  _syncLocalAfterWrite(col);
  setSyncStatus(true);
}

async function fbSetSameId(col, id, data) {
  _checkWriteRole(col);
  if (!isOnline) throw new Error('OFFLINE');
  await _assertFirebaseSession();
  await setDoc(doc(db_fs, col, id), {...data, _ts: serverTimestamp()}, {merge:true});
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: OFFLINE                                              ║
// ║  Extraction: node extract-modules.js → js/offline.js         ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= LOCAL FALLBACK =========
// ═══════════════════════════════════════════════════════════════
// C2 — Chiffrement AES-GCM du localStorage par clé dérivée du PIN
// ═══════════════════════════════════════════════════════════════
// CHIFFREMENT LOCAL AES-GCM
// FIX 2 CORRIGÉ : la clé est dérivée de l'UID Firebase + secret appareil.
// Plus de dépendance au mot de passe (qui n'est plus connu du code).
// Avantages :
//   - Fonctionne même si l'utilisateur change son mot de passe Firebase
//   - Unique par utilisateur ET par appareil
//   - Jamais persistée, reconstruite à chaque connexion
// ═══════════════════════════════════════════════════════════════
let _localKey = null; // CryptoKey en mémoire uniquement

async function _initLocalKey(uid) {
  // Combiner l'UID Firebase (propre à l'utilisateur) avec le secret appareil
  // (propre à cet appareil/navigateur) pour une clé unique à chaque combinaison
  const deviceSecret = _getOrCreateDeviceSecret();
  const material = uid + '|' + deviceSecret;
  const enc = new TextEncoder();

  // Lire ou créer le sel persistant pour ce couple uid+appareil
  const saltKey = 'gestcom_local_salt_' + uid.slice(0, 8);
  let saltHex = null;
  try { saltHex = localStorage.getItem(saltKey); } catch(e) {}
  let saltBytes;
  if (saltHex) {
    saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  } else {
    saltBytes = crypto.getRandomValues(new Uint8Array(16));
    saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem(saltKey, saltHex); } catch(e) {}
  }

  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(material), 'PBKDF2', false, ['deriveKey']);
  _localKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function _encryptLocal(data) {
  if (!_localKey) return null;
  try {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _localKey, enc.encode(JSON.stringify(data)));
    const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2,'0')).join('');
    const dataHex = Array.from(new Uint8Array(cipher)).map(b => b.toString(16).padStart(2,'0')).join('');
    return ivHex + ':' + dataHex;
  } catch(e) { return null; }
}

async function _decryptLocal(stored) {
  if (!_localKey || !stored || !stored.includes(':')) return null;
  try {
    const [ivHex, dataHex] = stored.split(':');
    const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const data = new Uint8Array(dataHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _localKey, data);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch(e) { return null; }
}

async function _decryptOfflineQueue(stored) {
  if (!_localKey || !stored || !stored.includes(':')) {
    // Fallback : file non chiffrée (migration depuis ancienne version)
    try { return stored ? JSON.parse(stored) : []; } catch(e) { return []; }
  }
  return await _decryptLocal(stored) || [];
}

function loadLocalData() {
  // Données chargées en clair uniquement si _localKey n'est pas encore disponible
  // (mode local sans login — données demo non sensibles)
  try { const d = localStorage.getItem('gestcom_local'); if(d) DB = JSON.parse(d); } catch(e){ console.warn('[local] Données locales corrompues, réinitialisation:', e); }
  if (!DB.mises) DB.mises = [];
  if (!DB.agences) DB.agences = [];
  if (!DB.primesPaliers) DB.primesPaliers = [];
  if (!DB.produits) DB.produits = [];
  if (DB.commerciaux.length === 0) initDemoLocal();
}

// Version chiffrée — utilisée après login commercial
async function loadLocalDataEncrypted() {
  try {
    const stored = localStorage.getItem('gestcom_local_enc');
    if (stored) {
      const decrypted = await _decryptLocal(stored);
      if (decrypted) { DB = decrypted; }
    }
  } catch(e) {}
  if (!DB.mises) DB.mises = [];
  if (!DB.agences) DB.agences = [];
  if (!DB.primesPaliers) DB.primesPaliers = [];
  if (!DB.produits) DB.produits = [];
}

// FIX 3 : saveLocal() en clair supprimee - toujours chiffre ou rien
function saveLocal() { /* desactivee : evite le stockage en clair de 30 000 clients */ }

// FIX PERF : debounce + report hors du tick courant.
// Avant : chaque fbAdd/fbUpdate déclenchait immédiatement un JSON.stringify(DB) + chiffrement
// AES-GCM de TOUTE la base (toutes collections confondues), ce qui bloquait un instant l'UI
// pile au moment où on attend le retour "client/mise enregistré ✓".
// Maintenant : les appels rapprochés sont regroupés (un seul chiffrement après une pause de 600ms)
// et l'exécution est repoussée via setTimeout(0) pour laisser l'UI se repeindre d'abord.
let _saveLocalEncTimer = null;
function saveLocalEncrypted() {
  if (_saveLocalEncTimer) clearTimeout(_saveLocalEncTimer);
  _saveLocalEncTimer = setTimeout(() => { _saveLocalEncTimer = null; _doSaveLocalEncrypted(); }, 600);
}
// FIX PERF (sécurité) : si l'app se ferme ou passe en arrière-plan pendant qu'un
// chiffrement est en attente (debounce), on le force immédiatement pour ne pas
// perdre la dernière sauvegarde locale.
function _flushSaveLocalEncrypted() {
  if (_saveLocalEncTimer) {
    clearTimeout(_saveLocalEncTimer);
    _saveLocalEncTimer = null;
    _doSaveLocalEncrypted();
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _flushSaveLocalEncrypted(); });
window.addEventListener('beforeunload', _flushSaveLocalEncrypted);
async function _doSaveLocalEncrypted() {
  if (!_localKey) { return; } // FIX 3 : pas de cle = pas de persistance locale
  try {
    const enc = await _encryptLocal(DB);
    if (enc) localStorage.setItem('gestcom_local_enc', enc);
  } catch(e) { console.warn('saveLocalEncrypted: echec, donnees non persistees localement'); } // FIX 3 : plus de fallback en clair
}

// M3 — _lid initialisé depuis localStorage pour éviter les collisions après rechargement
let _lid = (() => {
  try {
    const stored = parseInt(localStorage.getItem('gestcom_lid') || '0', 10);
    return Math.max(stored, Date.now());
  } catch(e) { return Date.now(); }
})();
function _nextLid() {
  _lid++;
  try { localStorage.setItem('gestcom_lid', String(_lid)); } catch(e) {}
  return String(_lid);
}
function localAdd(col, data) { const item = {...data, _id: _nextLid()}; DB[col].push(item); _touchVer(col); saveLocalEncrypted(); return item; }
function localUpdate(col, id, data) { const i = DB[col].findIndex(x => x._id === id); if(i>=0) DB[col][i] = {...DB[col][i], ...data}; _touchVer(col); saveLocalEncrypted(); }
function localDelete(col, id) { DB[col] = DB[col].filter(x => x._id !== id); _touchVer(col); saveLocalEncrypted(); }

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: UTILS                                                ║
// ║  Extraction: node extract-modules.js → js/utils.js           ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= DEMO DATA =========
// ⚠️ SÉCURITÉ : Les PINs de démonstration sont générés avec PBKDF2+sel au démarrage.
// En production, changez tous les PINs via l'interface d'administration immédiatement
// après le premier démarrage, puis supprimez ou désactivez initDemoFirebase().
async function initDemoFirebase() {
  const agences = [
    {nom:'Agence Centrale', ville:'Cotonou', description:'Siège principal'},
    {nom:'Agence Nord',     ville:'Parakou',  description:'Agence du Nord'}
  ];
  const agRefs = [];
  for (const a of agences) { const r = await addDoc(collection(db_fs,'agences'), a); agRefs.push(r.id); }
  // ⚠️ POINT 1 CORRIGÉ : Les PINs sont supprimés.
  // Chaque commercial doit avoir un compte Firebase Authentication (email + mot de passe).
  // L'UID Firebase Auth doit correspondre à l'ID du document dans 'commerciaux'.
  // Pour créer les comptes : Firebase Console → Authentication → Add user
  // Exemple d'emails de démo : admin@triomphant.app, kofi@triomphant.app, etc.
  const coms = [
    {nom:'Administrateur',tel:'',zone:'Direction',role:'admin',email:'admin@triomphant.app',codePrefix:'AD',clientSeq:0},
    {nom:'Kofi Mensah',tel:'+229 97 11 22 33',zone:'Cotonou Nord',email:'kofi@triomphant.app',role:'commercial',codePrefix:'KM',clientSeq:0,agenceId:agRefs[0]},
    {nom:'Amina Traoré',tel:'+229 96 44 55 66',zone:'Cotonou Sud',email:'amina@triomphant.app',role:'commercial',codePrefix:'AT',clientSeq:0,agenceId:agRefs[0]},
    {nom:'Brice Houndji',tel:'+229 94 77 88 99',zone:'Porto-Novo',email:'brice@triomphant.app',role:'commercial',codePrefix:'BH',clientSeq:0,agenceId:agRefs[1]}
  ];
  for (const c of coms) await addDoc(collection(db_fs, 'commerciaux'), c);
  const arts = [
    {ref:'MOB-001',nom:'Canapé 3 places',cat:'Mobilier',pv:300000,pa:200000,stock:8,stockMin:3,unite:'pièce'},
    {ref:'ELEC-001',nom:'Télévision 43"',cat:'Électroménager',pv:180000,pa:120000,stock:2,stockMin:3,unite:'pièce'},
    {ref:'ELEC-002',nom:'Réfrigérateur',cat:'Électroménager',pv:220000,pa:150000,stock:0,stockMin:2,unite:'pièce'},
  ];
  for (const a of arts) await addDoc(collection(db_fs, 'articles'), a);
  notify('Base de données initialisée avec des données de démonstration ✓');
}

async function initDemoLocal() {
  [
    {nom:'Agence Centrale', ville:'Cotonou', description:'Siège principal', _id:'ag1'},
    {nom:'Agence Nord',     ville:'Parakou',  description:'Agence du Nord', _id:'ag2'}
  ].forEach(a => DB.agences.push(a));
  // PINs hashés avec PBKDF2+sel aléatoire — PIN par défaut "1234" à changer immédiatement
  const comsDemo = [
    {nom:'Administrateur',tel:'',zone:'Direction',role:'admin',_id:'com1',codePrefix:'AD',clientSeq:0},
    {nom:'Kofi Mensah',tel:'+229 97 11 22 33',zone:'Cotonou Nord',role:'commercial',_id:'com2',codePrefix:'KM',clientSeq:0,agenceId:'ag1'},
    {nom:'Amina Traoré',tel:'+229 96 44 55 66',zone:'Cotonou Sud',role:'commercial',_id:'com3',codePrefix:'AT',clientSeq:0,agenceId:'ag1'},
  ];
  for(const c of comsDemo){
    // FIX 2 : plus de PIN - auth via Firebase Auth email+password
    DB.commerciaux.push(c);
  }
  saveLocal();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: CLIENTS                                              ║
// ║  Extraction: node extract-modules.js → js/clients.js         ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= SÉLECTION MULTIPLE CLIENTS =========
function mettreAJourSelectionBar(){
  const cases = document.querySelectorAll('.cl-row-check');
  const cochees = document.querySelectorAll('.cl-row-check:checked');
  const bar = document.getElementById('cl-selection-bar');
  const count = document.getElementById('cl-selection-count');
  const thCheck = document.getElementById('cl-th-check');
  const barCheck = document.getElementById('cl-select-all');

  if(cochees.length > 0){
    bar.style.display = 'flex';
    count.textContent = `${cochees.length} client(s) sélectionné(s)`;
  } else {
    bar.style.display = 'none';
  }
  // Mettre à jour l'état de la case "tout sélectionner"
  const etat = cases.length > 0 && cochees.length === cases.length;
  const indeterminate = cochees.length > 0 && cochees.length < cases.length;
  [thCheck, barCheck].forEach(el=>{ if(el){ el.checked=etat; el.indeterminate=indeterminate; } });
}

window.toggleSelectAll = function(source){
  const coche = source.checked;
  document.querySelectorAll('.cl-row-check').forEach(cb=>cb.checked=coche);
  // Synchroniser les deux cases "tout sélectionner"
  ['cl-th-check','cl-select-all'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.checked=coche; el.indeterminate=false; } });
  mettreAJourSelectionBar();
};

window.annulerSelection = function(){
  document.querySelectorAll('.cl-row-check').forEach(cb=>cb.checked=false);
  ['cl-th-check','cl-select-all'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.checked=false; el.indeterminate=false; } });
  mettreAJourSelectionBar();
};

window.supprimerSelection = async function(){
  const ids = [...document.querySelectorAll('.cl-row-check:checked')].map(cb=>cb.dataset.id);
  if(!ids.length){ notify('Aucun client sélectionné','err'); return; }
  const noms = ids.map(id=>getCl(id).nom).join(', ');
  if(!(await confirmDialog(`Supprimer définitivement ${ids.length} client(s) ?\n\n${noms.length>120?noms.slice(0,120)+'…':noms}`,{title:'🗑 Suppression de clients',okLabel:'Supprimer',danger:true}))) return;
  // ✅ FIX PERFORMANCE : suppressions en parallèle (Promise.all) au lieu de séquentiel
  await Promise.all(ids.map(id => fbDelete('clients', id)));
  notify(`${ids.length} client(s) supprimé(s)`);
  annulerSelection();
};

// ========= FICHE COMPLÈTE CLIENT =========
window.ouvrirFicheClient = async function(cid){
  // ✅ FIX COMPLÉTUDE : sur une grosse installation, DB.paiements (et
  // DB.adhesionPays / DB.livraisons) peut n'être que PARTIELLEMENT chargée
  // en mémoire (chargement par pages de 500, en tâche de fond, potentiellement
  // interrompu par un rafraîchissement de page avant d'avoir tout récupéré).
  // La fiche complète d'un client ne doit jamais dépendre de cet état de
  // chargement global : on va chercher directement TOUS les documents de
  // CE client (requête ciblée, peu coûteuse), et on les fusionne dans DB
  // avant de calculer/afficher quoi que ce soit. Cela évite que d'anciens
  // paiements (enregistrés bien avant, mais pas encore chargés dans le lot
  // global) semblent manquants.
  if (db_fs) {
    try {
      const [paySnap, adhSnap, livSnap] = await Promise.all([
        getDocs(query(collection(db_fs,'paiements'), where('clientId','==',cid))),
        getDocs(query(collection(db_fs,'adhesionPays'), where('clientId','==',cid))),
        getDocs(query(collection(db_fs,'livraisons'), where('clientId','==',cid)))
      ]);
      const merge = (col, snap) => {
        if (!DB[col]) DB[col] = [];
        const existing = new Map(DB[col].map(d => [d._id, d]));
        snap.docs.forEach(d => existing.set(d.id, {...d.data(), _id: d.id}));
        DB[col] = [...existing.values()];
        _touchVer(col);
      };
      merge('paiements', paySnap);
      merge('adhesionPays', adhSnap);
      merge('livraisons', livSnap);
    } catch(e) {
      console.error('Échec chargement complet des données du client:', e);
      notify("Certaines données anciennes de ce client n'ont peut-être pas pu être chargées — vérifiez votre connexion.", 'err');
    }
  }

  const c=getCl(cid), s=stats(c), com=getCom(c.commercialId);
  const fin=new Date(c.debut+'T12:00:00'); fin.setDate(fin.getDate()+(c.duree||372));

  document.getElementById('fiche-cl-header').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:800;">${esc(c.nom)}</div>
        ${c.codeClient?`<span style="background:rgba(201,168,76,0.18);border:1px solid rgba(201,168,76,0.45);border-radius:5px;padding:2px 10px;font-size:13px;color:var(--accent);font-weight:700;">${esc(c.codeClient)}</span>`:''}
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">📞 ${esc(c.tel||'—')} &nbsp;·&nbsp; 📍 ${esc(c.ville||'—')}${c.quartier?' — '+esc(c.quartier):''} &nbsp;·&nbsp; 👔 ${esc(com.nom)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--muted);">Début : <strong>${esc(c.debut||'—')}</strong> &nbsp;·&nbsp; Fin : <strong>${esc(fin.toLocaleDateString('fr-FR'))}</strong></div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">Durée : <strong>${esc(String(c.duree||372))} jours</strong></div>
      </div>
    </div>`;

  // Badge niveau selon progression
  const _pct=s.pct; let _niv='',_nc='';
  if(_pct>=100){_niv='🏆 Soldé';_nc='kv-green';}
  else if(_pct>=75){_niv='🌟 Avancé';_nc='kv-blue';}
  else if(_pct>=50){_niv='📈 En cours';_nc='kv-blue';}
  else if(_pct>=25){_niv='🔵 Débutant';_nc='kv-yellow';}
  else{_niv='🔴 Faible';_nc='kv-red';}

  document.getElementById('fiche-cl-kpi').innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total payé</div><div class="kpi-val kv-green" style="font-size:16px">${fmt(s.totalPaye)}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Restant</div><div class="kpi-val kv-red" style="font-size:16px">${fmt(s.totalRestant)}</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Progression</div><div class="kpi-val kv-blue" style="font-size:16px">${s.pct}%</div></div>
    <div class="kpi-card" style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:10px;padding:12px 10px;"><div class="kpi-lbl">Niveau</div><div class="kpi-val ${_nc}" style="font-size:13px;font-weight:800;">${_niv}</div></div>`;

  // ── Niveau de cotisation (calcul local pour la fiche) ──
  const dureeF = c.duree||372;
  const cotisF = jm(c);
  const pctActuelF = Math.min(100, Math.round(s.joursCouv/dureeF*100));
  const colorActuelF = s.joursRetard>0 ? 'var(--danger)' : 'var(--accent)';

  // Onglet Infos
  document.getElementById('fiche-cl-info').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;">
      <div class="ib ib-blue" style="margin:0;"><strong>Contrat</strong><br>${esc(c.contrat||'—')}</div>
      <div class="ib ib-green" style="margin:0;"><strong>Cotisation/jour</strong><br><span style="font-size:16px;font-weight:700;color:var(--accent2)">${fmt(s.m)}</span></div>
      <div class="ib ib-purple" style="margin:0;"><strong>Montant total</strong><br>${fmt(c.montantTotal||0)}</div>
      <div class="ib ib-yellow" style="margin:0;"><strong>Adhésion</strong><br>${fmt(c.adhesion||0)} — ${c.adhesionStatut==='paye'?'✅ Payée':'❌ Non payée'}</div>
    </div>

    ${(c.contratArticles&&c.contratArticles.length)?`
    <!-- Articles du contrat -->
    <div style="background:var(--surface2);border:1px solid rgba(56,201,160,0.25);border-radius:10px;padding:12px;margin-top:10px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">📦 Articles du contrat</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:rgba(56,201,160,0.07);">
          <th style="padding:5px 8px;text-align:left;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Article</th>
          <th style="padding:5px 8px;text-align:center;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Qté</th>
          <th style="padding:5px 8px;text-align:right;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Prix unit.</th>
          <th style="padding:5px 8px;text-align:right;font-size:9.5px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Sous-total</th>
        </tr></thead>
        <tbody>
          ${c.contratArticles.map((a,i)=>`<tr style="border-top:1px solid var(--border);${i%2?'background:rgba(26,32,53,0.3)':''}">
            <td style="padding:6px 8px;font-weight:600;font-size:12px;">${esc(a.nom)}</td>
            <td style="padding:6px 8px;text-align:center;font-size:12px;color:var(--muted);">${a.qty}</td>
            <td style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted);">${fmt(a.pv)}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;font-size:12px;color:var(--accent2);">${fmt(a.qty*a.pv)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="border-top:2px solid rgba(56,201,160,0.3);background:rgba(56,201,160,0.06);">
          <td colspan="3" style="padding:7px 8px;font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:800;color:var(--accent2);text-align:right;">TOTAL :</td>
          <td style="padding:7px 8px;font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:800;color:var(--accent);text-align:right;">${fmt(c.contratArticles.reduce((t,a)=>t+a.qty*a.pv,0))}</td>
        </tr></tfoot>
      </table>
    </div>`:''}

    <!-- Bloc niveau de cotisation -->
    <div style="background:var(--surface2);border:1px solid rgba(201,168,76,0.3);border-radius:10px;padding:14px;margin-top:12px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:var(--accent);margin-bottom:10px;">📊 Niveau de cotisation</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div style="background:rgba(201,168,76,0.07);border:1px solid rgba(201,168,76,0.2);border-radius:8px;padding:10px;">
          <div class="niveau-label">Jours couverts</div>
          <div class="niveau-val" style="color:${colorActuelF};">${joursEnJM(s.joursCouv)} <span style="font-size:11px;font-weight:400;color:var(--muted);">/ ${joursEnJM(dureeF)}</span></div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${pctActuelF}% couvert</div>
          <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);margin-top:6px;overflow:hidden;">
            <div style="width:${pctActuelF}%;height:100%;background:${colorActuelF};border-radius:4px;transition:width 0.4s;"></div>
          </div>
        </div>
        <div style="background:${s.joursRetard>0?'rgba(247,97,79,0.08)':'rgba(34,212,160,0.08)'};border:1px solid ${s.joursRetard>0?'rgba(224,92,82,0.25)':'rgba(34,212,160,0.2)'};border-radius:8px;padding:10px;">
          <div class="niveau-label">${s.joursRetard>0?'Retard':'Situation'}</div>
          <div class="niveau-val" style="color:${s.joursRetard>0?'var(--danger)':'var(--accent2)'};">${s.joursRetard>0?`${s.joursRetard}j`:'✓ À jour'}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px;">${s.joursRetard>0?`≈ ${fmt(s.joursRetard*s.m)} de retard`:`${s.joursCouv}j / ${s.joursEcoules}j écoulés`}</div>
          <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);margin-top:6px;overflow:hidden;">
            <div style="width:${s.joursRetard>0?Math.min(100,Math.round(s.joursRetard/dureeF*100)):100}%;height:100%;background:${s.joursRetard>0?'var(--danger)':'var(--accent2)'};border-radius:4px;"></div>
          </div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:3px;">
          <span>Progression sur ${dureeF} jours</span><span style="font-weight:700;color:${colorActuelF};">${pctActuelF}%</span>
        </div>
        <div style="height:10px;border-radius:6px;background:rgba(255,255,255,0.07);position:relative;overflow:hidden;">
          <div style="position:absolute;top:0;left:0;width:${pctActuelF}%;height:100%;background:${colorActuelF};border-radius:6px;"></div>
        </div>
      </div>
    </div>

    ${c.note?`<div style="margin-top:8px;font-size:11px;color:var(--muted);">📝 ${esc(c.note)}</div>`:''}`;

  // Paiements
  const pays=[...s.pays].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  // Trier du plus ancien au plus récent pour calculer le niveau cumulatif
  const paysTries = [...pays].sort((a,b)=>a.date.localeCompare(b.date));
  const cotisParJour = s.m;
  const dureeContrat = c.duree || 372;
  let cumulMontant = 0;
  // Calculer le niveau cumulatif pour chaque paiement (du plus ancien au plus récent)
  const niveauxMap = new Map();
  paysTries.forEach(p => {
    cumulMontant += p.montant;
    const joursCouv = cotisParJour > 0 ? Math.floor(cumulMontant / cotisParJour) : 0;
    niveauxMap.set(p._id || (p.date+p.montant), Math.min(dureeContrat, joursCouv));
  });
  document.getElementById('fiche-cl-pays-list').innerHTML=pays.map(p=>{
    const locked=p.verrouille||p.source==='commercial';
    const key = p._id || (p.date+p.montant);
    const niveauApres = niveauxMap.get(key);
    const niveauLabel = niveauApres !== undefined ? joursEnJM(niveauApres) : '—';
    const niveauColor = niveauApres !== undefined && niveauApres >= dureeContrat ? 'var(--accent2)' : 'var(--accent)';
    return`<tr><td>${esc(p.date)}</td><td class="tm">${esc(p.heure||'—')}</td><td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(p.cotisJour||s.m)}</span></td><td style="color:var(--accent2);font-weight:700">${fmt(p.montant)}</td><td>${ratio(p.montant,p.cotisJour||s.m)}</td><td style="font-size:12px;font-weight:700;color:${niveauColor};white-space:nowrap;">${niveauLabel}<span style="font-size:9px;color:var(--muted);font-weight:400;"> /${joursEnJM(dureeContrat)}</span></td><td style="font-size:10px;color:var(--muted)">${esc(p.saisiParNom||p.saisieParNom||'—')}${locked?' 🔒':''}${badgeCorrection(p)}</td><td class="tm" style="font-size:10px">${esc(p.note||'—')}</td></tr>`;
  }).join('')||'<tr><td colspan="8" class="emp">Aucun paiement</td></tr>';

  // Livraisons
  const livs=DB.livraisons.filter(l=>l.clientId===cid).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  document.getElementById('fiche-cl-liv-list').innerHTML=livs.map(l=>`<tr><td>${esc(l.date)}</td><td class="fw6">${esc(getProd(l.produitId).nom)}</td><td>${esc(String(l.qty||""))}</td><td>${fmt(l.montant)}</td><td>${livStatut(l.statut)}</td></tr>`).join('')||'<tr><td colspan="5" class="emp">Aucune livraison</td></tr>';

  // Adhésion
  const adhPays=DB.adhesionPays.filter(a=>a.clientId===cid);
  const adhIsAdmin = session && session.role===ROLES.ADMIN;
  document.getElementById('fiche-cl-adh-content').innerHTML=`<div class="ib ${c.adhesionStatut==='paye'?'ib-green':'ib-red'}" style="margin-bottom:8px;"><strong>Adhésion : ${fmt(c.adhesion)}</strong> — ${c.adhesionStatut==='paye'?'✅ Payé':'❌ Non payé'}</div>${adhPays.length>0?`<table style="width:100%;border-collapse:collapse;">${adhPays.map(a=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px;font-size:12px">${esc(a.date)}</td><td style="padding:6px;color:var(--accent2);font-weight:600">${fmt(a.montant)}</td><td style="padding:6px;font-size:11px;color:var(--muted)">${esc(a.note||'—')}</td>${adhIsAdmin?`<td style="padding:6px;text-align:right;"><button class="btn btn-xs btn-warn" onclick="supprimerAdhesionPay('${a._id}','${cid}')" title="Supprimer ce frais d'adhésion">🗑</button></td>`:''}</tr>`).join('')}</table>`:'<div class="emp" style="padding:12px">Aucun paiement d\'adhésion</div>'}`;

  // ✅ FIX : ne plus toujours revenir sur l'onglet "Infos" lors d'un
  // rafraîchissement silencieux (déclenché par un paiement/livraison saisi
  // ailleurs pendant la consultation de la fiche). On mémorise l'onglet
  // actuellement affiché AVANT de reconstruire le contenu, puis on le
  // restaure après — au lieu d'écraser systématiquement le choix de
  // l'utilisateur avec "Infos".
  const _ongletActifAvant = (() => {
    const tabs = ['info','paiements','livraisons','adhesion','calendrier'];
    for (const t of tabs) {
      const el = document.getElementById('fiche-cl-'+t);
      if (el && el.style.display !== 'none') return t;
    }
    return 'info';
  })();
  document.querySelectorAll('.fiche-cl-tab').forEach(t=>t.classList.remove('active'));
  const _tabsBtns = document.querySelectorAll('.fiche-cl-tab');
  const _tabIdx = ['info','paiements','livraisons','adhesion','calendrier'].indexOf(_ongletActifAvant);
  (_tabsBtns[_tabIdx] || _tabsBtns[0]).classList.add('active');
  ['paiements','livraisons','adhesion','calendrier','info'].forEach(t=>document.getElementById('fiche-cl-'+t).style.display = t===_ongletActifAvant ? '' : 'none');
  if (_ongletActifAvant === 'calendrier') {
    document.getElementById('fiche-cl-cal-content').innerHTML = genererCalendrierClient(cid);
  }
  _ficheClientCtxId = cid;

  document.getElementById('fiche-cl-pay-btn').onclick=()=>{closeM('m-fiche-client');openPay(cid);};
  document.getElementById('fiche-cl-pay-btn').style.display = (session.role===ROLES.ADMIN||session.role===ROLES.COMMERCIAL||session.role===ROLES.CHEF_AGENCE) ? '' : 'none';
  document.getElementById('fiche-cl-edit-btn').onclick=()=>{closeM('m-fiche-client');ouvrirEditionClient(cid);};
  // Bouton modifier contrat rapide
  const ficheContratBtn = document.getElementById('fiche-cl-contrat-btn');
  if(ficheContratBtn){
    ficheContratBtn.style.display = ['admin','chef_agence','secretaire'].includes(session.role) ? '' : 'none';
    ficheContratBtn.onclick=()=>{closeM('m-fiche-client');ouvrirModifContrat(cid);};
  }
  openM('m-fiche-client');
};

// ═══════════════ IMPRESSION FICHE CLIENT COMPLÈTE ═════════════
// Génère une page imprimable indépendante (fond blanc, sans le thème
// sombre de l'appli) avec les infos client + l'historique COMPLET des
// paiements (pas seulement ce qui est visible dans la zone défilante).
window.imprimerFicheClient = function(cid){
  cid = cid || _ficheClientCtxId;
  if(!cid){ notify('Aucune fiche ouverte à imprimer','err'); return; }
  const c = getCl(cid);
  if(!c){ notify('Client introuvable','err'); return; }
  const s = stats(c);
  const com = getCom(c.commercialId);
  const fin = new Date(c.debut+'T12:00:00'); fin.setDate(fin.getDate()+(c.duree||372));

  // Historique complet des paiements, du plus récent au plus ancien
  const pays = [...s.pays].sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.heure||'').localeCompare(a.heure||''));

  // Calcul du niveau cumulatif (identique à l'affichage écran)
  const paysTries = [...pays].sort((a,b)=>a.date.localeCompare(b.date));
  const cotisParJour = s.m;
  const dureeContrat = c.duree || 372;
  let cumulMontant = 0;
  const niveauxMap = new Map();
  paysTries.forEach(p=>{
    cumulMontant += p.montant;
    const joursCouv = cotisParJour>0 ? Math.floor(cumulMontant/cotisParJour) : 0;
    niveauxMap.set(p._id || (p.date+p.montant), Math.min(dureeContrat, joursCouv));
  });

  const lignesPaiements = pays.map(p=>{
    const key = p._id || (p.date+p.montant);
    const niveauApres = niveauxMap.get(key);
    const niveauLabel = niveauApres!==undefined ? joursEnJM(niveauApres) : '—';
    return `<tr>
      <td>${esc(p.date)}</td>
      <td>${esc(p.heure||'—')}</td>
      <td>${fmt(p.cotisJour||s.m)}</td>
      <td style="font-weight:700;">${fmt(p.montant)}</td>
      <td>${niveauLabel} / ${joursEnJM(dureeContrat)}</td>
      <td>${esc(p.saisiParNom||p.saisieParNom||'—')}${p.verrouille||p.source==='commercial'?' 🔒':''}</td>
      <td>${esc(p.note||'—')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:#888;padding:14px;">Aucun paiement enregistré</td></tr>';

  const dateImpression = new Date().toLocaleString('fr-FR');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Fiche client — ${esc(c.nom)}</title>
<style>
  * { box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; margin:24px; font-size:13px; }
  h1 { font-size:20px; margin:0 0 2px 0; }
  .sub { color:#555; font-size:12px; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:14px 0 18px 0; }
  .card { border:1px solid #ccc; border-radius:6px; padding:8px 10px; }
  .card .lbl { font-size:10px; text-transform:uppercase; color:#666; letter-spacing:0.5px; }
  .card .val { font-size:16px; font-weight:700; margin-top:2px; }
  .infos { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:18px; }
  .infos div { border:1px solid #ddd; border-radius:6px; padding:8px 10px; }
  table { width:100%; border-collapse:collapse; margin-top:6px; }
  th, td { border:1px solid #ccc; padding:5px 7px; font-size:11.5px; text-align:left; }
  th { background:#f0f0f0; text-transform:uppercase; font-size:9.5px; letter-spacing:0.5px; }
  h2 { font-size:14px; margin:18px 0 4px 0; border-bottom:2px solid #333; padding-bottom:3px; }
  .footer { margin-top:22px; font-size:10px; color:#777; text-align:right; }
  @media print {
    body { margin:10mm; }
    button { display:none; }
  }
  .print-bar { text-align:right; margin-bottom:14px; }
  .print-bar button { padding:8px 16px; font-size:13px; cursor:pointer; }
</style>
</head>
<body>
  <div class="print-bar"><button onclick="window.print()">🖨️ Imprimer</button></div>

  <h1>${esc(c.nom)} ${c.codeClient?('— '+esc(c.codeClient)):''}</h1>
  <div class="sub">📞 ${esc(c.tel||'—')} · 📍 ${esc(c.ville||'—')}${c.quartier?(' — '+esc(c.quartier)):''} · Commercial : ${esc(com.nom)}</div>

  <div class="grid">
    <div class="card"><div class="lbl">Total payé</div><div class="val">${fmt(s.totalPaye)}</div></div>
    <div class="card"><div class="lbl">Restant</div><div class="val">${fmt(s.totalRestant)}</div></div>
    <div class="card"><div class="lbl">Progression</div><div class="val">${s.pct}%</div></div>
    <div class="card"><div class="lbl">Montant total contrat</div><div class="val">${fmt(c.montantTotal||0)}</div></div>
  </div>

  <div class="infos">
    <div><strong>Contrat</strong><br>${esc(c.contrat||'—')}</div>
    <div><strong>Cotisation/jour</strong><br>${fmt(s.m)}</div>
    <div><strong>Début</strong><br>${esc(c.debut||'—')}</div>
    <div><strong>Fin prévue</strong><br>${esc(fin.toLocaleDateString('fr-FR'))} (${c.duree||372} jours)</div>
  </div>

  <h2>💰 Historique des paiements (${pays.length})</h2>
  <table>
    <thead><tr>
      <th>Date</th><th>Heure</th><th>Cotis./j</th><th>Montant</th><th>Niveau après</th><th>Saisi par</th><th>Note</th>
    </tr></thead>
    <tbody>${lignesPaiements}</tbody>
  </table>

  <div class="footer">Document généré le ${esc(dateImpression)} — TRIOMPHANT MMB SERVICE</div>

  <script>
    // Ouvre automatiquement la boîte de dialogue d'impression
    window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };
  <\/script>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if(!w){ notify("Impossible d'ouvrir la fenêtre d'impression — vérifiez que les pop-ups ne sont pas bloqués.", 'err'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
};

window.switchFicheTab = function(tab,el){
  document.querySelectorAll('.fiche-cl-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  ['info','paiements','livraisons','adhesion','calendrier'].forEach(t=>document.getElementById('fiche-cl-'+t).style.display=t===tab?'':'none');
  if(tab==='calendrier' && _ficheClientCtxId){
    document.getElementById('fiche-cl-cal-content').innerHTML = genererCalendrierClient(_ficheClientCtxId);
  }
};

let _ficheClientCtxId = null;
let _detClientCtxId = null;

window.switchDetTab = function(tab, el){
  document.querySelectorAll('.det-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  ['paiements','livraisons','adhesion','calendrier'].forEach(t=>document.getElementById('det-'+t).style.display=t===tab?'':'none');
  if(tab==='calendrier' && _detClientCtxId){
    document.getElementById('det-cal-content').innerHTML = genererCalendrierClient(_detClientCtxId);
  }
};

// ========= CALENDRIER CLIENT =========
function genererCalendrierClient(cid){
  const c = getCl(cid);
  const s = stats(c);
  const duree = c.duree || 372;
  const debut = new Date((c.debut||TODAY)+'T12:00:00');
  const today = new Date(TODAY+'T12:00:00');
  const cotis = jm(c);

  // Construire une map date -> montant payé ce jour
  const payMap = {};
  s.pays.forEach(p=>{
    if(!payMap[p.date]) payMap[p.date] = 0;
    payMap[p.date] += p.montant||0;
  });

  // Calculer les jours couverts (cumulatif)
  // On distribue les paiements chronologiquement sur les jours
  // Un paiement de N cotis couvre N jours à partir du jour courant non couvert
  let jours = [];
  for(let i=0; i<duree; i++){
    const d = new Date(debut); d.setDate(d.getDate()+i);
    const ds = d.toISOString().split('T')[0];
    jours.push({date:ds, d, index:i});
  }

  // Reconstruct couverture jour par jour à partir des paiements triés chronologiquement
  const paiements = [...s.pays].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let montantRestant = paiements.reduce((a,p)=>a+p.montant,0);
  // marquer les jours couverts : on dépense cotis par jour dans l'ordre
  let monnaie = montantRestant;
  const jourCouvert = new Array(duree).fill(false);
  for(let i=0; i<duree; i++){
    if(monnaie >= cotis){ jourCouvert[i]=true; monnaie-=cotis; }
    else break;
  }

  // Regrouper par tranches de 31 jours (Mois 1 = jours 1-31, Mois 2 = jours 32-62, etc.)
  const moisMap = {}; // key: numéro de mois (1-based) -> [{index, date, d}]
  jours.forEach(j=>{
    const numMois = Math.floor(j.index / 31) + 1;
    if(!moisMap[numMois]) moisMap[numMois]=[];
    moisMap[numMois].push(j);
  });

  const joursCouverts = jourCouvert.filter(Boolean).length;
  const joursEcoules = Math.max(0, Math.floor((today-debut)/(86400000)));
  const joursRetard = Math.max(0, joursEcoules - joursCouverts);
  const dateFin = new Date(debut); dateFin.setDate(dateFin.getDate()+duree-1);

  let html = `
  <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      <div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:800;color:var(--accent);">📅 Calendrier de cotisation</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">Du <strong>${debut.toLocaleDateString('fr-FR')}</strong> au <strong>${dateFin.toLocaleDateString('fr-FR')}</strong> — <strong>${duree} jours</strong></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div style="text-align:center;background:rgba(34,212,160,0.1);border:1px solid rgba(34,212,160,0.25);border-radius:8px;padding:7px 12px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Jours couverts</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent2);">${joursCouverts}</div>
        </div>
        <div style="text-align:center;background:${joursRetard>0?'rgba(224,92,82,0.1)':'rgba(201,168,76,0.08)'};border:1px solid ${joursRetard>0?'rgba(224,92,82,0.25)':'rgba(201,168,76,0.25)'};border-radius:8px;padding:7px 12px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">${joursRetard>0?'Jours retard':'À jour'}</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:${joursRetard>0?'var(--danger)':'var(--accent)'};">${joursRetard>0?joursRetard:'✓'}</div>
        </div>
        <div style="text-align:center;background:rgba(247,201,79,0.08);border:1px solid rgba(247,201,79,0.2);border-radius:8px;padding:7px 12px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Cotis./jour</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:800;color:var(--accent);">${fmt(cotis)}</div>
        </div>
      </div>
    </div>`;

  // Grille mois par mois (31 jours chacun)
  Object.entries(moisMap).forEach(([numMois, joursM])=>{
    const moisLabel = 'Mois ' + numMois;
    html += `<div style="margin-bottom:14px;">
      <div class="cal-mois-label">${moisLabel}</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px;">`;

    joursM.forEach(j=>{
      const idx = j.index;
      const isToday = j.date === TODAY;
      const isPasse = j.d < today;
      const estCouvert = jourCouvert[idx];
      const estFutur = j.d > today;

      let cls = 'futur';
      let title = '';
      if(isToday){ cls = estCouvert?'paye aujourdhui':'retard aujourdhui'; }
      else if(estCouvert){ cls='paye'; }
      else if(isPasse){ cls='retard'; }

      const dateStr = j.d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
      const paye = payMap[j.date]||0;
      title = `Jour ${idx+1} — ${dateStr}${paye>0?' — Payé: '+fmt(paye):''}${estCouvert?' ✓ Couvert':isPasse?' ✗ Non couvert':' (à venir)'}`;

      html += `<div class="cal-day ${cls}" title="${title}" style="width:18px;height:18px;border-radius:3px;cursor:default;flex-shrink:0;" data-tip="${title}"></div>`;
    });

    html += `</div></div>`;
  });

  html += `<div class="cal-legend">
    <div class="cal-legend-item"><div class="cal-legend-dot" style="background:#22d4a0;"></div>Jour couvert (payé)</div>
    <div class="cal-legend-item"><div class="cal-legend-dot" style="background:var(--danger);"></div>Jour en retard</div>
    <div class="cal-legend-item"><div class="cal-legend-dot" style="background:rgba(201,168,76,0.35);outline:2px solid var(--accent);"></div>Aujourd'hui</div>
    <div class="cal-legend-item"><div class="cal-legend-dot" style="background:rgba(255,255,255,0.06);"></div>Jour à venir</div>
  </div>
  </div>`;

  return html;
}


// ========= ÉDITION CLIENT (admin) =========
window.ouvrirEditionClient = function(cid){
  const c=getCl(cid);
  document.getElementById('edit-cl-id').value=cid;
  document.getElementById('edit-cl-code').value=c.codeClient||'';
  document.getElementById('edit-cl-nom').value=c.nom||'';
  document.getElementById('edit-cl-tel').value=c.tel||'';
  document.getElementById('edit-cl-ville').value=c.ville||'';
  document.getElementById('edit-cl-qrt').value=c.quartier||'';
  document.getElementById('edit-cl-contrat').value=c.contrat||'';
  document.getElementById('edit-cl-montant').value=c.montantTotal||'';
  syncDureeSelect('edit-cl-duree-sel','edit-cl-duree',c.duree||372);
  document.getElementById('edit-cl-debut').value=c.debut||TODAY;
  document.getElementById('edit-cl-adhesion').value=c.adhesion||0;
  document.getElementById('edit-cl-adhesion-statut').value=c.adhesionStatut||'non_paye';
  document.getElementById('edit-cl-note').value=c.note||'';
  document.getElementById('edit-cl-com').innerHTML=comsDansAgence().filter(x=>x.role===ROLES.COMMERCIAL).map(x=>`<option value="${x._id}"${x._id===c.commercialId?' selected':''}>${esc(x.nom)}</option>`).join('');
  document.getElementById('edit-cl-calc-info').style.display='none';
  calcJourEdit();
  openM('m-edit-client');
};

// ── Helpers sélecteur de durée ──
window.clDureeChange = function(sel){
  const inp = document.getElementById('cl-duree');
  if(sel.value==='custom'){inp.style.display='';inp.value='';inp.focus();}
  else{inp.style.display='none';inp.value=sel.value;calcJour();}
};
window.editClDureeChange = function(sel){
  const inp = document.getElementById('edit-cl-duree');
  if(sel.value==='custom'){inp.style.display='';inp.value='';inp.focus();}
  else{inp.style.display='none';inp.value=sel.value;calcJourEdit();}
};
window.comNclDureeChange = function(sel){
  const inp = document.getElementById('com-ncl-duree');
  if(sel.value==='custom'){inp.style.display='';inp.value='';inp.focus();}
  else{inp.style.display='none';inp.value=sel.value;calcJourComNcl();}
};
// Synchronise le select durée avec une valeur numérique (pour ouvrirEditionClient)
function syncDureeSelect(selId, inpId, val){
  const sel = document.getElementById(selId);
  const inp = document.getElementById(inpId);
  if(!sel||!inp) return;
  const known = ['93','186','372'];
  if(known.includes(String(val))){sel.value=String(val);inp.style.display='none';inp.value=val;}
  else{sel.value='custom';inp.style.display='';inp.value=val;}
}


window.calcJourEdit = function(){
  const p=parseFloat(document.getElementById('edit-cl-montant').value)||0;
  const d=parseInt(document.getElementById('edit-cl-duree').value)||372;
  const el=document.getElementById('edit-cl-calc-info');
  if(p>0){el.style.display='block';const jmv=Math.ceil(p/d);const debut=document.getElementById('edit-cl-debut').value||TODAY;const fin=new Date(debut+'T12:00:00');fin.setDate(fin.getDate()+d);el.innerHTML=`💰 Cotisation : <strong>${fmt(jmv)}/jour</strong> sur ${d} jours → Fin : <strong>${fin.toLocaleDateString('fr-FR')}</strong>`;}
  else el.style.display='none';
};

window.sauvegarderEditionClient = async function(){
  const cid=document.getElementById('edit-cl-id').value;
  const nom=document.getElementById('edit-cl-nom').value.trim();
  const tel=document.getElementById('edit-cl-tel').value.trim();
  const ct=document.getElementById('edit-cl-contrat').value.trim();
  const mt=parseFloat(document.getElementById('edit-cl-montant').value)||0;
  const debut=document.getElementById('edit-cl-debut').value;
  if(!nom||!tel||!ct||mt<=0||!debut){notify('Champs obligatoires manquants','err');return;}
  const newCode=document.getElementById('edit-cl-code').value.trim().toUpperCase();
  // Vérifier doublon de code si changé
  if(newCode){
    const doublon=DB.clients.find(c=>c._id!==cid&&c.codeClient&&c.codeClient.toUpperCase()===newCode);
    if(doublon){notify(`Code "${newCode}" déjà utilisé par ${esc(doublon.nom)}`,'err');return;}
  }
  // ✅ FIX : les clients importés peuvent porter un champ caché
  // 'cotisationJourFixe' (fixé une fois à l'import) que jm() priorise
  // toujours sur montantTotal/duree. Ce formulaire modifie justement
  // montantTotal/duree — sans effacer cotisationJourFixe, la nouvelle
  // cotisation calculée ici (affichée dans l'aperçu ci-dessus) ne
  // s'appliquerait jamais réellement. On l'efface donc à chaque
  // modification du contrat pour que le nouveau montant/durée fasse foi.
  await fbUpdate('clients',cid,{
    codeClient:newCode, nom, tel,
    ville:document.getElementById('edit-cl-ville').value,
    quartier:document.getElementById('edit-cl-qrt').value,
    contrat:ct, montantTotal:mt,
    duree:parseInt(document.getElementById('edit-cl-duree').value)||372,
    debut, note:document.getElementById('edit-cl-note').value,
    commercialId:document.getElementById('edit-cl-com').value,
    adhesion:parseFloat(document.getElementById('edit-cl-adhesion').value)||0,
    adhesionStatut:document.getElementById('edit-cl-adhesion-statut').value,
    cotisationJourFixe: null
  });
  closeM('m-edit-client');
  notify(`Client ${nom} mis à jour ✓`);
};


// ========= MODIFICATION DU CONTRAT AVEC ARTICLES =========
// State temporaire des articles du contrat en cours d'édition
let _mcArticles = []; // [{artId, nom, qty, pv}]

let _mcArticlesInitial = []; // snapshot avant modification pour diff

window.ouvrirModifContrat = function(cid){
  if(!cid){ notify("Client introuvable","err"); return; }
  const c = getCl(cid);
  const s = stats(c);
  document.getElementById("mc-cl-id").value = cid;
  document.getElementById("mc-cl-info").innerHTML =
    "<strong>"+esc(c.nom)+"</strong> · "+esc(c.contrat||"—")+"<br>"
    +"Déjà payé : <strong style=\"color:var(--accent2)\">"+fmt(s.totalPaye)+"</strong> / "+fmt(c.montantTotal||0)+" "
    +"— Restant : <strong style=\"color:"+(s.totalRestant>0?"var(--accent)":"var(--accent2)")+"\">"+fmt(s.totalRestant)+"</strong>";
  const mcContratEl = document.getElementById("mc-contrat");
  mcContratEl.value = c.contrat||"";
  // Marquer la désignation initiale comme "auto" si elle correspond au pattern articles
  // (sera écrasée librement par mcAutoNom si l'admin ne l'a pas modifiée manuellement)
  mcContratEl.dataset.auto = c.contrat||"";
  document.getElementById("mc-montant").value = c.montantTotal||"";
  syncDureeSelect("mc-duree-sel","mc-duree",c.duree||372);

  // Réinitialiser les nouveaux champs
  const codeEl = document.getElementById("mc-art-code"); if(codeEl) codeEl.value='';
  const qtyCodeEl = document.getElementById("mc-art-qty-code"); if(qtyCodeEl) qtyCodeEl.value=1;
  const msgEl = document.getElementById("mc-art-code-msg"); if(msgEl) msgEl.style.display='none';
  const noteEl = document.getElementById("mc-note-modif"); if(noteEl) noteEl.value='';

  // Charger les articles actuels du contrat + snapshot initial pour diff
  _mcArticles = (c.contratArticles||[]).map(a=>({...a}));
  _mcArticlesInitial = (c.contratArticles||[]).map(a=>({...a}));

  // Remplir le select de produits
  const sel = document.getElementById("mc-art-sel");
  sel.innerHTML = '<option value="">— Sélectionner un produit —</option>'
    + DB.produits.filter(p=>p.nom).sort((a,b)=>a.nom.localeCompare(b.nom))
        .map(p=>'<option value="'+p._id+'" data-pv="'+(p.prix||0)+'" data-nom="'+esc(p.nom)+'">'+esc(p.nom)+' — '+fmt(p.prix)+'</option>').join('');
  sel.onchange = function(){
    const opt = sel.options[sel.selectedIndex];
    const pv = opt ? opt.getAttribute('data-pv') : '';
    document.getElementById("mc-art-pv").value = pv||'';
  };

  _mcRenderArticles();
  calcMC();
  closeM("m-pay");
  openM("m-modif-contrat");
};

// Rend la liste des articles du contrat
function _mcRenderArticles(){
  const liste = document.getElementById("mc-art-liste");
  const vide  = document.getElementById("mc-art-vide");
  if(!_mcArticles.length){
    vide.style.display='';
    [...liste.querySelectorAll('.mc-art-row')].forEach(r=>r.remove());
    return;
  }
  vide.style.display='none';
  [...liste.querySelectorAll('.mc-art-row')].forEach(r=>r.remove());
  _mcArticles.forEach((a,i)=>{
    // Détecter si cet article était dans le contrat initial (pack d'origine) ou ajouté
    const estOriginal = _mcArticlesInitial.some(o=>o.artId===a.artId);
    const row = document.createElement('div');
    row.className = 'mc-art-row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);'+(i%2?'background:rgba(26,32,53,0.35)':'')+(estOriginal?'':'background:rgba(56,201,160,0.05);border-left:2px solid rgba(56,201,160,0.4);');
    const badgeNouv = !estOriginal ? '<span style="font-size:9px;background:rgba(56,201,160,0.15);color:var(--accent2);border:1px solid rgba(56,201,160,0.3);border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:700;">NOUVEAU</span>' : '';
    row.innerHTML =
      '<span style="flex:2;font-size:12px;font-weight:600;color:var(--text);">'+esc(a.nom)+badgeNouv+'</span>'
      +'<span style="flex:0 0 34px;text-align:center;">'
        +'<input type="number" min="1" value="'+a.qty+'" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:4px 6px;color:var(--accent);font-weight:700;font-size:12px;text-align:center;outline:none;" onchange="mcChangerQty('+i+',this.value)">'
      +'</span>'
      +'<span style="flex:0 0 110px;">'
        +'<input type="number" min="0" value="'+a.pv+'" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:4px 6px;color:var(--accent2);font-weight:600;font-size:11px;text-align:right;outline:none;" onchange="mcChangerPv('+i+',this.value)">'
      +'</span>'
      +'<span style="flex:0 0 90px;text-align:right;font-size:11px;font-weight:700;color:var(--accent);">'+fmt(a.qty*a.pv)+'</span>'
      +'<button onclick="mcSupprimerArticle('+i+')" title="Retirer du contrat (−'+fmt(a.qty*a.pv)+')" style="flex:0 0 auto;background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.3);border-radius:6px;padding:4px 9px;color:var(--danger);font-size:11px;font-weight:700;cursor:pointer;font-family:\'Outfit\',sans-serif;">➖</button>';
    liste.appendChild(row);
  });
  // Ligne total
  const totalNouv = _mcArticles.reduce((s,a)=>s+a.qty*a.pv,0);
  const totalAnc  = _mcArticlesInitial.reduce((s,a)=>s+a.qty*a.pv,0);
  const delta = totalNouv - totalAnc;
  const deltaHtml = (totalAnc>0 && delta!==0)
    ? ' <span style="font-size:11px;font-weight:600;color:'+(delta>0?'var(--accent2)':'var(--danger)')+';">'+(delta>0?'▲ +':'▼ ')+fmt(Math.abs(delta))+'</span>'
    : '';
  const totRow = document.createElement('div');
  totRow.className = 'mc-art-row';
  totRow.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:8px 12px;background:rgba(201,168,76,0.06);border-top:2px solid rgba(201,168,76,0.2);';
  totRow.innerHTML = '<span style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.8px;">Total produits</span>'
    +'<span style="font-family:\'Space Grotesk\',sans-serif;font-size:15px;font-weight:800;color:var(--accent);">'+fmt(totalNouv)+'</span>'
    +deltaHtml;
  liste.appendChild(totRow);
}

window.mcAjouterParCode = function(){
  const codeEl = document.getElementById('mc-art-code');
  const msgEl  = document.getElementById('mc-art-code-msg');
  const qtyEl  = document.getElementById('mc-art-qty-code');
  if(!codeEl||!msgEl) return;
  const code = codeEl.value.trim().toUpperCase();
  if(!code){ _mcShowMsg(msgEl,'Veuillez saisir un code ou une référence produit.','err'); return; }
  const prod = DB.produits.find(p=>
    (p.ref||'').toUpperCase()===code ||
    (p.nom||'').toUpperCase()===code
  );
  if(!prod){ _mcShowMsg(msgEl,`Aucun produit trouvé pour « ${code} ».`,'err'); return; }
  const qty = Math.max(1, parseInt(qtyEl?qtyEl.value:1)||1);
  const existing = _mcArticles.find(a=>a.artId===prod._id);
  if(existing){
    existing.qty += qty;
    _mcShowMsg(msgEl,`✓ Quantité mise à jour : ${esc(existing.nom)} × ${existing.qty}`,'ok');
  } else {
    _mcArticles.push({artId:prod._id, nom:prod.nom, qty, pv:prod.prix||0});
    _mcShowMsg(msgEl,`✓ « ${esc(prod.nom)} » ajouté au contrat.`,'ok');
  }
  codeEl.value='';
  if(qtyEl) qtyEl.value=1;
  _mcRenderArticles();
  mcRecalcTotal();
  mcAutoNom();
};

function _mcShowMsg(el, txt, type){
  const colors={ok:'rgba(34,212,160,0.15)',err:'rgba(224,92,82,0.14)',warn:'rgba(247,201,79,0.15)'};
  const tcol={ok:'var(--accent2)',err:'var(--danger)',warn:'var(--accent3)'};
  el.style.cssText=`display:block;background:${colors[type]||colors.ok};color:${tcol[type]||tcol.ok};border:1px solid ${tcol[type]||tcol.ok};border-radius:5px;padding:4px 9px;font-size:11px;`;
  el.textContent=txt;
  setTimeout(()=>{ if(type==='ok') el.style.display='none'; },DELAY_NOTIFY_HIDE_MS);
}

window.mcAjouterArticle = function(){
  const sel = document.getElementById("mc-art-sel");
  const qtyVal = parseInt(document.getElementById("mc-art-qty").value)||1;
  const pvVal  = parseFloat(document.getElementById("mc-art-pv").value)||0;
  if(!sel.value){ notify("Sélectionnez un produit","err"); return; }
  if(pvVal<=0){ notify("Prix unitaire invalide","err"); return; }
  const opt = sel.options[sel.selectedIndex];
  const nom = opt ? opt.getAttribute('data-nom') : sel.value;
  // Si l'article existe déjà → augmenter la quantité
  const existing = _mcArticles.find(a=>a.artId===sel.value);
  if(existing){ existing.qty+=qtyVal; }
  else { _mcArticles.push({artId:sel.value, nom, qty:qtyVal, pv:pvVal}); }
  sel.value='';
  document.getElementById("mc-art-qty").value=1;
  document.getElementById("mc-art-pv").value='';
  _mcRenderArticles();
  mcRecalcTotal();
  mcAutoNom();
};

window.mcSupprimerArticle = function(i){
  _mcArticles.splice(i,1);
  _mcRenderArticles();
  mcRecalcTotal();
  mcAutoNom();
};

window.mcChangerQty = function(i, val){
  const q = Math.max(1, parseInt(val)||1);
  _mcArticles[i].qty = q;
  _mcRenderArticles();
  mcRecalcTotal();
};

window.mcChangerPv = function(i, val){
  const p = Math.max(0, parseFloat(val)||0);
  _mcArticles[i].pv = p;
  _mcRenderArticles();
  mcRecalcTotal();
};

// Recalcule le montant total depuis la liste d'articles — toujours écrasé
window.mcRecalcTotal = function(){
  const total = _mcArticles.reduce((s,a)=>s+a.qty*a.pv,0);
  document.getElementById("mc-montant").value = total > 0 ? total : '';
  calcMC();
};

// Auto-génère la désignation du contrat depuis les articles
window.mcAutoNom = function(){
  const inp = document.getElementById("mc-contrat");
  if(!_mcArticles.length){
    // Si la désignation était auto, la vider aussi
    if(!inp.dataset.auto || inp.value.trim() === inp.dataset.auto){
      inp.value = ''; inp.dataset.auto = '';
    }
    return;
  }
  // Ne pas écraser une désignation saisie manuellement
  const current = inp.value.trim();
  const autoLabel = _mcArticles.map(a=>a.qty>1?a.qty+'× '+a.nom:a.nom).join(' + ');
  if(!current || current === inp.dataset.auto) {
    inp.value = autoLabel;
    inp.dataset.auto = autoLabel;
  }
};

window.mcDureeChange = function(sel){
  const inp = document.getElementById("mc-duree");
  if(sel.value==="custom"){inp.style.display="";inp.value="";inp.focus();}
  else{inp.style.display="none";inp.value=sel.value;calcMC();}
};

window.calcMC = function(){
  const p = parseFloat(document.getElementById("mc-montant").value)||0;
  const d = parseInt(document.getElementById("mc-duree").value)||372;
  const el = document.getElementById("mc-calc-info");
  if(p>0){ el.style.display="block"; el.innerHTML="💰 Cotisation résultante : <strong>"+fmt(Math.ceil(p/d))+"/jour</strong> sur "+d+" jours"; }
  else el.style.display="none";
};

window.sauvegarderModifContrat = async function(){
  if(!session || !['admin','chef_agence'].includes(session.role)){ notify("Accès réservé à l'administrateur ou au chef d'agence","err"); return; }
  const cid = document.getElementById("mc-cl-id").value;
  const ct  = document.getElementById("mc-contrat").value.trim();
  const mt  = parseFloat(document.getElementById("mc-montant").value)||0;
  const dur = parseInt(document.getElementById("mc-duree").value)||372;
  if(!ct || mt<=0 || dur<=0){ notify("Contrat, montant et durée obligatoires","err"); return; }

  const c = getCl(cid);
  const noteMotif = (document.getElementById("mc-note-modif").value||"").trim();

  // ── Calculer le diff articles (ajoutés / retirés) ──
  const ancienIds  = new Set(_mcArticlesInitial.map(a=>a.artId));
  const nouveauIds = new Set(_mcArticles.map(a=>a.artId));

  const articlesAjoutes   = _mcArticles.filter(a=>!ancienIds.has(a.artId));
  const articlesSupprimés = _mcArticlesInitial.filter(a=>!nouveauIds.has(a.artId));
  const articlesQteChange = _mcArticles.filter(a=>{
    const old = _mcArticlesInitial.find(o=>o.artId===a.artId);
    return old && old.qty !== a.qty;
  });

  // ── Construire la note historique ──
  const ancienContratLabel = c.contrat || "—";
  const ancienMontant = c.montantTotal || 0;
  const ancienDuree   = c.duree || 372;
  const dateModif = TODAY;
  const now = new Date();
  const heureModif = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');

  let noteHistorique = `[Modif ${dateModif} ${heureModif} par ${esc(session.nom)}]`;
  noteHistorique += ` Ancien contrat : « ${ancienContratLabel} » — ${fmt(ancienMontant)} — ${ancienDuree}j.`;
  if(articlesAjoutes.length)   noteHistorique += ` +Ajout : ${articlesAjoutes.map(a=>a.nom+(a.qty>1?' ×'+a.qty:'')).join(', ')}.`;
  if(articlesSupprimés.length) noteHistorique += ` −Retrait : ${articlesSupprimés.map(a=>a.nom).join(', ')}.`;
  if(articlesQteChange.length) noteHistorique += ` Qté modifiée : ${articlesQteChange.map(a=>{const o=_mcArticlesInitial.find(x=>x.artId===a.artId); return a.nom+' ('+o.qty+'→'+a.qty+')';}).join(', ')}.`;
  if(noteMotif) noteHistorique += ` Motif : ${noteMotif}.`;

  // Conserver les notes précédentes si existantes
  const noteExistante = (c.note||"").trim();
  const nouvelleNote = noteExistante ? noteExistante + "\n" + noteHistorique : noteHistorique;

  // ── Enregistrer ──
  // ✅ FIX : un client importé porte parfois un champ caché 'cotisationJourFixe'
  // (fixé une fois à l'import) que jm() priorise toujours sur montantTotal/duree.
  // On l'efface donc ici aussi (comme dans sauvegarderEditionClient) pour que la
  // cotisation journalière suive bien le nouveau montant/durée du contrat modifié.
  await fbUpdate("clients", cid, {
    contrat: ct,
    montantTotal: mt,
    duree: dur,
    contratArticles: _mcArticles.map(a=>({artId:a.artId,nom:a.nom,qty:a.qty,pv:a.pv})),
    note: nouvelleNote,
    cotisationJourFixe: null
  });

  closeM("m-modif-contrat");

  // ── Notification résumée ──
  let notifMsg = `✅ Contrat mis à jour — ${ct} — ${fmt(mt)}`;
  if(articlesAjoutes.length)   notifMsg += ` | ➕ ${articlesAjoutes.map(a=>a.nom+(a.qty>1?' ×'+a.qty:'')).join(', ')}`;
  if(articlesSupprimés.length) notifMsg += ` | ➖ ${articlesSupprimés.map(a=>a.nom).join(', ')}`;
  notify(notifMsg, "ok");

  // Si des articles ont été ajoutés, afficher une alerte récap visible
  if(articlesAjoutes.length || articlesSupprimés.length || articlesQteChange.length){
    setTimeout(()=>{
      let lignes = `<strong style="color:var(--accent)">📋 Résumé modification contrat — ${esc(c.nom)}</strong><br><span style="font-size:11px;color:var(--muted);">${dateModif} ${heureModif}</span><br><br>`;
      if(articlesAjoutes.length)   lignes += `<span style="color:var(--accent2)">➕ Ajoutés :</span> ${articlesAjoutes.map(a=>'<strong>'+esc(a.nom)+'</strong>'+(a.qty>1?' ×'+a.qty:'')+' — '+fmt(a.pv*a.qty)).join(', ')}<br>`;
      if(articlesSupprimés.length) lignes += `<span style="color:var(--danger)">➖ Retirés :</span> ${articlesSupprimés.map(a=>'<strong>'+esc(a.nom)+'</strong>').join(', ')}<br>`;
      if(articlesQteChange.length) lignes += `<span style="color:var(--accent)">🔄 Qté modifiée :</span> ${articlesQteChange.map(a=>{const o=_mcArticlesInitial.find(x=>x.artId===a.artId);return'<strong>'+esc(a.nom)+'</strong> : '+o.qty+' → '+a.qty;}).join(', ')}<br>`;
      lignes += `<br><span style="color:var(--muted);font-size:11px;">Ancien : ${esc(ancienContratLabel)} — ${fmt(ancienMontant)}<br>Nouveau : ${esc(ct)} — ${fmt(mt)}</span>`;
      if(noteMotif) lignes += `<br><span style="color:var(--subtle);font-size:11px;">Motif : ${esc(noteMotif)}</span>`;
      // Afficher dans un modal d'info rapide ou dans une notification enrichie
      const overlay = document.createElement('div');
      overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:12000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
      overlay.innerHTML=`<div style="background:var(--surface);border:1px solid rgba(201,168,76,0.4);border-radius:16px;padding:28px 30px;max-width:420px;width:94vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="margin-bottom:14px;line-height:1.8;">${lignes}</div>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:9px;background:rgba(201,168,76,0.14);border:1px solid rgba(201,168,76,0.35);border-radius:8px;color:var(--accent);font-weight:700;font-size:13px;cursor:pointer;font-family:'Outfit',sans-serif;">✓ Compris</button>
      </div>`;
      document.body.appendChild(overlay);
    }, 400);
  }
};

window.supprimerClient = async function(cid){
  const c=getCl(cid);
  if(!(await confirmDialog(`Supprimer définitivement le client "${esc(c.nom)}" ?\n\nTous ses paiements et historique seront conservés mais le client sera retiré de la liste.`,{title:'🗑 Suppression client',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('clients',cid);
  notify(`Client ${esc(c.nom)} supprimé`);
};

// ── Suppression d'un frais d'adhésion (réservé admin — règles Firestore) ──
window.supprimerAdhesionPay = async function(id, clientId){
  if(!session || session.role!=='admin'){ notify("Action réservée à l'administrateur", 'err'); return; }
  const a = DB.adhesionPays.find(x=>x._id===id);
  if(!a){ notify('Paiement introuvable', 'err'); return; }
  if(!(await confirmDialog(`Supprimer définitivement ce frais d'adhésion de ${fmt(a.montant)} du ${a.date} ?`,{title:"🗑 Suppression frais d'adhésion",okLabel:'Supprimer',danger:true}))) return;
  try{
    await fbDelete('adhesionPays', id);
    // Si le client n'a plus aucun paiement d'adhésion, on remet son statut à "non payé"
    const resteAdh = DB.adhesionPays.filter(x=>x.clientId===clientId);
    if(resteAdh.length===0){
      const c = DB.clients.find(x=>x._id===clientId);
      if(c) await fbUpdate('clients', clientId, {adhesionStatut:'non_paye'});
    }
    notify("Frais d'adhésion supprimé");
    const ficheOpen = document.getElementById('m-fiche-client')?.classList.contains('open');
    const detailOpen = document.getElementById('m-detail')?.classList.contains('open');
    if(ficheOpen && typeof ouvrirFicheClient==='function' && clientId) ouvrirFicheClient(clientId);
    if(detailOpen && typeof openDet==='function' && clientId) openDet(clientId);
    if(typeof renderControle==='function') renderControle();
  }catch(e){
    console.error('Échec suppression adhésion:', e);
    notify("Échec de la suppression — vérifiez votre connexion.", 'err');
  }
};

// ========= HELPERS =========
function fmt(n){ return Number(n||0).toLocaleString('fr-FR')+' FCFA'; }

// ── Badge "correction admin" — jamais caché, toujours visible partout où
// le paiement/l'adhésion apparaît (fiche du jour, registre, historique).
// Affiche la date réelle de saisie, l'auteur et le motif au survol.
function badgeCorrection(p){
  if(!p || !p.estCorrection) return '';
  const auteur = p.saisiParNom || 'admin';
  const dateReelle = p.dateSaisieReelle || '';
  const motif = (p.motifCorrection || '').replace(/"/g,'&quot;');
  const titre = `Correction saisie le ${dateReelle} par ${auteur}. Motif : ${motif}`;
  return `<span title="${titre}" style="display:inline-flex;align-items:center;gap:3px;margin-left:5px;background:rgba(224,92,82,0.12);border:1px solid rgba(247,97,79,0.4);border-radius:10px;padding:1px 7px;font-size:9px;font-weight:700;color:var(--danger);white-space:nowrap;">🔧 Correction</span>`;
}

// ─── Debounce générique pour les champs de recherche/filtre ───
// Évite de re-render toute la liste à CHAQUE frappe clavier : on attend
// que l'utilisateur arrête de taper (120ms) avant de lancer le rendu.
// ✅ FIX RÉACTIVITÉ : délai réduit (250ms → 120ms, quasi instantané) et
// exécution protégée par try/catch — avant, une erreur en cours de rendu
// s'arrêtait silencieusement (aucun message, aucun plantage visible) et
// le tableau restait figé jusqu'au rechargement ou au reclic sur le menu.
// Désormais toute erreur est signalée immédiatement via notify().
const _debounceTimers = {};
function dRender(fnName, delay){
  delay = (delay === undefined || delay === null) ? 120 : delay;
  clearTimeout(_debounceTimers[fnName]);
  _debounceTimers[fnName] = setTimeout(function(){
    safeRender(fnName);
  }, delay);
}

// ✅ Exécute une fonction de rendu (par nom ou référence) en capturant
// toute exception, pour que le filtrage/la recherche ne reste JAMAIS
// bloqué(e) silencieusement — l'erreur est reportée et loggée.
function safeRender(fnOrName){
  try {
    const fn = typeof fnOrName === 'string' ? window[fnOrName] : fnOrName;
    if (typeof fn === 'function') fn();
  } catch(e) {
    console.error('[safeRender] Erreur de rendu :', fnOrName, e);
    notify('Erreur d\'affichage — réessayez ou changez de page puis revenez : '+(e.message||String(e)), 'err');
  }
}
// ✅ PERF : getCl() est appelée 44 fois dans l'app et fait un .find() linéaire
// sur DB.clients — la plus grosse collection potentielle (jusqu'à 30 000
// clients selon les commentaires du code). Indexée en Map, invalidée via
// _dbVer.clients (ajoutée ci-dessous, déjà mise à jour par _touchVer()).
let _clIdxCache = null, _clIdxVer = -1;
function _clIndex(){
  if(_clIdxCache && _clIdxVer === _dbVer.clients) return _clIdxCache;
  const m = new Map();
  for(const c of (DB.clients||[])) m.set(c._id, c);
  _clIdxCache = m; _clIdxVer = _dbVer.clients;
  return m;
}
function getCl(id){ return _clIndex().get(id)||{nom:'—',contrat:'—'}; }
// ✅ PERF : getCom() est appelée ~30 fois dans l'app, dont une fois PAR LIGNE
// de chaque tableau client affiché. Avec un .find() linéaire sur
// DB.commerciaux à chaque appel, le coût grandit avec le nombre de
// commerciaux × le nombre de lignes affichées. On indexe une seule fois
// dans une Map, invalidée automatiquement via _dbVer.commerciaux (déjà mis
// à jour par _touchVer() sur tout ajout/modif/suppression/snapshot de la
// collection 'commerciaux').
let _comIdxCache = null, _comIdxVer = -1;
function _comIndex(){
  if(_comIdxCache && _comIdxVer === _dbVer.commerciaux) return _comIdxCache;
  const m = new Map();
  for(const c of (DB.commerciaux||[])) m.set(c._id, c);
  _comIdxCache = m; _comIdxVer = _dbVer.commerciaux;
  return m;
}
function getCom(id){ return _comIndex().get(id)||{nom:'—'}; }

// ✅ PERF : index combiné produits+articles, pour remplacer le motif
// `DB.produits.find(x=>x._id===id)||DB.articles.find(x=>x._id===id)` répété
// dans les boucles de rendu des contrats clients (une recherche linéaire
// double PAR ARTICLE de contrat PAR CLIENT affiché). Invalidé via
// _dbVer.produits/_dbVer.articles (déjà mis à jour par _touchVer()).
// (clés déjà déclarées dans _dbVer ci-dessus)
let _prodArtIdxCache = null, _prodArtIdxVerP = -1, _prodArtIdxVerA = -1;
function _prodArtIndex(){
  if(_prodArtIdxCache && _prodArtIdxVerP===_dbVer.produits && _prodArtIdxVerA===_dbVer.articles) return _prodArtIdxCache;
  const m = new Map();
  for(const x of (DB.produits||[])) if(!m.has(x._id)) m.set(x._id, x);
  for(const x of (DB.articles||[])) if(!m.has(x._id)) m.set(x._id, x);
  _prodArtIdxCache = m; _prodArtIdxVerP = _dbVer.produits; _prodArtIdxVerA = _dbVer.articles;
  return m;
}
function getProdOuArticle(id){ return _prodArtIndex().get(id); }
function getArt(id){ return DB.articles.find(a=>a._id===id)||{nom:'—',unite:'pcs'}; }
function getProd(id){ return (DB.produits||[]).find(p=>p._id===id)||{nom:'—',prix:0,composition:[]}; }

// ── AGENCES ──
function getAgence(id){ return DB.agences.find(a=>a._id===id)||{nom:'—'}; }
// Retourne l'agenceId de la session courante (null pour admin)
function sessionAgenceId(){
  if(!session || session.role===ROLES.ADMIN) return null;
  const u = DB.commerciaux.find(c=>c._id===session.userId);
  return u ? u.agenceId : null;
}
// Filtre un tableau de commerciaux par agence de session
function comsDansAgence(){
  const aid = sessionAgenceId();
  if(!aid) return DB.commerciaux; // admin voit tout
  return DB.commerciaux.filter(c=>c.agenceId===aid);
}
// Filtre les clients visibles par la session
function clientsDansAgence(){
  const aid = sessionAgenceId();
  if(!aid) return DB.clients; // admin voit tout
  const comIds = new Set(comsDansAgence().map(c=>c._id));
  return DB.clients.filter(c=>comIds.has(c.commercialId));
}
// Filtre les paiements visibles par la session
function paiementsDansAgence(){
  const aid = sessionAgenceId();
  if(!aid) return DB.paiements;
  const comIds = new Set(comsDansAgence().map(c=>c._id));
  return DB.paiements.filter(p=>comIds.has(p.commercialId));
}
// Filtre les livraisons visibles par la session
function livraisonsDansAgence(){
  const aid = sessionAgenceId();
  if(!aid) return DB.livraisons;
  const clIds = new Set(clientsDansAgence().map(c=>c._id));
  return DB.livraisons.filter(l=>clIds.has(l.clientId));
}
function jm(cl){ if(cl.cotisationJourFixe>0) return cl.cotisationJourFixe; return cl.montantTotal?Math.ceil(cl.montantTotal/cl.duree):0; }

// Calcule le cumul des livraisons (articles livrés) à déduire du solde client
// ── PERF : index mémorisés clientId → [enregistrements] ──
// Évite de refaire un .filter() sur TOUTE la collection paiements/livraisons
// pour CHAQUE client (coût O(clients × paiements) sur la page "Tous les clients").
// L'index est reconstruit uniquement quand _dbVer change (cf. _touchVer ci-dessus).
let _payIdxCache = null, _payIdxVer = -1;
function _payIndex(){
  if(_payIdxCache && _payIdxVer === _dbVer.paiements) return _payIdxCache;
  const m = new Map();
  for(const p of DB.paiements){
    if(!m.has(p.clientId)) m.set(p.clientId, []);
    m.get(p.clientId).push(p);
  }
  _payIdxCache = m; _payIdxVer = _dbVer.paiements;
  return m;
}
let _livIdxCache = null, _livIdxVer = -1;
function _livIndex(){
  if(_livIdxCache && _livIdxVer === _dbVer.livraisons) return _livIdxCache;
  const m = new Map();
  for(const l of DB.livraisons){
    if(!m.has(l.clientId)) m.set(l.clientId, []);
    m.get(l.clientId).push(l);
  }
  _livIdxCache = m; _livIdxVer = _dbVer.livraisons;
  return m;
}

function cumulLivraisons(clientId){
  const arr = _livIndex().get(clientId) || [];
  return arr.filter(l=>l.statut!=='annule').reduce((a,l)=>a+(Number(l.montant)||0),0);
}

// Solde disponible du client = total payé - cumul livraisons reçues
function soldeClient(cl){
  const pays = _payIndex().get(cl._id) || [];
  const totalPaye = pays.reduce((a,p)=>a+p.montant,0);
  const totalLiv   = cumulLivraisons(cl._id);
  return totalPaye - totalLiv;
}

// ── PERF : cache mémoïsé de stats() par client ──────────────────────────
// stats(cl) est appelée plusieurs fois pour le MÊME client dans une seule
// passe (une fois pour le tri retard-desc/cotis-desc, une ou plusieurs fois
// pour l'affichage de la ligne), sur des listes pouvant compter des
// milliers de clients. Le calcul lui-même est déjà bon marché (grâce aux
// index _payIndex()/_livIndex()), mais le refaire 2-3x par client par
// rendu reste un gaspillage évitable. On mémoïse le résultat par client,
// invalidé automatiquement si : la référence de l'objet client change
// (mise à jour de ses champs), les paiements/livraisons ont changé
// (_dbVer), ou si TODAY a changé (changement de jour).
const _statsCache = new Map(); // clientId -> {obj, verP, verL, today, result}
function stats(cl){
  const cached = _statsCache.get(cl._id);
  if (cached && cached.obj === cl && cached.verP === _dbVer.paiements &&
      cached.verL === _dbVer.livraisons && cached.today === TODAY) {
    return cached.result;
  }
  const m = jm(cl);
  const start = new Date(cl.debut), end = new Date(TODAY);
  const joursEcoules = Math.max(0, Math.floor((end-start)/86400000)+1);
  const pays = _payIndex().get(cl._id) || [];
  const totalPaye = pays.reduce((a,p)=>a+p.montant,0);
  const totalLivraisons = cumulLivraisons(cl._id);
  const soldeNet = totalPaye - totalLivraisons;
  const joursCouv = m>0?Math.floor(totalPaye/m):0;
  const pct = cl.montantTotal?Math.min(100,Math.round((totalPaye/cl.montantTotal)*100)):0;
  const joursRetard = Math.max(0,joursEcoules-joursCouv);
  const totalRestant = Math.max(0,cl.montantTotal-totalPaye);
  const paidToday = pays.some(p=>p.date===TODAY);
  const result = {m,joursEcoules,joursCouv,joursRestants:Math.max(0,cl.duree-joursCouv),joursRetard,totalPaye,totalLivraisons,soldeNet,totalRestant,pct,paidToday,pays};
  _statsCache.set(cl._id, {obj:cl, verP:_dbVer.paiements, verL:_dbVer.livraisons, today:TODAY, result});
  return result;
}

function sb(t,c){ return `<span class="sb ${c}">${t}</span>`; }
function ratio(montant,cotis){ const r=cotis>0?(montant/cotis):1; const col=r>=2?'var(--accent3)':r>=1?'var(--accent2)':'var(--muted)'; return`<span style="font-size:11px;color:${col}">${Math.round(r*10)/10}x</span>`; }
function joursEnJM(jours){ if(!jours||jours<=0) return "0/1"; const mois=Math.floor((jours-1)/31)+1; const jour=((jours-1)%31)+1; return jour+"/"+mois; }
function stockStatut(a){ if(a.stock<=0)return sb('Rupture','sr'); if(a.stock<=a.stockMin)return sb('Stock bas','sy'); return sb('OK','sg'); }
function livStatut(s){ if(s==='livre')return sb('Livré','sg'); if(s==='annule')return sb('Annulé','sr'); return sb('En attente','sy'); }
function setSyncStatus(ok){
  const el = document.getElementById('sync-status');
  if (el) el.innerHTML=`<div class="sync-dot" style="background:${ok?'var(--accent2)':'var(--accent3)'}"></div><span style="color:${ok?'var(--accent2)':'var(--accent3)'}">${ok?'Synchronisé':'Synchronisation...'}</span>`;
  // Duplique l'état dans le badge topbar mobile (sidebar caché en ≤900px)
  const elM = document.getElementById('sync-status-mobile');
  const txtM = document.getElementById('sync-status-mobile-txt');
  if (elM && txtM) {
    elM.style.color = ok ? 'var(--accent2)' : 'var(--accent3)';
    txtM.textContent = ok ? 'Synchronisé' : 'Synchronisation...';
  }
}

// ========= SÉCURITÉ : échappement HTML anti-XSS =========
// ✅ PERF : une seule passe sur la chaîne (regex combinée + table de
// correspondance) au lieu de 5 .replace() séquentiels qui reparcourent
// la chaîne à chaque fois. esc() est appelée un très grand nombre de fois
// par rendu (chaque champ texte de chaque ligne client/produit/paiement),
// donc réduire son coût unitaire compte sur les grandes listes.
const _ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const _ESC_RE = /[&<>"']/g;
function esc(s){
  if(s == null) return '';
  return String(s).replace(_ESC_RE, c => _ESC_MAP[c]);
}
window.esc = esc;

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: AUTH                                                 ║
// ║  Extraction: node extract-modules.js → js/auth.js            ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= LOGIN =========
function showLogin(){
  fillLogin();
  document.getElementById('login-screen').classList.remove('hidden');
}

function fillLogin(){
  // Réinitialise les champs de connexion
  const u = document.getElementById('login-user');
  if(u) u.value = '';
}

// ── POINT 4 CORRIGÉ : verrou anti-brute-force DOUBLE couche ──
// Couche 1 : localStorage (client) — rapide, bloque immédiatement
// Couche 2 : Firestore 'loginAttempts' (serveur) — résiste au changement
//            de navigateur, d'appareil, ou au vidage du cache
const _LGA_PALIERS = [60000, 300000, 1800000, 7200000]; // 1min,5min,30min,2h
function _lgaKey(key){ return '_lga_' + key.replace(/[^a-z0-9._-]/gi,'_'); }
function _getLoginAttempt(key){
  try{ return JSON.parse(localStorage.getItem(_lgaKey(key)) || '{"count":0,"until":0,"cycles":0}'); }
  catch(e){ return {count:0,until:0,cycles:0}; }
}
function _setLoginAttempt(key,val){ try{ localStorage.setItem(_lgaKey(key), JSON.stringify(val)); }catch(e){} }

// Verrou serveur Firestore — clé = email normalisé (minuscules), doit correspondre
// EXACTEMENT à request.auth.token.email.lower() côté règles pour permettre le reset sécurisé.
function _lgsKey(email){ return String(email).trim().toLowerCase().slice(0,150); }

async function _checkServerLock(email) {
  if (!db_fs) return null; // mode local : pas de verrou serveur
  try {
    const snap = await getDoc(doc(db_fs, 'loginAttempts', _lgsKey(email)));
    if (!snap.exists()) return null;
    return snap.data();
  } catch(e) { return null; }
}

async function _incServerLock(email) {
  if (!db_fs) return;
  try {
    const key = _lgsKey(email);
    const ref = doc(db_fs, 'loginAttempts', key);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { count: 1, windowStart: serverTimestamp() });
    } else {
      const d = snap.data();
      const windowMs = 60 * 1000;
      const windowStart = d.windowStart?.toDate ? d.windowStart.toDate() : new Date(d.windowStart);
      if (Date.now() - windowStart.getTime() > windowMs) {
        await setDoc(ref, { count: 1, windowStart: serverTimestamp() });
      } else {
        await updateDoc(ref, { count: (d.count||0) + 1 });
      }
    }
  } catch(e) { /* non bloquant */ }
}

async function _resetServerLock(email) {
  if (!db_fs) return;
  try {
    await setDoc(doc(db_fs, 'loginAttempts', _lgsKey(email)), { count: 0, windowStart: serverTimestamp() });
  } catch(e) {}
}
window.doLogin = async function(){
  const raw = (document.getElementById('login-user').value || '').trim().toLowerCase();
  const pinRaw = document.getElementById('login-pin').value;
  const errEl = document.getElementById('login-err');

  if (!raw || !pinRaw) {
    errEl.textContent = 'Veuillez saisir votre email et mot de passe.';
    errEl.style.display = 'block';
    return;
  }

  // ── Couche 1 : verrou localStorage (immédiat) ──
  const now = Date.now();
  const att = _getLoginAttempt(raw);
  if(att.until > now){
    const resteS = Math.ceil((att.until - now) / 1000);
    const msg = resteS > 90 ? `réessayez dans ${Math.ceil(resteS/60)} min` : `réessayez dans ${resteS} s`;
    errEl.textContent = `Trop de tentatives — ${msg}`;
    errEl.style.display = 'block';
    return;
  }

  // ── Couche 2 : verrou serveur Firestore (résiste au changement d'appareil) ──
  const serverLock = await _checkServerLock(raw);
  if (serverLock && serverLock.count >= 5) {
    const windowStart = serverLock.windowStart?.toDate ? serverLock.windowStart.toDate() : new Date(serverLock.windowStart);
    const elapsed = Date.now() - windowStart.getTime();
    if (elapsed < 60000) {
      const resteS = Math.ceil((60000 - elapsed) / 1000);
      errEl.textContent = `Trop de tentatives (serveur) — réessayez dans ${resteS} s`;
      errEl.style.display = 'block';
      return;
    }
  }

  try {
    let emailToUse = raw;
    if (!raw.includes('@')) {
      // ✅ Les commerciaux ne sont chargés qu'après auth.
      // On tente d'abord via la liste en mémoire (si déjà chargée),
      // sinon on demande à l'utilisateur d'utiliser son email.
      const u = DB.commerciaux.find(c => c.nom.toLowerCase() === raw);
      if (u && u.email) {
        emailToUse = u.email.toLowerCase();
      } else {
        throw new Error('Veuillez utiliser votre adresse email pour vous connecter.');
      }
    }

    const userCred = await signInWithEmailAndPassword(auth, emailToUse, pinRaw);
    const firebaseUid = userCred.user.uid;

    await ensureCollectionsLoaded(['commerciaux', 'commerciauxPrive', 'agences']);
    _mergeCommerciaux();
    // ✅ FIX BASCULE DE RÔLE : on cherche UNIQUEMENT par UID Firebase (source de vérité).
    // Chercher aussi par email causait des collisions si deux documents ont le même email.
    let u = DB.commerciaux.find(c => c._id === firebaseUid);
    // Fallback email uniquement si l'UID ne correspond à aucun document (migration)
    if (!u) u = DB.commerciaux.find(c => c.email && c.email.toLowerCase() === emailToUse);
    if (!u) {
      await signOut(auth);
      throw new Error('Profil utilisateur introuvable dans la base. Contactez l\'administrateur.');
    }
    // ✅ FIX RÔLE MANQUANT : si le champ role est absent ou vide, bloquer la connexion.
    // Sans cette garde, session.role vaut undefined et l'app traite l'utilisateur
    // comme un commercial par défaut (comportement des conditions if/else).
    const _VALID_ROLES = ['admin','commercial','secretaire','gestionnaire_stock','controleur','chef_agence'];
    if (!u.role || !_VALID_ROLES.includes(u.role)) {
      await signOut(auth);
      throw new Error(`Rôle utilisateur invalide ou manquant ("${u.role || 'vide'}"). Contactez l'administrateur.`);
    }

    // Succès — réinitialiser les deux verrous
    _setLoginAttempt(raw, {count:0, until:0, cycles:0});
    await _resetServerLock(raw);
    errEl.style.display = 'none';
    session = {userId: u._id, role: u.role, nom: u.nom};
    _sessionInvalidHandled = false; // ✅ FIX : réarme le garde-fou pour la nouvelle session
    _resetSessionTimer();
    _startTokenRefresh(); // Point 5 : démarrer le rafraîchissement proactif
    _startAlertesLivraison(); // 🔔 Alertes carnet terminé / produit prêt à livrer

  } catch(e) {
    // Incrémenter les deux verrous
    att.count = (att.count || 0) + 1;
    if(att.count >= 5){
      const cycle = Math.min(att.cycles || 0, _LGA_PALIERS.length - 1);
      att.until = now + _LGA_PALIERS[cycle];
      att.cycles = (att.cycles || 0) + 1;
      att.count = 0;
    }
    _setLoginAttempt(raw, att);
    await _incServerLock(raw); // verrou serveur

    const resteMin = att.until > now ? Math.ceil((att.until - now) / 60000) : 0;
    let msg = e.message || 'Identifiant ou mot de passe incorrect.';
    if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential' || e.code === 'auth/user-not-found') {
      msg = att.until > now
        ? (resteMin <= 1 ? 'Trop de tentatives — compte bloqué 1 minute' : `Trop de tentatives — compte bloqué ${resteMin} minutes`)
        : `Email ou mot de passe incorrect (${att.count}/5)`;
    } else if (e.code === 'auth/invalid-email') {
      msg = 'Adresse email invalide.';
    } else if (e.code === 'auth/too-many-requests') {
      msg = 'Trop de tentatives — Firebase a temporairement bloqué ce compte.';
    }
    errEl.textContent = msg;
    errEl.style.display = 'block';
    return;
  }
  document.getElementById('login-screen').classList.add('hidden');
  // FIX 2 : clé AES dérivée de l'UID Firebase + secret appareil (plus du mot de passe)
  if (session.role ===ROLES.COMMERCIAL) {
    await _initLocalKey(session.userId); // UID Firebase, jamais le mot de passe
    await loadLocalDataEncrypted();
  }
  // Pré-charger les collections terrain pour le mode offline (commercial uniquement)
  if (session.role ===ROLES.COMMERCIAL && isOnline) {
    const terrainCols = ['clients','paiements','mises','adhesionPays','commerciaux','agences','primesPaliers'];
    await ensureCollectionsLoaded(terrainCols);
    await _doSaveLocalEncrypted(); // snapshot chiffré pour usage offline (immédiat, pas debouncé)
  }
  setupRealtimeListeners();
  chatInit();
  _notifBellInit();
  await _loadOfflineQueue();
  _updateOfflineBadge();
  setupUI();
  go(getRoleHome(session.role));
  buildBottomNav(session.role);
  bnGo(getRoleHome(session.role));
};

window.doLogout = function(){
  // ✅ Indispensable maintenant que les listeners sont persistants entre
  // navigations : sans ça, les listeners (filtrés sur l'ancien utilisateur)
  // resteraient actifs et seraient réutilisés à tort pour le prochain login.
  _unsubscribeAll();
  chatTeardown();
  clearInterval(_alertesLivraisonInterval); // ✅ stopper les rappels de livraison
  session = null;
  _localKey = null; // C2 — effacer la clé AES de la mémoire
  _offlineQueue = [];
  _stopSessionTimer();
  // ✅ FIX LATENCE : vider le cache localStorage à la déconnexion
  // pour qu'un autre utilisateur ne voie pas les données du précédent.
  _cacheClear();
  _loadedCols.clear();
  // Déconnexion Firebase Auth
  if (auth) { try { signOut(auth); } catch(e){} }
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-pin').value = '';
  fillLogin();
};

// ========= TIMEOUT DE SESSION (inactivité 3h) =========
const SESSION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 heures
let _sessionTimer = null;
let _sessionWarningTimer = null;
let _tokenRefreshInterval = null; // Point 5 : rafraîchissement proactif du token

function _resetSessionTimer() {
  if (!session) return;
  clearTimeout(_sessionTimer);
  clearTimeout(_sessionWarningTimer);
  _sessionWarningTimer = setTimeout(() => {
    if (session) notify('⚠️ Session inactive — déconnexion dans 2 minutes', 'warn');
  }, SESSION_TIMEOUT_MS - 2 * 60 * 1000);
  _sessionTimer = setTimeout(() => {
    if (session) {
      notify('🔒 Session expirée — veuillez vous reconnecter', 'err');
      window.doLogout();
    }
  }, SESSION_TIMEOUT_MS);
}

function _stopSessionTimer() {
  clearTimeout(_sessionTimer);
  clearTimeout(_sessionWarningTimer);
  clearInterval(_tokenRefreshInterval);
  _sessionTimer = null;
  _sessionWarningTimer = null;
  _tokenRefreshInterval = null;
}

// ── POINT 5 CORRIGÉ : révocation serveur détectée en temps réel ──
// onAuthStateChanged est déclenché par Firebase dès que le token est
// révoqué (suppression du compte, désactivation, déconnexion forcée).
// Plus besoin d'attendre l'expiration du token (1 heure).
// FIX BLOCAGE UI : cet appel était fait directement au niveau racine du
// script, donc exécuté immédiatement au chargement de la page — avant
// même que 'auth' soit initialisé par initFB(). Cela provoquait un crash
// synchrone qui interrompait tout le reste du script (ADMIN_NAV, COM_NAV,
// getRoleNav, etc. n'étaient alors jamais définis → menu invisible après
// connexion). On encapsule donc l'inscription dans une fonction, appelée
// uniquement quand 'auth' existe réellement.
let _authStateListenerRegistered = false;
function _registerAuthStateListener() {
  if (_authStateListenerRegistered || !auth) return;
  _authStateListenerRegistered = true;
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser && session) {
      // Firebase a révoqué la session côté serveur
      notify('🔒 Session révoquée — veuillez vous reconnecter', 'err');
      session = null;
      _localKey = null;
      _offlineQueue = [];
      _stopSessionTimer();
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('login-pin').value = '';
      fillLogin();
    }
  });
}
// Si 'auth' est déjà disponible à ce stade (cas rare), on s'enregistre tout
// de suite ; sinon initFB() se chargera de l'appeler après getAuth(app).
_registerAuthStateListener();

// Rafraîchissement proactif du token toutes les 50 min (token Firebase = 1h)
// Détecte aussi une révocation lors du rafraîchissement
function _startTokenRefresh() {
  clearInterval(_tokenRefreshInterval);
  _tokenRefreshInterval = setInterval(async () => {
    if (!auth?.currentUser || !session) { clearInterval(_tokenRefreshInterval); return; }
    try {
      await auth.currentUser.getIdToken(true); // force=true = appel réseau
    } catch(e) {
      // getIdToken échoue si le compte a été désactivé ou supprimé
      notify('🔒 Session expirée ou révoquée — veuillez vous reconnecter', 'err');
      window.doLogout();
    }
  }, 50 * 60 * 1000); // 50 minutes
}

// ═══════════════ 🔔 ALERTES : carnet terminé / produit prêt à livrer ═══════
// Objectif : réduire les oublis d'enregistrement de livraison.
// - Alerte A : le client a atteint la durée de son carnet (ex: 372 jours
//   couverts par ses paiements) — le carnet est terminé.
// - Alerte B : le client a déjà payé assez pour couvrir le prix d'un
//   article de son contrat, mais cet article ne lui a pas encore été
//   livré (soldeNet = payé - déjà livré >= prix de l'article).
// Tant que la livraison correspondante n'est pas enregistrée, l'alerte
// revient périodiquement (elle ne se déclenche pas qu'une seule fois) —
// c'est justement pour éviter l'oubli.
const _ALERTES_LIV_INTERVAL_MS = 20 * 60 * 1000;   // vérifie toutes les 20 min
const _ALERTES_LIV_RENOTIF_MS  = 3 * 60 * 60 * 1000; // ne re-notifie le MÊME client/produit qu'après 3h
let _alertesLivraisonInterval = null;

function _alertesLivLastNotifKey(){
  return 'gestcom_alertes_liv_' + (session ? session.userId : 'anon');
}
function _alertesLivLireCache(){
  try { return JSON.parse(localStorage.getItem(_alertesLivLastNotifKey())||'{}'); }
  catch(e){ return {}; }
}
function _alertesLivEcrireCache(cache){
  try { localStorage.setItem(_alertesLivLastNotifKey(), JSON.stringify(cache)); } catch(e){}
}

// Quantité déjà livrée d'un article donné pour un client (livraisons au
// statut réellement "livré", pas en attente/annulée — même logique que le
// filtre corrigé dans dessinerTopProduits()).
function _qtyLivreeArticle(clientId, artId){
  return (DB.livraisons||[])
    .filter(l => l.clientId===clientId && l.produitId===artId &&
      (l.statut==='livre'||l.statut==='livré'||l.statut==='livre_partiel'))
    .reduce((s,l)=>s+(Number(l.qty)||0), 0);
}

function verifierAlertesLivraison(){
  if(!session) return;
  // Un commercial ne voit que ses propres clients ; le staff voit tous les
  // clients de son périmètre (mêmes règles de visibilité que le reste de l'app).
  const clients = session.role===ROLES.COMMERCIAL
    ? clientsDansAgence().filter(c=>c.commercialId===session.userId)
    : clientsDansAgence();

  const cache = _alertesLivLireCache();
  const maintenant = Date.now();
  const alertes = []; // {client, type, titre, corps}

  for(const cl of clients){
    const s = stats(cl);

    // ── Alerte A : carnet terminé (durée atteinte, ex: 372 jours) ──
    const duree = cl.duree || 372;
    if(s.joursCouv >= duree && s.totalRestant <= 0){
      alertes.push({
        cl, type:'carnet_termine',
        titre: `📘 Carnet terminé — ${cl.nom}`,
        corps: `${cl.nom} a atteint les ${duree} jours de son carnet (entièrement payé). Vérifiez que tout a bien été livré/clôturé.`
      });
    }

    // ── Alerte B : produit déjà payé mais pas encore livré ──
    if(cl.contratArticles && cl.contratArticles.length){
      for(const a of cl.contratArticles){
        const qtyLivree = _qtyLivreeArticle(cl._id, a.artId);
        if(qtyLivree >= (a.qty||1)) continue; // déjà entièrement livré
        const prixUnitaire = Number(a.pv)||0;
        if(prixUnitaire > 0 && s.soldeNet >= prixUnitaire){
          alertes.push({
            cl, type:'produit_pret_'+a.artId,
            titre: `📦 Livraison à faire — ${cl.nom}`,
            corps: `${cl.nom} a déjà payé de quoi couvrir "${a.nom||'un produit'}" (solde dispo: ${fmt(s.soldeNet)}) — livraison pas encore enregistrée.`
          });
        }
      }
    }
  }

  // Filtrer selon le délai de re-notification (pour "revenir de temps en
  // temps" sans spammer à chaque vérification).
  const aNotifier = alertes.filter(al=>{
    const key = al.cl._id+'|'+al.type;
    const dernier = cache[key] || 0;
    return (maintenant - dernier) >= _ALERTES_LIV_RENOTIF_MS;
  });

  // Nettoyer le cache des entrées dont la condition n'est plus vraie
  // (livraison entre-temps enregistrée) pour ne pas le laisser grossir indéfiniment.
  const clesActives = new Set(alertes.map(al=>al.cl._id+'|'+al.type));
  Object.keys(cache).forEach(k=>{ if(!clesActives.has(k)) delete cache[k]; });

  if(!aNotifier.length){ _alertesLivEcrireCache(cache); return; }

  aNotifier.forEach(al=>{
    const key = al.cl._id+'|'+al.type;
    cache[key] = maintenant;
    // Onglet visible et actif → notification interne (toast) discrète.
    // Onglet caché/en arrière-plan → notification navigateur, pour ne pas
    // manquer le rappel même sans regarder l'app (même logique que le chat).
    if(document.hidden || !document.hasFocus()){
      _alerteLivNotifNavigateur(al.titre, al.corps, al.cl._id);
    } else {
      notify(`${al.titre} — ${al.corps}`, al.type==='carnet_termine' ? 'success' : '', al.cl._id);
    }
  });
  _alertesLivEcrireCache(cache);
}

function _alerteLivNotifNavigateur(titre, corps, clientId){
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  try{
    const n = new Notification(titre, {
      body: corps,
      tag: 'alerte-livraison-'+clientId, // regroupe les rappels successifs du même client
      renotify: true
    });
    n.onclick = ()=>{ window.focus(); if(typeof ouvrirFicheClient==='function') ouvrirFicheClient(clientId); n.close(); };
    setTimeout(()=>n.close(), 10000);
  }catch(e){ /* certains navigateurs mobiles n'autorisent pas new Notification() direct */ }
}

function _startAlertesLivraison(){
  clearInterval(_alertesLivraisonInterval);
  chatDemanderPermissionNotif(); // réutilise la demande de permission déjà en place pour le chat
  // Premier passage peu après la connexion (laisse le temps aux données de charger),
  // puis vérification périodique tant que la session est active.
  setTimeout(()=>{ try{ verifierAlertesLivraison(); }catch(e){ console.error('[alertes livraison]', e); } }, 15000);
  _alertesLivraisonInterval = setInterval(()=>{
    if(!session){ clearInterval(_alertesLivraisonInterval); return; }
    try{ verifierAlertesLivraison(); }catch(e){ console.error('[alertes livraison]', e); }
  }, _ALERTES_LIV_INTERVAL_MS);
}

// Réinitialiser le timer à chaque interaction utilisateur
['click','keydown','mousemove','touchstart'].forEach(evt => {
  document.addEventListener(evt, () => { if (session) _resetSessionTimer(); }, { passive: true });
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: CHAT D'ASSISTANCE (tous rôles)                       ║
// ║  Collections Firestore : chatConversations / chatMessages /   ║
// ║  chatTyping — indépendantes du moteur DB[col] générique       ║
// ║  (flux temps réel léger, non chargé en pagination complète).  ║
// ╚══════════════════════════════════════════════════════════════╝
const CHAT_ROLE_LABELS = {admin:'Administrateur',commercial:'Commercial',secretaire:'Secrétaire',
  gestionnaire_stock:'Gest. de stock',controleur:'Contrôleur',chef_agence:"Chef d'Agence",comptable:'Comptable'};

// ── Modèle : messagerie many-to-many. Un id de conversation = paire d'UID
// triée alphabétiquement : "uidA__uidB". N'importe quel rôle peut écrire à
// n'importe quel autre rôle (plus de distinction staff/non-staff).
function _chatPairId(a,b){ return [a,b].sort().join('__'); }
function _chatOtherUid(convId){
  const conv = _chatConversations.get(convId);
  if(conv?.participants) return conv.participants.find(u=>u!==session.userId) || conv.participants[0];
  const parts = String(convId).split('__');
  return parts.find(u=>u!==session.userId) || parts[0];
}

let _chatConvId = null;            // conversation actuellement ouverte dans le fil
let _chatConversations = new Map();// toutes mes conversations, convId -> data
let _chatMessages = [];            // messages de la conversation actuellement ouverte
let _chatConvListReady = false;    // évite les notifications sur le snapshot initial
let _chatMsgsReady = false;
let _chatTypingSentAt = 0;
let _chatTypingResetTimer = null;
let _chatPanelOpen = false;

function _chatHeureNow(){
  const n = new Date();
  return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}
function _chatInitiales(nom){
  if(!nom) return '?';
  const parts = String(nom).trim().split(/\s+/);
  return ((parts[0]?.[0]||'')+(parts[1]?.[0]||'')).toUpperCase() || nom[0].toUpperCase();
}

// ── Bulle déplaçable (glisser-déposer, position mémorisée) ──
let _chatDragInitDone = false;
function _chatInitDrag(){
  if(_chatDragInitDone) return;
  const bubble = document.getElementById('chat-bubble');
  if(!bubble) return;
  _chatDragInitDone = true;

  // Restaure la position sauvegardée
  try{
    const saved = JSON.parse(localStorage.getItem('chatBubblePos')||'null');
    if(saved && typeof saved.left==='number' && typeof saved.top==='number'){
      _chatApplyPos(saved.left, saved.top);
    }
  }catch(_){}

  let dragging = false, moved = false, startX=0, startY=0, startLeft=0, startTop=0;

  function onDown(ev){
    const p = ev.touches ? ev.touches[0] : ev;
    dragging = true; moved = false;
    const rect = bubble.getBoundingClientRect();
    startX = p.clientX; startY = p.clientY;
    startLeft = rect.left; startTop = rect.top;
    bubble.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, {passive:false});
    document.addEventListener('touchend', onUp);
  }
  function onMove(ev){
    if(!dragging) return;
    const p = ev.touches ? ev.touches[0] : ev;
    const dx = p.clientX - startX, dy = p.clientY - startY;
    if(Math.abs(dx)>4 || Math.abs(dy)>4) moved = true;
    if(moved && ev.cancelable) ev.preventDefault();
    let left = startLeft + dx, top = startTop + dy;
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    left = Math.max(4, Math.min(window.innerWidth - w - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - h - 4, top));
    _chatApplyPos(left, top);
  }
  function onUp(){
    if(!dragging) return;
    dragging = false;
    bubble.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    if(moved){
      const rect = bubble.getBoundingClientRect();
      try{ localStorage.setItem('chatBubblePos', JSON.stringify({left:rect.left, top:rect.top})); }catch(_){}
      // Empêche le clic (ouverture du chat) juste après un glisser
      bubble.dataset.justDragged = '1';
      setTimeout(()=>{ delete bubble.dataset.justDragged; }, 50);
    }
  }
  bubble.addEventListener('mousedown', onDown);
  bubble.addEventListener('touchstart', onDown, {passive:true});
  // Bloque l'ouverture du panneau si ce clic suit immédiatement un glisser
  bubble.addEventListener('click', (ev)=>{
    if(bubble.dataset.justDragged){ ev.stopImmediatePropagation(); ev.preventDefault(); }
  }, true);

  // Repositionne si la fenêtre est redimensionnée (évite que la bulle sorte de l'écran)
  window.addEventListener('resize', ()=>{
    const rect = bubble.getBoundingClientRect();
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, rect.left));
    const top = Math.max(4, Math.min(window.innerHeight - h - 4, rect.top));
    if(bubble.style.left) _chatApplyPos(left, top);
  });
}
function _chatApplyPos(left, top){
  const bubble = document.getElementById('chat-bubble');
  if(!bubble) return;
  bubble.style.left = left+'px';
  bubble.style.top = top+'px';
  bubble.style.right = 'auto';
  bubble.style.bottom = 'auto';
}
// Démarré une seule fois à la connexion (comme setupRealtimeListeners()).
function chatInit(){
  if(!session || !db_fs) return;
  _chatConversations.clear();
  _chatMessages = [];
  _chatConvId = null;
  _chatConvListReady = false;
  _chatMsgsReady = false;

  const bubble = document.getElementById('chat-bubble');
  if(bubble) bubble.style.display = 'flex';
  _chatInitDrag();
  chatDemanderPermissionNotif();
  ensureCollectionsLoaded(['commerciaux']).catch(()=>{});

  document.getElementById('chat-hdr-title').textContent = '💬 Messagerie';
  document.getElementById('chat-hdr-sub').textContent = 'Sélectionnez une conversation';
  const newBtn = document.getElementById('chat-hdr-new');
  if(newBtn) newBtn.style.display = 'inline-block';
  _chatSubscribeConvList();
}

async function _chatEnsureConversation(convId, otherUid){
  const other = DB.commerciaux.find(c=>c._id===otherUid) || {};
  await setDoc(doc(db_fs,'chatConversations',convId), {
    participants: [session.userId, otherUid].sort(),
    names: {[session.userId]: session.nom, [otherUid]: other.nom||'—'},
    roles: {[session.userId]: session.role, [otherUid]: other.role||''},
    updatedAt: Date.now()
  }, {merge:true});
}

// ── Liste de MES conversations (commercial/staff) OU de TOUTES les
// conversations (admin — supervision complète de la messagerie) ──
function _chatSubscribeConvList(){
  const isAdminView = session.role === ROLES.ADMIN;
  const colRef = collection(db_fs,'chatConversations');
  // ✅ Admin : aucun filtre "participants" → voit toutes les conversations
  // entre tous les utilisateurs, pas seulement les siennes.
  const q = isAdminView ? colRef : query(colRef, where('participants','array-contains',session.userId));
  const unsub = onSnapshot(q, snap => {
    let totalUnread = 0;
    snap.forEach(d => {
      const data = {...d.data(), _id:d.id};
      _chatConversations.set(d.id, data);
      if(isAdminView){
        // ✅ L'admin n'étant pas participant, il n'a pas de compteur
        // unread[uid] alimenté par les autres utilisateurs. On se base donc
        // sur un horodatage "vu par l'admin" (adminSeenAt), comparé à la
        // date du dernier message — 1 conversation avec activité non vue
        // par l'admin = +1 sur le badge.
        const dernierMsg = data.updatedAt || 0;
        const vuLe = data.adminSeenAt?.[session.userId] || 0;
        if(data.lastAuthorId && data.lastAuthorId !== session.userId && dernierMsg > vuLe){
          totalUnread++;
        }
      } else {
        // ✅ Comportement généralisé à tous les utilisateurs (aligné sur celui
        // de l'admin) : 1 point par CONVERSATION ayant des messages non lus,
        // et non plus le nombre réel de messages cumulés dans unread[uid].
        if((data.unread?.[session.userId] || 0) > 0) totalUnread++;
      }
    });
    // Suppression des conversations disparues côté serveur (rare)
    const liveIds = new Set(); snap.forEach(d=>liveIds.add(d.id));
    for(const id of [..._chatConversations.keys()]) if(!liveIds.has(id)) _chatConversations.delete(id);

    if(_chatConvListReady){
      // Notifie pour toute nouvelle conversation ou réponse reçue d'un AUTRE utilisateur,
      // sauf si c'est le message qu'on vient d'envoyer soi-même ou la conv déjà ouverte.
      // Pour l'admin : notifie pour TOUTE conversation entre TOUS les
      // utilisateurs (pas seulement celles où il participe).
      snap.docChanges().forEach(ch=>{
        if(ch.type==='modified' || ch.type==='added'){
          const d = {...ch.doc.data(), _id:ch.doc.id};
          if(d.lastAuthorId && d.lastAuthorId !== session.userId && d._id !== _chatConvId){
            const nomExp = d.names?.[d.lastAuthorId] || 'un utilisateur';
            // Pour l'admin, préciser aussi le destinataire (conversation entre 2 tiers)
            const autreNom = isAdminView
              ? (d.participants||[]).map(p=>d.names?.[p]).find(n=>n && n!==nomExp)
              : null;
            const libelle = autreNom ? `${nomExp} → ${autreNom}` : nomExp;
            playChatNotifSound();
            notify(`💬 Nouveau message de ${libelle}`);
            if(document.hidden || !document.hasFocus()){
              chatNotifNavigateur(`💬 ${libelle}`, d.lastMsg||'Nouveau message');
            }
          }
        }
      });
    }
    _chatConvListReady = true;
    _chatUpdateBadge(totalUnread);
    if(_chatPanelOpen && !_chatConvId) renderChatConvList();
    if(_chatPanelOpen && _chatConvId) renderChatConvList(); // maj discrète du badge liste en arrière-plan
  }, err => console.error('[chat] listener conversations', err));
  _activeListeners.set('chat_conv_list', unsub);
}

// ── Notifications navigateur (hors page / onglet en arrière-plan) ──
function chatDemanderPermissionNotif(){
  if(!('Notification' in window)) return;
  if(Notification.permission === 'default'){
    Notification.requestPermission().catch(()=>{});
  }
}
function chatNotifNavigateur(titre, corps){
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  try{
    const n = new Notification(titre, {
      body: corps,
      icon: '🔔', // remplacé silencieusement si non supporté ; ok de laisser tel quel
      tag: 'chat-assistance', // regroupe les notifs successives au lieu d'en empiler 10
      renotify: true
    });
    n.onclick = ()=>{ window.focus(); chatToggle(true); n.close(); };
    setTimeout(()=>n.close(), 8000);
  }catch(e){ /* certains navigateurs mobiles n'autorisent pas new Notification() direct */ }
}

// ── Son de notification pour nouveau message de chat ──
let _chatAudioCtx = null;
function playChatNotifSound(){
  try{
    if(!_chatAudioCtx) _chatAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ctx = _chatAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    // Petit "ding" à deux notes, doux et discret
    [[880,now,0.11],[1175,now+0.09,0.13]].forEach(([freq,t,dur])=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t+0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t+dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t+dur+0.02);
    });
  }catch(e){ /* audio non disponible (autoplay bloqué avant 1ère interaction) */ }
}
// Débloque l'audio dès la première interaction de l'utilisateur avec la page
// (obligatoire dans les navigateurs modernes avant de pouvoir jouer un son)
// ✅ FIX : ne pas s'arrêter au tout premier tap ({once:true}) — si ce
// premier tap arrive avant la connexion (session encore null, ex: tap sur
// le champ de connexion), la demande de permission de notification était
// perdue pour toujours (le listener était déjà consommé). On continue
// maintenant d'écouter les interactions tant que la permission n'a pas été
// explicitement accordée/refusée par le navigateur.
function _armerDemandeNotifSurGeste(){
  const onGeste = ()=>{
    if(!_chatAudioCtx){ try{ _chatAudioCtx = new (window.AudioContext||window.webkitAudioContext)(); }catch(_){} }
    if(session) chatDemanderPermissionNotif();
    // Une fois la permission réellement tranchée (accordée ou refusée) par
    // le navigateur, plus besoin d'écouter — sinon on continue d'essayer
    // au prochain geste (utile si le 1er tap a eu lieu avant la connexion).
    if(!('Notification' in window) || Notification.permission !== 'default'){
      ['click','keydown','touchstart'].forEach(evt=>document.removeEventListener(evt, onGeste));
    }
  };
  ['click','keydown','touchstart'].forEach(evt=>{
    document.addEventListener(evt, onGeste, {passive:true});
  });
}
_armerDemandeNotifSurGeste();

// ── Messages d'une conversation ──
function _chatSubscribeMessages(convId){
  const old = _activeListeners.get('chat_messages'); if(old){ try{old();}catch(_){} }
  _chatMsgsReady = false;
  _chatMessages = [];
  const colRef = collection(db_fs,'chatMessages');
  const q = query(colRef, where('conversationId','==',convId));
  const unsub = onSnapshot(q, snap => {
    const msgs = [];
    snap.forEach(d=>msgs.push({...d.data(), _id:d.id}));
    msgs.sort((a,b)=>(a.tsMs||0)-(b.tsMs||0));
    _chatMessages = msgs;
    if(_chatMsgsReady){
      snap.docChanges().forEach(ch=>{
        if(ch.type==='added'){
          const m = ch.doc.data();
          if(m.authorId !== session.userId){
            playChatNotifSound();
            if(!_chatPanelOpen || _chatConvId!==convId){
              notify(`💬 Nouveau message de ${m.authorNom||'assistance'}`);
            }
            if(document.hidden || !document.hasFocus()){
              chatNotifNavigateur(`💬 ${m.authorNom||'Assistance'}`, m.texte||'Nouveau message');
            }
          }
        }
      });
    }
    _chatMsgsReady = true;
    if(_chatConvId===convId) renderChatMessages();
  }, err => console.error('[chat] listener messages', err));
  _activeListeners.set('chat_messages', unsub);
}

// ── Indicateur « en train d'écrire » ──
function _chatSubscribeTyping(convId){
  const old = _activeListeners.get('chat_typing'); if(old){ try{old();}catch(_){} }
  const otherUid = _chatOtherUid(convId);
  const ref = doc(db_fs,'chatTyping',convId);
  const unsub = onSnapshot(ref, snap => {
    if(!snap.exists()) { _chatRenderTyping(false); return; }
    const d = snap.data();
    const now = Date.now();
    const actif = d[`typing_${otherUid}`] && (now - (d[`typingAt_${otherUid}`]||0) < 6000);
    _chatRenderTyping(actif, d[`nom_${otherUid}`]);
  }, err => console.error('[chat] listener typing', err));
  _activeListeners.set('chat_typing', unsub);
}
function _chatRenderTyping(actif, nom){
  const row = document.getElementById('chat-typing-row');
  const txt = document.getElementById('chat-typing-txt');
  if(!row) return;
  if(actif){
    if(txt) txt.textContent = `${nom||'…'} en train d'écrire…`;
    row.classList.add('visible');
  } else {
    row.classList.remove('visible');
  }
}

// ── Badge (bulle flottante) ──
function _chatUpdateBadge(n){
  const badge = document.getElementById('chat-bubble-badge');
  if(badge){
    if(n>0){ badge.textContent = n>99?'99+':n; badge.classList.add('visible'); }
    else badge.classList.remove('visible');
  }
  // Cumul dans le badge de la cloche 🔔 (notifications + messages chat)
  _chatUnreadCount = n;
  if(typeof _notifBellUpdateBadge==='function') _notifBellUpdateBadge();
}

// ── Ouverture / fermeture du panneau ──
window.chatToggle = function(force){
  const panel = document.getElementById('chat-panel');
  if(!panel) return;
  _chatPanelOpen = (typeof force==='boolean') ? force : !_chatPanelOpen;
  panel.classList.toggle('open', _chatPanelOpen);
  if(_chatPanelOpen){
    if(_chatConvId) chatSelectConv(_chatConvId); else { renderChatConvList(); _chatShowView('list'); }
  }
};
function _chatShowView(view){
  const list = document.getElementById('chat-conv-list');
  const thread = document.getElementById('chat-thread');
  const picker = document.getElementById('chat-new-picker');
  const back = document.getElementById('chat-hdr-back');
  const newBtn = document.getElementById('chat-hdr-new');
  if(picker) picker.style.display = 'none';
  if(view==='list'){
    list.classList.add('visible'); thread.classList.remove('visible');
    back?.classList.remove('visible');
    if(newBtn) newBtn.style.display = 'inline-block';
    document.getElementById('chat-hdr-title').textContent = '💬 Messagerie';
    document.getElementById('chat-hdr-sub').textContent = 'Sélectionnez une conversation';
  } else if(view==='picker'){
    list.classList.remove('visible'); thread.classList.remove('visible');
    if(picker) picker.style.display = 'flex';
    back?.classList.add('visible');
    if(newBtn) newBtn.style.display = 'none';
    document.getElementById('chat-hdr-title').textContent = '✎ Nouveau message';
    document.getElementById('chat-hdr-sub').textContent = 'Choisissez un destinataire';
  } else {
    list.classList.remove('visible'); thread.classList.add('visible');
    back?.classList.add('visible'); if(newBtn) newBtn.style.display='none';
  }
}
window.chatBackToList = function(){
  _chatConvId = null;
  const old = _activeListeners.get('chat_messages'); if(old){ try{old();}catch(_){} _activeListeners.delete('chat_messages'); }
  const oldT = _activeListeners.get('chat_typing'); if(oldT){ try{oldT();}catch(_){} _activeListeners.delete('chat_typing'); }
  _chatShowView('list');
  renderChatConvList();
};

// ── Nouveau message : TOUS les rôles peuvent écrire à TOUS les rôles ──
window.chatOpenNewConvPicker = function(){
  const search = document.getElementById('chat-new-search');
  if(search) search.value = '';
  _chatShowView('picker');
  renderChatNewPicker();
};
window.renderChatNewPicker = function(){
  const el = document.getElementById('chat-new-picker-list');
  if(!el) return;
  const q = (document.getElementById('chat-new-search')||{}).value?.trim().toLowerCase() || '';
  // Tous les utilisateurs de l'app, tous rôles et toutes agences confondus, sauf soi-même.
  let users = (DB.commerciaux||[]).filter(c=>c._id !== session.userId);
  if(q) users = users.filter(c=>(c.nom||'').toLowerCase().includes(q));
  users = users.slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||''));
  if(!users.length){
    el.innerHTML = '<div class="chat-conv-empty">Aucun utilisateur trouvé</div>';
    return;
  }
  el.innerHTML = users.map(u=>`
    <div class="chat-conv-item" onclick="chatStartConvWith('${u._id}')">
      <div class="chat-conv-avatar">${esc(_chatInitiales(u.nom))}</div>
      <div class="chat-conv-info">
        <div class="chat-conv-name">${esc(u.nom||'—')} <span style="color:var(--muted);font-weight:400;">· ${esc(CHAT_ROLE_LABELS[u.role]||u.role||'')}</span></div>
      </div>
    </div>
  `).join('');
};
window.chatStartConvWith = async function(userId){
  const u = DB.commerciaux.find(c=>c._id===userId);
  if(!u){ notify('Utilisateur introuvable','err'); return; }
  const convId = _chatPairId(session.userId, userId);
  try{
    await _chatEnsureConversation(convId, userId);
    if(!_chatConversations.has(convId)){
      _chatConversations.set(convId, {
        participants:[session.userId, userId].sort(),
        names:{[session.userId]:session.nom, [userId]:u.nom},
        roles:{[session.userId]:session.role, [userId]:u.role},
        _id:convId
      });
    }
    chatSelectConv(convId);
  }catch(e){
    console.error('[chat] démarrage conversation', e);
    notify("Erreur lors de l'ouverture de la conversation","err");
  }
};

// ── Sélection d'une conversation ──
window.chatSelectConv = function(convId){
  _chatConvId = convId;
  const conv = _chatConversations.get(convId) || {};
  const isAdminObserving = session.role===ROLES.ADMIN && !(conv.participants||[]).includes(session.userId);
  if(isAdminObserving){
    // ✅ Admin en supervision : ni l'un ni l'autre des 2 participants,
    // donc afficher les 2 noms plutôt qu'un "autre" incorrect.
    const noms = (conv.participants||[]).map(p=>conv.names?.[p]||'—');
    document.getElementById('chat-hdr-title').textContent = '💬 ' + noms.join(' ↔ ');
    document.getElementById('chat-hdr-sub').textContent = 'Supervision — conversation entre 2 utilisateurs';
  } else {
    const otherUid = _chatOtherUid(convId);
    const otherNom = conv.names?.[otherUid] || 'Utilisateur';
    const otherRole = conv.roles?.[otherUid];
    document.getElementById('chat-hdr-title').textContent = '💬 ' + otherNom;
    document.getElementById('chat-hdr-sub').textContent = CHAT_ROLE_LABELS[otherRole] || otherRole || '';
  }
  _chatShowView('thread');
  const inputBar = document.querySelector('.chat-input-bar');
  if(inputBar) inputBar.style.display = isAdminObserving ? 'none' : '';
  _chatSubscribeMessages(convId);
  _chatSubscribeTyping(convId);
  _chatMarkRead();
};

async function _chatMarkRead(){
  if(!_chatConvId) return;
  try{
    if(session.role === ROLES.ADMIN){
      // ✅ L'admin n'est pas participant : on trace la date de dernière
      // consultation par l'admin séparément (adminSeenAt), pour calculer
      // le badge/notifications de supervision (voir _chatSubscribeConvList).
      await setDoc(doc(db_fs,'chatConversations',_chatConvId), {adminSeenAt:{[session.userId]:Date.now()}}, {merge:true});
    } else {
      await setDoc(doc(db_fs,'chatConversations',_chatConvId), {unread:{[session.userId]:0}}, {merge:true});
    }
  }catch(e){ console.error('[chat] marquage lu', e); }
}

// ── Rendu ──
function renderChatConvList(){
  const el = document.getElementById('chat-conv-list');
  if(!el) return;
  const isAdminView = session.role === ROLES.ADMIN;
  const convs = [..._chatConversations.values()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  if(!convs.length){
    el.innerHTML = '<div class="chat-conv-empty">Aucune conversation pour le moment — cliquez sur ✎ pour écrire à quelqu\'un</div>';
    return;
  }
  el.innerHTML = convs.map(c=>{
    let nom, role, unread;
    if(isAdminView && !(c.participants||[]).includes(session.userId)){
      // ✅ Vue supervision admin : afficher les 2 interlocuteurs (l'admin
      // n'est ni l'un ni l'autre), et calculer le badge via adminSeenAt.
      const noms = (c.participants||[]).map(p=>c.names?.[p]||'—');
      nom = noms.join(' ↔ ');
      role = '';
      const dernierMsg = c.updatedAt || 0;
      const vuLe = c.adminSeenAt?.[session.userId] || 0;
      unread = (c.lastAuthorId && c.lastAuthorId!==session.userId && dernierMsg>vuLe) ? 1 : 0;
    } else {
      const otherUid = c.participants?.find(p=>p!==session.userId) || _chatOtherUid(c._id);
      nom = c.names?.[otherUid] || '—';
      role = c.roles?.[otherUid] || '';
      unread = c.unread?.[session.userId] || 0;
    }
    return `
    <div class="chat-conv-item" onclick="chatSelectConv('${c._id}')">
      <div class="chat-conv-avatar">${esc(_chatInitiales(nom))}</div>
      <div class="chat-conv-info">
        <div class="chat-conv-name">${esc(nom)}${role?` <span style="color:var(--muted);font-weight:400;">· ${esc(CHAT_ROLE_LABELS[role]||role)}</span>`:''}</div>
        <div class="chat-conv-last">${esc(c.lastMsg||'—')}</div>
      </div>
      ${unread?`<div class="chat-conv-badge">${unread>99?'99+':unread}</div>`:''}
    </div>`;
  }).join('');
}

function renderChatMessages(){
  const el = document.getElementById('chat-messages');
  if(!el) return;
  if(!_chatMessages.length){
    el.innerHTML = '<div class="chat-msg-empty">Aucun message pour l\'instant — envoyez votre question ci-dessous</div>';
    return;
  }
  el.innerHTML = _chatMessages.map(m=>{
    const mine = m.authorId === session.userId;
    const peutSupprimer = mine || session.role ===ROLES.ADMIN;
    const delBtn = peutSupprimer
      ? `<button class="chat-msg-del" title="Supprimer" onclick="chatSupprimerMessage('${m._id}', ${m.storagePath?`'${esc(m.storagePath)}'`:'null'})">✕</button>`
      : '';
    const contenu = m.type === 'image'
      ? `<img src="${esc(m.imageUrl)}" class="chat-msg-img" onclick="window.open('${esc(m.imageUrl)}','_blank')" alt="Image envoyée">`
      : esc(m.texte||'');
    return `<div class="chat-msg ${mine?'chat-msg-mine':'chat-msg-theirs'}">
      ${delBtn}
      ${!mine?`<div class="chat-msg-author">${esc(m.authorNom||'—')}</div>`:''}
      ${contenu}
      <div class="chat-msg-meta">${esc(m.date||'')} ${esc(m.heure||'')}</div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight + 200;
}

// ── Saisie / indicateur de frappe ──
window.chatOnInput = function(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
  if(!_chatConvId) return;
  const now = Date.now();
  if(now - _chatTypingSentAt > 1500){
    _chatTypingSentAt = now;
    setDoc(doc(db_fs,'chatTyping',_chatConvId), {
      [`typing_${session.userId}`]: true,
      [`typingAt_${session.userId}`]: now,
      [`nom_${session.userId}`]: session.nom
    }, {merge:true}).catch(()=>{});
  }
  clearTimeout(_chatTypingResetTimer);
  _chatTypingResetTimer = setTimeout(()=>{
    if(!_chatConvId) return;
    setDoc(doc(db_fs,'chatTyping',_chatConvId), {[`typing_${session.userId}`]:false}, {merge:true}).catch(()=>{});
  }, 3000);
};
window.chatOnKeydown = function(ev){
  if(ev.key==='Enter' && !ev.shiftKey){ ev.preventDefault(); chatEnvoyer(); }
};

// ── Envoi d'un message ──
window.chatEnvoyer = async function(){
  const input = document.getElementById('chat-input');
  const texte = (input?.value||'').trim();
  if(texte.length > 4000){ notify('Message trop long (max 4000 caractères)','err'); return; }
  if(!texte) return;
  const convId = _chatConvId;
  if(!convId){ notify('Sélectionnez une conversation','err'); return; }
  const otherUid = _chatOtherUid(convId);
  const btn = document.getElementById('chat-send-btn');
  if(btn) btn.disabled = true;
  try{
    const now = Date.now();
    await _chatEnsureConversation(convId, otherUid);
    await addDoc(collection(db_fs,'chatMessages'), {
      conversationId: convId,
      type: 'texte',
      authorId: session.userId,
      authorNom: session.nom,
      authorRole: session.role,
      texte,
      tsMs: now,
      date: TODAY,
      heure: _chatHeureNow(),
      _ts: serverTimestamp()
    });
    const conv = _chatConversations.get(convId) || {};
    const otherUnread = (conv.unread?.[otherUid] || 0) + 1;
    await setDoc(doc(db_fs,'chatConversations',convId), {
      lastMsg: texte.slice(0,120),
      lastAuthorId: session.userId,
      lastAuthorRole: session.role,
      updatedAt: now,
      unread: {[otherUid]: otherUnread, [session.userId]: 0}
    }, {merge:true});

    // Fin immédiate de l'indicateur de frappe
    setDoc(doc(db_fs,'chatTyping',convId), {[`typing_${session.userId}`]:false}, {merge:true}).catch(()=>{});

    if(input){ input.value=''; input.style.height='auto'; }
  } catch(e){
    console.error('[chat] envoi message', e);
    notify("Erreur lors de l'envoi du message","err");
  } finally {
    if(btn) btn.disabled = false;
  }
};

// ── Envoi d'une image ──
window.chatEnvoyerImage = async function(file){
  const imgInput = document.getElementById('chat-img-input');
  if(!file) return;
  if(!_chatConvId){ notify('Sélectionnez une conversation','err'); if(imgInput) imgInput.value=''; return; }
  if(!file.type?.startsWith('image/')){ notify('Seules les images sont acceptées','err'); if(imgInput) imgInput.value=''; return; }
  const MAX = 8 * 1024 * 1024; // 8 Mo, doit correspondre à la règle Storage
  if(file.size > MAX){ notify('Image trop lourde (8 Mo max)','err'); if(imgInput) imgInput.value=''; return; }
  if(!storage){ notify('Firebase Storage non initialisé','err'); return; }

  const convId = _chatConvId;
  const otherUid = _chatOtherUid(convId);
  const btn = document.getElementById('chat-attach-btn');
  if(btn) btn.disabled = true;
  try{
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
    const path = `chatImages/${convId}/${Date.now()}_${session.userId}.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file, { contentType: file.type });
    const url = await getDownloadURL(fileRef);

    const now = Date.now();
    await _chatEnsureConversation(convId, otherUid);
    await addDoc(collection(db_fs,'chatMessages'), {
      conversationId: convId,
      type: 'image',
      imageUrl: url,
      storagePath: path,
      authorId: session.userId,
      authorNom: session.nom,
      authorRole: session.role,
      texte: '',
      tsMs: now,
      date: TODAY,
      heure: _chatHeureNow(),
      _ts: serverTimestamp()
    });
    const conv = _chatConversations.get(convId) || {};
    const otherUnread = (conv.unread?.[otherUid] || 0) + 1;
    await setDoc(doc(db_fs,'chatConversations',convId), {
      lastMsg: '📷 Photo',
      lastAuthorId: session.userId,
      lastAuthorRole: session.role,
      updatedAt: now,
      unread: {[otherUid]: otherUnread, [session.userId]: 0}
    }, {merge:true});
  }catch(e){
    console.error('[chat] envoi image', e);
    notify("Erreur lors de l'envoi de l'image","err");
  }finally{
    if(btn) btn.disabled = false;
    if(imgInput) imgInput.value = '';
  }
};

// ── Suppression d'un message (par son auteur, ou par un admin) ──
window.chatSupprimerMessage = async function(msgId, storagePath){
  if(!confirm('Supprimer ce message ?')) return;
  try{
    await deleteDoc(doc(db_fs,'chatMessages',msgId));
    if(storagePath){
      try{ await deleteObject(storageRef(storage, storagePath)); }
      catch(e){ /* non bloquant : l'image peut déjà avoir été supprimée */ }
    }
  }catch(e){
    console.error('[chat] suppression message', e);
    notify("Impossible de supprimer ce message","err");
  }
};

function chatTeardown(){
  ['chat_conv_list','chat_messages','chat_typing','chat_own_conv'].forEach(k=>{
    const u = _activeListeners.get(k); if(u){ try{u();}catch(_){} _activeListeners.delete(k); }
  });
  _chatConversations.clear();
  _chatMessages = [];
  _chatConvId = null;
  _chatPanelOpen = false;
  const panel = document.getElementById('chat-panel'); if(panel) panel.classList.remove('open');
  const bubble = document.getElementById('chat-bubble'); if(bubble) bubble.style.display = 'none';
  _chatUpdateBadge(0);
  const bell = document.getElementById('notif-bell'); if(bell) bell.style.display = 'none';
  const notifPanel = document.getElementById('notif-panel'); if(notifPanel) notifPanel.classList.remove('open');
  _notifBellPanelOpen = false;
}
// ╚══════════════════════════════════════════════════════════════╝

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: NAV                                                  ║
// ║  Extraction: node extract-modules.js → js/nav.js             ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= NAV =========
const ADMIN_NAV=`<div class="nav-sec">Principal</div>
<div class="nav-item" id="nav-admin-dashboard" onclick="go('admin-dashboard')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Tableau de bord</div>
<div class="nav-item" id="nav-registre" onclick="go('registre')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Registre par date</div>
<div class="nav-item" id="nav-historique" onclick="go('historique')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Historique</div>
<div class="nav-item" id="nav-historique-recus" onclick="go('historique-recus')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>Historique des reçus</div>
<div class="nav-sec">Gestion</div>
<div class="nav-item" id="nav-tous-clients" onclick="go('tous-clients')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>Clients</div>
<div class="nav-item" id="nav-controle" onclick="go('controle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>Contrôle</div>
<div class="nav-item" id="nav-livraisons" onclick="go('livraisons')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Livraisons</div>
<div class="nav-item" id="nav-articles" onclick="go('articles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Articles</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-stock" onclick="go('stock')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Stock</div>
<div class="nav-item" id="nav-commerciaux" onclick="go('commerciaux')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>Utilisateurs</div>
<div class="nav-item" id="nav-agences" onclick="go('agences')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>Agences</div>
<div class="nav-item" id="nav-primes" onclick="ouvrirPrimes()" style="color:var(--accent);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Primes commerciaux</div>
<div class="nav-item" id="nav-saisie-mises" onclick="go('saisie-mises')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>Saisie de mises</div>
<div class="nav-item" id="nav-saisie-adhesions" onclick="go('saisie-adhesions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>Saisie des adhésions</div>
<div class="nav-item" id="nav-fiche" onclick="go('fiche')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Fiche du jour</div>
<div class="nav-item" id="nav-rapport-activite" onclick="go('rapport-activite')" style="color:var(--accent);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Rapport d'activité</div>
<div class="nav-item" id="nav-transfert-resiliation" onclick="go('transfert-resiliation')" style="color:var(--danger);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>Transfert & Résiliation</div>
<div class="nav-item" id="nav-depenses-commerciaux" onclick="go('depenses-commerciaux')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Dépenses commerciaux</div>
<div class="nav-item" id="nav-controle-depart" onclick="go('controle-depart')" style="color:var(--danger);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>Contrôle avant départ</div>`;

const CHEF_AGENCE_NAV=`<div class="nav-sec">Principal</div>
<div class="nav-item" id="nav-registre" onclick="go('registre')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Registre par date</div>
<div class="nav-item" id="nav-historique" onclick="go('historique')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Historique</div>
<div class="nav-item" id="nav-historique-recus" onclick="go('historique-recus')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>Historique des reçus</div>
<div class="nav-sec">Gestion</div>
<div class="nav-item" id="nav-tous-clients" onclick="go('tous-clients')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>Clients</div>
<div class="nav-item" id="nav-livraisons" onclick="go('livraisons')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Livraisons</div>
<div class="nav-item" id="nav-articles" onclick="go('articles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Articles</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-saisie-mises" onclick="go('saisie-mises')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>Saisie de mises</div>
<div class="nav-item" id="nav-saisie-adhesions" onclick="go('saisie-adhesions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>Saisie des adhésions</div>
<div class="nav-item" id="nav-fiche" onclick="go('fiche')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Fiche du jour</div>
<div class="nav-item" id="nav-transfert-resiliation" onclick="go('transfert-resiliation')" style="color:var(--danger);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>Transfert & Résiliation</div>
<div class="nav-item" id="nav-depenses-commerciaux" onclick="go('depenses-commerciaux')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Dépenses commerciaux</div>`;

const COM_NAV=`<div class="nav-sec">Mon espace</div>
<div class="nav-item" id="nav-com-clients" onclick="go('com-clients')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>Mes clients</div>
<div class="nav-item" id="nav-com-nouveau-client" onclick="go('com-nouveau-client')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>Nouveau client</div>
<div class="nav-item" id="nav-saisie-mises" onclick="go('saisie-mises')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>Saisie de mises</div>
<div class="nav-item" id="nav-saisie-adhesions" onclick="go('saisie-adhesions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>Saisie des adhésions</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-fiche" onclick="go('fiche')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Fiche du jour</div>`;

const SECRETAIRE_NAV=`<div class="nav-sec">Principal</div>
<div class="nav-item" id="nav-registre" onclick="go('registre')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Registre par date</div>
<div class="nav-item" id="nav-historique" onclick="go('historique')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Historique</div>
<div class="nav-item" id="nav-historique-recus" onclick="go('historique-recus')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>Historique des reçus</div>
<div class="nav-item" id="nav-fiche" onclick="go('fiche')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Fiche du jour</div>
<div class="nav-sec">Gestion</div>
<div class="nav-item" id="nav-tous-clients" onclick="go('tous-clients')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>Clients</div>
<div class="nav-item" id="nav-livraisons" onclick="go('livraisons')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Livraisons</div>
<div class="nav-item" id="nav-saisie-adhesions" onclick="go('saisie-adhesions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>Saisie des adhésions</div>
<div class="nav-item" id="nav-articles" onclick="go('articles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Articles</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-transfert-resiliation" onclick="go('transfert-resiliation')" style="color:var(--danger);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>Transfert & Résiliation</div>`;

const CONTROLEUR_NAV=`<div class="nav-sec">Consultation</div>
<div class="nav-item" id="nav-controle" onclick="go('controle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>Contrôle</div>
<div class="nav-item" id="nav-registre" onclick="go('registre')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Registre</div>
<div class="nav-item" id="nav-historique" onclick="go('historique')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Historique</div>
<div class="nav-sec">Gestion</div>
<div class="nav-item" id="nav-tous-clients" onclick="go('tous-clients')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>Clients</div>
<div class="nav-item" id="nav-livraisons" onclick="go('livraisons')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Livraisons</div>
<div class="nav-item" id="nav-articles" onclick="go('articles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Articles</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-stock" onclick="go('stock')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Stock</div>
<div class="nav-item" id="nav-commerciaux" onclick="go('commerciaux')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>Utilisateurs</div>
<div class="nav-item" id="nav-controle-depart" onclick="go('controle-depart')" style="color:var(--danger);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>Contrôle avant départ</div>`;

const GSTOCK_NAV=`<div class="nav-sec">Stock</div>
<div class="nav-item" id="nav-articles" onclick="go('articles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Articles</div>
<div class="nav-item" id="nav-produits" onclick="go('produits')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Produits</div>
<div class="nav-item" id="nav-stock" onclick="go('stock')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Stock</div>
<div class="nav-item" id="nav-livraisons" onclick="go('livraisons')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Livraisons</div>
<div class="nav-item" id="nav-gstock-periode" onclick="go('gstock-periode')" style="color:var(--warn);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="8" y2="16"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="16" y1="14" x2="16" y2="16"/></svg>Suivi de période</div>`;

function getRoleLabel(role){
  const labels={admin:'Administrateur',commercial:'Commercial',secretaire:'Secrétaire',controleur:'Contrôleur',gestionnaire_stock:'Gest. de stock',chef_agence:"Chef d'Agence"};
  return labels[role]||role;
}
function getRoleNav(role){
  if(role===ROLES.ADMIN) return ADMIN_NAV;
  if(role===ROLES.COMMERCIAL) return COM_NAV;
  if(role===ROLES.SECRETAIRE) return SECRETAIRE_NAV;
  if(role===ROLES.CONTROLEUR) return CONTROLEUR_NAV;
  if(role===ROLES.GESTIONNAIRE_STOCK) return GSTOCK_NAV;
  if(role===ROLES.CHEF_AGENCE) return CHEF_AGENCE_NAV;
  return COM_NAV;
}
function getRoleHome(role){
  if(role===ROLES.ADMIN) return 'admin-dashboard';
  if(role===ROLES.COMMERCIAL) return 'saisie-mises';
  if(role===ROLES.SECRETAIRE) return 'registre';
  if(role===ROLES.CONTROLEUR) return 'controle';
  if(role===ROLES.GESTIONNAIRE_STOCK) return 'stock';
  if(role===ROLES.CHEF_AGENCE) return 'registre';
  return 'com-clients';
}

function setupUI(){
  const u = DB.commerciaux.find(c=>c._id===session.userId);
  document.getElementById('s-av').textContent = u.nom[0];
  document.getElementById('s-nm').textContent = u.nom;
  const ag = u.agenceId ? getAgence(u.agenceId) : null;
  const agLabel = ag ? ' · 🏢 '+ag.nom : '';
  document.getElementById('s-rl').textContent = getRoleLabel(u.role)+(u.zone?' · '+u.zone:'')+agLabel;
  document.getElementById('nav-menu').innerHTML = getRoleNav(session.role);
  document.getElementById('today-pill').textContent = new Date().toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'long'});
}

const TITLES={'admin-dashboard':'Tableau de bord',registre:'Registre par date',historique:'Historique','tous-clients':'Clients',controle:'Contrôle',livraisons:'Livraisons',articles:'Articles',produits:'Produits',catalogue:'Catalogue visuel',stock:'Stock',commerciaux:'Utilisateurs',agences:'Agences',recouvrement:'Recouvrement du jour',fiche:'Fiche du jour','saisie-mises':'Saisie de mises','saisie-adhesions':'Saisie des adhésions','com-clients':'Mes clients','com-nouveau-client':'Nouveau client','rapport-activite':"Rapport d'activité",'gstock-periode':'Suivi de période','transfert-resiliation':'Transfert & Résiliation','depenses-commerciaux':'Dépenses commerciaux','historique-recus':'Historique des reçus','controle-depart':'Contrôle avant départ'};
const BTN={'tous-clients':'+ Client',articles:'+ Article',produits:'+ Produit',livraisons:'+ Livraison',stock:'+ Mouvement',commerciaux:'+ Utilisateur'};
const ACT={'tous-clients':()=>openM('m-client'),articles:()=>openM('m-article'),produits:()=>ouvrirModalProduit(),livraisons:()=>openM('m-livraison'),stock:()=>openM('m-stock-mvt'),commerciaux:()=>openM('m-com')};
let curPg='';


/* ═══════════════════════════════════
   BOTTOM NAVIGATION BAR — MOBILE
═══════════════════════════════════ */

// Configs par rôle : items principaux (bottom) + items drawer (Plus)
const BN_CONFIG = {
  admin: {
    main: [
      {id:'admin-dashboard', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>', label:'Tableau'},
      {id:'saisie-mises',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>', label:'Mises'},
      {id:'tous-clients',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>', label:'Clients'},
      {id:'registre',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>', label:'Registre'},
    ],
    drawer: [
      {id:'historique',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', label:'Historique'},
      {id:'fiche',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>', label:'Fiche du jour'},
      {id:'livraisons',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>', label:'Livraisons'},
      {id:'articles',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>', label:'Articles'},
      {id:'produits',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', label:'Produits'},
      {id:'stock',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>', label:'Stock'},
      {id:'commerciaux',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>', label:'Utilisateurs'},
      {id:'agences',      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>', label:'Agences'},
      {id:'saisie-adhesions', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>', label:'Adhésions'},
      {id:'controle-depart', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>', label:'Contrôle départ'},
      {id:'__bt_printer__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>', label:'Imprimante BT', special:'bt'},
    ]
  },
  commercial: {
    main: [
      {id:'saisie-mises',       icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>', label:'Mises'},
      {id:'com-clients',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>', label:'Clients'},
      {id:'com-nouveau-client',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>', label:'Nouveau'},
      {id:'fiche',               icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>', label:'Fiche'},
    ],
    drawer: [
      {id:'produits', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', label:'Produits'},
      {id:'saisie-adhesions', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>', label:'Adhésions'},
      {id:'__bt_printer__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>', label:'Imprimante BT', special:'bt'},
      {id:'__logout__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>', label:'Déconnexion', special:'logout'},
    ]
  },
  secretaire: {
    main: [
      {id:'registre',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>', label:'Registre'},
      {id:'historique',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', label:'Historique'},
      {id:'tous-clients', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>', label:'Clients'},
      {id:'fiche',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>', label:'Fiche'},
    ],
    drawer: [
      {id:'saisie-mises', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>', label:'Saisie mises'},
      {id:'livraisons', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>', label:'Livraisons'},
      {id:'__bt_printer__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>', label:'Imprimante BT', special:'bt'},
      {id:'__logout__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>', label:'Déconnexion', special:'logout'},
    ]
  },
  controleur: {
    main: [
      {id:'controle',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>', label:'Contrôle'},
      {id:'registre',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>', label:'Registre'},
      {id:'tous-clients', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>', label:'Clients'},
      {id:'historique',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', label:'Historique'},
    ],
    drawer: [
      {id:'livraisons',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>', label:'Livraisons'},
      {id:'articles',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>', label:'Articles'},
      {id:'produits',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', label:'Produits'},
      {id:'stock',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>', label:'Stock'},
      {id:'commerciaux',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>', label:'Utilisateurs'},
      {id:'controle-depart', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>', label:'Contrôle départ'},
      {id:'__bt_printer__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>', label:'Imprimante BT', special:'bt'},
      {id:'__logout__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>', label:'Déconnexion', special:'logout'},
    ]
  },
  'gestionnaire-stock': {
    main: [
      {id:'stock',      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>', label:'Stock'},
      {id:'articles',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>', label:'Articles'},
      {id:'livraisons', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>', label:'Livraisons'},
      {id:'produits',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', label:'Produits'},
    ],
    drawer: [
      {id:'__bt_printer__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>', label:'Imprimante BT', special:'bt'},
      {id:'__logout__', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>', label:'Déconnexion', special:'logout'},
    ]
  }
};

let _bnCurrentPage = '';

window.buildBottomNav = function(role){
  if(window.innerWidth > 900) return;
  const cfg = BN_CONFIG[role] || BN_CONFIG['controleur'];
  const nav = document.getElementById('bottom-nav');
  const hasDrawer = cfg.drawer && cfg.drawer.length > 0;

  // Items principaux
  let html = cfg.main.map(item => `
    <div class="bn-item" id="bn-${item.id}" onclick="bnGo('${item.id}')">
      ${item.icon}
      <span>${item.label}</span>
    </div>`).join('');

  // Bouton "Plus" si drawer non vide
  if(hasDrawer){
    html += `<div class="bn-item" id="bn-more" onclick="toggleBnDrawer()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>
      <span>Plus</span>
    </div>`;
    // Contenu du drawer
    const drawer = document.getElementById('bn-drawer');
    drawer.innerHTML = cfg.drawer.map(item => {
      if(item.special === 'bt'){
        const connected = window._btDevice && window._btDevice.gatt && window._btDevice.gatt.connected;
        const statusDot = connected ? '🟢' : '🔴';
        const statusTxt = connected ? 'Connectée' : 'Non connectée';
        return `
      <div class="bn-drawer-item" id="bnd-${item.id}" onclick="bnGo('${item.id}')" style="justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:14px;">
          ${item.icon}
          <span>${item.label}</span>
        </div>
        <span id="bn-bt-status" style="font-size:10px;color:var(--muted);">${statusDot} ${statusTxt}</span>
      </div>`;
      }
      if(item.special === 'logout'){
        return `
      <div class="bn-drawer-sep"></div>
      <div class="bn-drawer-item" id="bnd-${item.id}" onclick="bnGo('${item.id}')" style="color:var(--danger);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--danger);"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span style="font-weight:700;">Déconnexion</span>
      </div>`;
      }
      return `
      <div class="bn-drawer-item" id="bnd-${item.id}" onclick="bnGo('${item.id}')">
        ${item.icon}
        <span>${item.label}</span>
      </div>`;
    }).join('');
  }

  nav.innerHTML = html;
}

window.bnGo = function(id){
  closeBnDrawer();
  // Déconnexion
  if(id === '__logout__'){
    confirmDialog('Se déconnecter de votre compte ?',{title:'🚪 Déconnexion',okLabel:'Se déconnecter'}).then(ok=>{
      if(ok) window.doLogout && window.doLogout();
    });
    return;
  }
  // Action spéciale : connexion imprimante Bluetooth
  if(id === '__bt_printer__'){
    window.connecterImprimanteBT && window.connecterImprimanteBT().then(()=>{
      // Mettre à jour le statut dans le drawer après connexion
      const statusEl = document.getElementById('bn-bt-status');
      if(statusEl){
        const connected = window._btDevice && window._btDevice.gatt && window._btDevice.gatt.connected;
        statusEl.textContent = connected ? '🟢 Connectée' : '🔴 Non connectée';
        statusEl.style.color = connected ? 'var(--accent2)' : 'var(--muted)';
      }
      // Aussi mettre à jour le statut sidebar desktop
      const sidebarStatus = document.getElementById('bt-printer-status');
      if(sidebarStatus){
        const connected = window._btDevice && window._btDevice.gatt && window._btDevice.gatt.connected;
        sidebarStatus.textContent = connected ? '🟢 '+( window._btDevice.name||'Connectée') : '🔴 Non connectée';
        sidebarStatus.style.color = connected ? 'var(--accent2)' : '';
      }
    });
    return;
  }
  if(typeof window.go === 'function') window.go(id);
  // Mettre à jour l'item actif dans la bottom nav
  _bnCurrentPage = id;
  document.querySelectorAll('.bn-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.bn-drawer-item').forEach(el => el.classList.remove('active'));
  const mainEl = document.getElementById('bn-' + id);
  if(mainEl) mainEl.classList.add('active');
  const drawerEl = document.getElementById('bnd-' + id);
  if(drawerEl){
    drawerEl.classList.add('active');
    document.getElementById('bn-more')?.classList.add('active');
  }
}

window.toggleBnDrawer = function(){
  const drawer = document.getElementById('bn-drawer');
  const overlay = document.getElementById('bn-drawer-overlay');
  const isOpen = drawer.classList.contains('open');
  if(isOpen){
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    drawer.classList.add('open');
    overlay.classList.add('open');
  }
}

window.closeBnDrawer = function(){
  document.getElementById('bn-drawer')?.classList.remove('open');
  document.getElementById('bn-drawer-overlay')?.classList.remove('open');
}

window.go = async function(id){ // ✅ FIX : async pour await setupPageListeners et capturer les erreurs
  // FIX 8 : vérification de session avant navigation
  if (!session || !auth?.currentUser) {
    document.getElementById('login-screen').classList.remove('hidden');
    return;
  }
  if(window.innerWidth <= 768){
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if(sidebar) sidebar.classList.remove('open');
    if(overlay) overlay.classList.remove('visible');
    document.body.style.overflow = '';
    // Remonter en haut de la page principale
    const main = document.getElementById('main');
    if(main) main.scrollTop = 0;
  }
  // Remonter aussi sur tablette (900px)
  if(window.innerWidth <= 900){
    const main2 = document.getElementById('main');
    if(main2) main2.scrollTop = 0;
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=document.getElementById('page-'+id); if(pg) pg.classList.add('active');
  const nav=document.getElementById('nav-'+id); if(nav) nav.classList.add('active');
  document.getElementById('pg-title').textContent=TITLES[id]||id;
  const btn=document.getElementById('btn-top');
  const role = session?.role;
  // Contrôleur : lecture seule totale — aucun bouton d'action
  const isControleur = role ===ROLES.CONTROLEUR;
  // Gestionnaire de stock : peut uniquement faire les mouvements de stock
  const isGStock = role ===ROLES.GESTIONNAIRE_STOCK;
  const readOnly = ['controleur'].includes(role);
  const canLiv = ['admin','secretaire','chef_agence'].includes(role);
  // Règles d'affichage du bouton topbar :
  // - contrôleur : jamais
  // - gestionnaire_stock : seulement le bouton "+ Mouvement" sur la page stock
  // - secrétaire : pas sur articles/clients/commerciaux, oui sur livraisons et stock non (stock = admin/gstock)
  let showBtn = false;
  if(!isControleur && BTN[id]){
    if(id === 'livraisons') showBtn = canLiv;
    else if(id === 'stock') showBtn = ['admin','gestionnaire_stock'].includes(role);
    else if(id === 'articles') showBtn = ['admin','secretaire','chef_agence'].includes(role);
    else if(id === 'produits') showBtn = ['admin','gestionnaire_stock','chef_agence'].includes(role);
    else if(id === 'tous-clients') showBtn = ['admin','secretaire','chef_agence'].includes(role);
    else if(id === 'commerciaux') showBtn = role ===ROLES.ADMIN;
    else if(id === 'agences') showBtn = role ===ROLES.ADMIN;
    else showBtn = !readOnly && !isGStock;
  }
  if(showBtn){btn.textContent=BTN[id];btn.style.display='';}else btn.style.display='none';
  // ✅ FIX DOUBLE RENDER : renderPg() est appelé UNE SEULE FOIS dans setupPageListeners()
  // après que les collections sont chargées. L'appel direct ici est supprimé.
  curPg=id;
  // ✅ FIX : await pour capturer les erreurs de chargement des collections
  try { await setupPageListeners(id); }
  catch(e) { console.error('[go] Erreur setupPageListeners:', e); notify('Erreur lors du chargement de la page','err'); }
};
window.topAction = function(){ if(ACT[curPg]) ACT[curPg](); };
function renderPg(id){
  const m={'admin-dashboard':renderAdminDash,registre:renderRegistre,historique:renderHist,'tous-clients':()=>{
    // Peupler le select, puis afficher le prompt (pas tous les clients d'un coup)
    const sel=document.getElementById('filter-com');
    if(sel){
      const comsVisibles = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
      const prev=sel.value;
      sel.innerHTML=`<option value="">— Sélectionner un commercial —</option>`+comsVisibles.map(c=>`<option value="${c._id}"${c._id===prev?' selected':''}>${esc(c.nom)}</option>`).join('');
      sel.value=prev;
    }
    // Si un commercial était déjà sélectionné (ou une recherche en cours), on
    // conserve l'état précédent et on réaffiche directement le tableau au lieu
    // de revenir systématiquement à l'écran d'invite.
    const q = (document.getElementById('search-clients')?.value || '').trim();
    const hasFilter = (sel && sel.value) || q.length >= 2;
    const pr=document.getElementById('cl-prompt');
    const tw=document.getElementById('tw-clients');
    if(hasFilter){
      if(pr) pr.style.display='none';
      if(tw) tw.style.display='';
      renderTousCls();
    } else {
      if(pr) pr.style.display='flex';
      if(tw) tw.style.display='none';
      const ct=document.getElementById('search-clients-count'); if(ct) ct.textContent='';
    }
  },controle:renderControle,livraisons:renderLivraisons,articles:renderArticles,produits:renderProduits,catalogue:renderCatalogue,stock:renderStock,commerciaux:renderComs,agences:renderAgences,recouvrement:renderRec,fiche:renderFiche,'saisie-mises':renderSaisieMises,'saisie-adhesions':renderSaisieAdhesions,'com-clients':renderComClients,'com-nouveau-client':renderComNouveauClient,'transfert-resiliation':renderTransfertResiliation,'depenses-commerciaux':renderDepensesCommerciaux,'historique-recus':renderHistoriqueRecus,'controle-depart':renderControleDepart};
  if(id==='controle' && !['admin','controleur'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  if(id==='controle-depart' && !['admin','controleur'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  // ✅ FIX ERREUR SILENCIEUSE : avant, une exception dans une fonction de rendu
  // spécifique (élément DOM manquant, donnée inattendue, etc.) remontait sans
  // aucun message — la page restait affichée à moitié construite, sans que
  // l'utilisateur ni la console ne soit informés de la cause.
  try {
    if(m[id]) m[id]();
    if(id==='rapport-activite'){
      if(session?.role!=='admin'){ notify("Accès réservé à l'administrateur",'err'); go('admin-dashboard'); return; }
      renderRapportActivite();
    }
    if(id==='gstock-periode'){
      if(!['admin','gestionnaire_stock'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
      initGstockPeriode();
    }
  } catch(e) {
    console.error(`[renderPg] Erreur lors de l'affichage de la page "${id}" :`, e);
    notify(`⚠️ Erreur d'affichage de la page (${e.message||e}). Contactez l'administrateur si le problème persiste.`, 'err');
  }
}

// ========= RENDERS =========
// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: DASHBOARD                                            ║
// ║  Extraction: node extract-modules.js → js/dashboard.js       ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= GRAPHIQUES DASHBOARD =========
let chartCollecte = null, chartComs = null, chartStatuts = null, chartMensuel = null, chartProduits = null;
let dashProdMode = 'qty'; // 'qty' | 'montant'

window.setDashProdMode = function(mode, btn){
  dashProdMode = mode;
  document.querySelectorAll('.dash-prod-mode').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  dessinerTopProduits();
};
let dashPeriod = 30;
let dashAgenceFilter = ''; // '' = toutes les agences
let registreAgenceFilter = ''; // '' = toutes les agences (admin registre)

// Retourne les paiements filtrés selon l'agence du dashboard
function dashPays(){
  if(!dashAgenceFilter) return DB.paiements;
  const comIds = DB.commerciaux.filter(c=>c.agenceId===dashAgenceFilter).map(c=>c._id);
  return DB.paiements.filter(p=>comIds.includes(p.commercialId));
}
function dashClients(){
  if(!dashAgenceFilter) return DB.clients;
  const comIds = DB.commerciaux.filter(c=>c.agenceId===dashAgenceFilter).map(c=>c._id);
  return DB.clients.filter(c=>comIds.includes(c.commercialId));
}

// Listes mémorisées par le dernier rendu du tableau de bord, utilisées par
// showContratsInactifsModal() pour éviter de refiltrer au clic.
let _dashInactifsResilies = [];
let _dashInactifsTermines = [];

// Modal dynamique (pas de HTML statique à ajouter) listant nominativement
// les clients dont le contrat est résilié ou terminé, filtrés selon
// l'agence actuellement sélectionnée sur le tableau de bord.
window.showContratsInactifsModal = function(){
  const rows = [
    ..._dashInactifsResilies.map(c=>({c, label:'RÉSILIÉ', color:'var(--danger)'})),
    ..._dashInactifsTermines.map(c=>({c, label:'TERMINÉ', color:'var(--accent2)'})),
  ];
  let overlay = document.getElementById('dash-inactifs-overlay');
  if(overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'dash-inactifs-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.onclick = (e)=>{ if(e.target===overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);">
        <strong style="font-size:15px;">🚫 Contrats inactifs (${rows.length})</strong>
        <button onclick="document.getElementById('dash-inactifs-overlay').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;">✕</button>
      </div>
      <div style="overflow-y:auto;padding:8px 12px;">
        ${rows.length ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead><tr style="text-align:left;color:var(--muted);font-size:11px;">
            <th style="padding:6px 8px;">Client</th><th style="padding:6px 8px;">Commercial</th><th style="padding:6px 8px;">Statut</th>
          </tr></thead>
          <tbody>
          ${rows.map(r=>`<tr style="border-top:1px solid var(--border);">
            <td style="padding:6px 8px;font-weight:600;">${esc(r.c.nom)}</td>
            <td style="padding:6px 8px;color:var(--muted);">${esc(getCom(r.c.commercialId)?.nom||'—')}</td>
            <td style="padding:6px 8px;color:${r.color};font-weight:700;font-size:11px;">${r.label}</td>
          </tr>`).join('')}
          </tbody>
        </table>` : `<div class="emp" style="padding:30px;">Aucun contrat inactif</div>`}
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

window.setDashAgence = function(agId, btn){
  dashAgenceFilter = agId;
  document.querySelectorAll('.dash-ag-chip').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderAdminDash();
};

window.setDashPeriod = function(jours, btn){
  dashPeriod = jours;
  document.querySelectorAll('.dash-period').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  dessinerGraphiques();
};

function dessinerGraphiques(){
  dessinerCourbeCollecte(dashPeriod);
  dessinerDonutComs();
  dessinerBarresStatuts();
  dessinerBarresMensuelles();
  dessinerTopProduits();
}

function dessinerBarresMensuelles(){
  const canvas = document.getElementById('chart-mensuel');
  if(!canvas) return;
  // ✅ FIX PERFORMANCE CHARTS : chart.update() si déjà créé (évite destroy/recreate)
  const labels=[], data=[], couleurs=[];
  const now = new Date(TODAY+'T12:00:00');
  const moisNoms=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const pays = dashPays();

  for(let i=11; i>=0; i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const moisStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    const label = moisNoms[d.getMonth()]+' '+String(d.getFullYear()).slice(2);
    const total = pays.filter(p=>p.date&&p.date.startsWith(moisStr)).reduce((a,p)=>a+p.montant,0);
    labels.push(label);
    data.push(total);
    const isCurrent = moisStr === TODAY.slice(0,7);
    couleurs.push(isCurrent ? 'rgba(201,168,76,0.75)' : 'rgba(201,168,76,0.65)');
  }

  const total12 = data.reduce((a,v)=>a+v,0);
  const totalEl = document.getElementById('chart-mensuel-total');
  if(totalEl) totalEl.textContent = 'Total 12 mois : '+Number(total12).toLocaleString('fr-FR')+' FCFA';

  const borderCouleurs = couleurs.map(c=>c.replace('0.65','1').replace('0.8','1'));

  if(chartMensuel){
    chartMensuel.data.labels = labels;
    chartMensuel.data.datasets[0].data = data;
    chartMensuel.data.datasets[0].backgroundColor = couleurs;
    chartMensuel.data.datasets[0].borderColor = borderCouleurs;
    chartMensuel.update('none'); return;
  }
  chartMensuel = new Chart(canvas,{
    type:'bar',
    data:{
      labels,
      datasets:[{
        label:'Collecte mensuelle (FCFA)',
        data,
        backgroundColor: couleurs,
        borderColor: borderCouleurs,
        borderWidth:1.5,
        borderRadius:6,
        borderSkipped:false
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>' '+Number(ctx.parsed.y).toLocaleString('fr-FR')+' FCFA'}}
      },
      scales:{
        x:{ticks:{color:'#6b7499',font:{size:9.5}},grid:{display:false}},
        y:{ticks:{color:'#6b7499',font:{size:9},callback:v=>v>=1000000?(v/1000000)+'M':v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,0.05)'}}
      }
    }
  });
}

function getCouleursComs(){
  return ['var(--accent)','#22d4a0','var(--accent)','var(--danger)','var(--accent)','#38bdf8','#fb923c','#4ade80'];
}

function dessinerTopProduits(){
  const canvas = document.getElementById('chart-produits');
  if(!canvas) return;
  if(chartProduits){ chartProduits.destroy(); chartProduits=null; }

  // Filtrer les livraisons selon l'agence sélectionnée
  // ✅ FIX BUG : le `||true` rendait ce filtre inopérant (incluait TOUTES les
  // livraisons, y compris en attente/annulées, dans le calcul du top produits).
  let livs = DB.livraisons.filter(l=>l.statut==='livre'||l.statut==='livré'||l.statut==='livre_partiel');
  if(dashAgenceFilter){
    const clIds = dashClients().map(c=>c._id);
    livs = livs.filter(l=>clIds.includes(l.clientId));
  }

  // Agréger par produit
  const map = {};
  livs.forEach(l=>{
    const prod = (DB.produits||[]).find(p=>p._id===l.produitId)||{nom:'Inconnu'};
    const nom = prod.nom || l.produitId || 'Inconnu';
    if(!map[nom]) map[nom]={qty:0,montant:0};
    map[nom].qty += Number(l.qty)||0;
    map[nom].montant += Number(l.montant)||0;
  });

  // Trier selon le mode
  const sorted = Object.entries(map)
    .map(([nom,v])=>({nom,qty:v.qty,montant:v.montant}))
    .sort((a,b)=> dashProdMode==='montant' ? b.montant-a.montant : b.qty-a.qty)
    .slice(0,10);

  if(sorted.length===0){
    canvas.parentElement.querySelector('canvas').style.display='none';
    if(!canvas.parentElement.querySelector('.emp-prod')){
      const d=document.createElement('div');
      d.className='emp emp-prod';
      d.style.padding='40px 0';
      d.textContent='Aucune livraison enregistrée';
      canvas.parentElement.appendChild(d);
    }
    return;
  }
  canvas.style.display='';
  const ep=canvas.parentElement.querySelector('.emp-prod');
  if(ep) ep.remove();

  const palettes=[
    'rgba(201,168,76,0.82)','rgba(34,212,160,0.82)','rgba(247,201,79,0.82)',
    'rgba(247,97,79,0.82)','rgba(201,168,76,0.82)','rgba(56,189,248,0.82)',
    'rgba(251,146,60,0.82)','rgba(74,222,128,0.82)','rgba(232,121,249,0.82)','rgba(250,204,21,0.82)'
  ];

  const labels = sorted.map(s=>s.nom.length>20?s.nom.slice(0,18)+'…':s.nom);
  const data   = sorted.map(s=>dashProdMode==='montant'?s.montant:s.qty);
  const bgColors = sorted.map((_,i)=>palettes[i%palettes.length]);

  chartProduits = new Chart(canvas,{
    type:'line',
    data:{
      labels,
      datasets:[{
        label: dashProdMode==='montant'?'Montant (FCFA)':'Quantité livrée',
        data,
        backgroundColor: 'rgba(201,168,76,0.12)',
        borderColor: 'rgba(201,168,76,1)',
        borderWidth:2.5,
        pointBackgroundColor: bgColors,
        pointBorderColor: bgColors.map(c=>c.replace('0.82','1')),
        pointBorderWidth:2,
        pointRadius:6,
        pointHoverRadius:9,
        fill:true,
        tension:0.4
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:true,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          label:ctx=> dashProdMode==='montant'
            ? ' '+Number(ctx.parsed.y).toLocaleString('fr-FR')+' FCFA'
            : ' '+ctx.parsed.y+' unité(s)'
        }}
      },
      scales:{
        x:{
          ticks:{color:'#e8eaf2',font:{size:10,weight:'600'}},
          grid:{color:'rgba(255,255,255,0.05)'}
        },
        y:{
          ticks:{
            color:'#6b7499',font:{size:9.5},
            callback:v=> dashProdMode==='montant'
              ? (v>=1000000?(v/1000000).toFixed(1)+'M':v>=1000?(v/1000)+'k':v)
              : v
          },
          grid:{color:'rgba(255,255,255,0.05)'}
        }
      }
    }
  });
}


function dessinerCourbeCollecte(jours){
  const canvas = document.getElementById('chart-collecte');
  if(!canvas) return;
  const pays = dashPays();
  const labels=[], data=[];
  for(let i=jours-1;i>=0;i--){
    const d=new Date(TODAY+'T12:00:00');
    d.setDate(d.getDate()-i);
    const ds=d.toISOString().split('T')[0];
    const dayLabel = d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
    labels.push(dayLabel);
    data.push(pays.filter(p=>p.date===ds).reduce((a,p)=>a+p.montant,0));
  }

  // ✅ FIX PERFORMANCE CHARTS : update si déjà créé (même nombre de jours)
  if(chartCollecte && chartCollecte.data.labels.length === labels.length){
    chartCollecte.data.labels = labels;
    chartCollecte.data.datasets[0].data = data;
    chartCollecte.update('none'); return;
  }
  if(chartCollecte){ chartCollecte.destroy(); chartCollecte=null; }
  chartCollecte = new Chart(canvas, {
    type:'line',
    data:{
      labels,
      datasets:[{
        label:'Collecte (FCFA)',
        data,
        borderColor:'#22d4a0',
        backgroundColor:'rgba(34,212,160,0.08)',
        borderWidth:2,
        pointRadius:jours<=30?3:1,
        pointBackgroundColor:'#22d4a0',
        tension:0.35,
        fill:true
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>' '+Number(ctx.parsed.y).toLocaleString('fr-FR')+' FCFA'}}
      },
      scales:{
        x:{ticks:{color:'#6b7499',font:{size:9},maxTicksLimit:jours<=30?10:8},grid:{color:'rgba(255,255,255,0.04)'}},
        y:{ticks:{color:'#6b7499',font:{size:9},callback:v=>v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,0.06)'}}
      }
    }
  });
}

function dessinerDonutComs(){
  const canvas = document.getElementById('chart-coms');
  const legend = document.getElementById('chart-coms-legend');
  if(!canvas||!legend) return;
  const mois=TODAY.slice(0,7);
  const mPays=dashPays().filter(p=>p.date&&p.date.startsWith(mois));
  const coms=(dashAgenceFilter
    ? DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL&&c.agenceId===dashAgenceFilter)
    : DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL));
  const couleurs=getCouleursComs();

  const vals=coms.map(c=>mPays.filter(p=>p.commercialId===c._id).reduce((a,p)=>a+p.montant,0));
  const total=vals.reduce((a,v)=>a+v,0);
  const labels=coms.map(c=>c.nom);

  if(total===0){
    canvas.parentElement.innerHTML='<div class="emp" style="padding:30px;font-size:11px;">Aucune collecte ce mois</div>';
    legend.innerHTML='';
    if(chartComs){ chartComs.destroy(); chartComs=null; }
    return;
  }

  // ✅ FIX PERFORMANCE CHARTS : update si déjà créé
  if(chartComs){
    chartComs.data.labels = labels;
    chartComs.data.datasets[0].data = vals;
    chartComs.data.datasets[0].backgroundColor = couleurs.slice(0,coms.length);
    chartComs.update('none');
    legend.innerHTML=coms.map((c,i)=>{
      const pct=total>0?Math.round(vals[i]/total*100):0;
      return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;"><div style="width:10px;height:10px;border-radius:50%;background:${couleurs[i]};flex-shrink:0;"></div><div style="flex:1;font-size:11px;"><div class="fw6">${esc(c.nom)}</div><div style="color:var(--muted);font-size:10px;">${Number(vals[i]).toLocaleString('fr-FR')} FCFA · ${pct}%</div></div></div>`;
    }).join('');
    return;
  }
  chartComs = new Chart(canvas,{
    type:'doughnut',
    data:{labels,datasets:[{data:vals,backgroundColor:couleurs.slice(0,coms.length),borderColor:'#111520',borderWidth:2,hoverOffset:4}]},
    options:{
      responsive:true, maintainAspectRatio:true,
      cutout:'65%',
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>' '+Number(ctx.parsed).toLocaleString('fr-FR')+' FCFA'}}
      }
    }
  });

  legend.innerHTML=coms.map((c,i)=>{
    const pct=total>0?Math.round(vals[i]/total*100):0;
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <div style="width:10px;height:10px;border-radius:50%;background:${couleurs[i]};flex-shrink:0;"></div>
      <div style="flex:1;font-size:11px;"><div class="fw6">${esc(c.nom)}</div><div style="color:var(--muted);font-size:10px;">${Number(vals[i]).toLocaleString('fr-FR')} FCFA · ${pct}%</div></div>
    </div>`;
  }).join('');
}

function dessinerBarresStatuts(){
  const canvas = document.getElementById('chart-statuts');
  if(!canvas) return;
  const cls = dashClients();
  const soldes  = cls.filter(c=>stats(c).pct>=100).length;
  const retard  = cls.filter(c=>{ const s=stats(c); return s.pct<100&&s.joursRetard>0; }).length;
  const encours = cls.filter(c=>{ const s=stats(c); return s.pct<100&&s.joursRetard<=0; }).length;

  // ✅ FIX PERFORMANCE CHARTS : update si déjà créé
  if(chartStatuts){
    chartStatuts.data.datasets[0].data = [soldes,encours,retard];
    chartStatuts.update('none'); return;
  }
  chartStatuts = new Chart(canvas,{
    type:'bar',
    data:{
      labels:['Soldés','En cours','En retard'],
      datasets:[{
        data:[soldes,encours,retard],
        backgroundColor:['rgba(34,212,160,0.7)','rgba(201,168,76,0.7)','rgba(247,97,79,0.7)'],
        borderColor:['#22d4a0','var(--accent)','var(--danger)'],
        borderWidth:1.5,
        borderRadius:6
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>` ${ctx.parsed.y} client(s)`}}
      },
      scales:{
        x:{ticks:{color:'#6b7499',font:{size:10}},grid:{display:false}},
        y:{ticks:{color:'#6b7499',font:{size:9},stepSize:1},grid:{color:'rgba(255,255,255,0.06)'}}
      }
    }
  });
}

let _dashQueryToken = 0;
async function renderAdminDash(){
  // ── FIX : les totaux ("CA total recouvré", collecte du mois) ne doivent
  // plus dépendre de la collection paiements entièrement chargée en mémoire
  // (jusqu'à 1M de documents). On va chercher : le total global via une
  // agrégation serveur (1 seul nombre transféré), et le détail du mois en
  // cours via une requête à plage de dates (volume raisonnable, avec le
  // détail nécessaire pour la répartition par commercial).
  const myDashToken = ++_dashQueryToken;
  const comIdsForAgence = dashAgenceFilter
    ? DB.commerciaux.filter(c=>c.agenceId===dashAgenceFilter).map(c=>c._id)
    : null;
  // ── FIX GRAPHIQUES : dessinerBarresMensuelles (12 derniers mois) et
  // dessinerCourbeCollecte (dashPeriod derniers jours) filtraient DB.paiements
  // en mémoire, qui ne contenait par défaut que la première page (500 docs
  // arbitraires) pour admin/secrétaire — donc des graphiques faux ou vides
  // dès que la collection dépasse cette taille. On charge maintenant la
  // fenêtre de dates réellement nécessaire (12 mois glissants, ou plus si
  // dashPeriod est réglé plus large) directement depuis Firestore.
  const _joursHistorique = Math.max(366, dashPeriod);
  const _dateDebutHisto = new Date(TODAY+'T12:00:00');
  _dateDebutHisto.setDate(_dateDebutHisto.getDate() - _joursHistorique);
  const dateDebutHisto = _dateDebutHisto.toISOString().split('T')[0];

  const mois0 = TODAY.slice(0,7);
  let totalGlobalServer, moisPaysServer, tPaysServer;
  try {
    [totalGlobalServer, moisPaysServer, tPaysServer] = await Promise.all([
      _sumPaiementsMontant(comIdsForAgence),
      _fetchPaiementsDateRange(dateDebutHisto, TODAY),
      _fetchColByDate('paiements', TODAY)
    ]);
  } catch(e) {
    notify('Erreur de chargement du tableau de bord : '+(e.message||String(e)), 'err');
    return;
  }
  if (myDashToken !== _dashQueryToken) return; // filtre agence changé entre-temps

  // ── Chips de filtre agence ──
  const chipsEl = document.getElementById('dash-agence-chips');
  if(chipsEl){
    chipsEl.innerHTML =
      `<button class="dash-ag-chip${dashAgenceFilter===''?' active':''}"
        onclick="setDashAgence('',this)"
        style="padding:4px 14px;border-radius:20px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-size:11px;cursor:pointer;transition:all 0.15s;">
        🌐 Toutes les agences
       </button>` +
      DB.agences.map(ag=>`
        <button class="dash-ag-chip${dashAgenceFilter===ag._id?' active':''}"
          onclick="setDashAgence('${ag._id}',this)"
          style="padding:4px 14px;border-radius:20px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-size:11px;cursor:pointer;transition:all 0.15s;">
          🏢 ${esc(ag.nom)}
        </button>`).join('');
    // Style actif via JS car pas de <style> inline dynamique
    chipsEl.querySelectorAll('.dash-ag-chip').forEach(b=>{
      b.onmouseover=()=>{ if(!b.classList.contains('active')) b.style.borderColor='var(--accent)'; b.style.color='var(--accent)'; };
      b.onmouseout =()=>{ if(!b.classList.contains('active')){ b.style.borderColor='var(--border)'; b.style.color='var(--muted)'; } };
      if(b.classList.contains('active')){
        b.style.background='rgba(201,168,76,0.12)';
        b.style.borderColor='var(--accent)';
        b.style.color='var(--accent)';
        b.style.fontWeight='700';
      } else {
        b.style.background='var(--surface2)';
        b.style.borderColor='var(--border)';
        b.style.color='var(--muted)';
        b.style.fontWeight='400';
      }
    });
  }

  const mois=mois0;
  const clients = dashClients();
  const comIdsSet = comIdsForAgence ? new Set(comIdsForAgence) : null;
  const moisCourantPays = moisPaysServer.filter(p=>p.date && p.date.startsWith(mois));
  const mPays = comIdsSet ? moisCourantPays.filter(p=>comIdsSet.has(p.commercialId)) : moisCourantPays;
  const tPays = comIdsSet ? tPaysServer.filter(p=>comIdsSet.has(p.commercialId)) : tPaysServer;
  const totalGlobal = totalGlobalServer;
  const actifs=clients.filter(c=>stats(c).pct<100);
  const agLabel = dashAgenceFilter ? (DB.agences.find(a=>a._id===dashAgenceFilter)||{nom:'?'}).nom : 'Toutes les agences';

  // Commerciaux filtrés
  const comsFiltrés = dashAgenceFilter
    ? DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL&&c.agenceId===dashAgenceFilter)
    : DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL);
  const nbComs = comsFiltrés.length;
  const nbAgences = DB.agences.length;

  // ── Contrats inactifs (résiliés + terminés) ──
  // Résilié : statutContrat==='resilie' (transfert/résiliation manuelle).
  // Terminé : contrat non résilié mais dont la progression (stats().pct) a
  // atteint 100% — le client a fini de cotiser la totalité du montant.
  const clientsResilies = clients.filter(c=>c.statutContrat==='resilie');
  const clientsTermines = clients.filter(c=>c.statutContrat!=='resilie' && stats(c).pct>=100);
  const nbInactifs = clientsResilies.length + clientsTermines.length;

  document.getElementById('ad-kpi').innerHTML=`
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Clients actifs</div><div class="kpi-val kv-blue">${actifs.length}</div><div class="kpi-sub">${clients.length} total · <span style="color:var(--accent);font-size:10px;">${agLabel}</span></div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">CA total recouvré</div><div class="kpi-val kv-green">${fmt(totalGlobal)}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Collecté ce mois</div><div class="kpi-val kv-yellow">${fmt(mPays.reduce((a,p)=>a+p.montant,0))}</div></div>
    <div class="kpi-card kc-purple"><div class="kpi-lbl">Agences / Utilisateurs</div><div class="kpi-val kv-purple">${nbAgences} / ${nbComs}</div><div class="kpi-sub"><button class="btn btn-primary btn-xs no-print" onclick="go('agences')" style="margin-top:3px">🏢 Gérer</button></div></div>
    <div class="kpi-card kc-red" style="cursor:pointer" onclick="showContratsInactifsModal()" title="Cliquer pour voir la liste"><div class="kpi-lbl">Contrats inactifs</div><div class="kpi-val kv-red">${nbInactifs}</div><div class="kpi-sub">${clientsResilies.length} résilié(s) · ${clientsTermines.length} terminé(s)</div></div>`;

  // Mémoriser pour le modal (évite de re-filtrer au clic)
  _dashInactifsResilies = clientsResilies;
  _dashInactifsTermines = clientsTermines;

  document.getElementById('ad-coms-list').innerHTML=comsFiltrés.map(c=>{
    const myCls=clients.filter(cl=>cl.commercialId===c._id&&stats(cl).pct<100);
    const totCotis=myCls.reduce((a,cl)=>a+jm(cl),0);
    const mT=mPays.filter(p=>p.commercialId===c._id).reduce((a,p)=>a+p.montant,0);
    const ag=getAgence(c.agenceId);
    return`<tr><td class="fw6">${esc(c.nom)}<div class="tm" style="font-size:10px">${c.zone} · <span style="color:var(--accent)">${esc(ag.nom)}</span></div></td><td class="tm">${c.zone}</td><td>${myCls.length}</td><td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(totCotis)}</span></td><td style="color:var(--accent2);font-weight:600">${fmt(mT)}</td></tr>`;
  }).join('')||'<tr><td colspan="5" class="emp">Aucun commercial</td></tr>';

  document.getElementById('ad-today').innerHTML=tPays.slice(0,8).map(p=>{
    const c=getCl(p.clientId),com=getCom(p.commercialId);
    return`<tr><td class="fw6">${esc(c.nom)}</td><td><span class="tag">${esc(com.nom)}</span></td><td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(p.cotisJour||jm(c))}</span></td><td style="color:var(--accent2);font-weight:700">${fmt(p.montant)}</td><td>${ratio(p.montant,p.cotisJour||jm(c))}</td></tr>`;
  }).join('')||'<tr><td colspan="5" class="emp">Aucun paiement aujourd\'hui</td></tr>';

  const alertArts=DB.articles.filter(a=>a.stock<=a.stockMin);
  document.getElementById('ad-stock-alert').innerHTML=alertArts.slice(0,5).map(a=>`<tr><td class="fw6">${esc(a.nom)}</td><td style="font-weight:700;color:${a.stock<=0?'var(--danger)':'var(--accent3)'}">${a.stock} ${esc(a.unite)}</td><td>${stockStatut(a)}</td></tr>`).join('')||'<tr><td colspan="3" class="emp">✅ Tous les stocks OK</td></tr>';
  const livsAtt=DB.livraisons.filter(l=>l.statut==='en_attente');
  document.getElementById('ad-livraisons-att').innerHTML=livsAtt.slice(0,5).map(l=>`<tr><td class="fw6">${esc(getCl(l.clientId).nom)}</td><td style="font-size:11px">${esc(getProd(l.produitId).nom)}</td><td>${esc(l.date)}</td><td>${livStatut(l.statut)}</td></tr>`).join('')||'<tr><td colspan="4" class="emp">Aucune livraison en attente</td></tr>';

  renderRapportProduitsEnCours();
  initDashSections();
  setTimeout(dessinerGraphiques, DELAY_CHART_RENDER_MS);
}

// ════════════════════════════════════════════════
//  SECTIONS COLLAPSIBLES DU TABLEAU DE BORD
// ════════════════════════════════════════════════
const DASH_SECTIONS = ['ds-collecte','ds-stats','ds-users','ds-prodcours','ds-stock-liv'];

function initDashSections(){
  DASH_SECTIONS.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    // Lire l'état mémorisé (localStorage), défaut = ouvert
    const collapsed = localStorage.getItem('dash-collapsed-'+id) === '1';
    if(collapsed) el.classList.add('collapsed');
  });
}

window.toggleDashSection = function(id){
  const el = document.getElementById(id);
  if(!el) return;
  const isNowCollapsed = !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', isNowCollapsed);
  localStorage.setItem('dash-collapsed-'+id, isNowCollapsed ? '1' : '0');
  // Si on rouvre une section avec des charts, les redessiner
  if(!isNowCollapsed){
    setTimeout(dessinerGraphiques, DELAY_CHART_RENDER_MS);
  }
};

// Retourne true si le contrat du client est encore actif (date fin non atteinte)
function clientEstEnCours(c){
  if(!c.debut) return false;
  const debut = new Date(c.debut+'T12:00:00');
  const duree = c.duree || 372;
  const fin   = new Date(debut);
  fin.setDate(fin.getDate() + duree - 1);
  const today = new Date(TODAY+'T12:00:00');
  return fin >= today;
}

// Construit le rapport groupé par libellé de contrat/produit
function buildRapportProduitsEnCours(){
  const actifs = DB.clients.filter(clientEstEnCours);
  // Regrouper par libellé de contrat (champ c.contrat)
  const map = new Map(); // label → [{client}]
  for(const c of actifs){
    const label = (c.contrat||'(Sans produit)').trim();
    if(!map.has(label)) map.set(label, []);
    map.get(label).push(c);
  }
  // Trier par nombre de clients décroissant
  const lignes = [...map.entries()]
    .map(([label, clients])=>({label, clients, nb: clients.length}))
    .sort((a,b)=>b.nb - a.nb);
  return { lignes, totalActifs: actifs.length };
}

// Cache pour la modal de détail
let _prodCoursDetailClients = [];
let _prodCoursDetailLabel   = '';

function renderRapportProduitsEnCours(){
  const q = (document.getElementById('dash-prodcours-search')?.value||'').toLowerCase().trim();
  const { lignes, totalActifs } = buildRapportProduitsEnCours();
  const filtered = q ? lignes.filter(l=>l.label.toLowerCase().includes(q)) : lignes;

  const emptyEl = document.getElementById('dash-prodcours-empty');
  const tbody    = document.getElementById('dash-prodcours-body');
  if(!tbody) return;

  if(filtered.length===0){
    tbody.innerHTML='';
    if(emptyEl) emptyEl.style.display='';
    return;
  }
  if(emptyEl) emptyEl.style.display='none';

  tbody.innerHTML = filtered.map((l,i)=>{
    const pct = totalActifs>0 ? Math.round(l.nb/totalActifs*100) : 0;
    const barW = pct;
    return `<tr style="cursor:pointer;" onclick="ouvrirDetailProdCours(${JSON.stringify(l.label).replace(/"/g,'&quot;')})" title="Voir les ${l.nb} clients en cours pour ce produit">
      <td class="tm">${i+1}</td>
      <td>
        <div style="font-weight:700;font-size:13px;color:var(--text);">${esc(l.label)}</div>
        <div style="margin-top:4px;height:5px;border-radius:3px;background:var(--surface2);overflow:hidden;max-width:240px;">
          <div style="height:100%;width:${barW}%;background:var(--accent);border-radius:3px;transition:width 0.4s;"></div>
        </div>
      </td>
      <td style="text-align:center;">
        <span style="display:inline-block;background:rgba(201,168,76,0.13);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:3px 12px;font-size:13px;font-weight:800;color:var(--accent);">${l.nb}</span>
      </td>
      <td style="text-align:center;font-size:12px;color:var(--muted);">${pct}%</td>
      <td style="text-align:right;">
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();ouvrirDetailProdCours(${JSON.stringify(l.label).replace(/"/g,'&quot;')})">👁 Voir</button>
      </td>
    </tr>`;
  }).join('');
}

window.ouvrirDetailProdCours = function(label){
  const { lignes } = buildRapportProduitsEnCours();
  const ligne = lignes.find(l=>l.label===label);
  if(!ligne) return;
  _prodCoursDetailClients = ligne.clients.slice();
  _prodCoursDetailLabel   = label;

  // KPIs
  const joursRestantsListe = ligne.clients.map(c=>{
    const debut = new Date(c.debut+'T12:00:00');
    const fin   = new Date(debut); fin.setDate(fin.getDate()+(c.duree||372)-1);
    return Math.max(0,Math.round((fin-new Date(TODAY+'T12:00:00'))/86400000));
  });
  const avgJours = joursRestantsListe.length ? Math.round(joursRestantsListe.reduce((a,b)=>a+b,0)/joursRestantsListe.length) : 0;
  const minJours = joursRestantsListe.length ? Math.min(...joursRestantsListe) : 0;

  document.getElementById('m-prodcours-detail-title').textContent = `📦 ${label} — Clients en cours (${ligne.nb})`;
  document.getElementById('m-prodcours-detail-kpi').innerHTML=`
    <div style="background:rgba(201,168,76,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(201,168,76,0.2);">
      <div style="font-size:22px;font-weight:800;color:var(--accent);">${ligne.nb}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Clients actifs</div>
    </div>
    <div style="background:rgba(34,212,160,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(34,212,160,0.2);">
      <div style="font-size:22px;font-weight:800;color:var(--accent2);">${avgJours}j</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Moy. jours restants</div>
    </div>
    <div style="background:rgba(224,92,82,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(224,92,82,0.2);">
      <div style="font-size:22px;font-weight:800;color:var(--danger);">${minJours}j</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Contrat le + proche</div>
    </div>`;

  document.getElementById('m-prodcours-detail-search').value='';
  renderProdCoursDetailTable(ligne.clients);
  openM('m-prodcours-detail');
};

function renderProdCoursDetailTable(clients){
  const getCom = id => DB.commerciaux?.find(c=>c._id===id)?.nom || '—';
  document.getElementById('m-prodcours-detail-body').innerHTML = clients.map((c,i)=>{
    const debut = new Date(c.debut+'T12:00:00');
    const fin   = new Date(debut); fin.setDate(fin.getDate()+(c.duree||372)-1);
    const joursR = Math.max(0,Math.round((fin-new Date(TODAY+'T12:00:00'))/86400000));
    const finStr = fin.toISOString().slice(0,10);
    const urgColor = joursR<=30?'var(--danger)':joursR<=90?'var(--warn)':'var(--accent2)';
    return `<tr>
      <td class="tm">${i+1}</td>
      <td><span style="font-weight:700;">${esc(c.nom)}</span>${c.code?`<br><span style="font-size:10px;color:var(--accent);">Code : ${c.code}</span>`:''}</td>
      <td style="font-size:12px;">${esc(c.tel||'—')}</td>
      <td style="font-size:12px;">${getCom(c.commercialId)}</td>
      <td style="font-size:11px;color:var(--subtle);">${c.debut||'—'}</td>
      <td style="font-size:11px;color:var(--subtle);">${finStr}</td>
      <td style="text-align:center;"><span style="font-weight:700;color:${urgColor};">${joursR}j</span></td>
    </tr>`;
  }).join('')||'<tr><td colspan="7" class="emp">Aucun résultat.</td></tr>';
}

window.filterProdCoursDetailSearch = function(){
  const q = (document.getElementById('m-prodcours-detail-search')?.value||'').toLowerCase().trim();
  const filtered = q
    ? _prodCoursDetailClients.filter(c=>(c.nom||'').toLowerCase().includes(q)||(c.tel||'').toLowerCase().includes(q)||(c.code||'').toLowerCase().includes(q))
    : _prodCoursDetailClients;
  renderProdCoursDetailTable(filtered);
};

window.exportRapportProduitsEnCoursCSV = function(){
  const { lignes } = buildRapportProduitsEnCours();
  let csv = 'Produit/Contrat;Nb clients en cours\n';
  lignes.forEach(l=>{ csv += `"${l.label.replace(/"/g,'""')}";${l.nb}\n`; });
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download=`rapport_produits_en_cours_${TODAY}.csv`; a.click();
};

window.exportDetailProdCoursCSV = function(){
  const getCom = id => DB.commerciaux?.find(c=>c._id===id)?.nom || '—';
  let csv = 'Client;Téléphone;Commercial;Début;Fin contrat;Jours restants\n';
  _prodCoursDetailClients.forEach(c=>{
    const debut = new Date(c.debut+'T12:00:00');
    const fin   = new Date(debut); fin.setDate(fin.getDate()+(c.duree||372)-1);
    const joursR = Math.max(0,Math.round((fin-new Date(TODAY+'T12:00:00'))/86400000));
    csv += `"${c.nom.replace(/"/g,'""')}";"${esc(c.tel||'')}";"${getCom(c.commercialId)}";"${c.debut||''}";"${fin.toISOString().slice(0,10)}";${joursR}\n`;
  });
  const label = _prodCoursDetailLabel.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,30);
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download=`clients_en_cours_${label}_${TODAY}.csv`; a.click();
};

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: PRODUITS                                             ║
// ║  Extraction: node extract-modules.js → js/produits.js        ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= PRODUITS =========
let prodFiltreActif = '';
let prodSelArtId = null; // article sélectionné dans la recherche
let prodComposition = []; // [{articleId, nom, qte, unite}]

// Calcule le stock théorique du produit = min(stock_art / qte_requise) pour chaque composant
function prodStockTheorique(composition) {
  if (!composition || composition.length === 0) return null;
  let min = Infinity;
  for (const c of composition) {
    const art = DB.articles.find(a => a._id === c.articleId);
    if (!art) continue;
    const dispo = Math.floor((art.stock || 0) / (c.qte || 1));
    if (dispo < min) min = dispo;
  }
  return min === Infinity ? null : min;
}

function prodStockBadge(stock) {
  if (stock === null || stock === undefined) return '';
  if (stock <= 0) return `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(247,97,79,0.12);color:var(--danger);border:1px solid rgba(247,97,79,0.3);font-weight:700;">Rupture</span>`;
  if (stock <= 2) return `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(247,201,79,0.12);color:var(--accent);border:1px solid rgba(247,201,79,0.3);font-weight:700;">Stock bas (${stock})</span>`;
  return `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(34,212,160,0.1);color:var(--accent2);border:1px solid rgba(34,212,160,0.25);font-weight:700;">En stock (${stock})</span>`;
}

function renderProduits() {
  const canEdit = session && ['admin','gestionnaire_stock','chef_agence'].includes(session.role);
  const adminBtns = document.getElementById('prod-admin-btns');
  if (adminBtns) adminBtns.style.display = canEdit ? 'flex' : 'none';

  const search = (document.getElementById('prod-search')?.value || '').toLowerCase().trim();
  const searchRef = (document.getElementById('prod-filter-ref')?.value || '').toLowerCase().trim();
  const sort   = document.getElementById('prod-sort')?.value || 'nom';

  // Catégories — ✅ PERF : ne reconstruire que si changé (pas à chaque frappe
  // via dRender('renderProduits')), comptage en une seule passe (Map).
  const cats = [...new Set(DB.produits.map(p => p.cat || '').filter(Boolean))].sort();
  const countByCatP = new Map();
  for (const p of DB.produits) { const c = p.cat||''; if(c) countByCatP.set(c, (countByCatP.get(c)||0)+1); }
  const filterBar = document.getElementById('prod-filter-bar');
  if (filterBar) {
    const barSig = `${prodFiltreActif}|${DB.produits.length}|${cats.join(',')}`;
    if (filterBar.dataset.barSig !== barSig) {
      filterBar.innerHTML =
        `<span style="font-size:11px;color:var(--muted);font-weight:600;margin-right:2px;">Catégorie :</span>` +
        `<button class="prod-filter-chip${prodFiltreActif===''?' active':''}" onclick="filtrerProduits('',this)">Tous (${DB.produits.length})</button>` +
        cats.map(c => {
          const n = countByCatP.get(c)||0;
          return `<button class="prod-filter-chip${prodFiltreActif===c?' active':''}" onclick="filtrerProduits('${c.replace(/'/g,"\\'")}',this)">${c} (${n})</button>`;
        }).join('');
      filterBar.dataset.barSig = barSig;
    }
  }

  let prods = DB.produits.slice();
  if (prodFiltreActif) prods = prods.filter(p => (p.cat||'') === prodFiltreActif);
  if (search) prods = prods.filter(p =>
    (p.nom||'').toLowerCase().includes(search) ||
    (p.cat||'').toLowerCase().includes(search) ||
    (p.desc||'').toLowerCase().includes(search)
  );
  if (searchRef) prods = prods.filter(p => (p.ref||'').toLowerCase().includes(searchRef));

  if (sort === 'nom') prods.sort((a,b) => (a.nom||'').localeCompare(b.nom||''));
  else if (sort === 'prix-asc') prods.sort((a,b) => (a.prix||0) - (b.prix||0));
  else if (sort === 'prix-desc') prods.sort((a,b) => (b.prix||0) - (a.prix||0));
  else if (sort === 'cat') prods.sort((a,b) => (a.cat||'').localeCompare(b.cat||''));

  const grid = document.getElementById('prod-grid');
  const empty = document.getElementById('prod-empty');
  const emptyMsg = document.getElementById('prod-empty-msg');
  if (!grid) return;

  if (prods.length === 0) {
    grid.innerHTML = '';
    if (empty) { empty.style.display = 'block'; }
    if (emptyMsg) {
      emptyMsg.textContent = search || prodFiltreActif
        ? 'Aucun produit ne correspond à votre recherche.'
        : canEdit ? 'Créez votre premier produit avec le bouton ci-dessus.' : 'Aucun produit disponible.';
    }
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = prods.map(p => {
    const comp = p.composition || [];
    const stock = prodStockTheorique(comp);
    const stockBadge = prodStockBadge(stock);
    const imgHtml = p.imageUrl
      ? `<img src="${p.imageUrl}" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" onclick="openImageLightbox('${p.imageUrl}', event)" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:56px;">📦</div>`
      : `<div style="font-size:56px;">📦</div>`;
    const nbArts = comp.length;
    return `<div class="prod-card" onclick="ouvrirZoomProduit('${p._id}')">
      <div class="prod-card-img">${imgHtml}</div>
      <div class="prod-card-body">
        <div style="margin-bottom:5px;">
          ${p.ref ? `<span style="display:inline-block;background:rgba(201,168,76,0.13);border:1px solid rgba(201,168,76,0.3);border-radius:5px;padding:1px 8px;font-size:10px;color:var(--accent);font-weight:700;letter-spacing:0.5px;">🏷️ ${esc(p.ref)}</span>` : `<span style="font-size:9px;color:var(--muted);font-style:italic;">Sans réf.</span>`}
        </div>
        ${p.cat ? `<div class="prod-card-cat">${esc(p.cat)}</div>` : ''}
        <div class="prod-card-nom">${esc(p.nom||'—')}</div>
        ${p.desc ? `<div class="prod-card-desc">${esc(p.desc)}</div>` : ''}
        <div class="prod-card-footer">
          <div class="prod-card-prix">${p.prix > 0 ? fmt(p.prix) + ' F' : '—'}</div>
          <div class="prod-card-compo">🔧 ${nbArts} article${nbArts>1?'s':''}</div>
        </div>
        ${stockBadge ? `<div style="margin-top:7px;">${stockBadge}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

window.filtrerProduits = function(cat, btn) {
  prodFiltreActif = cat;
  document.querySelectorAll('.prod-filter-chip').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderProduits();
};

// ─── Modal création/édition produit ───
window.ouvrirModalProduit = async function(id) {
  const p = id ? DB.produits.find(x => x._id === id) : null;
  document.getElementById('m-produit-title').textContent = p ? '✏️ Modifier le produit' : '📦 Nouveau produit';
  document.getElementById('prod-nom').value = p?.nom || '';
  document.getElementById('prod-cat').value = p?.cat || '';
  document.getElementById('prod-prix').value = p?.prix || '';
  document.getElementById('prod-ref').value = p?.ref || '';
  document.getElementById('prod-desc').value = p?.desc || '';
  document.getElementById('prod-edit-id').value = p?._id || '';
  // Prix d'achat : champ réservé à l'admin, valeur lue depuis le document
  // séparé 'produitsPrive' (jamais présente dans le document 'produits' que
  // les autres rôles peuvent lire).
  const paWrap = document.getElementById('prod-prix-achat-wrap');
  const paInput = document.getElementById('prod-prix-achat');
  if(paWrap) paWrap.style.display = (session?.role ===ROLES.ADMIN) ? 'block' : 'none';
  if(paInput) paInput.value = '';
  if(session?.role ===ROLES.ADMIN && p?._id){
    try{
      const snap = await getDoc(doc(db_fs,'produitsPrive',p._id));
      if(paInput) paInput.value = snap.exists() ? (snap.data().prixAchat || '') : '';
    }catch(e){ console.error('[produit] lecture prix achat', e); }
  }
  // Image
  const prevWrap = document.getElementById('prod-img-preview-wrap');
  const prevImg  = document.getElementById('prod-img-preview');
  if (p?.imageUrl) {
    prevImg.src = p.imageUrl;
    prevWrap.style.display = 'block';
  } else {
    prevWrap.style.display = 'none';
    prevImg.src = '';
  }
  window._prodImageUrl = p?.imageUrl || '';
  window._prodImageFile = null;
  window._prodImageRemoved = false;
  // Datalist catégories
  const dl = document.getElementById('prod-cat-list');
  if (dl) dl.innerHTML = [...new Set(DB.produits.map(x=>x.cat||'').filter(Boolean))].map(c=>`<option value="${esc(c)}">`).join('');
  // Composition
  prodComposition = (p?.composition || []).map(c => ({...c}));
  prodSelArtId = null;
  document.getElementById('prod-art-search').value = '';
  document.getElementById('prod-art-results').style.display = 'none';
  document.getElementById('prod-art-selected').style.display = 'none';
  document.getElementById('prod-art-qty').value = 1;
  renderProdCompositionList();
  openM('m-produit');
};

window.prodChargerImage = function(input) {
  const file = input.files[0]; if (!file) return;
  // Limite raisonnable côté client avant upload (évite d'envoyer un fichier énorme par erreur)
  const MAX_MB = 5;
  if (file.size > MAX_MB * 1024 * 1024) {
    notify(`Image trop lourde (max ${MAX_MB} Mo) — choisissez une photo plus légère`, 'err');
    input.value = '';
    return;
  }
  // ✅ FIX STOCKAGE : on garde le fichier réel pour l'upload vers Firebase
  // Storage au moment de la sauvegarde (voir saveProduit). L'aperçu local
  // (FileReader/DataURL) sert UNIQUEMENT à l'affichage immédiat dans le
  // formulaire — il n'est plus jamais enregistré tel quel dans Firestore.
  window._prodImageFile = file;
  window._prodImageRemoved = false;
  const reader = new FileReader();
  reader.onload = e => {
    const prevImg  = document.getElementById('prod-img-preview');
    const prevWrap = document.getElementById('prod-img-preview-wrap');
    prevImg.src = e.target.result;
    prevWrap.style.display = 'block';
  };
  reader.readAsDataURL(file);
};

window.prodSupprimerImage = function() {
  window._prodImageFile = null;
  window._prodImageRemoved = true;
  window._prodImageUrl = '';
  document.getElementById('prod-img-preview').src = '';
  document.getElementById('prod-img-preview-wrap').style.display = 'none';
  document.getElementById('prod-img-input').value = '';
};

// Recherche d'article dans le modal
window.prodArtSearch = function() {
  const q = (document.getElementById('prod-art-search')?.value || '').toLowerCase().trim();
  const res = document.getElementById('prod-art-results');
  if (!q) { res.style.display = 'none'; return; }
  const matches = DB.articles.filter(a => (a.nom||'').toLowerCase().includes(q)).slice(0, 8);
  if (matches.length === 0) {
    res.innerHTML = `<div style="padding:8px 12px;font-size:12px;color:var(--muted);">Aucun article trouvé</div>`;
    res.style.display = 'block';
    return;
  }
  res.innerHTML = matches.map(a => {
    const dejaAjoute = prodComposition.some(c => c.articleId === a._id);
    return `<div onclick="prodSelectionnerArt('${a._id}')" style="padding:8px 12px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);transition:background 0.1s;"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''"
    >
      <span style="${dejaAjoute?'color:var(--accent2);':''}">
        ${dejaAjoute?'✓ ':''}${esc(a.nom||'—')}
        <span style="font-size:10px;color:var(--muted);margin-left:5px;">${a.unite||'pcs'}</span>
      </span>
      <span style="font-size:11px;color:var(--muted);">Stock: ${a.stock||0}</span>
    </div>`;
  }).join('');
  res.style.display = 'block';
};

window.prodSelectionnerArt = function(artId) {
  const art = DB.articles.find(a => a._id === artId);
  if (!art) return;
  prodSelArtId = artId;
  document.getElementById('prod-art-search').value = art.nom;
  document.getElementById('prod-art-results').style.display = 'none';
  const selEl = document.getElementById('prod-art-selected');
  selEl.textContent = `✓ Sélectionné : ${esc(art.nom)} (stock : ${art.stock||0} ${art.unite||'pcs'})`;
  selEl.style.display = 'block';
};

window.prodArtAdd = function() {
  if (!prodSelArtId) { notify('Sélectionnez d\'abord un article dans la liste','warn'); return; }
  const qte = parseInt(document.getElementById('prod-art-qty')?.value) || 1;
  const art = DB.articles.find(a => a._id === prodSelArtId);
  if (!art) return;
  const existing = prodComposition.findIndex(c => c.articleId === prodSelArtId);
  if (existing >= 0) {
    prodComposition[existing].qte += qte;
    notify(`Quantité mise à jour : ${prodComposition[existing].qte} ${art.unite||'pcs'}`,'ok');
  } else {
    prodComposition.push({ articleId: prodSelArtId, nom: art.nom, qte, unite: art.unite||'pcs' });
  }
  prodSelArtId = null;
  document.getElementById('prod-art-search').value = '';
  document.getElementById('prod-art-selected').style.display = 'none';
  document.getElementById('prod-art-qty').value = 1;
  renderProdCompositionList();
  prodCalcInfo();
};

function renderProdCompositionList() {
  const el = document.getElementById('prod-comp-list');
  const vide = document.getElementById('prod-comp-vide');
  const stockInfo = document.getElementById('prod-stock-info');
  if (!el) return;
  if (prodComposition.length === 0) {
    el.innerHTML = '';
    if (vide) vide.style.display = 'block';
    if (stockInfo) stockInfo.style.display = 'none';
    return;
  }
  if (vide) vide.style.display = 'none';
  el.innerHTML = prodComposition.map((c, i) => {
    const art = DB.articles.find(a => a._id === c.articleId);
    const stock = art?.stock || 0;
    const dispo = Math.floor(stock / c.qte);
    const stockColor = dispo <= 0 ? 'var(--danger)' : dispo <= 2 ? 'var(--accent)' : 'var(--accent2)';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface);border-radius:7px;border:1px solid var(--border);">
      <span style="flex:1;font-size:12px;font-weight:600;">${esc(c.nom)}</span>
      <span style="font-size:11px;color:var(--muted);">×</span>
      <input type="number" value="${c.qte}" min="1"
        style="width:52px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:3px 6px;color:var(--text);font-size:12px;text-align:center;outline:none;"
        onchange="prodUpdateQte(${i},this.value)">
      <span style="font-size:11px;color:var(--muted);">${c.unite}</span>
      <span style="font-size:11px;color:${stockColor};" title="Disponible avec ce stock">≈${dispo}</span>
      <button onclick="prodRetirerArt(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 2px;line-height:1;">✕</button>
    </div>`;
  }).join('');
  // Stock théorique global
  const stockTheo = prodStockTheorique(prodComposition);
  if (stockInfo) {
    stockInfo.style.display = 'block';
    stockInfo.innerHTML = `📦 Stock produit théorique : <strong style="color:${stockTheo===null?'var(--muted)':stockTheo<=0?'var(--danger)':stockTheo<=2?'var(--accent)':'var(--accent2)'};">${stockTheo===null?'—':stockTheo+' unité(s)'}</strong>`;
  }
}

window.prodUpdateQte = function(idx, val) {
  const q = parseInt(val) || 1;
  if (prodComposition[idx]) { prodComposition[idx].qte = Math.max(1, q); }
  renderProdCompositionList();
  prodCalcInfo();
};

window.prodRetirerArt = function(idx) {
  prodComposition.splice(idx, 1);
  renderProdCompositionList();
  prodCalcInfo();
};

window.prodCalcInfo = function() {
  const prixSaisi = parseFloat(document.getElementById('prod-prix')?.value) || 0;
  const totalArt = prodComposition.reduce((s, c) => {
    const art = DB.articles.find(a => a._id === c.articleId);
    return s + (art?.prixVente || art?.prix || 0) * c.qte;
  }, 0);
  const infoEl = document.getElementById('prod-prix-info');
  if (infoEl) {
    if (totalArt > 0) {
      const diff = prixSaisi - totalArt;
      const diffStr = diff >= 0
        ? `<span style="color:var(--accent2);">+${fmt(diff)} F de marge</span>`
        : `<span style="color:var(--danger);">${fmt(Math.abs(diff))} F en dessous du coût articles</span>`;
      infoEl.innerHTML = `Coût articles : ${fmt(totalArt)} F — ${diffStr}`;
      infoEl.style.display = 'block';
    } else {
      infoEl.style.display = 'none';
    }
  }
};

// Upload une photo produit vers Firebase Storage et retourne son URL de
// téléchargement. Le nom de fichier inclut un timestamp pour éviter tout
// conflit/écrasement accidentel entre deux photos du même produit.
async function _uploadProduitImage(file, produitId) {
  if (!storage) throw new Error('Firebase Storage non initialisé');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
  const path = `produits/${produitId}/${Date.now()}.${ext}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || 'image/jpeg' });
  return await getDownloadURL(fileRef);
}

window.saveProduit = async function() {
  const nom  = document.getElementById('prod-nom')?.value.trim();
  const prix = parseFloat(document.getElementById('prod-prix')?.value) || 0;
  if (!nom) { notify('Le nom du produit est obligatoire','warn'); return; }
  const editId = document.getElementById('prod-edit-id')?.value;
  const prodActuel = editId ? DB.produits.find(p => p._id === editId) : null;
  const ancienImageUrl = prodActuel?.imageUrl || '';

  // ✅ FIX STOCKAGE : upload de la photo vers Firebase Storage (pas de
  // base64 dans Firestore). On génère d'abord l'id du produit si c'est une
  // création, pour pouvoir organiser les fichiers par produit dans Storage.
  let imageUrl = window._prodImageUrl || '';
  const btnSave = document.getElementById('prod-btn-save');
  if (window._prodImageFile) {
    if (btnSave) { btnSave.disabled = true; btnSave.textContent = '⏳ Envoi de la photo…'; }
    try {
      const produitIdPourUpload = editId || ('tmp_' + Date.now());
      imageUrl = await _uploadProduitImage(window._prodImageFile, produitIdPourUpload);
    } catch(e) {
      notify("Erreur lors de l'envoi de la photo : " + (e.message||String(e)), 'err');
      if (btnSave) { btnSave.disabled = false; btnSave.textContent = '✓ Enregistrer'; }
      return;
    }
  } else if (window._prodImageRemoved) {
    imageUrl = '';
  }

  const data = {
    nom,
    cat:  document.getElementById('prod-cat')?.value.trim() || '',
    prix,
    ref:  document.getElementById('prod-ref')?.value.trim() || '',
    desc: document.getElementById('prod-desc')?.value.trim() || '',
    imageUrl,
    composition: prodComposition.map(c => ({ articleId: c.articleId, nom: c.nom, qte: c.qte, unite: c.unite })),
    updatedAt: TODAY,
  };
  let produitId = editId;
  if (editId) {
    const ancienPrix = prodActuel ? prodActuel.prix : null;
    await fbUpdate('produits', editId, data);
    if (ancienPrix !== null && ancienPrix !== data.prix) {
      const clientsProteges = DB.clients.filter(c => (c.produitsPrixFiges||[]).some(x => x.produitId === editId));
      if (clientsProteges.length > 0) {
        notify(`Produit mis à jour ✓ — Prix ${fmt(ancienPrix)} → ${fmt(data.prix)} · ${clientsProteges.length} client(s) conservent leur prix 🔒`);
      } else { notify('Produit mis à jour ✓'); }
    } else { notify('Produit mis à jour ✓'); }
  } else {
    data.createdAt = TODAY;
    const created = await fbAdd('produits', data);
    produitId = created?._id;
    notify('Produit créé ✓');
  }
  // Prix d'achat : document séparé réservé à l'admin (voir règle produitsPrive).
  // Écrit seulement si le champ est visible, donc seulement pour un admin —
  // pour tout autre rôle ce bloc est ignoré et la valeur existante n'est
  // jamais touchée.
  if (session?.role ===ROLES.ADMIN && produitId) {
    const prixAchat = parseFloat(document.getElementById('prod-prix-achat')?.value) || 0;
    try { await setDoc(doc(db_fs,'produitsPrive',produitId), {prixAchat}, {merge:true}); }
    catch(e){ console.error('[produit] sauvegarde prix achat', e); notify("Prix d'achat non enregistré (erreur)","err"); }
  }
  // Nettoyage best-effort de l'ancienne photo dans Storage si elle a été
  // remplacée ou supprimée (non bloquant : une erreur ici n'empêche pas
  // la sauvegarde du produit, qui est déjà faite).
  if (ancienImageUrl && ancienImageUrl !== imageUrl && ancienImageUrl.includes('firebasestorage')) {
    try { await deleteObject(storageRef(storage, ancienImageUrl)); } catch(e) { /* fichier déjà absent ou permissions : on ignore */ }
  }
  if (btnSave) { btnSave.disabled = false; btnSave.textContent = '✓ Enregistrer'; }
  closeM('m-produit');
  renderProduits();
};

// ─── Zoom produit ───
let _prodZoomId = null;
window.ouvrirZoomProduit = function(id) {
  const p = DB.produits.find(x => x._id === id);
  if (!p) return;
  _prodZoomId = id;
  const canEdit = session && ['admin','gestionnaire_stock','chef_agence'].includes(session.role);

  document.getElementById('pz-nom').textContent = p.nom || '—';
  document.getElementById('pz-cat').textContent = p.cat || '';
  document.getElementById('pz-prix').textContent = p.prix > 0 ? fmt(p.prix) + ' F' : '—';
  document.getElementById('pz-ref').textContent = p.ref ? `Réf : ${p.ref}` : '';
  document.getElementById('pz-desc').textContent = p.desc || '';

  // Image
  const img = document.getElementById('pz-img');
  const noimg = document.getElementById('pz-noimg');
  if (p.imageUrl) {
    img.src = p.imageUrl;
    img.style.display = 'block';
    noimg.style.display = 'none';
  } else {
    img.style.display = 'none';
    noimg.style.display = 'flex';
  }

  // Stock théorique
  const comp = p.composition || [];
  const stock = prodStockTheorique(comp);
  const stockWrap = document.getElementById('pz-stock-wrap');
  const stockEl   = document.getElementById('pz-stock');
  if (stock !== null && canEdit) {
    stockWrap.style.display = 'block';
    stockEl.textContent = stock <= 0 ? '0 — Rupture' : `${stock} unité(s) disponible(s)`;
    stockEl.style.color = stock <= 0 ? 'var(--danger)' : stock <= 2 ? 'var(--accent)' : 'var(--accent2)';
  } else {
    stockWrap.style.display = 'none';
  }

  // Composition
  const compList = document.getElementById('pz-comp-list');
  if (comp.length === 0) {
    compList.innerHTML = `<div style="font-size:12px;color:var(--muted);">Aucun article composant.</div>`;
  } else {
    compList.innerHTML = comp.map(c => {
      const art = DB.articles.find(a => a._id === c.articleId);
      const artNom = art?.nom || c.nom || '—';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--surface2);border-radius:7px;font-size:12px;">
        <span style="font-weight:600;">${artNom}</span>
        <span style="color:var(--muted);">× ${c.qte} ${c.unite||'pcs'}</span>
      </div>`;
    }).join('');
  }

  // Boutons admin
  const adminBtns = document.getElementById('pz-admin-btns');
  if (adminBtns) {
    adminBtns.style.display = canEdit ? 'flex' : 'none';
    document.getElementById('pz-edit-btn').onclick = () => { closeM('m-prod-zoom'); ouvrirModalProduit(id); };
    document.getElementById('pz-del-btn').onclick = () => supprimerProduit(id);
  }
  openM('m-prod-zoom');
};

window.supprimerProduit = async function(id) {
  const p = DB.produits.find(x => x._id === id);
  if (!p) return;
  if (!(await confirmDialog(`Supprimer le produit "${esc(p.nom)}" ? Cette action est irréversible.`,{title:'🗑 Suppression produit',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('produits', id);
  closeM('m-prod-zoom');
  renderProduits();
  notify('Produit supprimé');
};

// ══════════════════════════════════════════
//  IMPORT PRODUITS — Excel / CSV
// ══════════════════════════════════════════

let importProdData = []; // [{nom, cat, prix, ref, desc, composition:[{nomArt,qte}], _resolved:[{articleId,nom,qte,unite,found}]}]

/**
 * Parse la colonne "composition" :
 * "Chauffe-eau×2, Tuyau x1, Robinet" → [{nomArt:'Chauffe-eau',qte:2}, ...]
 */
function parseCompositionStr(str) {
  if (!str || !str.toString().trim()) return [];
  return str.toString().split(',').map(s => s.trim()).filter(Boolean).map(part => {
    // Séparateurs : × (U+00D7), x, X suivi d'un chiffre, ou chiffre seul à la fin
    const m = part.match(/^(.+?)[\s]*[×xX][\s]*(\d+)[\s]*$/) || part.match(/^(.+?)[\s]+(\d+)[\s]*$/);
    if (m) return { nomArt: m[1].trim(), qte: parseInt(m[2]) || 1 };
    return { nomArt: part.trim(), qte: 1 };
  }).filter(c => c.nomArt);
}

/**
 * Résout les noms d'articles → articleId (insensible à la casse, trim)
 */
function resolveComposition(compParsed) {
  return compParsed.map(c => {
    const art = DB.articles.find(a =>
      (a.nom || '').trim().toLowerCase() === c.nomArt.trim().toLowerCase()
    );
    return {
      nomArt:    c.nomArt,
      qte:       c.qte,
      articleId: art ? art._id : null,
      nom:       art ? art.nom : c.nomArt,
      unite:     art ? (art.unite || 'pcs') : 'pcs',
      found:     !!art,
    };
  });
}

window.handleImportProduits = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  // Charger SheetJS si besoin
  if (!window.XLSX) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (!rows.length) { notify('Fichier vide ou non reconnu', 'warn'); return; }

  const get = (row, ...keys) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== '') return v;
    }
    return '';
  };

  importProdData = rows.map(row => {
    const nom   = (get(row, 'nom','name','produit','designation','désignation') || '').toString().trim();
    const cat   = (get(row, 'categorie','catégorie','cat','famille') || '').toString().trim();
    const prix  = parseFloat(get(row, 'prix','price','prix_vente','prix vente','montant')) || 0;
    const ref   = (get(row, 'ref','reference','référence','code','code_produit') || '').toString().trim();
    const desc  = (get(row, 'description','desc','detail','détail') || '').toString().trim();
    const compStr = get(row, 'composition','articles','composants','composition_articles');
    const compParsed  = parseCompositionStr(compStr);
    const compResolved = resolveComposition(compParsed);
    return { nom, cat, prix, ref, desc, _compStr: compStr, composition: compResolved };
  }).filter(r => r.nom); // ignorer lignes sans nom

  if (!importProdData.length) { notify('Aucune ligne valide (colonne "nom" absente ou vide)', 'warn'); return; }

  prepareProdImportPreview();
};

function prepareProdImportPreview() {
  const total = importProdData.length;
  const totalArts = importProdData.reduce((s, r) => s + r.composition.length, 0);
  const nonTrouves = importProdData.reduce((s, r) => s + r.composition.filter(c => !c.found).length, 0);

  document.getElementById('import-prod-info').innerHTML =
    `<strong>${total}</strong> produit(s) détecté(s) · <strong>${totalArts}</strong> lien(s) article(s) ·
     ${nonTrouves > 0
       ? `<span style="color:var(--danger);">⚠️ ${nonTrouves} article(s) introuvable(s) en base</span>`
       : `<span style="color:var(--accent2);">✓ Tous les articles ont été résolus</span>`}`;

  document.getElementById('import-prod-count').textContent = total;

  // Avertissements articles introuvables
  const warningEl = document.getElementById('import-prod-warnings');
  if (nonTrouves > 0) {
    const noms = [...new Set(
      importProdData.flatMap(r => r.composition.filter(c => !c.found).map(c => `"${esc(c.nomArt)}"`))
    )];
    warningEl.style.display = 'block';
    warningEl.innerHTML = `⚠️ Articles introuvables (seront ignorés dans la composition) : ${noms.map(n=>esc(n)).join(', ')}<br>
      <span style="color:var(--muted);">Vérifiez l'orthographe exacte dans la base Articles ou ajoutez-les d'abord.</span>`;
  } else {
    warningEl.style.display = 'none';
  }

  // Tableau aperçu
  document.getElementById('import-prod-body').innerHTML = importProdData.map((r, i) => {
    const compHtml = r.composition.length === 0
      ? `<span style="color:var(--muted);font-size:10px;">—</span>`
      : r.composition.map(c => {
          const color = c.found ? 'var(--accent2)' : 'var(--danger)';
          const icon  = c.found ? '✓' : '✗';
          return `<span style="font-size:10px;color:${color};margin-right:5px;">${icon} ${esc(c.nomArt)}×${c.qte}</span>`;
        }).join('');
    const hasWarn = r.composition.some(c => !c.found);
    const statut = hasWarn
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(247,201,79,0.12);color:var(--accent);border:1px solid rgba(247,201,79,0.3);font-weight:700;">⚠️ Partiel</span>`
      : `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(34,212,160,0.1);color:var(--accent2);border:1px solid rgba(34,212,160,0.25);font-weight:700;">✓ OK</span>`;
    return `<tr>
      <td class="tm">${i + 1}</td>
      <td class="fw6">${esc(r.nom)}</td>
      <td>${esc(r.cat) || '—'}</td>
      <td>${r.prix > 0 ? fmt(r.prix) + ' F' : '—'}</td>
      <td style="max-width:260px;line-height:1.8;">${compHtml}</td>
      <td>${statut}</td>
    </tr>`;
  }).join('');

  openM('m-import-prod-preview');
}

window.confirmImportProduits = async function() {
  if (!importProdData.length) return;
  const btn = document.getElementById('import-prod-confirm-btn');
  btn.disabled = true;
  const total = importProdData.length;
  let count = 0, errCount = 0, lastErr = null, interrompu = false;
  const task = startProgressTask('Import produits', total);
  for (const r of importProdData) {
    if(task.stopped()){ interrompu = true; break; }
    try {
      // Ne garder que les composants résolus (found === true)
      const composition = r.composition
        .filter(c => c.found)
        .map(c => ({ articleId: c.articleId, nom: c.nom, qte: c.qte, unite: c.unite }));
      await fbAdd('produits', {
        nom:         r.nom,
        cat:         r.cat,
        prix:        r.prix,
        ref:         r.ref,
        desc:        r.desc,
        imageUrl:    '',
        composition,
        createdAt:   TODAY,
        origine:     'import',
      });
      count++;
      task.update(count);
      btn.textContent = `⏳ Import en cours… ${count} / ${total}`;
    } catch(e){
      // ✅ FIX : une erreur sur UN produit n'interrompt plus tout l'import —
      // on la compte comme échec et on continue avec les produits suivants.
      errCount++;
      lastErr = e;
      task.update(count, `(${errCount} échec(s))`);
      btn.textContent = `⏳ Import en cours… ${count} / ${total} (${errCount} échec(s))`;
    }
    await new Promise(r => setTimeout(r, 50)); // FIX 4 : pause anti-saturation
  }
  task.finish();
  btn.disabled = false;
  btn.textContent = '✓ Importer';
  closeM('m-import-prod-preview');
  importProdData = [];
  renderProduits();
  let msg = interrompu
    ? `⏹ Import interrompu — ${count} produit(s) importé(s) avant l'arrêt`
    : `${count} produit(s) importé(s) avec succès ✓`;
  if(errCount>0) msg += ` — ⚠️ ${errCount} échec(s) (ex: ${lastErr?.message||lastErr})`;
  notify(msg, (errCount>0||interrompu) ? 'err' : 'ok');
};

// ══════════════════════════════════════════
//  MODÈLE EXCEL PRODUITS
// ══════════════════════════════════════════
window.downloadProduitTemplate = async function() {
  if (!window.XLSX) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  // Récupérer les noms d'articles existants pour l'exemple
  const artExemples = DB.articles.slice(0, 3).map(a => a.nom);
  while (artExemples.length < 3) artExemples.push(`Article ${artExemples.length + 1}`);

  const cols = ['nom','categorie','prix','ref','description','composition'];
  const exemples = [
    [
      'Kit Cuisine Complète',
      'Électroménager',
      85000,
      'PROD-001',
      'Pack complet pour équipement cuisine',
      `${artExemples[0]}×1, ${artExemples[1]}×2`,
    ],
    [
      'Forfait Climatisation Standard',
      'Climatisation',
      120000,
      'PROD-002',
      'Installation + matériel',
      `${artExemples[2]}×1`,
    ],
    [
      'Pack Plomberie Basique',
      'Plomberie',
      45000,
      '',
      '',
      `${artExemples[0]}×2, ${artExemples[2]}×3`,
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet([cols, ...exemples]);
  ws['!cols'] = [22, 18, 10, 12, 30, 45].map(w => ({ wch: w }));

  // Onglet guide
  const articlesBase = DB.articles.slice(0, 15).map(a => [a.nom, a.unite || 'pcs', a.stock || 0]);
  const guideData = [
    ['Colonne', 'Obligatoire ?', 'Description', 'Exemple'],
    ['nom',         'OUI ✅', 'Nom du produit',                              'Kit Cuisine Complète'],
    ['categorie',   'Non',    'Catégorie du produit',                        'Électroménager'],
    ['prix',        'Non',    'Prix de vente en FCFA',                       '85000'],
    ['ref',         'Non',    'Référence / code produit',                    'PROD-001'],
    ['description', 'Non',    'Description courte',                         'Pack complet...'],
    ['composition', 'Non',    'Articles composants : NomArticle×Qté séparés par virgule. La quantité après × ou x est optionnelle (1 par défaut). Le nom doit correspondre EXACTEMENT à un article en base.', `${artExemples[0]}×2, ${artExemples[1]}×1`],
    ['', '', '', ''],
    ['⚠️ Correspondance articles', '', 'La correspondance se fait par nom EXACT (insensible à la casse). Les articles introuvables seront ignorés mais le produit sera quand même créé.', ''],
    ['', '', '', ''],
    ['── Articles disponibles en base ──', '', '', ''],
    ['Nom article', 'Unité', 'Stock actuel', ''],
    ...articlesBase,
    ...(DB.articles.length === 0 ? [['(Aucun article en base)', '', '', '']] : []),
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(guideData);
  wsGuide['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 65 }, { wch: 35 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Produits');
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Guide + Articles base');
  XLSX.writeFile(wb, 'modele_import_produits.xlsx');
  notify('📥 Modèle produits téléchargé ✓');
};

// ========= CATALOGUE VISUEL =========
let catFiltreActif = '';
let catFiltreStock = ''; // '' | 'ok' | 'bas' | 'rupture'

function renderCatalogue(){
  // Masquer les filtres et infos stock pour les commerciaux
  const _isComCat = session && session.role ===ROLES.COMMERCIAL;
  const _sfEl = document.getElementById('cat-stock-filters');
  if(_sfEl) _sfEl.style.display = _isComCat ? 'none' : 'flex';
  // Construire les chips de catégories — ✅ PERF : ne reconstruire (innerHTML)
  // que si les catégories/compteurs ont changé, pas à chaque frappe de
  // recherche (oninput="dRender('renderCatalogue')" déclenche cette fonction
  // en continu). Le comptage par catégorie se fait aussi en une seule passe
  // (Map) au lieu d'un .filter() par catégorie (O(cats × articles)).
  const cats = [...new Set(DB.articles.map(a=>a.cat||'').filter(Boolean))].sort();
  const countByCat = new Map();
  for (const a of DB.articles) { const c = a.cat||''; if(c) countByCat.set(c, (countByCat.get(c)||0)+1); }
  const bar = document.getElementById('cat-filter-bar');
  if(bar){
    const barSig = `${catFiltreActif}|${DB.articles.length}|${cats.join(',')}`;
    if (bar.dataset.barSig !== barSig) {
      bar.innerHTML = `<span style="font-size:11px;color:var(--muted);font-weight:600;margin-right:4px;">Cat&eacute;gorie :</span>
        <button class="cat-filter-chip${catFiltreActif===''?' active':''}" onclick="filtrerCatalogue('',this)">Tous (${DB.articles.length})</button>`+
        cats.map(c=>{
          const n = countByCat.get(c)||0;
          return `<button class="cat-filter-chip${catFiltreActif===c?' active':''}" onclick="filtrerCatalogue('${c}',this)">${c} (${n})</button>`;
        }).join('');
      bar.dataset.barSig = barSig;
    }
  }

  // Mettre à jour le style actif des boutons stock
  ['all','ok','bas','rupture'].forEach(k=>{
    const btn = document.getElementById('cat-sc-'+k);
    if(!btn) return;
    const isActive = (k==='all' && catFiltreStock==='') || k===catFiltreStock;
    btn.style.fontWeight = isActive ? '700' : '400';
    btn.style.opacity = isActive ? '1' : '0.65';
    btn.style.transform = isActive ? 'scale(1.05)' : 'scale(1)';
  });

  const q=(document.getElementById('cat-search')?.value||'').toLowerCase().trim();
  let arts = DB.articles;
  if(catFiltreActif) arts = arts.filter(a=>a.cat===catFiltreActif);
  // Filtre statut stock
  if(catFiltreStock==='ok')      arts = arts.filter(a=>a.stock>a.stockMin);
  if(catFiltreStock==='bas')     arts = arts.filter(a=>a.stock>0&&a.stock<=a.stockMin);
  if(catFiltreStock==='rupture') arts = arts.filter(a=>a.stock<=0);
  if(q) arts = arts.filter(a=>a.nom.toLowerCase().includes(q)||(a.ref||'').toLowerCase().includes(q)||(a.desc||'').toLowerCase().includes(q));

  const grid = document.getElementById('cat-grid');
  if(!arts.length){
    grid.innerHTML='<div class="emp" style="padding:60px;grid-column:1/-1;">Aucun article trouvé.</div>';
    return;
  }

  grid.innerHTML = arts.map(a=>{
    const stockDispo = packStockDispo(a);
    const stockColor = stockDispo<=0?'var(--danger)':stockDispo<=a.stockMin?'var(--accent3)':'var(--accent2)';
    const stockLabel = stockDispo<=0?'Rupture':stockDispo<=a.stockMin?'Stock bas':'En stock';
    const stockBg    = stockDispo<=0?'rgba(224,92,82,0.14)':stockDispo<=a.stockMin?'rgba(247,201,79,0.15)':'rgba(34,212,160,0.15)';
    const imgs = artImages(a);
    const imgSection = imgs.length>0
      ? `<div style="position:relative;width:100%;height:200px;overflow:hidden;">
           <img src="${imgs[0]}" alt="${esc(a.nom)}" style="width:100%;height:200px;object-fit:cover;display:block;transition:transform 0.3s;" class="cat-card-photo">
           ${imgs.length>1?`<div style="position:absolute;bottom:6px;right:8px;background:rgba(0,0,0,0.55);color:#fff;font-size:10px;border-radius:12px;padding:2px 8px;">📷 ${imgs.length}</div>`:''}
         </div>`
      : `<div class="cat-card-no-img">
           <div style="font-size:56px;">${catEmoji(a.cat)}</div>
           ${(session&&(session.role===ROLES.ADMIN||session.role===ROLES.GESTIONNAIRE_STOCK||session.role===ROLES.CHEF_AGENCE))?`<label style="font-size:10px;color:var(--muted);cursor:pointer;padding:4px 10px;border:1px dashed var(--border);border-radius:6px;transition:all 0.15s;"
             onmouseover="this.style.borderColor='var(--accent3)';this.style.color='var(--accent3)'"
             onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'"
             onclick="event.stopPropagation();ouvrirZoomCatalogue('${a._id}',true)">
             &#128247; Ajouter une image
           </label>`:''}
         </div>`;
    const packBadge = a.type==='pack'?`<span style="position:absolute;top:8px;left:8px;background:rgba(201,168,76,0.9);color:#fff;font-size:9px;font-weight:800;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;">🎁 Pack</span>`:'';
    return `<div class="cat-card" onclick="ouvrirZoomCatalogue('${a._id}')">
      <div class="cat-card-img-wrap" style="position:relative;">
        ${imgSection}
        ${_isComCat?'':`<span class="cat-card-badge" style="background:${stockBg};color:${stockColor};">${stockLabel}</span>`}
        ${packBadge}
      </div>
      <div class="cat-card-body">
        <div class="cat-card-cat">${esc(a.cat)||'—'} · <span class="tag" style="font-size:9px;">${esc(a.ref)||'—'}</span></div>
        <div class="cat-card-nom">${esc(a.nom)}</div>
        ${a.desc?`<div class="cat-card-desc">${esc(a.desc)}</div>`:''}
        <div class="cat-card-footer">
          <div class="cat-card-prix">${fmt(a.pv)}</div>
          ${_isComCat?'':`<div style="font-size:10px;color:${stockColor};font-weight:600;">${stockDispo} ${a.unite||'pcs'}${a.type==='pack'?' (calculé)':''}</div>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

window.filtrerCatalogue = function(cat, btn){
  catFiltreActif = cat;
  document.querySelectorAll('.cat-filter-chip').forEach(c=>c.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderCatalogue();
};

window.filtrerCatalogueStock = function(val){
  catFiltreStock = val;
  renderCatalogue();
};

let catZoomId = null;
let catZoomImgIndex = 0; // index de l'image affichée dans le zoom

// ══════════════════════════════════════════
//  ZOOM CATALOGUE — multi-images + pack
// ══════════════════════════════════════════
window.ouvrirZoomCatalogue = function(artId, focusUpload=false){
  catZoomId = artId;
  catZoomImgIndex = 0;
  const a = DB.articles.find(x=>x._id===artId);
  if(!a) return;

  document.getElementById('zoom-cat-nom').textContent   = a.nom;
  document.getElementById('zoom-cat-cat').textContent   = a.cat||'';
  document.getElementById('zoom-cat-ref').textContent   = a.ref ? 'Réf. '+a.ref : '';
  document.getElementById('zoom-cat-desc').textContent  = a.desc||a.description||'';
  document.getElementById('zoom-cat-pv').textContent    = fmt(a.pv);
  document.getElementById('zoom-cat-pa').textContent    = a.pa>0?fmt(a.pa):'—';
  document.getElementById('zoom-cat-emoji').textContent = catEmoji(a.cat);

  // Stock — pack = calculé
  const stockEl = document.getElementById('zoom-cat-stock');
  const stockDispo = packStockDispo(a);
  const stockColor = stockDispo<=0?'var(--danger)':stockDispo<=a.stockMin?'var(--accent3)':'var(--accent2)';
  stockEl.textContent = `${stockDispo} ${a.unite||'pcs'}${a.type==='pack'?' (calculé)':''}`;
  stockEl.style.color = stockColor;

  // Afficher section composition pack
  const packSec = document.getElementById('zoom-pack-section');
  if(a.type==='pack' && (a.composition||[]).length>0){
    packSec.style.display='';
    document.getElementById('zoom-pack-list').innerHTML=(a.composition||[]).map(c=>{
      const comp=DB.articles.find(x=>x._id===c.articleId);
      if(!comp) return '';
      const sc = comp.stock<=0?'var(--danger)':comp.stock<=(comp.stockMin||0)?'var(--warn)':'var(--accent2)';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--surface2);border-radius:7px;margin-bottom:5px;">
        <div>
          <span style="font-weight:600;font-size:13px;">${esc(comp.nom)}</span>
          <span style="font-size:10px;color:var(--muted);margin-left:6px;">${esc(comp.ref||'')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-weight:700;color:var(--accent);">${c.qte}x</span>
          <span style="font-size:11px;color:${sc};font-weight:600;">Stock: ${comp.stock}</span>
        </div>
      </div>`;
    }).join('');
  } else { packSec.style.display='none'; }

  // Galerie images (images[] array ou image legacy)
  zoomRenderGallery(a);

  document.getElementById('zoom-upload-progress').style.display='none';
  document.getElementById('zoom-img-input').value='';
  const canEditCat = session && (session.role===ROLES.ADMIN||session.role===ROLES.GESTIONNAIRE_STOCK||session.role===ROLES.CHEF_AGENCE);
  const _isComZoom = session && session.role===ROLES.COMMERCIAL;
  document.getElementById('zoom-upload-section').style.display = canEditCat ? '' : 'none';
  const _sw = document.getElementById('zoom-cat-stock-wrap');
  const _pw = document.getElementById('zoom-cat-pa-wrap');
  const _ig = document.getElementById('zoom-cat-info-grid');
  if(_sw) _sw.style.display = _isComZoom ? 'none' : '';
  if(_pw) _pw.style.display = _isComZoom ? 'none' : '';
  if(_ig) _ig.style.gridTemplateColumns = _isComZoom ? '1fr' : '1fr 1fr 1fr';
  openM('m-cat-zoom');
  if(focusUpload && canEditCat) setTimeout(()=>document.getElementById('zoom-img-input').click(),200);
};

// Rendu galerie dans le zoom
function zoomRenderGallery(a){
  const imgs = artImages(a); // tableau d'URLs
  const main = document.getElementById('zoom-cat-img');
  const noImg = document.getElementById('zoom-cat-noimg');
  const thumbsEl = document.getElementById('zoom-thumbs');
  const counter = document.getElementById('zoom-img-counter');
  const prevBtn = document.getElementById('zoom-prev-btn');
  const nextBtn = document.getElementById('zoom-next-btn');
  const delBtn  = document.getElementById('zoom-del-img-btn');
  const canEdit = session && (session.role===ROLES.ADMIN||session.role===ROLES.GESTIONNAIRE_STOCK||session.role===ROLES.CHEF_AGENCE);
  if(catZoomImgIndex >= imgs.length) catZoomImgIndex=0;
  if(imgs.length>0){
    main.src=imgs[catZoomImgIndex]; main.style.display='block';
    noImg.style.display='none';
    counter.style.display = imgs.length>1 ? '' : 'none';
    counter.textContent = `${catZoomImgIndex+1} / ${imgs.length}`;
    prevBtn.style.display = imgs.length>1 ? '' : 'none';
    nextBtn.style.display = imgs.length>1 ? '' : 'none';
    if(canEdit) delBtn.style.display='';
  } else {
    main.src=''; main.style.display='none'; noImg.style.display='flex';
    counter.style.display='none'; prevBtn.style.display='none'; nextBtn.style.display='none';
    delBtn.style.display='none';
  }
  // Vignettes
  if(imgs.length>1){
    thumbsEl.style.display='flex';
    thumbsEl.innerHTML=imgs.map((src,i)=>`
      <img src="${src}" onclick="zoomSetImg(${i})"
        style="width:64px;height:64px;object-fit:cover;border-radius:7px;cursor:pointer;border:2px solid ${i===catZoomImgIndex?'var(--accent)':'transparent'};flex-shrink:0;transition:border-color 0.15s;">`
    ).join('');
  } else { thumbsEl.style.display='none'; thumbsEl.innerHTML=''; }
  // Label upload
  const lbl = document.getElementById('zoom-upload-label');
  if(lbl) lbl.textContent = imgs.length>=5 ? '✅ 5 illustrations — max atteint' : `📷 Ajouter des illustrations (${imgs.length}/5)`;
  const inp = document.getElementById('zoom-img-input');
  if(inp) inp.disabled = imgs.length>=5;
}

window.zoomSetImg = function(idx){
  const a=DB.articles.find(x=>x._id===catZoomId); if(!a) return;
  catZoomImgIndex=idx; zoomRenderGallery(a);
};
window.zoomNavImg = function(dir){
  const a=DB.articles.find(x=>x._id===catZoomId); if(!a) return;
  const imgs=artImages(a);
  catZoomImgIndex=(catZoomImgIndex+dir+imgs.length)%imgs.length;
  zoomRenderGallery(a);
};

window.uploadImagesCatalogue = async function(input){
  if(!input.files||!input.files.length||!catZoomId) return;
  const prog = document.getElementById('zoom-upload-progress');
  prog.style.display='block'; prog.textContent='Chargement…';
  const a = DB.articles.find(x=>x._id===catZoomId);
  if(!a){ prog.style.display='none'; return; }
  const existingImgs = artImages(a);
  const remaining = 5 - existingImgs.length;
  if(remaining<=0){ notify('Maximum 5 illustrations atteint','err'); prog.style.display='none'; return; }
  const files = Array.from(input.files).slice(0,remaining);
  const newB64 = [];
  for(const f of files){
    const b64 = await fileToBase64(f);
    if(!b64){ notify('Une image est trop grande (max 2 Mo)','err'); continue; }
    newB64.push(b64);
  }
  if(!newB64.length){ prog.style.display='none'; return; }
  const merged = [...existingImgs, ...newB64].slice(0,5);
  // Sauvegarder : images[] + image (legacy = 1ère)
  await fbUpdate('articles', catZoomId, {images: merged, image: merged[0]});
  catZoomImgIndex = existingImgs.length; // pointer sur la 1ère nouvellement ajoutée
  const updated = DB.articles.find(x=>x._id===catZoomId);
  if(updated){ updated.images=merged; updated.image=merged[0]; }
  zoomRenderGallery({...a, images:merged, image:merged[0]});
  prog.style.display='none';
  notify(`${newB64.length} illustration(s) ajoutée(s) ✓`);
};

window.supprimerImgCatalogueActuelle = async function(){
  if(!catZoomId) return;
  const a=DB.articles.find(x=>x._id===catZoomId); if(!a) return;
  const imgs=artImages(a);
  if(!imgs.length) return;
  if(!(await confirmDialog('Supprimer cette illustration ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true}))) return;
  const newImgs = imgs.filter((_,i)=>i!==catZoomImgIndex);
  catZoomImgIndex = Math.min(catZoomImgIndex, Math.max(0,newImgs.length-1));
  await fbUpdate('articles', catZoomId, {images:newImgs, image:newImgs[0]||''});
  a.images=newImgs; a.image=newImgs[0]||'';
  zoomRenderGallery(a);
  notify('Illustration supprimée');
};

// Compat legacy : récupérer tableau d'images depuis un article
function artImages(a){
  if(a.images && a.images.length) return a.images;
  if(a.image) return [a.image];
  return [];
}

// ══════════════════════════════════════════
//  PACKS — helpers stock
// ══════════════════════════════════════════
// Stock disponible d'un pack = floor(min(stock_composant / qte_requise))
function packStockDispo(a){
  if(a.type!=='pack') return a.stock;
  const comp = a.composition||[];
  if(!comp.length) return 0;
  return Math.floor(Math.min(...comp.map(c=>{
    const art=DB.articles.find(x=>x._id===c.articleId);
    return art ? Math.floor(art.stock / c.qte) : 0;
  })));
}

// ══════════════════════════════════════════
//  MODAL ARTICLE — type + pack + multi-images
// ══════════════════════════════════════════
let artEditImages = []; // tableau de base64 en cours d'édition
let artImageBase64 = null; // compat legacy (inutilisé si multi)

window.artSetType = function(type){
  document.getElementById('art-type').value=type;
  const isPack = type==='pack';
  document.getElementById('art-type-btn-article').style.cssText=`flex:1;padding:10px;border-radius:9px;border:2px solid ${isPack?'var(--border)':'var(--accent)'};background:${isPack?'transparent':'rgba(201,168,76,0.12)'};color:${isPack?'var(--muted)':'var(--accent)'};font-weight:700;font-size:13px;cursor:pointer;transition:all 0.15s;`;
  document.getElementById('art-type-btn-pack').style.cssText=`flex:1;padding:10px;border-radius:9px;border:2px solid ${isPack?'var(--warn)':'var(--border)'};background:${isPack?'rgba(201,168,76,0.12)':'transparent'};color:${isPack?'var(--warn)':'var(--muted)'};font-weight:700;font-size:13px;cursor:pointer;transition:all 0.15s;`;
  document.getElementById('art-pack-zone').style.display = isPack?'':'none';
  document.getElementById('art-stock-zone').style.display = isPack?'none':'';
  document.getElementById('art-stock-min-zone').style.display = isPack?'none':'';
};

window.packCompSearch = function(){
  const q=(document.getElementById('pack-comp-search').value||'').toLowerCase().trim();
  const res=document.getElementById('pack-comp-results');
  if(!q){ res.style.display='none'; return; }
  const editId = document.getElementById('art-edit-id').value;
  const found = DB.articles.filter(a=>
    a._id!==editId &&
    ((a.nom||'').toLowerCase().includes(q)||(a.ref||'').toLowerCase().includes(q))
  ).slice(0,7);
  if(!found.length){ res.style.display='block'; res.innerHTML='<div style="padding:10px;font-size:12px;color:var(--muted);">Aucun article trouvé.</div>'; return; }
  res.style.display='block';
  res.innerHTML=found.map(a=>`
    <div onclick="packAddComp('${a._id}','${esc(a.nom)}','${esc(a.ref||'')}')"
      style="padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"
      onmouseover="this.style.background='rgba(201,168,76,0.1)'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(a.nom)}</div>
        <div style="font-size:10px;color:var(--muted);">${a.ref?'Réf: '+esc(a.ref)+' · ':''}${esc(a.cat||'—')}</div>
      </div>
      <div style="font-size:11px;color:var(--accent2);font-weight:700;">Stock: ${a.stock}</div>
    </div>`
  ).join('');
};

let _packComposition = []; // [{articleId, nom, ref, qte}]

window.packAddComp = function(artId, nom, ref){
  document.getElementById('pack-comp-search').value='';
  document.getElementById('pack-comp-results').style.display='none';
  if(_packComposition.find(c=>c.articleId===artId)){ notify('Composant déjà ajouté','err'); return; }
  _packComposition.push({articleId:artId, nom, ref, qte:1});
  renderPackCompList();
};

window.packUpdateQte = function(artId, val){
  const c=_packComposition.find(x=>x.articleId===artId);
  if(c) c.qte=Math.max(1,parseInt(val)||1);
  renderPackCompList();
};

window.packRemoveComp = function(artId){
  _packComposition=_packComposition.filter(c=>c.articleId!==artId);
  renderPackCompList();
};

function renderPackCompList(){
  const el=document.getElementById('pack-comp-list');
  const info=document.getElementById('pack-comp-info');
  if(!_packComposition.length){
    el.innerHTML='<div style="font-size:12px;color:var(--muted);padding:8px 0;">Aucun composant ajouté.</div>';
    info.style.display='none'; return;
  }
  el.innerHTML=_packComposition.map(c=>`
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.nom)}</div>
        ${c.ref?`<div style="font-size:10px;color:var(--muted);">${esc(c.ref)}</div>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <label style="font-size:11px;color:var(--muted);">Qté</label>
        <input type="number" min="1" value="${c.qte}" onchange="packUpdateQte('${c.articleId}',this.value)"
          style="width:56px;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-weight:700;outline:none;text-align:center;">
        <button onclick="packRemoveComp('${c.articleId}')" style="background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.3);border-radius:6px;color:var(--danger);padding:4px 8px;font-size:11px;cursor:pointer;">✕</button>
      </div>
    </div>`
  ).join('');
  // Info stock dispo théorique
  const dispo=Math.floor(Math.min(..._packComposition.map(c=>{
    const art=DB.articles.find(x=>x._id===c.articleId);
    return art ? Math.floor(art.stock/c.qte) : 0;
  })));
  info.style.display='';
  info.innerHTML=`📦 Stock disponible théorique du pack : <strong style="color:${dispo>0?'var(--accent2)':'var(--danger)'};">${dispo} unité(s)</strong>`;
}

// Galerie éditable dans le modal article
function renderArtGalleryEdit(){
  const el=document.getElementById('art-gallery-edit');
  if(!el) return;
  if(!artEditImages.length){ el.innerHTML=''; return; }
  el.innerHTML=artEditImages.map((src,i)=>`
    <div style="position:relative;border-radius:9px;overflow:hidden;aspect-ratio:1;background:var(--surface2);">
      <img src="${src}" style="width:100%;height:100%;object-fit:cover;display:block;">
      ${i===0?'<div style="position:absolute;top:5px;left:5px;background:rgba(201,168,76,0.9);color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;">Principale</div>':''}
      <button onclick="artRemoveImg(${i})" style="position:absolute;top:5px;right:5px;background:rgba(0,0,0,0.6);border:none;border-radius:50%;width:22px;height:22px;color:#fff;font-size:12px;cursor:pointer;line-height:22px;text-align:center;">✕</button>
    </div>`
  ).join('');
  // Mettre à jour label du bouton d'ajout
  const addBtn=document.getElementById('art-img-add-btn');
  if(addBtn){
    const spans=addBtn.querySelectorAll('span:not(:first-child)');
    if(artEditImages.length>=5){
      addBtn.style.opacity='0.5'; addBtn.style.pointerEvents='none';
    } else {
      addBtn.style.opacity='1'; addBtn.style.pointerEvents='';
    }
  }
}

window.artRemoveImg = function(idx){
  artEditImages=artEditImages.filter((_,i)=>i!==idx);
  renderArtGalleryEdit();
};

window.chargerArtImages = async function(input){
  if(!input.files||!input.files.length) return;
  const remaining=5-artEditImages.length;
  if(remaining<=0){ notify('Maximum 5 illustrations atteint','err'); return; }
  const files=Array.from(input.files).slice(0,remaining);
  for(const f of files){
    const b64=await fileToBase64(f);
    if(!b64){ notify('Image trop grande (max 2 Mo)','err'); continue; }
    artEditImages.push(b64);
  }
  artEditImages=artEditImages.slice(0,5);
  renderArtGalleryEdit();
  input.value='';
};

// Legacy compat (gardé pour les anciens appels)
window.chargerArtImage = window.chargerArtImages;
window.supprimerArtImage = function(){ artEditImages=[]; renderArtGalleryEdit(); };
window.dropArtImage = function(e){
  e.preventDefault();
  document.getElementById('art-img-drop')?.classList?.remove('dragover');
  const f=e.dataTransfer?.files?.[0];
  if(f&&f.type.startsWith('image/')) chargerArtImages({files:[f]});
};

window.setArtView = function(mode){
  artViewMode = mode;
  document.getElementById('art-view-galerie').style.display = mode==='galerie' ? '' : 'none';
  document.getElementById('art-view-liste').style.display  = mode==='liste'   ? '' : 'none';
  document.getElementById('art-btn-galerie').classList.toggle('active', mode==='galerie');
  document.getElementById('art-btn-liste').classList.toggle('active', mode==='liste');
  renderArticles();
};

function renderArticles(){
  // ── Recherche ──
  const q = (document.getElementById('art-search')?.value||'').toLowerCase().trim();
  const qRef = (document.getElementById('art-filter-ref')?.value||'').toLowerCase().trim();
  // ── Tri ──
  const sort = document.getElementById('art-sort')?.value || 'nom';
  let arts = [...DB.articles];
  if(q) arts = arts.filter(a=>(a.nom||'').toLowerCase().includes(q)||(a.cat||'').toLowerCase().includes(q));
  if(qRef) arts = arts.filter(a=>(a.ref||'').toLowerCase().includes(qRef));
  arts.sort((a,b)=>{
    if(sort==='ref') return (a.ref||'').localeCompare(b.ref||'');
    if(sort==='pv_asc') return (a.pv||0)-(b.pv||0);
    if(sort==='pv_desc') return (b.pv||0)-(a.pv||0);
    if(sort==='stock_asc') return (a.stock||0)-(b.stock||0);
    if(sort==='stock_desc') return (b.stock||0)-(a.stock||0);
    return (a.nom||'').localeCompare(b.nom||'');
  });
  const isAdmin = ['admin','chef_agence'].includes(session?.role);

  // ── GALERIE ──
  document.getElementById('art-view-galerie').innerHTML = arts.length===0
    ? '<div class="emp" style="padding:40px;grid-column:1/-1;">Aucun article trouvé.</div>'
    : arts.map(a=>{
        const imgHtml = a.image
          ? `<img src="${a.image}" alt="${esc(a.nom)}" style="width:100%;height:140px;object-fit:cover;display:block;">`
          : `<div style="width:100%;height:140px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:48px;">${catEmoji(a.cat)}</div>`;
        const stockColor = a.stock<=0?'var(--danger)':a.stock<=a.stockMin?'var(--accent3)':'var(--accent2)';
        const adminBtns = isAdmin ? `
          <div style="display:flex;gap:4px;padding:6px 10px 8px;border-top:1px solid var(--border);" onclick="event.stopPropagation()">
            <button class="btn btn-ghost btn-xs" style="flex:1;" onclick="editArt('${a._id}')">✏️ Modifier</button>
            <button class="btn btn-xs btn-warn" onclick="delArt('${a._id}')">🗑</button>
          </div>` : '';
        const refBadge = a.ref ? `<span class="art-card-ref-badge">🏷️ ${esc(a.ref)}</span>` : `<span style="font-size:9px;color:var(--muted);font-style:italic;">Sans réf.</span>`;
        return `<div class="art-card" onclick="ouvrirArtModal('${a._id}')">
          ${imgHtml}
          <div class="art-card-body">
            <div style="margin-bottom:3px;">${refBadge}</div>
            <div class="art-card-nom" title="${esc(a.nom)}">${esc(a.nom)}</div>
            <div style="font-size:9.5px;color:var(--muted);margin-bottom:4px;">${esc(a.cat||'—')}</div>
            <div class="art-card-prix">${fmt(a.pv)}</div>
            <div class="art-card-stock" style="color:${stockColor}">Stock : ${a.stock} ${a.unite||'pcs'} ${stockStatut(a)}</div>
          </div>
          ${adminBtns}
        </div>`;
      }).join('');

  // ── LISTE ──
  document.getElementById('tb-articles').innerHTML = arts.map(a=>`<tr>
    <td style="width:46px;">
      ${a.image
        ? `<img src="${a.image}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="ouvrirArtModal('${a._id}')">`
        : `<div style="width:38px;height:38px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;" onclick="ouvrirArtModal('${a._id}')">${catEmoji(a.cat)}</div>`}
    </td>
    <td><span style="display:inline-block;background:rgba(201,168,76,0.13);border:1px solid rgba(201,168,76,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:var(--accent);font-weight:700;letter-spacing:0.3px;">${esc(a.ref)||'—'}</span></td><td class="fw6">${esc(a.nom)}</td><td class="tm">${esc(a.cat)}</td>
    <td class="fw6">${fmt(a.pv)}</td><td class="tm">${fmt(a.pa)}</td>
    <td><div style="font-weight:700;color:${a.stock<=0?'var(--danger)':a.stock<=a.stockMin?'var(--accent3)':'var(--accent2)'}">${a.stock} ${a.unite}</div><div class="stock-bar"><div class="stock-fill" style="width:${Math.min(100,a.stock*100/((a.stockMin*3)||1))}%;background:${a.stock<=0?'var(--danger)':a.stock<=a.stockMin?'var(--accent3)':'var(--accent2)'}"></div></div></td>
    <td class="tm">${a.stockMin}</td><td>${stockStatut(a)}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-ghost btn-xs" onclick="openMvtFor('${a._id}')" style="margin-right:3px"${['controleur'].includes(session?.role)?' hidden':''}>± Stock</button>
      ${isAdmin?`<button class="btn btn-ghost btn-xs" onclick="editArt('${a._id}')" style="margin-right:3px;">✏️</button><button class="btn btn-xs btn-warn" onclick="delArt('${a._id}')">🗑</button>`:''}
    </td>
  </tr>`).join('')||'<tr><td colspan="10" class="emp">Aucun article.</td></tr>';
}

function catEmoji(cat){
  const c=(cat||'').toLowerCase();
  if(c.includes('mob')||c.includes('cana')||c.includes('chais')) return '🛋️';
  if(c.includes('elec')||c.includes('tv')||c.includes('télé')) return '📺';
  if(c.includes('frigo')||c.includes('réfri')||c.includes('cong')) return '🧊';
  if(c.includes('cuisi')||c.includes('four')||c.includes('gas')) return '🍳';
  if(c.includes('info')||c.includes('ordi')||c.includes('pc')) return '💻';
  if(c.includes('télé')||c.includes('phone')||c.includes('mob')) return '📱';
  if(c.includes('linge')||c.includes('mach')) return '🫧';
  if(c.includes('clim')||c.includes('air')) return '❄️';
  return '📦';
}

let artImageModalId = null; // compat legacy

// ── Ouvrir modal image article → redirige vers zoom catalogue multi-images ──
window.ouvrirArtModal = function(artId){
  ouvrirZoomCatalogue(artId);
};

window.changerImageArticle = async function(input){
  if(!input.files[0]||!artImageModalId) return;
  const b64 = await fileToBase64(input.files[0]);
  if(!b64){ notify('Image trop grande (max 2 Mo)','err'); return; }
  await fbUpdate('articles', artImageModalId, {image: b64});
  document.getElementById('art-img-modal-img').src = b64;
  document.getElementById('art-img-modal-img').style.display = '';
  notify('Image mise à jour ✓');
};

window.supprimerImageArticle = async function(){
  if(!artImageModalId) return;
  if(!(await confirmDialog("Supprimer l'image de cet article ?",{title:'🗑 Suppression',okLabel:'Supprimer',danger:true}))) return;
  await fbUpdate('articles', artImageModalId, {image:''});
  document.getElementById('art-img-modal-img').src='';
  document.getElementById('art-img-modal-img').style.display='none';
  notify('Image supprimée');
};


function fileToBase64(file){
  return new Promise(res=>{
    if(file.size>2.5*1024*1024){res(null);return;}
    const r=new FileReader();
    r.onload=e=>res(e.target.result);
    r.onerror=()=>res(null);
    r.readAsDataURL(file);
  });
}

function renderStock(){
  document.getElementById('stock-kpi').innerHTML=`
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Articles</div><div class="kpi-val kv-blue">${DB.articles.length}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Ruptures</div><div class="kpi-val kv-red">${DB.articles.filter(a=>a.stock<=0).length}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Stock bas</div><div class="kpi-val kv-yellow">${DB.articles.filter(a=>a.stock>0&&a.stock<=a.stockMin).length}</div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">Mouvements</div><div class="kpi-val kv-green">${DB.stockMvts.length}</div></div>`;
  renderStockMvts();
  // Peupler le filtre agences (une seule fois)
  const selAg = document.getElementById('stock-agence-filter');
  if(selAg && selAg.options.length <= 1){
    DB.agences.forEach(ag=>{
      const o=document.createElement('option');
      o.value=ag._id; o.textContent='🏢 '+ag.nom;
      selAg.appendChild(o);
    });
    if(session.role===ROLES.GESTIONNAIRE_STOCK){
      const agId=sessionAgenceId();
      if(agId) selAg.value=agId;
    }
  }
  renderStockParAgence();
  renderInventaire();
}

// ─── Rendu filtrable du tableau de mouvements ───
window.renderStockMvts = function(){
  const q = (document.getElementById('stock-mvt-search')?.value||'').toLowerCase().trim();
  const filtType = document.getElementById('stock-mvt-filter-type')?.value||'';
  let mvts = [...DB.stockMvts].reverse();
  if(filtType) mvts = mvts.filter(m=>m.type===filtType);
  if(q) mvts = mvts.filter(m=>{
    const a=getArt(m.articleId);
    return (a.nom||'').toLowerCase().includes(q)||
      (m.note||'').toLowerCase().includes(q)||
      (m.destinationNom||'').toLowerCase().includes(q)||
      (m.destinationLibre||'').toLowerCase().includes(q);
  });
  const countEl = document.getElementById('stock-mvt-count');
  if(countEl) countEl.textContent = `(${mvts.length} / ${DB.stockMvts.length})`;
  document.getElementById('tb-stock-mvt').innerHTML=mvts.map(m=>{
    const a=getArt(m.articleId);
    const destLabel = m.type==='sortie'
      ? (m.destinationNom ? `<span style="background:rgba(224,92,82,0.15);border:1px solid rgba(224,92,82,0.3);border-radius:5px;padding:2px 7px;font-size:10px;color:var(--danger);">🏢 ${esc(m.destinationNom)}</span>`
        : m.destinationLibre ? `<span style="font-size:11px;color:var(--warn);">✏️ ${esc(m.destinationLibre)}</span>`
        : '<span style="color:var(--muted);font-size:10px;">—</span>')
      : '<span style="color:var(--muted);font-size:10px;">—</span>';
    return`<tr>
      <td>${m.date}</td>
      <td class="fw6">${esc(a.nom)}</td>
      <td>${m.type==='entree'?sb('📥 Entrée','sg'):sb('📤 Sortie','sr')}</td>
      <td style="font-weight:700;color:${m.type==='entree'?'var(--accent2)':'var(--danger)'}">${m.type==='entree'?'+':'-'}${m.qty} ${esc(a.unite)}</td>
      <td class="fw6">${m.stockApres} ${esc(a.unite)}</td>
      <td>${destLabel}</td>
      <td class="tm" style="font-size:11px">${esc(m.note||'—')}</td>
    </tr>`;
  }).join('')||'<tr><td colspan="7" class="emp">Aucun mouvement</td></tr>';
};

// ─── Collapse/expand mouvements ───
let _stockMvtCollapsed = false;
window.toggleStockMvt = function(){
  _stockMvtCollapsed = !_stockMvtCollapsed;
  const panel = document.getElementById('stock-mvt-panel');
  const chev  = document.getElementById('stock-mvt-chevron');
  if(panel) panel.style.display = _stockMvtCollapsed ? 'none' : '';
  if(chev)  chev.style.transform = _stockMvtCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
};

// ─── Affichage conditionnel destination selon type ───
window.mvtOnTypeChange = function(){
  const type = document.getElementById('mvt-type').value;
  const zone = document.getElementById('mvt-destination-zone');
  if(zone) zone.style.display = type==='sortie' ? '' : 'none';
  if(type!=='sortie'){
    const sel=document.getElementById('mvt-dest-agence'); if(sel) sel.value='';
    const lib=document.getElementById('mvt-dest-libre'); if(lib){lib.value='';lib.style.display='none';}
  }
};

// ─── Afficher champ libre si "Autre motif" ───
window.mvtOnDestChange = function(){
  const sel = document.getElementById('mvt-dest-agence');
  const lib = document.getElementById('mvt-dest-libre');
  if(!lib) return;
  lib.style.display = sel.value==='__autre__' ? '' : 'none';
  if(sel.value!=='__autre__') lib.value='';
};

// ═══ RECHERCHE ARTICLE DANS LE MODAL MOUVEMENT ═══
window.mvtArtLiveSearch = function(){
  const q = (document.getElementById('mvt-art-search').value||'').trim().toLowerCase();
  const res = document.getElementById('mvt-art-results');
  if(!q){ res.style.display='none'; return; }
  const found = DB.articles.filter(a=>
    (a.nom||'').toLowerCase().includes(q) ||
    (a.ref||'').toLowerCase().includes(q) ||
    (a.cat||'').toLowerCase().includes(q)
  ).slice(0,8);
  if(!found.length){
    res.style.display='block';
    res.innerHTML='<div style="padding:10px;font-size:12px;color:var(--muted);">Aucun article trouvé.</div>';
    return;
  }
  res.style.display='block';
  res.innerHTML=found.map(a=>{
    const stockColor = a.stock<=0?'var(--danger)':a.stock<=(a.stockMin||0)?'var(--warn)':'var(--accent2)';
    return `<div onclick="mvtSelectArt(${JSON.stringify({_id:a._id,nom:a.nom,ref:a.ref||'',stock:a.stock,unite:a.unite||'pcs',stockMin:a.stockMin||0}).replace(/"/g,'&quot;')})"
      style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;transition:background 0.12s;"
      onmouseover="this.style.background='rgba(212,137,58,0.1)'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:700;font-size:13px;">${esc(a.nom)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${a.ref?`<span style="color:var(--accent);font-weight:600;">Réf: ${esc(a.ref)}</span> · `:''} ${esc(a.cat||'—')}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:13px;font-weight:800;color:${stockColor};">${a.stock} ${esc(a.unite||'pcs')}</div>
        <div style="font-size:10px;color:var(--muted);">en stock</div>
      </div>
    </div>`;
  }).join('');
};

window.mvtSelectArt = function(art){
  // art peut être un objet ou une string JSON
  if(typeof art === 'string') art = JSON.parse(art);
  document.getElementById('mvt-art').value = art._id;
  document.getElementById('mvt-art-search').style.display='none';
  document.getElementById('mvt-art-results').style.display='none';
  const stockColor = art.stock<=0?'var(--danger)':art.stock<=(art.stockMin||0)?'var(--warn)':'var(--accent2)';
  document.getElementById('mvt-art-sel-nom').textContent = art.nom;
  document.getElementById('mvt-art-sel-info').innerHTML =
    `${art.ref?`Réf: <strong style="color:var(--accent)">${esc(art.ref)}</strong> &nbsp;·&nbsp; `:''}Stock actuel : <strong style="color:${stockColor}">${art.stock} ${esc(art.unite||'pcs')}</strong>${art.stockMin>0?` &nbsp;·&nbsp; Min: ${art.stockMin}`:''}`;
  document.getElementById('mvt-art-selected').style.display='flex';
};

window.mvtClearArt = function(){
  document.getElementById('mvt-art').value='';
  document.getElementById('mvt-art-search').value='';
  document.getElementById('mvt-art-search').style.display='';
  document.getElementById('mvt-art-results').style.display='none';
  document.getElementById('mvt-art-selected').style.display='none';
  document.getElementById('mvt-art-search').focus();
};

// ═══ STOCK PAR AGENCE ═══
window.renderStockParAgence = function(){
  const wrap = document.getElementById('stock-par-agence-wrap');
  if(!wrap) return;
  const filtAgId = document.getElementById('stock-agence-filter')?.value || '';
  let agences = DB.agences.length ? [...DB.agences] : [];
  if(filtAgId) agences = agences.filter(ag=>ag._id===filtAgId);
  if(session.role===ROLES.GESTIONNAIRE_STOCK){
    const agId=sessionAgenceId();
    if(agId) agences = agences.filter(ag=>ag._id===agId);
  }
  if(!agences.length){
    wrap.innerHTML='<div style="padding:14px;color:var(--muted);font-size:13px;">Aucune agence disponible.</div>';
    return;
  }
  wrap.innerHTML = agences.map(ag=>{
    const comIds = DB.commerciaux.filter(c=>c.agenceId===ag._id).map(c=>c._id);
    const clIds  = DB.clients.filter(c=>comIds.includes(c.commercialId)).map(c=>c._id);

    // ── Sorties de stock vers cette agence (via mouvements manuels) ──
    const sortiesVersAgence = DB.stockMvts.filter(m=>m.type==='sortie' && m.destinationId===ag._id);
    const sortiesMap = {}; // articleId => qty envoyée
    sortiesVersAgence.forEach(m=>{ sortiesMap[m.articleId]=(sortiesMap[m.articleId]||0)+m.qty; });

    // ── Livraisons confirmées de cette agence (décomposées produit → articles) ──
    const livs = DB.livraisons.filter(l=>clIds.includes(l.clientId) && l.statut==='livre');
    const livsMap = {}; // articleId => qty livrée (équivalent articles consommés)
    livs.forEach(l=>{
      const prod = (DB.produits||[]).find(p=>p._id===l.produitId);
      (prod?.composition||[]).forEach(c=>{
        livsMap[c.articleId] = (livsMap[c.articleId]||0) + (c.qte*l.qty);
      });
    });

    // ── Fusionner : articles concernés par envoi OU livraison ──
    const artIdsConcernes = new Set([...Object.keys(sortiesMap), ...Object.keys(livsMap)]);

    const rows = [...artIdsConcernes].map(aid=>{
      const a = DB.articles.find(x=>x._id===aid);
      if(!a) return null;
      const envoye  = sortiesMap[aid]||0;
      const livre   = livsMap[aid]||0;
      const restant = envoye - livre; // reste dans l'agence (pas encore livré au client)
      const stockColor = a.stock<=0?'var(--danger)':a.stock<=(a.stockMin||0)?'var(--warn)':'var(--accent2)';
      const restantColor = restant>0?'var(--accent)':restant===0?'var(--muted)':'var(--danger)';
      return `<tr>
        <td><span class="tag">${esc(a.ref||'—')}</span></td>
        <td class="fw6">${esc(a.nom)}</td>
        <td style="font-weight:700;color:var(--warn);">${envoye} ${esc(a.unite||'pcs')}</td>
        <td style="font-weight:700;color:var(--accent2);">${livre} ${esc(a.unite||'pcs')}</td>
        <td style="font-weight:800;color:${restantColor};">${restant} ${esc(a.unite||'pcs')}</td>
        <td style="font-weight:700;color:${stockColor};">${a.stock} ${esc(a.unite||'pcs')}</td>
      </tr>`;
    }).filter(Boolean).join('');

    const totalEnvoyes = Object.keys(sortiesMap).length;
    const totalLivres  = Object.keys(livsMap).length;
    return `<div style="background:var(--surface);border:1px solid rgba(212,137,58,0.2);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
        <div style="width:38px;height:38px;border-radius:9px;background:rgba(212,137,58,0.15);border:1px solid rgba(212,137,58,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏢</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;color:var(--text);">${esc(ag.nom)}</div>
          <div style="font-size:11px;color:var(--muted);">${esc(ag.ville||'')} &nbsp;·&nbsp; ${comIds.length} commercial(aux) &nbsp;·&nbsp; ${clIds.length} client(s)</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <div style="background:rgba(212,137,58,0.1);border:1px solid rgba(212,137,58,0.3);border-radius:8px;padding:6px 14px;text-align:center;">
            <div style="font-size:16px;font-weight:800;color:var(--warn);">${totalEnvoyes}</div>
            <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">art. envoyés</div>
          </div>
          <div style="background:rgba(56,201,160,0.08);border:1px solid rgba(56,201,160,0.25);border-radius:8px;padding:6px 14px;text-align:center;">
            <div style="font-size:16px;font-weight:800;color:var(--accent2);">${totalLivres}</div>
            <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">art. livrés</div>
          </div>
        </div>
      </div>
      ${rows
        ? `<div class="tw" style="margin:0;">
             <table><thead><tr>
               <th>Réf.</th><th>Article</th>
               <th style="color:var(--warn);">📤 Envoyé</th>
               <th style="color:var(--accent2);">✅ Livré clients</th>
               <th style="color:var(--accent);">📦 Restant agence</th>
               <th>Stock global</th>
             </tr></thead><tbody>${rows}</tbody></table>
           </div>`
        : '<div style="font-size:12px;color:var(--muted);padding:8px 0;">Aucune sortie de stock ni livraison pour cette agence.</div>'}
    </div>`;
  }).join('');
};

// ═══ INVENTAIRE GÉNÉRAL ═══
window.renderInventaire = function(){
  const q = (document.getElementById('inv-search')?.value||'').toLowerCase().trim();
  const filtStatut = document.getElementById('inv-filter-statut')?.value||'';
  let arts = [...DB.articles];
  if(q) arts = arts.filter(a=>(a.nom||'').toLowerCase().includes(q)||(a.ref||'').toLowerCase().includes(q)||(a.cat||'').toLowerCase().includes(q));
  if(filtStatut==='ok') arts = arts.filter(a=>a.stock>0&&(a.stock>(a.stockMin||0)));
  if(filtStatut==='bas') arts = arts.filter(a=>a.stock>0&&a.stock<=(a.stockMin||0));
  if(filtStatut==='rupture') arts = arts.filter(a=>a.stock<=0);
  // KPI inventaire
  const total = DB.articles.length;
  const enStock = DB.articles.filter(a=>a.stock>0&&a.stock>(a.stockMin||0)).length;
  const bas = DB.articles.filter(a=>a.stock>0&&a.stock<=(a.stockMin||0)).length;
  const rupture = DB.articles.filter(a=>a.stock<=0).length;
  const invKpi = document.getElementById('inv-kpi-row');
  if(invKpi) invKpi.innerHTML=`
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Total articles</div><div class="kpi-val kv-blue">${total}</div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">En stock</div><div class="kpi-val kv-green">${enStock}</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Stock bas</div><div class="kpi-val kv-yellow">${bas}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Rupture</div><div class="kpi-val kv-red">${rupture}</div></div>`;
  const tbody = document.getElementById('tb-inventaire');
  if(!tbody) return;
  tbody.innerHTML = arts.sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(a=>{
    const stockColor = a.stock<=0?'var(--danger)':a.stock<=(a.stockMin||0)?'var(--warn)':'var(--accent2)';
    const statut = a.stock<=0
      ? `<span class="sb sr">🔴 Rupture</span>`
      : a.stock<=(a.stockMin||0)
        ? `<span class="sb sy">⚠️ Stock bas</span>`
        : `<span class="sb sg">✅ OK</span>`;
    return `<tr>
      <td><span class="tag">${esc(a.ref||'—')}</span></td>
      <td class="fw6">${esc(a.nom)}</td>
      <td class="tm">${esc(a.cat||'—')}</td>
      <td style="font-weight:800;font-size:14px;color:${stockColor};">${a.stock}</td>
      <td style="color:var(--muted);">${a.stockMin||0}</td>
      <td style="color:var(--muted);">${esc(a.unite||'pcs')}</td>
      <td>${statut}</td>
    </tr>`;
  }).join('')||'<tr><td colspan="7" class="emp">Aucun article trouvé.</td></tr>';
};

function renderLivraisons(){
  // Afficher le bouton "+ Livraison" uniquement pour admin et secrétaire
  const btnLivInline = document.querySelector('#page-livraisons .btn-primary.btn-sm');
  if(btnLivInline) btnLivInline.style.display = ['admin','secretaire'].includes(session?.role) ? '' : 'none';

  // ── Peupler select agences (admin uniquement, une seule fois) ──
  const selAgence = document.getElementById('filter-liv-agence');
  if(selAgence){
    const isAdmin = session?.role ===ROLES.ADMIN;
    selAgence.parentElement.style.display = isAdmin ? '' : 'none';
    if(isAdmin && selAgence.options.length <= 1){
      DB.agences.forEach(ag => {
        const opt = document.createElement('option');
        opt.value = ag._id; opt.textContent = '🏢 ' + ag.nom;
        selAgence.appendChild(opt);
      });
    }
  }
  // ── Barre de filtres : visible pour tous les rôles ayant accès aux livraisons ──
  const barreFiltre = document.querySelector('#page-livraisons .liv-filtres-bar');
  if(barreFiltre) barreFiltre.style.display = '';

  // ── Peupler select commerciaux selon agence sélectionnée ──
  const selCom = document.getElementById('filter-liv-com');
  const agId = selAgence?.value || '';
  // Tous les membres du staff de l'agence (tous rôles confondus) — sert au filtre agence,
  // car une livraison peut être saisie par un commercial, une secrétaire ou un chef d'agence.
  const staffAgenceTous = agId
    ? DB.commerciaux.filter(c => c.agenceId === agId)
    : comsDansAgence();
  // Sous-ensemble "commercial" uniquement — sert seulement à peupler le select de choix.
  const comsSource = staffAgenceTous.filter(c => c.role ===ROLES.COMMERCIAL);
  const prevCom = selCom?.value || '';
  if(selCom){
    selCom.innerHTML = '<option value="">Tous les commerciaux</option>' +
      comsSource.map(c => `<option value="${esc(c._id)}"${c._id===prevCom?' selected':''}>${esc(c.nom)}${c.zone?' — '+esc(c.zone):''}</option>`).join('');
  }

  // ── Peupler select produits (une seule fois) ──
  const selArt = document.getElementById('filter-liv-article');
  if(selArt && selArt.options.length <= 1){
    (DB.produits||[]).filter(p=>p.nom).sort((a,b)=>a.nom.localeCompare(b.nom)).forEach(p=>{
      const opt = document.createElement('option');
      opt.value = p._id; opt.textContent = p.nom;
      selArt.appendChild(opt);
    });
  }

  // ── Lecture des filtres ──
  const q       = (document.getElementById('search-liv-cl')?.value || '').toLowerCase().trim();
  const filtDate   = document.getElementById('filter-liv-date')?.value   || '';
  const filtComId  = selCom?.value || '';
  const filtStatut = document.getElementById('filter-liv-statut')?.value || '';
  const filtArticleId = selArt?.value || '';
  const filtArtCode = (document.getElementById('filter-liv-art-code')?.value || '').trim().toLowerCase();

  // ── Base de livraisons (filtrée par agence de session) ──
  let livs = livraisonsDansAgence();

  // Appliquer filtre agence (admin seulement) — ⚠️ IMPORTANT : on filtre sur
  // l'agence DU CLIENT livré, pas sur le commercialId enregistré dans la
  // livraison. Ce dernier correspond à la personne qui a SAISI la livraison
  // (souvent l'admin/secrétaire), qui n'appartient à aucune agence — filtrer
  // dessus faisait disparaître à tort toutes les livraisons saisies par un
  // admin/secrétaire, alors que le client livré appartient bel et bien à
  // l'agence sélectionnée.
  if(agId){
    const clientIdsAgence = new Set(
      DB.clients.filter(c => {
        const com = DB.commerciaux.find(cc => cc._id === c.commercialId);
        return com && com.agenceId === agId;
      }).map(c => c._id)
    );
    livs = livs.filter(l => clientIdsAgence.has(l.clientId));
  }

  // Filtre date
  if(filtDate) livs = livs.filter(l => l.date === filtDate);

  // Filtre commercial
  if(filtComId) livs = livs.filter(l => l.commercialId === filtComId);

  // Filtre statut
  if(filtStatut) livs = livs.filter(l => l.statut === filtStatut);

  // Filtre article
  if(filtArticleId) livs = livs.filter(l => l.produitId === filtArticleId);
  if(filtArtCode) livs = livs.filter(l => {
    const prod = getProdOuArticle(l.produitId);
    return prod && (prod.ref||'').toLowerCase().includes(filtArtCode);
  });

  // Filtre recherche texte (client)
  if(q){
    const matchIds = clientsDansAgence().filter(c =>
      c.nom.toLowerCase().includes(q) ||
      (c.codeClient && c.codeClient.toLowerCase().includes(q)) ||
      (c.tel || '').includes(q)
    ).map(c => c._id);
    livs = livs.filter(l => matchIds.includes(l.clientId));
  }

  livs = [...livs].sort((a,b) => (b.date||'').localeCompare(a.date||''));

  // ── KPI (sur la base filtrée) ──
  const allLivs = livraisonsDansAgence();
  document.getElementById('liv-kpi').innerHTML=`
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">En attente</div><div class="kpi-val kv-yellow">${allLivs.filter(l=>l.statut==='en_attente').length}</div><div class="kpi-sub">total</div></div>
    <div class="kpi-card kc-green"><div class="kpi-lbl">Livrées</div><div class="kpi-val kv-green">${allLivs.filter(l=>l.statut==='livre').length}</div><div class="kpi-sub">total</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Résultat filtre</div><div class="kpi-val kv-blue">${livs.length}</div><div class="kpi-sub">sur ${allLivs.length} total</div></div>`;

  // ── Label filtres actifs ──
  const labelEl = document.getElementById('liv-filtre-label');
  if(labelEl){
    const parts = [];
    if(filtDate){ const ds = new Date(filtDate+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'}); parts.push(`📅 ${ds}`); }
    if(agId){ const ag = DB.agences.find(a=>a._id===agId); if(ag) parts.push(`🏢 ${esc(ag.nom)}`); }
    if(filtComId){ const com = DB.commerciaux.find(c=>c._id===filtComId); if(com) parts.push(`👤 ${esc(com.nom)}`); }
    if(filtStatut){ parts.push(filtStatut==='en_attente'?'⏳ En attente':filtStatut==='livre'?'✅ Livrées':'❌ Annulées'); }
    if(filtArticleId){ const prod = (DB.produits||[]).find(p=>p._id===filtArticleId); if(prod) parts.push(`📦 ${esc(prod.nom)}`); }
    if(filtArtCode){ parts.push(`🏷️ Code: ${esc(filtArtCode.toUpperCase())}`); }
    if(q) parts.push(`🔍 "${q}"`);
    labelEl.innerHTML = parts.length
      ? `<span style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.2);border-radius:6px;padding:3px 10px;">Filtres actifs : ${parts.join(' · ')}</span>`
      : '';
  }

  // ── Tableau ──
  document.getElementById('tb-livraisons').innerHTML=livs.map(l=>{
    const c=getCl(l.clientId),a=getProd(l.produitId),com=getCom(l.commercialId);
    return`<tr><td>${esc(l.date)}</td><td class="fw6">${esc(c.nom)}${c.codeClient?`<div style="font-size:9px;color:var(--accent);font-weight:700;">${esc(c.codeClient)}</div>`:''}</td>
    <td><span class="tag">${esc(com.nom)}</span></td>
    <td style="font-size:11px">${esc(a.nom)}</td><td>${l.qty}</td><td>${fmt(l.montant)}</td><td>${livStatut(l.statut)}</td>
    <td>${(l.statut==='en_attente'&&['admin','secretaire'].includes(session.role))?`<button class="btn btn-success btn-xs" onclick="marquerLivre('${l._id}')" style="margin-right:3px">✓ Livré</button>`:''}
    ${(session.role===ROLES.ADMIN||(session.role===ROLES.SECRETAIRE&&l.date===TODAY))?`<button class="btn btn-xs btn-warn" onclick="delLiv('${l._id}')">✕</button>`:livStatut(l.statut)}</td></tr>`;
  }).join('')||`<tr><td colspan="8" class="emp">${(q||filtDate||filtComId||filtStatut||agId)?'Aucune livraison pour ces filtres':'Aucune livraison'}</td></tr>`;
}

window.livChangerDate = function(delta){
  const el = document.getElementById('filter-liv-date');
  if(!el) return;
  const val = el.value || TODAY;
  const d = new Date(val + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  el.value = d.toISOString().split('T')[0];
  renderLivraisons();
};

window.livAujourdhui = function(){
  const el = document.getElementById('filter-liv-date');
  if(el) el.value = TODAY;
  renderLivraisons();
};

window.livOnAgenceChange = function(){
  // Réinitialiser le filtre commercial quand on change d'agence
  const selCom = document.getElementById('filter-liv-com');
  if(selCom) selCom.value = '';
  renderLivraisons();
};

window.livResetFiltres = function(){
  const ids = ['search-liv-cl','filter-liv-date','filter-liv-agence','filter-liv-com','filter-liv-statut','filter-liv-article','filter-liv-art-code'];
  ids.forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderLivraisons();
};

// Appelé quand le select commercial ou la recherche change
window.onClFilterChange = function(){
  const comVal = document.getElementById('filter-com')?.value || '';
  const q = (document.getElementById('search-clients')?.value || '').trim();
  const hasFilter = comVal || q.length >= 2;
  const prompt = document.getElementById('cl-prompt');
  const tableau = document.getElementById('tw-clients');
  if(!hasFilter){
    if(prompt) prompt.style.display='flex';
    if(tableau) tableau.style.display='none';
    const countEl = document.getElementById('search-clients-count');
    if(countEl) countEl.textContent = '';
    return;
  }
  if(prompt) prompt.style.display='none';
  if(tableau) tableau.style.display='';
  _clPage = 1; // nouveau filtre/recherche : revenir à la première page
  renderTousCls();
};

let _clientsLazyLoadToken = 0;
// ─── Pagination UI de la liste "Clients" (voir renderTousCls) ───
// ✅ PERF (point 2, option A) : réduit de 100 à 50 lignes par page — moins de
// nœuds DOM injectés à chaque rendu/changement de filtre, sans changement
// structurel (pas de virtualisation par fenêtre, juste un pas de pagination
// plus fin). Ajuster ce chiffre est sans risque de casse visuelle.
const _CL_PAGE_SIZE = 50;
let _clPage = 1;
window.clientsChangerPage = function(delta){
  _clPage += delta;
  if (_clPage < 1) _clPage = 1;
  renderTousCls();
};
async function renderTousCls(){
  // ── FIX PERFORMANCE : 'clients' (jusqu'à 30 000 docs) n'est plus chargé
  // automatiquement à l'ouverture de la page — seulement ici, la première
  // fois qu'une recherche/filtre est réellement utilisé(e). Grâce au cache
  // (_CACHE_TTL_MS), les recherches suivantes ne re-téléchargent rien.
  const myToken = ++_clientsLazyLoadToken;
  const tb = document.getElementById('tb-tous-cl');
  if (tb && !DB.clients?.length) tb.innerHTML = '<tr><td colspan="9" class="emp">⏳ Chargement des clients…</td></tr>';
  try {
    await ensureCollectionsLoaded(['clients']);
  } catch(e) {
    if (tb) tb.innerHTML = `<tr><td colspan="9" class="emp">Erreur de chargement : ${esc(e.message||String(e))}</td></tr>`;
    return;
  }
  if (myToken !== _clientsLazyLoadToken) return; // une recherche plus récente a été lancée

  const sel=document.getElementById('filter-com');
  // Remplir le select commercial — uniquement des commerciaux (pas chef d'agence/secrétaire/contrôleur)
  const comsVisibles = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
  // ✅ PERF : reconstruire ce <select> (innerHTML) est inutile si la liste des
  // commerciaux visibles n'a pas changé depuis le dernier rendu — or ce code
  // s'exécute à CHAQUE frappe dans le champ de recherche clients, alors que
  // seule la liste des commerciaux (rarement modifiée) devrait déclencher
  // une reconstruction. On compare une signature simple (ids concaténés) et
  // on ne touche au DOM que si elle a changé.
  const comsSig = comsVisibles.map(c=>c._id).join(',');
  const prevVal = sel.value;
  if (sel.dataset.comsSig !== comsSig) {
    sel.innerHTML=`<option value="">— Sélectionner un commercial —</option>`+comsVisibles.map(c=>`<option value="${c._id}"${c._id===prevVal?' selected':''}>${esc(c.nom)}</option>`).join('');
    sel.value = prevVal; // restaurer
    sel.dataset.comsSig = comsSig;
  }

  const q=(document.getElementById('search-clients')?.value||'').toLowerCase().trim();
  let cls=clientsDansAgence();
  if(sel.value) cls=cls.filter(c=>c.commercialId===sel.value);
  if(q) cls=cls.filter(c=>
    (c.codeClient&&c.codeClient.toLowerCase().includes(q))||
    c.nom.toLowerCase().includes(q)||
    (c.tel||'').includes(q)||
    (c.contrat||'').toLowerCase().includes(q)||
    (c.ville||'').toLowerCase().includes(q)||
    (c.quartier||'').toLowerCase().includes(q)
  );
  // ── Tri ──
  const sortVal = (document.getElementById('sort-clients')?.value) || 'nom-asc';
  // ✅ PERF : pour les tris basés sur stats(), pré-calculer une seule fois
  // par client (via une Map) au lieu d'appeler stats(a)/stats(b) à chaque
  // comparaison du .sort() (O(n log n) appels sinon, contre O(n) ici).
  let _sortStatsMap = null;
  if (sortVal === 'retard-desc' || sortVal === 'cotis-desc') {
    _sortStatsMap = new Map(cls.map(c => [c._id, stats(c)]));
  }
  cls = [...cls].sort((a,b)=>{
    switch(sortVal){
      case 'nom-asc':   return (a.nom||'').localeCompare(b.nom||'','fr',{sensitivity:'base'});
      case 'nom-desc':  return (b.nom||'').localeCompare(a.nom||'','fr',{sensitivity:'base'});
      case 'id-asc':    return (a.codeClient||a._id||'').localeCompare(b.codeClient||b._id||'');
      case 'id-desc':   return (b.codeClient||b._id||'').localeCompare(a.codeClient||a._id||'');
      case 'date-asc':  return (a.createdAt||a._id||'').localeCompare(b.createdAt||b._id||'');
      case 'date-desc': return (b.createdAt||b._id||'').localeCompare(a.createdAt||a._id||'');
      case 'retard-desc':{ const sa=_sortStatsMap.get(a._id); const sb2=_sortStatsMap.get(b._id); return sb2.joursRetard-sa.joursRetard; }
      case 'cotis-desc':{ const sa=_sortStatsMap.get(a._id); const sb2=_sortStatsMap.get(b._id); return sb2.m-sa.m; }
      default: return 0;
    }
  });
  const countEl=document.getElementById('search-clients-count');
  if(countEl) countEl.textContent=`${cls.length} client(s)`;

  // ✅ PAGINATION UI : avec jusqu'à 30 000 clients, générer TOUTES les lignes
  // <tr> d'un coup peut créer des milliers de nœuds DOM en une seule passe
  // (lent à afficher, lent à scroller). On découpe l'affichage en pages de
  // _CL_PAGE_SIZE lignes ; la liste filtrée/triée `cls` reste en mémoire,
  // seule la page courante est effectivement rendue dans le DOM.
  const totalPages = Math.max(1, Math.ceil(cls.length / _CL_PAGE_SIZE));
  if (_clPage > totalPages) _clPage = totalPages;
  if (_clPage < 1) _clPage = 1;
  const startIdx = (_clPage - 1) * _CL_PAGE_SIZE;
  const clsPage = cls.slice(startIdx, startIdx + _CL_PAGE_SIZE);

  const pagEl = document.getElementById('cl-pagination');
  const pageInfoEl = document.getElementById('cl-page-info');
  if (pagEl) pagEl.style.display = cls.length > _CL_PAGE_SIZE ? 'flex' : 'none';
  if (pageInfoEl) pageInfoEl.textContent = `Page ${_clPage} / ${totalPages} (${startIdx+1}–${Math.min(startIdx+_CL_PAGE_SIZE, cls.length)} sur ${cls.length})`;
  const prevBtn = document.getElementById('cl-page-prev');
  const nextBtn = document.getElementById('cl-page-next');
  if (prevBtn) prevBtn.disabled = _clPage <= 1;
  if (nextBtn) nextBtn.disabled = _clPage >= totalPages;

  document.getElementById('tb-tous-cl').innerHTML=clsPage.map(c=>{
    const s=stats(c);
    return`<tr>
      <td style="text-align:center;">
        ${['admin','chef_agence'].includes(session.role)?`<input type="checkbox" class="cl-row-check" data-id="${c._id}"
          style="width:14px;height:14px;accent-color:var(--danger);cursor:pointer;"
          onchange="mettreAJourSelectionBar()">`:''}
      </td>
      <td class="fw6">${esc(c.nom)}<div class="tm" style="font-size:10px">${esc(c.ville||'')} · ${esc(c.quartier||'')}</div>${c.codeClient?`<span style="font-size:9.5px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.4);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">${esc(c.codeClient)}</span>`:''}${c.statutContrat==='resilie'?`<span class="resilie-badge" style="font-size:9px;margin-left:5px;">RÉSILIÉ</span>`:''}</td>
      <td>${esc(c.tel||'—')}</td><td><span class="tag">${esc(getCom(c.commercialId).nom)}</span></td>
      <td>${c.adhesionStatut==='paye'?sb('Payée','sg'):sb('Non payée','sr')}<div class="tm" style="font-size:10px">${fmt(c.adhesion)}</div></td>
      <td style="font-size:11px">${(()=>{
        if(c.contratArticles&&c.contratArticles.length){
          return c.contratArticles.map(a=>{
            const art=getProdOuArticle(a.artId);
            const ref=art&&art.ref?art.ref:(a.nom||'?');
            const qty=parseInt(a.qty)||1;
            const label=qty>1?`${ref} x${qty}`:ref;
            return`<span style="display:inline-block;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.35);border-radius:4px;padding:1px 6px;font-size:9.5px;font-weight:700;color:var(--accent);margin:1px 2px 1px 0;white-space:nowrap;">${esc(label)}</span>`;
          }).join('<span style="color:var(--muted);font-size:9px;margin:0 1px;">+</span>');
        }
        return esc(c.contrat||'—');
      })()}</td>
      <td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(s.m)}</span></td>
      <td><div class="pgw"><div class="pgb" style="width:${s.pct}%"></div></div><div style="font-size:10px;color:var(--muted)">${s.pct}%</div></td>
      <td style="color:${s.joursRetard>0?'var(--danger)':'var(--accent2)'};font-weight:600;font-size:11px">${s.joursRetard>0?s.joursRetard+'j':'✓'}</td>
      <td style="display:flex;gap:3px;flex-wrap:wrap;">
        ${session.role===ROLES.ADMIN||session.role===ROLES.COMMERCIAL||session.role===ROLES.CHEF_AGENCE?`<button class="btn btn-success btn-xs" onclick="openPay('${c._id}')" title="Payer">💰</button>`:''}
        ${['admin','chef_agence'].includes(session.role)&&c.adhesionStatut!=='paye'?`<button class="btn btn-xs" style="background:rgba(247,201,79,0.15);color:var(--accent);border:1px solid rgba(247,201,79,0.3)" onclick="openAdh('${c._id}')" title="Adhésion">🎫</button>`:''}
        <button class="btn btn-ghost btn-xs" onclick="ouvrirFicheClient('${c._id}')" title="Fiche complète">👁</button>
        ${['admin','chef_agence','secretaire'].includes(session.role)?`<button class="btn btn-xs" style="background:rgba(201,168,76,0.12);color:var(--accent);border:1px solid rgba(201,168,76,0.28)" onclick="ouvrirEditionClient('${c._id}')" title="Modifier">✏️</button>`:''}
        ${['admin','chef_agence','secretaire'].includes(session.role)?`<button class="btn btn-xs" style="background:rgba(56,201,160,0.12);color:var(--accent2);border:1px solid rgba(56,201,160,0.28)" onclick="ouvrirModifContrat('${c._id}')" title="Modifier le contrat">📝</button>`:''}
        ${['admin','chef_agence'].includes(session.role)?`<button class="btn btn-xs btn-warn" onclick="supprimerClient('${c._id}')" title="Supprimer">🗑</button>`:''}
      </td></tr>`;
  }).join('')||`<tr><td colspan="10" class="emp">${q?'Aucun client trouvé pour "'+q+'"':'Aucun client'}</td></tr>`;
  mettreAJourSelectionBar();
}

// ═══════════════════════════════════════════════
//  PAGE CONTRÔLE — marquage des clients contrôlés
// ═══════════════════════════════════════════════
let controleTab = 'attente'; // 'attente' | 'fait'

window.setControleTab = function(tab){
  controleTab = tab;
  document.getElementById('ctrl-tab-attente').classList.toggle('active', tab==='attente');
  document.getElementById('ctrl-tab-fait').classList.toggle('active', tab==='fait');
  const selStatut = document.getElementById('ctrl-filter-statut');
  if(selStatut) selStatut.value = tab;
  renderControle();
};

function renderControle(){
  if(!['admin','controleur'].includes(session?.role)) return;
  const selStatutSync = document.getElementById('ctrl-filter-statut');
  if(selStatutSync) selStatutSync.value = controleTab;
  // Peupler le select commercial — ✅ PERF : ne reconstruire (innerHTML) que si
  // la liste des commerciaux a changé, pas à chaque frappe de recherche
  // (oninput="dRender('renderControle')" déclenche cette fonction en continu).
  const selCom = document.getElementById('ctrl-filter-com');
  if(selCom){
    const prevVal = selCom.value;
    const comsVisibles = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
    const comsSig = comsVisibles.map(c=>c._id).join(',');
    if (selCom.dataset.comsSig !== comsSig) {
      selCom.innerHTML = `<option value="">— Tous les commerciaux —</option>`+comsVisibles.map(c=>`<option value="${c._id}"${c._id===prevVal?' selected':''}>${esc(c.nom)}</option>`).join('');
      selCom.value = prevVal;
      selCom.dataset.comsSig = comsSig;
    }
  }

  const q = (document.getElementById('ctrl-search')?.value||'').toLowerCase().trim();
  const comFiltre = selCom ? selCom.value : '';

  let cls = clientsDansAgence();
  if(comFiltre) cls = cls.filter(c=>c.commercialId===comFiltre);
  if(q) cls = cls.filter(c=>
    (c.codeClient&&c.codeClient.toLowerCase().includes(q))||
    c.nom.toLowerCase().includes(q)||
    (c.tel||'').includes(q)||
    (c.contrat||'').toLowerCase().includes(q)
  );

  const enAttente = cls.filter(c=>!c.controle || c.controle.statut!=='controle');
  const dejaFait  = cls.filter(c=>c.controle && c.controle.statut==='controle');

  document.getElementById('ctrl-count-attente').textContent = enAttente.length;
  document.getElementById('ctrl-count-fait').textContent = dejaFait.length;

  const liste = controleTab==='attente' ? enAttente : dejaFait;
  // Tri par nom
  liste.sort((a,b)=>(a.nom||'').localeCompare(b.nom||'','fr',{sensitivity:'base'}));

  const countEl = document.getElementById('ctrl-search-count');
  if(countEl) countEl.textContent = `${liste.length} client(s)`;

  const thInfo = document.getElementById('ctrl-th-info');
  if(thInfo) thInfo.textContent = controleTab==='attente' ? 'Statut' : 'Contrôlé le';

  document.getElementById('tb-controle').innerHTML = liste.map(c=>{
    const contratLabel = (()=>{
      if(c.contratArticles && c.contratArticles.length){
        return c.contratArticles.map(a=>{
          const art = getProdOuArticle(a.artId);
          const ref = art&&art.ref ? art.ref : (a.nom||'?');
          const qty = parseInt(a.qty)||1;
          return qty>1 ? `${ref} x${qty}` : ref;
        }).join(' + ');
      }
      return c.contrat||'—';
    })();
    const s = stats(c);
    const dernierPay = s.pays && s.pays.length
      ? [...s.pays].sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.heure||'').localeCompare(a.heure||''))[0]
      : null;
    const majCell = dernierPay
      ? `<div style="font-size:11px;">${esc(dernierPay.date)}${dernierPay.heure?` <span class="tm" style="font-size:10px">${esc(dernierPay.heure)}</span>`:''}</div>`
      : `<span class="tm" style="font-size:11px;">—</span>`;
    const niveauColor = s.joursCouv>=(c.duree||0) && (c.duree||0)>0 ? 'var(--accent2)' : 'var(--accent)';
    const niveauCell = `<div title="Niveau: ${s.joursCouv}/${c.duree||0} jours" style="font-size:11px;font-weight:700;color:${niveauColor};white-space:nowrap;">${joursEnJM(s.joursCouv)}<span style="font-size:9px;color:var(--muted);font-weight:400;"> /${joursEnJM(c.duree||0)}</span></div>`;
    const infoCell = controleTab==='attente'
      ? sb('À contrôler','sy')
      : `<div style="font-size:11px;">${esc(c.controle.date||'—')} ${esc(c.controle.heure||'')}<div class="tm" style="font-size:10px">par ${esc(c.controle.par||'—')}</div>${c.controle.note?`<div class="tm" style="font-size:10px;font-style:italic;">"${esc(c.controle.note)}"</div>`:''}</div>`;
    const actionCell = controleTab==='attente'
      ? `<button class="btn btn-xs" style="background:rgba(100,160,247,0.15);color:#64a0f7;border:1px solid rgba(100,160,247,0.4);font-weight:700;" onclick="ouvrirMarquerControle('${c._id}')">✓ Marquer contrôlé</button>`
      : `<button class="btn btn-ghost btn-xs" onclick="annulerControle('${c._id}')" title="Annuler le contrôle">↺ Annuler</button>`;
    return `<tr>
      <td class="fw6">${esc(c.nom)}${c.codeClient?` <span style="font-size:9.5px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.4);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">${esc(c.codeClient)}</span>`:''}</td>
      <td>${esc(c.tel||'—')}</td>
      <td><span class="tag">${esc(getCom(c.commercialId).nom)}</span></td>
      <td style="font-size:11px;">${esc(contratLabel)}</td>
      <td class="fw6" style="font-size:11px;">${fmt(s.m)}<span class="tm" style="font-size:9px;">/j</span></td>
      <td>${majCell}</td>
      <td>${niveauCell}</td>
      <td>${infoCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="emp">${controleTab==='attente'?'Aucun client en attente de contrôle':'Aucun client contrôlé pour le moment'}</td></tr>`;
}

// ════════════════════════════════════════════════
//  CONTRÔLE AVANT DÉPART — audit complet d'un commercial
// ════════════════════════════════════════════════
// Objectif : avant qu'un commercial ne quitte l'entreprise (ou soit muté),
// donner à l'admin/contrôleur la liste COMPLÈTE des clients avec lesquels
// il a réellement travaillé (= au moins un paiement enregistré à son nom),
// même si ces clients ont depuis été réaffectés à un autre commercial.
// Cela évite qu'un remplaçant hérite d'un portefeuille dont il ne connaît
// pas la totalité, et permet d'exiger un contrôle complet avant le départ.
let _cdLastComId = null;
let _cdLastRows = []; // mémorisé pour l'export, évite de tout recalculer

async function renderControleDepart(){
  if(!['admin','controleur'].includes(session?.role)) return;
  const sel = document.getElementById('cd-com-select');
  if(sel){
    // Liste TOUS les commerciaux (y compris ceux qui ne sont plus assignés à
    // aucun client actuellement) — un départ imminent est justement le cas
    // où l'on veut auditer AVANT que quoi que ce soit ne change.
    const coms = DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL)
      .sort((a,b)=>(a.nom||'').localeCompare(b.nom||'','fr',{sensitivity:'base'}));
    const sig = coms.map(c=>c._id).join(',');
    if(sel.dataset.sig !== sig){
      const prev = sel.value;
      sel.innerHTML = '<option value="">— Sélectionner un commercial —</option>' +
        coms.map(c=>`<option value="${c._id}">${esc(c.nom)}${c.zone?' · '+esc(c.zone):''}</option>`).join('');
      if(prev && coms.find(c=>c._id===prev)) sel.value = prev;
      sel.dataset.sig = sig;
    }
  }

  const zone = document.getElementById('cd-result');
  const summary = document.getElementById('cd-summary');
  if(!sel || !sel.value){
    if(zone) zone.innerHTML = '<div class="emp" style="padding:40px;">Sélectionnez un commercial pour générer la liste complète des clients avec lesquels il a réellement travaillé (au moins un paiement à son nom).</div>';
    if(summary) summary.style.display = 'none';
    _cdLastComId = null; _cdLastRows = [];
    return;
  }

  const comId = sel.value;
  const com = getCom(comId);
  if(zone) zone.innerHTML = '<div class="emp" style="padding:40px;">⏳ Recherche de tous les paiements enregistrés par ce commercial…</div>';

  let paysCom;
  try {
    paysCom = await _fetchPaiementsParCommercial(comId);
  } catch(e){
    notify('Erreur lors de la recherche : '+(e.message||e), 'err');
    if(zone) zone.innerHTML = '<div class="emp" style="padding:40px;color:var(--danger);">Erreur de chargement.</div>';
    return;
  }
  // Si l'utilisateur a changé de commercial pendant le chargement, on ignore ce résultat obsolète
  if(document.getElementById('cd-com-select')?.value !== comId) return;

  // Regrouper par client : nb paiements, total payé À CE commercial, dernière date
  const parClient = new Map();
  for(const p of paysCom){
    if(!p.clientId) continue;
    const e = parClient.get(p.clientId) || {nb:0, total:0, dernier:null};
    e.nb++;
    e.total += (p.montant||0);
    if(!e.dernier || (p.date||'') > e.dernier) e.dernier = p.date;
    parClient.set(p.clientId, e);
  }

  const rows = [...parClient.entries()].map(([clientId, agg])=>{
    const cl = getCl(clientId);
    const reassigne = cl && cl.commercialId && cl.commercialId !== comId;
    return {
      clientId,
      nom: cl ? cl.nom : '(client supprimé)',
      tel: cl ? (cl.tel||'—') : '—',
      code: cl ? (cl.codeClient||'') : '',
      nb: agg.nb,
      total: agg.total,
      dernier: agg.dernier,
      statutContrat: cl ? (cl.statutContrat||'actif') : '—',
      reassigneA: reassigne ? (getCom(cl.commercialId)?.nom || '?') : null,
      supprime: !cl,
    };
  }).sort((a,b)=>(b.dernier||'').localeCompare(a.dernier||''));

  _cdLastComId = comId;
  _cdLastRows = rows;

  const nbClients = rows.length;
  const totalGeneral = rows.reduce((a,r)=>a+r.total, 0);
  const nbReassignes = rows.filter(r=>r.reassigneA).length;
  const nbResilies = rows.filter(r=>r.statutContrat==='resilie').length;

  if(summary){
    summary.style.display = '';
    summary.innerHTML = `
      <div class="kpi-card kc-blue"><div class="kpi-lbl">Clients ayant payé avec lui</div><div class="kpi-val kv-blue">${nbClients}</div></div>
      <div class="kpi-card kc-green"><div class="kpi-lbl">Total encaissé par lui</div><div class="kpi-val kv-green">${fmt(totalGeneral)}</div></div>
      <div class="kpi-card kc-yellow"><div class="kpi-lbl">Déjà réaffectés à un autre</div><div class="kpi-val kv-yellow">${nbReassignes}</div></div>
      <div class="kpi-card kc-red"><div class="kpi-lbl">Résiliés</div><div class="kpi-val kv-red">${nbResilies}</div></div>`;
  }

  if(zone){
    zone.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div style="font-size:12.5px;color:var(--muted);">Résultat pour <strong style="color:var(--text);">${esc(com?.nom||'?')}</strong> — ${nbClients} client(s) trouvé(s) (triés par activité la plus récente)</div>
        <button class="btn btn-sm no-print" style="background:rgba(34,212,160,0.12);color:var(--accent2);border:1px solid rgba(34,212,160,0.3);font-weight:700;" onclick="exportControleDepart()">📥 Exporter (Excel)</button>
      </div>
      <div class="tw"><table><thead><tr>
        <th>Client</th><th class="no-print">Téléphone</th><th>Paiements</th><th>Total payé (avec lui)</th><th>Dernier paiement</th><th>Statut contrat</th><th>Assignation actuelle</th>
      </tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td class="fw6">${esc(r.nom)}${r.code?` <span style="font-size:9.5px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.4);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">${esc(r.code)}</span>`:''}${r.supprime?' <span class="tm" style="font-size:10px;">(fiche supprimée)</span>':''}</td>
        <td class="no-print">${esc(r.tel)}</td>
        <td>${r.nb}</td>
        <td class="fw6" style="color:var(--accent2);">${fmt(r.total)}</td>
        <td style="font-size:11px;">${esc(r.dernier||'—')}</td>
        <td>${r.statutContrat==='resilie'?'<span class="resilie-badge" style="font-size:9px;">RÉSILIÉ</span>':(r.statutContrat==='actif'?sb('Actif','sg'):esc(r.statutContrat))}</td>
        <td style="font-size:11px;">${r.reassigneA?`<span style="color:var(--accent3);font-weight:700;">⚠️ Réaffecté → ${esc(r.reassigneA)}</span>`:'<span class="tm">— toujours à lui —</span>'}</td>
      </tr>`).join('') || `<tr><td colspan="7" class="emp">Aucun paiement trouvé pour ce commercial — aucun client "réel" identifié</td></tr>`}
      </tbody></table></div>`;
  }
}

window.exportControleDepart = function(){
  if(!_cdLastComId || !_cdLastRows.length){ notify('Aucune donnée à exporter — générez d\'abord le contrôle', 'err'); return; }
  const com = getCom(_cdLastComId);
  const cols = ['Client','Code client','Téléphone','Nb paiements','Total payé (avec lui)','Dernier paiement','Statut contrat','Assignation actuelle'];
  const data = _cdLastRows.map(r=>[
    r.nom, r.code||'', r.tel, r.nb, r.total, r.dernier||'',
    r.statutContrat==='resilie'?'Résilié':(r.statutContrat||''),
    r.reassigneA ? `Réaffecté → ${r.reassigneA}` : 'Toujours à lui'
  ]);
  const ws = XLSX.utils.aoa_to_sheet([cols, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contrôle avant départ');
  XLSX.writeFile(wb, `controle_depart_${(com?.nom||'commercial').replace(/[^a-z0-9]+/gi,'_')}_${TODAY}.xlsx`);
};

window.ouvrirMarquerControle = function(cid){
  const c = getCl(cid);
  if(!c){ notify('Client introuvable','err'); return; }
  document.getElementById('ctrl-cl-id').value = cid;
  document.getElementById('ctrl-cl-info').innerHTML = `<strong>${esc(c.nom)}</strong> · ${esc(c.tel||'—')}<br><span style="font-size:11px;color:var(--muted);">${esc(c.contrat||'—')}</span>`;
  document.getElementById('ctrl-note').value = '';
  openM('m-controle');
};

window.confirmerControle = async function(){
  if(!['admin','controleur'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  const cid = document.getElementById('ctrl-cl-id').value;
  if(!cid){ notify('Client introuvable','err'); return; }
  const note = (document.getElementById('ctrl-note').value||'').trim().slice(0,300);
  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  try {
    await fbUpdate('clients', cid, {
      controle: {
        statut: 'controle',
        date: TODAY,
        heure,
        par: session.nom || session.userId,
        note
      }
    });
    closeM('m-controle');
    notify('✅ Client marqué comme contrôlé');
    renderControle();
  } catch(e) {
    notify('Erreur lors du marquage : '+(e.message||String(e)), 'err');
  }
};

window.annulerControle = async function(cid){
  if(!['admin','controleur'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  const c = getCl(cid);
  if(!c){ notify('Client introuvable','err'); return; }
  if(!(await confirmDialog(`Annuler le contrôle de « ${esc(c.nom)} » ? Il repassera dans la liste "À contrôler".`,{title:'Annuler le contrôle'}))) return;
  try {
    await fbUpdate('clients', cid, {
      controle: { statut: 'non_controle', date:'', heure:'', par:'', note:'' }
    });
    notify('Contrôle annulé');
    renderControle();
  } catch(e) {
    notify('Erreur lors de l\'annulation : '+(e.message||String(e)), 'err');
  }
};

// ── Rapport de contrôle : synthèse imprimable des clients contrôlés / non contrôlés ──
window.ouvrirRapportControle = function(){
  if(!['admin','controleur'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  const selCom = document.getElementById('rc-com');
  const comsVisibles = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
  selCom.innerHTML = `<option value="">— Tous les commerciaux —</option>`+comsVisibles.map(c=>`<option value="${c._id}">${esc(c.nom)}</option>`).join('');
  document.getElementById('rc-statut').value = 'tous';
  openM('m-rapport-controle');
};

window.genererRapportControle = function(){
  const statutFiltre = document.getElementById('rc-statut').value;
  const comFiltre = document.getElementById('rc-com').value;

  let cls = clientsDansAgence();
  if(comFiltre) cls = cls.filter(c=>c.commercialId===comFiltre);

  const enAttente = cls.filter(c=>!c.controle || c.controle.statut!=='controle');
  const dejaFait  = cls.filter(c=>c.controle && c.controle.statut==='controle');

  let liste;
  if(statutFiltre==='controle') liste = dejaFait;
  else if(statutFiltre==='non_controle') liste = enAttente;
  else liste = cls;
  liste = [...liste].sort((a,b)=>(a.nom||'').localeCompare(b.nom||'','fr',{sensitivity:'base'}));

  const total = cls.length;
  const nbFait = dejaFait.length;
  const nbAttente = enAttente.length;
  const taux = total>0 ? Math.round((nbFait/total)*100) : 0;

  // Répartition par commercial
  const parCom = {};
  cls.forEach(c=>{
    const nom = getCom(c.commercialId).nom || '—';
    if(!parCom[nom]) parCom[nom] = {total:0, fait:0};
    parCom[nom].total++;
    if(c.controle && c.controle.statut==='controle') parCom[nom].fait++;
  });
  const lignesCom = Object.entries(parCom).sort((a,b)=>a[0].localeCompare(b[0],'fr')).map(([nom,d])=>{
    const t = d.total>0 ? Math.round((d.fait/d.total)*100) : 0;
    return `<tr><td style="padding:6px 8px;">${esc(nom)}</td><td style="padding:6px 8px;text-align:center;">${d.total}</td><td style="padding:6px 8px;text-align:center;color:#1a8a4a;">${d.fait}</td><td style="padding:6px 8px;text-align:center;color:#c0392b;">${d.total-d.fait}</td><td style="padding:6px 8px;text-align:center;font-weight:700;">${t}%</td></tr>`;
  }).join('') || `<tr><td colspan="5" style="padding:10px;text-align:center;color:#888;">Aucune donnée</td></tr>`;

  const statutLabel = statutFiltre==='controle' ? 'Clients contrôlés' : statutFiltre==='non_controle' ? 'Clients non contrôlés' : 'Tous les clients';
  const comLabel = comFiltre ? (DB.commerciaux.find(c=>c._id===comFiltre)?.nom || '—') : 'Tous les commerciaux';

  const lignesDetail = liste.map(c=>{
    const estFait = c.controle && c.controle.statut==='controle';
    const statutCell = estFait
      ? `<span style="color:#1a8a4a;font-weight:700;">✅ Contrôlé</span><div style="font-size:10px;color:#666;">${esc(c.controle.date||'')} ${esc(c.controle.heure||'')} — ${esc(c.controle.par||'—')}</div>`
      : `<span style="color:#c0392b;font-weight:700;">⏳ Non contrôlé</span>`;
    const noteCell = c.controle?.note ? `<span style="font-style:italic;color:#444;">"${esc(c.controle.note)}"</span>` : `<span style="color:#aaa;">—</span>`;
    const cotisCell = fmt(stats(c).m);
    return `<tr><td style="padding:6px 8px;">${esc(c.nom)}${c.codeClient?` (${esc(c.codeClient)})`:''}</td><td style="padding:6px 8px;">${esc(c.tel||'—')}</td><td style="padding:6px 8px;">${esc(getCom(c.commercialId).nom)}</td><td style="padding:6px 8px;text-align:right;">${cotisCell}</td><td style="padding:6px 8px;">${statutCell}</td><td style="padding:6px 8px;max-width:220px;">${noteCell}</td></tr>`;
  }).join('') || `<tr><td colspan="6" style="padding:10px;text-align:center;color:#888;">Aucun client</td></tr>`;

  const now = new Date();
  const dateGen = now.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'}) + ' à ' + String(now.getHours()).padStart(2,'0')+'h'+String(now.getMinutes()).padStart(2,'0');

  const win = window.open('', '_blank', 'width=900,height=1000,scrollbars=yes');
  if(!win){ alert('Veuillez autoriser les popups pour générer le rapport.'); return; }
  win.document.write(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Rapport de contrôle</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#111;padding:24px;max-width:960px;margin:0 auto;}
  h1{font-size:20px;color:#1e3a5f;margin-bottom:2px;}
  .sub{color:#666;font-size:12px;margin-bottom:18px;}
  .kpis{display:flex;gap:12px;margin-bottom:22px;flex-wrap:wrap;}
  .kpi{flex:1;min-width:140px;border:1px solid #ddd;border-radius:8px;padding:12px 14px;background:#f8f9fb;}
  .kpi .lbl{font-size:10.5px;text-transform:uppercase;color:#777;letter-spacing:0.5px;}
  .kpi .val{font-size:22px;font-weight:800;color:#1e3a5f;margin-top:4px;}
  h2{font-size:14px;color:#1e3a5f;margin:22px 0 8px;border-bottom:2px solid #64a0f7;padding-bottom:4px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  thead th{background:#eef2f8;text-align:left;padding:7px 8px;font-size:11px;color:#333;border-bottom:2px solid #ccc;}
  tbody tr{border-top:1px solid #e5e5e5;}
  .btn-print{margin-top:20px;padding:10px 20px;background:#64a0f7;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;}
  @media print{ .no-print{display:none!important;} }
</style></head>
<body>
  <h1>📊 Rapport de contrôle</h1>
  <div class="sub">Généré le ${dateGen} · Filtre : ${esc(statutLabel)} · Commercial : ${esc(comLabel)}</div>
  <div class="kpis">
    <div class="kpi"><div class="lbl">Total clients</div><div class="val">${total}</div></div>
    <div class="kpi"><div class="lbl">✅ Contrôlés</div><div class="val" style="color:#1a8a4a;">${nbFait}</div></div>
    <div class="kpi"><div class="lbl">⏳ Non contrôlés</div><div class="val" style="color:#c0392b;">${nbAttente}</div></div>
    <div class="kpi"><div class="lbl">Taux de contrôle</div><div class="val">${taux}%</div></div>
  </div>
  <h2>Répartition par commercial</h2>
  <table><thead><tr><th>Commercial</th><th style="text-align:center;">Total</th><th style="text-align:center;">Contrôlés</th><th style="text-align:center;">Non contrôlés</th><th style="text-align:center;">Taux</th></tr></thead><tbody>${lignesCom}</tbody></table>
  <h2>Détail — ${esc(statutLabel)} (${liste.length})</h2>
  <table><thead><tr><th>Client</th><th>Téléphone</th><th>Commercial</th><th style="text-align:right;">Cotisation</th><th>Statut</th><th>Note du contrôleur</th></tr></thead><tbody>${lignesDetail}</tbody></table>
  <button class="btn-print no-print" onclick="window.print()">🖨️ Imprimer</button>
</body></html>`);
  win.document.close();
  closeM('m-rapport-controle');
};

let _histDateQueryToken = 0;
async function renderHist(){
  const el = document.getElementById('h-date');
  const fd = el ? el.value : TODAY;
  // Peupler le select commercial si vide — ✅ PERF : ne reconstruire (innerHTML)
  // que si la liste des commerciaux a changé, pas à chaque frappe de recherche
  // (oninput="dRender('renderHist')" déclenche cette fonction en continu).
  const comSel = document.getElementById('h-filter-com');
  if(comSel){
    const comsVisibles = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
    const comsSig = comsVisibles.map(c=>c._id).join(',');
    if (comSel.dataset.comsSig !== comsSig) {
      comSel.innerHTML = '<option value="">Tous les commerciaux</option>' +
        comsVisibles.map(c=>`<option value="${esc(c._id)}">${esc(c.nom)}${c.zone?' — '+esc(c.zone):''}</option>`).join('');
      comSel.dataset.comsSig = comsSig;
      // Restaurer la sélection si encore valide
      if(comSel._lastVal) comSel.value = comSel._lastVal;
    }
    if (!comSel.onchange) comSel.onchange = function(){ comSel._lastVal = this.value; renderHist(); };
  }
  const filtreComId = comSel ? comSel.value : '';

  // ── FIX : même correction que registre/fiche — quand une date précise est
  // sélectionnée (cas le plus courant, y compris pour retrouver un paiement
  // à supprimer), on va chercher les paiements de CETTE date directement
  // sur Firestore, au lieu de filtrer DB.paiements qui peut être incomplet
  // (grosse collection chargée par pages arbitraires). Sans quoi un paiement
  // existant peut ne jamais apparaître dans la liste — impossible à trouver
  // ni à supprimer, même s'il existe bien côté serveur.
  const myHistToken = ++_histDateQueryToken;
  const tbHist = document.getElementById('tb-hist');
  if (fd) {
    if (tbHist) tbHist.innerHTML = `<tr><td colspan="8" class="emp">⏳ Chargement…</td></tr>`;
    try {
      await Promise.all([
        _fetchColByDate('paiements', fd),
        fd !== TODAY ? _fetchColByDate('paiements', TODAY) : Promise.resolve()
      ]);
    } catch(e) {
      if (tbHist) tbHist.innerHTML = `<tr><td colspan="8" class="emp">Erreur de chargement : ${esc(e.message||String(e))}</td></tr>`;
      return;
    }
    if (myHistToken !== _histDateQueryToken) return; // date changée entre-temps
  }
  // NB : si aucune date n'est sélectionnée ("tous les paiements"), la vue
  // reste basée sur ce qui est déjà chargé en mémoire (comportement inchangé
  // — afficher l'historique complet sans filtre de date nécessiterait de
  // parcourir la collection entière, ce qui est un problème à part).

  const histSearch = (document.getElementById('h-search')?.value || '').toLowerCase().trim();
  // ✅ Tri par heure (au lieu d'un filtre par plage horaire) — permet de
  // classer les paiements du jour du plus tôt au plus tard (ou l'inverse)
  // sans avoir à saisir d'heure précise.
  const sortHeure = document.getElementById('h-sort-heure')?.value || '';
  let pays = paiementsDansAgence();
  if(fd) pays = pays.filter(p=>p.date===fd);
  if(filtreComId) pays = pays.filter(p=>p.commercialId===filtreComId);
  if(histSearch) pays = pays.filter(p=>{
    const cl = getCl(p.clientId);
    return (cl.nom||'').toLowerCase().includes(histSearch)
      || (cl.codeClient||'').toLowerCase().includes(histSearch)
      || (cl.contrat||'').toLowerCase().includes(histSearch)
      || (cl.tel||'').includes(histSearch);
  });
  pays = [...pays].sort((a,b)=>{
    if(sortHeure==='asc') return (a.heure||'').localeCompare(b.heure||'') || (b.date||'').localeCompare(a.date||'');
    if(sortHeure==='desc') return (b.heure||'').localeCompare(a.heure||'') || (b.date||'').localeCompare(a.date||'');
    return (b.date||'').localeCompare(a.date||'');
  });
  const tot = pays.reduce((a,p)=>a+p.montant,0);
  const tp = paiementsDansAgence().filter(p=>p.date===TODAY);
  // Label contextuel
  const labelEl = document.getElementById('h-visu-label');
  if(labelEl){
    const comLabel = filtreComId ? ` · <strong style="color:var(--accent)">${(DB.commerciaux.find(c=>c._id===filtreComId)||{nom:'?'}).nom}</strong>` : '';
    const heureLabel = sortHeure ? ` · <strong style="color:#64a0f7">🕐 Trié par heure ${sortHeure==='asc'?'↑':'↓'}</strong>` : '';
    const searchLabel = histSearch ? ` · <strong style="color:var(--accent2)">🔍 "${histSearch}"</strong>` : '';
    if(fd){
      const d = new Date(fd+'T12:00:00');
      const ds = d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
      const isToday = fd===TODAY;
      labelEl.innerHTML = `<span style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:6px;padding:3px 10px;">&#128197; ${ds}${isToday?' <strong style="color:var(--accent2)"> — Aujourd\'hui</strong>':''}${comLabel}${heureLabel}${searchLabel}</span>`;
    } else {
      labelEl.innerHTML = `<span style="background:rgba(247,201,79,0.1);border:1px solid rgba(201,168,76,0.25);border-radius:6px;padding:3px 10px;color:var(--accent);">&#128203; Tous les paiements — ${pays.length} entr&eacute;e(s)${comLabel}${heureLabel}${searchLabel}</span>`;
    }
  }
  document.getElementById('h-kpi').innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total ${fd?'ce jour':'global'}</div><div class="kpi-val kv-green">${fmt(tot)}</div><div class="kpi-sub">${pays.length} paiement(s)</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Collecté aujourd'hui</div><div class="kpi-val kv-blue">${fmt(tp.reduce((a,p)=>a+p.montant,0))}</div><div class="kpi-sub">${tp.length} paiement(s)</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Clients payants</div><div class="kpi-val kv-yellow">${new Set(pays.map(p=>p.clientId)).size}</div></div>`;
  const isAdminHist = session && ['admin','chef_agence'].includes(session.role);
  const thActions = document.getElementById('tb-hist-actions-th');
  if(thActions) thActions.style.display = isAdminHist ? '' : 'none';
  document.getElementById('tb-hist').innerHTML=pays.map(p=>{
    const c=getCl(p.clientId),com=getCom(p.commercialId),cotis=p.cotisJour||jm(c);
    const verrouille = p.verrouille === true;
    const btnSuppr = isAdminHist
      ? `<td style="text-align:center;">${verrouille
          ? `<button onclick="delPaiementVerrouille('${p._id}')" title="Paiement verrouillé — cliquer pour une suppression exceptionnelle" style="background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:3px 8px;color:var(--accent);font-size:14px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='rgba(201,168,76,0.22)'" onmouseout="this.style.background='rgba(201,168,76,0.1)'">🔒</button>`
          : `<button onclick="delPaiement('${p._id}')" title="Supprimer ce paiement" style="background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.35);border-radius:6px;padding:3px 8px;color:var(--danger);font-size:12px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='rgba(224,92,82,0.28)'" onmouseout="this.style.background='rgba(224,92,82,0.12)'">🗑</button>`
        }</td>`
      : '';
    const colspan = isAdminHist ? 8 : 7;
    return`<tr><td>${p.date||'—'}<span class="tm" style="font-size:10px;margin-left:4px">${esc(p.heure||'')}</span></td>
    <td class="fw6">${esc(c.nom)}</td><td style="font-size:11px">${esc(c.contrat||'—')}</td>
    <td><span class="cotis-badge" style="font-size:10px">&#128176; ${fmt(cotis)}</span></td>
    <td style="color:var(--accent2);font-weight:700">${fmt(p.montant)}</td>
    <td>${ratio(p.montant,cotis)}</td>
    <td><span class="tag">${esc(com.nom)}</span></td>${btnSuppr}</tr>`;
  }).join('')||`<tr><td colspan="${isAdminHist?8:7}" class="emp">${fd?'Aucun paiement ce jour':'Aucun paiement enregistr&eacute;'}</td></tr>`;
}

// ═══════════ SUPPRESSION EXCEPTIONNELLE D'UN PAIEMENT VERROUILLÉ ═══════════
// Un paiement verrouillé (saisie de mises, adhésion, transfert) n'est
// normalement JAMAIS supprimable — c'est une protection anti-fraude/erreur.
// Cette fonction permet à un admin de passer outre dans un cas exceptionnel,
// mais avec un frein volontairement plus élevé qu'une suppression normale :
// double confirmation + motif obligatoire + trace dans un journal d'audit
// (collection 'auditLog') indiquant qui, quand, et pourquoi.
window.delPaiementVerrouille = async function(id){
  if(!session || !['admin','chef_agence'].includes(session.role)){ notify('Accès refusé — réservé aux administrateurs','err'); return; }
  const p = (DB.paiements||[]).find(x=>x._id===id);
  if(!p){ notify('Paiement introuvable','err'); return; }
  const c = getCl(p.clientId);
  const com = getCom(p.commercialId);

  const etape1 = await confirmDialog(
    `⚠️ Ce paiement est VERROUILLÉ (protection normale).\n\n`+
    `Client : ${esc(c.nom||'—')}\nCommercial : ${esc(com.nom||'—')}\nDate : ${p.date||'—'} ${p.heure||''}\nMontant : ${fmt(p.montant)}\n${p.note?'Note : '+p.note+'\n':''}\n`+
    `La suppression d'un paiement verrouillé est une action EXCEPTIONNELLE, tracée et non standard.\nVoulez-vous continuer ?`,
    {title:'🔒 Suppression exceptionnelle', okLabel:'Continuer', danger:true}
  );
  if(!etape1) return;

  const motif = (prompt('Motif de cette suppression exceptionnelle (obligatoire — sera enregistré dans le journal d\'audit) :')||'').trim();
  if(!motif){ notify('Suppression annulée — un motif est obligatoire','warn'); return; }

  const etape2 = await confirmDialog(
    `Dernière confirmation.\n\nMotif saisi : "${motif}"\n\nCette action sera enregistrée avec votre nom et l'heure. Confirmer la suppression définitive ?`,
    {title:'⚠️ Confirmation finale', okLabel:'Supprimer définitivement', danger:true}
  );
  if(!etape2) return;

  try {
    // Journal d'audit AVANT suppression (si la suppression réussit mais pas
    // le log, on préfère quand même garder une trace tentée plutôt qu'aucune).
    await fbAdd('auditLog', {
      action: 'suppression_paiement_verrouille',
      paiementId: id,
      clientId: p.clientId, clientNom: c.nom||'—',
      commercialId: p.commercialId, commercialNom: com.nom||'—',
      montant: p.montant, date: p.date||'—', heure: p.heure||'—',
      note: p.note||'',
      motif,
      effectuePar: session.userId, effectueParNom: session.nom||session.userId,
      horodatage: new Date().toISOString()
    });
  } catch(e) {
    // On n'empêche pas la suppression si le log échoue (ex: règle Firestore
    // pas encore configurée pour 'auditLog') — mais on avertit clairement.
    console.error('Échec écriture auditLog :', e);
    notify("⚠️ Le journal d'audit n'a pas pu être écrit (vérifiez les règles Firestore pour 'auditLog') — suppression annulée par prudence.", 'err');
    return;
  }

  try {
    await fbDelete('paiements', id);
    notify('✅ Paiement verrouillé supprimé (action tracée)');
    renderHist();
  } catch(e){
    notify('Erreur lors de la suppression : '+e.message,'err');
  }
};

// ═══════════════ SUPPRESSION PAIEMENT (admin) ═══════════════
window.delPaiement = async function(id){
  if(!session || !['admin','chef_agence'].includes(session.role)){ notify('Accès refusé — réservé aux administrateurs','err'); return; }
  const p = (DB.paiements||[]).find(x=>x._id===id);
  if(!p){ notify('Paiement introuvable','err'); return; }
  if(p.verrouille === true){ notify("Ce paiement est verrouillé — utilisez l'icône 🔒 pour une suppression exceptionnelle tracée.",'err'); return; }
  const c = getCl(p.clientId);
  const com = getCom(p.commercialId);
  const ok = await confirmDialog(
    `Client : ${esc(c.nom||'—')}\nCommercial : ${esc(com.nom||'—')}\nDate : ${p.date||'—'} ${p.heure||''}\nMontant : ${fmt(p.montant)}\n${p.note?'Note : '+p.note+'\n':''}\nCette suppression est définitive et irréversible.`,
    {title:'🗑 Supprimer ce paiement ?', okLabel:'Supprimer', danger:true}
  );
  if(!ok) return;
  try {
    await fbDelete('paiements', id);
    notify('✅ Paiement supprimé');
    renderHist();
  } catch(e){
    notify('Erreur lors de la suppression : '+e.message,'err');
  }
};
// ════════════════════════════════════════════════════════════

window.changerDateHist = function(delta){
  const el = document.getElementById('h-date');
  if(!el || !el.value) return;
  const d = new Date(el.value+'T12:00:00');
  d.setDate(d.getDate()+delta);
  el.value = d.toISOString().split('T')[0];
  renderHist();
};

window.histAujourdhui = function(){
  const el = document.getElementById('h-date');
  if(el) el.value = TODAY;
  renderHist();
};

// ========= NAVIGATION DATE REGISTRE =========
window.changerDateRegistre = function(delta){
  const input = document.getElementById('reg-date');
  const d = new Date((input.value || TODAY) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  input.value = d.toISOString().split('T')[0];
  renderRegistre();
};

window.allerAujourdhui = function(){
  document.getElementById('reg-date').value = TODAY;
  renderRegistre();
};

// ========= ACTUALISER LE SYSTÈME =========
// ✅ FIX LECTURES FIRESTORE : avant, ce bouton relisait 9 collections ENTIÈRES
// sans filtre de rôle ni limite (getDocs brut), peu importe le rôle de
// l'utilisateur ou la page affichée — un clic pouvait coûter des dizaines de
// milliers de lectures sur une base de données volumineuse. On ne relit
// désormais que les collections utilisées par la page actuellement affichée,
// via _loadCol() qui applique le même filtre par rôle (where commercialId==uid)
// et la même limite de pagination (limit 200) que le chargement normal.
const REFRESH_COOLDOWN_MS = 8000; // anti-clics répétés
let _lastRefreshAt = 0;

window.actualiserSysteme = async function(){
  const btn = document.getElementById('btn-refresh');
  const now = Date.now();
  if (now - _lastRefreshAt < REFRESH_COOLDOWN_MS) {
    notify('Données déjà à jour — réessayez dans quelques secondes');
    return;
  }
  _lastRefreshAt = now;

  btn.textContent = '↻';
  btn.style.animation = 'spin 0.6s linear';
  btn.disabled = true;
  try {
    if(isOnline){
      const cols = _PAGE_DEPS[curPg] || [];
      // ✅ FIX LECTURES FIRESTORE (v2) : on ne saute la relecture que pour les
      // collections couvertes EN INTÉGRALITÉ par leur listener actif
      // (_listenerCoversFullLoad) — toujours à jour, inutile de payer un
      // nouveau getDocs(). Pour 'livraisons' côté commercial (listener limité
      // aux 30 premiers clients) ou les grosses collections paginées admin,
      // on garde la relecture forcée comme avant.
      const colsToReload = cols.filter(c => !(_activeListeners.has(c) && _listenerCoversFullLoad(c)));
      colsToReload.forEach(c => {
        _loadedCols.delete(c);
        try {
          localStorage.removeItem(_SS_PREFIX + c);
          if (session && session.userId) localStorage.removeItem(_SS_PREFIX + c + ':' + session.userId);
        } catch(e){}
      });
      await ensureCollectionsLoaded(colsToReload);
      setSyncStatus(true);
    } else {
      loadLocalData();
    }
    if(curPg) renderPg(curPg);
    notify('Données actualisées ✓');
  } catch(e){
    notify('Erreur lors de l\'actualisation','err');
  }
  setTimeout(()=>{ btn.style.animation=''; btn.disabled=false; }, DELAY_ANIM_RESET_MS);
};

window.renderRegistreAgenceChips = function(){
  const bar = document.getElementById('reg-agence-bar');
  if(!bar) return;
  // N'afficher les chips que pour l'admin
  if(!session || session.role !== 'admin'){bar.style.display='none';return;}
  if(DB.agences.length < 1){bar.style.display='none';return;}
  bar.style.display='flex';
  bar.style.flexWrap='wrap';
  bar.style.gap='7px';
  bar.style.alignItems='center';
  const mkChip=(id,label,active)=>`<button onclick="window.setRegistreAgenceFilter('${id}')" style="padding:5px 14px;border-radius:20px;border:1.5px solid ${active?'var(--accent)':'var(--border)'};background:${active?'rgba(79,142,247,0.18)':'transparent'};color:${active?'var(--accent)':'var(--muted)'};font-size:11px;font-weight:700;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all 0.15s;">${label}</button>`;
  bar.innerHTML = `<span style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-right:4px;">Agence :</span>`
    + mkChip('', '🌐 Toutes', registreAgenceFilter==='')
    + DB.agences.map(ag=>mkChip(ag._id, '🏢 '+ag.nom, registreAgenceFilter===ag._id)).join('');
};

window.setRegistreAgenceFilter = function(id){
  registreAgenceFilter = id;
  window.renderRegistreAgenceChips();
  renderRegistre();
};

async function renderRegistre(){
  const date=document.getElementById('reg-date').value;
  if(!date){document.getElementById('reg-content').innerHTML='<div class="emp" style="padding:50px">Sélectionnez une date.</div>';return;}
  const dateStr=new Date(date+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  // ── Déterminer le filtre d'agence effectif ──
  // Pour l'admin (seul rôle multi-agences) : utilise registreAgenceFilter ('' = toutes, sinon id agence)
  // Pour tous les autres rôles, y compris chef_agence : toujours cantonné à sessionAgenceId()
  // ✅ FIX : chef_agence était inclus dans "isAdmin", ce qui lui appliquait
  // registreAgenceFilter (par défaut '' = toutes les agences) au lieu de le
  // limiter à sa propre agence → il voyait le registre de TOUTES les agences.
  const isAdmin = session && session.role === 'admin';
  const effectiveAgenceId = isAdmin ? (registreAgenceFilter || null) : sessionAgenceId();

  // ── Rendre les chips de filtre (admin seulement) ──
  renderRegistreAgenceChips();

  // ── FIX : chargement ciblé depuis Firestore pour CETTE date, au lieu de
  // filtrer DB.paiements/DB.adhesionPays qui peuvent être incomplets pour
  // de grosses collections chargées par pages. Garantit un registre du jour
  // toujours exact. Un jeton évite d'afficher un résultat périmé si
  // l'utilisateur change de date pendant le chargement.
  const myToken = ++_dateQueryToken;
  const contentEl = document.getElementById('reg-content');
  if (contentEl) contentEl.innerHTML = '<div class="emp" style="padding:50px">⏳ Chargement des données du jour…</div>';
  let paysDate, adhDate, rachatsDate;
  try {
    [paysDate, adhDate, rachatsDate] = await Promise.all([
      _fetchColByDate('paiements', date),
      _fetchColByDate('adhesionPays', date),
      _fetchColByDate('rachatCarnetPays', date)
    ]);
  } catch(e) {
    if (contentEl) contentEl.innerHTML = '<div class="emp" style="padding:50px">Erreur de chargement : '+esc(e.message||String(e))+'</div>';
    return;
  }
  if (myToken !== _dateQueryToken) return; // une requête plus récente a été lancée entre-temps

  // ── Paiements cotisations du jour ──
  // Filtrage : si effectiveAgenceId, garder seulement les coms de cette agence
  let allComs = DB.commerciaux.filter(c=>c.role!=='admin');
  if(effectiveAgenceId) allComs = allComs.filter(c=>c.agenceId===effectiveAgenceId);
  const comIds = new Set(allComs.map(c=>c._id));

  const pays = paysDate.filter(p=>p.origine!=='import_historique' && p.source!=='transfert' && comIds.has(p.commercialId));
  const totalCotis=pays.reduce((a,p)=>a+p.montant,0);
  const coms = allComs;

  // ── Adhésions du jour : filtrées par a.commercialId (même logique que cotisations)
  // FIX: évite dépendance à DB.clients potentiellement incomplet
  const adhJour = adhDate.filter(a=> comIds.has(a.commercialId));
  const totalAdh = adhJour.reduce((a,x)=>a+Number(x.montant||0),0);
  // ✅ FIX : les rachats de carnet (saisis par le commercial LUI-MÊME ou par
  // l'admin/chef d'agence en son nom — commercialId reste toujours celui du
  // commercial concerné) sont maintenant comptés dans le registre du jour du
  // commercial concerné, peu importe qui a réellement fait la saisie.
  const rachatsJour = rachatsDate.filter(r=> comIds.has(r.commercialId));
  const totalRachats = rachatsJour.reduce((a,x)=>a+Number(x.montant||0),0);
  const totalJour = totalCotis + totalAdh + totalRachats;

  // ── Calcul par commercial ──
  const comsData = coms.map(c=>{
    const paysC = pays.filter(p=>p.commercialId===c._id);
    const montantCotis = paysC.reduce((a,p)=>a+p.montant,0);
    // Adhésions liées aux clients de ce commercial
    // FIX: adhésions filtrées par a.commercialId (comme cotisations)
    // évite dépendance à DB.clients potentiellement incomplet en mémoire
    const adhC = adhJour.filter(a=>a.commercialId===c._id);
    const montantAdh = adhC.reduce((a,x)=>a+Number(x.montant||0),0);
    // ✅ FIX : rachats de carnet du jour attribués à ce commercial
    const rachatsC = rachatsJour.filter(r=>r.commercialId===c._id);
    const montantRachats = rachatsC.reduce((a,x)=>a+Number(x.montant||0),0);
    // FIX: nbClients ne compte que les clientId présents dans DB.clients
    // pour aligner le registre sur la même logique que la fiche journalière
    const clientIdsComC = new Set(DB.clients.filter(cl=>cl.commercialId===c._id).map(cl=>cl._id));
    return{
      com: c,
      montantCotis,
      montantAdh,
      montantRachats,
      montantTotal: montantCotis + montantAdh + montantRachats,
      nbPaiements: paysC.length,
      nbAdhesions: adhC.length,
      nbRachats: rachatsC.length,
      nbClients: new Set(paysC.map(p=>p.clientId).filter(id=>clientIdsComC.has(id))).size
    };
  }).filter(d=>d.montantTotal>0).sort((a,b)=>b.montantTotal-a.montantTotal);

  const aid = effectiveAgenceId;
  const agLabel = aid ? getAgence(aid).nom : 'Toutes les agences';
  const nbComsActifs = comsData.length;
  // u2500u2500 Calcul total primes u00e0 du00e9duire u2500u2500
  const totalPrimes = comsData.reduce((a,d)=>{ const p=calculerPrime(d.montantTotal); return a+(p?Number(p.montant):0); },0);
  const totalNet = totalJour - totalPrimes;

  let html=`
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:16px;">
    <!-- En-tête -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid var(--border);">
      <div>
        <div style="display:flex;align-items:center;gap:7px;"><img src="logo.jpg" alt="Logo" style="height:28px;width:28px;object-fit:contain;border-radius:5px;flex-shrink:0;"><span style="font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:800;color:var(--accent);">TRIOMPHANT MMB SERVICE</span></div>
        <div style="font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-top:2px;">Registre de Collecte Journalier</div>
        <div style="font-size:11px;color:var(--accent);margin-top:2px;font-weight:600;">🏢 ${agLabel}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-weight:700;font-size:12px;color:var(--accent);">📅 ${dateStr}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">${nbComsActifs} commercial(aux) actif(s) · ${pays.length} cotis. · ${adhJour.length} adhés. · ${rachatsJour.length} rachats</div>
      </div>
    </div>

    <!-- KPI Totaux du jour : 3 blocs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:16px;">
      <div style="background:linear-gradient(135deg,rgba(34,212,160,0.12),rgba(34,212,160,0.04));border:1px solid rgba(34,212,160,0.3);border-radius:10px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">💰 Cotisations</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent2);">${fmt(totalCotis)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">${pays.length} paiement(s) · ${new Set(pays.map(p=>p.clientId)).size} client(s)</div>
      </div>
      <div style="background:linear-gradient(135deg,rgba(201,168,76,0.1),rgba(247,201,79,0.04));border:1px solid rgba(247,201,79,0.3);border-radius:10px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">🎫 Adhésions</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent);">${fmt(totalAdh)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">${adhJour.length} encaissement(s)</div>
      </div>
      <div style="background:linear-gradient(135deg,rgba(100,160,247,0.12),rgba(100,160,247,0.04));border:1px solid rgba(100,160,247,0.3);border-radius:10px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">📘 Rachats de carnet</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:#64a0f7;">${fmt(totalRachats)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">${rachatsJour.length} rachat(s)</div>
      </div>
      <div style="background:linear-gradient(135deg,rgba(201,168,76,0.09),rgba(79,142,247,0.04));border:1px solid rgba(79,142,247,0.35);border-radius:10px;padding:12px;">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">📊 TOTAL GÉNÉRAL</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent);">${fmt(totalJour)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">Cotis. + Adhés. + Rachats du jour</div>
        ${totalPrimes>0?`<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(201,168,76,0.2);"><div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">🏆 Primes à verser</div><div style="font-size:12px;font-weight:800;color:var(--accent);">− ${fmt(totalPrimes)}</div></div><div style="margin-top:6px;padding-top:6px;border-top:2px solid rgba(201,168,76,0.28);"><div style="font-size:9px;color:var(--accent2);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">💵 Net après primes</div><div style="font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:800;color:var(--accent2);">${fmt(totalNet)}</div></div>`:''}
      </div>
    </div>

    ${nbComsActifs===0 ? `<div class="emp" style="padding:30px;">Aucune collecte enregistrée ce jour.</div>` : `
    <!-- Tableau par commercial -->
    <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Répartition par commercial</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:var(--surface2);">
          <th style="padding:10px 14px;text-align:left;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;border-radius:7px 0 0 0;">Commercial</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Zone</th>
          <th style="padding:10px 14px;text-align:center;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Clients</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Cotisations</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Adhésions</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;color:#64a0f7;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Rachats</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total</th>
          <th style="padding:10px 14px;text-align:center;font-size:10px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:1px;">🏆 Prime</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;border-radius:0 7px 0 0;">% du total</th>
          <th style="padding:10px 14px;text-align:center;font-size:10px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Versé</th>
        </tr>
      </thead>
      <tbody>
        ${comsData.map((d,i)=>{
          const pct = totalJour>0 ? Math.round(d.montantTotal/totalJour*100) : 0;
          const prime = calculerPrime(d.montantTotal);
          const medal = prime ? (d.montantTotal >= 150000 ? '🥇' : d.montantTotal >= 80000 ? '🥈' : '🥉') : '';
          return`<tr style="border-top:1px solid var(--border);${i%2===1?'background:rgba(26,32,53,0.4)':''}">
            <td style="padding:9px 14px;">
              <div style="font-weight:700;font-size:12px;">${esc(d.com.nom)}</div>
              ${d.com.codePrefix?`<span style="font-size:9px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">${esc(d.com.codePrefix)}</span>`:''}
            </td>
            <td style="padding:9px 14px;font-size:11px;color:var(--muted);">${esc(d.com.zone||'—')}</td>
            <td style="padding:9px 14px;text-align:center;font-size:12px;font-weight:700;color:var(--muted);">${d.nbClients}${d.nbAdhesions>0?`<div style="font-size:9px;color:var(--accent);">+${d.nbAdhesions} adhés.</div>`:''}
            </td>
            <td style="padding:9px 14px;text-align:right;font-size:12px;font-weight:700;color:var(--accent2);">${fmt(d.montantCotis)}</td>
            <td style="padding:9px 14px;text-align:right;font-size:12px;font-weight:700;color:${d.montantAdh>0?'var(--accent3)':'var(--muted)'};">${d.montantAdh>0?fmt(d.montantAdh):'—'}</td>
            <td style="padding:9px 14px;text-align:right;font-size:12px;font-weight:700;color:${d.montantRachats>0?'#64a0f7':'var(--muted)'};">${d.montantRachats>0?fmt(d.montantRachats):'—'}</td>
            <td style="padding:9px 14px;text-align:right;font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:800;color:var(--accent);">${fmt(d.montantTotal)}</td>
            <td style="padding:9px 14px;text-align:center;">
              ${prime
                ? `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.35);border-radius:8px;padding:5px 10px;">
                    <span style="font-size:13px;">${medal}</span>
                    <span style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:800;color:var(--accent);">+${fmt(prime.montant)}</span>
                    <span style="font-size:9px;color:var(--muted);font-weight:600;">${esc(prime.label)||''}</span>
                  </div>`
                : `<span style="font-size:11px;color:var(--muted);">—</span>`}
            </td>
            <td style="padding:9px 14px;text-align:right;">
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
                <div style="width:48px;background:var(--surface2);border-radius:4px;height:5px;overflow:hidden;">
                  <div style="width:${pct}%;height:5px;background:var(--accent);border-radius:4px;"></div>
                </div>
                <span style="font-size:11px;font-weight:700;color:var(--accent);min-width:30px;">${pct}%</span>
              </div>
            </td>
            <td style="padding:9px 14px;text-align:center;">
              ${(()=>{
                const vt = getVersementDuJour(d.com._id, date);
                const canMark = ['admin','secretaire'].includes(session?.role);
                const isAdminRole = session?.role===ROLES.ADMIN;
                if(vt) return `<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(34,212,160,0.12);border:1px solid rgba(34,212,160,0.4);border-radius:20px;padding:3px 10px;font-size:10px;font-weight:700;color:var(--accent2);">✅ Versé<br><span style="font-size:9px;font-weight:400;color:var(--muted);">${vt.marqueParNom}</span>${isAdminRole?`<button onclick="annulerVersement('${vt._id}','${esc(d.com.nom)}','${date}')" title="Annuler ce versement" class="no-print" style="margin-left:2px;background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.35);border-radius:6px;padding:1px 6px;color:var(--danger);font-size:10px;cursor:pointer;">✕</button>`:''}</span>`;
                if(canMark && d.montantTotal>0) return `<button onclick="marquerVerseRegistre('${d.com._id}','${date}')" style="background:rgba(34,212,160,0.15);border:1px solid rgba(34,212,160,0.4);border-radius:7px;padding:4px 10px;color:var(--accent2);font-size:10px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;">Marquer versé</button>`;
                return `<span style="font-size:11px;color:var(--muted);">—</span>`;
              })()}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--border);background:var(--surface2);">
          <td colspan="2" style="padding:10px 14px;font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:800;color:var(--text);">TOTAL DU JOUR</td>
          <td style="padding:10px 14px;text-align:center;font-size:12px;font-weight:800;color:var(--muted);">${new Set(pays.map(p=>p.clientId)).size}</td>
          <td style="padding:10px 14px;text-align:right;font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:800;color:var(--accent2);">${fmt(totalCotis)}</td>
          <td style="padding:10px 14px;text-align:right;font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:800;color:var(--accent);">${fmt(totalAdh)}</td>
          <td style="padding:10px 14px;text-align:right;font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:800;color:var(--accent);">
            ${fmt(totalJour)}
            ${totalPrimes>0?`<div style="font-size:10px;color:var(--accent);font-weight:700;margin-top:2px;">− ${fmt(totalPrimes)} primes</div><div style="font-size:12px;font-weight:800;color:var(--accent2);border-top:1px solid rgba(255,255,255,0.1);margin-top:3px;padding-top:3px;">${fmt(totalNet)} net</div>`:''}
          </td>
          <td style="padding:10px 14px;text-align:center;">
            ${totalPrimes>0
              ? `<div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:800;color:var(--accent);">Σ −${fmt(totalPrimes)}</div><div style="font-size:9px;color:var(--muted);">total primes</div>`
              : `<span style="color:var(--muted);font-size:11px;">—</span>`}
          </td>
          <td style="padding:10px 14px;text-align:right;font-size:12px;font-weight:800;color:var(--accent);">100%</td>
          <td style="padding:10px 14px;text-align:center;font-size:11px;color:var(--muted);">—</td>
        </tr>
      </tfoot>
    </table>`}

  <!-- Tableau détaillé des adhésions du jour -->
  ${adhJour.length>0?`
  <div style="background:var(--surface);border:1px solid rgba(247,201,79,0.3);border-radius:14px;padding:20px;margin-top:14px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0;">
      <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;">🎫 Adhésions encaissées — ${adhJour.length} entrée(s) · ${fmt(totalAdh)}</div>
      <button onclick="(function(btn){var t=document.getElementById('adh-detail-table');if(t.style.display==='none'){t.style.display='';btn.textContent='▲ Masquer';}else{t.style.display='none';btn.textContent='▼ Détails';}})(this)" style="background:rgba(201,168,76,0.1);border:1px solid rgba(247,201,79,0.3);border-radius:7px;padding:4px 12px;color:var(--accent);font-size:10px;font-weight:700;cursor:pointer;font-family:'Space Grotesk',sans-serif;">▼ Détails</button>
    </div>
    <div id="adh-detail-table" style="display:none;margin-top:12px;">
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:var(--surface2);">
          <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Code client</th>
          <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Nom</th>
          <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Commercial</th>
          <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:1px;">Heure</th>
          <th style="padding:8px 12px;text-align:right;font-size:9.5px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:1px;">Montant</th>
        </tr>
      </thead>
      <tbody>
        ${adhJour.map((a,i)=>{
          const cl = DB.clients.find(c=>c._id===a.clientId)||{};
          const com = coms.find(c=>c._id===a.commercialId)||{};
          const bg = i%2===1?'background:rgba(26,32,53,0.35)':'';
          return '<tr style="border-top:1px solid var(--border);'+bg+'">'
            +'<td style="padding:8px 12px;"><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 6px;color:var(--accent);font-weight:700;">'+esc(cl.codeClient||'—')+'</span></td>'
            +'<td style="padding:8px 12px;font-weight:600;font-size:12px;">'+esc(cl.nom||'—')+'</td>'
            +'<td style="padding:8px 12px;font-size:11px;color:var(--muted);">'+esc(com.nom||'—')+'</td>'
            +'<td style="padding:8px 12px;font-size:11px;color:var(--muted);">'+esc(a.heure||'—')+badgeCorrection(a)+'</td>'
            +'<td style="padding:8px 12px;text-align:right;font-weight:800;font-size:13px;color:var(--accent);">'+fmt(a.montant)+'</td>'
            +'</tr>';
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid rgba(247,201,79,0.3);background:rgba(247,201,79,0.06);">
          <td colspan="4" style="padding:8px 12px;font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:800;color:var(--accent);text-align:right;">TOTAL ADHÉSIONS :</td>
          <td style="padding:8px 12px;font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:800;color:var(--accent);text-align:right;">${fmt(totalAdh)}</td>
        </tr>
      </tfoot>
    </table>
    </div>
  </div>`:''}

  </div>`;

  document.getElementById('reg-content').innerHTML=html;
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: ADMIN                                                ║
// ║  Extraction: node extract-modules.js → js/admin.js           ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= AGENCES =========
function remplirSelectAgences(selectId, valActuelle){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  sel.innerHTML = '<option value="">— Sélectionner une agence —</option>' +
    DB.agences.map(a=>`<option value="${esc(a._id)}"${a._id===valActuelle?' selected':''}>${esc(a.nom)} — ${esc(a.ville||'')}</option>`).join('');
}

function renderAgences(){
  const grid = document.getElementById('agences-grid');
  if(!grid) return;
  if(!DB.agences.length){
    grid.innerHTML='<div class="emp" style="padding:40px;grid-column:1/-1;">Aucune agence. Cliquez sur "+ Nouvelle agence" pour commencer.</div>';
    return;
  }
  grid.innerHTML = DB.agences.map(ag=>{
    const membres = DB.commerciaux.filter(c=>c.agenceId===ag._id);
    const coms = membres.filter(c=>c.role===ROLES.COMMERCIAL);
    const secs = membres.filter(c=>c.role===ROLES.SECRETAIRE);
    const clients = DB.clients.filter(c=>coms.some(com=>com._id===c.commercialId));
    const totalPaye = DB.paiements.filter(p=>coms.some(com=>com._id===p.commercialId)).reduce((a,p)=>a+p.montant,0);
    const roleColors={commercial:'rgba(34,212,160,0.15)',secretaire:'rgba(201,168,76,0.12)',controleur:'rgba(247,201,79,0.15)',gestionnaire_stock:'rgba(247,97,79,0.12)'};
    const roleIcons={commercial:'🧑‍💼',secretaire:'📋',controleur:'🔍',gestionnaire_stock:'📦'};
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;transition:border-color 0.18s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <!-- Header agence -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
        <div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:17px;font-weight:800;color:var(--accent);">🏢 ${esc(ag.nom)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">📍 ${esc(ag.ville||'—')} ${ag.description?'· '+ag.description:''}</div>
        </div>
        <div style="display:flex;gap:5px;">
          <button class="btn btn-ghost btn-xs" onclick="editAgence('${ag._id}')">✏️</button>
          <button class="btn btn-xs btn-warn" onclick="deleteAgence('${ag._id}')">🗑</button>
        </div>
      </div>
      <!-- KPIs agence -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
        <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Clients</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent);">${clients.length}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">CA Total</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:800;color:var(--accent2);">${totalPaye>=1000000?(totalPaye/1000000).toFixed(1)+'M':totalPaye>=1000?(totalPaye/1000).toFixed(0)+'k':totalPaye} FCFA</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Membres</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:800;color:var(--accent);">${membres.length}</div>
        </div>
      </div>
      <!-- Liste membres -->
      <div style="border-top:1px solid var(--border);padding-top:12px;">
        <div style="font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Membres de l'agence</div>
        ${membres.length===0?'<div class="emp" style="padding:10px;font-size:11px;">Aucun membre assigné</div>':
          membres.map(m=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <div style="width:28px;height:28px;border-radius:50%;background:${roleColors[m.role]||'rgba(201,168,76,0.09)'};display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">${roleIcons[m.role]||'👤'}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.nom)}</div>
              <div style="font-size:10px;color:var(--muted);">${getRoleLabel(m.role)}${m.codePrefix?' · Préfixe : <strong style="color:var(--accent)">'+m.codePrefix+'</strong>':''}</div>
            </div>
          </div>`).join('')}
      </div>
      <!-- Bouton ajouter membre -->
      <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:12px;font-size:11px;" onclick="openM('m-com')">+ Ajouter un membre</button>
    </div>`;
  }).join('');
}

window.editAgence = function(id){
  const ag = DB.agences.find(a=>a._id===id);
  if(!ag) return;
  document.getElementById('m-agence-title').textContent = '✏️ Modifier l\'agence';
  document.getElementById('agence-id').value = id;
  document.getElementById('agence-nom').value = ag.nom||'';
  document.getElementById('agence-ville').value = ag.ville||'';
  document.getElementById('agence-desc').value = ag.description||'';
  openM('m-agence');
};

window.saveAgence = async function(){
  const nom = document.getElementById('agence-nom').value.trim();
  const ville = document.getElementById('agence-ville').value.trim();
  const desc = document.getElementById('agence-desc').value.trim();
  if(!nom||!ville){ notify('Nom et ville obligatoires','err'); return; }
  const id = document.getElementById('agence-id').value;
  if(id){
    await fbUpdate('agences', id, {nom, ville, description:desc});
    notify(`Agence "${nom}" mise à jour ✓`);
  } else {
    await fbAdd('agences', {nom, ville, description:desc});
    notify(`Agence "${nom}" créée ✓`);
  }
  closeM('m-agence');
};

window.deleteAgence = async function(id){
  const ag = DB.agences.find(a=>a._id===id);
  if(!ag) return;
  const membres = DB.commerciaux.filter(c=>c.agenceId===id);
  if(membres.length){
    notify(`Impossible : ${membres.length} membre(s) appartiennent à cette agence. Réassignez-les d'abord.`,'err');
    return;
  }
  if(!(await confirmDialog(`Supprimer l'agence "${esc(ag.nom)}" ? Cette action est irréversible.`,{title:'🗑 Suppression agence',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('agences', id);
  notify(`Agence "${esc(ag.nom)}" supprimée`);
};

function renderComs(){
  const roleColors={admin:'sb2',commercial:'sg',secretaire:'sb2',controleur:'sy',gestionnaire_stock:'sb'};
  const roleIcons={admin:'👑',commercial:'🧑‍💼',secretaire:'📋',controleur:'🔍',gestionnaire_stock:'📦'};
  // La colonne PIN n'est visible que pour l'admin
  const pinColHeader = document.getElementById('th-pin-col');
  if(pinColHeader) pinColHeader.style.display = session?.role===ROLES.ADMIN ? '' : 'none';
  document.getElementById('tb-coms').innerHTML=DB.commerciaux.map(c=>{
    const tot=DB.paiements.filter(p=>p.commercialId===c._id).reduce((a,p)=>a+p.montant,0)
      // ✅ FIX : les rachats de carnet du commercial étaient absents du calcul
      // de son solde (même bug que dans le Registre, corrigé de la même façon).
      + (DB.rachatCarnetPays||[]).filter(r=>r.commercialId===c._id).reduce((a,r)=>a+Number(r.montant||0),0);
    const totMises=(DB.mises||[]).filter(m=>m.commercialId===c._id).reduce((a,m)=>a+m.montant,0);
    const solde=tot-totMises;
    const myCls=DB.clients.filter(cl=>cl.commercialId===c._id);
    const isCommercial=c.role===ROLES.COMMERCIAL;
    const ag = c.agenceId ? getAgence(c.agenceId) : null;
    const isAdminSession = session?.role===ROLES.ADMIN;
    const isMe = c._id === session?.userId;
    // FIX 2 : PIN supprimé - auth Firebase Auth uniquement
    const pinCell = `<td style="display:none;"></td>`;
    return`<tr>
      <td class="fw6">
        ${roleIcons[c.role]||''} ${esc(c.nom)}
        <div style="margin-top:3px;">${sb(getRoleLabel(c.role),roleColors[c.role]||'sb2')}</div>
        ${isCommercial&&c.codePrefix?`<div style="font-size:9.5px;margin-top:2px;"><span style="background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.35);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">Préfixe : ${esc(c.codePrefix)}</span></div>`:''}
        ${ag?`<div style="font-size:9.5px;margin-top:2px;color:var(--accent);">🏢 ${esc(ag.nom)}</div>`:''}
      </td>
      <td>${esc(c.tel||'—')}</td>
      <td class="tm">${esc(c.zone||'—')}</td>
      ${pinCell}
      <td>${isCommercial?myCls.length:'—'}</td>
      <td style="color:var(--accent2);font-weight:600">${isCommercial?fmt(tot):'—'}</td>
      <td style="color:var(--danger);font-weight:600">${isCommercial?fmt(totMises):'—'}</td>
      <td style="color:${solde>=0?'var(--accent)':'var(--danger)'};font-weight:700">${isCommercial?fmt(solde):'—'}</td>
      <td style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
        ${isAdminSession?`<button class="btn btn-xs" style="background:rgba(201,168,76,0.12);color:var(--accent);border:1px solid rgba(201,168,76,0.28)" onclick="ouvrirEditionUtilisateur('${c._id}')">&#9998; Modifier</button>`:''}
        ${isAdminSession&&isCommercial&&myCls.length>0?`<button class="btn btn-xs" style="background:rgba(247,201,79,0.15);color:var(--accent);border:1px solid rgba(247,201,79,0.3)" onclick="ouvrirTransfertClients('${c._id}')">&#8646; Transférer</button>`:''}
        ${isCommercial?`<button class="btn btn-xs" style="background:rgba(201,168,76,0.15);color:var(--accent);border:1px solid rgba(201,168,76,0.3)" onclick="openMise('${c._id}')">&#128181; Mise</button>`:''}
        ${isAdminSession&&c.role!=='admin'?`<button class="btn btn-xs btn-warn" onclick="delCom('${c._id}')">Supprimer</button>`:''}
      </td>
    </tr>`;
  }).join('');
}

// Toggle affichage PIN (masqué / visible) — le PIN est haché, on indique juste le statut
window.togglePinDisplay = function(uid, pin){
  const el = document.getElementById('pin-display-'+uid);
  if(!el) return;
  if(el.dataset.visible==='1'){
    el.dataset.visible='0';
    el.textContent='••••••••';
    el.title='Cliquer pour révéler';
  } else {
    el.dataset.visible='1';
    el.textContent = pin ? '🔒 haché' : '(vide)';
    el.title='PIN stocké sous forme de hash SHA-256';
  }
};


// Modal changer son propre PIN (admin)
window.ouvrirChangerMonPin = function(){
  if(session?.role!=='admin'){ notify('Accès refusé','err'); return; }
  openM('m-changer-pin');
  document.getElementById('cp-old').value='';
  document.getElementById('cp-new').value='';
  document.getElementById('cp-err').style.display='none';
};

window.confirmerChangerPin = async function(){
  if(session?.role!=='admin') return;
  const oldPinRaw = document.getElementById('cp-old').value.trim();
  const newPin = document.getElementById('cp-new').value.trim();
  const errEl = document.getElementById('cp-err');
  const u = DB.commerciaux.find(c=>c._id===session.userId);
  if(!u){ notify('Utilisateur introuvable','err'); return; }
  // Vérification compatible ancien SHA-256 ET nouveau PBKDF2
  const oldOk = await verifyPin(oldPinRaw, u.pin);
  if(!oldOk){
    errEl.textContent='PIN actuel incorrect.';
    errEl.style.display='block';
    return;
  }
  const pinErr2 = pinInvalideMessage(newPin);
  if(pinErr2){
    errEl.textContent = pinErr2;
    errEl.style.display='block';
    return;
  }
  // Enregistrer avec le nouveau format PBKDF2
  try{
    const newPinHash = await hashPin(newPin);
    await fbUpdate('commerciaux', session.userId, {pin: newPinHash});
    closeM('m-changer-pin');
    notify('✅ Votre PIN a été changé avec succès');
  }catch(e){
    console.error('Échec changement de PIN:', e);
    errEl.textContent = 'Échec de l\'enregistrement — vérifiez votre connexion et réessayez.';
    errEl.style.display='block';
  }
};

// ========= ÉDITION UTILISATEUR =========
window.ouvrirEditionUtilisateur = function(uid){
  if(session?.role===ROLES.CONTROLEUR){ notify('Accès refusé — lecture seule','err'); return; }
  const u = DB.commerciaux.find(c=>c._id===uid);
  if(!u) return;
  document.getElementById('eu-id').value = uid;
  document.getElementById('eu-nom').value = u.nom||'';
  document.getElementById('eu-tel').value = u.tel||'';
  document.getElementById('eu-zone').value = u.zone||'';
  document.getElementById('eu-pin').value = '';
  document.getElementById('eu-role').value = u.role||'commercial';
  document.getElementById('eu-prefix').value = u.codePrefix||'';
  document.getElementById('eu-warn').style.display='none';
  remplirSelectAgences('eu-agence', u.agenceId||'');
  onEuRoleChange(u.role||'commercial');
  openM('m-edit-user');
};

window.onEuRoleChange = function(role){
  const row = document.getElementById('eu-prefix-row');
  if(row) row.style.display = role===ROLES.COMMERCIAL ? '' : 'none';
  const agRow = document.getElementById('eu-agence-row');
  if(agRow) agRow.style.display = ['commercial','secretaire','chef_agence'].includes(role) ? '' : 'none';
};

window.sauvegarderUtilisateur = async function(){
  const uid = document.getElementById('eu-id').value;
  const nom = document.getElementById('eu-nom').value.trim();
  const pin = document.getElementById('eu-pin').value.trim();
  const role = document.getElementById('eu-role').value;
  const warn = document.getElementById('eu-warn');
  if(!nom){ notify('Le nom est obligatoire','err'); return; }
  if(pin){ const pinErr3 = pinInvalideMessage(pin); if(pinErr3){ notify(pinErr3,'err'); return; } }
  const agenceId = document.getElementById('eu-agence')?.value||'';
  if(['commercial','secretaire'].includes(role) && !agenceId){ notify('Sélectionnez une agence','err'); return; }
  const update = {
    nom,
    tel: document.getElementById('eu-tel').value.trim(),
    zone: document.getElementById('eu-zone').value.trim(),
    role
  };
  try{
    // FIX 2 : changement de mot de passe via Firebase Auth Console (plus de PIN local)
    if(agenceId) update.agenceId = agenceId;
    if(role===ROLES.COMMERCIAL){
      const prefix = document.getElementById('eu-prefix').value.trim().toUpperCase();
      if(!prefix){ notify('Le préfixe est obligatoire pour un commercial','err'); return; }
      const doublon = DB.commerciaux.find(c=>c._id!==uid && c.role===ROLES.COMMERCIAL && (c.codePrefix||'').toUpperCase()===prefix);
      if(doublon){ notify(`Le préfixe "${prefix}" est déjà utilisé par ${esc(doublon.nom)}`,'err'); return; }
      const u = DB.commerciaux.find(c=>c._id===uid);
      if(u && u.codePrefix && u.codePrefix.toUpperCase()!==prefix){
        warn.style.display='block';
        warn.innerHTML=`&#9888;&#65039; Le préfixe a changé de <strong>${esc(u.codePrefix)}</strong> vers <strong>${esc(prefix)}</strong>. Les codes clients existants ne seront <strong>pas</strong> modifiés automatiquement.`;
      }
      update.codePrefix = prefix;
    }
    await fbUpdate('commerciaux', uid, update);
    // ── Étape 1 du point 2 de l'audit : écriture en parallèle, non disruptive ──
    // (voir le commentaire détaillé dans saveCom ci-dessus)
    try{
      await fbSetSameId('commerciauxPrive', uid, {
        tel: update.tel, zone: update.zone, codePrefix: update.codePrefix||''
      });
    }catch(e){ console.error('commerciauxPrive (étape 1, non bloquant):', e); }
    closeM('m-edit-user');
    fillLogin();
    notify(`Utilisateur ${nom} mis à jour ✓`);
  }catch(e){
    console.error('Échec mise à jour utilisateur:', e);
    notify("Échec de l'enregistrement — vérifiez votre connexion et réessayez.", 'err');
  }
};

// ========= TRANSFERT DE CLIENTS =========
window.ouvrirTransfertClients = function(sourceId){
  const source = DB.commerciaux.find(c=>c._id===sourceId);
  if(!source) return;
  document.getElementById('tr-source-id').value = sourceId;
  document.getElementById('tr-source-info').innerHTML =
    `&#128100; <strong>${esc(source.nom)}</strong> — ${DB.clients.filter(c=>c.commercialId===sourceId).length} client(s) au total`;
  // Remplir liste destination (autres commerciaux)
  const dest = document.getElementById('tr-dest');
  dest.innerHTML = '<option value="">— Sélectionner un commercial —</option>' +
    DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL&&c._id!==sourceId)
      .map(c=>`<option value="${esc(c._id)}">${esc(c.nom)}${c.codePrefix?' ['+esc(c.codePrefix)+']':''}</option>`).join('');
  // Remplir liste clients
  const clients = DB.clients.filter(c=>c.commercialId===sourceId);
  const listEl = document.getElementById('tr-clients-list');
  if(!clients.length){ listEl.innerHTML='<div class="emp" style="padding:16px;">Aucun client</div>'; }
  else {
    listEl.innerHTML = clients.map(c=>{
      const s=stats(c);
      return`<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;transition:background 0.1s;" onmouseover="this.style.background='rgba(201,168,76,0.05)'" onmouseout="this.style.background=''">
        <input type="checkbox" class="tr-cl-check" value="${c._id}" checked style="width:15px;height:15px;accent-color:var(--accent);flex-shrink:0;" onchange="trUpdateCount()">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;">${esc(c.nom)}${c.codeClient?` <span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);">${esc(c.codeClient)}</span>`:''}</div>
          <div style="font-size:10px;color:var(--muted);">${esc(c.ville||'')} · ${esc(c.contrat||'')} · ${s.pct}% payé${s.joursRetard>0?' · <span style="color:var(--danger)">'+s.joursRetard+'j retard</span>':''}</div>
        </div>
        <span style="font-size:11px;color:var(--accent2);font-weight:600;flex-shrink:0;">${fmt(s.m)}/j</span>
      </label>`;
    }).join('');
  }
  document.getElementById('tr-warn').style.display='none';
  trUpdateCount();
  openM('m-transfert');
};

window.trSelectAll = function(val){
  document.querySelectorAll('.tr-cl-check').forEach(cb=>cb.checked=val);
  trUpdateCount();
};

window.trUpdateCount = function(){
  const n = document.querySelectorAll('.tr-cl-check:checked').length;
  const total = document.querySelectorAll('.tr-cl-check').length;
  document.getElementById('tr-count').textContent = `${n} / ${total} sélectionné(s)`;
};

window.confirmerTransfert = async function(){
  const sourceId = document.getElementById('tr-source-id').value;
  const destId = document.getElementById('tr-dest').value;
  const warn = document.getElementById('tr-warn');
  if(!destId){ notify('Sélectionnez un commercial destinataire','err'); return; }
  const selected = [...document.querySelectorAll('.tr-cl-check:checked')].map(cb=>cb.value);
  if(!selected.length){ notify('Sélectionnez au moins un client','err'); return; }
  const dest = DB.commerciaux.find(c=>c._id===destId);
  const source = DB.commerciaux.find(c=>c._id===sourceId);
  if(!(await confirmDialog(`Transférer ${selected.length} client(s) de "${esc(source.nom)}" vers "${esc(dest.nom)}" ?\n\nCette action est irréversible.`,{title:'Transfert de clients',okLabel:'Transférer'}))) return;
  warn.style.display='none';
  let ok=0, err=0;
  for(const cid of selected){
    try{ await fbUpdate('clients', cid, {commercialId: destId}); ok++; }
    catch(e){ err++; }
  }
  closeM('m-transfert');
  if(err>0) notify(`${ok} client(s) transférés, ${err} erreur(s)`, 'err');
  else notify(`&#10003; ${ok} client(s) transférés vers ${esc(dest.nom)}`);
};

let _recDateQueryToken = 0;
async function renderRec(){
  // ── FIX : même correction que renderRegistre/renderFiche — les paiements
  // du jour doivent venir directement de Firestore, pas d'un filtrage sur
  // DB.paiements qui peut être incomplet pour une grosse collection.
  const myRecToken = ++_recDateQueryToken;
  let tpAll;
  try {
    tpAll = await _fetchColByDate('paiements', TODAY);
  } catch(e) {
    const tb = document.getElementById('tb-rec');
    if (tb) tb.innerHTML = `<tr><td colspan="8" class="emp">Erreur de chargement : ${esc(e.message||String(e))}</td></tr>`;
    return;
  }
  if (myRecToken !== _recDateQueryToken) return;

  const cls=DB.clients.filter(c=>c.commercialId===session.userId&&stats(c).pct<100);
  const tp=tpAll.filter(p=>cls.some(c=>c._id===p.clientId));
  const coll=tp.reduce((a,p)=>a+p.montant,0);
  const cotisTotal=cls.reduce((a,c)=>a+stats(c).m,0);
  document.getElementById('rec-info').innerHTML=
    `📅 <strong>${new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})}</strong><br>
     Cotisations attendues : <strong>${fmt(cotisTotal)}</strong> &nbsp;|&nbsp; Collecté : <strong style="color:var(--accent2)">${fmt(coll)}</strong> &nbsp;|&nbsp; <strong>${new Set(tp.map(p=>p.clientId)).size}/${cls.length}</strong> clients`;
  document.getElementById('tb-rec').innerHTML=cls.map(c=>{
    const s=stats(c);const pt=tp.find(p=>p.clientId===c._id);
    return`<tr>
      <td><div class="fw6">${esc(c.nom)}</div><div class="tm" style="font-size:10px">${esc(c.ville)} · ${esc(c.quartier)}</div>${c.codeClient?`<span style="font-size:9px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 4px;color:var(--accent);font-weight:700;">${esc(c.codeClient)}</span>`:''}</td>
      <td>${esc(c.tel)}</td><td style="font-size:11px">${esc(c.contrat)}</td>
      <td><span class="cotis-badge">💰 ${fmt(s.m)}</span></td>
      <td title="Niveau: ${s.joursCouv}/${c.duree} jours">${joursEnJM(s.joursCouv)}</td>
      <td><div class="pgw"><div class="pgb" style="width:${s.pct}%"></div></div><div style="font-size:10px;color:var(--muted)">${s.pct}% · Restant ${fmt(s.totalRestant)}</div></td>
      <td style="color:${s.joursRetard>0?'var(--danger)':'var(--accent2)'};font-weight:600;font-size:11px">${s.joursRetard>0?s.joursRetard+' j':'✓ À jour'}</td>
      <td>${pt?`${sb('✓ Payé','sg')}<div style="font-size:10px;color:var(--muted)">${fmt(pt.montant)} ${ratio(pt.montant,s.m)}</div>`:`<button class="btn btn-success btn-sm" onclick="openPay('${c._id}')">💰 Payer</button>`}</td>
    </tr>`;
  }).join('')||'<tr><td colspan="8" class="emp">Aucun client actif.</td></tr>';
}

// Récupère les clients d'UN commercial directement depuis Firestore, sans
// charger toute la collection (utile pour 'fiche' où admin/secrétaire ne
// regardent qu'un commercial à la fois, mais où _PAGE_DEPS chargeait avant
// les 30 000 clients de la base entière pour n'en afficher qu'une poignée).
async function _fetchClientsByCommercial(comId) {
  if (!db_fs) return (DB.clients||[]).filter(c=>c.commercialId===comId);
  const colRef = collection(db_fs, 'clients');
  const snap = await getDocs(query(colRef, where('commercialId','==', comId)));
  const docs = snap.docs.map(d => ({...d.data(), _id: d.id}));
  if (!DB.clients) DB.clients = [];
  const existing = new Map(DB.clients.map(d => [d._id, d]));
  docs.forEach(d => existing.set(d._id, d));
  DB.clients = [...existing.values()];
  return docs;
}

async function renderFiche(){
  const role = session.role;
  const isChefAgence = (role===ROLES.CHEF_AGENCE);
  const isViewer = (role===ROLES.ADMIN||role===ROLES.SECRETAIRE||isChefAgence);

  // Sélecteur de commercial pour admin / secrétaire / chef d'agence
  const sel = document.getElementById('fiche-com-select');
  if(isViewer){
    sel.style.display='';
    let coms = DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL);
    // La secrétaire et le chef d'agence ne voient que les commerciaux de LEUR agence.
    // ✅ FIX : seul isChefAgence était filtré ici — la secrétaire voyait donc
    // la fiche du jour de tous les commerciaux de toutes les agences.
    if(isChefAgence || role===ROLES.SECRETAIRE){
      const moi = getCom(session.userId);
      const monAgenceId = moi ? moi.agenceId : null;
      coms = coms.filter(c=>c.agenceId===monAgenceId);
    }
    if(sel.options.length !== coms.length){
      const prev = sel.value;
      sel.innerHTML = coms.map(c=>`<option value="${c._id}">${esc(c.nom)}${c.zone?' · '+esc(c.zone):''}</option>`).join('');
      if(prev && coms.find(c=>c._id===prev)) sel.value=prev;
    }
    document.getElementById('fiche-page-title').textContent = 'Fiche du jour — commercial';
  } else {
    sel.style.display='none';
    document.getElementById('fiche-page-title').textContent = 'Ma fiche de recouvrement';
  }

  const comId = isViewer ? (sel.value || (DB.commerciaux.find(c=>c.role===ROLES.COMMERCIAL)||{})._id) : session.userId;
  if(!comId){ document.getElementById('fiche-content').innerHTML='<div class="emp" style="padding:40px;">Aucun commercial enregistré.</div>'; return; }

  // ── Contrôle du bouton "Marquer versé" ──
  const fd=document.getElementById('fiche-date').value||TODAY;
  const btnVerse = document.getElementById('btn-marquer-verse');
  const versementExistant = comId ? getVersementDuJour(comId, fd) : null;
  if(btnVerse){
    if(isViewer && comId){
      if(versementExistant){
        btnVerse.style.display='';
        btnVerse.textContent='✅ Versé le '+versementExistant.dateMarquage+' par '+versementExistant.marqueParNom+(session.role===ROLES.ADMIN?' — cliquer pour annuler':'');
        btnVerse.style.background='rgba(34,212,160,0.08)';
        btnVerse.style.borderColor='rgba(34,212,160,0.3)';
        btnVerse.style.color='var(--accent2)';
        if(session.role===ROLES.ADMIN){
          btnVerse.style.cursor='pointer';
          btnVerse.onclick=()=>annulerVersement(versementExistant._id, (DB.commerciaux.find(c=>c._id===comId)||{}).nom||'?', fd);
        } else {
          btnVerse.style.cursor='default';
          btnVerse.onclick=null;
        }
      } else {
        btnVerse.style.display='';
        btnVerse.textContent='✅ Marquer comme versé';
        btnVerse.style.background='linear-gradient(135deg,rgba(34,212,160,0.25),rgba(34,212,160,0.12))';
        btnVerse.style.borderColor='rgba(34,212,160,0.45)';
        btnVerse.style.color='var(--accent2)';
        btnVerse.style.cursor='pointer';
        btnVerse.onclick=marquerPointsVerses;
      }
    } else {
      btnVerse.style.display='none';
    }
  }
  // ── FIX : mêmes raisons que renderRegistre — paiements/adhésions de CETTE
  // date, et clients DU commercial sélectionné, sont chargés directement
  // depuis Firestore plutôt que filtrés depuis DB.paiements/DB.clients qui
  // supposeraient les collections entières (jusqu'à 1M / 30 000 docs) déjà
  // chargées en mémoire.
  const myFicheToken = ++_ficheDateQueryToken;
  const ficheContentEl = document.getElementById('fiche-content');
  if (ficheContentEl) ficheContentEl.innerHTML = '<div class="emp" style="padding:40px">⏳ Chargement des données du jour…</div>';
  let paysDateFiche, adhDateFiche, clsFiche, rachatsDateFiche;
  try {
    [paysDateFiche, adhDateFiche, clsFiche, rachatsDateFiche] = await Promise.all([
      _fetchColByDate('paiements', fd),
      _fetchColByDate('adhesionPays', fd),
      _fetchClientsByCommercial(comId),
      _fetchColByDate('rachatCarnetPays', fd)
    ]);
  } catch(e) {
    if (ficheContentEl) ficheContentEl.innerHTML = '<div class="emp" style="padding:40px">Erreur de chargement : '+esc(e.message||String(e))+'</div>';
    return;
  }
  if (myFicheToken !== _ficheDateQueryToken) return; // requête plus récente entre-temps

  const com=getCom(comId);
  const cls=clsFiche;
  const pays=paysDateFiche.filter(p=>p.origine!=='import_historique'&&p.source!=='transfert'&&p.commercialId===comId);
  let clientsPayeurs=cls.filter(c=>pays.some(p=>p.clientId===c._id));
  // Trier par heure de saisie du paiement (du plus ancien au plus récent)
  clientsPayeurs = clientsPayeurs.slice().sort((c1,c2)=>{
    const h1 = (pays.find(p=>p.clientId===c1._id)||{}).heure || '';
    const h2 = (pays.find(p=>p.clientId===c2._id)||{}).heure || '';
    return h1.localeCompare(h2);
  });
  const total=pays.reduce((a,p)=>a+p.montant,0);
  const dateStr=new Date(fd+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  // Nouveaux clients enregistrés ce jour par ce commercial
  const nouveauxClients = cls.filter(c=>(c.debut===fd || c.createdAt===fd) && c.origine!=='import');
  // Adhésions encaissées ce jour (table adhesionPays), triées par heure de saisie croissante
  // FIX: adhésions filtrées par a.commercialId (aligné avec registre)
  const adhJourFiche = adhDateFiche.filter(a=>a.commercialId===comId)
    .slice().sort((a,b)=>(a.heure||'').localeCompare(b.heure||''));
  const totalAdhesions = adhJourFiche.reduce((a,x)=>a+Number(x.montant||0),0);
  // ✅ Rachats de carnet du jour pour ce commercial (même bug corrigé partout
  // ailleurs : commercialId reste celui du commercial concerné même si la
  // saisie a été faite par l'admin/chef d'agence en son nom).
  const rachatsJourFiche = rachatsDateFiche.filter(r=>r.commercialId===comId)
    .slice().sort((a,b)=>(a.heure||'').localeCompare(b.heure||''));
  const totalRachatsFiche = rachatsJourFiche.reduce((a,x)=>a+Number(x.montant||0),0);
  // Total général = cotisations + adhésions + rachats
  const totalJour = total + totalAdhesions + totalRachatsFiche;
  // Fiche visible si cotisations OU adhésions OU nouveaux clients OU rachats ce jour
  const rienDuTout = !clientsPayeurs.length && !adhJourFiche.length && !nouveauxClients.length && !rachatsJourFiche.length;

  const headerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:13px;border-bottom:2px solid var(--border);">
      <div style="display:flex;align-items:center;gap:10px;"><img src="logo.jpg" alt="Logo" style="height:40px;width:40px;object-fit:contain;border-radius:7px;flex-shrink:0;"><div><div style="font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:800;color:var(--accent);">TRIOMPHANT MMB SERVICE</div><div style="font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-top:2px;">Fiche Journalière de Recouvrement</div></div></div>
      <div style="text-align:right;"><div style="font-weight:700;font-size:13px;">${com?com.nom:'—'}</div><div style="font-size:11px;color:var(--muted);">${com&&com.zone?com.zone:''} ${com&&com.tel?'· '+com.tel:''}</div>${com&&com.agenceId?`<div style="font-size:11px;color:var(--accent2);font-weight:700;margin-top:2px;">🏢 ${getAgence(com.agenceId).nom}</div>`:''}<div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:3px;">📅 ${dateStr}</div>
      ${versementExistant?`<div style="margin-top:6px;display:inline-flex;align-items:center;gap:5px;background:rgba(34,212,160,0.12);border:1px solid rgba(34,212,160,0.4);border-radius:20px;padding:4px 12px;font-size:11px;font-weight:700;color:var(--accent2);">✅ Versé · ${versementExistant.marqueParNom} · ${versementExistant.heureMarquage||''}</div>`:''}
      </div>
    </div>`;

  if(rienDuTout){
    document.getElementById('fiche-content').innerHTML=`
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:20px;">
        ${headerHTML}
        <div class="emp" style="padding:40px;">Aucune activité enregistrée pour cette journée.</div>
      </div>`;
    return;
  }

  document.getElementById('fiche-content').innerHTML=`
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:20px;">
      ${headerHTML}

      <!-- KPIs : 4 blocs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
        <div style="background:linear-gradient(135deg,rgba(34,212,160,0.12),rgba(34,212,160,0.04));border:1px solid rgba(34,212,160,0.3);border-radius:10px;padding:14px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">💰 Cotisations</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:var(--accent2);">${fmt(total)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${pays.length} paiement(s) · ${clientsPayeurs.length} client(s)</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(201,168,76,0.1),rgba(247,201,79,0.04));border:1px solid rgba(247,201,79,0.3);border-radius:10px;padding:14px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">🎫 Adhésions</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:var(--accent);">${fmt(totalAdhesions)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${adhJourFiche.length} encaissement(s)</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(201,168,76,0.12),rgba(201,168,76,0.04));border:1px solid rgba(201,168,76,0.3);border-radius:10px;padding:14px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">🆕 Nouveaux clients</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:var(--accent);">${nouveauxClients.length}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">enregistrés ce jour</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(100,160,247,0.12),rgba(100,160,247,0.04));border:1px solid rgba(100,160,247,0.3);border-radius:10px;padding:14px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">📘 Rachats de carnet</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:#64a0f7;">${fmt(totalRachatsFiche)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">${rachatsJourFiche.length} rachat(s)</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(201,168,76,0.09),rgba(79,142,247,0.04));border:1px solid rgba(79,142,247,0.35);border-radius:10px;padding:14px;">
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">📊 TOTAL GÉNÉRAL</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:var(--accent);">${fmt(totalJour)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">Cotis. + Adhés. + Rachats</div>
        </div>
      </div>

      <!-- Tableau cotisations (si existant) -->
      ${clientsPayeurs.length>0?`
      <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Détail des cotisations</div>
      <div class="tw" style="margin-bottom:16px;"><table>
        <thead><tr>
          <th>Code</th><th>Client</th>
          <th>Cotis./jour</th><th>Heure</th><th>Montant payé</th><th>Ratio</th><th>Niveau</th>
        </tr></thead>
        <tbody>${clientsPayeurs.map(c=>{
          const s=stats(c);
          const pay=pays.find(p=>p.clientId===c._id);
          // Niveau : joursCouv actuel du client, affiché comme dans la fiche client
          const dureeC = c.duree || 0;
          const niveauColor = s.joursCouv >= dureeC && dureeC>0 ? 'var(--accent2)' : 'var(--accent)';
          const niveauLabel = '<span style="font-size:11px;font-weight:700;color:'+niveauColor+';">'+joursEnJM(s.joursCouv)+'</span>'
            +(dureeC>0 ? '<span style="font-size:9px;color:var(--muted);font-weight:400;"> /'+joursEnJM(dureeC)+'</span>' : '');
          return '<tr>'
            +'<td><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">'+(c.codeClient||'—')+'</span></td>'
            +'<td class="fw6">'+c.nom+'</td>'
            +'<td style="font-weight:700;color:var(--accent)">'+fmt(s.m)+'</td>'
            +'<td style="color:var(--muted);font-size:11px">'+(pay.heure||'—')+badgeCorrection(pay)+'</td>'
            +'<td style="font-weight:700;color:var(--accent2)">'+fmt(pay.montant)+'</td>'
            +'<td>'+ratio(pay.montant,s.m)+'</td>'
            +'<td style="white-space:nowrap;">'+niveauLabel+'</td>'
            +'</tr>';
        }).join('')}
        </tbody>
        <tfoot>
          ${totalAdhesions>0?`<tr style="background:rgba(247,201,79,0.07);">
            <td colspan="4" style="padding:7px 8px;font-size:11px;color:var(--accent);text-align:right;font-weight:700;">🎫 Adhésions encaissées :</td>
            <td style="padding:7px 8px;font-weight:800;font-size:13px;color:var(--accent);">+ ${fmt(totalAdhesions)}</td>
            <td colspan="2"></td>
          </tr>`:''}
          <tr style="background:var(--surface2);">
            <td colspan="4" style="padding:9px 8px;font-weight:800;text-align:right;font-family:'Space Grotesk',sans-serif;">TOTAL DU JOUR :</td>
            <td style="padding:9px 8px;font-weight:800;font-size:16px;color:var(--accent);">${fmt(totalJour)}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table></div>`:''}

      <!-- Tableau adhésions du jour -->
      ${adhJourFiche.length>0?`
      <div style="margin-bottom:16px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🎫 Adhésions encaissées ce jour</div>
        <div class="tw" style="border-color:rgba(247,201,79,0.3);"><table>
          <thead><tr>
            <th>Code client</th><th>Nom</th><th>Heure</th><th>Montant</th><th>Note</th>
          </tr></thead>
          <tbody>${adhJourFiche.map(a=>{
            const c = getCl(a.clientId)||{};
            return '<tr>'
              +'<td><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">'+(c.codeClient||'—')+'</span></td>'
              +'<td class="fw6">'+(c.nom||'—')+'</td>'
              +'<td style="color:var(--muted);font-size:11px">'+(a.heure||'—')+badgeCorrection(a)+'</td>'
              +'<td style="font-weight:800;color:var(--accent);">'+fmt(a.montant)+'</td>'
              +'<td style="font-size:10px;color:var(--muted)">'+(a.note||'—')+'</td>'
              +'</tr>';
          }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:var(--surface2);">
              <td colspan="3" style="padding:9px 8px;font-weight:800;text-align:right;font-family:'Space Grotesk',sans-serif;">Total adhésions :</td>
              <td style="padding:9px 8px;font-weight:800;font-size:15px;color:var(--accent);">${fmt(totalAdhesions)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table></div>
      </div>`:''}

      <!-- Tableau rachats de carnet du jour -->
      ${rachatsJourFiche.length>0?`
      <div style="margin-bottom:16px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">📘 Rachats de carnet du jour</div>
        <div class="tw" style="border-color:rgba(100,160,247,0.3);"><table>
          <thead><tr>
            <th>Code client</th><th>Nom</th><th>Heure</th><th>Montant</th><th>Note</th>
          </tr></thead>
          <tbody>${rachatsJourFiche.map(r=>{
            const c = getCl(r.clientId)||{};
            return '<tr>'
              +'<td><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">'+(c.codeClient||'—')+'</span></td>'
              +'<td class="fw6">'+(c.nom||'—')+'</td>'
              +'<td style="color:var(--muted);font-size:11px">'+(r.heure||'—')+badgeCorrection(r)+'</td>'
              +'<td style="font-weight:800;color:#64a0f7;">'+fmt(r.montant)+'</td>'
              +'<td style="font-size:10px;color:var(--muted)">'+(r.note||'—')+'</td>'
              +'</tr>';
          }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:var(--surface2);">
              <td colspan="3" style="padding:9px 8px;font-weight:800;text-align:right;font-family:'Space Grotesk',sans-serif;">Total rachats :</td>
              <td style="padding:9px 8px;font-weight:800;font-size:15px;color:#64a0f7;">${fmt(totalRachatsFiche)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table></div>
      </div>`:''}

      <!-- Nouveaux clients du jour -->
      ${nouveauxClients.length>0?`
      <div style="margin-bottom:16px;">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🆕 Nouveaux clients enregistrés ce jour</div>
        <div class="tw"><table>
          <thead><tr>
            <th>Code</th><th>Nom</th><th>Montant contrat</th><th>Adhésion</th>
          </tr></thead>
          <tbody>${nouveauxClients.map(c=>`<tr>
            <td><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:0 5px;color:var(--accent);font-weight:700;">${esc(c.codeClient||'—')}</span></td>
            <td class="fw6">${esc(c.nom)}${c.origine==='import'?'<span style="font-size:9px;background:rgba(79,142,247,0.18);border:1px solid rgba(79,142,247,0.35);border-radius:4px;padding:0 5px;color:var(--accent);margin-left:5px;">📥 Importé</span>':''}</td>
            <td style="font-weight:700;color:var(--accent);">${fmt(c.montantTotal||0)}</td>
            <td style="text-align:center;">
              ${c.adhesionStatut==='paye'
                ?'<span style=\"background:rgba(34,212,160,0.18);border:1px solid rgba(34,212,160,0.45);border-radius:20px;padding:3px 12px;font-size:11px;font-weight:700;color:var(--accent2)\">✅ Encaissée</span>'
                :(role===ROLES.COMMERCIAL?`<div style=\"display:flex;align-items:center;gap:6px;justify-content:center;\"><span style=\"background:rgba(224,92,82,0.14);border:1px solid rgba(247,97,79,0.4);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:var(--danger)\">❌ Non encaissée</span><button class=\"btn btn-xs\" style=\"background:rgba(34,212,160,0.18);color:var(--accent2);border:1px solid rgba(34,212,160,0.4);white-space:nowrap;\" onclick=\"encaisserAdhesionFiche('${c._id}')\">💵 Encaisser</button></div>`:'<span style=\"background:rgba(224,92,82,0.14);border:1px solid rgba(247,97,79,0.4);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:var(--danger)\">❌ Non encaissée</span>')}
            </td>
          </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`:''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div style="border:1px solid var(--border);border-radius:7px;padding:12px;"><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Signature du commercial</div>${com&&com.agenceId?`<div style="font-size:10px;font-weight:700;color:var(--accent2);margin-bottom:14px;">🏢 ${getAgence(com.agenceId).nom}</div>`:`<div style="margin-bottom:18px;"></div>`}<div style="border-bottom:1px solid var(--border);"></div><div style="font-size:9px;color:var(--muted);margin-top:4px;">${com?com.nom:'—'}</div></div>
        <div style="border:1px solid var(--border);border-radius:7px;padding:12px;"><div style="font-size:10px;color:var(--muted);margin-bottom:26px;">Visa superviseur</div><div style="border-bottom:1px solid var(--border);"></div><div style="font-size:9px;color:var(--muted);margin-top:4px;">Date : ___________</div></div>
      </div>
    </div>`;
}


window.encaisserAdhesionFiche = async function(cid){
  const c = getCl(cid);
  if(!c || c.adhesionStatut==='paye'){ notify('Adhésion déjà encaissée','err'); return; }
  if(!(await confirmDialog(`Encaisser le droit d'adhésion de 200 FCFA pour ${esc(c.nom)} ?\n\nCette action marquera l'adhésion comme payée.`,{title:'💰 Encaissement adhésion',okLabel:'Encaisser'}))) return;
  try{
    await fbUpdate('clients', cid, {adhesionStatut:'paye', adhesion:200});
    const _now = new Date();
    const _heure = String(_now.getHours()).padStart(2,'0')+':'+String(_now.getMinutes()).padStart(2,'0');
    await fbAdd('adhesionPays', {clientId:cid, commercialId:session.userId, montant:200, date:TODAY, heure:_heure, note:"Adhésion encaissée par commercial", saisiParId:session.userId, saisiParNom:session.nom, verrouille:true});
    notify(`✅ Adhésion de ${esc(c.nom)} encaissée — 200 FCFA`);
    renderFiche();
  }catch(e){
    console.error('Échec encaissement adhésion:', e);
    notify("Échec de l'encaissement — vérifiez votre connexion et vérifiez le statut du client avant de réessayer.", 'err');
  }
};

// ========= PRIMES COMMERCIAUX =========

// Retourne le palier le plus élevé atteint pour un montant donné
function calculerPrime(montantJour) {
  const paliers = (DB.primesPaliers || [])
    .filter(p => montantJour >= Number(p.seuil))
    .sort((a, b) => Number(b.seuil) - Number(a.seuil));
  return paliers.length > 0 ? paliers[0] : null;
}

// Ouvre le modal de gestion des paliers (admin seulement)
window.ouvrirPrimes = function() {
  renderPaliersList();
  openM('m-primes');
};

function renderPaliersList() {
  const paliers = [...(DB.primesPaliers || [])].sort((a, b) => Number(a.seuil) - Number(b.seuil));
  const tbody = document.getElementById('primes-paliers-list');
  if (!tbody) return;
  if (!paliers.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="emp" style="padding:24px;">Aucun palier défini. Ajoutez-en un ci-dessus.</td></tr>`;
    return;
  }
  tbody.innerHTML = paliers.map((p, i) => {
    const medal = Number(p.seuil) >= 150000 ? '🥇' : Number(p.seuil) >= 80000 ? '🥈' : '🥉';
    return `<tr>
      <td><span style="font-size:16px;margin-right:6px;">${medal}</span><strong>${esc(p.label) || '—'}</strong></td>
      <td style="text-align:right;font-weight:700;color:var(--accent2);">≥ ${fmt(Number(p.seuil))}</td>
      <td style="text-align:right;font-weight:800;color:var(--accent);">+ ${fmt(Number(p.montant))}</td>
      <td style="text-align:center;">
        <button class="btn btn-xs btn-warn" onclick="supprimerPalier('${p._id}')">🗑 Supprimer</button>
      </td>
    </tr>`;
  }).join('');
}

window.ajouterPalier = async function() {
  const seuil = parseInt(document.getElementById('prime-seuil').value);
  const montant = parseInt(document.getElementById('prime-montant').value);
  const label = document.getElementById('prime-label').value.trim() || `Palier ${fmt(seuil)}`;
  if (!seuil || !montant || seuil <= 0 || montant <= 0) {
    notify('Seuil et montant prime obligatoires', 'err'); return;
  }
  // Vérifier doublon de seuil
  const existe = (DB.primesPaliers || []).find(p => Number(p.seuil) === seuil);
  if (existe) { notify('Un palier avec ce seuil existe déjà', 'err'); return; }
  await fbAdd('primesPaliers', { seuil, montant, label });
  document.getElementById('prime-seuil').value = '';
  document.getElementById('prime-montant').value = '';
  document.getElementById('prime-label').value = '';
  notify('Palier ajouté ✓');
  renderPaliersList();
};

window.supprimerPalier = async function(id) {
  if (!(await confirmDialog('Supprimer ce palier de prime ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('primesPaliers', id);
  notify('Palier supprimé');
  renderPaliersList();
};

// ========= ACTIONS =========
window.openPay = function(cid){
  payCtx=cid;
  const c=getCl(cid),s=stats(c);
  // ── Bloquer si contrat résilié ──
  if(c.statutContrat==='resilie'){
    notify(`🚫 Contrat de ${esc(c.nom)} résilié — aucune cotisation possible.`,'err');
    return;
  }
  const contratSolde = c.montantTotal>0 && s.totalPaye>=c.montantTotal;
  // Affichage info + badge contrat soldé si applicable
  const soldeBadge = contratSolde
    ? `<div style="margin-top:7px;background:rgba(34,212,160,0.12);border:1px solid rgba(34,212,160,0.4);border-radius:8px;padding:7px 11px;font-size:12px;color:var(--accent2);font-weight:700;">🏆 Contrat totalement soldé — aucune cotisation supplémentaire requise.<br><span style="font-size:11px;font-weight:400;color:var(--muted);">Modifiez le contrat pour autoriser de nouveaux encaissements.</span></div>`
    : '';
  document.getElementById('pay-info').innerHTML=`<strong>${esc(c.nom)}</strong> · ${esc(c.contrat)}<br>Cotisation/jour : <strong>${fmt(s.m)}</strong> &nbsp;|&nbsp; Restant : <strong style="color:${contratSolde?'var(--accent2)':'var(--text)'}">${fmt(s.totalRestant)}</strong><br>${s.joursRetard>0?`⚠️ Retard : <strong style="color:var(--danger)">${s.joursRetard}j</strong> ≈ ${fmt(s.joursRetard*s.m)}`:'✅ À jour'}${soldeBadge}`;
  document.getElementById('pay-multiples').innerHTML=`<span style="font-size:10px;color:var(--muted);align-self:center">Raccourcis :</span>`+[1,2,3,5].map(n=>`<button class="btn btn-ghost btn-xs" onclick="document.getElementById('pay-amt').value=${s.m*n}">${n}x (${fmt(s.m*n)})</button>`).join('');
  document.getElementById('pay-amt').value=contratSolde?0:s.m;
  document.getElementById('pay-note').value='';
  // Bouton modifier contrat (admin uniquement)
  const editContratWrap = document.getElementById('pay-edit-contrat-wrap');
  if(editContratWrap) editContratWrap.style.display = ['admin','chef_agence','secretaire'].includes(session.role) ? '' : 'none';
  // Désactiver le bouton confirmer si contrat soldé (non-admin bloqué, admin peut forcer)
  const btnConfirm = document.getElementById('pay-btn-confirm');
  if(btnConfirm){
    if(contratSolde && !['admin','chef_agence','secretaire'].includes(session.role)){
      btnConfirm.disabled=true; btnConfirm.style.opacity='0.4'; btnConfirm.style.cursor='not-allowed';
      btnConfirm.title='Contrat soldé — modification du contrat requise';
    } else {
      btnConfirm.disabled=false; btnConfirm.style.opacity=''; btnConfirm.style.cursor=''; btnConfirm.title='';
    }
  }
  // Champ date visible uniquement pour l'admin
  const dateRow = document.getElementById('pay-date-row');
  const dateInput = document.getElementById('pay-date');
  const comIdForDate = ['admin','chef_agence'].includes(session.role) ? (getCl(cid)||{}).commercialId : session.userId;
  const effectiveDate = ['admin','chef_agence'].includes(session.role) ? TODAY : getDateEffectiveCommercial(comIdForDate);
  if(['admin','chef_agence'].includes(session.role)){
    dateRow.style.display='';
    dateInput.value=TODAY;
  } else {
    dateRow.style.display='none';
    dateInput.value=effectiveDate;
  }
  const motifRow = document.getElementById('pay-motif-row');
  const motifInput = document.getElementById('pay-motif-correction');
  if(motifRow) motifRow.style.display='none';
  if(motifInput) motifInput.value='';
  openM('m-pay');
};

// ── Affiche le champ "motif de correction" dès que l'admin/chef d'agence
// choisit une date différente d'aujourd'hui. Rend la correction visible
// et justifiée plutôt que silencieuse.
window._payToggleMotifCorrection = function(){
  const dateInput = document.getElementById('pay-date');
  const motifRow = document.getElementById('pay-motif-row');
  if(!dateInput || !motifRow) return;
  motifRow.style.display = (dateInput.value && dateInput.value !== TODAY) ? '' : 'none';
};

window.savePay = async function(){
  if(!['admin','commercial','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  if(!payCtx) return;
  // ── Bloquer si contrat résilié ──
  const _clResilie = getCl(payCtx);
  if(_clResilie && _clResilie.statutContrat==='resilie'){
    notify(`🚫 Contrat de ${esc(_clResilie.nom)} résilié — aucune cotisation possible.`,'err');
    closeM('m-pay'); payCtx=null; return;
  }
  // ── Bloquer si montant contrat totalement atteint (non-admin) ──
  if(!['admin','chef_agence'].includes(session.role)){
    const _cl = getCl(payCtx);
    const _totalPaye = DB.paiements.filter(p=>p.clientId===payCtx).reduce((a,p)=>a+p.montant,0);
    if(_cl.montantTotal>0 && _totalPaye>=_cl.montantTotal){
      notify(`🔒 Contrat de ${esc(_cl.nom)} totalement soldé (${fmt(_cl.montantTotal)}). Aucun encaissement supplémentaire autorisé.`,'err');
      return;
    }
  }
  const amt=parseFloat(document.getElementById('pay-amt').value)||0;
  if(amt<=0){notify('Montant invalide','err');return;}
  const c=getCl(payCtx),s=stats(c);
  const note=document.getElementById('pay-note').value||'';
  const autoNote=amt===s.m?note:`${Math.round(amt/s.m*10)/10}x cotisation${note?', '+note:''}`;
  const now=new Date();
  const heureSaisie = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  // L'admin peut choisir la date, le commercial utilise la date effective (J ou J+1 si point versé)
  const isCorrecteur = ['admin','chef_agence'].includes(session.role);
  const payDate = isCorrecteur
    ? (document.getElementById('pay-date').value || TODAY)
    : getDateEffectiveCommercial(session.userId);

  // ── Correction à une date antérieure : transparente, jamais silencieuse ──
  // On exige un motif, on garde la date réelle de saisie (aujourd'hui) et on
  // marque clairement l'enregistrement comme correction : il apparaîtra
  // dans le registre/la fiche du jour concerné avec un badge visible par
  // le commercial, la date réelle de saisie et le nom de l'auteur.
  const estCorrection = isCorrecteur && payDate !== TODAY;
  let motifCorrection = '';
  if(estCorrection){
    motifCorrection = (document.getElementById('pay-motif-correction')?.value || '').trim();
    if(!motifCorrection){
      notify('Motif de la correction obligatoire — expliquez pourquoi cette saisie est datée différemment.','err');
      return;
    }
  }

  const paiementData = {
    clientId:payCtx,
    commercialId:isCorrecteur?c.commercialId:session.userId,
    cotisJour:s.m,
    montant:amt,
    date:payDate,
    note:autoNote,
    heure:heureSaisie,
    saisiParId:session.userId,
    saisiParNom:session.nom
  };
  if(estCorrection){
    paiementData.estCorrection = true;
    paiementData.dateSaisieReelle = TODAY;
    paiementData.motifCorrection = motifCorrection;
  }

  try{
    await fbAdd('paiements',paiementData);
    closeM('m-pay');payCtx=null;
    notify(estCorrection
      ? `✅ Correction enregistrée sur le ${payDate} — visible dans le registre et la fiche du commercial`
      : `Paiement de ${fmt(amt)} enregistré ✓`);
    // ✅ FIX SYNCHRO : rafraîchir immédiatement la page courante si elle
    // affiche ce paiement (fiche/registre), sans attendre le debounce du
    // listener temps réel (qui diffère le rendu pendant l'activité de
    // l'utilisateur pour éviter le clignotement).
    if(curPg==='fiche' && typeof renderFiche==='function') renderFiche();
    else if(curPg==='registre' && typeof renderRegistre==='function') renderRegistre();
  }catch(e){
    console.error('Échec enregistrement paiement:', e);
    notify("Échec de l'enregistrement du paiement — vérifiez votre connexion et réessayez avant de fermer cette fenêtre.", 'err');
    return;
  }
  // FIX : ce flux de paiement (modale "m-pay", utilisée depuis la fiche
  // client) ne générait PAS de reçu automatiquement, contrairement à la
  // "Saisie de mises" — d'où des reçus manquants dans l'historique pour
  // certains paiements. On l'aligne ici sur le même comportement partout
  // (reçu généré à chaque enregistrement, correction incluse, comme le
  // fait déjà la Saisie de mises).
  await new Promise(r=>setTimeout(r,350));
  const sApres = stats(c);
  const com = getCom(paiementData.commercialId);
  afficherRecu({
    type: 'cotisation',
    clientNom: c.nom,
    clientCode: c.codeClient || '',
    commercialNom: com.nom,
    commercialId: paiementData.commercialId,
    montant: amt,
    nbCotis: s.m>0 ? Math.round(amt/s.m*10)/10 : 0,
    cotisJour: s.m,
    date: payDate,
    heure: heureSaisie,
    note: autoNote,
    saisiParNom: session.nom,
    totalPaye: sApres.totalPaye,
    totalRestant: sApres.totalRestant,
    pct: sApres.pct
  });
};

window.openAdh = function(cid){
  adhCtx=cid;const c=getCl(cid);
  document.getElementById('adhesion-info').innerHTML=`<strong>${esc(c.nom)}</strong><br>Adhésion : <strong>${fmt(c.adhesion)}</strong> — Statut : <strong style="color:${c.adhesionStatut==='paye'?'var(--accent2)':'var(--danger)'}">${c.adhesionStatut==='paye'?'Payé':'Non payé'}</strong>`;
  document.getElementById('adh-amt').value=c.adhesion;
  openM('m-adhesion');
};

window.saveAdhesion = async function(){
  if(!adhCtx) return;
  const amt = 200;
  const c=DB.clients.find(x=>x._id===adhCtx);
  try{
    if(c){await fbUpdate('clients',c._id,{adhesionStatut:'paye',adhesion:amt});}
    // commercialId stocké pour filtrage correct dans le registre
    await fbAdd('adhesionPays',{
      clientId: adhCtx,
      commercialId: c ? c.commercialId : (session.userId||''),
      montant: amt,
      date: TODAY,
      note: document.getElementById('adh-note').value
    });
    closeM('m-adhesion');adhCtx=null;notify('Adhésion enregistrée ✓');
    if(curPg==='fiche' && typeof renderFiche==='function') renderFiche();
    else if(curPg==='registre' && typeof renderRegistre==='function') renderRegistre();
  }catch(e){
    console.error('Échec enregistrement adhésion:', e);
    notify("Échec de l'enregistrement de l'adhésion — vérifiez votre connexion et vérifiez le statut du client avant de réessayer.", 'err');
  }
};

window.openDet = function(cid){
  const c=getCl(cid),s=stats(c);
  document.getElementById('det-title').textContent=`👤 ${esc(c.nom)} — ${esc(c.contrat)}`;
  document.getElementById('det-kpi').style.gridTemplateColumns='repeat(auto-fill,minmax(130px,1fr))';
  document.getElementById('det-kpi').innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total payé</div><div class="kpi-val kv-green" style="font-size:16px">${fmt(s.totalPaye)}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Restant dû</div><div class="kpi-val kv-red" style="font-size:16px">${fmt(s.totalRestant)}</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Avancement</div><div class="kpi-val kv-blue" style="font-size:16px">${s.pct}%</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Retard</div><div class="kpi-val kv-yellow" style="font-size:16px">${s.joursRetard}j</div></div>
    <div class="kpi-card" style="border-color:${s.soldeNet>=0?'rgba(34,212,160,0.35)':'rgba(247,97,79,0.35)'};background:${s.soldeNet>=0?'rgba(34,212,160,0.07)':'rgba(247,97,79,0.07)'}">
      <div class="kpi-lbl" style="color:${s.soldeNet>=0?'var(--accent2)':'var(--danger)'}">💳 Solde dispo.</div>
      <div class="kpi-val" style="font-size:14px;color:${s.soldeNet>=0?'var(--accent2)':'var(--danger)'};">${fmt(s.soldeNet)}</div>
      <div style="font-size:9px;color:var(--muted);margin-top:2px;">Livraisons : −${fmt(s.totalLivraisons)}</div>
    </div>`;
  const pays=[...s.pays].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  // Calcul du niveau cumulatif par paiement (du plus ancien au plus récent)
  const paysTries2 = [...s.pays].sort((a,b)=>a.date.localeCompare(b.date));
  const cotisJ2 = s.m; const duree2 = c.duree||372;
  let cumul2 = 0;
  const niveauxMap2 = new Map();
  paysTries2.forEach(p => {
    cumul2 += p.montant;
    niveauxMap2.set(p._id||(p.date+p.montant), Math.min(duree2, cotisJ2>0?Math.floor(cumul2/cotisJ2):0));
  });
  document.getElementById('det-pays-list').innerHTML=pays.map(p=>{
    const locked = p.verrouille||p.source==='commercial';
    const key2 = p._id||(p.date+p.montant);
    const niv2 = niveauxMap2.get(key2);
    const nivLabel2 = niv2!==undefined ? joursEnJM(niv2) : '—';
    const nivColor2 = niv2!==undefined && niv2>=duree2 ? 'var(--accent2)' : 'var(--accent)';
    const btnDelPai2 = (session&&['admin','chef_agence'].includes(session.role)&&!p.verrouille)
      ? `<td style="text-align:center;"><button onclick="delPaiement('${p._id}')" title="Supprimer ce paiement" style="background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.35);border-radius:6px;padding:2px 7px;color:var(--danger);font-size:11px;cursor:pointer;" onmouseover="this.style.background='rgba(224,92,82,0.28)'" onmouseout="this.style.background='rgba(224,92,82,0.12)'">🗑</button></td>`
      : (session&&['admin','chef_agence'].includes(session.role) ? `<td style="text-align:center;"><button onclick="delPaiementVerrouille('${p._id}')" title="Paiement verrouillé — cliquer pour une suppression exceptionnelle" style="background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:2px 7px;color:var(--accent);font-size:11px;cursor:pointer;">🔒</button></td>` : '<td></td>');
    return`<tr><td>${p.date}</td><td class="tm">${p.heure||'—'}</td><td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(p.cotisJour||s.m)}</span></td><td style="color:var(--accent2);font-weight:700">${fmt(p.montant)}</td><td>${ratio(p.montant,p.cotisJour||s.m)}</td><td style="font-size:12px;font-weight:700;color:${nivColor2};white-space:nowrap;">${nivLabel2}<span style="font-size:9px;color:var(--muted);font-weight:400;"> /${joursEnJM(duree2)}</span></td><td class="tm" style="font-size:10px">${esc(p.note||'—')}${locked?'<span style="margin-left:4px;color:var(--accent2);" title="Saisi par commercial — verrouillé">🔒</span>':''}${badgeCorrection(p)}</td>${btnDelPai2}</tr>`;
  }).join('')||`<tr><td colspan="${session&&['admin','chef_agence'].includes(session.role)?8:7}" class="emp">Aucun paiement</td></tr>`;
  const detPaysTh = document.getElementById('det-pays-th-actions');
  if(detPaysTh) detPaysTh.style.display = (session&&['admin','chef_agence'].includes(session.role)) ? '' : 'none';
  const livs=DB.livraisons.filter(l=>l.clientId===cid).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  document.getElementById('det-liv-list').innerHTML=livs.map(l=>`<tr><td>${esc(l.date)}</td><td class="fw6">${esc(getProd(l.produitId).nom)}</td><td>${esc(String(l.qty||""))}</td><td>${fmt(l.montant)}</td><td>${livStatut(l.statut)}</td></tr>`).join('')||'<tr><td colspan="5" class="emp">Aucune livraison</td></tr>';
  const adhPays=DB.adhesionPays.filter(a=>a.clientId===cid);
  const detAdhIsAdmin = session && session.role===ROLES.ADMIN;
  document.getElementById('det-adh-content').innerHTML=`<div class="ib ${c.adhesionStatut==='paye'?'ib-green':'ib-red'}" style="margin-bottom:8px;"><strong>Adhésion : ${fmt(c.adhesion)}</strong> — ${c.adhesionStatut==='paye'?'✅ Payé':'❌ Non payé'}${c.adhesionStatut!=='paye'&&session.role===ROLES.ADMIN?`<br><button class="btn btn-success btn-xs no-print" onclick="closeM('m-detail');openAdh('${cid}')" style="margin-top:5px">Encaisser</button>`:''}</div>${adhPays.length>0?`<div class="tw" style="margin:0"><table><thead><tr><th>Date</th><th>Montant</th><th>Note</th>${detAdhIsAdmin?'<th class="no-print"></th>':''}</tr></thead><tbody>${adhPays.map(a=>`<tr><td>${esc(a.date)}</td><td style="color:var(--accent2);font-weight:600">${fmt(a.montant)}</td><td class="tm" style="font-size:10px">${esc(a.note||'—')}</td>${detAdhIsAdmin?`<td class="no-print" style="text-align:center;"><button onclick="supprimerAdhesionPay('${a._id}','${cid}')" title="Supprimer ce frais d'adhésion" style="background:rgba(224,92,82,0.12);border:1px solid rgba(224,92,82,0.35);border-radius:6px;padding:2px 7px;color:var(--danger);font-size:11px;cursor:pointer;">🗑</button></td>`:''}</tr>`).join('')}</tbody></table></div>`:'<div class="emp" style="padding:16px">Aucun paiement d\'adhésion</div>'}`;
  document.querySelectorAll('.det-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.det-tab').classList.add('active');
  ['paiements','livraisons','adhesion'].forEach(t=>document.getElementById('det-'+t).style.display=t==='paiements'?'':'none');
  document.getElementById('det-pay-btn').style.display = (session.role===ROLES.ADMIN||session.role===ROLES.COMMERCIAL||session.role===ROLES.CHEF_AGENCE) ? '' : 'none';
  document.getElementById('det-pay-btn').onclick=()=>{closeM('m-detail');openPay(cid);};
  openM('m-detail');
};

// ========= PRODUITS DU CONTRAT (PAR CODE) =========
// Stockage interne des produits ajoutés par prefix
const _articlesAdded = { 'cl': [], 'com-ncl': [] };

// Appelé au reset du formulaire
function resetArticlesAdded(prefix){
  _articlesAdded[prefix] = [];
  const listEl = document.getElementById(prefix+'-articles-list');
  if(listEl){ listEl.innerHTML=''; listEl.style.display='none'; }
  const recap = document.getElementById(prefix+'-articles-recap');
  if(recap) recap.style.display='none';
  const codeEl = document.getElementById(prefix+'-art-code');
  if(codeEl) codeEl.value='';
  const msgEl = document.getElementById(prefix+'-art-code-msg');
  if(msgEl) msgEl.style.display='none';
}

window.ajouterArticleParCode = function(prefix){
  const codeEl = document.getElementById(prefix+'-art-code');
  const msgEl  = document.getElementById(prefix+'-art-code-msg');
  if(!codeEl||!msgEl) return;
  const code = codeEl.value.trim().toUpperCase();
  if(!code){ showMsg(msgEl,'Veuillez saisir un code produit.','err'); return; }

  // Recherche par ref (insensible à la casse) ou par nom exact
  const prod = (DB.produits||[]).find(p=>
    (p.ref||'').toUpperCase()===code ||
    (p.nom||'').toUpperCase()===code
  );
  if(!prod){ showMsg(msgEl,`Aucun produit trouvé pour le code « ${code} ».`,'err'); return; }

  // Vérifier doublon
  if(_articlesAdded[prefix].find(x=>x._id===prod._id)){
    showMsg(msgEl,`« ${esc(prod.nom)} » est déjà dans le contrat.`,'warn'); return;
  }

  _articlesAdded[prefix].push(prod);
  codeEl.value='';
  showMsg(msgEl,`✓ « ${esc(prod.nom)} » ajouté.`,'ok');
  renderArticlesList(prefix);
};

function showMsg(el, txt, type){
  el.style.display='block';
  const colors={ok:'rgba(34,212,160,0.15)',err:'rgba(224,92,82,0.14)',warn:'rgba(247,201,79,0.15)'};
  const tcol={ok:'var(--accent2)',err:'var(--danger)',warn:'var(--accent3)'};
  el.style.background=colors[type]||colors.ok;
  el.style.color=tcol[type]||tcol.ok;
  el.style.border='1px solid '+(tcol[type]||tcol.ok);
  el.style.borderRadius='5px';
  el.style.padding='4px 8px';
  el.textContent=txt;
}

function renderArticlesList(prefix){
  const list = _articlesAdded[prefix];
  const listEl = document.getElementById(prefix+'-articles-list');
  const recap  = document.getElementById(prefix+'-articles-recap');
  const montantEl = document.getElementById(prefix==='cl'?'cl-montant':'com-ncl-montant');
  const contratEl = document.getElementById(prefix==='cl'?'cl-contrat':'com-ncl-contrat');

  if(!list.length){
    if(listEl){ listEl.innerHTML=''; listEl.style.display='none'; }
    if(recap) recap.style.display='none';
    if(montantEl) montantEl.value='';
    if(contratEl) contratEl.value='';
    if(prefix==='cl') calcJour(); else calcJourComNcl();
    return;
  }

  // Affichage des lignes produit
  if(listEl){
    listEl.style.display='flex';
    listEl.innerHTML = list.map((p,i)=>`
      <div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;">
        <div>
          <span style="color:var(--accent);font-weight:700;font-size:10px;margin-right:6px;">${esc(p.ref)||'—'}</span>
          <span style="font-weight:600;">${esc(p.nom)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="color:var(--accent2);font-weight:700;">${fmt(p.prix)}</span>
          <button onclick="supprimerArticle('${prefix}',${i})"
            style="background:rgba(224,92,82,0.14);border:1px solid rgba(247,97,79,0.4);border-radius:5px;color:var(--danger);padding:2px 7px;cursor:pointer;font-size:11px;">✕</button>
        </div>
      </div>`).join('');
  }

  // Calcul total + désignation auto
  const total = list.reduce((s,p)=>s+(parseFloat(p.prix)||0),0);
  const noms  = list.map(p=>p.nom);
  if(montantEl) montantEl.value = total;
  if(contratEl) contratEl.value = noms.join(' + ');

  if(recap){
    recap.style.display='block';
    recap.innerHTML=`📦 ${list.length} produit(s) : <strong>${noms.join(', ')}</strong> &mdash; Montant total : <strong style="color:var(--accent2)">${fmt(total)}</strong>`;
  }
  if(prefix==='cl') calcJour(); else calcJourComNcl();
}

window.supprimerArticle = function(prefix, idx){
  _articlesAdded[prefix].splice(idx,1);
  renderArticlesList(prefix);
};


// Compat: ces fonctions ne font plus rien (les selects checkbox n'existent plus)
function chargerArticlesSelect(containerId, prefix){ /* obsolète */ }
function majMontantArticles(prefix){ /* obsolète */ }

// ========= FORMS =========
window.calcJour = function(){
  const p=parseFloat(document.getElementById('cl-montant').value)||0;
  const d=parseInt(document.getElementById('cl-duree').value)||365;
  const el=document.getElementById('cl-calc-info');
  if(p>0){el.style.display='block';const jmv=Math.ceil(p/d);const debut=document.getElementById('cl-debut').value||TODAY;const fin=new Date(debut+'T12:00:00');fin.setDate(fin.getDate()+d);el.innerHTML=`💰 Cotisation : <strong style="font-size:14px">${fmt(jmv)}/jour</strong> sur ${d} jours → Fin : <strong>${fin.toLocaleDateString('fr-FR')}</strong>`;}
  else el.style.display='none';
};

window.saveCl = async function(){
  const nom=document.getElementById('cl-nom').value.trim();
  const tel=document.getElementById('cl-tel').value.trim();
  const ct=document.getElementById('cl-contrat').value.trim();
  const mt=parseFloat(document.getElementById('cl-montant').value)||0;
  const debut=document.getElementById('cl-debut').value;
  if(!nom||!tel||!ct||mt<=0||!debut){notify('Champs obligatoires manquants','err');return;}
  const comId=document.getElementById('cl-com').value||session.userId;
  // Adhésion fixe 200 FCFA — lire statut depuis les boutons radio
  const adhRadio = document.querySelector('input[name="cl-adh-statut-r"]:checked');
  const adhesionStatut = adhRadio ? adhRadio.value : 'non_paye';
  try{
    const codeClient = await genererCodeClient(comId);
    // Figer les prix des produits au moment de la création du contrat
    const produitsPrixFiges = _articlesAdded['cl'].map(p=>({produitId:p._id, pvFige:p.prix, nom:p.nom}));
    const newClRef = await fbAdd('clients',{nom,tel,ville:document.getElementById('cl-ville').value,quartier:document.getElementById('cl-qrt').value,contrat:ct,montantTotal:mt,duree:parseInt(document.getElementById('cl-duree').value)||365,debut,note:document.getElementById('cl-note').value,commercialId:comId,adhesion:200,adhesionStatut,codeClient,produitsPrixFiges});
    // Si adhésion payée à la création → enregistrer dans adhesionPays pour le registre
    if(adhesionStatut === 'paye' && newClRef && newClRef._id){
      const now = new Date();
      const heure = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      try{
        await fbAdd('adhesionPays',{
          clientId: newClRef._id, commercialId: comId,
          montant: 200, date: TODAY, heure,
          note: "Adhésion encaissée à l'inscription",
          saisiParId: session.userId, saisiParNom: session.nom,
          verrouille: true
        });
      }catch(e){
        console.error('Échec enregistrement adhésion à la création:', e);
        notify(`Client ${nom} créé ✓ — Code : ${codeClient}, mais l'adhésion n'a pas pu être enregistrée (vérifiez la connexion et ressaisissez-la depuis le registre)`, 'err');
        closeM('m-client');
        return;
      }
    }
    closeM('m-client');notify(`Client ${nom} créé ✓ — Code : ${codeClient}`);
  }catch(e){
    console.error('Échec création client:', e);
    notify("Échec de la création du client — vérifiez votre connexion et réessayez. Si le problème persiste, contactez l'administrateur.", 'err');
  }
};

window.saveArticle = async function(){
  if(!['admin'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const nom=document.getElementById('art-nom').value.trim();
  const pv=parseFloat(document.getElementById('art-prix-vente').value)||0;
  if(!nom||pv<=0){notify('Désignation et prix obligatoires','err');return;}
  const editId = document.getElementById('art-edit-id').value;
  const type = document.getElementById('art-type').value||'article';
  const isPack = type==='pack';
  if(isPack && !_packComposition.length){ notify('Ajoutez au moins un composant au pack','err'); return; }
  const stock = isPack ? 0 : (parseInt(document.getElementById('art-stock').value)||0);
  const data={
    ref:document.getElementById('art-ref').value||`ART-${Date.now()}`,
    nom, cat:document.getElementById('art-cat').value,
    pv, pa:parseFloat(document.getElementById('art-prix-achat').value)||0,
    stock, stockMin: isPack ? 0 : (parseInt(document.getElementById('art-stock-min').value)||5),
    unite:document.getElementById('art-unite').value||'pièce',
    desc:document.getElementById('art-desc').value.trim(),
    type,
    composition: isPack ? _packComposition.map(c=>({articleId:c.articleId,nom:c.nom,ref:c.ref,qte:c.qte})) : []
  };
  // Images
  if(artEditImages.length){
    data.images = artEditImages;
    data.image  = artEditImages[0];
  }
  if(editId){
    const artActuel = DB.articles.find(a=>a._id===editId);
    const ancienPv = artActuel ? artActuel.pv : null;
    await fbUpdate('articles', editId, data);
    closeM('m-article');
    if(ancienPv !== null && ancienPv !== data.pv){
      // Compatibilité : anciens contrats créés avant le passage aux produits pouvaient figer un prix d'article
      const clientsProtéges = DB.clients.filter(c=>(c.articlesPrixFiges||[]).some(x=>x.articleId===editId));
      if(clientsProtéges.length>0){
        notify(`Article modifié ✓ — Prix ${fmt(ancienPv)} → ${fmt(data.pv)} · ${clientsProtéges.length} ancien(s) contrat(s) conservent leur prix 🔒`);
      } else { notify(`Article modifié ✓`); }
    } else { notify('Article modifié ✓'); }
  } else {
    if(!artEditImages.length) data.images=[]; data.image='';
    const art=await fbAdd('articles',data);
    if(stock>0) await fbAdd('stockMvts',{articleId:art._id,type:'entree',qty:stock,stockApres:stock,date:TODAY,note:'Stock initial'});
    closeM('m-article');notify('Article créé ✓');
  }
};

window.saveMvt = async function(){
  if(session?.role===ROLES.CONTROLEUR){ notify('Accès refusé — lecture seule','err'); return; }
  const artId=document.getElementById('mvt-art').value;
  const type=document.getElementById('mvt-type').value;
  const qty=parseInt(document.getElementById('mvt-qty').value)||0;
  if(!artId||qty<=0){notify('Article et quantité obligatoires','err');return;}
  const art=DB.articles.find(a=>a._id===artId);
  if(!art){notify('Article introuvable','err');return;}
  if(type==='sortie'&&qty>art.stock){notify(`Stock insuffisant (${art.stock})','err`);return;}
  // Destination pour les sorties
  let destinationId='', destinationNom='', destinationLibre='';
  if(type==='sortie'){
    const selDest = document.getElementById('mvt-dest-agence');
    const libDest = document.getElementById('mvt-dest-libre');
    const destVal = selDest?.value||'';
    if(destVal==='__autre__'){
      destinationLibre = (libDest?.value||'').trim();
      if(!destinationLibre){ notify('Précisez le motif de sortie','err'); return; }
    } else if(destVal){
      destinationId = destVal;
      const ag = DB.agences.find(a=>a._id===destVal);
      destinationNom = ag ? ag.nom : destVal;
    } else {
      notify('Précisez la destination de la sortie','err'); return;
    }
  }
  const newStock=art.stock+(type==='entree'?qty:-qty);
  await fbUpdate('articles',artId,{stock:newStock});
  const mvtData={articleId:artId,type,qty,stockApres:newStock,
    date:document.getElementById('mvt-date').value||TODAY,
    note:document.getElementById('mvt-note').value};
  if(type==='sortie'){
    if(destinationId) mvtData.destinationId=destinationId;
    if(destinationNom) mvtData.destinationNom=destinationNom;
    if(destinationLibre) mvtData.destinationLibre=destinationLibre;
  }
  await fbAdd('stockMvts',mvtData);
  closeM('m-stock-mvt');notify('Mouvement enregistré ✓');
};

window.openMvtFor = function(artId){
  openM('m-stock-mvt');
  setTimeout(()=>{
    const art = DB.articles.find(a=>a._id===artId);
    if(art) mvtSelectArt(art);
  }, 150);
};

window.saveLivraison = async function(){
  if(!['admin','secretaire','commercial'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const cId=document.getElementById('liv-client').value;
  const pId=document.getElementById('liv-article').value;
  const qty=parseInt(document.getElementById('liv-qty').value)||1;
  const date=document.getElementById('liv-date').value;
  if(!cId||!pId||!date){notify('Client, produit et date obligatoires','err');return;}
  const statut=document.getElementById('liv-statut').value;
  const prod=getProd(pId);
  const montantLivraison = parseFloat(document.getElementById('liv-montant').value)||0;

  // ── BLOCAGE SOLDE INSUFFISANT ──
  const client = DB.clients.find(c=>c._id===cId);
  if(client && prod){
    const solde = soldeClient(client);
    // Prix figé au contrat du client (protège contre les changements de prix produit)
    const prixFige = (client.produitsPrixFiges||[]).find(x=>x.produitId===pId);
    const pvUtilise = prixFige ? prixFige.pvFige : prod.prix;
    const coutProduit = pvUtilise * qty;
    if(solde < coutProduit){
      notify(`⛔ Livraison bloquée — Solde client insuffisant : ${fmt(solde)} disponible, ${fmt(coutProduit)} requis.`, 'err');
      return;
    }
  }

  // Sauvegarder le prix figé dans la livraison pour l'historique
  const _prixFigeLiv = (() => {
    if(!client) return prod ? prod.prix : 0;
    const pf = (client.produitsPrixFiges||[]).find(x=>x.produitId===pId);
    return pf ? pf.pvFige : (prod ? prod.prix : 0);
  })();
  const montantFinal = montantLivraison || (_prixFigeLiv * qty);

  try{
    if(statut==='livre'&&prod){
      const warnings = await deduireStockLivraison(prod, qty, getCl(cId)?.nom||'');
      if(warnings.length) notify(`⚠️ Stock insuffisant sur : ${warnings.join(', ')}`,'warn');
    }
    // ── commercialId = commercial RÉEL du client (garantit que la livraison
    // reste toujours rattachée à la bonne agence, même quand c'est un
    // admin/secrétaire/chef d'agence qui saisit l'opération). Qui a
    // effectivement saisi la livraison reste tracé via saisiParId/saisiParNom.
    const commercialReel = client ? (client.commercialId || session.userId) : session.userId;
    await fbAdd('livraisons',{clientId:cId,commercialId:commercialReel,produitId:pId,qty,montant:montantFinal,pvFige:_prixFigeLiv,date,statut,note:document.getElementById('liv-note').value,saisiParId:session.userId,saisiParNom:session.nom});
    closeM('m-livraison');notify('Livraison enregistrée ✓');
  }catch(e){
    console.error('Échec enregistrement livraison:', e);
    notify("Échec de l'enregistrement de la livraison — vérifiez votre connexion et vérifiez le stock avant de réessayer.", 'err');
  }
};

window.marquerLivre = async function(id){
  if(!['admin','secretaire'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const l=DB.livraisons.find(l=>l._id===id);
  if(!l) return;
  const prod=getProd(l.produitId);
  try{
    if(!prod || !prod._id){ await fbUpdate('livraisons',id,{statut:'livre'}); notify('Livraison marquée livrée ✓'); return; }
    const warnings = await deduireStockLivraison(prod, l.qty, l.clientId||'');
    await fbUpdate('livraisons',id,{statut:'livre'});
    if(warnings.length){
      notify(`⚠️ Livraison marquée livrée — Stock insuffisant sur : ${warnings.join(', ')}`,'warn');
    } else {
      notify('Livraison marquée livrée ✓');
    }
  }catch(e){
    console.error('Échec marquage livraison:', e);
    notify("Échec de la mise à jour de la livraison — vérifiez votre connexion et réessayez.", 'err');
  }
};

// Décompose le produit livré en ses articles (composition de la recette) et déduit le stock de chacun.
// Retourne la liste des alertes de manque de stock.
async function deduireStockLivraison(prod, qty, clientNom){
  const warnings=[];
  const comp = prod.composition||[];
  if(!comp.length){
    warnings.push(`(« ${esc(prod.nom)} » n'a pas de composition d'articles définie)`);
    return warnings;
  }
  for(const c of comp){
    const compArt=DB.articles.find(x=>x._id===c.articleId);
    if(!compArt){ warnings.push(`(composant inconnu)`); continue; }
    const needed=c.qte*qty;
    const deduct=Math.min(needed, compArt.stock);
    const ns=Math.max(0,compArt.stock-needed);
    await fbUpdate('articles',c.articleId,{stock:ns});
    await fbAdd('stockMvts',{articleId:c.articleId,type:'sortie',qty:deduct,stockApres:ns,date:TODAY,note:`Produit livré: ${esc(prod.nom)} × ${qty} → client ${clientNom}`});
    if(deduct<needed) warnings.push(`${esc(compArt.nom)} (manque ${needed-deduct})`);
  }
  return warnings;
}

window.verifierPrefix = function(input){
  const p = input.value.trim().toUpperCase();
  input.value = p;
  const status  = document.getElementById('com-prefix-status');
  const preview = document.getElementById('com-prefix-preview');
  if(!p){ status.innerHTML=''; preview.textContent=''; return; }
  const existing = DB.commerciaux.filter(c=>c.role!=='admin').map(c=>(c.codePrefix||'').toUpperCase());
  if(existing.includes(p)){
    status.innerHTML=`<span style="color:var(--danger);">❌ Ce préfixe est déjà utilisé par un autre commercial.</span>`;
    input.style.borderColor='var(--danger)';
    preview.textContent='';
  } else {
    status.innerHTML=`<span style="color:var(--accent2);">✓ Disponible</span>`;
    input.style.borderColor='var(--accent2)';
    preview.innerHTML=`→ <strong style="color:var(--accent);">${p}0001</strong>, <strong style="color:var(--accent);">${p}0002</strong>…`;
  }
};

window.onRoleChange = function(role){
  const prefRow = document.getElementById('com-prefix-row');
  prefRow.style.display = role===ROLES.COMMERCIAL ? '' : 'none';
  // L'agence est obligatoire uniquement pour commercial et secrétaire
  const agRow = document.getElementById('com-agence-row');
  if(agRow) agRow.style.display = ['commercial','secretaire','chef_agence'].includes(role) ? '' : 'none';
};

window.saveCom = async function(){
  const nom=document.getElementById('com-nom').value.trim();
  const role=document.getElementById('com-role').value;
  if(!nom){ notify('Le nom est obligatoire','err'); return; }
  const agenceId = document.getElementById('com-agence')?.value||'';
  if(['commercial','secretaire','chef_agence'].includes(role) && !agenceId){notify('Sélectionnez une agence','err');return;}
  let prefix='';
  if(role===ROLES.COMMERCIAL){
    prefix=document.getElementById('com-prefix').value.trim().toUpperCase();
    if(!prefix){notify('Le code préfixe est obligatoire pour un commercial','err');return;}
    const existing=DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL).map(c=>(c.codePrefix||'').toUpperCase());
    if(existing.includes(prefix)){notify(`Le préfixe "${prefix}" est déjà utilisé`,'err');return;}
  }
  const email = document.getElementById('com-email')?.value.trim().toLowerCase()||'';
  if(!email){ notify('L\'email est obligatoire (compte Firebase Auth)','err'); return; }
  try{
    // ── POINT 2 CORRIGÉ : champs sensibles HORS de 'commerciaux' ──
    // 'commerciaux' ne contient que : nom, role, email, agenceId
    // tel, zone, codePrefix, clientSeq → uniquement dans 'commerciauxPrive'
    const pubData = {nom, role, email};
    if(agenceId) pubData.agenceId = agenceId;
    const newCom = await fbAdd('commerciaux', pubData);
    if(newCom && newCom._id){
      try{
        await fbSetSameId('commerciauxPrive', newCom._id, {
          tel:        document.getElementById('com-tel').value,
          zone:       document.getElementById('com-zone').value,
          codePrefix: prefix,
          clientSeq:  0
        });
      }catch(e){ console.error('commerciauxPrive:', e); }
    }
    closeM('m-com'); fillLogin();
    const ag = DB.agences.find(a=>a._id===agenceId);
    const msg=role===ROLES.COMMERCIAL?`Commercial ${nom} créé ✓ — Préfixe : ${prefix}${ag?' — Agence : '+ag.nom:''}`:`Utilisateur ${nom} (${getRoleLabel(role)}) créé ✓${ag?' — Agence : '+ag.nom:''}`;
    notify(msg);
  }catch(e){
    console.error('Échec création utilisateur:', e);
    notify("Échec de la création de l'utilisateur — vérifiez votre connexion et réessayez.", 'err');
  }
};

window.delArt = async function(id){ if(!['admin','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; } if(!(await confirmDialog('Supprimer cet article ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true}))) return; await fbDelete('articles',id); notify('Article supprimé'); };

window.editArt = function(id){
  if(!['admin','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const a = DB.articles.find(x=>x._id===id);
  if(!a){ notify('Article introuvable','err'); return; }
  document.getElementById('art-edit-id').value = id;
  document.getElementById('m-article-title').textContent = '✏️ Modifier l\'article';
  document.getElementById('art-ref').value = a.ref||'';
  document.getElementById('art-nom').value = a.nom||'';
  document.getElementById('art-cat').value = a.cat||'';
  document.getElementById('art-prix-vente').value = a.pv||'';
  document.getElementById('art-prix-achat').value = a.pa||'';
  document.getElementById('art-stock').value = a.stock||0;
  document.getElementById('art-stock-min').value = a.stockMin||5;
  document.getElementById('art-unite').value = a.unite||'';
  document.getElementById('art-desc').value = a.desc||a.description||'';
  // Type pack / article
  artSetType(a.type==='pack'?'pack':'article');
  // Composition pack
  _packComposition = (a.composition||[]).map(c=>({...c}));
  renderPackCompList();
  // Images
  artEditImages = artImages(a);
  renderArtGalleryEdit();
  openM('m-article');
};
window.delLiv = async function(id){
  if(!['admin','secretaire'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const liv = (DB.livraisons||[]).find(l=>l._id===id);
  if(liv && liv.date && liv.date!==TODAY && session.role!=='admin'){
    notify('🚫 Cette livraison a été effectuée un jour précédent — seul un administrateur peut la supprimer.','err');
    return;
  }
  if(!(await confirmDialog('Supprimer cette livraison ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('livraisons',id);
  notify('Livraison supprimée');
};
window.delCom = async function(id){
  // FIX 6 : seul l'admin peut supprimer un utilisateur
  if(session?.role !== 'admin'){ notify('Accès refusé — admin uniquement','err'); return; }
  // Empêcher l'admin de se supprimer lui-même
  if(id === session?.userId){ notify('Vous ne pouvez pas supprimer votre propre compte','err'); return; }
  if(!(await confirmDialog('Supprimer cet utilisateur ?',{title:'🗑 Suppression utilisateur',okLabel:'Supprimer',danger:true}))) return;
  await fbDelete('commerciaux',id);
  // Supprimer aussi les données privées associées
  try { await fbDelete('commerciauxPrive', id); } catch(e){ console.warn('[commerciauxPrive] Suppression échouée pour id:', id, e); }
  fillLogin();
  notify('Utilisateur supprimé');
};

let miseCtx = null;
window.openMise = function(comId){
  miseCtx = comId;
  const c = DB.commerciaux.find(x=>x._id===comId)||{nom:'?'};
  const tot = DB.paiements.filter(p=>p.commercialId===comId).reduce((a,p)=>a+p.montant,0);
  const totMises = (DB.mises||[]).filter(m=>m.commercialId===comId).reduce((a,m)=>a+m.montant,0);
  document.getElementById('mise-info').innerHTML =
    `<strong>${esc(c.nom)}</strong> — Collecté : <strong style="color:var(--accent2)">${fmt(tot)}</strong> &nbsp;|&nbsp; Mises versées : <strong style="color:var(--danger)">${fmt(totMises)}</strong> &nbsp;|&nbsp; Solde : <strong style="color:var(--accent)">${fmt(tot-totMises)}</strong>`;
  document.getElementById('mise-amt').value='';
  document.getElementById('mise-note').value='';
  document.getElementById('mise-date').value=TODAY;
  // Historique des mises
  const hist=(DB.mises||[]).filter(m=>m.commercialId===comId).sort((a,b)=>b.date.localeCompare(a.date));
  document.getElementById('mise-hist').innerHTML = hist.length===0?'' :
    `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600;">Historique des mises</div>
     <div style="max-height:160px;overflow-y:auto;">
       <table style="width:100%;border-collapse:collapse;">
         <thead><tr style="font-size:9.5px;color:var(--muted)"><th style="text-align:left;padding:4px 8px">Date</th><th style="text-align:left;padding:4px 8px">Montant</th><th style="text-align:left;padding:4px 8px">Note</th><th style="padding:4px 8px"></th></tr></thead>
         <tbody>${hist.map(m=>`<tr style="border-top:1px solid var(--border);font-size:12px">
           <td style="padding:5px 8px;color:var(--muted)">${m.date}</td>
           <td style="padding:5px 8px;color:var(--danger);font-weight:600">${fmt(m.montant)}</td>
           <td style="padding:5px 8px;font-size:11px">${esc(m.note||'—')}</td>
           <td style="padding:5px 8px"><button class="btn btn-xs btn-warn" onclick="delMise('${m._id}')">✕</button></td>
         </tr>`).join('')}</tbody>
       </table>
     </div>`;
  openM('m-mise');
};

// ── Marquer versé depuis le Registre (bouton par ligne commerciale) ──
window.marquerVerseRegistre = async function(comId, date){
  const role = session?.role;
  if(!['admin','secretaire'].includes(role)){ notify('Accès refusé','err'); return; }
  const com = DB.commerciaux.find(c=>c._id===comId)||{nom:'?'};
  const existing = getVersementDuJour(comId, date);
  if(existing){ notify(`⚠️ Déjà marqué versé pour ${esc(com.nom)}`,'err'); return; }
  // Calculer total du jour
  const cls = DB.clients.filter(c=>c.commercialId===comId);
  const pays = DB.paiements.filter(p=>p.date===date && cls.some(c=>c._id===p.clientId));
  const totalCotis = pays.reduce((a,p)=>a+p.montant,0);
  const clientIdsC = new Set(cls.map(c=>c._id));
  const adhJour = (DB.adhesionPays||[]).filter(a=>a.date===date && clientIdsC.has(a.clientId));
  const totalAdh = adhJour.reduce((a,x)=>a+Number(x.montant||0),0);
  const totalJour = totalCotis + totalAdh;
  if(!(await confirmDialog(`Marquer les points de ${esc(com.nom)} du ${date} comme versés ?\nTotal : ${fmt(totalJour)}`,{title:'✅ Marquer versé',okLabel:'Confirmer'}))) return;
  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  try{
    await fbAdd('versements',{
      commercialId:comId, date, montantTotal:totalJour,
      montantCotis:totalCotis, montantAdh:totalAdh,
      marqueParId:session.userId, marqueParNom:session.nom,
      marqueParRole:session.role, heureMarquage:heure, dateMarquage:TODAY
    });
    notify(`✅ Points de ${esc(com.nom)} marqués versés — ${fmt(totalJour)}`);
    renderRegistre();
  }catch(e){
    console.error('Échec marquage versement:', e);
    notify("Échec de l'enregistrement du versement — vérifiez votre connexion et réessayez.", 'err');
  }
};

window.saveMise = async function(){
  const amt=parseFloat(document.getElementById('mise-amt').value);
  if(!miseCtx||!amt||amt<=0){notify('Montant invalide','err');return;}
  try{
    await fbAdd('mises',{commercialId:miseCtx,montant:amt,date:document.getElementById('mise-date').value||TODAY,note:document.getElementById('mise-note').value.trim()});
    closeM('m-mise');
    notify('Mise enregistrée ✓');
  }catch(e){
    console.error('Échec enregistrement mise:', e);
    notify("Échec de l'enregistrement de la mise — vérifiez votre connexion et réessayez.", 'err');
  }
};

window.delMise = async function(id){
  if(!(await confirmDialog('Supprimer cette mise ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true})))return;
  await fbDelete('mises',id);
  openMise(miseCtx);
  notify('Mise supprimée');
};

// ========= MARQUER POINTS COMME VERSÉS (Secrétaire / Admin) =========
// Un versement lie une date + commercial. Une fois versé, le commercial ne peut plus
// enregistrer de mise ce jour-là.

window.annulerVersement = async function(id, comNom, date){
  if(session?.role!=='admin'){ notify('Action réservée à l\'administrateur','err'); return; }
  if(!(await confirmDialog(`Annuler le versement marqué pour ${comNom} du ${date} ?\nLe commercial redeviendra "non versé" pour cette date.`,{title:'✕ Annuler le versement',okLabel:'Annuler le versement',danger:true}))) return;
  try{
    await fbDelete('versements', id);
    notify('Versement annulé — retour à "non versé"');
    if(typeof renderRegistre==='function') renderRegistre();
    if(typeof renderFiche==='function') renderFiche();
  }catch(e){
    console.error('Échec annulation versement:', e);
    notify("Échec de l'annulation — vérifiez votre connexion.", 'err');
  }
};

function getVersementDuJour(comId, date){
  return (DB.versements||[]).find(v=>v.commercialId===comId && v.date===date);
}

window.marquerPointsVerses = async function(){
  const role = session?.role;
  if(!['admin','secretaire'].includes(role)){ notify('Accès refusé','err'); return; }
  const sel = document.getElementById('fiche-com-select');
  const comId = sel?.value || (DB.commerciaux.find(c=>c.role===ROLES.COMMERCIAL)||{})._id;
  const date = document.getElementById('fiche-date').value || TODAY;
  if(!comId){ notify('Sélectionnez un commercial','err'); return; }
  const com = DB.commerciaux.find(c=>c._id===comId)||{nom:'?'};
  const existing = getVersementDuJour(comId, date);
  if(existing){
    notify(`⚠️ Points du ${date} déjà marqués comme versés pour ${esc(com.nom)}`, 'err');
    return;
  }
  // Calculer le total du jour
  const cls = DB.clients.filter(c=>c.commercialId===comId);
  const pays = DB.paiements.filter(p=>p.date===date && cls.some(c=>c._id===p.clientId));
  const totalCotis = pays.reduce((a,p)=>a+p.montant,0);
  const clientIdsC = new Set(cls.map(c=>c._id));
  const adhJour = (DB.adhesionPays||[]).filter(a=>a.date===date && clientIdsC.has(a.clientId));
  const totalAdh = adhJour.reduce((a,x)=>a+Number(x.montant||0),0);
  const totalJour = totalCotis + totalAdh;

  if(!(await confirmDialog(`Marquer les points du ${new Date(date+'T12:00:00').toLocaleDateString('fr-FR')} comme versés pour ${esc(com.nom)} ?\n\nMontant total : ${fmt(totalJour)}\n\n⚠️ Le commercial ne pourra plus enregistrer de mise pour cette date.`,{title:'✅ Marquer versé',okLabel:'Confirmer'}))) return;

  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  await fbAdd('versements',{
    commercialId: comId,
    date: date,
    montantTotal: totalJour,
    montantCotis: totalCotis,
    montantAdh: totalAdh,
    marqueParId: session.userId,
    marqueParNom: session.nom,
    marqueParRole: session.role,
    heureMarquage: heure,
    dateMarquage: TODAY
  });
  notify(`✅ Points de ${esc(com.nom)} du ${date} marqués comme versés — ${fmt(totalJour)}`);
  renderFiche();
};

window.livFiltrerClients = function(){
  const comId = document.getElementById('liv-filter-com').value;
  const code  = (document.getElementById('liv-search-code').value||'').trim().toUpperCase();
  let clients = DB.clients;
  if(comId)  clients = clients.filter(c=>c.commercialId===comId);
  if(code)   clients = clients.filter(c=>(c.codeClient||'').toUpperCase().includes(code)||(c.nom||'').toUpperCase().includes(code));
  const count = document.getElementById('liv-cl-count');
  count.textContent = clients.length ? `(${clients.length} client${clients.length>1?'s':''})` : '(aucun)';
  const sel = document.getElementById('liv-client');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Sélectionner un client —</option>' +
    clients.map(c=>{
      const com = getCom(c.commercialId);
      return `<option value="${c._id}"${prev===c._id?' selected':''}>${c.codeClient?c.codeClient+' — ':''} ${esc(c.nom)} · ${esc(com.nom||'')}` + `</option>`;
    }).join('');
  // Si le client précédemment sélectionné n'est plus dans la liste, réinitialiser l'info
  if(prev && !clients.find(c=>c._id===prev)){
    document.getElementById('liv-client-info').style.display='none';
    document.getElementById('liv-info').style.display='none';
  } else if(prev){ onLivClientChange(); }
};

window.onLivClientChange = function(){
  const el=document.getElementById('liv-info');el.style.display='none';
  const cId=document.getElementById('liv-client').value;
  const infoBox=document.getElementById('liv-client-info');
  if(!cId){ infoBox.style.display='none'; return; }
  const c=getCl(cId);
  const com=getCom(c.commercialId);
  const solde = soldeClient(c);
  const soldeColor = solde>=0 ? 'var(--accent2)' : 'var(--danger)';
  const soldeBg = solde>=0 ? 'rgba(34,212,160,0.10)' : 'rgba(247,97,79,0.10)';
  const soldeBorder = solde>=0 ? 'rgba(34,212,160,0.3)' : 'rgba(247,97,79,0.4)';
  infoBox.style.display='block';
  infoBox.innerHTML=`<span style="color:var(--accent);font-weight:700;">${esc(c.codeClient||'')}</span>${c.codeClient?' — ':''}
    <strong style="color:var(--text)">${esc(c.nom)}</strong> &nbsp;·&nbsp;
    <span style="color:var(--muted)">${esc(c.tel||'')}</span> &nbsp;·&nbsp;
    Commercial : <span style="color:var(--accent2)">${esc(com.nom||'—')}</span>
    <span style="display:inline-flex;align-items:center;gap:5px;margin-left:12px;padding:3px 10px;border-radius:20px;border:1px solid ${soldeBorder};background:${soldeBg};font-size:11px;font-weight:700;color:${soldeColor};">
      💳 Solde dispo. : ${fmt(solde)}
    </span>`;
  const livs=DB.livraisons.filter(l=>l.clientId===cId);
  if(livs.length){el.style.display='block';el.innerHTML=`📦 Ce client a déjà <strong>${livs.length}</strong> livraison(s). <button class="btn btn-ghost btn-xs" onclick="openDet('${cId}');closeM('m-livraison')">Voir</button>`;}
  // Avertissement si solde négatif ou nul
  if(solde<=0){
    el.style.display='block';
    el.innerHTML=`<span style="color:var(--danger);font-weight:700;">⛔ Solde insuffisant (${fmt(solde)}) — toute livraison sera bloquée.</span>`;
  }
};
// Recherche article par code dans le modal livraison
window.onLivArtCodeInput = function(force){
  const codeInput = document.getElementById('liv-art-code');
  const artHidden = document.getElementById('liv-article');
  const infoEl = document.getElementById('liv-art-info');
  const errEl = document.getElementById('liv-art-err');
  const code = (codeInput.value||'').trim().toUpperCase();
  if(!code){
    artHidden.value=''; infoEl.style.display='none'; errEl.style.display='none';
    document.getElementById('liv-info').style.display='none';
    return;
  }
  // Chercher par ref exacte, ou ref partielle, ou nom
  let prod = (DB.produits||[]).find(p=>(p.ref||'').toUpperCase()===code);
  if(!prod) prod = (DB.produits||[]).find(p=>(p.ref||'').toUpperCase().startsWith(code));
  if(!prod && force) prod = (DB.produits||[]).find(p=>(p.nom||'').toUpperCase().includes(code));
  if(prod){
    artHidden.value = prod._id;
    errEl.style.display='none';
    const cId = document.getElementById('liv-client').value;
    const c = cId ? getCl(cId) : null;
    const prixFige = c ? (c.produitsPrixFiges||[]).find(x=>x.produitId===prod._id) : null;
    const pvAff = prixFige ? prixFige.pvFige : prod.prix;
    const stockDispo = stockDisponibleProduit(prod);
    const stockColor = stockDispo>0?'var(--accent2)':'var(--danger)';
    const prixLabel = prixFige
      ? `${fmt(pvAff)} <span style="font-size:10px;color:var(--accent2);">🔒 prix contrat</span>`
      : fmt(prod.prix);
    infoEl.style.display='block';
    infoEl.innerHTML=`✅ <strong>${esc(prod.nom)}</strong> &nbsp;·&nbsp; Réf: <strong style="color:var(--accent)">${esc(prod.ref||'-')}</strong> &nbsp;·&nbsp; Stock dispo. : <strong style="color:${stockColor}">${stockDispo}</strong> &nbsp;·&nbsp; Prix : ${prixLabel}`;
    // Déclencher onLivArtChange pour mettre à jour le panneau montant/solde
    onLivArtChange();
  } else {
    artHidden.value='';
    infoEl.style.display='none';
    if(code.length>=3){
      errEl.style.display='block';
      errEl.textContent=`❌ Aucun produit trouvé pour le code « ${code} »`;
    } else {
      errEl.style.display='none';
    }
    document.getElementById('liv-info').style.display='none';
  }
};

// Stock disponible d'un produit = quantité maximale livrable selon le stock des articles de sa composition
function stockDisponibleProduit(prod){
  const comp = prod.composition||[];
  if(!comp.length) return 0;
  return Math.min(...comp.map(c=>{
    const art = DB.articles.find(x=>x._id===c.articleId);
    if(!art || !c.qte) return 0;
    return Math.floor((art.stock||0) / c.qte);
  }));
}

window.onLivArtChange = function(){
  const pId=document.getElementById('liv-article').value;
  if(!pId) return;
  const prod=getProd(pId);
  calcLivMontant();
  const qty=parseInt(document.getElementById('liv-qty').value)||1;
  const cId=document.getElementById('liv-client').value;
  // Utiliser prix figé au contrat si disponible
  const c = cId ? getCl(cId) : null;
  const prixFige = c ? (c.produitsPrixFiges||[]).find(x=>x.produitId===pId) : null;
  const pvAffiche = prixFige ? prixFige.pvFige : prod.prix;
  const coutProduit = pvAffiche * qty;
  const infoEl=document.getElementById('liv-info');
  infoEl.style.display='block';
  let warnHtml='';
  if(c){
    const solde=soldeClient(c);
    const soldeColor = solde>=coutProduit?'var(--accent2)':'var(--danger)';
    warnHtml=` &nbsp;<span style="font-weight:700;color:${soldeColor};">${solde>=coutProduit?'✓ Solde OK':'⛔ Solde insuffisant'} (${fmt(solde)} dispo.)</span>`;
  }
  const prixLabel = prixFige
    ? `<strong>${fmt(pvAffiche)}</strong> <span style="font-size:10px;color:var(--accent2);" title="Prix figé au contrat — protégé du changement de tarif">🔒 prix contrat</span>`
    : `<strong>${fmt(prod.prix)}</strong>`;
  const stockDispo = stockDisponibleProduit(prod);
  infoEl.innerHTML=`📦 <strong>${esc(prod.nom)}</strong> — Stock dispo. : <strong style="color:${stockDispo>0?'var(--accent2)':'var(--danger)'}">${stockDispo}</strong> — Prix : ${prixLabel}${warnHtml}`;
};
window.calcLivMontant = function(){
  const pId=document.getElementById('liv-article').value;
  const qty=parseInt(document.getElementById('liv-qty').value)||1;
  if(!pId)return;
  const prod=getProd(pId);
  const cId=document.getElementById('liv-client').value;
  const c = cId ? getCl(cId) : null;
  const prixFige = c ? (c.produitsPrixFiges||[]).find(x=>x.produitId===pId) : null;
  const pv = prixFige ? prixFige.pvFige : prod.prix;
  document.getElementById('liv-montant').value=pv*qty;
};

// ========= MODALS =========
window.openM = function(id){
  document.getElementById(id).classList.add('open');
  if(id==='m-agence'){
    // Réinitialiser — évite qu'un ID de modif précédent reste en mémoire
    document.getElementById('m-agence-title').textContent='🏢 Nouvelle agence';
    document.getElementById('agence-id').value='';
    ['agence-nom','agence-ville','agence-desc'].forEach(i=>document.getElementById(i).value='');
  }
  if(id==='m-client'){
    ['cl-nom','cl-tel','cl-ville','cl-qrt','cl-contrat','cl-note'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('cl-montant').value='';document.getElementById('cl-duree-sel').value='372';document.getElementById('cl-duree').value='372';document.getElementById('cl-duree').style.display='none';
    document.getElementById('cl-debut').value=TODAY;document.getElementById('cl-adhesion').value='0';
    document.getElementById('cl-adhesion-statut').value='non_paye';
    const clAdhRNP=document.getElementById('cl-adh-non-paye'); if(clAdhRNP) clAdhRNP.checked=true;
    document.getElementById('cl-calc-info').style.display='none';
    document.getElementById('cl-com').innerHTML='<option value="">— Sélectionner —</option>'+comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL).map(c=>`<option value="${c._id}">${esc(c.nom)}</option>`).join('');
    // Charger les articles multi-select
    resetArticlesAdded('cl');
  }
  if(id==='m-com'){
    ['com-nom','com-tel','com-zone','com-pin','com-prefix'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('com-prefix-status').innerHTML='';
    document.getElementById('com-prefix-preview').textContent='';
    document.getElementById('com-role').value='commercial';
    document.getElementById('com-prefix-row').style.display='';
    document.getElementById('com-agence-row').style.display='';
    remplirSelectAgences('com-agence','');
    const prefEl=document.getElementById('com-prefix');
    if(prefEl) prefEl.style.borderColor='rgba(201,168,76,0.4)';
  }
  if(id==='m-agence'){
    document.getElementById('m-agence-title').textContent='🏢 Nouvelle agence';
    document.getElementById('agence-id').value='';
    ['agence-nom','agence-ville','agence-desc'].forEach(i=>document.getElementById(i).value='');
  }
  if(id==='m-article'){
    document.getElementById('art-edit-id').value='';
    document.getElementById('m-article-title').textContent='📦 Nouvel article';
    ['art-ref','art-nom','art-cat','art-unite','art-desc'].forEach(i=>document.getElementById(i).value='');
    ['art-prix-vente','art-prix-achat'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('art-stock').value='0';
    document.getElementById('art-stock-min').value='5';
    artImageBase64=null;
    artEditImages=[];
    renderArtGalleryEdit();
    _packComposition=[];
    renderPackCompList();
    artSetType('article');
    document.getElementById('art-img-preview').style.display='none';
    document.getElementById('art-img-preview').src='';
    document.getElementById('art-img-actions').style.display='none';
    document.getElementById('art-img-drop').style.display='none';
    document.getElementById('art-img-input').value='';
    document.getElementById('pack-comp-search').value='';
    document.getElementById('pack-comp-results').style.display='none';
  }
  if(id==='m-stock-mvt'){
    // Réinitialiser la recherche article
    document.getElementById('mvt-art').value='';
    document.getElementById('mvt-art-search').value='';
    document.getElementById('mvt-art-results').style.display='none';
    document.getElementById('mvt-art-selected').style.display='none';
    document.getElementById('mvt-art-search').style.display='';
    document.getElementById('mvt-type').value='entree';
    document.getElementById('mvt-destination-zone').style.display='none';
    document.getElementById('mvt-dest-libre').style.display='none';
    document.getElementById('mvt-dest-libre').value='';
    document.getElementById('mvt-date').value=TODAY;
    ['mvt-qty','mvt-note'].forEach(i=>document.getElementById(i).value='');
    // Peupler le select agences de destination (une seule fois)
    const selDest = document.getElementById('mvt-dest-agence');
    if(selDest && selDest.options.length <= 2){
      DB.agences.forEach(ag=>{
        const o=document.createElement('option');
        o.value=ag._id; o.textContent='🏢 '+ag.nom+(ag.ville?' — '+ag.ville:'');
        // Insérer avant l'option "Autre"
        selDest.insertBefore(o, selDest.options[selDest.options.length-1]);
      });
    }
  }
  if(id==='m-livraison'){
    // Remplir la liste des commerciaux (filtre)
    const comsActifs = DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL);
    document.getElementById('liv-filter-com').innerHTML =
      '<option value="">— Tous les commerciaux —</option>' +
      comsActifs.map(c=>`<option value="${c._id}">${esc(c.nom)}${c.prefixCode?' ('+c.prefixCode+')':''}</option>`).join('');
    // Reset champs de recherche
    document.getElementById('liv-search-code').value = '';
    document.getElementById('liv-client-info').style.display = 'none';
    // Charger tous les clients
    livFiltrerClients();
    document.getElementById('liv-article').value='';
    const livArtCode=document.getElementById('liv-art-code'); if(livArtCode) livArtCode.value='';
    const livArtInfo=document.getElementById('liv-art-info'); if(livArtInfo) livArtInfo.style.display='none';
    const livArtErr=document.getElementById('liv-art-err'); if(livArtErr) livArtErr.style.display='none';
    document.getElementById('liv-date').value=TODAY;document.getElementById('liv-qty').value='1';
    document.getElementById('liv-montant').value='';document.getElementById('liv-note').value='';
    document.getElementById('liv-info').style.display='none';
  }
};
window.closeM = function(id){ document.getElementById(id).classList.remove('open'); };

// ── Visionneuse photo plein écran (galerie) ───────────────────
window.openImageLightbox = function(url, ev){
  if(ev) ev.stopPropagation();
  if(!url) return;
  const img = document.getElementById('img-lightbox-img');
  img.src = url;
  document.getElementById('m-img-lightbox').classList.add('open');
};
window.closeImageLightbox = function(ev){
  if(ev) ev.stopPropagation();
  document.getElementById('m-img-lightbox').classList.remove('open');
  document.getElementById('img-lightbox-img').src = '';
};
document.querySelectorAll('.mo').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) m.classList.remove('open'); }));

// ── Confirmation personnalisée (remplace window.confirm() — point 8 de l'audit) ──
// Usage : if(!(await confirmDialog('Texte...'))) return;
// Optionnel : confirmDialog('Texte', {title:'🗑 Suppression', okLabel:'Supprimer', danger:true})

// ── POINT 6 CORRIGÉ : jeton unique par dialog ──
// Un appel console direct à _cfmAnswer(true) sans avoir ouvert le dialog
// ne peut pas résoudre la promesse (jeton expiré ou inconnu).
let _cfmResolve = null;
let _cfmToken = null; // jeton unique valide uniquement pour le dialog en cours

window.confirmDialog = function(message, opts={}){
  // Vérifier que la session est toujours active
  if (!session || !auth?.currentUser) {
    notify('Session expirée — veuillez vous reconnecter', 'err');
    window.doLogout();
    return Promise.resolve(false);
  }
  return new Promise(resolve=>{
    _cfmToken = Math.random().toString(36).slice(2); // jeton à usage unique
    _cfmResolve = resolve;
    document.getElementById('cfm-title').textContent = opts.title || '⚠️ Confirmation';
    document.getElementById('cfm-body').textContent = message;
    const btnOk = document.getElementById('cfm-btn-ok');
    btnOk.textContent = opts.okLabel || '✓ Confirmer';
    btnOk.className = 'btn ' + (opts.danger ? 'btn-warn' : 'btn-primary');
    // Stocker le jeton dans l'attribut du bouton OK (non devinable depuis la console)
    btnOk.dataset.cfmToken = _cfmToken;
    openM('m-confirm-generic');
    setTimeout(()=>document.getElementById('cfm-btn-cancel')?.focus(), 50);
  });
};

window._cfmAnswer = function(val, token){
  // Vérifier le jeton ET la session avant d'accepter la confirmation
  if (val === true) {
    if (!token || token !== _cfmToken) {
      console.warn('confirmDialog: jeton invalide — action bloquée');
      return;
    }
    if (!session || !auth?.currentUser) {
      notify('Session expirée', 'err');
      window.doLogout();
      return;
    }
  }
  _cfmToken = null; // invalider le jeton après usage
  closeM('m-confirm-generic');
  if(_cfmResolve){ const r=_cfmResolve; _cfmResolve=null; r(val); }
};
// Clic sur le fond, ou touche Échap : équivaut à "Annuler"
document.getElementById('m-confirm-generic')?.addEventListener('click', e=>{
  if(e.target.id==='m-confirm-generic') window._cfmAnswer(false);
});
document.addEventListener('keydown', e=>{
  if(e.key==='Escape' && document.getElementById('m-confirm-generic')?.classList.contains('open')) window._cfmAnswer(false);
});

// ========= NOTIF =========
// Historisé dans la cloche 🔔 (plus de toast éphémère — voir _notifBellPush)
window.notify = function(msg,t='',clientId=null){
  _notifBellPush(msg,t,clientId);
};

// ── Cloche 🔔 : historique persistant des notify() ──
const NOTIF_BELL_STORAGE_KEY = 'notifBellHistory';
const NOTIF_BELL_MAX_ITEMS   = 50;
let _notifBellItems = [];
let _notifBellPanelOpen = false;
let _chatUnreadCount = 0; // maj par _chatUpdateBadge(), lu ici pour cumuler le badge

function _notifBellLoad(){
  try { _notifBellItems = JSON.parse(localStorage.getItem(NOTIF_BELL_STORAGE_KEY)||'[]'); }
  catch(e){ _notifBellItems = []; }
}
function _notifBellSave(){
  try { localStorage.setItem(NOTIF_BELL_STORAGE_KEY, JSON.stringify(_notifBellItems.slice(0,NOTIF_BELL_MAX_ITEMS))); }
  catch(e){}
}
function _notifBellPush(msg,t,clientId=null){
  _notifBellItems.unshift({ id: Date.now()+'_'+Math.random().toString(36).slice(2,7), msg, t, ts: Date.now(), read:false, clientId });
  if(_notifBellItems.length > NOTIF_BELL_MAX_ITEMS) _notifBellItems.length = NOTIF_BELL_MAX_ITEMS;
  _notifBellSave();
  if(_notifBellPanelOpen) _notifBellRender();
  _notifBellUpdateBadge();
}
function _notifBellUnreadCount(){
  return _notifBellItems.reduce((n,it)=>n+(it.read?0:1),0);
}
function _notifBellUpdateBadge(){
  const badge = document.getElementById('notif-bell-badge');
  if(!badge) return;
  const total = _notifBellUnreadCount() + _chatUnreadCount;
  if(total>0){ badge.textContent = total>99?'99+':total; badge.classList.add('visible'); }
  else badge.classList.remove('visible');
}
function _notifBellTimeAgo(ts){
  const s = Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'à l\'instant';
  if(s<3600) return Math.floor(s/60)+' min';
  if(s<86400) return Math.floor(s/3600)+' h';
  return Math.floor(s/86400)+' j';
}
function _notifBellRender(){
  const list = document.getElementById('notif-list');
  if(!list) return;
  if(!_notifBellItems.length){
    list.innerHTML = '<div class="notif-panel-empty">Aucune notification pour le moment.</div>';
    return;
  }
  list.innerHTML = _notifBellItems.map(it=>`
    <div class="notif-item${it.t==='err'?' err':''}${it.read?'':' unread'}${it.clientId?' notif-item-clickable':''}"${it.clientId?` onclick="notifBellGoToClient('${it.clientId}','${it.id}')" style="cursor:pointer;"`:''}>
      <span class="notif-item-dot"></span>
      <div class="notif-item-body">
        <div class="notif-item-msg">${esc(it.msg)}</div>
        <div class="notif-item-time">${_notifBellTimeAgo(it.ts)}${it.clientId?' · 👁 Voir la fiche client':''}</div>
      </div>
    </div>
  `).join('');
}
// Clic sur une notification d'alerte livraison/carnet : ouvre directement la
// fiche du client concerné (même comportement que la notification navigateur).
window.notifBellGoToClient = function(clientId, notifId){
  const it = _notifBellItems.find(n=>n.id===notifId);
  if(it) it.read = true;
  _notifBellSave();
  _notifBellUpdateBadge();
  notifBellToggle(false);
  if(typeof ouvrirFicheClient === 'function') ouvrirFicheClient(clientId);
};
window.notifBellToggle = function(force){
  const panel = document.getElementById('notif-panel');
  if(!panel) return;
  _notifBellPanelOpen = (force!==undefined) ? force : !_notifBellPanelOpen;
  panel.classList.toggle('open', _notifBellPanelOpen);
  if(_notifBellPanelOpen){
    _notifBellRender();
    // On considère les notifications comme lues à l'ouverture du panneau
    // (même logique que l'ouverture d'une conversation du chat).
    _notifBellItems.forEach(it=>it.read=true);
    _notifBellSave();
    _notifBellUpdateBadge();
  }
};
window.notifBellClearAll = function(){
  _notifBellItems = [];
  _notifBellSave();
  _notifBellRender();
  _notifBellUpdateBadge();
};
// ── Visibilité de la cloche 🔔 : réservée à secrétaire, chef d'agence, admin ──
const NOTIF_BELL_ALLOWED_ROLES = [ROLES.SECRETAIRE, ROLES.CHEF_AGENCE, ROLES.ADMIN];
function _notifBellInit(){
  const bell = document.getElementById('notif-bell');
  if(!bell) return;
  const allowed = session && NOTIF_BELL_ALLOWED_ROLES.includes(session.role);
  bell.style.display = allowed ? 'flex' : 'none';
  if(!allowed){
    const panel = document.getElementById('notif-panel');
    if(panel) panel.classList.remove('open');
    _notifBellPanelOpen = false;
  }
}

_notifBellLoad();
_notifBellUpdateBadge();


// ========= PRINT CLIENTS =========
window.printClients = function(){
  const sel = document.getElementById('filter-com');
  const comId = sel.value;
  const comName = comId ? (DB.commerciaux.find(c=>c._id===comId)||{nom:'Tous'}).nom : 'Tous les utilisateurs';
  let cls = clientsDansAgence();
  if(comId) cls = cls.filter(c=>c.commercialId===comId);
  document.getElementById('print-cl-com-name').textContent = comName;
  document.getElementById('print-cl-date').textContent = 'Imprimé le ' + new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('print-cl-count').textContent = cls.length + ' client(s)';
  window.print();
};

// ========= IMPORT =========
let importData = [];

window.handleImport = async function(event){
  const file = event.target.files[0];
  if(!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let rows = [];
    if(ext === 'csv'){ rows = await parseCSV(file); }
    else if(ext === 'xlsx' || ext === 'xls'){ rows = await parseXLSX(file); }
    else { notify('Format non supporté. Utilisez .csv ou .xlsx','err'); return; }
    if(!rows || rows.length === 0){ notify('Fichier vide ou non lisible','err'); return; }
    prepareImportPreview(rows);
  } catch(e){ notify('Erreur de lecture : ' + e.message, 'err'); }
  event.target.value = '';
};

async function parseCSV(file){
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length < 2) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h=>h.trim().replace(/^["']|["']$/g,'').toLowerCase());
  return lines.slice(1).map(line=>{
    const vals = line.split(sep).map(v=>v.trim().replace(/^["']|["']$/g,''));
    const obj={};
    headers.forEach((h,i)=>obj[h]=vals[i]||'');
    return obj;
  }).filter(r=>Object.values(r).some(v=>v));
}

async function parseXLSX(file){
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=res; s.onerror=rej;
      document.head.appendChild(s);
    });
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, {defval:''});
  return data.map(row=>{
    const obj={};
    Object.keys(row).forEach(k=>obj[k.toLowerCase().trim()]=String(row[k]||''));
    return obj;
  });
}

function normalizeRow(row){
  const get = (...keys) => { for(const k of keys){ if(row[k]!==undefined && row[k]!=='') return row[k]; } return ''; };
  return {
    nom:             get('nom','name','client','prénom nom','prenom nom'),
    tel:             get('telephone','téléphone','tel','phone','mobile','gsm','contact'),
    ville:           get('ville','city','localite','localité'),
    quartier:        get('quartier','adresse','address','zone','secteur'),
    contrat:         get('contrat','article','produit','designation','désignation','objet','description'),
    montant:         parseFloat(get('montant','montant_total','montant total','prix','amount','valeur','total')) || 0,
    cotisationJour:  parseFloat(get('cotisation_jour','cotisation jour','cotis_jour','cotis jour','mise_jour','mise jour','cotisation_journaliere','cotisation journaliere')) || 0,
    duree:           parseInt(get('duree','durée','jours','nb_jours','nb jours','days')) || 372,
    debut:           normalizeDate(get('debut','date_debut','date debut','date_contrat','date contrat','start')),
    adhesion:        parseFloat(get('adhesion','adhésion','droit_adhesion','droit adhesion','inscription')) || 0,
    // Statut d'adhésion déduit du montant : 200 dans la colonne adhésion = payé. Vide, autre valeur ou texte (ex: un pays) = non payé.
    adhesionStatut:  (()=>{ const v = parseFloat(get('adhesion','adhésion','droit_adhesion','droit adhesion','inscription')) || 0; return v===200 ? 'paye' : 'non_paye'; })(),
    codeClient:      (get('code_client','code client','codeclient','code','id_client','id client','identifiant')||'').toString().trim().toUpperCase(),
    // Paiements déjà effectués
    montantDejaPaye: parseFloat(get('montant_deja_paye','montant deja paye','montant_déjà_payé','montant déjà payé','deja_paye','deja paye','solde_initial','solde initial','paiement_initial','paiement initial')) || 0,
    dateDernierPaiement: normalizeDate(get('date_dernier_paiement','date dernier paiement','date_paiement','date paiement','date_versement','date versement')),
    notePaiement:    String(get('note_paiement','note paiement','note_versement','note versement','commentaire_paiement')||'').trim().slice(0,200),
    // ✅ Nouveau paramètre : montant divers (pénalité, remise, frais divers...)
    montantDivers:   parseFloat(get('montant_divers','montant divers','penalite','pénalité','remise','frais_divers','frais divers','divers')) || 0,
    noteDivers:      String(get('note_divers','note divers','motif_divers','motif divers','commentaire_divers')||'').trim().slice(0,200),
  };
}

function normalizeDate(d){
  if(!d) return TODAY;
  if(/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(d)){ const p=d.split('/'); return p[2]+'-'+p[1]+'-'+p[0]; }
  if(/^\d{2}-\d{2}-\d{4}$/.test(d)){ const p=d.split('-'); return p[2]+'-'+p[1]+'-'+p[0]; }
  const dt=new Date(d);
  if(!isNaN(dt)) return dt.toISOString().split('T')[0];
  return TODAY;
}

function prepareImportPreview(rows){
  importData = rows.map(normalizeRow).filter(r=>r.nom);
  const errors = rows.length - importData.length;

  // Détecter doublons de codes dans le fichier lui-même
  const codesVus = new Set();
  const doublonsFichier = new Set();
  importData.forEach(r=>{ if(r.codeClient){ if(codesVus.has(r.codeClient)) doublonsFichier.add(r.codeClient); codesVus.add(r.codeClient); } });

  // Détecter codes déjà existants en base (= client existant → sera MIS À JOUR, pas ignoré)
  const clientsExistantsParCode = new Map(DB.clients.filter(c=>c.codeClient).map(c=>[(c.codeClient||'').toUpperCase(), c]));
  const codesExistants = new Set(clientsExistantsParCode.keys());

  const nbAvecCode  = importData.filter(r=>r.codeClient).length;
  const nbSansCode  = importData.filter(r=>!r.codeClient).length;
  const nbMaj       = importData.filter(r=>r.codeClient&&codesExistants.has(r.codeClient)&&!doublonsFichier.has(r.codeClient)).length;
  const nbDoublonsFichier = importData.filter(r=>r.codeClient&&doublonsFichier.has(r.codeClient)).length;

  document.getElementById('import-preview-info').innerHTML =
    `Fichier lu : <strong>${rows.length} ligne(s)</strong> — <strong style="color:var(--accent2)">${importData.length} ligne(s) valides</strong>`+
    (errors>0?` — <strong style="color:var(--danger)">${errors} ignorée(s)</strong>`:'')+
    `<br><span style="font-size:11px;">📋 Avec code : <strong style="color:var(--accent)">${nbAvecCode}</strong> &nbsp;|&nbsp; Sans code (généré auto) : <strong style="color:var(--accent)">${nbSansCode}</strong>`+
    (nbMaj>0?` &nbsp;|&nbsp; <strong style="color:var(--accent2)">🔄 ${nbMaj} client(s) existant(s) — seront mis à jour (infos cochées ajoutées, reste inchangé)</strong>`:'')+
    (nbDoublonsFichier>0?` &nbsp;|&nbsp; <strong style="color:var(--danger)">⚠️ ${nbDoublonsFichier} doublon(s) dans le fichier — seront ignorés</strong>`:'')+'</span>';

  document.getElementById('import-count').textContent = importData.length;
  if(errors>0){ document.getElementById('import-errors').style.display=''; document.getElementById('import-errors').textContent = errors+' lignes ignorées (nom manquant).'; }
  else { document.getElementById('import-errors').style.display='none'; }
  document.getElementById('import-com').innerHTML = '<option value="">— Sélectionner —</option>' +
    DB.commerciaux.filter(c=>c.role===ROLES.COMMERCIAL).map(c=>'<option value="'+c._id+'">'+c.nom+'</option>').join('');

  // Stats paiements
  const nbAvecCotisJ = importData.filter(r=>r.cotisationJour>0).length;
  const nbAvecPaiement = importData.filter(r=>r.montantDejaPaye>0).length;
  if(nbAvecCotisJ>0 || nbAvecPaiement>0){
    const extra = document.getElementById('import-preview-info');
    extra.innerHTML += `<br><span style="font-size:11px;">💰 Avec cotis/jour définie : <strong style="color:var(--accent)">${nbAvecCotisJ}</strong> &nbsp;|&nbsp; Avec paiements à reporter : <strong style="color:var(--accent2)">${nbAvecPaiement}</strong></span>`;
  }

  document.getElementById('import-preview-body').innerHTML = importData.slice(0,50).map((r,i)=>{
    const estDoublonFichier = r.codeClient && doublonsFichier.has(r.codeClient);
    const estClientExistant = r.codeClient && codesExistants.has(r.codeClient) && !estDoublonFichier;
    const doublon = estDoublonFichier; // seul un doublon DANS LE FICHIER est bloquant désormais
    const codeBadge = r.codeClient
      ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;background:${doublon?'rgba(224,92,82,0.14)':(estClientExistant?'rgba(56,201,160,0.14)':'rgba(201,168,76,0.15)')};color:${doublon?'var(--danger)':(estClientExistant?'var(--accent2)':'var(--accent)')};border:1px solid ${doublon?'rgba(247,97,79,0.4)':(estClientExistant?'rgba(56,201,160,0.4)':'rgba(201,168,76,0.35)')};">${esc(r.codeClient)}${doublon?' ⚠️':''}</span>`
      : `<span style="font-size:10px;color:var(--accent);font-style:italic;">auto</span>`;
    const statut = doublon ? sb('Doublon (ignoré)','sr') : (estClientExistant ? sb('🔄 Client existant — MAJ','sg') : sb('Nouveau','sg'));
    const cotisCell = r.cotisationJour>0
      ? `<span class="cotis-badge" style="font-size:10px;">💰 ${fmt(r.cotisationJour)}</span>`
      : (r.montant>0 ? `<span style="font-size:10px;color:var(--muted);font-style:italic;">${fmt(Math.ceil(r.montant/r.duree))}/j</span>` : '—');
    const paiCell = r.montantDejaPaye>0
      ? `<span style="font-size:10px;color:var(--accent2);font-weight:700;">+${fmt(r.montantDejaPaye)}</span>`
      : '<span style="color:var(--muted);font-size:10px;">—</span>';
    const adhBadge = r.adhesionStatut==='paye'
      ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;background:rgba(34,212,160,0.12);color:var(--accent2);border:1px solid rgba(34,212,160,0.3);">✓ Payé</span>`
      : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;background:rgba(224,92,82,0.1);color:var(--danger);border:1px solid rgba(224,92,82,0.25);">Non payé</span>`;
    const diversCell = r.montantDivers
      ? `<span style="font-size:10px;color:${r.montantDivers<0?'var(--danger)':'var(--accent2)'};font-weight:700;">${r.montantDivers>0?'+':''}${fmt(r.montantDivers)}</span>`
      : '<span style="color:var(--muted);font-size:10px;">—</span>';
    return `<tr${doublon?' style="background:rgba(247,97,79,0.05);"':(estClientExistant?' style="background:rgba(56,201,160,0.05);"':'')}>
      <td class="tm">${i+1}</td>
      <td class="fw6">${esc(r.nom)}</td>
      <td>${esc(r.tel||'—')}</td>
      <td>${esc(r.ville||'—')}</td>
      <td style="font-size:11px">${esc(r.contrat||'<span style="color:var(--muted);font-style:italic;">À définir</span>')}</td>
      <td>${cotisCell}</td>
      <td>${paiCell}</td>
      <td style="font-size:10px;color:var(--subtle);">${r.debut||'—'}</td>
      <td>${adhBadge}</td>
      <td>${diversCell}</td>
      <td>${codeBadge}</td>
      <td>${statut}</td>
    </tr>`;
  }).join('') + (importData.length>50?`<tr><td colspan="12" style="text-align:center;padding:10px;color:var(--muted);font-size:12px;">... et ${importData.length-50} autres lignes</td></tr>`:'');
  openM('m-import-preview');
}

window.confirmImport = async function(){
  if(!importData.length){ notify('Aucune donnée à importer','err'); return; }

  // ✅ Cases à cocher : quelles informations importer
  const impCotis    = document.getElementById('import-chk-cotis')?.checked !== false;
  const impAdhesion = document.getElementById('import-chk-adhesion')?.checked !== false;
  const impPaye     = document.getElementById('import-chk-paye')?.checked !== false;
  const impDivers   = document.getElementById('import-chk-divers')?.checked !== false;

  const comId = document.getElementById('import-com').value || session.userId;
  const dateCliInput = (document.getElementById('import-cli-date')?.value||'').trim();
  const dateImportCli = /^\d{4}-\d{2}-\d{2}$/.test(dateCliInput) ? dateCliInput : TODAY;
  // Clients déjà présents en base AVANT cet import (servent à détecter les MAJ)
  const clientsExistantsParCode = new Map(DB.clients.filter(c=>c.codeClient).map(c=>[(c.codeClient||'').toUpperCase(), c]));
  const codesUtilises = new Set(clientsExistantsParCode.keys());
  const codesVusDansFichier = new Set();

  let count=0, ignores=0, generes=0, paiementsReportes=0, majClients=0, errCount=0;
  let lastErr = null, interrompu = false;

  // Indicateur de progression empilable + bouton d'interruption
  const total = importData.length;
  const task = startProgressTask('Import clients', total);

  try {
    for(let i = 0; i < importData.length; i++){
     if(task.stopped()){ interrompu = true; break; }
     try {
      const r = importData[i];
      const nom = String(r.nom||'').trim().slice(0,100);
      const tel  = String(r.tel||'').trim().replace(/[^0-9+\s\-]/g,'').slice(0,20);
      const ville = String(r.ville||'').trim().slice(0,80);
      const quartier = String(r.quartier||'').trim().slice(0,80);
      const contrat  = String(r.contrat||'À définir').trim().slice(0,200);
      const montant  = Math.max(0, Math.min(Number(r.montant)||0, 999999999));
      const cotisationJour = (impCotis && r.cotisationJour > 0) ? Math.max(0, Math.min(Number(r.cotisationJour), 999999)) : 0;
      const duree    = Math.max(1, Math.min(Number(r.duree)||372, 3650));
      const debut    = /^\d{4}-\d{2}-\d{2}$/.test(r.debut) ? r.debut : dateImportCli;
      if(!nom){ ignores++; continue; }

      const montantDejaPaye = (impPaye) ? Math.max(0, Math.min(Number(r.montantDejaPaye)||0, 999999999)) : 0;
      const montantDivers   = (impDivers) ? Math.max(-999999999, Math.min(Number(r.montantDivers)||0, 999999999)) : 0;
      const adhesionMontant = (impAdhesion) ? (Number(r.adhesion)||0) : 0;

      let codeClient = (r.codeClient||'').toString().toUpperCase().trim().slice(0,20);

      // ── Cas 1 : le code correspond à un client déjà existant en base ⇒ MISE À JOUR (ajout d'infos, sans toucher au reste)
      if(codeClient && clientsExistantsParCode.has(codeClient) && !codesVusDansFichier.has(codeClient)){
        codesVusDansFichier.add(codeClient);
        const clientExistant = clientsExistantsParCode.get(codeClient);
        const clientId = clientExistant._id;

        // Cotisation/jour : mise à jour du montant fixe uniquement si coché et fourni
        if(cotisationJour > 0){
          await fbUpdate('clients', clientId, { cotisationJourFixe: cotisationJour });
        }
        // Droit d'adhésion : si coché et non déjà payé, on l'ajoute sans écraser le reste de la fiche
        if(impAdhesion && adhesionMontant > 0 && clientExistant.adhesionStatut !== 'paye'){
          await fbUpdate('clients', clientId, { adhesion: adhesionMontant, adhesionStatut: 'paye' });
          await fbAdd('adhesionPays', {
            clientId, commercialId: clientExistant.commercialId || comId,
            montant: adhesionMontant, date: dateImportCli, heure: '00:00',
            note: 'Adhésion reportée via import', origine: 'import_historique'
          });
        }
        // Montant déjà payé : ajouté comme paiement historique
        if(montantDejaPaye > 0){
          const datePai = /^\d{4}-\d{2}-\d{2}$/.test(r.dateDernierPaiement) ? r.dateDernierPaiement : debut;
          const cotisRef = cotisationJour > 0 ? cotisationJour : (clientExistant.cotisationJourFixe || (montant > 0 ? Math.ceil(montant/duree) : 0));
          await fbAdd('paiements', {
            clientId, commercialId: clientExistant.commercialId || comId,
            cotisJour: cotisRef, montant: montantDejaPaye,
            date: datePai, heure: '00:00',
            note: r.notePaiement || "Paiement reporté à l'import (client existant)",
            origine: 'import_historique'
          });
          paiementsReportes++;
        }
        // Montant divers : ajouté comme mouvement séparé, sans toucher au reste de la fiche
        if(montantDivers !== 0){
          await fbAdd('paiements', {
            clientId, commercialId: clientExistant.commercialId || comId,
            type: 'divers', montant: montantDivers,
            date: dateImportCli, heure: '00:00',
            note: r.noteDivers || 'Montant divers (pénalité/remise/frais) — import',
            origine: 'import_divers'
          });
        }

        majClients++;
        count++;
        task.update(count);
        continue;
      }

      if(codeClient){
        if(codesUtilises.has(codeClient) || codesVusDansFichier.has(codeClient)){
          ignores++; continue;
        }
        codesVusDansFichier.add(codeClient);
        codesUtilises.add(codeClient);
      } else {
        codeClient = await genererCodeClient(comId);
        codesUtilises.add(codeClient);
        generes++;
      }

      // ── Cas 2 : nouveau client
      const clientDoc = {
        nom, tel, ville, quartier,
        contrat, montantTotal: montant,
        duree, debut,
        note:'', commercialId:comId,
        adhesion: adhesionMontant, adhesionStatut: (impAdhesion ? (r.adhesionStatut||'non_paye') : 'non_paye'),
        codeClient, createdAt:dateImportCli, origine:'import'
      };
      if(cotisationJour > 0) clientDoc.cotisationJourFixe = cotisationJour;

      // Enregistrement individuel via fbAdd
      const clientRef = await fbAdd('clients', clientDoc);
      const clientId = clientRef.id || clientRef;

      if(montantDejaPaye > 0){
        const datePai = /^\d{4}-\d{2}-\d{2}$/.test(r.dateDernierPaiement) ? r.dateDernierPaiement : debut;
        const cotisRef = cotisationJour > 0 ? cotisationJour : (montant > 0 ? Math.ceil(montant/duree) : 0);
        await fbAdd('paiements', {
          clientId, commercialId: comId,
          cotisJour: cotisRef, montant: montantDejaPaye,
          date: datePai, heure: '00:00',
          note: r.notePaiement || "Paiement reporté à l'import",
          origine: 'import_historique'
        });
        paiementsReportes++;
      }
      if(montantDivers !== 0){
        await fbAdd('paiements', {
          clientId, commercialId: comId,
          type: 'divers', montant: montantDivers,
          date: dateImportCli, heure: '00:00',
          note: r.noteDivers || 'Montant divers (pénalité/remise/frais) — import',
          origine: 'import_divers'
        });
      }

      count++;
      task.update(count);
     } catch(rowErr){
      // ✅ FIX : une erreur sur UNE ligne n'interrompt plus tout l'import —
      // on la compte comme échec et on continue avec les lignes suivantes.
      errCount++;
      lastErr = rowErr;
      task.update(count, `(${errCount} échec(s))`);
     }
    }
    // Invalider le cache pour forcer un re-fetch propre
    _syncLocalAfterWrite('clients');
    _syncLocalAfterWrite('paiements');
  } finally {
    task.finish();
  }

  closeM('m-import-preview');
  importData=[];
  let msg = interrompu
    ? `⏹ Import interrompu — ${count} ligne(s) traitée(s) avant l'arrêt`
    : `${count} ligne(s) traitée(s) avec succès !`;
  if(majClients>0) msg += ` — ${majClients} client(s) existant(s) mis à jour`;
  if(generes>0) msg += ` (${generes} code(s) générés auto)`;
  if(paiementsReportes>0) msg += ` — ${paiementsReportes} paiement(s) historique(s) reporté(s)`;
  if(ignores>0) msg += ` — ${ignores} ignoré(s) (doublon de code dans le fichier)`;
  if(errCount>0) msg += ` — ⚠️ ${errCount} échec(s) (ex: ${lastErr?.message||lastErr})`;
  notify(msg, (errCount>0||interrompu) ? 'err' : 'ok');
};

// ========= IMPORT ARTICLES =========
let importArticlesData = []; // lignes valides
let importArticlesRaw  = []; // toutes les lignes parsées (pour aperçu complet)

// ══════════════════════════════════════════
//  TÉLÉCHARGER LE MODÈLE
// ══════════════════════════════════════════
window.downloadArticleTemplate = async function(){
  // Charger SheetJS si pas encore disponible
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=res; s.onerror=rej;
      document.head.appendChild(s);
    });
  }
  const cols = [
    'ref','nom','categorie','prix_vente','prix_achat','stock','stock_min','unite','description'
  ];
  const exemple = [
    ['CE-001','Chauffe-eau 10L','Électroménager',45000,30000,20,5,'pièce','Chauffe-eau électrique 10 litres'],
    ['RAL-001','Rallonge 5m','Électricité',3500,2000,50,10,'pièce','Rallonge électrique 5 mètres'],
    ['GAZ-6KG','Gaz 6kg','Gaz',12000,8500,30,5,'bouteille','Bouteille de gaz 6 kg'],
  ];
  const ws = XLSX.utils.aoa_to_sheet([cols, ...exemple]);
  // Largeurs colonnes
  ws['!cols'] = [8,25,18,12,12,8,8,10,30].map(w=>({wch:w}));
  // Style entête (gras) — note: XLSX de base ne gère pas le style, mais on peut noter
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Articles');
  // Feuille guide
  const guide = XLSX.utils.aoa_to_sheet([
    ['Colonne','Description','Obligatoire ?','Exemple'],
    ['ref','Référence unique de l\'article (code)','Non','CE-001'],
    ['nom','Désignation / nom de l\'article','OUI','Chauffe-eau 10L'],
    ['categorie','Famille ou catégorie','Non','Électroménager'],
    ['prix_vente','Prix de vente en FCFA','OUI','45000'],
    ['prix_achat','Prix d\'achat en FCFA','Non','30000'],
    ['stock','Stock initial','Non (0 par défaut)','20'],
    ['stock_min','Seuil d\'alerte stock bas','Non (5 par défaut)','5'],
    ['unite','Unité de mesure','Non (pièce par défaut)','pièce / kg / litre'],
    ['description','Notes ou description libre','Non','Chauffe-eau électrique...'],
    ['','','',''],
    ['⚠️ Important','Les colonnes ref, nom, categorie... acceptent aussi les noms sans accent.','',''],
    ['','Ex: "référence" ou "reference" sont tous les deux reconnus.','',''],
  ]);
  guide['!cols'] = [{wch:15},{wch:45},{wch:22},{wch:30}];
  XLSX.utils.book_append_sheet(wb, guide, 'Guide colonnes');
  XLSX.writeFile(wb, 'modele_import_articles.xlsx');
  notify('Modèle téléchargé ✓');
};

// ══════════════════════════════════════════
//  GESTION IMPORT
// ══════════════════════════════════════════
window.handleImportArticles = async function(event){
  const file = event.target.files[0];
  if(!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let rows = [];
    if(ext==='csv'){ rows = await parseCSV(file); }
    else if(ext==='xlsx'||ext==='xls'){ rows = await parseXLSX(file); }
    else { notify('Format non supporté. Utilisez .csv ou .xlsx','err'); return; }
    if(!rows||rows.length===0){ notify('Fichier vide ou non lisible','err'); return; }
    prepareImportArticlesPreview(rows);
  } catch(e){ notify('Erreur de lecture : '+e.message,'err'); }
  event.target.value='';
};

// ═══════════════════════════════════════════════
//  IMPORT MOUVEMENTS DE STOCK
// ═══════════════════════════════════════════════
let importMvtData = [];

window.handleImportMvts = async function(event){
  if(!['admin','gestionnaire_stock'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  const file = event.target.files[0];
  if(!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  try{
    let rows = [];
    if(ext==='csv'){ rows = await parseCSV(file); }
    else if(ext==='xlsx'||ext==='xls'){ rows = await parseXLSX(file); }
    else { notify('Format non supporté. Utilisez .csv ou .xlsx','err'); return; }
    if(!rows||rows.length===0){ notify('Fichier vide ou non lisible','err'); return; }
    prepareImportMvtPreview(rows);
  } catch(e){ notify('Erreur de lecture : '+e.message,'err'); }
  event.target.value='';
};

function normalizeArticleForMvt(valeur){
  // Cherche par ref exacte d'abord, puis par ref partielle, puis par nom
  const v = (valeur||'').trim().toLowerCase();
  if(!v) return null;
  return DB.articles.find(a=>(a.ref||'').toLowerCase()===v)
    || DB.articles.find(a=>(a.ref||'').toLowerCase().includes(v))
    || DB.articles.find(a=>(a.nom||'').toLowerCase()===v)
    || DB.articles.find(a=>(a.nom||'').toLowerCase().includes(v))
    || null;
}

function normalizeMvtRow(row){
  const get = (...keys) => { for(const k of keys){ const v=row[k]; if(v!==undefined&&String(v).trim()!=='') return String(v).trim(); } return ''; };
  const typeRaw = (get('type','mouvement','sens','operation','opération')||'').toLowerCase();
  let type = 'entree';
  if(typeRaw.includes('sort')||typeRaw.includes('out')||typeRaw==='-') type='sortie';
  else if(typeRaw.includes('entr')||typeRaw.includes('in')||typeRaw==='+') type='entree';
  return {
    articleVal: get('article','ref','référence','reference','code','code_article','designation','désignation','nom'),
    type,
    qty:        Math.abs(parseInt(get('quantite','quantité','qty','qte','qté','nombre','nb'))||0),
    date:       normalizeDate(get('date','date_mvt','date mvt')),
    note:       get('note','notes','motif','commentaire','observation').slice(0,200),
    destination:get('destination','agence','dest','destinataire').slice(0,100),
  };
}

function prepareImportMvtPreview(rows){
  const normalized = rows.map(normalizeMvtRow);
  const annotated = normalized.map((r,i)=>{
    const art = normalizeArticleForMvt(r.articleVal);
    const erreurs = [];
    if(!r.articleVal) erreurs.push('Article manquant');
    else if(!art) erreurs.push(`Article "${r.articleVal}" introuvable`);
    if(r.qty<=0) erreurs.push('Quantité nulle ou invalide');
    if(r.type==='sortie'&&art&&r.qty>art.stock) erreurs.push(`Stock insuffisant (dispo: ${art.stock})`);
    return {...r, art, erreurs, statut: erreurs.length?'erreur':'ok'};
  });

  importMvtData = annotated.filter(r=>r.statut==='ok');
  const erreurs = annotated.filter(r=>r.statut==='erreur');
  const nbEntrees = importMvtData.filter(r=>r.type==='entree').length;
  const nbSorties = importMvtData.filter(r=>r.type==='sortie').length;

  document.getElementById('import-mvt-kpi').innerHTML=`
    <div style="background:var(--surface2);border-radius:9px;padding:10px;text-align:center;border:1px solid var(--border);">
      <div style="font-size:18px;font-weight:800;color:var(--text);">${rows.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Lignes lues</div>
    </div>
    <div style="background:rgba(34,212,160,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(34,212,160,0.25);">
      <div style="font-size:18px;font-weight:800;color:var(--accent2);">${importMvtData.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">✅ À importer</div>
    </div>
    <div style="background:rgba(201,168,76,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(201,168,76,0.2);">
      <div style="font-size:18px;font-weight:800;color:var(--accent);">📥${nbEntrees} / 📤${nbSorties}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Entrées / Sorties</div>
    </div>
    <div style="background:rgba(224,92,82,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(224,92,82,0.25);">
      <div style="font-size:18px;font-weight:800;color:var(--danger);">${erreurs.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">❌ Erreurs</div>
    </div>`;

  document.getElementById('import-mvt-info').innerHTML =
    `<strong>${rows.length}</strong> ligne(s) lues — <strong style="color:var(--accent2)">${importMvtData.length} mouvement(s) prêts</strong>`+
    (erreurs.length?` — <strong style="color:var(--danger)">${erreurs.length} ligne(s) en erreur (ignorées)</strong>`:'');

  const warnsEl = document.getElementById('import-mvt-warns');
  if(erreurs.length){
    warnsEl.style.display='';
    warnsEl.innerHTML = `⚠️ Lignes ignorées :<ul style="margin:6px 0 0 16px;font-size:11px;">`+
      erreurs.slice(0,10).map(r=>`<li>${r.articleVal||'(sans article)'} — ${r.erreurs.join(', ')}</li>`).join('')+
      (erreurs.length>10?`<li>... et ${erreurs.length-10} autre(s)</li>`:'')+`</ul>`;
  } else { warnsEl.style.display='none'; }

  const btnConfirm = document.getElementById('btn-confirm-import-mvt');
  if(btnConfirm) btnConfirm.disabled = importMvtData.length===0;

  document.getElementById('import-mvt-body').innerHTML = annotated.slice(0,50).map((r,i)=>{
    const artNom = r.art ? `<span style="font-weight:600;color:var(--text);">${esc(r.art.nom)}</span><br><span style="font-size:10px;color:var(--accent);">${esc(r.art.ref||'—')}</span>` : `<span style="color:var(--danger);font-size:11px;">${esc(r.articleVal)||'—'}</span>`;
    const typeBadge = r.type==='entree'
      ? `<span style="background:rgba(34,212,160,0.12);border:1px solid rgba(34,212,160,0.3);color:var(--accent2);border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700;">📥 Entrée</span>`
      : `<span style="background:rgba(212,137,58,0.12);border:1px solid rgba(212,137,58,0.3);color:var(--warn);border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700;">📤 Sortie</span>`;
    const statutBadge = r.statut==='ok'
      ? `<span style="background:rgba(34,212,160,0.1);border:1px solid rgba(34,212,160,0.25);color:var(--accent2);border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700;">✅ OK</span>`
      : `<span style="background:rgba(224,92,82,0.1);border:1px solid rgba(224,92,82,0.25);color:var(--danger);border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700;" title="${esc(r.erreurs.join(', '))}">❌ Erreur</span>`;
    return `<tr${r.statut!=='ok'?' style="background:rgba(247,97,79,0.05);"':''}>
      <td class="tm">${i+1}</td>
      <td>${artNom}</td>
      <td>${typeBadge}</td>
      <td style="font-weight:700;color:var(--text);">${r.qty||'—'}</td>
      <td style="font-size:11px;color:var(--subtle);">${r.date||'—'}</td>
      <td style="font-size:11px;color:var(--muted);">${esc(r.note||r.destination||'—')}</td>
      <td>${statutBadge}</td>
    </tr>`;
  }).join('')+(annotated.length>50?`<tr><td colspan="7" style="text-align:center;padding:10px;color:var(--muted);font-size:12px;">... et ${annotated.length-50} autres lignes</td></tr>`:'');

  openM('m-import-mvt');
}

window.confirmImportMvts = async function(){
  if(!importMvtData.length){ notify('Aucun mouvement valide à importer','err'); return; }
  if(!['admin','gestionnaire_stock'].includes(session?.role)){ notify('Accès non autorisé','err'); return; }
  let count=0, errCount=0, interrompu=false;
  const total = importMvtData.length;
  const task = startProgressTask('Import mouvements stock', total);
  for(const r of importMvtData){
    if(task.stopped()){ interrompu = true; break; }
    try{
      // Re-chercher l'article (stock peut avoir changé)
      const art = DB.articles.find(a=>a._id===r.art._id);
      if(!art){ errCount++; continue; }
      if(r.type==='sortie'&&r.qty>art.stock){ errCount++; continue; }
      const delta = r.type==='entree' ? r.qty : -r.qty;
      const newStock = Math.max(0, art.stock + delta);
      await fbUpdate('articles', art._id, {stock: newStock});
      // Mettre à jour le cache local immédiatement
      art.stock = newStock;
      const mvtDoc = {
        articleId: art._id,
        type: r.type,
        qty: r.qty,
        stockApres: newStock,
        date: r.date || TODAY,
        note: r.note || (r.destination ? `Import — Destination : ${r.destination}` : 'Importé depuis Excel/CSV'),
        origine: 'import',
      };
      if(r.destination) mvtDoc.destinationLibre = r.destination;
      await fbAdd('stockMvts', mvtDoc);
      count++;
      task.update(count, errCount?`(${errCount} échec(s))`:'');
      await new Promise(r => setTimeout(r, 50)); // FIX 4 : pause anti-saturation
    } catch(e){ errCount++; task.update(count, `(${errCount} échec(s))`); }
  }
  task.finish();
  closeM('m-import-mvt');
  importMvtData=[];
  let msg = interrompu
    ? `⏹ Import interrompu — ${count} mouvement(s) importé(s) avant l'arrêt`
    : `✅ ${count} mouvement(s) importé(s) avec succès !`;
  if(errCount>0) msg += ` — ${errCount} échec(s)`;
  notify(msg, (errCount>0||interrompu)?'err':'ok');
};

window.downloadMvtTemplate = async function(){
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload=res; s.onerror=rej;
      document.head.appendChild(s);
    });
  }
  const artExemples = DB.articles.slice(0,3).map(a=>a.ref||a.nom);
  const rows = [
    ['article','type','quantite','date','note','destination'],
    [artExemples[0]||'REF-001','entree',10,TODAY,'Réapprovisionnement fournisseur',''],
    [artExemples[1]||'REF-002','sortie',5,TODAY,'Envoi agence','Agence Nord'],
    [artExemples[2]||'REF-003','entree',20,TODAY,'Livraison initiale',''],
    ['','','','','',''],
    ['=== AIDE ===','','','','',''],
    ['article','Référence (ref) ou nom exact de l\'article','','','',''],
    ['type','entree OU sortie','','','',''],
    ['quantite','Nombre entier positif','','','',''],
    ['date','Format JJ/MM/AAAA ou AAAA-MM-JJ (laisser vide = aujourd\'hui)','','','',''],
    ['note','Commentaire libre (optionnel)','','','',''],
    ['destination','Agence / motif de sortie (optionnel)','','','',''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{wch:22},{wch:10},{wch:12},{wch:16},{wch:35},{wch:22}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mouvements');
  XLSX.writeFile(wb, 'modele_import_mouvements.xlsx');
  notify('📋 Modèle téléchargé','ok');
};

function normalizeArticleRow(row){
  const get = (...keys) => { for(const k of keys){ const v=row[k]; if(v!==undefined&&v!=='') return String(v).trim(); } return ''; };
  return {
    ref:      get('ref','référence','reference','code','code_article','Réf.','Ref'),
    nom:      get('nom','designation','désignation','libelle','libellé','article','name','produit','Désignation','Designation'),
    cat:      get('categorie','catégorie','cat','famille','type','Catégorie','Categorie'),
    pv:       parseFloat(get('prix_vente','pv','prix vente','prix','price','montant','vente','Prix vente','Prix_vente')) || 0,
    pa:       parseFloat(get('prix_achat','pa','prix achat','achat','cout','coût','cost','Prix achat','Prix_achat')) || 0,
    stock:    parseInt(get('stock','quantite','quantité','qty','qte','Stock')) || 0,
    stockMin: parseInt(get('stock_min','stock min','stockmin','min','minimum','seuil','Stock min')) || 5,
    unite:    get('unite','unité','unit','mesure','Unité','Unite') || 'pièce',
    desc:     get('description','desc','note','notes','Description'),
  };
}

function prepareImportArticlesPreview(rows){
  importArticlesRaw = rows.map(normalizeArticleRow);
  // Identifier les refs existantes dans DB
  const refsExistantes = new Set(DB.articles.map(a=>(a.ref||'').toLowerCase().trim()).filter(Boolean));
  // Identifier les refs en doublon DANS le fichier lui-même
  const refsVues = new Set();
  const refsDoublonsFichier = new Set();
  importArticlesRaw.forEach(r=>{ const k=(r.ref||'').toLowerCase().trim(); if(k){ if(refsVues.has(k)) refsDoublonsFichier.add(k); else refsVues.add(k); } });

  // Annoter chaque ligne
  const annotated = importArticlesRaw.map(r=>{
    const erreurs = [];
    if(!r.nom) erreurs.push('Désignation manquante');
    if(!r.pv||r.pv<=0) erreurs.push('Prix vente manquant ou nul');
    const refKey = (r.ref||'').toLowerCase().trim();
    let statut = 'ok';
    let statutMsg = '';
    if(erreurs.length){ statut='erreur'; statutMsg=erreurs.join(', '); }
    else if(refKey && refsExistantes.has(refKey)){ statut='doublon_db'; statutMsg=`Réf. "${r.ref}" existe déjà en base`; }
    else if(refKey && refsDoublonsFichier.has(refKey)){ statut='doublon_fichier'; statutMsg=`Réf. "${r.ref}" en doublon dans ce fichier`; }
    return {...r, statut, statutMsg};
  });

  // Séparer valides / bloqués
  importArticlesData = annotated.filter(r=>r.statut==='ok');
  const erreurs     = annotated.filter(r=>r.statut==='erreur');
  const doublonsDB  = annotated.filter(r=>r.statut==='doublon_db');
  const doublonsFic = annotated.filter(r=>r.statut==='doublon_fichier');
  const bloquees    = erreurs.length + doublonsDB.length + doublonsFic.length;

  // KPI
  document.getElementById('import-art-kpi').innerHTML=`
    <div style="background:var(--surface2);border-radius:9px;padding:10px;text-align:center;border:1px solid var(--border);">
      <div style="font-size:18px;font-weight:800;color:var(--accent2);">${rows.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">Lignes lues</div>
    </div>
    <div style="background:rgba(34,212,160,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(34,212,160,0.25);">
      <div style="font-size:18px;font-weight:800;color:var(--accent2);">${importArticlesData.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">✅ À importer</div>
    </div>
    <div style="background:rgba(247,201,79,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(247,201,79,0.25);">
      <div style="font-size:18px;font-weight:800;color:var(--warn);">${doublonsDB.length+doublonsFic.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">⚠️ Doublons bloqués</div>
    </div>
    <div style="background:rgba(224,92,82,0.08);border-radius:9px;padding:10px;text-align:center;border:1px solid rgba(224,92,82,0.25);">
      <div style="font-size:18px;font-weight:800;color:var(--danger);">${erreurs.length}</div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">❌ Erreurs</div>
    </div>`;

  // Info principale
  document.getElementById('import-art-info').innerHTML =
    `<strong>${rows.length}</strong> ligne(s) lues — <strong style="color:var(--accent2)">${importArticlesData.length} article(s) prêts à importer</strong>`+
    (bloquees>0?` — <strong style="color:var(--danger)">${bloquees} bloquée(s)</strong>`:'');

  // Message doublons
  const doubEl = document.getElementById('import-art-doublons');
  if(doublonsDB.length||doublonsFic.length){
    doubEl.style.display='';
    let msg = `⚠️ <strong>${doublonsDB.length+doublonsFic.length} ligne(s) bloquée(s) pour doublon :</strong><ul style="margin:6px 0 0 16px;font-size:12px;">`;
    if(doublonsDB.length) msg+=`<li>${doublonsDB.length} réf. existent déjà en base de données (non importées)</li>`;
    if(doublonsFic.length) msg+=`<li>${doublonsFic.length} réf. en doublon dans le fichier lui-même (seule la 1ère occurrence sera prise)</li>`;
    msg+='</ul>';
    doubEl.innerHTML=msg;
  } else { doubEl.style.display='none'; }

  // Message erreurs
  const errEl = document.getElementById('import-art-errors');
  if(erreurs.length){
    errEl.style.display='';
    errEl.innerHTML=`❌ <strong>${erreurs.length} ligne(s) ignorée(s)</strong> : désignation ou prix de vente manquant.`;
  } else { errEl.style.display='none'; }

  // Tableau — toutes les lignes avec statut coloré
  document.getElementById('import-art-count').textContent = importArticlesData.length;
  const btnConfirm = document.getElementById('import-art-confirm-btn');
  if(btnConfirm) btnConfirm.disabled = importArticlesData.length===0;

  document.getElementById('import-art-body').innerHTML = annotated.slice(0,80).map((r,i)=>{
    const statutBadge = r.statut==='ok'
      ? sb('✅ OK','sg')
      : r.statut==='doublon_db'
        ? `<span class="sb sy" title="${esc(r.statutMsg)}">⚠️ Doublon DB</span>`
        : r.statut==='doublon_fichier'
          ? `<span class="sb sy" title="${esc(r.statutMsg)}">⚠️ Doublon fichier</span>`
          : `<span class="sb sr" title="${esc(r.statutMsg)}">❌ Erreur</span>`;
    const rowOpacity = r.statut!=='ok' ? 'opacity:0.55;' : '';
    return `<tr style="${rowOpacity}">
      <td style="color:var(--muted);font-size:11px;">${i+1}</td>
      <td><span class="tag">${esc(r.ref||'—')}</span></td>
      <td class="fw6">${esc(r.nom||'—')}</td>
      <td class="tm">${esc(r.cat||'—')}</td>
      <td style="color:var(--accent2);font-weight:600;">${r.pv>0?fmt(r.pv):'—'}</td>
      <td class="tm">${r.pa>0?fmt(r.pa):'—'}</td>
      <td>${r.stock||0}</td>
      <td class="tm">${esc(r.unite||'pièce')}</td>
      <td>${statutBadge}</td>
    </tr>`;
  }).join('')+(annotated.length>80?`<tr><td colspan="9" style="text-align:center;padding:10px;color:var(--muted);font-size:12px;">… et ${annotated.length-80} autres lignes</td></tr>`:'');

  openM('m-import-articles');
}

window.confirmImportArticles = async function(){
  if(!importArticlesData.length){ notify('Aucun article à importer','err'); return; }
  const btn = document.getElementById('import-art-confirm-btn');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Import en cours…'; }
  // Récupérer la date choisie ou utiliser TODAY par défaut
  const dateInput = (document.getElementById('import-art-date')?.value||'').trim();
  const dateImport = /^\d{4}-\d{2}-\d{2}$/.test(dateInput) ? dateInput : TODAY;
  const total = importArticlesData.length;
  let count=0, errCount=0, lastErr=null, interrompu=false;
  const task = startProgressTask('Import articles', total);
  for(const r of importArticlesData){
    if(task.stopped()){ interrompu = true; break; }
    try {
      const ref = r.ref || `ART-${Date.now()}-${count}`;
      const art = await fbAdd('articles',{
        ref, nom:r.nom, cat:r.cat, pv:r.pv, pa:r.pa,
        stock:r.stock, stockMin:r.stockMin, unite:r.unite,
        desc:r.desc||'', type:'article', composition:[], images:[], image:'',
        dateImport: dateImport
      });
      if(r.stock>0) await fbAdd('stockMvts',{
        articleId:art._id||art.id, type:'entree', qty:r.stock,
        stockApres:r.stock, date:dateImport, note:'Stock initial — import fichier'
      });
      count++;
      task.update(count);
      if(btn) btn.textContent = `⏳ Import en cours… ${count} / ${total}`;
    } catch(e){
      // ✅ FIX : une erreur sur UN article n'interrompt plus tout l'import —
      // on la compte comme échec et on continue avec les articles suivants.
      errCount++;
      lastErr = e;
      task.update(count, `(${errCount} échec(s))`);
      if(btn) btn.textContent = `⏳ Import en cours… ${count} / ${total} (${errCount} échec(s))`;
    }
    await new Promise(r => setTimeout(r, 50)); // FIX 4 : pause anti-saturation
  }
  task.finish();
  if(btn){ btn.disabled=false; btn.textContent='✓ Importer'; }
  closeM('m-import-articles');
  importArticlesData=[]; importArticlesRaw=[];
  let msg = interrompu
    ? `⏹ Import interrompu — ${count} article(s) importé(s) avant l'arrêt`
    : `✅ ${count} article(s) importé(s) avec succès !`;
  if(errCount>0) msg += ` — ⚠️ ${errCount} échec(s) (ex: ${lastErr?.message||lastErr})`;
  notify(msg, (errCount>0||interrompu) ? 'err' : 'ok');
};

// ========= COMMERCIAL : MES CLIENTS (lecture seule) =========
function renderComClients(){
  const q = (document.getElementById('com-cl-search')?.value||'').toLowerCase().trim();
  let cls = clientsDansAgence().filter(c=>c.commercialId===session.userId);
  if(q) cls = cls.filter(c=>
    (c.codeClient&&c.codeClient.toLowerCase().includes(q)) ||
    c.nom.toLowerCase().includes(q) ||
    (c.tel||'').includes(q)
  );
  const sortVal = (document.getElementById('sort-com-clients')?.value)||'nom-asc';
  let _sortStatsMapCom = null;
  if (sortVal === 'retard-desc' || sortVal === 'cotis-desc') {
    _sortStatsMapCom = new Map(cls.map(c => [c._id, stats(c)]));
  }
  cls = [...cls].sort((a,b)=>{
    switch(sortVal){
      case 'nom-asc':    return (a.nom||'').localeCompare(b.nom||'','fr',{sensitivity:'base'});
      case 'nom-desc':   return (b.nom||'').localeCompare(a.nom||'','fr',{sensitivity:'base'});
      case 'code-asc':   return (a.codeClient||'').localeCompare(b.codeClient||'');
      case 'code-desc':  return (b.codeClient||'').localeCompare(a.codeClient||'');
      case 'retard-desc':{ const sa=_sortStatsMapCom.get(a._id),sb=_sortStatsMapCom.get(b._id); return sb.joursRetard-sa.joursRetard; }
      case 'cotis-desc': { const sa=_sortStatsMapCom.get(a._id),sb=_sortStatsMapCom.get(b._id); return sb.m-sa.m; }
      default: return 0;
    }
  });
  document.getElementById('tb-com-clients').innerHTML = cls.map(c=>{
    const s=stats(c);
    return `<tr>
      <td><span style="background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.35);border-radius:5px;padding:1px 7px;font-size:11px;color:var(--accent);font-weight:700;">${esc(c.codeClient||'—')}</span></td>
      <td class="fw6">${esc(c.nom)}<div class="tm" style="font-size:10px">${esc(c.ville||'')} ${c.quartier?'· '+esc(c.quartier):''}</div></td>
      <td>${esc(c.tel||'—')}</td>
      <td style="font-size:11px;">${(()=>{
        if(c.contratArticles&&c.contratArticles.length){
          return c.contratArticles.map(a=>{
            const art=getProdOuArticle(a.artId);
            const ref=art&&art.ref?art.ref:(a.nom||'?');
            const qty=parseInt(a.qty)||1;
            const label=qty>1?`${ref} x${qty}`:ref;
            return`<span style="display:inline-block;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.35);border-radius:4px;padding:1px 6px;font-size:9.5px;font-weight:700;color:var(--accent);margin:1px 2px 1px 0;white-space:nowrap;">${esc(label)}</span>`;
          }).join('<span style="color:var(--muted);font-size:9px;margin:0 1px;">+</span>');
        }
        return esc(c.contrat||'—');
      })()}</td>
      <td><span class="cotis-badge" style="font-size:10px;">💰 ${fmt(s.m)}</span></td>
      <td>
        <div class="pgw"><div class="pgb" style="width:${s.pct}%;background:${s.pct>=100?'var(--accent2)':s.joursRetard>0?'var(--danger)':'var(--accent)'}"></div></div>
        <div style="font-size:10px;color:var(--muted)">${s.pct}% · Payé ${fmt(s.totalPaye)}</div>
      </td>
      <td style="color:${s.joursRetard>0?'var(--danger)':'var(--accent2)'};font-weight:600;font-size:11px;">${s.joursRetard>0?s.joursRetard+' j retard':'✓ À jour'}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="voirDetailComClient('${c._id}')">👁 Détail</button></td>
    </tr>`;
  }).join('')||'<tr><td colspan="8" class="emp">Aucun client trouvé</td></tr>';
}

window.voirDetailComClient = function(cid){
  // Ouvre le modal de détail en lecture seule (sans bouton payer)
  const c=getCl(cid),s=stats(c);
  document.getElementById('det-title').textContent=`👤 ${esc(c.nom)} — ${esc(c.contrat)}`;
  document.getElementById('det-kpi').style.gridTemplateColumns='repeat(auto-fill,minmax(130px,1fr))';
  document.getElementById('det-kpi').innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Total payé</div><div class="kpi-val kv-green" style="font-size:16px">${fmt(s.totalPaye)}</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Restant dû</div><div class="kpi-val kv-red" style="font-size:16px">${fmt(s.totalRestant)}</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Avancement</div><div class="kpi-val kv-blue" style="font-size:16px">${s.pct}%</div></div>
    <div class="kpi-card kc-yellow"><div class="kpi-lbl">Retard</div><div class="kpi-val kv-yellow" style="font-size:16px">${s.joursRetard}j</div></div>
    <div class="kpi-card" style="border-color:${s.soldeNet>=0?'rgba(34,212,160,0.35)':'rgba(247,97,79,0.35)'};background:${s.soldeNet>=0?'rgba(34,212,160,0.07)':'rgba(247,97,79,0.07)'}">
      <div class="kpi-lbl" style="color:${s.soldeNet>=0?'var(--accent2)':'var(--danger)'}">💳 Solde dispo.</div>
      <div class="kpi-val" style="font-size:14px;color:${s.soldeNet>=0?'var(--accent2)':'var(--danger)'};">${fmt(s.soldeNet)}</div>
      <div style="font-size:9px;color:var(--muted);margin-top:2px;">Livraisons : −${fmt(s.totalLivraisons)}</div>
    </div>`;
  const pays=[...s.pays].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const paysTries3 = [...s.pays].sort((a,b)=>a.date.localeCompare(b.date));
  const cotisJ3=s.m; const duree3=c.duree||372; let cumul3=0; const niveauxMap3=new Map();
  paysTries3.forEach(p=>{ cumul3+=p.montant; niveauxMap3.set(p._id||(p.date+p.montant),Math.min(duree3,cotisJ3>0?Math.floor(cumul3/cotisJ3):0)); });
  document.getElementById('det-pays-list').innerHTML=pays.map(p=>{
    const key3=p._id||(p.date+p.montant); const niv3=niveauxMap3.get(key3);
    const nivLabel3=niv3!==undefined?joursEnJM(niv3):'—'; const nivColor3=niv3!==undefined&&niv3>=duree3?'var(--accent2)':'var(--accent)';
    return`<tr><td>${p.date}</td><td class="tm">${p.heure||'—'}</td><td><span class="cotis-badge" style="font-size:10px">💰 ${fmt(p.cotisJour||s.m)}</span></td><td style="color:var(--accent2);font-weight:700">${fmt(p.montant)}</td><td>${ratio(p.montant,p.cotisJour||s.m)}</td><td style="font-size:12px;font-weight:700;color:${nivColor3};white-space:nowrap;">${nivLabel3}<span style="font-size:9px;color:var(--muted);font-weight:400;"> /${joursEnJM(duree3)}</span></td><td class="tm" style="font-size:10px">${esc(p.note||'—')}${badgeCorrection(p)}</td></tr>`;
  }).join('')||'<tr><td colspan="7" class="emp">Aucun paiement</td></tr>';
  const livs=DB.livraisons.filter(l=>l.clientId===cid).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  document.getElementById('det-liv-list').innerHTML=livs.map(l=>`<tr><td>${esc(l.date)}</td><td class="fw6">${esc(getProd(l.produitId).nom)}</td><td>${esc(String(l.qty||""))}</td><td>${fmt(l.montant)}</td><td>${livStatut(l.statut)}</td></tr>`).join('')||'<tr><td colspan="5" class="emp">Aucune livraison</td></tr>';
  const adhPays=DB.adhesionPays.filter(a=>a.clientId===cid);
  document.getElementById('det-adh-content').innerHTML=`<div class="ib ${c.adhesionStatut==='paye'?'ib-green':'ib-red'}" style="margin-bottom:8px;"><strong>Adhésion : ${fmt(c.adhesion)}</strong> — ${c.adhesionStatut==='paye'?'✅ Payé':'❌ Non payé'}</div>${adhPays.length>0?`<div class="tw" style="margin:0"><table><thead><tr><th>Date</th><th>Montant</th><th>Note</th></tr></thead><tbody>${adhPays.map(a=>`<tr><td>${esc(a.date)}</td><td style="color:var(--accent2);font-weight:600">${fmt(a.montant)}</td><td class="tm" style="font-size:10px">${esc(a.note||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="emp" style="padding:16px">Aucun paiement d\'adhésion</div>'}`;
  document.querySelectorAll('.det-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.det-tab').classList.add('active');
  ['paiements','livraisons','adhesion','calendrier'].forEach(t=>document.getElementById('det-'+t).style.display=t==='paiements'?'':'none');
  _detClientCtxId = cid;
  // Masquer le bouton payer pour les commerciaux (lecture seule)
  document.getElementById('det-pay-btn').style.display = (session.role===ROLES.ADMIN||session.role===ROLES.COMMERCIAL||session.role===ROLES.CHEF_AGENCE) ? '' : 'none';
  openM('m-detail');
};

// ========= COMMERCIAL : NOUVEAU CLIENT =========
function renderComNouveauClient(){
  ['com-ncl-nom','com-ncl-tel','com-ncl-ville','com-ncl-qrt','com-ncl-contrat','com-ncl-note'].forEach(i=>{ const el=document.getElementById(i); if(el) el.value=''; });
  const m=document.getElementById('com-ncl-montant'); if(m) m.value='';
  const d=document.getElementById('com-ncl-duree'); if(d){d.value='372';d.style.display='none';} const ds=document.getElementById('com-ncl-duree-sel'); if(ds) ds.value='372';
  const db=document.getElementById('com-ncl-debut'); if(db) db.value=TODAY;
  const adh=document.getElementById('com-ncl-adhesion'); if(adh) adh.value='0';
  const adhS=document.getElementById('com-ncl-adhesion-statut'); if(adhS) adhS.value='non_paye';
  const adhRNP=document.getElementById('com-ncl-adh-non-paye'); if(adhRNP) adhRNP.checked=true;
  const ci=document.getElementById('com-ncl-calc-info'); if(ci) ci.style.display='none';
  const res=document.getElementById('com-ncl-result'); if(res) res.style.display='none';
  const st=document.getElementById('com-ncl-code-status'); if(st) st.innerHTML='';
  const recap=document.getElementById('com-ncl-articles-recap'); if(recap) recap.style.display='none';
  // Afficher le préfixe verrouillé du commercial
  const com = DB.commerciaux.find(c=>c._id===session.userId);
  const prefix = com && com.codePrefix ? com.codePrefix.toUpperCase() : '??';
  const prefBadge = document.getElementById('com-ncl-prefix-txt');
  if(prefBadge) prefBadge.textContent = prefix;
  // Réinitialiser séquence
  const seqEl = document.getElementById('com-ncl-seq');
  if(seqEl) seqEl.value = '';
  const codeEl = document.getElementById('com-ncl-code');
  if(codeEl) codeEl.value = '';
  // Charger les articles multi-select
  resetArticlesAdded('com-ncl');
  // Suggérer automatiquement le prochain numéro de séquence
  setTimeout(suggererProchainCode, DELAY_CODE_SUGGEST_MS);
}

window.suggererProchainCode = function(){
  const com = DB.commerciaux.find(c=>c._id===session.userId);
  const prefix = com && com.codePrefix ? com.codePrefix.toUpperCase() : 'CL';
  // Mettre à jour le badge préfixe
  const prefBadge = document.getElementById('com-ncl-prefix-txt');
  if(prefBadge) prefBadge.textContent = prefix;
  // Trouver le plus grand numéro de séquence parmi les clients de CE commercial
  const clientsCom = DB.clients.filter(c=>c.commercialId===session.userId);
  let maxSeq = 0;
  clientsCom.forEach(c=>{
    if(c.codeClient){
      // Extraire uniquement les chiffres a la FIN du code (apres le prefixe)
      const m = c.codeClient.match(/(\d+)$/);
      const n = m ? parseInt(m[1], 10) : NaN;
      if(!isNaN(n) && n > maxSeq) maxSeq = n;
    }
  });
  const nextSeq = String(maxSeq + 1).padStart(3,'0');
  const seqEl = document.getElementById('com-ncl-seq');
  if(seqEl) { seqEl.value = nextSeq; onSeqInput(); }
};

window.onSeqInput = function(){
  const com = DB.commerciaux.find(c=>c._id===session.userId);
  const prefix = com && com.codePrefix ? com.codePrefix.toUpperCase() : 'CL';
  const seqEl = document.getElementById('com-ncl-seq');
  const codeEl = document.getElementById('com-ncl-code');
  const status = document.getElementById('com-ncl-code-status');
  const seq = seqEl ? seqEl.value.trim() : '';
  const fullCode = prefix + seq;
  if(codeEl) codeEl.value = fullCode;
  if(!seq){ if(status) status.innerHTML=''; return; }
  // Vérifier doublon
  const doublon = DB.clients.find(c => c.codeClient && c.codeClient.toUpperCase() === fullCode);
  if(doublon){
    const comDbl = getCom(doublon.commercialId);
    if(status) status.innerHTML=`<span style="color:var(--danger);">&#10060; Code <strong>${fullCode}</strong> déjà utilisé par <strong>${esc(doublon.nom)}</strong> (${esc(comDbl.nom)}).</span>`;
    if(seqEl) seqEl.style.borderColor='var(--danger)';
  } else {
    if(status) status.innerHTML=`<span style="color:var(--accent2);">&#10003; Code <strong style="color:var(--accent)">${fullCode}</strong> disponible</span>`;
    if(seqEl) seqEl.style.color='var(--text)';
  }
};

window.verifierCodeClient = function(input){
  // Maintenu pour compatibilité admin modal, mais ignoré dans page commercial
  const code = input.value.trim().toUpperCase();
  input.value = code;
  const status = document.getElementById('com-ncl-code-status');
  if(!code){ if(status) status.innerHTML=''; return; }
  const doublon = DB.clients.find(c => c.codeClient && c.codeClient.toUpperCase() === code);
  if(doublon){
    const comDbl = getCom(doublon.commercialId);
    if(status) status.innerHTML=`<span style="color:var(--danger);">&#10060; Code déjà utilisé par <strong>${esc(doublon.nom)}</strong> (${esc(comDbl.nom)}).</span>`;
    input.style.borderColor='var(--danger)';
  } else {
    if(status) status.innerHTML=`<span style="color:var(--accent2);">&#10003; Code disponible</span>`;
    input.style.borderColor='var(--accent2)';
  }
};

window.calcJourComNcl = function(){
  const p=parseFloat(document.getElementById('com-ncl-montant').value)||0;
  const d=parseInt(document.getElementById('com-ncl-duree').value)||365;
  const el=document.getElementById('com-ncl-calc-info');
  if(p>0){el.style.display='block';const jmv=Math.ceil(p/d);const debut=document.getElementById('com-ncl-debut').value||TODAY;const fin=new Date(debut+'T12:00:00');fin.setDate(fin.getDate()+d);el.innerHTML=`💰 Cotisation : <strong style="font-size:14px">${fmt(jmv)}/jour</strong> sur ${d} jours → Fin : <strong>${fin.toLocaleDateString('fr-FR')}</strong>`;}
  else el.style.display='none';
};

window.saveComNouveauClient = async function(){
  const com = DB.commerciaux.find(c=>c._id===session.userId);
  const prefix = com && com.codePrefix ? com.codePrefix.toUpperCase() : null;
  const seq = (document.getElementById('com-ncl-seq').value||'').trim();
  if(!seq){ notify('Entrez le numéro de séquence du code client','err'); return; }
  const codeClient = (prefix||'') + seq;
  // Vérification stricte : le code commence obligatoirement par le préfixe du commercial
  if(prefix && !codeClient.startsWith(prefix)){
    notify(`Le code doit commencer par votre préfixe "${prefix}"`, 'err'); return;
  }
  const nom=document.getElementById('com-ncl-nom').value.trim();
  const tel=document.getElementById('com-ncl-tel').value.trim();
  const ville=document.getElementById('com-ncl-ville').value.trim();
  const qrt=document.getElementById('com-ncl-qrt').value.trim();
  const ct=document.getElementById('com-ncl-contrat').value.trim();
  const mt=parseFloat(document.getElementById('com-ncl-montant').value)||0;
  const debut=document.getElementById('com-ncl-debut').value;
  if(!nom||!tel||!ville||!qrt||!ct||mt<=0||!debut){
    if(!ville) notify('La ville est obligatoire','err');
    else if(!qrt) notify('Le quartier est obligatoire','err');
    else notify('Champs obligatoires manquants','err');
    return;
  }
  // Anti-doublon final
  const doublon = DB.clients.find(c => c.codeClient && c.codeClient.toUpperCase() === codeClient);
  if(doublon){
    const comD=getCom(doublon.commercialId);
    notify(`Code "${codeClient}" déjà utilisé par ${esc(doublon.nom)} (${esc(comD.nom)})`, 'err');
    return;
  }
  const comId=session.userId;
  // Adhésion fixe 200 FCFA — lire statut depuis les boutons radio
  const comNclAdhRadio = document.querySelector('input[name="com-ncl-adh-statut-r"]:checked');
  const comNclAdhStatut = comNclAdhRadio ? comNclAdhRadio.value : 'non_paye';
  // Figer les prix des produits au moment de la création du contrat
  const produitsPrixFigesNcl = _articlesAdded['com-ncl'].map(p=>({produitId:p._id, pvFige:p.prix, nom:p.nom}));
  const newClientRef = await fbAdd('clients',{nom,tel,ville,quartier:qrt,contrat:ct,montantTotal:mt,duree:parseInt(document.getElementById('com-ncl-duree').value)||365,debut,note:document.getElementById('com-ncl-note').value,commercialId:comId,adhesion:200,adhesionStatut:comNclAdhStatut,codeClient,produitsPrixFiges:produitsPrixFigesNcl});
  // Si adhésion payée à la création → enregistrer dans adhesionPays pour le registre
  if(comNclAdhStatut === 'paye'){
    const now = new Date();
    const heure = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const clientId = newClientRef && newClientRef._id ? newClientRef._id : null;
    if(clientId){
      await fbAdd('adhesionPays',{
        clientId, commercialId: comId,
        montant: 200, date: TODAY, heure,
        note: "Adhésion encaissée à l'inscription",
        saisiParId: session.userId, saisiParNom: session.nom,
        verrouille: true
      });
    }
  }
  // Afficher le résultat
  const res=document.getElementById('com-ncl-result');
  res.style.display='block';
  res.innerHTML=`&#9989; Client créé avec succès !<br><strong style="font-size:16px;color:var(--accent);">Code : ${codeClient}</strong><br><span style="font-size:11px;color:var(--muted);">Ce code permet de retrouver le client rapidement en saisie de mises.</span>`;
  notify(`Client ${nom} créé — Code : ${codeClient}`);
  // Réinitialiser
  ['com-ncl-nom','com-ncl-tel','com-ncl-ville','com-ncl-qrt','com-ncl-contrat','com-ncl-note'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('com-ncl-montant').value='';
  document.getElementById('com-ncl-duree').value='372';document.getElementById('com-ncl-duree').style.display='none';document.getElementById('com-ncl-duree-sel').value='372';
  document.getElementById('com-ncl-debut').value=TODAY;
  document.getElementById('com-ncl-adhesion').value='0';
  document.getElementById('com-ncl-calc-info').style.display='none';
  document.getElementById('com-ncl-code-status').innerHTML='';
  document.getElementById('com-ncl-seq').value='';
  document.getElementById('com-ncl-code').value='';
  // Suggérer le prochain code auto
  setTimeout(suggererProchainCode, DELAY_CODE_SUGGEST2_MS);
};

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: PAIEMENTS                                            ║
// ║  Extraction: node extract-modules.js → js/paiements.js       ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= SAISIE DE MISES =========
async function genererCodeClient(comId){
  const com = DB.commerciaux.find(c=>c._id===comId);
  const prefix = com && com.codePrefix ? com.codePrefix : 'CL';
  // Utiliser tous les clients en mémoire + les codes déjà générés dans cette session
  // pour éviter les doublons lors de gros imports
  const allClients = DB.clients || [];
  let maxSeq = 0;
  allClients.forEach(c=>{
    if(c.codeClient){
      const parts = c.codeClient.toUpperCase().split('-');
      const n = parseInt(parts[parts.length-1]);
      if(!isNaN(n) && n>maxSeq) maxSeq = n;
    }
  });
  // Incrémenter jusqu'à trouver un code libre (robuste aux trous de séquence)
  let seq = maxSeq + 1;
  const usedCodes = new Set(allClients.map(c=>(c.codeClient||'').toUpperCase()).filter(Boolean));
  let candidate = `${prefix}-${String(seq).padStart(4,'0')}`;
  while(usedCodes.has(candidate)){
    seq++;
    candidate = `${prefix}-${String(seq).padStart(4,'0')}`;
  }
  return candidate;
}

window.rechercherParCodeClient = function(){
  const q = document.getElementById('mise-search-id').value.trim();
  if(!q) return;
  let pool = clientsDansAgence();
  if(session.role ===ROLES.COMMERCIAL) pool = pool.filter(c => c.commercialId === session.userId);
  const exactMatch = pool.find(c => c.codeClient && c.codeClient.toUpperCase() === q.toUpperCase());
  if(exactMatch){ selectMiseClient(exactMatch._id); document.getElementById('mise-search-results').style.display='none'; return; }
  miseLiveSearch();
};

// ========= SAISIE DE MISES =========
let miseClientCtx = null;

function renderSaisieMises(){
  document.getElementById('mise-search-id').value = '';
  document.getElementById('mise-search-results').style.display = 'none';
  document.getElementById('mise-client-card').style.display = 'none';
  document.getElementById('mise-nb-cotis').value = '';
  document.getElementById('mise-total-calc').textContent = '-';
  document.getElementById('mise-saisie-note').value = '';
  document.getElementById('mise-saisie-warn').style.display = 'none';
  const nv = document.getElementById('mc-niveau-wrap'); if(nv) nv.innerHTML='';
  miseClientCtx = null;
  // Admin, commercial, secrétaire ET chef d'agence peuvent saisir des mises
  const canSaisirMise = ['admin','commercial','secretaire','chef_agence'].includes(session.role);
  const saisieForm = document.getElementById('mise-saisie-form-zone');
  const infoLecture = document.getElementById('mise-lecture-seule-info');

  // Vérifier si les points du commercial sont déjà versés aujourd'hui
  if(session.role ===ROLES.COMMERCIAL){
    const versementAujourdhui = getVersementDuJour(session.userId, TODAY);
    if(versementAujourdhui){
      if(saisieForm) saisieForm.style.display = 'none';
      if(infoLecture){
        infoLecture.style.display = 'block';
        infoLecture.innerHTML = `🔒 <strong>Points versés</strong> — Vos points du jour ont été marqués comme versés par <strong>${esc(versementAujourdhui.marqueParNom)}</strong> à ${versementAujourdhui.heureMarquage||''}. Vous pourrez saisir à nouveau demain.`;
        infoLecture.style.background = 'rgba(34,212,160,0.08)';
        infoLecture.style.border = '1px solid rgba(34,212,160,0.3)';
        infoLecture.style.color = 'var(--accent2)';
      }
      return;
    }
  }

  if(saisieForm) saisieForm.style.display = canSaisirMise ? '' : 'none';
  if(infoLecture){
    if(!canSaisirMise){
      infoLecture.style.display = 'block';
      infoLecture.innerHTML = '🔍 <strong>Mode consultation</strong> — Vous pouvez consulter l\'historique des paiements mais pas enregistrer de nouvelle mise.';
      infoLecture.style.background = '';
      infoLecture.style.border = '';
      infoLecture.style.color = '';
    } else {
      infoLecture.style.display = 'none';
    }
  }
  // Champ date admin : afficher uniquement pour l'admin
  const dateAdminZone = document.getElementById('mise-date-admin-zone');
  const dateAdminInput = document.getElementById('mise-date-admin');
  if(dateAdminZone) dateAdminZone.style.display = (['admin','chef_agence'].includes(session.role)) ? '' : 'none';
  if(dateAdminInput) dateAdminInput.value = TODAY;
  const motifZone0 = document.getElementById('mise-motif-correction-zone');
  if(motifZone0) motifZone0.style.display = 'none';
}

// ── Affiche le champ "motif de correction" dès que l'admin/chef d'agence
// choisit une date de mise différente d'aujourd'hui.
window._miseToggleMotifCorrection = function(){
  const dateInput = document.getElementById('mise-date-admin');
  const motifZone = document.getElementById('mise-motif-correction-zone');
  if(!dateInput || !motifZone) return;
  motifZone.style.display = (dateInput.value && dateInput.value !== TODAY) ? '' : 'none';
};

window.miseLiveSearch = function(){
  const q = document.getElementById('mise-search-id').value.trim().toLowerCase();
  const res = document.getElementById('mise-search-results');
  if(!q){ res.style.display='none'; return; }
  let pool = clientsDansAgence();
  if(session.role ===ROLES.COMMERCIAL) pool = pool.filter(c => c.commercialId === session.userId);
  const found = pool.filter(c =>
    (c.codeClient && c.codeClient.toLowerCase().includes(q)) ||
    c._id.toLowerCase().includes(q) ||
    c.nom.toLowerCase().includes(q) ||
    (c.tel||'').toLowerCase().includes(q)
  ).slice(0, 8);
  if(!found.length){
    res.style.display = 'block';
    res.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--muted);">Aucun client trouvé.</div>';
    return;
  }
  res.style.display = 'block';
  res.innerHTML = found.map(c => {
    const s = stats(c);
    return `<div onclick="selectMiseClient('${c._id}')"
      style="padding:9px 12px;border-radius:7px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin-top:4px;background:var(--surface2);border:1px solid var(--border);transition:border-color 0.15s;"
      onmouseover="this.style.borderColor='rgba(201,168,76,0.5)'" onmouseout="this.style.borderColor='var(--border)'">
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(c.nom)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${esc(c.tel||'-')} - ${esc(c.ville||'-')} ${c.codeClient?`<span style="color:var(--accent);font-weight:700;">· ${esc(c.codeClient)}</span>`:''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:var(--accent2);font-weight:600;">${fmt(s.totalPaye)}</div>
        <div style="font-size:10px;color:var(--muted);">${s.pct}% - Retard: ${s.joursRetard}j</div>
      </div>
    </div>`;
  }).join('');
};

window.selectMiseClient = function(id){
  miseClientCtx = id;
  const c = getCl(id);
  const s = stats(c);
  const com = getCom(c.commercialId);
  document.getElementById('mise-search-results').style.display = 'none';
  document.getElementById('mise-search-id').value = c.codeClient || c.nom;
  document.getElementById('mc-nom').textContent = c.nom;
  document.getElementById('mc-meta').innerHTML = `${c.codeClient?`<span style="background:rgba(201,168,76,0.2);border:1px solid rgba(201,168,76,0.5);border-radius:5px;padding:1px 7px;font-size:11px;color:var(--accent);font-weight:700;margin-right:6px;">${esc(c.codeClient)}</span>`:''}${esc(c.tel||'-')} &nbsp;&middot;&nbsp; ${esc(c.ville||'-')}${c.quartier?' - '+esc(c.quartier):''} &nbsp;&middot;&nbsp; Commercial : ${esc(com.nom)}`;
  document.getElementById('mc-pct-badge').innerHTML =
    s.pct>=100 ? '<span class="sb sg">Solde</span>' :
    s.joursRetard>0 ? `<span class="sb sr">Retard ${s.joursRetard}j</span>` :
    '<span class="sb sb2">En cours</span>';
  document.getElementById('mc-cotis').textContent = fmt(s.m);
  document.getElementById('mc-paye').textContent = fmt(s.totalPaye);
  document.getElementById('mc-restant').textContent = fmt(s.totalRestant);
  document.getElementById('mc-pct-txt').textContent = s.pct+'%';
  document.getElementById('mc-pgb').style.width = s.pct+'%';
  document.getElementById('mc-pgb').style.background =
    s.pct>=100 ? 'var(--accent2)' : s.joursRetard>0 ? 'var(--danger)' : 'var(--accent)';
  document.getElementById('mc-retard').innerHTML = s.joursRetard>0
    ? `<span style="color:var(--danger);">Retard : ${s.joursRetard} jour(s) - montant en retard : <strong>${fmt(s.joursRetard * s.m)}</strong></span>`
    : `<span style="color:var(--accent2);">A jour - ${s.joursCouv} jours couverts sur ${s.joursEcoules} ecoules</span>`;
  document.getElementById('mise-nb-cotis').value = '';
  document.getElementById('mise-total-calc').textContent = '-';
  document.getElementById('mise-saisie-note').value = '';
  document.getElementById('mise-saisie-warn').style.display = 'none';

  // ── Niveau de cotisation visuel ──
  afficherNiveauCotisation(id, 0);

  afficherHistMisesClient(id);
  // ── Bloc adhésion ──
  miseAdhRefresh(id);
  document.getElementById('mise-client-card').style.display = 'block';
  document.getElementById('mise-client-card').scrollIntoView({behavior:'smooth', block:'start'});
};

// Met à jour le bloc encaissement adhésion selon le statut du client sélectionné
function miseAdhRefresh(id){
  const bloc = document.getElementById('mise-adh-bloc');
  if(!bloc) return;
  // Masquer le bloc adhésion pour les commerciaux
  if(session && session.role ===ROLES.COMMERCIAL){ bloc.style.display = 'none'; return; }
  const c = getCl(id);
  const sw = document.getElementById('mise-adh-status-wrap');
  const form = document.getElementById('mise-adh-form');
  bloc.style.display = 'block';
  if(c.adhesionStatut === 'paye'){
    // Chercher le paiement d'adhésion existant
    const adhPay = (DB.adhesionPays||[]).filter(a=>a.clientId===id).sort((a,b)=>b.date.localeCompare(a.date))[0];
    sw.innerHTML = `<div class="ib ib-green" style="margin:0;display:flex;align-items:center;gap:10px;">
      <span style="font-size:18px;">✅</span>
      <div>
        <div style="font-weight:700;font-size:12px;">Adhésion déjà encaissée</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">${adhPay ? fmt(adhPay.montant)+' FCFA — le '+adhPay.date : fmt(c.adhesion||200)+' FCFA'}</div>
      </div>
    </div>`;
    form.style.display = 'none';
  } else {
    sw.innerHTML = `<div class="ib ib-yellow" style="margin:0;display:flex;align-items:center;gap:10px;">
      <span style="font-size:18px;">⚠️</span>
      <div>
        <div style="font-weight:700;font-size:12px;">Adhésion non encaissée — Client : <strong>${esc(c.nom)}</strong></div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">Saisissez le montant et confirmez l'encaissement ci-dessous.</div>
      </div>
    </div>`;
    const montantEl = document.getElementById('mise-adh-montant');
    if(montantEl && !(montantEl.value > 0)) montantEl.value = c.adhesion || 200;
    form.style.display = 'block';
  }
}

window.calcMiseTotal = function(){
  if(!miseClientCtx) return;
  const nb = parseInt(document.getElementById('mise-nb-cotis').value) || 0;
  const c = getCl(miseClientCtx);
  const cotis = jm(c);
  const total = nb * cotis;
  const el = document.getElementById('mise-total-calc');
  if(nb > 0){
    el.textContent = '';
    el.innerHTML = `<span>${fmt(total)}</span>`;
    el.style.background = 'rgba(201,168,76,0.18)';
    el.style.borderColor = 'rgba(201,168,76,0.6)';
  } else {
    el.textContent = '-';
    el.style.background = 'rgba(201,168,76,0.12)';
    el.style.borderColor = 'rgba(201,168,76,0.35)';
  }
  const s = stats(c);
  const warn = document.getElementById('mise-saisie-warn');
  if(nb > 0 && total > s.totalRestant && s.totalRestant > 0){
    warn.style.display = 'block';
    warn.innerHTML = `<div class="ib ib-yellow">Ce montant (<strong>${fmt(total)}</strong>) dépasse le restant dû (<strong>${fmt(s.totalRestant)}</strong>).</div>`;
  } else { warn.style.display = 'none'; }

  // Mettre à jour la prévisualisation du niveau
  afficherNiveauCotisation(miseClientCtx, nb);
};

// ========= NIVEAU COTISATION AVANT / APRÈS =========
function afficherNiveauCotisation(clientId, nbNouveaux){
  const el = document.getElementById('mc-niveau-wrap');
  if(!el) return;
  const c = getCl(clientId);
  const s = stats(c);
  const duree = c.duree || 372;
  const cotis = jm(c);

  const joursCouvertsActuel = s.joursCouv;
  const joursApres = Math.min(duree, joursCouvertsActuel + nbNouveaux);
  const pctActuel = Math.min(100, Math.round(joursCouvertsActuel/duree*100));
  const pctApres = Math.min(100, Math.round(joursApres/duree*100));

  const colorActuel = s.joursRetard>0 ? 'var(--danger)' : 'var(--accent)';
  const colorApres = '#22d4a0';

  const gainJours = joursApres - joursCouvertsActuel;
  const gainMontant = gainJours * cotis;

  el.innerHTML = `
  <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
    <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:var(--accent);">📊 Niveau de cotisation</div>
    ${nbNouveaux>0?`<span style="font-size:10px;background:rgba(34,212,160,0.12);border:1px solid rgba(34,212,160,0.3);border-radius:20px;padding:2px 10px;color:var(--accent2);font-weight:700;">+${gainJours} jour(s) — ${fmt(gainMontant)}</span>`:''}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
    <div style="background:rgba(201,168,76,0.07);border:1px solid rgba(201,168,76,0.2);border-radius:8px;padding:10px;">
      <div class="niveau-label">Niveau actuel</div>
      <div class="niveau-val" style="color:${colorActuel};">${joursEnJM(joursCouvertsActuel)} <span style="font-size:11px;font-weight:400;color:var(--muted);" title="${joursCouvertsActuel}/${duree} jours">/ ${joursEnJM(duree)}</span></div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px;">${pctActuel}% couvert${s.joursRetard>0?` · <span style="color:var(--danger);">${s.joursRetard}j retard</span>`:' · ✓ À jour'}</div>
      <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);margin-top:6px;overflow:hidden;">
        <div style="width:${pctActuel}%;height:100%;background:${colorActuel};border-radius:4px;transition:width 0.4s;"></div>
      </div>
    </div>
    <div style="background:rgba(34,212,160,0.08);border:1px solid rgba(34,212,160,0.2);border-radius:8px;padding:10px;${nbNouveaux>0?'':'opacity:0.4;'}">
      <div class="niveau-label">Après cette mise</div>
      <div class="niveau-val" style="color:${colorApres};">${nbNouveaux>0?joursEnJM(joursApres):'—'} ${nbNouveaux>0?`<span style="font-size:11px;font-weight:400;color:var(--muted);" title="${joursApres}/${duree} jours">/ ${joursEnJM(duree)}</span>`:''}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px;">${nbNouveaux>0?pctApres+'% couvert':'Saisissez un nombre de cotisations'}</div>
      <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);margin-top:6px;overflow:hidden;">
        <div style="width:${nbNouveaux>0?pctApres:0}%;height:100%;background:${colorApres};border-radius:4px;transition:width 0.5s cubic-bezier(0.34,1.56,0.64,1);"></div>
      </div>
    </div>
  </div>
  <!-- Barre de progression globale combinée -->
  <div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:3px;">
      <span>Progression sur ${duree} jours</span>
      <span>${nbNouveaux>0?`${pctActuel}% → <strong style="color:var(--accent2);">${pctApres}%</strong>`:pctActuel+'%'}</span>
    </div>
    <div style="height:10px;border-radius:6px;background:rgba(255,255,255,0.07);position:relative;overflow:hidden;">
      ${nbNouveaux>0?`<div style="position:absolute;top:0;left:0;width:${pctApres}%;height:100%;background:rgba(34,212,160,0.3);border-radius:6px;"></div>`:''}
      <div style="position:absolute;top:0;left:0;width:${pctActuel}%;height:100%;background:${colorActuel};border-radius:6px;"></div>
    </div>
  </div>`;
}



function afficherHistMisesClient(clientId){
  // Affiche les paiements enregistrés par les commerciaux (source:'commercial') pour ce client
  const hist = (DB.paiements||[]).filter(m=>m.clientId===clientId&&m.source==='commercial').sort((a,b)=>b.date.localeCompare(a.date));
  const el = document.getElementById('mise-saisie-hist');
  if(!hist.length){ el.innerHTML=''; return; }
  const totalMises = hist.reduce((a,m)=>a+m.montant,0);
  el.innerHTML = `<div class="tw" style="border-color:rgba(34,212,160,0.25);">
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:var(--accent2);">
      Paiements confirmés &mdash; ${hist.length} entrée(s) &middot; Total : <span style="color:var(--accent2)">${fmt(totalMises)}</span>
      <span style="float:right;font-size:10px;color:var(--muted);font-weight:400;">🔒 Non modifiables</span>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Date</th>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Heure</th>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Nb cotis.</th>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Montant</th>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Saisi par</th>
        <th style="padding:8px 12px;text-align:left;font-size:9.5px;color:var(--muted);background:var(--surface2);">Note</th>
      </tr></thead>
      <tbody>${hist.map(m=>`
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:8px 12px;font-size:12px;color:var(--muted);">${m.date}</td>
          <td style="padding:8px 12px;font-size:11px;color:var(--muted);">${m.heure||'—'}</td>
          <td style="padding:8px 12px;font-size:13px;font-weight:700;color:var(--accent2);">${m.nbCotis||'?'}x</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:700;color:var(--accent2);">${fmt(m.montant)}</td>
          <td style="padding:8px 12px;font-size:11px;color:var(--muted);">${esc(m.saisiParNom||m.saisieParNom||'—')}</td>
          <td style="padding:8px 12px;font-size:11px;">${esc(m.note||'—')} <span style="color:var(--accent2);font-size:10px;">🔒</span></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

// ========= REÇU IMPRIMABLE =========
function afficherRecu(data, opts){
  opts = opts || {};
  // Fonction d'échappement HTML locale pour sécuriser la popup (correction C3)
  function _escHtml(s){ if(s==null)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  // data: { type, clientNom, clientCode, clientTel, clientVille, commercialNom, montant, nbCotis, cotisJour, date, heure, note, totalPaye, totalRestant, pct, contrat, saisiParNom }
  const isReprint = !!opts.reprint;
  const now = new Date();
  let recuNum, emissionDate, emissionHeure;
  if(isReprint && opts.recuNum){
    // Réimpression : on conserve exactement le numéro et la date d'émission d'origine
    recuNum = opts.recuNum;
    emissionDate = opts.emissionDate;
    emissionHeure = opts.emissionHeure;
  } else {
    // Génération d'un numéro de reçu unique lisible : REC-YYYYMMDD-XXXXX
    const ymd = now.getFullYear().toString()
      + String(now.getMonth()+1).padStart(2,'0')
      + String(now.getDate()).padStart(2,'0');
    recuNum = 'REC-' + ymd + '-' + Date.now().toString(36).toUpperCase().slice(-5);
    emissionDate = now.toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'});
    emissionHeure = String(now.getHours()).padStart(2,'0') + 'h' + String(now.getMinutes()).padStart(2,'0');

    // Enregistrement du reçu dans l'historique (réimprimable ensuite par
    // administrateur, chef d'agence et secrétaire). Non bloquant : l'impression
    // du reçu ne doit jamais être retardée ou empêchée par cette sauvegarde.
    try {
      fbAdd('recus', {
        recuNum, emissionDate, emissionHeure,
        type: data.type || 'cotisation',
        clientId: data.clientId || null,
        clientNom: data.clientNom || '',
        clientCode: data.clientCode || '',
        clientTel: data.clientTel || '',
        clientVille: data.clientVille || '',
        commercialId: data.commercialId || null,
        commercialNom: data.commercialNom || '',
        montant: Number(data.montant||0),
        nbCotis: Number(data.nbCotis||0),
        cotisJour: Number(data.cotisJour||0),
        date: data.date || TODAY,
        heure: data.heure || emissionHeure,
        note: data.note || '',
        saisiParId: session?.userId || null,
        saisiParNom: data.saisiParNom || ''
      }).catch(e => console.error('[afficherRecu] Échec enregistrement historique reçu :', e));
    } catch(e) { console.error('[afficherRecu] Échec enregistrement historique reçu :', e); }
  }

  const typeLabel = data.type === 'adhesion' ? 'ENCAISSEMENT ADHÉSION' : data.type === 'rachat_carnet' ? 'RACHAT DE CARNET' : 'PAIEMENT DE COTISATION(S)';
  const typeIcon  = data.type === 'adhesion' ? '🤝' : data.type === 'rachat_carnet' ? '📘' : '💳';

  // Agence du commercial
  const _comObj = DB.commerciaux.find(c=>c._id === data.commercialId) || {};
  const _agObj  = _comObj.agenceId ? (DB.agences.find(a=>a._id===_comObj.agenceId)||{}) : {};
  const agenceLabel = [_agObj.nom, _agObj.ville, _comObj.zone].filter(Boolean).join(' — ') || '—';

  // Plein écran sur mobile, grande fenêtre sur desktop
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const winFeatures = isMobile
    ? 'width=' + screen.width + ',height=' + screen.height + ',top=0,left=0,scrollbars=yes,resizable=yes'
    : 'width=820,height=980,scrollbars=yes,left=' + Math.round((screen.width-820)/2) + ',top=40';
  const win = window.open('', '_blank', winFeatures);
  if(!win){ alert('Veuillez autoriser les popups pour imprimer le reçu.'); return; }
  win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Reçu ${recuNum}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  html{font-size:18px;}
  body{font-family:'Aptos','Segoe UI',sans-serif;background:#e8eaf0;display:flex;flex-direction:column;align-items:center;padding:16px 10px 32px;gap:14px;min-height:100vh;}
  .ticket{background:#fff;width:100%;max-width:620px;border-radius:12px;box-shadow:0 8px 36px rgba(0,0,0,0.26);page-break-inside:avoid;}
  .hdr{background:#0c0e12;color:#c9a84c;padding:24px 22px 18px;text-align:center;border-bottom:3px solid #c9a84c;border-radius:12px 12px 0 0;}
  .hdr-name{font-size:1.35rem;font-weight:700;letter-spacing:1px;}
  .hdr-type{font-size:0.85rem;margin-top:8px;color:#e8c96a;text-transform:uppercase;letter-spacing:1.5px;}
  .body{padding:20px 20px 16px;}
  .sep{border:none;border-top:1px dashed #bbb;margin:16px 0;}
  .row{display:flex;justify-content:space-between;align-items:baseline;font-size:1rem;padding:7px 0;gap:12px;}
  .lbl{color:#666;flex-shrink:0;}
  .val{font-weight:700;color:#111;text-align:right;word-break:break-word;}
  .val.gold{color:#b8833e;}
  .amt{text-align:center;padding:22px 0 16px;}
  .amt-val{font-size:2.6rem;font-weight:700;color:#0c0e12;line-height:1.1;}
  .amt-sub{font-size:1rem;color:#555;margin-top:8px;}
  .ftr{background:#f5f5f8;border-top:1px dashed #bbb;padding:18px 22px;text-align:center;font-size:0.95rem;color:#777;line-height:2;border-radius:0 0 12px 12px;}
  .actions{display:flex;gap:10px;width:100%;max-width:620px;flex-wrap:wrap;}
  .btn-p{flex:1;background:#c9a84c;color:#0c0e12;border:none;padding:16px 0;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;}
  .btn-bt{flex:1;background:#1a6fc4;color:#fff;border:none;padding:16px 0;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;}
  .btn-f{background:#1c2130;color:#dce1ee;border:1px solid #444;padding:16px 20px;border-radius:10px;font-size:1rem;cursor:pointer;}
  @media(max-width:768px){
    html{font-size:20px;}
    body{padding:0;gap:0;background:#fff;min-height:100vh;}
    .ticket{max-width:100%;width:100%;border-radius:0;box-shadow:none;}
    .hdr{border-radius:0;padding:28px 20px 22px;}
    .hdr-name{font-size:1.3rem;}
    .amt-val{font-size:3rem;}
    .row{font-size:1.1rem;padding:9px 0;}
    .body{padding:22px 20px 18px;}
    .actions{position:fixed;bottom:0;left:0;width:100%;padding:10px 12px;background:#e8eaf0;box-shadow:0 -2px 12px rgba(0,0,0,0.15);gap:8px;max-width:100%;}
    .btn-p,.btn-bt{padding:18px 0;font-size:1.1rem;}
    .btn-f{padding:18px 16px;font-size:1.1rem;}
    .ticket{padding-bottom:90px;}
  }
  @media print{
    @page{margin:4mm;size:auto;}
    html,body{
      width:100% !important;
      height:auto !important;
      min-height:0 !important;
      background:#fff !important;
      padding:0 !important;
      gap:0 !important;
      display:block !important;
    }
    .ticket{
      width:100% !important;
      max-width:100% !important;
      box-shadow:none !important;
      border-radius:0 !important;
      page-break-inside:avoid !important;
      border:none !important;
    }
    .hdr{
      background:#0c0e12 !important;
      -webkit-print-color-adjust:exact !important;
      print-color-adjust:exact !important;
      border-radius:0 !important;
      padding:12px 14px !important;
    }
    .hdr-name{font-size:14px !important;}
    .hdr-type{font-size:10px !important;}
    .body{padding:10px 14px 8px !important;}
    .sep{margin:8px 0 !important;}
    .row{font-size:11px !important;padding:3px 0 !important;}
    .lbl{color:#555 !important;}
    .val{max-width:180px !important;font-size:11px !important;}
    .amt-val{font-size:22px !important;}
    .amt-sub{font-size:10px !important;}
    .ftr{
      background:#f5f5f8 !important;
      -webkit-print-color-adjust:exact !important;
      print-color-adjust:exact !important;
      padding:8px 14px !important;
      font-size:10px !important;
      border-radius:0 !important;
    }
    .actions{display:none !important;}
  }
</style>
</head>
<body>
<div class="ticket">
  <div class="hdr">
    <div class="hdr-name">TRIOMPHANT MMB SERVICE</div>
    <div class="hdr-type">${typeIcon} ${typeLabel}</div>
    ${isReprint?'<div style="margin-top:6px;font-size:0.7rem;color:#e8c96a;letter-spacing:1px;">🔁 RÉIMPRESSION</div>':''}
  </div>
  <div class="body">
    <div class="row"><span class="lbl">N° Reçu</span><span class="val gold">${recuNum}</span></div>
    <div class="row"><span class="lbl">Date</span><span class="val">${emissionDate} ${emissionHeure}</span></div>
    <hr class="sep">
    ${data.clientCode?`<div class="row"><span class="lbl">Code</span><span class="val gold">${_escHtml(data.clientCode)}</span></div>`:''}
    <div class="row"><span class="lbl">Client</span><span class="val">${_escHtml(data.clientNom)}</span></div>
    <hr class="sep">
    <div class="amt">
      <div class="amt-val">${Number(data.montant||0).toLocaleString('fr-FR')} FCFA</div>
      ${data.type!=='adhesion'?`<div class="amt-sub">${Number(data.nbCotis||0)} cotis. × ${Number(data.cotisJour||0).toLocaleString('fr-FR')} FCFA</div>`:''}
    </div>
    <hr class="sep">
    <div class="row"><span class="lbl">Saisi par</span><span class="val">${_escHtml(data.saisiParNom)}</span></div>
    ${agenceLabel!=='—'?`<div class="row"><span class="lbl">Agence</span><span class="val">${_escHtml(agenceLabel)}</span></div>`:''}
    ${data.note?`<div class="row"><span class="lbl">Note</span><span class="val">${_escHtml(data.note)}</span></div>`:''}
  </div>
  <div class="ftr">
    Conservez ce reçu — preuve officielle
  </div>
</div>
<div class="actions">
  <button class="btn-p" onclick="window.print()">🖨️ Standard</button>
  <button class="btn-bt" id="btn-bluetooth-print">📲 Bluetooth</button>
  <button class="btn-f" onclick="window.close()">✕</button>
</div>
<script>
  // Les données sont transmises via postMessage pour éviter toute injection de script
  document.getElementById('btn-bluetooth-print').addEventListener('click', function(){
    if(window.opener && window.opener.imprimerBluetooth){
      // Récupérer les données depuis l'attribut data-payload encodé en base64
      var payload = JSON.parse(atob(document.getElementById('recu-payload').dataset.payload));
      window.opener.imprimerBluetooth(
        payload.data,
        payload.recuNum,
        payload.emissionDate,
        payload.emissionHeure,
        payload.agenceLabel,
        function(){ window.close(); }
      );
    } else {
      alert('Impression Bluetooth indisponible.\\nRechargez la page principale.');
    }
  });
<\/script>
<!-- Payload sécurisé en base64 — évite l'injection de script via les données -->
<div id="recu-payload" style="display:none" data-payload="${btoa(unescape(encodeURIComponent(JSON.stringify({data, recuNum, emissionDate, emissionHeure, agenceLabel}))))}"></div>
</body>
</html>`);
  win.document.close();
  win.focus();
}

window.enregistrerMiseSaisie = async function(){
  if(!['admin','commercial','secretaire','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  if(!miseClientCtx){ notify("Sélectionnez un client d'abord",'err'); return; }
  const nb = parseInt(document.getElementById('mise-nb-cotis').value);
  if(!nb||nb<=0){ notify('Entrez un nombre de cotisations valide','err'); return; }
  const c = getCl(miseClientCtx);

  // ── BLOCAGE : vérifier si les points du jour sont déjà marqués versés ──
  if(session.role ===ROLES.COMMERCIAL){
    const versementAujourdhui = getVersementDuJour(c.commercialId, TODAY);
    if(versementAujourdhui){
      notify(`🔒 Vos points du ${TODAY} ont déjà été marqués comme versés par la secrétaire. Vous ne pouvez pas enregistrer de mise aujourd'hui.`, 'err');
      return;
    }
  }
  const montant = nb * jm(c);
  const note = document.getElementById('mise-saisie-note').value.trim();
  // Date : l'admin/chef d'agence peut choisir une date personnalisée
  let dateChoisie = TODAY;
  if(['admin','chef_agence'].includes(session.role)){
    const dateAdminVal = (document.getElementById('mise-date-admin')?.value || '').trim();
    if(dateAdminVal) dateChoisie = dateAdminVal;
  }
  const now = new Date();
  const heure = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  // ── Correction datée différemment d'aujourd'hui : motif obligatoire,
  // jamais silencieuse. La date réelle de saisie et l'auteur restent
  // toujours visibles dans le registre et la fiche du commercial.
  const estCorrection = ['admin','chef_agence'].includes(session.role) && dateChoisie !== TODAY;
  let motifCorrection = '';
  if(estCorrection){
    motifCorrection = (document.getElementById('mise-motif-correction')?.value || '').trim();
    if(!motifCorrection){
      notify('Motif de la correction obligatoire — expliquez pourquoi cette mise est datée différemment.','err');
      return;
    }
  }

  // Confirmation irréversible obligatoire
  const dateMention = dateChoisie !== TODAY ? `\nDate : ${dateChoisie} ⚠️ (correction admin — motif : ${motifCorrection})` : '';
  if(!(await confirmDialog(`Client : ${esc(c.nom)}\nCotisations : ${nb}x\nMontant : ${fmt(montant)}${dateMention}\n\nCe paiement ne pourra pas être modifié.`,{title:'⚠️ Confirmation irréversible',okLabel:'Confirmer le paiement',danger:true}))) return;
  try{
    // Enregistrer dans paiements (pas mises) — verrouillé (source: commercial)
    const paiementMiseData = {
      clientId:miseClientCtx, commercialId:c.commercialId,
      cotisJour:jm(c), montant, date:dateChoisie, heure,
      note: note || `${nb} cotisation(s) — saisie ${session.role===ROLES.SECRETAIRE?'secrétaire':session.role===ROLES.ADMIN?'admin':session.role===ROLES.CHEF_AGENCE?'chef d\'agence':'commercial'}`,
      nbCotis:nb, type:'mise', source:session.role===ROLES.SECRETAIRE?'secretaire':session.role===ROLES.ADMIN?'admin':session.role===ROLES.CHEF_AGENCE?'chef_agence':'commercial',
      saisiParId:session.userId, saisiParNom:session.nom,
      verrouille:true
    };
    if(estCorrection){
      paiementMiseData.estCorrection = true;
      paiementMiseData.dateSaisieReelle = TODAY;
      paiementMiseData.motifCorrection = motifCorrection;
    }
    await fbAdd('paiements',paiementMiseData);
    notify(estCorrection
      ? `✅ Correction enregistrée sur le ${dateChoisie} — visible dans le registre et la fiche du commercial`
      : `✅ ${nb} cotisation(s) enregistrée(s) — ${fmt(montant)} FCFA encaissé`,'ok');
    if(curPg==='fiche' && typeof renderFiche==='function') renderFiche();
    else if(curPg==='registre' && typeof renderRegistre==='function') renderRegistre();
  }catch(e){
    console.error('Échec enregistrement cotisation:', e);
    notify("Échec de l'enregistrement — vérifiez votre connexion avant de ressaisir, pour éviter un double paiement.", 'err');
    return;
  }
  // Afficher le reçu automatiquement
  await new Promise(r=>setTimeout(r,350));
  const sApres = stats(getCl(miseClientCtx));
  const com = getCom(c.commercialId);
  afficherRecu({
    type: 'cotisation',
    clientNom: c.nom,
    clientCode: c.codeClient || '',
    commercialNom: com.nom,
    commercialId: c.commercialId,
    montant, nbCotis: nb, cotisJour: jm(c),
    date: dateChoisie, heure,
    note: note || `${nb} cotisation(s)`,
    saisiParNom: session.nom,
    totalPaye: sApres.totalPaye,
    totalRestant: sApres.totalRestant,
    pct: sApres.pct
  });
  // Réinitialiser et recharger
  document.getElementById('mise-nb-cotis').value = '';
  document.getElementById('mise-total-calc').textContent = '-';
  document.getElementById('mise-saisie-note').value = '';
  document.getElementById('mise-saisie-warn').style.display = 'none';
  if(['admin','chef_agence'].includes(session.role)){
    const dateAdminInput = document.getElementById('mise-date-admin');
    if(dateAdminInput) dateAdminInput.value = TODAY;
    const motifInput = document.getElementById('mise-motif-correction');
    if(motifInput) motifInput.value = '';
    const motifZone = document.getElementById('mise-motif-correction-zone');
    if(motifZone) motifZone.style.display = 'none';
  }
  // ✅ Pour les commerciaux : formulaire entièrement vierge après confirmation
  // (déselectionne le client, vide la recherche) — évite tout risque de double saisie
  // sur le même client. Admin/secrétaire gardent le client sélectionné (saisies en série).
  // ✅ Pour tous les rôles : la page revient entièrement à son état initial
  // après confirmation du paiement (client désélectionné, champ de recherche
  // vidé, formulaire vierge) — évite tout risque de double saisie.
  renderSaisieMises();
};

// ========= SAISIE DES ADHÉSIONS =========
function renderSaisieAdhesions(){
  if(!['admin','commercial','secretaire','chef_agence'].includes(session?.role)){
    document.getElementById('tb-saisie-adhesions').innerHTML=
      '<tr><td colspan="7" class="emp">Accès réservé à l\'admin, au secrétaire, au chef d\'agence et aux commerciaux.</td></tr>';
    return;
  }

  // Peupler le select commercial — ✅ PERF : ne reconstruire que si changé
  // (pas à chaque frappe via dRender('renderSaisieAdhesions')).
  const selCom = document.getElementById('adh-filter-com');
  if(selCom){
    const comsVisibles = ['admin','chef_agence','secretaire'].includes(session.role)
      ? comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL)
      : [DB.commerciaux.find(c=>c._id===session.userId)].filter(Boolean);
    const comsSig = comsVisibles.map(c=>c._id).join(',');
    const prev = selCom.value;
    if (selCom.dataset.comsSig !== comsSig) {
      selCom.innerHTML = (['admin','chef_agence','secretaire'].includes(session.role)
        ? '<option value="">Tous les commerciaux</option>'
        : '') +
        comsVisibles.map(c=>`<option value="${c._id}"${c._id===prev?' selected':''}>${esc(c.nom)}</option>`).join('');
      selCom.value = prev;
      selCom.dataset.comsSig = comsSig;
    }
    // Pour le commercial, forcer son propre filtre
    if(session.role ===ROLES.COMMERCIAL) selCom.value = session.userId;
  }

  const filtComId = document.getElementById('adh-filter-com')?.value || '';
  const filtStatut = document.getElementById('adh-filter-statut')?.value || '';
  const q = (document.getElementById('adh-search')?.value || '').toLowerCase().trim();

  // Base clients
  let clients = clientsDansAgence();
  if(session.role ===ROLES.COMMERCIAL) clients = clients.filter(c=>c.commercialId===session.userId);
  if(filtComId) clients = clients.filter(c=>c.commercialId===filtComId);
  if(filtStatut) clients = clients.filter(c=>(c.adhesionStatut||'non_paye')===filtStatut);
  if(q) clients = clients.filter(c=>
    c.nom.toLowerCase().includes(q) ||
    (c.codeClient&&c.codeClient.toLowerCase().includes(q)) ||
    (c.tel||'').includes(q)
  );

  // Trier : non payés en premier, puis par nom
  clients = [...clients].sort((a,b)=>{
    const as = (a.adhesionStatut||'non_paye')==='non_paye'?0:1;
    const bs = (b.adhesionStatut||'non_paye')==='non_paye'?0:1;
    if(as!==bs) return as-bs;
    return a.nom.localeCompare(b.nom);
  });

  // KPIs
  const total = clientsDansAgence().filter(c=>session.role===ROLES.COMMERCIAL?c.commercialId===session.userId:true);
  const nbPaye = total.filter(c=>c.adhesionStatut==='paye').length;
  const nbNonPaye = total.filter(c=>(c.adhesionStatut||'non_paye')==='non_paye').length;
  const montantTotal = nbPaye * 200;
  document.getElementById('adh-kpi').innerHTML=`
    <div class="kpi-card kc-green"><div class="kpi-lbl">Adhésions payées</div><div class="kpi-val kv-green">${nbPaye}</div><div class="kpi-sub">${Number(montantTotal).toLocaleString('fr-FR')} FCFA encaissés</div></div>
    <div class="kpi-card kc-red"><div class="kpi-lbl">Non payées</div><div class="kpi-val kv-red">${nbNonPaye}</div><div class="kpi-sub">en attente</div></div>
    <div class="kpi-card kc-blue"><div class="kpi-lbl">Résultat filtre</div><div class="kpi-val kv-blue">${clients.length}</div><div class="kpi-sub">clients affichés</div></div>`;

  // Label filtres
  const labelEl = document.getElementById('adh-filtre-label');
  if(labelEl){
    const parts=[];
    if(filtComId){ const com=DB.commerciaux.find(c=>c._id===filtComId); if(com) parts.push('👤 '+com.nom); }
    if(filtStatut) parts.push(filtStatut==='paye'?'✅ Payé':'❌ Non payé');
    if(q) parts.push('🔍 "'+q+'"');
    labelEl.innerHTML=parts.length
      ?`<span style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.2);border-radius:6px;padding:3px 10px;">Filtres actifs : ${parts.join(' · ')}</span>`:'';
  }

  // Tableau
  const canSaisir = ['admin','commercial'].includes(session?.role); // encaissement adhésion (inchangé)
  const canRachat = ['admin','secretaire','chef_agence'].includes(session?.role); // ✅ rachat de carnet : pas les commerciaux
  document.getElementById('tb-saisie-adhesions').innerHTML = clients.map(c=>{
    const com = getCom(c.commercialId);
    const paye = (c.adhesionStatut||'non_paye') === 'paye';
    const adhPay = paye ? (DB.adhesionPays||[]).filter(a=>a.clientId===c._id).sort((a,b)=>b.date.localeCompare(a.date))[0] : null;
    // ✅ Rachat de carnet : frais séparé, toujours disponible, quel que soit le statut d'adhésion
    const rachats = (DB.rachatCarnetPays||[]).filter(r=>r.clientId===c._id).sort((a,b)=>b.date.localeCompare(a.date));
    return `<tr>
      <td><span style="font-size:10px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.35);border-radius:4px;padding:1px 7px;color:var(--accent);font-weight:700;">${esc(c.codeClient||'—')}</span></td>
      <td class="fw6">${esc(c.nom)}<div class="tm" style="font-size:10px">${esc(c.ville||'')} ${c.quartier?'· '+esc(c.quartier):''}</div></td>
      <td>${esc(c.tel||'—')}</td>
      <td><span class="tag">${esc(com.nom)}</span></td>
      <td style="text-align:center;">
        ${paye
          ? `<span class="adh-badge-paye">✅ Payée</span>${adhPay?`<div style="font-size:9px;color:var(--muted);margin-top:3px;">${adhPay.date}${adhPay.heure?' · '+adhPay.heure:''}</div>`:''}`
          : `<span class="adh-badge-non">❌ Non payée</span>`
        }
      </td>
      <td style="text-align:center;">
        ${canRachat
          ? `<button class="adh-btn-encaisser" style="background:rgba(100,160,247,0.15);color:#64a0f7;border:1px solid rgba(100,160,247,0.35);" onclick="ouvrirRachatCarnet('${c._id}')">📘 Racheter 200 FCFA</button>`
          : ''
        }
        ${rachats.length>0?`<div style="font-size:9px;color:var(--muted);margin-top:3px;">${rachats.length} rachat(s) — dernier : ${rachats[0].date}</div>`:''}
      </td>
      <td style="text-align:center;">
        ${(!paye && canSaisir)
          ? `<button class="adh-btn-encaisser" onclick="ouvrirEncaissementAdh('${c._id}')">🎫 Encaisser 200 FCFA</button>`
          : `<span style="font-size:10px;color:var(--muted);">${paye?'—':'Accès refusé'}</span>`
        }
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="emp">${q||filtComId||filtStatut?'Aucun client pour ces filtres':'Aucun client'}</td></tr>`;
}

window.adhResetFiltres = function(){
  ['adh-filter-com','adh-filter-statut','adh-search'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  renderSaisieAdhesions();
};

window.ouvrirEncaissementAdh = function(clientId){
  if(!['admin','commercial'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const c = getCl(clientId);
  if(!c){ notify('Client introuvable','err'); return; }
  if(c.adhesionStatut==='paye'){ notify('Adhésion déjà encaissée','err'); return; }
  document.getElementById('m-adh-client-id').value = clientId;
  document.getElementById('m-adh-note').value = '';
  document.getElementById('m-adh-client-info').innerHTML =
    `<strong>Client :</strong> ${esc(c.nom)} ${c.codeClient?'<span style="color:var(--accent);font-weight:700;">('+c.codeClient+')</span>':''}<br>
     <strong>Commercial :</strong> ${getCom(c.commercialId).nom}`;
  // Champ date visible uniquement pour l'admin (pour antidater un encaissement)
  const dateRow = document.getElementById('m-adh-date-row');
  const dateInput = document.getElementById('m-adh-date');
  if(['admin','chef_agence'].includes(session.role)){
    dateRow.style.display = '';
    dateInput.value = TODAY;
  } else {
    dateRow.style.display = 'none';
    dateInput.value = TODAY;
  }
  openM('m-encaisser-adh');
};

window.confirmerEncaissementAdh = async function(){
  if(!['admin','commercial'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const clientId = document.getElementById('m-adh-client-id').value;
  const note = document.getElementById('m-adh-note').value.trim();
  const c = getCl(clientId);
  if(!c){ notify('Client introuvable','err'); return; }
  if(c.adhesionStatut==='paye'){ notify('Adhésion déjà encaissée','err'); closeM('m-encaisser-adh'); return; }
  if(!(await confirmDialog(`Client : ${esc(c.nom)}\nMontant : 200 FCFA\n\nCet encaissement ne peut pas être annulé.`,{title:'⚠️ Confirmation irréversible',okLabel:'Confirmer',danger:true}))) return;
  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  // Admin peut choisir une date différente d'aujourd'hui
  const dateChoisie = (['admin','chef_agence'].includes(session.role) && document.getElementById('m-adh-date')?.value)
    ? document.getElementById('m-adh-date').value
    : TODAY;
  await fbUpdate('clients', clientId, {adhesionStatut:'paye', adhesion:200});
  await fbAdd('adhesionPays',{
    clientId,
    commercialId: c.commercialId,
    montant: 200,
    date: dateChoisie,
    heure: dateChoisie === TODAY ? heure : '00:00',
    note: note || ('Adhésion encaissée — saisie adhésions' + (dateChoisie !== TODAY ? ' (date modifiée par admin)' : '')),
    saisiParId: session.userId,
    saisiParNom: session.nom,
    verrouille: true
  });
  closeM('m-encaisser-adh');
  notify(`✅ Adhésion de ${esc(c.nom)} encaissée — 200 FCFA`);
  // Afficher le reçu
  await new Promise(r=>setTimeout(r,300));
  afficherRecu({
    type: 'adhesion',
    clientNom: c.nom,
    clientCode: c.codeClient || '',
    commercialNom: getCom(c.commercialId).nom,
    commercialId: c.commercialId,
    montant: 200, nbCotis: 1, cotisJour: 200,
    date: TODAY, heure,
    note: note || 'Adhésion encaissée',
    saisiParNom: session.nom,
    totalPaye: 200,
    totalRestant: 0,
    pct: 100
  });
  renderSaisieAdhesions();
};

// ========= RACHAT DE CARNET (frais séparé, répétable) =========
// Contrairement à l'adhésion, ce frais n'a pas de statut "payé/non payé" :
// c'est un historique de paiements, comme les paiements normaux, qu'on peut
// encaisser autant de fois que nécessaire (ex : perte de carnet).
window.ouvrirRachatCarnet = function(clientId){
  if(!['admin','secretaire','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const c = getCl(clientId);
  if(!c){ notify('Client introuvable','err'); return; }
  document.getElementById('m-rachat-client-id').value = clientId;
  document.getElementById('m-rachat-note').value = '';
  document.getElementById('m-rachat-client-info').innerHTML =
    `<strong>Client :</strong> ${esc(c.nom)} ${c.codeClient?'<span style="color:var(--accent);font-weight:700;">('+c.codeClient+')</span>':''}<br>
     <strong>Commercial :</strong> ${getCom(c.commercialId).nom}`;
  // Champ date visible uniquement pour l'admin (pour antidater un encaissement)
  const dateRow = document.getElementById('m-rachat-date-row');
  const dateInput = document.getElementById('m-rachat-date');
  if(['admin','chef_agence'].includes(session.role)){
    dateRow.style.display = '';
    dateInput.value = TODAY;
  } else {
    dateRow.style.display = 'none';
    dateInput.value = TODAY;
  }
  openM('m-rachat-carnet');
};

window.confirmerRachatCarnet = async function(){
  if(!['admin','secretaire','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  const clientId = document.getElementById('m-rachat-client-id').value;
  const note = document.getElementById('m-rachat-note').value.trim();
  const c = getCl(clientId);
  if(!c){ notify('Client introuvable','err'); return; }
  if(!(await confirmDialog(`Client : ${esc(c.nom)}\nRachat de carnet : 200 FCFA\n\nCet encaissement ne peut pas être annulé.`,{title:'⚠️ Confirmation irréversible',okLabel:'Confirmer',danger:true}))) return;
  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  // Admin peut choisir une date différente d'aujourd'hui
  const dateChoisie = (['admin','chef_agence'].includes(session.role) && document.getElementById('m-rachat-date')?.value)
    ? document.getElementById('m-rachat-date').value
    : TODAY;
  // ✅ Frais séparé : on n'écrase jamais adhesionStatut/adhesion — uniquement un nouveau document d'historique
  await fbAdd('rachatCarnetPays',{
    clientId,
    commercialId: c.commercialId,
    montant: 200,
    date: dateChoisie,
    heure: dateChoisie === TODAY ? heure : '00:00',
    note: note || ('Rachat de carnet encaissé' + (dateChoisie !== TODAY ? ' (date modifiée par admin)' : '')),
    saisiParId: session.userId,
    saisiParNom: session.nom,
    verrouille: true
  });
  closeM('m-rachat-carnet');
  notify(`✅ Rachat de carnet de ${esc(c.nom)} encaissé — 200 FCFA`);
  // Afficher le reçu
  await new Promise(r=>setTimeout(r,300));
  afficherRecu({
    type: 'rachat_carnet',
    clientNom: c.nom,
    clientCode: c.codeClient || '',
    commercialNom: getCom(c.commercialId).nom,
    commercialId: c.commercialId,
    montant: 200, nbCotis: 1, cotisJour: 200,
    date: dateChoisie, heure,
    note: note || 'Rachat de carnet encaissé',
    saisiParNom: session.nom,
    totalPaye: 200,
    totalRestant: 0,
    pct: 100
  });
  renderSaisieAdhesions();
};

// ========= ENCAISSEMENT ADHÉSION — SAISIE MISES =========
window.enregistrerAdhesionMise = async function(){
  if(!['admin','commercial','chef_agence'].includes(session?.role)){ notify('Accès refusé','err'); return; }
  if(!miseClientCtx){ notify("Sélectionnez un client d'abord",'err'); return; }
  const c = getCl(miseClientCtx);
  if(c.adhesionStatut === 'paye'){ notify('Adhésion déjà encaissée','err'); return; }
  const montant = parseFloat(document.getElementById('mise-adh-montant').value);
  if(!montant || montant <= 0){ notify('Entrez un montant valide','err'); return; }
  const note = document.getElementById('mise-adh-note').value.trim();
  const now = new Date();
  const heure = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  if(!(await confirmDialog(`Client : ${esc(c.nom)}\nAdhésion : ${fmt(montant)} FCFA\n\nCet encaissement ne pourra pas être modifié.`,{title:'⚠️ Confirmation irréversible',okLabel:'Confirmer',danger:true}))) return;
  await fbUpdate('clients', miseClientCtx, { adhesionStatut:'paye', adhesion: montant });
  await fbAdd('adhesionPays', {
    clientId: miseClientCtx,
    commercialId: c.commercialId,
    montant, date: TODAY, heure,
    note: note || 'Adhésion encaissée — saisie commercial',
    saisiParId: session.userId, saisiParNom: session.nom,
    verrouille: true
  });
  notify(`✅ Adhésion de ${esc(c.nom)} encaissée — ${fmt(montant)} FCFA`);
  // Afficher le reçu imprimable
  const comAdh = getCom(c.commercialId);
  await new Promise(r=>setTimeout(r,350));
  afficherRecu({
    type: 'adhesion',
    clientNom: c.nom,
    clientCode: c.codeClient || '',
    commercialNom: comAdh.nom,
    commercialId: c.commercialId,
    montant, nbCotis: 1, cotisJour: montant,
    date: TODAY, heure,
    note: note || 'Adhésion encaissée',
    saisiParNom: session.nom,
    totalPaye: montant,
    totalRestant: 0,
    pct: 100
  });
  document.getElementById('mise-adh-note').value = '';
  document.getElementById('mise-adh-montant').value = '';
  // ✅ Pour les commerciaux : formulaire entièrement vierge après confirmation.
  // Admin garde le client sélectionné (peut enchaîner d'autres opérations sur ce client).
  if(session.role ===ROLES.COMMERCIAL){
    renderSaisieMises();
  } else {
    miseAdhRefresh(miseClientCtx);
  }
  // ── Rafraîchir registre et fiche du jour immédiatement ──
  if(typeof renderRegistre === 'function') renderRegistre();
  if(typeof renderFiche === 'function') renderFiche();
};

// ╔══════════════════════════════════════════════════════════════╗
// ║  MODULE: BOOT                                                 ║
// ║  Extraction: node extract-modules.js → js/boot.js            ║
// ╚══════════════════════════════════════════════════════════════╝
// ========= RESPONSIVE — SIDEBAR MOBILE =========
function toggleSidebar(){
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = sidebar.classList.contains('open');
  if(isOpen){
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  } else {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
  }
}

// Fermer la sidebar quand on clique sur un item de nav en mobile
function closeSidebarMobile(){
  if(window.innerWidth <= 768){
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
  }
}

// Attacher l'événement closeSidebarMobile à tous les .nav-item (après leur création)
const _navObserver = new MutationObserver(()=>{
  document.querySelectorAll('.nav-item').forEach(el=>{
    if(!el.dataset.mobileListener){
      el.dataset.mobileListener = '1';
      el.addEventListener('click', closeSidebarMobile);
    }
  });
});
_navObserver.observe(document.getElementById('nav-menu'), {childList:true, subtree:true});

// ========= BOOT =========
document.getElementById('reg-date').value=TODAY;
const ficheDateEl = document.getElementById('fiche-date');
if(ficheDateEl) ficheDateEl.value=TODAY;
const histDateEl = document.getElementById('h-date');
if(histDateEl) histDateEl.value=TODAY;

// =========================================================
// IMPRESSION BLUETOOTH ESC/POS — TRIOMPHANT MMB SERVICE
// Compatible : Xprinter, GOOJPRT, Peripage, MUNBYN, etc.
// Navigateur requis : Chrome Android (Web Bluetooth API)
// =========================================================

const _ESC = 0x1B, _GS = 0x1D;
const _escCmd = (...b) => new Uint8Array(b);

const BT_ESC_INIT        = _escCmd(_ESC, 0x40);
const BT_ALIGN_CTR       = _escCmd(_ESC, 0x61, 0x01);
const BT_ALIGN_LEFT      = _escCmd(_ESC, 0x61, 0x00);
const BT_BOLD_ON         = _escCmd(_ESC, 0x45, 0x01);
const BT_BOLD_OFF        = _escCmd(_ESC, 0x45, 0x00);
const BT_FONT_LARGE      = _escCmd(_ESC, 0x21, 0x30);
const BT_FONT_NORMAL     = _escCmd(_ESC, 0x21, 0x00);
const BT_FONT_SMALL      = _escCmd(_ESC, 0x21, 0x01);
const BT_CUT             = _escCmd(_GS,  0x56, 0x01);
const BT_LF              = _escCmd(0x0A);

function _btText(str){
  const map={'é':'e','è':'e','ê':'e','ë':'e','à':'a','â':'a','ù':'u','û':'u','ô':'o','î':'i','ï':'i','ç':'c','É':'E','È':'E','Ê':'E','À':'A','Ô':'O','Î':'I','Û':'U','Ç':'C','²':'2','€':'EUR'};
  const s=(str||'').replace(/[éèêëàâùûôîïçÉÈÊÀÔÎÛÇ²€]/g,m=>map[m]||m);
  // Convertir les \n en octet 0x0A (LF imprimante)
  const bytes=[];
  for(let i=0;i<s.length;i++){
    if(s[i]==='\n') bytes.push(0x0A);
    else bytes.push(s.charCodeAt(i)&0xFF);
  }
  return new Uint8Array(bytes);
}

function _btLine(left, right, cols){
  cols=cols||32;
  const l=String(left||'');
  const r=String(right||'');
  const maxRight = cols - l.length - 1;
  if(r.length > maxRight){
    // Valeur trop longue : label sur ligne 1, valeur alignée à droite sur ligne 2
    const sp2 = Math.max(0, cols - r.length);
    return _btText(l + '\n' + ' '.repeat(sp2) + r);
  }
  const sp=Math.max(1, cols-l.length-r.length);
  return _btText(l+' '.repeat(sp)+r);
}

function _btSep(cols){ return _btText('-'.repeat(cols||32)); }

function _buildEscPos(data, recuNum, emissionDate, emissionHeure, agenceLabel){
  const chunks=[];
  const add=(...a)=>a.forEach(x=>chunks.push(x));
  const COLS=32;

  add(BT_ESC_INIT);
  add(BT_FONT_SMALL);

  // En-tête
  add(BT_ALIGN_CTR, BT_BOLD_ON);
  add(_btText('TRIOMPHANT MMB SERVICE'), BT_LF);
  add(BT_BOLD_OFF);

  const typeLabel = data.type==='adhesion' ? 'ENCAISSEMENT ADHESION' : 'PAIEMENT COTISATION(S)';
  add(BT_BOLD_ON, _btText(typeLabel), BT_BOLD_OFF, BT_LF);
  add(_btSep(COLS), BT_LF);

  // Infos reçu
  add(BT_ALIGN_LEFT);
  add(_btLine('N Recu:', recuNum, COLS), BT_LF);
  add(_btLine('Date:', emissionDate, COLS), BT_LF);
  add(_btLine('Heure:', emissionHeure, COLS), BT_LF);
  add(_btSep(COLS), BT_LF);

  // Client
  if(data.clientCode) add(_btLine('Code:', data.clientCode, COLS), BT_LF);
  add(_btLine('Client:', (data.clientNom||''), COLS), BT_LF);
  add(_btSep(COLS), BT_LF);

  // Montant
  add(BT_ALIGN_CTR, BT_BOLD_ON);
  add(_btText(String(Number(data.montant||0)).replace(/\B(?=(\d{3})+(?!\d))/g,' ')+' FCFA'), BT_LF);
  add(BT_BOLD_OFF);
  if(data.type!=='adhesion'){
    add(_btText(`${data.nbCotis} cotis. x ${String(Number(data.cotisJour||0)).replace(/\B(?=(\d{3})+(?!\d))/g,' ')} FCFA`), BT_LF);
  }
  add(_btSep(COLS), BT_LF);

  // Saisi par
  add(BT_ALIGN_LEFT);
  add(_btLine('Saisi par:', (data.saisiParNom||''), COLS), BT_LF);
  if(agenceLabel && agenceLabel!=='—'){
    add(_btLine('Agence:', agenceLabel, COLS), BT_LF);
  }
  add(_btSep(COLS), BT_LF);

  // Pied de page
  add(BT_ALIGN_CTR, BT_BOLD_ON);
  add(_btText('Paiement enregistre'), BT_LF);
  add(BT_BOLD_OFF);
  add(_btText('Conservez ce recu'), BT_LF);
  add(_btText('preuve officielle'), BT_LF, BT_LF);

  // Coupe papier
  add(BT_CUT);

  // Fusionner
  let total=0; chunks.forEach(c=>total+=c.length);
  const result=new Uint8Array(total);
  let off=0; chunks.forEach(c=>{result.set(c,off);off+=c.length;});
  return result;
}

// ════════════════════════════════════════════════════
// SUIVI DE PÉRIODE — Gestionnaire de stock
// ════════════════════════════════════════════════════

let _gpCharts = {};

function _toISODate(d){ return d.toISOString().slice(0,10); }
function _fmtDate(s){ if(!s) return '—'; const d=new Date(s); return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'}); }

window.setGperiodeShortcut = function(type, el){
  document.querySelectorAll('.gperiode-shortcut').forEach(b=>b.classList.remove('active'));
  if(el) el.classList.add('active');
  const now = new Date();
  let debut, fin = _toISODate(now);
  if(type==='semaine'){
    const day=now.getDay(), diff=(day===0?-6:1-day);
    const d=new Date(now); d.setDate(now.getDate()+diff);
    debut=_toISODate(d);
  } else if(type==='mois'){
    debut=_toISODate(new Date(now.getFullYear(),now.getMonth(),1));
  } else if(type==='trimestre'){
    debut=_toISODate(new Date(now.getFullYear(),Math.floor(now.getMonth()/3)*3,1));
  } else if(type==='semestre'){
    debut=_toISODate(new Date(now.getFullYear(),now.getMonth()<6?0:6,1));
  } else {
    debut=_toISODate(new Date(now.getFullYear(),0,1));
  }
  document.getElementById('gp-date-debut').value=debut;
  document.getElementById('gp-date-fin').value=fin;
  renderGstockPeriode();
};

function initGstockPeriode(){
  // Pré-remplir avec le mois en cours si vide
  const d=document.getElementById('gp-date-debut');
  const f=document.getElementById('gp-date-fin');
  if(!d.value){
    const now=new Date();
    d.value=_toISODate(new Date(now.getFullYear(),now.getMonth(),1));
    f.value=_toISODate(now);
    // Activer le raccourci "Ce mois"
    const btns=document.querySelectorAll('.gperiode-shortcut');
    if(btns[1]) btns[1].classList.add('active');
  }
  if(d.value) renderGstockPeriode();
}

window.renderGstockPeriode = function(){
  const debut_str = document.getElementById('gp-date-debut')?.value;
  const fin_str   = document.getElementById('gp-date-fin')?.value;
  const body = document.getElementById('gp-body');

  if(!debut_str||!fin_str){
    body.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">📅 Sélectionnez une date de début et une date de fin.</div>';
    return;
  }
  if(debut_str > fin_str){
    body.innerHTML='<div style="text-align:center;padding:40px;color:var(--danger);font-size:13px;">⚠️ La date de début doit être antérieure à la date de fin.</div>';
    return;
  }

  const debut = new Date(debut_str+'T00:00:00');
  const fin   = new Date(fin_str+'T23:59:59');

  // Badge
  const badge = document.getElementById('gp-periode-badge');
  const txt   = document.getElementById('gp-periode-txt');
  if(badge){ badge.style.display=''; }
  if(txt) txt.textContent = `${_fmtDate(debut_str)} → ${_fmtDate(fin_str)}`;

  // Filtrer les données
  const inP = (x) => {
    const ds = x.date || x.createdAt;
    if(!ds) return false;
    const d = new Date(ds); return d>=debut && d<=fin;
  };

  const mvts      = (DB.stockMvts||[]).filter(inP);
  const entrees   = mvts.filter(m=>m.type==='entree');
  const sorties   = mvts.filter(m=>m.type==='sortie');
  const livraisons= (DB.livraisons||[]).filter(inP);

  // Mouvements par article
  const parArticle = {};
  mvts.forEach(m=>{
    const a = (DB.articles||[]).find(x=>x._id===m.articleId);
    const nom = a?a.nom:`Art. ${m.articleId?.slice(-4)||'?'}`;
    if(!parArticle[m.articleId]) parArticle[m.articleId]={nom, entrees:0, sorties:0, qteEntree:0, qteSortie:0};
    if(m.type==='entree'){ parArticle[m.articleId].entrees++; parArticle[m.articleId].qteEntree+=(Number(m.qty)||0); }
    else                 { parArticle[m.articleId].sorties++; parArticle[m.articleId].qteSortie+=(Number(m.qty)||0); }
  });
  const artList = Object.values(parArticle).sort((a,b)=>(b.qteEntree+b.qteSortie)-(a.qteEntree+a.qteSortie));

  // Évolution journalière des mouvements
  const jours = {};
  mvts.forEach(m=>{
    const ds=(m.date||m.createdAt||'').slice(0,10);
    if(!ds) return;
    if(!jours[ds]) jours[ds]={e:0,s:0};
    if(m.type==='entree') jours[ds].e+=(Number(m.qty)||0);
    else jours[ds].s+=(Number(m.qty)||0);
  });
  const joursLabels=Object.keys(jours).sort();

  // Destinations des sorties
  const destMap = {};
  sorties.forEach(m=>{
    const k = m.destinationNom||m.destinationLibre||'Non spécifié';
    destMap[k]=(destMap[k]||0)+(Number(m.qty)||0);
  });

  // Livraisons par statut
  const livStatuts = {};
  livraisons.forEach(l=>{ const s=l.statut||'inconnu'; livStatuts[s]=(livStatuts[s]||0)+1; });

  // Détruire anciens charts
  Object.values(_gpCharts).forEach(c=>{try{c.destroy();}catch(e){}});
  _gpCharts={};

  body.innerHTML = `
    <!-- KPI GLOBAUX -->
    <div class="gperiode-section">
      <div class="gperiode-section-title">📊 Vue d'ensemble</div>
      <div class="gperiode-kpi-grid">
        <div class="gperiode-kpi green">
          <div class="gk-lbl">Entrées de stock</div>
          <div class="gk-val">${entrees.length} <span style="font-size:12px;font-weight:400;">mvt(s)</span></div>
        </div>
        <div class="gperiode-kpi red">
          <div class="gk-lbl">Sorties de stock</div>
          <div class="gk-val">${sorties.length} <span style="font-size:12px;font-weight:400;">mvt(s)</span></div>
        </div>
        <div class="gperiode-kpi">
          <div class="gk-lbl">Qté totale entrée</div>
          <div class="gk-val">${entrees.reduce((s,m)=>s+(Number(m.qty)||0),0)}</div>
        </div>
        <div class="gperiode-kpi red">
          <div class="gk-lbl">Qté totale sortie</div>
          <div class="gk-val">${sorties.reduce((s,m)=>s+(Number(m.qty)||0),0)}</div>
        </div>
        <div class="gperiode-kpi muted">
          <div class="gk-lbl">Articles concernés</div>
          <div class="gk-val">${artList.length}</div>
        </div>
        <div class="gperiode-kpi muted">
          <div class="gk-lbl">Livraisons</div>
          <div class="gk-val">${livraisons.length}</div>
        </div>
      </div>
    </div>

    <!-- GRAPHIQUE ÉVOLUTION -->
    <div class="gperiode-section">
      <div class="gperiode-section-title">📈 Évolution journalière (quantités)</div>
      ${joursLabels.length===0?'<div style="color:var(--muted);font-size:12px;padding:8px;">Aucun mouvement sur cette période.</div>':
        '<div class="gperiode-chart-wrap"><canvas id="gp-chart-evolution"></canvas></div>'}
    </div>

    <!-- MOUVEMENTS PAR ARTICLE -->
    <div class="gperiode-section">
      <div class="gperiode-section-title">📦 Mouvements par article</div>
      ${artList.length===0
        ? '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucun mouvement sur cette période.</div>'
        : `<div class="tw"><table>
            <thead><tr><th>Article</th><th>Entrées (qté)</th><th>Sorties (qté)</th><th>Solde net</th></tr></thead>
            <tbody>${artList.map(a=>{
              const net = a.qteEntree - a.qteSortie;
              return `<tr>
                <td class="fw6">${esc(a.nom)}</td>
                <td style="color:var(--accent2);font-weight:700;">+${a.qteEntree} <span style="color:var(--muted);font-weight:400;font-size:10px;">(${a.entrees} mvt)</span></td>
                <td style="color:var(--danger);font-weight:700;">-${a.qteSortie} <span style="color:var(--muted);font-weight:400;font-size:10px;">(${a.sorties} mvt)</span></td>
                <td style="font-weight:700;color:${net>=0?'var(--accent2)':'var(--danger)'};">${net>=0?'+':''}${net}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`}
    </div>

    <!-- DESTINATIONS DES SORTIES -->
    <div class="gperiode-section">
      <div class="gperiode-section-title">📤 Destinations des sorties</div>
      ${Object.keys(destMap).length===0
        ? '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucune sortie enregistrée sur cette période.</div>'
        : `<div class="gperiode-chart-wrap"><canvas id="gp-chart-dest"></canvas></div>
           <div class="tw" style="margin-top:10px;"><table>
             <thead><tr><th>Destination</th><th>Quantité sortie</th></tr></thead>
             <tbody>${Object.entries(destMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${esc(k)}</td><td style="font-weight:700;color:var(--warn);">${v}</td></tr>`).join('')}</tbody>
           </table></div>`}
    </div>

    <!-- LISTE DÉTAILLÉE DES MOUVEMENTS -->
    <div class="gperiode-section">
      <div class="gperiode-section-title" style="margin-bottom:8px;">📋 Détail des mouvements</div>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        <input type="text" id="gp-search" placeholder="🔍 Filtrer article, note..."
          style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;color:var(--text);font-size:11px;outline:none;flex:1;min-width:150px;"
          oninput="filterGpMvts()">
        <select id="gp-type-filter"
          style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;color:var(--text);font-size:11px;outline:none;"
          onchange="filterGpMvts()">
          <option value="">Tous les types</option>
          <option value="entree">📥 Entrées seulement</option>
          <option value="sortie">📤 Sorties seulement</option>
        </select>
      </div>
      <div id="gp-mvts-table">
        ${_buildGpMvtsTable(mvts)}
      </div>
    </div>

    <!-- LIVRAISONS SUR LA PÉRIODE -->
    <div class="gperiode-section">
      <div class="gperiode-section-title">🚚 Livraisons sur la période</div>
      ${livraisons.length===0
        ? '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucune livraison sur cette période.</div>'
        : `<div class="gperiode-kpi-grid" style="margin-bottom:10px;">
            ${Object.entries(livStatuts).map(([s,n])=>`<div class="gperiode-kpi muted"><div class="gk-lbl">${s}</div><div class="gk-val">${n}</div></div>`).join('')}
           </div>
           <div class="tw"><table>
             <thead><tr><th>Date</th><th>Client</th><th>Statut</th><th>Note</th></tr></thead>
             <tbody>${livraisons.slice().reverse().map(l=>{
               const cl=(DB.clients||[]).find(c=>c._id===l.clientId);
               return `<tr><td>${l.date||'—'}</td><td class="fw6">${cl?esc(cl.nom):'—'}</td><td>${l.statut||'—'}</td><td class="tm">${esc(l.note||'—')}</td></tr>`;
             }).join('')}</tbody>
           </table></div>`}
    </div>
  `;

  // Stocker mvts pour le filtre
  window._gpAllMvts = mvts;

  // Dessiner graphiques
  requestAnimationFrame(()=>{
    const warn='rgba(212,137,58,0.85)', green='rgba(56,201,160,0.85)', danger='rgba(224,92,82,0.85)';
    const gridColor='rgba(255,255,255,0.06)', tickColor='rgba(255,255,255,0.35)';

    // Graphique évolution
    const c1=document.getElementById('gp-chart-evolution');
    if(c1 && joursLabels.length){
      _gpCharts.evol=new Chart(c1.getContext('2d'),{
        type:'bar',
        data:{
          labels:joursLabels,
          datasets:[
            {label:'Entrées',data:joursLabels.map(j=>jours[j].e),backgroundColor:green,borderRadius:4,stack:'s'},
            {label:'Sorties',data:joursLabels.map(j=>jours[j].s),backgroundColor:danger,borderRadius:4,stack:'s2'}
          ]
        },
        options:{
          responsive:true,maintainAspectRatio:true,
          plugins:{legend:{labels:{color:tickColor,font:{size:10}}}},
          scales:{
            x:{ticks:{color:tickColor,font:{size:9},maxRotation:45},grid:{color:gridColor}},
            y:{ticks:{color:tickColor,font:{size:9}},grid:{color:gridColor}}
          }
        }
      });
    }

    // Graphique destinations
    const c2=document.getElementById('gp-chart-dest');
    if(c2 && Object.keys(destMap).length){
      const dkeys=Object.keys(destMap);
      const colors=[warn,'rgba(201,168,76,0.8)',danger,'rgba(100,130,200,0.8)','rgba(150,100,200,0.8)'];
      _gpCharts.dest=new Chart(c2.getContext('2d'),{
        type:'doughnut',
        data:{labels:dkeys,datasets:[{data:dkeys.map(k=>destMap[k]),backgroundColor:dkeys.map((_,i)=>colors[i%colors.length]),borderWidth:0}]},
        options:{responsive:true,plugins:{legend:{labels:{color:tickColor,font:{size:10}}}}}
      });
    }
  });
};

function _buildGpMvtsTable(mvts){
  if(!mvts.length) return '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucun mouvement.</div>';
  return `<div class="tw"><table>
    <thead><tr><th>Date</th><th>Article</th><th>Type</th><th>Quantité</th><th>Stock après</th><th>Destination / Motif</th><th>Note</th></tr></thead>
    <tbody>${[...mvts].reverse().map(m=>{
      const a=(DB.articles||[]).find(x=>x._id===m.articleId)||{};
      const dest = m.type==='sortie'?(m.destinationNom||m.destinationLibre||'—'):'—';
      return `<tr>
        <td>${m.date||'—'}</td>
        <td class="fw6">${esc(a.nom||'?')}</td>
        <td>${m.type==='entree'?'<span style="background:rgba(56,201,160,0.15);color:var(--accent2);border-radius:5px;padding:2px 7px;font-size:10px;">📥 Entrée</span>':'<span style="background:rgba(224,92,82,0.15);color:var(--danger);border-radius:5px;padding:2px 7px;font-size:10px;">📤 Sortie</span>'}</td>
        <td style="font-weight:700;color:${m.type==='entree'?'var(--accent2)':'var(--danger)'};">${m.type==='entree'?'+':'-'}${m.qty} ${esc(a.unite||'')}</td>
        <td>${m.stockApres!=null?m.stockApres+' '+esc(a.unite||''):'—'}</td>
        <td style="font-size:11px;color:var(--subtle);">${esc(dest)}</td>
        <td class="tm" style="font-size:11px;">${esc(m.note||'—')}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

window.filterGpMvts = function(){
  const q=(document.getElementById('gp-search')?.value||'').toLowerCase().trim();
  const typ=document.getElementById('gp-type-filter')?.value||'';
  let mvts=window._gpAllMvts||[];
  if(typ) mvts=mvts.filter(m=>m.type===typ);
  if(q) mvts=mvts.filter(m=>{
    const a=(DB.articles||[]).find(x=>x._id===m.articleId)||{};
    return (a.nom||'').toLowerCase().includes(q)||(m.note||'').toLowerCase().includes(q)||(m.destinationNom||'').toLowerCase().includes(q)||(m.destinationLibre||'').toLowerCase().includes(q);
  });
  const wrap=document.getElementById('gp-mvts-table');
  if(wrap) wrap.innerHTML=_buildGpMvtsTable(mvts);
};

window.exportGstockCSV = function(){
  const debut_str=document.getElementById('gp-date-debut')?.value;
  const fin_str=document.getElementById('gp-date-fin')?.value;
  if(!debut_str||!fin_str){ notify('Sélectionnez une période d\'abord','err'); return; }
  const debut=new Date(debut_str+'T00:00:00'), fin=new Date(fin_str+'T23:59:59');
  const inP=(x)=>{ const ds=x.date||x.createdAt; if(!ds) return false; const d=new Date(ds); return d>=debut&&d<=fin; };
  const mvts=(DB.stockMvts||[]).filter(inP);
  const livraisons=(DB.livraisons||[]).filter(inP);

  let csv=`Suivi de période — ${_fmtDate(debut_str)} au ${_fmtDate(fin_str)}\n\n`;
  csv+=`MOUVEMENTS DE STOCK\nDate;Article;Type;Quantité;Stock après;Destination;Note\n`;
  mvts.forEach(m=>{
    const a=(DB.articles||[]).find(x=>x._id===m.articleId)||{};
    csv+=`${m.date||''};${esc(a.nom||'')};${m.type};${m.qty};${m.stockApres!=null?m.stockApres:''};${m.destinationNom||m.destinationLibre||''};${esc(m.note||'')}\n`;
  });
  csv+=`\nLIVRAISONS\nDate;Client;Statut;Note\n`;
  livraisons.forEach(l=>{
    const cl=(DB.clients||[]).find(c=>c._id===l.clientId);
    csv+=`${l.date||''};${cl?cl.nom:''};${l.statut||''};${esc(l.note||'')}\n`;
  });

  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`suivi_stock_${debut_str}_${fin_str}.csv`;
  a.click();
  notify('✅ Export CSV téléchargé','ok');
};

// ════════════════════════════════════════════════════
// RAPPORT D'ACTIVITÉ — Admin uniquement
// ════════════════════════════════════════════════════

let _rapportPeriod = 'semaine';
let _rapportCharts = {};

window.setRapportPeriod = function(p){
  _rapportPeriod = p;
  document.querySelectorAll('.rapport-tab').forEach(t=>{
    t.classList.toggle('active', t.textContent.toLowerCase().includes(
      p==='semaine'?'semaine':p==='mois'?'mois':p==='trimestre'?'trimestre':p==='semestre'?'semestre':'ann'
    ));
  });
  renderRapportActivite();
};

function _getPeriodeBornes(p){
  const now = new Date();
  let debut, fin = new Date(now);
  fin.setHours(23,59,59,999);
  if(p==='semaine'){
    const day = now.getDay();
    const diff = (day===0?-6:1-day);
    debut = new Date(now); debut.setDate(now.getDate()+diff); debut.setHours(0,0,0,0);
  } else if(p==='mois'){
    debut = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if(p==='trimestre'){
    const qStart = Math.floor(now.getMonth()/3)*3;
    debut = new Date(now.getFullYear(), qStart, 1);
  } else if(p==='semestre'){
    const sStart = now.getMonth()<6 ? 0 : 6;
    debut = new Date(now.getFullYear(), sStart, 1);
  } else { // annee
    debut = new Date(now.getFullYear(), 0, 1);
  }
  return {debut, fin};
}

function _periodeLabel(p){
  const now = new Date();
  const mois = ['Janv','Févr','Mars','Avr','Mai','Juin','Juil','Août','Sept','Oct','Nov','Déc'];
  if(p==='semaine'){
    const {debut,fin}=_getPeriodeBornes(p);
    return `Sem. du ${debut.getDate()} ${mois[debut.getMonth()]} au ${fin.getDate()} ${mois[fin.getMonth()]} ${fin.getFullYear()}`;
  }
  if(p==='mois') return `${mois[now.getMonth()]} ${now.getFullYear()}`;
  if(p==='trimestre'){const q=Math.floor(now.getMonth()/3)+1;return `T${q} ${now.getFullYear()}`;}
  if(p==='semestre'){return (now.getMonth()<6?'1er':'2e')+` semestre ${now.getFullYear()}`;}
  return `Année ${now.getFullYear()}`;
}

function _inPeriod(dateStr, debut, fin){
  if(!dateStr) return false;
  const d = new Date(dateStr);
  return d>=debut && d<=fin;
}

function _fmtMoney(v){ return Number(v||0).toLocaleString('fr-FR')+ ' FCFA'; }
function _fmtNum(v){ return Number(v||0).toLocaleString('fr-FR'); }

function _destroyRapportCharts(){
  Object.values(_rapportCharts).forEach(c=>{ try{c.destroy();}catch(e){} });
  _rapportCharts = {};
}

function renderRapportActivite(){
  if(session?.role !== 'admin'){ return; }
  const p = _rapportPeriod;
  const {debut, fin} = _getPeriodeBornes(p);

  // Mettre à jour le badge période
  document.getElementById('rapport-periode-txt').textContent = _periodeLabel(p);

  const body = document.getElementById('rapport-body');
  body.innerHTML = '<div class="rapport-loading">⏳ Calcul du rapport…</div>';

  // Détruire les anciens charts
  _destroyRapportCharts();

  // Filtrer les données
  const paiements = (DB.paiements||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  const adhesions = (DB.adhesionPays||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  // ✅ FIX : rachats de carnet absents des KPI/classements de ce rapport
  // (même bug que le Registre et la page Commerciaux, corrigé de la même façon).
  const rachats = (DB.rachatCarnetPays||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  const livraisons = (DB.livraisons||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  const mises = (DB.mises||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  const stockMvts = (DB.stockMvts||[]).filter(x=>_inPeriod(x.date||x.createdAt, debut, fin));
  const clients = (DB.clients||[]).filter(x=>_inPeriod(x.dateAdhesion||x.createdAt, debut, fin));
  const agences = DB.agences||[];
  const coms = (DB.commerciaux||[]).filter(c=>c.role!=='admin');
  const primes = DB.primesPaliers||[];

  // ── KPI financiers ──
  const totalPaiements = paiements.reduce((s,x)=>s+(Number(x.montant)||0),0);
  const totalCotisations = adhesions.reduce((s,x)=>s+(Number(x.montant)||0),0);
  const totalRachats = rachats.reduce((s,x)=>s+(Number(x.montant)||0),0);

  // CA par agence
  const caParAgence = {};
  agences.forEach(a=>{ caParAgence[a._id]={nom:a.nom, total:0}; });
  paiements.forEach(p=>{
    const cl = (DB.clients||[]).find(c=>c._id===p.clientId);
    if(cl){ const ag=cl.agenceId||'inconnue'; if(!caParAgence[ag]) caParAgence[ag]={nom:ag,total:0}; caParAgence[ag].total+=(Number(p.montant)||0); }
  });
  rachats.forEach(r=>{
    const cl = (DB.clients||[]).find(c=>c._id===r.clientId);
    if(cl){ const ag=cl.agenceId||'inconnue'; if(!caParAgence[ag]) caParAgence[ag]={nom:ag,total:0}; caParAgence[ag].total+=(Number(r.montant)||0); }
  });

  // Primes atteintes — chercher commerciaux ayant atteint un palier sur la période
  const primesAtteintes = [];
  coms.forEach(com=>{
    const totalCom = paiements.filter(p=>{
      const cl=(DB.clients||[]).find(c=>c._id===p.clientId);
      return cl && cl.commercialId===com._id;
    }).reduce((s,x)=>s+(Number(x.montant)||0),0)
      + rachats.filter(r=>r.commercialId===com._id).reduce((s,x)=>s+(Number(x.montant)||0),0);
    const palier = [...primes].sort((a,b)=>b.seuil-a.seuil).find(pr=>totalCom>=(Number(pr.seuil)||0));
    if(palier) primesAtteintes.push({com:com.nom, palier:palier.nom||`Palier ${palier.seuil}`, montant:palier.prime||0, ca:totalCom});
  });

  // Performance par commercial
  const perfCom = coms.map(com=>{
    const paysCom = paiements.filter(p=>{ const cl=(DB.clients||[]).find(c=>c._id===p.clientId); return cl&&cl.commercialId===com._id; });
    const rachatsCom = rachats.filter(r=>r.commercialId===com._id);
    const clientsCom = clients.filter(c=>c.commercialId===com._id);
    return { nom:com.nom, ca:paysCom.reduce((s,x)=>s+(Number(x.montant)||0),0)+rachatsCom.reduce((s,x)=>s+(Number(x.montant)||0),0), nbClients:clientsCom.length, nbPay:paysCom.length };
  }).sort((a,b)=>b.ca-a.ca);

  const maxCa = perfCom.length ? perfCom[0].ca : 1;

  // ── Données pour graphiques par période (jours/semaines/mois selon la période) ──
  function _buildTimeSeries(liste, champDate, champVal){
    const buckets = {};
    const fmt = (d) => {
      if(p==='semaine'||p==='mois') return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'});
      if(p==='trimestre') return `Sem.${_weekNum(d)}`;
      if(p==='semestre'||p==='annee') return d.toLocaleDateString('fr-FR',{month:'short',year:'2-digit'});
      return d.toISOString().slice(0,7);
    };
    liste.forEach(x=>{
      const d=new Date(x[champDate]||x.createdAt||x.date);
      if(!d||isNaN(d)) return;
      const k=fmt(d);
      if(!buckets[k]) buckets[k]=0;
      buckets[k]+=(Number(x[champVal])||0);
    });
    return buckets;
  }
  function _weekNum(d){ const s=new Date(d.getFullYear(),0,1); return Math.ceil(((d-s)/86400000+s.getDay()+1)/7); }

  const tsPaiements = _buildTimeSeries(paiements,'date','montant');
  const tsAdhesions = _buildTimeSeries(adhesions,'date','montant');
  const labels = [...new Set([...Object.keys(tsPaiements),...Object.keys(tsAdhesions)])].sort();

  // Livraisons par statut
  const livrStatuts = {};
  livraisons.forEach(l=>{ const s=l.statut||'inconnu'; livrStatuts[s]=(livrStatuts[s]||0)+1; });

  // Mouvements stock par type
  const stockEntrees = stockMvts.filter(m=>m.type==='entree').length;
  const stockSorties = stockMvts.filter(m=>m.type==='sortie').length;

  // ── Construire le HTML ──
  body.innerHTML = `
    <!-- ░░ KPI FINANCIERS ░░ -->
    <div class="rapport-section-title">💰 Données financières</div>
    <div class="rapport-kpi-grid">
      <div class="rapport-kpi accent">
        <div class="rk-label">Total encaissements</div>
        <div class="rk-val">${_fmtMoney(totalPaiements)}</div>
        <div class="rk-sub">${paiements.length} paiement(s)</div>
      </div>
      <div class="rapport-kpi green">
        <div class="rk-label">Cotisations collectées</div>
        <div class="rk-val">${_fmtMoney(totalCotisations)}</div>
        <div class="rk-sub">${adhesions.length} adhésion(s)</div>
      </div>
      <div class="rapport-kpi" style="border-color:rgba(100,160,247,0.35);">
        <div class="rk-label">Rachats de carnet</div>
        <div class="rk-val">${_fmtMoney(totalRachats)}</div>
        <div class="rk-sub">${rachats.length} rachat(s)</div>
      </div>
      <div class="rapport-kpi">
        <div class="rk-label">Nouveaux clients</div>
        <div class="rk-val">${clients.length}</div>
        <div class="rk-sub">sur la période</div>
      </div>
      <div class="rapport-kpi warn">
        <div class="rk-label">Livraisons</div>
        <div class="rk-val">${livraisons.length}</div>
        <div class="rk-sub">${livrStatuts['livre']||0} livrée(s)</div>
      </div>
    </div>

    <!-- ░░ GRAPHIQUE ENCAISSEMENTS ░░ -->
    <div class="rapport-chart-wrap">
      <div class="rapport-chart-label">Évolution des encaissements vs cotisations</div>
      <canvas id="chart-rapport-encaiss"></canvas>
    </div>

    <!-- ░░ CA PAR AGENCE ░░ -->
    <div class="rapport-section-title">🏢 Chiffre d'affaires par agence</div>
    <div class="rapport-kpi-grid">
      ${Object.values(caParAgence).sort((a,b)=>b.total-a.total).map(ag=>`
        <div class="rapport-kpi">
          <div class="rk-label">${esc(ag.nom||'—')}</div>
          <div class="rk-val" style="font-size:14px;">${_fmtMoney(ag.total)}</div>
        </div>
      `).join('')||'<div style="color:var(--muted);font-size:12px;padding:8px;">Aucune donnée agence</div>'}
    </div>
    <div class="rapport-chart-wrap">
      <div class="rapport-chart-label">CA par agence (FCFA)</div>
      <canvas id="chart-rapport-agences" style="max-height:180px;"></canvas>
    </div>

    <!-- ░░ PERFORMANCE COMMERCIAUX ░░ -->
    <div class="rapport-section-title">👤 Performance par commercial</div>
    ${perfCom.length===0?'<div style="color:var(--muted);font-size:12px;padding:8px;">Aucun commercial trouvé</div>':
      perfCom.map((c,i)=>`
        <div class="com-rank-row">
          <div class="com-rank-pos">${i+1}</div>
          <div class="com-rank-name">${esc(c.nom)}</div>
          <div class="com-rank-bar-wrap"><div class="com-rank-bar" style="width:${maxCa>0?Math.round(c.ca/maxCa*100):0}%"></div></div>
          <div class="com-rank-val">${_fmtMoney(c.ca)}</div>
          <div style="font-size:10px;color:var(--muted);margin-left:6px;">${c.nbClients} client(s)</div>
        </div>
      `).join('')}
    <div class="rapport-chart-wrap" style="margin-top:12px;">
      <div class="rapport-chart-label">Encaissements par commercial</div>
      <canvas id="chart-rapport-coms" style="max-height:200px;"></canvas>
    </div>

    <!-- ░░ PRIMES ET PALIERS ░░ -->
    <div class="rapport-section-title">🏆 Primes et paliers atteints</div>
    ${primesAtteintes.length===0
      ? '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucun palier atteint sur cette période.</div>'
      : `<div class="tw"><table><thead><tr><th>Commercial</th><th>Palier atteint</th><th>CA généré</th><th>Prime</th></tr></thead><tbody>
          ${primesAtteintes.map(p=>`<tr><td>${p.com}</td><td>${p.palier}</td><td>${_fmtMoney(p.ca)}</td><td style="color:var(--accent);font-weight:700;">${_fmtMoney(p.montant)}</td></tr>`).join('')}
        </tbody></table></div>`}

    <!-- ░░ LIVRAISONS ░░ -->
    <div class="rapport-section-title">🚚 Livraisons effectuées</div>
    <div class="rapport-kpi-grid">
      ${Object.entries(livrStatuts).map(([s,n])=>`<div class="rapport-kpi"><div class="rk-label">${s}</div><div class="rk-val">${n}</div></div>`).join('') || '<div style="color:var(--muted);font-size:12px;padding:8px;">Aucune livraison sur cette période.</div>'}
    </div>
    <div class="rapport-chart-wrap">
      <div class="rapport-chart-label">Livraisons par statut</div>
      <canvas id="chart-rapport-livr" style="max-height:180px;"></canvas>
    </div>

    <!-- ░░ STOCK ░░ -->
    <div class="rapport-section-title">📦 Mouvements de stock</div>
    <div class="rapport-kpi-grid">
      <div class="rapport-kpi green">
        <div class="rk-label">Entrées de stock</div>
        <div class="rk-val">${stockEntrees}</div>
        <div class="rk-sub">mouvements</div>
      </div>
      <div class="rapport-kpi warn">
        <div class="rk-label">Sorties de stock</div>
        <div class="rk-val">${stockSorties}</div>
        <div class="rk-sub">mouvements</div>
      </div>
      <div class="rapport-kpi">
        <div class="rk-label">Total mouvements</div>
        <div class="rk-val">${stockMvts.length}</div>
        <div class="rk-sub">sur la période</div>
      </div>
    </div>
    <div class="rapport-chart-wrap">
      <div class="rapport-chart-label">Entrées vs Sorties de stock</div>
      <canvas id="chart-rapport-stock" style="max-height:160px;"></canvas>
    </div>
  `;

  // ── Dessiner les graphiques ──
  requestAnimationFrame(()=>{
    const gold='rgba(201,168,76,0.85)', goldFill='rgba(201,168,76,0.15)';
    const green='rgba(56,201,160,0.85)', greenFill='rgba(56,201,160,0.15)';
    const warn='rgba(212,137,58,0.85)', warnFill='rgba(212,137,58,0.15)';
    const gridColor='rgba(255,255,255,0.06)', tickColor='rgba(255,255,255,0.35)';

    const baseOpts = (yLabel)=>({
      responsive:true, maintainAspectRatio:true,
      plugins:{legend:{labels:{color:tickColor,font:{size:10}}},tooltip:{callbacks:{label:c=>' '+Number(c.parsed.y).toLocaleString('fr-FR')+' FCFA'}}},
      scales:{
        x:{ticks:{color:tickColor,font:{size:9}},grid:{color:gridColor}},
        y:{ticks:{color:tickColor,font:{size:9},callback:v=>Number(v).toLocaleString('fr-FR')},grid:{color:gridColor},title:{display:!!yLabel,text:yLabel,color:tickColor,font:{size:9}}}
      }
    });

    // 1. Encaissements vs cotisations
    const c1=document.getElementById('chart-rapport-encaiss');
    if(c1){
      _rapportCharts.encaiss=new Chart(c1.getContext('2d'),{
        type:'line',
        data:{
          labels,
          datasets:[
            {label:'Encaissements',data:labels.map(l=>tsPaiements[l]||0),borderColor:gold,backgroundColor:goldFill,tension:0.4,fill:true,pointRadius:3},
            {label:'Cotisations',data:labels.map(l=>tsAdhesions[l]||0),borderColor:green,backgroundColor:greenFill,tension:0.4,fill:true,pointRadius:3}
          ]
        },
        options:baseOpts()
      });
    }

    // 2. CA par agence — barre horizontale
    const c2=document.getElementById('chart-rapport-agences');
    if(c2){
      const agData=Object.values(caParAgence).sort((a,b)=>b.total-a.total);
      _rapportCharts.agences=new Chart(c2.getContext('2d'),{
        type:'bar',
        data:{
          labels:agData.map(a=>a.nom),
          datasets:[{label:'CA (FCFA)',data:agData.map(a=>a.total),backgroundColor:gold,borderRadius:6}]
        },
        options:{...baseOpts(),...{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+Number(c.parsed.x).toLocaleString('fr-FR')+' FCFA'}}}}}
      });
    }

    // 3. Performance commerciaux
    const c3=document.getElementById('chart-rapport-coms');
    if(c3){
      _rapportCharts.coms=new Chart(c3.getContext('2d'),{
        type:'bar',
        data:{
          labels:perfCom.map(c=>c.nom),
          datasets:[{label:'Encaissements',data:perfCom.map(c=>c.ca),backgroundColor:green,borderRadius:6}]
        },
        options:{...baseOpts(),...{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+Number(c.parsed.y).toLocaleString('fr-FR')+' FCFA'}}}}}
      });
    }

    // 4. Livraisons par statut — doughnut
    const c4=document.getElementById('chart-rapport-livr');
    if(c4){
      const livrKeys=Object.keys(livrStatuts);
      _rapportCharts.livr=new Chart(c4.getContext('2d'),{
        type:'doughnut',
        data:{
          labels:livrKeys,
          datasets:[{data:livrKeys.map(k=>livrStatuts[k]),backgroundColor:[gold,green,warn,'rgba(224,92,82,0.8)'],borderWidth:0}]
        },
        options:{responsive:true,plugins:{legend:{labels:{color:tickColor,font:{size:10}}}}}
      });
    }

    // 5. Stock entrées/sorties
    const c5=document.getElementById('chart-rapport-stock');
    if(c5){
      _rapportCharts.stock=new Chart(c5.getContext('2d'),{
        type:'bar',
        data:{
          labels:['Entrées','Sorties'],
          datasets:[{data:[stockEntrees,stockSorties],backgroundColor:[green,warn],borderRadius:8}]
        },
        options:{...baseOpts(),...{plugins:{legend:{display:false}},scales:{x:{ticks:{color:tickColor,font:{size:11}},grid:{color:gridColor}},y:{ticks:{color:tickColor,font:{size:9}},grid:{color:gridColor}}}}}
      });
    }
  });
}

window.exportRapportCSV = function(){
  if(session?.role!=='admin'){ notify("Accès réservé à l'administrateur",'err'); return; }
  const p=_rapportPeriod;
  const {debut,fin}=_getPeriodeBornes(p);
  const paiements=(DB.paiements||[]).filter(x=>_inPeriod(x.date||x.createdAt,debut,fin));
  const adhesions=(DB.adhesionPays||[]).filter(x=>_inPeriod(x.date||x.createdAt,debut,fin));
  const livraisons=(DB.livraisons||[]).filter(x=>_inPeriod(x.date||x.createdAt,debut,fin));
  const stockMvts=(DB.stockMvts||[]).filter(x=>_inPeriod(x.date||x.createdAt,debut,fin));
  const clients=(DB.clients||[]).filter(x=>_inPeriod(x.dateAdhesion||x.createdAt,debut,fin));

  let csv=`Rapport d'activité — ${_periodeLabel(p)}\n\n`;
  csv+=`FINANCIER\nTotal encaissements;${paiements.reduce((s,x)=>s+(Number(x.montant)||0),0)} FCFA\nCotisations collectées;${adhesions.reduce((s,x)=>s+(Number(x.montant)||0),0)} FCFA\nNouveaux clients;${clients.length}\n\n`;
  csv+=`PAIEMENTS\nDate;Client;Montant;Note\n`;
  paiements.forEach(x=>{ const cl=(DB.clients||[]).find(c=>c._id===x.clientId); csv+=`${x.date||''};${cl?cl.nom:'—'};${x.montant||0};${esc(x.note||'')}\n`; });
  csv+=`\nLIVRAISONS\nDate;Client;Statut\n`;
  livraisons.forEach(x=>{ const cl=(DB.clients||[]).find(c=>c._id===x.clientId); csv+=`${x.date||''};${cl?cl.nom:'—'};${x.statut||''}\n`; });
  csv+=`\nSTOCK\nDate;Article;Type;Quantité\n`;
  stockMvts.forEach(x=>{ csv+=`${x.date||''};${x.articleNom||x.articleId||''};${x.type||''};${x.qte||0}\n`; });

  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`rapport_${p}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  notify('✅ Export CSV téléchargé','ok');
};

// ── État connexion Bluetooth ──
let _btDevice=null, _btChar=null;

async function _btConnect(){
  if(!navigator.bluetooth){
    notify('❌ Web Bluetooth non supporté. Utilisez Chrome sur Android.','err');
    return false;
  }
  try{
    notify('🔵 Recherche imprimante Bluetooth...','info');
    _btDevice = await navigator.bluetooth.requestDevice({
      filters:[
        {services:['000018f0-0000-1000-8000-00805f9b34fb']},
      ],
      optionalServices:[
        '000018f0-0000-1000-8000-00805f9b34fb',
        '0000ff00-0000-1000-8000-00805f9b34fb',
        '0000ffe0-0000-1000-8000-00805f9b34fb',
        '00001101-0000-1000-8000-00805f9b34fb',
        '0000fff0-0000-1000-8000-00805f9b34fb',
      ]
    });
    const server = await _btDevice.gatt.connect();

    // Tentative sur plusieurs UUID de service connus
    const svcs=[
      '000018f0-0000-1000-8000-00805f9b34fb',
      '0000ff00-0000-1000-8000-00805f9b34fb',
      '0000ffe0-0000-1000-8000-00805f9b34fb',
      '0000fff0-0000-1000-8000-00805f9b34fb',
    ];
    let svc=null;
    for(const u of svcs){ try{svc=await server.getPrimaryService(u);break;}catch(e){} }
    if(!svc){
      // Dernier recours : toutes les services disponibles
      const allSvcs = await server.getPrimaryServices();
      svc = allSvcs[0] || null;
    }
    if(!svc){ notify('❌ Service imprimante introuvable','err'); return false; }

    // Tentative sur plusieurs UUID de caractéristique
    const chars=[
      '00002af1-0000-1000-8000-00805f9b34fb',
      '0000ff02-0000-1000-8000-00805f9b34fb',
      '0000ffe1-0000-1000-8000-00805f9b34fb',
      '0000fff2-0000-1000-8000-00805f9b34fb',
    ];
    _btChar=null;
    for(const u of chars){ try{_btChar=await svc.getCharacteristic(u);break;}catch(e){} }
    if(!_btChar){
      // Fallback : première caractéristique avec écriture
      const allChars=await svc.getCharacteristics();
      _btChar=allChars.find(c=>c.properties.writeWithoutResponse||c.properties.write)||null;
    }
    if(!_btChar){ notify('❌ Caractéristique écriture introuvable','err'); return false; }

    // Détecter déconnexion
    _btDevice.addEventListener('gattserverdisconnected',()=>{
      _btChar=null;
      notify('🔌 Imprimante Bluetooth déconnectée','err');
      // Mettre à jour statuts
      const statusEl=document.getElementById('bn-bt-status');
      if(statusEl){statusEl.textContent='🔴 Non connectée';statusEl.style.color='var(--muted)';}
    });

    notify('✅ Imprimante connectée : '+(_btDevice.name||'Imprimante BT'),'ok');
    // Mettre à jour le bouton de statut sidebar desktop
    const statusEl=document.getElementById('bt-printer-status');
    if(statusEl){ statusEl.textContent='🟢 '+(_btDevice.name||'Connectée'); statusEl.style.color='var(--accent2)'; }
    // Mettre à jour le statut dans le drawer mobile
    const bnStatusEl=document.getElementById('bn-bt-status');
    if(bnStatusEl){ bnStatusEl.textContent='🟢 '+(_btDevice.name||'Connectée'); bnStatusEl.style.color='var(--accent2)'; }
    return true;
  }catch(e){
    if(e.name!=='NotFoundError') notify('❌ Connexion Bluetooth échouée : '+e.message,'err');
    return false;
  }
}

async function _btSend(data){
  const CHUNK=128;
  // Séparer le contenu texte de la commande de coupe (3 derniers octets : 0x1D 0x56 0x01)
  const body = data.slice(0, data.length-3);
  const cut  = data.slice(data.length-3);
  // Envoyer le contenu par petits blocs avec délai suffisant
  for(let i=0;i<body.length;i+=CHUNK){
    const chunk=body.slice(i,i+CHUNK);
    try{
      if(_btChar.properties.writeWithoutResponse){
        await _btChar.writeValueWithoutResponse(chunk);
      }else{
        await _btChar.writeValue(chunk);
      }
      await new Promise(r=>setTimeout(r,80));
    }catch(e){
      throw new Error('Envoi échoué : '+e.message);
    }
  }
  // Pause finale : laisser l'imprimante terminer avant la coupe
  await new Promise(r=>setTimeout(r,250));
  try{
    if(_btChar.properties.writeWithoutResponse){
      await _btChar.writeValueWithoutResponse(cut);
    }else{
      await _btChar.writeValue(cut);
    }
  }catch(e){
    throw new Error('Coupe échouée : '+e.message);
  }
}

// Fonction publique appelée depuis la popup
window.imprimerBluetooth = async function(data, recuNum, emissionDate, emissionHeure, agenceLabel, onDone){
  try{
    if(!_btChar || !_btDevice?.gatt?.connected){
      const ok=await _btConnect();
      if(!ok) return;
    }
    notify('🖨️ Impression en cours...','info');
    const ticket=_buildEscPos(data, recuNum, emissionDate, emissionHeure, agenceLabel);
    await _btSend(ticket);
    notify('✅ Ticket imprimé avec succès !','ok');
    if(typeof onDone==='function') onDone();
  }catch(e){
    notify('❌ Erreur impression Bluetooth : '+e.message,'err');
    _btChar=null;
  }
};

// Connexion manuelle depuis les paramètres
window.connecterImprimanteBT = async function(){
  _btChar=null; _btDevice=null;
  const result = await _btConnect();
  // Mettre à jour le statut dans le drawer mobile si présent
  const statusEl = document.getElementById('bn-bt-status');
  if(statusEl){
    const connected = _btDevice && _btDevice.gatt && _btDevice.gatt.connected;
    statusEl.textContent = connected ? ('🟢 '+(_btDevice.name||'Connectée')) : '🔴 Non connectée';
    statusEl.style.color = connected ? 'var(--accent2)' : 'var(--muted)';
  }
  return result;
};

// Check saved config (déchiffrement AES-GCM)
(async () => {
  try {
    const cfg = await _loadCfgDecrypted();
    if (cfg) {
      ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'].forEach(k=>{
        const el=document.getElementById('cfg-'+k); if(el&&cfg[k]) el.value=cfg[k];
      });
      await initFB(cfg);
    } else {
      // Aucune config sauvegardée : utiliser FIREBASE_CONFIG hardcode si les cles sont renseignees
      const hc = window.FIREBASE_CONFIG || {};
      const isConfigured = hc.apiKey && hc.apiKey.indexOf('%%') === -1;
      if (isConfigured) {
        ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'].forEach(k=>{
          const el=document.getElementById('cfg-'+k); if(el&&hc[k]) el.value=hc[k];
        });
        await _saveCfgEncrypted(hc);
        await initFB(hc);
      }
    }
  } catch(e) { /* afficher l'ecran de configuration */ }
})();

// ═══════════════════════════════════════════════════════════
//  TRANSFERT DE SOLDE & RÉSILIATION DE CONTRAT
//  Accès : admin + secrétaire + chef d'agence
//  Logique :
//   1. Chercher client SOURCE → afficher solde total versé
//   2. Chercher client DESTINATION → afficher montant contrat
//   3. Saisir montant manuel → avertissement si dépassement
//   4. Confirmer → fbAdd paiement sur destination + fbUpdate client source statut='resilie' + trace dans 'transferts'
// ═══════════════════════════════════════════════════════════

let _trSrcId = null;   // id client source sélectionné
let _trDstId = null;   // id client destination sélectionné

// ── Accès guard ──────────────────────────────────────────────
function _trCheckAccess(){
  if(!session){ notify('Non connecté','err'); return false; }
  if(!['admin','secretaire','chef_agence'].includes(session.role)){
    notify('Accès refusé — réservé admin, secrétaire & chef d\'agence','err');
    go(getRoleHome(session.role));
    return false;
  }
  return true;
}

// ── Render page (historique) ──────────────────────────────────
function renderTransfertResiliation(){
  if(!_trCheckAccess()) return;
  const transferts = (DB.transferts || []).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tbody = document.getElementById('tr-historique-body');
  if(!tbody) return;
  if(!transferts.length){
    tbody.innerHTML='<tr><td colspan="7" class="emp">Aucun transfert enregistré</td></tr>';
    return;
  }
  tbody.innerHTML = transferts.map(t=>{
    const src = DB.clients.find(c=>c._id===t.srcClientId);
    const dst = DB.clients.find(c=>c._id===t.dstClientId);
    return `<tr>
      <td>${t.date||'—'}</td>
      <td class="tm">${t.heure||'—'}</td>
      <td><strong>${esc(src?src.nom:'—')}</strong><br><span class="resilie-badge" style="font-size:9px;">RÉSILIÉ</span></td>
      <td><strong>${esc(dst?dst.nom:'—')}</strong></td>
      <td style="color:var(--accent2);font-weight:700;">${fmt(t.montant||0)}</td>
      <td class="tm" style="font-size:11px;">${esc(t.motif||'—')}</td>
      <td class="tm" style="font-size:11px;">${esc(t.operateur||'—')}</td>
    </tr>`;
  }).join('');
}

// ── Live search SOURCE ────────────────────────────────────────
window.trSrcLiveSearch = function(){
  const q = (document.getElementById('tr-src-search').value||'').toLowerCase().trim();
  const box = document.getElementById('tr-src-results');
  if(q.length < 2){ box.style.display='none'; return; }
  const results = (DB.clients||[]).filter(c=>{
    if(c.statutContrat==='resilie') return false;
    return (c.nom||'').toLowerCase().includes(q)
        || (c.codeClient||'').toLowerCase().includes(q)
        || (c.tel||'').includes(q);
  }).slice(0,8);
  if(!results.length){ box.innerHTML='<div style="padding:8px;font-size:12px;color:var(--muted);">Aucun client trouvé</div>'; box.style.display='block'; return; }
  box.innerHTML = results.map(c=>{
    const totalPaye = (DB.paiements||[]).filter(p=>p.clientId===c._id).reduce((a,p)=>a+p.montant,0);
    return `<div onclick="trSelectSrc('${c._id}')" style="padding:8px 10px;cursor:pointer;border-radius:7px;border:1px solid var(--border);margin-bottom:4px;background:var(--surface2);">
      <strong style="font-size:12px;">${esc(c.nom)}</strong>
      <span class="tag" style="margin-left:6px;">${esc(c.codeClient||'—')}</span>
      <span style="font-size:11px;color:var(--accent2);margin-left:6px;">${fmt(totalPaye)} versés</span>
    </div>`;
  }).join('');
  box.style.display='block';
};

window.trSelectSrc = function(id){
  _trSrcId = id;
  const c = DB.clients.find(cl=>cl._id===id);
  if(!c){ return; }
  document.getElementById('tr-src-results').style.display='none';
  document.getElementById('tr-src-search').value = c.nom + (c.codeClient?' ('+c.codeClient+')':'');
  const totalPaye = (DB.paiements||[]).filter(p=>p.clientId===id).reduce((a,p)=>a+p.montant,0);
  const info = document.getElementById('tr-src-info');
  info.style.display='block';
  info.innerHTML=`<div class="ib ib-red">
    <strong>📋 ${esc(c.nom)}</strong> — ${esc(c.contrat||'—')}<br>
    💰 Total versé : <strong style="color:var(--accent2);">${fmt(totalPaye)}</strong>
    &nbsp;/&nbsp; Contrat : <strong>${fmt(c.montantTotal||0)}</strong><br>
    <span style="font-size:10px;color:var(--muted);">Tel: ${esc(c.tel||'—')} · Commercial : ${esc((DB.commerciaux||[]).find(x=>x._id===c.commercialId)?.nom||'—')}</span>
  </div>`;
  _trCheckBothSelected();
};

// ── Live search DESTINATION ───────────────────────────────────
window.trDstLiveSearch = function(){
  const q = (document.getElementById('tr-dst-search').value||'').toLowerCase().trim();
  const box = document.getElementById('tr-dst-results');
  if(q.length < 2){ box.style.display='none'; return; }
  const results = (DB.clients||[]).filter(c=>{
    if(c._id===_trSrcId) return false; // exclure le source
    return (c.nom||'').toLowerCase().includes(q)
        || (c.codeClient||'').toLowerCase().includes(q)
        || (c.tel||'').includes(q);
  }).slice(0,8);
  if(!results.length){ box.innerHTML='<div style="padding:8px;font-size:12px;color:var(--muted);">Aucun client trouvé</div>'; box.style.display='block'; return; }
  box.innerHTML = results.map(c=>{
    const totalPaye = (DB.paiements||[]).filter(p=>p.clientId===c._id).reduce((a,p)=>a+p.montant,0);
    const restant = Math.max(0,(c.montantTotal||0)-totalPaye);
    return `<div onclick="trSelectDst('${c._id}')" style="padding:8px 10px;cursor:pointer;border-radius:7px;border:1px solid var(--border);margin-bottom:4px;background:var(--surface2);">
      <strong style="font-size:12px;">${esc(c.nom)}</strong>
      <span class="tag" style="margin-left:6px;">${esc(c.codeClient||'—')}</span>
      <span style="font-size:11px;color:var(--accent);margin-left:6px;">${fmt(restant)} restant</span>
    </div>`;
  }).join('');
  box.style.display='block';
};

window.trSelectDst = function(id){
  _trDstId = id;
  const c = DB.clients.find(cl=>cl._id===id);
  if(!c){ return; }
  document.getElementById('tr-dst-results').style.display='none';
  document.getElementById('tr-dst-search').value = c.nom + (c.codeClient?' ('+c.codeClient+')':'');
  const totalPaye = (DB.paiements||[]).filter(p=>p.clientId===id).reduce((a,p)=>a+p.montant,0);
  const restant = Math.max(0,(c.montantTotal||0)-totalPaye);
  const info = document.getElementById('tr-dst-info');
  info.style.display='block';
  info.innerHTML=`<div class="ib ib-green">
    <strong>📋 ${esc(c.nom)}</strong> — ${esc(c.contrat||'—')}<br>
    💰 Déjà versé : <strong style="color:var(--accent2);">${fmt(totalPaye)}</strong>
    &nbsp;·&nbsp; Restant à couvrir : <strong style="color:var(--accent);">${fmt(restant)}</strong><br>
    <span style="font-size:10px;color:var(--muted);">Montant total contrat : ${fmt(c.montantTotal||0)}</span>
  </div>`;
  _trCheckBothSelected();
};

// ── Afficher zone montant si les deux sont sélectionnés ───────
function _trCheckBothSelected(){
  const zone = document.getElementById('tr-montant-zone');
  if(_trSrcId && _trDstId && zone) zone.style.display='block';
}

// ── Vérification avertissement dépassement ────────────────────
window.trCheckWarn = function(){
  const warn = document.getElementById('tr-warn');
  if(!warn || !_trDstId) return;
  const montant = parseFloat(document.getElementById('tr-montant').value)||0;
  const dst = DB.clients.find(c=>c._id===_trDstId);
  if(!dst){ warn.style.display='none'; return; }
  const totalPayeDst = (DB.paiements||[]).filter(p=>p.clientId===_trDstId).reduce((a,p)=>a+p.montant,0);
  const restant = Math.max(0,(dst.montantTotal||0)-totalPayeDst);
  if(montant > restant){
    warn.style.display='block';
    warn.innerHTML=`⚠️ Attention : le montant transféré (${fmt(montant)}) dépasse le solde restant du contrat destination (${fmt(restant)}). L'opération est quand même autorisée.`;
  } else {
    warn.style.display='none';
  }
};

// ── Confirmer le transfert ────────────────────────────────────
window.trConfirmer = async function(){
  if(!_trCheckAccess()) return;
  if(!_trSrcId || !_trDstId){ notify('Sélectionnez les deux clients','err'); return; }
  const montant = parseFloat(document.getElementById('tr-montant').value)||0;
  if(montant <= 0){ notify('Montant invalide','err'); return; }
  const motif = (document.getElementById('tr-motif').value||'').trim();
  const srcClient = DB.clients.find(c=>c._id===_trSrcId);
  const dstClient = DB.clients.find(c=>c._id===_trDstId);
  if(!srcClient || !dstClient){ notify('Client introuvable','err'); return; }

  // Confirmation double
  const ok = await confirmDialog(
    `Source (à résilier) : ${esc(srcClient.nom)}\n`+
    `Destination : ${esc(dstClient.nom)}\n`+
    `Montant : ${fmt(montant)}\n\n`+
    `Le contrat de ${esc(srcClient.nom)} sera marqué RÉSILIÉ.\n`+
    `Cette action est irréversible.`,
    {title:'⚠️ Confirmation du transfert', okLabel:'Continuer', danger:true}
  );
  if(!ok) return;

  const btn = document.getElementById('tr-btn-confirm');
  if(btn){ btn.disabled=true; btn.textContent='⏳ En cours…'; }

  try {
    const now = new Date();
    const heure = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const operateur = session.nom || session.userId;

    // 1. Enregistrer le paiement sur le contrat destination
    await fbAdd('paiements',{
      clientId: _trDstId,
      commercialId: dstClient.commercialId || session.userId,
      cotisJour: 0,
      montant: montant,
      date: TODAY,
      heure: heure,
      note: `Transfert depuis ${esc(srcClient.nom)}${srcClient.codeClient?' ('+srcClient.codeClient+')':''} · ${motif||'Transfert de contrat'}`,
      saisiParId: session.userId,
      saisiParNom: operateur,
      source: 'transfert',
      verrouille: true
    });

    // 2. Marquer le contrat source comme résilié (ne pas supprimer)
    await fbUpdate('clients', _trSrcId, {
      statutContrat: 'resilie',
      dateResiliation: TODAY,
      motifResiliation: motif || 'Transfert vers contrat '+dstClient.nom,
      resiliePar: operateur
    });

    // 3. Enregistrer la trace dans la collection 'transferts'
    await fbAdd('transferts',{
      srcClientId: _trSrcId,
      dstClientId: _trDstId,
      montant: montant,
      motif: motif || '—',
      date: TODAY,
      heure: heure,
      operateur: operateur,
      operateurId: session.userId
    });

    notify(`✅ Transfert effectué — ${esc(srcClient.nom)} résilié · ${fmt(montant)} ajouté au contrat de ${esc(dstClient.nom)}`);
    trReset();
    renderTransfertResiliation();

  } catch(e){
    notify('Erreur lors du transfert : '+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='🔄 Confirmer le transfert & résilier'; }
  }
};

// ── Réinitialiser le formulaire ───────────────────────────────
window.trReset = function(){
  _trSrcId = null;
  _trDstId = null;
  const ids = ['tr-src-search','tr-src-results','tr-src-info','tr-dst-search','tr-dst-results','tr-dst-info','tr-montant','tr-motif','tr-warn'];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(el.tagName==='INPUT') el.value='';
    else el.style.display='none';
  });
  const zone = document.getElementById('tr-montant-zone');
  if(zone) zone.style.display='none';
  const btn = document.getElementById('tr-btn-confirm');
  if(btn){ btn.disabled=false; btn.textContent='🔄 Confirmer le transfert & résilier'; }
};
// ═══════════════ FIN TRANSFERT RÉSILIATION ═══════════════════

// ═══════════════ DÉPENSES COMMERCIAUX ═════════════════════════
// Saisie de dotations de fonds par commercial (entraide, carburant,
// vidange, réparation, etc.) — réservé à l'admin et au chef d'agence.

function _depCheckAccess(){
  if(!session){ notify('Non connecté','err'); return false; }
  if(!['admin','chef_agence'].includes(session.role)){
    notify("Accès refusé — réservé à l'administrateur ou au chef d'agence","err");
    go(getRoleHome(session.role));
    return false;
  }
  return true;
}

window.depToggleAutre = function(){
  const sel = document.getElementById('dep-nature');
  const zone = document.getElementById('dep-autre-zone');
  if(!sel || !zone) return;
  zone.style.display = (sel.value==='Autre') ? '' : 'none';
};

function _depPopulateSelects(){
  const coms = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL).sort((a,b)=>(a.nom||'').localeCompare(b.nom||''));
  const selForm = document.getElementById('dep-commercial');
  const selFiltre = document.getElementById('dep-filtre-commercial');
  if(selForm){
    const prev = selForm.value;
    selForm.innerHTML = `<option value="">— Sélectionner un commercial —</option>` +
      coms.map(c=>`<option value="${c._id}"${c._id===prev?' selected':''}>${esc(c.nom)}</option>`).join('');
  }
  if(selFiltre){
    const prev = selFiltre.value;
    selFiltre.innerHTML = `<option value="">— Tous les commerciaux —</option>` +
      coms.map(c=>`<option value="${c._id}"${c._id===prev?' selected':''}>${esc(c.nom)}</option>`).join('');
  }
}

window.depResetForm = function(){
  const ids = ['dep-commercial','dep-nature-autre','dep-montant','dep-note'];
  ids.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  const nat = document.getElementById('dep-nature'); if(nat) nat.value='Entraide';
  const dt = document.getElementById('dep-date'); if(dt) dt.value = TODAY;
  const zone = document.getElementById('dep-autre-zone'); if(zone) zone.style.display='none';
  const btn = document.getElementById('dep-btn-save');
  if(btn){ btn.disabled=false; btn.textContent='💾 Enregistrer la dépense'; }
};

window.depResetFiltres = function(){
  const ids = ['dep-filtre-commercial','dep-filtre-date-debut','dep-filtre-date-fin'];
  ids.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  renderDepensesCommerciaux();
};

window.depEnregistrer = async function(){
  if(!_depCheckAccess()) return;
  const commercialId = (document.getElementById('dep-commercial')||{}).value;
  if(!commercialId){ notify('Sélectionnez un commercial','err'); return; }
  const natureSel = (document.getElementById('dep-nature')||{}).value || 'Autre';
  const montant = parseFloat((document.getElementById('dep-montant')||{}).value)||0;
  if(montant <= 0){ notify('Montant invalide','err'); return; }
  const note = ((document.getElementById('dep-note')||{}).value||'').trim();
  const dateChoisie = (document.getElementById('dep-date')||{}).value || TODAY;
  const nature = natureSel==='Autre'
    ? (((document.getElementById('dep-nature-autre')||{}).value||'').trim() || 'Autre')
    : natureSel;

  if(natureSel==='Autre' && !nature){ notify('Précisez la nature de la dépense','err'); return; }

  const com = DB.commerciaux.find(c=>c._id===commercialId);
  if(!com){ notify('Commercial introuvable','err'); return; }

  const btn = document.getElementById('dep-btn-save');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Enregistrement…'; }

  try {
    const now = new Date();
    const heure = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    await fbAdd('depenses',{
      commercialId: commercialId,
      commercialNom: com.nom,
      nature: nature,
      montant: montant,
      note: note,
      date: dateChoisie,
      heure: heure,
      saisiParId: session.userId,
      saisiParNom: session.nom || session.userId
    });
    notify(`✅ Dépense enregistrée — ${fmt(montant)} (${nature}) pour ${esc(com.nom)}`);
    depResetForm();
    renderDepensesCommerciaux();
  } catch(e){
    notify("Erreur lors de l'enregistrement : "+e.message,'err');
    if(btn){ btn.disabled=false; btn.textContent='💾 Enregistrer la dépense'; }
  }
};

window.depSupprimer = async function(id){
  if(!session || session.role!=='admin'){ notify('Suppression réservée à l\'administrateur','err'); return; }
  const ok = await confirmDialog('Supprimer définitivement cette dépense ?',{title:'🗑 Suppression',okLabel:'Supprimer',danger:true});
  if(!ok) return;
  try {
    await fbDelete('depenses', id);
    notify('Dépense supprimée');
    renderDepensesCommerciaux();
  } catch(e){
    notify('Erreur lors de la suppression : '+e.message,'err');
  }
};

// ── Génération automatique des primes journalières ────────────
// Calcule, pour chaque commercial visible (filtré par agence pour un chef
// d'agence), le total encaissé du jour choisi (cotisations + adhésions,
// même logique que le registre), détermine la prime via les paliers
// définis (calculerPrime) et l'enregistre comme une dépense de nature
// "Prime journalière". Une prime déjà générée pour ce commercial à cette
// date n'est jamais dupliquée (elle est simplement ignorée).
window.depGenererPrimesJour = async function(){
  if(!_depCheckAccess()) return;
  const date = (document.getElementById('dep-prime-date')||{}).value;
  if(!date){ notify('Sélectionnez une date','err'); return; }

  const btn = document.getElementById('dep-btn-gen-primes');
  const resume = document.getElementById('dep-prime-resume');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Calcul en cours…'; }

  try {
    const [paysDate, adhDate] = await Promise.all([
      _fetchColByDate('paiements', date),
      _fetchColByDate('adhesionPays', date)
    ]);

    let coms = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL);
    const comIds = new Set(coms.map(c=>c._id));

    const pays = paysDate.filter(p=>p.origine!=='import_historique' && p.source!=='transfert' && comIds.has(p.commercialId));
    const adh = adhDate.filter(a=>comIds.has(a.commercialId));

    // Dépenses déjà enregistrées pour cette date (pour éviter les doublons)
    const dejaGenerees = new Set(
      (DB.depenses||[])
        .filter(d=>d.date===date && d.nature==='Prime journalière')
        .map(d=>d.commercialId)
    );

    const now = new Date();
    const heure = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const operateur = session.nom || session.userId;

    let totalEncaisse = 0, totalPrimesGenerees = 0, nbPrimees = 0, nbIgnorees = 0, nbSansPrime = 0;
    const details = [];

    for(const c of coms){
      const montantCotis = pays.filter(p=>p.commercialId===c._id).reduce((a,p)=>a+p.montant,0);
      const montantAdh = adh.filter(a=>a.commercialId===c._id).reduce((a,x)=>a+Number(x.montant||0),0);
      const montantTotal = montantCotis + montantAdh;
      if(montantTotal<=0) continue;
      totalEncaisse += montantTotal;

      const palier = calculerPrime(montantTotal);
      if(!palier){ nbSansPrime++; continue; }

      if(dejaGenerees.has(c._id)){
        nbIgnorees++;
        details.push({nom:c.nom, montantTotal, prime:Number(palier.montant), statut:'déjà générée'});
        continue;
      }

      await fbAdd('depenses',{
        commercialId: c._id,
        commercialNom: c.nom,
        nature: 'Prime journalière',
        montant: Number(palier.montant),
        note: `Palier "${palier.label||'—'}" atteint · total du jour ${fmt(montantTotal)}`,
        date: date,
        heure: heure,
        saisiParId: session.userId,
        saisiParNom: operateur,
        autoGenere: true
      });
      totalPrimesGenerees += Number(palier.montant);
      nbPrimees++;
      details.push({nom:c.nom, montantTotal, prime:Number(palier.montant), statut:'générée'});
    }

    if(resume){
      resume.style.display='block';
      const netApres = totalEncaisse - totalPrimesGenerees;
      resume.innerHTML = `<div class="ib ib-green">
        📅 <strong>${date}</strong> — ${fmt(totalEncaisse)} encaissé sur la journée<br>
        🏆 <strong>${nbPrimees}</strong> prime(s) générée(s) pour un total de <strong style="color:var(--accent);">${fmt(totalPrimesGenerees)}</strong>
        ${nbIgnorees?` &nbsp;·&nbsp; ${nbIgnorees} déjà généré(s) aujourd'hui (ignoré)`:''}
        ${nbSansPrime?` &nbsp;·&nbsp; ${nbSansPrime} commercial(aux) sous le seuil minimum`:''}<br>
        💵 Net après primes : <strong style="color:var(--accent2);">${fmt(netApres)}</strong>
      </div>`;
    }

    if(nbPrimees>0){
      notify(`✅ ${nbPrimees} prime(s) générée(s) — ${fmt(totalPrimesGenerees)} au total`);
    } else if(nbIgnorees>0){
      notify('Toutes les primes de cette date avaient déjà été générées','err');
    } else {
      notify('Aucun commercial n\'atteint un palier de prime pour cette date','err');
    }

    renderDepensesCommerciaux();
  } catch(e){
    notify('Erreur lors de la génération des primes : '+e.message,'err');
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='🏆 Générer les primes du jour'; }
  }
};

function renderDepensesCommerciaux(){
  if(!_depCheckAccess()) return;
  _depPopulateSelects();

  const dateInput = document.getElementById('dep-date');
  if(dateInput && !dateInput.value) dateInput.value = TODAY;
  const primeDateInput = document.getElementById('dep-prime-date');
  if(primeDateInput && !primeDateInput.value) primeDateInput.value = TODAY;

  const comIdsVisibles = new Set(comsDansAgence().map(c=>c._id));
  let depenses = (DB.depenses||[]).filter(d=>comIdsVisibles.has(d.commercialId));

  const filtreCom = (document.getElementById('dep-filtre-commercial')||{}).value||'';
  const filtreDebut = (document.getElementById('dep-filtre-date-debut')||{}).value||'';
  const filtreFin = (document.getElementById('dep-filtre-date-fin')||{}).value||'';

  if(filtreCom) depenses = depenses.filter(d=>d.commercialId===filtreCom);
  if(filtreDebut) depenses = depenses.filter(d=>(d.date||'') >= filtreDebut);
  if(filtreFin) depenses = depenses.filter(d=>(d.date||'') <= filtreFin);

  depenses = depenses.slice().sort((a,b)=>{
    const da = (a.date||'')+(a.heure||''), db = (b.date||'')+(b.heure||'');
    return db.localeCompare(da);
  });

  const total = depenses.reduce((a,d)=>a+(d.montant||0),0);
  const totalEl = document.getElementById('dep-total-filtre');
  if(totalEl) totalEl.textContent = `Total : ${fmt(total)} (${depenses.length} dépense${depenses.length>1?'s':''})`;

  const tbody = document.getElementById('dep-historique-body');
  if(!tbody) return;
  if(!depenses.length){
    tbody.innerHTML = '<tr><td colspan="7" class="emp">Aucune dépense enregistrée</td></tr>';
    return;
  }
  const canDelete = session && session.role===ROLES.ADMIN;
  tbody.innerHTML = depenses.map(d=>`<tr>
    <td class="tm">${d.date||'—'}</td>
    <td><strong>${esc(d.commercialNom||'—')}</strong></td>
    <td>${esc(d.nature||'—')}${d.autoGenere?' <span style="font-size:9px;background:rgba(247,201,79,0.15);border:1px solid rgba(247,201,79,0.35);border-radius:4px;padding:1px 5px;color:var(--accent);">🏆 auto</span>':''}</td>
    <td style="color:var(--accent);font-weight:700;">${fmt(d.montant||0)}</td>
    <td class="tm" style="font-size:11px;">${esc(d.note||'—')}</td>
    <td class="tm" style="font-size:11px;">${esc(d.saisiParNom||'—')}</td>
    <td style="text-align:center;">${canDelete?`<button class="btn btn-xs btn-warn" onclick="depSupprimer('${d._id}')" title="Supprimer">🗑</button>`:''}</td>
  </tr>`).join('');
}
// ═══════════════ FIN DÉPENSES COMMERCIAUX ═════════════════════

// ═══════════════ HISTORIQUE DES REÇUS (réimpression) ═══════════
// Accès réservé à l'administrateur, au chef d'agence et à la secrétaire.
function _recuCheckAccess(){
  if(!session){ notify('Non connecté','err'); return false; }
  if(!['admin','chef_agence','secretaire'].includes(session.role)){
    notify("Accès refusé — réservé à l'administrateur, au chef d'agence ou à la secrétaire","err");
    go(getRoleHome(session.role));
    return false;
  }
  return true;
}

function _recuPopulateSelects(){
  const sel = document.getElementById('recu-filtre-commercial');
  if(!sel) return;
  // ✅ PERF : ne reconstruire (innerHTML) que si la liste des commerciaux a
  // changé — cette fonction est appelée à CHAQUE frappe dans la recherche
  // via renderHistoriqueRecus() → dRender('renderHistoriqueRecus').
  const coms = comsDansAgence().filter(c=>c.role===ROLES.COMMERCIAL).sort((a,b)=>(a.nom||'').localeCompare(b.nom||''));
  const comsSig = coms.map(c=>c._id).join(',');
  if (sel.dataset.comsSig === comsSig) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">— Tous les commerciaux —</option>` +
    coms.map(c=>`<option value="${c._id}"${c._id===prev?' selected':''}>${esc(c.nom)}</option>`).join('');
  sel.value = prev;
  sel.dataset.comsSig = comsSig;
}

window.recuResetFiltres = function(){
  const ids = ['recu-filtre-commercial','recu-filtre-type','recu-filtre-date-debut','recu-filtre-date-fin','recu-filtre-recherche'];
  ids.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  renderHistoriqueRecus();
};

function renderHistoriqueRecus(){
  if(!_recuCheckAccess()) return;
  _recuPopulateSelects();

  const comIdsVisibles = new Set(comsDansAgence().map(c=>c._id));
  let recus = (DB.recus||[]).filter(r=>comIdsVisibles.has(r.commercialId));

  const filtreCom = (document.getElementById('recu-filtre-commercial')||{}).value||'';
  const filtreType = (document.getElementById('recu-filtre-type')||{}).value||'';
  const filtreDebut = (document.getElementById('recu-filtre-date-debut')||{}).value||'';
  const filtreFin = (document.getElementById('recu-filtre-date-fin')||{}).value||'';
  const q = (document.getElementById('recu-filtre-recherche')||{}).value.trim().toLowerCase();

  if(filtreCom) recus = recus.filter(r=>r.commercialId===filtreCom);
  if(filtreType) recus = recus.filter(r=>(r.type||'cotisation')===filtreType);
  if(filtreDebut) recus = recus.filter(r=>(r.date||'') >= filtreDebut);
  if(filtreFin) recus = recus.filter(r=>(r.date||'') <= filtreFin);
  if(q){
    recus = recus.filter(r =>
      (r.recuNum||'').toLowerCase().includes(q) ||
      (r.clientNom||'').toLowerCase().includes(q) ||
      (r.clientCode||'').toLowerCase().includes(q)
    );
  }

  recus = recus.slice().sort((a,b)=>{
    const da = (a.date||'')+(a.heure||''), db = (b.date||'')+(b.heure||'');
    return db.localeCompare(da);
  });

  const total = recus.reduce((a,r)=>a+(Number(r.montant)||0),0);
  const totalEl = document.getElementById('recu-total-filtre');
  if(totalEl) totalEl.textContent = `Total : ${fmt(total)} (${recus.length} reçu${recus.length>1?'s':''})`;

  const tbody = document.getElementById('recu-historique-body');
  if(!tbody) return;
  if(!recus.length){
    tbody.innerHTML = '<tr><td colspan="8" class="emp">Aucun reçu enregistré</td></tr>';
    return;
  }
  const typeLabels = {cotisation:'💳 Cotisation(s)', adhesion:'🤝 Adhésion', rachat_carnet:'📘 Rachat carnet'};
  tbody.innerHTML = recus.map(r=>`<tr>
    <td class="tm" style="font-weight:700;color:var(--accent);">${esc(r.recuNum||'—')}</td>
    <td class="tm">${esc(r.date||'—')} ${esc(r.heure||'')}</td>
    <td>${typeLabels[r.type||'cotisation']||'💳 Cotisation(s)'}</td>
    <td><strong>${esc(r.clientNom||'—')}</strong>${r.clientCode?` <span style="font-size:9px;color:var(--muted);">(${esc(r.clientCode)})</span>`:''}</td>
    <td class="tm">${esc(r.commercialNom||'—')}</td>
    <td style="color:var(--accent);font-weight:700;">${fmt(r.montant||0)}</td>
    <td class="tm" style="font-size:11px;">${esc(r.saisiParNom||'—')}</td>
    <td style="text-align:center;"><button class="btn btn-xs" style="background:rgba(120,140,255,0.12);color:#8fa4ff;border:1px solid rgba(120,140,255,0.3)" onclick="reimprimerRecu('${r._id}')" title="Réimprimer ce reçu">🖨️ Réimprimer</button></td>
  </tr>`).join('');
}
window.renderHistoriqueRecus = renderHistoriqueRecus;

// Réimpression à l'identique d'un reçu déjà émis (même numéro, même date d'émission).
window.reimprimerRecu = function(id){
  if(!_recuCheckAccess()) return;
  const r = (DB.recus||[]).find(x=>x._id===id);
  if(!r){ notify('Reçu introuvable','err'); return; }
  afficherRecu({
    type: r.type,
    clientNom: r.clientNom,
    clientCode: r.clientCode,
    clientTel: r.clientTel,
    clientVille: r.clientVille,
    commercialId: r.commercialId,
    commercialNom: r.commercialNom,
    montant: r.montant,
    nbCotis: r.nbCotis,
    cotisJour: r.cotisJour,
    note: r.note,
    saisiParNom: r.saisiParNom
  }, { recuNum: r.recuNum, emissionDate: r.emissionDate, emissionHeure: r.emissionHeure, reprint: true });
};
// ═══════════════ FIN HISTORIQUE DES REÇUS ══════════════════════

// ✅ FIX RÉACTIVITÉ FILTRES/RECHERCHE (tous écrans) ═══════════════
// Ce script est chargé en <script type="module">. Dans un module JS, les
// fonctions déclarées normalement (function xxx(){...}) restent invisibles
// depuis les attributs HTML inline (onchange="...", oninput="...") — ceux-ci
// s'exécutent dans le contexte global, hors du scope du module. Seules les
// fonctions explicitement assignées à window sont accessibles depuis eux.
// dRender() (utilisée par presque tous les champs de recherche) et plusieurs
// fonctions de rendu appelées directement en onchange n'étaient PAS exposées
// sur window : chaque frappe/sélection déclenchait une erreur silencieuse
// (aucun message visible), et le filtre ne s'appliquait qu'après un
// rechargement complet de la page (qui, lui, passe par go() → exposé sur
// window → appelle ces fonctions en interne, dans le scope du module).
window.dRender = dRender;
window.safeRender = safeRender;
window.toggleSidebar = toggleSidebar;
window.mettreAJourSelectionBar = mettreAJourSelectionBar;
window.renderArticles = renderArticles;
// ✅ FIX BUG : ces fonctions sont appelées via dRender('nomFonction') → safeRender
// → window[nomFonction], donc elles DOIVENT être exposées sur window, sinon
// "Uncaught ReferenceError: ... is not defined" dès qu'un filtre/recherche
// correspondant est utilisé.
window.renderCatalogue = renderCatalogue;
window.renderFiche = renderFiche;
window.renderHist = renderHist;
window.renderRapportProduitsEnCours = renderRapportProduitsEnCours;
window.renderRegistre = renderRegistre;
window.renderStock = renderStock;
window.renderComClients = renderComClients;
window.renderControle = renderControle;
window.renderDepensesCommerciaux = renderDepensesCommerciaux;
window.renderLivraisons = renderLivraisons;
window.renderProduits = renderProduits;
window.renderSaisieAdhesions = renderSaisieAdhesions;

// ✅ Filet de sécurité global : toute erreur JS qui échapperait encore à un
// try/catch local est désormais signalée à l'utilisateur (au lieu de rester
// silencieuse) et journalisée en console pour diagnostic.
window.addEventListener('error', function(e){
  console.error('[Erreur globale]', e.message, e.error);
  if (typeof notify === 'function') {
    notify('Erreur : '+(e.message||'action impossible')+' — réessayez ou changez de page puis revenez.', 'err');
  }
});
window.addEventListener('unhandledrejection', function(e){
  console.error('[Promesse rejetée]', e.reason);
  if (typeof notify === 'function') {
    notify('Erreur : '+((e.reason&&e.reason.message)||'action impossible')+' — réessayez ou changez de page puis revenez.', 'err');
  }
});

// ═══════════════ ENREGISTREMENT SERVICE WORKER (PWA) ═════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch(err => console.error('Échec enregistrement Service Worker :', err));
  });
}
