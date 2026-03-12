// routes/ai.js — CloudGuard Pro AI Proxy (server-side Anthropic calls)
const express = require('express');
const router  = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  if (!client) {
    return res.status(503).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY in your .env file.' });
  }

  const { messages = [], systemPrompt = '', awsContext = {} } = req.body;

  if (!messages.length) return res.status(400).json({ error: 'messages array is required' });

  // Build rich system prompt with live AWS data passed from frontend
  const bil = awsContext.billing || {};
  const s3  = awsContext.s3  || {};
  const ec2 = awsContext.ec2 || {};
  const iam = awsContext.iam || {};

  const system = systemPrompt || `You are CloudGuard AI, an expert AWS cloud security and cost optimization assistant embedded in the CloudGuard Pro dashboard.

LIVE AWS ACCOUNT DATA:
- Account: ${awsContext.accountId || 'unknown'} | Role: ${awsContext.roleName || 'unknown'}
- Billing: Current month $${bil.currentMonthCost ?? 'N/A'}, Forecasted $${bil.forecastedCost ?? 'N/A'}, MoM change: ${bil.percentChange ?? 'N/A'}%
- S3: ${s3.totalBuckets ?? 'N/A'} buckets, ${s3.vulnerableCount ?? 0} with issues, ${s3.criticalCount ?? 0} critical
- EC2: ${ec2.runningInstances ?? 'N/A'} running, ${ec2.idleInstances ?? 0} idle, ~$${ec2.estimatedMonthlyCost ?? '?'}/mo
- IAM: ${iam.totalUsers ?? 'N/A'} users, ${iam.usersWithIssues ?? 0} with issues, ${iam.usersWithoutMFA ?? 0} without MFA
${awsContext.topServices ? '- Top services: ' + awsContext.topServices : ''}
${awsContext.securityIssues ? '- Security issues: ' + awsContext.securityIssues : ''}

YOUR ROLE:
- Answer questions about THIS specific AWS account using the live data above
- Give concrete, actionable recommendations with actual numbers from the account
- Format code/CLI commands in markdown code blocks
- Be direct, professional, and thorough. No generic filler advice.
- If data is not loaded, recommend running a Full Scan
- Current time: ${new Date().toLocaleString()}`;

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system,
      messages:   messages.slice(-20), // keep last 20 messages for context
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    res.json({ reply, usage: response.usage });
  } catch (err) {
    console.error('[ai/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/status ────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    configured: !!client,
    model:      'claude-sonnet-4-20250514',
    provider:   'Anthropic',
  });
});

module.exports = router;
