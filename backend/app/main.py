import asyncio
import re
from datetime import datetime, timezone
from html import unescape
from io import StringIO
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET

import httpx
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

app = FastAPI(title="US Economy Live Monitor API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRED_SERIES: Dict[str, Dict[str, str]] = {
    "cpi": {"series_id": "CPIAUCSL", "label": "CPI (All Urban Consumers, SA)"},
    "unemployment_rate": {"series_id": "UNRATE", "label": "Unemployment Rate"},
    "payrolls": {"series_id": "PAYEMS", "label": "Total Nonfarm Payrolls"},
    "real_gdp": {"series_id": "GDPC1", "label": "Real GDP"},
    "fed_funds_rate": {"series_id": "FEDFUNDS", "label": "Fed Funds Rate"},
    "initial_claims": {"series_id": "ICSA", "label": "Initial Jobless Claims"},
}

# Extra FRED blocks (same CSV shape as core `economy` rows) for dashboard columns + pulse heuristics.
INTEREST_RATE_SERIES: Dict[str, str] = {
    "MORTGAGE30US": "30-year fixed mortgage rate",
    "TERMCBAUTO48NS": "48-mo new auto loan rate (finance cos.)",
    "MPRIME": "Bank prime loan rate",
    "TB3MS": "3-month Treasury bill (secondary market)",
}

TAX_FRED_SERIES: Dict[str, str] = {
    "FYFSGDA188S": "Federal surplus or deficit (% of GDP)",
    "GFDEGDQ188S": "Federal public debt (% of GDP)",
    "FYFRGDA188S": "Federal current receipts (% of GDP)",
}

ACTIVITY_FRED_SERIES: Dict[str, str] = {
    "UMCSENT": "U. of Michigan consumer sentiment",
    "RSXFS": "Retail sales ex food services & motor vehicles",
    "HOUST": "Housing starts, U.S. total (SAAR)",
}

YF_TICKERS: Dict[str, Dict[str, str]] = {
    "spy": {"symbol": "SPY", "label": "S&P 500 ETF"},
    "vix": {"symbol": "^VIX", "label": "CBOE Volatility Index"},
    "dxy": {"symbol": "DX-Y.NYB", "label": "US Dollar Index"},
    "wti": {"symbol": "CL=F", "label": "WTI Crude Oil Futures"},
    "gold": {"symbol": "GC=F", "label": "Gold Futures"},
    "btc": {"symbol": "BTC-USD", "label": "Bitcoin (USD)"},
}

TREASURY_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/"
    "accounting/od/avg_interest_rates"
)
YIELD_FRED_SERIES: Dict[str, str] = {
    "1m": "DGS1MO",
    "3m": "DGS3MO",
    "6m": "DGS6MO",
    "1y": "DGS1",
    "2y": "DGS2",
    "5y": "DGS5",
    "10y": "DGS10",
    "30y": "DGS30",
}
COUNTRY_GDP_SERIES: Dict[str, Dict[str, str]] = {
    "us": {"label": "United States", "series_id": "MKTGDPUSA646NWDB"},
    "china": {"label": "China", "series_id": "MKTGDPCAA646NWDB"},
    "japan": {"label": "Japan", "series_id": "MKTGDPJPA646NWDB"},
    "germany": {"label": "Germany", "series_id": "MKTGDPDEA646NWDB"},
    "india": {"label": "India", "series_id": "MKTGDPINA646NWDB"},
}
COUNTRY_CPI_SERIES: Dict[str, Dict[str, str]] = {
    "us": {"label": "United States", "series_id": "FPCPITOTLZGUSA"},
    "china": {"label": "China", "series_id": "FPCPITOTLZGCHN"},
    "japan": {"label": "Japan", "series_id": "FPCPITOTLZGJPN"},
    "germany": {"label": "Germany", "series_id": "FPCPITOTLZGDEU"},
    "india": {"label": "India", "series_id": "FPCPITOTLZGIND"},
}
HEADLINE_SOURCES: List[Dict[str, str]] = [
    {"name": "Yahoo Finance", "url": "https://finance.yahoo.com/news/rssindex"},
    {"name": "CNBC", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},
    {"name": "Federal Reserve", "url": "https://www.federalreserve.gov/feeds/press_all.xml"},
]

_VADER = SentimentIntensityAnalyzer()

# RSS `content:encoded` expanded tag (namespaces collapsed by ElementTree).
_RSS_CONTENT_ENCODED = "{http://purl.org/rss/1.0/modules/content/}encoded"
_HTML_TAG_RE = re.compile(r"<[^>]+>", re.I)

