// routes/auth.js — CloudGuard Pro AWS SSO Authentication
const express = require('express');
const router  = express.Router();
const {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} = require('@aws-sdk/client-sso-oidc');
const {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  GetRoleCredentialsCommand,
} = require('@aws-sdk/client-sso');

// In-memory session store (replace with Redis for production)
const sessions = new Map();

// ── Register SSO client & start device flow ───────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const { startUrl, region = 'us-east-1' } = req.body;
    if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

    const oidc = new SSOOIDCClient({ region });

    // Register a public client
    const client = await oidc.send(new RegisterClientCommand({
      clientName: 'cloudguard-pro',
      clientType: 'public',
    }));

    // Start device authorization
    const auth = await oidc.send(new StartDeviceAuthorizationCommand({
      clientId:     client.clientId,
      clientSecret: client.clientSecret,
      startUrl,
    }));

    // Store session
    const sessionId = require('crypto').randomUUID();
    sessions.set(sessionId, {
      region,
      startUrl,
      clientId:     client.clientId,
      clientSecret: client.clientSecret,
      deviceCode:   auth.deviceCode,
      expiresAt:    Date.now() + (auth.expiresIn || 600) * 1000,
      credentials:  null,
      accountId:    null,
      roleName:     null,
    });

    res.json({
      sessionId,
      verificationUri:         auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      userCode:                auth.userCode,
      interval:                auth.interval || 5,
    });
  } catch (err) {
    console.error('[auth/start]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Poll for token after user approves ───────────────────────────────────────
router.post('/poll', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sess = sessions.get(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (Date.now() > sess.expiresAt) return res.status(410).json({ error: 'Session expired' });

    const oidc = new SSOOIDCClient({ region: sess.region });

    let token;
    try {
      token = await oidc.send(new CreateTokenCommand({
        clientId:     sess.clientId,
        clientSecret: sess.clientSecret,
        grantType:    'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode:   sess.deviceCode,
      }));
    } catch (e) {
      if (e.name === 'AuthorizationPendingException') return res.json({ status: 'pending' });
      if (e.name === 'SlowDownException')             return res.json({ status: 'slow_down' });
      throw e;
    }

    sess.accessToken = token.accessToken;
    sess.tokenExpiry = Date.now() + (token.expiresIn || 3600) * 1000;

    // Fetch accounts
    const sso = new SSOClient({ region: sess.region });
    const acctResp = await sso.send(new ListAccountsCommand({
      accessToken: token.accessToken,
      maxResults:  20,
    }));

    // For each account, fetch roles
    const accounts = await Promise.all(
      (acctResp.accountList || []).map(async acc => {
        try {
          const rolesResp = await sso.send(new ListAccountRolesCommand({
            accessToken: token.accessToken,
            accountId:   acc.accountId,
          }));
          return { ...acc, roles: rolesResp.roleList || [] };
        } catch {
          return { ...acc, roles: [] };
        }
      })
    );

    sessions.set(sessionId, sess);
    res.json({ status: 'authorized', accounts });
  } catch (err) {
    console.error('[auth/poll]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Select account + role → exchange for temporary credentials ───────────────
router.post('/select', async (req, res) => {
  try {
    const { sessionId, accountId, roleName } = req.body;
    const sess = sessions.get(sessionId);
    if (!sess || !sess.accessToken) return res.status(401).json({ error: 'Not authenticated' });

    const sso = new SSOClient({ region: sess.region });
    const creds = await sso.send(new GetRoleCredentialsCommand({
      accessToken: sess.accessToken,
      accountId,
      roleName,
    }));

    sess.credentials = {
      accessKeyId:     creds.roleCredentials.accessKeyId,
      secretAccessKey: creds.roleCredentials.secretAccessKey,
      sessionToken:    creds.roleCredentials.sessionToken,
      expiration:      new Date(creds.roleCredentials.expiration * 1000),
    };
    sess.accountId = accountId;
    sess.roleName  = roleName;
    sessions.set(sessionId, sess);

    res.json({ status: 'ok', accountId, roleName });
  } catch (err) {
    console.error('[auth/select]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get session status (for page-reload restoration) ────────────────────────
router.get('/session/:sessionId', (req, res) => {
  const sess = sessions.get(req.params.sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  res.json({
    hasCredentials: !!sess.credentials,
    accountId:      sess.accountId,
    roleName:       sess.roleName,
    region:         sess.region,
  });
});

// ── Delete session (logout) ──────────────────────────────────────────────────
router.delete('/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ status: 'ok' });
});

// Export sessions so other routes can access credentials
module.exports = router;
module.exports.sessions = sessions;
