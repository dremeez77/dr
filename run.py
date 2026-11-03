"""Алгоритмический робот-инвестор: прогноз цен (линейная регрессия, дерево решений) + портфель с рисками."""
import os
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from robot import config
from robot.data import load_prices, load_macro
from robot.news import load_news_sentiment
from robot.features import build_panel, FEATURE_COLS
from robot.models import walk_forward_predict, metrics, fit_full, feature_importance
from robot.portfolio import signals_to_weights
from robot.backtest import run_backtest

os.makedirs("reports", exist_ok=True)
close, volume = load_prices()
macro = load_macro().reindex(close.index).ffill()
news = load_news_sentiment(list(close.columns), close.index)
panel = build_panel(close, volume, macro, news, horizon=config.HORIZON)

rows, curves, md = [], {}, []
for kind, name in [("linear", "Линейная регрессия"), ("tree", "Дерево решений")]:
    pred = walk_forward_predict(panel, kind, horizon=config.HORIZON)
    m = metrics(panel, pred)
    w = signals_to_weights(pred.unstack("ticker").reindex(close.index), close)
    bt = run_backtest(w, close, index=macro["imoex"])
    curves[name] = bt["equity"]
    rows.append({"model": name, **{f"ml_{k}": v for k, v in m.items()}, **bt["metrics"]})
    imp = feature_importance(fit_full(panel, kind)).head(8)
    md.append(f"### {name}\nТоп-признаки:\n\n{imp.to_string()}\n")
    start = bt["first_active"]
bench = bt["benchmarks"]
for k, label in [("equal_weight", "Equal-weight (buy&hold)"), ("index", "IMOEX")]:
    if k in bench:
        b = bench[k]
        curves[label] = b["equity"] if isinstance(b, dict) and "equity" in b else b

res = pd.DataFrame(rows).set_index("model").round(4)
print(res.T.to_string())
pd.DataFrame(curves).dropna(how="all").apply(lambda s: s / s.dropna().iloc[0]).plot(figsize=(11, 5), title="Капитал, бэктест walk-forward")
plt.grid(alpha=.3); plt.savefig("reports/equity.png", dpi=120, bbox_inches="tight")
with open("report.md", "w") as f:
    f.write("# Отчёт\n\nТикеры: " + ", ".join(close.columns) + f"\nПериод: {close.index[0].date()} — {close.index[-1].date()}\n\n")
    f.write("## Метрики (ml_* — качество прогноза out-of-sample; остальное — бэктест)\n\n" + res.T.to_markdown() + "\n\n## Признаки\n\n" + "\n".join(md))
    f.write("\n![equity](reports/equity.png)\n")
