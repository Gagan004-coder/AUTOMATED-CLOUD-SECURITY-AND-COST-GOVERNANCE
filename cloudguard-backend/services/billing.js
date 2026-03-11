/**
 * billing.js — AI-Enhanced Cloud Cost Management Service
 * Implements: Automated Cost Reports, Anomaly Detection, Forecasting, Trend Analysis
 * Based on: "AI-Enabled Cloud Cost Management Platforms" (Jakku, 2024)
 */

const { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } = require('@aws-sdk/client-cost-explorer');

let costClient = null;

function getClient(credentials) {
  if (credentials) {
    return new CostExplorerClient({
      region: 'us-east-1',
      credentials: {
        accessKeyId:     credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken:    credentials.sessionToken,
      },
    });
  }
  if (!costClient) costClient = new CostExplorerClient({ region: 'us-east-1' });
  return costClient;
}

function fmtDate(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(1); return d; }

// ─── Cost Retrieval ──────────────────────────────────────────────────────────

async function getDailyCosts(credentials, days = 30) {
  const client = getClient(credentials);
  try {
    const data = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: fmtDate(daysAgo(days)), End: fmtDate(new Date()) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
    }));
    return (data.ResultsByTime || []).map(r => ({
      date: r.TimePeriod.Start,
      cost: parseFloat(r.Total?.UnblendedCost?.Amount || 0),
    }));
  } catch (err) {
    console.warn('[billing] getDailyCosts fallback to mock:', err.message);
    return getMockDailyCosts(days);
  }
}

async function getMonthlyTrend(credentials, months = 6) {
  const client = getClient(credentials);
  try {
    const data = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: fmtDate(monthsAgo(months)), End: fmtDate(new Date()) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    }));
    return (data.ResultsByTime || []).map(r => {
      const d = new Date(r.TimePeriod.Start);
      return {
        month: d.toLocaleString('default', { month: 'short' }),
        year:  d.getFullYear(),
        cost:  parseFloat(r.Total?.UnblendedCost?.Amount || 0),
      };
    });
  } catch (err) {
    console.warn('[billing] getMonthlyTrend fallback to mock:', err.message);
    return getMockMonthlyTrend(months);
  }
}

async function getServiceBreakdown(credentials) {
  const client = getClient(credentials);
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  try {
    const data = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: fmtDate(start), End: fmtDate(now) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }));
    const results = data.ResultsByTime?.[0]?.Groups || [];
    return results
      .map(g => ({ service: g.Keys[0], cost: parseFloat(g.Metrics.UnblendedCost.Amount || 0) }))
      .filter(s => s.cost > 0.01)
      .sort((a, b) => b.cost - a.cost);
  } catch (err) {
    console.warn('[billing] getServiceBreakdown fallback to mock:', err.message);
    return getMockServiceBreakdown();
  }
}

async function getForecast(credentials) {
  const client = getClient(credentials);
  const now  = new Date();
  const eom  = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  if (start >= eom) return null;
  try {
    const data = await client.send(new GetCostForecastCommand({
      TimePeriod: { Start: fmtDate(start), End: fmtDate(eom) },
      Metric: 'UNBLENDED_COST',
      Granularity: 'MONTHLY',
    }));
    return parseFloat(data.Total?.Amount || 0);
  } catch (err) {
    console.warn('[billing] getForecast fallback:', err.message);
    return null;
  }
}

// ─── AI Anomaly Detection ─────────────────────────────────────────────────────
// Rolling Z-score model per Section 3.2 of the paper.

