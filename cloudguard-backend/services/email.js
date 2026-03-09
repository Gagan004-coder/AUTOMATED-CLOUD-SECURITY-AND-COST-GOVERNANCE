const nodemailer = require('nodemailer');

const USE_RESEND   = !!process.env.RESEND_API_KEY;
const USE_SENDGRID = !!process.env.SENDGRID_API_KEY;
const USE_SMTP     = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

if (USE_RESEND)        console.log('[email] Provider: Resend');
else if (USE_SENDGRID) console.log('[email] Provider: SendGrid');
else if (USE_SMTP)     console.log('[email] Provider: SMTP');
else                   console.warn('[email] No provider configured — emails DISABLED');

async function sendViaResend({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : to.split(',').map(s => s.trim());
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `CloudGuard Pro <${process.env.SENDGRID_FROM || 'onboarding@resend.dev'}>`,
      to: recipients,
      subject,
      html: html || text,
      text: text || subject,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  console.log('[email] Sent via Resend:', subject);
  return { sent: true, provider: 'resend' };
}

async function sendViaSendGrid({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : to.split(',').map(s => s.trim());
  const body = {
    personalizations: [{ to: recipients.map(email => ({ email })) }],
    from: { email: process.env.SENDGRID_FROM || 'cloudguard@example.com' },
    subject,
    content: [
      { type: 'text/plain', value: text || subject },
      { type: 'text/html',  value: html  || text || subject },
    ],
  };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status}: ${detail}`);
  }
  const messageId = res.headers.get('x-message-id') || 'sendgrid-ok';
  console.log('[email] Sent via SendGrid:', subject, '→', recipients.join(', '), messageId);
  return { sent: true, messageId, provider: 'sendgrid' };
}

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
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

const TO = process.env.ALERT_EMAIL || '';

async function send({ to, subject, html, text }) {
  const recipients = to || TO;
  if (!recipients) return { skipped: true, reason: 'No recipient configured' };
  if (USE_RESEND)   return sendViaResend({ to: recipients, subject, html, text });
  if (USE_SENDGRID) return sendViaSendGrid({ to: recipients, subject, html, text });
  if (USE_SMTP)     return sendViaSmtp({ to: recipients, subject, html, text });
  console.warn('[email] Skipping — no provider configured:', subject);
  return { skipped: true, reason: 'No email provider configured' };
}

// ── Formatted alert emails ────────────────────────────────────────────────────

async function sendSecurityAlert({ accountId, issues, to }) {
  const critical = issues.filter(i => i.severity === 'critical');
  const high     = issues.filter(i => i.severity === 'high');
  const rows = issues.map(i => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:${i.severity==='critical'?'#ff4747':i.severity==='high'?'#ffb547':'#47c8ff'};font-family:monospace;font-size:12px">${i.severity.toUpperCase()}</td>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:#f0f0eb;font-size:13px">${i.resource}</td>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:#aaa;font-size:12px">${(i.issues||[]).join(', ')}</td>
    </tr>`).join('');
  return send({
    to,
    subject: `🔴 [CloudGuard] Security Alert — ${critical.length} Critical, ${high.length} High · Account ${accountId}`,
    html: `<div style="background:#0d0d0d;color:#f0f0eb;padding:24px;font-family:sans-serif;max-width:600px">
      <div style="color:#c6f135;font-size:20px;font-weight:700;margin-bottom:4px">🛡️ CloudGuard Security Alert</div>
      <div style="color:#555;font-size:12px;font-family:monospace;margin-bottom:20px">Account: ${accountId} · ${new Date().toLocaleString()}</div>
      <div style="display:flex;gap:12px;margin-bottom:20px">
        <div style="background:#1e1e1e;border:1px solid rgba(255,71,71,.3);border-radius:8px;padding:12px 20px;text-align:center">
          <div style="color:#ff4747;font-size:28px;font-weight:700">${critical.length}</div>
          <div style="color:#aaa;font-size:11px">CRITICAL</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid rgba(255,181,71,.3);border-radius:8px;padding:12px 20px;text-align:center">
          <div style="color:#ffb547;font-size:28px;font-weight:700">${high.length}</div>
          <div style="color:#aaa;font-size:11px">HIGH</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid rgba(198,241,53,.2);border-radius:8px;padding:12px 20px;text-align:center">
          <div style="color:#c6f135;font-size:28px;font-weight:700">${issues.length}</div>
          <div style="color:#aaa;font-size:11px">TOTAL</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#141414;border-radius:8px;overflow:hidden">
        <thead><tr>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">SEV</th>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">RESOURCE</th>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">ISSUES</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:20px;padding:12px;background:#141414;border-radius:8px;font-size:12px;color:#555">CloudGuard Pro · Automated AWS Security Monitor</div>
    </div>`,
    text: `CloudGuard Security Alert\nAccount: ${accountId}\nCritical: ${critical.length} | High: ${high.length} | Total: ${issues.length}\n\n${issues.map(i=>`[${i.severity.toUpperCase()}] ${i.resource}: ${(i.issues||[]).join(', ')}`).join('\n')}`,
  });
}

