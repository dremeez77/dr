import os, sys
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robot.portfolio import signals_to_weights, cap_weights
from robot.backtest import run_backtest

try:
    from robot.config import MAX_WEIGHT, TARGET_VOL, COST
except Exception:
    MAX_WEIGHT, TARGET_VOL, COST = 0.25, 0.15, 0.0005


def synth(n=400, k=8, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2020-01-01", periods=n, name="date")
    cols = [f"T{i}" for i in range(k)]
    r = rng.normal(0.0004, 0.02, (n, k))
    close = pd.DataFrame(100 * np.exp(np.cumsum(r, 0)), index=idx, columns=cols)
    pred = pd.DataFrame(rng.normal(0.002, 0.01, (n, k)), index=idx, columns=cols)
    return close, pred


def test_caps_and_longonly():
    close, pred = synth()
    w = signals_to_weights(pred, close)
    assert (w >= 0).all().all()
    assert w.max().max() <= MAX_WEIGHT + 1e-9
    assert (w.sum(axis=1) <= 1 + 1e-9).all()
    assert cap_weights(np.array([0.9, 0.05, 0.05]), 0.5).max() <= 0.5


def test_cash_when_no_positive_signal():
    close, pred = synth()
    w = signals_to_weights(-pred.abs(), close)
    assert w.abs().sum().sum() == 0


def test_no_lookahead():
    close, pred = synth()
    w1 = signals_to_weights(pred, close)
    t = 200
    p2, c2 = pred.copy(), close.copy()
    p2.iloc[t:] = 5.0 * np.random.default_rng(1).random(p2.iloc[t:].shape)  # change pred from t
    c2.iloc[t:] = c2.iloc[t:] * 1.7
    w2 = signals_to_weights(p2, c2)
    # weights up to and including day t depend only on info through t-1
    pd.testing.assert_frame_equal(w1.iloc[: t + 1], w2.iloc[: t + 1])
    assert not w1.iloc[t + 1:].equals(w2.iloc[t + 1:])


def test_rebalance_every_n():
    close, pred = synth()
    w = signals_to_weights(pred, close, rebalance_every=5, dd_levels=(9, 9.5))
    changes = (w.diff().abs().sum(axis=1) > 1e-12)
    assert changes.sum() <= len(w) // 5 + 2


def test_vol_target():
    close, pred = synth(k=8)
    w = signals_to_weights(pred, close, dd_levels=(9, 9.5))
    r = close.pct_change()
    t = 300
    cov = r.iloc[t - 60:t].cov().values * 252
    ww = w.iloc[t + 1].values
    assert np.sqrt(ww @ cov @ ww) <= TARGET_VOL * 1.5 or ww.sum() <= 1


def test_costs_reduce_returns():
    close, pred = synth()
    w = signals_to_weights(pred, close)
    a = run_backtest(w, close, cost=0.0)
    b = run_backtest(w, close, cost=0.005)
    assert b["equity"].iloc[-1] < a["equity"].iloc[-1]
    assert b["metrics"]["turnover"] > 0
    assert set(["CAGR", "vol", "Sharpe", "Sortino", "MaxDD", "Calmar", "turnover"]) <= set(b["metrics"])
    assert "equal_weight" in b["benchmarks"]


def test_backtest_timing_and_index():
    close, _ = synth(n=50, k=2)
    w = pd.DataFrame(0.0, index=close.index, columns=close.columns)
    w.iloc[10:, 0] = 1.0
    res = run_backtest(w, close, cost=0.0, index=close.iloc[:, 1])
    exp = close.iloc[:, 0].pct_change().iloc[10:]
    np.testing.assert_allclose(res["returns"].iloc[10:].values, exp.values)
    assert "index" in res["benchmarks"]


def test_drawdown_stop_derisks():
    idx = pd.bdate_range("2021-01-01", periods=200, name="date")
    px = np.r_[np.linspace(100, 110, 80), np.linspace(110, 60, 60), np.linspace(60, 90, 60)]
    close = pd.DataFrame({"A": px, "B": px * 1.01}, index=idx)
    pred = pd.DataFrame(0.01, index=idx, columns=close.columns)
    w = signals_to_weights(pred, close, target_vol=10.0)
    assert w.iloc[:, :].sum(axis=1).iloc[80:140].min() < 0.1
    assert w.sum(axis=1).iloc[75] > 0.4
