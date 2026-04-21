from datetime import datetime, timezone
from io import StringIO
from typing import Any, Dict, List, Optional
from xml.etree import ElementTree as ET

import httpx
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

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


async def fetch_fred_series(
    client: httpx.AsyncClient, series_id: str, label: str
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

        return {
            "series_id": series_id,
            "label": label,
            "latest_date": str(latest["date"]),
            "latest_value": float(latest["value"]),
            "change": change,
            "pct_change": pct_change,
            "history": df.tail(240).to_dict(orient="records"),
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


def classify_headline(title: str) -> Dict[str, str]:
    text = title.lower()
    if any(k in text for k in ["inflation", "prices rise", "hot cpi", "overheat"]):
        return {"impact_area": "Inflation", "direction": "negative", "color": "red"}
    if any(k in text for k in ["layoffs", "unemployment", "job cuts", "claims rise"]):
        return {"impact_area": "Labor Market", "direction": "negative", "color": "red"}
    if any(k in text for k in ["gdp growth", "job gains", "productivity", "soft landing"]):
        return {"impact_area": "Growth", "direction": "positive", "color": "green"}
    if any(k in text for k in ["oil", "crude", "shipping", "freight", "hormuz"]):
        return {"impact_area": "Energy/Supply", "direction": "mixed", "color": "yellow"}
    if any(k in text for k in ["fed", "rates", "treasury", "bond yields"]):
        return {"impact_area": "Monetary Policy", "direction": "mixed", "color": "yellow"}
    return {"impact_area": "General Macro", "direction": "mixed", "color": "yellow"}


async def fetch_headlines(client: httpx.AsyncClient) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
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
                classification = classify_headline(title)
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


def compute_us_economy_direction(
    economy: List[Dict[str, Any]],
    treasury_yields: Dict[str, Any],
    markets: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Heuristic 0–100 pulse from public series already on the dashboard.
    Not a forecast — a compact read of recent momentum + yield curve shape.
    """
    components: List[Dict[str, Any]] = []
    score = 50.0

    def add_component(name: str, delta: float, detail: str) -> None:
        nonlocal score
        score += delta
        components.append({"name": name, "delta": round(delta, 1), "detail": detail})

    payems = _fred_row(economy, "PAYEMS")
    if payems.get("change") is not None:
        ch = float(payems["change"])
        if ch > 0:
            add_component("Payrolls (PAYEMS)", 8, "Payrolls rose vs prior print")
        elif ch < 0:
            add_component("Payrolls (PAYEMS)", -8, "Payrolls fell vs prior print")

    unrate = _fred_row(economy, "UNRATE")
    if unrate.get("change") is not None:
        ch = float(unrate["change"])
        if ch < 0:
            add_component("Unemployment (UNRATE)", 8, "Unemployment rate edged down")
        elif ch > 0:
            add_component("Unemployment (UNRATE)", -8, "Unemployment rate rose")

    icsa = _fred_row(economy, "ICSA")
    if icsa.get("change") is not None:
        ch = float(icsa["change"])
        if ch < 0:
            add_component("Jobless claims (ICSA)", 6, "Initial claims declined vs prior week")
        elif ch > 0:
            add_component("Jobless claims (ICSA)", -6, "Initial claims rose vs prior week")

    gdp = _fred_row(economy, "GDPC1")
    if gdp.get("change") is not None:
        ch = float(gdp["change"])
        if ch > 0:
            add_component("Real GDP (GDPC1)", 10, "Real GDP rose vs prior quarter")
        elif ch < 0:
            add_component("Real GDP (GDPC1)", -12, "Real GDP contracted vs prior quarter")

    cpi = _fred_row(economy, "CPIAUCSL")
    if cpi.get("pct_change") is not None:
        pc = float(cpi["pct_change"])
        if pc > 0.35:
            add_component("CPI (CPIAUCSL)", -4, "MoM CPI increase looks firm")
        elif pc < -0.05:
            add_component("CPI (CPIAUCSL)", 3, "MoM CPI cooled vs prior month")

    y10 = treasury_yields.get("10y")
    y2 = treasury_yields.get("2y")
    if y10 is not None and y2 is not None:
        spread = float(y10) - float(y2)
        if spread < -0.1:
            add_component("Yield curve (10Y − 2Y)", -14, "Curve inverted — classic late-cycle signal")
        elif spread < 0.25:
            add_component("Yield curve (10Y − 2Y)", -4, "Curve is flat — growth doubts")
        elif spread < 0.75:
            add_component("Yield curve (10Y − 2Y)", 4, "Curve modestly positive")
        else:
            add_component("Yield curve (10Y − 2Y)", 10, "Curve steep — markets pricing better growth / term premium")

    spy = _market_row(markets, "SPY")
    if spy.get("pct_change") is not None:
        pc = float(spy["pct_change"])
        if pc > 0.25:
            add_component("Risk assets (SPY)", 5, "S&P 500 ETF up vs prior session")
        elif pc < -0.35:
            add_component("Risk assets (SPY)", -5, "S&P 500 ETF down vs prior session")

    vix = _market_row(markets, "^VIX")
    if vix.get("pct_change") is not None:
        pc = float(vix["pct_change"])
        if pc < -3:
            add_component("Volatility (VIX)", 4, "VIX fell — calmer risk pricing")
        elif pc > 5:
            add_component("Volatility (VIX)", -5, "VIX jumped — risk-off tone")

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
        "verdict": verdict,
        "band": band,
        "components": components,
        "method": "Heuristic blend of latest FRED deltas, 10Y−2Y spread, and SPY/VIX session moves.",
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
        headlines = await fetch_headlines(client)

    economy_direction = compute_us_economy_direction(
        economy=fred_data,
        treasury_yields=treasury_yields if isinstance(treasury_yields, dict) else {},
        markets=markets,
    )

    return {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "economy": fred_data,
        "markets": markets,
        "us_economy_direction": economy_direction,
        "treasury_yields": treasury_yields,
        "fiscal_meta": debt_interest_meta,
        "global_compare": {
            "gdp_usd_current": gdp_compare,
            "inflation_annual": inflation_compare,
        },
        "headlines": headlines,
        "sources": [
            "FRED public CSV endpoints",
            "US Treasury Fiscal Data API",
            "Yahoo Finance public market data",
            "Reuters/AP public RSS feeds",
        ],
    }
