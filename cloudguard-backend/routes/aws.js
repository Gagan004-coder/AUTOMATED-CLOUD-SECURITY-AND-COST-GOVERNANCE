// routes/aws.js — CloudGuard Pro AWS Data Routes
const express = require('express');
const router  = express.Router();
const { sessions } = require('./auth');

const { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, ListBucketsCommand, GetBucketAclCommand, GetBucketEncryptionCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
const { IAMClient, ListUsersCommand, ListAccessKeysCommand, GetLoginProfileCommand, ListMFADevicesCommand, ListAttachedUserPoliciesCommand } = require('@aws-sdk/client-iam');
const { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } = require('@aws-sdk/client-cost-explorer');

// ── Middleware: extract credentials from session ─────────────────────────────
function getCredentials(req) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) throw new Error('No session ID provided');
  const sess = sessions.get(sessionId);
  if (!sess || !sess.credentials) throw new Error('Not authenticated — please connect via AWS SSO');
  if (new Date() > new Date(sess.credentials.expiration)) throw new Error('AWS credentials have expired — please reconnect');
  return { credentials: sess.credentials, region: sess.region || 'us-east-1', accountId: sess.accountId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeEC2(creds, region)  { return new EC2Client({ region, credentials: creds }); }
function makeS3(creds, region)   { return new S3Client({ region, credentials: creds }); }
function makeIAM(creds)          { return new IAMClient({ region: 'us-east-1', credentials: creds }); }
function makeCE(creds)           { return new CostExplorerClient({ region: 'us-east-1', credentials: creds }); }

const fmt2 = n => Math.round(n * 100) / 100;

// ── S3 Audit ─────────────────────────────────────────────────────────────────
async function auditS3(creds, region) {
  const s3 = makeS3(creds, region);
  let buckets = [];
  try {
    const resp = await s3.send(new ListBucketsCommand({}));
    buckets = resp.Buckets || [];
  } catch (e) {
    console.warn('[S3] ListBuckets error:', e.message);
    return { totalBuckets: 0, vulnerableCount: 0, criticalCount: 0, buckets: [], vulnerableBuckets: [] };
  }

  const audited = await Promise.all(buckets.map(async b => {
    const issues = [];
    let severity = 'ok';

    try {
      const pub = await s3.send(new GetPublicAccessBlockCommand({ Bucket: b.Name }));
      const c = pub.PublicAccessBlockConfiguration;
      if (!c.BlockPublicAcls || !c.BlockPublicPolicy || !c.IgnorePublicAcls || !c.RestrictPublicBuckets) {
        issues.push('Public access not fully blocked');
        severity = 'critical';
      }
    } catch { issues.push('Public access block: check failed'); severity = severity === 'ok' ? 'medium' : severity; }

    try {
      await s3.send(new GetBucketEncryptionCommand({ Bucket: b.Name }));
    } catch (e) {
      if (e.name === 'ServerSideEncryptionConfigurationNotFoundError' || e.$metadata?.httpStatusCode === 404) {
        issues.push('Encryption not enabled');
        severity = severity === 'ok' ? 'high' : severity;
      }
    }

    try {
      const ver = await s3.send(new GetBucketVersioningCommand({ Bucket: b.Name }));
      if (!ver.Status || ver.Status !== 'Enabled') {
        issues.push('Versioning not enabled');
        if (severity === 'ok') severity = 'low';
      }
    } catch { /* skip */ }

    return { name: b.Name, issues, severity, createdAt: b.CreationDate };
  }));

  const vulnerable  = audited.filter(b => b.severity !== 'ok');
  const critical    = audited.filter(b => b.severity === 'critical');

  return {
    totalBuckets:     audited.length,
    vulnerableCount:  vulnerable.length,
    criticalCount:    critical.length,
    buckets:          audited,
    vulnerableBuckets: vulnerable,
  };
}

// ── EC2 Audit ────────────────────────────────────────────────────────────────
async function auditEC2(creds, region) {
  const ec2 = makeEC2(creds, region);
  let reservations = [];
  let volumes = [];

  try {
    const resp = await ec2.send(new DescribeInstancesCommand({ MaxResults: 100 }));
    reservations = resp.Reservations || [];
  } catch (e) { console.warn('[EC2] DescribeInstances:', e.message); }

  try {
    const vResp = await ec2.send(new DescribeVolumesCommand({ MaxResults: 100 }));
    volumes = vResp.Volumes || [];
  } catch (e) { console.warn('[EC2] DescribeVolumes:', e.message); }

  const instances = reservations.flatMap(r => r.Instances || []);
  const running   = instances.filter(i => i.State?.Name === 'running');
  const stopped   = instances.filter(i => i.State?.Name === 'stopped');
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const idle      = stopped.filter(i => i.StateTransitionReason?.includes('User initiated') || (i.StateReason?.Message && new Date(i.LaunchTime).getTime() < sevenDaysAgo));
  const unusedVols = volumes.filter(v => v.State === 'available');

  // Rough monthly cost estimates
  const instanceCostMap = { 't2.micro':8,'t2.small':16,'t2.medium':33,'t3.micro':7,'t3.small':15,'t3.medium':30,'t3.large':60,'m5.large':70,'m5.xlarge':140,'c5.large':62,'r5.large':91 };
  const getCost = type => instanceCostMap[type] || 50;

  const formatInst = i => ({
    instanceId:    i.InstanceId,
    instanceType:  i.InstanceType,
    state:         i.State?.Name,
    name:          i.Tags?.find(t => t.Key === 'Name')?.Value || i.InstanceId,
    az:            i.Placement?.AvailabilityZone,
    launchTime:    i.LaunchTime,
    monthlyCost:   getCost(i.InstanceType),
    platform:      i.Platform || 'Linux',
  });

  const totalMonthlyCost = running.reduce((s, i) => s + getCost(i.InstanceType), 0);

  return {
    summary: {
      runningInstances:    running.length,
      stoppedInstances:    stopped.length,
      idleInstances:       idle.length,
      unusedVolumes:       unusedVols.length,
      estimatedMonthlyCost: totalMonthlyCost,
    },
    instances: {
      running: running.map(formatInst),
      stopped: stopped.map(formatInst),
      idle:    idle.map(formatInst),
    },
    storage: {
      totalVolumes:  volumes.length,
      unusedVolumes: unusedVols.map(v => ({
        volumeId:    v.VolumeId,
        sizeGB:      v.Size,
        volumeType:  v.VolumeType,
        monthlyCost: fmt2(v.Size * 0.1),
      })),
    },
  };
}

// ── IAM Audit ────────────────────────────────────────────────────────────────
async function auditIAM(creds) {
  const iam = makeIAM(creds);
  let users = [];

  try {
    const resp = await iam.send(new ListUsersCommand({ MaxItems: 100 }));
    users = resp.Users || [];
  } catch (e) { console.warn('[IAM] ListUsers:', e.message); return { summary: {}, usersWithIssues: [] }; }

  const now = Date.now();
  const ninetyDays = 90 * 86400000;

  const audited = await Promise.all(users.map(async u => {
    const issues = [];
    let severity = 'ok';

    // Check MFA
    try {
      const mfa = await iam.send(new ListMFADevicesCommand({ UserName: u.UserName }));
      if (!mfa.MFADevices?.length) {
        // Only flag if user has console access
        try {
          await iam.send(new GetLoginProfileCommand({ UserName: u.UserName }));
          issues.push('No MFA enabled for console user');
          severity = 'high';
        } catch { /* no console access, skip */ }
      }
    } catch { /* skip */ }

    // Check access keys
    try {
      const keys = await iam.send(new ListAccessKeysCommand({ UserName: u.UserName }));
      for (const key of keys.AccessKeyMetadata || []) {
        if (key.Status === 'Active' && key.CreateDate) {
          const age = now - new Date(key.CreateDate).getTime();
          if (age > ninetyDays) {
            issues.push(`Access key ${key.AccessKeyId.slice(-6)} is ${Math.floor(age / 86400000)}d old`);
            if (severity === 'ok') severity = 'medium';
            u._oldKeyId = key.AccessKeyId;
          }
        }
      }
    } catch { /* skip */ }

    return {
      username: u.UserName,
      userId:   u.UserId,
      arn:      u.Arn,
      created:  u.CreateDate,
      issues,
      severity,
      oldKeyId: u._oldKeyId,
    };
  }));

  const withIssues = audited.filter(u => u.severity !== 'ok');
  const highSev    = withIssues.filter(u => u.severity === 'high' || u.severity === 'critical');

  return {
    summary: {
      totalUsers:      users.length,
      usersWithIssues: withIssues.length,
      highSeverity:    highSev.length,
      usersWithoutMFA: audited.filter(u => u.issues.some(i => i.includes('MFA'))).length,
    },
    usersWithIssues: withIssues,
    allUsers:        audited,
  };
}

// ── Billing / Cost Explorer ──────────────────────────────────────────────────
async function auditBilling(creds) {
  const ce = makeCE(creds);
  const now      = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const today    = now.toISOString().split('T')[0];
  const startOfMonth = firstOfMonth.toISOString().split('T')[0];

  // 6-month trend
  const trend = [];
  for (let m = 5; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const start = d.toISOString().split('T')[0];
    const endD = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const end = endD > now ? today : endD.toISOString().split('T')[0];
    trend.push({ month: d.toLocaleString('default', { month: 'short' }), start, end });
  }

  let currentCost = 0, prevCost = 0, forecastedCost = null, serviceBreakdown = [], monthlyTrend = [];

  try {
    // Current month total
    const curr = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: startOfMonth, End: today },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    }));
    currentCost = parseFloat(curr.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0);

    // Previous month total
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const prevEnd   = startOfMonth;
    const prev = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: prevStart, End: prevEnd },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    }));
    prevCost = parseFloat(prev.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0);

    // Service breakdown
    const svcResp = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: startOfMonth, End: today },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }));
    serviceBreakdown = (svcResp.ResultsByTime?.[0]?.Groups || [])
      .map(g => ({ service: g.Keys[0], cost: fmt2(parseFloat(g.Metrics.UnblendedCost.Amount)) }))
      .filter(s => s.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);

    // Forecast
    try {
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
      if (today < endOfMonth) {
        const fc = await ce.send(new GetCostForecastCommand({
          TimePeriod: { Start: today, End: endOfMonth },
          Metric: 'UNBLENDED_COST',
          Granularity: 'MONTHLY',
        }));
        forecastedCost = fmt2(currentCost + parseFloat(fc.Total?.Amount || 0));
      } else {
        forecastedCost = fmt2(currentCost);
      }
    } catch { forecastedCost = fmt2(currentCost * 1.1); }

    // 6-month trend data
    monthlyTrend = await Promise.all(trend.map(async t => {
      if (t.start === t.end) return { month: t.month, cost: 0 };
      try {
        const r = await ce.send(new GetCostAndUsageCommand({
          TimePeriod: { Start: t.start, End: t.end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
        }));
        return { month: t.month, cost: fmt2(parseFloat(r.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0)) };
      } catch { return { month: t.month, cost: 0 }; }
    }));

  } catch (e) {
    console.warn('[Billing]', e.message);
  }

  const percentChange = prevCost > 0 ? Math.round(((currentCost - prevCost) / prevCost) * 100) : 0;

  return {
    summary: {
      currentMonthCost:  fmt2(currentCost),
      previousMonthCost: fmt2(prevCost),
      forecastedCost:    forecastedCost ?? fmt2(currentCost),
      percentChange,
      currency: 'USD',
    },
    serviceBreakdown,
    monthlyTrend: monthlyTrend.length ? monthlyTrend : trend.map(t => ({ month: t.month, cost: 0 })),
  };
}

