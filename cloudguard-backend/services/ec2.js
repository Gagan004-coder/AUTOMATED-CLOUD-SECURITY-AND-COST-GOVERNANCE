// ─────────────────────────────────────────────────────────────────────────────
// services/ec2.js
// ─────────────────────────────────────────────────────────────────────────────
const {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeSnapshotsCommand,
  DescribeRegionsCommand
} = require('@aws-sdk/client-ec2');

// Rough on-demand pricing (USD/hr) — update as needed
const EC2_PRICING = {
  't2.micro': 0.0116, 't2.small': 0.023, 't2.medium': 0.0464, 't2.large': 0.0928,
  't3.micro': 0.0104, 't3.small': 0.0208, 't3.medium': 0.0416, 't3.large': 0.0832,
  't3.xlarge': 0.1664, 't3.2xlarge': 0.3328,
  'm5.large': 0.096, 'm5.xlarge': 0.192, 'm5.2xlarge': 0.384, 'm5.4xlarge': 0.768,
  'c5.large': 0.085, 'c5.xlarge': 0.17, 'c5.2xlarge': 0.34,
  'r5.large': 0.126, 'r5.xlarge': 0.252
};

const EBS_PRICE_PER_GB = 0.08; // gp2/gp3 per GB per month

function makeClient(creds, region) {
  return new EC2Client({
    region,
    credentials: {
      accessKeyId:     creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken:    creds.sessionToken
    }
  });
}

function estimateMonthlyCost(instanceType) {
  const hourly = EC2_PRICING[instanceType] || 0.05;
  return +(hourly * 24 * 30).toFixed(2);
}

// Fetch instances in one region
async function getRegionInstances(client) {
  const instances = [];
  let token;

  do {
    const resp = await client.send(new DescribeInstancesCommand({
      NextToken: token,
      MaxResults: 100
    }));

    for (const reservation of resp.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        const nameTag = (inst.Tags || []).find(t => t.Key === 'Name');
        const tags = Object.fromEntries((inst.Tags || []).map(t => [t.Key, t.Value]));

        instances.push({
          instanceId:    inst.InstanceId,
          instanceType:  inst.InstanceType,
          state:         inst.State?.Name,
          name:          nameTag?.Value || inst.InstanceId,
          launchTime:    inst.LaunchTime,
          publicIp:      inst.PublicIpAddress,
          privateIp:     inst.PrivateIpAddress,
          az:            inst.Placement?.AvailabilityZone,
          platform:      inst.Platform || 'linux',
          monthlyCost:   estimateMonthlyCost(inst.InstanceType),
          tags
        });
      }
    }

    token = resp.NextToken;
  } while (token);

  return instances;
}

// Detect idle instances — running but low CPU is hard to know without CloudWatch
// We flag: stopped instances that still cost (EBS attached), very old launches, etc.
function analyzeInstances(instances) {
  const running  = instances.filter(i => i.state === 'running');
  const stopped  = instances.filter(i => i.state === 'stopped');

  // Stopped instances older than 7 days are "idle" (still paying for EBS)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const idleStopped = stopped.filter(i => new Date(i.launchTime).getTime() < sevenDaysAgo);

  return { running, stopped, idleStopped };
}

// ── Main export ───────────────────────────────────────────────────────────────
async function getAll(creds, region = 'us-east-1') {
  const client = makeClient(creds, region);

  const [instancesResult, volumesResult, snapshotsResult] = await Promise.allSettled([
    getRegionInstances(client),
    client.send(new DescribeVolumesCommand({ MaxResults: 100 })),
    client.send(new DescribeSnapshotsCommand({
      OwnerIds: ['self'],
      MaxResults: 100
    }))
  ]);

  const instances = instancesResult.status === 'fulfilled' ? instancesResult.value : [];
  const { running, stopped, idleStopped } = analyzeInstances(instances);

  // Volumes
  const volumes = volumesResult.status === 'fulfilled'
    ? (volumesResult.value.Volumes || []) : [];
  const unusedVolumes = volumes
    .filter(v => v.State === 'available')  // available = not attached
    .map(v => ({
      volumeId:    v.VolumeId,
      sizeGB:      v.Size,
      volumeType:  v.VolumeType,
      createTime:  v.CreateTime,
      monthlyCost: +(v.Size * EBS_PRICE_PER_GB).toFixed(2)
    }));

  // Snapshots
  const snapshots = snapshotsResult.status === 'fulfilled'
    ? (snapshotsResult.value.Snapshots || []) : [];
  const oldSnapshots = snapshots
    .filter(s => {
      const age = (Date.now() - new Date(s.StartTime).getTime()) / (1000 * 60 * 60 * 24);
      return age > 90;  // older than 90 days
    })
    .map(s => ({
      snapshotId:  s.SnapshotId,
      sizeGB:      s.VolumeSize,
      startTime:   s.StartTime,
      description: s.Description
    }));

  // Cost summary
  const runningCost      = running.reduce((s, i) => s + i.monthlyCost, 0);
  const unusedVolumeCost = unusedVolumes.reduce((s, v) => s + v.monthlyCost, 0);
  const idleCost         = idleStopped.reduce((s, i) => s + i.monthlyCost, 0);

  return {
    summary: {
      totalInstances:    instances.length,
      runningInstances:  running.length,
      stoppedInstances:  stopped.length,
      idleInstances:     idleStopped.length,
      unusedVolumes:     unusedVolumes.length,
      oldSnapshots:      oldSnapshots.length,
      estimatedMonthlyCost:   +runningCost.toFixed(2),
      potentialSavings:       +(unusedVolumeCost + idleCost).toFixed(2)
    },
    instances: {
      running:  running.slice(0, 50),
      stopped:  stopped.slice(0, 50),
      idle:     idleStopped.slice(0, 20)
    },
    storage: {
      volumes:         volumes.slice(0, 50),
      unusedVolumes:   unusedVolumes.slice(0, 20),
      snapshots:       snapshots.slice(0, 50),
      oldSnapshots:    oldSnapshots.slice(0, 20)
    }
  };
}

module.exports = { getAll };
