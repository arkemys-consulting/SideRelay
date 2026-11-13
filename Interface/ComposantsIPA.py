"""Link local iOS libraries into a development IPA before signing it."""
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import struct
import tarfile


ARM64 = 0x0100000C
EXECUTABLE, DYLIB = 2, 6
MAX_COMPONENTS_SIZE = 512 * 1024 * 1024
COMPONENTS = {".dylib", ".framework", ".bundle"}


def read_at(file, offset, size):
    file.seek(offset)
    data = file.read(size)
    if len(data) != size:
        raise ValueError("The Mach-O executable is incomplete.")
    return data


def slices(file):
    size = os.fstat(file.fileno()).st_size
    magic = read_at(file, 0, 4)
    if magic == b"\xcf\xfa\xed\xfe":
        return [(0, size)]
    formats = {b"\xca\xfe\xba\xbe": ">IIIII", b"\xca\xfe\xba\xbf": ">IIQQII"}
    fmt = formats.get(magic)
    if not fmt:
        raise ValueError("Choose a native ARM64 iPhone or iPad binary.")
    count, = struct.unpack(">I", read_at(file, 4, 4))
    entry_size = struct.calcsize(fmt)
    table_end = 8 + count * entry_size
    if count not in range(1, 65) or table_end > size:
        raise ValueError("The Mach-O architecture table is invalid.")
    images, ranges = [], []
    for i in range(count):
        cpu, _, start, length, *_ = struct.unpack(fmt, read_at(file, 8 + i * entry_size, entry_size))
        if start < table_end or length == 0 or start + length > size:
            raise ValueError("The Mach-O slice lies outside its file.")
        ranges.append((start, length))
        if cpu == ARM64:
            images.append((start, length))
    ranges.sort()
    if not images or any(a + size_a > b for (a, size_a), (b, _) in zip(ranges, ranges[1:])):
        raise ValueError("The Mach-O does not contain distinct ARM64 slices.")
    return images


def ios_header(file, start, length, kind):
    if length < 32:
        raise ValueError("The Mach-O header is incomplete.")
    header = struct.unpack("<8I", read_at(file, start, 32))
    magic, cpu, _, filetype, count, size, *_ = header
    if (magic, cpu, filetype) != (0xFEEDFACF, ARM64, kind):
        raise ValueError("Choose an ARM64 iOS executable or dynamic library.")
    if length < 32 + size or size > 16 * 1024 * 1024 or count > size // 8:
        raise ValueError("The Mach-O load commands are invalid.")
    commands = read_at(file, start + 32, size)
    cursor = 0
    content = length
    platform = None
    for _ in range(count):
        if cursor + 8 > size:
            raise ValueError("A Mach-O load command is truncated.")
        cmd, width = struct.unpack_from("<II", commands, cursor)
        if width < 8 or width % 8 or cursor + width > size:
            raise ValueError("A Mach-O load command has an invalid size.")
        if cmd in (0x21, 0x2C) and width >= 20 and struct.unpack_from("<I", commands, cursor + 16)[0]:
            raise ValueError("Use an unencrypted development build of the IPA.")
        if cmd == 0x32 and width >= 24:
            platform, = struct.unpack_from("<I", commands, cursor + 8)
        if cmd == 0x25 and platform is None:
            platform = 2
        if cmd == 0x19:
            if width < 72:
                raise ValueError("A Mach-O segment is incomplete.")
            offset, filesize = struct.unpack_from("<QQ", commands, cursor + 40)
            sections, = struct.unpack_from("<I", commands, cursor + 64)
            if 72 + sections * 80 > width:
                raise ValueError("The Mach-O section table is incomplete.")
            if offset and filesize:
                content = min(content, offset)
            for section in range(sections):
                section_offset, = struct.unpack_from("<I", commands, cursor + 72 + section * 80 + 48)
                if section_offset:
                    content = min(content, section_offset)
        cursor += width
    if platform != 2 or cursor != size or content < 32 + size:
        raise ValueError("The Mach-O is not a supported physical iOS binary.")
    return count, size, content


def link_libraries(executable, library_names):
    commands = bytearray()
    for name in library_names:
        string = f"@executable_path/Frameworks/{name}".encode() + b"\0"
        width = (24 + len(string) + 7) & ~7
        commands += struct.pack("<6I", 0xC, width, 24, 0, 0, 0) + string.ljust(width - 24, b"\0")
    with executable.open("r+b") as file:
        edits = []
        for start, length in slices(file):
            count, size, content = ios_header(file, start, length, EXECUTABLE)
            position = start + 32 + size
            if 32 + size + len(commands) > content or any(read_at(file, position, len(commands))):
                raise ValueError("This executable has no room for the selected libraries. Export a development build with linker header padding.")
            edits.append((start, position, count, size))
        for start, position, count, size in edits:
            file.seek(start + 16)
            file.write(struct.pack("<II", count + len(library_names), size + len(commands)))
            file.seek(position)
            file.write(commands)


def validate_ios_binary(path, kind):
    with path.open("rb") as file:
        for start, length in slices(file):
            ios_header(file, start, length, kind)


