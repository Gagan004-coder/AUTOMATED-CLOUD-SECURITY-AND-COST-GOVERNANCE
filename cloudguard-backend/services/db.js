// services/db.js — CloudGuard Pro SQLite Persistent Storage v2.6
// Uses sql.js — pure JavaScript SQLite, zero native compilation.
// Works on Node.js v16–v25+, Windows/macOS/Linux with NO build tools needed.
'use strict';

const path = require('path');
const fs   = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'cloudguard.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// ── DB singleton (initialised asynchronously once on startup) ─────────────────
let db         = null;
let dbReady    = false;
let initPromise = null;

async function initDb() {
  if (dbReady) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS scan_results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id     TEXT    NOT NULL,
        region         TEXT    NOT NULL DEFAULT 'us-east-1',
        scan_type      TEXT    NOT NULL,
        result_json    TEXT    NOT NULL,
        issues_count   INTEGER DEFAULT 0,
        critical_count INTEGER DEFAULT 0,
        security_score INTEGER DEFAULT 100,
        monthly_cost   REAL    DEFAULT 0,
        scanned_at     TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS fix_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        fix_id     TEXT NOT NULL,
        resource   TEXT NOT NULL,
        status     TEXT NOT NULL,
        details    TEXT,
        applied_by TEXT DEFAULT 'user',
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS absence_plans (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL,
        account_id    TEXT DEFAULT 'demo',
        total_days    INTEGER NOT NULL,
        start_date    TEXT NOT NULL,
        auto_stop_day INTEGER DEFAULT 5,
        keep_running  TEXT DEFAULT '[]',
        plan_json     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        notify_email  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS cost_snapshots (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id        TEXT NOT NULL,
        snapshot_date     TEXT NOT NULL,
        current_cost      REAL DEFAULT 0,
        forecasted_cost   REAL DEFAULT 0,
        percent_change    REAL DEFAULT 0,
        service_breakdown TEXT DEFAULT '[]',
        monthly_trend     TEXT DEFAULT '[]',
        anomalies         TEXT DEFAULT '[]',
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, snapshot_date)
      );
      CREATE TABLE IF NOT EXISTS email_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email_type TEXT NOT NULL,
        recipient  TEXT NOT NULL,
        subject    TEXT,
        status     TEXT NOT NULL DEFAULT 'sent',
        provider   TEXT,
        error_msg  TEXT,
        account_id TEXT,
        sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS security_issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id  TEXT NOT NULL,
        resource    TEXT NOT NULL,
        service     TEXT NOT NULL,
        issue       TEXT NOT NULL,
        severity    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        fix_id      TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scan_account ON scan_results(account_id, scanned_at);
      CREATE INDEX IF NOT EXISTS idx_fix_account  ON fix_history(account_id, applied_at);
      CREATE INDEX IF NOT EXISTS idx_absence_user ON absence_plans(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_cost_account ON cost_snapshots(account_id, snapshot_date);
      CREATE INDEX IF NOT EXISTS idx_issues_acct  ON security_issues(account_id, severity, status);
      CREATE INDEX IF NOT EXISTS idx_email_log    ON email_log(sent_at);
    `);

    _persist();
    dbReady = true;
    console.log('[DB] SQLite (sql.js) ready at', DB_PATH);
  })();

  return initPromise;
}

// ── Persist DB to disk ────────────────────────────────────────────────────────
function _persist() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch (e) { console.warn('[DB] persist error:', e.message); }
}

// ── Low-level query helpers ───────────────────────────────────────────────────
function run(sql, params) {
  if (!db) return;
  try { db.run(sql, params); _persist(); }
  catch (e) { console.warn('[DB] run:', e.message, '|', sql.slice(0, 80)); }
}

function all(sql, params) {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    const rows = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.warn('[DB] all:', e.message, '|', sql.slice(0, 80));
    return [];
  }
}

function get(sql, params) { return all(sql, params)[0] || null; }

// ── Scan results ──────────────────────────────────────────────────────────────
function saveScan({ accountId, region, scanType, result, issuesCount, criticalCount, securityScore, monthlyCost }) {
  run(
    `INSERT INTO scan_results (account_id,region,scan_type,result_json,issues_count,critical_count,security_score,monthly_cost)
     VALUES (?,?,?,?,?,?,?,?)`,
    [accountId, region||'us-east-1', scanType, JSON.stringify(result),
     issuesCount||0, criticalCount||0, securityScore||100, monthlyCost||0]
  );
}

function getLatestScan(accountId, scanType) {
  const row = get(
    `SELECT * FROM scan_results WHERE account_id=? AND scan_type=? ORDER BY scanned_at DESC LIMIT 1`,
    [accountId, scanType]
  );
  if (!row) return null;
  try { row.result = JSON.parse(row.result_json); } catch { row.result = null; }
  return row;
}

function getScanHistory(accountId, limit=20) {
  return all(
    `SELECT id,account_id,scan_type,issues_count,critical_count,security_score,monthly_cost,scanned_at
     FROM scan_results WHERE account_id=? ORDER BY scanned_at DESC LIMIT ?`,
    [accountId, limit]
  );
}

// ── Fix history ───────────────────────────────────────────────────────────────
function saveFix({ accountId, fixId, resource, status, details, appliedBy }) {
  run(
    `INSERT INTO fix_history (account_id,fix_id,resource,status,details,applied_by) VALUES (?,?,?,?,?,?)`,
    [accountId, fixId, resource, status, details||'', appliedBy||'user']
  );
}

function getFixHistory(accountId, limit=50) {
  return all(`SELECT * FROM fix_history WHERE account_id=? ORDER BY applied_at DESC LIMIT ?`, [accountId, limit]);
}

function getFixStats(accountId) {
  const rows = all(`SELECT status, COUNT(*) as count FROM fix_history WHERE account_id=? GROUP BY status`, [accountId]);
  return Object.fromEntries(rows.map(r => [r.status, r.count]));
}

// ── Absence plans ─────────────────────────────────────────────────────────────
function saveAbsencePlan({ userId, accountId, plan, notifyEmail }) {
  run(
    `INSERT INTO absence_plans (user_id,account_id,total_days,start_date,auto_stop_day,keep_running,plan_json,notify_email)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, accountId||'demo', plan.totalDays, plan.startDate,
     plan.autoStopDay||5, JSON.stringify(plan.keepRunning||[]),
     JSON.stringify(plan), notifyEmail||null]
  );
}

