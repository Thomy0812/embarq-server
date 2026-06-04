// ============================================================
//  Embarq — Backend (Express + Stripe + Multer + Nodemailer)
//   1. POST /api/create-checkout-session : sauvegarde le fichier + crée la session Stripe
//   2. Stripe redirige le client vers le paiement
//   3. POST /webhook : après paiement -> enregistre la commande + envoie les e-mails
//   4. /admin : tableau de bord protégé (commandes + téléchargement des pièces jointes)
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

const PLANS = {
  pdf: { label: 'Formule PDF', price: process.env.PRICE_PDF },
  premium: { label: 'Impression premium', price: process.env.PRICE_PREMIUM },
  pack: { label: 'Pack 10 Roadbooks', price: process.env.PRICE_PACK, noFile: true },
};

// ---- Stockage des fichiers déposés ----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Journal des commandes (pour le tableau de bord admin) ----
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function readOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveOrder(order) {
  const orders = readOrders();
  orders.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const safe = file.originalname.replace(/[^\w.\-]/g, '_').slice(-80);
    cb(null, id + '__' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

// ---- E-mail (SMTP) ----
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE) === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const app = express();

// Le webhook a besoin du corps brut -> déclaré AVANT express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide :', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  if (event.type === 'checkout.session.completed') {
    try { await handlePaidOrder(event.data.object); }
    catch (e) { console.error('Traitement commande échoué :', e); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/order-amount', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    res.json({
      amount: (session.amount_total / 100).toFixed(2),
      currency: (session.currency || 'eur').toUpperCase(),
      plan: session.metadata?.plan_label || 'Commande',
    });
  } catch (e) {
    res.json({});
  }
});

app.post('/api/create-checkout-session', upload.array('documents', 10), async (req, res) => {
  try {
    const plan = PLANS[req.body.plan];
    if (!plan || !plan.price) return res.status(400).json({ error: 'Formule inconnue.' });
    if (!plan.noFile && (!req.files || req.files.length === 0)) return res.status(400).json({ error: 'Aucun document fourni.' });
    const fileNames = req.files.map((f) => f.filename).join(',');
    const pages = { premium: 'formule-premium.html', pack: 'formule-pack.html', pdf: 'formule-pdf.html' };
    const page = pages[req.body.plan] || 'formule-pdf.html';
    const lineItems = [{ price: plan.price, quantity: 1 }];
    const printQty = Math.max(0, Math.min(100, parseInt(req.body.print_qty, 10) || 0));
    if (printQty > 0 && process.env.PRICE_IMPRESSION) {
      lineItems.push({ price: process.env.PRICE_IMPRESSION, quantity: printQty });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: process.env.PUBLIC_URL + '/merci.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.PUBLIC_URL + '/' + page + '?paiement=annule',
      customer_email: req.body.email || undefined,
      metadata: {
        plan: req.body.plan,
        plan_label: plan.label,
        files: fileNames,
        customer_name: (req.body.name || '').slice(0, 200),
        customer_phone: (req.body.phone || '').slice(0, 60),
        note: (req.body.note || '').slice(0, 480),
        print_qty: String(printQty),
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Création de la session impossible.' });
  }
});

async function handlePaidOrder(session) {
  const files = (session.metadata?.files || '').split(',').filter(Boolean);
  const attachments = files.map((name) => ({
    filename: name.split('__').slice(1).join('__') || name,
    path: path.join(UPLOAD_DIR, name),
  }));
  const label = session.metadata?.plan_label || 'Commande';
  const customer = session.customer_details?.email || session.customer_email;
  const cname = session.metadata?.customer_name || '';
  const cphone = session.metadata?.customer_phone || '';
  const note = session.metadata?.note || '';
  const printQty = session.metadata?.print_qty || '0';

  // 0) Enregistrement dans le journal (tableau de bord)
  saveOrder({
    id: session.id,
    date: new Date().toISOString(),
    plan: session.metadata?.plan || '',
    plan_label: label,
    customer: customer || '',
    name: cname,
    phone: cphone,
    note: note,
    print_qty: printQty,
    amount: (session.amount_total / 100).toFixed(2),
    currency: (session.currency || 'eur').toUpperCase(),
    files: files.map((name) => ({ stored: name, original: name.split('__').slice(1).join('__') || name })),
  });

  // 1) Notification interne avec pièce(s) jointe(s)
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.ADMIN_EMAIL,
      subject: 'Nouvelle commande Embarq — ' + label,
      text: 'Formule : ' + label
        + '\nNom : ' + (cname || 'non renseigné')
        + '\nTéléphone : ' + (cphone || 'non renseigné')
        + '\nE-mail : ' + (customer || 'non renseigné')
        + '\nNote : ' + (note || '—')
        + '\nImpressions : ' + printQty + ' x 25 EUR'
        + '\nMontant : ' + (session.amount_total / 100).toFixed(2) + ' ' + (session.currency || '').toUpperCase()
        + '\nSession : ' + session.id,
      attachments,
    });
  } catch (e) { console.error('E-mail interne échoué :', e.message); }

  // 2) Accusé de réception au client
  if (customer) {
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM,
        to: customer,
        subject: 'Embarq — votre commande est bien reçue',
        text: 'Merci pour votre confiance !\n\nNous avons bien reçu votre document et votre paiement pour la « ' + label + ' ». Votre itinéraire de voyage vous sera transmis sous 72 h.\n\nL\'équipe Embarq',
      });
    } catch (e) { console.error('E-mail client échoué :', e.message); }
  }
}

