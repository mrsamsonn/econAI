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

/**
 * When unset in dev, use same-origin `/api/...` so Vite can proxy to the backend (see vite.config.js).
 * `./run.sh` sets VITE_API_BASE to the real backend port — then we call that URL directly.
 * Production builds without env fall back to localhost:8000 unless you set VITE_API_BASE at build time.
 */
const _viteApi = import.meta.env.VITE_API_BASE;
const API_BASE =
  typeof _viteApi === "string" && _viteApi.trim() !== ""
    ? _viteApi.trim().replace(/\/$/, "")
    : import.meta.env.DEV
      ? ""
      : "http://127.0.0.1:8000";
const STATUS_TICK_MS = 1_000;
/** One dashboard pull hits many upstream URLs (FRED CSV, Yahoo, RSS). Keep a safe floor. */
const MIN_DATA_REFRESH_MS = 60_000;
const MAX_DATA_REFRESH_MS = 300_000;
const _refreshParsed = Number(import.meta.env.VITE_DATA_REFRESH_MS);
const DATA_REFRESH_MS =
  Number.isFinite(_refreshParsed) && _refreshParsed > 0
    ? Math.min(MAX_DATA_REFRESH_MS, Math.max(MIN_DATA_REFRESH_MS, _refreshParsed))
    : MIN_DATA_REFRESH_MS;
const EMPTY_HEADLINES = [];
const TIMELINE_OPTIONS = ["1M", "3M", "YTD", "1Y", "5Y", "ALL"];

/** Recharts defaults use a white tooltip — unreadable on our dark UI. */
const CHART_TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: "#141c2b",
    border: "1px solid #2f4058",
    borderRadius: 8,
    boxShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
  },
  labelStyle: {
    color: "#eef4ff",
    fontWeight: 600,
    fontSize: 12,
    marginBottom: 4,
  },
  itemStyle: {
    color: "#c5d4ea",
    fontSize: 12,
  },
};

const CHART_LINE_TOOLTIP_CURSOR = { stroke: "#5a7ab0", strokeWidth: 1, strokeDasharray: "4 4" };
const CHART_BAR_TOOLTIP_CURSOR = { fill: "rgba(107, 168, 255, 0.14)" };
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
  MORTGAGE30US: "Lower is often better for housing affordability (context: growth vs inflation)",
  TERMCBAUTO48NS: "Lower is often better for auto affordability",
  MPRIME: "Context dependent (policy vs credit conditions)",
  TB3MS: "Context dependent (policy expectations vs growth fears)",
  FYFSGDA188S: "Higher surplus / smaller deficit as % of GDP is often viewed as tighter fiscal stance",
  GFDEGDQ188S: "Lower debt-to-GDP is generally preferable long-run",
  FYFRGDA188S: "Context dependent (revenue strength vs tax policy)",
  UMCSENT: "Higher is generally better (consumer confidence)",
  RSXFS: "Higher is generally better (nominal retail demand)",
  HOUST: "Higher is generally better (residential construction)",
};