# Lexicon hits (substring on lowercased title). Keep phrases before single words where order matters.
_POSITIVE_LEXICON: List[Tuple[str, float]] = [
    ("beat expectations", 11),
    ("beats expectations", 11),
    ("tops expectations", 10),
    ("better than expected", 11),
    ("better-than-expected", 11),
    ("earnings beat", 9),
    ("profit beat", 9),
    ("record high", 8),
    ("record close", 8),
    ("all-time high", 8),
    ("gdp growth", 10),
    ("economic growth", 9),
    ("job gains", 10),
    ("added jobs", 10),
    ("hiring", 6),
    ("unemployment falls", 10),
    ("unemployment fell", 10),
    ("unemployment drops", 10),
    ("inflation cools", 12),
    ("inflation cooled", 12),
    ("inflation eases", 12),
    ("inflation eased", 12),
    ("disinflation", 11),
    ("cooling inflation", 11),
    ("rate cut", 7),
    ("rate cuts", 8),
    ("cuts rates", 8),
    ("dovish", 6),
    ("soft landing", 9),
    ("rally", 6),
    ("surges", 5),
    ("soars", 5),
    ("jumped", 4),
    ("gains", 4),
    ("rebound", 6),
    ("recovery", 7),
    ("upgrade", 7),
    ("breakthrough", 6),
    ("trade deal", 6),
    ("ceasefire", 5),
    ("peace talks", 4),
    ("productivity", 5),
    ("expansion", 7),
    ("resilient", 5),
]

_NEGATIVE_LEXICON: List[Tuple[str, float]] = [
    ("layoffs", 12),
    ("job cuts", 12),
    ("cuts jobs", 12),
    ("job losses", 12),
    ("unemployment rises", 11),
    ("unemployment rose", 11),
    ("unemployment jumps", 11),
    ("recession", 14),
    ("contraction", 11),
    ("downgrade", 9),
    ("default", 10),
    ("bankruptcy", 11),
    ("crisis", 9),
    ("crash", 11),
    ("plunge", 9),
    ("plunges", 9),
    ("slump", 8),
    ("turmoil", 8),
    ("strikes", 7),
    ("shutdown", 8),
    ("fears", 6),
    ("warning", 7),
    ("worse than expected", 11),
    ("misses expectations", 11),
    ("disappoints", 8),
    ("disappointment", 8),
    ("inflation surges", 13),
    ("inflation soars", 13),
    ("inflation jumps", 12),
    ("inflation spikes", 12),
    ("hot cpi", 12),
    ("prices soar", 10),
    ("price surge", 10),
    ("hawkish", 6),
    ("higher for longer", 8),
    ("rate hikes", 7),
    ("tariff", 6),
    ("war risk", 9),
    ("geopolitical", 5),
    ("demand concerns", 7),
    ("demand worries", 7),
    ("growth worries", 8),
    ("markets slide", 8),
    ("stocks slide", 8),
    ("oil surges", 9),
    ("crude surges", 9),
    ("oil spikes", 8),
    ("yield spike", 7),
    ("bond vigilante", 8),
]


async def fetch_fred_series(
    client: httpx.AsyncClient, series_id: str, label: str, history_limit: Optional[int] = 240
) -> Dict[str, Any]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    try:
        response = await client.get(url, timeout=20)
        response.raise_for_status()
        df = pd.read_csv(StringIO(response.text))
        date_col = "DATE" if "DATE" in df.columns else "observation_date"
        df = df.rename(columns={series_id: "value", date_col: "date"})
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
        df = df.dropna(subset=["value"])

        if df.empty:
            return {"series_id": series_id, "label": label, "error": "No data returned"}

        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else None
        change = float(latest["value"] - prev["value"]) if prev is not None else None
        pct_change = (
            float((latest["value"] - prev["value"]) / prev["value"] * 100)
            if prev is not None and prev["value"] != 0
            else None
        )

        history_df = df if history_limit is None else df.tail(history_limit)

        return {
            "series_id": series_id,
            "label": label,
            "latest_date": str(latest["date"]),
            "latest_value": float(latest["value"]),
            "change": change,
            "pct_change": pct_change,
            "history": history_df.to_dict(orient="records"),
        }
    except Exception as exc:
        return {"series_id": series_id, "label": label, "error": str(exc)}


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _freshness_multiplier(observed_date: Optional[str], now_utc: datetime) -> float:
    """
    Down-weight stale observations so slow-frequency series don't dominate a live pulse.
    """
    if not observed_date:
        return 1.0
    dt = pd.to_datetime(observed_date, errors="coerce", utc=True)
    if pd.isna(dt):
        return 1.0
    age_days = max(0.0, (now_utc - dt.to_pydatetime()).total_seconds() / 86400.0)
    if age_days <= 45:
        return 1.0
    if age_days <= 120:
        return 0.85
    if age_days <= 240:
        return 0.65
    if age_days <= 365:
        return 0.45
    return 0.3


