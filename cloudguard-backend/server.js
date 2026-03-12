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
const aiRoutes           = require('./routes/ai');
const absence            = require('./services/absence');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Trust Proxy (REQUIRED for Render / any reverse-proxy host) ────────────────
// Must be set BEFORE rate-limiter so express-rate-limit can correctly read
// the real client IP from the X-Forwarded-For header.
app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Always allow the app's own Render domain
const renderDomain = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
if (renderDomain && !allowedOrigins.includes(renderDomain)) {
  allowedOrigins.push(renderDomain.replace(/\/$/, ''));
}

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server-to-server / curl
    // Always allow requests from the same Render hostname
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    // Allow any onrender.com subdomain (covers Render previews too)
    if (/^https:\/\/[^.]+\.onrender\.com$/.test(origin)) return cb(null, true);
    // Allow localhost in development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // unified preflight handler

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,  // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
}));

// ── Absence plan deduplication guard ─────────────────────────────────────────
// Prevents the same user from creating multiple plans within 10 seconds,
// which was causing rapid-fire duplicate entries in the logs.
const recentAbsencePlans = new Map();

app.use('/api/absence/plan', (req, res, next) => {
  const key = req.body?.email || req.ip;
  const now = Date.now();
  const last = recentAbsencePlans.get(key) || 0;

  if (now - last < 10_000) {
    return res.status(429).json({ error: 'Plan already created recently. Please wait.' });
  }

  recentAbsencePlans.set(key, now);

  // Clean up old entries to prevent memory growth
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

// ── Global error handler ──────────────────────────────────────────────────────
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

  absence.startMonitoring();
});