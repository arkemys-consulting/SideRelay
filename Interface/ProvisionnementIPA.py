"""Check iOS provisioning profiles and sign a copy with an imported identity."""
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import zipfile

if __package__:
    from . import ArchiveIPA as ipa
else:
    import ArchiveIPA as ipa

PROFILE_LIMIT = 4 * 1024 * 1024
EXECUTABLE_LIMIT = 512 * 1024 * 1024
APP_ID = "application-identifier"
TEAM_ID = "com.apple.developer.team-identifier"
KEYCHAIN_GROUPS = "keychain-access-groups"
CODE_SIGN = "/usr/bin/codesign"
PLATFORMS_IOS = {"iPhoneOS", "iOS"}
CAPABILITY_NAMES = {
    "aps-environment": "Push Notifications",
    "com.apple.developer.applesignin": "Sign in with Apple",
    "com.apple.developer.associated-domains": "Associated Domains",
    "com.apple.security.application-groups": "App Groups",
    KEYCHAIN_GROUPS: "Keychain Sharing",
}


@dataclass
class Bundle:
    path: str
    identifier: str
    executable: str
    platform: str


@dataclass
class Profile:
    path: Path
    payload: dict
    entitlements: dict
    identifier: str
    expires: datetime

    @property
    def prefix(self):
        return self.identifier.split(".", 1)[0]

    @property
    def pattern(self):
        return self.identifier.split(".", 1)[1]


def tool(helper, command, *args, password=None):
    result = subprocess.run([str(helper), command, *map(str, args)], input=password or b"",
                            capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace")[:450] or "The local signing tool could not complete the check.")
    return result.stdout


def bundles(archive, root):
    members = set(archive.namelist())
    paths = [root] + sorted({name.removesuffix("/Info.plist") for name in members
                             if name != root + "/Info.plist" and name.startswith(root + "/")
                             and name.endswith((".app/Info.plist", ".appex/Info.plist"))})
    if len(paths) > 40:
        raise ValueError("This IPA contains more than 40 app and extension bundles.")
    found = []
    for path in paths:
        info = ipa.plist(archive, path + "/Info.plist")
        identifier = info.get("CFBundleIdentifier", "")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*", identifier):
            raise ValueError(f"{Path(path).name} has an invalid bundle identifier.")
        platform = (info.get("CFBundleSupportedPlatforms") or [""])[0]
        if platform and platform not in PLATFORMS_IOS:
            raise ValueError(f"{identifier} is built for {platform}. This check supports iPhone and iPad builds.")
        executable = ipa.app_executable(info, path)
        if executable not in members or archive.getinfo(executable).file_size > EXECUTABLE_LIMIT:
            raise ValueError(f"{identifier} has a missing or oversized executable.")
        found.append(Bundle(path, identifier, executable, platform))
    if len({item.identifier for item in found}) != len(found):
        raise ValueError("The app and extensions must have distinct bundle identifiers.")
    return found


def read_profile(helper, path):
    if path.stat().st_size == 0 or path.stat().st_size > PROFILE_LIMIT:
        raise ValueError("The provisioning profile is empty or too large.")
    if helper is None:
        result = subprocess.run(["openssl", "cms", "-verify", "-binary", "-inform", "DER", "-noverify", "-in", str(path)],
                                capture_output=True, timeout=10)
        if result.returncode:
            raise ValueError("The embedded provisioning profile could not be read.")
        payload = plistlib.loads(result.stdout)
    else:
        payload = plistlib.loads(tool(helper, "profile", path))
    if not isinstance(payload, dict):
        raise ValueError("The provisioning profile is unreadable.")
    entitlements = payload.get("Entitlements")
    expires = payload.get("ExpirationDate")
    identifier = entitlements.get(APP_ID, "") if isinstance(entitlements, dict) else ""
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Z0-9]+\.(?:[A-Za-z0-9-]+\.)*(?:[A-Za-z0-9-]+|\*)", identifier) or not isinstance(expires, datetime):
        raise ValueError("The provisioning profile is missing its App ID or expiry date.")
    return Profile(path, payload, entitlements, identifier, expires.replace(tzinfo=timezone.utc))


def signature(executable, cert_dir=None):
    result = subprocess.run([CODE_SIGN, "-d", "--entitlements", "-", "--xml", str(executable)],
                            capture_output=True, timeout=25)
    if result.returncode:
        return None, None
    entitlements = plistlib.loads(result.stdout) if result.stdout else {}
    certificate = None
    if cert_dir is not None:
        prefix = cert_dir / "signing-cert-"
        subprocess.run([CODE_SIGN, "-d", f"--extract-certificates={prefix}", str(executable)],
                       capture_output=True, timeout=25)
        leaf = cert_dir / "signing-cert-0"
        if leaf.is_file():
            certificate = leaf.read_bytes()
    return entitlements, certificate


def within_pattern(value, pattern):
    if not isinstance(value, str) or not isinstance(pattern, str):
        return False
    return value == pattern or (pattern.endswith("*") and "*" not in pattern[:-1] and value.startswith(pattern[:-1]))