def _yf_flatten_columns(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        out = df.copy()
        out.columns = out.columns.get_level_values(0)
        return out
    return df


def _download_market_daily(symbol: str) -> pd.DataFrame:
    df = yf.download(
        symbol,
        period="max",
        interval="1d",
        progress=False,
        auto_adjust=True,
        threads=False,
        group_by="column",
    )
    if df.empty:
        return df
    df = _yf_flatten_columns(df)
    if "Close" not in df.columns:
        return pd.DataFrame()
    df = df[["Close"]].rename(columns={"Close": "value"}).dropna()
    df = df.sort_index()
    idx = pd.DatetimeIndex(pd.to_datetime(df.index))
    if idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    df.index = idx.normalize()
    df = df[~df.index.duplicated(keep="last")]
    df["date"] = df.index.strftime("%Y-%m-%d")
    return df.reset_index(drop=True)


async def fetch_market_snapshot(symbol: str, label: str) -> Dict[str, Any]:
    try:
        close_df = _download_market_daily(symbol)
        if close_df.empty:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period="max", interval="1d", auto_adjust=True, actions=False)
            if hist.empty:
                return {"symbol": symbol, "label": label, "error": "No market data returned"}
            hist = hist.sort_index()
            close_series_raw = hist["Close"]
            if isinstance(close_series_raw, pd.DataFrame):
                close_series_raw = close_series_raw.iloc[:, 0]
            tmp = pd.DataFrame({"value": close_series_raw}).dropna()
            idx = pd.DatetimeIndex(pd.to_datetime(tmp.index))
            if idx.tz is not None:
                idx = idx.tz_convert("UTC").tz_localize(None)
            tmp["date"] = idx.strftime("%Y-%m-%d")
            close_df = tmp.reset_index(drop=True)

        close_series = close_df["value"]
        if close_series.empty:
            return {"symbol": symbol, "label": label, "error": "No close prices available"}

        latest_close = float(close_series.iloc[-1])
        prev_close = float(close_series.iloc[-2]) if len(close_series) > 1 else None
        change = (latest_close - prev_close) if prev_close is not None else None
        pct_change = (change / prev_close * 100) if prev_close else None

        return {
            "symbol": symbol,
            "label": label,
            "latest": latest_close,
            "latest_date": str(close_df.iloc[-1]["date"]) if "date" in close_df.columns else None,
            "change": change,
            "pct_change": pct_change,
            # Full daily history (e.g. SPY ~8.3k rows since 1993); needed for "ALL" timeline in UI.
            "history": close_df.to_dict(orient="records"),
        }
    except Exception as exc:
        return {"symbol": symbol, "label": label, "error": str(exc)}


async def fetch_treasury_yields(client: httpx.AsyncClient) -> Dict[str, Any]:
    try:
        result: Dict[str, Any] = {}
        latest_date: Optional[str] = None
        for tenor, fred_series_id in YIELD_FRED_SERIES.items():
            series = await fetch_fred_series(
                client=client,
                series_id=fred_series_id,
                label=f"Treasury {tenor.upper()}",
            )
            result[tenor] = series.get("latest_value")
            if not latest_date and series.get("latest_date"):
                latest_date = series["latest_date"]
        result["record_date"] = latest_date
        return result
    except Exception as exc:
        return {"error": str(exc)}


async def fetch_avg_interest_rates(client: httpx.AsyncClient) -> Dict[str, Any]:
    params = {"sort": "-record_date", "page[size]": "12"}
    try:
        response = await client.get(TREASURY_URL, params=params, timeout=20)
        response.raise_for_status()
        payload = response.json()
        return {"count": len(payload.get("data", []))}
    except Exception as exc:
        return {"error": str(exc)}


def _plain_text(html_or_text: str) -> str:
    """Strip tags / entities from RSS description or content:encoded."""
    if not html_or_text:
        return ""
    s = unescape(str(html_or_text))
    s = _HTML_TAG_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _rss_element_raw_text(el: Optional[ET.Element]) -> str:
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def _rss_item_body_plain(item: ET.Element) -> str:
    """Plain-text body from RSS description and/or content:encoded (deduped)."""
    blobs: List[str] = []
    for el in (item.find("description"), item.find(_RSS_CONTENT_ENCODED)):
        raw = _rss_element_raw_text(el)
        if not raw:
            continue
        plain = _plain_text(raw)
        if plain and plain not in blobs:
            blobs.append(plain)
    return "\n\n".join(blobs).strip()


