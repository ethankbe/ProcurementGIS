import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "05_app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from main import app  # noqa: E402, F401