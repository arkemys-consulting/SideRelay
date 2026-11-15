"""Bind the companion to a paired Apple TV and that device's Tailnet identity."""

from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from uuid import UUID
from zipfile import ZipFile

from .CompagnonIPA import enabled, tailnet_ip
from .CatalogueIPA import download, main_ipa_plist, private_work, refresh_catalogues, tv_sources, upload_archive
from .CompagnonMisesAJour import engine_request
from .ImportLiveContainer import tailscale


def enrollment_path(root):
    return private_work(root) / "companion-tv-devices.json"


def read_enrollments(path):
    try:
        result = json.loads(path.read_text())
        if isinstance(result, dict):
            return result
    except (OSError, ValueError):
        pass
    return {}


def owned_tv_peers(status):
    owner = (status.get("Self") or {}).get("UserID")
    return {p["ID"]: p for p in (status.get("Peer") or {}).values()
            if owner and p.get("UserID") == owner and p.get("OS", "").casefold() == "tvos" and p.get("ID")}


def tv_addresses(root, status):
    peers = owned_tv_peers(status)
    devices = read_enrollments(enrollment_path(root))
    return {device: frozenset(filter(None, map(tailnet_ip, peers[peer].get("TailscaleIPs") or [])))
            for device, peer in devices.items() if isinstance(peer, str) and peer in peers}


