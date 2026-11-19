"""Serve the shared SideRelay screens and the local signing engine in Docker."""

import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import signal
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import unicodedata
import zipfile
from urllib.parse import parse_qs, urlencode, urlsplit

from PIL import Image, ImageOps

from . import ArchiveIPA, Backup, BackupCrypto, CatalogueIPA, CoreDeviceDocker, ImportTVContainer, InspectionIPA, ProvisionnementIPA, SecuriteDocker, SignatureOrbStack
from . import EngineAccess
from .ComposantsIPA import MAX_COMPONENTS_SIZE
from .CompagnonIPA import tailnet_ip
from .MisesAJourDocker import DockerUpdates
from .TransfertCompagnon import Transfers

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ["SIDERELAY_DATA_DIR"])
SECRETS = Path(os.environ.get("SIDERELAY_SECRETS_DIR", "/var/lib/siderelay-secrets"))
ENGINE_PORT = 18784
PORT = int(os.environ.get("SIDERELAY_WEB_PORT", "8080"))
COMPANION_OWNER = os.environ.get("SIDERELAY_COMPANION_OWNER")
COMPANION_ADDRESS = os.environ.get("SIDERELAY_COMPANION_ADDRESS")
TRANSFERS = Transfers(DATA, COMPANION_ADDRESS, COMPANION_OWNER) if COMPANION_OWNER and COMPANION_ADDRESS else None
MAC_SIGNING = os.environ.get("SIDERELAY_HOST_SIGNING") == "1" and bool(os.environ.get("SIDERELAY_DISCOVERY_TOKEN"))
PREFIX = "/_siderelay/"
BUFFER = 1024 * 1024
SCRIPTS = ("Web", "Guide", "IPA", "Jumelage", "Comptes", "LotsIPA", "Store", "Bibliotheque", "Outils")
ICON = "SideRelay.png"
ASSETS = {f"{name}.js": "text/javascript; charset=utf-8" for name in SCRIPTS} | {
    "App.css": "text/css; charset=utf-8", "Web.css": "text/css; charset=utf-8", ICON: "image/png",
}
HEAD = b"".join(
    f'<link rel="stylesheet" href="{PREFIX}assets/{name}">'.encode() for name in ("App.css", "Web.css")
) + (
    f'<link rel="icon" type="image/png" sizes="256x256" href="{PREFIX}assets/{ICON}">'
    f'<link rel="apple-touch-icon" href="{PREFIX}assets/{ICON}">'
).encode()
if CoreDeviceDocker.available():
    HEAD += b'<meta name="siderelay-apple-tv" content="1">'
if TRANSFERS:
    HEAD += b'<meta name="siderelay-livecontainer" content="1">'
if MAC_SIGNING:
    HEAD += b'<meta name="siderelay-imported-signing" content="1">'
# The shared scripts change the server-rendered DOM. Leptos must attach its handlers
# to the original markup before these scripts render SideRelay's controls.
HYDRATE = b"mod.hydrate();"
LOAD_INTERFACE = HYDRATE + b"(async()=>{" + b"".join(
    f'await import("{PREFIX}assets/{name}.js");'.encode() for name in SCRIPTS
) + b"})();"
HOST = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?", re.I)
PAIRING_ROUTE = "/api/register_device11318273670462819093"
NONCE = re.compile(rb'<script\b[^>]*\bnonce="([A-Za-z0-9+/_-]{16,128}={0,2})"')
UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
PACKAGE = r"(?:[0-9a-f]{32}|[0-9a-f]{64})"
SETUP = DATA / "web-setup.json"
SETUP_LOCK = threading.Lock()
MDNS_ENABLED = os.environ.get("SIDERELAY_MDNS", "1") == "1"
with (ROOT / "Interface" / "Info.plist").open("rb") as stream:
    BUNDLE = plistlib.load(stream)
DOCKER_UPDATES = DockerUpdates(BUNDLE["CFBundleShortVersionString"])


def field(data, key, pattern):
    value = data.get(key)
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid {key}.")
    return value


def cli(*args):
    result = subprocess.run([sys.executable, "-B", str(ROOT / "signature-ios"), *args],
                            capture_output=True, check=True, timeout=130)
    value = json.loads(result.stdout)
    if isinstance(value, dict) and value.get("error"):
        raise ValueError(value["error"])
    return value


def store_artwork(data):
    source = field(data, "sourceId", UUID)
    address = CatalogueIPA.https_url(field(data, "address", r".{1,4096}")).geturl()
    size = data.get("size", "original")
    if size not in ("icon", "preview", "original"):
        raise ValueError("Invalid image size.")
    with database() as db:
        mime, artwork = CatalogueIPA.store_artwork(db, source, address)
    if not mime:
        return {}
    if size != "original":
        limit = 288 if size == "icon" else 960
        try:
            with Image.open(BytesIO(artwork)) as image:
                if image.width * image.height > 32_000_000:
                    return {}
                if max(image.size) > limit:
                    preview = ImageOps.exif_transpose(image)
                    preview.thumbnail((limit, limit), Image.Resampling.LANCZOS)
                    transparent = "A" in preview.getbands() or "transparency" in preview.info
                    with BytesIO() as buffer:
                        if transparent:
                            preview.convert("RGBA").save(buffer, "PNG")
                            mime = "image/png"
                        else:
                            preview.convert("RGB").save(buffer, "JPEG", quality=86)
                            mime = "image/jpeg"
                        artwork = buffer.getvalue()
        except Image.DecompressionBombError:
            return {}
        except (OSError, ValueError):
            # The browser may decode formats that this version of Pillow lacks.
            pass
    return {"mime": mime, "image": base64.b64encode(artwork).decode("ascii")}


