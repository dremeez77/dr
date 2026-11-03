"""Portfolio construction: forecasts -> long-only weights.

Output convention: the returned weights are TRADEABLE and already lagged by one
day: row t is the position held over day t's close-to-close return, decided
using information available at the close of day t-1 or earlier.
run_backtest therefore applies them to same-day returns without shifting.
"""
import numpy as np
import pandas as pd

try:
    from robot import config as _cfg
except Exception:  # pragma: no cover
    try:
        import config as _cfg
    except Exception:
        _cfg = None

MAX_WEIGHT = getattr(_cfg, "MAX_WEIGHT", 0.25)
TARGET_VOL = getattr(_cfg, "TARGET_VOL", 0.15)


def cap_weights(w: np.ndarray, cap: float) -> np.ndarray:
    """Cap each weight at `cap`, redistributing excess among uncapped names.
    Sum stays 1 if feasible (n*cap >= 1), else all names sit at cap (rest cash)."""
    w = np.asarray(w, dtype=float).copy()
    for _ in range(len(w) + 1):
        over = w > cap + 1e-12
        if not over.any():
            break
        excess = (w[over] - cap).sum()
        w[over] = cap
        free = (~over) & (w > 0) & (w < cap - 1e-12)
        if not free.any():
            break
        w[free] += excess * w[free] / w[free].sum()
    return np.minimum(w, cap)


def _target_weights(score: pd.Series, rets: pd.DataFrame, max_weight, target_vol, vol_window):
    """Target weights from one day's forecasts, using returns up to that day."""
    n = len(score)
    w = np.zeros(n)
    s = score.fillna(0.0).clip(lower=0.0).values
    if s.sum() <= 0:
        return pd.Series(w, index=score.index)
    w = cap_weights(s / s.sum(), max_weight)
    hist = rets.reindex(columns=score.index).tail(vol_window)
    if len(hist) >= max(20, vol_window // 3):
        cov = hist.fillna(0.0).cov().values * 252.0
        var = float(w @ cov @ w)
        if var > 0:
            w = w * min(1.0, target_vol / np.sqrt(var))
    return pd.Series(w, index=score.index)


def signals_to_weights(pred, close, max_weight=None, target_vol=None,
                       rebalance_every=5, vol_window=60,
                       dd_levels=(0.10, 0.20), dd_scales=(0.5, 0.0),
                       recover_frac=0.5):
    """pred: DataFrame[date x ticker] forecast forward returns; close: prices.

    Long-only; positive forecasts only; score-proportional; per-name cap;
    vol targeting (trailing `vol_window` cov, gross <= 1, rest cash); rebalance
    every `rebalance_every` days; drawdown stop on the unscaled ("paper")
    strategy equity: exposure x dd_scales[0] when DD > dd_levels[0], x dd_scales[1]
    when DD > dd_levels[1]; step back up once DD < level*recover_frac.
    Result is shifted one day (no look-ahead)."""
    max_weight = MAX_WEIGHT if max_weight is None else max_weight
    target_vol = TARGET_VOL if target_vol is None else target_vol
    close = close.sort_index()
    tickers = list(close.columns)
    pred = pred.reindex(index=close.index, columns=tickers)
    rets = close.pct_change()
    idx = close.index
    n = len(idx)

    # target decided at close of day i (only on rebalance days, held in between)
    tgt = np.zeros((n, len(tickers)))
    cur = np.zeros(len(tickers))
    first = pred.notna().any(axis=1).values.argmax() if pred.notna().any().any() else n
    for i in range(n):
        if i >= first and (i - first) % rebalance_every == 0:
            cur = _target_weights(pred.iloc[i], rets.iloc[: i + 1], max_weight,
                                  target_vol, vol_window).values
        tgt[i] = cur

    out = np.zeros_like(tgt)
    r = rets.fillna(0.0).values
    paper, peak, level = 1.0, 1.0, 0  # level: 0 full, 1 reduced, 2 flat
    l1, l2 = dd_levels
    for i in range(1, n):
        scale = (1.0, dd_scales[0], dd_scales[1])[level]
        out[i] = tgt[i - 1] * scale           # decided at close i-1
        paper *= 1.0 + float(tgt[i - 1] @ r[i])
        peak = max(peak, paper)
        dd = 1.0 - paper / peak
        # state update at close i, effective for day i+1
        if dd > l2:
            level = 2
        elif level == 2 and dd < l2 * recover_frac:
            level = 1
        if level == 1 and dd < l1 * recover_frac:
            level = 0
        elif level == 0 and dd > l1:
            level = 1
    return pd.DataFrame(out, index=idx, columns=tickers)
