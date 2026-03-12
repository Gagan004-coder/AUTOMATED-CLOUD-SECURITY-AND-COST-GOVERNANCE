// routes/ai.js — CloudGuard Pro AI with full tool calling
// AI can: answer questions AND take actions — send emails, apply fixes,
//         create absence plans, query live AWS data
// Uses Groq (free) — get key at https://console.groq.com
'use strict';

const express    = require('express');
const router     = express.Router();
const emailSvc   = require('../services/email');
const absenceSvc = require('../services/absence');

// ── Tool definitions (OpenAI-compatible format for Groq) ─────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email notification. Use this whenever the user asks to send an email, alert, notification, security report, cost alert, weekly summary, or test email.',
      parameters: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: ['test', 'security', 'cost', 'weekly', 'autofix'],
            description: 'test=test email | security=security alert | cost=cost alert | weekly=weekly summary | autofix=fix report'
          },
          to: { type: 'string', description: 'Recipient email. Leave empty to use configured ALERT_EMAIL.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_aws_fix',
      description: 'Apply a security or cost fix directly to the AWS account. Use when user asks to fix, remediate, block, stop, enable, or apply a change.',
      parameters: {
        type: 'object',
        required: ['fixId', 'resource', 'params'],
        properties: {
          fixId: {
            type: 'string',
            enum: ['s3-block-public-access', 's3-enable-encryption', 's3-enable-versioning', 'ec2-stop-idle', 'ec2-delete-unattached-volume', 'iam-disable-old-key'],
          },
          resource: { type: 'string', description: 'Human-readable resource name e.g. "s3://my-bucket" or "i-0abc123"' },
          params:   { type: 'object', description: 'Fix params. For S3: {bucket}. For EC2: {instanceId} or {volumeId}. For IAM: {username, accessKeyId}' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_absence_plan',
      description: 'Create an absence or vacation plan. Schedules automatic AWS service management and sends a notification email.',
      parameters: {
        type: 'object',
        required: ['userId', 'totalDays'],
        properties: {
          userId:      { type: 'string', description: 'User identifier (email or name)' },
          totalDays:   { type: 'number', description: 'Number of days absent' },
          startDate:   { type: 'string', description: 'Start date in YYYY-MM-DD format. Default: today.' },
          notifyEmail: { type: 'string', description: 'Email address to send the plan to.' },
          keepRunning: { type: 'array', items: { type: 'string' }, description: 'EC2 instance IDs to keep running during absence' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_security_issues',
      description: 'Get the full list of current security issues in the AWS account. Use when user asks about security, vulnerabilities, or issues.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cost_breakdown',
      description: 'Get detailed AWS cost breakdown by service. Use when user asks about costs, billing, or specific service spending.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Execute a tool and return a string result ─────────────────────────────────
async function executeTool(name, args, ctx) {
  const { awsContext, sessionId } = ctx;

  // Lazy-load sessions and notifications to avoid circular deps
  const { sessions }  = require('./auth');
  const sess          = sessions.get(sessionId);
  const creds         = sess?.credentials;
  const region        = sess?.region || 'us-east-1';

  switch (name) {

    // ── SEND EMAIL ────────────────────────────────────────────────────────────
    case 'send_email': {
      const { type, to } = args;
      const provider = emailSvc.detectProvider();
      if (!provider) return '❌ Email not configured. Set RESEND_API_KEY or SMTP_USER+SMTP_PASS in environment variables.';

      try {
        const bil  = awsContext.billing  || {};
        const s3   = awsContext.s3       || {};
        const iam  = awsContext.iam      || {};
        const ec2  = awsContext.ec2      || {};

        if (type === 'test') {
          await emailSvc.sendTest(to || null);
          return `✅ Test email sent to ${to || process.env.ALERT_EMAIL || 'configured recipients'}.`;
        }

        if (type === 'security') {
          const issues = (awsContext.rawIssues || []);
          if (!issues.length) return '⚠️ No security issues found in current scan data. Run a Full Scan first, then try again.';
          await emailSvc.sendSecurityAlert(issues, to || null);
          return `✅ Security alert email sent — ${issues.length} issue(s) listed.`;
        }

        if (type === 'cost') {
          await emailSvc.sendCostAlert({
            currentCost:   bil.currentMonthCost  ?? 0,
            forecastedCost: bil.forecastedCost   ?? 0,
            threshold:     parseInt(process.env.COST_ALERT_THRESHOLD || '500'),
          }, to || null);
          return `✅ Cost alert email sent. Current spend: $${bil.currentMonthCost ?? '?'}, forecast: $${bil.forecastedCost ?? '?'}.`;
        }

        if (type === 'weekly') {
          const vulnPct = ((s3.vulnerableCount || 0) / Math.max(1, s3.totalBuckets || 1)) * 100;
          const iamPct  = ((iam.usersWithIssues || 0) / Math.max(1, iam.totalUsers || 1)) * 100;
          const score   = Math.max(0, Math.round(100 - (vulnPct * 0.6) - (iamPct * 0.4)));
          await emailSvc.sendWeeklySummary({
            securityScore:  score,
            criticalIssues: s3.criticalCount || 0,
            monthlyCost:    bil.currentMonthCost ?? 0,
            costChange:     bil.percentChange    ?? 0,
            autoFixes:      0,
          }, to || null);
          return `✅ Weekly summary email sent. Score: ${score}/100, Cost: $${bil.currentMonthCost ?? '?'}.`;
        }

        if (type === 'autofix') {
          const history = awsContext.fixHistory || [];
          if (!history.length) return '⚠️ No auto-fix history to report.';
          await emailSvc.sendAutoFixReport(history, to || null);
          return `✅ Auto-fix report email sent — ${history.length} fix(es) included.`;
        }

        return `❌ Unknown email type: ${type}`;
      } catch (e) {
        return `❌ Email failed: ${e.message}`;
      }
    }

    // ── APPLY AWS FIX ─────────────────────────────────────────────────────────
    case 'apply_aws_fix': {
      const { fixId, resource, params } = args;
      if (!creds) return '❌ Not authenticated to AWS. Please reconnect via SSO first.';

      try {
        // Reuse the applyFix function from notifications route
        const { applyFixFn } = require('./notifications');
        if (applyFixFn) {
          const result = await applyFixFn({ fixId, params }, creds, region);
          return `✅ Fix applied: ${result}`;
        }

        // Inline fallback if applyFixFn not exported
        if (fixId === 's3-block-public-access') {
          const { S3Client, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
          const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
          await s3.send(new PutPublicAccessBlockCommand({
            Bucket: params.bucket,
            PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
          }));
          return `✅ Public access blocked on s3://${params.bucket}`;
        }
        if (fixId === 's3-enable-encryption') {
          const { S3Client, PutBucketEncryptionCommand } = require('@aws-sdk/client-s3');
          const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
          await s3.send(new PutBucketEncryptionCommand({
            Bucket: params.bucket,
            ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
          }));
          return `✅ Encryption (AES256) enabled on s3://${params.bucket}`;
        }
        if (fixId === 's3-enable-versioning') {
          const { S3Client, PutBucketVersioningCommand } = require('@aws-sdk/client-s3');
          const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
          await s3.send(new PutBucketVersioningCommand({ Bucket: params.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
          return `✅ Versioning enabled on s3://${params.bucket}`;
        }
        if (fixId === 'ec2-stop-idle') {
          const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');
          const ec2 = new EC2Client({ region, credentials: creds });
          await ec2.send(new StopInstancesCommand({ InstanceIds: [params.instanceId] }));
          return `✅ EC2 instance ${params.instanceId} stopped`;
        }
        if (fixId === 'ec2-delete-unattached-volume') {
          const { EC2Client, DeleteVolumeCommand } = require('@aws-sdk/client-ec2');
          const ec2 = new EC2Client({ region, credentials: creds });
          await ec2.send(new DeleteVolumeCommand({ VolumeId: params.volumeId }));
          return `✅ EBS volume ${params.volumeId} deleted`;
        }
        if (fixId === 'iam-disable-old-key') {
          const { IAMClient, UpdateAccessKeyCommand, ListAccessKeysCommand } = require('@aws-sdk/client-iam');
          const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
          let keyId = params.accessKeyId;
          if (!keyId) {
            const keys = await iam.send(new ListAccessKeysCommand({ UserName: params.username }));
            const old  = (keys.AccessKeyMetadata || []).find(k => k.Status === 'Active' && (Date.now() - new Date(k.CreateDate).getTime()) > 90 * 86400000);
            keyId = old?.AccessKeyId;
          }
          if (keyId) {
            await iam.send(new UpdateAccessKeyCommand({ UserName: params.username, AccessKeyId: keyId, Status: 'Inactive' }));
            return `✅ Access key ${keyId} disabled for IAM user ${params.username}`;
          }
          return `ℹ️ No old active key found for ${params.username}`;
        }
        return `❌ Unknown fixId: ${fixId}`;
      } catch (e) {
        return `❌ Fix failed: ${e.message}`;
      }
    }

    // ── CREATE ABSENCE PLAN ───────────────────────────────────────────────────
    case 'create_absence_plan': {
      const { userId, totalDays, startDate, notifyEmail, keepRunning } = args;
      try {
        const plan = absenceSvc.createPlan({
          userId,
          totalDays,
          startDate:   startDate || new Date().toISOString().split('T')[0],
          keepRunning: keepRunning || [],
        });
        if (notifyEmail) {
          emailSvc.sendAbsencePlanEmail(plan, notifyEmail).catch(() => {});
        }
        const lines = [
          `✅ Absence plan created for **${userId}**`,
          `- Duration: ${totalDays} days from ${plan.startDate}`,
          `- Auto-stop triggers: Day ${plan.autoStopDay || 5}`,
          notifyEmail ? `- Notification email sent to ${notifyEmail}` : '',
          plan.days?.length ? `\n**Schedule preview:**\n${plan.days.slice(0,3).map(d => `Day ${d.day} (${d.date}): ${(d.actions||[]).join(', ')}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        return lines;
      } catch (e) {
        return `❌ Failed to create absence plan: ${e.message}`;
      }
    }

    // ── GET SECURITY ISSUES ───────────────────────────────────────────────────
    case 'get_security_issues': {
      const issues = awsContext.rawIssues || [];
      if (!issues.length) return 'No security issues in current data. Run a Full Scan first to load live data.';
      const grouped = { critical: [], high: [], medium: [], low: [] };
      for (const i of issues) grouped[i.severity || 'medium']?.push(i);
      return [
        `**Security Issues (${issues.length} total):**`,
        ...Object.entries(grouped).filter(([,v]) => v.length).map(([sev, list]) =>
          `\n**${sev.toUpperCase()} (${list.length}):**\n` + list.slice(0,5).map(i => `- ${i.resource}: ${(i.issues||[]).join(', ')}`).join('\n')
        ),
      ].join('\n');
    }

    // ── GET COST BREAKDOWN ────────────────────────────────────────────────────
    case 'get_cost_breakdown': {
      const svcs = awsContext.serviceBreakdown || [];
      if (!svcs.length) return 'No cost data available. Run a Full Scan to load billing data.';
      return [
        `**Cost Breakdown (this month):**`,
        ...svcs.map((s, i) => `${i+1}. ${s.service.replace('Amazon ','').replace('AWS ','')}: **$${s.cost.toFixed(2)}**`),
        `\nTotal: **$${svcs.reduce((s,x) => s + x.cost, 0).toFixed(2)}**`,
      ].join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── System prompt with live data ──────────────────────────────────────────────
function buildSystemPrompt(awsContext) {
  const bil = awsContext.billing || {};
  const s3  = awsContext.s3  || {};
  const ec2 = awsContext.ec2 || {};
  const iam = awsContext.iam || {};
  const vulnPct = ((s3.vulnerableCount || 0) / Math.max(1, s3.totalBuckets || 1)) * 100;
  const iamPct  = ((iam.usersWithIssues || 0) / Math.max(1, iam.totalUsers || 1)) * 100;
  const score   = Math.max(0, Math.round(100 - (vulnPct * 0.6) - (iamPct * 0.4)));

  return `You are CloudGuard AI, an AWS security and cost expert assistant embedded in CloudGuard Pro.

You can both ANSWER questions and TAKE REAL ACTIONS using your tools:
- send_email → send test, security alert, cost alert, weekly summary, or autofix report emails
- apply_aws_fix → directly fix S3 security, stop idle EC2, disable old IAM keys
- create_absence_plan → schedule automatic AWS management for user vacations
- get_security_issues → fetch the full security issue list
- get_cost_breakdown → fetch detailed cost by service

LIVE AWS ACCOUNT DATA (${new Date().toLocaleString()}):
Account: ${awsContext.accountId || 'unknown'} | Role: ${awsContext.roleName || 'unknown'}
Security Score: ${score}/100
Billing: This month $${bil.currentMonthCost ?? 'N/A'} | Forecast $${bil.forecastedCost ?? 'N/A'} | MoM ${bil.percentChange != null ? (bil.percentChange > 0 ? '+' : '') + bil.percentChange + '%' : 'N/A'}
S3: ${s3.totalBuckets ?? '?'} buckets | ${s3.vulnerableCount ?? 0} vulnerable | ${s3.criticalCount ?? 0} critical
EC2: ${ec2.runningInstances ?? '?'} running | ${ec2.idleInstances ?? 0} idle | ~$${ec2.estimatedMonthlyCost ?? '?'}/mo
IAM: ${iam.totalUsers ?? '?'} users | ${iam.usersWithIssues ?? 0} with issues | ${iam.usersWithoutMFA ?? 0} without MFA${awsContext.topServices ? '\nTop services: ' + awsContext.topServices : ''}

RULES:
- When user asks to DO something → call the tool, don't just explain
- After tool execution, summarise what was done in plain language
- If AWS data is missing, suggest running Full Scan
- Format responses in markdown, use bullet points for lists
- Be direct, concise, and professional`;
}

// ── Main tool-calling loop with Groq ─────────────────────────────────────────
async function runWithTools(messages, awsContext, sessionId) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const systemPrompt = buildSystemPrompt(awsContext);
  const ctx = { awsContext, sessionId };

  let msgHistory = [
    { role: 'system', content: systemPrompt },
    ...messages.slice(-16),
  ];

  // Up to 5 tool-calling rounds
  for (let round = 0; round < 5; round++) {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1500,
        temperature: 0.3,
        messages:    msgHistory,
        tools:       TOOLS,
        tool_choice: 'auto',
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || `Groq error ${resp.status}`);

    const choice  = data.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error('Empty response from Groq');

    // No tool calls → return the text
    if (!message.tool_calls?.length) {
      return message.content || '(no response)';
    }

    // Add assistant message with tool calls
    msgHistory.push({
      role:       'assistant',
      content:    message.content || '',
      tool_calls: message.tool_calls,
    });

    // Execute each tool call
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}

      console.log(`[AI tool] ${call.function.name}`, JSON.stringify(args));
      const result = await executeTool(call.function.name, args, ctx);
      console.log(`[AI tool result] ${result.slice(0, 120)}`);

      msgHistory.push({
        role:         'tool',
        tool_call_id: call.id,
        content:      result,
      });
    }
    // Loop: Groq now sees tool results and generates next response
  }

  return 'Done — all actions completed.';
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({
      error: 'AI not configured. Add GROQ_API_KEY to your Render environment variables. Free key at https://console.groq.com',
    });
  }

  const { messages = [], awsContext = {} } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'messages array is required' });

  const sessionId = req.headers['x-session-id'] || '';

  try {
    const reply = await runWithTools(messages, awsContext, sessionId);
    res.json({ reply, provider: 'groq' });
  } catch (err) {
    console.error('[ai/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/status ────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const ok = !!process.env.GROQ_API_KEY;
  res.json({
    configured: ok,
    provider:   ok ? 'groq' : 'none',
    model:      'llama-3.3-70b-versatile (free)',
    tools:      TOOLS.map(t => t.function.name),
    email:      emailSvc.detectProvider() || 'none',
  });
});

module.exports = router;