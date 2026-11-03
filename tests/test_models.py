import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from robot.features import build_panel, FEATURE_COLS
from robot.models import walk_forward_predict, metrics, make_model, fit_full, feature_importance

H = 5


def synth(n=900, k=6, seed=0, signal=0.0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2019-01-01", periods=n, name="date")
    tk = [f"T{i}" for i in range(k)]
    r = rng.normal(0, 0.015, (n, k))
    if signal:  # predictable: today's return follows lagged 5d momentum
        for t in range(6, n):
            r[t] += signal * r[t - 5:t].mean(0)
    close = pd.DataFrame(100 * np.exp(r.cumsum(0)), idx, tk)
    vol = pd.DataFrame(rng.integers(1e5, 1e6, (n, k)).astype(float), idx, tk)
    macro = pd.DataFrame({"imoex": 3000 * np.exp(rng.normal(0, .01, n).cumsum()),
                          "usdrub": 70 * np.exp(rng.normal(0, .005, n).cumsum()),
                          "key_rate": np.round(10 + rng.normal(0, .02, n).cumsum(), 2)}, idx)
    news = pd.DataFrame(rng.uniform(-1, 1, (n, k + 1)), idx, tk + ["market"])
    return close, vol, macro, news


def test_no_lookahead_features():
    c, v, m, n = synth()
    full = build_panel(c, v, m, n, H)
    cut = c.index[500]
    part = build_panel(c[:cut], v[:cut], m[:cut], n[:cut], H)
    a = full.loc[full.index.get_level_values(0) <= cut, FEATURE_COLS]
    b = part[FEATURE_COLS]
    pd.testing.assert_frame_equal(a.loc[b.index], b)  # truncating the future leaves features unchanged
    assert full.index.names == ["date", "ticker"]
    # target definition
    d, t = c.index[300], "T0"
    assert np.isclose(full.loc[(d, t), "target"], np.log(c[t].iloc[305] / c[t].iloc[300]))


def test_runs_and_oos_only():
    c, v, m, n = synth()
    p = build_panel(c, v, m, n, H)
    for kind in ("linear", "tree"):
        pr = walk_forward_predict(p, kind, horizon=H)
        assert len(pr) > 0
        first = pr.index.get_level_values(0).min()
        assert first > p.index.get_level_values(0).unique()[250]
        mt = metrics(p, pr)
        assert set(mt) >= {"MAE", "RMSE", "R2", "directional_accuracy", "IC"}
        print(kind, mt)
        assert abs(mt["IC"]) < 0.15 and mt["R2"] < 0.02  # random walk: no skill
        imp = feature_importance(fit_full(p, kind))
        assert len(imp) == len(FEATURE_COLS)


def test_no_leakage_future_shuffle():
    c, v, m, n = synth(seed=1, signal=0.0)
    p = build_panel(c, v, m, n, H)
    base = walk_forward_predict(p, "linear", horizon=H)
    # corrupt targets only in the future of the last refit: earlier predictions must not change
    cut = base.index.get_level_values(0).unique()[-70]
    p2 = p.copy()
    dts = p2.index.get_level_values(0)
    rng = np.random.default_rng(0)
    p2.loc[dts >= cut, "target"] = rng.permutation(p2.loc[dts >= cut, "target"].values)
    alt = walk_forward_predict(p2, "linear", horizon=H)
    early = base[base.index.get_level_values(0) < cut - pd.Timedelta(days=1) * 0]
    # predictions for dates before cut - refit block cannot depend on targets at >= cut
    ok = base.index.get_level_values(0) < cut - pd.offsets.BDay(70)
    pd.testing.assert_series_equal(base[ok], alt.reindex(base.index)[ok])


def test_signal_detected_when_present():
    c, v, m, n = synth(seed=2, signal=0.0)
    p = build_panel(c, v, m, n, H)
    # inject genuinely predictive feature: target driven by ret_5d of the past
    rng = np.random.default_rng(3)
    p = p.copy()
    p["target"] = 0.3 * p["ret_5d"] + rng.normal(0, .01, len(p))
    pr = walk_forward_predict(p, "linear", horizon=H)
    assert metrics(p, pr)["IC"] > 0.3


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
