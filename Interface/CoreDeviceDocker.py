"""Relay SideRelay's tvOS operations to the paired Mac that runs CoreDevice."""

from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

TV_ID = re.compile(r"[0-9a-fA-F-]{8,64}")
BUNDLE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,254}")
ARCHIVE_LIMIT = 1024 * 1024 * 1024


def available():
    return (os.environ.get("SIDERELAY_HOST_DISCOVERY") == "1"
            and os.environ.get("SIDERELAY_HOST_TVOS") == "1"
            and bool(os.environ.get("SIDERELAY_DISCOVERY_TOKEN")))


def mac_request(method, path, body=None, headers=None, timeout=12):
    if not available():
        raise ValueError("Enable the Mac’s Apple TV service to manage Apple TV in Docker.")
    token = os.environ["SIDERELAY_DISCOVERY_TOKEN"]
    port = int(os.environ.get("SIDERELAY_DISCOVERY_PORT", "18786"))
    with closing(http.client.HTTPConnection("host.docker.internal", port, timeout=timeout)) as host:
        host.request(method, path, body, {"Authorization": f"Bearer {token}", **(headers or {})})
        with host.getresponse() as response:
            data = response.read(4 * 1024 * 1024 + 1)
            try:
                result = json.loads(data)
            except ValueError as error:
                if response.status == 404:
                    raise ValueError("Update the Mac discovery helper and start it with --apple-tv.") from error
                raise ValueError("The Mac did not return a valid Apple TV response.") from error
            if response.status != 200:
                raise ValueError(result.get("error") or "The Mac could not complete the Apple TV operation.")
            return result


def devicectl(*args, timeout):
    try:
        run = subprocess.run(
            ["/usr/bin/xcrun", "devicectl", *args, "--quiet", "--timeout", str(timeout), "--json-output", "-"],
            check=False, capture_output=True, timeout=timeout + 3,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("CoreDevice is unavailable or timed out. Check Xcode and the Apple TV.") from error
    try:
        response = json.loads(run.stdout)
    except ValueError:
        response = {}
    if run.returncode:
        description = response.get("error", {}).get("userInfo", {}).get("NSLocalizedDescription")
        raise ValueError(description or run.stderr.decode(errors="replace").strip()[:1200] or "CoreDevice failed.")
    if not isinstance(response.get("result"), dict):
        raise ValueError("CoreDevice did not return the expected result.")
    return response["result"]


def local_devices():
    devices = devicectl("list", "devices", timeout=8).get("devices")
    if not isinstance(devices, list):
        raise ValueError("CoreDevice did not return a device list.")
    return [device for device in devices
            if device.get("hardwareProperties", {}).get("platform") == "tvOS"
            and device.get("connectionProperties", {}).get("transportType") == "localNetwork"]


def device_choice(device):
    hardware, properties = device["hardwareProperties"], device["deviceProperties"]
    udid = hardware.get("udid") or ""
    identifier = device.get("identifier") or ""
    paired = device["connectionProperties"].get("pairingState") == "paired"
    key = udid if paired else identifier or udid
    if not TV_ID.fullmatch(key):
        return None
    return {"id": key, "udid": udid, "name": properties.get("name") or "Apple TV",
            "osVersion": properties.get("osVersionNumber") or "", "paired": paired}


def nearby():
    choices = [choice for device in local_devices() if (choice := device_choice(device))]
    return {"status": "ready", "devices": choices}


def paired_device(identifier):
    return next((device for device in local_devices()
                 if device["hardwareProperties"].get("udid") == identifier
                 and device["connectionProperties"].get("pairingState") == "paired"), None)


def pair(identifier):
    device = next((item for item in local_devices()
                   if identifier in (item.get("identifier"), item["hardwareProperties"].get("udid"))), None)
    if device is None:
        raise ValueError("Open Remote App and Devices on the Apple TV, then scan again.")
    choice = device_choice(device)
    if choice and choice["paired"]:
        return choice
    devicectl("manage", "pair", "--device", identifier, timeout=55)
    result = next((choice for item in local_devices()
                   if identifier in (item.get("identifier"), item["hardwareProperties"].get("udid"))
                   and (choice := device_choice(item)) and choice["paired"]), None)
    if result is None:
        raise ValueError("Finish pairing in Xcode on the Mac, then scan again.")
    return result


class ArchiveBody:
    def __init__(self, stream, length):
        self.stream = stream
        self.remaining = length

    def read(self, size):
        block = self.stream.read(min(size, self.remaining))
        self.remaining -= len(block)
        return block


def receive_app(stream, length, destination):
    if not 0 < length <= ARCHIVE_LIMIT:
        raise ValueError("The signed Apple TV app exceeds the supported size.")
    count = 0
    with tarfile.open(fileobj=ArchiveBody(stream, length), mode="r|") as archive:
        for entry in archive:
            count += 1
            parts = entry.name.split("/")
            if (count > 50000 or parts[0] != "App.app"
                    or any(part in ("", ".", "..") for part in parts)
                    or not (entry.isfile() or entry.isdir())):
                raise ValueError("The signed Apple TV app contains unsupported archive entries.")
            path = destination.joinpath(*parts)
            if entry.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o700 if entry.mode & 0o111 else 0o600)
    app = destination / "App.app"
    info = app / "Info.plist"
    if not info.is_file() or info.stat().st_size > 1024 * 1024:
        raise ValueError("The signed Apple TV app lacks a valid Info.plist.")
    with info.open("rb") as source:
        metadata = plistlib.load(source)
    if (not isinstance(metadata, dict) or "AppleTVOS" not in metadata.get("CFBundleSupportedPlatforms", [])
            or not (app / "embedded.mobileprovision").is_file()):
        raise ValueError("Choose a signed tvOS application.")
    return app