def library(data):
    operation = data.get("operation")
    if operation == "store-image":
        return store_artwork(data)
    if operation in ("store", "refresh-store"):
        with database(write=True) as db:
            return CatalogueIPA.command(db, DATA, ENGINE_PORT, operation, "all" if data.get("force") == "yes" else None)
    args = []
    if operation in ("refresh", "remove", "download"):
        args = [field(data, "sourceId", UUID)]
        if operation == "download":
            args.extend([field(data, "bundleId", r"[A-Za-z0-9][A-Za-z0-9.-]{0,254}"),
                         field(data, "versionId", r"[0-9a-f]{64}")])
    elif operation in ("inspect", "icon"):
        args = [field(data, "packageId", PACKAGE)]
    elif operation == "prepare-top-shelf-update" and CoreDeviceDocker.available():
        args = [field(data, "packageId", PACKAGE), field(data, "appId", UUID)]
    elif operation == "diagnose":
        package = field(data, "packageId", PACKAGE)
        with database() as db:
            source = InspectionIPA.package_path(db, DATA, package)
            device = db.execute("SELECT udid FROM devices WHERE id = ?",
                                (field(data, "deviceId", UUID),)).fetchone() if data.get("deviceId") else None
        if MAC_SIGNING:
            with SignatureOrbStack.relay("verify", source, device[0] if device else None) as response:
                result = json.loads(response.read(256 * 1024)) if response.getheader("Content-Type") == "application/json" else {}
                if response.status != 200:
                    raise ValueError(result.get("error", "The Mac signature service is unavailable."))
                return result
        with tempfile.TemporaryDirectory(prefix="web-profile-", dir=CatalogueIPA.private_work(DATA)) as workspace:
            return ProvisionnementIPA.diagnosis(source, device[0] if device else None, Path(workspace), None)
    elif operation == "add":
        args = [CatalogueIPA.https_url(field(data, "url", r".{1,4096}")).geturl()]
    elif operation not in ("list", "inbox"):
        raise ValueError("Unknown library action.")
    return cli("ipa-library", operation, *args)


def database(write=False):
    connection = sqlite3.connect((DATA / "signature.db").as_uri() + ("?mode=rw" if write else "?mode=ro"),
                                 uri=True, timeout=4)
    return closing(SecuriteDocker.account_reader(connection, SECRETS / "service-key"))


def engine_call(action, values, timeout=12, headers=None):
    with closing(http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=timeout)) as engine:
        engine.request("POST", f"/api/{action}11318273670462819093", urlencode(values), {
            "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
            **(headers or {}), **EngineAccess.headers(),
        })
        with engine.getresponse() as response:
            result = response.read(256 * 1024)
            if response.status != 200:
                raise ValueError("The signing engine could not complete the request.")
            return json.loads(result)


def write_preference(destination, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=DATA, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(value)
            stream.close()
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


def setup(action, data):
    with SETUP_LOCK:
        saved = json.loads(SETUP.read_text()) if SETUP.exists() else {"step": -1}
        if action == "portal":
            state = cli("etat-portail")
            return {**state, **saved, "setupDeferred": "savedStep" in saved,
                    "mdnsEnabled": MDNS_ENABLED,
                    "version": BUNDLE["CFBundleShortVersionString"], "build": BUNDLE["CFBundleVersion"]}
        if action == "connection":
            saved["mode"] = field(data, "mode", r"bonjour|tailscale")
            write_preference(SETUP, json.dumps(saved))
            return {"mode": saved["mode"]}
        if action == "restartSetup":
            saved["step"] = saved.pop("savedStep", 0)
            if saved["step"] == 0:
                saved.pop("firstApp", None)
            write_preference(SETUP, json.dumps(saved))
            return {"step": saved["step"]}
        current = saved["step"]
        if action == "setupStep":
            proposed = int(field(data, "step", r"-1|[0-3]"))
            if current not in range(4) or proposed not in (-1, current - 1, current + 1):
                raise ValueError("Invalid setup step.")
            if proposed == -1:
                if data.get("defer") == "yes":
                    saved["savedStep"] = current
                elif current == 3 and saved.get("firstApp", {}).get("opened") == "yes":
                    saved.pop("firstApp", None)
                else:
                    raise ValueError("Confirm that your first app opens.")
            elif proposed > current and current in (0, 2):
                if not cli("etat-portail")["devices" if current == 0 else "accounts"]:
                    raise ValueError("Complete the current setup step first.")
            saved["step"] = proposed
            write_preference(SETUP, json.dumps(saved))
            return True
        if current != 3:
            raise ValueError("The first-installation check is unavailable.")
        if action in ("setupFirstApp", "setupResetFirstApp"):
            if action == "setupFirstApp":
                mode = field(data, "mode", r"native")
                saved["firstApp"] = {"mode": mode, "id": field(data, "id", UUID)}
            else:
                saved.pop("firstApp", None)
            write_preference(SETUP, json.dumps(saved))
            return True
        first = saved.get("firstApp")
    if not first:
        return {"state": "untracked"}
    result = cli("setup-verification", first["mode"], first["id"])
    if result["state"] == "installed" and action == "setupConfirmOpened":
        with SETUP_LOCK:
            saved = json.loads(SETUP.read_text())
            if saved["step"] == 3 and saved.get("firstApp") == first:
                first["opened"] = "yes"
                saved["firstApp"] = first
                write_preference(SETUP, json.dumps(saved))
    if result.get("refresh") == "configured":
        try:
            probe = engine_call("probe_device", {"device_id": result["deviceID"]})
            result["refresh"] = "ready" if probe.get("reachable_ms") is not None else "unreachable"
        except (OSError, ValueError, http.client.HTTPException):
            result["refresh"] = "unreachable"
    return {**result, "opened": first.get("opened") == "yes"}


def replace_certificate(data):
    token = field(data, "token", UUID)
    serial = field(data, "serial", r"[0-9a-fA-F]{1,80}")
    message = f"SideRelay certificate replacement\n{token}\n{serial}".encode()
    approval = hmac.digest(SecuriteDocker.read_secret(SECRETS / "service-key"), message, "sha256").hex()
    with closing(http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=120)) as engine:
        engine.request("POST", "/api/replace_certificate11318273670462819093", urlencode({"token": token, "serial": serial}),
                       {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
                        "X-SideRelay-Approval": approval, **EngineAccess.headers()})
        with engine.getresponse() as response:
            data = response.read(64 * 1024)
            if response.status != 200:
                error = data.decode(errors="replace")
                if error.startswith("ServerError|"):
                    error = error.removeprefix("ServerError|")
                else:
                    try:
                        error = json.loads(error).get("ServerError", "")
                    except (ValueError, AttributeError):
                        error = ""
                raise ValueError(error or "Apple could not revoke the certificate.")
            return json.loads(data)


