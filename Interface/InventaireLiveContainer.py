"""Read the companion's visible guest apps through the existing paired device channel."""
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile

from .ArchiveIPA import devicectl_json
from .CatalogueIPA import BUNDLE_ID as APP_BUNDLE_ID, private_work
from .CompagnonIPA import BUNDLE_ID as HOST_BUNDLE_ID
from .InspectionIPA import PLIST_LIMIT, icon_rank, png_icon_preview

MAX_APPS = 256
PNG_LIMIT = 2 * 1024 * 1024
READ_ERRORS = (OSError, ValueError, OverflowError, plistlib.InvalidFileException, subprocess.SubprocessError)


def listing(arguments, subdirectory, *options):
    path = ["--subdirectory", subdirectory] if subdirectory else []
    result = devicectl_json(["device", "info", "files", *arguments, *path, *options], timeout=7)
    if not isinstance(result.get("files"), list):
        raise ValueError("No file listing returned")
    return result["files"]


def readable_files(entries):
    apps = {}
    for entry in entries:
        path = entry.get("relativePath")
        if not isinstance(path, str) or len(path) > 512 or not path.isprintable() or "\\" in path:
            continue
        parts = path.split("/")
        if len(parts) != 2 or not parts[0].endswith(".app") or parts[1] in ("", ".", ".."):
            continue
        props = entry.get("resources", {})
        if props.get("isDirectory") or props.get("isSymbolicLink") or not props.get("isReadable"):
            continue
        size = entry.get("metadata", {}).get("size")
        if type(size) is int and 0 < size <= max(PLIST_LIMIT, PNG_LIMIT):
            apps.setdefault(parts[0], {})[parts[1]] = size
    return apps


def read_guest(root, arguments, applications, folder, files):
    with tempfile.TemporaryDirectory(prefix="siderelay-guest-", dir=private_work(root)) as temp:
        work = Path(temp)

        def read(name, limit):
            if not 0 < files.get(name, 0) <= limit:
                raise ValueError("Missing or oversized app metadata")
            target = work / "remote"
            target.unlink(missing_ok=True)
            devicectl_json(["device", "copy", "from", *arguments, "--source", f"{applications}/{folder}/{name}",
                            "--destination", str(target)], timeout=7)
            if target.is_symlink() or not target.is_file() or not 0 < target.stat().st_size <= limit:
                raise ValueError("Unexpected app file")
            return target.read_bytes()

        info = plistlib.loads(read("Info.plist", PLIST_LIMIT))
        config = plistlib.loads(read("LCAppInfo.plist", PLIST_LIMIT)) if "LCAppInfo.plist" in files else {}
        if not isinstance(info, dict) or not isinstance(config, dict):
            raise ValueError("Invalid guest app metadata")
        if config.get("isHidden") or info.get("isHidden"):
            return None
        bundle = config.get("LCOrignalBundleIdentifier") or info.get("LCBundleIdentifier") or info.get("CFBundleIdentifier")
        if not isinstance(bundle, str) or len(bundle) > 255 or not APP_BUNDLE_ID.fullmatch(bundle):
            raise ValueError("Invalid guest bundle identifier")
        name = info.get("CFBundleDisplayName") or info.get("CFBundleName")
        build = info.get("CFBundleVersion")
        version = info.get("CFBundleShortVersionString") or build
        row = {
            "bundleID": bundle,
            "name": name[:160] if isinstance(name, str) and name.strip() else bundle,
            "version": version[:64] if isinstance(version, str) else None,
            "build": build[:64] if isinstance(build, str) else None,
        }
        icons = []
        for entry in files:
            rank = (-1, 0, 0) if entry == "LCAppIconLight.png" else icon_rank(entry, info)
            if rank is not None:
                icons.append((rank, entry))
        for _, entry in sorted(icons)[:3]:
            try:
                if image := png_icon_preview(read(entry, PNG_LIMIT), work):
                    row["icon"] = b64encode(image).decode("ascii")
                    break
            except READ_ERRORS:
                continue
        return row


def has_directory(entries, path):
    return any(entry.get("relativePath") == path and entry.get("resources", {}).get("isDirectory")
               and not entry["resources"].get("isSymbolicLink") for entry in entries)


def read_container(root, arguments, parent, device_id, name):
    try:
        if parent == "LiveContainer" and not has_directory(listing(arguments, "", "--no-recurse"), parent):
            return [], False
        if not has_directory(listing(arguments, parent, "--no-recurse"), "Applications"):
            return [], False
        applications = parent + "/Applications"
        entries = listing(arguments, applications, "--filter",
                          "name ENDSWITH '.app/Info.plist' OR name ENDSWITH '.app/LCAppInfo.plist' OR name ENDSWITH[c] '.png'")
    except READ_ERRORS:
        return [], True
    folders = [(folder, files) for folder, files in readable_files(entries).items() if "Info.plist" in files]

    def read(item):
        try:
            app = read_guest(root, arguments, applications, *item)
            if app:
                app.update(deviceID=device_id, device=name, inventoryID=f"{device_id}:{arguments[-1]}:{item[0]}")
            return app, False
        except READ_ERRORS:
            return None, True

    with ThreadPoolExecutor(max_workers=3) as worker:
        results = list(worker.map(read, folders[:MAX_APPS]))
    return [app for app, _ in results if app], len(folders) > MAX_APPS or any(failed for _, failed in results)


def read_host(root, host):
    device_id, name, udid, host_bundle = host
    if not (isinstance(udid, str) and re.fullmatch(r"[0-9A-Fa-f-]{24,40}", udid) and
            re.fullmatch(re.escape(HOST_BUNDLE_ID) + r"(?:\.[A-Za-z0-9-]+)*", host_bundle, re.I)):
        return [], True
    target = ["--device", udid]
    arguments = target + ["--domain-type", "appDataContainer", "--domain-identifier", host_bundle]
    rows, incomplete = read_container(root, arguments, "Documents", device_id, name)
    if incomplete and not rows:
        return rows, incomplete
    try:
        installed = devicectl_json(["device", "info", "apps", *target, "--include-app-group-identifiers",
                                   "--filter", f"bundleIdentifier = '{host_bundle}'"], timeout=7)
        app = next((app for app in installed.get("apps", []) if app.get("bundleIdentifier") == host_bundle), {})
    except READ_ERRORS:
        return rows, True
    for group in dict.fromkeys(app.get("appGroupIdentifiers") or []):
        if not isinstance(group, str) or not re.fullmatch(
            r"(?:group|[A-Z0-9]{10})\.com\.kdt\.livecontainer(?:\.[A-Za-z0-9-]+)*", group
        ):
            continue
        arguments = target + ["--domain-type", "appGroupDataContainer", "--domain-identifier", group]
        shared, failed = read_container(root, arguments, "LiveContainer", device_id, name)
        rows.extend(shared)
        incomplete |= failed
    return rows, incomplete


def inventory(db, root):
    hosts = db.execute("""
        SELECT d.id, d.name, d.udid, a.bundle_id FROM apps a JOIN devices d ON d.id = a.device_id
        WHERE a.installed_at IS NOT NULL AND (lower(a.bundle_id) = ? OR lower(a.bundle_id) LIKE ?)
        ORDER BY d.id, a.bundle_id
    """, (HOST_BUNDLE_ID, HOST_BUNDLE_ID + ".%")).fetchall()
    apps, incomplete = [], False
    for host in hosts:
        rows, failed = read_host(root, host)
        apps.extend(rows)
        incomplete |= failed
    return {"apps": list({app["inventoryID"]: app for app in apps}.values()), "incomplete": incomplete}
