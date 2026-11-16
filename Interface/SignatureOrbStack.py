"""Pass IPA files to the loopback Mac helper without sharing either data volume."""

import base64
from contextlib import ExitStack, closing, contextmanager
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import BadZipFile

if __package__:
    from . import ArchiveIPA, ProvisionnementIPA
else:
    import ArchiveIPA
    import ProvisionnementIPA

IPA_LIMIT = 512 * 1024 * 1024
FRAME = "application/x-siderelay-signing"
ROUTES = {"/signing/verify", "/signing/imported"}


@contextmanager
def relay(action, ipa, udid, certificate=None, profiles=(), password=b""):
    with ExitStack() as stack:
        files = [stack.enter_context(path.open("rb")) for path in
                 ([ipa, certificate, *profiles] if certificate else [ipa])]
        manifest = json.dumps({"udid": udid, "sizes": [os.fstat(file.fileno()).st_size for file in files],
                               "password": base64.b64encode(password).decode("ascii")}).encode()
        prefix = len(manifest).to_bytes(4, "big") + manifest
        length = len(prefix) + sum(os.fstat(file.fileno()).st_size for file in files)

        def body():
            yield prefix
            for file in files:
                while chunk := file.read(256 * 1024):
                    yield chunk

        host = stack.enter_context(closing(http.client.HTTPConnection(
            "host.docker.internal", int(os.environ.get("SIDERELAY_DISCOVERY_PORT", "18786")), timeout=300,
        )))
        host.request("POST", f"/signing/{action}", body(), {
            "Authorization": f"Bearer {os.environ['SIDERELAY_DISCOVERY_TOKEN']}",
            "Content-Type": FRAME, "Content-Length": str(length),
        })
        yield stack.enter_context(host.getresponse())


def receive(request, work, signing):
    length = request.headers.get("Content-Length", "")
    if (request.headers.get_content_type() != FRAME or request.headers.get("Transfer-Encoding")
            or not re.fullmatch(r"\d{1,10}", length, re.ASCII)):
        raise ValueError("Expected a SideRelay signing request.")
    count = int.from_bytes(request.rfile.read(4), "big")
    if not 0 < count <= 8192:
        raise ValueError("Invalid signing request.")
    manifest = json.loads(request.rfile.read(count))
    if not isinstance(manifest, dict):
        raise ValueError("Invalid signing request.")
    sizes, udid = manifest.get("sizes"), manifest.get("udid")
    if (not isinstance(sizes, list) or not (3 <= len(sizes) <= 42 if signing else len(sizes) == 1)
            or any(type(size) is not int or size <= 0 for size in sizes)
            or sizes[0] > IPA_LIMIT or any(size > ProvisionnementIPA.PROFILE_LIMIT for size in sizes[1:])
            or 4 + count + sum(sizes) != int(length)
            or not (udid is None and not signing or isinstance(udid, str) and re.fullmatch(r"[a-fA-F0-9-]{24,40}", udid))):
        raise ValueError("Choose an IPA, a paired iPhone or iPad, and valid signing files.")
    password = base64.b64decode(manifest.get("password", ""), validate=True)
    if len(password) > 4096:
        raise ValueError("The certificate password is too long.")
    files = []
    for index, remaining in enumerate(sizes):
        local = work / f"source-{index}"
        with local.open("xb") as output:
            while remaining:
                chunk = request.rfile.read(min(remaining, 256 * 1024))
                if not chunk:
                    raise ValueError("The signing upload did not finish.")
                output.write(chunk)
                remaining -= len(chunk)
        files.append(local)
    return files, udid, password


def serve(request, helper, directory, lock):
    if not lock.acquire(blocking=False):
        return request.reply({"error": "The Mac is already checking or signing an IPA."}, status=409)
    try:
        request.connection.settimeout(30)
        with tempfile.TemporaryDirectory(prefix="siderelay-signing-", dir=directory) as temporary:
            work = Path(temporary)
            signing = request.path == "/signing/imported"
            files, udid, password = receive(request, work, signing)
            target = work / "signed.ipa"
            if signing:
                report = ProvisionnementIPA.imported(files[0], files[2:], files[1], password, udid, work, helper, target)
                if report["ready"]:
                    request.send_response(200)
                    request.send_header("Content-Type", "application/octet-stream")
                    request.send_header("Content-Length", str(target.stat().st_size))
                    request.send_header("Cache-Control", "no-store")
                    request.end_headers()
                    with target.open("rb") as stream:
                        shutil.copyfileobj(stream, request.wfile, 256 * 1024)
                    return
            else:
                report = ProvisionnementIPA.diagnosis(files[0], udid, work, helper)
                app = ArchiveIPA.extract(files[0], work)
                verified = subprocess.run([ProvisionnementIPA.CODE_SIGN, "--verify", "--deep", "--strict", str(app)],
                                          capture_output=True, timeout=90).returncode == 0
                report["signatureVerified"] = verified
                if not verified and report["components"]:
                    report["ready"] = False
                    report["components"][0]["errors"].insert(0, "The app or nested code failed signature verification.")
            request.reply(report)
    except (ValueError, BadZipFile) as error:
        request.reply({"error": str(error)[:350]}, status=400)
    except (BrokenPipeError, ConnectionResetError):
        pass
    except (OSError, subprocess.SubprocessError):
        request.reply({"error": "The Mac could not complete the signature operation."}, status=503)
    finally:
        lock.release()
