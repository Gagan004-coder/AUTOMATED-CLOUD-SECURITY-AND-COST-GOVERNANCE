// ═══════════════════════════════════════════════════════════════════════════════
// ai-assistant.js — CloudGuard Pro AI Assistant
// Claude (Anthropic API) integration
// Features: context-aware, live AWS data injection, conversation memory,
//           floating chat button, quick prompts, markdown rendering
//
// HOW TO USE:
//   1. Add <script src="ai-assistant.js"></script> before </body> in index.html
//   2. Add the floating panel HTML (see bottom of this file)
//   3. Call initAIAssistant() after login / showApp()
//
// BACKEND PROXY (recommended for production):
//   Add POST /api/ai/chat to your Express server (see aiProxy route below)
//   Set USE_PROXY = true and ensure ANTHROPIC_API_KEY is in your .env
// ═══════════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const AI_CONFIG = {
  // Set to true + add backend proxy route when hosting outside claude.ai
  USE_PROXY:   false,
  PROXY_URL:   '/api/ai/chat',
  DIRECT_URL:  'https://api.anthropic.com/v1/messages',
  MODEL:       'claude-sonnet-4-20250514',
  MAX_TOKENS:  1000,
  MAX_HISTORY: 20,   // keep last N messages in context window
};

// ── State ─────────────────────────────────────────────────────────────────────
const AI_STATE = {
  messages:  [],    // full conversation history
  streaming: false,
  panelOpen: false,
  unread:    false,
  initialized: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — builds a context-rich prompt from live AWS data
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const now  = new Date().toLocaleString();
  // S is the global state object from the main app (S.data, S.accountId, etc.)
  const acct = (typeof S !== 'undefined' && S.accountId) || 'unknown';
  const role = (typeof S !== 'undefined' && S.roleName)  || 'unknown';
  const data = (typeof S !== 'undefined' && S.data)      || {};

  const bil = data.billing?.summary       || {};
  const s3  = data.s3                     || {};
  const ec2 = data.ec2?.summary           || {};
  const iam = data.iam?.summary           || {};
  const svcs = (data.billing?.serviceBreakdown || []).slice(0, 6);

  // ── Cost context ────────────────────────────────────────────────────────────
  const costCtx = bil.currentMonthCost != null
    ? [
        `Current month spend : $${bil.currentMonthCost.toFixed(2)}`,
        `Forecasted EOM      : $${bil.forecastedCost?.toFixed(2) ?? 'N/A'}`,
        `MoM change          : ${bil.percentChange != null ? (bil.percentChange > 0 ? '+' : '') + bil.percentChange + '%' : 'N/A'}`,
        `Previous month      : $${bil.previousMonthCost?.toFixed(2) ?? 'N/A'}`,
      ].join('\n')
    : 'Billing data not yet loaded — user should run a scan.';

  const svcsCtx = svcs.length
    ? 'Top services by cost:\n' + svcs.map(s =>
        `  - ${s.service.replace('Amazon ','').replace('AWS ','')} : $${s.cost.toFixed(2)}`).join('\n')
    : 'Service breakdown not yet loaded.';

  // ── Infrastructure context ───────────────────────────────────────────────────
  const ec2Ctx = ec2.runningInstances != null
    ? [
        `Running instances   : ${ec2.runningInstances}`,
        `Stopped instances   : ${ec2.stoppedInstances ?? 0}`,
        `Idle 7d+            : ${ec2.idleInstances ?? 0}`,
        `Unattached volumes  : ${ec2.unusedVolumes ?? 0}`,
        `Est. monthly cost   : $${ec2.estimatedMonthlyCost ?? '?'}`,
      ].join('\n')
    : 'EC2 data not yet loaded.';

  const s3Ctx = s3.totalBuckets != null
    ? [
        `Total S3 buckets    : ${s3.totalBuckets}`,
        `Vulnerable buckets  : ${s3.vulnerableCount ?? 0}`,
        `Critical severity   : ${s3.criticalCount ?? 0}`,
      ].join('\n')
    : 'S3 data not yet loaded.';

  const iamCtx = iam.totalUsers != null
    ? [
        `Total IAM users     : ${iam.totalUsers}`,
        `Users with issues   : ${iam.usersWithIssues ?? 0}`,
        `Without MFA         : ${iam.usersWithoutMFA ?? 0}`,
        `High severity       : ${iam.highSeverity ?? 0}`,
      ].join('\n')
    : 'IAM data not yet loaded.';

  // ── Top issues ───────────────────────────────────────────────────────────────
  const s3Issues = (data.s3?.vulnerableBuckets || []).slice(0, 4)
    .map(b => `  [${b.severity}] ${b.name}: ${(b.issues || []).join(', ')}`).join('\n');

  const iamIssues = (data.iam?.usersWithIssues || []).slice(0, 4)
    .map(u => `  [${u.severity}] ${u.username}: ${(u.issues || []).join(', ')}`).join('\n');

  // ── Fix history ──────────────────────────────────────────────────────────────
  const fixes = ((typeof S !== 'undefined' && S.fixHistory) || []).slice(0, 6)
    .map(f => `  ${f.status === 'success' ? '✓' : '✗'} ${f.resource} — ${f.action || f.fixId}`).join('\n');

  return `You are CloudGuard AI, an expert AWS cloud security and cost assistant embedded in the CloudGuard Pro dashboard. You have direct access to live AWS account data shown below.

━━━ ACCOUNT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AWS Account : ${acct}
Role        : ${role}
Timestamp   : ${now}

━━━ BILLING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${costCtx}

${svcsCtx}

━━━ EC2 COMPUTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ec2Ctx}

━━━ S3 SECURITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${s3Ctx}
${s3Issues ? 'Vulnerable buckets:\n' + s3Issues : ''}

━━━ IAM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${iamCtx}
${iamIssues ? 'Users with issues:\n' + iamIssues : ''}

━━━ RECENT AUTO-FIXES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${fixes || '  No fixes applied this session.'}

━━━ YOUR INSTRUCTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Answer questions about THIS specific AWS account using the data above
- Give concrete, actionable advice referencing actual numbers from the data
- Format CLI commands and code in markdown triple-backtick blocks
- Use bullet points for lists, short paragraphs for explanations
- If data shows "not yet loaded", tell the user to run a Full Scan first
- Be direct and concise — no filler phrases
- You are an expert in AWS security, cost optimization, IAM, S3, EC2, and FinOps`;
}