def inbox_settings(action, data):
    default = Path(os.environ["SIDERELAY_IPA_INBOX_DIR"])
    preference = DATA / "ipa-inbox-folder"
    if action == "resetIPAInbox":
        preference.unlink(missing_ok=True)
    elif action == "selectIPAInbox":
        folder = Path(field(data, "path", r"/[^\x00\r\n]{1,4095}")).resolve()
        if not (folder == default.resolve() or DATA.resolve() in folder.parents):
            raise ValueError(f"Choose a folder inside {DATA} or the default IPA Inbox.")
        if not folder.is_dir() or not os.access(folder, os.R_OK | os.X_OK):
            raise ValueError("SideRelay can’t read this folder. Check the container path and permissions.")
        if folder == default.resolve():
            preference.unlink(missing_ok=True)
        else:
            write_preference(preference, str(folder))
    try:
        selected = Path(preference.read_text(encoding="utf-8"))
        custom = True
    except FileNotFoundError:
        selected, custom = default, False
    return {"path": str(selected), "defaultPath": str(default), "isCustom": custom,
            "available": selected.is_dir() and os.access(selected, os.R_OK | os.X_OK)}


def host_request(method, resource, data=None):
    if os.environ.get("SIDERELAY_HOST_DISCOVERY") != "1" or not (token := os.environ.get("SIDERELAY_DISCOVERY_TOKEN")):
        return None
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    port = int(os.environ.get("SIDERELAY_DISCOVERY_PORT", "18786"))
    with closing(http.client.HTTPConnection("host.docker.internal", port, timeout=10)) as host:
        host.request(method, resource, json.dumps(data) if data is not None else None, headers)
        with host.getresponse() as response:
            if response.status != 200:
                raise ValueError("The Mac device service rejected the request.")
            return json.loads(response.read(128 * 1024))


def device_discovery():
    try:
        detected = host_request("GET", "/devices")
        status = "notConfigured"
    except (OSError, ValueError, http.client.HTTPException):
        detected, status = None, "unavailable"
    if detected is None:
        detected = {"pairing": False}
    for source in ("wifi", "tailscale", "usb"):
        detected.setdefault(source, {"status": status, "devices": []})
    if not CoreDeviceDocker.available():
        detected.pop("tvos", None)
    else:
        detected.setdefault("tvos", {"status": status, "devices": []})
    # Preserve the Mac's diagnostics and results when its Bonjour scan works.
    # If the helper is absent or stopped, a container on the LAN can still browse it.
    if MDNS_ENABLED and detected["wifi"]["status"] != "ready":
        try:
            from .DecouverteLinux import bonjour
            local = bonjour()
            if local["devices"] or detected["wifi"]["status"] != "permission":
                detected["wifi"] = local
        except (OSError, ImportError, RuntimeError):
            if detected["wifi"]["status"] != "permission":
                detected["wifi"]["status"] = "unavailable"
    with database() as db:
        registered = db.execute("SELECT ip, mdns_ip, udid, name FROM devices").fetchall()
    filter_paired_devices(detected, registered)
    return detected


def normalized_device_name(value):
    return "".join(char for char in unicodedata.normalize("NFKD", value.casefold()) if char.isalnum())


