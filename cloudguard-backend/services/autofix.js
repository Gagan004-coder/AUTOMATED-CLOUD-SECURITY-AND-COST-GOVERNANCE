// services/autofix.js — CloudGuard Pro Auto-Fix Engine v2.6
'use strict';

const {
  S3Client,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const {
  EC2Client,
  StopInstancesCommand,
  TerminateInstancesCommand,
  DeleteVolumeCommand,
} = require('@aws-sdk/client-ec2');
const {
  IAMClient,
  DeleteAccessKeyCommand,
  UpdateAccessKeyCommand,
  ListAccessKeysCommand,
} = require('@aws-sdk/client-iam');

const db    = require('./db');
const email = require('./email');

function makeClients(credentials, region) {
  const creds = {
    accessKeyId:     credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken:    credentials.sessionToken,
  };
  return {
    s3:  new S3Client({ region: 'us-east-1', credentials: creds }),
    ec2: new EC2Client({ region: region || 'us-east-1', credentials: creds }),
    iam: new IAMClient({ region: 'us-east-1', credentials: creds }),
  };
}

// ── Fix Registry ──────────────────────────────────────────────────────────────
const FIXES = {
  's3-block-public-access': {
    label:       'Block S3 Public Access',
    category:    's3',
    description: 'Enables all four public access block settings on the bucket',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls:       true,
          BlockPublicPolicy:     true,
          IgnorePublicAcls:      true,
          RestrictPublicBuckets: true,
        },
      }));
      return `Public access blocked on s3://${bucket}`;
    },
  },
  's3-enable-encryption': {
    label:       'Enable S3 Encryption',
    category:    's3',
    description: 'Enables AES-256 server-side encryption on the bucket',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }));
      return `AES-256 encryption enabled on s3://${bucket}`;
    },
  },
  's3-enable-versioning': {
    label:       'Enable S3 Versioning',
    category:    's3',
    description: 'Enables versioning for data protection',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }));
      return `Versioning enabled on s3://${bucket}`;
    },
  },
  's3-add-lifecycle': {
    label:       'Add S3 Lifecycle Rule',
    category:    's3',
    description: 'Transitions old objects to Glacier after 90 days',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID:      'cloudguard-auto-lifecycle',
            Status:  'Enabled',
            Filter:  { Prefix: '' },
            Transitions: [
              { Days: 90,  StorageClass: 'STANDARD_IA' },
              { Days: 180, StorageClass: 'GLACIER' },
            ],
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }],
        },
      }));
      return `Lifecycle rule added to s3://${bucket}`;
    },
  },
  'ec2-stop-idle': {
    label:       'Stop Idle EC2 Instance',
    category:    'ec2',
    description: 'Stops a stopped/idle EC2 instance to avoid EBS charges',
    async apply(clients, { instanceId }) {
      await clients.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
      return `EC2 instance ${instanceId} stopped`;
    },
  },
  'ec2-delete-unattached-volume': {
    label:       'Delete Unattached EBS Volume',
    category:    'ec2',
    description: 'Deletes an unattached EBS volume',
    async apply(clients, { volumeId }) {
      await clients.ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      return `EBS volume ${volumeId} deleted`;
    },
  },
  'ec2-terminate-old-stopped': {
    label:       'Terminate Long-Stopped Instance',
    category:    'ec2',
    description: 'Terminates an instance stopped for 30+ days',
    async apply(clients, { instanceId }) {
      await clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      return `EC2 instance ${instanceId} terminated`;
    },
  },
  'iam-disable-old-key': {
    label:       'Disable Old Access Key',
    category:    'iam',
    description: 'Disables an access key older than 90 days',
    async apply(clients, { username, accessKeyId }) {
      let keyId = accessKeyId;
      if (!keyId) {
        const keys = await clients.iam.send(new ListAccessKeysCommand({ UserName: username }));
        const ninety = Date.now() - 90 * 86400000;
        const old  = (keys.AccessKeyMetadata || []).find(k =>
          k.Status === 'Active' && new Date(k.CreateDate).getTime() < ninety
        );
        keyId = old?.AccessKeyId;
      }
      if (!keyId) return `No old active key found for ${username}`;
      await clients.iam.send(new UpdateAccessKeyCommand({ UserName: username, AccessKeyId: keyId, Status: 'Inactive' }));
      return `Access key ${keyId} disabled for ${username}`;
    },
  },
  'iam-delete-old-key': {
    label:       'Delete Unused Access Key',
    category:    'iam',
    description: 'Deletes an access key unused for 90+ days',
    async apply(clients, { username, accessKeyId }) {
      await clients.iam.send(new DeleteAccessKeyCommand({ UserName: username, AccessKeyId: accessKeyId }));
      return `Access key ${accessKeyId} deleted for ${username}`;
    },
  },
};

// ── Apply a batch of fixes ────────────────────────────────────────────────────
async function applyFixes({ fixes, credentials, region, accountId, notifyEmail }) {
  const clients = makeClients(credentials, region);
  const results = [];

  for (const fix of fixes) {
    const handler = FIXES[fix.fixId];
    if (!handler) {
      results.push({ resource: fix.resource, action: fix.fixId, status: 'failed', details: `Unknown fix: ${fix.fixId}`, timestamp: new Date().toISOString() });
      continue;
    }
    try {
      console.log(`[autofix] ${fix.fixId} on ${fix.resource}`);
      const details = await handler.apply(clients, fix.params || {});
      const r = { resource: fix.resource, action: handler.label, status: 'success', details, timestamp: new Date().toISOString() };
      results.push(r);

      // Persist to DB
      db.saveFix({ accountId, fixId: fix.fixId, resource: fix.resource, status: 'success', details, appliedBy: fix.appliedBy || 'user' });
    } catch (err) {
      console.error(`[autofix] ${fix.fixId} failed:`, err.message);
      const r = { resource: fix.resource, action: handler.label, status: 'failed', details: err.message, timestamp: new Date().toISOString() };
      results.push(r);
      db.saveFix({ accountId, fixId: fix.fixId, resource: fix.resource, status: 'failed', details: err.message, appliedBy: fix.appliedBy || 'user' });
    }
  }

  const recipient = notifyEmail || process.env.ALERT_EMAIL;
  if (recipient && results.some(r => r.status === 'success')) {
    email.sendAutoFixReport(results, recipient, accountId).catch(console.error);
  }

  return results;
}

function listFixes() {
  return Object.entries(FIXES).map(([id, f]) => ({
    id, label: f.label, category: f.category, description: f.description,
  }));
}

module.exports = { applyFixes, listFixes, FIXES };