function detectAnomalies(dailyCosts) {
  if (!dailyCosts || dailyCosts.length < 7) return [];
  const values   = dailyCosts.map(d => d.cost);
  const window   = 7;
  const anomalies = [];

  for (let i = window; i < values.length; i++) {
    const slice  = values.slice(i - window, i);
    const mean   = slice.reduce((a, b) => a + b, 0) / window;
    const std    = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / window);
    const val    = values[i];
    const zScore = std > 0 ? (val - mean) / std : 0;

    if (Math.abs(zScore) > 2.0) {
      anomalies.push({
        date:      dailyCosts[i].date,
        cost:      val,
        baseline:  parseFloat(mean.toFixed(2)),
        deviation: parseFloat(((val - mean) / mean * 100).toFixed(1)),
        zScore:    parseFloat(zScore.toFixed(2)),
        severity:  Math.abs(zScore) > 3 ? 'critical' : Math.abs(zScore) > 2.5 ? 'high' : 'medium',
        direction: val > mean ? 'spike' : 'drop',
        message:   val > mean
          ? `$${val.toFixed(2)} is ${((val - mean) / mean * 100).toFixed(0)}% above the 7-day avg of $${mean.toFixed(2)}`
          : `$${val.toFixed(2)} dropped ${((mean - val) / mean * 100).toFixed(0)}% below the 7-day avg`,
      });
    }
  }

  return anomalies.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ─── AI Cost Forecasting ──────────────────────────────────────────────────────
// Linear regression trend model per Section 6.3 (simplified ARIMA-like approach).

function buildForecast(monthlyTrend) {
  if (!monthlyTrend || monthlyTrend.length < 3) return null;

  const n     = monthlyTrend.length;
  const costs = monthlyTrend.map(m => m.cost);
  const xMean = (n - 1) / 2;
  const yMean = costs.reduce((a, b) => a + b, 0) / n;
  const num   = costs.reduce((s, y, i) => s + (i - xMean) * (y - yMean), 0);
  const den   = costs.reduce((s, _, i) => s + Math.pow(i - xMean, 2), 0);
  const slope     = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  const ssRes = costs.reduce((s, y, i) => s + Math.pow(y - (intercept + slope * i), 2), 0);
  const ssTot = costs.reduce((s, y) => s + Math.pow(y - yMean, 2), 0);
  const r2    = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const forecasts = Array.from({ length: 3 }, (_, i) => {
    const projected = intercept + slope * (n + i);
    const d = new Date();
    d.setMonth(d.getMonth() + i + 1);
    return {
      month:     d.toLocaleString('default', { month: 'short', year: 'numeric' }),
      projected: Math.max(0, parseFloat(projected.toFixed(2))),
      lower:     Math.max(0, parseFloat((projected * 0.85).toFixed(2))),
      upper:     parseFloat((projected * 1.15).toFixed(2)),
    };
  });

  return {
    trend:      slope > 0.5 ? 'increasing' : slope < -0.5 ? 'decreasing' : 'stable',
    trendPct:   parseFloat(((slope / Math.max(1, yMean)) * 100).toFixed(1)),
    confidence: parseFloat((r2 * 100).toFixed(0)),
    forecasts,
    avgMonthly: parseFloat(yMean.toFixed(2)),
  };
}

// ─── Master Cost Summary ──────────────────────────────────────────────────────

async function getCostSummary(credentials) {
  const [monthly, services, daily] = await Promise.all([
    getMonthlyTrend(credentials, 6),
    getServiceBreakdown(credentials),
    getDailyCosts(credentials, 30),
  ]);

  const current  = monthly.at(-1)?.cost ?? 0;
  const previous = monthly.at(-2)?.cost ?? 0;
  const pctChange = previous > 0
    ? parseFloat(((current - previous) / previous * 100).toFixed(1))
    : 0;

  let forecastedCost = await getForecast(credentials);
  const forecastModel = buildForecast(monthly);
  if (forecastedCost == null && forecastModel) {
    forecastedCost = forecastModel.forecasts[0]?.projected ?? null;
  }

  const anomalies = detectAnomalies(daily);

  return {
    summary: {
      currentMonthCost:  parseFloat(current.toFixed(2)),
      previousMonthCost: parseFloat(previous.toFixed(2)),
      forecastedCost:    forecastedCost != null ? parseFloat(forecastedCost.toFixed(2)) : null,
      percentChange:     pctChange,
    },
    monthlyTrend:     monthly,
    dailyTrend:       daily,
    serviceBreakdown: services,
    anomalies,
    forecastModel,
  };
}