def _sentiment_corpus(title: str, body_plain: str, max_chars: int = 8000) -> str:
    """Title + article snippet for VADER (truncated to keep requests predictable)."""
    t = (title or "").strip()
    b = (body_plain or "").strip()
    if t and b:
        blob = f"{t}\n\n{b}"
    elif t:
        blob = t
    elif b:
        blob = b
    else:
        return ""
    blob = blob.strip()
    if len(blob) <= max_chars:
        return blob
    return blob[:max_chars].rstrip()


def _lexicon_impact(text: str) -> float:
    impact = 0.0
    for phrase, weight in _POSITIVE_LEXICON:
        if phrase in text:
            impact += weight
    for phrase, weight in _NEGATIVE_LEXICON:
        if phrase in text:
            impact -= weight
    return impact


def _detect_impact_area(text: str) -> str:
    if any(
        k in text
        for k in ["inflation", "cpi", "pce", "consumer prices", "producer price", "cost of living"]
    ):
        return "Inflation"
    if any(
        k in text
        for k in ["layoff", "employ", "jobs", "payroll", "wages", "unemployment", "claims", "nfp"]
    ):
        return "Labor Market"
    if any(k in text for k in ["gdp", "growth", "recession", "expansion", "economy shrinks", "economic output"]):
        return "Growth"
    if any(k in text for k in ["oil", "crude", "opec", "shipping", "freight", "supply chain", "energy"]):
        return "Energy/Supply"
    if any(
        k in text
        for k in ["fed", "fomc", "interest rate", "rates", "treasury", "bond yield", "yields", "dollar index"]
    ):
        return "Monetary Policy"
    return "General Macro"


def _domain_bias(text: str) -> float:
    """
    Signed priors for typical US macro / risk framing (not a forecast).
    Pushes bland headlines toward a side when domain verbs are clear.
    """
    bias = 0.0
    if "inflation" in text or "cpi" in text or "pce" in text:
        if any(
            x in text
            for x in ("surge", "soar", "jump", "spike", "hot", "reaccelerat", "sticky", "persistent high")
        ):
            bias -= 11.0
        elif any(
            x in text
            for x in ("cool", "cooling", "ease", "easing", "fall", "fell", "slow", "disinflat", "decline", "subdued")
        ):
            bias += 9.0
    if any(x in text for x in ("layoff", "job cut", "cuts jobs", "job losses")):
        bias -= 10.0
    elif any(x in text for x in ("job gains", "hiring", "added jobs", "unemployment fall", "unemployment drop")):
        bias += 8.0
    if any(x in text for x in ("recession", "contraction", "shrinks", "slumps")):
        bias -= 12.0
    if any(x in text for x in ("expansion", "gdp growth", "accelerat")):
        bias += 8.0
    if "oil" in text or "crude" in text or "gasoline" in text:
        if any(x in text for x in ("demand concern", "demand worry", "oversupply", "glut")):
            bias -= 6.0
        if any(x in text for x in ("surge", "soar", "spike", "jump", "rally")):
            bias -= 7.0
        if any(x in text for x in ("fall", "fell", "drop", "plunge", "tumble")):
            bias += 5.0
    if any(x in text for x in ("rate cut", "cuts rates", "easing", "dovish")):
        bias += 6.0
    if any(x in text for x in ("rate hike", "hikes rates", "hawkish", "higher for longer")):
        bias -= 6.0
    return bias


def classify_headline(title: str, body_plain: str = "") -> Dict[str, Any]:
    """
    Rule-based topic + VADER sentiment + domain biases -> direction/color.
    Lexicon/domain use title + body; VADER runs on title + plain-text RSS body (description / content:encoded).
    """
    raw_title = (title or "").strip()
    body = (body_plain or "").strip()
    combined_lower = f"{raw_title}\n{body}".lower().strip()
    if not combined_lower:
        return {
            "impact_area": "General Macro",
            "direction": "mixed",
            "color": "yellow",
            "sentiment_compound": 0.0,
            "impact_score": 0.0,
        }

    sentiment_blob = _sentiment_corpus(raw_title, body)
    compound = float(_VADER.polarity_scores(sentiment_blob)["compound"])
    lex = _lexicon_impact(combined_lower)
    dom_bias = _domain_bias(combined_lower)
    area = _detect_impact_area(combined_lower)

    # Lexicon/domain carry most signal; VADER uses headline + article snippet from the feed.
    impact_score = compound * 42.0 + lex + dom_bias

    pos_cut, neg_cut = 4.5, -4.5
    if impact_score >= pos_cut:
        direction, color = "positive", "green"
    elif impact_score <= neg_cut:
        direction, color = "negative", "red"
    elif compound >= 0.15:
        direction, color = "positive", "green"
    elif compound <= -0.15:
        direction, color = "negative", "red"
    else:
        direction, color = "mixed", "yellow"

    return {
        "impact_area": area,
        "direction": direction,
        "color": color,
        "sentiment_compound": round(compound, 4),
        "impact_score": round(impact_score, 2),
    }


