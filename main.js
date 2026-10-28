'use strict';
// electron-outlook : Outlook web dans sa propre fenêtre, avec l'Electron des dépôts Arch.
// Apports par rapport à la PWA Chromium : bulle de non-lus sur l'icône de la barre des tâches (KDE),
// fond orange à l'arrivée d'un mail, icône dans la zone de notification, fermeture = réduction (sauf en fin de session),
// lancement réduit avec la session.
const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, session, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NOM = 'electron-outlook';
const URL_ACCUEIL = 'https://outlook.cloud.microsoft/mail/';
const PARTITION = 'persist:outlook';
const DEBUG = process.env.ELECTRON_OUTLOOK_DEBUG === '1';
const ICONE = path.join(__dirname, 'icones', `${NOM}-64.png`);
const ICONE_ZONE = path.join(__dirname, 'icones', `${NOM}-32.png`);
// Données (session Microsoft, cache, fenêtre) dans ~/.config/electron-outlook, et non ~/.config/Outlook.
app.setPath('userData', path.join(app.getPath('appData'), NOM));
const FICHIER_FENETRE = path.join(app.getPath('userData'), 'fenetre.json');

// Domaines Microsoft gardés dans l'application (Outlook, connexion, fenêtres détachées).
// Tout autre lien qui ouvre une nouvelle fenêtre part dans le navigateur par défaut.
const DOMAINES_MICROSOFT = [
  'cloud.microsoft', 'office.com', 'office365.com', 'outlook.com', 'live.com',
  'microsoftonline.com', 'microsoft.com', 'msauth.net', 'msftauth.net',
];
const PERMISSIONS = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

const log = (...a) => { if (DEBUG) console.log('[electron-outlook]', ...a); };