def run_client(arguments):
    # Accept only the command shapes generated by SideRelay's signing engine.
    if (len(arguments) < 5 or arguments[-5:-3] != ["--quiet", "--timeout"]
            or arguments[-3] not in ("8", "12", "30", "300")
            or arguments[-2:] != ["--json-output", "/dev/stdout"]):
        raise ValueError("Unsupported CoreDevice options.")
    args = arguments[:-5]
    if args == ["list", "devices"]:
        return mac_request("GET", "/tvos/devices")
    if len(args) == 6 and args[:5] == ["device", "info", "apps", "--include-all-apps", "--device"]:
        if TV_ID.fullmatch(args[5]):
            return mac_request("GET", f"/tvos/apps/{args[5]}", timeout=25)
        raise ValueError("CoreDevice received an invalid Apple TV identifier.")
    if len(args) != 6 or args[0] != "device" or args[3] != "--device":
        raise ValueError("Unsupported CoreDevice command.")
    if not TV_ID.fullmatch(args[4]):
        raise ValueError("CoreDevice received an invalid Apple TV identifier.")
    identifier = args[4]
    if args[1:3] == ["uninstall", "app"] and BUNDLE_ID.fullmatch(args[5]):
        body = json.dumps({"bundle": args[5]}).encode()
        return mac_request("POST", f"/tvos/uninstall/{identifier}", body,
                           {"Content-Type": "application/json"}, timeout=45)
    if args[1:3] == ["install", "app"]:
        app = Path(args[5])
        if not app.is_dir() or app.suffix != ".app":
            raise ValueError("The signed Apple TV app is missing.")
        with tempfile.TemporaryFile() as payload:
            with tarfile.open(fileobj=payload, mode="w") as archive:
                archive.add(app, arcname="App.app")
            length = payload.tell()
            if length > ARCHIVE_LIMIT:
                raise ValueError("The signed Apple TV app exceeds the supported size.")
            payload.seek(0)
            return mac_request("POST", f"/tvos/install/{identifier}", payload,
                               {"Content-Type": "application/x-tar", "Content-Length": str(length)}, timeout=330)
    raise ValueError("Unsupported CoreDevice operation.")


if __name__ == "__main__":
    try:
        print(json.dumps({"result": run_client(sys.argv[1:])}))
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(str(error)[:2000], file=sys.stderr)
        sys.exit(1)
