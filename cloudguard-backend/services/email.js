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