def permitted(value, allowed):
    if isinstance(value, list) and isinstance(allowed, list):
        return all(any(permitted(item, choice) for choice in allowed) for item in value)
    if isinstance(value, dict) and isinstance(allowed, dict):
        return all(key in allowed and permitted(item, allowed[key]) for key, item in value.items())
    if isinstance(value, str):
        if isinstance(allowed, list):
            return any(within_pattern(value, item) for item in allowed)
        return within_pattern(value, allowed)
    return type(value) is type(allowed) and value == allowed


def normalized_udid(value):
    return value.replace("-", "").lower() if isinstance(value, str) else ""


def validity_dates(cert):
    result = subprocess.run(["/usr/bin/openssl", "x509", "-inform", "DER", "-noout", "-dates"],
                            input=cert, capture_output=True, check=True, timeout=10)
    dates = {}
    for line in result.stdout.decode("ascii").splitlines():
        key, value = line.split("=", 1)
        dates[key] = datetime.strptime(value, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return dates["notBefore"], dates["notAfter"]


def checks(profile, bundle, udid, cert, requested, now, *, resign=False, check_signature=True):
    issues = []
    team = profile.entitlements.get(TEAM_ID)
    if not isinstance(team, str) or team not in profile.payload.get("TeamIdentifier", []):
        issues.append("The profile has no matching Apple Team ID.")
    if not within_pattern(bundle.identifier, profile.pattern):
        issues.append(f"The profile App ID {profile.identifier} does not cover this bundle.")
    if not set(profile.payload.get("Platform") or []).intersection(PLATFORMS_IOS):
        issues.append("The profile is not for iPhone or iPad.")
    if profile.expires <= now:
        issues.append(f"The profile expired on {profile.expires:%Y-%m-%d %H:%M} UTC.")
    devices = profile.payload.get("ProvisionedDevices") or []
    if not devices:
        issues.append("The profile has no registered devices. Choose a development or ad hoc profile.")
    elif udid and normalized_udid(udid) not in {normalized_udid(value) for value in devices}:
        issues.append("The selected iPhone or iPad is missing from the profile.")
    if cert is None and check_signature:
        issues.append("The executable has no certificate-backed signature.")
    elif cert is not None and cert not in profile.payload.get("DeveloperCertificates", []):
        issues.append("The signing certificate is not listed in this profile.")
    if cert is not None:
        start, end = validity_dates(cert)
        if end <= now:
            issues.append(f"The signing certificate expired on {end:%Y-%m-%d %H:%M} UTC.")
        elif start > now:
            issues.append("The signing certificate is not yet valid.")

    effective = dict(requested or {})
    expected_id = profile.prefix + "." + bundle.identifier
    if resign:
        previous = effective.get(APP_ID)
        groups = effective.get(KEYCHAIN_GROUPS)
        if isinstance(previous, str) and isinstance(groups, list):
            effective[KEYCHAIN_GROUPS] = [expected_id if group == previous else group for group in groups]
        effective[APP_ID] = expected_id
        effective[TEAM_ID] = team
        if effective.get("get-task-allow") is True and profile.entitlements.get("get-task-allow") is not True:
            effective.pop("get-task-allow")
        effective.pop("beta-reports-active", None)
    elif requested is not None:
        if effective.get(APP_ID) != expected_id:
            issues.append("The signed application identifier does not match the bundle and profile.")
        if effective.get(TEAM_ID) != team:
            issues.append("The signed Team ID does not match the profile.")

    for name, value in sorted(effective.items()):
        if value is False and name == "get-task-allow":
            continue
        if name not in profile.entitlements or not permitted(value, profile.entitlements[name]):
            label = CAPABILITY_NAMES.get(name)
            if name.startswith("com.apple.developer.icloud") or name.startswith("com.apple.developer.ubiquity"):
                label = "iCloud"
            capability = f"{label} ({name})" if label else name
            issues.append(f"Capability not authorized by the profile: {capability}.")
    return issues, effective


def report_row(bundle, profile, errors, warnings=()):
    return {"bundle": bundle.identifier, "profile": profile.payload.get("Name") if profile else None,
            "expires": profile.expires.isoformat() if profile else None, "errors": errors, "warnings": list(warnings)}


def diagnosis(source, udid, work, helper):
    now = datetime.now(timezone.utc)
    archive, root = ipa.archive(source)
    rows = []
    with archive:
        for index, bundle in enumerate(bundles(archive, root)):
            folder = work / str(index)
            folder.mkdir()
            member = bundle.path + "/embedded.mobileprovision"
            if member not in archive.namelist():
                rows.append(report_row(bundle, None, ["No provisioning profile is embedded. Sign this IPA before installing."]))
                continue
            if archive.getinfo(member).file_size > PROFILE_LIMIT:
                rows.append(report_row(bundle, None, ["The embedded provisioning profile is too large."]))
                continue
            local = folder / "embedded.mobileprovision"
            ipa.copy_member(archive, member, local)
            try:
                profile = read_profile(helper, local)
                if helper is None:
                    errors, _ = checks(profile, bundle, udid, None, None, now, check_signature=False)
                    warnings = ["The executable signature and the profile’s Apple trust chain require macOS verification."]
                else:
                    exe = folder / "executable"
                    ipa.copy_member(archive, bundle.executable, exe)
                    requested, cert = signature(exe, folder)
                    errors, _ = checks(profile, bundle, udid, cert, requested, now)
                    warnings = [] if requested is not None else ["Could not read the executable’s signed capabilities."]
                rows.append(report_row(bundle, profile, errors, warnings))
            except (ValueError, plistlib.InvalidFileException) as error:
                rows.append(report_row(bundle, None, [str(error)]))
    return {"components": rows, "ready": bool(udid) and not any(row["errors"] for row in rows),
            "profileOnly": helper is None}


def imported(source, profile_files, p12, password, udid, work, helper, destination=None):
    if not normalized_udid(udid):
        raise ValueError("Select the iPhone or iPad that will receive this IPA.")
    if not 1 <= len(profile_files) <= 40 or p12.stat().st_size > PROFILE_LIMIT:
        raise ValueError("Choose a .p12 and up to 40 provisioning profiles.")
    identity_path = work / "identity.p12"
    shutil.copyfile(p12, identity_path)
    cert = tool(helper, "identity", identity_path, password=password)
    profiles = []
    for index, original in enumerate(profile_files):
        if original.stat().st_size > PROFILE_LIMIT:
            raise ValueError(f"{original.name}: the profile is too large.")
        path = work / f"profile-{index}.mobileprovision"
        shutil.copyfile(original, path)
        try:
            profiles.append(read_profile(helper, path))
        except (ValueError, plistlib.InvalidFileException) as error:
            raise ValueError(f"{original.name}: {error}") from error

    now = datetime.now(timezone.utc)
    archive, root = ipa.archive(source)
    with archive:
        packages = bundles(archive, root)
    app = ipa.extract(source, work)
    selected, rows = [], []
    for bundle in packages:
        executable = work / bundle.executable
        try:
            ipa.validate_ios_binary(executable, ipa.EXECUTABLE)
        except ValueError as error:
            rows.append(report_row(bundle, None, [str(error)]))
            continue
        executable.chmod(executable.stat().st_mode | 0o100)
        requested, _ = signature(executable)
        candidates = [p for p in profiles if within_pattern(bundle.identifier, p.pattern)]
        warnings = []
        if requested is None:
            warnings.append("The source has no readable signed capabilities. The export will use standard app identifiers.")
        if not candidates:
            rows.append(report_row(bundle, None, ["None of the selected profiles covers this bundle ID."], warnings))
            continue
        ranked = [(profile, *checks(profile, bundle, udid, cert, requested, now, resign=True)) for profile in candidates]
        profile, errors, effective = min(ranked, key=lambda item: (len(item[1]), item[0].pattern.endswith("*"),
                                                                   -item[0].expires.timestamp(), str(item[0].path)))
        selected.append((bundle, profile, effective))
        rows.append(report_row(bundle, profile, errors, warnings))

    if len({profile.entitlements.get(TEAM_ID) for _, profile, _ in selected}) > 1:
        for row in rows:
            row["errors"].append("The app and all its extensions must use the same Apple Team ID.")
    ready = not any(row["errors"] for row in rows)
    result = {"components": rows, "ready": ready}
    if destination is None or not ready:
        return result

    sign_copy(app, work, helper, identity_path, password, cert, selected, destination)
    return result


def sign_copy(app, work, helper, identity_path, password, cert, selected, destination):
    import hashlib

    keychain = work / "identity.keychain-db"
    try:
        imported_certificate = tool(helper, "keychain", identity_path, keychain, password=password)
        if imported_certificate != cert:
            raise ValueError("The imported signing identity changed.")
        sha1 = hashlib.sha1(cert).hexdigest().upper()
        identities = subprocess.run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", str(keychain)],
                                    check=True, capture_output=True, timeout=15)
        if sha1.encode() not in identities.stdout.upper():
            raise ValueError("macOS does not recognize this certificate and private key as a valid code signing identity.")
        authorizations = {}
        for index, (bundle, profile, effective) in enumerate(selected):
            target = work / bundle.path
            profile_path = target / "embedded.mobileprovision"
            shutil.copyfile(profile.path, profile_path)
            entitlements = work / f"entitlements-{index}.plist"
            entitlements.write_bytes(plistlib.dumps(effective))
            authorizations[target] = entitlements

        nested = [p for p in app.rglob("*") if p.suffix in (".app", ".appex", ".framework", ".xpc", ".dylib")]
        for target in sorted(nested, key=lambda p: len(p.parts), reverse=True) + [app]:
            command = [CODE_SIGN, "--force", "--sign", sha1, "--keychain", str(keychain), "--timestamp=none",
                       "--generate-entitlement-der"]
            if target in authorizations:
                command += ["--entitlements", str(authorizations[target])]
            subprocess.run([*command, str(target)], check=True, capture_output=True, timeout=120)
        subprocess.run([CODE_SIGN, "--verify", "--deep", "--strict", str(app)],
                       check=True, capture_output=True, timeout=120)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            for path in app.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(work))
    finally:
        if keychain.exists():
            tool(helper, "delete-keychain", keychain)
