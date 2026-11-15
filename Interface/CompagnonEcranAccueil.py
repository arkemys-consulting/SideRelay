"""Publish one private Home Screen web app for a LiveContainer guest."""

import hashlib
from html import escape
import json
import plistlib
import tempfile


HOME_SCREEN_PATH = "home-screen/launch"

LAUNCH_SCRIPT = """const openLink = document.getElementById("open");
if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) {
    document.getElementById("setup").hidden = true;
    openLink.hidden = false;

    let ready = Promise.resolve();
    if ("serviceWorker" in navigator) {
        ready = Promise.race([
            navigator.serviceWorker.register("./worker.js")
                .then(() => navigator.serviceWorker.ready)
                .catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 1000))
        ]);
    }

    let lastLaunch = -Infinity;
    async function launchGuest() {
        await ready;
        if (document.visibilityState !== "visible" || performance.now() - lastLaunch < 900) return;
        lastLaunch = performance.now();
        location.href = openLink.href;
    }

    document.addEventListener("visibilitychange", launchGuest);
    window.addEventListener("pageshow", launchGuest);
    window.addEventListener("focus", launchGuest);
    launchGuest();
}
"""

WORKER_SCRIPT = """const cacheName = "siderelay-launch-v1:" + new URL(self.registration.scope).pathname;
const resources = ["./", "./icon.png", "./launcher.js"]
    .map(path => new URL(path, self.registration.scope).href);

self.addEventListener("install", event => {
    event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(resources))
        .then(() => self.skipWaiting()));
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET" || !resources.includes(event.request.url)) return;
    event.respondWith(caches.open(cacheName).then(async cache =>
        (await cache.match(event.request)) || fetch(event.request)));
});
"""


def save_launcher(root, device, clip):
    links = root / "home-screen"
    links.mkdir(mode=0o700, exist_ok=True)
    if links.is_symlink() or links.stat().st_mode & 0o077:
        raise ValueError("The Home Screen data directory must remain private.")

    # Keep existing icons working when their guest's name or artwork changes.
    key = hashlib.sha256(f'{device}\n{clip["URL"]}'.encode()).hexdigest()
    destination = links / (key + ".plist")
    with tempfile.NamedTemporaryFile(dir=links, delete=False) as staging:
        path = links / staging.name
        try:
            plistlib.dump({
                "device": device,
                "name": clip["Label"],
                "launch": clip["URL"],
                "icon": clip["Icon"],
            }, staging, fmt=plistlib.FMT_BINARY)
            staging.close()
            path.replace(destination)
        finally:
            path.unlink(missing_ok=True)
    return key


def read_launcher(root, key):
    with (root / "home-screen" / (key + ".plist")).open("rb") as record:
        return plistlib.load(record)


def launcher_resource(record, resource):
    if resource == "icon.png":
        return "image/png", record["icon"]
    if resource == "launcher.js":
        return "text/javascript; charset=utf-8", LAUNCH_SCRIPT.encode()
    if resource == "worker.js":
        return "text/javascript; charset=utf-8", WORKER_SCRIPT.encode()
    if resource == "manifest.webmanifest":
        return "application/manifest+json", json.dumps({
            "id": "./",
            "name": record["name"],
            "short_name": record["name"],
            "start_url": "./",
            "scope": "./",
            "display": "standalone",
            "icons": [{"src": "./icon.png", "type": "image/png"}],
        }).encode()

    name = escape(record["name"])
    launch = escape(record["launch"], quote=True)
    return "text/html; charset=utf-8", f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="{name}">
<link rel="apple-touch-icon" href="./icon.png">
<link rel="manifest" href="./manifest.webmanifest">
<title>{name}</title>
<style>
    :root {{ color-scheme: light dark; font: 100% system-ui; }}
    body {{ display: grid; min-height: 100dvh; margin: 0; place-items: center; }}
    main {{ max-width: 24rem; padding: 2rem; text-align: center; }}
    img {{ width: 5rem; height: 5rem; border-radius: 1.15rem; }}
    h1 {{ margin: 1rem 0 .6rem; font-size: 1.5rem; overflow-wrap: anywhere; }}
    p {{ line-height: 1.5; }}
    a {{ display: inline-grid; place-items: center; min-height: 44px; padding: 0 1rem;
         border-radius: .9rem; background: #005ac2; color: white; font-weight: 600; text-decoration: none; }}
    [hidden] {{ display: none; }}
</style>
<script defer src="./launcher.js"></script>
</head>
<body>
<main>
    <img src="./icon.png" alt="">
    <h1>{name}</h1>
    <p id="setup">Tap <strong>Share</strong>, choose <strong>Add to Home Screen</strong>,
        then tap <strong>Add</strong>.</p>
    <a id="open" href="{launch}" hidden>Open {name}</a>
</main>
</body>
</html>
""".encode()
