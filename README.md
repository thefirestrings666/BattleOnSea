# ⚓ Bataille Navale en ligne

Jeu de bataille navale **pour deux joueurs à distance**, en temps réel, dans le navigateur.
Un joueur crée une partie, envoie le lien (ou le code à 5 caractères) à son adversaire, et c'est parti !

- 🌐 Temps réel via WebSocket, serveur Node.js minimaliste (une seule dépendance : `ws`)
- 🛡️ Serveur arbitre : la position des navires adverses n'est **jamais** envoyée au navigateur avant qu'ils soient coulés (pas de triche possible en inspectant la page)
- 🚢 Placement à la souris / au doigt, rotation (`R` ou clic droit), placement aléatoire
- 🎯 Règle classique : touché ⇒ on rejoue, à l'eau ⇒ la main passe
- 💬 Chat entre les joueurs, 🔊 effets sonores synthétisés, vibrations sur mobile
- 🔄 Reconnexion automatique (rechargement de page, coupure réseau) grâce à un jeton de session
- ⚔️ Revanche en un clic (le premier joueur alterne)
- 📱 Interface responsive (ordinateur et téléphone)

## Lancer en local

Prérequis : Node.js 18 ou plus.

```bash
npm install
npm start
```

Puis ouvrir <http://localhost:3000>. Pour tester seul, ouvre la partie dans deux onglets (ou un onglet normal + un onglet privé).

Variables d'environnement : `PORT` (défaut `3000`), `HOST` (défaut `0.0.0.0`).

## Jouer avec quelqu'un à distance

Le serveur doit être joignable depuis Internet. Plusieurs options :

### Fly.io (recommandé)

Le fichier `fly.toml` est prêt (région Paris, machine qui s'endort quand personne ne joue).

```bash
# 1. Installer flyctl : https://fly.io/docs/flyctl/install/
curl -L https://fly.io/install.sh | sh
# 2. Se connecter (ou créer un compte)
fly auth login
# 3. Créer l'app (le nom doit être unique ; s'il est pris, change-le aussi dans fly.toml)
fly apps create battleonsea
# 4. Déployer — UNE seule machine, car les parties sont en mémoire
fly deploy --ha=false
```

Le jeu est alors en ligne sur `https://battleonsea.fly.dev`.

**Déploiement automatique depuis GitHub (sans terminal)** : crée un jeton d'organisation dans le tableau de bord Fly (*Tokens*) ou avec `fly tokens create org`, ajoute-le dans le dépôt GitHub (*Settings → Secrets and variables → Actions*) sous le nom `FLY_API_TOKEN`. Chaque push sur `main` lance les tests puis déploie (workflow `.github/workflows/fly-deploy.yml`, lançable aussi à la main depuis l'onglet *Actions*). L'app est créée automatiquement au premier déploiement.

> ⚠️ Ne passe pas à plusieurs machines (`fly scale count 1` si besoin) : chaque machine aurait ses propres parties. Un redéploiement interrompt les parties en cours.

### Autres options

- **Render** : pousse ce dépôt sur GitHub, puis sur [render.com](https://render.com) → *New* → *Blueprint* → choisis le dépôt (le fichier `render.yaml` est déjà prêt). Tu obtiens une URL publique `https://….onrender.com` à partager.
- **Docker** (n'importe quel VPS, Fly.io, Railway…) :
   ```bash
   docker build -t bataille-navale .
   docker run -p 3000:3000 bataille-navale
   ```
- **Depuis ton PC, via un tunnel** (le plus rapide pour une partie ponctuelle) :
   ```bash
   npm start
   npx cloudflared tunnel --url http://localhost:3000
   ```
   Cloudflare affiche une URL `https://….trycloudflare.com` : ouvre-la et partage le lien d'invitation.

> Les WebSockets passent par le même port que la page (`/ws`), en `wss://` automatiquement derrière HTTPS.

## Comment jouer

1. Entre ton nom et clique **Créer une partie**.
2. Clique **🔗 Inviter** pour copier le lien et l'envoyer à ton adversaire (ou donne-lui le code).
3. Place tes 5 navires : porte-avions (5), croiseur (4), contre-torpilleur (3), sous-marin (3), torpilleur (2).
4. Clique **Prêt au combat !** La bataille démarre quand les deux flottes sont en place ; le premier joueur est tiré au sort.
5. Tire sur la grille ennemie. Le premier qui coule toute la flotte adverse gagne.

## Structure

```
src/game.js      Règles du jeu (pures, testées) : flotte, placement, tirs, tours, revanche
src/server.js    Serveur HTTP statique + WebSocket, gestion des parties et reconnexions
public/          Client navigateur (HTML/CSS/JS sans framework)
test/            Tests unitaires et d'intégration (node:test)
```

## Tests

```bash
npm test
```

## Protocole WebSocket (résumé)

Client → serveur : `create {name}`, `join {code, name, token?}`, `resume {code, token}`, `place {ships:[{id,x,y,dir}]}`, `unready`, `fire {x,y}`, `chat {text}`, `rematch`, `leave`.

Serveur → client : `joined {code, token}`, `state {state, event?}` (vue personnalisée de la partie), `chat`, `info`, `error`, `resume-failed`, `left`.

Les parties inactives sont supprimées après 30 minutes (5 minutes si plus aucun joueur n'est connecté).
