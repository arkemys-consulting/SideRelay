"""Inspect and prepare an IPA for the owner's development workflow."""
import argparse
from copy import copy
from datetime import datetime, timezone
import ipaddress
import json
import os
import platform
import plistlib
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
if __package__:
    from .ComposantsIPA import EXECUTABLE, link_libraries, prepare_components, validate_ios_binary
else:
    from ComposantsIPA import EXECUTABLE, link_libraries, prepare_components, validate_ios_binary

GIB = 1024 ** 3
MAX_DOWNLOAD = 2 * GIB
MAX_EXPANDED = 8 * GIB
MODEL_KEYS = {"UISupportedDevices", "CFBundleSupportedDevices", "SupportedDevices", "softwareSupportedDevices"}


def archive(path):
    z = zipfile.ZipFile(path)
    try:
        members = z.infolist()
        if len(members) > 100_000 or sum(i.file_size for i in members) > MAX_EXPANDED:
            raise ValueError("The archive is too large.")
        seen = set()
        for item in members:
            name = item.filename.rstrip("/")
            if not name or "\\" in name or any(p in ("", ".", "..") for p in name.split("/")):
                raise ValueError("The archive contains an invalid path.")
            key = name.casefold()
            if key in seen:
                raise ValueError("The archive contains duplicate paths.")
            seen.add(key)
        apps = [i.filename[:-len("/Info.plist")] for i in members
                if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", i.filename)]
        if len(apps) != 1:
            raise ValueError("Choose an IPA with exactly one app.")
        return z, apps[0]
    except BaseException:
        z.close()
        raise


def plist(z, name):
    if z.getinfo(name).file_size > 4 * 1024 * 1024:
        raise ValueError("The app metadata is too large.")
    return plistlib.loads(z.read(name))


def plugins(z, root):
    regex = re.compile(re.escape(root) + r"/(?:PlugIns|Extensions)/[^/]+\.appex/Info\.plist")
    found = []
    for name in z.namelist():
        if regex.fullmatch(name):
            p = plist(z, name)
            path = name.removesuffix("/Info.plist")
            found.append({"path": path, "identifier": p.get("CFBundleIdentifier"), "name": p.get("CFBundleDisplayName") or
                          p.get("CFBundleName") or PurePosixPath(path).stem})
    return found


def inspect(source):
    z, root = archive(source)
    with z:
        p = plist(z, root + "/Info.plist")
        return {"name": p.get("CFBundleDisplayName") or p.get("CFBundleName") or PurePosixPath(root).stem,
                "identifier": p.get("CFBundleIdentifier", ""), "minimum": p.get("MinimumOSVersion", ""),
                "platform": (p.get("CFBundleSupportedPlatforms") or [""])[0],
                "extensions": plugins(z, root)}


def translated_id(value, old, new):
    if isinstance(value, str) and (value == old or value.startswith(old + ".")):
        return new + value[len(old):]
    return value


def remove_device_models(info):
    for key in MODEL_KEYS:
        info.pop(key, None)


def copy_member(archive, member, destination):
    with archive.open(member) as incoming, destination.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)


def app_executable(info, root):
    name = info.get("CFBundleExecutable")
    if not isinstance(name, str) or name in ("", ".", "..") or "/" in name or "\\" in name:
        raise ValueError("The IPA does not declare a valid executable.")
    return root + "/" + name


def component_root(path):
    parts = path.split("/")
    return "/".join(parts[:2] if parts[0].casefold() == "frameworks" else parts[:1]).casefold()