/** Short hover explanations (native `title` tooltips). */
const METRIC_GLOSSARY = {
  CPIAUCSL:
    "Consumer Price Index for All Urban Consumers (seasonally adjusted). Tracks average price changes for a broad basket of consumer goods and services — the main headline CPI inflation gauge.",
  UNRATE:
    "Civilian unemployment rate — percent of the labor force that is unemployed and actively seeking work. A key labor-market tightness indicator.",
  PAYEMS:
    "Total nonfarm payroll employment — estimated number of jobs in the economy excluding farms, private households, and a few small sectors. A top monthly jobs reading.",
  GDPC1:
    "Real Gross Domestic Product (chain-weighted, quarterly, seasonally adjusted annual rate). Inflation-adjusted size of the economy — the core growth yardstick.",
  FEDFUNDS:
    "Effective Federal Funds rate — overnight interbank lending rate the FOMC targets. Higher often reflects tighter policy; level must be read with growth and inflation.",
  ICSA:
    "Initial jobless claims — weekly count of new unemployment insurance filings. Spikes often align with layoffs or shocks (can be noisy week-to-week).",
  SPY:
    "SPDR S&P 500 ETF — tracks the S&P 500 large-cap U.S. equity index. A liquid proxy for broad U.S. stock market price levels.",
  "^VIX":
    "CBOE Volatility Index — market-implied volatility on S&P 500 options over the next ~30 days. Often called the “fear gauge”; higher usually means more expected swings.",
  "DX-Y.NYB":
    "U.S. Dollar Index (ICE futures proxy on Yahoo). Measures the USD vs a basket of major currencies; strength affects trade, earnings, and global funding conditions.",
  "CL=F":
    "WTI crude oil front-month futures — global growth and energy-cost barometer; large moves spill into inflation and consumer spending.",
  "GC=F":
    "Gold front-month futures — traditional safe-haven and real-rate sensitive asset; moves with risk appetite, the dollar, and opportunity cost of holding cash/bonds.",
  "BTC-USD":
    "Bitcoin in U.S. dollars — high-volatility risk asset; sometimes viewed as a liquidity / sentiment tell, not a macro fundamental like payrolls or GDP.",
  YIELD_1M: "1-month Treasury yield — very short end; tracks near-term cash rates and policy expectations.",
  YIELD_3M: "3-month Treasury yield — T-bill sector; sensitive to Fed path and money-market conditions.",
  YIELD_6M: "6-month Treasury yield — short/intermediate funding rates.",
  YIELD_1Y: "1-year Treasury yield — bridges money markets and the belly of the curve.",
  YIELD_2Y: "2-year Treasury yield — highly sensitive to expected Fed policy over the next couple of years.",
  YIELD_5Y: "5-year Treasury yield — mid-curve; mixes growth, inflation, and rate expectations.",
  YIELD_10Y: "10-year Treasury yield — benchmark long rate for mortgages, credit spreads, and discounting cash flows.",
  YIELD_30Y: "30-year Treasury yield — long bond; term premium and long-horizon growth/inflation expectations.",
  MORTGAGE30US:
    "Freddie Mac Primary Mortgage Market Survey — average 30-year fixed mortgage rate. A key housing affordability and credit-conditions input.",
  TERMCBAUTO48NS:
    "Finance company new-car loan rate (48-month). A read on consumer credit pricing for autos.",
  MPRIME:
    "Bank prime loan rate — reference for many consumer and business floating-rate loans; moves with Fed policy and credit spreads.",
  TB3MS:
    "3-month Treasury bill secondary market rate — a pure short government borrowing rate; tracks near-term policy and cash yields.",
  FYFSGDA188S:
    "Federal surplus (+) or deficit (−) as a percent of GDP (annual NIPA). A high-level fiscal stance snapshot.",
  GFDEGDQ188S:
    "Federal debt held by the public as a percent of GDP — stock measure of leverage vs the size of the economy.",
  FYFRGDA188S:
    "Federal current receipts as a percent of GDP — how much of the economy the federal government collects in taxes/fees.",
  UMCSENT:
    "University of Michigan consumer sentiment index — survey-based read on household expectations for finances and the economy.",
  RSXFS:
    "Advance retail sales excluding motor vehicles & parts and food services — monthly nominal demand pulse.",
  HOUST:
    "New privately owned housing starts, seasonally adjusted annual rate — residential construction cycle indicator.",
};

