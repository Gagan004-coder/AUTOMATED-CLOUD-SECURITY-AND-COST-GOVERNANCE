// services/email.js — CloudGuard Pro Email Service v2.6
// Supports: Resend API (primary), SendGrid, SMTP (nodemailer) fallback
// Fixed: template alignment, table-safe layouts for all email clients
'use strict';

const db = require('./db');

const alertRecipients = () =>
  (process.env.ALERT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);

const appUrl = (process.env.APP_URL || 'https://automated-cloud-security-and-cost.onrender.com')
  .replace(/\/$/, '');

// ── Detect which provider is configured ──────────────────────────────────────
function detectProvider() {
  if (process.env.RESEND_API_KEY)    return 'resend';
  if (process.env.SENDGRID_API_KEY)  return 'sendgrid';
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
async function sendEmail({ to, subject, html, accountId, emailType }) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      'No email provider configured. Set RESEND_API_KEY or SMTP_USER+SMTP_PASS in your .env file.'
    );
  }

  const toAddresses = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!toAddresses.length) throw new Error('No recipient email address specified');

  let result;

  if (provider === 'resend') {
    const from = process.env.RESEND_FROM || process.env.SENDGRID_FROM || 'onboarding@resend.dev';
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from, to: toAddresses, subject, html }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || `Resend error: ${resp.status}`);
    result = { provider: 'resend', id: data.id };
  }

  else if (provider === 'sendgrid') {
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from: { email: process.env.SENDGRID_FROM || 'noreply@cloudguard.pro' },
        personalizations: [{ to: toAddresses.map(e => ({ email: e })) }],
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.errors?.[0]?.message || `SendGrid error: ${resp.status}`);
    }
    result = { provider: 'sendgrid' };
  }

  else if (provider === 'smtp') {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const info = await transporter.sendMail({
      from:    `CloudGuard Pro <${process.env.SMTP_USER}>`,
      to:      toAddresses.join(','),
      subject,
      html,
    });
    result = { provider: 'smtp', messageId: info.messageId };
  }

  // Log to DB
  db.logEmail({
    emailType:  emailType  || 'general',
    recipient:  toAddresses,
    subject,
    status:     'sent',
    provider,
    accountId:  accountId  || null,
  });

  return result;
}

