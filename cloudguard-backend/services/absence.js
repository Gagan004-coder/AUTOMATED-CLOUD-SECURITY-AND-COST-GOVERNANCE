// ─────────────────────────────────────────────────────────────────────────────
// services/absence.js — User Activity Tracker & Absence-Based Auto-Stop
// ─────────────────────────────────────────────────────────────────────────────
const { EC2Client, StopInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const email = require('./email');

// In-memory store (replace with DB in production)
const userActivity = new Map();    // userId -> { lastSeen, accountId, credentials, plan }
const absencePlans  = new Map();   // userId -> AbsencePlan
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour
const MAX_ABSENT_DAYS = parseInt(process.env.MAX_ABSENT_DAYS || '5');

// ── Record activity ───────────────────────────────────────────────────────────
function recordActivity(userId, accountId, credentials) {
  const now = Date.now();
  const existing = userActivity.get(userId) || {};
  userActivity.set(userId, {
    ...existing,
    userId,
    accountId,
    credentials,
    lastSeen: now,
    firstSeen: existing.firstSeen || now,
    alertSent3d: false,
    alertSent5d: false,
    servicesStopped: false,
  });
  console.log(`[absence] Activity recorded for ${userId}`);
}

// ── Get user status ───────────────────────────────────────────────────────────
function getUserStatus(userId) {
  const u = userActivity.get(userId);
  if (!u) return null;
  const daysMissing = Math.floor((Date.now() - u.lastSeen) / (1000 * 60 * 60 * 24));
  return { ...u, daysMissing, isAbsent: daysMissing >= 1 };
}

function getAllUserStatuses() {
  return Array.from(userActivity.values()).map(u => {
    const daysMissing = Math.floor((Date.now() - u.lastSeen) / (1000 * 60 * 60 * 24));
    return { ...u, daysMissing, isAbsent: daysMissing >= 1, credentials: undefined };
  });
}

// ── Create absence plan ───────────────────────────────────────────────────────
function createAbsencePlan({ userId, totalDays, startDate, keepRunning = [], notifyEmail }) {
  const start = new Date(startDate || Date.now());
  const days = Array.from({ length: totalDays }, (_, i) => {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dayNum = i + 1;
    const actions = [];
    let risk = 'low';

    if (dayNum === 1) { actions.push('Monitor only'); risk = 'low'; }
    if (dayNum === 2) { actions.push('Send status email'); risk = 'low'; }
    if (dayNum === 3) { actions.push('Send absence warning email'); risk = 'medium'; }
    if (dayNum === 4) { actions.push('Identify stoppable resources'); risk = 'high'; }
    if (dayNum === MAX_ABSENT_DAYS) { actions.push('Auto-stop non-critical services'); risk = 'critical'; }
    if (dayNum > MAX_ABSENT_DAYS) { actions.push('Services remain stopped'); risk = 'critical'; }

    return {
      day: dayNum,
      date: date.toISOString().split('T')[0],
      actions,
      risk,
    };
  });

  const plan = {
    userId,
    totalDays,
    startDate: start.toISOString().split('T')[0],
    keepRunning,
    notifyEmail,
    days,
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  absencePlans.set(userId, plan);
  console.log(`[absence] Plan created for ${userId}, ${totalDays} days`);
  return plan;
}

function getAbsencePlan(userId) {
  return absencePlans.get(userId) || null;
}

function deleteAbsencePlan(userId) {
  absencePlans.delete(userId);
}

// ── Stop EC2 instances ────────────────────────────────────────────────────────
async function stopEC2Instances(credentials, region, keepRunning = []) {
  const ec2 = new EC2Client({
    region: region || 'us-east-1',
    credentials: {
      accessKeyId:     credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken:    credentials.sessionToken,
    },
  });

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({
    Filters: [{ Name: 'instance-state-name', Values: ['running'] }]
  }));

  const instances = (Reservations || []).flatMap(r => r.Instances || []);
  const toStop = instances
    .filter(i => !keepRunning.includes(i.InstanceId))
    .map(i => i.InstanceId);

  if (!toStop.length) return { stopped: [], total: 0 };

  await ec2.send(new StopInstancesCommand({ InstanceIds: toStop }));

  return {
    stopped: toStop,
    total: toStop.length,
    kept: keepRunning,
  };
}

// ── Auto-fix: re-enable services ──────────────────────────────────────────────
async function resumeServices(userId) {
  const u = userActivity.get(userId);
  if (!u) return { error: 'User not found' };
  u.servicesStopped = false;
  u.lastSeen = Date.now();
  u.alertSent3d = false;
  u.alertSent5d = false;
  userActivity.set(userId, u);
  return { success: true, message: 'Services resumed, activity reset' };
}

// ── Absence check loop ────────────────────────────────────────────────────────
let checkTimer = null;

function startMonitoring() {
  if (checkTimer) return;
  console.log('[absence] Monitoring started, interval:', CHECK_INTERVAL_MS / 1000 / 60, 'minutes');

  checkTimer = setInterval(async () => {
    const alertEmail = process.env.ALERT_EMAIL;
    for (const [userId, u] of userActivity.entries()) {
      const daysMissing = Math.floor((Date.now() - u.lastSeen) / (1000 * 60 * 60 * 24));
      if (daysMissing === 0) continue;

      // Day 3 warning
      if (daysMissing >= 3 && daysMissing < MAX_ABSENT_DAYS && !u.alertSent3d) {
        u.alertSent3d = true;
        userActivity.set(userId, u);
        console.log(`[absence] 3-day warning for ${userId}`);
        if (alertEmail) {
          await email.sendAbsenceAlert({
            accountId: u.accountId,
            userId,
            daysMissing,
            servicesWillStop: [],
            to: alertEmail,
          }).catch(console.error);
        }
      }

      // Day 5+ — stop services
      if (daysMissing >= MAX_ABSENT_DAYS && !u.servicesStopped && u.credentials) {
        u.servicesStopped = true;
        userActivity.set(userId, u);
        console.log(`[absence] Stopping services for ${userId} (${daysMissing}d absent)`);

        const plan = absencePlans.get(userId);
        const keepRunning = plan?.keepRunning || [];

        let stoppedServices = [];
        try {
          const result = await stopEC2Instances(u.credentials, 'us-east-1', keepRunning);
          stoppedServices = result.stopped.map(id => ({ id, type: 'EC2', status: 'stopped' }));
        } catch (err) {
          console.error('[absence] Stop failed:', err.message);
        }

        if (alertEmail) {
          await email.sendAbsenceAlert({
            accountId: u.accountId,
            userId,
            daysMissing,
            servicesWillStop: stoppedServices,
            to: alertEmail,
          }).catch(console.error);
        }
      }

      // Day 5 alert (once)
      if (daysMissing >= MAX_ABSENT_DAYS && !u.alertSent5d) {
        u.alertSent5d = true;
        userActivity.set(userId, u);
      }
    }
  }, CHECK_INTERVAL_MS);
}

function stopMonitoring() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

module.exports = {
  recordActivity,
  getUserStatus,
  getAllUserStatuses,
  createAbsencePlan,
  getAbsencePlan,
  deleteAbsencePlan,
  resumeServices,
  stopEC2Instances,
  startMonitoring,
  stopMonitoring,
  MAX_ABSENT_DAYS,
};
