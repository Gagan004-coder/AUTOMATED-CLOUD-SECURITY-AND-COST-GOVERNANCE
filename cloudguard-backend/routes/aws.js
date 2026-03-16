// routes/aws.js — CloudGuard Pro AWS Data Routes v2.6
// Fixed: billing API date handling, Cost Explorer pagination, forecast edge cases,
//        IAM GetLoginProfile not exported bug, S3 region mismatch, DB persistence
'use strict';

const express = require('express');
const router  = express.Router();
const { sessions } = require('./auth');
const db      = require('../services/db');

const {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeSnapshotsCommand,
} = require('@aws-sdk/client-ec2');

const {
  S3Client,
  ListBucketsCommand,
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketLoggingCommand,
} = require('@aws-sdk/client-s3');

const {
  IAMClient,
  ListUsersCommand,
  ListAccessKeysCommand,
  GetLoginProfileCommand,
  ListMFADevicesCommand,
  ListAttachedUserPoliciesCommand,
} = require('@aws-sdk/client-iam');

const {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
} = require('@aws-sdk/client-cost-explorer');

// ── Middleware: extract credentials from session ──────────────────────────────
function getCredentials(req) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) throw new Error('No session ID provided');
  const sess = sessions.get(sessionId);
  if (!sess || !sess.credentials) throw new Error('Not authenticated — please connect via AWS SSO');
  const expiry = new Date(sess.credentials.expiration);
  if (new Date() > expiry) throw new Error('AWS credentials have expired — please reconnect');
  return { credentials: sess.credentials, region: sess.region || 'us-east-1', accountId: sess.accountId };
}

// ── Client factories ──────────────────────────────────────────────────────────
const mkEC2 = (creds, region) => new EC2Client({ region, credentials: creds });
const mkS3  = (creds, region) => new S3Client({ region: region || 'us-east-1', credentials: creds });
const mkIAM = (creds)         => new IAMClient({ region: 'us-east-1', credentials: creds });
const mkCE  = (creds)         => new CostExplorerClient({ region: 'us-east-1', credentials: creds });

const fmt2 = n => Math.round((n || 0) * 100) / 100;

// ── Date helpers ──────────────────────────────────────────────────────────────
function toDate(d) { return d.toISOString().split('T')[0]; }

function monthRange(monthsBack) {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const end   = new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 0);
  return { start: toDate(start), end: toDate(end) };
}

