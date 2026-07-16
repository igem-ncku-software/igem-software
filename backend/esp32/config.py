import os

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
DATA_FILE = os.path.join(os.path.dirname(__file__), "data.json")

os.makedirs(UPLOAD_DIR, exist_ok=True)
