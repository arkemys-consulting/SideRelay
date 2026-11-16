"""Portable SideRelay library and settings backup, wrapped in encryption by the Mac app."""

from contextlib import contextmanager
from pathlib import Path
import fcntl
import http.client
import json
import os
import re
import shutil
import sqlite3
import tempfile
from typing import BinaryIO
from uuid import uuid4
import zipfile

from .CatalogueIPA import IPA_BYTES, STORE_2026, https_url, private_work, tv_sources, upload_archive
from .InspectionIPA import package_path


MANIFEST = "manifest.json"
MAX_MANIFEST = 16 * 1024 * 1024
ARCHIVE_ENTRY = re.compile(r"library/[0-9a-f]{32}(?:[0-9a-f]{32})?\.ipa\Z")


@contextmanager
def restore_lock(root):
    path = private_work(root) / "restore-backup.lock"
    with os.fdopen(os.open(path, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600), "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def export_backup(db, root, destination):
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_STORED) as archive:
        devices = [dict(name=name, udid=udid) for name, udid in db.execute("SELECT name,udid FROM devices")]
        accounts = [name for name, in db.execute("SELECT apple_account_name(apple_id) FROM apple_accounts")]
        sources = [dict(url=url, name=name) for url, name in db.execute("SELECT url,name FROM ipa_sources")]
        refresh = [dict(udid=udid, bundle=bundle, enabled=bool(enabled))
                   for udid, bundle, enabled in db.execute("""
                       SELECT d.udid,a.bundle_id,a.refresh_enabled FROM apps a
                       JOIN devices d ON a.device_id=d.id WHERE a.installed_at IS NOT NULL
                   """)]
        packages = []
        missing = 0
        for package_id, in db.execute("SELECT id FROM ipa_packages WHERE removed_at IS NULL"):
            entry = f"library/{package_id}.ipa"
            try:
                file = package_path(db, root, package_id)
                if not ARCHIVE_ENTRY.fullmatch(entry) or not file.is_file() or not 4 <= file.stat().st_size <= IPA_BYTES:
                    raise ValueError("Unsupported library item.")
            except (OSError, ValueError):
                missing += 1
                continue
            archive.write(file, entry)
            packages.append(entry)
        manifest = dict(version=1, devices=devices, accounts=accounts, sources=sources, refresh=refresh, packages=packages)
        archive.writestr(MANIFEST, json.dumps(manifest).encode())
    return {"packages": len(packages), "missing": missing, "sources": len(sources)}


def valid_text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(ord(c) < 32 for c in value)


def read_manifest(archive):
    entries = archive.infolist()
    manifests = [entry for entry in entries if entry.filename == MANIFEST]
    if len(manifests) != 1 or manifests[0].file_size > MAX_MANIFEST:
        raise ValueError("Invalid SideRelay backup manifest.")
    manifest = json.loads(archive.read(manifests[0]))
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("This backup version is unsupported.")
    packages = [entry.filename for entry in entries if entry.filename != MANIFEST]
    if (manifest.get("packages") != packages or len(packages) != len(set(packages))
            or any(not ARCHIVE_ENTRY.fullmatch(entry.filename) or not 4 <= entry.file_size <= IPA_BYTES
                   or entry.compress_type != zipfile.ZIP_STORED for entry in entries if entry.filename != MANIFEST)):
        raise ValueError("Invalid library entries in the backup.")
    validators = {
        "accounts": lambda row: valid_text(row, 512),
        "devices": lambda row: isinstance(row, dict) and valid_text(row.get("udid"), 128) and valid_text(row.get("name"), 512),
        "sources": lambda row: isinstance(row, dict) and valid_text(row.get("url"), 4096) and valid_text(row.get("name"), 512),
        "refresh": lambda row: isinstance(row, dict) and valid_text(row.get("udid"), 128)
        and valid_text(row.get("bundle"), 255) and type(row.get("enabled")) is bool,
    }
    for key, valid in validators.items():
        values = manifest.get(key)
        if not isinstance(values, list) or not all(valid(row) for row in values):
            raise ValueError("Invalid settings in the backup.")
    for source in manifest["sources"]:
        if source["url"] != STORE_2026:
            https_url(source["url"])
    return manifest


def review_backup(db, manifest):
    existing_devices = {udid for udid, in db.execute("SELECT udid FROM devices")}
    existing_accounts = {name.casefold() for name, in db.execute("SELECT apple_account_name(apple_id) FROM apple_accounts")}
    return {
        "packages": len(manifest["packages"]),
        "sources": len(manifest["sources"]),
        "devicesToPair": [row["name"] for row in manifest["devices"] if row["udid"] not in existing_devices],
        "accountsToConnect": [name for name in manifest["accounts"] if name.casefold() not in existing_accounts],
    }


def pending_path(root):
    return private_work(root) / "restored-refresh-settings.json"


def read_pending(root):
    path = pending_path(root)
    if not path.is_file():
        return []
    with os.fdopen(os.open(path, os.O_NOFOLLOW | os.O_RDONLY), "r") as handle:
        return json.load(handle)


def save_pending(root, pending):
    path = pending_path(root)
    if not pending:
        path.unlink(missing_ok=True)
        return
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False, dir=path.parent) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(pending, handle)
            handle.flush()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def apply_settings(db, settings):
    remaining = []
    for row in settings:
        changed = db.execute("""
            UPDATE apps SET refresh_enabled=? WHERE installed_at IS NOT NULL AND bundle_id=?
            AND device_id=(SELECT id FROM devices WHERE udid=?)
        """, (int(row["enabled"]), row["bundle"], row["udid"])).rowcount
        if not changed:
            remaining.append(row)
    return remaining


def apply_pending(db, root):
    with restore_lock(root):
        pending = read_pending(root)
        if pending:
            with db:
                remaining = apply_settings(db, pending)
            if len(remaining) != len(pending):
                save_pending(root, remaining)


def restore_backup(db, root, port, archive, manifest):
    result = review_backup(db, manifest)
    failed = []
    with restore_lock(root):
        for entry in manifest["packages"]:
            try:
                with archive.open(entry) as source, tempfile.TemporaryFile(dir=private_work(root)) as package:
                    shutil.copyfileobj(source, package, 1024 * 1024)
                    upload_archive(package, port, package.tell())
            except (OSError, ValueError, zipfile.BadZipFile, http.client.HTTPException):
                failed.append(entry)
        pending = {(row["udid"], row["bundle"]): row for row in read_pending(root)}
        pending.update({(row["udid"], row["bundle"]): row for row in manifest["refresh"]})
        with db:
            for source in manifest["sources"]:
                address = source["url"]
                # Publisher definitions are rebuilt by the current version of SideRelay.
                if address in tv_sources():
                    continue
                db.execute("INSERT OR IGNORE INTO ipa_sources (id,url,name,catalogue,checked_at) VALUES (?,?,?,'[]',0)",
                           (str(uuid4()), address, source["name"]))
            remaining = apply_settings(db, pending.values())
        save_pending(root, remaining)
    result.update(restored=len(manifest["packages"]) - len(failed), failed=len(failed),
                  pendingRefresh=len(remaining))
    return result


def command(db: sqlite3.Connection, root: Path, port: int, action: str, file: Path | BinaryIO | None):
    if action == "apply":
        apply_pending(db, root)
        return {}
    if action == "export":
        with db:
            db.execute("BEGIN")
            return export_backup(db, root, file)
    with zipfile.ZipFile(file) as archive:
        manifest = read_manifest(archive)
        return review_backup(db, manifest) if action == "review" else restore_backup(db, root, port, archive, manifest)
