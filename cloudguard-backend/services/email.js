// ─────────────────────────────────────────────────────────────────────────────
// services/email.js — CloudGuard Pro Email Service
// Provider priority: SendGrid (HTTP API) → Nodemailer SMTP
//
// WHY: Render's free tier blocks outbound SMTP ports (25, 465, 587),
// causing ETIMEDOUT on every nodemailer send. SendGrid uses HTTPS (443)
// which is never blocked.
//
// Setup (pick one):
//   A) Set SENDGRID_API_KEY in Render env vars  ← recommended
//   B) Keep SMTP_USER + SMTP_PASS (only works on paid Render plans)
// ─────────────────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

// ── Provider detection ────────────────────────────────────────────────────────
const USE_SENDGRID = !!process.env.SENDGRID_API_KEY;
const USE_SMTP     = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

if (USE_SENDGRID) {
  console.log('[email] Provider: SendGrid (HTTP API)');
} else if (USE_SMTP) {
  console.log('[email] Provider: SMTP (nodemailer) — ensure your host allows port 587');
} else {
  console.warn('[email] No provider configured — email alerts are DISABLED');
  console.warn('[email] Set SENDGRID_API_KEY (recommended) or SMTP_USER + SMTP_PASS');
}

// ── SendGrid sender (pure fetch, no extra package needed) ─────────────────────
async function sendViaSendGrid({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : to.split(',').map(s => s.trim());

  const body = {
    personalizations: [{ to: recipients.map(email => ({ email })) }],
    from: { email: process.env.SENDGRID_FROM || process.env.SENDGRID_USER || 'cloudguard@example.com' },
    subject,
    content: [
      { type: 'text/plain', value: text || subject },
      { type: 'text/html',  value: html  || text || subject },
    ],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status}: ${detail}`);
  }

  // SendGrid returns 202 with no body on success
  const messageId = res.headers.get('x-message-id') || 'sendgrid-ok';
  console.log('[email] Sent via SendGrid:', subject, '→', recipients.join(', '), messageId);
  return { sent: true, messageId, provider: 'sendgrid' };
}

// ── SMTP sender (nodemailer — fallback) ───────────────────────────────────────
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Fail fast so the server doesn't hang for 60 s on Render free tier
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000,
  });
  return _transporter;
}

async function sendViaSmtp({ to, subject, html, text }) {
  const FROM = process.env.SMTP_FROM || process.env.SMTP_USER;
  const info = await getTransporter().sendMail({ from: FROM, to, subject, html, text });
  console.log('[email] Sent via SMTP:', subject, '→', to, info.messageId);
  return { sent: true, messageId: info.messageId, provider: 'smtp' };
}

// ── Generic send (auto-selects provider) ──────────────────────────────────────
const TO = process.env.ALERT_EMAIL || '';

async function send({ to, subject, html, text }) {
  const recipients = to || TO;
  if (!recipients) return { skipped: true, reason: 'No recipient configured' };

  if (USE_SENDGRID) return sendViaSendGrid({ to: recipients, subject, html, text });
  if (USE_SMTP)     return sendViaSmtp({ to: recipients, subject, html, text });

  console.warn('[email] Skipping — no provider configured:', subject);
  return { skipped: true, reason: 'No email provider configured' };
}

// ── HTML template wrapper ─────────────────────────────────────────────────────
function wrap(title, body, severity = 'info') {
  const colors = {
    critical: '#ff4747', high: '#ffb547', medium: '#47c8ff',
    info: '#c6f135', success: '#c6f135',
  };
  const accent = colors[severity] || '#c6f135';
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; font-family: 'Segoe UI', Arial, sans-serif; color: #f0f0eb; }
  .wrapper { max-width: 620px; margin: 0 auto; padding: 24px 16px; }
  .card { background: #141414; border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; overflow: hidden; }
  .header { background: #1e1e1e; padding: 24px 28px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; gap: 12px; }
  .logo-mark { width: 36px; height: 36px; background: ${accent}; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; color: #0d0d0d; font-size: 14px; }
  .header h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
  .header .sub { font-size: 11px; color: #555; margin-top: 2px; font-family: monospace; }
  .accent-bar { height: 2px; background: linear-gradient(90deg, ${accent}, transparent); }
  .body { padding: 28px; }
  .title { font-size: 20px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 16px; }
  .title span { color: ${accent}; }
  .content { font-size: 14px; line-height: 1.7; color: rgba(240,240,235,0.8); }
  table.data { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  table.data th { text-align: left; padding: 8px 12px; background: #1e1e1e; color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-family: monospace; }
  table.data td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  table.data tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-family: monospace; font-weight: 600; text-transform: uppercase; }
  .badge-critical { background: rgba(255,71,71,0.15);   color: #ff4747; border: 1px solid rgba(255,71,71,0.2); }
  .badge-high     { background: rgba(255,181,71,0.15);  color: #ffb547; border: 1px solid rgba(255,181,71,0.2); }
  .badge-medium   { background: rgba(71,200,255,0.15);  color: #47c8ff; border: 1px solid rgba(71,200,255,0.2); }
  .badge-low      { background: rgba(85,85,85,0.2);     color: #777;    border: 1px solid rgba(85,85,85,0.2); }
  .badge-ok       { background: rgba(198,241,53,0.1);   color: #c6f135; border: 1px solid rgba(198,241,53,0.2); }
  .cta { display: block; margin: 20px 0 0; padding: 12px 20px; background: ${accent}; color: #0d0d0d; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 13px; text-align: center; letter-spacing: 0.03em; }
  .footer { padding: 16px 28px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 11px; color: #444; font-family: monospace; }
  .alert-box { padding: 14px 16px; border-radius: 8px; border-left: 3px solid ${accent}; background: rgba(255,255,255,0.03); margin: 16px 0; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="header">
      <div class="logo-mark">CG</div>
      <div>
        <div class="header h1">CloudGuard Pro</div>
        <div class="sub">AWS SECURITY &amp; COST MONITOR</div>
      </div>
    </div>
    <div class="accent-bar"></div>
    <div class="body">
      <div class="title">${title}</div>
      <div class="content">${body}</div>
      ${process.env.APP_URL ? `<a class="cta" href="${process.env.APP_URL}">Open CloudGuard Dashboard →</a>` : ''}
    </div>
    <div class="footer">
      CloudGuard Pro · ${new Date().toUTCString()} · Auto-generated alert
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Specific alert types ──────────────────────────────────────────────────────

async function sendSecurityAlert({ accountId, issues = [], to }) {
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount     = issues.filter(i => i.severity === 'high').length;

  const rows = issues.slice(0, 15).map(i => `
    <tr>
      <td><span class="badge badge-${i.severity}">${i.severity}</span></td>
      <td>${i.resource || '—'}</td>
      <td style="color:#777;font-size:12px">${(i.issues || [i.description || '']).join(', ')}</td>
    </tr>`).join('');

  const body = `
    <div class="alert-box">
      Found <strong>${criticalCount} critical</strong> and <strong>${highCount} high</strong> severity issues
      in account <code>${accountId}</code> that require immediate attention.
    </div>
    <table class="data">
      <thead><tr><th>Severity</th><th>Resource</th><th>Issue</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#555;font-size:12px;margin-top:8px">
      Showing top ${Math.min(issues.length, 15)} of ${issues.length} issues.
      Log in to CloudGuard to see all and auto-fix.
    </p>`;

  return send({
    to,
    subject: `🔴 [CloudGuard] ${criticalCount} Critical Security Issues — Account ${accountId}`,
    html:    wrap(`<span>${criticalCount}</span> Critical Security Issues Detected`, body, 'critical'),
    text:    `CloudGuard Alert: ${criticalCount} critical, ${highCount} high issues in ${accountId}. Open your dashboard to review.`,
  });
}

async function sendCostAlert({ accountId, currentCost, forecastedCost, threshold, to }) {
  const body = `
    <div class="alert-box">
      Your AWS spend has exceeded the configured threshold of <strong>$${threshold}</strong>.
    </div>
    <table class="data">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Account ID</td><td style="font-family:monospace">${accountId}</td></tr>
        <tr><td>Current Month Spend</td><td style="color:#ffb547;font-family:monospace;font-weight:700">$${currentCost?.toFixed(2)}</td></tr>
        <tr><td>Forecasted (EOM)</td><td style="color:#ff4747;font-family:monospace;font-weight:700">$${forecastedCost?.toFixed(2)}</td></tr>
        <tr><td>Alert Threshold</td><td style="font-family:monospace">$${threshold}</td></tr>
      </tbody>
    </table>
    <p style="color:#777;font-size:13px">
      Review your service breakdown in CloudGuard and consider rightsizing or stopping idle resources.
    </p>`;

  return send({
    to,
    subject: `💰 [CloudGuard] Cost Alert — $${currentCost?.toFixed(0)} spent in ${accountId}`,
    html:    wrap(`Cost Threshold Exceeded: <span>$${currentCost?.toFixed(2)}</span>`, body, 'high'),
    text:    `CloudGuard Cost Alert: $${currentCost?.toFixed(2)} spent this month in ${accountId}. Threshold: $${threshold}.`,
  });
}

async function sendAbsenceAlert({ accountId, userId, daysMissing, servicesWillStop, to }) {
  const isStopping = daysMissing >= 5;
  const body = `
    <div class="alert-box">
      User <strong>${userId}</strong> has been inactive for <strong>${daysMissing} days</strong>
      in account <code>${accountId}</code>.
      ${isStopping
        ? '<br><br>⚠️ <strong>AWS services are being automatically stopped to prevent cost overrun.</strong>'
        : `CloudGuard will stop services if inactivity continues for ${5 - daysMissing} more days.`}
    </div>
    ${servicesWillStop?.length ? `
    <table class="data">
      <thead><tr><th>Resource</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>
        ${servicesWillStop.map(s => `
          <tr>
            <td style="font-family:monospace">${s.id}</td>
            <td>${s.type}</td>
            <td><span class="badge ${isStopping ? 'badge-critical' : 'badge-high'}">${isStopping ? 'STOPPING' : 'AT RISK'}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''}
    <p style="color:#777;font-size:13px">Log back in to CloudGuard to resume services and cancel the absence policy.</p>`;

  return send({
    to,
    subject: `⏸ [CloudGuard] ${isStopping ? 'SERVICES STOPPING' : 'Absence Warning'} — ${userId} (${daysMissing}d inactive)`,
    html:    wrap(`User Absence Detected: <span>${daysMissing} Days</span>`, body, isStopping ? 'critical' : 'high'),
    text:    `CloudGuard: ${userId} has been inactive ${daysMissing} days in ${accountId}. ${isStopping ? 'Services being stopped.' : `${5 - daysMissing} more days until auto-stop.`}`,
  });
}

async function sendAbsencePlan({ accountId, userId, absencePlan, to }) {
  const rows = (absencePlan.days || []).map((d, i) => `
    <tr>
      <td style="font-family:monospace">Day ${i + 1}</td>
      <td>${d.date}</td>
      <td>${d.actions?.join(', ') || '—'}</td>
      <td><span class="badge badge-${d.risk || 'ok'}">${d.risk || 'low'}</span></td>
    </tr>`).join('');

  const body = `
    <div class="alert-box">
      User <strong>${userId}</strong> absence plan activated in account <code>${accountId}</code>.
      Duration: <strong>${absencePlan.totalDays} days</strong> starting ${absencePlan.startDate}.
    </div>
    <table class="data">
      <thead><tr><th>Period</th><th>Date</th><th>Actions</th><th>Risk</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:12px;color:#555;margin-top:8px">
      All actions are automated. Login to CloudGuard to modify or cancel this plan.
    </p>`;

  return send({
    to,
    subject: `📋 [CloudGuard] Absence Plan Activated — ${userId} (${absencePlan.totalDays}d)`,
    html:    wrap(`Absence Plan: <span>${absencePlan.totalDays} Days</span>`, body, 'info'),
    text:    `CloudGuard: Absence plan activated for ${userId} in ${accountId}. ${absencePlan.totalDays} days from ${absencePlan.startDate}.`,
  });
}

async function sendAutoFixResult({ accountId, fixes = [], to }) {
  const succeeded = fixes.filter(f => f.status === 'success').length;
  const failed    = fixes.filter(f => f.status === 'failed').length;

  const rows = fixes.map(f => `
    <tr>
      <td><span class="badge badge-${f.status === 'success' ? 'ok' : 'critical'}">${f.status}</span></td>
      <td style="font-family:monospace;font-size:12px">${f.resource}</td>
      <td>${f.action}</td>
      <td style="color:#555;font-size:12px">${f.details || ''}</td>
    </tr>`).join('');

  const body = `
    <div class="alert-box">
      Auto-fix completed in account <code>${accountId}</code>:
      <strong style="color:#c6f135">${succeeded} succeeded</strong>,
      <strong style="color:#ff4747">${failed} failed</strong>.
    </div>
    <table class="data">
      <thead><tr><th>Status</th><th>Resource</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  return send({
    to,
    subject: `🔧 [CloudGuard] Auto-Fix Complete — ${succeeded}/${fixes.length} fixed in ${accountId}`,
    html:    wrap(`Auto-Fix Results: <span>${succeeded}/${fixes.length}</span> Fixed`, body, succeeded === fixes.length ? 'success' : 'high'),
    text:    `CloudGuard Auto-Fix: ${succeeded} of ${fixes.length} issues fixed in ${accountId}.`,
  });
}

async function sendWeeklySummary({ accountId, summary, to }) {
  const body = `
    <p>Your weekly CloudGuard security &amp; cost summary for account <code>${accountId}</code>.</p>
    <table class="data" style="margin-top:16px">
      <thead><tr><th>Metric</th><th>Value</th><th>Change</th></tr></thead>
      <tbody>
        <tr>
          <td>Security Score</td>
          <td style="color:#c6f135;font-family:monospace;font-weight:700">${summary.securityScore}/100</td>
          <td style="color:${summary.scoreChange >= 0 ? '#c6f135' : '#ff4747'};font-family:monospace">${summary.scoreChange >= 0 ? '+' : ''}${summary.scoreChange}</td>
        </tr>
        <tr>
          <td>Critical Issues</td>
          <td style="color:#ff4747;font-family:monospace">${summary.criticalIssues}</td>
          <td style="color:#777;font-family:monospace">${summary.criticalChange >= 0 ? '+' : ''}${summary.criticalChange}</td>
        </tr>
        <tr>
          <td>Monthly Spend</td>
          <td style="color:#ffb547;font-family:monospace">$${summary.monthlyCost?.toFixed(2)}</td>
          <td style="color:${summary.costChange <= 0 ? '#c6f135' : '#ffb547'};font-family:monospace">${summary.costChange >= 0 ? '+' : ''}${summary.costChange?.toFixed(1)}%</td>
        </tr>
        <tr>
          <td>Auto-Fixes Applied</td>
          <td style="color:#c6f135;font-family:monospace">${summary.autoFixes}</td>
          <td></td>
        </tr>
      </tbody>
    </table>`;

  return send({
    to,
    subject: `📊 [CloudGuard] Weekly Summary — ${accountId} | Score: ${summary.securityScore}/100`,
    html:    wrap(`Weekly Security Summary: <span>${accountId}</span>`, body, 'info'),
    text:    `CloudGuard Weekly Summary: Security ${summary.securityScore}/100, Critical Issues: ${summary.criticalIssues}, Spend: $${summary.monthlyCost?.toFixed(2)}`,
  });
}

module.exports = {
  send,
  sendSecurityAlert,
  sendCostAlert,
  sendAbsenceAlert,
  sendAbsencePlan,
  sendAutoFixResult,
  sendWeeklySummary,
};