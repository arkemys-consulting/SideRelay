"""Fetch user-selected IPA sources and read SideRelay's local library."""
from base64 import b64encode
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import lru_cache
from pathlib import Path
import hashlib
import http.client
import ipaddress
import json
import os
import plistlib
import re
import socket
import ssl
import tempfile
import threading
import time
from urllib.parse import quote, urljoin, urlsplit
from uuid import uuid4
from xml.parsers.expat import ExpatError
import zipfile
import zlib


SOURCE_BYTES = 2 * 1024 * 1024
IMAGE_BYTES = 4 * 1024 * 1024
IPA_BYTES = 512 * 1024 * 1024
STORE_REFRESH_INTERVAL = 3600
GITHUB_REFRESH_INTERVAL = 4 * STORE_REFRESH_INTERVAL
SOURCE_RETRY_INTERVAL = 300
GITHUB_API_HOST = "api.github.com"
BUNDLE_ID = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\Z")
VERSION = re.compile(r"[A-Za-z0-9.+-]{1,64}\Z")
DEFAULT_SOURCES = Path(__file__).with_name("StoreSources.json")
STORE_2026 = "siderelay://catalogue/2026"
IGNORED_BUNDLES = {"com.stremiox.tv"}

SIDE_STORE_APPS = set("""
    org.ppsspp.ppsspp com.neo.countdown com.stik.stiknes com.libretro.retroarchios11
    app.ish.ish net.nerd.inds com.virtualapplications.play com.litchie.idosgames
    com.adriweb.firebird-emu com.yoshisuga.activegs at.tpau.ready com.example.mame4ios
    com.zurac.oldos com.xitrix.itorrent2 org.scummvm.scummvm net.namedfork.minivmac
    com.wh0ba.xpatcher eu.vcmi.vcmiclient
""".split())
UPSTREAM_REPOS = {
    "com.rileytestut.delta": {"rileytestut/delta"},
    "org.provenance-emu.provenance": {"provenance-emu/provenance"},
    "com.provenance-emu.provenance.alpha": {"provenance-emu/provenance"},
    "com.utmapp.utm": {"utmapp/utm"},
    "com.utmapp.utm-se": {"utmapp/utm"},
    "org.ppsspp.ppsspp-free": {"hrydgard/ppsspp"},
    "com.jevon.pocket8": {"jevonlipsey/pico-ios"},
    "oss.krtirtho.spotube": {"krtirtho/spotube", "team-spotube/spotube"},
    "org.spotube.spotube.spotube": {"team-spotube/spotube"},
    "com.paperback.ios": {"paperback-ios/app"},
    "com.example.mirarr": {"mirarr-app/mirarr"},
    "app.molinete.aerio": {"jonzey231/aeriotv"},
}


def curated_source(url):
    parts = urlsplit(url)
    return (parts.hostname, parts.path) in (
        ("community-apps.sidestore.io", "/sidecommunity.json"),
        ("kb01111.github.io", "/Sideload-Sources/source.json"),
    )


def included_release(url, bundle, release):
    parts = urlsplit(url)
    if (parts.hostname, parts.path) == ("community-apps.sidestore.io", "/sidecommunity.json"):
        return bundle in SIDE_STORE_APPS
    if (parts.hostname, parts.path) != ("kb01111.github.io", "/Sideload-Sources/source.json"):
        return True
    download = urlsplit(release["downloadURL"])
    path = download.path.strip("/").split("/")
    return (download.hostname == "github.com" and len(path) == 6 and path[2:4] == ["releases", "download"]
            and path[-1].lower().endswith(".ipa")
            and "/".join(path[:2]).lower() in UPSTREAM_REPOS.get(bundle, ()))


def https_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(c.isspace() for c in value):
        raise ValueError("Enter a valid HTTPS URL.")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Use an HTTPS URL without credentials or a fragment.")
    return parsed


def public_addresses(host, port):
    addresses = list(dict.fromkeys(
        item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    ))
    if not addresses or any(not ipaddress.ip_address(address).is_global
                            or ipaddress.ip_address(address).is_multicast for address in addresses):
        raise ValueError("The source or download points to a private network address.")
    return addresses


class SourceConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, addresses):
        super().__init__(host, port, timeout=10, context=ssl.create_default_context())
        self.addresses = addresses

    def connect(self):
        for address in self.addresses:
            try:
                sock = socket.create_connection((address, self.port), self.timeout)
                break
            except OSError as error:
                last_error = error
        else:
            raise last_error
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