function getAbsencePlans(accountId, limit=20) {
  return all(
    `SELECT * FROM absence_plans WHERE account_id=? ORDER BY created_at DESC LIMIT ?`,
    [accountId, limit]
  ).map(r => {
    try { r.plan = JSON.parse(r.plan_json); } catch { r.plan = null; }
    try { r.keepRunning = JSON.parse(r.keep_running); } catch { r.keepRunning = []; }
    return r;
  });
}

function getActiveAbsencePlan(userId) {
  const row = get(
    `SELECT * FROM absence_plans WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!row) return null;
  try { row.plan = JSON.parse(row.plan_json); } catch { row.plan = null; }
  return row;
}

function completeAbsencePlan(userId) {
  run(`UPDATE absence_plans SET status='completed',updated_at=datetime('now') WHERE user_id=? AND status='active'`, [userId]);
}

// ── Cost snapshots ────────────────────────────────────────────────────────────
function saveCostSnapshot({ accountId, currentCost, forecastedCost, percentChange, serviceBreakdown, monthlyTrend, anomalies }) {
  const today = new Date().toISOString().split('T')[0];
  run(
    `INSERT INTO cost_snapshots (account_id,snapshot_date,current_cost,forecasted_cost,percent_change,service_breakdown,monthly_trend,anomalies)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id,snapshot_date) DO UPDATE SET
       current_cost=excluded.current_cost, forecasted_cost=excluded.forecasted_cost,
       percent_change=excluded.percent_change, service_breakdown=excluded.service_breakdown,
       monthly_trend=excluded.monthly_trend, anomalies=excluded.anomalies, created_at=datetime('now')`,
    [accountId, today, currentCost||0, forecastedCost||0, percentChange||0,
     JSON.stringify(serviceBreakdown||[]), JSON.stringify(monthlyTrend||[]), JSON.stringify(anomalies||[])]
  );
}

function getCostHistory(accountId, limit=30) {
  return all(
    `SELECT * FROM cost_snapshots WHERE account_id=? ORDER BY snapshot_date DESC LIMIT ?`,
    [accountId, limit]
  ).map(r => {
    try { r.serviceBreakdown = JSON.parse(r.service_breakdown); } catch { r.serviceBreakdown = []; }
    try { r.monthlyTrend = JSON.parse(r.monthly_trend); } catch { r.monthlyTrend = []; }
    try { r.anomalies = JSON.parse(r.anomalies); } catch { r.anomalies = []; }
    return r;
  });
}

function getLatestCostSnapshot(accountId) {
  const row = get(`SELECT * FROM cost_snapshots WHERE account_id=? ORDER BY snapshot_date DESC LIMIT 1`, [accountId]);
  if (!row) return null;
  try { row.serviceBreakdown = JSON.parse(row.service_breakdown); } catch { row.serviceBreakdown = []; }
  try { row.monthlyTrend = JSON.parse(row.monthly_trend); } catch { row.monthlyTrend = []; }
  try { row.anomalies = JSON.parse(row.anomalies); } catch { row.anomalies = []; }
  return row;
}

// ── Email log ─────────────────────────────────────────────────────────────────
function logEmail({ emailType, recipient, subject, status, provider, errorMsg, accountId }) {
  try {
    run(
      `INSERT INTO email_log (email_type,recipient,subject,status,provider,error_msg,account_id) VALUES (?,?,?,?,?,?,?)`,
      [emailType, Array.isArray(recipient) ? recipient.join(', ') : recipient,
       subject||'', status||'sent', provider||'', errorMsg||null, accountId||null]
    );
  } catch (e) { console.warn('[DB] logEmail:', e.message); }
}

function getEmailLog(limit=100) {
  return all(`SELECT * FROM email_log ORDER BY sent_at DESC LIMIT ?`, [limit]);
}

// ── Security issues ───────────────────────────────────────────────────────────
function saveSecurityIssues(accountId, issues) {
  run(`DELETE FROM security_issues WHERE account_id=? AND status='open'`, [accountId]);
  for (const i of issues) {
    run(
      `INSERT INTO security_issues (account_id,resource,service,issue,severity,fix_id) VALUES (?,?,?,?,?,?)`,
      [accountId, i.resource||'unknown', i.service||'unknown',
       i.issue||(Array.isArray(i.issues) ? i.issues.join(', ') : 'unknown'),
       i.severity||'medium', i.fixId||null]
    );
  }
}

function getOpenIssues(accountId) {
  return all(
    `SELECT * FROM security_issues WHERE account_id=? AND status='open'
     ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END LIMIT 100`,
    [accountId]
  );
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
function getDashboardStats(accountId) {
  return {
    latestScan:   getLatestScan(accountId, 'full'),
    fixStats:     getFixStats(accountId),
    costSnapshot: getLatestCostSnapshot(accountId),
    recentFixes:  getFixHistory(accountId, 5),
    scanHistory:  getScanHistory(accountId, 7),
    emailHistory: getEmailLog(10),
    absencePlans: getAbsencePlans(accountId, 5),
  };
}

module.exports = {
  initDb,
  saveScan, getLatestScan, getScanHistory,
  saveFix, getFixHistory, getFixStats,
  saveAbsencePlan, getAbsencePlans, getActiveAbsencePlan, completeAbsencePlan,
  saveCostSnapshot, getCostHistory, getLatestCostSnapshot,
  logEmail, getEmailLog,
  saveSecurityIssues, getOpenIssues,
  getDashboardStats,
};