async def fetch_headlines(client: httpx.AsyncClient) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for source in HEADLINE_SOURCES:
        try:
            response = await client.get(
                source["url"],
                timeout=20,
                headers={"User-Agent": "econai-monitor/0.1"},
            )
            response.raise_for_status()
            root = ET.fromstring(response.text)
            items = root.findall(".//item")[:5]
            for item in items:
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                pub_date = (item.findtext("pubDate") or "").strip()
                if not title:
                    continue
                body_plain = _rss_item_body_plain(item)
                classification = classify_headline(title, body_plain)
                results.append(
                    {
                        "source": source["name"],
                        "title": title,
                        "url": link,
                        "published_at": pub_date,
                        **classification,
                    }
                )
        except Exception:
            continue
    return results[:12]


def _fred_row(rows: List[Dict[str, Any]], series_id: str) -> Dict[str, Any]:
    for row in rows:
        if row.get("series_id") == series_id:
            return row
    return {}


def _market_row(markets: List[Dict[str, Any]], symbol: str) -> Dict[str, Any]:
    for row in markets:
        if row.get("symbol") == symbol:
            return row
    return {}


def _headline_sentiment_pulse(headlines: List[Dict[str, Any]]) -> Optional[Tuple[float, str]]:
    """Aggregate VADER `sentiment_compound` from classified RSS headlines into a score nudge."""
    comps: List[float] = []
    for h in headlines:
        v = h.get("sentiment_compound")
        if isinstance(v, bool) or v is None:
            continue
        try:
            comps.append(float(v))
        except (TypeError, ValueError):
            continue
    if not comps:
        return None
    avg = sum(comps) / len(comps)
    delta = max(-12.0, min(12.0, avg * 28.0))
    detail = f"Mean VADER compound {avg:.3f} across {len(comps)} RSS headlines (title + body text)"
    return delta, detail


def _interest_rate_pulse(rows: List[Dict[str, Any]], add_component) -> None:
    """Lower quoted consumer / benchmark rates vs prior print → modest easing read for the pulse."""
    specs = [
        ("MORTGAGE30US", "Mortgage (30Y)", 0.02),
        ("TERMCBAUTO48NS", "Auto loan (48M)", 0.04),
        ("MPRIME", "Bank prime", 0.03),
        ("TB3MS", "T-bill 3M", 0.02),
    ]
    for sid, label, thr in specs:
        row = _fred_row(rows, sid)
        if row.get("error") or row.get("change") is None:
            continue
        ch = float(row["change"])
        if ch < -thr:
            add_component(
                f"Rates — {label}",
                1.6,
                f"{label} fell {abs(ch):.2f} pts vs prior observation",
                bucket="rates",
                observed_date=row.get("latest_date"),
            )
        elif ch > thr:
            add_component(
                f"Rates — {label}",
                -1.6,
                f"{label} rose {ch:.2f} pts vs prior observation",
                bucket="rates",
                observed_date=row.get("latest_date"),
            )


def _tax_fiscal_pulse(rows: List[Dict[str, Any]], add_component) -> None:
    """High-level fiscal stance deltas (% of GDP series, mostly quarterly / annual)."""
    bal = _fred_row(rows, "FYFSGDA188S")
    if bal.get("change") is not None:
        ch = float(bal["change"])
        if ch > 0.08:
            add_component(
                "Fiscal balance (% GDP)",
                3.2,
                "Surplus improved / deficit narrowed vs prior print",
                bucket="fiscal",
                observed_date=bal.get("latest_date"),
            )
        elif ch < -0.08:
            add_component(
                "Fiscal balance (% GDP)",
                -3.2,
                "Deficit widened vs prior print",
                bucket="fiscal",
                observed_date=bal.get("latest_date"),
            )

    debt = _fred_row(rows, "GFDEGDQ188S")
    if debt.get("change") is not None:
        ch = float(debt["change"])
        if ch > 0.15:
            add_component(
                "Public debt (% GDP)",
                -2.4,
                "Debt-to-GDP moved up vs prior observation",
                bucket="fiscal",
                observed_date=debt.get("latest_date"),
            )
        elif ch < -0.12:
            add_component(
                "Public debt (% GDP)",
                2.0,
                "Debt-to-GDP improved vs prior observation",
                bucket="fiscal",
                observed_date=debt.get("latest_date"),
            )

    rec = _fred_row(rows, "FYFRGDA188S")
    if rec.get("change") is not None:
        ch = float(rec["change"])
        if ch > 0.12:
            add_component(
                "Federal receipts (% GDP)",
                1.8,
                "Receipts share of GDP rose vs prior print",
                bucket="fiscal",
                observed_date=rec.get("latest_date"),
            )
        elif ch < -0.12:
            add_component(
                "Federal receipts (% GDP)",
                -1.8,
                "Receipts share of GDP fell vs prior print",
                bucket="fiscal",
                observed_date=rec.get("latest_date"),
            )


