# Контракт модулей (пакет `robot/`)
TICKERS = ["SBER","GAZP","LKOH","GMKN","NVTK","ROSN","YDEX","TATN","MTSS","MGNT"]  # в robot/config.py (YDEX заменить на PLZL если нет 5 лет данных)
Кэш CSV в `data/`. Все индексы — pd.DatetimeIndex (дневные, без tz), имя индекса "date".

robot/config.py : TICKERS, YEARS=5, DATA_DIR, константы риска (MAX_WEIGHT=0.25, TARGET_VOL=0.15, COST=0.0005, HORIZON=5).
robot/data.py   : load_prices(tickers=TICKERS, years=YEARS) -> (close: DataFrame[date x ticker], volume: DataFrame)   # MOEX ISS TQBR, пагинация, кэш
                  load_macro() -> DataFrame[date] колонки: imoex, usdrub, key_rate  (IMOEX с ISS, курс USD и ключевая ставка с cbr.ru), ffill
robot/news.py   : load_news_sentiment(tickers, index) -> DataFrame[date x (tickers + "market")] значения [-1,1]; лексикон RU, RSS (MOEX sitenews, lenta/interfax/rbc) ; нет истории -> 0.0 (нейтрально), кэш
robot/features.py: build_panel(close, volume, macro, news, horizon=5) -> DataFrame (MultiIndex date,ticker) признаки + колонка target (лог-доходность через horizon дней вперёд); FEATURE_COLS; без утечки будущего
robot/models.py : make_model(kind: "linear"|"tree") ; walk_forward_predict(panel, kind, ...) -> pd.Series прогнозов (MultiIndex date,ticker) только на out-of-sample; metrics(panel,pred) -> dict (MAE, RMSE, R2, directional accuracy, IC)
robot/portfolio.py: signals_to_weights(pred: DataFrame[date x ticker], close, ...) -> DataFrame весов (long-only, cap MAX_WEIGHT, vol-targeting, drawdown stop-loss, cash остаток)
robot/backtest.py: run_backtest(weights, close, cost) -> dict(equity Series, returns, metrics: CAGR, vol, Sharpe, MaxDD, turnover); benchmark equal-weight и IMOEX
run.py          : оркестрация, печать итогов, графики в reports/, report.md
