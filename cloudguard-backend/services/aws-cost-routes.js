// services/email.js — CloudGuard Pro Email Service
// Supports: Resend API (primary), SendGrid, SMTP (nodemailer) fallback
'use strict';

const alertRecipients = () => (process.env.ALERT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
const appUrl          = process.env.APP_URL || 'https://automated-cloud-security-and-cost.onrender.com';

// ── Detect which provider is configured ──────────────────────────────────────
function detectProvider() {
  if (process.env.RESEND_API_KEY)  return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}

async function getConfig() {
  const provider = detectProvider();
  return {
    configured:  !!provider,
    provider:    provider || 'none',
    alertEmail:  alertRecipients().join(', ') || '(not set)',
    smtp: process.env.SMTP_USER ? { user: process.env.SMTP_USER } : null,
  };
}

// ── Low-level send function ───────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const provider = detectProvider();
  if (!provider) throw new Error('No email provider configured. Set RESEND_API_KEY or SMTP_USER+SMTP_PASS in your .env file.');

  const toAddresses = Array.isArray(to) ? to : [to];
  if (!toAddresses.length) throw new Error('No recipient email address specified');

  if (provider === 'resend') {
    const from = process.env.SENDGRID_FROM || 'onboarding@resend.dev';
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from, to: toAddresses, subject, html }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || `Resend error: ${resp.status}`);
    return { provider: 'resend', id: data.id };
  }

  if (provider === 'sendgrid') {
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from: { email: process.env.SENDGRID_FROM || 'noreply@cloudguard.pro' },
        personalizations: [{ to: toAddresses.map(e => ({ email: e })) }],
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.errors?.[0]?.message || `SendGrid error: ${resp.status}`); }
    return { provider: 'sendgrid' };
  }

  if (provider === 'smtp') {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const info = await transporter.sendMail({ from: `CloudGuard Pro <${process.env.SMTP_USER}>`, to: toAddresses.join(','), subject, html });
    return { provider: 'smtp', messageId: info.messageId };
  }
}

