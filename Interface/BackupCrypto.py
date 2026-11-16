"""Read and write the framed backup format shared with the macOS app."""

import hashlib
import os
import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"SideRelayBackup1"
FRAME = 4 * 1024 * 1024
OVERHEAD = 28


def cipher(password, salt):
    return AESGCM(hashlib.pbkdf2_hmac("sha256", password, salt, 600_000, dklen=32))


def encrypt(source, target, password):
    salt = os.urandom(16)
    header = MAGIC + salt
    aes = cipher(password, salt)
    target.write(header)
    frame = 0
    while True:
        block = source.read(FRAME)
        nonce = os.urandom(12)
        sealed = nonce + aes.encrypt(nonce, block, header + struct.pack(">Q", frame))
        target.write(struct.pack(">I", len(sealed)))
        target.write(sealed)
        if not block:
            return
        frame += 1


def decrypt(source, target, password):
    invalid = "This file is incomplete or is not a SideRelay backup."
    header = source.read(len(MAGIC) + 16)
    if len(header) != len(MAGIC) + 16 or not header.startswith(MAGIC):
        raise ValueError(invalid)
    aes = cipher(password, header[-16:])
    frame = 0
    while True:
        size = source.read(4)
        if len(size) != 4 or not OVERHEAD <= (length := struct.unpack(">I", size)[0]) <= FRAME + OVERHEAD:
            raise ValueError(invalid)
        sealed = source.read(length)
        if len(sealed) != length:
            raise ValueError(invalid)
        try:
            block = aes.decrypt(sealed[:12], sealed[12:], header + struct.pack(">Q", frame))
        except InvalidTag as error:
            raise ValueError("The password is incorrect or the backup is damaged.") from error
        if not block:
            if source.read(1):
                raise ValueError(invalid)
            return
        target.write(block)
        frame += 1
