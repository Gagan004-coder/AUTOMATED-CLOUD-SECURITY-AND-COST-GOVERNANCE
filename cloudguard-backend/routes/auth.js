// ─────────────────────────────────────────────────────────────────────────────
// routes/auth.js  — AWS SSO OIDC device-code login flow
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { v4: uuid } = require('uuid');
const {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand
} = require('@aws-sdk/client-sso-oidc');
const {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  GetRoleCredentialsCommand
} = require('@aws-sdk/client-sso');

const router  = express.Router();
const sessions = new Map();

const SSO_REGION    = process.env.AWS_SSO_REGION    || 'us-east-1';
const SSO_START_URL = process.env.AWS_SSO_START_URL || '';

// ── POST /api/auth/start ──────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const startUrl = (req.body.startUrl || SSO_START_URL || '').trim();
    if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

    const region     = req.body.region || SSO_REGION;
    const oidcClient = new SSOOIDCClient({ region });

    console.log('[auth/start] Registering OIDC client for', startUrl);

    const { clientId, clientSecret } = await oidcClient.send(
      new RegisterClientCommand({ clientName: 'CloudGuard-Pro', clientType: 'public' })
    );

    const authData = await oidcClient.send(
      new StartDeviceAuthorizationCommand({ clientId, clientSecret, startUrl })
    );

    console.log('[auth/start] Device auth started, userCode:', authData.userCode);

    const sessionId = uuid();
    sessions.set(sessionId, {
      clientId,
      clientSecret,
      deviceCode: authData.deviceCode,
      startUrl,
      region,
      status: 'pending',
      createdAt: Date.now()
    });

    res.json({
      sessionId,
      verificationUri:         authData.verificationUri,
      verificationUriComplete: authData.verificationUriComplete,
      userCode:  authData.userCode,
      expiresIn: authData.expiresIn,
      interval:  authData.interval || 5
    });

  } catch (err) {
    console.error('[auth/start] ERROR:', err.name, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/poll ───────────────────────────────────────────────────────
router.post('/poll', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  // Already authorized — return cached result
  if (session.status === 'authorized') {
    return res.json({ status: 'authorized', accounts: session.accounts });
  }

  try {
    const oidcClient = new SSOOIDCClient({ region: session.region || SSO_REGION });

    const tokenData = await oidcClient.send(
      new CreateTokenCommand({
        clientId:     session.clientId,
        clientSecret: session.clientSecret,
        grantType:    'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode:   session.deviceCode
      })
    );

    console.log('[auth/poll] Token obtained! Listing accounts...');

    const ssoClient = new SSOClient({ region: session.region || SSO_REGION });

    let accountList = [];
    try {
      const resp = await ssoClient.send(
        new ListAccountsCommand({ accessToken: tokenData.accessToken, maxResults: 20 })
      );
      accountList = resp.accountList || [];
      console.log('[auth/poll] Found', accountList.length, 'accounts');
    } catch (listErr) {
      console.error('[auth/poll] ListAccounts failed:', listErr.message);
    }

    const accounts = await Promise.all(
      accountList.map(async (account) => {
        try {
          const { roleList } = await ssoClient.send(
            new ListAccountRolesCommand({
              accessToken: tokenData.accessToken,
              accountId:   account.accountId
            })
          );
          return { ...account, roles: roleList || [] };
        } catch (roleErr) {
          console.warn('[auth/poll] Roles fetch failed for', account.accountId, roleErr.message);
          return { ...account, roles: [] };
        }
      })
    );

    session.status      = 'authorized';
    session.accessToken = tokenData.accessToken;
    session.accounts    = accounts;
    sessions.set(sessionId, session);

    return res.json({ status: 'authorized', accounts });

  } catch (err) {
    if (err.name === 'AuthorizationPendingException') {
      return res.json({ status: 'pending' });
    }
    if (err.name === 'SlowDownException') {
      return res.json({ status: 'pending', slowDown: true });
    }
    if (err.name === 'ExpiredTokenException') {
      sessions.delete(sessionId);
      return res.json({ status: 'expired' });
    }
    console.error('[auth/poll] UNEXPECTED ERROR:', err.name, '|', err.message);
    return res.status(500).json({ error: err.message, code: err.name });
  }
});

// ── POST /api/auth/select ─────────────────────────────────────────────────────
router.post('/select', async (req, res) => {
  const { sessionId, accountId, roleName } = req.body;

  if (!sessionId || !accountId || !roleName) {
    return res.status(400).json({ error: 'sessionId, accountId and roleName are required' });
  }

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'authorized') {
    return res.status(401).json({ error: 'Session not found or not authorized' });
  }

  try {
    console.log('[auth/select] Getting credentials for', accountId, '/', roleName);

    const ssoClient = new SSOClient({ region: session.region || SSO_REGION });
    const { roleCredentials } = await ssoClient.send(
      new GetRoleCredentialsCommand({
        accessToken: session.accessToken,
        accountId,
        roleName
      })
    );

    session.credentials = {
      accessKeyId:     roleCredentials.accessKeyId,
      secretAccessKey: roleCredentials.secretAccessKey,
      sessionToken:    roleCredentials.sessionToken,
      expiration:      roleCredentials.expiration
    };
    session.accountId = accountId;
    session.roleName  = roleName;
    sessions.set(sessionId, session);

    console.log('[auth/select] Credentials obtained!');

    res.json({ success: true, accountId, roleName, expiresAt: roleCredentials.expiration });

  } catch (err) {
    console.error('[auth/select] ERROR:', err.name, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/session/:id ─────────────────────────────────────────────────
router.get('/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    status:         session.status,
    accountId:      session.accountId,
    roleName:       session.roleName,
    hasCredentials: !!session.credentials
  });
});

// ── DELETE /api/auth/session/:id ──────────────────────────────────────────────
router.delete('/session/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
module.exports.sessions = sessions;