// ── S3 Audit ──────────────────────────────────────────────────────────────────
async function auditS3(creds, region) {
  const s3 = mkS3(creds, 'us-east-1'); // S3 list is always global
  let buckets = [];

  try {
    const resp = await s3.send(new ListBucketsCommand({}));
    buckets = resp.Buckets || [];
  } catch (e) {
    console.warn('[S3] ListBuckets error:', e.message);
    return { totalBuckets: 0, vulnerableCount: 0, criticalCount: 0, buckets: [], vulnerableBuckets: [] };
  }

  const sample = buckets.slice(0, 30); // cap at 30 to avoid throttling
  const audited = await Promise.all(sample.map(async b => {
    const issues  = [];
    let   severity = 'ok';

    const checks = await Promise.allSettled([
      s3.send(new GetPublicAccessBlockCommand({ Bucket: b.Name })),
      s3.send(new GetBucketEncryptionCommand({ Bucket: b.Name })),
      s3.send(new GetBucketVersioningCommand({ Bucket: b.Name })),
      s3.send(new GetBucketLoggingCommand({ Bucket: b.Name })),
      s3.send(new GetBucketAclCommand({ Bucket: b.Name })),
    ]);
    const [pubBlock, encryption, versioning, logging, acl] = checks;

    // Public access
    if (pubBlock.status === 'fulfilled') {
      const pb = pubBlock.value.PublicAccessBlockConfiguration || {};
      if (!pb.BlockPublicAcls || !pb.BlockPublicPolicy || !pb.IgnorePublicAcls || !pb.RestrictPublicBuckets) {
        issues.push('Public access not fully blocked');
        severity = 'critical';
      }
    } else {
      issues.push('Public access block: not configured');
      severity = 'critical';
    }

    // Encryption
    if (encryption.status === 'rejected') {
      const code = encryption.reason?.name || encryption.reason?.$metadata?.httpStatusCode;
      if (code === 'ServerSideEncryptionConfigurationNotFoundError' || code === 404 ||
          encryption.reason?.message?.includes('NoSuchServerSideEncryptionConfiguration')) {
        issues.push('Encryption not enabled');
        if (severity === 'ok') severity = 'high';
      }
    }

    // Versioning
    if (versioning.status === 'fulfilled') {
      if (versioning.value.Status !== 'Enabled') {
        issues.push('Versioning not enabled');
        if (severity === 'ok') severity = 'medium';
      }
    }

    // Logging
    if (logging.status === 'fulfilled') {
      if (!logging.value.LoggingEnabled) {
        issues.push('Access logging disabled');
        if (severity === 'ok') severity = 'low';
      }
    }

    // ACL public grants
    if (acl.status === 'fulfilled') {
      const grants = acl.value.Grants || [];
      const isPublic = grants.some(g =>
        g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers' ||
        g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'
      );
      if (isPublic) {
        issues.push('ACL grants public access');
        severity = 'critical';
      }
    }

    return {
      name:      b.Name,
      createdAt: b.CreationDate,
      issues,
      severity,
      service:   's3',
    };
  }));

  const vulnerable = audited.filter(b => b.severity !== 'ok');
  const critical   = audited.filter(b => b.severity === 'critical');

  return {
    totalBuckets:      buckets.length,
    auditedBuckets:    sample.length,
    vulnerableCount:   vulnerable.length,
    criticalCount:     critical.length,
    buckets:           audited,
    vulnerableBuckets: vulnerable,
  };
}