def deb_data(source, workspace):
    if source.stat().st_size > MAX_COMPONENTS_SIZE:
        raise ValueError("The Debian package is too large.")
    data = None
    with source.open("rb") as archive:
        if archive.read(8) != b"!<arch>\n":
            raise ValueError("The Debian package is not an ar archive.")
        size = os.fstat(archive.fileno()).st_size
        while header := archive.read(60):
            if len(header) != 60 or header[-2:] != b"`\n":
                raise ValueError("The Debian package has an invalid member header.")
            length = int(header[48:58])
            start = archive.tell()
            end = start + length + length % 2
            if length < 0 or end > size:
                raise ValueError("The Debian package contains an incomplete member.")
            name = header[:16].rstrip(b" /")
            if re.fullmatch(rb"data\.tar(?:\.(?:gz|bz2|xz|zst))?", name):
                if data is not None:
                    raise ValueError("Choose a Debian package with one data archive.")
                data = workspace / name.decode("ascii")
                with data.open("xb") as out:
                    remaining = length
                    while remaining:
                        chunk = archive.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("The Debian package data archive is incomplete.")
                        out.write(chunk)
                        remaining -= len(chunk)
            archive.seek(end)
    if data is None:
        raise ValueError("Choose a Debian package with one data archive.")
    return data


def deb_components(source, workspace):
    data = deb_data(source, workspace)
    roots = {}
    expanded = 0
    try:
        with tarfile.open(data, mode="r|*") as archive:
            for index, entry in enumerate(archive):
                path = PurePosixPath(entry.name)
                expanded += entry.size
                if index >= 20_000 or expanded > MAX_COMPONENTS_SIZE:
                    raise ValueError("The expanded Debian package is too large.")
                if path.is_absolute() or ".." in path.parts or "\\" in entry.name:
                    raise ValueError("The Debian package contains an invalid path.")
                parts = path.parts
                component = next((i for i, p in enumerate(parts) if Path(p).suffix.lower() in COMPONENTS), None)
                if component is None:
                    continue
                prefix = parts[:component + 1]
                root = roots.setdefault(prefix, workspace / f"part-{len(roots)}" / prefix[-1])
                target = root.joinpath(*parts[component + 1:])
                if entry.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif entry.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry) as incoming, target.open("xb") as out:
                        shutil.copyfileobj(incoming, out)
                    target.chmod(0o600 | (entry.mode & 0o111))
                else:
                    raise ValueError("A selected Debian component contains a link or a special file.")
    except tarfile.TarError as error:
        raise ValueError("Could not read the Debian data archive with this Python installation.") from error
    if not roots:
        raise ValueError("The Debian package contains no iOS library, framework or resource bundle.")
    return list(roots.values())


def component_files(source):
    suffix = source.suffix.lower()
    if source.is_symlink() or suffix not in COMPONENTS:
        raise ValueError("Choose an iOS dylib, framework, resource bundle or Debian package.")
    if suffix == ".dylib" and source.is_file():
        validate_ios_binary(source, DYLIB)
        return [(f"Frameworks/{source.name}", source)], source.name
    if not source.is_dir() or suffix == ".dylib":
        raise ValueError("Frameworks and resource bundles must be directories.")
    meta = source / "Info.plist"
    entries = []
    folder = "Frameworks/" if suffix == ".framework" else ""
    for path in source.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("Components must contain regular files and directories.")
        if path.is_file():
            entries.append((folder + source.name + "/" + path.relative_to(source).as_posix(), path))
    if not entries:
        raise ValueError("The component is empty.")
    info = plistlib.loads(meta.read_bytes()) if meta.is_file() and meta.stat().st_size <= 4 * 1024 * 1024 else {}
    executable = info.get("CFBundleExecutable")
    if suffix == ".bundle":
        if executable:
            raise ValueError("Choose a resource-only bundle. Use an iOS framework for executable code.")
        return entries, None
    if not isinstance(executable, str) or not re.fullmatch(r"[A-Za-z0-9_+.-]+", executable) or executable in (".", ".."):
        raise ValueError("The framework must have a valid CFBundleExecutable.")
    validate_ios_binary(source / executable, DYLIB)
    return entries, f"{source.name}/{executable}"


def prepare_components(selected, workspace):
    if not isinstance(selected, list) or len(selected) > 32:
        raise ValueError("Choose up to 32 iOS components.")
    entries, names = [], []
    added, size = set(), 0
    for i, value in enumerate(selected):
        path = Path(value)
        sources = [path]
        if path.suffix.lower() == ".deb" and path.is_file() and not path.is_symlink():
            folder = workspace / f"deb-{i}"
            folder.mkdir()
            sources = deb_components(path, folder)
        for source in sources:
            if not re.fullmatch(r"[A-Za-z0-9_.+-]+", source.name):
                raise ValueError("Use component filenames containing only letters, numbers, dots, underscores, plus signs or hyphens.")
            key = source.name.casefold()
            if key in added:
                raise ValueError("Two selected components have the same name.")
            added.add(key)
            files, library = component_files(source)
            size += sum(path.stat().st_size for _, path in files)
            if len(entries) + len(files) > 20_000 or size > MAX_COMPONENTS_SIZE:
                raise ValueError("The selected components are too large.")
            entries.extend(files)
            if library:
                names.append(library)
    return entries, names