async function sendCostAlert({ accountId, currentCost, forecastedCost, threshold, to }) {
  return send({
    to,
    subject: `💰 [CloudGuard] Cost Alert — $${(currentCost||0).toFixed(2)} spent · Account ${accountId}`,
    html: `<div style="background:#0d0d0d;color:#f0f0eb;padding:24px;font-family:sans-serif;max-width:600px">
      <div style="color:#c6f135;font-size:20px;font-weight:700;margin-bottom:4px">💸 CloudGuard Cost Alert</div>
      <div style="color:#555;font-size:12px;font-family:monospace;margin-bottom:20px">Account: ${accountId} · ${new Date().toLocaleString()}</div>
      <div style="display:flex;gap:12px;margin-bottom:20px">
        <div style="background:#1e1e1e;border:1px solid rgba(255,181,71,.3);border-radius:8px;padding:16px 24px;text-align:center">
          <div style="color:#ffb547;font-size:32px;font-weight:700">$${(currentCost||0).toFixed(2)}</div>
          <div style="color:#aaa;font-size:11px">THIS MONTH</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid rgba(71,200,255,.2);border-radius:8px;padding:16px 24px;text-align:center">
          <div style="color:#47c8ff;font-size:32px;font-weight:700">$${(forecastedCost||0).toFixed(2)}</div>
          <div style="color:#aaa;font-size:11px">FORECASTED</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid rgba(255,71,71,.2);border-radius:8px;padding:16px 24px;text-align:center">
          <div style="color:#ff4747;font-size:32px;font-weight:700">$${(threshold||0).toFixed(0)}</div>
          <div style="color:#aaa;font-size:11px">THRESHOLD</div>
        </div>
      </div>
      <div style="margin-top:20px;padding:12px;background:#141414;border-radius:8px;font-size:12px;color:#555">CloudGuard Pro · Automated AWS Cost Monitor</div>
    </div>`,
    text: `CloudGuard Cost Alert\nAccount: ${accountId}\nThis Month: $${(currentCost||0).toFixed(2)}\nForecasted: $${(forecastedCost||0).toFixed(2)}\nThreshold: $${(threshold||0).toFixed(0)}`,
  });
}

