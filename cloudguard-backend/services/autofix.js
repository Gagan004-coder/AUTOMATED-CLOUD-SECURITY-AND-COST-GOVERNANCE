// ─────────────────────────────────────────────────────────────────────────────
// services/autofix.js — AWS Auto-Fix Engine
// Applies security & cost fixes directly via AWS APIs
// ─────────────────────────────────────────────────────────────────────────────
const {
  S3Client,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  DeleteBucketLifecycleCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const {
  EC2Client,
  StopInstancesCommand,
  TerminateInstancesCommand,
  DeleteVolumeCommand,
  DescribeVolumesCommand,
  ModifyInstanceAttributeCommand,
} = require('@aws-sdk/client-ec2');
const {
  IAMClient,
  DeleteAccessKeyCommand,
  DeactivateMFADeviceCommand,
  AttachUserPolicyCommand,
  ListAccessKeysCommand,
  UpdateAccessKeyCommand,
} = require('@aws-sdk/client-iam');
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
// Each fix: { id, label, category, description, apply(clients, params) }

const FIXES = {
  // ── S3 ──
  's3-block-public-access': {
    label: 'Block S3 Public Access',
    category: 's3',
    description: 'Enables BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, RestrictPublicBuckets',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }));
      return `Public access blocked on s3://${bucket}`;
    },
  },
  's3-enable-encryption': {
    label: 'Enable S3 Encryption',
    category: 's3',
    description: 'Enables AES-256 server-side encryption on the bucket',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }));
      return `Encryption enabled on s3://${bucket}`;
    },
  },
  's3-enable-versioning': {
    label: 'Enable S3 Versioning',
    category: 's3',
    description: 'Enables versioning for data protection on the bucket',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }));
      return `Versioning enabled on s3://${bucket}`;
    },
  },
  's3-add-lifecycle': {
    label: 'Add S3 Lifecycle Rule',
    category: 's3',
    description: 'Adds a lifecycle policy to transition old objects to Glacier after 90 days',
    async apply(clients, { bucket }) {
      await clients.s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: 'cloudguard-auto-lifecycle',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Transitions: [
              { Days: 90, StorageClass: 'STANDARD_IA' },
              { Days: 180, StorageClass: 'GLACIER' },
            ],
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }],
        },
      }));
      return `Lifecycle rule added to s3://${bucket}`;
    },
  },

  // ── EC2 ──
  'ec2-stop-idle': {
    label: 'Stop Idle EC2 Instance',
    category: 'ec2',
    description: 'Stops an idle/underutilized EC2 instance to reduce cost',
    async apply(clients, { instanceId }) {
      await clients.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
      return `EC2 instance ${instanceId} stopped`;
    },
  },
  'ec2-delete-unattached-volume': {
    label: 'Delete Unattached EBS Volume',
    category: 'ec2',
    description: 'Deletes an unattached EBS volume that is incurring cost',
    async apply(clients, { volumeId }) {
      await clients.ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      return `EBS volume ${volumeId} deleted`;
    },
  },
  'ec2-terminate-old-stopped': {
    label: 'Terminate Long-Stopped Instance',
    category: 'ec2',
    description: 'Terminates an instance stopped for 30+ days',
    async apply(clients, { instanceId }) {
      await clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      return `EC2 instance ${instanceId} terminated`;
    },
  },

  // ── IAM ──
  'iam-disable-old-key': {
    label: 'Disable Old Access Key',
    category: 'iam',
    description: 'Disables an access key older than 90 days',
    async apply(clients, { username, accessKeyId }) {
      await clients.iam.send(new UpdateAccessKeyCommand({
        UserName: username,
        AccessKeyId: accessKeyId,
        Status: 'Inactive',
      }));
      return `Access key ${accessKeyId} disabled for ${username}`;
    },
  },
  'iam-delete-old-key': {
    label: 'Delete Unused Access Key',
    category: 'iam',
    description: 'Deletes an access key that has never been used or unused for 90+ days',
    async apply(clients, { username, accessKeyId }) {
      await clients.iam.send(new DeleteAccessKeyCommand({
        UserName: username,
        AccessKeyId: accessKeyId,
      }));
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
      results.push({ ...fix, status: 'failed', details: `Unknown fix: ${fix.fixId}` });
      continue;
    }
    try {
      console.log(`[autofix] Applying ${fix.fixId} to ${fix.resource}`);
      const details = await handler.apply(clients, fix.params || {});
      results.push({
        resource: fix.resource,
        action: handler.label,
        status: 'success',
        details,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[autofix] Failed ${fix.fixId}:`, err.message);
      results.push({
        resource: fix.resource,
        action: handler.label,
        status: 'failed',
        details: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Send email notification
  if (notifyEmail || process.env.ALERT_EMAIL) {
    await email.sendAutoFixResult({
      accountId,
      fixes: results,
      to: notifyEmail || process.env.ALERT_EMAIL,
    }).catch(console.error);
  }

  return results;
}

// ── Available fixes list (for UI) ─────────────────────────────────────────────
function listFixes() {
  return Object.entries(FIXES).map(([id, f]) => ({
    id,
    label: f.label,
    category: f.category,
    description: f.description,
  }));
}

module.exports = { applyFixes, listFixes, FIXES };
