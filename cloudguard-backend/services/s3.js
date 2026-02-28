// ─────────────────────────────────────────────────────────────────────────────
// services/s3.js
// ─────────────────────────────────────────────────────────────────────────────
const {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetBucketLoggingCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
  GetBucketTaggingCommand
} = require('@aws-sdk/client-s3');

function makeClient(creds, region = 'us-east-1') {
  return new S3Client({
    region,
    credentials: {
      accessKeyId:     creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken:    creds.sessionToken
    }
  });
}

// Check a single bucket for security issues
async function auditBucket(client, bucketName) {
  const issues = [];
  let severity = 'ok';

  const checks = await Promise.allSettled([
    client.send(new GetPublicAccessBlockCommand({ Bucket: bucketName })),
    client.send(new GetBucketEncryptionCommand({ Bucket: bucketName })),
    client.send(new GetBucketVersioningCommand({ Bucket: bucketName })),
    client.send(new GetBucketLoggingCommand({ Bucket: bucketName })),
    client.send(new GetBucketAclCommand({ Bucket: bucketName }))
  ]);

  const [publicBlock, encryption, versioning, logging, acl] = checks;

  // Public access check
  if (publicBlock.status === 'fulfilled') {
    const pb = publicBlock.value.PublicAccessBlockConfiguration || {};
    if (!pb.BlockPublicAcls || !pb.BlockPublicPolicy || !pb.IgnorePublicAcls || !pb.RestrictPublicBuckets) {
      issues.push('Public access not fully blocked');
      severity = 'critical';
    }
  } else {
    issues.push('Public access block: not configured');
    severity = 'critical';
  }

  // Encryption check
  if (encryption.status === 'rejected') {
    issues.push('Server-side encryption disabled');
    if (severity !== 'critical') severity = 'high';
  }

  // Versioning check
  if (versioning.status === 'fulfilled') {
    if (versioning.value.Status !== 'Enabled') {
      issues.push('Versioning not enabled');
      if (severity === 'ok') severity = 'medium';
    }
  }

  // Logging check
  if (logging.status === 'fulfilled') {
    if (!logging.value.LoggingEnabled) {
      issues.push('Access logging disabled');
      if (severity === 'ok') severity = 'low';
    }
  }

  // ACL check — warn if public-read or public-read-write
  if (acl.status === 'fulfilled') {
    const grants = acl.value.Grants || [];
    const isPublic = grants.some(g =>
      g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers' ||
      g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'
    );
    if (isPublic) {
      issues.push('Bucket ACL grants public access');
      severity = 'critical';
    }
  }

  return { issues, severity };
}

// Get object count + approximate size for a bucket
async function getBucketStats(client, bucketName) {
  try {
    let totalSize = 0;
    let objectCount = 0;
    let token;

    // List up to 1000 objects to estimate (full inventory requires S3 Inventory)
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000
    }));

    objectCount = resp.KeyCount || 0;
    totalSize   = (resp.Contents || []).reduce((s, o) => s + (o.Size || 0), 0);

    return { objectCount, totalSizeBytes: totalSize };
  } catch {
    return { objectCount: 0, totalSizeBytes: 0 };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
async function getAll(creds, region = 'us-east-1') {
  const client = makeClient(creds, region);

  const { Buckets = [] } = await client.send(new ListBucketsCommand({}));

  // Audit all buckets in parallel (cap at 20 to avoid throttling)
  const sample = Buckets.slice(0, 20);

  const results = await Promise.all(
    sample.map(async (bucket) => {
      // Each bucket may be in a different region — use the global endpoint
      const auditClient = makeClient(creds, 'us-east-1');

      const [audit, stats, tagging] = await Promise.allSettled([
        auditBucket(auditClient, bucket.Name),
        getBucketStats(auditClient, bucket.Name),
        auditClient.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }))
      ]);

      const tags = tagging.status === 'fulfilled'
        ? Object.fromEntries((tagging.value.TagSet || []).map(t => [t.Key, t.Value]))
        : {};

      return {
        name:            bucket.Name,
        createdAt:       bucket.CreationDate,
        issues:          audit.status === 'fulfilled' ? audit.value.issues : ['Audit failed'],
        severity:        audit.status === 'fulfilled' ? audit.value.severity : 'unknown',
        objectCount:     stats.status === 'fulfilled' ? stats.value.objectCount : 0,
        totalSizeBytes:  stats.status === 'fulfilled' ? stats.value.totalSizeBytes : 0,
        totalSizeGB:     stats.status === 'fulfilled'
                           ? (stats.value.totalSizeBytes / 1e9).toFixed(3)
                           : '0',
        tags
      };
    })
  );

  const vulnerable = results.filter(b => b.severity !== 'ok');

  return {
    totalBuckets:     Buckets.length,
    auditedBuckets:   sample.length,
    vulnerableCount:  vulnerable.length,
    criticalCount:    vulnerable.filter(b => b.severity === 'critical').length,
    buckets:          results,
    vulnerableBuckets: vulnerable
  };
}

module.exports = { getAll };
