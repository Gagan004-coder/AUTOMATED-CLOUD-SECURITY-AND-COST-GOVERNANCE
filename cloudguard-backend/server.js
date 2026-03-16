// server.js — CloudGuard Pro v2.6.0
// Features: AWS SSO, Security Audit, Cost Monitor, Auto-Fix, Email Alerts,
//           Absence Management, SQLite persistence, Patent-ready architecture
'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const authRoutes         = require('./routes/auth');
const awsRoutes          = require('./routes/aws');
const notificationRoutes = require('./routes/notifications');
const aiRoutes           = require('./routes/ai');
const absence            = require('./services/absence');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Trust proxy (Render / reverse-proxy) ──────────────────────────────────────
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const renderDomain = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
if (renderDomain) {
  const clean = renderDomain.replace(/\/$/, '');
  if (!allowedOrigins.includes(clean)) allowedOrigins.push(clean);
}

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^https:\/\/[^.]+\.onrender\.com$/.test(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs:        60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — please slow down.' },
}));

// ── Absence plan dedup guard (prevent duplicate rapid submissions) ─────────────
const recentAbsencePlans = new Map();
app.use('/api/notify/absence/plan', (req, res, next) => {
  const key  = req.body?.userId || req.body?.email || req.ip;
  const now  = Date.now();
  const last = recentAbsencePlans.get(key) || 0;
  if (now - last < 10_000) {
    return res.status(429).json({ error: 'Plan created recently. Please wait 10 seconds.' });
  }
  recentAbsencePlans.set(key, now);
  if (recentAbsencePlans.size > 500) {
    for (const [k, t] of recentAbsencePlans) {
      if (now - t > 60_000) recentAbsencePlans.delete(k);
    }
  }
  next();
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/aws',    awsRoutes);
app.use('/api/notify', notificationRoutes);
app.use('/api/ai',     aiRoutes);

// ── Health endpoint ───────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  status:    'ok',
  version:   '2.6.0',
  time:      new Date().toISOString(),
  features:  ['email-alerts', 'auto-fix', 'absence-management', 'cost-monitoring', 'sqlite-persistence'],
  smtp:      !!(process.env.SMTP_USER   && process.env.SMTP_PASS),
  resend:    !!process.env.RESEND_API_KEY,
  groq:      !!process.env.GROQ_API_KEY,
  absenceThreshold: process.env.MAX_ABSENT_DAYS || '5',
  costAlertAt:      `$${process.env.COST_ALERT_THRESHOLD || '500'}`,
}));

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡️  CloudGuard Pro v2.6.0 → http://localhost:${PORT}`);
  console.log(`   SSO Start URL   : ${process.env.AWS_SSO_START_URL || '(not set)'}`);
  console.log(`   SSO Region      : ${process.env.AWS_SSO_REGION   || 'us-east-1'}`);
  console.log(`   Email Provider  : ${
    process.env.RESEND_API_KEY ? 'Resend' :
    process.env.SENDGRID_API_KEY ? 'SendGrid' :
    (process.env.SMTP_USER && process.env.SMTP_PASS) ? 'SMTP' : 'None (set RESEND_API_KEY)'}`);
  console.log(`   Alert Email     : ${process.env.ALERT_EMAIL      || '(not set)'}`);
  console.log(`   Absence Limit   : ${process.env.MAX_ABSENT_DAYS  || '5'} days`);
  console.log(`   Cost Alert At   : $${process.env.COST_ALERT_THRESHOLD || '500'}`);
  console.log(`   AI (Groq)       : ${process.env.GROQ_API_KEY ? '✓ configured' : '(not set)'}\n`);

  absence.startMonitoring();
});