// ─────────────────────────────────────────────────────────────────────────────
// API CALL — direct to Anthropic or via backend proxy
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(userMsg) {
  // Trim history to max window to avoid token bloat
  const history = AI_STATE.messages.slice(-AI_CONFIG.MAX_HISTORY);

  const body = {
    model:      AI_CONFIG.MODEL,
    max_tokens: AI_CONFIG.MAX_TOKENS,
    system:     buildSystemPrompt(),
    messages: [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMsg },
    ],
  };

  const url = AI_CONFIG.USE_PROXY ? AI_CONFIG.PROXY_URL : AI_CONFIG.DIRECT_URL;

  const headers = { 'Content-Type': 'application/json' };
  // When using proxy, send session id so backend can auth if needed
  if (AI_CONFIG.USE_PROXY && typeof S !== 'undefined' && S.sessionId) {
    headers['x-session-id'] = S.sessionId;
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || err.error || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('AUTH_ERROR');
    if (res.status === 429) throw new Error('RATE_LIMIT');
    throw new Error(msg);
  }

  const data = await res.json();
  return data.content?.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('') || '(empty response)';
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND MESSAGE — main entry point
// ─────────────────────────────────────────────────────────────────────────────
async function sendAIMessage(text) {
  if (!text?.trim() || AI_STATE.streaming) return;
  text = text.trim();

  // Render user bubble
  appendBubble('user', text);
  AI_STATE.messages.push({ role: 'user', content: text });

  // Lock UI
  AI_STATE.streaming = true;
  setAISendDisabled(true);
  clearAIInput();

  // Hide quick prompts after first message
  const qp = document.getElementById('ai-quick-prompts');
  if (qp) qp.style.display = 'none';

  // Show typing indicator
  const typingEl = showTypingIndicator();

  try {
    const reply = await callClaude(text);
    typingEl?.remove();
    appendBubble('assistant', reply);
    AI_STATE.messages.push({ role: 'assistant', content: reply });

    // Unread badge if panel closed
    if (!AI_STATE.panelOpen) {
      AI_STATE.unread = true;
      document.getElementById('ai-fab-btn')?.classList.add('has-unread');
    }

  } catch (err) {
    typingEl?.remove();
    const friendly =
      err.message === 'AUTH_ERROR'  ? '⚠️ Authentication error. This app needs to be opened via **claude.ai** for the API key to work automatically.' :
      err.message === 'RATE_LIMIT'  ? '⏳ Rate limited — please wait a moment and try again.' :
      `❌ Error: ${err.message}`;
    appendBubble('assistant', friendly);
  }

  AI_STATE.streaming = false;
  setAISendDisabled(false);
  document.getElementById('ai-input')?.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Minimal markdown → HTML (bold, code blocks, inline code, line breaks)
function mdToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')   // escape first
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
      `<pre>${code.trim()}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,    '<em>$1</em>')
    .replace(/^### (.+)$/gm,  '<strong>$1</strong>')
    .replace(/^## (.+)$/gm,   '<strong>$1</strong>')
    .replace(/^- (.+)$/gm,    '• $1')
    .replace(/\n/g, '<br>');
}

function appendBubble(role, text) {
  const list = document.getElementById('ai-message-list');
  if (!list) return;

  const wrapper = document.createElement('div');
  wrapper.className = `ai-msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';
  bubble.innerHTML = mdToHtml(text);

  const time = document.createElement('div');
  time.className = 'ai-msg-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  list.appendChild(wrapper);
  list.scrollTop = list.scrollHeight;
}

