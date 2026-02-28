// ─────────────────────────────────────────────────────────────────────────────
// services/billing.js
// ─────────────────────────────────────────────────────────────────────────────
const {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  GetDimensionValuesCommand
} = require('@aws-sdk/client-cost-explorer');

// Cost Explorer is always us-east-1
function makeClient(creds) {
  return new CostExplorerClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId:     creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken:    creds.sessionToken
    }
  });
}

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(1);
  return d;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function getAll(creds) {
  const client = makeClient(creds);

  const today    = new Date();
  const start6m  = dateStr(monthsAgo(6));
  const today_s  = dateStr(today);

  // Month-by-month totals
  const [monthly, byService, forecast] = await Promise.allSettled([

    // 6-month daily grouped by month
    client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start6m, End: today_s },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost']
    })),

    // Current month breakdown by service
    client.send(new GetCostAndUsageCommand({
      TimePeriod: {
        Start: dateStr(new Date(today.getFullYear(), today.getMonth(), 1)),
        End: today_s
      },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
    })),

    // 30-day cost forecast
    client.send(new GetCostForecastCommand({
      TimePeriod: {
        Start: today_s,
        End: dateStr(new Date(today.getFullYear(), today.getMonth() + 1, 1))
      },
      Metric: 'UNBLENDED_COST',
      Granularity: 'MONTHLY'
    }))
  ]);

  // Process monthly trend
  const monthlyTrend = monthly.status === 'fulfilled'
    ? (monthly.value.ResultsByTime || []).map(r => ({
        period: r.TimePeriod.Start,
        month:  new Date(r.TimePeriod.Start).toLocaleString('default', { month: 'short' }),
        cost:   +parseFloat(r.Total?.UnblendedCost?.Amount || 0).toFixed(2),
        unit:   r.Total?.UnblendedCost?.Unit || 'USD'
      }))
    : [];

  // Process service breakdown
  const serviceBreakdown = byService.status === 'fulfilled'
    ? (byService.value.ResultsByTime?.[0]?.Groups || [])
        .map(g => ({
          service: g.Keys[0],
          cost:    +parseFloat(g.Metrics?.UnblendedCost?.Amount || 0).toFixed(2)
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 15)
    : [];

  // Current month spend
  const currentMonthCost = monthlyTrend.length > 0
    ? monthlyTrend[monthlyTrend.length - 1].cost
    : 0;

  // Forecast
  const forecastedCost = forecast.status === 'fulfilled'
    ? +parseFloat(forecast.value.Total?.Amount || 0).toFixed(2)
    : null;

  // Previous month for comparison
  const prevMonthCost = monthlyTrend.length >= 2
    ? monthlyTrend[monthlyTrend.length - 2].cost
    : null;

  const change = prevMonthCost
    ? +(((currentMonthCost - prevMonthCost) / prevMonthCost) * 100).toFixed(1)
    : null;

  return {
    summary: {
      currentMonthCost,
      forecastedCost,
      previousMonthCost: prevMonthCost,
      percentChange: change,
      currency: 'USD'
    },
    monthlyTrend,
    serviceBreakdown,
    topService: serviceBreakdown[0] || null
  };
}

module.exports = { getAll };