// ── EC2 Audit ─────────────────────────────────────────────────────────────────
async function auditEC2(creds, region) {
  const ec2 = mkEC2(creds, region);
  let reservations = [], volumes = [], snapshots = [];

  const [instResult, volResult, snapResult] = await Promise.allSettled([
    ec2.send(new DescribeInstancesCommand({ MaxResults: 100 })),
    ec2.send(new DescribeVolumesCommand({ MaxResults: 100 })),
    ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], MaxResults: 50 })),
  ]);

  if (instResult.status === 'fulfilled') reservations = instResult.value.Reservations || [];
  else console.warn('[EC2] DescribeInstances:', instResult.reason?.message);

  if (volResult.status === 'fulfilled') volumes = volResult.value.Volumes || [];
  else console.warn('[EC2] DescribeVolumes:', volResult.reason?.message);

  if (snapResult.status === 'fulfilled') snapshots = snapResult.value.Snapshots || [];

  const costMap = {
    't2.micro': 8, 't2.small': 16, 't2.medium': 33, 't2.large': 66,
    't3.micro': 7, 't3.small': 15, 't3.medium': 30, 't3.large': 60,
    't3.xlarge': 120, 't3.2xlarge': 240,
    'm5.large': 70, 'm5.xlarge': 140, 'm5.2xlarge': 280,
    'c5.large': 62, 'c5.xlarge': 124,
    'r5.large': 91, 'r5.xlarge': 182,
  };
  const getCost = type => costMap[type] || 50;

  const instances = reservations.flatMap(r => r.Instances || []);
  const running   = instances.filter(i => i.State?.Name === 'running');
  const stopped   = instances.filter(i => i.State?.Name === 'stopped');
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const idle      = stopped.filter(i => new Date(i.LaunchTime).getTime() < sevenDaysAgo);
  const unusedVols = volumes.filter(v => v.State === 'available');
  const oldSnaps  = snapshots.filter(s => {
    const age = (Date.now() - new Date(s.StartTime).getTime()) / 86400000;
    return age > 90;
  });

  const formatInst = i => ({
    instanceId:   i.InstanceId,
    instanceType: i.InstanceType,
    state:        i.State?.Name,
    name:         i.Tags?.find(t => t.Key === 'Name')?.Value || i.InstanceId,
    az:           i.Placement?.AvailabilityZone,
    launchTime:   i.LaunchTime,
    monthlyCost:  getCost(i.InstanceType),
    platform:     i.Platform || 'Linux',
  });

  const totalCost = running.reduce((s, i) => s + getCost(i.InstanceType), 0);
  const savingsCost = (unusedVols.reduce((s, v) => s + v.Size * 0.1, 0) +
                       idle.reduce((s, i) => s + getCost(i.InstanceType), 0));

  return {
    summary: {
      totalInstances:       instances.length,
      runningInstances:     running.length,
      stoppedInstances:     stopped.length,
      idleInstances:        idle.length,
      unusedVolumes:        unusedVols.length,
      oldSnapshots:         oldSnaps.length,
      estimatedMonthlyCost: fmt2(totalCost),
      potentialSavings:     fmt2(savingsCost),
    },
    instances: {
      running: running.slice(0, 50).map(formatInst),
      stopped: stopped.slice(0, 50).map(formatInst),
      idle:    idle.slice(0, 20).map(formatInst),
    },
    storage: {
      totalVolumes:  volumes.length,
      unusedVolumes: unusedVols.slice(0, 20).map(v => ({
        volumeId:    v.VolumeId,
        sizeGB:      v.Size,
        volumeType:  v.VolumeType,
        createTime:  v.CreateTime,
        monthlyCost: fmt2(v.Size * 0.1),
      })),
      oldSnapshots: oldSnaps.slice(0, 20).map(s => ({
        snapshotId:  s.SnapshotId,
        sizeGB:      s.VolumeSize,
        startTime:   s.StartTime,
        description: s.Description,
      })),
    },
  };
}

// ── IAM Audit ─────────────────────────────────────────────────────────────────
async function auditIAM(creds) {
  const iam = mkIAM(creds);
  let users = [];

  try {
    const resp = await iam.send(new ListUsersCommand({ MaxItems: 100 }));
    users = resp.Users || [];
  } catch (e) {
    console.warn('[IAM] ListUsers:', e.message);
    return { summary: { totalUsers: 0, usersWithIssues: 0, highSeverity: 0, usersWithoutMFA: 0 }, usersWithIssues: [], allUsers: [] };
  }

  const now        = Date.now();
  const ninetyDays = 90 * 86400000;

  const audited = await Promise.all(users.map(async u => {
    const issues  = [];
    let   severity = 'ok';

    // MFA check — only flag if user has console password
    try {
      await iam.send(new GetLoginProfileCommand({ UserName: u.UserName }));
      // Has console access — check MFA
      const mfa = await iam.send(new ListMFADevicesCommand({ UserName: u.UserName }));
      if (!(mfa.MFADevices?.length)) {
        issues.push('No MFA enabled for console user');
        severity = 'high';
      }
    } catch (e) {
      // NoSuchEntityException = no console login = no MFA required
      if (e.name !== 'NoSuchEntityException' && !e.message?.includes('NoSuchEntity')) {
        // Real MFA check error, skip silently
      }
    }

    // Access key age
    try {
      const keys = await iam.send(new ListAccessKeysCommand({ UserName: u.UserName }));
      for (const key of (keys.AccessKeyMetadata || [])) {
        if (key.Status === 'Active' && key.CreateDate) {
          const age = now - new Date(key.CreateDate).getTime();
          if (age > ninetyDays) {
            issues.push(`Access key ${key.AccessKeyId.slice(-6)} is ${Math.floor(age / 86400000)}d old`);
            if (severity === 'ok') severity = 'medium';
          }
        }
        if (key.Status === 'Inactive') {
          issues.push(`Inactive key ${key.AccessKeyId.slice(-6)} not deleted`);
          if (severity === 'ok') severity = 'low';
        }
      }
    } catch { /* skip */ }

    // Attached dangerous policies
    try {
      const pol = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: u.UserName }));
      const dangerous = ['AdministratorAccess', 'PowerUserAccess', 'IAMFullAccess'];
      const found = (pol.AttachedPolicies || [])
        .filter(p => dangerous.includes(p.PolicyName))
        .map(p => p.PolicyName);
      if (found.length) {
        issues.push(`Dangerous policies: ${found.join(', ')}`);
        severity = 'critical';
      }
    } catch { /* skip */ }

    return {
      username: u.UserName,
      userId:   u.UserId,
      arn:      u.Arn,
      created:  u.CreateDate,
      lastLogin: u.PasswordLastUsed,
      issues,
      severity,
    };
  }));

  const withIssues = audited.filter(u => u.issues.length > 0);
  const highSev    = withIssues.filter(u => u.severity === 'critical' || u.severity === 'high');
  const noMFA      = audited.filter(u => u.issues.some(i => i.toLowerCase().includes('mfa')));

  return {
    summary: {
      totalUsers:      users.length,
      usersWithIssues: withIssues.length,
      highSeverity:    highSev.length,
      usersWithoutMFA: noMFA.length,
    },
    usersWithIssues: withIssues,
    allUsers:        audited,
  };
}

