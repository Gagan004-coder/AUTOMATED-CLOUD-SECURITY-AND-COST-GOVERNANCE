/**
 * costAlerts.js — AI-Driven Cost Alert & Auto-Remediation Service
 * Implements: Real-time alerts, multi-channel notifications, proactive risk mitigation
 * Based on: "AI-Enabled Cloud Cost Management Platforms" Sections 4 & 5 (Jakku, 2024)
 */

const { detectAnomalies, buildForecast, buildOptimizationRecommendations } = require('./billing');

// ─── Alert Threshold Engine ───────────────────────────────────────────────────

function evaluateAlerts(costSummary, ec2Data, config = {}) {
  const threshold = parseFloat(config.costThreshold || process.env.COST_ALERT_THRESHOLD || 500);
  const alerts    = [];
  const { summary, anomalies, forecastModel } = costSummary;

  // 1. Budget threshold breach
  if (summary.currentMonthCost >= threshold) {
    alerts.push({
      type:     'budget-exceeded',
      severity: 'critical',
      title:    `Monthly budget threshold exceeded`,
      message:  `Spend of $${summary.currentMonthCost.toFixed(2)} has exceeded the $${threshold} threshold`,
      value:    summary.currentMonthCost,
      threshold,
      timestamp: new Date().toISOString(),
    });
  } else if (summary.forecastedCost && summary.forecastedCost >= threshold) {
    alerts.push({
      type:     'budget-forecast-breach',
      severity: 'high',
      title:    'Forecasted spend will exceed budget',
      message:  `On track to spend $${summary.forecastedCost.toFixed(2)} — above $${threshold} threshold`,
      value:    summary.forecastedCost,
      threshold,
      timestamp: new Date().toISOString(),
    });
  }

  // 2. Month-over-month spike
  if (summary.percentChange > 25) {
    alerts.push({
      type:     'mom-spike',
      severity: summary.percentChange > 50 ? 'critical' : 'high',
      title:    'Significant month-over-month cost increase',
      message:  `Costs up ${summary.percentChange}% vs last month ($${summary.previousMonthCost.toFixed(2)} → $${summary.currentMonthCost.toFixed(2)})`,
      value:    summary.percentChange,
      timestamp: new Date().toISOString(),
    });
  }

  // 3. Anomalies from AI detection
  const recentAnomalies = anomalies.filter(a => {
    const daysOld = (Date.now() - new Date(a.date)) / 86400000;
    return daysOld <= 3;
  });
  recentAnomalies.forEach(a => {
    alerts.push({
      type:     'anomaly-detected',
      severity: a.severity,
      title:    `Cost anomaly on ${a.date}`,
      message:  a.message,
      date:     a.date,
      zScore:   a.zScore,
      direction: a.direction,
      timestamp: new Date().toISOString(),
    });
  });

  // 4. Trend-based early warning
  if (forecastModel?.trend === 'increasing' && forecastModel.trendPct > 15) {
    alerts.push({
      type:     'trend-warning',
      severity: 'medium',
      title:    'Cost trend requires attention',
      message:  `Spending growing at ${forecastModel.trendPct}% per month. ${forecastModel.forecasts[0]?.month}: projected $${forecastModel.forecasts[0]?.projected}`,
      trendPct: forecastModel.trendPct,
      timestamp: new Date().toISOString(),
    });
  }

  return alerts;
}

// ─── Auto-Remediation Decision Engine ────────────────────────────────────────
// Section 4.3 — Proactive AI-Powered Risk Mitigation

function buildRemediationPlan(alerts, costSummary, ec2Data) {
  const actions = [];

  alerts.forEach(alert => {
    if (alert.type === 'budget-exceeded' || alert.type === 'budget-forecast-breach') {
      // Suggest stopping idle EC2 instances
      const idle = ec2Data?.instances?.idle || [];
      idle.forEach(inst => {
        actions.push({
          actionId:   'ec2-stop-idle',
          resource:   inst.instanceId,
          label:      `Stop idle instance ${inst.instanceId}`,
          savings:    inst.monthlyCost || 0,
          automate:   false, // Requires user approval for cost-related stops
          reason:     `Budget threshold exceeded — idle instance costing ~$${inst.monthlyCost}/mo`,
          fixId:      'ec2-stop-idle',
          params:     { instanceId: inst.instanceId },
        });
      });

      // Suggest deleting unattached volumes
      const vols = ec2Data?.storage?.unusedVolumes || [];
      vols.forEach(vol => {
        actions.push({
          actionId: 'ec2-delete-unattached-volume',
          resource:  vol.volumeId,
          label:     `Delete unattached volume ${vol.volumeId} (${vol.sizeGB}GB)`,
          savings:   vol.monthlyCost || 0,
          automate:  false,
          reason:    'Unused volume adding unnecessary cost',
          fixId:     'ec2-delete-unattached-volume',
          params:    { volumeId: vol.volumeId },
        });
      });
    }

    if (alert.type === 'anomaly-detected' && alert.direction === 'spike') {
      actions.push({
        actionId: 'investigate-spike',
        resource:  alert.date,
        label:     `Investigate cost spike on ${alert.date}`,
        savings:   null,
        automate:  false,
        reason:    alert.message,
        fixId:     null,
        params:    { date: alert.date },
      });
    }
  });

  const totalSavings = actions
    .filter(a => a.savings)
    .reduce((s, a) => s + a.savings, 0);

  return { actions, totalSavings: parseFloat(totalSavings.toFixed(2)) };
}

