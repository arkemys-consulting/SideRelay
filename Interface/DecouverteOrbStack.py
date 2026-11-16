"""Serve the Mac's SideRelay discovery results to the local OrbStack container."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tarfile
import tempfile
import threading


if __package__:
    from . import CoreDeviceDocker as tvos
    from . import SignatureOrbStack
else:
    import CoreDeviceDocker as tvos
    import SignatureOrbStack

SCRIPT = Path(__file__).resolve().parents[1] / "signature-ios"
TV_PATH = re.compile(r"/tvos/(apps|install|uninstall|pair)/([0-9a-fA-F-]{8,64})")


class Pairing:
    def __init__(self, command, token):
        self.command = command
        self.token = token
        self.process = None
        self.lock = threading.Lock()

    def request(self, query):
        with self.lock:
            if not self.process or self.process.poll() is not None:
                if query["action"] != "startPairing":
                    return {"stage": "idle"}
                self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, encoding="utf-8", bufsize=1,
                                                env={**os.environ, "SIDERELAY_PAIRING_TOKEN": self.token})
            process = self.process
            try:
                process.stdin.write(json.dumps(query) + "\n")
                process.stdin.flush()
                if not select.select([process.stdout], [], [], 5)[0]:
                    raise TimeoutError()
                return json.loads(process.stdout.readline(4096))
            except (OSError, ValueError):
                process.stdin.close()
                self.process = None
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                return {"stage": "startFailed"}


def scan(*command):
    try:
        result = subprocess.run(command, check=True, capture_output=True, timeout=7)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"status": "unavailable", "devices": []}


class Discovery(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(35)
        super().setup()

    def log_message(self, *_):
        pass

    def authorized(self, path):
        expected_host = f"host.docker.internal:{self.server.server_port}"
        if self.path != path or self.headers.get("Host") != expected_host:
            self.send_error(404)
            return False
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), self.server.authorization):
            self.send_error(403)
            return False
        return True

    def do_GET(self):
        if self.path.startswith("/tvos/"):
            return self.apple_tv()
        if not self.authorized("/devices"):
            return
        with ThreadPoolExecutor(max_workers=4) as executor:
            wifi = executor.submit(scan, self.server.bonjour)
            tailscale = executor.submit(scan, sys.executable, "-B", str(SCRIPT), "decouverte-tailscale")
            usb = executor.submit(scan, sys.executable, "-B", str(SCRIPT), "decouverte-usb") if self.server.pairing else None
            apple_tv = executor.submit(self.tv_discovery) if self.server.apple_tv else None
            self.reply({"wifi": wifi.result(), "tailscale": tailscale.result(), "pairing": bool(self.server.pairing),
                        "usb": usb.result() if usb else {"status": "notConfigured", "devices": []},
                        "tvos": apple_tv.result() if apple_tv else {"status": "notConfigured", "devices": []}})

    def do_POST(self):
        if self.path in SignatureOrbStack.ROUTES:
            if not self.server.signature_helper:
                return self.send_error(404)
            if self.authorized(self.path):
                return SignatureOrbStack.serve(self, self.server.signature_helper,
                                              self.server.signature_work_dir, self.server.signature_lock)
            return
        if self.path.startswith("/tvos/"):
            return self.apple_tv()
        if not self.authorized("/pair"):
            return
        try:
            count = int(self.headers.get("Content-Length", "0"))
            if not 0 < count <= 4096:
                raise ValueError()
            query = json.loads(self.rfile.read(count))
            allowed = ("startPairing", "pairingStatus", "retryPairing", "closePairing")
            if not isinstance(query, dict) or query.get("action") not in allowed:
                raise ValueError()
            if not all(isinstance(value, str) for value in query.values()):
                raise ValueError()
        except ValueError:
            self.send_error(400)
            return
        self.reply(self.server.pairing.request(query) if self.server.pairing else {"stage": "startFailed"})

    def tv_discovery(self):
        try:
            return tvos.nearby()
        except ValueError:
            return {"status": "unavailable", "devices": []}

    def apple_tv(self):
        target = TV_PATH.fullmatch(self.path)
        valid = (self.path == "/tvos/devices" and self.command == "GET") or (
            target and self.command == ("GET" if target[1] == "apps" else "POST")
        )
        if not self.server.apple_tv or not valid:
            return self.send_error(404)
        if not self.authorized(self.path):
            return
        try:
            if self.path == "/tvos/devices":
                devices = [{
                    "hardwareProperties": {"platform": "tvOS", "udid": device["hardwareProperties"].get("udid")},
                    "connectionProperties": {
                        "transportType": "localNetwork",
                        "pairingState": device["connectionProperties"].get("pairingState"),
                    },
                    "deviceProperties": {
                        "name": device["deviceProperties"].get("name"),
                        "osVersionNumber": device["deviceProperties"].get("osVersionNumber"),
                    },
                } for device in tvos.local_devices()]
                return self.reply({"devices": devices})
            action, identifier = target.groups()
            if action == "pair":
                return self.reply(tvos.pair(identifier))
            if tvos.paired_device(identifier) is None:
                raise ValueError("Pair the Apple TV with the Mac on the local network.")
            if action == "apps":
                result = tvos.devicectl("device", "info", "apps", "--include-all-apps", "--device", identifier, timeout=12)
                if not isinstance(result.get("apps"), list):
                    raise ValueError("CoreDevice did not return a list of installed apps.")
                return self.reply({"apps": [{"bundleIdentifier": app["bundleIdentifier"]}
                                            for app in result["apps"] if app.get("bundleIdentifier")]})
            size = int(self.headers.get("Content-Length", "0"))
            if action == "uninstall":
                if not 0 < size <= 1024:
                    raise ValueError("Choose an installed Apple TV app.")
                request = json.loads(self.rfile.read(size))
                bundle = request.get("bundle", "") if isinstance(request, dict) else ""
                if not isinstance(bundle, str) or not tvos.BUNDLE_ID.fullmatch(bundle):
                    raise ValueError("Choose an installed Apple TV app.")
                return self.reply(tvos.devicectl("device", "uninstall", "app", "--device", identifier, bundle, timeout=30))
            if self.headers.get_content_type() != "application/x-tar":
                raise ValueError("Expected a signed Apple TV application archive.")
            with self.server.install_lock, tempfile.TemporaryDirectory(
                prefix="siderelay-tvos-", dir=self.server.apple_tv_work_dir,
            ) as workspace:
                app = tvos.receive_app(self.rfile, size, Path(workspace))
                result = tvos.devicectl("device", "install", "app", "--device", identifier, str(app), timeout=300)
            self.reply(result)
        except (OSError, ValueError, tarfile.TarError) as error:
            self.reply({"error": str(error)[:1500]}, status=400)

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bonjour", type=Path, required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--pair", type=Path)
    parser.add_argument("--portal-port", type=int, default=18785)
    parser.add_argument("--port", type=int, default=18786)
    parser.add_argument("--apple-tv", action="store_true")
    parser.add_argument("--apple-tv-work-dir", type=Path)
    parser.add_argument("--identity-helper", type=Path)
    parser.add_argument("--signature-work-dir", type=Path)
    args = parser.parse_args()
    credentials = args.credentials.read_text().strip()
    if not re.fullmatch(r"SIDERELAY_DISCOVERY_TOKEN=[a-f0-9]{64}", credentials):
        parser.error("Invalid discovery credentials.")
    token = credentials.split("=", 1)[1]
    with ThreadingHTTPServer(("127.0.0.1", args.port), Discovery) as server:
        server.authorization = f"Bearer {token}".encode()
        server.bonjour = args.bonjour
        server.apple_tv = args.apple_tv
        server.apple_tv_work_dir = args.apple_tv_work_dir
        server.signature_work_dir = args.signature_work_dir or args.apple_tv_work_dir
        helper = args.identity_helper or SCRIPT.parent / "siderelay-identity"
        server.signature_helper = helper if server.signature_work_dir and os.access(helper, os.X_OK) else None
        server.signature_lock = threading.Lock()
        server.install_lock = threading.Lock()
        server.pairing = Pairing([args.bonjour, "pair", str(args.portal_port), args.pair], token) if args.pair else None
        server.serve_forever()


if __name__ == "__main__":
    main()