def replace_icons(meta, root, source, workspace):
    icon = workspace / "square.png"
    size = subprocess.check_output(
        ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", str(source)], text=True, timeout=30)
    sides = [int(v) for v in re.findall(r"pixel(?:Width|Height): (\d+)", size)]
    if len(sides) != 2 or min(sides) < 1 or max(sides) > 12000:
        raise ValueError("Choose a valid PNG or JPEG icon.")
    side = str(min(sides))
    subprocess.run(["/usr/bin/sips", "-s", "format", "png", "-c", side, side, str(source),
                    "--out", str(icon)], check=True, capture_output=True, timeout=30)
    outputs = {}
    for name, pixels in (("Icon60@2x", 120), ("Icon60@3x", 180), ("Icon76@2x", 152), ("Icon83.5@2x", 167)):
        dest = workspace / (name + ".png")
        subprocess.run(["/usr/bin/sips", "-z", str(pixels), str(pixels), str(icon), "--out", str(dest)],
                       check=True, capture_output=True, timeout=30)
        outputs[root + "/SR" + dest.name] = dest.read_bytes()
    for key, files in (("CFBundleIcons", ["SRIcon60"]),
                       ("CFBundleIcons~ipad", ["SRIcon60", "SRIcon76", "SRIcon83.5"])):
        icons = dict(meta.get(key) or {})
        icons["CFBundlePrimaryIcon"] = {"CFBundleIconFiles": files, "UIPrerenderedIcon": False}
        meta[key] = icons
    meta["CFBundleIconFiles"] = ["SRIcon60"]
    meta.pop("CFBundleIconName", None)
    return outputs


def modified_ipa(source, dest, options, workspace):
    z, root = archive(source)
    with z:
        main = root + "/Info.plist"
        info = plist(z, main)
        old = info.get("CFBundleIdentifier", "")
        bundle_id = options.get("identifier", "").strip()
        name = options.get("name", "").strip()
        minimum = options.get("minimum", "").strip()
        if bundle_id and (len(bundle_id) > 155 or not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle_id) or not old):
            raise ValueError("Enter a bundle ID like com.example.app.")
        if minimum and not re.fullmatch(r"[0-9]{1,2}(?:\.[0-9]{1,2}){1,2}", minimum):
            raise ValueError("Enter a minimum iOS version like 17.0.")
        if len(name) > 100 or any(ord(c) < 32 for c in name):
            raise ValueError("Enter an app name up to 100 characters.")
        removed = set(options.get("remove", []))
        if not removed <= {p["path"] for p in plugins(z, root)}:
            raise ValueError("Select extensions from this IPA.")
        if options.get("icon") and info.get("CFBundleSupportedPlatforms") == ["AppleTVOS"]:
            raise ValueError("Changing the icon is available for iPhone and iPad IPAs.")

        if name:
            info.update(CFBundleDisplayName=name, CFBundleName=name)
        if minimum:
            info["MinimumOSVersion"] = minimum
        if bundle_id:
            info["CFBundleIdentifier"] = bundle_id
        if options.get("sharing"):
            info.update(UIFileSharingEnabled=True, LSSupportsOpeningDocumentsInPlace=True)
        remove_models = options.get("removeDeviceModels", False)
        if remove_models:
            remove_device_models(info)
        components, libraries = prepare_components(options.get("components", []), workspace)
        if components and info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
            raise ValueError("Component embedding is available for iPhone and iPad IPAs.")
        component_entries = [(root + "/" + path, source) for path, source in components]
        component_names = [path.casefold() for path, _ in component_entries]
        component_roots = {component_root(path) for path, _ in components}
        existing_roots = {component_root(path[len(root)+1:].rstrip("/"))
                          for path in z.namelist() if path.startswith(root + "/")}
        if len(set(component_names)) != len(component_names) or component_roots & existing_roots:
            raise ValueError("Two selected or existing components have the same name.")
        patched = workspace / "patched-executable"
        executable = None
        if libraries:
            executable = app_executable(info, root)
            if executable not in z.namelist():
                raise ValueError("The IPA executable is missing.")
            copy_member(z, executable, patched)
            link_libraries(patched, libraries)
        additions = replace_icons(info, root, Path(options["icon"]), workspace) if options.get("icon") else {}
        changes = {main: plistlib.dumps(info, fmt=plistlib.FMT_BINARY)}
        for item in z.infolist():
            path = item.filename
            if any(path == p or path.startswith(p + "/") for p in removed):
                continue
            nested_app_info = path.rsplit("/", 1)[0].endswith((".app", ".appex"))
            if (path != main and path.startswith(root + "/") and path.endswith("/Info.plist")
                    and (bundle_id or (remove_models and nested_app_info))):
                child = plist(z, path)
                if bundle_id:
                    for key in ("CFBundleIdentifier", "WKCompanionAppBundleIdentifier", "WKAppBundleIdentifier"):
                        if key in child:
                            child[key] = translated_id(child[key], old, bundle_id)
                if remove_models and nested_app_info:
                    remove_device_models(child)
                changes[path] = plistlib.dumps(child, fmt=plistlib.FMT_BINARY)
            if remove_models and path == "iTunesMetadata.plist":
                metadata = plist(z, path)
                remove_device_models(metadata)
                changes[path] = plistlib.dumps(metadata, fmt=plistlib.FMT_BINARY)
            if name and re.fullmatch(re.escape(root) + r"/[^/]+\.lproj/InfoPlist\.strings", path):
                raw = z.read(item)
                try:
                    localized = plistlib.loads(raw)
                except (plistlib.InvalidFileException, ValueError):
                    out = subprocess.run(["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-"],
                                         input=raw, capture_output=True, timeout=10)
                    if out.returncode:
                        raise ValueError("A localized app name could not be edited.")
                    localized = plistlib.loads(out.stdout)
                localized.update(CFBundleDisplayName=name, CFBundleName=name)
                changes[path] = plistlib.dumps(localized, fmt=plistlib.FMT_BINARY)
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as output:
            for item in z.infolist():
                path = item.filename
                if path in additions or any(path == p or path.startswith(p + "/") for p in removed):
                    continue
                if path in changes:
                    output.writestr(copy(item), changes[path])
                elif item.is_dir():
                    output.writestr(copy(item), b"")
                else:
                    stream = patched.open("rb") if path == executable else z.open(item)
                    with stream, output.open(copy(item), "w", force_zip64=item.file_size >= 2 * GIB - 1) as target:
                        shutil.copyfileobj(stream, target)
            for path, data in additions.items():
                output.writestr(path, data)
            for path, source in component_entries:
                output.write(source, path)