const YIELD_TENOR_GLOSSARY_KEY = {
  "1m": "YIELD_1M",
  "3m": "YIELD_3M",
  "6m": "YIELD_6M",
  "1y": "YIELD_1Y",
  "2y": "YIELD_2Y",
  "5y": "YIELD_5Y",
  "10y": "YIELD_10Y",
  "30y": "YIELD_30Y",
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

function TimelineStrip({ value, onChange }) {
  return (
    <div
      className="timeline-strip"
      role="toolbar"
      aria-label="History window for macro and market trend charts"
    >
      <span className="timeline-strip-label">Timeline</span>
      <div className="timeline-strip-pills">
        {TIMELINE_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`timeline-btn ${value === opt ? "active" : ""}`}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Lightweight placeholder layout (CSS opacity pulse only — no charts or timers). */
function DashboardSkeleton() {
  return (
    <div
      className="dashboard-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      <section className="skeleton-pulse-card" aria-hidden>
        <div className="skeleton-pulse-row">
          <div className="sk sk-pulse-score" />
          <div className="skeleton-pulse-text">
            <div className="sk sk-line sk-line-wide" />
            <div className="sk sk-line sk-line-narrow" />
          </div>
        </div>
        <div className="skeleton-bar-outer" aria-hidden>
          <div className="sk sk-pulse-barfill" />
        </div>
      </section>

      <section className="layout-columns">
        <div className="layout-col layout-left">
          <section className="card card-yield">
            <div className="sk sk-card-title sk-w-medium" />
            <div className="skeleton-yield-grid">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <div key={i} className="sk sk-yield-cell" />
              ))}
            </div>
            <div className="sk sk-chart-block" />
          </section>

          <section className="card card-span-2 card-global">
            <div className="sk sk-card-title sk-w-short" />
            <div className="skeleton-compare">
              <div className="sk sk-chart-block sk-chart-short" />
              <div className="sk sk-chart-block sk-chart-short" />
            </div>
          </section>
        </div>

        <div className="layout-col layout-main">
          <section className="card card-span-2 card-macro">
            <div className="sk sk-card-title" />
            <div className="skeleton-rows">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton-feed-row">
                  <div className="skeleton-feed-left">
                    <div className="sk sk-line sk-line-feed-title" />
                    <div className="sk sk-line sk-line-feed-meta" />
                  </div>
                  <div className="sk sk-line sk-line-feed-value" />
                </div>
              ))}
            </div>
            <div className="chart-grid-full skeleton-chart-grid">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="sk sk-chart-tile" />
              ))}
            </div>
          </section>
        </div>

        <div className="layout-col layout-right">
          <section className="card card-span-2 card-markets">
            <div className="sk sk-card-title sk-w-medium" />
            <div className="skeleton-rows">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton-feed-row">
                  <div className="skeleton-feed-left">
                    <div className="sk sk-line sk-line-feed-title" />
                    <div className="sk sk-line sk-line-feed-meta" />
                  </div>
                  <div className="sk sk-line sk-line-feed-value" />
                </div>
              ))}
            </div>
            <div className="chart-grid-full skeleton-chart-grid">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="sk sk-chart-tile" />
              ))}
            </div>
          </section>
        </div>
      </section>

      <section className="extra-metrics-row extra-metrics-row--skeleton" aria-hidden>
        {[1, 2, 3].map((col) => (
          <div key={col} className="card card-extra">
            <div className="sk sk-card-title sk-w-medium" />
            <div className="sk sk-line sk-line-sub" />
            {[1, 2, 3, 4].map((row) => (
              <div key={row} className="skeleton-feed-row">
                <div className="skeleton-feed-left">
                  <div className="sk sk-line sk-line-feed-title" />
                  <div className="sk sk-line sk-line-feed-meta" />
                </div>
                <div className="sk sk-line sk-line-feed-value" />
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="below-section">
        <section className="card card-headlines">
          <div className="sk sk-card-title sk-w-long" />
          <div className="sk sk-line sk-line-sub" />
          <div className="skeleton-headlines-columns">
            {[1, 2, 3].map((col) => (
              <div key={col} className="skeleton-headlines-col">
                <div className="sk sk-headlines-col-title" />
                {[1, 2, 3].map((row) => (
                  <div key={row} className="skeleton-headline-block">
                    <div className="sk sk-line sk-line-headline-a" />
                    <div className="sk sk-line sk-line-headline-b" />
                    <div className="sk sk-tag sk-tag-wide sk-headline-block-tag" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function getMetricPreference(key) {
  return METRIC_PREFERENCE[key] || "Context dependent";
}

function glossaryTip(key) {
  if (!key) return undefined;
  return METRIC_GLOSSARY[key] || undefined;
}

function tipForPulseDriverLine(name) {
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? glossaryTip(m[1].trim()) : undefined;
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

function buildTimeTicksFromData(points, maxTicks = 5) {
  const ts = points
    .map((p) => Number(p.ts))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!ts.length) return [];
  if (ts.length <= maxTicks) return ts;
  const ticks = [];
  const step = (ts.length - 1) / (maxTicks - 1);
  for (let i = 0; i < maxTicks; i += 1) {
    ticks.push(ts[Math.round(i * step)]);
  }
  return Array.from(new Set(ticks));
}

function pickMiniSeriesForTimeline(points, timeline) {
  const sorted = [...points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!sorted.length) return [];
  if (timeline === "ALL") return sorted;

  const now = new Date();
  const start = new Date(now);
  if (timeline === "1M") start.setMonth(now.getMonth() - 1);
  if (timeline === "3M") start.setMonth(now.getMonth() - 3);
  if (timeline === "YTD") start.setMonth(0, 1);
  if (timeline === "1Y") start.setFullYear(now.getFullYear() - 1);
  if (timeline === "5Y") start.setFullYear(now.getFullYear() - 5);

  const filtered = sorted.filter((p) => {
    const date = new Date(p.date);
    return !Number.isNaN(date.getTime()) && date >= start;
  });
  // Sparse annual/quarterly series can have 0-1 points in short windows.
  if (filtered.length >= 2) return filtered;
  const fallbackCountByTimeline = {
    "1M": 2,
    "3M": 2,
    YTD: 2,
    "1Y": 2,
    "5Y": 6,
  };
  const n = fallbackCountByTimeline[timeline] ?? 2;
  return sorted.slice(-Math.min(n, sorted.length));
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

function TrendChart({ title, data, yLabel, onExpand, preference, glossaryKey }) {
  const domain = getDynamicDomain(data.map((d) => Number(d.value)));
  const tip = glossaryTip(glossaryKey);
  return (
    <div className="chart-block">
      <div className="chart-head">
        <div className={tip ? "sub metric-tip" : "sub"} title={tip || undefined}>
          {title}
        </div>
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
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              cursor={CHART_LINE_TOOLTIP_CURSOR}
              formatter={(value) => formatNumber(value)}
              labelFormatter={formatDateFromTs}
            />
            <Line type="monotone" dataKey="value" stroke="#6ba8ff" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="sub">{yLabel}</div>
      <div className="metric-hint">{preference}</div>
    </div>
  );
}

function MiniMetricTrend({
  title,
  data,
  valueFormatter = formatNumber,
  unit = "",
  betterWhen = "Context dependent",
  readingNote = "Trend line shows raw level over the selected timeline.",
}) {
  const domain = getDynamicDomain(data.map((d) => Number(d.value)));
  const xTicks = useMemo(() => buildTimeTicksFromData(data, 5), [data]);
  const isLongRange = useMemo(() => {
    if (!data.length) return false;
    const minTs = Math.min(...data.map((d) => Number(d.ts)).filter((v) => Number.isFinite(v)));
    const maxTs = Math.max(...data.map((d) => Number(d.ts)).filter((v) => Number.isFinite(v)));
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return false;
    const years = (maxTs - minTs) / (1000 * 60 * 60 * 24 * 365.25);
    return years > 8;
  }, [data]);
  const xTickFormatter = (ts) => {
    if (typeof ts !== "number" || Number.isNaN(ts)) return "";
    if (isLongRange) return new Date(ts).toLocaleDateString(undefined, { year: "numeric", timeZone: "UTC" });
    return formatDateFromTs(ts);
  };
  return (
    <div className="mini-trend-wrap">
      <div className="sub">{title}</div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#223046" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            stroke="#9cb0cb"
            ticks={xTicks}
            tick={{ fontSize: 10 }}
            tickFormatter={xTickFormatter}
            minTickGap={20}
          />
          <YAxis domain={domain} stroke="#9cb0cb" tick={{ fontSize: 10 }} tickFormatter={valueFormatter} width={58} />
          <Tooltip
            {...CHART_TOOLTIP_PROPS}
            cursor={CHART_LINE_TOOLTIP_CURSOR}
            formatter={(v) => `${valueFormatter(v)}${unit}`}
            labelFormatter={formatDateFromTs}
          />
          <Line type="monotone" dataKey="value" stroke="#6ba8ff" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="mini-trend-note">
        <strong>How to read:</strong> {readingNote} <strong>Rule of thumb:</strong> {betterWhen}.
      </div>
    </div>
  );
}

function sentimentClass(color) {
  if (color === "green") return "sentiment green";
  if (color === "red") return "sentiment red";
  return "sentiment yellow";
}

function headlineScoreTip(h) {
  const score = h.impact_score;
  const compound = h.sentiment_compound;
  if (typeof score !== "number" && typeof compound !== "number") return undefined;
  const parts = [];
  if (typeof score === "number") parts.push(`impact score ${score}`);
  if (typeof compound === "number") parts.push(`VADER compound ${compound}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Map API headline to a 3-column impact bucket (backend uses `mixed` for neutral). */
function headlineImpactBucket(h) {
  const d = String(h.direction || "").toLowerCase();
  if (d === "positive") return "positive";
  if (d === "negative") return "negative";
  if (d === "mixed" || d === "neutral") return "neutral";
  const c = String(h.color || "").toLowerCase();
  if (c === "green") return "positive";
  if (c === "red") return "negative";
  return "neutral";
}

function HeadlinesByImpact({ headlines }) {
  const buckets = useMemo(() => {
    const positive = [];
    const neutral = [];
    const negative = [];
    for (const h of headlines) {
      const b = headlineImpactBucket(h);
      if (b === "positive") positive.push(h);
      else if (b === "negative") negative.push(h);
      else neutral.push(h);
    }
    return { positive, neutral, negative };
  }, [headlines]);

  const columns = [
    { id: "positive", title: "Positive impact", tone: "positive", items: buckets.positive },
    { id: "neutral", title: "Neutral / mixed", tone: "neutral", items: buckets.neutral },
    { id: "negative", title: "Negative impact", tone: "negative", items: buckets.negative },
  ];

  return (
    <div className="headlines-by-impact">
      {columns.map((col) => (
        <section key={col.id} className={`headlines-col headlines-col--${col.tone}`} aria-label={col.title}>
          <div className="headlines-col-head">
            <h4 className="headlines-col-heading">{col.title}</h4>
            <span className="headlines-col-count">{col.items.length}</span>
          </div>
          <div className="headlines-col-list">
            {col.items.length === 0 ? (
              <p className="headlines-empty">No headlines in this bucket.</p>
            ) : (
              col.items.map((h) => (
                <article key={`${h.source}-${h.url}-${h.title}`} className="headline-item">
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noreferrer"
                    className="headline-link"
                    title={headlineScoreTip(h)}
                  >
                    {h.title}
                  </a>
                  <div className="sub">
                    {h.source} · {h.published_at || "n/a"}
                  </div>
                  <div className="headline-tags">
                    <span className="tag">{h.impact_area}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function formatSyncAge(msAgo) {
  if (msAgo == null || Number.isNaN(msAgo)) return "";
  if (msAgo < 1500) return "just now";
  const s = Math.floor(msAgo / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Wall-clock in UTC for live display (`Date.now()` is always rendered as UTC via ISO). */
function formatUtcClock(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
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
  const [pulseDriversOpen, setPulseDriversOpen] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), STATUS_TICK_MS);
    return () => clearInterval(id);
  }, []);

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
        setLastSyncAt(Date.now());
      } catch (err) {
        const raw = err?.message || "Failed to load dashboard";
        const isNetwork =
          raw === "Failed to fetch" ||
          raw === "Load failed" ||
          raw.includes("NetworkError") ||
          raw.toLowerCase().includes("fetch");
        const hint = isNetwork
          ? " Start the FastAPI backend (e.g. ./run.sh), or run it on port 8000 if you use npm run dev without VITE_API_BASE."
          : "";
        setError(raw + hint);
      } finally {
        setLoading(false);
      }
    }

    load();
    timer = setInterval(load, DATA_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const clockNow = useMemo(() => Date.now(), [tick, lastSyncAt]);
  const ageMs = lastSyncAt != null ? clockNow - lastSyncAt : null;
  const lastUpdateSuffix = useMemo(() => {
    if (data?.updated_at == null) return "";
    return ` · Last update: ${new Date(data.updated_at).toLocaleString()}`;
  }, [data?.updated_at]);
  const statusTone =
    error && !data
      ? "bad"
      : error
        ? "warn"
        : ageMs == null
          ? "idle"
          : ageMs > DATA_REFRESH_MS * 3
            ? "warn"
            : "ok";

  const economy = useMemo(() => data?.economy || [], [data]);
  const markets = useMemo(() => data?.markets || [], [data]);
  const interestRates = useMemo(() => data?.interest_rates || [], [data]);
  const taxMetrics = useMemo(() => data?.tax_metrics || [], [data]);
  const activityMetrics = useMemo(() => data?.activity_metrics || [], [data]);
  const yields = data?.treasury_yields || {};
  const globalCompare = data?.global_compare || {};
  const headlines = data?.headlines ?? EMPTY_HEADLINES;
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

  const extraCharts = useMemo(() => {
    const pick = (rows, seriesId, title) => {
      const row = rows.find((r) => r.series_id === seriesId);
      if (!row) return null;
      const filtered = pickMiniSeriesForTimeline(normalizeHistoryRows(row.history), timeline);
      const dataPts = attachTimestamps(filtered);
      if (!dataPts.length) return null;
      return { key: seriesId, title, data: dataPts };
    };
    return {
      interest: pick(interestRates, "MORTGAGE30US", "30Y mortgage trend"),
      tax: pick(taxMetrics, "FYFSGDA188S", "Federal balance (% GDP) trend"),
      activity: pick(activityMetrics, "HOUST", "Housing starts trend"),
    };
  }, [interestRates, taxMetrics, activityMetrics, timeline]);

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
    const allCharts = [...macroCharts, ...marketCharts, ...Object.values(extraCharts).filter(Boolean)];
    return allCharts.find((c) => c.key === expandedChart) || null;
  }, [expandedChart, macroCharts, marketCharts, extraCharts]);

  return (
    <main className="page">
      <div className="monitor-status-bar" role="status" aria-live="polite">
        <span className={`monitor-dot monitor-dot--${statusTone}`} aria-hidden />
        <span className="monitor-label">Live monitor</span>
        <span className="monitor-detail">
          {lastSyncAt == null && loading
            ? "Connecting…"
            : lastSyncAt == null
              ? "No sync yet"
              : error
                ? `Last good sync ${formatSyncAge(ageMs)} · ${error}${lastUpdateSuffix}`
                : `Data synced ${formatSyncAge(ageMs)} · pulls every ${DATA_REFRESH_MS / 1000}s${lastUpdateSuffix}`}
        </span>
        <div className="monitor-meta">
          <time
            className="monitor-utc"
            dateTime={new Date(clockNow).toISOString()}
            aria-label="Current time in UTC"
          >
            {formatUtcClock(clockNow)} UTC
          </time>
          <span
            className="monitor-hint"
            title={`Status text refreshes every 1s. Set VITE_DATA_REFRESH_MS in .env for pull interval (${MIN_DATA_REFRESH_MS}–${MAX_DATA_REFRESH_MS} ms).`}
          >
            1s clock · {DATA_REFRESH_MS / 1000}s pulls
          </span>
        </div>
      </div>

      <header className="top">
        <div>
          <h1>US Economy Live Monitor</h1>
        </div>
        <div className="top-sources">
          <strong>Sources</strong>
          <div className="sub">
            {(data?.sources || []).join(" | ")}
          </div>
        </div>
      </header>

      {error && <p className="state error">{error}</p>}

      {loading && !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          {data?.us_economy_direction && (
            <section className={`economy-pulse pulse-${data.us_economy_direction.band || "neutral"}`}>
              <div className="pulse-main">
                <div className="pulse-score-wrap">
                  <span className="pulse-score">{formatNumber(data.us_economy_direction.score, 0)}</span>
                  <span className="pulse-out-of">/ 100</span>
                </div>
                <div>
                  <div className="pulse-verdict">{data.us_economy_direction.verdict}</div>
                  <div className="sub">{data.us_economy_direction.method}</div>
                </div>
              </div>
              <div className="pulse-bar-outer" aria-hidden>
                <div
                  className="pulse-bar-inner"
                  style={{ width: `${Math.min(100, Math.max(0, Number(data.us_economy_direction.score)))}%` }}
                />
              </div>
              <div className="pulse-legend" role="group" aria-label="Economy pulse score bands">
                <div className="pulse-legend-title">Verdict bands (heuristic score)</div>
                <ul className="pulse-legend-list">
                  <li>
                    <span className="pulse-legend-swatch swatch-positive" aria-hidden />
                    <span>
                      <strong>62–100</strong> — Expansion bias
                    </span>
                  </li>
                  <li>
                    <span className="pulse-legend-swatch swatch-neutral" aria-hidden />
                    <span>
                      <strong>39–61</strong> — Mixed / transitioning
                    </span>
                  </li>
                  <li>
                    <span className="pulse-legend-swatch swatch-negative" aria-hidden />
                    <span>
                      <strong>0–38</strong> — Slowdown / risk bias
                    </span>
                  </li>
                </ul>
              </div>
              {(data.us_economy_direction.components || []).length > 0 && (
                <div className="pulse-drivers">
                  <button
                    type="button"
                    className="pulse-drivers-toggle"
                    onClick={() => setPulseDriversOpen((open) => !open)}
                    aria-expanded={pulseDriversOpen}
                    aria-controls="pulse-drivers-list"
                    id="pulse-drivers-toggle"
                  >
                    {pulseDriversOpen
                      ? "Hide score drivers"
                      : `Show score drivers (${data.us_economy_direction.components.length})`}
                  </button>
                  {pulseDriversOpen && (
                    <ul className="pulse-components" id="pulse-drivers-list" aria-labelledby="pulse-drivers-toggle">
                      {data.us_economy_direction.components.map((c) => (
                        <li
                          key={c.name}
                          className={tipForPulseDriverLine(c.name) ? "metric-tip" : undefined}
                          title={tipForPulseDriverLine(c.name)}
                        >
                          <strong>{c.name}</strong>{" "}
                          <span className={c.delta >= 0 ? "delta-pos" : "delta-neg"}>
                            ({c.delta >= 0 ? "+" : ""}
                            {c.delta})
                          </span>
                          : {c.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          <TimelineStrip value={timeline} onChange={setTimeline} />

          <section className="layout-columns">
        <div className="layout-col layout-left">
          <Card title="Treasury Yield Curve" className="card-yield">
            <div className="yield-grid">
              {["1m", "3m", "6m", "1y", "2y", "5y", "10y", "30y"].map((tenor) => (
                <div
                  key={tenor}
                  className={`yield-item${glossaryTip(YIELD_TENOR_GLOSSARY_KEY[tenor]) ? " metric-tip" : ""}`}
                  title={glossaryTip(YIELD_TENOR_GLOSSARY_KEY[tenor])}
                >
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
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    cursor={CHART_LINE_TOOLTIP_CURSOR}
                    formatter={(v) => `${formatNumber(v)}%`}
                  />
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
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={gdpBars} margin={{ top: 6, right: 6, left: 4, bottom: 16 }}>
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
                    <Tooltip
                      {...CHART_TOOLTIP_PROPS}
                      cursor={CHART_BAR_TOOLTIP_CURSOR}
                      formatter={(v) => formatNumber(v, 0)}
                    />
                    <Bar dataKey="value" fill="#6ba8ff" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <div className="sub">Inflation rate (% annual) - last reported</div>
              <div className="metric-hint">{getMetricPreference("INFLATION_COMPARE")}</div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={inflationBars} margin={{ top: 6, right: 6, left: 4, bottom: 16 }}>
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
                    <Tooltip
                      {...CHART_TOOLTIP_PROPS}
                      cursor={{ fill: "rgba(240, 168, 75, 0.16)" }}
                      formatter={(v) => `${formatNumber(v)}%`}
                    />
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
                  <strong
                    className={glossaryTip(item.series_id) ? "metric-tip" : undefined}
                    title={glossaryTip(item.series_id)}
                  >
                    {item.label}
                  </strong>
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
                glossaryKey={chart.key}
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
                    <strong
                      className={glossaryTip(item.symbol) ? "metric-tip" : undefined}
                      title={glossaryTip(item.symbol)}
                    >
                      {item.label}
                    </strong>
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
                  glossaryKey={chart.key}
                  onExpand={() => setExpandedChart(chart.key)}
                />
              ))}
            </div>
          </Card>
        </div>
      </section>

      <section className="extra-metrics-row" aria-label="Additional FRED indicators">
        <Card title="Consumer & policy interest rates" className="card-extra">
          <p className="sub extra-metrics-hint">
            Mortgage, auto finance, bank prime, and 3M T-bill. Pulse treats modest rate drops as easing and hikes as
            tightening (context dependent).
          </p>
          <div className="rows">
            {interestRates.map((item) => (
              <div key={item.series_id || item.label} className="row">
                <div>
                  <strong
                    className={glossaryTip(item.series_id) ? "metric-tip" : undefined}
                    title={glossaryTip(item.series_id)}
                  >
                    {item.label}
                  </strong>
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
          {extraCharts.interest && (
            <MiniMetricTrend
              title={extraCharts.interest.title}
              data={extraCharts.interest.data}
              unit="%"
              betterWhen="Lower rates are usually better for borrower affordability."
              readingNote="This is the level of average 30Y mortgage rates, not a growth rate."
            />
          )}
        </Card>
        <Card title="Fiscal stance (% of GDP)" className="card-extra">
          <p className="sub extra-metrics-hint">
            Surplus/deficit, debt, and receipts as shares of GDP. Updates are often quarterly or annual — read changes
            cautiously.
          </p>
          <div className="rows">
            {taxMetrics.map((item) => (
              <div key={item.series_id || item.label} className="row">
                <div>
                  <strong
                    className={glossaryTip(item.series_id) ? "metric-tip" : undefined}
                    title={glossaryTip(item.series_id)}
                  >
                    {item.label}
                  </strong>
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
          {extraCharts.tax && (
            <MiniMetricTrend
              title={extraCharts.tax.title}
              data={extraCharts.tax.data}
              unit="%"
              betterWhen="Higher (less negative) is generally better because deficits are smaller."
              readingNote="This tracks federal balance as % of GDP; values below zero are deficits."
            />
          )}
        </Card>
        <Card title="Consumer demand & housing" className="card-extra">
          <p className="sub extra-metrics-hint">
            Michigan sentiment, retail sales ex-autos, and nationwide U.S. housing starts — demand-side momentum for
            the pulse.
          </p>
          <div className="rows">
            {activityMetrics.map((item) => (
              <div key={item.series_id || item.label} className="row">
                <div>
                  <strong
                    className={glossaryTip(item.series_id) ? "metric-tip" : undefined}
                    title={glossaryTip(item.series_id)}
                  >
                    {item.label}
                  </strong>
                  <div className="sub">{item.latest_date || item.error}</div>
                  <div className="metric-hint">{getMetricPreference(item.series_id)}</div>
                </div>
                <div className="right">
                  <div>{formatNumber(item.latest_value)}</div>
                  <StatusPill
                    change={
                      item.series_id === "RSXFS" && item.pct_change != null && item.pct_change !== undefined
                        ? item.pct_change
                        : item.change
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          {extraCharts.activity && (
            <MiniMetricTrend
              title={extraCharts.activity.title}
              data={extraCharts.activity.data}
              betterWhen="Higher is generally better for housing-cycle momentum."
              readingNote="This is the level of housing starts (SAAR), so trend direction shows cycle strength/weakness."
            />
          )}
        </Card>
      </section>

      <section className="below-section">
        <Card title="Macro Headlines (Rule-Labeled Impact)" className="card-headlines">
          <p className="sub">
            VADER runs on the headline plus plain text from the RSS item (description / content:encoded); keywords and
            domain priors use that same text. Hover a headline for impact score and compound. Topic tags are
            keyword-derived.
          </p>
          <HeadlinesByImpact headlines={headlines} />
        </Card>
      </section>
        </>
      )}

      {expandedChartData && (
        <div className="modal-backdrop" onClick={() => setExpandedChart(null)} role="presentation">
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <h3
                className={glossaryTip(expandedChartData.key) ? "metric-tip" : undefined}
                title={glossaryTip(expandedChartData.key)}
              >
                {expandedChartData.title}
              </h3>
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
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    cursor={CHART_LINE_TOOLTIP_CURSOR}
                    formatter={(v) => formatNumber(v)}
                    labelFormatter={formatDateFromTs}
                  />
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