// ── Email HTML template ────────────────────────────────────────────────────────
function emailTemplate(title, body, badgeColor = '#c6f135') {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d0d0d;color:#f0f0eb;margin:0;padding:20px}
  .container{max-width:600px;margin:0 auto;background:#141414;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)}
  .header{background:#1e1e1e;padding:20px 24px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:12px}
  .logo{width:36px;height:36px;background:${badgeColor};border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:#0d0d0d;font-size:14px}
  .header-title{font-size:18px;font-weight:700;color:#f0f0eb}
  .header-sub{font-size:11px;color:#666;margin-top:2px}
  .body{padding:24px}
  .metric-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
  .metric-label{font-size:12px;color:#888}
  .metric-value{font-size:13px;font-weight:600}
  .issue-item{padding:10px 14px;border-radius:8px;margin-bottom:8px;border:1px solid}
  .critical{background:rgba(255,71,71,0.1);border-color:rgba(255,71,71,0.2);color:#ff4747}
  .high{background:rgba(255,181,71,0.1);border-color:rgba(255,181,71,0.2);color:#ffb547}
  .medium{background:rgba(71,200,255,0.1);border-color:rgba(71,200,255,0.2);color:#47c8ff}
  .ok{background:rgba(198,241,53,0.1);border-color:rgba(198,241,53,0.2);color:#c6f135}
  .btn{display:inline-block;padding:10px 20px;background:${badgeColor};color:#0d0d0d;text-decoration:none;border-radius:7px;font-weight:700;font-size:13px;margin-top:16px}
  .footer{padding:16px 24px;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:#555;text-align:center}
  table{width:100%;border-collapse:collapse}
</style></head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">CG</div>
    <div>
      <div class="header-title">${title}</div>
      <div class="header-sub">CloudGuard Pro · ${new Date().toLocaleString()}</div>
    </div>
  </div>
  <div class="body">${body}</div>
  <div class="footer">
    <a href="${appUrl}" style="color:#c6f135;text-decoration:none">Open CloudGuard Pro Dashboard →</a><br><br>
    CloudGuard Pro v2.5.0 · Automated AWS Security &amp; Cost Monitor
  </div>
</div>
</body></html>`;
}

// ── Individual email types ──────────────────────────────────────────────────
async function sendTest(to) {
  const recipients = to ? [to] : alertRecipients();
  if (!recipients.length) throw new Error('No recipient. Pass a "to" address or set ALERT_EMAIL in .env');

  const html = emailTemplate(
    '✅ CloudGuard Pro — Test Email',
    `<h2 style="color:#c6f135;margin-top:0">Email notifications are working!</h2>
     <p style="color:#aaa">Your CloudGuard Pro alert system is correctly configured and ready to send security, cost, and absence notifications.</p>
     <div class="metric-row"><span class="metric-label">Provider</span><span class="metric-value" style="color:#c6f135">${detectProvider() || 'none'}</span></div>
     <div class="metric-row"><span class="metric-label">Recipient</span><span class="metric-value">${recipients.join(', ')}</span></div>
     <div class="metric-row"><span class="metric-label">Sent at</span><span class="metric-value">${new Date().toLocaleString()}</span></div>
     <a class="btn" href="${appUrl}">Open Dashboard →</a>`
  );
  return sendEmail({ to: recipients, subject: '✅ CloudGuard Pro — Email Test', html });
}

async function sendSecurityAlert(issues, to) {
  const recipients = to ? [to] : alertRecipients();
  const critical = issues.filter(i => i.severity === 'critical');
  const high     = issues.filter(i => i.severity === 'high');

  const issuesHtml = issues.slice(0, 10).map(i => `
    <div class="issue-item ${i.severity || 'medium'}">
      <strong>${i.resource}</strong>
      <div style="font-size:12px;margin-top:4px;opacity:.8">${(i.issues || []).join(' · ')}</div>
    </div>`).join('');

  const html = emailTemplate(
    '🔴 CloudGuard — Security Alert',
    `<h2 style="color:#ff4747;margin-top:0">⚠️ Security Issues Detected</h2>
     <div class="metric-row"><span class="metric-label">Critical Issues</span><span class="metric-value" style="color:#ff4747">${critical.length}</span></div>
     <div class="metric-row"><span class="metric-label">High Severity</span><span class="metric-value" style="color:#ffb547">${high.length}</span></div>
     <div class="metric-row"><span class="metric-label">Total Issues</span><span class="metric-value">${issues.length}</span></div>
     <h3 style="font-size:13px;color:#aaa;margin:16px 0 8px">Issues Found:</h3>
     ${issuesHtml}
     <a class="btn" href="${appUrl}" style="background:#ff4747">View &amp; Fix Issues →</a>`,
    '#ff4747'
  );
  return sendEmail({ to: recipients, subject: `🔴 CloudGuard Alert: ${issues.length} Security Issues Found`, html });
}

async function sendCostAlert({ currentCost, forecastedCost, threshold }, to) {
  const recipients = to ? [to] : alertRecipients();
  const html = emailTemplate(
    '💰 CloudGuard — Cost Alert',
    `<h2 style="color:#ffb547;margin-top:0">💰 Cost Threshold Exceeded</h2>
     <p style="color:#aaa">Your AWS spend has exceeded the configured alert threshold.</p>
     <div class="metric-row"><span class="metric-label">Current Month Spend</span><span class="metric-value" style="color:#c6f135">$${(currentCost||0).toFixed(2)}</span></div>
     <div class="metric-row"><span class="metric-label">Forecasted (EOM)</span><span class="metric-value" style="color:#ffb547">$${(forecastedCost||currentCost||0).toFixed(2)}</span></div>
     <div class="metric-row"><span class="metric-label">Alert Threshold</span><span class="metric-value" style="color:#ff4747">$${threshold}</span></div>
     <a class="btn" href="${appUrl}" style="background:#ffb547">Review Costs →</a>`,
    '#ffb547'
  );
  return sendEmail({ to: recipients, subject: `💰 CloudGuard: Monthly spend $${(currentCost||0).toFixed(0)} (Threshold: $${threshold})`, html });
}

async function sendWeeklySummary(summary, to) {
  const recipients = to ? [to] : alertRecipients();
  const scoreColor = (summary.securityScore||0) >= 80 ? '#c6f135' : (summary.securityScore||0) >= 60 ? '#ffb547' : '#ff4747';
  const html = emailTemplate(
    '📊 CloudGuard — Weekly Summary',
    `<h2 style="color:#c6f135;margin-top:0">📊 Weekly AWS Report</h2>
     <div class="metric-row"><span class="metric-label">Security Score</span><span class="metric-value" style="color:${scoreColor}">${summary.securityScore ?? '—'} / 100</span></div>
     <div class="metric-row"><span class="metric-label">Critical Issues</span><span class="metric-value" style="color:#ff4747">${summary.criticalIssues ?? '—'}</span></div>
     <div class="metric-row"><span class="metric-label">Monthly Cost</span><span class="metric-value" style="color:#c6f135">$${(summary.monthlyCost||0).toFixed(2)}</span></div>
     <div class="metric-row"><span class="metric-label">Cost Change (MoM)</span><span class="metric-value" style="color:${(summary.costChange||0)>5?'#ff4747':'#c6f135'}">${summary.costChange>=0?'+':''}${summary.costChange||0}%</span></div>
     <div class="metric-row"><span class="metric-label">Auto-Fixes Applied</span><span class="metric-value">${summary.autoFixes ?? 0}</span></div>
     <a class="btn" href="${appUrl}">Open Dashboard →</a>`
  );
  return sendEmail({ to: recipients, subject: `📊 CloudGuard Weekly: Score ${summary.securityScore ?? '—'}/100 · $${(summary.monthlyCost||0).toFixed(0)} this month`, html });
}

async function sendAutoFixReport(results, to) {
  const recipients = to ? [to] : alertRecipients();
  if (!recipients.length) return;
  const succeeded = results.filter(r => r.status === 'success');
  const failed    = results.filter(r => r.status === 'failed');

  const html = emailTemplate(
    '🔧 CloudGuard — Auto-Fix Report',
    `<h2 style="color:#c6f135;margin-top:0">🔧 Auto-Fix Results</h2>
     <div class="metric-row"><span class="metric-label">Succeeded</span><span class="metric-value" style="color:#c6f135">${succeeded.length}</span></div>
     <div class="metric-row"><span class="metric-label">Failed</span><span class="metric-value" style="color:#ff4747">${failed.length}</span></div>
     <h3 style="font-size:13px;color:#aaa;margin:16px 0 8px">Applied Fixes:</h3>
     ${succeeded.slice(0,10).map(r => `<div class="issue-item ok">✓ <strong>${r.resource}</strong> — ${r.details||r.fixId}</div>`).join('')}
     ${failed.slice(0,5).map(r => `<div class="issue-item critical">✕ <strong>${r.resource}</strong> — ${r.details||'Failed'}</div>`).join('')}
     <a class="btn" href="${appUrl}">View Dashboard →</a>`
  );
  return sendEmail({ to: recipients, subject: `🔧 CloudGuard Auto-Fix: ${succeeded.length} fixes applied`, html });
}

async function sendAbsencePlanEmail(plan, to) {
  const recipients = to ? [to] : alertRecipients();
  if (!recipients.length) return;

  const html = emailTemplate(
    `📅 Absence Plan — ${plan.userId}`,
    `<h2 style="color:#a78bfa;margin-top:0">📅 Absence Plan Created</h2>
     <div class="metric-row"><span class="metric-label">User</span><span class="metric-value">${plan.userId}</span></div>
     <div class="metric-row"><span class="metric-label">Duration</span><span class="metric-value">${plan.totalDays} days</span></div>
     <div class="metric-row"><span class="metric-label">Start Date</span><span class="metric-value">${plan.startDate}</span></div>
     <div class="metric-row"><span class="metric-label">Auto-Stop Threshold</span><span class="metric-value" style="color:#ff4747">Day ${plan.autoStopDay || 5}</span></div>
     <h3 style="font-size:13px;color:#aaa;margin:16px 0 8px">Schedule:</h3>
     ${(plan.days||[]).slice(0,7).map(d => `<div class="metric-row"><span class="metric-label">Day ${d.day} — ${d.date}</span><span class="metric-value" style="font-size:11px">${(d.actions||[]).join(', ')}</span></div>`).join('')}
     <a class="btn" href="${appUrl}" style="background:#a78bfa">View Absence Manager →</a>`,
    '#a78bfa'
  );
  return sendEmail({ to: recipients, subject: `📅 CloudGuard: Absence plan created for ${plan.userId} (${plan.totalDays} days)`, html });
}

module.exports = { getConfig, sendTest, sendSecurityAlert, sendCostAlert, sendWeeklySummary, sendAutoFixReport, sendAbsencePlanEmail, detectProvider };