def enroll(root, device_id, hostname):
    device_id = str(UUID(device_id))
    with closing(sqlite3.connect((root / "signature.db").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        if not db.execute("SELECT 1 FROM devices WHERE id=? AND discovery='coredevice-tvos'", (device_id,)).fetchone():
            raise ValueError("Choose a paired Apple TV in SideRelay.")
    peers = owned_tv_peers(tailscale("status", "--json"))
    hostname = hostname.casefold().rstrip(".")
    matches = [peer_id for peer_id, peer in peers.items() if hostname in
               (peer.get("HostName", "").casefold(), peer.get("DNSName", "").casefold().rstrip("."))]
    if len(matches) != 1:
        raise ValueError("Choose the matching Apple TV in your own Tailscale devices.")
    peer_id = matches[0]
    path = enrollment_path(root)
    lock_fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        devices = read_enrollments(path)
        if any(peer == peer_id and device != device_id for device, peer in devices.items()):
            raise ValueError("This Tailscale Apple TV is already paired with another SideRelay device.")
        devices[device_id] = peer_id
        with tempfile.NamedTemporaryFile(mode="w", prefix="companion-tv-", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                json.dump(devices, output)
                output.flush()
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
    enabled(root).touch(mode=0o600, exist_ok=True)


def tv_editions(db):
    definitions = tv_sources()
    for source, url, raw in db.execute("SELECT id,url,catalogue FROM ipa_sources WHERE catalogue!='[]'"):
        if url not in definitions:
            continue
        for app in json.loads(raw):
            if app["bundleId"] != definitions[url]["bundleIdentifier"]:
                continue
            for release in app["versions"]:
                if release.get("platform") == "tvOS" and not release.get("restricted"):
                    yield source, app, release


def refresh_tv_sources(db, root):
    cutoff = int(time.time()) - 3600
    entries = [entry for entry in db.execute("SELECT id,url FROM ipa_sources WHERE checked_at<=?", (cutoff,))
               if entry[1] in tv_sources()]
    if entries:
        uri = (root / "signature.db").as_uri() + "?mode=rw"
        with closing(sqlite3.connect(uri, uri=True, timeout=2)) as writer:
            refresh_catalogues(writer, entries)


def installed_tv_app(db, device, bundle):
    return db.execute("""
        SELECT a.id,a.account_id,a.version,p.id,p.metadata FROM apps a
        LEFT JOIN ipa_packages p ON p.path=a.ipa_path
        WHERE a.device_id=? AND a.installed_at IS NOT NULL
        AND (lower(p.bundle_id)=lower(?) OR lower(a.bundle_id)=lower(?)
             OR lower(a.bundle_id)=lower(? || '.' || a.signing_team)) LIMIT 2
    """, (device, bundle, bundle, bundle)).fetchall()


def queue_tv_install(db, port, device, bundle, package_id):
    installs = installed_tv_app(db, device, bundle)
    if len(installs) > 1:
        return None
    if installs:
        target, account, *_ = installs[0]
    else:
        target = ""
        companion = installed_tv_app(db, device, "com.hubzzzgr.tvcontainer")
        account = companion[0][1] if len(companion) == 1 else None
    if not account:
        return None
    return engine_request(port, "install_library_ipa", {"package_id": package_id, "device_id": device,
                          "account_id": account, "target_app_id": target, "use_main_profile": "false"}, timeout=60)


def install_uploaded_ipa(db, port, device, archive, size):
    with ZipFile(archive) as package:
        _, info = main_ipa_plist(package)
    if not isinstance(info, dict) or info.get("CFBundleSupportedPlatforms") != ["AppleTVOS"]:
        raise ValueError("Choose an IPA built for Apple TV.")
    bundle = info.get("CFBundleIdentifier")
    if not isinstance(bundle, str) or not re.fullmatch(r"[A-Za-z0-9.-]{1,255}", bundle):
        raise ValueError("The IPA has no valid bundle ID.")
    if bundle.casefold() == "com.hubzzzgr.tvcontainer":
        raise ValueError("Update the SideRelay companion on the Mac.")
    package = upload_archive(archive, port, size, {"X-SideRelay-Bundle": bundle})
    return queue_tv_install(db, port, device, bundle, package["id"])


def version_parts(value):
    match = re.match(r"^[0-9]+(?:\.[0-9]+)*", value or "")
    return tuple(map(int, match[0].split("."))) if match else ()


def tv_store_action(installs, release):
    if not installs:
        return "get"
    if len(installs) != 1 or not installs[0][1]:
        return "unavailable"
    _, _, version, package, metadata = installs[0]
    if package and package == release.get("sha256"):
        return "installed"
    current, next_version = version_parts(version), version_parts(release["version"])
    try:
        build = str(json.loads(metadata).get("build") or "") if metadata else ""
    except (ValueError, AttributeError):
        build = ""
    has_update = bool(current and next_version > current)
    if current and current == next_version and build and release.get("build"):
        has_update = version_parts(release["build"]) > version_parts(build)
    return "update" if has_update else "installed"


def store(db, root, device):
    refresh_tv_sources(db, root)
    items = []
    for _, app, release in tv_editions(db):
        installs = installed_tv_app(db, device, app["bundleId"])
        items.append({"bundleID": app["bundleId"], "name": app["name"], "developer": app["developer"],
                      "subtitle": app["subtitle"], "description": app["description"], "icon": app["icon"] or None,
                      "preview": app["preview"] or None, "version": release["version"], "beta": app["beta"],
                      "minimumOS": release["minOS"], "releaseID": release["id"], "action": tv_store_action(installs, release)})
    items.sort(key=lambda item: item["name"].casefold())
    return {"apps": items, "app": next((item for item in items if item["bundleID"] == "com.example.orbrisa"), None)}


def install_from_store(db, root, port, device, release_id):
    edition = next((edition for edition in tv_editions(db) if edition[2]["id"] == release_id), None)
    if not edition:
        return None
    source, app, release = edition
    bundle = app["bundleId"]
    installs = installed_tv_app(db, device, bundle)
    action = tv_store_action(installs, release)
    if action not in ("get", "update"):
        return None
    if action == "update":
        target, account, *_ = installs[0]
    else:
        target = ""
        host = installed_tv_app(db, device, "com.hubzzzgr.tvcontainer")
        account = host[0][1] if len(host) == 1 else None
    if not account or db.execute("""
        SELECT 1 FROM jobs j JOIN apps a ON a.id=j.app_id WHERE a.device_id=?
        AND (lower(a.bundle_id)=? OR lower(a.bundle_id) LIKE ?) AND j.status IN ('queued','running','pending')
    """, (device, bundle.lower(), bundle.lower() + ".%")).fetchone():
        return None
    package = download(db, root, port, source, bundle, release_id)
    return engine_request(port, "install_library_ipa", {"package_id": package["id"], "device_id": device,
                          "account_id": account, "target_app_id": target, "use_main_profile": "false"})


if __name__ == "__main__":
    enroll(Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3])
