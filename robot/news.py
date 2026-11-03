"""News sentiment from RSS feeds with a simple Russian keyword lexicon.

LIMITATION: RSS feeds only expose the most recent days/weeks of news, so there
is NO long history. Dates in `index` without any fetched/cached news get a
neutral 0.0. Each run appends newly fetched headlines to a cache
(data/news_cache.csv) so history accumulates over time, but for a 5-year
backtest the feature is effectively constant 0.0 (carries no look-ahead and
no information). Do not interpret it as a validated predictive signal.
"""
import os
import re
import logging
import xml.etree.ElementTree as ET

import pandas as pd

from .config import TICKERS, DATA_DIR
from .data import _get

log = logging.getLogger(__name__)

FEEDS = [
    "https://lenta.ru/rss/news",
    "https://www.interfax.ru/rss.asp",
    "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
]
MOEX_NEWS = "https://iss.moex.com/iss/sitenews.json"

NAMES = {  # lowercase stems / names -> ticker
    "SBER": ["сбербанк", "сбер ", "sber"], "GAZP": ["газпром ", "газпрома", "gazprom"],
    "LKOH": ["лукойл", "lukoil"], "GMKN": ["норникел", "норильский никел", "gmkn"],
    "NVTK": ["новатэк", "novatek"], "ROSN": ["роснефт", "rosneft"],
    "YDEX": ["яндекс", "yandex"], "PLZL": ["полюс золот", "полюс ", "plzl"],
    "ALRS": ["алроса"], "TATN": ["татнефт", "tatneft"], "MTSS": ["мтс ", "мтс,", "мтс."],
    "MGNT": ["магнит ", "магнита", "magnit"],
}
MARKET_WORDS = ["рынок", "рубл", "индекс мосбирж", "imoex", "цб ", "ключев", "банк россии", "санкц", "нефт"]

POS = ["рост", "вырос", "выросл", "повыш", "прибыл", "рекорд", "дивиденд", "увелич", "укреп", "улучш",
       "подорожа", "одобр", "расшир", "успех", "выгодн", "оптимизм", "восстанов", "превысил", "привлек"]
NEG = ["пад", "упал", "снижен", "снизил", "сниз", "убыт", "санкц", "штраф", "потер", "ухудш", "риск",
       "кризис", "дефолт", "банкрот", "обвал", "дешев", "отмен", "сокращ", "иск ", "арест", "атак",
       "взрыв", "пожар", "ослаб", "угроз", "запрет", "приостанов"]


def score_text(text):
    """Lexicon sentiment of a text in [-1, 1]."""
    t = " " + text.lower() + " "
    p = sum(len(re.findall(w, t)) for w in POS)
    n = sum(len(re.findall(w, t)) for w in NEG)
    return 0.0 if p + n == 0 else (p - n) / (p + n)


def _rss_items(url):
    r = _get(url, retries=2)
    if r is None:
        return []
    out = []
    try:
        root = ET.fromstring(r.content)
        for it in root.iter("item"):
            title = (it.findtext("title") or "")
            desc = re.sub(r"<[^>]+>", " ", it.findtext("description") or "")
            pub = pd.to_datetime(it.findtext("pubDate"), errors="coerce", utc=True)
            if pd.notna(pub):
                out.append((pub.tz_localize(None).normalize(), title + ". " + desc))
    except Exception as e:
        log.warning("RSS parse failed %s: %s", url, e)
    return out


def _moex_items():
    r = _get(MOEX_NEWS, retries=2)
    if r is None:
        return []
    try:
        j = r.json()["sitenews"]
        cols = j["columns"]
        df = pd.DataFrame(j["data"], columns=cols)
        return [(pd.to_datetime(d).normalize(), t) for d, t in zip(df["published_at"], df["title"])]
    except Exception as e:
        log.warning("MOEX news parse failed: %s", e)
        return []


def _cache_path():
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, "news_cache.csv")


def _collect():
    """Fetch headlines, merge into the cache, return DataFrame[date, text]."""
    items = _moex_items()
    for u in FEEDS:
        items += _rss_items(u)
    new = pd.DataFrame(items, columns=["date", "text"])
    try:
        old = pd.read_csv(_cache_path(), parse_dates=["date"])
    except Exception:
        old = pd.DataFrame(columns=["date", "text"])
    df = pd.concat([old, new], ignore_index=True).drop_duplicates("text")
    if len(df):
        try:
            df.to_csv(_cache_path(), index=False)
        except Exception as e:
            log.warning("news cache write failed: %s", e)
    return df


def load_news_sentiment(tickers=TICKERS, index=None):
    """Daily sentiment [date x (tickers + "market")] in [-1, 1].

    Ticker columns: mean lexicon score of items mentioning the company;
    "market": mean score of all items about the market/macro (or any item).
    Days without news (all history beyond the RSS window) -> 0.0 neutral.
    """
    cols = list(tickers) + ["market"]
    idx = pd.DatetimeIndex(index if index is not None else [], name="date")
    out = pd.DataFrame(0.0, index=idx, columns=cols)
    try:
        df = _collect()
        if df.empty:
            return out
        df["text"] = df["text"].fillna("").astype(str)
        df["s"] = df["text"].map(score_text)
        low = df["text"].str.lower() + " "
        res = pd.DataFrame(index=sorted(df["date"].unique()), columns=cols, dtype=float)
        for t in tickers:
            names = NAMES.get(t, [t.lower()])
            m = low.apply(lambda x: any(n in x for n in names))
            if m.any():
                res[t] = df[m].groupby("date")["s"].mean()
        mm = low.apply(lambda x: any(w in x for w in MARKET_WORDS))
        res["market"] = df[mm].groupby("date")["s"].mean() if mm.any() else df.groupby("date")["s"].mean()
        res.index = pd.DatetimeIndex(res.index, name="date")
        out = res.reindex(idx).fillna(0.0).clip(-1, 1)
    except Exception as e:
        log.warning("news sentiment failed, returning neutral: %s", e)
    return out