def filter_paired_devices(detected, registered):
    known = {address for ip, mdns, _, _ in registered for address in (ip, mdns) if address}
    known_ids = {udid.replace("-", "").lower() for _, _, udid, _ in registered if udid}
    saved_names = Counter(normalized_device_name(name) for _, _, _, name in registered)
    wifi = detected["wifi"]
    nearby_names = Counter(normalized_device_name(device["name"]) for device in wifi["devices"])

    def paired_on_wifi(device):
        name = normalized_device_name(device["name"])
        if not name or re.fullmatch(r"(?:iphone|ipad)[0-9]*(?:air|mini|pro|max|promax|plus)?[0-9]*", name):
            return False
        # The same device can appear under a distinct IP address on Bonjour and Tailscale.
        return saved_names[name] == nearby_names[name] == 1

    wifi["devices"] = [device for device in wifi["devices"]
                       if device["address"] not in known and not paired_on_wifi(device)]
    tailscale = detected["tailscale"]
    tailscale["devices"] = [device for device in tailscale["devices"] if device["address"] not in known]
    usb = detected["usb"]
    usb["devices"] = [device for device in usb["devices"] if device["id"].replace("-", "").lower() not in known_ids]
    if tvos := detected.get("tvos"):
        tvos["devices"] = [device for device in tvos["devices"]
                           if device["udid"].replace("-", "").lower() not in known_ids]


def install_device_versions():
    headers = {"X-SideRelay-Device": "1"}

    def read(action):
        try:
            return engine_call(action, {}, timeout=8, headers=headers)
        except (OSError, ValueError, http.client.HTTPException):
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        phones = executor.submit(read, "ios_device_versions")
        televisions = executor.submit(read, "apple_tv_devices") if CoreDeviceDocker.available() else None
        versions = phones.result() or {}
        if televisions is None:
            return versions
        tv_versions = {device["udid"]: device["osVersion"]
                       for device in (televisions.result() or []) if device["osVersion"]}
    with database() as db:
        versions.update({key: tv_versions[udid] for key, udid in db.execute(
            "SELECT id, udid FROM devices WHERE discovery = 'coredevice-tvos'") if udid in tv_versions})
    return versions


def bridge(data):
    action = data.get("action")
    if action == "dockerUpdate":
        return DOCKER_UPDATES.check()
    if action in ("portal", "connection", "restartSetup", "setupStep", "setupFirstApp", "setupResetFirstApp",
                  "setupVerifyFirstApp", "setupConfirmOpened"):
        return setup(action, data)
    if action in ("ipaInboxSettings", "selectIPAInbox", "resetIPAInbox"):
        return inbox_settings(action, data)
    if action == "deviceDiscovery":
        return device_discovery()
    if action == "pairAppleTV":
        identifier = field(data, "device", CoreDeviceDocker.TV_ID.pattern)
        return CoreDeviceDocker.mac_request("POST", f"/tvos/pair/{identifier}", timeout=75)
    if action == "importTVContainer" and CoreDeviceDocker.available():
        device = field(data, "deviceId", UUID)
        package = field(data, "packageId", PACKAGE)
        udid, bundle, source = ImportTVContainer.resolve_import(DATA, device, package)
        with source.open("rb") as ipa:
            size = os.fstat(ipa.fileno()).st_size
            if not 0 < size <= CatalogueIPA.IPA_BYTES:
                raise ValueError("The TVContainer IPA exceeds the supported size.")
            return CoreDeviceDocker.mac_request("POST", f"/tvos/import/{udid}", ipa, {
                "Content-Type": "application/octet-stream", "Content-Length": str(size),
                "X-SideRelay-Companion": bundle,
            }, timeout=240)
    if action == "installDeviceVersions":
        return install_device_versions()
    if action == "expiryAlerts":
        with database() as db:
            rows = db.execute("""
                SELECT a.id, COALESCE(a.profile_expires_at, COALESCE(a.last_refreshed,a.installed_at) + 604800)
                FROM apps a
                LEFT JOIN jobs j ON j.rowid=(SELECT rowid FROM jobs WHERE app_id=a.id ORDER BY rowid DESC LIMIT 1)
                WHERE a.installed_at IS NOT NULL AND a.refresh_enabled=1 AND a.account_id IS NOT NULL
                  AND COALESCE(a.profile_expires_at, COALESCE(a.last_refreshed,a.installed_at) + 604800)
                      <= unixepoch() + CASE WHEN j.error LIKE '[pairing-unreachable]%' THEN 259200 ELSE 86400 END
            """).fetchall()
        return dict(rows)
    if action == "importLiveContainer" and TRANSFERS:
        return TRANSFERS.create(field(data, "packageId", PACKAGE), field(data, "deviceId", UUID))
    if action == "closeLiveContainerLink" and TRANSFERS:
        TRANSFERS.close()
        return {}
    if action in ("startPairing", "pairingStatus", "retryPairing", "closePairing"):
        return host_request("POST", "/pair", data) or {"stage": "startFailed"}
    if action == "installLogs":
        return ArchiveIPA.jobs(DATA / "signature.db", field(data, "jobID", UUID) if data.get("jobID") else None)
    if action == "ipaLibrary":
        return library(data)
    if action == "discardInstallAttempt":
        return cli("retirer-tentative", field(data, "appID", UUID))
    if action == "installedAppIcon":
        return cli("installed-app-icon", field(data, "appID", UUID))
    if action == "workshopInfo":
        with database() as db:
            return ArchiveIPA.inspect(InspectionIPA.package_path(db, DATA, field(data, "packageId", PACKAGE)))
    if action == "replaceCertificate":
        return replace_certificate(data)
    if action == "appsCatalog":
        with database(True) as db:
            Backup.apply_pending(db, DATA)
        return cli("catalogue-apps")
    commands = {"activity": "activite", "clearActivity": "effacer-activite",
                "liveContainerInventory": "inventaire-livecontainer"}
    if isinstance(action, str) and action in commands:
        return cli(commands[action])
    raise ValueError("Unknown SideRelay action.")


