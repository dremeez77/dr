"""Models, walk-forward out-of-sample prediction, metrics."""
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeRegressor

from .features import FEATURE_COLS


def make_model(kind):
    if kind == "linear":
        return make_pipeline(StandardScaler(), LinearRegression())
    if kind == "tree":
        return DecisionTreeRegressor(max_depth=3, min_samples_leaf=200, random_state=0)
    raise ValueError(f"unknown model kind: {kind}")


def walk_forward_predict(panel, kind, horizon=5, min_train_days=250, refit_every=60,
                         window=None, feature_cols=None):
    """Out-of-sample forecasts. Model refit every `refit_every` dates on data whose
    dates are < (first prediction date - horizon) in trading-date positions, so no train
    label (which looks `horizon` days ahead) overlaps the prediction period.
    window=None -> expanding; int -> rolling window of that many dates."""
    cols = list(feature_cols or FEATURE_COLS)
    dates = panel.index.get_level_values("date").unique().sort_values()
    d_all = panel.index.get_level_values("date")
    preds = []
    for i in range(min_train_days + horizon, len(dates), refit_every):
        train_end = i - horizon  # exclusive: train dates dates[:train_end]
        start = 0 if window is None else max(0, train_end - window)
        m_tr = (d_all >= dates[start]) & (d_all < dates[train_end])
        tr = panel[m_tr].dropna(subset=["target"])
        if len(tr) < 50:
            continue
        model = make_model(kind).fit(tr[cols].values, tr["target"].values)
        m_te = (d_all >= dates[i]) & (d_all <= dates[min(i + refit_every, len(dates)) - 1])
        te = panel[m_te]
        preds.append(pd.Series(model.predict(te[cols].values), index=te.index))
    if not preds:
        return pd.Series(dtype=float, name="pred")
    return pd.concat(preds).rename("pred")


def metrics(panel, pred):
    df = pd.concat([panel["target"].rename("y"), pred.rename("p")], axis=1, join="inner").dropna()
    y, p = df["y"], df["p"]
    err = p - y
    ss_res, ss_tot = (err ** 2).sum(), ((y - y.mean()) ** 2).sum()
    ranks = df.groupby(level="date").rank()
    ic = ranks.groupby(level="date").apply(lambda g: g["y"].corr(g["p"]) if len(g) > 2 and g["p"].nunique() > 1 and g["y"].nunique() > 1 else np.nan)
    return {
        "n": int(len(df)),
        "MAE": float(err.abs().mean()),
        "RMSE": float(np.sqrt((err ** 2).mean())),
        "R2": float(1 - ss_res / ss_tot) if ss_tot > 0 else float("nan"),
        "directional_accuracy": float((np.sign(p) == np.sign(y)).mean()),
        "IC": float(ic.mean()),
    }


def feature_importance(model, feature_cols=None):
    """Linear: absolute standardized coefficients are in .coef (signed); tree: feature_importances_.
    Returns Series sorted by magnitude."""
    cols = list(feature_cols or FEATURE_COLS)
    est = model.steps[-1][1] if hasattr(model, "steps") else model
    vals = est.coef_ if hasattr(est, "coef_") else est.feature_importances_
    s = pd.Series(np.ravel(vals), index=cols)
    return s.reindex(s.abs().sort_values(ascending=False).index)


def fit_full(panel, kind, feature_cols=None):
    """Fit on all labelled rows (for inspecting coefficients/importances)."""
    cols = list(feature_cols or FEATURE_COLS)
    tr = panel.dropna(subset=["target"])
    return make_model(kind).fit(tr[cols].values, tr["target"].values)
