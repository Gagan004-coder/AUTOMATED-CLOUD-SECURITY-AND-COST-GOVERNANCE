// ─────────────────────────────────────────────────────────────────────────────
// routes/aws.js  — All AWS data endpoints + alert triggers
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { sessions } = require('./auth');
const s3Service      = require('../services/s3');
const ec2Service     = require('../services/ec2');
const iamService     = require('../services/iam');
const billingService = require('../services/billing');
const emailSvc       = require('../services/email');
const absence        = require('../services/absence');

const router = express.Router();

const COST_ALERT_THRESHOLD = parseFloat(process.env.COST_ALERT_THRESHOLD || '500');

// ── Middleware: resolve credentials from sessionId ────────────────────────────
function requireSession(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.body?.sessionId;
  if (!sessionId) return res.status(401).json({ error: 'x-session-id header required' });
  const session = sessions.get(sessionId);
  if (!session || !session.credentials) {
    return res.status(401).json({ error: 'Session not found or not authenticated' });
  }
  req.session = session;
  req.awsCredentials = session.credentials;
  req.awsRegion = req.headers['x-aws-region'] || 'us-east-1';
  next();
}

// ── POST-SCAN alert logic ─────────────────────────────────────────────────────
async function triggerAlerts(session, overview) {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail) return;

  try {
    // Security alert — critical issues
    const s3Issues = (overview.s3?.vulnerableBuckets || []).map(b => ({
      severity: b.severity,
      resource: `s3://${b.name}`,
      issues: b.issues,
    }));
    const iamIssues = (overview.iam?.usersWithIssues || []).map(u => ({
      severity: u.severity,
      resource: `iam:${u.username}`,
      issues: u.issues,
    }));
    const allIssues = [...s3Issues, ...iamIssues];
    const criticals = allIssues.filter(i => i.severity === 'critical');

    if (criticals.length > 0) {
      await emailSvc.sendSecurityAlert({
        accountId: session.accountId,
        issues: allIssues,
        to: alertEmail,
      }).catch(console.error);
    }

    // Cost alert
    const billing = overview.billing;
    if (billing && !billing.error) {
      const cost = billing.summary?.currentMonthCost;
      if (cost && cost > COST_ALERT_THRESHOLD) {
        await emailSvc.sendCostAlert({
          accountId: session.accountId,
          currentCost: cost,
          forecastedCost: billing.summary?.forecastedCost,
          threshold: COST_ALERT_THRESHOLD,
          to: alertEmail,
        }).catch(console.error);
      }
    }
  } catch (err) {
    console.error('[aws] Alert trigger error:', err.message);
  }
}

// ── GET /api/aws/overview ─────────────────────────────────────────────────────
router.get('/overview', requireSession, async (req, res) => {
  const { awsCredentials: creds, awsRegion: region, session } = req;

  // Record user activity for absence tracking
  if (session.accountId) {
    absence.recordActivity(session.accountId, session.accountId, creds);
  }

  try {
    const [s3, ec2, iam, billing] = await Promise.allSettled([
      s3Service.getAll(creds, region),
      ec2Service.getAll(creds, region),
      iamService.getAll(creds, region),
      billingService.getAll(creds, region)
    ]);

    const overview = {
      s3:      s3.status      === 'fulfilled' ? s3.value      : { error: s3.reason?.message },
      ec2:     ec2.status     === 'fulfilled' ? ec2.value     : { error: ec2.reason?.message },
      iam:     iam.status     === 'fulfilled' ? iam.value     : { error: iam.reason?.message },
      billing: billing.status === 'fulfilled' ? billing.value : { error: billing.reason?.message },
      fetchedAt: new Date().toISOString()
    };

    // Fire-and-forget alerts
    triggerAlerts(session, overview);

    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/s3 ───────────────────────────────────────────────────────────
router.get('/s3', requireSession, async (req, res) => {
  try {
    const data = await s3Service.getAll(req.awsCredentials, req.awsRegion);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/ec2 ──────────────────────────────────────────────────────────
router.get('/ec2', requireSession, async (req, res) => {
  try {
    const data = await ec2Service.getAll(req.awsCredentials, req.awsRegion);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/iam ──────────────────────────────────────────────────────────
router.get('/iam', requireSession, async (req, res) => {
  try {
    const data = await iamService.getAll(req.awsCredentials, req.awsRegion);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/billing ──────────────────────────────────────────────────────
router.get('/billing', requireSession, async (req, res) => {
  try {
    const data = await billingService.getAll(req.awsCredentials, req.awsRegion);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