// ─── Cost Alert Email Body ────────────────────────────────────────────────────

function buildCostAlertEmailHtml(alerts, costSummary, remediationPlan, accountId) {
  const sevColor = { critical: '#ff4747', high: '#ffb547', medium: '#47c8ff', low: '#aaa' };
  const sevIcon  = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };

  const alertRows = alerts.map(a => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #222;">
        <span style="color:${sevColor[a.severity] || '#aaa'}">${sevIcon[a.severity] || '•'} ${a.title}</span><br>
        <span style="font-size:12px;color:#888">${a.message}</span>
      </td>
    </tr>`).join('');

  const actionRows = remediationPlan.actions.slice(0, 5).map(a => `
    <tr>
      <td style="padding:8px 16px;border-bottom:1px solid #1a1a1a;">
        <span style="color:#c6f135">⚡ ${a.label}</span><br>
        <span style="font-size:11px;color:#888">${a.reason}${a.savings ? ` — saves ~$${a.savings.toFixed(0)}/mo` : ''}</span>
      </td>
    </tr>`).join('');

  const forecastRows = (costSummary.forecastModel?.forecasts || []).map(f => `
    <tr>
      <td style="padding:6px 16px;color:#aaa;font-size:12px;border-bottom:1px solid #1a1a1a;">${f.month}</td>
      <td style="padding:6px 16px;color:#ffb547;font-family:monospace;font-size:12px;border-bottom:1px solid #1a1a1a;">$${f.projected}</td>
      <td style="padding:6px 16px;color:#888;font-size:11px;border-bottom:1px solid #1a1a1a;">$${f.lower} – $${f.upper}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><body style="background:#0d0d0d;color:#f0f0eb;font-family:'Segoe UI',sans-serif;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto">
  <div style="background:#141414;border:1px solid #222;border-top:2px solid #c6f135;border-radius:12px;overflow:hidden">
    <div style="padding:24px 28px;border-bottom:1px solid #222">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="background:#c6f135;color:#0d0d0d;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">CG</div>
        <div>
          <div style="font-size:18px;font-weight:700">CloudGuard Pro — Cost Alert</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Account: ${accountId || '—'} · ${new Date().toLocaleString()}</div>
        </div>
      </div>
    </div>

    <div style="padding:20px 28px;border-bottom:1px solid #222">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div style="background:#1a1a1a;border-radius:8px;padding:14px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.1em">This Month</div>
          <div style="font-size:22px;font-weight:700;color:#c6f135;margin-top:4px">$${costSummary.summary.currentMonthCost.toFixed(2)}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:8px;padding:14px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.1em">Forecasted</div>
          <div style="font-size:22px;font-weight:700;color:#ffb547;margin-top:4px">$${costSummary.summary.forecastedCost?.toFixed(2) || '—'}</div>
        </div>
        <div style="background:#1a1a1a;border-radius:8px;padding:14px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.1em">vs Last Month</div>
          <div style="font-size:22px;font-weight:700;color:${costSummary.summary.percentChange > 0 ? '#ff4747' : '#c6f135'};margin-top:4px">${costSummary.summary.percentChange > 0 ? '+' : ''}${costSummary.summary.percentChange}%</div>
        </div>
      </div>
    </div>

    ${alertRows ? `
    <div style="padding:16px 28px 0;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:8px">⚠️ Active Alerts</div></div>
    <table style="width:100%;border-collapse:collapse">${alertRows}</table>` : ''}

    ${actionRows ? `
    <div style="padding:16px 28px 0;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:8px">⚡ Recommended Actions</div></div>
    <table style="width:100%;border-collapse:collapse">${actionRows}</table>
    <div style="padding:8px 28px;font-size:11px;color:#c6f135">Estimated potential savings: $${remediationPlan.totalSavings}/mo</div>` : ''}

    ${forecastRows ? `
    <div style="padding:16px 28px 0;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:8px">📈 3-Month AI Forecast</div></div>
    <table style="width:100%;border-collapse:collapse">
      <tr style="background:#1a1a1a"><th style="padding:6px 16px;text-align:left;font-size:10px;color:#888">Month</th><th style="padding:6px 16px;text-align:left;font-size:10px;color:#888">Projected</th><th style="padding:6px 16px;text-align:left;font-size:10px;color:#888">Range</th></tr>
      ${forecastRows}
    </table>` : ''}

    <div style="padding:20px 28px;border-top:1px solid #222;text-align:center">
      <a href="${process.env.APP_URL || '#'}" style="display:inline-block;background:#c6f135;color:#0d0d0d;padding:10px 24px;border-radius:7px;font-weight:700;font-size:13px;text-decoration:none">Open CloudGuard Dashboard →</a>
      <div style="margin-top:12px;font-size:10px;color:#555">CloudGuard Pro v2.6.0 · AI Cost Management</div>
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = {
  evaluateAlerts,
  buildRemediationPlan,
  buildCostAlertEmailHtml,
};
