"""Backtest of tradeable (already lagged) weights; see portfolio.py."""
import numpy as np
import pandas as pd

try:
    from robot import config as _cfg
except Exception:  # pragma: no cover
    try:
        import config as _cfg
    except Exception:
        _cfg = None

COST = getattr(_cfg, "COST", 0.0005)


def compute_metrics(r: pd.Series, turnover: float = float("nan")) -> dict:
    r = r.dropna()
    if len(r) < 2:
        return {k: float("nan") for k in ("CAGR", "vol", "Sharpe", "Sortino", "MaxDD", "Calmar", "turnover")}
    eq = (1 + r).cumprod()
    years = len(r) / 252.0
    cagr = eq.iloc[-1] ** (1 / years) - 1 if eq.iloc[-1] > 0 else -1.0
    vol = r.std() * np.sqrt(252)
    sharpe = r.mean() * 252 / vol if vol > 0 else float("nan")
    dn = np.sqrt((np.minimum(r, 0) ** 2).mean()) * np.sqrt(252)
    sortino = r.mean() * 252 / dn if dn > 0 else float("nan")
    mdd = (eq / eq.cummax() - 1).min()
    calmar = cagr / abs(mdd) if mdd < 0 else float("nan")
    return {"CAGR": float(cagr), "vol": float(vol), "Sharpe": float(sharpe),
            "Sortino": float(sortino), "MaxDD": float(mdd), "Calmar": float(calmar),
            "turnover": float(turnover)}


def run_backtest(weights, close, cost=None, index=None, lag=0):
    """weights[t] = position held over day t's return (already lagged by
    signals_to_weights). `lag` adds extra shift if raw same-day weights are passed
    (use lag=1 then). index: optional index level Series (e.g. IMOEX) as benchmark.
    Cost = cost * sum|dw| per day (applied on the day of the position change).
    Returns dict(equity, returns, metrics, turnover, benchmarks)."""
    cost = COST if cost is None else cost
    close = close.sort_index()
    rets = close.pct_change().fillna(0.0)
    w = weights.reindex(index=rets.index, columns=rets.columns).fillna(0.0)
    if lag:
        w = w.shift(lag).fillna(0.0)
    # weights drift between rebalances; trading only when target changes
    turn = w.diff().abs().sum(axis=1)
    turn.iloc[0] = w.iloc[0].abs().sum()
    gross = (w * rets).sum(axis=1)
    net = gross - cost * turn
    equity = (1 + net).cumprod()
    out = {
        "equity": equity, "returns": net, "gross_returns": gross,
        "weights": w, "turnover_series": turn,
        "metrics": compute_metrics(net, turn.mean()),
    }
    start = w.abs().sum(axis=1).gt(0).values.argmax() if (w.abs().sum(axis=1) > 0).any() else 0
    ew = rets.mean(axis=1).copy()          # equal-weight buy&hold (no rebalance)
    ew_eq = (1 + rets).cumprod().mean(axis=1)
    ew = ew_eq.pct_change().fillna(0.0)
    bench = {"equal_weight": {"equity": ew_eq / ew_eq.iloc[0], "returns": ew,
                              "metrics": compute_metrics(ew)}}
    if index is not None:
        ix = pd.Series(index).sort_index().reindex(rets.index).ffill()
        ir = ix.pct_change().fillna(0.0)
        bench["index"] = {"equity": (1 + ir).cumprod(), "returns": ir,
                          "metrics": compute_metrics(ir)}
    out["benchmarks"] = bench
    out["first_active"] = rets.index[start]
    return out
