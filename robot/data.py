"""Market and macro data loaders (MOEX ISS, CBR) with CSV caching.

All frames have a tz-naive daily DatetimeIndex named "date". Network failures
never raise: the loader falls back to the cached CSV (or an empty frame).
"""
import os
import re
import time
import logging
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from io import StringIO

import pandas as pd
import requests

from .config import TICKERS, YEARS, DATA_DIR, HTTP_TIMEOUT, HTTP_RETRIES, USER_AGENT

log = logging.getLogger(__name__)
ISS = "https://iss.moex.com/iss/engines/stock/markets"
CACHE_MAX_AGE_H = 12


def _get(url, params=None, retries=HTTP_RETRIES):
    """GET with retries/backoff; returns Response or None."""
    for i in range(retries):
        try:
            r = requests.get(url, params=params, timeout=HTTP_TIMEOUT,
                             headers={"User-Agent": USER_AGENT})
            if r.status_code == 200:
                return r
            log.warning("HTTP %s for %s", r.status_code, url)
        except requests.RequestException as e:
            log.warning("request failed (%s/%s) %s: %s", i + 1, retries, url, e)
        time.sleep(1.5 * (i + 1))
    return None


def _path(name):
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, name)


def _read_cache(path):
    try:
        df = pd.read_csv(path, index_col=0, parse_dates=True)
        df.index.name = "date"
        return df
    except Exception:
        return None


def _fresh(path):
    return os.path.exists(path) and (time.time() - os.path.getmtime(path)) < CACHE_MAX_AGE_H * 3600


def _fetch_candles(url, start_date):
    """Paginated ISS candles (interval=24) -> DataFrame[date, close, volume]."""
    rows, start = [], 0
    while True:
        r = _get(url, {"interval": 24, "from": start_date, "start": start})
        if r is None:
            break
        try:
            c = r.json()["candles"]
            cols, data = c["columns"], c["data"]
        except Exception:
            break
        if not data:
            break
        rows.extend(data)
        start += len(data)
        if len(data) < 500:
            break
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=cols)
    df["date"] = pd.to_datetime(df["begin"]).dt.normalize()
    df = df.drop_duplicates("date").set_index("date").sort_index()
    return df[["close", "volume"]].astype(float)


def _start_date(years):
    return (date.today() - timedelta(days=int(365.25 * years) + 10)).isoformat()


def _load_candles(name, url, years, force=False):
    path = _path(f"{name}.csv")
    if not force and _fresh(path):
        df = _read_cache(path)
        if df is not None and len(df):
            return df
    df = _fetch_candles(url, _start_date(years))
    if df is not None and len(df):
        df.to_csv(path)
        return df
    log.warning("fetch failed for %s, using cache", name)
    return _read_cache(path)


def load_prices(tickers=TICKERS, years=YEARS):
    """Daily close and volume from MOEX ISS board TQBR.

    Returns (close, volume): DataFrames [date x ticker]. Tickers that cannot be
    loaded (and have no cache) are skipped. Rows where all tickers are NaN are
    dropped; gaps are forward-filled in close (volume gaps -> 0).
    """
    closes, vols = {}, {}
    for t in tickers:
        url = f"{ISS}/shares/boards/TQBR/securities/{t}/candles.json"
        df = _load_candles(f"price_{t}", url, years)
        if df is None or df.empty:
            log.warning("no data for %s", t)
            continue
        closes[t], vols[t] = df["close"], df["volume"]
    if not closes:
        e = pd.DataFrame(index=pd.DatetimeIndex([], name="date"))
        return e, e.copy()
    close = pd.DataFrame(closes).sort_index().dropna(how="all").ffill()
    volume = pd.DataFrame(vols).reindex(close.index).fillna(0.0)
    close.index.name = volume.index.name = "date"
    cutoff = pd.Timestamp(_start_date(years))
    return close[close.index >= cutoff], volume[volume.index >= cutoff]


def _fetch_usdrub(d1, d2):
    r = _get("https://www.cbr.ru/scripts/XML_dynamic.asp",
             {"date_req1": d1.strftime("%d/%m/%Y"), "date_req2": d2.strftime("%d/%m/%Y"),
              "VAL_NM_RQ": "R01235"})
    if r is None:
        return None
    try:
        root = ET.fromstring(r.content)  # honours windows-1251 declaration
        out = {}
        for rec in root.iter("Record"):
            v = float(rec.find("Value").text.replace(",", ".").replace("\xa0", ""))
            n = float(rec.find("Nominal").text.replace(",", "."))
            out[pd.to_datetime(rec.get("Date"), format="%d.%m.%Y")] = v / n
        return pd.Series(out, name="usdrub").sort_index()
    except Exception as e:
        log.warning("usdrub parse failed: %s", e)
        return None


def _fetch_keyrate(d1, d2):
    r = _get("https://www.cbr.ru/hd_base/KeyRate/",
             {"UniDbQuery.Posted": "True", "UniDbQuery.From": d1.strftime("%d.%m.%Y"),
              "UniDbQuery.To": d2.strftime("%d.%m.%Y")})
    if r is None:
        return None
    try:
        rows = re.findall(r"<td>\s*(\d{2}\.\d{2}\.\d{4})\s*</td>\s*<td>\s*([\d,\.]+)\s*</td>", r.text)
        if not rows:
            return None
        s = pd.Series({pd.to_datetime(d, format="%d.%m.%Y"): float(v.replace(",", "."))
                       for d, v in rows}, name="key_rate").sort_index()
        return s
    except Exception as e:
        log.warning("key rate parse failed: %s", e)
        return None


def _cached_series(name, fetch, d1, d2):
    path = _path(f"macro_{name}.csv")
    if _fresh(path):
        c = _read_cache(path)
        if c is not None and len(c):
            return c[name]
    s = fetch(d1, d2)
    if s is not None and len(s):
        s.to_frame().to_csv(path)
        return s
    c = _read_cache(path)
    return c[name] if c is not None and name in c else None


def load_macro(years=YEARS):
    """Macro frame [date] with columns imoex, usdrub, key_rate (forward-filled).

    imoex: IMOEX index close (MOEX ISS); usdrub: official CBR USD rate;
    key_rate: CBR key rate, %. Missing sources yield NaN columns (the pipeline
    does not crash); the index is a business-day calendar over the period.
    """
    d2 = date.today()
    d1 = d2 - timedelta(days=int(365.25 * years) + 10)
    imoex = _load_candles("macro_imoex", f"{ISS}/index/securities/IMOEX/candles.json", years)
    imoex = imoex["close"].rename("imoex") if imoex is not None else None
    usd = _cached_series("usdrub", _fetch_usdrub, d1, d2)
    kr = _cached_series("key_rate", _fetch_keyrate, d1, d2)
    parts = [s for s in (imoex, usd, kr) if s is not None]
    idx = pd.bdate_range(d1, d2, name="date")
    out = pd.DataFrame(index=idx, columns=["imoex", "usdrub", "key_rate"], dtype=float)
    for name, s in (("imoex", imoex), ("usdrub", usd), ("key_rate", kr)):
        if s is not None:
            s = s[~s.index.duplicated(keep="last")].sort_index()
            # union with series' own dates so earlier observations (e.g. rate set before d1) seed ffill
            out[name] = s.reindex(out.index.union(s.index)).ffill().reindex(out.index)
    out = out.ffill().bfill()
    if not parts:
        log.warning("no macro data available")
    out.index.name = "date"
    return out
