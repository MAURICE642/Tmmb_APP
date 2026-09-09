// ═══════════════════════════════════════════════════════════════
// crypto-worker.js — Worker dédié au chiffrement local de la base (DB).
//
// Rôle unique : recevoir un objet JS (la base DB, ou tout autre objet à
// chiffrer localement), faire JSON.stringify + chiffrement AES-GCM, et
// renvoyer le résultat — le tout HORS du thread principal (UI), pour que
// l'application ne se fige jamais pendant une sauvegarde locale, même
// quand la base grossit (des milliers de clients/paiements).
//
// Sécurité :
//  - La CryptoKey reçue via 'setKey' est non-extractible (dérivée avec
//    extractable=false côté app.js) : elle ne peut pas être exportée en
//    clair, ni par ce worker ni par le thread principal. Elle ne quitte
//    jamais ce fichier.
//  - Rien ici n'écrit sur le réseau ni dans localStorage/IndexedDB : ce
//    worker calcule seulement, la persistance reste gérée par app.js
//    (voir _doSaveLocalEncrypted → idbSet), pour ne pas dupliquer la
//    logique de stockage à deux endroits.
//  - Aucun `importScripts()` : ce fichier ne dépend d'aucune ressource
//    externe, donc aucune surface d'attaque supplémentaire liée au CDN.
//
// Chargé depuis app.js via `new Worker('crypto-worker.js')` — ce fichier
// doit rester servi depuis la MÊME origine que l'application (voir la CSP
// de index.html : script-src 'self' couvre aussi worker-src par défaut ;
// une directive worker-src 'self' explicite a été ajoutée par prudence).
// ═══════════════════════════════════════════════════════════════

let _key = null; // CryptoKey en mémoire uniquement, jamais persistée ici

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type } = msg;
  try {
    if (type === 'setKey') {
      _key = msg.key;
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'clearKey') {
      _key = null;
      // id peut valoir 0 ici (appel "fire and forget" côté app.js) : on ne
      // répond que si un id valide a été fourni pour éviter un postMessage inutile.
      if (id) self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'encrypt') {
      if (!_key) { self.postMessage({ id, ok: false, error: 'no-key' }); return; }
      const enc = new TextEncoder();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // ── C'est ICI que s'exécute désormais le JSON.stringify(DB) ──
      // Il tourne dans ce thread de worker : il peut prendre du temps sur
      // une base volumineuse, mais il ne bloque plus jamais l'UI.
      const json = JSON.stringify(msg.data);
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _key, enc.encode(json));
      const cipherBytes = new Uint8Array(cipher);
      // Transfert "zero-copy" des buffers vers le thread principal (au lieu
      // d'une recopie complète) : { iv, data } redevient directement
      // utilisable tel quel par _encryptLocal côté app.js.
      self.postMessage({ id, ok: true, iv, data: cipherBytes }, [iv.buffer, cipherBytes.buffer]);
      return;
    }
    self.postMessage({ id, ok: false, error: 'unknown-message-type:' + type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
