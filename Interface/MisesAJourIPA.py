"""Find and prepare updates for apps SideRelay already manages."""

from itertools import zip_longest
import re

from .CatalogueIPA import download, library, sources
from .CompagnonMisesAJour import engine_request


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
    job = engine_request(port, "install_library_ipa", {
        "package_id": package["id"], "device_id": latest["deviceID"], "account_id": latest["accountID"],
        "target_app_id": app_id, "use_main_profile": "true" if latest.get("useMainProfile") else "false",
    }, timeout=120)
    return {"status": "queued", "job": job} if isinstance(job, str) and job else {"status": "activity"}
