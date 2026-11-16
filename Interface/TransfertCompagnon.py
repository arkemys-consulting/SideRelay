"""Short-lived IPA links for the selected device on the owner's tailnet."""

from contextlib import closing
import base64
from html import escape
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from urllib.parse import urlencode
from zipfile import ZipFile

from .CatalogueIPA import main_ipa_plist
from .CompagnonIPA import tailnet_ip
from .InspectionIPA import package_path

ROOT = "livecontainer-import"
LIFETIME = 300


class Transfers:
    def __init__(self, data, address, owner):
        if not re.fullmatch(r"https://[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.ts\.net:(?:19445|19447)", address):
            raise ValueError("Set the companion address to its Tailscale HTTPS address on port 19445 or 19447.")
        self.data = data
        self.address = address
        self.owner = owner
        self.entry = None
        self.lock = threading.Lock()

    def create(self, package, device_id):
        uri = (self.data / "signature.db").as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=3)) as db:
            device = db.execute("SELECT ip FROM devices WHERE id=? AND discovery!='coredevice-tvos'", (device_id,)).fetchone()
            address = tailnet_ip(device[0]) if device else None
            if address is None:
                raise ValueError("Choose a paired iPhone or iPad with its Tailscale address set in Devices.")
            ipa = package_path(db, self.data, package)
        with ZipFile(ipa) as archive:
            _, info = main_ipa_plist(archive)
        platforms = info.get("CFBundleSupportedPlatforms") or []
        if "iPhoneOS" not in platforms:
            raise ValueError("Choose an IPA built for iPhone or iPad.")
        with self.lock:
            if self.entry and self.entry[0] > time.monotonic():
                return {"error": "Close the existing import link before creating another.", "linkInUse": True}
            token = secrets.token_urlsafe(32)
            link = f"{self.address}/{ROOT}/{token}/"
            qr = subprocess.run(["qrencode", "-t", "PNG", "-o", "-"], input=link.encode(),
                                check=True, capture_output=True, timeout=3).stdout
            self.entry = (time.monotonic() + LIFETIME, token, address, ipa)
        return {"qr": base64.b64encode(qr).decode("ascii"), "opened": False}

    def close(self):
        with self.lock:
            self.entry = None

    def serve(self, request):
        match = re.fullmatch(rf"/{ROOT}/([A-Za-z0-9_-]{{43}})/(app\.ipa)?", request.path)
        address = tailnet_ip(request.headers.get("X-Forwarded-For", ""))
        with self.lock:
            entry = self.entry
        if (not match or not entry or entry[0] <= time.monotonic()
                or request.headers.get("Tailscale-User-Login") != self.owner
                or address != entry[2] or not secrets.compare_digest(match[1], entry[1])):
            request.reply(404, {})
            return
        url = f"{self.address}/{ROOT}/{entry[1]}/app.ipa"
        link = escape("livecontainer://install?" + urlencode({"url": url}), quote=True)
        body = (f'<!doctype html><html lang="en"><meta charset="utf-8">'
                f'<meta name="viewport" content="width=device-width"><title>SideRelay</title>'
                f'<a href="{link}">Open in LiveContainer</a></html>').encode()
        def send(content_type, size):
            request.send_response(200)
            request.send_header("Content-Type", content_type)
            request.send_header("Content-Length", str(size))
            request.send_header("Cache-Control", "no-store")
            request.send_header("Referrer-Policy", "no-referrer")
            request.send_header("X-Content-Type-Options", "nosniff")
            request.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
            request.end_headers()

        if match[2]:
            try:
                ipa = entry[3].open("rb")
            except OSError:
                return request.reply(404, {})
            with ipa:
                send("application/octet-stream", os.fstat(ipa.fileno()).st_size)
                if request.command == "GET":
                    shutil.copyfileobj(ipa, request.wfile, 256 * 1024)
        else:
            send("text/html; charset=utf-8", len(body))
            if request.command == "GET":
                request.wfile.write(body)