function estMicrosoft(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && DOMAINES_MICROSOFT.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

// Liens des mails réécrits par Microsoft Defender (*.safelinks.protection.outlook.com?url=…) : domaine
// Microsoft, mais destination externe.
function estSafeLinks(url) {
  try { return new URL(url).hostname.endsWith('.safelinks.protection.outlook.com'); } catch { return false; }
}
// Adresse réelle d'un lien Safe Links, pour la copie.
function lienReel(url) {
  try { return estSafeLinks(url) ? new URL(url).searchParams.get('url') || url : url; } catch { return url; }
}

function ouvrirDansNavigateur(url) {
  log('navigateur :', url);
  if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
}

// Menu contextuel (Electron n'en a aucun par défaut) : liens, texte sélectionné, champs de saisie.
function menuContextuel(wc, p) {
  const modele = [];
  if (/^(https?|mailto):/.test(p.linkURL)) {
    modele.push(
      { label: 'Ouvrir le lien dans le navigateur', click: () => ouvrirDansNavigateur(p.linkURL) },
      { label: "Copier l'adresse du lien", click: () => clipboard.writeText(lienReel(p.linkURL).replace(/^mailto:/, '')) },
    );
  }
  if (p.isEditable && p.misspelledWord) {
    if (modele.length) modele.push({ type: 'separator' });
    for (const mot of p.dictionarySuggestions.slice(0, 5)) {
      modele.push({ label: mot, click: () => wc.replaceMisspelling(mot) });
    }
    modele.push({ label: 'Ajouter au dictionnaire', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
  }
  if (p.isEditable || p.selectionText.trim()) {
    if (modele.length) modele.push({ type: 'separator' });
    if (p.isEditable) modele.push({ label: 'Couper', role: 'cut', enabled: p.editFlags.canCut });
    modele.push({ label: 'Copier', role: 'copy', enabled: p.editFlags.canCopy });
    if (p.isEditable) modele.push({ label: 'Coller', role: 'paste', enabled: p.editFlags.canPaste });
  }
  if (modele.length) Menu.buildFromTemplate(modele).popup({ window: BrowserWindow.fromWebContents(wc) });
}

// Le WM_CLASS / app_id Wayland doit valoir « electron-outlook » pour que KDE relie la fenêtre
// à electron-outlook.desktop (icône, regroupement, bulle).
app.setName(NOM);
app.setDesktopName(`${NOM}.desktop`);
// Microsoft n'aime pas les navigateurs inconnus : on se présente comme un Chrome ordinaire.
app.userAgentFallback = app.userAgentFallback.replace(/ (electron-outlook|Outlook|Electron)\/\S+/g, '');

if (!app.requestSingleInstanceLock()) app.exit(0);

let fenetre = null;
let zone = null;
let quitter = false;
let nonLus = -1;

function gdbus(args, rappel) {
  execFile('gdbus', args, (err, sortie) => {
    if (err) console.error('[electron-outlook] gdbus :', err.message);
    else if (rappel) rappel(sortie);
  });
}

// --- Déconnexion ou extinction : KWin demande à chaque fenêtre de se fermer, puis attend.
// Ce n'est pas le moment de réduire : la fenêtre resterait et KWin afficherait « Les applications
// suivantes n'ont pas été fermées », avec une déconnexion forcée au bout de 2 minutes.
// ksmserver répond isShuttingDown = true pendant toute la fin de session (false hors KDE ou en cas d'erreur).
function finDeSession(rappel) {
  execFile('gdbus', ['call', '--session', '--dest', 'org.kde.ksmserver', '--object-path', '/KSMServer',
    '--method', 'org.kde.KSMServerInterface.isShuttingDown'], { timeout: 2000 },
  (err, sortie) => rappel(!err && /true/.test(sortie)));
}

// --- Script KWin chargé par D-Bus, exécuté une fois puis déchargé : sous Wayland, une application ne peut
// ni faire clignoter son bouton ni se remettre d'elle-même au premier plan.
function scriptKWin(nom, code) {
  const script = path.join(app.getPath('userData'), `${nom}.js`);
  fs.writeFileSync(script, code);
  const kwin = ['call', '--session', '--dest', 'org.kde.KWin'];
  const nomScript = `${NOM}-${nom}`;
  gdbus([...kwin, '--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.unloadScript', nomScript], () => {
    gdbus([...kwin, '--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.loadScript', script, nomScript], (sortie) => {
      const id = /-?\d+/.exec(sortie)?.[0];
      if (!id || id === '-1') return;
      gdbus([...kwin, '--object-path', `/Scripting/Script${id}`, '--method', 'org.kde.kwin.Script.run'], () => {
        gdbus([...kwin, '--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.unloadScript', nomScript]);
      });
    });
  });
}

// --- Fond orange du bouton dans la barre des tâches (« demande l'attention ») : flashFrame d'Electron ne fait rien
// sous Wayland. KWin retire l'état tout seul quand la fenêtre est activée.
function demanderAttention() {
  scriptKWin('attention', `for (const w of workspace.windowList())
  if (w.desktopFileName === '${NOM}' && !w.active) w.demandsAttention = true;\n`);
}

// --- Premier plan : sous Wayland, restore() et focus() d'Electron laissent la fenêtre réduite (KWin ne rend
// pas la main à une application qui la demande sans jeton d'activation). La fenêtre principale est la première
// de l'application dans la liste de KWin, rangée par ordre de création : son titre change avec la page affichée.
function activerFenetre() {
  scriptKWin('activation', `for (const w of workspace.windowList())
  if (w.desktopFileName === '${NOM}') { w.minimized = false; workspace.activeWindow = w; break; }\n`);
}

// --- Bulle : signal com.canonical.Unity.LauncherEntry, que la barre des tâches de Plasma affiche.
// Fond orange en plus quand le nombre augmente (nouveau mail) et que la fenêtre n'est pas au premier plan.
function majNonLus(n, initial = false) {
  n = Math.max(0, Math.trunc(n) || 0);
  const hausse = !initial && n > nonLus;
  if (n === nonLus) return;
  nonLus = n;
  log('non-lus :', n, hausse ? '(nouveau)' : '');
  if (hausse && fenetre && !fenetre.isFocused()) demanderAttention();
  const proprietes = n > 0 ? `{'count': <int64 ${n}>, 'count-visible': <true>}` : "{'count-visible': <false>}";
  gdbus(['emit', '--session', '--object-path', '/com/canonical/unity/launcherentry/1',
    '--signal', 'com.canonical.Unity.LauncherEntry.Update', `application://${NOM}.desktop`, proprietes]);
  if (zone) zone.setToolTip(n > 0 ? `Outlook — ${n} non lu${n > 1 ? 's' : ''}` : 'Outlook');
}

// --- Taille et position de la fenêtre, retenues d'une session à l'autre.
function lireEtatFenetre() {
  try { return JSON.parse(fs.readFileSync(FICHIER_FENETRE, 'utf8')); } catch { return { width: 1400, height: 900 }; }
}
function enregistrerEtatFenetre() {
  if (!fenetre || fenetre.isMinimized()) return;
  const etat = { ...fenetre.getNormalBounds(), maximise: fenetre.isMaximized() };
  try { fs.writeFileSync(FICHIER_FENETRE, JSON.stringify(etat)); } catch { /* sans importance */ }
}

function afficher() {
  if (!fenetre) return;
  if (fenetre.isMinimized()) fenetre.restore();
  fenetre.show();
  fenetre.focus();
  activerFenetre();
}

function creerFenetre(masquee) {
  const etat = lireEtatFenetre();
  fenetre = new BrowserWindow({
    ...etat,
    show: false,
    title: 'Outlook',
    icon: ICONE,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1b',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (etat.maximise) fenetre.maximize();
  // Au démarrage de la session (--masquee) : fenêtre réduite, pour garder son bouton et sa bulle.
  fenetre.once('ready-to-show', () => {
    if (masquee) { fenetre.showInactive(); fenetre.minimize(); } else fenetre.show();
  });

  const wc = fenetre.webContents;

  // Nouvelles fenêtres : celles de Microsoft (connexion, message détaché) restent ici, le reste va dans le navigateur.
  wc.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || (estMicrosoft(url) && !estSafeLinks(url))) {
      log('fenêtre interne :', url);
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICONE } };
    }
    ouvrirDansNavigateur(url);
    return { action: 'deny' };
  });

  // Fenêtre ouverte vide puis dirigée vers un lien externe (ou Safe Links) : le lien part dans le navigateur
  // et la fenêtre se referme.
  wc.on('did-create-window', (enfant) => {
    enfant.webContents.on('will-navigate', (e) => {
      const depart = enfant.webContents.getURL();
      if (!e.isMainFrame || (depart && depart !== 'about:blank')) return;
      if (estMicrosoft(e.url) && !estSafeLinks(e.url)) return;
      e.preventDefault();
      ouvrirDansNavigateur(e.url);
      enfant.close();
    });
  });

  fenetre.on('close', (e) => {
    enregistrerEtatFenetre();
    if (quitter) return;
    // Réduire plutôt que cacher : le bouton de la barre des tâches (bulle, fond orange) reste visible.
    // Sauf en fin de session, où l'on quitte vraiment.
    e.preventDefault();
    finDeSession((oui) => {
      if (!oui) { if (fenetre && !fenetre.isDestroyed()) fenetre.minimize(); return; }
      log('fin de session : fermeture');
      quitter = true;
      app.quit();
    });
  });
  fenetre.on('resize', enregistrerEtatFenetre);
  fenetre.on('move', enregistrerEtatFenetre);

  wc.loadURL(URL_ACCUEIL);

}

