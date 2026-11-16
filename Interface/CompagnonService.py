"""Serve device-scoped status and refresh requests over Tailscale Serve."""
from contextlib import closing
from datetime import datetime
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlencode
from uuid import NAMESPACE_URL, uuid5
from zipfile import BadZipFile

from .ArchiveIPA import devicectl_json
from .CatalogueIPA import IPA_BYTES, private_work
from .CompagnonEcranAccueil import HOME_SCREEN_PATH, launcher_resource, read_launcher, save_launcher
from .CompagnonIPA import BUNDLE_ID, PORT, enabled, endpoint, tailnet_ip
from .CompagnonMisesAJour import AutoUpdates, engine_request
from .CompagnonTV import install_from_store, install_uploaded_ipa, store, tv_addresses
from .ImportLiveContainer import TAILSCALE, tailscale
from .InspectionIPA import archive_icon_preview, tvos_icon_fallback
from .TransfertCompagnon import ROOT as LIVE_IMPORT_PATH


TV_CONTROL_PATH = re.compile(r"/apple-tv/([a-f0-9-]{36})/(status|refresh|ipa/install|jobs/[a-f0-9-]{36}|apps/[a-f0-9-]{36}/icon)")


def authorized_device(db, request, owner, aliases, televisions, *, device_id=None):
    if request.headers.get("Tailscale-User-Login") != owner:
        return None
    address = tailnet_ip(request.headers.get("X-Forwarded-For", ""))
    if device_id is None:
        device_id = request.headers.get("X-SideRelay-Device", "")
    if address is None or not re.fullmatch(r"[a-fA-F\d-]{36}", device_id):
        return None
    device = db.execute("SELECT ip, discovery FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not device:
        return None
    if device[1] == "coredevice-tvos":
        return device_id if address in televisions.get(device_id, ()) else None
    registered = tailnet_ip(device[0])
    return device_id if registered and (address == registered or address in aliases.get(registered, ())) else None


def status(db, root, device_id, television=False):
    rows = db.execute("""
        SELECT a.id, a.display_name, a.bundle_id, a.version,
               COALESCE(a.profile_expires_at, max(COALESCE(a.last_refreshed, a.installed_at), a.installed_at) + 604800),
               a.account_id, a.ipa_path, j.status, j.error, a.signing_repair,
               coalesce((SELECT max(i.installed_at) FROM ipa_installations i WHERE i.app_id = a.id), a.installed_at)
        FROM apps a LEFT JOIN jobs j ON j.rowid = (SELECT last.rowid FROM jobs last WHERE last.app_id = a.id ORDER BY last.rowid DESC LIMIT 1)
        WHERE a.device_id = ? AND a.installed_at IS NOT NULL
        ORDER BY lower(a.display_name)
    """, (device_id,))
    apps = []
    for key, name, bundle, version, expiry, account, ipa, job, error, repair, installed in rows:
        busy = job in ("queued", "running", "pending")
        if busy:
            state = "Refresh or installation in progress."
        elif repair:
            state = "Re-signing required."
        elif job == "failed":
            if (error or "").startswith("[pairing-unreachable]"):
                state = ("The Mac couldn’t reach this Apple TV. Check that both are on the local network." if television else
                         "The iPhone’s Apple pairing service is unreachable. Try USB or a reachable Wi-Fi connection.")
            else:
                state = "Last operation failed. See Activity in SideRelay."
        else:
            state = None
        apps.append({"id": key, "name": name, "bundleID": bundle, "version": version, "expiresAt": expiry, "busy": busy,
                     "canRefresh": bool(account and ipa and (root / ipa).is_file()), "state": state,
                     "iconRevision": installed})
    return {"apps": apps}


def queue_refresh(port, app_id):
    job = engine_request(port, "refresh_app", {"app_id": app_id})
    return job if isinstance(job, str) and re.fullmatch(r"[a-fA-F\d-]{36}", job) else None


@lru_cache(maxsize=128)
def cached_app_icon(root, path, modified, size):
    with tempfile.TemporaryDirectory(prefix="companion-app-icon-", dir=private_work(root)) as work:
        return archive_icon_preview(path, Path(work))


def installed_app_icon(db, root, device, app, *, include_companion=False):
    row = db.execute("""
        SELECT a.ipa_path, p.path, p.id FROM apps a
        LEFT JOIN ipa_installations i ON i.rowid = (
            SELECT last.rowid FROM ipa_installations last WHERE last.app_id=a.id
            ORDER BY last.installed_at DESC,last.rowid DESC LIMIT 1
        )
        LEFT JOIN ipa_packages p ON p.id=i.package_id
        WHERE a.id=? AND a.device_id=? AND a.installed_at IS NOT NULL
          AND (? OR (lower(a.bundle_id) != ? AND lower(a.bundle_id) NOT LIKE ?))
    """, (app, device, include_companion, BUNDLE_ID, BUNDLE_ID + ".%")).fetchone()
    if not row:
        return None
    app_path, package_path, package_id = row
    for relative in dict.fromkeys((app_path, package_path)):
        if not relative:
            continue
        try:
            path = (root / relative).resolve(strict=True)
            if not path.is_relative_to((root / "ipas").resolve()) or not path.is_file():
                continue
            stat = path.stat()
            image = cached_app_icon(root, path, stat.st_mtime_ns, stat.st_size)
            if image:
                return image
        except (OSError, ValueError, BadZipFile, RuntimeError, subprocess.SubprocessError):
            continue
    if include_companion and package_id:
        with tempfile.TemporaryDirectory(prefix="installed-app-icon-", dir=private_work(root)) as work:
            return tvos_icon_fallback(db, root, package_id, Path(work))
    return None


HOME_SCREEN_PROFILE_ID = "fr.arkemys.siderelay.homescreen"
MAX_HOME_SCREEN_APPS = 256
MAX_PROFILE_REQUEST = 24 * 1024 * 1024
MAX_PROFILE_CACHE = 32 * 1024 * 1024
PROFILE_DESCRIPTION = "Adds Home Screen icons for apps imported into SideRelay."


def home_screen_clip(data):
    name, bundle, folder = (data.get(key) for key in ("name", "bundle", "folder"))
    if (not isinstance(name, str) or not 0 < len(name.strip()) <= 100 or not name.isprintable()
            or not isinstance(bundle, str) or not bundle.endswith(".app") or not 0 < len(bundle) <= 255
            or not bundle.isprintable() or any(c in bundle for c in "/\\")
            or (folder is not None and (not isinstance(folder, str) or not 0 < len(folder) <= 255
                                        or not folder.isprintable() or folder in (".", "..")
                                        or any(c in folder for c in "/\\")))):
        raise ValueError("Invalid Home Screen shortcut")

    query = {"bundle-name": bundle}
    if folder:
        query["container-folder-name"] = folder
    encoded_query = urlencode(query, quote_via=quote)
    app_key = hashlib.sha256(bundle.encode()).hexdigest()[:24]
    clip_id = f"{HOME_SCREEN_PROFILE_ID}.{app_key}"
    clip = {
        "PayloadType": "com.apple.webClip.managed",
        "PayloadIdentifier": clip_id,
        "PayloadUUID": str(uuid5(NAMESPACE_URL, clip_id)),
        "PayloadVersion": 1,
        "PayloadDisplayName": name,
        "Label": name,
        "IsRemovable": True,
        "Precomposed": True,
        "FullScreen": True,
        "URL": "livecontainer://livecontainer-launch?" + encoded_query,
    }
    icon = data.get("icon")
    if icon is not None:
        if not isinstance(icon, str) or len(icon) > 175000:
            raise ValueError("Invalid Home Screen icon")
        try:
            png = base64.b64decode(icon, validate=True)
        except binascii.Error as error:
            raise ValueError("Invalid Home Screen icon") from error
        if (len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n" or png[12:16] != b"IHDR"
                or not all(0 < int.from_bytes(png[offset:offset + 4], "big") <= 400 for offset in (16, 20))):
            raise ValueError("Invalid Home Screen icon")
        clip["Icon"] = png
    return clip


def home_screen_clips(data, include_icons=False):
    apps = data.get("apps")
    if not isinstance(apps, list) or not 0 < len(apps) <= MAX_HOME_SCREEN_APPS:
        raise ValueError("Invalid Home Screen app list")
    clips = {}
    for app in apps:
        if not isinstance(app, dict):
            raise ValueError("Invalid Home Screen app")
        clip = home_screen_clip(app if include_icons else {**app, "icon": None})
        clips[clip["PayloadIdentifier"]] = clip
    return [clips[key] for key in sorted(clips)]


def home_screen_revision(clips):
    destinations = [(clip["PayloadIdentifier"], clip["Label"], clip["URL"]) for clip in clips]
    return hashlib.sha256(json.dumps(destinations, ensure_ascii=False).encode()).hexdigest()[:24]


def home_screen_profile(data):
    restore = data.get("restore", False)
    if not isinstance(restore, bool):
        raise ValueError("Invalid Home Screen restore request")
    clips = home_screen_clips(data, include_icons=True)
    revision = home_screen_revision(clips)
    if restore:
        # iOS matches Web Clips by payload identifier. Give restored shortcuts new
        # identities under the same profile so iOS installs them as new clips.
        generation = secrets.token_hex(8)
        for clip in clips:
            clip["PayloadIdentifier"] += f".{generation}"
            clip["PayloadUUID"] = str(uuid5(NAMESPACE_URL, clip["PayloadIdentifier"]))
    return plistlib.dumps({
        "PayloadType": "Configuration",
        "PayloadIdentifier": HOME_SCREEN_PROFILE_ID,
        "PayloadUUID": str(uuid5(NAMESPACE_URL, HOME_SCREEN_PROFILE_ID)),
        "PayloadVersion": 1,
        "PayloadDisplayName": "SideRelay Home Screen Shortcuts",
        "PayloadDescription": f"{PROFILE_DESCRIPTION} Revision: {revision}.",
        "PayloadOrganization": "SideRelay",
        "PayloadContent": clips,
    })


def home_screen_profile_state(udid, data):
    clips = home_screen_clips(data)
    try:
        result = devicectl_json(["device", "profile", "list", "--device", udid,
                                 "--type", "configuration", "--search", HOME_SCREEN_PROFILE_ID], timeout=5)
        profiles = result["configurationProfiles"]
        if not isinstance(profiles, list):
            return "unknown"
        profile = next((p for p in profiles if p.get("payloadIdentifier") == HOME_SCREEN_PROFILE_ID), None)
    except (OSError, ValueError, KeyError, AttributeError, subprocess.SubprocessError):
        return "unknown"
    if profile is None:
        return "missing"
    description = profile.get("profileDescription") or ""
    marker = re.search(r"Revision: ([a-f0-9]{24})\.$", description)
    if marker:
        return "current" if marker[1] == home_screen_revision(clips) else "outdated"
    # Earlier releases used one fixed description. A newer import still requires an update.
    try:
        installed_at = datetime.fromisoformat(profile["creationDate"]).timestamp()
    except (TypeError, ValueError, KeyError, OverflowError):
        return "installed"
    if any(isinstance(app.get("installedAt"), (int, float)) and app["installedAt"] > installed_at
           for app in data["apps"]):
        return "outdated"
    return "installed"


def handler(root, owner, engine_port, aliases=None, updates=None, televisions=None, transfers=None):
    aliases = aliases or {}
    televisions = televisions or {}
    profiles = {}
    profile_lock = threading.Lock()
    store_lock = threading.Lock()

    database_uri = (root / "signature.db").as_uri() + "?mode=ro"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status_code, result):
            data = json.dumps(result).encode()
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if transfers and self.path.startswith(f"/{LIVE_IMPORT_PATH}/"):
                self.connection.settimeout(20)
                return transfers.serve(self)
            if self.path.startswith(f"/{HOME_SCREEN_PATH}/"):
                self.view_launcher()
                return
            if match := re.fullmatch(r"/home-screen/([a-zA-Z0-9_-]{43})/SideRelay.mobileconfig", self.path):
                self.download_profile(match[1])
                return
            self.handle_companion(self.path if self.path == "/store" or self.path.startswith(("/jobs/", "/apps/", "/apple-tv/")) else "/status")

        def do_HEAD(self):
            if transfers and self.path.startswith(f"/{LIVE_IMPORT_PATH}/"):
                self.connection.settimeout(20)
                return transfers.serve(self)
            self.send_error(404)

        def do_POST(self):
            if self.path in ("/refresh", "/auto-update", "/home-screen", "/home-screen/status",
                             f"/{HOME_SCREEN_PATH}", "/store/install") or self.path.startswith("/apple-tv/"):
                self.handle_companion(self.path)
            else:
                self.reply(404, {})

        def view_launcher(self):
            match = re.fullmatch(
                rf"/{HOME_SCREEN_PATH}/([a-f0-9]{{64}})/(icon\.png|launcher\.js|worker\.js|manifest\.webmanifest)?",
                self.path,
            )
            if not match:
                self.reply(404, {})
                return
            if self.headers.get("Tailscale-User-Login") != owner:
                self.reply(403, {})
                return
            key, resource = match.groups()
            self.connection.settimeout(5)
            try:
                record = read_launcher(root, key)
                with closing(sqlite3.connect(database_uri, uri=True, timeout=2)) as db:
                    if not authorized_device(db, self, owner, aliases, televisions, device_id=record["device"]):
                        self.reply(403, {})
                        return
                mime, data = launcher_resource(record, resource)
            except FileNotFoundError:
                self.reply(404, {})
                return
            except (OSError, ValueError, KeyError, sqlite3.Error, plistlib.InvalidFileException):
                self.reply(503, {})
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if resource is None:
                self.send_header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; "
                                 "frame-ancestors 'none'; img-src 'self'; script-src 'self'; worker-src 'self'; "
                                 "manifest-src 'self'; style-src 'unsafe-inline'")
            self.end_headers()
            try:
                self.wfile.write(data)
            except OSError:
                pass

        def prepare_launcher(self, device):
            try:
                clip = home_screen_clip(self.read_object(256 * 1024))
                if "Icon" not in clip:
                    raise ValueError("Missing Home Screen icon")
            except ValueError:
                self.reply(400, {})
                return
            self.reply(200, {"id": save_launcher(root, device, clip)})

        def download_profile(self, token):
            address = tailnet_ip(self.headers.get("X-Forwarded-For", ""))
            if not address or self.headers.get("Tailscale-User-Login") != owner:
                self.reply(403, {})
                return
            with profile_lock:
                item = profiles.get(token)
                if (not item or item[0] <= time.monotonic()
                        or (address != item[1] and address not in aliases.get(item[1], ()))):
                    item = None
            if not item:
                self.reply(404, {})
                return
            data = item[2]
            self.send_response(200)
            self.send_header("Content-Type", "application/x-apple-aspen-config")
            self.send_header("Content-Disposition", 'attachment; filename="SideRelay.mobileconfig"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(data)
            except OSError:
                pass

        def read_object(self, maximum):
            length = self.headers.get("Content-Length", "")
            if not length.isascii() or not length.isdecimal() or len(length) > 8 or not 0 < int(length) <= maximum:
                raise ValueError("Invalid request size")
            selection = json.loads(self.rfile.read(int(length)))
            if not isinstance(selection, dict):
                raise ValueError("Expected a JSON object")
            return selection

        def prepare_profile(self):
            try:
                data = home_screen_profile(self.read_object(MAX_PROFILE_REQUEST))
            except (ValueError, OverflowError):
                self.reply(400, {})
                return
            address = tailnet_ip(self.headers.get("X-Forwarded-For", ""))
            token = secrets.token_urlsafe(32)
            now = time.monotonic()
            with profile_lock:
                for key, (expires, _, _) in list(profiles.items()):
                    if expires <= now:
                        del profiles[key]
                if len(profiles) >= 16 or sum(len(item[2]) for item in profiles.values()) + len(data) > MAX_PROFILE_CACHE:
                    self.reply(429, {})
                    return
                profiles[token] = (now + 300, address, data)
            self.reply(200, {"token": token})

        def receive_tv_ipa(self, db, device):
            length = self.headers.get("Content-Length", "")
            if (self.headers.get_content_type() != "application/octet-stream" or self.headers.get("Transfer-Encoding")
                    or not re.fullmatch(r"[0-9]{1,9}", length) or not 4 <= int(length) <= IPA_BYTES):
                self.close_connection = True
                self.reply(400, {"error": "Choose a tvOS IPA smaller than 512 MB."})
                return
            if not store_lock.acquire(blocking=False):
                self.close_connection = True
                self.reply(409, {"error": "SideRelay is already preparing an Apple TV installation."})
                return
            try:
                with tempfile.TemporaryFile(dir=private_work(root)) as archive:
                    size = remaining = int(length)
                    deadline = time.monotonic() + 300
                    while remaining:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("IPA upload timed out")
                        chunk = self.rfile.read1(min(remaining, 256 * 1024))
                        if not chunk:
                            raise ValueError("The upload did not finish.")
                        archive.write(chunk)
                        remaining -= len(chunk)
                    job = install_uploaded_ipa(db, engine_port, device, archive, size)
                if isinstance(job, str) and re.fullmatch(r"[a-f0-9-]{36}", job):
                    self.reply(200, {"jobID": job})
                else:
                    self.reply(409, {"error": "Could not queue this IPA. Check the Apple TV and Apple Account in SideRelay."})
            except (BadZipFile, plistlib.InvalidFileException):
                self.reply(400, {"error": "This file is not a valid IPA."})
            except ValueError as error:
                self.close_connection = True
                self.reply(400, {"error": str(error)[:240]})
            finally:
                store_lock.release()

        def handle_companion(self, path):
            self.connection.settimeout(5)
            if self.path != path:
                self.reply(404, {})
                return
            try:
                with closing(sqlite3.connect(database_uri, uri=True, timeout=2)) as db:
                    device = authorized_device(db, self, owner, aliases, televisions)
                    if not device:
                        self.reply(403, {})
                        return
                    television = device in televisions
                    if path.startswith("/apple-tv/"):
                        if television:
                            self.reply(403, {})
                            return
                        match = TV_CONTROL_PATH.fullmatch(path)
                        expected = "POST" if match and match[2] in ("ipa/install", "refresh") else "GET"
                        if not match or self.command != expected or match[1] not in televisions:
                            self.reply(404, {})
                            return
                        device, operation = match.groups()
                        if not db.execute("SELECT 1 FROM devices WHERE id=? AND discovery='coredevice-tvos'", (device,)).fetchone():
                            self.reply(404, {})
                            return
                        television, path = True, "/" + operation
                        if path == "/ipa/install":
                            self.receive_tv_ipa(db, device)
                            return
                    if path == "/store":
                        if television:
                            self.reply(200, store(db, root, device))
                        else:
                            self.reply(404, {})
                        return
                    if path == "/store/install":
                        if not television:
                            self.reply(404, {})
                            return
                        try:
                            release = self.read_object(256).get("releaseID")
                            if not isinstance(release, str) or not re.fullmatch(r"[a-f0-9]{64}", release):
                                raise ValueError("Invalid release ID")
                        except (ValueError, OverflowError):
                            self.reply(400, {})
                            return
                        if not store_lock.acquire(blocking=False):
                            self.reply(409, {})
                            return
                        try:
                            job = install_from_store(db, root, engine_port, device, release)
                        finally:
                            store_lock.release()
                        if isinstance(job, str):
                            self.reply(200, {"jobID": job})
                        else:
                            self.reply(409, {})
                        return
                    if television and path not in ("/status", "/refresh") and not path.startswith(("/jobs/", "/apps/")):
                        self.reply(404, {})
                        return
                    if path == f"/{HOME_SCREEN_PATH}":
                        self.prepare_launcher(device)
                        return
                    if path == "/home-screen":
                        self.prepare_profile()
                        return
                    if path == "/home-screen/status":
                        udid, = db.execute("SELECT udid FROM devices WHERE id=?", (device,)).fetchone()
                        try:
                            state = home_screen_profile_state(udid, self.read_object(512 * 1024))
                        except (ValueError, OverflowError):
                            self.reply(400, {})
                            return
                        self.reply(200, {"state": state})
                        return
                    if path.startswith("/apps/"):
                        match = re.fullmatch(r"/apps/([a-fA-F\d-]{36})/icon", path)
                        image = installed_app_icon(db, root, device, match[1]) if match else None
                        self.reply(200, {"png": base64.b64encode(image).decode("ascii")} if image else {})
                        return
                    if path.startswith("/jobs/"):
                        job_id = path.removeprefix("/jobs/")
                        row = db.execute("""
                            SELECT j.status, j.error, j.progress, j.stage FROM jobs j JOIN apps a ON a.id=j.app_id
                            WHERE j.id=? AND a.device_id=? AND (j.kind='refresh' OR (? AND j.kind='install'))
                        """, (job_id, device, television)).fetchone() if re.fullmatch(r"[a-fA-F\d-]{36}", job_id) else None
                        if not row:
                            self.reply(404, {})
                        else:
                            code = re.match(r"^\[([a-z-]+)\]", row[1] or "")
                            self.reply(200, {"status": row[0], "errorCode": code[1] if code else None,
                                             "progress": row[2], "stage": row[3]})
                        return
                    result = status(db, root, device, television)
                    if path in ("/refresh", "/auto-update"):
                        length = self.headers.get("Content-Length", "")
                        if not length.isascii() or not length.isdecimal() or len(length) > 3 or not 0 < int(length) <= 256:
                            self.reply(400, {})
                            return
                        try:
                            data = json.loads(self.rfile.read(int(length)))
                        except (ValueError, UnicodeError):
                            data = None
                        if not isinstance(data, dict):
                            self.reply(400, {})
                            return
                    if path == "/auto-update":
                        value = data.get("enabled")
                        if not isinstance(value, bool) or updates is None:
                            self.reply(400, {})
                            return
                        if not updates.set_enabled(db, device, value):
                            self.reply(409, {})
                            return
                    if path == "/refresh":
                        key = data.get("appID")
                        app = next((a for a in result["apps"] if a["id"] == key and a["canRefresh"]), None)
                        if not app:
                            self.reply(409, {"error": "refresh-unavailable"})
                            return
                        job = None if app["busy"] else queue_refresh(engine_port, app["id"])
                        result = status(db, root, device, television)
                        if job is None and not any(a["id"] == key and a["busy"] for a in result["apps"]):
                            self.reply(409, {"error": "refresh-unavailable"})
                            return
                        result["refreshJobID"] = job
                    if updates and not television:
                        result.update(updates.state(device))
                    if path == "/status" and not television:
                        result["appleTVs"] = [{"id": key, "name": name} for key, name in db.execute(
                            "SELECT id,name FROM devices WHERE discovery='coredevice-tvos' ORDER BY name") if key in televisions]
                        deadlines = [row[0] for row in db.execute("""
                            SELECT COALESCE(a.profile_expires_at, COALESCE(a.last_refreshed,a.installed_at) + 604800), a.device_id
                            FROM apps a JOIN devices d ON d.id=a.device_id
                            WHERE d.discovery='coredevice-tvos' AND a.installed_at IS NOT NULL
                        """) if row[1] in televisions and row[0] is not None]
                        result["appleTVExpiry"] = min(deadlines, default=None)
                    self.reply(200, result)
            except (OSError, ValueError, sqlite3.Error, http.client.HTTPException):
                self.close_connection = True
                try:
                    self.reply(503, {})
                except OSError:
                    pass
    return Handler


def serve(root, engine_port):
    if not enabled(root).is_file():
        return
    _, owner = endpoint()
    network = tailscale("status", "--json")
    peers = network.get("Peer") or {}
    aliases = {}
    for peer in peers.values():
        if peer.get("OS") != "iOS":
            continue
        addresses = {address for ip in peer.get("TailscaleIPs", []) if (address := tailnet_ip(ip))}
        for address in addresses:
            aliases[address] = addresses
    config = tailscale("serve", "status", "--json")
    if str(PORT) in (config.get("TCP") or {}) or any(
        host.endswith(f":{PORT}") for host in ((config.get("Web") or {}) | (config.get("AllowFunnel") or {}))
    ):
        raise ValueError("The Tailscale port for the iPhone companion is already in use.")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    updates = AutoUpdates(root, engine_port, stop)
    televisions = tv_addresses(root, network)
    with ThreadingHTTPServer(("127.0.0.1", 0), handler(root, owner, engine_port, aliases, updates, televisions)) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        relay = subprocess.Popen(
            [TAILSCALE, "serve", "--yes", "--https", str(PORT), f"http://127.0.0.1:{server.server_port}"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "TAILSCALE_BE_CLI": "1"},
        )
        try:
            updates.start()
            while relay.poll() is None and not stop.wait(1):
                pass
        finally:
            stop.set()
            if relay.poll() is None:
                relay.terminate()
                try:
                    relay.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    relay.kill()
                    relay.wait()
            server.shutdown()
            thread.join()
            updates.close()


if __name__ == "__main__":
    try:
        serve(Path(sys.argv[1]), int(sys.argv[2]))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