// ─── Optimization Recommendations ────────────────────────────────────────────
// AI-Powered Cost-Saving Strategies per Section 5.1

function buildOptimizationRecommendations(summary, ec2Data) {
  const recs = [];
  const { forecastModel, anomalies, serviceBreakdown } = summary;

  if (forecastModel?.trend === 'increasing' && forecastModel.trendPct > 10) {
    recs.push({
      type:     'forecast-alert',
      priority: 'high',
      title:    'Costs trending up significantly',
      detail:   `Spend growing ${forecastModel.trendPct}% MoM. Next month projected: $${forecastModel.forecasts[0]?.projected}`,
      action:   'Review largest services and right-size instances',
    });
  }

  const highAnomalies = anomalies.filter(a => a.severity === 'critical' || a.severity === 'high');
  if (highAnomalies.length) {
    recs.push({
      type:     'anomaly-alert',
      priority: 'critical',
      title:    `${highAnomalies.length} significant cost anomaly(ies) detected`,
      detail:   `Most recent: ${highAnomalies[0]?.message}`,
      action:   'Investigate resource usage on flagged dates',
    });
  }

  const ec2Cost = serviceBreakdown?.find(s => s.service.includes('EC2'))?.cost;
  if (ec2Cost && ec2Cost > 200 && (ec2Data?.summary?.idleInstances ?? 0) > 0) {
    recs.push({
      type:     'rightsizing',
      priority: 'medium',
      title:    'EC2 rightsizing opportunity',
      detail:   `EC2 at $${ec2Cost.toFixed(0)}/mo with ${ec2Data.summary.idleInstances} idle instance(s)`,
      action:   'Stop idle instances via the Auto-Fix tab',
    });
  }

  const rdsCost = serviceBreakdown?.find(s => s.service.includes('RDS'))?.cost;
  if (rdsCost && rdsCost > 100) {
    recs.push({
      type:     'reserved-instances',
      priority: 'medium',
      title:    'Reserved Instances opportunity for RDS',
      detail:   `RDS running at $${rdsCost.toFixed(0)}/mo — Reserved Instances can save up to 40%`,
      action:   'Purchase Reserved Instances for predictable workloads',
    });
  }

  if (!recs.length) {
    recs.push({
      type:     'all-clear',
      priority: 'low',
      title:    'No major cost issues detected',
      detail:   'Spend is within expected patterns. Continue monitoring.',
      action:   'Review monthly forecast for planning',
    });
  }

  return recs;
}

// ─── Mock Fallback Data ───────────────────────────────────────────────────────

function getMockDailyCosts(days) {
  const base = 18;
  return Array.from({ length: days }, (_, i) => {
    const d = daysAgo(days - 1 - i);
    const spike = (i === 10 || i === 22) ? base * 1.9 : 0;
    return { date: fmtDate(d), cost: parseFloat((base + Math.random() * 6 - 3 + spike).toFixed(2)) };
  });
}

function getMockMonthlyTrend(months) {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Array.from({ length: months }, (_, i) => {
    const d = monthsAgo(months - 1 - i);
    return { month: names[d.getMonth()], year: d.getFullYear(), cost: parseFloat((420 + i * 38 + Math.random() * 50).toFixed(2)) };
  });
}

function getMockServiceBreakdown() {
  return [
    { service: 'Amazon EC2',        cost: 312.40 },
    { service: 'Amazon RDS',        cost: 189.20 },
    { service: 'Amazon S3',         cost:  87.50 },
    { service: 'AWS Lambda',        cost:  43.10 },
    { service: 'Amazon CloudFront', cost:  28.90 },
    { service: 'Amazon Route 53',   cost:   9.60 },
    { service: 'AWS CloudTrail',    cost:   5.30 },
  ];
}

module.exports = {
  getCostSummary,
  getDailyCosts,
  getMonthlyTrend,
  getServiceBreakdown,
  detectAnomalies,
  buildForecast,
  buildOptimizationRecommendations,
};