"""Private Docker service keys, Apple session migration and portal access."""

import base64
from collections import deque
from contextlib import closing
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import tempfile
import threading
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ACCOUNT_SCHEMA = 0x53520002


def read_secret(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        mode = os.fstat(stream.fileno()).st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise ValueError("SideRelay secrets must be private files (mode 0600).")
        return stream.read(256)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_secret(path, value):
    # Publish a complete file once. A restart can safely resume after either write.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            os.link(temporary, path)
            sync_directory(path.parent)
        except FileExistsError:
            pass
        finally:
            temporary.unlink()
    return read_secret(path)


def encrypt_value(cipher, value):
    nonce = os.urandom(12)
    return base64.b64encode(nonce + cipher.encrypt(nonce, value.encode(), None)).decode("ascii")


def open_account_name(cipher, name):
    if name is None or not name.startswith("enc:"):
        return name
    _, _, ciphertext = name.split(":", 2)
    data = base64.b64decode(ciphertext, validate=True)
    return cipher.decrypt(data[:12], data[12:], None).decode()


def account_reader(connection, key_path=None):
    if key_path is None:
        connection.create_function("apple_account_name", 1, lambda name: name, deterministic=True)
    else:
        cipher = AESGCM(bytes.fromhex(read_secret(key_path).decode("ascii")))
        connection.create_function("apple_account_name", 1, lambda name: open_account_name(cipher, name), deterministic=True)
    return connection


def account_lookup(key, name):
    return hmac.digest(key, b"SideRelay Apple Account lookup\0" + name.encode(), "sha256").hex()


def migrate_apple_sessions(database, key_text):
    if not database.is_file():
        return
    with closing(sqlite3.connect(database)) as connection:
        if not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sideload_storage'"
        ).fetchone():
            return
        if connection.execute("PRAGMA user_version").fetchone()[0] == ACCOUNT_SCHEMA:
            return
        key = bytes.fromhex(key_text.decode("ascii"))
        cipher = AESGCM(key)
        connection.execute("PRAGMA secure_delete = ON")
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            scoped = {}
            for account_id, saved in connection.execute("SELECT id, apple_id FROM apple_accounts").fetchall():
                name = open_account_name(cipher, saved)
                lookup = account_lookup(key, name)
                scoped[hashlib.sha256(name.encode()).hexdigest()] = lookup
                scoped[lookup] = lookup
                if name == saved:
                    connection.execute("UPDATE apple_accounts SET apple_id = ? WHERE id = ?",
                                       (f"enc:{lookup}:{encrypt_value(cipher, name)}", account_id))
            if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ipa_batches'"
            ).fetchone():
                for batch_id, name in connection.execute(
                    "SELECT id, account_name FROM ipa_batches WHERE account_name NOT LIKE 'enc:%'"
                ).fetchall():
                    connection.execute("UPDATE ipa_batches SET account_name = ? WHERE id = ?",
                                       (f"enc:{account_lookup(key, name)}:{encrypt_value(cipher, name)}", batch_id))
            rows = connection.execute(
                "SELECT key, value FROM sideload_storage WHERE substr(key, 65, 1) = '/'"
            ).fetchall()
            for row_key, value in rows:
                if not re.fullmatch(r"[0-9a-f]{64}/.+", row_key):
                    continue
                prefix, suffix = row_key.split("/", 1)
                if prefix not in scoped:
                    # Incomplete sign-ins and removed accounts have no usable session.
                    connection.execute("DELETE FROM sideload_storage WHERE key = ?", (row_key,))
                    continue
                destination = f"{scoped[prefix]}/{suffix}"
                value = value if value.startswith("enc:") else "enc:" + encrypt_value(cipher, value)
                if destination == row_key:
                    connection.execute("UPDATE sideload_storage SET value = ? WHERE key = ?", (value, row_key))
                else:
                    connection.execute("INSERT OR IGNORE INTO sideload_storage (key, value) VALUES (?, ?)",
                                       (destination, value))
                    connection.execute("DELETE FROM sideload_storage WHERE key = ?", (row_key,))
        connection.execute("VACUUM")
        connection.execute(f"PRAGMA user_version = {ACCOUNT_SCHEMA}")
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
            connection.execute("PRAGMA user_version = 0")
            raise ValueError("SideRelay could not finish cleaning old Apple session data.")


def prepare(data, directory):
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError("SideRelay's secrets directory must have mode 0700.")
    if directory.resolve().is_relative_to(data.resolve()):
        raise ValueError("SideRelay needs separate data and secret directories.")
    path, legacy = directory / "service-key", data / "cle"
    database = data / "signature.db"
    old = read_secret(legacy) if legacy.exists() or legacy.is_symlink() else None
    if path.exists() or path.is_symlink():
        key = read_secret(path)
    elif old is not None:
        key = create_secret(path, old)
    elif database.exists():
        raise ValueError("SideRelay's service key is missing. Restore its secrets volume.")
    else:
        key = create_secret(path, secrets.token_hex(32).encode("ascii"))
    if not re.fullmatch(rb"[0-9a-f]{64}", key) or key == b"0" * 64:
        raise ValueError("SideRelay's service key is invalid.")
    if old is not None:
        if not hmac.compare_digest(old, key):
            raise ValueError("SideRelay found two different service keys.")
        # Make the new directory entry durable before removing the old one.
        sync_directory(directory)
        legacy.unlink()
        sync_directory(data)
    migrate_apple_sessions(database, key)
    password = create_secret(directory / "portal-password", secrets.token_urlsafe(32).encode("ascii"))
    if not re.fullmatch(rb"[A-Za-z0-9_-]{43}", password):
        raise ValueError("SideRelay's portal access key is invalid.")
    return path, PortalAccess(password)


class PortalAccess:
    cookie = "siderelay_session"
    lifetime = 12 * 60 * 60

    def __init__(self, password):
        self.password = password
        self.attempts = deque()
        self.sessions = {}
        self.lock = threading.Lock()

    def sign_in(self, password):
        with self.lock:
            now = time.monotonic()
            while self.attempts and now - self.attempts[0] >= 60:
                self.attempts.popleft()
            if len(self.attempts) >= 10:
                return 429, None
            if not hmac.compare_digest(password.encode("utf-8"), self.password):
                self.attempts.append(now)
                return 401, None
            self.attempts.clear()
            self.sessions = {token: expiry for token, expiry in self.sessions.items() if expiry > now}
            if len(self.sessions) >= 64:
                self.sessions.pop(next(iter(self.sessions)))
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + self.lifetime
            return 303, token

    def session_token(self, raw_cookie):
        cookies = SimpleCookie()
        try:
            cookies.load(raw_cookie)
        except CookieError:
            return None
        token = cookies.get(self.cookie)
        if token and re.fullmatch(r"[A-Za-z0-9_-]{43}", token.value):
            return token.value
        return None

    def authorized(self, raw_cookie):
        token = self.session_token(raw_cookie)
        with self.lock:
            return self.sessions.get(token, 0) > time.monotonic()

    def sign_out(self, raw_cookie):
        with self.lock:
            self.sessions.pop(self.session_token(raw_cookie), None)

    def session_cookie(self, token=""):
        lifetime = self.lifetime if token else 0
        return f"{self.cookie}={token}; Max-Age={lifetime}; Path=/; HttpOnly; SameSite=Strict"
