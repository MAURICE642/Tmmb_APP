/* ══════════════════════════════════════════════════════════════════════
   TRIOMPHANT MMB SERVICE — Cloud Functions
   ── VOLET 58 ── Changement de l'e-mail de connexion d'un utilisateur
   ──────────────────────────────────────────────────────────────────────
   POURQUOI CÔTÉ SERVEUR
   Le SDK du navigateur ne peut PAS modifier l'e-mail d'un AUTRE compte :
   seul l'Admin SDK le peut, et ses droits ne doivent jamais se trouver
   dans app.js. Cette fonction est donc la SEULE porte d'entrée.

   CE QUI GARDE LES CLIENTS
   L'UID Firebase ne change jamais. La fiche commerciaux/{uid} garde son ID
   et tous les clients/paiements (commercialId == uid) restent rattachés.
   Rien n'est réécrit dans clients, paiements, etc.

   CONTRÔLES (dans cet ordre)
   1. appelant connecté ;
   2. appelant = admin, lu dans commerciaux/{uid}.role — même source de
      vérité que firestore.rules (isAdmin) ;
   3. connexion RÉCENTE (mot de passe ressaisi il y a < 5 min) ;
   4. paramètres valides ;
   5. la fiche cible existe ET un compte Auth porte le MÊME UID (sinon les
      clients ne suivraient pas : refus) ;
   6. nouvel e-mail libre dans Auth ET dans commerciaux.
   Puis : Auth modifié → fiche + historique écrits ensemble (batch).
   Si l'écriture Firestore échoue, l'e-mail Auth est REMIS à l'ancien.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

// ⚠️ Doit être IDENTIQUE à _FN_REGION dans app.js.
const REGION = 'europe-west1';
const AGE_MAX_CONNEXION_S = 5 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function jourBenin(d) {
  // AAAA-MM-JJ à l'heure de Porto-Novo (UTC+1, sans heure d'été).
  return new Date(d.getTime() + 3600 * 1000).toISOString().slice(0, 10);
}

exports.adminChangerEmail = onCall(
  { region: REGION, maxInstances: 2, timeoutSeconds: 30 },
  async (req) => {
    // 1. Connecté
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError('unauthenticated', 'Connexion requise.');
    }
    const appelantUid = req.auth.uid;
    const db = getFirestore();

    // 2. Admin
    const appelantSnap = await db.doc(`commerciaux/${appelantUid}`).get();
    if (!appelantSnap.exists || appelantSnap.get('role') !== 'admin') {
      throw new HttpsError('permission-denied', "Réservé à l'administrateur.");
    }

    // 3. Connexion récente
    const authTime = Number(req.auth.token && req.auth.token.auth_time) || 0;
    if (!authTime || (Date.now() / 1000 - authTime) > AGE_MAX_CONNEXION_S) {
      throw new HttpsError('failed-precondition', 'reauth-requise');
    }

    // 4. Paramètres
    const data = req.data || {};
    const uid = typeof data.uid === 'string' ? data.uid.trim() : '';
    const nouvel = typeof data.nouvelEmail === 'string' ? data.nouvelEmail.trim().toLowerCase() : '';
    const motif = typeof data.motif === 'string' ? data.motif.trim().slice(0, 300) : '';
    if (!uid || uid.length > 128 || uid.includes('/')) {
      throw new HttpsError('invalid-argument', 'Utilisateur invalide.');
    }
    if (!nouvel || nouvel.length > 150 || !EMAIL_RE.test(nouvel)) {
      throw new HttpsError('invalid-argument', 'Adresse e-mail invalide.');
    }

    // 5. Fiche + compte Auth avec le même UID
    const ficheRef = db.doc(`commerciaux/${uid}`);
    const ficheSnap = await ficheRef.get();
    if (!ficheSnap.exists) {
      throw new HttpsError('not-found', 'Fiche utilisateur introuvable.');
    }
    let compte;
    try {
      compte = await getAuth().getUser(uid);
    } catch (e) {
      if (e && e.code === 'auth/user-not-found') {
        throw new HttpsError('not-found',
          "Aucun compte de connexion n'a le même identifiant que cette fiche. "
          + "Rien n'a été modifié (sinon ses clients ne suivraient pas).");
      }
      throw e;
    }
    const ancien = (compte.email || '').toLowerCase();
    if (ancien === nouvel) {
      throw new HttpsError('invalid-argument', "C'est déjà l'adresse actuelle.");
    }

    // 6. Nouvel e-mail libre
    try {
      const autre = await getAuth().getUserByEmail(nouvel);
      if (autre && autre.uid !== uid) {
        throw new HttpsError('already-exists', 'Cette adresse est déjà utilisée par un autre compte.');
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (!(e && e.code === 'auth/user-not-found')) throw e;
    }
    const doublons = await db.collection('commerciaux').where('email', '==', nouvel).limit(2).get();
    if (doublons.docs.some(d => d.id !== uid)) {
      throw new HttpsError('already-exists', 'Cette adresse figure déjà sur une autre fiche utilisateur.');
    }

    // ── Modification ──
    await getAuth().updateUser(uid, { email: nouvel, emailVerified: false });

    const maintenant = new Date();
    try {
      const batch = db.batch();
      batch.update(ficheRef, { email: nouvel });
      batch.create(db.collection('changementsEmail').doc(), {
        utilisateurId: uid,
        utilisateurNom: ficheSnap.get('nom') || '',
        utilisateurRole: ficheSnap.get('role') || '',
        ancienEmail: ancien,
        nouvelEmail: nouvel,
        motif,
        effectuePar: appelantUid,
        effectueParNom: appelantSnap.get('nom') || '',
        horodatage: maintenant.toISOString(),
        horodatageJour: jourBenin(maintenant)
      });
      await batch.commit();
    } catch (e) {
      // Retour arrière : la connexion doit rester cohérente avec la fiche.
      try {
        await getAuth().updateUser(uid, { email: ancien || undefined, emailVerified: !!compte.emailVerified });
      } catch (e2) {
        console.error('[adminChangerEmail] RETOUR ARRIÈRE ÉCHOUÉ', uid, ancien, nouvel, e2);
      }
      console.error('[adminChangerEmail] écriture Firestore échouée', uid, e);
      throw new HttpsError('internal', "Échec de l'enregistrement : rien n'a été modifié.");
    }

    console.log('[adminChangerEmail] OK', { uid, ancien, nouvel, par: appelantUid });
    return { ok: true, ancienEmail: ancien, nouvelEmail: nouvel };
  }
);