def extract(source, workspace):
    z, root = archive(source)
    with z:
        for item in z.infolist():
            if not item.filename.startswith(root + "/"):
                continue
            dest = workspace / item.filename
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError("This IPA contains symbolic links. Install the signed archive using Xcode.")
            if item.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(item) as stream, dest.open("xb") as output:
                    shutil.copyfileobj(stream, output)
                dest.chmod(0o600 | (mode & 0o111))
    return workspace / root


def adhoc(source, dest, workspace):
    app = extract(source, workspace)
    nested = [p for p in app.rglob("*") if p.suffix in (".app", ".appex", ".framework", ".xpc", ".dylib")]
    for target in sorted(nested, key=lambda p: len(p.parts), reverse=True) + [app]:
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(target)],
                       check=True, capture_output=True, timeout=120)
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as z:
        for p in app.rglob("*"):
            if p.is_file():
                z.write(p, p.relative_to(workspace))


def verify_https(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.port not in (None, 443):
        raise ValueError("Use a public HTTPS link to an IPA.")
    if not all(ipaddress.ip_address(v[4][0]).is_global for v in socket.getaddrinfo(p.hostname, 443)):
        raise ValueError("Use a public HTTPS link to an IPA.")


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        verify_https(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, dest):
    verify_https(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPSRedirect())
    with opener.open(url, timeout=20) as response, dest.open("xb") as out:
        size = 0
        deadline = time.monotonic() + 600
        while chunk := response.read(1024 * 1024):
            if time.monotonic() > deadline:
                raise ValueError("The download took too long.")
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError("The download exceeds 2 GB.")
            out.write(chunk)
    return inspect(dest)


def validate_device(device):
    if not re.fullmatch(r"[a-fA-F0-9-]{36}", device):
        raise ValueError("Choose a device paired in Xcode.")


def install(source, device, workspace):
    validate_device(device)
    app = extract(source, workspace)
    return subprocess.check_output(
        ["/usr/bin/xcrun", "devicectl", "device", "install", "app", "--device", device,
         str(app), "--timeout", "120"], stderr=subprocess.STDOUT, text=True, timeout=130)


def devices(workspace):
    output = workspace / "devices.json"
    subprocess.run(["/usr/bin/xcrun", "devicectl", "list", "devices", "--timeout", "10",
                    "--json-output", str(output)], check=True, capture_output=True, timeout=20)
    all_devices = json.loads(output.read_text())["result"]["devices"]
    result = []
    for item in all_devices:
        connection = item.get("connectionProperties", {})
        hardware = item.get("hardwareProperties", {})
        platform = hardware.get("platform", "")
        if connection.get("pairingState") != "paired" or platform not in ("iOS", "iPadOS", "tvOS"):
            continue
        result.append({"id": item["identifier"], "name": item.get("deviceProperties", {}).get("name") or platform,
                       "platform": platform, "udid": hardware.get("udid") or ""})
    return {"devices": result}


def mac_package(source, workspace):
    if platform.machine() != "arm64":
        raise ValueError("Installing iPhone and iPad IPAs requires an Apple Silicon Mac.")
    z, root = archive(source)
    with z:
        info = plist(z, root + "/Info.plist")
        if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
            raise ValueError("Choose an iPhone or iPad IPA.")
        profile_name = root + "/embedded.mobileprovision"
        if profile_name not in z.namelist() or root + "/_CodeSignature/CodeResources" not in z.namelist():
            raise ValueError("Export a signed IPA from Xcode with this Mac in its provisioning profile.")
        executable = workspace / "app-executable"
        copy_member(z, app_executable(info, root), executable)
        validate_ios_binary(executable, EXECUTABLE)
        profile = workspace / "embedded.mobileprovision"
        copy_member(z, profile_name, profile)
        decoded = plistlib.loads(subprocess.check_output(["/usr/bin/security", "cms", "-D", "-i", str(profile)], timeout=10))
        expiry = decoded.get("ExpirationDate")
        if not isinstance(expiry, datetime) or expiry.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
            raise ValueError("The IPA’s provisioning profile has expired. Export a newly signed IPA.")
        hardware = json.loads(subprocess.check_output(["/usr/sbin/system_profiler", "SPHardwareDataType", "-json"], timeout=10))
        udid = hardware["SPHardwareDataType"][0].get("provisioning_UDID", "").casefold()
        provisioned = {str(device).casefold() for device in decoded.get("ProvisionedDevices", [])}
        if not udid or udid not in provisioned:
            raise ValueError("This Mac is missing from the IPA’s provisioning profile. Register it in Xcode and export the IPA again.")
    return {"log": "IPA prepared for the macOS installer."}


def devicectl_json(arguments, timeout=15):
    result = subprocess.run(["/usr/bin/xcrun", "devicectl", *arguments, "--quiet", "--timeout", str(timeout),
                             "--json-output", "-"], capture_output=True, text=True, timeout=timeout + 5)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Xcode could not reach the device. Connect and unlock it, then try again.")
    return json.loads(result.stdout).get("result", {})


def development_apps(device):
    validate_device(device)
    result = devicectl_json(["device", "info", "apps", "--device", device, "--no-include-default-apps"])
    return [app for app in result.get("apps", [])
            if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{1,154}", str(app.get("bundleIdentifier", "")))
            and app.get("builtByDeveloper") is not False]


def debug_apps(device):
    apps = [{"id": app["bundleIdentifier"], "name": app.get("name") or app["bundleIdentifier"]}
            for app in development_apps(device)]
    return {"apps": sorted(apps, key=lambda app: app["name"].casefold())}


def device_path(url):
    path = urllib.parse.unquote(urllib.parse.urlsplit(url).path)
    return PurePosixPath(path.removeprefix("/private/") if path.startswith("/private/") else path.lstrip("/"))


def running_app_pid(device, app):
    bundle = device_path(app.get("url", ""))
    if bundle.suffix != ".app":
        return None
    processes = devicectl_json(["device", "info", "processes", "--device", device]).get("runningProcesses", [])
    for process in processes:
        executable = device_path(process.get("executable", ""))
        if executable.parent == bundle:
            return process.get("processIdentifier")
    return None


def enable_jit(device, identifier):
    app = next((app for app in development_apps(device) if app["bundleIdentifier"] == identifier), None)
    if app is None:
        raise ValueError("Choose an installed development app that Xcode can debug.")
    pid = running_app_pid(device, app)
    if pid is None:
        try:
            launched = devicectl_json(["device", "process", "launch", "--device", device, "--start-stopped", identifier])
            pid = launched.get("process", {}).get("processIdentifier")
        except ValueError as error:
            if "10004" not in str(error):
                raise ValueError(f"Open the app on the device and try Enable JIT again. {error}") from error
            pid = running_app_pid(device, app)
            if pid is None:
                launched = devicectl_json(["device", "process", "launch", "--device", device, identifier])
                pid = launched.get("process", {}).get("processIdentifier")
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("Xcode did not report the launched app’s process ID. Reopen the app before trying again.")
    detach = f"""import time
for _ in range(48):
    process = lldb.debugger.GetSelectedTarget().GetProcess()
    if process.IsValid() and process.GetProcessID() == {pid} and process.GetState() in (lldb.eStateStopped, lldb.eStateRunning):
        result = process.Detach()
        print("SIDERELAY_DETACHED" if result.Success() else result.GetCString())
        break
    time.sleep(0.25)
else:
    print("The debugger did not confirm attachment to the selected process.")
"""
    try:
        completed = subprocess.run(["/usr/bin/xcrun", "lldb", "--no-lldbinit", "--batch",
                                    "-o", f"device select {device}", "-o", "script lldb.debugger.SetAsync(False)",
                                    "-o", f"device process attach --pid {pid}", "-o", f"script exec({detach!r})"],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=True, timeout=35)
        if "SIDERELAY_DETACHED" not in completed.stdout.splitlines():
            raise subprocess.CalledProcessError(1, "lldb", output=completed.stdout)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        try:
            devicectl_json(["device", "process", "resume", "--device", device, "--pid", str(pid)], timeout=5)
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
        detail = getattr(error, "stdout", None) or ""
        if isinstance(detail, bytes):
            detail = detail.decode(errors="replace")
        detail = "\n".join(line for line in detail.splitlines() if not line.startswith("(lldb)"))
        raise ValueError("Xcode could not complete the JIT debugger session. " + detail.strip()[-1500:]) from error
    return {"log": "The debugger attached and detached. JIT applies to this running app session."}

def jobs(source, job_id=None):
    if not source.exists():
        return {"log": ""}
    uri = source.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        rows = db.execute("""SELECT a.display_name, j.kind, j.status, j.stage, j.progress,
                                   j.started_at, j.finished_at, j.error
                            FROM jobs AS j JOIN apps AS a ON a.id = j.app_id
                            WHERE ? IS NULL OR j.id = ?
                            ORDER BY j.started_at DESC, j.rowid DESC LIMIT 150""", (job_id, job_id))
        lines = []
        for name, kind, status, stage, progress, started, finished, error in rows:
            action = {"refresh": "Refresh", "install": "Install"}.get(kind, "Installation job")
            outcome = {"done": "Succeeded", "failed": "Failed", "running": "Running",
                       "queued": "Queued", "pending": "Pending"}.get(status, "Status unavailable")
            start = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(started)) if started is not None else "Pending"
            lines.append(f"{name}  ·  {action}  ·  {outcome}")
            lines.append(f"  Started: {start}")
            if stage:
                lines.append(f"  {stage}  {progress or 0}%")
            if finished is not None:
                lines.append(f"  Finished: {time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(finished))}")
            if error:
                certificat = re.search(r"Developer error 7460: [^\n\r]+", str(error))
                if certificat:
                    lines.append(f"  {certificat.group(0)}")
                lines.append(f"  {str(error)[:2000]}")
        return {"log": "\n".join(lines)}