def _activity_pulse(rows: List[Dict[str, Any]], add_component) -> None:
    sent = _fred_row(rows, "UMCSENT")
    if sent.get("change") is not None:
        ch = float(sent["change"])
        if ch > 1.0:
            add_component(
                "Consumer sentiment",
                4.5,
                "UMich sentiment improved vs prior month",
                bucket="activity",
                observed_date=sent.get("latest_date"),
            )
        elif ch < -1.0:
            add_component(
                "Consumer sentiment",
                -4.5,
                "UMich sentiment softened vs prior month",
                bucket="activity",
                observed_date=sent.get("latest_date"),
            )

    retail = _fred_row(rows, "RSXFS")
    if retail.get("pct_change") is not None:
        pc = float(retail["pct_change"])
        if pc > 0.35:
            add_component(
                "Retail sales (ex-auto)",
                3.5,
                "Retail sales rose vs prior month",
                bucket="activity",
                observed_date=retail.get("latest_date"),
            )
        elif pc < -0.35:
            add_component(
                "Retail sales (ex-auto)",
                -3.5,
                "Retail sales fell vs prior month",
                bucket="activity",
                observed_date=retail.get("latest_date"),
            )

    starts = _fred_row(rows, "HOUST")
    if starts.get("change") is not None:
        ch = float(starts["change"])
        if ch > 2.5:
            add_component(
                "Housing starts",
                3.8,
                "Starts picked up vs prior month (SAAR units)",
                bucket="activity",
                observed_date=starts.get("latest_date"),
            )
        elif ch < -2.5:
            add_component(
                "Housing starts",
                -3.8,
                "Starts cooled vs prior month (SAAR units)",
                bucket="activity",
                observed_date=starts.get("latest_date"),
            )


