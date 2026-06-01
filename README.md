# Embarq — Backend

Serveur qui relie le site au paiement Stripe et transmet le bon de commande déposé.

## Parcours
1. Le client dépose son document et clique sur « Payer » → le navigateur envoie le
   fichier + la formule à `POST /api/create-checkout-session`.
2. Le serveur sauvegarde le fichier, crée une **session Stripe Checkout** et renvoie
   l'URL de paiement. Le navigateur redirige le client dessus.
3. Après paiement, Stripe appelle `POST /webhook`. Le serveur envoie alors le document
   par e-mail à l'équipe (`ADMIN_EMAIL`) et un accusé de réception au client.

## Installation
```bash
npm install
cp .env.example .env      # puis remplissez vos clés
npm start
```
Placez `index.html`, `formule-pdf.html`, `formule-premium.html` (et leurs images)
dans le dossier `public/`. Ils seront servis sur http://localhost:4242.

## Configurer le webhook Stripe
En local, avec la CLI Stripe :
```bash
stripe listen --forward-to localhost:4242/webhook
```
La commande affiche un secret `whsec_...` → à mettre dans `STRIPE_WEBHOOK_SECRET`.

En production : Dashboard Stripe → Développeurs → Webhooks → ajouter l'endpoint
`https://votre-domaine/webhook` en écoutant l'événement `checkout.session.completed`.

## Variables (.env)
| Variable | Rôle |
|---|---|
| STRIPE_SECRET_KEY | Clé secrète Stripe (sk_test_… ou sk_live_…) |
| STRIPE_WEBHOOK_SECRET | Secret de signature du webhook |
| PRICE_PDF / PRICE_PREMIUM | IDs de prix des deux formules |
| PUBLIC_URL | URL publique (retours de paiement) |
| SMTP_* / MAIL_FROM / ADMIN_EMAIL | Envoi des e-mails |

## Sécurité
- Le secret Stripe et les identifiants SMTP restent **côté serveur** (jamais dans le HTML).
- Les fichiers sont stockés dans `uploads/` ; pensez à les purger régulièrement
  (RGPD) une fois la commande traitée.
- Limite : 15 Mo par fichier, 10 fichiers max.
