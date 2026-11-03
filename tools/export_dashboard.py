"""Выгрузка CSV для веб-дашборда: python tools/export_dashboard.py <папка>."""
import warnings, json, sys; warnings.filterwarnings("ignore")
import pandas as pd, numpy as np
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
from robot import config
from robot.data import load_prices, load_macro
from robot.news import load_news_sentiment
from robot.features import build_panel
from robot.models import walk_forward_predict, metrics, fit_full, feature_importance
from robot.portfolio import signals_to_weights
from robot.backtest import run_backtest
OUT = sys.argv[1]
close, volume = load_prices()
macro = load_macro().reindex(close.index).ffill()
news = load_news_sentiment(list(close.columns), close.index)
panel = build_panel(close, volume, macro, news, horizon=config.HORIZON)
names = {"linear": "Линейная регрессия", "tree": "Дерево решений"}
eq, met, fc, wts, imp = {}, [], [], [], []
for kind, nm in names.items():
    pred = walk_forward_predict(panel, kind, horizon=config.HORIZON)
    m = metrics(panel, pred)
    w = signals_to_weights(pred.unstack("ticker").reindex(close.index), close)
    bt = run_backtest(w, close, index=macro["imoex"])
    eq[nm] = bt["equity"]; first = bt["first_active"]
    met.append({"model": nm, "IC": m["IC"], "directional_accuracy": m["directional_accuracy"], "R2": m["R2"], "MAE": m["MAE"], **{k: bt["metrics"][k] for k in ["CAGR","vol","Sharpe","Sortino","MaxDD","Calmar","turnover"]}})
    # latest forecast with full-sample model
    mdl = fit_full(panel, kind)
    last = panel.index.get_level_values("date").max()
    X = panel.xs(last, level="date")
    from robot.features import FEATURE_COLS
    p = mdl.predict(X[FEATURE_COLS])
    for t, v in zip(X.index, p): fc.append({"ticker": t, "model": nm, "forecast_5d": float(np.expm1(v))})
    lw = w.dropna(how="all").iloc[-1]
    for t, v in lw.items(): wts.append({"ticker": t, "model": nm, "weight": float(v)})
    wts.append({"ticker": "Кэш", "model": nm, "weight": float(max(0, 1 - lw.sum()))})
    fi = feature_importance(mdl)
    fi = fi.head(10) if isinstance(fi, pd.Series) else fi.iloc[:10, 0]
    for f, v in fi.items(): imp.append({"model": nm, "feature": f, "value": float(v)})
for k, lab in [("equal_weight", "Равные веса"), ("index", "Индекс IMOEX")]:
    b = bt["benchmarks"].get(k)
    if b is None: continue
    eq[lab] = b["equity"] if isinstance(b, dict) else b
    if isinstance(b, dict) and "metrics" in b:
        met.append({"model": lab, **{kk: b["metrics"].get(kk) for kk in ["CAGR","vol","Sharpe","Sortino","MaxDD","Calmar","turnover"]}})
E = pd.DataFrame(eq).dropna(how="all")
E = E[E.index >= first].ffill().dropna()
E = E / E.iloc[0]
E.index.name = "date"
E.reset_index().melt("date", var_name="series", value_name="equity").assign(date=lambda d: d.date.dt.strftime("%Y-%m-%d")).round(5).to_csv(f"{OUT}/equity.csv", index=False)
pd.DataFrame(met).round(5).to_csv(f"{OUT}/metrics.csv", index=False)
F = pd.DataFrame(fc); W = pd.DataFrame(wts)
F.round(5).to_csv(f"{OUT}/forecasts.csv", index=False)
W.round(4).to_csv(f"{OUT}/weights.csv", index=False)
pd.DataFrame(imp).round(5).to_csv(f"{OUT}/importance.csv", index=False)
print("asof", last.date(), "first", first, E.shape)
print(pd.DataFrame(met).round(3).to_string()); print(F.pivot(index="ticker", columns="model", values="forecast_5d").round(4)); print(W.pivot(index="ticker", columns="model", values="weight").round(3))
print(pd.DataFrame(imp).head(20))
