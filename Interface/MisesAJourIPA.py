"""Find and prepare updates for apps SideRelay already manages."""

from itertools import zip_longest
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from .ArchiveIPA import archive, modified_ipa, plist, plugins
from .CatalogueIPA import download, library, private_work, sources, upload_archive
from .CompagnonMisesAJour import engine_request
from .InspectionIPA import package_path


def compare_version(left, right):
    if not all(isinstance(value, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value)
               for value in (left, right)):
        return 0
    for a, b in zip_longest(map(int, left.split(".")), map(int, right.split(".")), fillvalue=0):
        if a != b:
            return 1 if a > b else -1
    return 0


def original_bundle(app, metadata):
    suffix = "." + app["accountTeam"] if app.get("accountTeam") else ""
    bundle = app["bundleID"]
    return metadata.get("bundleId") or (bundle.removesuffix(suffix) if suffix else bundle)


def newer(release, app, metadata):
    version = release.get("version")
    return compare_version(version, app["version"]) > 0 or (
        version == app["version"] and compare_version(release.get("build"), metadata.get("build")) > 0)


def matches(package, app, metadata):
    platforms = package.get("platforms") or []
    tv = "AppleTVOS" in platforms
    if tv != bool(app["appleTV"]) or (not tv and platforms and "iPhoneOS" not in platforms):
        return False
    return package.get("bundleId") in (original_bundle(app, metadata), app["bundleID"])


def installed_metadata(app, packages):
    installed = packages.get(app.get("packageID"), {})
    return {**installed, **{key: value for key, value in (app.get("packageMetadata") or {}).items() if value}}


def available_updates(apps, packages, catalogues):
    by_id = {package["id"]: package for package in packages}
    local = {}
    remote = {}
    for package in packages:
        if package["available"]:
            local.setdefault(package.get("bundleId"), []).append(package)
    for source in catalogues:
        for item in source["apps"]:
            remote.setdefault(item["bundleId"], []).extend(
                {"source": {"id": source["id"]}, "item": {"bundleId": item["bundleId"]}, "release": release}
                for release in item["versions"] if not release.get("restricted"))

    updates = {}
    for app in apps:
        if not all(app.get(key) for key in ("installedAt", "version", "accountID", "deviceID")):
            continue
        metadata = installed_metadata(app, by_id)
        bundle = original_bundle(app, metadata)
        offers = [{"ipa": package, "release": package}
                  for candidate in dict.fromkeys((bundle, app["bundleID"])) for package in local.get(candidate, [])
                  if package["id"] != app.get("packageID") and matches(package, app, metadata)]
        offers.extend(offer for offer in remote.get(bundle, [])
                      if (offer["release"].get("platform") == "tvOS") == bool(app["appleTV"]))
        best = None
        for offer in offers:
            release = offer["release"]
            if not newer(release, app, metadata):
                continue
            if best:
                previous = best["release"]
                order = (compare_version(release.get("version"), previous.get("version"))
                         or compare_version(release.get("build"), previous.get("build")))
                if order < 0 or (not order and (best.get("ipa") or not offer.get("ipa"))):
                    continue
            best = offer
        if best:
            updates[app["id"]] = best
    return updates


