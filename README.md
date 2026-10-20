# electron-outlook

Outlook web (Microsoft 365) dans sa propre fenêtre sous Linux, avec l'**Electron des dépôts Arch**.
Fait pour KDE Plasma, où une PWA Chromium ne peut pas afficher le nombre de non-lus sur son icône.

## Ce que ça apporte par rapport à la PWA Chromium

| | PWA Chromium | electron-outlook |
|---|---|---|
| Bulle de non-lus sur l'icône de la barre des tâches | ❌ (Chromium ignore l'API Badging sous Linux) | ✅ |
| Fond orange du bouton à l'arrivée d'un nouveau mail | ❌ | ✅ |
| Icône dans la zone de notification, avec infobulle « n non lus » | ❌ | ✅ |
| Fermer la fenêtre = la réduire (bouton, bulle et notifications restent), sans bloquer la déconnexion | ❌ | ✅ |
| Démarrage avec la session, réduit | à la main | ✅ (`install.sh`) |
| Propre icône et regroupement correct dans la barre des tâches | variable | ✅ |
| Correctifs de sécurité du moteur | pacman (`chromium`) | pacman (`electron`) |

## Installation

```bash
sudo pacman -S --needed electron glib2
git clone <ce dépôt> ~/Projets/_perso/electron-outlook
~/Projets/_perso/electron-outlook/install.sh            # avec démarrage automatique
~/Projets/_perso/electron-outlook/install.sh --sans-demarrage
~/Projets/_perso/electron-outlook/install.sh --desinstaller
```

`install.sh` ne demande aucun droit admin. Il crée `~/.local/share/applications/electron-outlook.desktop`,
installe les icônes dans `~/.local/share/icons/hicolor` et, sauf `--sans-demarrage`,
`~/.config/autostart/electron-outlook.desktop` (lancement réduit, option `--masquee`).
Le lanceur pointe vers le dossier du dépôt : relancer `install.sh` si le dossier est déplacé.

Au premier lancement, se connecter avec son compte Microsoft. Pour les notifications de bureau :
Outlook → *Paramètres → Général → Notifications* → activer les notifications de bureau.

## Fonctionnement

- **Bulle** : la barre des tâches de Plasma affiche le compteur reçu par le signal D-Bus
  `com.canonical.Unity.LauncherEntry.Update` pour `application://electron-outlook.desktop`.
  L'application l'émet avec `gdbus` (paquet `glib2`), sans dépendance npm. `app.setBadgeCount`
  d'Electron ne le fait que sous Unity. La couleur de la bulle est la couleur d'accentuation du thème.
- **Compteur** : `preload.js` lit toutes les 3 s le titre du dossier Boîte de réception dans le volet des
  dossiers (`[data-folder-name="boîte de réception"]`, ou `inbox` en anglais : « … (1 non lus) »).
  En secours, si le volet est introuvable, il reprend l'API Badging d'Outlook (`navigator.setAppBadge`).
  Celle-ci compte seulement les nouveaux messages depuis la dernière visite, et Outlook la remet à 0
  dès que la fenêtre est vue.
- **Fond orange** : quand le nombre de non-lus augmente et que la fenêtre n'est pas au premier plan,
  la fenêtre est marquée « demande l'attention ». `BrowserWindow.flashFrame` ne fait rien sous Wayland :
  l'application charge un petit script KWin par D-Bus (`org.kde.KWin /Scripting`), qui met
  `demandsAttention` à vrai. KWin le retire quand la fenêtre est activée. La couleur (orange) est celle
  des avertissements du jeu de couleurs (`NeutralText`), pas l'accentuation. Le premier relevé au
  lancement sert de point de départ : pas de fond orange au démarrage.
- **Fermer, c'est réduire** : une fenêtre cachée n'aurait plus de bouton dans la barre des tâches, donc
  ni bulle ni fond orange. Au démarrage de la session (`--masquee`), la fenêtre s'ouvre réduite.
  Pour quitter : clic droit sur l'icône de la zone de notification → *Quitter*.
  Sauf à la déconnexion ou à l'extinction : KWin demande alors à chaque fenêtre de se fermer, et une
  fenêtre qui se réduit bloque la fin de session (« Les applications suivantes n'ont pas été fermées »,
  déconnexion forcée au bout de 2 minutes). À chaque demande de fermeture, l'application interroge donc
  ksmserver par D-Bus (`org.kde.KSMServerInterface.isShuttingDown`) : si la session se termine, elle quitte.
- **Couleur de la bulle** : elle suit la couleur d'accentuation, car elle est compilée dans Plasma
  (`TaskBadgeOverlay`, paquet `plasma-desktop`) ; aucun réglage ne la change seule.
- **Fenêtre reconnue par KDE** : `app.setDesktopName('electron-outlook.desktop')` donne l'identifiant
  Wayland `electron-outlook`, le nom du lanceur.
- **Liens** : les fenêtres ouvertes vers un domaine Microsoft (connexion, message détaché) restent dans
  l'application ; les autres liens s'ouvrent dans le navigateur par défaut.
- **Identité du navigateur** : `Electron/…` est retiré de l'User-Agent, comme pour un Chrome ordinaire.
- **Sécurité** : `contextIsolation`, `sandbox`, pas de `nodeIntegration`. Seules les permissions
  notifications, presse-papiers et plein écran sont accordées, et seulement aux domaines Microsoft.
- **Données** : session, cache et taille de la fenêtre dans `~/.config/electron-outlook`.

## Diagnostic

```bash
ELECTRON_OUTLOOK_DEBUG=1 electron ~/Projets/_perso/electron-outlook
```
Affiche les titres de page, les non-lus reçus (source `dossier` ou `badge`), les permissions et les liens.

Si la bulle ne bouge plus après une mise à jour d'Outlook, c'est sans doute que l'attribut
`data-folder-name` ou le format du titre du dossier a changé : adapter `SELECTEUR` et `NON_LUS` dans `preload.js`.

## Licence

Code : MIT (`LICENSE`). Icône : `ms-outlook.svg` du thème Qogir (paquet EndeavourOS `eos-qogir-icons`), GPL-3.0 (`icones/LICENSE`).
Outlook et Microsoft 365 sont des marques de Microsoft ; ce projet personnel n'a aucun lien avec Microsoft.