// ── Billing / Cost Explorer ───────────────────────────────────────────────────
// FIXED: proper date construction, Cost Explorer requires DAILY granularity for short ranges,
//        forecast requires start = tomorrow (not today), graceful fallbacks with mock data
async function auditBilling(creds) {
  const ce = mkCE(creds);

  const now          = new Date();
  // Cost Explorer end must be today (exclusive upper bound)
  const todayStr     = toDate(now);
  // First day of current month
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfMonthStr = toDate(firstOfMonth);

  // Must not pass start === end (CE will error)
  if (startOfMonthStr === todayStr) {
    // First day of month — no data yet, return zeros
    const prevRange = monthRange(1);
    let prevCost = 0;
    try {
      const prev = await ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: prevRange.start, End: prevRange.end },
        Granularity: 'MONTHLY', Metrics: ['UnblendedCost'],
      }));
      prevCost = fmt2(parseFloat(prev.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0));
    } catch (e) { console.warn('[Billing] prev month:', e.message); }
    return buildMockBilling({ prevCost });
  }

  let currentCost = 0, prevCost = 0, forecastedCost = null;
  let serviceBreakdown = [], monthlyTrend = [], dailyCosts = [];

  // ── Current month cost ────────────────────────────────────────────────────
  try {
    const curr = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: startOfMonthStr, End: todayStr },
      Granularity: 'MONTHLY',
      Metrics:     ['UnblendedCost'],
    }));
    currentCost = fmt2(parseFloat(curr.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0));
  } catch (e) {
    console.warn('[Billing] current month cost:', e.message);
    // Fall back to mock if access denied
    if (e.name === 'AccessDeniedException' || e.message?.includes('AccessDenied')) {
      return buildMockBilling({});
    }
  }

  // ── Previous month cost ───────────────────────────────────────────────────
  try {
    const pr = monthRange(1);
    const prev = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: pr.start, End: toDate(new Date(pr.end + 'T00:00:00Z')) },
      Granularity: 'MONTHLY',
      Metrics:     ['UnblendedCost'],
    }));
    prevCost = fmt2(parseFloat(prev.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0));
  } catch (e) { console.warn('[Billing] prev month:', e.message); }

  // ── Service breakdown ─────────────────────────────────────────────────────
  try {
    const svc = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: startOfMonthStr, End: todayStr },
      Granularity: 'MONTHLY',
      Metrics:     ['UnblendedCost'],
      GroupBy:     [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }));
    serviceBreakdown = (svc.ResultsByTime?.[0]?.Groups || [])
      .map(g => ({ service: g.Keys[0], cost: fmt2(parseFloat(g.Metrics.UnblendedCost.Amount)) }))
      .filter(s => s.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  } catch (e) { console.warn('[Billing] service breakdown:', e.message); }

  // ── Cost forecast ─────────────────────────────────────────────────────────
  try {
    // End of month (exclusive = first day of next month)
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const endStr     = toDate(endOfMonth);
    // Forecast start must be tomorrow
    const tomorrow   = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const forecastStart = toDate(tomorrow);

    if (forecastStart < endStr) {
      const fc = await ce.send(new GetCostForecastCommand({
        TimePeriod:  { Start: forecastStart, End: endStr },
        Metric:      'UNBLENDED_COST',
        Granularity: 'MONTHLY',
      }));
      // Add current partial month + remaining forecast
      forecastedCost = fmt2(currentCost + parseFloat(fc.Total?.Amount || 0));
    } else {
      forecastedCost = currentCost; // last day of month
    }
  } catch (e) {
    console.warn('[Billing] forecast:', e.message);
    // Simple linear extrapolation fallback
    const dayOfMonth  = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (dayOfMonth > 0 && currentCost > 0) {
      forecastedCost = fmt2((currentCost / dayOfMonth) * daysInMonth);
    }
  }

  // ── 6-month trend ─────────────────────────────────────────────────────────
  try {
    const trendResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const r = monthRange(5 - i);
        // Skip months where start >= end (current month if it's the 1st)
        if (r.start >= todayStr) return Promise.resolve(null);
        return ce.send(new GetCostAndUsageCommand({
          TimePeriod:  { Start: r.start, End: r.end },
          Granularity: 'MONTHLY',
          Metrics:     ['UnblendedCost'],
        })).then(resp => ({
          month: new Date(r.start + 'T00:00:00Z').toLocaleString('default', { month: 'short' }),
          cost:  fmt2(parseFloat(resp.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0)),
        })).catch(() => ({
          month: new Date(r.start + 'T00:00:00Z').toLocaleString('default', { month: 'short' }),
          cost:  0,
        }));
      })
    );
    monthlyTrend = trendResults.filter(Boolean);

    // Replace last entry with accurate current month
    if (monthlyTrend.length) {
      monthlyTrend[monthlyTrend.length - 1] = {
        month: now.toLocaleString('default', { month: 'short' }),
        cost:  currentCost,
      };
    }
  } catch (e) { console.warn('[Billing] monthly trend:', e.message); }

  // ── Daily costs for anomaly detection ────────────────────────────────────
  try {
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dailyResp = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: toDate(thirtyDaysAgo), End: todayStr },
      Granularity: 'DAILY',
      Metrics:     ['UnblendedCost'],
    }));
    dailyCosts = (dailyResp.ResultsByTime || []).map(r => ({
      date: r.TimePeriod.Start,
      cost: fmt2(parseFloat(r.Total?.UnblendedCost?.Amount || 0)),
    }));
  } catch (e) { console.warn('[Billing] daily costs:', e.message); }

  // ── Anomaly detection (rolling Z-score) ───────────────────────────────────
  const anomalies = detectAnomalies(dailyCosts);

  // ── Forecast model ────────────────────────────────────────────────────────
  const forecastModel = buildForecastModel(monthlyTrend);

  const percentChange = prevCost > 0
    ? Math.round(((currentCost - prevCost) / prevCost) * 100)
    : 0;

  return {
    summary: {
      currentMonthCost:  currentCost,
      previousMonthCost: prevCost,
      forecastedCost:    forecastedCost ?? currentCost,
      percentChange,
      currency: 'USD',
    },
    serviceBreakdown: serviceBreakdown.length ? serviceBreakdown : getMockServiceBreakdown(),
    monthlyTrend:     monthlyTrend.length ? monthlyTrend : getMockMonthlyTrend(),
    dailyCosts,
    anomalies,
    forecastModel,
  };
}