def prepare_top_shelf_update(db, root, port, app_id, package_id):
    target = db.execute("""
        SELECT a.bundle_id,a.signing_team,a.account_id,a.version,a.signed_extension_ids,p.metadata
        FROM apps a JOIN devices d ON d.id=a.device_id LEFT JOIN ipa_packages p ON p.path=a.ipa_path
        WHERE a.id=? AND a.installed_at IS NOT NULL AND d.discovery='coredevice-tvos'
    """, (app_id,)).fetchone()
    candidate = db.execute("SELECT metadata FROM ipa_packages WHERE id=? AND removed_at IS NULL",
                           (package_id,)).fetchone()
    if not target or not target[2] or not candidate:
        return None
    bundle, team, account, version, signed_extensions, prior = target
    if signed_extensions is None or json.loads(signed_extensions) != []:
        return None
    incoming = json.loads(candidate[0] or "{}")
    previous = json.loads(prior or "{}")
    app = {"bundleID": bundle, "accountTeam": team, "version": version, "appleTV": True}
    extensions = incoming.get("extensions") or []
    if (not matches(incoming, app, previous) or not newer(incoming, app, previous)
            or len(extensions) != 1 or extensions[0].get("point") != "com.apple.tv-top-shelf"):
        return None

    def plan(ipa_id):
        result = engine_request(port, "preview_app_ids", {"package_id": ipa_id, "account_id": account}, timeout=30)
        if not isinstance(result, dict):
            return None, []
        rows = result.get("sharedRows") if result.get("sharedIosId") == bundle else None
        return result.get("available"), rows if rows is not None else result.get("rows", [])

    available, rows = plan(package_id)
    main = [row for row in rows if not row["extension"]]
    proposed = [row for row in rows if row["extension"] and not row["registered"]]
    if (available != 0 or len(rows) != 2 or len(main) != 1 or len(proposed) != 1
            or main[0]["identifier"] != bundle or not main[0]["registered"]):
        return None

    source = package_path(db, root, package_id)
    zipped, base = archive(source)
    with zipped:
        actual = plugins(zipped, base)
        if len(actual) != 1 or actual[0]["identifier"] != extensions[0]["bundleId"]:
            return None
        extension = plist(zipped, actual[0]["path"] + "/Info.plist").get("NSExtension", {})
        if extension.get("NSExtensionPointIdentifier") != "com.apple.tv-top-shelf":
            return None
    with TemporaryDirectory(prefix="top-shelf-update-", dir=private_work(root)) as directory:
        work = Path(directory)
        prepared = work / "update.ipa"
        modified_ipa(source, prepared, {"remove": [actual[0]["path"]]}, work)
        with prepared.open("rb") as stream:
            result = upload_archive(stream, port, prepared.stat().st_size)
    if (any(result.get(key) != incoming.get(key) for key in ("bundleId", "version", "build", "platforms"))
            or result.get("extensions")):
        raise ValueError("Could not prepare this update without Top Shelf.")
    _, prepared_rows = plan(result["id"])
    if len(prepared_rows) != 1 or prepared_rows[0]["identifier"] != bundle or not prepared_rows[0]["registered"]:
        raise ValueError("Could not verify that the update will reuse the installed App ID.")
    return result


def queue_update(db, root, port, app_id, release_id, read_apps):
    def current():
        app = next((app for app in read_apps() if app["id"] == app_id and app["installedAt"]), None)
        if app is None or not app.get("deviceID") or not app.get("accountID"):
            raise ValueError("The installed app or its Apple Account is no longer available.")
        return app

    app = current()
    if app["activeJob"]:
        return {"status": "activity"}
    packages = library(db, root)
    offer = available_updates([app], packages, sources(db)).get(app_id)
    if offer is None or offer["release"]["id"] != release_id:
        raise ValueError("The available update changed. Reopen the menu to check again.")
    package = offer.get("ipa") or download(db, root, port, offer["source"]["id"],
                                           offer["item"]["bundleId"], release_id)
    latest = current()
    if latest["activeJob"]:
        return {"status": "activity"}
    if (latest["deviceID"], latest["accountID"]) != (app["deviceID"], app["accountID"]):
        raise ValueError("The app’s device or Apple Account changed. Reopen the menu and try again.")
    metadata = installed_metadata(latest, {item["id"]: item for item in packages})
    if not matches(package, latest, metadata):
        raise ValueError("The new IPA does not match this installed app and device.")
    if not newer(package, latest, metadata):
        if latest["packageID"] == package["id"]:
            return {"status": "updated"}
        raise ValueError("The downloaded IPA is not newer than the installed build.")
    if latest["appleTV"]:
        package = prepare_top_shelf_update(db, root, port, app_id, package["id"]) or package
    job = engine_request(port, "install_library_ipa", {
        "package_id": package["id"], "device_id": latest["deviceID"], "account_id": latest["accountID"],
        "target_app_id": app_id, "use_main_profile": "true" if latest.get("useMainProfile") else "false",
    }, timeout=120)
    return {"status": "queued", "job": job} if isinstance(job, str) and job else {"status": "activity"}
