/**
 * notifications-cost-addition.js
 * ADD this block to your existing routes/notifications.js
 *
 * Add at the top of notifications.js (require section):
 *   const billing    = require('../services/billing');
 *   const costAlerts = require('../services/costAlerts');
 *
 * Then mount the new route:
 *   router.post('/cost/ai-alert', handleAICostAlert);
 */

// ── POST /api/notify/cost/ai-alert ────────────────────────────────────────────
// Triggered automatically when anomalies or threshold breaches are detected.
// Sends a rich HTML email with alerts, remediation plan, and forecast.

async function handleAICostAlert(req, res) {
  const { costSummary, ec2Data, to } = req.body;

  if (!costSummary) {
    return res.status(400).json({ error: 'costSummary is required' });
  }

  try {
    const { evaluateAlerts, buildRemediationPlan, buildCostAlertEmailHtml } = require('../services/costAlerts');

    const threshold  = process.env.COST_ALERT_THRESHOLD || 500;
    const alerts     = evaluateAlerts(costSummary, ec2Data, { costThreshold: threshold });
    const remediation = buildRemediationPlan(alerts, costSummary, ec2Data || {});

    if (!alerts.length) {
      return res.json({ sent: false, reason: 'No active alerts to report', alerts: [] });
    }

    const recipients = (to || process.env.ALERT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!recipients.length) {
      return res.json({ sent: false, reason: 'No recipient configured', alerts });
    }

    const html    = buildCostAlertEmailHtml(alerts, costSummary, remediation, req.headers['x-account-id']);
    const subject = `⚠️ CloudGuard Cost Alert — ${alerts.length} issue(s) detected`;

    // Send via existing email helper (reuse whatever send function is in notifications.js)
    // Replace `sendEmail` with your actual helper name if different
    await sendEmail({ to: recipients.join(','), subject, html });

    res.json({
      sent:      true,
      alerts:    alerts.length,
      actions:   remediation.actions.length,
      savings:   remediation.totalSavings,
      recipients,
    });
  } catch (err) {
    console.error('[notify/cost/ai-alert]', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { handleAICostAlert };
