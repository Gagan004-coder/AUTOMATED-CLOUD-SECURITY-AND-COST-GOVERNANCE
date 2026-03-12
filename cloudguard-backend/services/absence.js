// services/absence.js — CloudGuard Pro Absence Management
'use strict';

const trackedUsers = new Map(); // userId -> { daysMissing, accountId, lastSeen }
const activePlans  = new Map(); // userId -> plan

// ── Create an absence plan ────────────────────────────────────────────────────
function createPlan({ userId, totalDays, startDate, keepRunning = [] }) {
  const start = startDate ? new Date(startDate) : new Date();
  const autoStopDay = parseInt(process.env.MAX_ABSENT_DAYS || '5');

  const days = Array.from({ length: Math.min(totalDays, 30) }, (_, i) => {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dayNum = i + 1;
    const actions = [];
    let risk = 'low';

    if (dayNum === 1)             { actions.push('Absence begins', 'Monitoring activated'); risk = 'low'; }
    if (dayNum === 3)             { actions.push('Warning email sent', 'Activity check'); risk = 'medium'; }
    if (dayNum === autoStopDay)   { actions.push('Auto-stop services', 'Critical alert email'); risk = 'critical'; }
    if (dayNum > autoStopDay)     { actions.push('Services stopped', 'Continued monitoring'); risk = 'critical'; }
    if (dayNum === totalDays)     { actions.push('Plan ends', 'Services resumed on return'); }
    if (!actions.length)          { actions.push('Monitoring active'); }

    return {
      day:     dayNum,
      date:    date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      actions,
      risk,
    };
  });

  const plan = {
    userId, totalDays, startDate: start.toISOString().split('T')[0],
    keepRunning, autoStopDay, days,
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  activePlans.set(userId, plan);

  // Track the user
  trackedUsers.set(userId, {
    userId,
    accountId:   process.env.AWS_ACCOUNT_ID || 'demo',
    daysMissing: 0,
    lastSeen:    new Date().toISOString(),
    plan:        plan,
  });

  return plan;
}

// ── Get all tracked users ─────────────────────────────────────────────────────
function getTrackedUsers() {
  return Array.from(trackedUsers.values());
}

// ── Resume a user (mark as active) ───────────────────────────────────────────
function resumeUser(userId) {
  const user = trackedUsers.get(userId);
  if (user) {
    user.daysMissing = 0;
    user.lastSeen = new Date().toISOString();
    trackedUsers.set(userId, user);
  }
  const plan = activePlans.get(userId);
  if (plan) { plan.status = 'completed'; activePlans.set(userId, plan); }
}

// ── Simulate service stop ─────────────────────────────────────────────────────
function stopServices(keepRunning = []) {
  return {
    total:    3, // mock
    stopped:  3,
    kept:     keepRunning.length,
    timestamp: new Date().toISOString(),
  };
}

// ── Background monitoring (runs on server start) ──────────────────────────────
function startMonitoring() {
  const threshold  = parseInt(process.env.MAX_ABSENT_DAYS || '5');
  const emailSvc   = require('./email');

  // Check every hour
  setInterval(() => {
    const now = Date.now();
    trackedUsers.forEach((user, userId) => {
      if (user.status === 'stopped') return;
      const lastSeenMs  = new Date(user.lastSeen).getTime();
      const daysMissing = Math.floor((now - lastSeenMs) / 86400000);
      user.daysMissing  = daysMissing;

      if (daysMissing >= threshold && user.status !== 'stopped') {
        user.status = 'stopped';
        console.log(`[Absence] Auto-stopping services for ${userId} (${daysMissing}d absent)`);
        emailSvc.sendSecurityAlert([{
          severity: 'critical',
          resource: `user:${userId}`,
          issues:   [`Auto-stop triggered: ${daysMissing} days absent (threshold: ${threshold})`],
        }]).catch(() => {});
      } else if (daysMissing >= 3 && !user.warningEmailSent) {
        user.warningEmailSent = true;
        console.log(`[Absence] Warning for ${userId} (${daysMissing}d absent)`);
      }

      trackedUsers.set(userId, user);
    });
  }, 3600 * 1000);

  console.log(`[Absence] Monitoring started. Auto-stop threshold: ${threshold} days`);
}

module.exports = { createPlan, getTrackedUsers, resumeUser, stopServices, startMonitoring };