// ── Master HTML Email Template ─────────────────────────────────────────────────
// Uses table-based layout for maximum email client compatibility
// Works in Gmail, Outlook, Apple Mail, Yahoo Mail
function emailTemplate({ title, previewText = '', accentColor = '#c6f135', bodyHtml }) {
  const stamp = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    /* Reset */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; background-color: #0d0d0d; width: 100% !important; }
    a { color: ${accentColor}; }

    /* Main wrapper */
    .email-wrapper { background-color: #0d0d0d; padding: 24px 16px; }
    .email-container { max-width: 600px; margin: 0 auto; background-color: #141414;
      border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08); }

    /* Header */
    .email-header { background-color: #1a1a1a; padding: 20px 28px;
      border-bottom: 1px solid rgba(255,255,255,0.07); }
    .logo-cell { vertical-align: middle; padding-right: 14px; }
    .logo-box { width: 40px; height: 40px; background-color: ${accentColor};
      border-radius: 9px; text-align: center; line-height: 40px;
      font-family: Arial, sans-serif; font-size: 14px; font-weight: 700; color: #0d0d0d; }
    .header-title { font-family: 'Segoe UI', Arial, sans-serif; font-size: 18px;
      font-weight: 700; color: #f0f0eb; margin: 0 0 3px 0; line-height: 1.3; }
    .header-sub { font-family: 'Courier New', Courier, monospace; font-size: 11px;
      color: #666666; margin: 0; }

    /* Top accent bar */
    .accent-bar { height: 3px; background-color: ${accentColor}; font-size: 0; line-height: 0; }

    /* Body */
    .email-body { padding: 28px 28px 20px 28px; }
    .section-title { font-family: 'Segoe UI', Arial, sans-serif; font-size: 20px;
      font-weight: 700; color: ${accentColor}; margin: 0 0 16px 0; }
    .body-text { font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px;
      color: #aaaaaa; line-height: 1.6; margin: 0 0 16px 0; }

    /* Metric cards */
    .metrics-table { width: 100%; border-collapse: separate; border-spacing: 8px;
      margin-bottom: 20px; }
    .metric-card { background-color: #1e1e1e; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.06); padding: 14px 16px;
      text-align: center; vertical-align: top; }
    .metric-label { font-family: 'Courier New', Courier, monospace; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.1em; color: #666666;
      display: block; margin-bottom: 6px; }
    .metric-value { font-family: 'Segoe UI', Arial, sans-serif; font-size: 22px;
      font-weight: 700; line-height: 1.2; }

    /* Separator */
    .divider { height: 1px; background-color: rgba(255,255,255,0.06);
      margin: 20px 0; font-size: 0; line-height: 0; }

    /* Issue / alert rows */
    .issue-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .issue-row td { padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .issue-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block;
      vertical-align: middle; margin-right: 8px; }
    .issue-resource { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
      font-weight: 600; color: #f0f0eb; }
    .issue-detail { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px;
      color: #888888; margin-top: 3px; }

    /* Severity badge */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-family: 'Courier New', Courier, monospace; font-size: 10px;
      font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      vertical-align: middle; }
    .badge-critical { background-color: rgba(255,71,71,0.15); color: #ff4747;
      border: 1px solid rgba(255,71,71,0.3); }
    .badge-high     { background-color: rgba(255,181,71,0.15); color: #ffb547;
      border: 1px solid rgba(255,181,71,0.3); }
    .badge-medium   { background-color: rgba(71,200,255,0.12); color: #47c8ff;
      border: 1px solid rgba(71,200,255,0.25); }
    .badge-low      { background-color: rgba(198,241,53,0.08); color: #c6f135;
      border: 1px solid rgba(198,241,53,0.2); }
    .badge-ok       { background-color: rgba(198,241,53,0.12); color: #c6f135;
      border: 1px solid rgba(198,241,53,0.25); }

    /* Section heading */
    .section-heading { font-family: 'Courier New', Courier, monospace; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.12em; color: #666666;
      padding: 16px 0 8px 0; margin: 0; border-bottom: 1px solid rgba(255,255,255,0.06); }

    /* CTA button */
    .cta-table { margin: 24px 0 8px 0; }
    .cta-btn { display: inline-block; padding: 12px 28px; background-color: ${accentColor};
      color: #0d0d0d !important; text-decoration: none; border-radius: 8px;
      font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; font-weight: 700;
      letter-spacing: 0.01em; }

    /* Footer */
    .email-footer { background-color: #0f0f0f; padding: 16px 28px;
      border-top: 1px solid rgba(255,255,255,0.05); text-align: center; }
    .footer-link { font-family: 'Courier New', Courier, monospace; font-size: 11px;
      color: ${accentColor} !important; text-decoration: none; }
    .footer-copy { font-family: 'Courier New', Courier, monospace; font-size: 10px;
      color: #444444; margin-top: 6px; }

    /* Data table */
    .data-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
    .data-table th { background-color: #1e1e1e; color: #888888;
      font-family: 'Courier New', Courier, monospace; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.08em;
      padding: 8px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .data-table td { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.04);
      font-family: 'Segoe UI', Arial, sans-serif; color: #cccccc; vertical-align: middle; }
    .data-table tr:last-child td { border-bottom: none; }

    /* KV row (label: value) */
    .kv-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .kv-table td { padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      vertical-align: middle; }
    .kv-label { font-family: 'Courier New', Courier, monospace; font-size: 11px;
      color: #777777; width: 45%; }
    .kv-value { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
      font-weight: 600; color: #f0f0eb; text-align: right; }

    @media screen and (max-width: 600px) {
      .email-wrapper  { padding: 12px 8px !important; }
      .email-header   { padding: 16px 18px !important; }
      .email-body     { padding: 20px 18px !important; }
      .metrics-table,
      .metrics-table tbody,
      .metrics-table tr,
      .metrics-table td { display: block !important; width: 100% !important;
        box-sizing: border-box !important; }
      .metric-card { margin-bottom: 8px !important; text-align: left !important; }
    }
  </style>
</head>
<body>
<!-- Preview text (hidden) -->
<div style="display:none;max-height:0;overflow:hidden;color:transparent">
  ${previewText || title}
</div>

<div class="email-wrapper">
  <table class="email-container" cellpadding="0" cellspacing="0" role="presentation" width="100%">

    <!-- Accent bar -->
    <tr><td class="accent-bar"></td></tr>

    <!-- Header -->
    <tr>
      <td class="email-header">
        <table cellpadding="0" cellspacing="0" role="presentation" width="100%">
          <tr>
            <td class="logo-cell" width="54">
              <div class="logo-box">CG</div>
            </td>
            <td>
              <p class="header-title">${title}</p>
              <p class="header-sub">CloudGuard Pro &nbsp;·&nbsp; ${stamp}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td class="email-body">
        ${bodyHtml}

        <!-- CTA -->
        <table class="cta-table" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td>
              <a href="${appUrl}" class="cta-btn">Open CloudGuard Dashboard →</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td class="email-footer">
        <a href="${appUrl}" class="footer-link">${appUrl}</a>
        <p class="footer-copy">CloudGuard Pro v2.6.0 &nbsp;·&nbsp; Automated AWS Security &amp; Cost Monitor<br>
        This is an automated notification — do not reply to this email.</p>
      </td>
    </tr>

  </table>
</div>
</body>
</html>`;
}

// ── Reusable building blocks ──────────────────────────────────────────────────
function metricCards(cards) {
  // cards: [{label, value, color}]
  // Render 3 per row, then wrap
  const rows = [];
  for (let i = 0; i < cards.length; i += 3) {
    const slice = cards.slice(i, i + 3);
    const tds = slice.map(c => `
      <td class="metric-card" width="${Math.floor(100 / slice.length)}%">
        <span class="metric-label">${c.label}</span>
        <span class="metric-value" style="color:${c.color || '#f0f0eb'}">${c.value}</span>
      </td>`).join('');
    rows.push(`<tr>${tds}</tr>`);
  }
  return `<table class="metrics-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
    ${rows.join('\n')}
  </table>`;
}

function sectionHeading(text) {
  return `<p class="section-heading">${text}</p>`;
}

function divider() {
  return `<div class="divider"></div>`;
}

function kvRows(pairs) {
  // pairs: [{label, value, color?}]
  const rows = pairs.map(p => `
    <tr>
      <td class="kv-label">${p.label}</td>
      <td class="kv-value" style="${p.color ? 'color:' + p.color : ''}">${p.value}</td>
    </tr>`).join('');
  return `<table class="kv-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
    ${rows}
  </table>`;
}

function severityDot(severity) {
  const colors = { critical: '#ff4747', high: '#ffb547', medium: '#47c8ff', low: '#aaaaaa', ok: '#c6f135' };
  return `<span class="issue-dot" style="background-color:${colors[severity] || '#888888'}"></span>`;
}

// ── Individual email senders ─────────────────────────────────────────────────

async function sendTest(to, accountId) {
  const recipients = to ? [to] : alertRecipients();
  if (!recipients.length) throw new Error('No recipient. Pass a "to" address or set ALERT_EMAIL in .env');

  const provider = detectProvider();
  const bodyHtml = `
    <p class="section-title">✅ Email Notifications Working</p>
    <p class="body-text">
      Your CloudGuard Pro alert system is correctly configured and ready to send security,
      cost, and absence notifications.
    </p>
    ${metricCards([
      { label: 'Provider',   value: provider || 'none',        color: '#c6f135' },
      { label: 'Recipient',  value: recipients[0],             color: '#f0f0eb' },
      { label: 'Status',     value: 'Connected',               color: '#c6f135' },
    ])}
    ${kvRows([
      { label: 'All Recipients', value: recipients.join(', ') },
      { label: 'Sent At',        value: new Date().toLocaleString() },
      { label: 'Version',        value: 'CloudGuard Pro v2.6.0' },
    ])}
  `;

  const html = emailTemplate({
    title:       '✅ CloudGuard Pro — Test Email',
    previewText: 'Your email notifications are working correctly.',
    accentColor: '#c6f135',
    bodyHtml,
  });

  return sendEmail({ to: recipients, subject: '✅ CloudGuard Pro — Email Test', html, emailType: 'test', accountId });
}

async function sendSecurityAlert(issues, to, accountId) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : alertRecipients();
  if (!recipients.length) return;

  const critical = issues.filter(i => i.severity === 'critical');
  const high     = issues.filter(i => i.severity === 'high');
  const medium   = issues.filter(i => i.severity === 'medium');

  const issueRows = issues.slice(0, 12).map(i => {
    const sev = i.severity || 'medium';
    return `
    <tr class="issue-row">
      <td style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.04)">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td>
              ${severityDot(sev)}
              <span class="issue-resource">${i.resource || 'Unknown Resource'}</span>
              &nbsp;&nbsp;<span class="badge badge-${sev}">${sev}</span>
            </td>
            <td style="text-align:right;min-width:60px;vertical-align:top">
              <span style="font-family:'Courier New',monospace;font-size:10px;color:#555">
                ${i.service ? i.service.toUpperCase() : ''}
              </span>
            </td>
          </tr>
          <tr>
            <td colspan="2">
              <span class="issue-detail">${(i.issues || [i.issue] || []).join(' · ')}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const bodyHtml = `
    <p class="section-title">⚠️ Security Issues Detected</p>
    <p class="body-text">A security scan of your AWS account has identified the following issues
    requiring attention.</p>

    ${metricCards([
      { label: 'Critical',  value: critical.length, color: '#ff4747' },
      { label: 'High',      value: high.length,     color: '#ffb547' },
      { label: 'Medium',    value: medium.length,   color: '#47c8ff' },
    ])}

    ${sectionHeading('⚠️ Issues Found')}
    <table class="issue-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      ${issueRows}
    </table>
    ${issues.length > 12 ? `<p style="font-family:'Courier New',monospace;font-size:11px;color:#666;text-align:center">+${issues.length - 12} more issues — open dashboard for full report</p>` : ''}
  `;

  const html = emailTemplate({
    title:       '🔴 CloudGuard — Security Alert',
    previewText: `${issues.length} security issue(s) detected in your AWS account.`,
    accentColor: '#ff4747',
    bodyHtml,
  });

  return sendEmail({
    to:        recipients,
    subject:   `🔴 CloudGuard Alert: ${issues.length} Security Issue(s) — ${critical.length} Critical`,
    html,
    emailType: 'security',
    accountId,
  });
}

async function sendCostAlert({ currentCost, forecastedCost, threshold, percentChange, serviceBreakdown }, to, accountId) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : alertRecipients();
  if (!recipients.length) return;

  const pctColor = (percentChange || 0) > 10 ? '#ff4747' : (percentChange || 0) > 0 ? '#ffb547' : '#c6f135';
  const topServices = (serviceBreakdown || []).slice(0, 5);

  const serviceRows = topServices.map(s => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#cccccc">
        ${s.service?.replace('Amazon ', '').replace('AWS ', '') || s.service}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Courier New',monospace;font-size:13px;color:#c6f135;
        font-weight:700;text-align:right">
        $${(s.cost || 0).toFixed(2)}
      </td>
    </tr>`).join('');

  const bodyHtml = `
    <p class="section-title">💰 Cost Threshold Exceeded</p>
    <p class="body-text">Your AWS spend has exceeded the configured alert threshold of
    <strong style="color:#ff4747">$${threshold}</strong>.</p>

    ${metricCards([
      { label: 'This Month',  value: `$${(currentCost || 0).toFixed(2)}`,    color: '#c6f135' },
      { label: 'Forecasted',  value: `$${(forecastedCost || currentCost || 0).toFixed(2)}`, color: '#ffb547' },
      { label: 'vs Threshold',value: `$${threshold}`,                         color: '#ff4747' },
    ])}

    ${kvRows([
      { label: 'Month-over-Month Change',
        value: `${(percentChange || 0) > 0 ? '+' : ''}${percentChange || 0}%`,
        color: pctColor },
      { label: 'Alert Threshold',  value: `$${threshold}`, color: '#ff4747' },
      { label: 'Check Date',       value: new Date().toLocaleDateString() },
    ])}

    ${topServices.length ? `
      ${sectionHeading('📊 Top Services by Cost')}
      <table class="data-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
        <thead>
          <tr>
            <th>Service</th>
            <th style="text-align:right">This Month</th>
          </tr>
        </thead>
        <tbody>${serviceRows}</tbody>
      </table>` : ''}
  `;

  const html = emailTemplate({
    title:       '💰 CloudGuard — Cost Alert',
    previewText: `AWS spend $${(currentCost || 0).toFixed(0)} has exceeded your $${threshold} threshold.`,
    accentColor: '#ffb547',
    bodyHtml,
  });

  return sendEmail({
    to:        recipients,
    subject:   `💰 CloudGuard Cost Alert: $${(currentCost || 0).toFixed(0)} spent (Threshold: $${threshold})`,
    html,
    emailType: 'cost',
    accountId,
  });
}

async function sendWeeklySummary(summary, to, accountId) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : alertRecipients();
  if (!recipients.length) return;

  const score = summary.securityScore ?? 0;
  const scoreColor = score >= 80 ? '#c6f135' : score >= 60 ? '#ffb547' : '#ff4747';
  const costChange = summary.costChange || 0;

  const topSvcs = (summary.serviceBreakdown || []).slice(0, 5);
  const serviceRows = topSvcs.map(s => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#cccccc">
        ${(s.service || '').replace('Amazon ', '').replace('AWS ', '')}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Courier New',monospace;font-size:12px;color:#c6f135;text-align:right">
        $${(s.cost || 0).toFixed(2)}
      </td>
    </tr>`).join('');

  const bodyHtml = `
    <p class="section-title">📊 Weekly AWS Report</p>
    <p class="body-text">Here is your weekly CloudGuard Pro summary for your AWS account.</p>

    ${metricCards([
      { label: 'Security Score',  value: `${score}/100`,                    color: scoreColor },
      { label: 'Monthly Cost',    value: `$${(summary.monthlyCost || 0).toFixed(2)}`, color: '#c6f135' },
      { label: 'Auto-Fixes',      value: summary.autoFixes ?? 0,            color: '#a78bfa' },
    ])}

    ${kvRows([
      { label: 'Critical Issues',       value: summary.criticalIssues ?? 0,  color: summary.criticalIssues > 0 ? '#ff4747' : '#c6f135' },
      { label: 'Cost Change (MoM)',     value: `${costChange >= 0 ? '+' : ''}${costChange}%`, color: costChange > 5 ? '#ff4747' : '#c6f135' },
      { label: 'Users Without MFA',     value: summary.usersWithoutMFA ?? 0, color: (summary.usersWithoutMFA ?? 0) > 0 ? '#ffb547' : '#c6f135' },
      { label: 'S3 Vulnerable Buckets', value: summary.vulnerableBuckets ?? 0, color: (summary.vulnerableBuckets ?? 0) > 0 ? '#ff4747' : '#c6f135' },
      { label: 'Report Period',         value: `Week of ${new Date().toLocaleDateString()}` },
    ])}

    ${topSvcs.length ? `
      ${sectionHeading('💸 Cost Breakdown by Service')}
      <table class="data-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
        <thead><tr><th>Service</th><th style="text-align:right">Cost</th></tr></thead>
        <tbody>${serviceRows}</tbody>
      </table>` : ''}
  `;

  const html = emailTemplate({
    title:       '📊 CloudGuard — Weekly Summary',
    previewText: `Score ${score}/100 · $${(summary.monthlyCost || 0).toFixed(0)} this month`,
    accentColor: '#c6f135',
    bodyHtml,
  });

  return sendEmail({
    to:        recipients,
    subject:   `📊 CloudGuard Weekly: Score ${score}/100 · $${(summary.monthlyCost || 0).toFixed(0)}/mo`,
    html,
    emailType: 'weekly',
    accountId,
  });
}

async function sendAutoFixReport(results, to, accountId) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : alertRecipients();
  if (!recipients.length) return;

  const succeeded = results.filter(r => r.status === 'success');
  const failed    = results.filter(r => r.status === 'failed');

  const fixRows = results.slice(0, 15).map(r => `
    <tr>
      <td style="padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.04)">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td>
              <span style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;
                color:${r.status === 'success' ? '#c6f135' : '#ff4747'};font-weight:600">
                ${r.status === 'success' ? '✓' : '✕'} ${r.resource || r.action || r.fixId}
              </span>
            </td>
            <td style="text-align:right">
              <span class="badge ${r.status === 'success' ? 'badge-ok' : 'badge-critical'}">
                ${r.status}
              </span>
            </td>
          </tr>
          <tr>
            <td colspan="2">
              <span style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#777">
                ${r.details || r.action || ''}
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  const bodyHtml = `
    <p class="section-title">🔧 Auto-Fix Results</p>
    <p class="body-text">The following automated security and cost fixes have been applied to your
    AWS account.</p>

    ${metricCards([
      { label: 'Succeeded', value: succeeded.length, color: '#c6f135' },
      { label: 'Failed',    value: failed.length,    color: failed.length > 0 ? '#ff4747' : '#aaaaaa' },
      { label: 'Total',     value: results.length,   color: '#f0f0eb' },
    ])}

    ${sectionHeading('🔧 Fix Details')}
    <table class="data-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <tbody>${fixRows}</tbody>
    </table>
    ${results.length > 15 ? `<p style="font-family:'Courier New',monospace;font-size:10px;color:#555;text-align:center">+${results.length - 15} more fixes in dashboard</p>` : ''}
  `;

  const html = emailTemplate({
    title:       '🔧 CloudGuard — Auto-Fix Report',
    previewText: `${succeeded.length} fix(es) applied successfully.`,
    accentColor: '#c6f135',
    bodyHtml,
  });

  return sendEmail({
    to:        recipients,
    subject:   `🔧 CloudGuard Auto-Fix: ${succeeded.length} fix(es) applied`,
    html,
    emailType: 'autofix',
    accountId,
  });
}

async function sendAbsencePlanEmail(plan, to, accountId) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : alertRecipients();
  if (!recipients.length) return;

  const riskColors = { low: '#c6f135', medium: '#ffb547', critical: '#ff4747' };

  const scheduleRows = (plan.days || []).slice(0, 8).map(d => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Courier New',monospace;font-size:11px;color:#888;width:80px">
        Day ${d.day}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#aaa;width:100px">
        ${d.date}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
        font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#cccccc">
        ${(d.actions || []).join(', ')}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);text-align:right">
        <span class="badge" style="background-color:rgba(255,255,255,0.05);
          color:${riskColors[d.risk] || '#aaa'};border:1px solid rgba(255,255,255,0.1)">
          ${d.risk}
        </span>
      </td>
    </tr>`).join('');

  const bodyHtml = `
    <p class="section-title">📅 Absence Plan Created</p>
    <p class="body-text">
      An absence management plan has been created for <strong style="color:#a78bfa">${plan.userId}</strong>.
      AWS services will be automatically managed during this period.
    </p>

    ${metricCards([
      { label: 'Duration',      value: `${plan.totalDays} days`, color: '#a78bfa' },
      { label: 'Start Date',    value: plan.startDate,           color: '#f0f0eb' },
      { label: 'Auto-Stop Day', value: `Day ${plan.autoStopDay || 5}`, color: '#ff4747' },
    ])}

    ${kvRows([
      { label: 'User ID',             value: plan.userId },
      { label: 'Plan Status',         value: 'Active',    color: '#c6f135' },
      { label: 'Services Protected',  value: (plan.keepRunning || []).length > 0 ? plan.keepRunning.join(', ') : 'None specified' },
      { label: 'Created At',          value: new Date(plan.createdAt || Date.now()).toLocaleDateString() },
    ])}

    ${sectionHeading('📅 Schedule')}
    <table class="data-table" cellpadding="0" cellspacing="0" role="presentation" width="100%">
      <thead>
        <tr>
          <th>Day</th>
          <th>Date</th>
          <th>Actions</th>
          <th style="text-align:right">Risk</th>
        </tr>
      </thead>
      <tbody>${scheduleRows}</tbody>
    </table>
    ${plan.days?.length > 8 ? `<p style="font-family:'Courier New',monospace;font-size:10px;color:#555;text-align:center">+${plan.days.length - 8} more days — view full schedule in dashboard</p>` : ''}
  `;

  const html = emailTemplate({
    title:       `📅 Absence Plan — ${plan.userId}`,
    previewText: `${plan.totalDays}-day absence plan created. Auto-stop on Day ${plan.autoStopDay || 5}.`,
    accentColor: '#a78bfa',
    bodyHtml,
  });

  return sendEmail({
    to:        recipients,
    subject:   `📅 CloudGuard: Absence plan for ${plan.userId} (${plan.totalDays} days from ${plan.startDate})`,
    html,
    emailType: 'absence',
    accountId,
  });
}

module.exports = {
  getConfig,
  detectProvider,
  sendTest,
  sendSecurityAlert,
  sendCostAlert,
  sendWeeklySummary,
  sendAutoFixReport,
  sendAbsencePlanEmail,
  // expose low-level for notifications-cost-addition
  sendEmail,
};
