import importlib.util
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "05_app", "main.py")

spec = importlib.util.spec_from_file_location("backend_main", BACKEND)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

app = backend.app
