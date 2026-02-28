// ─────────────────────────────────────────────────────────────────────────────
// server.js — CloudGuard Pro Entry Point
// Features: AWS SSO, Security Audit, Cost Monitor, Auto-Fix, Email Alerts,
//           Absence Management (5-day auto-stop), PDF Reports
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const authRoutes         = require('./routes/auth');
const awsRoutes          = require('./routes/aws');
const notificationRoutes = require('./routes/notifications');
const absence            = require('./services/absence');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));
// ── Preflight support (IMPORTANT) ─────────────────────────────────────────────
app.options('*', cors({
  origin: (origin, cb) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));
// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  message: { error: 'Too many requests — slow down.' }
}));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/aws',    awsRoutes);
app.use('/api/notify', notificationRoutes);

app.get('/api/health', (_, res) => res.json({
  status:  'ok',
  version: '2.5.0',
  time:    new Date().toISOString(),
  features: ['email-alerts', 'auto-fix', 'absence-management', 'cost-monitoring'],
  smtp: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
  absenceThreshold: process.env.MAX_ABSENT_DAYS || '5',
}));

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡️  CloudGuard Pro v2.5.0 → http://localhost:${PORT}`);
  console.log(`   SSO Start URL   : ${process.env.AWS_SSO_START_URL || '(not set)'}`);
  console.log(`   SSO Region      : ${process.env.AWS_SSO_REGION || 'us-east-1'}`);
  console.log(`   SMTP Configured : ${!!(process.env.SMTP_USER && process.env.SMTP_PASS)}`);
  console.log(`   Alert Email     : ${process.env.ALERT_EMAIL || '(not set)'}`);
  console.log(`   Absence Limit   : ${process.env.MAX_ABSENT_DAYS || '5'} days`);
  console.log(`   Cost Alert At   : $${process.env.COST_ALERT_THRESHOLD || '500'}\n`);

  // Start absence monitoring
  absence.startMonitoring();
});