// ── /api/aws/overview — combined endpoint ────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const { credentials: creds, region, accountId } = getCredentials(req);

    // Run all audits in parallel, let each fail gracefully
    const [s3, ec2, iam, billing] = await Promise.allSettled([
      auditS3(creds, region),
      auditEC2(creds, region),
      auditIAM(creds),
      auditBilling(creds),
    ]);

    res.json({
      accountId,
      region,
      s3:      s3.status      === 'fulfilled' ? s3.value      : { error: s3.reason?.message,      totalBuckets: 0, vulnerableCount: 0, criticalCount: 0, buckets: [], vulnerableBuckets: [] },
      ec2:     ec2.status     === 'fulfilled' ? ec2.value     : { error: ec2.reason?.message,     summary: {}, instances: {}, storage: {} },
      iam:     iam.status     === 'fulfilled' ? iam.value     : { error: iam.reason?.message,     summary: {}, usersWithIssues: [] },
      billing: billing.status === 'fulfilled' ? billing.value : { error: billing.reason?.message, summary: {}, serviceBreakdown: [], monthlyTrend: [] },
    });
  } catch (err) {
    console.error('[aws/overview]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Individual endpoints ─────────────────────────────────────────────────────
router.get('/s3',      async (req, res) => { try { const { credentials: c, region } = getCredentials(req); res.json(await auditS3(c, region)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/ec2',     async (req, res) => { try { const { credentials: c, region } = getCredentials(req); res.json(await auditEC2(c, region)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/iam',     async (req, res) => { try { const { credentials: c }          = getCredentials(req); res.json(await auditIAM(c)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/billing', async (req, res) => { try { const { credentials: c }          = getCredentials(req); res.json(await auditBilling(c)); } catch (e) { res.status(500).json({ error: e.message }); } });

module.exports = router;
module.exports.getCredentials = getCredentials;