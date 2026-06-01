// ============================================================
//  Embarq — Backend (Express + Stripe + Multer + Nodemailer)
//  Parcours :
//   1. Le client dépose son bon de commande -> POST /api/create-checkout-session
//      (le fichier est sauvegardé, une session Stripe Checkout est créée)
//   2. Stripe redirige le client vers la page de paiement
//   3. Après paiement, Stripe appelle POST /webhook
//      -> on envoie le document par e-mail (à l'équipe + accusé au client)
// ============================================================

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Catalogue des formules (les price_ proviennent de votre dashboard Stripe) ----
const PLANS = {
  pdf: {
    label: 'Formule PDF',
    price: process.env.PRICE_PDF,        // price_... (29,99 €)
  },
  premium: {
    label: 'Impression premium',
    price: process.env.PRICE_PREMIUM,    // price_... (59,99 €)
  },
};

// ---- Stockage des fichiers déposés ----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const safe = file.originalname.replace(/[^\w.\-]/g, '_').slice(-80);
    cb(null, `${id}__${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 }, // 15 Mo / fichier, 10 max
});

// ---- E-mail (SMTP) ----
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE) === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const app = express();

// IMPORTANT : le webhook a besoin du corps brut -> on le déclare AVANT express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature webhook invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await handlePaidOrder(session);
    } catch (e) {
      console.error('Traitement commande échoué :', e);
      // On répond 200 quand même pour éviter les renvois en boucle de Stripe ;
      // l'erreur est loggée pour reprise manuelle.
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Création de la session de paiement ----
app.post('/api/create-checkout-session', upload.array('documents', 10), async (req, res) => {
  try {
    const plan = PLANS[req.body.plan];
    if (!plan || !plan.price) return res.status(400).json({ error: 'Formule inconnue.' });
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'Aucun document fourni.' });

    const fileNames = req.files.map((f) => f.filename).join(',');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: plan.price, quantity: 1 }],
      success_url: `${process.env.PUBLIC_URL}/${req.body.plan === 'premium' ? 'formule-premium.html' : 'formule-pdf.html'}?paiement=succes`,
      cancel_url: `${process.env.PUBLIC_URL}/${req.body.plan === 'premium' ? 'formule-premium.html' : 'formule-pdf.html'}?paiement=annule`,
      customer_email: req.body.email || undefined,
      metadata: {
        plan: req.body.plan,
        plan_label: plan.label,
        files: fileNames,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Création de la session impossible.' });
  }
});

// ---- Envoi du document après paiement ----
async function handlePaidOrder(session) {
  const files = (session.metadata?.files || '').split(',').filter(Boolean);
  const attachments = files.map((name) => ({
    filename: name.split('__').slice(1).join('__') || name,
    path: path.join(UPLOAD_DIR, name),
  }));

  const label = session.metadata?.plan_label || 'Commande';
  const customer = session.customer_details?.email || session.customer_email;

  // 1) Notification interne avec le(s) document(s) en pièce jointe
  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: `Nouvelle commande Embarq — ${label}`,
    text: `Formule : ${label}\nClient : ${customer || 'non renseigné'}\nMontant : ${(session.amount_total / 100).toFixed(2)} ${session.currency?.toUpperCase()}\nSession : ${session.id}`,
    attachments,
  });

  // 2) Accusé de réception au client
  if (customer) {
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: customer,
      subject: 'Embarq — votre commande est bien reçue ✈️',
      text: `Merci pour votre confiance !\n\nNous avons bien reçu votre document et votre paiement pour la « ${label} ». Votre itinéraire de voyage vous sera transmis sous 24 h.\n\nL'équipe Embarq`,
    });
  }
}

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Embarq server en écoute sur http://localhost:${PORT}`));
