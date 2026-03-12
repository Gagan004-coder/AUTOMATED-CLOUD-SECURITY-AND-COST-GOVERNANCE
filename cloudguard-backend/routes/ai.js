// routes/ai.js — CloudGuard Pro AI Proxy
// Uses Groq API — FREE, no credit card, works in India & globally
// Get free key: https://console.groq.com → API Keys → Create
'use strict';

const express = require('express');
const router  = express.Router();

function buildSystemPrompt(awsContext = {}) {
  const bil = awsContext.billing || {};
  const s3  = awsContext.s3  || {};
  const ec2 = awsContext.ec2 || {};
  const iam = awsContext.iam || {};
  return `You are CloudGuard AI, an expert AWS cloud security and cost optimization assistant embedded in the CloudGuard Pro dashboard.

LIVE AWS ACCOUNT DATA (as of ${new Date().toLocaleString()}):
- Account: ${awsContext.accountId || 'unknown'} | Role: ${awsContext.roleName || 'unknown'}
- Billing: Current month $${bil.currentMonthCost ?? 'N/A'}, Forecasted $${bil.forecastedCost ?? 'N/A'}, MoM change: ${bil.percentChange ?? 'N/A'}%
- S3: ${s3.totalBuckets ?? 'N/A'} buckets, ${s3.vulnerableCount ?? 0} with issues, ${s3.criticalCount ?? 0} critical
- EC2: ${ec2.runningInstances ?? 'N/A'} running, ${ec2.idleInstances ?? 0} idle, ~$${ec2.estimatedMonthlyCost ?? '?'}/mo
- IAM: ${iam.totalUsers ?? 'N/A'} users, ${iam.usersWithIssues ?? 0} with issues, ${iam.usersWithoutMFA ?? 0} without MFA
${awsContext.topServices    ? '- Top services: ' + awsContext.topServices    : ''}
${awsContext.securityIssues ? '- Security issues: ' + awsContext.securityIssues : ''}

YOUR ROLE:
- Answer questions about THIS specific AWS account using the live data above
- Give concrete, actionable recommendations with actual numbers
- Format CLI commands in markdown code blocks
- Be direct, professional, thorough — no generic filler
- If data not loaded, suggest running a Full Scan`;
}

async function callGroq(messages, systemPrompt) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  1500,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-20),
      ],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Groq error ${resp.status}`);
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty response from Groq');
  return reply;
}

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({
      error: 'AI not configured. Add GROQ_API_KEY to your Render environment variables. Get a free key at https://console.groq.com',
    });
  }

  const { messages = [], awsContext = {} } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'messages array is required' });

  try {
    const reply = await callGroq(messages, buildSystemPrompt(awsContext));
    res.json({ reply, provider: 'groq' });
  } catch (err) {
    console.error('[ai/chat][groq]', err.message);
    res.status(500).json({ error: err.message, provider: 'groq' });
  }
});

// GET /api/ai/status
router.get('/status', (req, res) => {
  res.json({
    configured: !!process.env.GROQ_API_KEY,
    provider:   process.env.GROQ_API_KEY ? 'groq' : 'none',
    model:      'llama-3.3-70b-versatile (FREE)',
    freeKeyUrl: 'https://console.groq.com',
  });
});

module.exports = router;