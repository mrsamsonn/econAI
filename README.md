# US Economy Live Monitor

React + FastAPI dashboard for near-live US economy monitoring using free data sources.

Inspired by a live crisis-monitor style dashboard ([Strait of Hormuz Live Tracker](https://hormuzstraitmonitor.com/)), but expanded to broader US-economic risk and performance signals.

## Stack

- Frontend: React (Vite)
- Backend: FastAPI
- Python env: `venv` + `requirements.txt`
- Data sources (free):
  - FRED public CSV endpoints
  - US Treasury Fiscal Data API
  - Yahoo Finance public market data (via `yfinance`)

## 1) Backend Setup (venv + requirements.txt)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Backend runs at `http://127.0.0.1:8000`.

## 2) Frontend Setup (React)

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://127.0.0.1:5173`.

## API endpoint

- `GET /api/dashboard`
  - `economy`: macro series snapshots (CPI, unemployment, payrolls, GDP, Fed funds, initial claims)
  - `markets`: market/risk instruments (SPY, VIX, DXY, WTI, gold, BTC)
  - `treasury_yields`: latest US treasury curve tenors
  - `sources`: source list

## Suggested next expansions (all free-friendly)

- Freight/shipping proxies (Baltic Dry / container indexes where accessible)
- Housing (Case-Shiller, mortgage rates, permits)
- Consumer stress (delinquencies, credit card rates, savings rates)
- Real-time news sentiment and policy event feed
- Alerting thresholds (yield inversion, VIX spikes, oil shock triggers)