// ============================================================
//  TABLEAU DE BORD ADMIN  (/admin)
// ============================================================
function adminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) return res.status(500).send('ADMIN_PASSWORD non configuré.');
  const [type, creds] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && creds) {
    const [user, pass] = Buffer.from(creds, 'base64').toString().split(':');
    if (user === expectedUser && pass === expectedPass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Embarq Admin"');
  return res.status(401).send('Authentification requise.');
}

app.get('/admin/orders', adminAuth, (req, res) => res.json(readOrders()));

app.get('/admin/file/:name', adminAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Fichier introuvable (peut-être purgé).');
  res.download(filePath, name.split('__').slice(1).join('__') || name);
});

app.get('/admin', adminAuth, (req, res) => res.type('html').send(ADMIN_HTML));

const ADMIN_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Embarq — Commandes</title><style>
:root{--sand:#F4EEE3;--ink:#1C2B33;--ink-soft:#465863;--teal:#0E5C63}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:var(--sand);color:var(--ink);padding:28px}
h1{font-family:Georgia,serif;font-size:28px;margin-bottom:4px}
.sub{color:var(--ink-soft);margin-bottom:24px;font-size:14px}
.bar{display:flex;gap:12px;margin-bottom:18px}
.bar input{flex:1;max-width:320px;padding:10px 14px;border:1px solid #d9d2c4;border-radius:10px}
.btn{background:var(--teal);color:#fff;border:none;padding:10px 16px;border-radius:10px;cursor:pointer}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden}
th,td{text-align:left;padding:14px 16px;font-size:14px;border-bottom:1px solid #eee}
th{background:#fbf8f1;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft)}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#eef4f3;color:var(--teal)}
.pill.prem{background:#fbf2dd;color:#9a7320}
.file{display:inline-block;margin:2px 6px 2px 0;padding:6px 12px;background:var(--teal);color:#fff;border-radius:8px;text-decoration:none;font-size:13px}
.empty{padding:40px;text-align:center;color:var(--ink-soft)}
.amount{font-family:Georgia,serif;font-weight:600}
</style></head><body>
<h1>Commandes Embarq</h1>
<div class="sub">Tableau de bord interne — chaque commande payée et ses documents à télécharger.</div>
<div class="bar"><input id="q" placeholder="Rechercher (client, formule)"><button class="btn" onclick="load()">Actualiser</button></div>
<div id="wrap"></div>
<script>
async function load(){
  try{
    const r=await fetch('/admin/orders');const orders=await r.json();
    const q=(document.getElementById('q').value||'').toLowerCase();
    const list=orders.filter(function(o){return JSON.stringify(o).toLowerCase().includes(q);});
    const wrap=document.getElementById('wrap');
    if(!list.length){wrap.innerHTML='<div class="empty">Aucune commande pour le moment.</div>';return;}
    var h='<table><thead><tr><th>Date</th><th>Formule</th><th>Contact</th><th>Note</th><th>Montant</th><th>Documents</th></tr></thead><tbody>';
    for(var i=0;i<list.length;i++){
      var o=list[i];
      var d=new Date(o.date).toLocaleString('fr-FR');
      var prem=o.plan==='premium'?' prem':'';
      var files=(o.files||[]).map(function(f){return '<a class="file" href="/admin/file/'+encodeURIComponent(f.stored)+'">Telecharger '+f.original+'</a>';}).join('')||'-';
      var contact=[o.name,o.customer,o.phone].filter(Boolean).join('<br>')||'-';
      var note=(o.note?o.note:'') + ((o.print_qty&&o.print_qty!=='0')?(' [Impressions: '+o.print_qty+']'):'') || '-';
      h+='<tr><td>'+d+'</td><td><span class="pill'+prem+'">'+o.plan_label+'</span></td><td>'+contact+'</td><td>'+note+'</td><td class="amount">'+o.amount+' '+o.currency+'</td><td>'+files+'</td></tr>';
    }
    h+='</tbody></table>';wrap.innerHTML=h;
  }catch(e){document.getElementById('wrap').innerHTML='<div class="empty">Erreur de chargement : '+e.message+'</div>';}
}
document.getElementById('q').addEventListener('input',load);
load();
</script></body></html>`;

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log('Embarq server en écoute sur http://localhost:' + PORT));
