"""Authenticate trusted local clients to the signing engine."""

import hmac
import os
from pathlib import Path
import re
import stat


def token(key_path=None):
    if key_path is None:
        root = Path(os.environ.get("SIDERELAY_DATA_DIR", Path(__file__).resolve().parents[1] / "donnees"))
        key_path = os.environ.get("JAS_SECRET_KEY_FILE", root / "cle")
    fd = os.open(key_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        mode = os.fstat(stream.fileno()).st_mode
        key = stream.read(65) if stat.S_ISREG(mode) and not mode & 0o077 else b""
    if not re.fullmatch(rb"[0-9a-fA-F]{64}", key):
        raise ValueError("The SideRelay engine credential is unavailable.")
    return hmac.digest(key, b"SideRelay local engine v1", "sha256").hex()


def headers():
    return {"X-SideRelay-Engine": token()}
