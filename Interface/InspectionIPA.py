"""Package a local iOS device build and inspect archives without extracting them."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import zipfile

from .ComposantsIPA import EXECUTABLE, validate_ios_binary


PLIST_LIMIT = 2 * 1024 * 1024
ASSET_CATALOGUE_LIMIT = 64 * 1024 * 1024
PNG_HEADER = b"\x89PNG\r\n\x1a\n"


def package_build(source, output):
    selected = Path(source)
    if selected.suffix.lower() != ".app" or selected.is_symlink() or not selected.is_dir():
        raise ValueError("Choose an Xcode .app built for a physical iPhone or iPad.")
    app = selected.resolve(strict=True)
    info = app / "Info.plist"
    if info.is_symlink() or not info.is_file() or info.stat().st_size > PLIST_LIMIT:
        raise ValueError("This build has no readable Info.plist.")
    metadata = plistlib.loads(info.read_bytes())
    platforms = metadata.get("CFBundleSupportedPlatforms", []) if isinstance(metadata, dict) else []
    if not isinstance(platforms, list) or "iPhoneOS" not in platforms:
        raise ValueError("Build for a physical iPhone or iPad in Xcode. Simulator and Mac builds are not supported.")
    name = metadata.get("CFBundleExecutable")
    if not isinstance(name, str) or Path(name).name != name or name in ("", ".", ".."):
        raise ValueError("This build has no valid main executable.")
    executable = app / name
    if executable.is_symlink() or not executable.is_file():
        raise ValueError("This build has no main executable.")
    validate_ios_binary(executable, EXECUTABLE)

    entries = 0
    total = 0
    if "\\" in app.name or any(ord(c) < 32 for c in app.name):
        raise ValueError("This build has an unsupported name.")
    prefix = PurePosixPath("Payload", app.stem + ".app")
    seen = set()
    def walk_error(error):
        raise error

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for folder, directories, files in os.walk(app, followlinks=False, onerror=walk_error):
            directories.sort()
            for entry in sorted(directories + files):
                local = Path(folder) / entry
                relative = local.relative_to(app)
                if any("\\" in part or any(ord(c) < 32 for c in part) for part in relative.parts):
                    raise ValueError("This build contains an unsupported file name.")
                archived = (prefix / relative.as_posix()).as_posix()
                key = archived.casefold()
                if key in seen:
                    raise ValueError("This build contains duplicate file names.")
                seen.add(key)
                details = local.lstat()
                entries += 1
                total += details.st_size
                if entries > 100_000 or total > 4 * 1024**3:
                    raise ValueError("This build is too large to import.")
                if stat.S_ISLNK(details.st_mode):
                    if entry in directories:
                        directories.remove(entry)
                    target = os.readlink(local)
                    if Path(target).is_absolute() or not local.resolve(strict=True).is_relative_to(app):
                        raise ValueError("This build contains a link outside the app.")
                    link = zipfile.ZipInfo(archived)
                    link.create_system = 3
                    link.external_attr = details.st_mode << 16
                    archive.writestr(link, target)
                elif stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode):
                    archive.write(local, archived)
                else:
                    raise ValueError("This build contains an unsupported file type.")


def package_path(db, root, package_id):
    row = db.execute("SELECT path FROM ipa_packages WHERE id = ?", (package_id,)).fetchone()
    if row is None:
        raise ValueError("This IPA is no longer in the library.")
    path = (root / row[0]).resolve(strict=True)
    if not path.is_relative_to((root / "ipas").resolve()):
        raise ValueError("This IPA is outside the library.")
    return path


def main_info(archive):
    candidates = [item for item in archive.infolist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", item.filename)]
    if len(candidates) != 1 or candidates[0].file_size > PLIST_LIMIT:
        raise ValueError("This IPA has no readable main Info.plist.")
    info = candidates[0]
    metadata = plistlib.loads(archive.read(info))
    if not isinstance(metadata, dict):
        raise ValueError("This IPA has an invalid Info.plist.")
    return info.filename.removesuffix("Info.plist"), metadata


def icon_names(metadata):
    for key in ("CFBundleIcons", "CFBundleIcons~ipad"):
        icons = metadata.get(key)
        primary = icons.get("CFBundlePrimaryIcon") if isinstance(icons, dict) else None
        if isinstance(primary, dict):
            files = primary.get("CFBundleIconFiles")
            if isinstance(files, list):
                yield from files
            yield primary.get("CFBundleIconName")
    if isinstance(metadata.get("CFBundleIconFiles"), list):
        yield from metadata["CFBundleIconFiles"]
    yield metadata.get("CFBundleIconFile")


def icon_preview(db, root, package_id, workspace):
    return (archive_icon_preview(package_path(db, root, package_id), workspace)
            or tvos_icon_fallback(db, root, package_id, workspace))


def tvos_icon_fallback(db, root, package_id, workspace):
    candidates = db.execute("""
        SELECT newer.id
        FROM ipa_packages original
        JOIN ipa_packages newer ON newer.bundle_id = original.bundle_id
        WHERE original.id = ? AND newer.id != original.id AND newer.removed_at IS NULL
          AND newer.imported_at >= original.imported_at
          AND 'AppleTVOS' IN (SELECT value FROM json_each(original.metadata, '$.platforms'))
          AND 'AppleTVOS' IN (SELECT value FROM json_each(newer.metadata, '$.platforms'))
        ORDER BY newer.imported_at DESC
        LIMIT 4
    """, (package_id,))
    for (candidate_id,) in candidates:
        try:
            if image := archive_icon_preview(package_path(db, root, candidate_id), workspace):
                return image
        except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError):
            continue
    return None


def icon_rank(filename, metadata):
    match = re.fullmatch(r"([^/@~]+?)(?:@([1-3])x)?(?:~(iphone|ipad))?\.png", filename.lower())
    if not match:
        return None
    stem, scale, device = match.groups()
    names = list(dict.fromkeys(
        re.sub(r"(?:@[1-3]x)?(?:~(?:iphone|ipad))?$", "", name.lower().removesuffix(".png"))
        for name in icon_names(metadata) if isinstance(name, str) and name and "/" not in name
    ))
    if stem in names:
        rank = names.index(stem)
    elif re.fullmatch(r"(?:app)?icon(?:\d+(?:\.\d+)?x\d+(?:\.\d+)?)?", stem):
        rank = len(names)
    else:
        return None
    return device == "ipad", rank, -int(scale or 1)


def png_icon_preview(data, workspace):
    position = 24 if data[12:16] == b"CgBI" else 8
    if len(data) < position + 16 or not data.startswith(PNG_HEADER) or \
            data[position:position + 8] != b"\x00\x00\x00\rIHDR":
        return None
    width, height = struct.unpack_from(">II", data, position + 8)
    if not 0 < width <= 2048 or width != height:
        return None
    if not os.path.isfile("/usr/bin/sips"):
        from io import BytesIO
        from PIL import Image

        try:
            with Image.open(BytesIO(data), formats=["PNG"]) as icon:
                icon.thumbnail((96, 96))
                output = BytesIO()
                icon.convert("RGBA").save(output, format="PNG")
                return output.getvalue()
        except OSError:
            return None
    source = workspace / "source.png"
    png = workspace / "preview.png"
    source.write_bytes(data)
    result = subprocess.run(["/usr/bin/sips", "-s", "format", "png", "-Z", "96", str(source), "--out", str(png)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    if result.returncode == 0 and png.is_file():
        return png.read_bytes()
    return None


def tv_icon_preview(archive, prefix, metadata, workspace):
    icons = metadata.get("CFBundleIcons")
    name = icons.get("CFBundlePrimaryIcon") if isinstance(icons, dict) else None
    if isinstance(name, dict):
        name = name.get("CFBundleIconName")
    if not isinstance(name, str) or not 0 < len(name) <= 255 or not name.isprintable():
        return None

    identity_helper = os.environ.get("SIDERELAY_IDENTITY_HELPER")
    executable_dir = (Path(identity_helper).parent if identity_helper else
                      Path(__file__).resolve().parents[1] / "SideRelay.app/Contents/MacOS")
    helper = executable_dir / "siderelay-tv-icon"
    if not os.access(helper, os.X_OK):
        return None

    try:
        entry = archive.getinfo(prefix + "Assets.car")
        if not 0 < entry.file_size <= ASSET_CATALOGUE_LIMIT or stat.S_ISLNK(entry.external_attr >> 16):
            return None
        path = workspace / "Assets.car"
        with archive.open(entry) as source, path.open("wb") as output:
            shutil.copyfileobj(source, output)
        result = subprocess.run([str(helper), str(path), name], capture_output=True, timeout=5)
    except (KeyError, OSError, subprocess.SubprocessError):
        return None
    if result.returncode == 0 and result.stdout.startswith(PNG_HEADER):
        return result.stdout
    return None


def archive_icon_preview(path, workspace):
    with zipfile.ZipFile(path) as archive:
        prefix, metadata = main_info(archive)
        candidates = []
        for info in archive.infolist():
            if not info.filename.startswith(prefix) or not 0 < info.file_size <= 2 * 1024 * 1024:
                continue
            filename = info.filename[len(prefix):]
            rank = icon_rank(filename, metadata)
            if rank is not None and not stat.S_ISLNK(info.external_attr >> 16):
                candidates.append((rank, info))
        for _, info in sorted(candidates, key=lambda item: item[0])[:8]:
            if image := png_icon_preview(archive.read(info), workspace):
                return image
        platforms = metadata.get("CFBundleSupportedPlatforms")
        if isinstance(platforms, list) and "AppleTVOS" in platforms:
            return tv_icon_preview(archive, prefix, metadata, workspace)
    return None

def inspect_package(db, root, package_id):
    with zipfile.ZipFile(package_path(db, root, package_id)) as archive:
        prefix, metadata = main_info(archive)
        infos = archive.infolist()
        groups = {}
        for item in sorted(infos, key=lambda entry: entry.filename):
            if item.is_dir() or not item.filename.startswith(prefix):
                continue
            name = item.filename[len(prefix):]
            parts = name.split("/")
            if "_CodeSignature" in parts:
                continue
            components = [("/".join(parts[:i + 1]), "Framework", "/".join(parts[i + 1:]))
                          for i, part in enumerate(parts[:-1]) if part.lower().endswith(".framework")]
            if parts[-1].lower().endswith(".dylib"):
                components.append((name, "Dynamic Library", ""))
            for component, kind, member in components:
                group = groups.setdefault(component, [kind, 0, hashlib.sha256()])
                group[1] += item.file_size
                # ZIP checksums let us compare archived contents without extracting executable code.
                group[2].update(f"{member}\0{item.CRC:08x}\0{item.file_size}\n".encode("utf-8"))
        return {
            "components": [{"path": path, "kind": kind, "size": size, "digest": digest.hexdigest()}
                           for path, (kind, size, digest) in sorted(groups.items())],
            "plist": plistlib.dumps(metadata, sort_keys=True).decode("utf-8"),
            "keys": {key: hashlib.sha256(plistlib.dumps({"value": value}, sort_keys=True)).hexdigest()
                     for key, value in metadata.items()},
        }
