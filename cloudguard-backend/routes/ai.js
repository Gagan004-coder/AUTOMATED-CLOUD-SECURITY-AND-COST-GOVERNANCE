// routes/ai.js — CloudGuard Pro AI Proxy
// Primary:  Google Gemini 2.0 Flash  (FREE — 15 req/min, 1500/day, no credit card)
// Fallback: Anthropic Claude          (paid, if ANTHROPIC_API_KEY is set)
// Get free Gemini key: https://aistudio.google.com/app/apikey
'use strict';

const express = require('express');
const router  = express.Router();

function getProvider() {
  if (process.env.GEMINI_API_KEY)    return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function buildSystemPrompt(awsContext = {}) {
  const bil = awsContext.billing || {};
  const s3  = awsContext.s3  || {};
  const ec2 = awsContext.ec2 || {};
  const iam = awsContext.iam || {};

  return `You are CloudGuard AI, an expert AWS cloud security and cost optimization assistant embedded in the CloudGuard Pro dashboard.

LIVE AWS ACCOUNT DATA (as of ${new Date().toLocaleString()}):
- Account: ${awsContext.accountId || 'unknown'} | Role: ${awsContext.roleName || 'unknown'}
- Billing: Current month $${bil.currentMonthCost ?? 'N/A'}, Forecasted $${bil.forecastedCost ?? 'N/A'}, MoM change: ${bil.percentChange ?? 'N/A'}%
- S3: ${s3.totalBuckets ?? 'N/A'} buckets total, ${s3.vulnerableCount ?? 0} with security issues, ${s3.criticalCount ?? 0} critical
- EC2: ${ec2.runningInstances ?? 'N/A'} running instances, ${ec2.idleInstances ?? 0} idle (7d+), ~$${ec2.estimatedMonthlyCost ?? '?'}/mo
- IAM: ${iam.totalUsers ?? 'N/A'} users, ${iam.usersWithIssues ?? 0} with issues, ${iam.usersWithoutMFA ?? 0} without MFA
${awsContext.topServices    ? '- Top services by cost: ' + awsContext.topServices    : ''}
${awsContext.securityIssues ? '- Active security issues: ' + awsContext.securityIssues : ''}

YOUR ROLE:
- Answer questions about THIS specific AWS account using the live data above
- Give concrete, actionable recommendations with actual numbers from the account
- Format CLI commands and code in markdown code blocks
- Be direct, professional, and thorough — no generic filler advice
- If data is not yet loaded, recommend running a Full Scan first
- You are an expert in AWS security, cost optimization, and best practices`;
}

async function callGemini(messages, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model  = 'gemini-2.0-flash';
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 1500, temperature: 0.7 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Gemini error ${resp.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

async function callAnthropic(messages, systemPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system:     systemPrompt,
      messages:   messages.slice(-20),
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Anthropic error ${resp.status}`);
  return data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

router.post('/chat', async (req, res) => {
  const provider = getProvider();
  if (!provider) {
    return res.status(503).json({
      error: 'AI not configured. Add GEMINI_API_KEY (free) to your Render environment variables. Get one free at https://aistudio.google.com/app/apikey',
    });
  }

  const { messages = [], awsContext = {} } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'messages array is required' });

  const systemPrompt = buildSystemPrompt(awsContext);

  try {
    const reply = provider === 'gemini'
      ? await callGemini(messages.slice(-20), systemPrompt)
      : await callAnthropic(messages.slice(-20), systemPrompt);

    res.json({ reply, provider });
  } catch (err) {
    console.error(`[ai/chat][${provider}]`, err.message);
    res.status(500).json({ error: err.message, provider });
  }
});

router.get('/status', (req, res) => {
  const provider = getProvider();
  res.json({
    configured: !!provider,
    provider:   provider || 'none',
    model:      provider === 'gemini' ? 'gemini-2.0-flash (FREE)' : provider === 'anthropic' ? 'claude-haiku (paid)' : 'none',
    freeKeyUrl: 'https://aistudio.google.com/app/apikey',
  });
});

module.exports = router;