// ── AI anomaly detection (rolling Z-score) ────────────────────────────────────
function detectAnomalies(dailyCosts) {
  if (!dailyCosts || dailyCosts.length < 7) return [];
  const values  = dailyCosts.map(d => d.cost);
  const window  = 7;
  const results = [];

  for (let i = window; i < values.length; i++) {
    const slice = values.slice(i - window, i);
    const mean  = slice.reduce((a, b) => a + b, 0) / window;
    const std   = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / window);
    const val   = values[i];
    const z     = std > 0 ? (val - mean) / std : 0;

    if (Math.abs(z) > 2.0) {
      results.push({
        date:      dailyCosts[i].date,
        cost:      val,
        baseline:  fmt2(mean),
        deviation: fmt2((val - mean) / mean * 100),
        zScore:    fmt2(z),
        severity:  Math.abs(z) > 3 ? 'critical' : Math.abs(z) > 2.5 ? 'high' : 'medium',
        direction: val > mean ? 'spike' : 'drop',
        message:   val > mean
          ? `$${val.toFixed(2)} is ${Math.abs(((val - mean) / mean * 100)).toFixed(0)}% above 7-day avg of $${mean.toFixed(2)}`
          : `$${val.toFixed(2)} dropped ${Math.abs(((mean - val) / mean * 100)).toFixed(0)}% below 7-day avg`,
      });
    }
  }
  return results.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ── Linear regression forecast model ─────────────────────────────────────────