@contextmanager
def companion_server():
    if not COMPANION_OWNER:
        yield
        return
    from .CompagnonService import handler
    configured = json.loads(os.environ.get("SIDERELAY_COMPANION_TV_ADDRESSES") or "{}")
    if not isinstance(configured, dict):
        raise ValueError("Expected a map of SideRelay Apple TV IDs to Tailscale addresses.")
    televisions = {}
    used_addresses = set()
    for device_id, value in configured.items():
        address = tailnet_ip(value) if isinstance(value, str) else None
        if not re.fullmatch(UUID, device_id) or address is None or address in used_addresses:
            raise ValueError("Assign a unique Tailscale address to each SideRelay Apple TV ID.")
        used_addresses.add(address)
        televisions[device_id] = frozenset({address})

    # Tailscale Serve on the host supplies authenticated identity headers. Keep
    # the application endpoint on loopback even in host networking mode.
    with ThreadingHTTPServer(("127.0.0.1", 19446), handler(
        DATA, COMPANION_OWNER, ENGINE_PORT, televisions=televisions, transfers=TRANSFERS,
    )) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield
        finally:
            server.shutdown()
            thread.join()


class Portal(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(150)
        super().setup()

    def log_message(self, *_):
        pass

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.headers_for(status, len(data), "application/json; charset=utf-8")
        if self.command != "HEAD":
            self.wfile.write(data)

    def headers_for(self, status, size, content_type, filename=None, nonce=None, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.security_headers(nonce)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()

    def security_headers(self, nonce=None):
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "same-origin")
        script = f" 'nonce-{nonce}'" if nonce else ""
        self.send_header("Content-Security-Policy",
                         f"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'{script}; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                         "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def redirect(self, location, cookie):
        self.headers_for(303, 0, "text/plain", headers={"Location": location, "Set-Cookie": cookie})

    def login(self):
        status = 200
        message = ""
        access = self.server.access
        if self.command == "POST":
            if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                raise ValueError("Invalid sign-in form.")
            length = self.body_length(1024)
            fields = parse_qs(self.rfile.read(length).decode("utf-8"), max_num_fields=1)
            status, token = access.sign_in(fields.get("key", [""])[0].strip())
            if token:
                return self.redirect("/", access.session_cookie(token))
            message = ("Too many attempts. Try again in a minute." if status == 429
                       else "That access key is incorrect.")
        feedback = f'<p role="alert">{message}</p>' if message else ""
        body = b'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' + HEAD + f"""
            <title>Sign In to SideRelay</title></head><body class="sr-portal-login">
            <main class="card">
                <img src="{PREFIX}assets/{ICON}" width="56" height="56" alt="">
                <h1>Sign In to SideRelay</h1>
                <p>Enter the portal access key for this Docker instance.</p>
                <form method="post" action="{PREFIX}login">
                    <label for="portal-key">Portal Access Key</label>
                    <input type="password" id="portal-key" name="key" autocomplete="current-password"
                           maxlength="128" required autofocus>
                    {feedback}
                    <button type="submit" class="btn btn-primary">Sign In</button>
                </form>
            </main></body></html>""".encode()
        headers = {"Retry-After": "60"} if status == 429 else None
        self.headers_for(status, len(body), "text/html; charset=utf-8", headers=headers)
        if self.command != "HEAD":
            self.wfile.write(body)

    def pairing_helper(self):
        token = os.environ.get("SIDERELAY_DISCOVERY_TOKEN", "")
        return (
            self.command == "POST" and self.path == PAIRING_ROUTE
            and self.headers.get("Origin") is None
            and self.headers.get_content_type() == "application/x-www-form-urlencoded"
            and re.fullmatch(r"[0-9a-f]{64}", token)
            and hmac.compare_digest(self.headers.get("X-SideRelay-Pairing-Bridge", "").encode(), token.encode())
        )

    def send_file(self, path, content_type, filename=None):
        with path.open("rb") as stream:
            self.headers_for(200, os.fstat(stream.fileno()).st_size, content_type, filename)
            if self.command != "HEAD":
                shutil.copyfileobj(stream, self.wfile, BUFFER)

    def body_length(self, limit):
        length = self.headers.get("Content-Length", "0")
        if self.headers.get("Transfer-Encoding") or not length.isdecimal() or int(length) > limit:
            raise ValueError("Request exceeds the supported upload size.")
        return int(length)

    def chunks(self, length):
        while length:
            block = self.rfile.read(min(length, BUFFER))
            if not block:
                raise ValueError("Incomplete upload.")
            yield block
            length -= len(block)

    def object_body(self, limit=64 * 1024):
        value = json.loads(self.rfile.read(self.body_length(limit)))
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object.")
        return value

    def upload_files(self, directory, limit):
        length = self.body_length(limit + 4 * BUFFER + 4)
        manifest_length = int.from_bytes(self.rfile.read(4), "big")
        if not 0 < manifest_length <= min(length - 4, 4 * BUFFER):
            raise ValueError("Invalid upload metadata.")
        data = json.loads(self.rfile.read(manifest_length))
        if not isinstance(data, dict) or not isinstance(files := data.get("files"), list) or len(files) > 20_000:
            raise ValueError("Invalid file selection.")
        remaining = length - 4 - manifest_length
        if remaining > limit:
            raise ValueError("The files exceed the supported upload size.")
        roots = set()
        for entry in files:
            if not isinstance(entry, dict):
                raise ValueError("Invalid file selection.")
            name = field(entry, "name", r"[^\\\x00-\x1f]{1,1024}")
            size = entry.get("size")
            parts = name.split("/")
            if any(part in ("", ".", "..") for part in parts) or type(size) is not int or not 0 <= size <= remaining:
                raise ValueError("Invalid file selection.")
            local = directory.joinpath(*parts)
            roots.add(directory / parts[0])
            local.parent.mkdir(parents=True, exist_ok=True)
            try:
                with local.open("xb") as file:
                    for block in self.chunks(size):
                        file.write(block)
            except FileExistsError as error:
                raise ValueError("The selection contains duplicate paths.") from error
            if local.suffix.lower() == ".dylib":
                local.chmod(0o700)
            remaining -= size
        if remaining:
            raise ValueError("The uploaded files do not match the selection.")
        return data, sorted(roots)

    def relay(self):
        headers = {key: self.headers[key] for key in (
            "Content-Type", "Accept", "X-SideRelay-Action", "X-SideRelay-App-IDs",
            "X-SideRelay-Device", "X-SideRelay-Documents", "X-SideRelay-Library", "X-SideRelay-Recovery",
        ) if key in self.headers}
        size = self.body_length(CatalogueIPA.IPA_BYTES + 1024 * 1024)
        headers["Content-Length"] = str(size)
        headers.update(EngineAccess.headers())
        with closing(http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=130)) as upstream:
            upstream.request(self.command, self.path, body=self.chunks(size) if size else None, headers=headers)
            with upstream.getresponse() as response:
                content_type = response.getheader("Content-Type", "application/octet-stream")
                if response.status == 200 and self.command == "GET" and content_type.startswith("text/html"):
                    body = response.read(8 * BUFFER + 1)
                    if len(body) > 8 * BUFFER:
                        raise ValueError("Portal page is too large.")
                    body = re.sub(br"<title>[^<]*</title>", b"<title>SideRelay</title>", body, count=1)
                    body = body.replace(HYDRATE, LOAD_INTERFACE, 1)
                    body = body.replace(b"</head>", HEAD + b"</head>", 1)
                    match = NONCE.search(body)
                    self.headers_for(response.status, len(body), content_type,
                                     nonce=match[1].decode("ascii") if match else None)
                    self.wfile.write(body)
                    return
                self.send_response(response.status)
                for header in ("Content-Type", "Content-Length", "Content-Disposition", "Location"):
                    if value := response.getheader(header):
                        self.send_header(header, value)
                self.security_headers()
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(response, self.wfile, BUFFER)

    def backup(self, action):
        password = base64.b64decode(field({"password": self.headers.get("X-SideRelay-Password")}, "password",
                                          r"[A-Za-z0-9+/=]{4,4096}"), validate=True)
        scratch = CatalogueIPA.private_work(DATA)
        with tempfile.TemporaryFile(dir=scratch) as plain, tempfile.TemporaryFile(dir=scratch) as encrypted:
            if action == "export":
                with database() as db:
                    Backup.command(db, DATA, ENGINE_PORT, action, plain)
                plain.seek(0)
                BackupCrypto.encrypt(plain, encrypted, password)
                self.headers_for(200, encrypted.tell(), "application/octet-stream", "SideRelay.siderelaybackup")
                encrypted.seek(0)
                shutil.copyfileobj(encrypted, self.wfile, BUFFER)
                return
            for block in self.chunks(self.body_length(8 * 1024 * BUFFER)):
                encrypted.write(block)
            encrypted.seek(0)
            BackupCrypto.decrypt(encrypted, plain, password)
            plain.seek(0)
            with database(action == "restore") as db:
                self.reply(200, Backup.command(db, DATA, ENGINE_PORT, action, plain))

    def sign_imported(self, workspace):
        limit = ProvisionnementIPA.PROFILE_LIMIT
        data, files = self.upload_files(workspace, 41 * limit)
        certificates = [path for path in files if path.suffix.lower() == ".p12" and path.is_file()]
        profiles = [path for path in files if path.suffix.lower() == ".mobileprovision" and path.is_file()]
        if (len(certificates) != 1 or not 1 <= len(profiles) <= 40 or len(certificates) + len(profiles) != len(files)
                or any(not 0 < path.stat().st_size <= limit for path in files)):
            raise ValueError("Choose one .p12 certificate and up to 40 provisioning profiles.")
        password = data.get("password", "")
        if not isinstance(password, str) or len(password.encode()) > 4096:
            raise ValueError("The certificate password is too long.")
        with database() as db:
            source = InspectionIPA.package_path(db, DATA, field(data, "packageId", PACKAGE))
            device = db.execute("SELECT udid FROM devices WHERE id=? AND discovery!='coredevice-tvos'",
                                (field(data, "deviceId", UUID),)).fetchone()
        if not device or not device[0]:
            raise ValueError("Choose a paired iPhone or iPad.")
        with SignatureOrbStack.relay("imported", source, device[0], certificates[0], profiles, password.encode()) as response:
            content_type = response.getheader("Content-Type")
            if content_type == "application/json":
                report = json.loads(response.read(256 * 1024))
                return self.reply(response.status, report)
            if response.status != 200 or content_type != "application/octet-stream":
                raise ValueError("The Mac signature service is unavailable.")
            length = response.getheader("Content-Length", "")
            if not re.fullmatch(r"[0-9]{1,10}", length) or not 0 < int(length) <= 2 * 1024 * BUFFER:
                raise ValueError("The signed IPA is too large.")
            self.headers_for(200, int(length), content_type, "SideRelay-signed.ipa")
            shutil.copyfileobj(response, self.wfile, BUFFER)

    def workshop(self, workspace):
        components = []
        if self.headers.get_content_type() == "application/octet-stream":
            data, components = self.upload_files(workspace / "components", MAX_COMPONENTS_SIZE)
        else:
            data = self.object_body(3 * BUFFER)
        package = field(data, "packageId", PACKAGE)
        fields = {"name", "identifier", "minimum", "sharing", "removeDeviceModels", "remove"}
        options = {key: value for key, value in data.items() if key in fields}
        if any(not isinstance(options.get(key, ""), str) for key in ("name", "identifier", "minimum")):
            raise ValueError("Invalid app metadata.")
        if any(not isinstance(options.get(key, False), bool) for key in ("sharing", "removeDeviceModels")):
            raise ValueError("Invalid app settings.")
        removed = options.get("remove", [])
        if not isinstance(removed, list) or any(not isinstance(path, str) for path in removed):
            raise ValueError("Invalid extension selection.")
        options["components"] = [str(path) for path in components]
        with database() as db:
            source = InspectionIPA.package_path(db, DATA, package)
        target = workspace / "prepared.ipa"
        if data.get("icon"):
            icon = base64.b64decode(field(data, "icon", r"[A-Za-z0-9+/=]{4,2800000}"), validate=True)
            path = workspace / "icon"
            path.write_bytes(icon)
            options["icon"] = str(path)
        ArchiveIPA.modified_ipa(source, target, options, workspace)
        if data.get("destination") == "library":
            with target.open("rb") as stream:
                self.reply(200, CatalogueIPA.upload_archive(stream, ENGINE_PORT, target.stat().st_size))
        else:
            self.send_file(target, "application/octet-stream", "SideRelay-prepared.ipa")

    def import_build(self, workspace):
        _, roots = self.upload_files(workspace, CatalogueIPA.IPA_BYTES)
        if len(roots) != 1 or roots[0].suffix.lower() != ".app":
            raise ValueError("Choose one iPhone or iPad .app build.")
        # Directory uploads don't preserve mode bits. Give the declared executable
        # its execute bit before packaging the archive.
        app = roots[0]
        for info in app.rglob("Info.plist"):
            if info.parent.suffix not in (".app", ".appex", ".framework") or info.stat().st_size > InspectionIPA.PLIST_LIMIT:
                continue
            metadata = ArchiveIPA.plistlib.loads(info.read_bytes())
            name = metadata.get("CFBundleExecutable") if isinstance(metadata, dict) else None
            if isinstance(name, str) and PurePosixPath(name).name == name:
                executable = info.parent / name
                if executable.is_file():
                    executable.chmod(0o700)
        self.reply(200, CatalogueIPA.import_build(DATA, ENGINE_PORT, str(app)))

    def signed_batch(self, batch):
        base = (DATA / "ipas" / "signed").resolve()
        source = (base / batch).resolve()
        if source.parent != base or not source.is_dir():
            return self.reply(404, {"error": "Signed files are unavailable."})
        with tempfile.TemporaryDirectory(prefix="web-batch-", dir=CatalogueIPA.private_work(DATA)) as workspace:
            path = Path(workspace) / "signed.zip"
            with zipfile.ZipFile(path, "x") as archive:
                for entry in sorted(source.glob("*.ipa")):
                    if entry.is_file() and not entry.is_symlink():
                        archive.write(entry, entry.name)
            self.send_file(path, "application/zip", "SideRelay-signed-IPAs.zip")

    def download_ipa(self, package):
        with database() as db:
            row = db.execute("SELECT display_name FROM ipa_packages WHERE id = ? AND removed_at IS NULL",
                             (package,)).fetchone()
            if not row:
                return self.reply(404, {"error": "This IPA is no longer in the library."})
            try:
                path = InspectionIPA.package_path(db, DATA, package)
            except FileNotFoundError:
                return self.reply(404, {"error": "This IPA is no longer available."})
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", row[0] or "").strip("-.")[:80] or "SideRelay"
        self.send_file(path, "application/octet-stream", name + ".ipa")

    def handle_request(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if not HOST.fullmatch(host) or (origin and origin != f"http://{host}") or self.headers.get("Sec-Fetch-Site") == "cross-site":
            return self.reply(403, {"error": "Open SideRelay through its local port."})
        path = urlsplit(self.path).path
        if self.pairing_helper():
            self.body_length(1024 * 1024)
            return self.relay()
        if self.command == "POST" and origin != f"http://{host}":
            return self.reply(403, {"error": "A local SideRelay page must submit this request."})
        if self.command in ("GET", "HEAD") and path == PREFIX + "health":
            try:
                with socket.create_connection(("127.0.0.1", ENGINE_PORT), timeout=0.5):
                    return self.reply(200, {"ready": True})
            except OSError:
                return self.reply(503, {"ready": False})
        if self.command in ("GET", "HEAD") and path == "/favicon.ico":
            return self.send_file(ROOT / "Interface" / ICON, ASSETS[ICON])
        public_assets = ("App.css", "Web.css", ICON)
        if self.command in ("GET", "HEAD") and path in {f"{PREFIX}assets/{name}" for name in public_assets}:
            name = path.rsplit("/", 1)[1]
            return self.send_file(ROOT / "Interface" / name, ASSETS[name])
        raw_cookie = self.headers.get("Cookie", "")
        if path == PREFIX + "login":
            return self.login()
        if not self.server.access.authorized(raw_cookie):
            if self.command in ("GET", "HEAD") and self.headers.get("Sec-Fetch-Dest") in (None, "document"):
                return self.redirect(PREFIX + "login", self.server.access.session_cookie())
            return self.reply(401, {"error": "Sign in to the SideRelay portal."})
        if self.command == "POST" and path == PREFIX + "logout":
            self.server.access.sign_out(raw_cookie)
            return self.redirect(PREFIX + "login", self.server.access.session_cookie())
        if not path.startswith(PREFIX):
            return self.relay()
        endpoint = path.removeprefix(PREFIX)
        if self.command in ("GET", "HEAD") and endpoint.startswith("assets/"):
            name = endpoint.removeprefix("assets/")
            if name in ASSETS:
                return self.send_file(ROOT / "Interface" / name, ASSETS[name])
        if self.command == "GET" and (batch := re.fullmatch(r"signed/(" + UUID + ")", endpoint)):
            return self.signed_batch(batch[1])
        if self.command in ("GET", "HEAD") and (package := re.fullmatch(r"ipa/(" + PACKAGE + ")", endpoint)):
            return self.download_ipa(package[1])
        if self.command == "POST" and self.headers.get("X-SideRelay-Web") == "1":
            if endpoint == "bridge":
                return self.reply(200, bridge(self.object_body()))
            if endpoint == "sign-imported" and MAC_SIGNING:
                if self.headers.get_content_type() != "application/octet-stream":
                    raise ValueError("Choose the certificate and profiles to upload.")
                with tempfile.TemporaryDirectory(prefix="web-signing-", dir=CatalogueIPA.private_work(DATA)) as directory:
                    return self.sign_imported(Path(directory))
            if endpoint in ("workshop", "import-build"):
                with tempfile.TemporaryDirectory(prefix=f"web-{endpoint}-", dir=CatalogueIPA.private_work(DATA)) as directory:
                    return (self.workshop if endpoint == "workshop" else self.import_build)(Path(directory))
            if endpoint in ("backup/export", "backup/review", "backup/restore"):
                return self.backup(endpoint.split("/")[1])
        self.reply(404, {"error": "Unknown SideRelay route."})

    def dispatch(self):
        try:
            self.handle_request()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, zipfile.BadZipFile, ArchiveIPA.plistlib.InvalidFileException) as error:
            self.reply(400, {"error": str(error)[:500]})
        except (OSError, subprocess.SubprocessError, sqlite3.Error, http.client.HTTPException, ssl.SSLError) as error:
            print(f"Portal request failed: {self.command} {type(error).__name__}", file=sys.stderr, flush=True)
            self.reply(503, {"error": "SideRelay could not complete this request. Try again or check the container log."})

    do_GET = do_HEAD = do_POST = dispatch


def main():
    os.umask(0o077)
    key_path, access = SecuriteDocker.prepare(DATA, SECRETS)
    os.environ["JAS_SECRET_KEY_FILE"] = str(key_path)
    os.environ["SIDERELAY_ENCRYPT_ACCOUNT_NAMES"] = "1"
    Path(os.environ["SIDERELAY_IPA_INBOX_DIR"]).mkdir(exist_ok=True)
    if not SETUP.exists() and not (DATA / "signature.db").exists():
        write_preference(SETUP, json.dumps({"step": 0}))
    args = [sys.executable, "-B", str(ROOT / "signature-ios"), "servir"]
    if not MDNS_ENABLED:
        args.append("--no-mdns")
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    default_bind = "127.0.0.1" if COMPANION_OWNER else "0.0.0.0"
    with ThreadingHTTPServer((os.environ.get("SIDERELAY_WEB_BIND", default_bind), PORT), Portal) as server, companion_server():
        server.access = access
        server.timeout = 0.5
        with subprocess.Popen(args) as engine:
            try:
                while not stopping and engine.poll() is None:
                    server.handle_request()
            finally:
                if engine.poll() is None:
                    engine.terminate()
                    try:
                        engine.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        engine.kill()
            return (engine.returncode or 0) if not stopping else 0


if __name__ == "__main__":
    sys.exit(main())
