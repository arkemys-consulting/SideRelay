"""Install new upstream releases for iPhones that opted in."""
from contextlib import closing
import http.client
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from urllib.parse import urlencode

from .CatalogueIPA import private_work
from .CompagnonIPA import prepare, published_commit, tracked_host


CHECK_INTERVAL = 15 * 60
RELEASE_INTERVAL = 60 * 60
LOG = logging.getLogger(__name__)


def engine_request(port, action, fields, timeout=12):
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)) as connection:
        connection.request("POST", f"/api/{action}11318273670462819093", urlencode(fields),
                           {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(64 * 1024)
        return json.loads(body) if response.status == 200 else None


class AutoUpdates:
    def __init__(self, root, port, stop):
        self.root = root
        self.port = port
        self.stop = stop
        self.changed = threading.Event()
        self.lock = threading.Lock()
        self.file = private_work(root) / "companion-auto-updates.json"
        self.messages = {}
        self.commit = None
        self.checked_at = 0
        self.thread = threading.Thread(target=self.run, daemon=True)

    def read(self):
        if not self.file.exists():
            return set()
        data = json.loads(self.file.read_text())
        return set(data["devices"])

    def state(self, device):
        with self.lock:
            return {"autoUpdate": device in self.read(), "updateMessage": self.messages.get(device)}

    def set_enabled(self, db, device, value):
        if value:
            app, account, _ = tracked_host(db, device)
            if not app or not account:
                return False
        with self.lock:
            devices = self.read()
            if value:
                devices.add(device)
            else:
                devices.discard(device)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.file.parent, delete=False) as file:
                temporary = Path(file.name)
                try:
                    json.dump({"devices": sorted(devices)}, file)
                    file.flush()
                    os.replace(temporary, self.file)
                finally:
                    temporary.unlink(missing_ok=True)
            self.messages.pop(device, None)
        self.changed.set()
        return True

    def message(self, device, value):
        with self.lock:
            self.messages[device] = value

    def start(self):
        self.thread.start()

    def close(self):
        self.changed.set()
        self.thread.join(timeout=1)

    def run(self):
        while not self.stop.is_set():
            try:
                self.check()
            except (OSError, ValueError, sqlite3.Error, http.client.HTTPException) as error:
                LOG.warning("LiveContainer update check failed (%s).", type(error).__name__)
            self.changed.wait(CHECK_INTERVAL)
            self.changed.clear()

    def check(self):
        with self.lock:
            devices = sorted(self.read())
        if not devices:
            return
        now = time.monotonic()
        if self.commit is None or now - self.checked_at >= RELEASE_INTERVAL:
            try:
                self.commit = published_commit()
            except (OSError, ValueError, http.client.HTTPException):
                for device in devices:
                    self.message(device, "The Mac could not check for a new release. It will retry.")
                return
            self.checked_at = now
        uri = (self.root / "signature.db").as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=2)) as db:
            for device in devices:
                if self.stop.is_set():
                    break
                try:
                    self.check_device(db, device)
                except (OSError, ValueError, sqlite3.Error, http.client.HTTPException) as error:
                    LOG.warning("LiveContainer update failed (%s).", type(error).__name__)
                    self.message(device, "The Mac could not prepare the update. It will retry.")

    def check_device(self, db, device):
        app, account, _ = tracked_host(db, device)
        if not app or not account:
            self.message(device, "Install SideRelay again from the Mac to update this iPhone.")
            return
        busy = db.execute(
            "SELECT 1 FROM jobs WHERE app_id = ? AND status IN ('pending', 'queued', 'running') LIMIT 1", (app,)
        ).fetchone()
        if busy:
            return
        # The engine's probe uses the same USB and network routes as the installer.
        connection = engine_request(self.port, "probe_device", {"device_id": device})
        if not isinstance(connection, dict) or connection.get("reachable_ms") is None:
            self.message(device, "Waiting for the Mac to reach this iPhone.")
            return
        package = prepare(self.root, self.port, device, account, self.commit)
        if package.get("upToDate"):
            self.message(device, "LiveContainer is up to date.")
            return
        if package.get("targetAppId") != app:
            return
        with self.lock:
            if self.stop.is_set() or device not in self.read():
                return
            job = engine_request(self.port, "install_library_ipa", {
                "package_id": package["id"], "device_id": device, "account_id": account, "target_app_id": app,
            })
            if not isinstance(job, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", job):
                self.messages[device] = "The Mac could not start the update. See Activity on the Mac."
            else:
                self.messages[device] = "LiveContainer update queued on the Mac."