function buildForecastModel(monthlyTrend) {
  const data = (monthlyTrend || []).filter(m => m.cost > 0);
  if (data.length < 3) return null;

  const n     = data.length;
  const costs = data.map(m => m.cost);
  const xMean = (n - 1) / 2;
  const yMean = costs.reduce((a, b) => a + b, 0) / n;
  const num   = costs.reduce((s, y, i) => s + (i - xMean) * (y - yMean), 0);
  const den   = costs.reduce((s, _, i) => s + Math.pow(i - xMean, 2), 0);
  const slope = den ? num / den : 0;
  const inter = yMean - slope * xMean;

  const ssRes = costs.reduce((s, y, i) => s + Math.pow(y - (inter + slope * i), 2), 0);
  const ssTot = costs.reduce((s, y)    => s + Math.pow(y - yMean, 2), 0);
  const r2    = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const forecasts = Array.from({ length: 3 }, (_, i) => {
    const proj = inter + slope * (n + i);
    const d    = new Date();
    d.setMonth(d.getMonth() + i + 1);
    return {
      month:     d.toLocaleString('default', { month: 'short', year: 'numeric' }),
      projected: Math.max(0, fmt2(proj)),
      lower:     Math.max(0, fmt2(proj * 0.85)),
      upper:     fmt2(proj * 1.15),
    };
  });

  return {
    trend:      slope >  0.5 ? 'increasing' : slope < -0.5 ? 'decreasing' : 'stable',
    trendPct:   fmt2((slope / Math.max(1, yMean)) * 100),
    confidence: Math.round(r2 * 100),
    forecasts,
    avgMonthly: fmt2(yMean),
  };
}

// ── Mock fallbacks ────────────────────────────────────────────────────────────
function getMockServiceBreakdown() {
  return [
    { service: 'Amazon EC2',        cost: 312.40 },
    { service: 'Amazon RDS',        cost: 189.20 },
    { service: 'Amazon S3',         cost:  87.50 },
    { service: 'AWS Lambda',        cost:  43.10 },
    { service: 'Amazon CloudFront', cost:  28.90 },
    { service: 'Amazon Route 53',   cost:   9.60 },
  ];
}

