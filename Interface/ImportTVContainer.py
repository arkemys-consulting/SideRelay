"""Transfer a library IPA to the TVContainer companion over CoreDevice."""

from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
from uuid import UUID, uuid4
from zipfile import ZipFile

from .ArchiveIPA import devicectl_json
from .CatalogueIPA import private_work
from .CompagnonTV import installed_tv_app
from .InspectionIPA import main_info, package_path


HOST = "com.hubzzzgr.tvcontainer"
HOST_BUNDLE = re.compile(re.escape(HOST) + r"(?:\.[A-Za-z0-9-]+)?")


def resolve_import(root, device, package):
    device = str(UUID(device))
    with closing(sqlite3.connect((root / "signature.db").as_uri() + "?mode=ro", uri=True)) as db:
        hosts = installed_tv_app(db, device, HOST)
        if len(hosts) != 1:
            raise ValueError("Install the SideRelay companion on this Apple TV first.")
        udid, bundle, expires, repair, companion = db.execute("""
            SELECT d.udid,a.bundle_id,a.profile_expires_at,a.signing_repair,a.ipa_path
            FROM apps a JOIN devices d ON d.id=a.device_id
            WHERE a.id=? AND d.id=? AND d.discovery='coredevice-tvos'
        """, (hosts[0][0], device)).fetchone() or (None,) * 5
        source = package_path(db, root, package)
    if not udid or not re.fullmatch(r"[0-9A-Fa-f-]{24,40}", udid) or not HOST_BUNDLE.fullmatch(bundle or ""):
        raise ValueError("Select the paired Apple TV with SideRelay installed.")
    if repair or (expires is not None and expires <= time.time()):
        raise ValueError("Refresh the SideRelay companion’s signature first.")
    host_app = (root / (companion or "")).resolve()
    if not host_app.is_relative_to((root / "ipas").resolve()) or not host_app.is_file():
        raise ValueError("Update the SideRelay companion to enable TVContainer imports.")
    with ZipFile(host_app) as archive:
        _, host_info = main_info(archive)
    config = host_info.get("SideRelayConnection")
    if not isinstance(config, dict) or config.get("deviceID") != device or config.get("pairedImport") != 1:
        raise ValueError("Update the SideRelay companion to enable TVContainer imports.")
    return udid, bundle, source


def install(root, device, package):
    device = str(UUID(device))
    udid, bundle, source = resolve_import(root, device, package)

    work = private_work(root)
    fd = os.open(work / f"tvcontainer-import-{device}.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("An import is already running on this Apple TV.") from error
        return transfer(udid, bundle, source, work)


def transfer(udid, bundle, source, work):
    if not HOST_BUNDLE.fullmatch(bundle):
        raise ValueError("Select the paired Apple TV with SideRelay installed.")
    with ZipFile(source) as archive:
        _, info = main_info(archive)
    guest = info.get("CFBundleIdentifier", "")
    if ("AppleTVOS" not in info.get("CFBundleSupportedPlatforms", []) or not isinstance(guest, str)
            or not re.fullmatch(r"[A-Za-z0-9.-]{1,255}", guest)
            or guest.casefold() == HOST or guest.casefold().startswith(HOST + ".")):
        raise ValueError("Choose a guest IPA built for Apple TV.")
    with tempfile.TemporaryDirectory(prefix="tvcontainer-receipt-", dir=work) as folder:
        request = str(uuid4()).lower()
        remote = f"Library/Caches/SideRelayImport-{request}"
        channel = ["--device", udid, "--domain-type", "appDataContainer", "--domain-identifier", bundle]
        manifest = Path(folder) / "request.json"
        manifest.write_text(json.dumps({"bundleID": guest, "build": str(info.get("CFBundleVersion") or "")}))
        devicectl_json(["device", "copy", "to", *channel, "--source", str(source),
                        "--destination", remote + ".ipa"], timeout=60)
        devicectl_json(["device", "copy", "to", *channel, "--source", str(manifest),
                        "--destination", remote + ".request"], timeout=10)
        devicectl_json(["device", "process", "launch", "--device", udid, "--payload-url",
                        f"tvcontainer://siderelay-import/{request}", bundle])
        receipt = Path(folder) / "result.json"
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                devicectl_json(["device", "copy", "from", *channel, "--source", remote + ".json",
                                "--destination", str(receipt)], timeout=5)
            except (ValueError, subprocess.TimeoutExpired):
                time.sleep(2)
                continue
            result = json.loads(receipt.read_text())
            if (not isinstance(result, dict) or result.get("request") != request
                    or result.get("bundleID") != guest or not (result.get("installed") is True or result.get("error"))):
                raise ValueError("The companion returned an unexpected import result.")
            return result
    raise ValueError("TVContainer did not confirm the import. Check the companion before retrying.")
