#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   verifier.js — garde-fous automatiques de TRIOMPHANT MMB SERVICE
   ──────────────────────────────────────────────────────────────────────
   Node pur, AUCUNE dépendance. À lancer AVANT chaque minification :

       node verifier.js && npx terser app.js --module --compress --mangle -o app.min.js

   Sort en code 1 si un contrôle BLOQUANT échoue ; les AVERTISSEMENTS ne
   bloquent jamais (sinon le premier lot pressé désactiverait l'outil).

   Il ne vérifie AUCUNE logique métier : uniquement des invariants de
   structure entre les tables de configuration. C'est précisément ce qui
   échoue en silence dans cette application — une page absente de
   _PAGE_DEPS s'affiche vide, un rôle absent de BN_CONFIG reçoit le menu
   d'un autre rôle, et rien ne le signale.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const RACINE = process.argv[2] || '.';
const F = n => path.join(RACINE, n);

function lire(n) {
  try { return fs.readFileSync(F(n), 'utf8'); }
  catch (e) { return null; }
}

const app   = lire('app.js');
const html  = lire('index.html');
const sw    = lire('sw.js');
const rules = lire('firestore.rules');

if (!app || !html) {
  console.error('✖ app.js ou index.html introuvable dans « ' + RACINE + ' ».');
  process.exit(1);
}

let echecs = 0, avertissements = 0;
const lignesApp = app.split('\n');

function ligneDe(motif) {            // n° de ligne (1-indexé) de la 1re occurrence
  for (let i = 0; i < lignesApp.length; i++) if (lignesApp[i].includes(motif)) return i + 1;
  return '?';
}
function ok(n, msg)   { console.log(`  ✔ ${n}. ${msg}`); }
function ko(n, msg, details) {
  echecs++;
  console.log(`  ✖ ${n}. ${msg}`);
  (details || []).forEach(d => console.log(`       ${d}`));
}
function warn(n, msg, details) {
  avertissements++;
  console.log(`  ⚠ ${n}. ${msg}`);
  (details || []).forEach(d => console.log(`       ${d}`));
}

// Extrait le corps d'un littéral objet/tableau à partir de son accolade ouvrante.
function bloc(src, depuis, ouvre, ferme) {
  const i = src.indexOf(ouvre, depuis);
  if (i < 0) return '';
  let p = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === ouvre) p++;
    else if (src[j] === ferme) { p--; if (!p) return src.slice(i + 1, j); }
  }
  return '';
}

