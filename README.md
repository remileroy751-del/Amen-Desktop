# AMEN CONNECT Admin — version bureau (Windows 10 / 11)

Application de bureau du **Collège AMEN** : l'interface Super Admin Direction d'AMEN-CONNECT
(tableau de bord, élèves & parents, enseignants, classes & matières, notes, messages, administration),
empaquetée avec Electron. Elle utilise la même base Supabase que l'application mobile.

> Les données restent sur Supabase, mais l'application **fonctionne aussi sans Internet** (voir « Mode hors connexion » ci-dessous).

## Obtenir l'exécutable avec GitHub (sans rien installer sur votre PC)

1. Créez un dépôt GitHub (privé de préférence) et envoyez-y **tout le contenu de ce dossier**,
   y compris le dossier caché `.github` (via *GitHub Desktop* ou `git push`).
   Si vous utilisez l'envoi par navigateur et que `.github` n'apparaît pas, créez le fichier
   `.github/workflows/build-windows.yml` avec « Add file > Create new file » et collez son contenu.
2. Onglet **Actions** > « Build AMEN CONNECT Admin (Windows) » > **Run workflow**
   (ou simplement un `push` sur la branche `main`).
3. Une fois terminé (environ 3 à 6 minutes), ouvrez l'exécution et téléchargez l'artefact
   **AMEN-CONNECT-Admin-Windows** (un zip) en bas de la page. Il contient :
   - `AMEN-CONNECT-Admin-Setup-1.1.0.exe` : installateur (choix du dossier, raccourcis Bureau et menu Démarrer) ;
   - `AMEN-CONNECT-Admin-Portable-1.1.0.exe` : version portable, sans installation.

Pour publier une version téléchargeable dans l'onglet *Releases* : créez un tag, par exemple `v1.0.0`
(`git tag v1.0.0 && git push --tags`). Pensez à mettre le même numéro dans `package.json` (`"version"`).

## Tester sur un PC de développement

```
npm install
npm start          # lance l'application
npm run dist       # génère les exécutables dans dist/
```
(Node.js 20 ou plus requis.)

## Ce qui a été adapté par rapport à `admin/index.html`

- Même interface et mêmes fonctions ; bibliothèques Supabase et jsPDF **embarquées** (secours CDN si besoin).
- `prompt()` n'existe pas dans Electron : le mot de passe Direction demandé à la création d'une classe
  s'affiche maintenant dans une fenêtre intégrée, **avec saisie masquée**.
- Correctif Windows du focus des champs après les messages `alert` / `confirm`.
- Export PDF des codes d'accès : boîte « Enregistrer sous » puis ouverture du dossier du fichier.
- Impression des codes (fenêtre de secours) autorisée ; liens externes ouverts dans le navigateur.
- Menu en français, zoom (Ctrl +/−/0), plein écran (F11), instance unique, mémorisation de la taille de la fenêtre.
- Bandeau d'alerte si la connexion Internet est coupée.
- Icône : logo du Collège AMEN (`build/icon.ico`).

## Mode hors connexion (v1.1)

**Principe** : à chaque lecture réussie, les données sont copiées sur le PC (IndexedDB). Sans Internet, l'application
affiche ces copies. Les saisies faites hors ligne (parents, élèves, enseignants, affectations, matières, messages,
suppressions, nouveaux codes…) sont rangées dans une **file d'attente** enregistrée sur le disque, visibles tout de suite
à l'écran, puis **envoyées automatiquement et dans l'ordre** à Supabase dès que la connexion revient
(vérification toutes les 15 secondes). La file survit à la fermeture de l'application ou du PC.

**Indicateur** (bouton en bas à gauche) : `● En ligne · à jour` / `● Hors connexion · N en attente` /
`⟳ Synchronisation en cours…` / `⚠ N modification(s) en erreur`. Un clic ouvre la liste des modifications en attente,
avec « Synchroniser maintenant » et « Abandonner » pour celles refusées par le serveur.

**À savoir**
- **Première utilisation** : se connecter au moins une fois **avec Internet** sur le PC (cela charge les données et
  mémorise une empreinte sécurisée du mot de passe). Ensuite la connexion hors ligne fonctionne (valable 30 jours
  après la dernière connexion en ligne).
- **Codes d'accès** : ils sont générés par le serveur. Un parent ou un enseignant créé hors ligne apparaît tout de suite,
  avec le code « ⏳ généré à la synchronisation » ; **les vrais codes s'affichent dans une fenêtre dès la synchronisation**
  (et restent dans « Codes d'accès »). Idem pour « Nouveau code ».
- **Création de classe** : impossible hors connexion (le mot de passe Direction est vérifié par le serveur).
- **Messagerie Parents/Enseignants** : consultation seulement, avec les dernières données chargées.
- **Conflits** : les modifications sont rejouées dans l'ordre ; si le serveur en refuse une (ex. élément supprimé entre-temps),
  elle passe en « erreur » sans bloquer les autres. Les notes saisies par les enseignants sur mobile arrivent à la
  prochaine ouverture en ligne.
- **Session expirée** : si Supabase demande une nouvelle authentification au moment de synchroniser, le mot de passe
  est redemandé (il n'est jamais enregistré en clair).
- **Données locales** : elles sont stockées dans le profil Windows de l'utilisateur. Sur un PC partagé, utilisez
  « Déconnexion » en fin de journée.
- Test automatique de la logique : `npm test` (aucune dépendance requise).

## Remarques

- **Avertissement SmartScreen** : l'exécutable n'est pas signé numériquement. Au premier lancement,
  Windows peut afficher « Windows a protégé votre ordinateur » : cliquez sur *Informations complémentaires*
  puis *Exécuter quand même*. Un certificat de signature de code supprime cet avertissement.
- La clé Supabase *publishable* est intégrée dans `renderer/index.html` (usage client, comme dans la version web).
  Ne mettez jamais de clé `service_role` dans le dépôt.
- Pour changer de version Electron ou de dépendances, modifiez `package.json`.
