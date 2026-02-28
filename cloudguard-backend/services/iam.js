// ─────────────────────────────────────────────────────────────────────────────
// services/iam.js
// ─────────────────────────────────────────────────────────────────────────────
const {
  IAMClient,
  ListUsersCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  ListMFADevicesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  GetCredentialReportCommand,
  GenerateCredentialReportCommand,
  ListRolesCommand,
  ListPoliciesCommand
} = require('@aws-sdk/client-iam');

function makeClient(creds) {
  return new IAMClient({
    region: 'us-east-1',   // IAM is global
    credentials: {
      accessKeyId:     creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken:    creds.sessionToken
    }
  });
}

// Dangerous admin-equivalent policies
const DANGEROUS_POLICIES = [
  'AdministratorAccess',
  'PowerUserAccess',
  'IAMFullAccess'
];

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

async function auditUser(client, user) {
  const issues   = [];
  let   severity = 'ok';

  const [keys, mfa, policies] = await Promise.allSettled([
    client.send(new ListAccessKeysCommand({ UserName: user.UserName })),
    client.send(new ListMFADevicesCommand({ UserName: user.UserName })),
    client.send(new ListAttachedUserPoliciesCommand({ UserName: user.UserName }))
  ]);

  // MFA check
  const mfaDevices = mfa.status === 'fulfilled' ? mfa.value.MFADevices : [];
  if (mfaDevices.length === 0) {
    issues.push('MFA not enabled');
    if (severity === 'ok') severity = 'medium';
  }

  // Access key checks
  const keyList = keys.status === 'fulfilled' ? keys.value.AccessKeyMetadata : [];
  for (const key of keyList) {
    const keyAge = daysSince(key.CreateDate);
    if (keyAge > 90) {
      issues.push(`Access key older than 90 days (${keyAge}d)`);
      if (severity === 'ok') severity = 'medium';
    }
    if (key.Status === 'Inactive') {
      issues.push('Inactive access key not deleted');
    }

    // Check last used
    try {
      const lastUsed = await client.send(
        new GetAccessKeyLastUsedCommand({ AccessKeyId: key.AccessKeyId })
      );
      const lastUsedDate = lastUsed.AccessKeyLastUsed?.LastUsedDate;
      if (lastUsedDate) {
        const unused = daysSince(lastUsedDate);
        if (unused > 60) {
          issues.push(`Access key unused for ${unused} days`);
          if (severity === 'ok') severity = 'medium';
        }
      }
    } catch {}
  }

  // Policy checks
  const policyList = policies.status === 'fulfilled'
    ? policies.value.AttachedPolicies : [];
  const dangerousPolicies = policyList
    .filter(p => DANGEROUS_POLICIES.includes(p.PolicyName))
    .map(p => p.PolicyName);

  if (dangerousPolicies.length > 0) {
    issues.push(`Dangerous policies: ${dangerousPolicies.join(', ')}`);
    severity = 'high';
  }

  // Inactive user check (no console login for 90+ days)
  const lastLogin = user.PasswordLastUsed;
  if (lastLogin) {
    const inactive = daysSince(lastLogin);
    if (inactive > 90) {
      issues.push(`Console login inactive for ${inactive} days`);
      if (severity === 'ok') severity = 'medium';
    }
  } else if (user.PasswordLastUsed === undefined) {
    // Never logged in
    issues.push('Console password never used');
    if (severity === 'ok') severity = 'low';
  }

  return {
    username:    user.UserName,
    userId:      user.UserId,
    arn:         user.Arn,
    createdAt:   user.CreateDate,
    lastLogin:   user.PasswordLastUsed,
    mfaEnabled:  mfaDevices.length > 0,
    accessKeys:  keyList.length,
    policies:    policyList.map(p => p.PolicyName),
    issues,
    severity
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
async function getAll(creds) {
  const client = makeClient(creds);

  // List all users
  const users = [];
  let marker;
  do {
    const resp = await client.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 }));
    users.push(...(resp.Users || []));
    marker = resp.Marker;
  } while (marker);

  // Audit up to 30 users in parallel
  const sample = users.slice(0, 30);
  const auditResults = await Promise.all(
    sample.map(user => auditUser(client, user))
  );

  const usersWithIssues = auditResults.filter(u => u.issues.length > 0);
  const highSeverity    = usersWithIssues.filter(u => u.severity === 'high');
  const noMFA           = auditResults.filter(u => !u.mfaEnabled);

  // Roles summary
  let roles = [];
  try {
    const rolesResp = await client.send(new ListRolesCommand({ MaxItems: 50 }));
    roles = (rolesResp.Roles || []).map(r => ({
      roleName:    r.RoleName,
      arn:         r.Arn,
      createdAt:   r.CreateDate,
      description: r.Description
    }));
  } catch {}

  return {
    summary: {
      totalUsers:       users.length,
      usersAudited:     sample.length,
      usersWithIssues:  usersWithIssues.length,
      highSeverity:     highSeverity.length,
      usersWithoutMFA:  noMFA.length,
      totalRoles:       roles.length
    },
    users: auditResults,
    usersWithIssues,
    highSeverityUsers: highSeverity,
    usersWithoutMFA:   noMFA,
    roles: roles.slice(0, 20)
  };
}

module.exports = { getAll };
