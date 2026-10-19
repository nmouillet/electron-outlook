'use strict';
// Remonte à main.js le nombre de non-lus, par deux moyens :
// 1. le compteur de la Boîte de réception dans le volet des dossiers (source principale) ;
// 2. l'API Badging (navigator.setAppBadge), que Chromium n'affiche pas sous Linux. Outlook s'en sert
//    pour les « nouveaux messages depuis la dernière visite » et la remet à 0 dès que la fenêtre est vue :
//    elle ne sert qu'en secours, quand le volet des dossiers est absent.
const { contextBridge, ipcRenderer } = require('electron');

// Dossier Boîte de réception (nom en minuscules, selon la langue d'Outlook).
const SELECTEUR = ['boîte de réception', 'inbox'].map((n) => `[role=treeitem][data-folder-name="${n}"]`).join(',');
// Titre : « Boîte de réception - éléments 4 543 (1 non lus) » ou « Inbox - 4,543 items (1 unread) ».
const NON_LUS = /\(([\d\s  .,]+)\s(?:non lu|unread)/i;

let dernier = null;
setInterval(() => {
  const dossier = document.querySelector(SELECTEUR);
  let n = null;
  if (dossier) {
    const m = NON_LUS.exec(dossier.getAttribute('title') || '');
    n = m ? Number(m[1].replace(/\D/g, '')) : 0;
  }
  if (n !== dernier) {
    dernier = n;
    ipcRenderer.send('non-lus', { source: 'dossier', n });
  }
}, 3000);

window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__electronOutlook === 'badge') {
    ipcRenderer.send('non-lus', { source: 'badge', n: e.data.n });
  }
});

contextBridge.executeInMainWorld({
  func: () => {
    const envoyer = (n) => window.postMessage({ __electronOutlook: 'badge', n }, '*');
    // Sans argument, l'API demande un simple point : on le compte comme 1.
    navigator.setAppBadge = (n) => { envoyer(n === undefined ? 1 : Number(n) || 0); return Promise.resolve(); };
    navigator.clearAppBadge = () => { envoyer(0); return Promise.resolve(); };
  },
});