console.log('\n══ verifier.js — ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' ══\n');

/* ── 1. Rôles : ROLES ↔ BN_CONFIG / getRoleNav / getRoleHome ────────── */
const ROLES = [...bloc(app, app.indexOf('const ROLES'), '{', '}')
  .matchAll(/:\s*'([a-z_]+)'/g)].map(m => m[1]);

const bnBody = bloc(app, app.indexOf('BN_CONFIG'), '{', '}');
// clés de 1er niveau : celles suivies de « : { »
const bnCles = [...bnBody.matchAll(/(?:^|\n)\s*'?([A-Za-z_][\w-]*)'?\s*:\s*\{/g)].map(m => m[1]);

if (!ROLES.length) {
  warn(1, 'ROLES introuvable — contrôle des rôles ignoré.');
} else {
  const manquants = ROLES.filter(r => !bnCles.includes(r));
  const inconnus  = bnCles.filter(r => !ROLES.includes(r));
  if (manquants.length || inconnus.length) {
    ko(1, 'BN_CONFIG ne correspond pas à ROLES — sur mobile, le rôle reçoit le menu du contrôleur, EN SILENCE.',
      [...manquants.map(r => `rôle « ${r} » ABSENT de BN_CONFIG`),
       ...inconnus.map(r => `clé « ${r} » de BN_CONFIG (ligne ${ligneDe("'" + r + "'")}) ne correspond à aucun rôle`)]);
  } else ok(1, `BN_CONFIG couvre les ${ROLES.length} rôles de ROLES.`);

  // getRoleHome / getRoleNav
  const home = bloc(app, app.indexOf('function getRoleHome'), '{', '}');
  const nav  = bloc(app, app.indexOf('function getRoleNav'), '{', '}');
  const absentsHome = ROLES.filter(r => !home.includes(`'${r}'`) && !home.includes(r.toUpperCase()));
  if (absentsHome.length) warn(2, 'Rôles sans page d\'accueil explicite dans getRoleHome : ' + absentsHome.join(', '));
  else ok(2, 'getRoleHome couvre tous les rôles.');
  const absentsNav = ROLES.filter(r => !nav.includes(`'${r}'`) && !nav.includes(r.toUpperCase()));
  if (absentsNav.length) warn(3, 'Rôles sans menu dans getRoleNav : ' + absentsNav.join(', '));
  else ok(3, 'getRoleNav couvre tous les rôles.');
}

/* ── 4. Pages : go('X') ↔ TITLES ↔ _PAGE_DEPS ↔ <div id="page-X"> ───── */
const pagesGo = new Set([...app.matchAll(/\bgo\(\s*'([a-z0-9-]+)'/g)].map(m => m[1])
  .concat([...html.matchAll(/\bgo\(\s*'([a-z0-9-]+)'/g)].map(m => m[1])));

const titresBody = bloc(app, app.indexOf('const TITLES'), '{', '}');
const depsBody   = bloc(app, app.indexOf('const _PAGE_DEPS'), '{', '}');
const pagesHtml  = new Set([...html.matchAll(/id="page-([a-z0-9-]+)"/g)].map(m => m[1]));

const sansDeps  = [...pagesGo].filter(p => !new RegExp(`['"]?${p}['"]?\\s*:`).test(depsBody));
const sansTitre = [...pagesGo].filter(p => !new RegExp(`['"]?${p}['"]?\\s*:`).test(titresBody));
const sansHtml  = [...pagesGo].filter(p => !pagesHtml.has(p));

if (sansDeps.length) {
  ko(4, 'Page atteignable SANS entrée dans _PAGE_DEPS — elle s\'affichera VIDE ou FAUSSE jusqu\'à ce qu\'une autre page charge ses collections.',
    sansDeps.map(p => `« ${p} » (go() ligne ${ligneDe("go('" + p + "')")})`));
} else ok(4, `Les ${pagesGo.size} pages atteignables ont toutes des dépendances déclarées.`);

if (sansTitre.length) warn(5, 'Pages sans entrée dans TITLES : ' + sansTitre.join(', '));
else ok(5, 'Toutes les pages atteignables ont un titre.');

if (sansHtml.length) ko(6, 'go() vers une page sans <div id="page-…"> dans index.html : ' + sansHtml.join(', '));
else ok(6, 'Chaque page atteignable a son conteneur HTML.');

// pages définies mais inatteignables (informatif)
const orphelines = [...pagesHtml].filter(p => !pagesGo.has(p));
if (orphelines.length) warn(7, 'Pages présentes dans index.html mais atteignables par aucun go() : ' + orphelines.join(', '));
else ok(7, 'Aucune page orpheline.');

/* ── 8. Collections : écritures ↔ _WRITE_ROLES ↔ firestore.rules ────── */
const colsEcrites = new Set([...app.matchAll(/fb(?:Add|Update|Delete|SetSameId)\(\s*'([A-Za-z_]+)'/g)].map(m => m[1]));
// ⚠ On vise la DÉCLARATION, pas la première mention : « _WRITE_ROLES » est
// cité dans plusieurs commentaires bien avant la ligne 2075, et un
// indexOf naïf capturait alors le mauvais littéral objet — d'où une liste
// de « collections non déclarées » entièrement fausse.
const wrBody = bloc(app, app.search(/const\s+_WRITE_ROLES\s*=/), '{', '}');
const wrCles = new Set([...wrBody.matchAll(/(?:^|\n)\s*([A-Za-z_]\w*)\s*:\s*\[/g)].map(m => m[1]));

const nonDeclarees = [...colsEcrites].filter(c => !wrCles.has(c));
if (nonDeclarees.length) {
  ko(8, 'Collection écrite mais ABSENTE de _WRITE_ROLES — _checkWriteRole échoue OUVERT : tous les rôles peuvent écrire.',
    nonDeclarees.map(c => `« ${c} » (ligne ${ligneDe("'" + c + "'")})`));
} else ok(8, `Les ${colsEcrites.size} collections écrites sont déclarées dans _WRITE_ROLES.`);

if (rules) {
  const matchs = new Set([...rules.matchAll(/match\s+\/([A-Za-z_]+)\/\{/g)].map(m => m[1]));
  const sansRegle = [...new Set([...colsEcrites, ...wrCles])].filter(c => !matchs.has(c));
  if (sansRegle.length) ko(9, 'Collection sans règle Firestore — toute écriture sera REFUSÉE en production : ' + sansRegle.join(', '));
  else ok(9, 'Chaque collection connue a une règle Firestore.');

  // sécurité : motifs à ne jamais laisser passer
  const dangers = [];
  if (/allow\s+read\s*,\s*write\s*:\s*if\s+true/.test(rules)) dangers.push('« allow read, write: if true » présent');
  if (/request\.resource\.data\.role\s*==\s*'comptable'/.test(rules)) dangers.push("auto-attribution du rôle 'comptable' au create de /commerciaux (voir AUDIT §S1)");
  if (/allow\s+write\s*:[^;]*;\s*allow\s+update\s*,\s*delete/.test(rules)) dangers.push("« allow write » suivi de « allow update,delete » : les deux se CUMULENT (OU), le second ne restreint rien (voir AUDIT §S4)");
  // ── VOLET 37 ── hasOnly() qui ne tolère pas « _ts ».
  // Depuis le volet 19, fbUpdate() ajoute _ts:serverTimestamp() à TOUTE
  // modification. Une règle qui restreint les champs modifiables par
  // hasOnly([...]) sans y faire figurer '_ts' refuse donc désormais toute
  // écriture passant par fbUpdate — en permission-denied, sans que l'écran
  // qui lit le champ ne montre autre chose qu'un compteur à zéro.
  // C'est ainsi que la mise sous contrôle par un contrôleur est restée
  // bloquée du 27/09 au 05/10 sans que rien ne le signale.
  // ⚠️ Un hasOnly() sur request.resource.data.keys() (document ENTIER, au
  // create) n'est PAS concerné : on ne regarde que les diff() d'update.
  // La règle n'est RÉELLEMENT cassée que si la collection concernée est
  // écrite via fbUpdate(). Une collection mise à jour autrement — setDoc()
  // avec merge, par exemple — n'ajoute pas _ts et reste intacte : la
  // signaler comme bloquante serait un faux positif, et un garde-fou qui
  // crie pour rien finit par être ignoré. On la signale donc en
  // AVERTISSEMENT, parce que le risque redeviendrait réel le jour où
  // quelqu'un routerait cette écriture par fbUpdate().
  const _tsLatents = [];
  for (const m of rules.matchAll(/diff\s*\(\s*resource\.data\s*\)\s*\.affectedKeys\(\)\s*\.hasOnly\(\s*\[([^\]]*)\]/g)) {
    if (/['"]_ts['"]/.test(m[1])) continue;
    const champs = m[1].replace(/\s+/g, ' ').trim();
    // Collection = le dernier « match /<col>/ » ouvert avant cette position.
    const avant = rules.slice(0, m.index);
    const matches = [...avant.matchAll(/match\s+\/([A-Za-z0-9_]+)\s*\//g)];
    const col = matches.length ? matches[matches.length - 1][1] : '?';
    const parFbUpdate = new RegExp(`fbUpdate\\(\\s*['"\`]${col}['"\`]`).test(app);
    const msg = `/${col} : hasOnly([${champs}]) ne tolère pas '_ts'`;
    if (parFbUpdate) {
      dangers.push(msg + ` — fbUpdate() l'ajoute à chaque modification, cette écriture EST refusée `
        + `en permission-denied (voir LISEZ-MOI § 43)`);
    } else {
      _tsLatents.push(msg + ` (non bloquant aujourd'hui : cette collection n'est pas écrite par fbUpdate(), `
        + `mais le deviendrait si c'était le cas)`);
    }
  }
  if (_tsLatents.length) warn(10, "Règles restreignant les champs sans tolérer '_ts' :", _tsLatents);
  if (dangers.length) ko(10, 'Motifs dangereux dans firestore.rules :', dangers);
  else ok(10, 'Aucun motif dangereux connu dans firestore.rules.');
} else warn(9, 'firestore.rules absent — contrôles 9 et 10 ignorés.');

/* ── 11. Handlers inline exposés sur window ─────────────────────────── */
const DOM_OK = new Set(['preventDefault','stopPropagation','stopImmediatePropagation','focus','blur','click',
  'getElementById','querySelector','if','for','while','return','typeof','function','catch','new','JSON','Number',
  'String','Array','Object','Math','Date','parseInt','parseFloat','event','this','confirm','alert','setTimeout',
  'decodeURIComponent','encodeURIComponent','console','window','document']);

const appeles = new Set();
for (const m of html.matchAll(/\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/g))
  for (const f of m[2].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) appeles.add(f[1]);
for (const m of app.matchAll(/\bon[a-z]+\s*=\s*[\\"'`]([^"'`]{0,300}?)[\\"'`]/g)) {
  // ⚠ Dans un gabarit `...${expr}...`, ce qui est entre ${ } est évalué AU
  // MOMENT DU RENDU, côté module — ce n'est pas ce que le navigateur
  // exécutera au clic. Ces fonctions-là n'ont donc pas à être sur window.
  // Sans ce retrait, _attrJSON(), esc(), fmt(), prodImages()… étaient
  // signalées à tort comme « non exposées ».
  const emis = m[1].replace(/\$\{[^}]*\}/g, '');
  for (const f of emis.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) appeles.add(f[1]);
}

const nonExposes = [...appeles].filter(n =>
  !DOM_OK.has(n) && !n.startsWith('_') &&
  !app.includes('window.' + n + ' =') && !app.includes('window.' + n + '=') &&
  (new RegExp(`\\bfunction\\s+${n}\\b`).test(app) || new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`).test(app)));

if (nonExposes.length) {
  ko(11, 'Fonction appelée depuis un attribut on*= mais NON exposée sur window — elle cassera après minification :',
    nonExposes.map(n => `${n}() (ligne ${ligneDe(n)})`));
} else ok(11, `Les ${appeles.size} handlers inline détectés sont exposés (ou sont des primitives DOM).`);

/* ── 12. Identifiants dupliqués dans index.html ─────────────────────── */
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const doublons = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
if (doublons.length) warn(12, 'Identifiants HTML en double (getElementById en renverra un seul) : ' + doublons.join(', '));
else ok(12, 'Tous les identifiants HTML sont uniques.');

/* ── 13. Balises équilibrées ────────────────────────────────────────── */
const desequilibres = [];
for (const t of ['div', 'span', 'table', 'tbody', 'thead', 'select', 'form']) {
  const o = (html.match(new RegExp('<' + t + '\\b', 'g')) || []).length;
  const c = (html.match(new RegExp('</' + t + '>', 'g')) || []).length;
  if (o !== c) desequilibres.push(`<${t}> : ${o} ouvertes, ${c} fermées`);
}
if (desequilibres.length) ko(13, 'Balises déséquilibrées dans index.html :', desequilibres);
else ok(13, 'Balises équilibrées dans index.html.');

/* ── 14. Version applicative et cohérence avec le service worker ────── */
const mVer = app.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!mVer) {
  warn(14, "Aucun APP_VERSION dans app.js — impossible de savoir quelle version tourne chez un agent, "
        + "et les erreurs remontées dans logs_erreurs_app ne sont rattachables à aucun lot. Voir AUDIT §M3.");
} else if (sw) {
  const mCache = sw.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
  if (mCache && !mCache[1].includes(mVer[1])) {
    ko(14, `APP_VERSION (« ${mVer[1]} ») absente de CACHE_NAME (« ${mCache[1]} ») — `
         + `si sw.js ne change pas, AUCUNE bannière de mise à jour ne s'affichera et les agents resteront sur l'ancien code.`);
  } else ok(14, `Version ${mVer[1]} cohérente entre app.js et sw.js.`);
} else warn(14, 'sw.js absent — cohérence de version non vérifiable.');

/* ── 14b. app.min.js régénéré ? (volet 84) ──────────────────────────────
   index.html charge app.min.js, PAS app.js. Si la minification échoue,
   l'ancien app.min.js reste en place et part en production avec le
   nouvel index.html (incident v83 : « ouvrirGuide is not defined »). */
if (mVer) {
  const minJs = lire('app.min.js');
  if (!minJs) warn('14b', "app.min.js absent — c'est pourtant le fichier chargé par index.html.");
  else if (!minJs.includes('"' + mVer[1] + '"') && !minJs.includes("'" + mVer[1] + "'"))
    ko('14b', `app.min.js ne contient pas la version « ${mVer[1]} » : il n'a PAS été régénéré depuis app.js. `
         + `Relancez : npx terser app.js --module --compress --mangle -o app.min.js (et lisez ses erreurs).`);
  else ok('14b', `app.min.js régénéré (version ${mVer[1]}).`);
}

/* ── 15. Littéraux de rôle : seuil anti-dérive ──────────────────────── */
const SEUIL = Number(process.env.SEUIL_ROLES || 144);
const nbLitteraux = (app.match(/'admin'/g) || []).length;
if (nbLitteraux > SEUIL) {
  warn(15, `${nbLitteraux} littéraux 'admin' (seuil : ${SEUIL}). Utilisez ROLES.ADMIN dans les zones que vous touchez. `
        + `Si la hausse est volontaire : SEUIL_ROLES=${nbLitteraux} node verifier.js`);
} else ok(15, `${nbLitteraux} littéraux 'admin' (seuil : ${SEUIL}) — pas de dérive.`);

/* ── 16. Toute suppression doit être tracée au journal d'audit ──────── */
// VOLET 38. La collection 'auditLog' existait depuis longtemps, mais SEULES
// DEUX suppressions y étaient écrites : les douze autres effaçaient sans
// laisser de trace. Rien ne le signalait — et un journal incomplet qu'on
// croit complet est pire que pas de journal.
// Ce contrôle liste les collections détruites par fbDelete() qui ne sont pas
// déclarées dans _AUDIT_TYPES. Il ne prouve pas que l'appel est bien placé
// (avant la suppression, et bloquant en cas d'échec) — seule la relecture le
// fait — mais il garantit qu'aucune collection n'est oubliée en silence.
{
  const mTypes = app.match(/const\s+_AUDIT_TYPES\s*=\s*\{([\s\S]*?)\n\};/);
  if (!mTypes) {
    warn(16, "_AUDIT_TYPES introuvable dans app.js — couverture du journal d'audit non vérifiable.");
  } else {
    const traces = new Set([...mTypes[1].matchAll(/^\s*([A-Za-z][\w]*)\s*:/gm)].map(m => m[1]));
    // Collections détruites, hors appels dynamiques fbDelete(col, …).
    const detruites = new Set([...app.matchAll(/fbDelete\(\s*['"`]([A-Za-z][\w]*)['"`]/g)].map(m => m[1]));
    // Collections miroir/techniques : supprimées en cascade avec leur parent,
    // déjà tracé. Les signaler serait du bruit.
    const CASCADE = new Set(['commerciauxPrive']);
    const oubliees = [...detruites].filter(c => !traces.has(c) && !CASCADE.has(c));
    if (oubliees.length) {
      ko(16, "Collections supprimées SANS être déclarées dans _AUDIT_TYPES — ces suppressions ne laisseront aucune trace :",
        oubliees.map(c => `fbDelete('${c}', …) (ligne ${ligneDe("fbDelete('" + c + "'")})`));
    } else {
      ok(16, `Les ${detruites.size} collection(s) supprimables sont toutes déclarées au journal d'audit.`);
    }
  }
}

/* ── Bilan ──────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(64));
if (echecs) {
  console.log(`✖ ${echecs} contrôle(s) BLOQUANT(S) en échec` + (avertissements ? `, ${avertissements} avertissement(s).` : '.'));
  console.log('  Corrigez avant de minifier et de déployer.\n');
  process.exit(1);
}
console.log(`✔ Tous les contrôles bloquants passent` + (avertissements ? `, ${avertissements} avertissement(s).` : '.') + '\n');
process.exit(0);
