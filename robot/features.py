"""Feature panel construction. All features at date t use data up to t (close of t) only."""
import numpy as np
import pandas as pd

LAGS = (1, 5, 10, 20)
FEATURE_COLS = (
    [f"ret_{l}d" for l in LAGS]
    + ["vol_10d", "vol_20d", "rsi_14", "macd", "macd_hist",
       "sma_ratio_10", "sma_ratio_20", "sma_ratio_50", "volume_z",
       "rel_imoex_5d", "rel_imoex_20d",
       "usdrub_ret_5d", "key_rate_chg_20d", "imoex_ret_1d", "imoex_ret_5d",
       "news_ticker", "news_market"]
)


def _rsi(close, n=14):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    return rsi.where(dn != 0, 100.0)


def build_panel(close, volume, macro, news, horizon=5):
    """Returns DataFrame indexed (date, ticker) with FEATURE_COLS + 'target'
    (log(close[t+horizon]/close[t])). Rows with NaN features are dropped; rows whose
    target is not yet known (last `horizon` dates) are kept with NaN target."""
    close = close.sort_index().astype(float)
    idx = close.index
    volume = volume.reindex(index=idx, columns=close.columns).astype(float)
    macro = macro.sort_index().reindex(idx).ffill()
    lc = np.log(close)
    f = {}
    for l in LAGS:
        f[f"ret_{l}d"] = lc.diff(l)
    r1 = lc.diff()
    f["vol_10d"] = r1.rolling(10).std()
    f["vol_20d"] = r1.rolling(20).std()
    f["rsi_14"] = _rsi(close) / 100.0
    ema12, ema26 = close.ewm(span=12, adjust=False).mean(), close.ewm(span=26, adjust=False).mean()
    macd = (ema12 - ema26) / close
    sig = macd.ewm(span=9, adjust=False).mean()
    f["macd"], f["macd_hist"] = macd, macd - sig
    for n in (10, 20, 50):
        f[f"sma_ratio_{n}"] = close / close.rolling(n).mean() - 1
    lv = np.log1p(volume)
    f["volume_z"] = (lv - lv.rolling(20).mean()) / lv.rolling(20).std().replace(0, np.nan)

    imoex = np.log(macro["imoex"].astype(float))
    for n in (5, 20):
        f[f"rel_imoex_{n}d"] = lc.diff(n).sub(imoex.diff(n), axis=0)

    def bcast(s):  # series -> same value for all tickers
        return pd.DataFrame({c: s for c in close.columns}, index=idx)

    f["usdrub_ret_5d"] = bcast(np.log(macro["usdrub"].astype(float)).diff(5))
    f["key_rate_chg_20d"] = bcast(macro["key_rate"].astype(float).diff(20))
    f["imoex_ret_1d"] = bcast(imoex.diff(1))
    f["imoex_ret_5d"] = bcast(imoex.diff(5))

    # news: lag one day (news of day t may be published after the close)
    news = news.reindex(idx).fillna(0.0).shift(1).fillna(0.0)
    nt = news.reindex(columns=close.columns).fillna(0.0)
    nm = news["market"] if "market" in news else pd.Series(0.0, index=idx)
    f["news_ticker"] = nt
    f["news_market"] = bcast(nm)

    target = lc.shift(-horizon) - lc

    def st(df):
        s = df.stack(future_stack=True) if hasattr(df, "stack") else df
        return s
    frames = {k: v.rename_axis(index="date", columns="ticker").stack(future_stack=True) for k, v in f.items()}
    frames["target"] = target.rename_axis(index="date", columns="ticker").stack(future_stack=True)
    panel = pd.DataFrame(frames)[FEATURE_COLS + ["target"]]
    panel = panel.replace([np.inf, -np.inf], np.nan)
    panel = panel.dropna(subset=FEATURE_COLS)
    return panel.sort_index()
