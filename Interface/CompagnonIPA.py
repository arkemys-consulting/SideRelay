"""Build and archive SideRelay's iPhone companion from the published upstream revision."""
from contextlib import closing
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
from zipfile import BadZipFile, ZipFile

from .CatalogueIPA import open_url, private_work, transfer, upload_archive
from .ImportLiveContainer import installed_host, tailscale
from .InspectionIPA import package_build

PORT = 19445
BUNDLE_ID = "com.kdt.livecontainer"
SIDERELAY_IOS_VERSION = "1.22.6"
REPOSITORY = "https://github.com/LiveContainer/LiveContainer"
RELEASE = "https://api.github.com/repos/LiveContainer/LiveContainer/releases/tags/nightly"
COMMIT = re.compile(r"https://github\.com/LiveContainer/LiveContainer/commit/([a-f0-9]{40})\)")


def published_commit():
    with open_url(RELEASE, "application/vnd.github+json") as response:
        data = bytearray()
        transfer(response, 256 * 1024, 15, data.extend)
    release = json.loads(data)
    body = release.get("body")
    commit = COMMIT.search(body) if isinstance(body, str) else None
    if (release.get("tag_name") != "nightly" or release.get("draft") or not commit
            or not any(a.get("name") == "LiveContainer.ipa" and
                       a.get("browser_download_url") == REPOSITORY + "/releases/download/nightly/LiveContainer.ipa"
                       for a in release.get("assets", []))):
        raise ValueError("The official LiveContainer release has no verifiable source revision.")
    return commit[1]


def endpoint():
    status = tailscale("status", "--json")
    node = status.get("Self") or {}
    hostname = node.get("DNSName", "").rstrip(".")
    owner = status.get("User", {}).get(str(node.get("UserID")), {}).get("LoginName")
    if (status.get("BackendState") != "Running" or not owner
            or not re.fullmatch(r"[A-Za-z0-9.-]+\.ts\.net", hostname)):
        raise ValueError("Connect Tailscale on the Mac before setting up the iPhone companion.")
    return f"https://{hostname}:{PORT}", owner


def tailnet_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    network = ipaddress.ip_network("100.64.0.0/10" if address.version == 4 else "fd7a:115c:a1e0::/48")
    return address if address in network else None


def enabled(root):
    return private_work(root) / "companion-enabled"


def tracked_host(db, device_id):
    app = db.execute("""
        SELECT id, account_id, ipa_path FROM apps
        WHERE device_id = ? AND installed_at IS NOT NULL
          AND (lower(bundle_id) = ? OR lower(bundle_id) LIKE ?)
        LIMIT 2
    """, (device_id, BUNDLE_ID, BUNDLE_ID + ".%")).fetchall()
    if len(app) > 1:
        raise ValueError("More than one LiveContainer install is registered on this iPhone. Choose the app to update in Apps.")
    return app[0] if app else (None, None, None)