function creerZoneNotification() {
  zone = new Tray(ICONE_ZONE);
  zone.setToolTip('Outlook');
  zone.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher Outlook', click: afficher },
    { label: 'Recharger', click: () => fenetre && fenetre.webContents.reload() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitter = true; app.quit(); } },
  ]));
  zone.on('click', () => (fenetre && fenetre.isVisible() && !fenetre.isMinimized() && fenetre.isFocused() ? fenetre.minimize() : afficher()));
}

app.on('second-instance', afficher);
// Clic sur une notification : Outlook ouvre le message dans la page, la fenêtre passe au premier plan.
ipcMain.on('notification-cliquee', () => { log('notification cliquée'); afficher(); });
app.on('web-contents-created', (e, wc) => wc.on('context-menu', (ev, p) => menuContextuel(wc, p)));
app.on('before-quit', () => { quitter = true; });

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(app.userAgentFallback);
  ses.setSpellCheckerLanguages(['fr', 'en-US']);
  ses.setPermissionRequestHandler((wc, permission, rappel, details) => {
    const ok = PERMISSIONS.has(permission) && estMicrosoft(details.requestingUrl || wc.getURL());
    log('permission', permission, ok ? 'accordée' : 'refusée');
    rappel(ok);
  });

  // Compteur du dossier Boîte de réception en priorité ; badge d'Outlook seulement quand le dossier est introuvable.
  // Le premier relevé de chaque source sert de point de départ (pas de fond orange au lancement).
  let dossierTrouve = false;
  const sourcesVues = new Set();
  ipcMain.on('non-lus', (e, { source, n }) => {
    if (!fenetre || e.sender !== fenetre.webContents) return;
    log('non-lus reçus :', source, n);
    if (n === null) { if (source === 'dossier') dossierTrouve = false; return; }
    if (source === 'dossier') dossierTrouve = true;
    else if (dossierTrouve) return;
    const initial = !sourcesVues.has(source);
    sourcesVues.add(source);
    majNonLus(n, initial);
  });

  creerZoneNotification();
  creerFenetre(process.argv.includes('--masquee'));
  majNonLus(0, true);
});