function showTypingIndicator() {
  const list = document.getElementById('ai-message-list');
  if (!list) return null;
  const el = document.createElement('div');
  el.className = 'ai-msg assistant';
  el.id = 'ai-typing-indicator';
  el.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

function setAISendDisabled(disabled) {
  const btn = document.getElementById('ai-send-btn');
  if (btn) btn.disabled = disabled;
}

function clearAIInput() {
  const inp = document.getElementById('ai-input');
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
}

function clearAIChat() {
  AI_STATE.messages = [];
  const list = document.getElementById('ai-message-list');
  if (list) list.innerHTML = '';
  // Re-show quick prompts
  const qp = document.getElementById('ai-quick-prompts');
  if (qp) qp.style.display = 'flex';
  showWelcomeMessage();
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL OPEN / CLOSE
// ─────────────────────────────────────────────────────────────────────────────
function toggleAIPanel() {
  const panel = document.getElementById('ai-chat-panel');
  if (!panel) return;

  AI_STATE.panelOpen = !AI_STATE.panelOpen;
  panel.classList.toggle('hidden',  !AI_STATE.panelOpen);
  panel.classList.toggle('visible',  AI_STATE.panelOpen);

  if (AI_STATE.panelOpen) {
    // Clear unread dot
    AI_STATE.unread = false;
    document.getElementById('ai-fab-btn')?.classList.remove('has-unread');
    // Focus input
    setTimeout(() => document.getElementById('ai-input')?.focus(), 150);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WELCOME MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
function showWelcomeMessage() {
  const bil = (typeof S !== 'undefined' && S.data?.billing?.summary) || {};
  const hasData = bil.currentMonthCost != null;

  const costLine = hasData
    ? `Your account is spending **$${bil.currentMonthCost.toFixed(2)}** this month${bil.percentChange != null ? ` (${bil.percentChange > 0 ? '+' : ''}${bil.percentChange}% vs last month)` : ''}.`
    : `Run a **Full Scan** first to give me context about your account.`;

  appendBubble('assistant',
    `Hi! I'm CloudGuard AI, powered by Claude.\n\n${costLine}\n\nAsk me anything — costs, security, EC2, IAM, or AWS best practices.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK PROMPTS — dynamically built from live data
// ─────────────────────────────────────────────────────────────────────────────
function buildQuickPrompts() {
  const ec2  = (typeof S !== 'undefined' && S.data?.ec2?.summary)          || {};
  const s3   = (typeof S !== 'undefined' && S.data?.s3)                    || {};
  const bil  = (typeof S !== 'undefined' && S.data?.billing?.summary)      || {};
  const iam  = (typeof S !== 'undefined' && S.data?.iam?.summary)          || {};

  const prompts = [
    { icon: '💸', label: 'Why are costs high?',  q: 'Why are my AWS costs high this month? Give me a breakdown.' },
    { icon: '🔒', label: 'Security summary',      q: 'Summarise my top security issues and how to fix them.' },
  ];

  if (ec2.idleInstances > 0)
    prompts.push({ icon: '🖥️', label: `${ec2.idleInstances} idle EC2`, q: `I have ${ec2.idleInstances} idle EC2 instances. What should I do with them?` });

  if (s3.criticalCount > 0)
    prompts.push({ icon: '🪣', label: `${s3.criticalCount} S3 critical`, q: `Explain my ${s3.criticalCount} critical S3 issues and give remediation steps.` });

  if (bil.percentChange > 10)
    prompts.push({ icon: '📈', label: `+${bil.percentChange}% MoM`, q: `My costs jumped ${bil.percentChange}% month-over-month. What's likely causing this?` });

  if (iam.usersWithoutMFA > 0)
    prompts.push({ icon: '👤', label: `${iam.usersWithoutMFA} no MFA`, q: `${iam.usersWithoutMFA} IAM users have no MFA. What's the risk and how do I fix it?` });

  prompts.push({ icon: '💡', label: 'Save money',  q: 'What are the top 3 actions I can take right now to reduce my AWS costs?' });

  const container = document.getElementById('ai-quick-prompts');
  if (!container) return;
  container.innerHTML = prompts.slice(0, 5).map(p =>
    `<span class="ai-qp" onclick="sendAIMessage('${p.q.replace(/'/g, "\\'")}')">${p.icon} ${p.label}</span>`
  ).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT — call this after login / showApp()
// ─────────────────────────────────────────────────────────────────────────────
function initAIAssistant() {
  if (AI_STATE.initialized) return;
  AI_STATE.initialized = true;

  // Show FAB
  const fab = document.getElementById('ai-fab');
  if (fab) fab.style.display = 'flex';

  // Show welcome message
  showWelcomeMessage();

  // Build quick prompts
  buildQuickPrompts();

  // Auto-resize textarea on input
  const input = document.getElementById('ai-input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAIMessage(input.value);
      }
    });
  }

  // Send button
  document.getElementById('ai-send-btn')
    ?.addEventListener('click', () => sendAIMessage(document.getElementById('ai-input')?.value));
}

// Refresh prompts + welcome when new AWS data loads
function onAWSDataLoaded() {
  buildQuickPrompts();
}