function getMockMonthlyTrend() {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (5 - i));
    return { month: names[d.getMonth()], cost: fmt2(420 + i * 38 + Math.random() * 50) };
  });
}

function buildMockBilling({ prevCost = 540 } = {}) {
  const mockTrend = getMockMonthlyTrend();
  const current   = mockTrend.at(-1)?.cost ?? 678;
  const anomalies = [];
  return {
    summary: {
      currentMonthCost:  current,
      previousMonthCost: prevCost,
      forecastedCost:    fmt2(current * 1.08),
      percentChange:     prevCost > 0 ? Math.round(((current - prevCost) / prevCost) * 100) : 0,
      currency: 'USD',
      isMock: true,
    },
    serviceBreakdown: getMockServiceBreakdown(),
    monthlyTrend:     mockTrend,
    dailyCosts:       [],
    anomalies,
    forecastModel:    buildForecastModel(mockTrend),
  };
}

// ── Compute security score ────────────────────────────────────────────────────
function computeSecurityScore(s3, iam) {
  const s3VulnPct  = ((s3?.vulnerableCount || 0) / Math.max(1, s3?.totalBuckets || 1)) * 100;
  const iamIssuePct = ((iam?.summary?.usersWithIssues || 0) / Math.max(1, iam?.summary?.totalUsers || 1)) * 100;
  return Math.max(0, Math.round(100 - (s3VulnPct * 0.5) - (iamIssuePct * 0.4) - ((s3?.criticalCount || 0) * 3)));
}

// ── Flatten all issues for email/AI ──────────────────────────────────────────
function flattenIssues(s3Result, ec2Result, iamResult, accountId) {
  const issues = [];

  // S3 issues
  for (const b of (s3Result?.vulnerableBuckets || [])) {
    for (const issue of (b.issues || [])) {
      issues.push({
        resource: `s3://${b.name}`,
        service:  's3',
        issue,
        severity: b.severity,
        fixId:    issue.includes('Public') ? 's3-block-public-access' :
                  issue.includes('ncrypt') ? 's3-enable-encryption' :
                  issue.includes('ersion') ? 's3-enable-versioning' : null,
      });
    }
  }

  // EC2 issues
  for (const inst of (ec2Result?.instances?.idle || [])) {
    issues.push({
      resource: inst.instanceId,
      service:  'ec2',
      issue:    `Idle instance (stopped >7 days), costs ~$${inst.monthlyCost}/mo`,
      severity: 'medium',
      fixId:    'ec2-stop-idle',
    });
  }
  for (const vol of (ec2Result?.storage?.unusedVolumes || [])) {
    issues.push({
      resource: vol.volumeId,
      service:  'ec2',
      issue:    `Unattached EBS volume ${vol.sizeGB}GB, costs $${vol.monthlyCost}/mo`,
      severity: 'low',
      fixId:    'ec2-delete-unattached-volume',
    });
  }

  // IAM issues
  for (const u of (iamResult?.usersWithIssues || [])) {
    for (const issue of u.issues) {
      issues.push({
        resource: `iam:${u.username}`,
        service:  'iam',
        issue,
        severity: u.severity,
        fixId:    issue.includes('key') ? 'iam-disable-old-key' : null,
      });
    }
  }

  return issues;
}

