import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const REFRESH_MS = 60_000;
const TIMELINE_OPTIONS = ["1M", "3M", "YTD", "1Y", "5Y", "ALL"];
const METRIC_PREFERENCE = {
  CPIAUCSL: "Lower is generally better",
  UNRATE: "Lower is generally better",
  PAYEMS: "Higher is generally better",
  GDPC1: "Higher is generally better",
  FEDFUNDS: "Context dependent",
  ICSA: "Lower is generally better",
  SPY: "Higher is generally better",
  "^VIX": "Lower is generally better",
  "DX-Y.NYB": "Context dependent",
  "CL=F": "Lower is generally better",
  "GC=F": "Context dependent",
  "BTC-USD": "Context dependent",
  YIELD_CURVE: "Context dependent",
  GDP_COMPARE: "Higher is generally better",
  INFLATION_COMPARE: "Lower is generally better",
};

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatCompact(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Number(value).toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

function formatSigned(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, digits)}`;
}

function StatusPill({ change }) {
  
  const isUp = change > 0;
  const isDown = change < 0;
  const cls = isUp ? "pill up" : isDown ? "pill down" : "pill flat";
  return <span className={cls}>{formatSigned(change)}</span>;
}

function Card({ title, children, className = "" }) {
  return (
    <section className={`card ${className}`.trim()}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function getMetricPreference(key) {
  return METRIC_PREFERENCE[key] || "Context dependent";
}

function formatDateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function formatDateFromTs(ts) {
  if (typeof ts !== "number" || Number.isNaN(ts)) return "";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function normalizeHistoryRows(history) {
  if (!Array.isArray(history) || !history.length) return [];
  if (typeof history[0] === "number") return [];
  return history
    .map((h) =>
      h && typeof h === "object"
        ? { date: String(h.date).slice(0, 10), value: Number(h.value) }
        : null
    )
    .filter((p) => p && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.date) && Number.isFinite(p.value));
}

function attachTimestamps(points) {
  return points.map((p) => ({
    ...p,
    ts: Date.parse(`${p.date}T12:00:00Z`),
  }));
}

function TrendChart({ title, data, yLabel, onExpand, preference }) {
  const domain = getDynamicDomain(data.map((d) => Number(d.value)));
  return (
    <div className="chart-block">
      <div className="chart-head">
        <div className="sub">{title}</div>
        <button className="ghost-btn" onClick={onExpand} type="button">
          Expand
        </button>
      </div>
      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              stroke="#9cb0cb"
              tick={{ fontSize: 11 }}
              tickFormatter={formatDateFromTs}
              minTickGap={28}
            />
            <YAxis
              domain={domain}
              stroke="#9cb0cb"
              tick={{ fontSize: 11 }}
              width={70}
              tickFormatter={formatCompact}
            />
            <Tooltip formatter={(value) => formatNumber(value)} labelFormatter={formatDateFromTs} />
            <Line type="monotone" dataKey="value" stroke="#6ba8ff" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="sub">{yLabel}</div>
      <div className="metric-hint">{preference}</div>
    </div>
  );
}

function sentimentClass(color) {
  if (color === "green") return "sentiment green";
  if (color === "red") return "sentiment red";
  return "sentiment yellow";
}

function getDynamicDomain(values, paddingRatio = 0.08) {
  const cleaned = values.filter((v) => Number.isFinite(v));
  if (!cleaned.length) return [0, 1];
  const min = Math.min(...cleaned);
  const max = Math.max(...cleaned);
  if (min === max) {
    const delta = Math.abs(min || 1) * paddingRatio;
    return [min - delta, max + delta];
  }
  const span = max - min;
  const pad = span * paddingRatio;
  return [min - pad, max + pad];
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState("1Y");
  const [expandedChart, setExpandedChart] = useState(null);

  useEffect(() => {
    let timer;

    async function load() {
      try {
        const response = await fetch(`${API_BASE}/api/dashboard?_=${Date.now()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`API request failed (${response.status})`);
        }
        const payload = await response.json();
        setData(payload);
        setError("");
      } catch (err) {
        setError(err.message || "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    }

    load();
    timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const economy = useMemo(() => data?.economy || [], [data]);
  const markets = useMemo(() => data?.markets || [], [data]);
  const yields = data?.treasury_yields || {};
  const globalCompare = data?.global_compare || {};
  const headlines = data?.headlines || [];
  const yieldTenors = ["1m", "3m", "6m", "1y", "2y", "5y", "10y", "30y"];
  const yieldCurveData = yieldTenors.map((tenor) => ({ tenor: tenor.toUpperCase(), value: yields[tenor] }));

  function sortPointsByDate(points) {
    return [...points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function filterByTimeline(points) {
    const sorted = sortPointsByDate(points);
    const now = new Date();
    const start = new Date(now);
    if (timeline === "1M") start.setMonth(now.getMonth() - 1);
    if (timeline === "3M") start.setMonth(now.getMonth() - 3);
    if (timeline === "YTD") start.setMonth(0, 1);
    if (timeline === "1Y") start.setFullYear(now.getFullYear() - 1);
    if (timeline === "5Y") start.setFullYear(now.getFullYear() - 5);
    if (timeline === "ALL") return sorted;
    return sorted.filter((p) => {
      const date = new Date(p.date);
      return !Number.isNaN(date.getTime()) && date >= start;
    });
  }

  const macroCharts = economy.slice(0, 4).map((item) => {
    const raw = normalizeHistoryRows(item.history);
    const filtered = filterByTimeline(raw);
    return { key: item.series_id, title: item.label, data: attachTimestamps(filtered) };
  });

  const marketCharts = markets.slice(0, 4).map((item) => {
    const raw = normalizeHistoryRows(item.history);
    const filtered = filterByTimeline(raw);
    return { key: item.symbol, title: item.symbol, data: attachTimestamps(filtered) };
  });

  const gdpBars = (globalCompare.gdp_usd_current || []).map((row) => ({
    country: row.country,
    value: Number(row.latest_value),
  }));

  const inflationBars = (globalCompare.inflation_annual || []).map((row) => ({
    country: row.country,
    value: Number(row.latest_value),
  }));
  const gdpDomain = getDynamicDomain(gdpBars.map((d) => d.value));
  const inflationDomain = getDynamicDomain(inflationBars.map((d) => d.value));
  const yieldDomain = getDynamicDomain(yieldCurveData.map((d) => Number(d.value)));

  const expandedChartData = useMemo(() => {
    if (!expandedChart) return null;
    const allCharts = [...macroCharts, ...marketCharts];
    return allCharts.find((c) => c.key === expandedChart) || null;
  }, [expandedChart, macroCharts, marketCharts]);

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>US Economy Live Monitor</h1>
          <p>
            Real-time-ish pulse of macro + market conditions using free data APIs.
            Refreshes every 60 seconds.
          </p>
          {data?.updated_at && (
            <small>Last update: {new Date(data.updated_at).toLocaleString()}</small>
          )}
        </div>
        <div className="top-sources">
          <strong>Sources</strong>
          <div className="sub">
            {(data?.sources || []).join(" | ")}
          </div>
        </div>
      </header>

      {loading && <p className="state">Loading dashboard...</p>}
      {error && <p className="state error">{error}</p>}

      <section className="layout-columns">
        <div className="layout-col layout-left">
          <Card title="Timeline" className="card-timeline">
            <div className="timeline-controls">
              {TIMELINE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`timeline-btn ${timeline === opt ? "active" : ""}`}
                  onClick={() => setTimeline(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            <p className="sub">Applies to macro + market trend charts.</p>
          </Card>

          <Card title="Treasury Yield Curve" className="card-yield">
            <div className="yield-grid">
              {["1m", "3m", "6m", "1y", "2y", "5y", "10y", "30y"].map((tenor) => (
                <div key={tenor} className="yield-item">
                  <span>{tenor.toUpperCase()}</span>
                  <strong>{formatNumber(yields[tenor])}%</strong>
                </div>
              ))}
            </div>
            <p className="sub">Date: {yields.record_date || "n/a"}</p>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={yieldCurveData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
                  <XAxis dataKey="tenor" stroke="#9cb0cb" />
                  <YAxis domain={yieldDomain} stroke="#9cb0cb" unit="%" tickFormatter={formatNumber} />
                  <Tooltip formatter={(v) => `${formatNumber(v)}%`} />
                  <Line type="monotone" dataKey="value" stroke="#7ce3b1" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="metric-hint">{getMetricPreference("YIELD_CURVE")}</p>
          </Card>

          <Card title="Global Macro Comparison (US vs Major Economies)" className="card-span-2 card-global">
          <div className="compare-grid">
            <div>
              <div className="sub">Nominal GDP (current USD) - last reported</div>
              <div className="metric-hint">{getMetricPreference("GDP_COMPARE")}</div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={gdpBars} margin={{ top: 8, right: 8, left: 8, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
                    <XAxis
                      dataKey="country"
                      stroke="#9cb0cb"
                      tick={{ fontSize: 11 }}
                      angle={-15}
                      textAnchor="end"
                      interval={0}
                      height={52}
                    />
                    <YAxis
                      domain={gdpDomain}
                      stroke="#9cb0cb"
                      tickFormatter={(v) => `${(v / 1e12).toFixed(1)}T`}
                      width={64}
                    />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#6ba8ff" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <div className="sub">Inflation rate (% annual) - last reported</div>
              <div className="metric-hint">{getMetricPreference("INFLATION_COMPARE")}</div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={inflationBars} margin={{ top: 8, right: 8, left: 8, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
                    <XAxis
                      dataKey="country"
                      stroke="#9cb0cb"
                      tick={{ fontSize: 11 }}
                      angle={-15}
                      textAnchor="end"
                      interval={0}
                      height={52}
                    />
                    <YAxis domain={inflationDomain} stroke="#9cb0cb" unit="%" width={50} tickFormatter={formatNumber} />
                    <Tooltip formatter={(v) => `${formatNumber(v)}%`} />
                    <Bar dataKey="value" fill="#f0a84b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          </Card>

        </div>

        <div className="layout-col layout-main">
          <Card title="Macro Indicators (FRED)" className="card-span-2 card-macro">
          <div className="rows">
            {economy.map((item) => (
              <div key={item.series_id} className="row">
                <div>
                  <strong>{item.label}</strong>
                  <div className="sub">{item.latest_date || item.error}</div>
                  <div className="metric-hint">{getMetricPreference(item.series_id)}</div>
                </div>
                <div className="right">
                  <div>{formatNumber(item.latest_value)}</div>
                  <StatusPill change={item.change} />
                </div>
              </div>
            ))}
          </div>
          <div className="chart-grid-full">
            {macroCharts.map((chart) => (
              <TrendChart
                key={chart.key}
                title={chart.title}
                data={chart.data}
                yLabel="Value axis (Y) over time (X)"
                preference={getMetricPreference(chart.key)}
                onExpand={() => setExpandedChart(chart.key)}
              />
            ))}
          </div>
          </Card>
        </div>

        <div className="layout-col layout-right">
          <Card title="Market Risk + Pricing" className="card-span-2 card-markets">
            <div className="rows">
              {markets.map((item) => (
                <div key={item.symbol} className="row">
                  <div>
                    <strong>{item.label}</strong>
                    <div className="sub">{item.symbol}</div>
                    <div className="metric-hint">{getMetricPreference(item.symbol)}</div>
                  </div>
                  <div className="right">
                    <div>{formatNumber(item.latest)}</div>
                    <StatusPill change={item.pct_change} />
                  </div>
                </div>
              ))}
            </div>
            <div className="chart-grid-full">
              {marketCharts.map((chart) => (
                <TrendChart
                  key={chart.key}
                  title={`${chart.title} price`}
                  data={chart.data}
                  yLabel="Price axis (Y) over time (X)"
                  preference={getMetricPreference(chart.key)}
                  onExpand={() => setExpandedChart(chart.key)}
                />
              ))}
            </div>
          </Card>
        </div>
      </section>

      <section className="below-section">
        <Card title="Macro Headlines (Rule-Labeled Impact)" className="card-headlines">
          <p className="sub">
            Labels are transparent, rule-based tags from headline text (not opaque AI sentiment).
          </p>
          <div className="rows">
            {headlines.map((h) => (
              <div key={`${h.source}-${h.url}-${h.title}`} className="headline-row">
                <div>
                  <a href={h.url} target="_blank" rel="noreferrer" className="headline-link">
                    {h.title}
                  </a>
                  <div className="sub">
                    {h.source} | {h.published_at || "n/a"}
                  </div>
                </div>
                <div className="headline-tags">
                  <span className={sentimentClass(h.color)}>{h.direction}</span>
                  <span className="tag">{h.impact_area}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {expandedChartData && (
        <div className="modal-backdrop" onClick={() => setExpandedChart(null)} role="presentation">
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <h3>{expandedChartData.title}</h3>
              <button className="ghost-btn" onClick={() => setExpandedChart(null)} type="button">
                Back
              </button>
            </div>
            <div className="modal-chart">
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={expandedChartData.data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    stroke="#9cb0cb"
                    tickFormatter={formatDateFromTs}
                    minTickGap={34}
                  />
                  <YAxis
                    domain={getDynamicDomain(expandedChartData.data.map((d) => Number(d.value)))}
                    stroke="#9cb0cb"
                    tickFormatter={formatCompact}
                    width={80}
                  />
                  <Tooltip formatter={(v) => formatNumber(v)} labelFormatter={formatDateFromTs} />
                  <Line type="monotone" dataKey="value" stroke="#6ba8ff" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
