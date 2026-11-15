"""Configure the installed companion over Apple's paired file transfer."""

from contextlib import closing
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import uuid
from zipfile import BadZipFile, ZipFile
import plistlib

from .ArchiveIPA import devicectl_json
from .CatalogueIPA import private_work
from .CompagnonIPA import tracked_host
from .CompagnonMisesAJour import engine_request


STAGING = "Library/Caches/SideRelaySigning.json"
RECEIPT = "Library/Caches/SideRelaySigningReady.json"
def signing_setup(root, port, device_id, *, television=False):
    device_id = str(uuid.UUID(device_id))
    platform = "Apple TV" if television else "iPhone"
    bundle_id = "com.hubzzzgr.tvcontainer" if television else "com.kdt.livecontainer"
    app_path = "Payload/TVContainer.app/Info.plist" if television else "Payload/LiveContainer.app/Info.plist"
    setup_url = "tvcontainer://siderelay-setup" if television else "livecontainer://siderelay-setup"
    with closing(sqlite3.connect((root / "signature.db").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        if television:
            tracked = db.execute("""
                SELECT a.id, a.account_id, a.ipa_path FROM apps a JOIN devices d ON d.id=a.device_id
                WHERE d.id=? AND d.discovery='coredevice-tvos' AND a.installed_at IS NOT NULL
                AND (lower(a.bundle_id)=? OR lower(a.bundle_id) LIKE ?) LIMIT 2
            """, (device_id, bundle_id, bundle_id + ".%")).fetchall()
            if len(tracked) != 1:
                return {"error": "Select the paired Apple TV with SideRelay installed."}
            app, account, archive = tracked[0]
        else:
            app, account, archive = tracked_host(db, device_id)
        if not app or not account:
            return {"needsCompanion": True}
        row = db.execute("""
            SELECT d.udid, a.bundle_id, a.signing_serial, a.signing_repair, a.profile_expires_at
            FROM apps a JOIN devices d ON d.id=a.device_id WHERE a.id=?
        """, (app,)).fetchone()
    if not row or not archive:
        return {"needsUpdate": True}
    source = (root / archive).resolve()
    try:
        if not source.is_relative_to((root / "ipas").resolve()):
            return {"needsUpdate": True}
        with ZipFile(source) as ipa:
            entry = ipa.getinfo(app_path)
            if entry.file_size > 256 * 1024:
                return {"needsUpdate": True}
            metadata = plistlib.loads(ipa.read(entry))
            config = metadata.get("SideRelayConnection") if isinstance(metadata, dict) else None
            if (not isinstance(config, dict) or config.get("certificateSetup") != "paired-v1"
                    or config.get("deviceID") != device_id):
                return {"needsUpdate": True}
    except (OSError, KeyError, BadZipFile, ValueError, plistlib.InvalidFileException):
        return {"needsUpdate": True}

    udid, bundle, serial, repair, expires_at = row
    if (not isinstance(udid, str) or not re.fullmatch(r"[0-9A-Fa-f-]{24,40}", udid)
            or not isinstance(bundle, str)
            or not re.fullmatch(re.escape(bundle_id) + r"(?:\.[A-Za-z0-9-]+)?", bundle)):
        return {"error": f"Select the {platform} with SideRelay installed."}
    if not isinstance(serial, str) or not re.fullmatch(r"[0-9A-Fa-f]{1,80}", serial) or repair or (
        expires_at is not None and expires_at <= time.time()
    ):
        return {"error": "Refresh SideRelay in Apps before setting up the signing identity."}
    serial = serial.upper().lstrip("0")
    revision = config.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}-[a-f0-9]{16}", revision):
        return {"needsUpdate": True}
    work = private_work(root)
    lock = os.open(work / f"livecontainer-setup-{device_id}.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)

    with os.fdopen(lock, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"error": f"Signing setup is already running for this {platform}."}
        with tempfile.TemporaryDirectory(prefix="livecontainer-setup-", dir=work) as folder:
            folder = Path(folder)
            arguments = ["--device", udid, "--domain-type", "appDataContainer", "--domain-identifier", bundle]
            expected = {"serial": serial, "revision": revision}
            if read_receipt(folder, arguments, expected):
                return {"ready": True}
            try:
                # Use the device channel before asking Apple for the reusable identity.
                devicectl_json(["device", "info", "files", *arguments, "--subdirectory", "Library/Caches"],
                              timeout=7)
            except (OSError, ValueError, subprocess.SubprocessError):
                return {"error": f"Make sure this {platform} is connected, then retry signing setup."}
            try:
                exported = engine_request(port, "export_livecontainer_cert", {"account_id": account}, timeout=30)
            except (OSError, ValueError, http.client.HTTPException):
                exported = None
            if not isinstance(exported, dict):
                return {"error": "Could not retrieve the signing certificate. Check the Apple Account on the Mac, then retry."}
            exported_serial = exported.get("serial", "")
            if not isinstance(exported_serial, str) or exported_serial.upper().lstrip("0") != serial:
                return {"error": "The certificate no longer matches this installation. Refresh SideRelay in Apps, then retry."}
            payload = {
                **expected,
                "p12": exported.get("p12_b64"),
                "password": exported.get("password"),
                "expiresAt": int(time.time()) + 120,
            }
            if (not isinstance(payload["p12"], str) or not 0 < len(payload["p12"]) < 65536
                    or not isinstance(payload["password"], str) or not 0 < len(payload["password"]) < 256):
                return {"error": "SideRelay could not prepare the certificate."}
            transfer = folder / "SideRelaySigning.json"
            with transfer.open("x", encoding="utf-8") as output:
                os.chmod(transfer, 0o600)
                json.dump(payload, output)
            try:
                devicectl_json(["device", "copy", "to", *arguments, "--source", str(transfer),
                               "--destination", STAGING], timeout=10)
                devicectl_json(["device", "process", "launch", "--device", udid, "--payload-url", setup_url, bundle],
                              timeout=10)
            except (OSError, ValueError, subprocess.SubprocessError):
                return {"error": f"Open SideRelay on the {platform}, then retry signing setup."}
            finally:
                transfer.unlink()
            for _ in range(3):
                if read_receipt(folder, arguments, expected):
                    return {"ready": True}
                time.sleep(0.5)
            return {"error": f"Open SideRelay on the {platform}, then retry signing setup."}


def read_receipt(folder, arguments, expected):
    target = folder / "ready.json"
    target.unlink(missing_ok=True)
    try:
        devicectl_json(["device", "copy", "from", *arguments, "--source", RECEIPT,
                        "--destination", str(target)], timeout=5)
        return target.stat().st_size <= 1024 and json.loads(target.read_text()) == expected
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
