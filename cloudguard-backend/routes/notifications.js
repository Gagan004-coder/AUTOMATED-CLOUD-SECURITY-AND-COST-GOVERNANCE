// routes/notifications.js — CloudGuard Pro Notifications & Automation v2.6
'use strict';

const express    = require('express');
const router     = express.Router();
const emailSvc   = require('../services/email');
const absenceSvc = require('../services/absence');
const db         = require('../services/db');
const { sessions } = require('./auth');
const autofix    = require('../services/autofix');

function getAccountId(req) {
  const sessionId = req.headers['x-session-id'];
  const sess = sessions.get(sessionId);
  return sess?.accountId || req.headers['x-account-id'] || 'demo';
}

// ── Email config check ───────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    res.json(await emailSvc.getConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email log ────────────────────────────────────────────────────────────────
router.get('/email-log', async (req, res) => {
  try {
    const log = db.getEmailLog(100);
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Test email ───────────────────────────────────────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const { to } = req.body;
    const result = await emailSvc.sendTest(to, getAccountId(req));
    res.json({ sent: true, ...result });
  } catch (err) {
    console.error('[notify/test]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Security alert email ─────────────────────────────────────────────────────
router.post('/security', async (req, res) => {
  try {
    const { issues, to } = req.body;
    const accountId = getAccountId(req);
    const result = await emailSvc.sendSecurityAlert(issues || [], to, accountId);
    res.json({ sent: true, count: (issues || []).length, ...result });
  } catch (err) {
    console.error('[notify/security]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cost alert email ─────────────────────────────────────────────────────────
router.post('/cost', async (req, res) => {
  try {
    const { currentCost, forecastedCost, threshold, percentChange, serviceBreakdown, to } = req.body;
    const accountId = getAccountId(req);
    const result = await emailSvc.sendCostAlert(
      { currentCost, forecastedCost, threshold: threshold || 500, percentChange, serviceBreakdown },
      to,
      accountId
    );
    res.json({ sent: true, ...result });
  } catch (err) {
    console.error('[notify/cost]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI cost alert (rich email with anomalies + forecast) ─────────────────────
router.post('/cost/ai-alert', async (req, res) => {
  try {
    const { costSummary, ec2Data, to } = req.body;
    if (!costSummary) return res.status(400).json({ error: 'costSummary is required' });

    const accountId  = getAccountId(req);
    const threshold  = parseFloat(process.env.COST_ALERT_THRESHOLD || '500');
    const summary    = costSummary.summary || {};

    const alerts = [];

    if (summary.currentMonthCost >= threshold) {
      alerts.push({ type: 'budget-exceeded', severity: 'critical',
        message: `Spend $${summary.currentMonthCost?.toFixed(2)} exceeded $${threshold} threshold` });
    } else if (summary.forecastedCost && summary.forecastedCost >= threshold) {
      alerts.push({ type: 'forecast-breach', severity: 'high',
        message: `Forecasted $${summary.forecastedCost?.toFixed(2)} will exceed $${threshold}` });
    }
    if (summary.percentChange > 25) {
      alerts.push({ type: 'mom-spike', severity: summary.percentChange > 50 ? 'critical' : 'high',
        message: `Month-over-month increase: +${summary.percentChange}%` });
    }
    for (const a of (costSummary.anomalies || []).slice(0, 3)) {
      alerts.push({ type: 'anomaly', severity: a.severity, message: a.message, date: a.date });
    }

    if (!alerts.length) {
      return res.json({ sent: false, reason: 'No active alerts', alerts: [] });
    }

    const recipients = (to || process.env.ALERT_EMAIL || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!recipients.length) {
      return res.json({ sent: false, reason: 'No recipient configured', alerts });
    }

    const result = await emailSvc.sendCostAlert({
      currentCost:     summary.currentMonthCost,
      forecastedCost:  summary.forecastedCost,
      threshold,
      percentChange:   summary.percentChange,
      serviceBreakdown: costSummary.serviceBreakdown,
    }, recipients, accountId);

    res.json({ sent: true, alerts: alerts.length, ...result });
  } catch (err) {
    console.error('[notify/cost/ai-alert]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Weekly summary email ─────────────────────────────────────────────────────
router.post('/weekly', async (req, res) => {
  try {
    const { summary, to } = req.body;
    const accountId = getAccountId(req);
    const result = await emailSvc.sendWeeklySummary(summary || {}, to, accountId);
    res.json({ sent: true, ...result });
  } catch (err) {
    console.error('[notify/weekly]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-fix engine ──────────────────────────────────────────────────────────
router.post('/autofix', async (req, res) => {
  try {
    const { fixes = [], notifyEmail } = req.body;
    const sessionId = req.headers['x-session-id'];
    const sess      = sessions.get(sessionId);
    const creds     = sess?.credentials;
    const region    = sess?.region || 'us-east-1';
    const accountId = sess?.accountId || 'demo';

    let results;
    if (creds) {
      results = await autofix.applyFixes({
        fixes, credentials: creds, region, accountId,
        notifyEmail: notifyEmail || process.env.ALERT_EMAIL,
      });
    } else {
      // Demo mode
      results = await Promise.all(fixes.map(async fix => {
        await new Promise(r => setTimeout(r, 150 + Math.random() * 200));
        return {
          resource: fix.resource || fix.params?.bucket || fix.params?.instanceId || fix.fixId,
          action:   fix.fixId,
          status:   'success',
          details:  `${fix.fixId} applied (demo mode)`,
          timestamp: new Date().toISOString(),
        };
      }));

      if (notifyEmail || process.env.ALERT_EMAIL) {
        emailSvc.sendAutoFixReport(results, notifyEmail || process.env.ALERT_EMAIL, accountId).catch(() => {});
      }
    }

    // Persist each fix to DB
    for (const r of results) {
      try {
        db.saveFix({
          accountId,
          fixId:    r.action || r.fixId || 'unknown',
          resource: r.resource || 'unknown',
          status:   r.status,
          details:  r.details || '',
          appliedBy: 'user',
        });
      } catch { /* non-fatal */ }
    }

    res.json({
      total:     fixes.length,
      succeeded: results.filter(r => r.status === 'success').length,
      failed:    results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (err) {
    console.error('[notify/autofix]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Absence management ────────────────────────────────────────────────────────
router.get('/absence/status', async (req, res) => {
  try {
    const accountId = getAccountId(req);
    const users     = absenceSvc.getTrackedUsers();
    const plans     = db.getAbsencePlans(accountId, 20);
    res.json({ users, plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/plan', async (req, res) => {
  try {
    const { userId, totalDays, startDate, keepRunning = [], notifyEmail, email } = req.body;
    if (!userId || !totalDays) return res.status(400).json({ error: 'userId and totalDays are required' });

    const accountId  = getAccountId(req);
    const plan       = absenceSvc.createPlan({ userId, totalDays, startDate, keepRunning });
    const recipient  = notifyEmail || email;

    // Persist to DB
    try {
      db.saveAbsencePlan({ userId, accountId, plan, notifyEmail: recipient });
    } catch (dbErr) { console.warn('[DB] saveAbsencePlan:', dbErr.message); }

    if (recipient) {
      emailSvc.sendAbsencePlanEmail(plan, recipient, accountId).catch(e => {
        console.warn('[notify/absence/plan] email failed:', e.message);
      });
    }

    res.json({ plan, persisted: true });
  } catch (err) {
    console.error('[notify/absence/plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/resume/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    absenceSvc.resumeUser(userId);
    db.completeAbsencePlan(userId);
    res.json({ status: 'ok', userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/stop-services', async (req, res) => {
  try {
    const { keepRunning = [] } = req.body;
    const result = absenceSvc.stopServices(keepRunning);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List available fixes ─────────────────────────────────────────────────────
router.get('/autofix/list', (req, res) => {
  res.json({ fixes: autofix.listFixes() });
});

module.exports = router;
