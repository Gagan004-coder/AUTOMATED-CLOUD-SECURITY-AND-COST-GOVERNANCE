// ─────────────────────────────────────────────────────────────────────────────
// routes/notifications.js — Email Alerts, Auto-Fix, Absence Management
// ─────────────────────────────────────────────────────────────────────────────
const express  = require('express');
const { sessions } = require('./auth');
const emailSvc = require('../services/email');
const autofix  = require('../services/autofix');
const absence  = require('../services/absence');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireSession(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.body?.sessionId;
  if (!sessionId) return res.status(401).json({ error: 'x-session-id required' });
  const session = sessions.get(sessionId);
  if (!session || !session.credentials) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  req.awsCredentials = session.credentials;
  req.awsRegion = req.headers['x-aws-region'] || 'us-east-1';
  next();
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/notify/test — Send a test email
router.post('/test', async (req, res) => {
  const { to } = req.body;
  try {
    const result = await emailSvc.send({
      to,
      subject: '✅ [CloudGuard] Test Email — Configuration Working',
      html: `<div style="background:#0d0d0d;color:#f0f0eb;padding:24px;font-family:monospace">
        <div style="color:#c6f135;font-size:20px;font-weight:700;margin-bottom:12px">✓ CloudGuard Email Working</div>
        <p>Your CloudGuard Pro email notifications are correctly configured.</p>
        <p style="color:#555;margin-top:12px;font-size:12px">Sent at ${new Date().toISOString()}</p>
      </div>`,
      text: 'CloudGuard Pro email test — working correctly.',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notify/security — Send security alert
router.post('/security', requireSession, async (req, res) => {
  const { issues, to } = req.body;
  try {
    const result = await emailSvc.sendSecurityAlert({
      accountId: req.session.accountId,
      issues: issues || [],
      to,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notify/cost — Send cost threshold alert
router.post('/cost', requireSession, async (req, res) => {
  const { currentCost, forecastedCost, threshold, to } = req.body;
  try {
    const result = await emailSvc.sendCostAlert({
      accountId: req.session.accountId,
      currentCost, forecastedCost, threshold, to,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notify/weekly — Send weekly summary
router.post('/weekly', requireSession, async (req, res) => {
  const { summary, to } = req.body;
  try {
    const result = await emailSvc.sendWeeklySummary({
      accountId: req.session.accountId,
      summary: summary || {},
      to,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notify/config — Return email config status (masked)
router.get('/config', (req, res) => {
  res.json({
    configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      user: process.env.SMTP_USER ? process.env.SMTP_USER.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    },
    alertEmail: process.env.ALERT_EMAIL ? process.env.ALERT_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    appUrl: process.env.APP_URL || null,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTO-FIX ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/notify/fixes — List available fixes
router.get('/fixes', (req, res) => {
  res.json({ fixes: autofix.listFixes() });
});

// POST /api/notify/autofix — Apply fixes
router.post('/autofix', requireSession, async (req, res) => {
  const { fixes, notifyEmail } = req.body;
  if (!fixes || !fixes.length) return res.status(400).json({ error: 'fixes array required' });
  try {
    const results = await autofix.applyFixes({
      fixes,
      credentials: req.awsCredentials,
      region:      req.awsRegion,
      accountId:   req.session.accountId,
      notifyEmail,
    });
    res.json({ results, applied: results.filter(r => r.status === 'success').length, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ABSENCE MANAGEMENT ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/notify/absence/activity — Record user activity
router.post('/absence/activity', requireSession, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  absence.recordActivity(userId, req.session.accountId, req.awsCredentials);
  res.json({ success: true, recorded: new Date().toISOString() });
});

// GET /api/notify/absence/status — Get all user statuses
router.get('/absence/status', requireSession, (req, res) => {
  res.json({ users: absence.getAllUserStatuses() });
});

// GET /api/notify/absence/status/:userId — Get single user status
router.get('/absence/status/:userId', requireSession, (req, res) => {
  const status = absence.getUserStatus(req.params.userId);
  if (!status) return res.status(404).json({ error: 'User not found' });
  res.json({ ...status, credentials: undefined });
});

// POST /api/notify/absence/plan — Create absence plan
router.post('/absence/plan', requireSession, async (req, res) => {
  const { userId, totalDays, startDate, keepRunning, notifyEmail } = req.body;
  if (!userId || !totalDays) return res.status(400).json({ error: 'userId and totalDays required' });
  try {
    const plan = absence.createAbsencePlan({ userId, totalDays, startDate, keepRunning, notifyEmail });
    // Record current activity so we track from now
    absence.recordActivity(userId, req.session.accountId, req.awsCredentials);
    // Send plan email
    const alertTo = notifyEmail || process.env.ALERT_EMAIL;
    if (alertTo) {
      await emailSvc.sendAbsencePlan({
        accountId: req.session.accountId,
        userId,
        absencePlan: plan,
        to: alertTo,
      }).catch(console.error);
    }
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notify/absence/plan/:userId — Get absence plan
router.get('/absence/plan/:userId', requireSession, (req, res) => {
  const plan = absence.getAbsencePlan(req.params.userId);
  if (!plan) return res.status(404).json({ error: 'No plan found' });
  res.json({ plan });
});

// DELETE /api/notify/absence/plan/:userId — Cancel plan & resume
router.delete('/absence/plan/:userId', requireSession, async (req, res) => {
  absence.deleteAbsencePlan(req.params.userId);
  const result = await absence.resumeServices(req.params.userId);
  res.json({ success: true, ...result });
});

// POST /api/notify/absence/stop-services — Manually stop services for absent user
router.post('/absence/stop-services', requireSession, async (req, res) => {
  const { keepRunning } = req.body;
  try {
    const result = await absence.stopEC2Instances(req.awsCredentials, req.awsRegion, keepRunning || []);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notify/absence/resume/:userId — Resume services after return
router.post('/absence/resume/:userId', requireSession, async (req, res) => {
  const result = await absence.resumeServices(req.params.userId);
  res.json(result);
});

module.exports = router;
