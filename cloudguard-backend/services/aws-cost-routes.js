/**
 * aws-cost-routes.js — Additional AWS route handlers for AI Cost Management
 * ADD these routes to your existing routes/aws.js file
 *
 * Usage in aws.js:
 *   const costRoutes = require('./aws-cost-routes');
 *   router.use('/cost', costRoutes);
 *
 * Endpoints added:
 *   GET  /api/aws/cost/summary        — Full cost summary with anomalies + forecast
 *   GET  /api/aws/cost/daily          — 30-day daily cost trend
 *   GET  /api/aws/cost/anomalies      — AI-detected anomalies only
 *   GET  /api/aws/cost/forecast       — 3-month AI forecast model
 *   GET  /api/aws/cost/recommendations — Optimization recommendations
 *   POST /api/aws/cost/report         — Generate on-demand cost report
 */

const express = require('express');
const router  = express.Router();

const billing     = require('../services/billing');
const costAlerts  = require('../services/costAlerts');
const { sessions } = require('./auth'); // reuse existing session store

function getCredentials(req) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return null;
  const session = sessions?.get(sessionId);
  return session?.credentials || null;
}

// ── GET /api/aws/cost/summary ─────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const creds   = getCredentials(req);
    const summary = await billing.getCostSummary(creds);
    res.json(summary);
  } catch (err) {
    console.error('[cost/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/cost/daily ───────────────────────────────────────────────────
router.get('/daily', async (req, res) => {
  try {
    const creds = getCredentials(req);
    const days  = parseInt(req.query.days) || 30;
    const daily = await billing.getDailyCosts(creds, days);
    res.json({ daily, anomalies: billing.detectAnomalies(daily) });
  } catch (err) {
    console.error('[cost/daily]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/cost/anomalies ───────────────────────────────────────────────
router.get('/anomalies', async (req, res) => {
  try {
    const creds = getCredentials(req);
    const daily = await billing.getDailyCosts(creds, 30);
    const anomalies = billing.detectAnomalies(daily);
    res.json({ anomalies, total: anomalies.length });
  } catch (err) {
    console.error('[cost/anomalies]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/cost/forecast ────────────────────────────────────────────────
router.get('/forecast', async (req, res) => {
  try {
    const creds   = getCredentials(req);
    const monthly = await billing.getMonthlyTrend(creds, 6);
    const model   = billing.buildForecast(monthly);
    res.json({ model, monthlyTrend: monthly });
  } catch (err) {
    console.error('[cost/forecast]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aws/cost/recommendations ─────────────────────────────────────────
router.get('/recommendations', async (req, res) => {
  try {
    const creds   = getCredentials(req);
    const summary = await billing.getCostSummary(creds);
    // We don't have ec2 data here — pass null and let the function handle it
    const recs    = billing.buildOptimizationRecommendations(summary, null);
    const alerts  = costAlerts.evaluateAlerts(summary, null, {
      costThreshold: process.env.COST_ALERT_THRESHOLD || 500,
    });
    res.json({ recommendations: recs, alerts });
  } catch (err) {
    console.error('[cost/recommendations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/aws/cost/report ─────────────────────────────────────────────────
// On-demand cost report endpoint (Section 2.2 — scheduled & on-demand reporting)
router.post('/report', async (req, res) => {
  try {
    const creds   = getCredentials(req);
    const { period = 30 } = req.body;
    const [summary, daily] = await Promise.all([
      billing.getCostSummary(creds),
      billing.getDailyCosts(creds, period),
    ]);
    const anomalies = billing.detectAnomalies(daily);
    const model     = billing.buildForecast(summary.monthlyTrend);
    const recs      = billing.buildOptimizationRecommendations(summary, null);
    const alerts    = costAlerts.evaluateAlerts(summary, null, {
      costThreshold: process.env.COST_ALERT_THRESHOLD || 500,
    });

    res.json({
      generatedAt: new Date().toISOString(),
      period,
      summary:     summary.summary,
      daily,
      anomalies,
      forecastModel: model,
      serviceBreakdown: summary.serviceBreakdown,
      recommendations:  recs,
      alerts,
    });
  } catch (err) {
    console.error('[cost/report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