def compute_us_economy_direction(
    economy: List[Dict[str, Any]],
    treasury_yields: Dict[str, Any],
    markets: List[Dict[str, Any]],
    interest_rates: List[Dict[str, Any]],
    tax_metrics: List[Dict[str, Any]],
    activity_metrics: List[Dict[str, Any]],
    headlines: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Heuristic 0–100 pulse from FRED + market data + RSS headline sentiment.
    Not a forecast — a compact read of momentum, curve shape, and news tone.
    """
    components: List[Dict[str, Any]] = []
    score = 50.0
    now_utc = datetime.now(timezone.utc)
    bucket_totals: Dict[str, float] = {}
    bucket_caps: Dict[str, float] = {
        "growth_labor": 26.0,
        "inflation": 8.0,
        "financial": 22.0,
        "news": 8.0,
        "rates": 7.0,
        "fiscal": 7.0,
        "activity": 10.0,
    }

    def add_component(
        name: str,
        delta: float,
        detail: str,
        bucket: str = "growth_labor",
        observed_date: Optional[str] = None,
    ) -> None:
        nonlocal score
        cap = bucket_caps.get(bucket, 8.0)
        running = bucket_totals.get(bucket, 0.0)
        freshness = _freshness_multiplier(observed_date, now_utc)
        adjusted = float(delta) * freshness
        room_up = cap - running
        room_down = -cap - running
        applied = max(room_down, min(room_up, adjusted))
        if abs(applied) < 1e-9:
            return
        bucket_totals[bucket] = running + applied
        score += applied
        components.append(
            {
                "name": name,
                "delta": round(applied, 1),
                "detail": detail,
                "freshness": round(freshness, 2),
                "bucket": bucket,
            }
        )

    payems = _fred_row(economy, "PAYEMS")
    if payems.get("change") is not None:
        ch = float(payems["change"])
        if ch > 0:
            add_component(
                "Payrolls (PAYEMS)",
                7,
                "Payrolls rose vs prior print",
                bucket="growth_labor",
                observed_date=payems.get("latest_date"),
            )
        elif ch < 0:
            add_component(
                "Payrolls (PAYEMS)",
                -7,
                "Payrolls fell vs prior print",
                bucket="growth_labor",
                observed_date=payems.get("latest_date"),
            )

    unrate = _fred_row(economy, "UNRATE")
    if unrate.get("change") is not None:
        ch = float(unrate["change"])
        if ch < 0:
            add_component(
                "Unemployment (UNRATE)",
                7,
                "Unemployment rate edged down",
                bucket="growth_labor",
                observed_date=unrate.get("latest_date"),
            )
        elif ch > 0:
            add_component(
                "Unemployment (UNRATE)",
                -7,
                "Unemployment rate rose",
                bucket="growth_labor",
                observed_date=unrate.get("latest_date"),
            )

    icsa = _fred_row(economy, "ICSA")
    if icsa.get("change") is not None:
        ch = float(icsa["change"])
        if ch < 0:
            add_component(
                "Jobless claims (ICSA)",
                4.5,
                "Initial claims declined vs prior week",
                bucket="growth_labor",
                observed_date=icsa.get("latest_date"),
            )
        elif ch > 0:
            add_component(
                "Jobless claims (ICSA)",
                -4.5,
                "Initial claims rose vs prior week",
                bucket="growth_labor",
                observed_date=icsa.get("latest_date"),
            )

    gdp = _fred_row(economy, "GDPC1")
    if gdp.get("change") is not None:
        ch = float(gdp["change"])
        if ch > 0:
            add_component(
                "Real GDP (GDPC1)",
                8.5,
                "Real GDP rose vs prior quarter",
                bucket="growth_labor",
                observed_date=gdp.get("latest_date"),
            )
        elif ch < 0:
            add_component(
                "Real GDP (GDPC1)",
                -10.0,
                "Real GDP contracted vs prior quarter",
                bucket="growth_labor",
                observed_date=gdp.get("latest_date"),
            )

    cpi = _fred_row(economy, "CPIAUCSL")
    if cpi.get("pct_change") is not None:
        pc = float(cpi["pct_change"])
        if pc > 0.35:
            add_component(
                "CPI (CPIAUCSL)",
                -4.5,
                "MoM CPI increase looks firm",
                bucket="inflation",
                observed_date=cpi.get("latest_date"),
            )
        elif pc < -0.05:
            add_component(
                "CPI (CPIAUCSL)",
                3.0,
                "MoM CPI cooled vs prior month",
                bucket="inflation",
                observed_date=cpi.get("latest_date"),
            )

    y10 = treasury_yields.get("10y")
    y2 = treasury_yields.get("2y")
    if y10 is not None and y2 is not None:
        spread = float(y10) - float(y2)
        if spread < -0.1:
            add_component(
                "Yield curve (10Y − 2Y)",
                -10.0,
                "Curve inverted — classic late-cycle signal",
                bucket="financial",
                observed_date=treasury_yields.get("record_date"),
            )
        elif spread < 0.25:
            add_component(
                "Yield curve (10Y − 2Y)",
                -3.5,
                "Curve is flat — growth doubts",
                bucket="financial",
                observed_date=treasury_yields.get("record_date"),
            )
        elif spread < 0.75:
            add_component(
                "Yield curve (10Y − 2Y)",
                3.5,
                "Curve modestly positive",
                bucket="financial",
                observed_date=treasury_yields.get("record_date"),
            )
        else:
            add_component(
                "Yield curve (10Y − 2Y)",
                7.5,
                "Curve steep — markets pricing better growth / term premium",
                bucket="financial",
                observed_date=treasury_yields.get("record_date"),
            )

    spy = _market_row(markets, "SPY")
    if spy.get("pct_change") is not None:
        pc = float(spy["pct_change"])
        if pc > 0.25:
            add_component(
                "Risk assets (SPY)",
                4.0,
                "S&P 500 ETF up vs prior session",
                bucket="financial",
                observed_date=spy.get("latest_date"),
            )
        elif pc < -0.35:
            add_component(
                "Risk assets (SPY)",
                -4.0,
                "S&P 500 ETF down vs prior session",
                bucket="financial",
                observed_date=spy.get("latest_date"),
            )

    vix = _market_row(markets, "^VIX")
    if vix.get("pct_change") is not None:
        pc = float(vix["pct_change"])
        if pc < -3:
            add_component(
                "Volatility (VIX)",
                3.0,
                "VIX fell — calmer risk pricing",
                bucket="financial",
                observed_date=vix.get("latest_date"),
            )
        elif pc > 5:
            add_component(
                "Volatility (VIX)",
                -4.0,
                "VIX jumped — risk-off tone",
                bucket="financial",
                observed_date=vix.get("latest_date"),
            )

    hsent = _headline_sentiment_pulse(headlines)
    if hsent is not None:
        delta, detail = hsent
        add_component("News flow (RSS headline sentiment)", round(delta, 1), detail, bucket="news")

    _interest_rate_pulse(interest_rates, add_component)
    _tax_fiscal_pulse(tax_metrics, add_component)
    _activity_pulse(activity_metrics, add_component)

    raw_score = max(0.0, min(100.0, score))
    avg_freshness = (
        sum(float(c.get("freshness", 1.0)) for c in components) / len(components) if components else 1.0
    )
    active_bucket_count = sum(1 for v in bucket_totals.values() if abs(v) > 1e-9)
    bucket_coverage = active_bucket_count / max(1, len(bucket_caps))
    signal_density = min(1.0, len(components) / 10.0)
    reliability = max(0.45, min(1.0, 0.55 * avg_freshness + 0.35 * bucket_coverage + 0.10 * signal_density))
    score = 50.0 + (raw_score - 50.0) * reliability
    score = max(0.0, min(100.0, score))
    if score >= 62:
        verdict = "Expansion bias"
        band = "positive"
    elif score <= 38:
        verdict = "Slowdown / risk bias"
        band = "negative"
    else:
        verdict = "Mixed / transitioning"
        band = "neutral"

    return {
        "score": round(score, 1),
        "raw_score": round(raw_score, 1),
        "reliability": round(reliability, 2),
        "verdict": verdict,
        "band": band,
        "components": components,
        "bucket_subtotals": {k: round(v, 1) for k, v in bucket_totals.items()},
        "method": (
            "Bucketed heuristic with caps, freshness decay, and reliability shrink toward neutral when data is stale "
            "or narrow: growth/labor, inflation, financial conditions, news sentiment, consumer rates, fiscal stance, "
            "and activity/housing."
        ),
    }


async def fetch_country_series(
    client: httpx.AsyncClient, series_map: Dict[str, Dict[str, str]]
) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for _, metadata in series_map.items():
        series = await fetch_fred_series(
            client=client, series_id=metadata["series_id"], label=metadata["label"]
        )
        output.append(
            {
                "country": metadata["label"],
                "latest_value": series.get("latest_value"),
                "latest_date": series.get("latest_date"),
                "history": series.get("history", []),
                "error": series.get("error"),
            }
        )
    return output


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


async def _fetch_fred_group(
    client: httpx.AsyncClient, spec: Dict[str, str], history_limit: Optional[int] = 240
) -> List[Dict[str, Any]]:
    tasks = [fetch_fred_series(client, series_id=sid, label=lab, history_limit=history_limit) for sid, lab in spec.items()]
    return list(await asyncio.gather(*tasks))


@app.get("/api/dashboard")
async def dashboard(response: Response) -> Dict[str, Any]:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    async with httpx.AsyncClient() as client:
        fred_data: List[Dict[str, Any]] = []
        for _, metadata in FRED_SERIES.items():
            fred_data.append(
                await fetch_fred_series(
                    client,
                    series_id=metadata["series_id"],
                    label=metadata["label"],
                )
            )

        interest_rates, tax_metrics, activity_metrics, headlines = await asyncio.gather(
            _fetch_fred_group(client, INTEREST_RATE_SERIES, history_limit=None),
            _fetch_fred_group(client, TAX_FRED_SERIES, history_limit=None),
            _fetch_fred_group(client, ACTIVITY_FRED_SERIES, history_limit=None),
            fetch_headlines(client),
        )

        markets: List[Dict[str, Any]] = []
        for _, metadata in YF_TICKERS.items():
            markets.append(
                await fetch_market_snapshot(
                    symbol=metadata["symbol"],
                    label=metadata["label"],
                )
            )

        treasury_yields = await fetch_treasury_yields(client)
        debt_interest_meta = await fetch_avg_interest_rates(client)
        gdp_compare = await fetch_country_series(client, COUNTRY_GDP_SERIES)
        inflation_compare = await fetch_country_series(client, COUNTRY_CPI_SERIES)

    economy_direction = compute_us_economy_direction(
        economy=fred_data,
        treasury_yields=treasury_yields if isinstance(treasury_yields, dict) else {},
        markets=markets,
        interest_rates=interest_rates,
        tax_metrics=tax_metrics,
        activity_metrics=activity_metrics,
        headlines=headlines,
    )

    return {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "economy": fred_data,
        "markets": markets,
        "us_economy_direction": economy_direction,
        "interest_rates": interest_rates,
        "tax_metrics": tax_metrics,
        "activity_metrics": activity_metrics,
        "treasury_yields": treasury_yields,
        "fiscal_meta": debt_interest_meta,
        "global_compare": {
            "gdp_usd_current": gdp_compare,
            "inflation_annual": inflation_compare,
        },
        "headlines": headlines,
        "sources": [
            "FRED public CSV endpoints (core macro + rates + fiscal + activity)",
            "US Treasury Fiscal Data API",
            "Yahoo Finance public market data",
            "Public RSS headlines (Yahoo / CNBC / Fed)",
        ],
    }
