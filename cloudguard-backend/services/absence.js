// services/absence.js — CloudGuard Pro Absence Management v2.6
'use strict';

const trackedUsers = new Map(); // userId -> tracking state
const activePlans  = new Map(); // userId -> plan

function createPlan({ userId, totalDays, startDate, keepRunning = [] }) {
  const start      = startDate ? new Date(startDate) : new Date();
  const autoStopDay = parseInt(process.env.MAX_ABSENT_DAYS || '5');
  const maxDays    = Math.min(Math.max(1, totalDays), 365);

  const days = Array.from({ length: maxDays }, (_, i) => {
    const date   = new Date(start);
    date.setDate(date.getDate() + i);
    const dayNum = i + 1;
    const actions = [];
    let   risk  = 'low';

    if (dayNum === 1)              { actions.push('Absence begins', 'Monitoring activated');       risk = 'low'; }
    if (dayNum === 3)              { actions.push('Warning email sent', 'Activity check');         risk = 'medium'; }
    if (dayNum === autoStopDay)    { actions.push('Auto-stop triggered', 'Critical alert email');  risk = 'critical'; }
    if (dayNum > autoStopDay)      { actions.push('Services stopped', 'Continued monitoring');     risk = 'critical'; }
    if (dayNum === maxDays)        { actions.push('Plan ends', 'Services resume on return'); }
    if (!actions.length)           { actions.push('Monitoring active'); }

    return {
      day:     dayNum,
      date:    date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      actions,
      risk,
    };
  });

  const plan = {
    userId,
    totalDays: maxDays,
    startDate: start.toISOString().split('T')[0],
    keepRunning,
    autoStopDay,
    days,
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  activePlans.set(userId, plan);
  trackedUsers.set(userId, {
    userId,
    accountId:        process.env.AWS_ACCOUNT_ID || 'demo',
    daysMissing:      0,
    lastSeen:         new Date().toISOString(),
    warningEmailSent: false,
    status:           'active',
    plan,
  });

  return plan;
}

function getTrackedUsers() {
  return Array.from(trackedUsers.values());
}

function resumeUser(userId) {
  const user = trackedUsers.get(userId);
  if (user) {
    user.daysMissing      = 0;
    user.lastSeen         = new Date().toISOString();
    user.warningEmailSent = false;
    user.status           = 'active';
    trackedUsers.set(userId, user);
  }
  const plan = activePlans.get(userId);
  if (plan) {
    plan.status = 'completed';
    activePlans.set(userId, plan);
  }
}

function stopServices(keepRunning = []) {
  return {
    total:     3,
    stopped:   3 - keepRunning.length,
    kept:      keepRunning.length,
    timestamp: new Date().toISOString(),
  };
}

function startMonitoring() {
  const threshold = parseInt(process.env.MAX_ABSENT_DAYS || '5');

  setInterval(() => {
    const now = Date.now();
    trackedUsers.forEach((user, userId) => {
      if (user.status === 'stopped') return;
      const daysMissing = Math.floor((now - new Date(user.lastSeen).getTime()) / 86400000);
      user.daysMissing  = daysMissing;

      if (daysMissing >= threshold && user.status !== 'stopped') {
        user.status = 'stopped';
        console.log(`[Absence] Auto-stopping services for ${userId} (${daysMissing}d absent)`);

        // Lazy-load email to avoid circular deps
        const emailSvc = require('./email');
        emailSvc.sendSecurityAlert([{
          resource: `user:${userId}`,
          service:  'absence',
          issues:   [`Auto-stop triggered: ${daysMissing} days absent (threshold: ${threshold})`],
          severity: 'critical',
        }], null, userId).catch(() => {});

      } else if (daysMissing >= 3 && !user.warningEmailSent) {
        user.warningEmailSent = true;
        console.log(`[Absence] Warning for ${userId} (${daysMissing}d absent)`);
      }

      trackedUsers.set(userId, user);
    });
  }, 3_600_000); // every hour

  console.log(`[Absence] Monitoring started. Auto-stop threshold: ${threshold} days`);
}

module.exports = { createPlan, getTrackedUsers, resumeUser, stopServices, startMonitoring };
