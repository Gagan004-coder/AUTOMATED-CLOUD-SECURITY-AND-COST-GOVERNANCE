// routes/notifications.js — CloudGuard Pro Notifications & Automation
const express = require('express');
const router  = express.Router();
const emailService = require('../services/email');
const absence      = require('../services/absence');

// ── Email config check ───────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const config = await emailService.getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send test email ──────────────────────────────────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const { to } = req.body;
    const result = await emailService.sendTest(to);
    res.json(result);
  } catch (err) {
    console.error('[notify/test]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Security alert email ─────────────────────────────────────────────────────
router.post('/security', async (req, res) => {
  try {
    const { issues, to } = req.body;
    const result = await emailService.sendSecurityAlert(issues || [], to);
    res.json(result);
  } catch (err) {
    console.error('[notify/security]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cost alert email ─────────────────────────────────────────────────────────
router.post('/cost', async (req, res) => {
  try {
    const { currentCost, forecastedCost, threshold, to } = req.body;
    const result = await emailService.sendCostAlert({ currentCost, forecastedCost, threshold: threshold || 500 }, to);
    res.json(result);
  } catch (err) {
    console.error('[notify/cost]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Weekly summary email ─────────────────────────────────────────────────────
router.post('/weekly', async (req, res) => {
  try {
    const { summary, to } = req.body;
    const result = await emailService.sendWeeklySummary(summary || {}, to);
    res.json(result);
  } catch (err) {
    console.error('[notify/weekly]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-fix engine ──────────────────────────────────────────────────────────
router.post('/autofix', async (req, res) => {
  try {
    const { fixes = [], notifyEmail } = req.body;
    const sessionId = req.headers['x-session-id'];
    const { sessions } = require('./auth');
    const sess = sessions.get(sessionId);
    const creds = sess?.credentials;

    const results = await Promise.all(fixes.map(async fix => {
      try {
        const result = await applyFix(fix, creds, sess?.region || 'us-east-1');
        return { ...fix, status: 'success', details: result, timestamp: new Date().toISOString() };
      } catch (e) {
        return { ...fix, status: 'failed', details: e.message, timestamp: new Date().toISOString() };
      }
    }));

    const succeeded = results.filter(r => r.status === 'success');

    // Send email notification if configured
    if (succeeded.length > 0) {
      emailService.sendAutoFixReport(results, notifyEmail).catch(() => {});
    }

    res.json({ total: fixes.length, results });
  } catch (err) {
    console.error('[notify/autofix]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Apply a single fix ───────────────────────────────────────────────────────
async function applyFix(fix, creds, region) {
  if (!creds) {
    // Simulate fix for demo mode
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    return `${fix.fixId} applied (demo mode)`;
  }

  switch (fix.fixId) {
    case 's3-block-public-access': {
      const { S3Client, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
      await s3.send(new PutPublicAccessBlockCommand({
        Bucket: fix.params.bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, IgnorePublicAcls: true,
          BlockPublicPolicy: true, RestrictPublicBuckets: true,
        },
      }));
      return `Public access blocked on s3://${fix.params.bucket}`;
    }

    case 's3-enable-encryption': {
      const { S3Client, PutBucketEncryptionCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
      await s3.send(new PutBucketEncryptionCommand({
        Bucket: fix.params.bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }));
      return `SSE-AES256 encryption enabled on s3://${fix.params.bucket}`;
    }

    case 's3-enable-versioning': {
      const { S3Client, PutBucketVersioningCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: 'us-east-1', credentials: creds });
      await s3.send(new PutBucketVersioningCommand({
        Bucket: fix.params.bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }));
      return `Versioning enabled on s3://${fix.params.bucket}`;
    }

    case 'ec2-stop-idle': {
      const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');
      const ec2 = new EC2Client({ region, credentials: creds });
      await ec2.send(new StopInstancesCommand({ InstanceIds: [fix.params.instanceId] }));
      return `EC2 instance ${fix.params.instanceId} stopped`;
    }

    case 'ec2-delete-unattached-volume': {
      const { EC2Client, DeleteVolumeCommand } = require('@aws-sdk/client-ec2');
      const ec2 = new EC2Client({ region, credentials: creds });
      await ec2.send(new DeleteVolumeCommand({ VolumeId: fix.params.volumeId }));
      return `EBS volume ${fix.params.volumeId} deleted`;
    }

    case 'iam-disable-old-key': {
      const { IAMClient, UpdateAccessKeyCommand, ListAccessKeysCommand } = require('@aws-sdk/client-iam');
      const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
      let keyId = fix.params.accessKeyId;
      if (!keyId) {
        const keys = await iam.send(new ListAccessKeysCommand({ UserName: fix.params.username }));
        const ninetyDaysAgo = Date.now() - 90 * 86400000;
        const old = (keys.AccessKeyMetadata || []).find(k => k.Status === 'Active' && new Date(k.CreateDate).getTime() < ninetyDaysAgo);
        keyId = old?.AccessKeyId;
      }
      if (keyId) {
        await iam.send(new UpdateAccessKeyCommand({ UserName: fix.params.username, AccessKeyId: keyId, Status: 'Inactive' }));
        return `Access key ${keyId} disabled for ${fix.params.username}`;
      }
      return `No old active key found for ${fix.params.username}`;
    }

    default:
      throw new Error(`Unknown fix: ${fix.fixId}`);
  }
}

// ── Absence management routes ─────────────────────────────────────────────────
router.get('/absence/status', async (req, res) => {
  try {
    const users = absence.getTrackedUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/plan', async (req, res) => {
  try {
    const { userId, totalDays, startDate, keepRunning = [], notifyEmail } = req.body;
    if (!userId || !totalDays) return res.status(400).json({ error: 'userId and totalDays are required' });

    const plan = absence.createPlan({ userId, totalDays, startDate, keepRunning });
    if (notifyEmail) {
      emailService.sendAbsencePlanEmail(plan, notifyEmail).catch(() => {});
    }
    res.json({ plan });
  } catch (err) {
    console.error('[notify/absence/plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/resume/:userId', async (req, res) => {
  try {
    absence.resumeUser(req.params.userId);
    res.json({ status: 'ok', userId: req.params.userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/absence/stop-services', async (req, res) => {
  try {
    const { keepRunning = [] } = req.body;
    const result = absence.stopServices(keepRunning);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;