class GitHubRateLimit(ValueError):
    def __init__(self, response):
        super().__init__("GitHub’s request limit was reached.")
        now = int(time.time())
        reset = response.getheader("X-RateLimit-Reset", "")
        retry_after = response.getheader("Retry-After", "")
        self.retry_at = max(
            now + SOURCE_RETRY_INTERVAL,
            int(reset) if reset.isascii() and reset.isdecimal() else 0,
            now + int(retry_after) if retry_after.isascii() and retry_after.isdecimal() else 0,
        )


@contextmanager
def open_url(url, accept):
    for _ in range(6):
        parts = https_url(url)
        host = parts.hostname.encode("idna").decode("ascii")
        port = parts.port or 443
        connection = SourceConnection(host, port, public_addresses(host, port))
        path = (parts.path or "/") + ("?" + parts.query if parts.query else "")
        try:
            connection.request("GET", path, headers={"Accept": accept, "User-Agent": "SideRelay"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("The source returned an invalid redirect.")
                url = urljoin(url, location)
                continue
            if host == GITHUB_API_HOST and response.status in (403, 429) and (
                    response.status == 429 or response.getheader("X-RateLimit-Remaining") == "0"
                    or response.getheader("Retry-After")):
                raise GitHubRateLimit(response)
            if response.status != 200:
                raise ValueError(f"The source server returned HTTP {response.status}.")
            response.relay_url = url
            yield response
            return
        finally:
            connection.close()
    raise ValueError("The source redirected too many times.")


def transfer(response, limit, seconds, write):
    length = response.getheader("Content-Length")
    if length and length.isdecimal() and int(length) > limit:
        raise ValueError("The download is too large.")
    deadline = time.monotonic() + seconds
    total = 0
    while True:
        if time.monotonic() > deadline:
            raise ValueError("The download took too long.")
        chunk = response.read1(128 * 1024)
        if not chunk:
            return total
        total += len(chunk)
        if total > limit:
            raise ValueError("The download is too large.")
        write(chunk)


def text(value, limit=200):
    return value.strip()[:limit] if isinstance(value, str) else ""


def asset_url(value, source):
    if not isinstance(value, str) or not value:
        return ""
    try:
        url = urljoin(source, value)
        https_url(url)
        return url
    except ValueError:
        return ""


def source_artwork(item, url):
    screenshots = item.get("screenshots")
    if isinstance(screenshots, dict):
        screenshots = screenshots.get("iphone") or screenshots.get("ipad")
    if not isinstance(screenshots, list) or not screenshots:
        screenshots = item.get("screenshotURLs")
    items, landscape = [], ""
    for screenshot in (screenshots[:20] if isinstance(screenshots, list) else []):
        record = screenshot if isinstance(screenshot, dict) else {"imageURL": screenshot}
        if not (image := asset_url(record.get("imageURL"), url)):
            continue
        items.append(image)
        width, height = record.get("width"), record.get("height")
        if not landscape and type(width) is int and type(height) is int and width > height > 0:
            landscape = image
    return {"icon": asset_url(item.get("iconURL"), url), "screenshots": items,
            "preview": landscape or (items[0] if items else "")}


def normalise_version(value, source_url, legacy=False):
    version = text(value.get("version"), 65)
    raw_build = value.get("buildVersion") or value.get("buildNumber")
    build = text(str(raw_build) if type(raw_build) is int else raw_build, 65)
    download = value.get("downloadURL")
    build_label = re.fullmatch(r"Build ([0-9]+)", version, re.IGNORECASE)
    if build_label:
        build = build or build_label[1]
    if ((not VERSION.fullmatch(version) and not build_label) or (build and not VERSION.fullmatch(build))
            or not isinstance(download, str)):
        return None
    download = urljoin(source_url, download)
    try:
        https_url(download)
    except ValueError:
        return None
    host = urlsplit(download).hostname or ""
    return {
        "id": hashlib.sha256(f"{version}\n{build}\n{download}".encode()).hexdigest(),
        "version": version,
        "expectedVersion": "" if build_label else version,
        "build": build,
        "notes": text(value.get("versionDescription" if legacy else "localizedDescription"), 12_000),
        "date": text(value.get("versionDate" if legacy else "date"), 40),
        "minOS": text(value.get("minOSVersion"), 32),
        "maxOS": text(value.get("maxOSVersion"), 32),
        "restricted": host == "patreon.com" or host.endswith(".patreon.com"),
        "downloadURL": download,
    }


def updated_in_2026(release):
    try:
        published = date.fromisoformat(release["date"][:10])
    except ValueError:
        return False
    download = urlsplit(release["downloadURL"])
    return (published.year == 2026 and published <= date.today()
            and download.path.lower().endswith(".ipa") and not release.get("restricted"))


def store_manifests():
    manifests = json.loads(DEFAULT_SOURCES.read_text())
    manifests["appleTVSources"] = list(tv_sources())
    return manifests


@lru_cache(maxsize=1)
def tv_sources():
    definitions = json.loads(DEFAULT_SOURCES.with_name("StoreTV.json").read_text())
    result = {}
    for item in definitions:
        if item["verified"].get("downloadURL"):
            result[f"siderelay://catalogue/tvos/{item['bundleIdentifier']}"] = item
            continue
        endpoint = "?per_page=8" if item.get("publicPreReleases") else "/latest"
        if item.get("pinRelease"):
            endpoint = "/tags/" + quote(item["verified"]["tag"], safe="")
        result[f"https://api.github.com/repos/{item['repo']}/releases{endpoint}"] = item
    return result


def parse_source(document, url, base=None):
    if not isinstance(document, dict) or not isinstance(document.get("apps"), list):
        raise ValueError("This is not an AltStore source.")
    name = text(document.get("name")) or urlsplit(url).hostname
    apps = {}
    groups = store_manifests()
    recent_only = any(url in groups.get(group, []) for group in ("sources2026", "additional2026Sources", "late2026Sources"))
    for item in document["apps"]:
        if not isinstance(item, dict):
            continue
        bundle = text(item.get("bundleIdentifier"), 256)
        if len(bundle) > 255 or not BUNDLE_ID.fullmatch(bundle) or bundle.lower() in IGNORED_BUNDLES:
            continue
        if recent_only and ("superseded" in text(item.get("name")).lower()
                            or item.get("marketplaceID") is not None):
            continue
        rows = item.get("versions")
        versions = [normalise_version(row, base or url) for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
        versions = [entry for entry in versions if entry]
        if not versions:
            legacy = normalise_version(item, base or url, legacy=True)
            if legacy:
                versions = [legacy]
        versions = [release for release in versions if included_release(url, bundle.lower(), release)]
        if recent_only:
            versions = [release for release in versions if updated_in_2026(release)]
        if versions:
            app = apps.setdefault(bundle, {
                "bundleId": bundle, "name": text(item.get("name")) or bundle, "versions": [],
                "developer": text(item.get("developerName")), "subtitle": text(item.get("subtitle")),
                "category": text(item.get("category")), "description": text(item.get("localizedDescription"), 6000),
                "beta": item.get("beta") is True, **source_artwork(item, base or url),
            })
            known = {release["id"] for release in app["versions"]}
            for row in versions:
                if row["id"] not in known:
                    app["versions"].append(row)
                    known.add(row["id"])
    if not apps and not recent_only:
        raise ValueError("This source contains no downloadable IPA releases.")
    return name, list(apps.values())


def fetch_source(url):
    if url == STORE_2026:
        return parse_source(json.loads(DEFAULT_SOURCES.with_name("Store2026.json").read_text()), url)
    definition = tv_sources().get(url)
    if definition and definition["verified"].get("downloadURL"):
        return seed_tv_source(url, definition)
    body = bytearray()
    with open_url(url, "application/json") as response:
        transfer(response, SOURCE_BYTES, 30, body.extend)
        base = response.relay_url
    try:
        doc = json.loads(body)
    except (UnicodeError, ValueError) as error:
        raise ValueError("This source did not return valid JSON.") from error
    if definition:
        return tv_source(doc, url, definition)
    return parse_source(doc, url, base)


def tv_source(document, url, definition):
    repo = definition["repo"]
    verified = definition["verified"]
    releases = document if isinstance(document, list) else [document]
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") is not False:
            continue
        if release.get("prerelease") and not definition.get("publicPreReleases"):
            continue
        tag = text(release.get("tag_name"))
        parts = re.fullmatch(definition["tagPattern"], tag)
        assets = release.get("assets")
        if not parts or not isinstance(assets, list):
            continue
        matching = [(asset, label) for asset in assets if isinstance(asset, dict)
                    and (label := re.fullmatch(definition["assetPattern"], text(asset.get("name"))))]
        if len(matching) != 1:
            continue
        asset, asset_parts = matching[0]
        address = text(asset.get("browser_download_url"), 4096)
        prefix = f"https://github.com/{repo}"
        expected_path = tv_asset_path(tag, asset["name"])
        direct = verified.get("downloadURL")
        valid_address = (address == direct if direct else
                         address[:len(prefix)].casefold() == prefix.casefold() and address[len(prefix):] == expected_path)
        digest, size = asset.get("digest"), asset.get("size")
        if (not valid_address or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
                or type(size) is not int or not 0 < size <= IPA_BYTES):
            continue
        sha256 = digest.removeprefix("sha256:")
        pinned = verified if (verified["tag"] == tag and verified["asset"] == asset["name"]
                              and verified["sha256"] == sha256) else {}
        labels = parts.groupdict() | asset_parts.groupdict()
        if (title_pattern := definition.get("titlePattern")) and (title := re.fullmatch(title_pattern, text(release.get("name")))):
            labels.update(title.groupdict())
        version_label = pinned.get("version") or labels.get("version")
        if not version_label:
            continue
        version = {"version": version_label, "downloadURL": address,
                   "date": release.get("published_at"), "localizedDescription": release.get("body"),
                   "buildVersion": pinned.get("build") or labels.get("build"), "minOSVersion": pinned.get("os")}
        artwork = f"https://raw.githubusercontent.com/{repo}/{definition.get('artworkBranch', 'main')}/"
        name, apps = parse_source({"name": definition["name"], "apps": [{
            "bundleIdentifier": definition["bundleIdentifier"], "name": definition["name"],
            "developerName": definition["developer"], "subtitle": definition["subtitle"], "category": definition["category"],
            "localizedDescription": definition["description"],
            "beta": bool(release.get("prerelease") or "-beta" in tag or "-beta" in asset["name"].lower()),
            "iconURL": definition.get("iconURL") or (artwork + quote(definition["icon"]) if definition.get("icon") else ""),
            "screenshotURLs": [artwork + quote(image) for image in definition.get("screenshots", [])], "versions": [version],
        }]}, url)
        item = apps[0]["versions"][0]
        item.update(platform="tvOS", sha256=sha256, size=size,
                    expectedVersion=pinned.get("version", ""), expectedBuild=pinned.get("build", ""))
        return name, apps
    raise ValueError("No compatible IPA was found in this publisher’s Apple TV releases.")


def tv_asset_path(tag, asset):
    return f"/releases/download/{quote(tag, safe='')}/{quote(asset, safe='')}"


def seed_tv_source(url, definition):
    verified = definition["verified"]
    tag, asset = verified["tag"], verified["asset"]
    address = verified.get("downloadURL") or f"https://github.com/{definition['repo']}" + tv_asset_path(tag, asset)
    return tv_source({
        "tag_name": tag, "draft": False, "prerelease": verified.get("prerelease", False),
        "published_at": verified["date"],
        "assets": [{"name": asset, "browser_download_url": address, "size": verified["size"],
                    "digest": "sha256:" + verified["sha256"]}],
    }, url, definition)


def load_source(db, source_id):
    row = db.execute("SELECT url, name, catalogue, checked_at FROM ipa_sources WHERE id = ?", (source_id,)).fetchone()
    if not row:
        raise ValueError("This source is no longer in SideRelay.")
    return row


def read_ipa_plist(z, entry):
    if entry.file_size > 2 * 1024 * 1024:
        raise ValueError("The IPA metadata is too large.")
    return plistlib.loads(z.read(entry))


def main_ipa_plist(z):
    apps = [entry for entry in z.infolist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", entry.filename)]
    if len(apps) != 1:
        raise ValueError("This IPA has no single main app.")
    return apps[0].filename.removesuffix("Info.plist"), read_ipa_plist(z, apps[0])


def device_families(plist):
    values = plist.get("UIDeviceFamily")
    return [value for value in values if type(value) is int] if isinstance(values, list) else []


def legacy_metadata(path):
    with zipfile.ZipFile(path) as z:
        root, app = main_ipa_plist(z)
        extensions = []
        for entry in z.infolist():
            tail = entry.filename.removeprefix(root)
            if not entry.filename.startswith(root) or not re.fullmatch(r"(?:PlugIns|Extensions)/[^/]+\.appex/Info\.plist", tail):
                continue
            metadata = read_ipa_plist(z, entry)
            extensions.append({
                "bundleId": metadata.get("CFBundleIdentifier"),
                "name": metadata.get("CFBundleDisplayName") or metadata.get("CFBundleName") or tail.split("/")[1],
                "point": (metadata.get("NSExtension") or {}).get("NSExtensionPointIdentifier"),
            })
        return {
            "bundleId": app["CFBundleIdentifier"],
            "displayName": app.get("CFBundleDisplayName") or app.get("CFBundleName") or app["CFBundleIdentifier"],
            "version": app.get("CFBundleShortVersionString") or app.get("CFBundleVersion"),
            "build": app.get("CFBundleVersion"),
            "minimumOs": app.get("MinimumOSVersion"),
            "platforms": app.get("CFBundleSupportedPlatforms") or [],
            "deviceFamilies": device_families(app),
            "extensions": extensions,
        }


def library(db, root):
    packages = []
    for row in db.execute("""
        SELECT p.id, p.path, p.bundle_id, p.display_name, p.version, p.metadata,
               p.source_id, s.name, p.imported_at,
               EXISTS(SELECT 1 FROM apps a WHERE a.ipa_path = p.path)
        FROM ipa_packages p LEFT JOIN ipa_sources s ON p.source_id = s.id
        WHERE p.removed_at IS NULL
        ORDER BY p.imported_at DESC, p.display_name
    """):
        package_id, path, bundle, name, version, saved, source, origin, imported, in_use = row
        path = root / path
        available = path.is_file()
        try:
            metadata = json.loads(saved) if saved else legacy_metadata(path)
        except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile, plistlib.InvalidFileException):
            available = False
            metadata = {"bundleId": bundle, "displayName": name, "version": version, "extensions": []}
        if available and "iPhoneOS" in (metadata.get("platforms") or []) and "deviceFamilies" not in metadata:
            try:
                with zipfile.ZipFile(path) as archive:
                    _, app = main_ipa_plist(archive)
                metadata["deviceFamilies"] = device_families(app)
            except (OSError, ValueError, AttributeError, RuntimeError, ExpatError,
                    zipfile.BadZipFile, zlib.error, plistlib.InvalidFileException):
                # Optional display metadata should not make an archived build unavailable.
                pass
        installs = [
            {"appId": app, "installedAt": date, "current": current}
            for app, date, current in db.execute("""
                SELECT i.app_id, i.installed_at, a.ipa_path = p.path
                FROM ipa_installations i JOIN apps a ON a.id = i.app_id JOIN ipa_packages p ON p.id = i.package_id
                WHERE i.package_id = ?
            """, (package_id,))
        ]
        packages.append({**metadata, "id": package_id, "available": available, "sourceId": source,
                         "sourceName": origin, "importedAt": imported, "installations": installs, "inUse": bool(in_use)})
    return packages


def sources(db, *, with_revision=False):
    results = []
    for source_id, url, name, catalogue, checked in db.execute(
            "SELECT id, url, name, catalogue, checked_at FROM ipa_sources ORDER BY lower(name), id"):
        apps = json.loads(catalogue)
        for app in apps:
            bundle = app["bundleId"].lower()
            app["versions"] = [release for release in app["versions"]
                               if included_release(url, bundle, release)]
            for version in app["versions"]:
                host = urlsplit(version["downloadURL"]).hostname or ""
                version.setdefault("restricted", host == "patreon.com" or host.endswith(".patreon.com"))
                version.pop("downloadURL", None)
        apps = [app for app in apps if app["versions"] and app["bundleId"].lower() not in IGNORED_BUNDLES]
        source = {"id": source_id, "host": urlsplit(url).hostname, "name": name,
                  "checkedAt": checked, "curated": curated_source(url), "apps": apps}
        if with_revision:
            source["revision"] = hashlib.sha256(catalogue.encode()).hexdigest()
        results.append(source)
    return results


def seed_store(db):
    groups = store_manifests()
    television = tv_sources()
    checked = int(time.time())
    with db:
        db.execute("""CREATE TABLE IF NOT EXISTS ipa_store_defaults (
            url TEXT PRIMARY KEY)""")
        for addresses in groups.values():
            for url in addresses:
                definition = television.get(url)
                new_default = db.execute("INSERT OR IGNORE INTO ipa_store_defaults VALUES (?)", (url,)).rowcount
                if new_default:
                    if definition:
                        name, apps = seed_tv_source(url, definition)
                    else:
                        name, apps = fetch_source(url) if url == STORE_2026 else (urlsplit(url).hostname, [])
                    db.execute("""INSERT OR IGNORE INTO ipa_sources (id,url,name,catalogue,checked_at)
                                  VALUES (?,?,?,?,?)""",
                               (str(uuid4()), url, name, json.dumps(apps), checked if apps else 0))
                elif url == STORE_2026:
                    name, apps = fetch_source(url)
                    catalogue = json.dumps(apps)
                    db.execute("""UPDATE ipa_sources SET name=?, catalogue=?, checked_at=?
                                  WHERE url=? AND (name != ? OR catalogue != ?)""",
                               (name, catalogue, checked, url, name, catalogue))
                elif definition and db.execute("SELECT 1 FROM ipa_sources WHERE url = ? AND catalogue = '[]'", (url,)).fetchone():
                    name, apps = seed_tv_source(url, definition)
                    db.execute("""UPDATE ipa_sources SET name=?, catalogue=?, checked_at=?
                                  WHERE url=? AND catalogue='[]'""", (name, json.dumps(apps), checked, url))


def store_schedule(db):
    db.execute("""CREATE TABLE IF NOT EXISTS ipa_store_failures (
        source_id TEXT PRIMARY KEY, message TEXT NOT NULL, tried_at INTEGER NOT NULL,
        github_retry_at INTEGER NOT NULL)""")
    rows = db.execute("""SELECT s.id,s.url,s.checked_at,f.message,f.tried_at,f.github_retry_at
        FROM ipa_sources s LEFT JOIN ipa_store_failures f ON f.source_id=s.id""").fetchall()
    github_retry_at = max((row[5] or 0 for row in rows), default=0)
    schedule = {}
    for source_id, url, checked, error, tried, _ in rows:
        github = urlsplit(url).hostname == GITHUB_API_HOST
        blocked_until = github_retry_at if github else 0
        interval = GITHUB_REFRESH_INTERVAL if github else STORE_REFRESH_INTERVAL
        due = checked + interval if checked else 0
        if tried:
            due = tried + SOURCE_RETRY_INTERVAL
        schedule[source_id] = (url, error, max(due, blocked_until), blocked_until)
    return schedule


def refreshable_sources(schedule, force=False):
    now = int(time.time())
    return [(source_id, url) for source_id, (url, _, due, blocked) in schedule.items()
            if blocked <= now and (force or due <= now)]


def store_snapshot(db, updated=False):
    schedule = store_schedule(db)
    catalogues = sources(db, with_revision=True)
    for source in catalogues:
        entry = schedule.get(source["id"])
        if entry and entry[1]:
            source["refreshError"] = entry[1]
    now = int(time.time())
    return {
        "sources": catalogues, "updated": updated,
        "failed": [source["id"] for source in catalogues if source.get("refreshError")],
        "refreshAfter": min((row[2] for row in schedule.values()), default=now + STORE_REFRESH_INTERVAL),
        "githubRetryAt": max((row[3] for row in schedule.values() if row[3] > now), default=0),
    }


def refresh_catalogues(db, entries):
    if not entries:
        return False

    github_limit = None
    limit_lock = threading.Lock()

    def read(entry):
        nonlocal github_limit
        source_id, url = entry
        if urlsplit(url).hostname == GITHUB_API_HOST:
            with limit_lock:
                if github_limit:
                    return source_id, None, github_limit
        try:
            return source_id, fetch_source(url), None
        except GitHubRateLimit as error:
            with limit_lock:
                if not github_limit or error.retry_at > github_limit.retry_at:
                    github_limit = error
            return source_id, None, error
        except (ValueError, OSError, http.client.HTTPException) as error:
            return source_id, None, error

    changed = False
    with ThreadPoolExecutor(max_workers=8) as pool:
        for source_id, result, error in pool.map(read, entries):
            with db:
                if error is not None:
                    message = (str(error)[:200] if isinstance(error, ValueError) else
                               "The publisher couldn’t be reached.")
                    blocked_until = error.retry_at if isinstance(error, GitHubRateLimit) else 0
                    db.execute("""INSERT INTO ipa_store_failures
                        SELECT id, ?, unixepoch(), ? FROM ipa_sources WHERE id=?
                        ON CONFLICT(source_id) DO UPDATE SET message=excluded.message,
                        tried_at=excluded.tried_at, github_retry_at=excluded.github_retry_at""",
                        (message, blocked_until, source_id))
                else:
                    name, catalogue = result
                    changed |= bool(db.execute("""UPDATE ipa_sources
                        SET name=?, catalogue=?, checked_at=unixepoch() WHERE id=?""",
                        (name, json.dumps(catalogue), source_id)).rowcount)
                    db.execute("DELETE FROM ipa_store_failures WHERE source_id=?", (source_id,))
    return changed


def store_artwork(db, source_id, address):
    _, _, catalogue, _ = load_source(db, source_id)
    if not any(address in (app.get("icon"), app.get("preview"), *app.get("screenshots", []))
               for app in json.loads(catalogue)):
        raise ValueError("This image is no longer in the source.")
    image = bytearray()
    with open_url(address, "image/*") as response:
        transfer(response, IMAGE_BYTES, 12, image.extend)
    signatures = (
        (b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
        (b"GIF8", "image/gif"),
    )
    mime = next((kind for magic, kind in signatures if image.startswith(magic)), "")
    if image.startswith(b"RIFF") and image[8:12] == b"WEBP":
        mime = "image/webp"
    if image[4:12] == b"ftypavif":
        mime = "image/avif"
    return mime, bytes(image)


def store_image(db, source_id, address):
    mime, image = store_artwork(db, source_id, address)
    return {"mime": mime, "image": b64encode(image).decode("ascii")} if mime else {}


def private_work(root):
    work = root / "travail-signature"
    work.mkdir(exist_ok=True, mode=0o700)
    if work.is_symlink() or work.stat().st_mode & 0o077:
        raise ValueError("The SideRelay working directory must remain private.")
    return work


def upload_archive(temp, port, size, extra=None):
    if size < 4 or size > IPA_BYTES:
        raise ValueError("Choose an IPA smaller than 512 MB.")
    temp.seek(0)
    headers = {"Content-Type": "application/octet-stream", "Content-Length": str(size),
               "X-SideRelay-Action": "catalogue", **(extra or {})}
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    try:
        connection.request("POST", "/api/siderelay/ipa/import", temp, headers)
        result = connection.getresponse()
        body = result.read(256 * 1024)
        if result.status != 200:
            raise ValueError(body.decode("utf-8", errors="replace")[:500] or "SideRelay could not import the IPA.")
        return json.loads(body)
    finally:
        connection.close()


def download(db, root, port, source_id, bundle, release_id):
    url, _, catalogue, _ = load_source(db, source_id)
    release = next((release for app in json.loads(catalogue) if app["bundleId"] == bundle
                    for release in app["versions"] if release["id"] == release_id), None)
    if not release or bundle.lower() in IGNORED_BUNDLES or not included_release(url, bundle.lower(), release):
        raise ValueError("This version is no longer in the source. Refresh the catalogue.")
    host = urlsplit(release["downloadURL"]).hostname or ""
    if host == "patreon.com" or host.endswith(".patreon.com"):
        raise ValueError("This release is available through the publisher.")
    with tempfile.TemporaryFile(dir=private_work(root)) as temp:
        with open_url(release["downloadURL"], "application/octet-stream") as response:
            size = transfer(response, IPA_BYTES, 240, temp.write)
        if url in tv_sources():
            temp.seek(0)
            if size != release["size"] or hashlib.file_digest(temp, "sha256").hexdigest() != release["sha256"]:
                raise ValueError("The download did not match GitHub’s checksum.")
            with zipfile.ZipFile(temp) as archive:
                _, info = main_ipa_plist(archive)
                if "AppleTVOS" not in (info.get("CFBundleSupportedPlatforms") or []):
                    raise ValueError("The download is not an Apple TV app.")
        headers = {"X-SideRelay-Source": source_id, "X-SideRelay-Bundle": bundle}
        if expected := release.get("expectedVersion", release["version"]):
            headers["X-SideRelay-Version"] = expected
        if expected := release.get("expectedBuild", release["build"]):
            headers["X-SideRelay-Build"] = expected
        return upload_archive(temp, port, size, headers)


def import_build(root, port, source):
    from .InspectionIPA import package_build
    with tempfile.TemporaryFile(dir=private_work(root)) as temp:
        package_build(source, temp)
        return upload_archive(temp, port, temp.tell())


def inbox_status(db):
    if not db.execute("SELECT 1 FROM sqlite_schema WHERE name = 'ipa_inbox'").fetchone():
        return {"revision": "", "errors": [], "packageIds": []}
    rows = db.execute("SELECT name, fingerprint, package_id, error FROM ipa_inbox ORDER BY name").fetchall()
    revision = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
    errors = [{"file": name, "message": "This file is not a complete IPA archive."
               if error.startswith("invalid Zip archive:") else error}
              for name, _, _, error in rows if error]
    return {"revision": revision, "errors": errors,
            "packageIds": sorted({package_id for _, _, package_id, error in rows if package_id and not error})}


def command(db, root, port, action, first=None, second=None, third=None):
    if action == "list":
        # Capture the revision first so an import during this read triggers a later reload.
        inbox = inbox_status(db)
        return {"packages": library(db, root), "sources": sources(db), "inbox": inbox}
    if action == "inbox":
        return inbox_status(db)
    if action == "prepare-top-shelf-update":
        from .MisesAJourIPA import prepare_top_shelf_update
        return prepare_top_shelf_update(db, root, port, second, first) or {}
    if action == "store":
        seed_store(db)
        return store_snapshot(db)
    if action == "refresh-store":
        seed_store(db)
        entries = refreshable_sources(store_schedule(db), force=first == "all")
        return store_snapshot(db, updated=refresh_catalogues(db, entries))
    if action == "store-image":
        return store_image(db, first, second)
    if action == "add":
        name, catalogue = fetch_source(first)
        store_schedule(db)
        with db:
            db.execute("""
                INSERT INTO ipa_sources (id,url,name,catalogue,checked_at) VALUES (?,?,?,?,unixepoch())
                ON CONFLICT(url) DO UPDATE SET name=excluded.name,catalogue=excluded.catalogue,checked_at=excluded.checked_at
            """, (str(uuid4()), first, name, json.dumps(catalogue)))
            db.execute("DELETE FROM ipa_store_failures WHERE source_id=(SELECT id FROM ipa_sources WHERE url=?)",
                       (first,))
    elif action == "refresh":
        schedule = store_schedule(db)
        if first not in schedule:
            raise ValueError("This source is no longer in SideRelay.")
        entries = refreshable_sources({first: schedule[first]}, force=True)
        return store_snapshot(db, updated=refresh_catalogues(db, entries))
    elif action == "remove":
        store_schedule(db)
        with db:
            db.execute("DELETE FROM ipa_sources WHERE id = ?", (first,))
            db.execute("DELETE FROM ipa_store_failures WHERE source_id=?", (first,))
    elif action == "download":
        return download(db, root, port, first, second, third)
    elif action == "import-build":
        return import_build(root, port, first)
    elif action in ("diagnose", "signing-path"):
        from .InspectionIPA import package_path
        path = package_path(db, root, first)
        if action == "signing-path":
            return {"path": str(path)}
        from .ProvisionnementIPA import diagnosis
        device = db.execute("SELECT udid FROM devices WHERE id = ?", (second,)).fetchone() if second else None
        if second and (device is None or not device[0]):
            raise ValueError("The selected device has no registered identifier.")
        helper = Path(os.environ.get("SIDERELAY_IDENTITY_HELPER", root.parent / "SideRelay.app/Contents/MacOS/siderelay-identity"))
        with tempfile.TemporaryDirectory(prefix="preflight-", dir=private_work(root)) as work:
            return diagnosis(path, device[0] if device else None, Path(work), helper)
    elif action == "inspect":
        from .InspectionIPA import inspect_package
        return inspect_package(db, root, first)
    elif action == "icon":
        from .InspectionIPA import icon_preview
        with tempfile.TemporaryDirectory(prefix="ipa-icon-", dir=private_work(root)) as work:
            image = icon_preview(db, root, first, Path(work))
        return {"png": b64encode(image).decode("ascii")} if image else {}
    else:
        raise ValueError("Unknown catalogue action.")
    return store_snapshot(db)