def provision(source, args, work):
    import sys
    from ProvisionnementIPA import diagnosis, imported

    options = json.loads(args.options)
    udid = options.get("udid")
    helper = Path(__file__).resolve().parent.parent / "MacOS" / "siderelay-identity"
    if args.action == "preflight":
        return diagnosis(source, udid, work, helper)
    p12 = Path(options["certificate"])
    profiles = [Path(name) for name in options["profiles"]]
    password = sys.stdin.buffer.read(4097)
    if len(password) > 4096:
        raise ValueError("The certificate password is too long.")
    if args.action == "check-imported":
        return imported(source, profiles, p12, password, udid, work, helper)
    dest = Path(args.destination)
    if any(dest.resolve() == item.resolve() for item in (source, p12, *profiles)):
        raise ValueError("Choose a different output file to preserve the input files.")
    with tempfile.TemporaryDirectory(prefix=".SideRelay-", dir=dest.parent) as folder:
        staged = Path(folder) / "signed.ipa"
        result = imported(source, profiles, p12, password, udid, work, helper, staged)
        if result["ready"]:
            os.replace(staged, dest)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "export", "adhoc", "download", "install", "jobs", "devices",
                                           "mac-package", "debug-apps", "jit", "preflight",
                                           "check-imported", "sign-imported"])
    parser.add_argument("source")
    parser.add_argument("destination", nargs="?")
    parser.add_argument("--options", default="{}")
    parser.add_argument("--scratch")
    parser.add_argument("--job")
    args = parser.parse_args()
    source = Path(args.source)
    if args.action == "inspect":
        result = inspect(source)
    elif args.action == "jobs":
        result = jobs(source, args.job)
    elif args.action == "debug-apps":
        result = debug_apps(args.source)
    elif args.action == "jit":
        result = enable_jit(args.source, args.destination)
    else:
        with tempfile.TemporaryDirectory(prefix="SideRelay-", dir=args.scratch) as tmp:
            work = Path(tmp)
            if args.action in ("preflight", "check-imported", "sign-imported"):
                result = provision(source, args, work)
            elif args.action == "install":
                result = {"log": install(source, args.destination, work)}
            elif args.action == "devices":
                result = devices(work)
            elif args.action == "mac-package":
                result = mac_package(source, work)
            else:
                dest = Path(args.destination)
                if dest.resolve() == source.resolve() and args.action != "download":
                    raise ValueError("Choose a different output file to keep the original IPA.")
                # Stage the replacement next to its destination, so a failed write leaves the prior file intact.
                with tempfile.TemporaryDirectory(prefix=".SideRelay-", dir=dest.parent) as stage:
                    staged = Path(stage) / "prepared.ipa"
                    options = json.loads(args.options)
                    if args.action == "download":
                        result = download(args.source, staged)
                    elif args.action == "export":
                        modified_ipa(source, staged, options, work)
                        result = inspect(staged)
                    else:
                        prepared = work / "prepared.ipa"
                        modified_ipa(source, prepared, options, work)
                        adhoc(prepared, staged, work)
                        result = inspect(staged)
                    os.replace(staged, dest)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        output = error.stdout or error.stderr or "The tool could not complete the operation."
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        print(json.dumps({"error": output.strip()[:6000]}))
        raise SystemExit(1)
    except (ValueError, OSError, RuntimeError, TypeError, KeyError, zipfile.BadZipFile, plistlib.InvalidFileException,
            subprocess.TimeoutExpired, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)[:6000]}))
        raise SystemExit(1)