async function sendWeeklySummary({ accountId, summary, to }) {
  const s = summary || {};
  const scoreColor = s.securityScore >= 80 ? '#c6f135' : s.securityScore >= 60 ? '#ffb547' : '#ff4747';
  return send({
    to,
    subject: `📊 [CloudGuard] Weekly Summary — Score ${s.securityScore||'—'}/100 · Account ${accountId}`,
    html: `<div style="background:#0d0d0d;color:#f0f0eb;padding:24px;font-family:sans-serif;max-width:600px">
      <div style="color:#c6f135;font-size:20px;font-weight:700;margin-bottom:4px">📊 CloudGuard Weekly Summary</div>
      <div style="color:#555;font-size:12px;font-family:monospace;margin-bottom:20px">Account: ${accountId} · Week ending ${new Date().toLocaleDateString()}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="background:#1e1e1e;border:1px solid #282828;border-radius:8px;padding:16px">
          <div style="color:#aaa;font-size:11px;font-family:monospace;margin-bottom:4px">SECURITY SCORE</div>
          <div style="color:${scoreColor};font-size:32px;font-weight:700">${s.securityScore||'—'}<span style="font-size:16px;color:#555">/100</span></div>
          <div style="color:${s.scoreChange>=0?'#c6f135':'#ff4747'};font-size:12px">${s.scoreChange>=0?'+':''}${s.scoreChange||0} vs last week</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid #282828;border-radius:8px;padding:16px">
          <div style="color:#aaa;font-size:11px;font-family:monospace;margin-bottom:4px">CRITICAL ISSUES</div>
          <div style="color:#ff4747;font-size:32px;font-weight:700">${s.criticalIssues||0}</div>
          <div style="color:#555;font-size:12px">${s.criticalChange>=0?'+':''}${s.criticalChange||0} vs last week</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid #282828;border-radius:8px;padding:16px">
          <div style="color:#aaa;font-size:11px;font-family:monospace;margin-bottom:4px">MONTHLY COST</div>
          <div style="color:#ffb547;font-size:32px;font-weight:700">$${(s.monthlyCost||0).toFixed(0)}</div>
          <div style="color:${s.costChange<=0?'#c6f135':'#ff4747'};font-size:12px">${s.costChange>=0?'+':''}${s.costChange||0}% vs last month</div>
        </div>
        <div style="background:#1e1e1e;border:1px solid #282828;border-radius:8px;padding:16px">
          <div style="color:#aaa;font-size:11px;font-family:monospace;margin-bottom:4px">AUTO-FIXES APPLIED</div>
          <div style="color:#c6f135;font-size:32px;font-weight:700">${s.autoFixes||0}</div>
          <div style="color:#555;font-size:12px">this week</div>
        </div>
      </div>
      <div style="margin-top:20px;padding:12px;background:#141414;border-radius:8px;font-size:12px;color:#555">CloudGuard Pro · Automated AWS Weekly Digest</div>
    </div>`,
    text: `CloudGuard Weekly Summary\nAccount: ${accountId}\nSecurity Score: ${s.securityScore||'—'}/100\nCritical Issues: ${s.criticalIssues||0}\nMonthly Cost: $${(s.monthlyCost||0).toFixed(2)}\nAuto-Fixes: ${s.autoFixes||0}`,
  });
}

async function sendAbsencePlan({ accountId, userId, absencePlan, to }) {
  const plan = absencePlan || {};
  const dayRows = (plan.days || []).map(d => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:#aaa;font-family:monospace;font-size:12px">Day ${d.day}</td>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:#f0f0eb;font-size:13px">${d.date}</td>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:${d.risk==='critical'?'#ff4747':d.risk==='high'?'#ffb547':'#c6f135'};font-size:12px;font-family:monospace">${d.risk?.toUpperCase()||'LOW'}</td>
      <td style="padding:8px;border-bottom:1px solid #1e1e1e;color:#aaa;font-size:12px">${(d.actions||[]).join(', ')}</td>
    </tr>`).join('');
  return send({
    to,
    subject: `📅 [CloudGuard] Absence Plan — ${userId} · ${plan.totalDays||'?'} days · Account ${accountId}`,
    html: `<div style="background:#0d0d0d;color:#f0f0eb;padding:24px;font-family:sans-serif;max-width:600px">
      <div style="color:#c6f135;font-size:20px;font-weight:700;margin-bottom:4px">📅 Absence Plan Created</div>
      <div style="color:#555;font-size:12px;font-family:monospace;margin-bottom:12px">Account: ${accountId} · User: ${userId}</div>
      <div style="background:#141414;border:1px solid #282828;border-radius:8px;padding:12px;margin-bottom:16px;font-family:monospace;font-size:13px">
        <div>Duration: <span style="color:#c6f135">${plan.totalDays||'?'} days</span></div>
        <div>Start: <span style="color:#f0f0eb">${plan.startDate||'—'}</span></div>
        <div>End: <span style="color:#f0f0eb">${plan.endDate||'—'}</span></div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#141414;border-radius:8px;overflow:hidden">
        <thead><tr>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">DAY</th>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">DATE</th>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">RISK</th>
          <th style="padding:10px 8px;text-align:left;color:#555;font-size:11px;font-family:monospace;border-bottom:1px solid #1e1e1e">ACTIONS</th>
        </tr></thead>
        <tbody>${dayRows}</tbody>
      </table>
      <div style="margin-top:20px;padding:12px;background:#141414;border-radius:8px;font-size:12px;color:#555">CloudGuard Pro · Absence Management System</div>
    </div>`,
    text: `CloudGuard Absence Plan\nUser: ${userId}\nAccount: ${accountId}\nDuration: ${plan.totalDays||'?'} days\nStart: ${plan.startDate||'—'}\n\n${(plan.days||[]).map(d=>`Day ${d.day} (${d.date}): ${(d.actions||[]).join(', ')}`).join('\n')}`,
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  send,
  sendSecurityAlert,
  sendCostAlert,
  sendWeeklySummary,
  sendAbsencePlan,
};