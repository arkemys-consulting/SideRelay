"""Serve one selected IPA briefly to the owner's devices on the tailnet."""

from contextlib import closing, suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener
from urllib.error import URLError

from .ArchiveIPA import devicectl_json
from .InspectionIPA import package_path


TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
PORT = 19444
DURATION = 300


def tailscale(*arguments):
    try:
        result = subprocess.check_output([TAILSCALE, *arguments], stderr=subprocess.DEVNULL, timeout=6,
                                         env={**os.environ, "TAILSCALE_BE_CLI": "1"})
        return json.loads(result)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise ValueError("Open Tailscale on the Mac and connect to your network.") from error


def tailnet():
    status = tailscale("status", "--json")
    node = status.get("Self") or {}
    hostname = node.get("DNSName", "").rstrip(".")
    owner = status.get("User", {}).get(str(node.get("UserID")), {}).get("LoginName")
    if (status.get("BackendState") != "Running" or not owner
            or not re.fullmatch(r"[a-zA-Z0-9.-]+\.ts\.net", hostname)):
        raise ValueError("Connect Tailscale on the Mac with MagicDNS and HTTPS available.")
    config = tailscale("serve", "status", "--json")
    if str(PORT) in config.get("TCP", {}) or any(
        host.endswith(f":{PORT}") for host in (config.get("Web", {}) | config.get("AllowFunnel", {}))
    ):
        raise ValueError("The Tailscale port for LiveContainer is already in use.")
    return hostname, owner


def installed_host(udid):
    try:
        apps = devicectl_json(["device", "info", "apps", "--device", udid,
                              "--no-include-default-apps", "--search", "livecontainer"], timeout=5)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return any(re.fullmatch(r"com\.kdt\.livecontainer(?:\.[A-Za-z0-9-]+)?",
                            app.get("bundleIdentifier", ""), re.IGNORECASE)
               for app in apps.get("apps", []))


def open_import(udid, url):
    try:
        devicectl_json(["device", "process", "openURL", "--device", udid, url], timeout=7)
        return True
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def transfer(root, package_id, device_id, cancelled):
    from .LiveContainerSigning import signing_setup

    if not re.fullmatch(r"[a-f0-9]{32}|[a-f0-9]{64}", package_id):
        raise ValueError("Choose an IPA from the library.")
    with closing(sqlite3.connect((root / "signature.db").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        ipa = package_path(db, root, package_id)
        device = db.execute("SELECT udid FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not device or not re.fullmatch(r"[0-9A-Fa-f-]{24,40}", device[0]):
        raise ValueError("Select a paired iPhone in SideRelay.")
    udid = device[0]
    setup = signing_setup(root, 18784, device_id)
    if not setup.get("ready"):
        print(json.dumps(setup), flush=True)
        return
    hostname, owner = tailnet()
    token = secrets.token_urlsafe(32)
    entry = f"/{token}/"
    download = entry + "app.ipa"
    origin = f"https://{hostname}:{PORT}"
    deep_link = "livecontainer://install?" + urlencode({"url": origin + download})
    landing = (
        "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        "<meta name=referrer content=no-referrer><title>SideRelay</title>"
        "<body style='font:18px system-ui;padding:24px'><h1>SideRelay</h1>"
        f"<p><a href='{deep_link}'>Open in LiveContainer</a></p>"
        "<p>LiveContainer will download the IPA on this iPhone.</p></body></html>"
    ).encode()

    class DownloadHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self.serve()

        def do_GET(self):
            self.serve()

        def serve(self):
            self.connection.settimeout(20)
            if cancelled.is_set() or self.headers.get("Tailscale-User-Login") != owner:
                self.send_error(404)
                return
            if self.path == entry:
                self.send_body("text/html; charset=utf-8", len(landing))
                if self.command == "GET":
                    self.wfile.write(landing)
            elif self.path == download:
                with ipa.open("rb") as file:
                    self.send_body("application/octet-stream", os.fstat(file.fileno()).st_size)
                    if self.command == "GET":
                        shutil.copyfileobj(file, self.wfile, length=256 * 1024)
            else:
                self.send_error(404)

        def send_body(self, content_type, size):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()

    with ThreadingHTTPServer(("127.0.0.1", 0), DownloadHandler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            relay = subprocess.Popen(
                [TAILSCALE, "serve", "--yes", "--https", str(PORT), f"http://127.0.0.1:{server.server_port}"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={**os.environ, "TAILSCALE_BE_CLI": "1"},
            )
            try:
                opener = build_opener(ProxyHandler({}))
                deadline = time.monotonic() + 12
                while not cancelled.is_set() and relay.poll() is None and time.monotonic() < deadline:
                    try:
                        with opener.open(origin + entry, timeout=1) as response:
                            if response.read() == landing:
                                break
                    except (URLError, TimeoutError, OSError):
                        cancelled.wait(0.25)
                else:
                    raise ValueError("Tailscale could not open a private HTTPS link for this IPA.")
                opened = open_import(udid, deep_link)
                if not cancelled.is_set():
                    print(json.dumps({"opened": opened, "link": origin + entry}), flush=True)
                    cancelled.wait(DURATION)
            finally:
                if relay.poll() is None:
                    relay.terminate()
                    try:
                        relay.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        relay.kill()
                        relay.wait()
        finally:
            server.shutdown()


def main():
    import sys

    cancelled = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: cancelled.set())
    try:
        transfer(Path(sys.argv[1]), sys.argv[2], sys.argv[3], cancelled)
    except (OSError, ValueError, sqlite3.Error) as error:
        with suppress(BrokenPipeError):
            print(json.dumps({"error": str(error)[:300]}), flush=True)


if __name__ == "__main__":
    main()