def prepare(root, port, device_id, account_id, commit=None):
    with closing(sqlite3.connect((root / "signature.db").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        device = db.execute("SELECT ip, udid FROM devices WHERE id = ?", (device_id,)).fetchone()
        if device is None:
            raise ValueError("Choose a paired iPhone or iPad.")
        if not tailnet_ip(device[0]):
            raise ValueError("Set this iPhone's Tailscale address in Devices to use the iPhone companion.")
        target_id, target_account, target_ipa = tracked_host(db, device_id)
        if target_id and target_account != account_id:
            raise ValueError("Choose the Apple Account used for the existing LiveContainer installation.")
        if db.execute("SELECT 1 FROM apple_accounts WHERE id = ?", (account_id,)).fetchone() is None:
            raise ValueError("Choose an Apple Account in SideRelay.")
    try:
        developer = Path(subprocess.check_output(["/usr/bin/xcode-select", "-p"],
                         stderr=subprocess.DEVNULL, timeout=4, text=True).strip())
        if not (developer / "usr/bin/xcodebuild").is_file():
            raise ValueError()
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise ValueError("Install Xcode on this Mac, open it once to finish setup, then try again.") from error
    if not target_id and device[1] and installed_host(device[1]) is True:
        raise ValueError("LiveContainer is already installed outside SideRelay. The existing app and its data need to be preserved before replacing it.")
    address, _ = endpoint()
    commit = commit or published_commit()
    source = Path(os.environ.get("SIDERELAY_RUNTIME_ROOT", root.parent)) / "Compagnon"
    digest = hashlib.sha256()
    for name in ("construire.sh", "LiveContainer.patch", "SideRelayView.swift", "Icone.swift", "../Interface/Logo.swift",
                 "../Interface/StoreSources.json", "../Interface/Store2026.json"):
        digest.update((source / name).read_bytes())
    revision = f"{commit}-{digest.hexdigest()[:16]}"
    configuration = {"address": address, "deviceID": device_id, "revision": revision,
                     "certificateSetup": "paired-v1"}
    if target_ipa:
        installed_ipa = (root / target_ipa).resolve()
        if installed_ipa.is_relative_to((root / "ipas").resolve()):
            try:
                with ZipFile(installed_ipa) as archive:
                    entry = archive.getinfo("Payload/LiveContainer.app/Info.plist")
                    if entry.file_size <= 2 * 1024 * 1024:
                        installed_info = plistlib.loads(archive.read(entry))
                        if (installed_info.get("SideRelayConnection") == configuration
                                and installed_info.get("SideRelayVersion") == SIDERELAY_IOS_VERSION):
                            return {"upToDate": True, "version": installed_info.get("CFBundleShortVersionString")}
            except (OSError, KeyError, ValueError, BadZipFile, plistlib.InvalidFileException):
                pass
    work = private_work(root)
    cache = work / f"companion-{revision}"
    lock_fd = os.open(work / "companion.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("SideRelay is already preparing the iPhone companion. Try again after that build finishes.") from error
        app = cache / "LiveContainer.app"
        if not app.is_dir():
            # Use the configured workspace for large Xcode intermediates when available.
            mac_workspace = root.parents[3] / "tmp/Travaux" if len(root.parents) > 3 else work
            temp_root = os.environ.get("SIDERELAY_BUILD_TMP") or (
                str(mac_workspace) if mac_workspace.is_dir() else os.environ.get("TMPDIR") or str(work))
            with tempfile.TemporaryDirectory(prefix="siderelay-companion-", dir=temp_root) as directory:
                build = Path(directory)
                logpath = work / "companion-build.log"
                with logpath.open("w") as log:
                    try:
                        subprocess.run(["/bin/bash", str(source / "construire.sh"), commit, directory],
                                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900,
                                       env={**os.environ, "TMPDIR": directory, "GIT_TERMINAL_PROMPT": "0"})
                    except subprocess.SubprocessError as error:
                        raise ValueError("Could not build the latest LiveContainer. Open Activity for the installation history. The build log is companion-build.log in SideRelay’s data folder.") from error
                stage = build / "SideRelay.xcarchive/Products/Applications/LiveContainer.app"
                with tempfile.TemporaryDirectory(prefix="companion-cache-", dir=work) as staged_directory:
                    staged_app = Path(staged_directory) / app.name
                    shutil.copytree(stage, staged_app, symlinks=True)
                    cache.mkdir(exist_ok=True, mode=0o700)
                    staged_app.rename(app)
        with tempfile.TemporaryDirectory(prefix="companion-package-", dir=work) as directory:
            local = Path(directory) / app.name
            shutil.copytree(app, local, symlinks=True)
            metadata = local / "Info.plist"
            info = plistlib.loads(metadata.read_bytes())
            if (info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleDisplayName") != "SideRelay"
                    or commit[:7] not in info.get("LCVersionInfo", "")):
                raise ValueError("The iPhone build does not match the official LiveContainer revision.")
            info["SideRelayConnection"] = configuration
            info["SideRelayVersion"] = SIDERELAY_IOS_VERSION
            metadata.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
            # ZIP entries include timestamps. Keep repeated attempts for the same
            # build and device byte-identical so the library reuses the archive.
            template = (app / "Info.plist").stat()
            os.utime(metadata, ns=(template.st_atime_ns, template.st_mtime_ns))
            with tempfile.TemporaryFile(dir=work) as ipa:
                package_build(local, ipa)
                result = upload_archive(ipa, port, ipa.tell())
    return {**result, "targetAppId": target_id, "upstreamCommit": commit}