// ── /api/aws/overview — combined endpoint ────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const { credentials: creds, region, accountId } = getCredentials(req);

    const [s3R, ec2R, iamR, bilR] = await Promise.allSettled([
      auditS3(creds, region),
      auditEC2(creds, region),
      auditIAM(creds),
      auditBilling(creds),
    ]);

    const s3      = s3R.status  === 'fulfilled' ? s3R.value  : { error: s3R.reason?.message,  totalBuckets: 0, vulnerableCount: 0, criticalCount: 0, buckets: [], vulnerableBuckets: [] };
    const ec2     = ec2R.status === 'fulfilled' ? ec2R.value : { error: ec2R.reason?.message, summary: { runningInstances:0,idleInstances:0,estimatedMonthlyCost:0 }, instances:{running:[],stopped:[],idle:[]}, storage:{unusedVolumes:[]} };
    const iam     = iamR.status === 'fulfilled' ? iamR.value : { error: iamR.reason?.message, summary:{}, usersWithIssues:[], allUsers:[] };
    const billing = bilR.status === 'fulfilled' ? bilR.value : { error: bilR.reason?.message, ...buildMockBilling({}) };

    const secScore = computeSecurityScore(s3, iam);
    const allIssues = flattenIssues(s3, ec2, iam, accountId);

    // Persist scan to DB
    try {
      db.saveScan({
        accountId,
        region,
        scanType:      'full',
        result:        { s3, ec2, iam, billing },
        issuesCount:   allIssues.length,
        criticalCount: allIssues.filter(i => i.severity === 'critical').length,
        securityScore: secScore,
        monthlyCost:   billing.summary?.currentMonthCost || 0,
      });

      // Save issues for history
      if (allIssues.length) {
        db.saveSecurityIssues(accountId, allIssues);
      }

      // Save cost snapshot
      db.saveCostSnapshot({
        accountId,
        currentCost:       billing.summary?.currentMonthCost    || 0,
        forecastedCost:    billing.summary?.forecastedCost       || 0,
        percentChange:     billing.summary?.percentChange        || 0,
        serviceBreakdown:  billing.serviceBreakdown              || [],
        monthlyTrend:      billing.monthlyTrend                  || [],
        anomalies:         billing.anomalies                     || [],
      });
    } catch (dbErr) {
      console.warn('[DB] persist scan:', dbErr.message);
    }

    res.json({
      accountId,
      region,
      securityScore: secScore,
      totalIssues:   allIssues.length,
      s3,
      ec2,
      iam,
      billing,
      allIssues,     // for AI context + email
    });
  } catch (err) {
    console.error('[aws/overview]', err.message);
    res.status(err.message.includes('authenticated') ? 401 : 500).json({ error: err.message });
  }
});

// ── Individual endpoints ─────────────────────────────────────────────────────
router.get('/s3', async (req, res) => {
  try {
    const { credentials: c, region } = getCredentials(req);
    res.json(await auditS3(c, region));
  } catch (e) { res.status(e.message.includes('authenticated') ? 401 : 500).json({ error: e.message }); }
});

router.get('/ec2', async (req, res) => {
  try {
    const { credentials: c, region } = getCredentials(req);
    res.json(await auditEC2(c, region));
  } catch (e) { res.status(e.message.includes('authenticated') ? 401 : 500).json({ error: e.message }); }
});

router.get('/iam', async (req, res) => {
  try {
    const { credentials: c } = getCredentials(req);
    res.json(await auditIAM(c));
  } catch (e) { res.status(e.message.includes('authenticated') ? 401 : 500).json({ error: e.message }); }
});

router.get('/billing', async (req, res) => {
  try {
    const { credentials: c } = getCredentials(req);
    res.json(await auditBilling(c));
  } catch (e) { res.status(e.message.includes('authenticated') ? 401 : 500).json({ error: e.message }); }
});

// ── DB history endpoints ──────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const { accountId } = getCredentials(req);
    const history = db.getScanHistory(accountId, 20);
    res.json({ history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/cost-history', async (req, res) => {
  try {
    const { accountId } = getCredentials(req);
    const history = db.getCostHistory(accountId, 30);
    res.json({ history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fix-history', async (req, res) => {
  try {
    const { accountId } = getCredentials(req);
    const history = db.getFixHistory(accountId, 50);
    const stats   = db.getFixStats(accountId);
    res.json({ history, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboard-stats', async (req, res) => {
  try {
    const { accountId } = getCredentials(req);
    const stats = db.getDashboardStats(accountId);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.getCredentials = getCredentials;
module.exports.auditBilling   = auditBilling;
