"""Read-only checks for the first installation completed by the setup assistant."""
from pathlib import Path
import re
import time
import uuid


def verifier(db, root, mode, identifiant, bundle=None):
    uuid.UUID(identifiant)
    if mode == "native":
        row = db.execute("""
            SELECT j.status, j.error, a.id, a.device_id, a.display_name, a.installed_at, a.ipa_path,
                   a.refresh_enabled, a.profile_expires_at, a.signing_repair, c.id
            FROM jobs j JOIN apps a ON a.id = j.app_id
            LEFT JOIN apple_accounts c ON c.id = a.account_id
            WHERE j.id = ? AND j.kind = 'install'
        """, (identifiant,)).fetchone()
        if not row:
            return {"state": "missing"}
        status, error, *app = row
        if status != "done":
            if status in ("failed", "cancelled", "canceled"):
                return {"state": "failed", **({"error": error[:4096]} if error else {})}
            return {"state": "pending"}
    elif mode == "livecontainer":
        if not bundle or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]{0,254}", bundle):
            raise ValueError("Invalid app identifier")
        from .InventaireLiveContainer import read_host, HOST_BUNDLE_ID

        hosts = db.execute("""
            SELECT d.id, d.name, d.udid, a.bundle_id, a.id, a.device_id, a.display_name,
                   a.installed_at, a.ipa_path, a.refresh_enabled, a.profile_expires_at,
                   a.signing_repair, c.id
            FROM apps a JOIN devices d ON d.id = a.device_id
            LEFT JOIN apple_accounts c ON c.id = a.account_id
            WHERE d.id = ? AND a.installed_at IS NOT NULL
              AND (lower(a.bundle_id) = ? OR lower(a.bundle_id) LIKE ?)
            ORDER BY a.last_refreshed DESC
        """, (identifiant, HOST_BUNDLE_ID, HOST_BUNDLE_ID + ".%")).fetchall()
        if not hosts:
            return {"state": "companion"}
        incomplete = False
        for *host, app_id, device_id, name, installed, ipa, auto, expiry, repair, account in hosts:
            apps, partial = read_host(root, host)
            incomplete |= partial
            guest = next((app for app in apps if app["bundleID"] == bundle), None)
            if guest:
                app = [app_id, device_id, guest["name"], installed, ipa, auto, expiry, repair, account]
                break
        else:
            return {"state": "unreadable" if incomplete else "notImported"}
    else:
        raise ValueError("Invalid installation destination")

    app_id, device, name, installed, ipa, auto, expiry, repair, account = app
    if not installed:
        return {"state": "missing"}
    path = root / ipa if ipa else None
    if not account:
        reason = "account"
    elif repair:
        reason = "certificate"
    elif path is None or not path.is_file():
        reason = "ipa"
    elif not auto:
        reason = "disabled"
    elif not expiry or expiry <= time.time():
        reason = "profile"
    else:
        reason = "configured"
    return {"state": "installed", "refresh": reason, "appID": app_id, "deviceID": device, "name": name}
