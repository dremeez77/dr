"""Global configuration."""
import os

# YDEX has < 5y of TQBR history (starts 2024-07), replaced by PLZL.
TICKERS = ["SBER", "GAZP", "LKOH", "GMKN", "NVTK", "ROSN", "PLZL", "TATN", "MTSS", "MGNT"]
YEARS = 5
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")

MAX_WEIGHT = 0.25
TARGET_VOL = 0.15
COST = 0.0005
HORIZON = 5

HTTP_TIMEOUT = 20
HTTP_RETRIES = 4
USER_AGENT = "Mozilla/5.0 (robot-advisor research)"
