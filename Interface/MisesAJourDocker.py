"""Discover stable SideRelay Docker releases without credentials."""

import json
import re
import threading
import time
from urllib.request import Request, urlopen
from xml.etree import ElementTree


RELEASES = "https://github.com/arkemys-consulting/SideRelay/releases"
API = "https://api.github.com/repos/arkemys-consulting/SideRelay/releases?per_page=50"
TAG = re.compile(r"docker-v([0-9]+\.[0-9]+\.[0-9]+)")
ATOM = "{http://www.w3.org/2005/Atom}"
ASSET_HOSTS = ("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
LIMIT = 2 * 1024 * 1024


def read(url, accept):
    request = Request(url, headers={"Accept": accept, "User-Agent": "SideRelay-Docker"})
    with urlopen(request, timeout=5) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError("Unexpected release data size.")
    return data


def assets(tag):
    version = tag.removeprefix("docker-v")
    return {"compose.yaml", "SHA256SUMS", *(f"SideRelay-Docker-{version}-linux-{arch}.tar.gz" for arch in ("arm64", "amd64"))}


def public_tags():
    try:
        releases = json.loads(read(API, "application/vnd.github+json"))
        if not isinstance(releases, list):
            raise ValueError("Unexpected release data.")
    except (OSError, ValueError):
        feed = read(f"{RELEASES}.atom", "application/atom+xml")
        for link in ElementTree.fromstring(feed).iterfind(f"{ATOM}entry/{ATOM}link"):
            href = link.get("href", "")
            prefix = f"{RELEASES}/tag/"
            tag = href.removeprefix(prefix)
            if href.startswith(prefix) and TAG.fullmatch(tag):
                # The public feed lists releases. Make sure the installer bundle is available.
                checksum = Request(f"{RELEASES}/download/{tag}/SHA256SUMS", method="HEAD")
                try:
                    with urlopen(checksum, timeout=4) as response:
                        if response.url.startswith(tuple(f"https://{host}/" for host in ASSET_HOSTS)):
                            yield tag
                except OSError:
                    continue
        return
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
            continue
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not TAG.fullmatch(tag):
            continue
        uploaded = {asset.get("name") for asset in release.get("assets", [])
                    if isinstance(asset, dict) and asset.get("state") == "uploaded"}
        if assets(tag) <= uploaded:
            yield tag


def version(value):
    return tuple(map(int, value.split(".")))


class DockerUpdates:
    def __init__(self, current):
        self.current = current
        self.lock = threading.Lock()
        self.next_check = 0
        self.offer = None

    def check(self):
        with self.lock:
            if time.monotonic() >= self.next_check:
                try:
                    versions = (tag.removeprefix("docker-v") for tag in public_tags())
                    latest = max(versions, default=self.current, key=version)
                    self.offer = (dict(version=latest, current=self.current, url=f"{RELEASES}/tag/docker-v{latest}")
                                  if version(latest) > version(self.current) else None)
                    delay = 6 * 60 * 60
                except (OSError, ValueError, ElementTree.ParseError):
                    delay = 5 * 60
                self.next_check = time.monotonic() + delay
            return {"update": self.offer}
