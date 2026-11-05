# -*- coding: utf-8 -*-
"""声场 · 本地高保真音乐播放器

一个只在你电脑上运行的小型音乐服务器：
扫描本目录（含子目录）里的音频文件，把曲库和音频流提供给网页播放器。
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import socket
import struct
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, redirect, request, send_file, session

mimetypes.add_type("application/manifest+json", ".webmanifest")

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
AUDIO_EXTS = {
    ".mp3", ".m4a", ".m4b", ".aac", ".flac", ".wav", ".wave",
    ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif", ".ape",
    ".dsf", ".dff", ".alac",
}
SKIP_DIRS = {"web", "tools", "__pycache__", "node_modules", ".git", ".idea", ".vscode"}
MIME_OVERRIDES = {
    ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac",
    ".flac": "audio/flac", ".opus": "audio/ogg", ".oga": "audio/ogg",
    ".wma": "audio/x-ms-wma", ".ape": "audio/x-ape",
    ".aiff": "audio/aiff", ".aif": "audio/aiff",
    ".dsf": "audio/x-dsf", ".dff": "audio/x-dff",
}

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="/static")
app.json.ensure_ascii = False
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
app.config.update(
    SESSION_COOKIE_NAME="sf_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=180),
)
if os.environ.get("SOUNDFIELD_HTTPS") == "1":
    # 远程模式走 Cloudflare 的 HTTPS，Cookie 只在 HTTPS 下发送
    app.config["SESSION_COOKIE_SECURE"] = True

# 只有在启动远程访问（或手动设置环境变量）时才需要访问码。
# 普通「启动播放器」没有任何登录步骤，和以前完全一样。
ACCESS_CODE = os.environ.get("SOUNDFIELD_ACCESS_CODE", "").strip()
if ACCESS_CODE:
    app.secret_key = os.environ.get("SOUNDFIELD_SECRET_KEY", "").strip() or secrets.token_hex(32)

LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_MAX_FAILURES = 12
_login_failures: dict[str, list[float]] = {}
_login_lock = threading.Lock()


def _client_ip() -> str:
    """真实客户端地址。经过 Cloudflare 隧道时 remote_addr 是本机，需要用请求头。"""
    return (request.headers.get("CF-Connecting-IP") or request.remote_addr or "").strip()


def _is_local_request() -> bool:
    """是不是电脑本机直接打开的请求（不是隧道转发进来的）。"""
    if (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("CF-Ray")
        or request.headers.get("X-Forwarded-For")
    ):
        return False
    return (request.remote_addr or "") in ("127.0.0.1", "::1")


def _is_authenticated() -> bool:
    if not ACCESS_CODE or session.get("sf_access") or _is_local_request():
        return True
    return False


def _code_matches(value: str) -> bool:
    return bool(ACCESS_CODE) and hmac.compare_digest(str(value or "").strip(), ACCESS_CODE)


def _login_blocked(ip: str) -> bool:
    now = time.time()
    with _login_lock:
        attempts = [stamp for stamp in _login_failures.get(ip, []) if now - stamp < LOGIN_WINDOW_SECONDS]
        if attempts:
            _login_failures[ip] = attempts
        else:
            _login_failures.pop(ip, None)
        return len(attempts) >= LOGIN_MAX_FAILURES


def _record_login_failure(ip: str) -> None:
    now = time.time()
    with _login_lock:
        attempts = [stamp for stamp in _login_failures.get(ip, []) if now - stamp < LOGIN_WINDOW_SECONDS]
        attempts.append(now)
        _login_failures[ip] = attempts
        if len(_login_failures) > 2000:
            for key in [k for k, v in _login_failures.items() if not v or now - v[-1] > LOGIN_WINDOW_SECONDS]:
                _login_failures.pop(key, None)


def _clear_login_failures(ip: str) -> None:
    with _login_lock:
        _login_failures.pop(ip, None)


def _safe_next(value: str | None) -> str:
    target = (value or "").strip()
    if target.startswith("/") and not target.startswith("//") and "\\" not in target and "\n" not in target:
        return target
    return "/"


def _login_page(status: int = 200, message: str = "", next_url: str = "/") -> Response:
    page = WEB_DIR / "login.html"
    if not page.exists():
        return Response("需要访问码，但 web/login.html 缺失。", status=500, mimetype="text/plain")
    body = page.read_text(encoding="utf-8")
    body = body.replace("{{ERROR}}", html.escape(message))
    body = body.replace("{{NEXT}}", html.escape(next_url))
    response = Response(body, status=status, mimetype="text/html")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.before_request
def _guard_remote_access():
    """设置访问码后，所有非本机请求都要先登录；静态资源和登录页除外。"""
    if not ACCESS_CODE:
        return None
    path = request.path
    if path == "/login" or path == "/favicon.ico" or path.startswith("/static/"):
        return None
    if path == "/api/health":
        return None
    if _is_local_request() or session.get("sf_access"):
        return None

    # 二维码里的链接会带 ?code=xxxxxx，扫码后自动登录并把参数从地址栏去掉
    if request.method == "GET" and "code" in request.args:
        ip = _client_ip()
        if _login_blocked(ip):
            return _login_page(429, "尝试次数过多，请 5 分钟后再试。", "/")
        if _code_matches(request.args.get("code", "")):
            session.permanent = True
            session["sf_access"] = True
            _clear_login_failures(ip)
            params = request.args.to_dict(flat=True)
            params.pop("code", None)
            target = request.path + (("?" + urllib.parse.urlencode(params)) if params else "")
            return redirect(_safe_next(target))
        _record_login_failure(ip)
        return _login_page(401, "链接里的访问码不正确，请重新扫码。", "/")

    if path.startswith("/api/"):
        return jsonify({"ok": False, "error": "unauthorized", "login": "/login"}), 401
    if path == "/":
        return _login_page(200, "", "/")
    return redirect("/login?next=" + quote(path, safe=""))


@app.route("/login", methods=["GET", "POST"])
def login():
    if not ACCESS_CODE:
        return redirect("/")
    next_url = _safe_next(request.values.get("next"))
    if request.method == "POST":
        ip = _client_ip()
        if _login_blocked(ip):
            return _login_page(429, "尝试次数过多，请 5 分钟后再试。", next_url)
        if _code_matches(request.form.get("code", "")):
            session.permanent = True
            session["sf_access"] = True
            _clear_login_failures(ip)
            return redirect(next_url)
        _record_login_failure(ip)
        return _login_page(401, "访问码不正确，请重新输入。", next_url)
    if _is_authenticated():
        return redirect(next_url)
    return _login_page(200, "", next_url)


# ---------------------------------------------------------------------------
# 元数据读取（无第三方依赖，够用即好）
# ---------------------------------------------------------------------------

@dataclass
class Meta:
    title: str = ""
    artist: str = ""
    album: str = ""
    album_artist: str = ""
    date: str = ""
    track: str = ""
    duration: float = 0.0
    cover: bytes | None = None
    cover_mime: str = ""
    lyrics: str = ""


def _decode_text(raw: bytes, encoding: str = "utf-8") -> str:
    if not raw:
        return ""
    if encoding in ("utf-16", "utf-16-be", "utf-16-le") and not raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raw = b"\xff\xfe" + raw
    try:
        return raw.decode(encoding, errors="replace").strip("\x00 \t\r\n")
    except (LookupError, UnicodeError):
        return raw.decode("utf-8", errors="replace").strip("\x00 \t\r\n")


def _mp4_atoms(buf: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1:
            if pos + 16 > end:
                break
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            break
        yield kind, pos + header, pos + size
        pos += size


def _mp4_find(buf: bytes, start: int, end: int, wanted: bytes):
    for kind, body, stop in _mp4_atoms(buf, start, end):
        if kind == wanted:
            yield body, stop


def _parse_mp4(path: Path) -> Meta:
    meta = Meta()
    size = path.stat().st_size
    moov = b""
    with path.open("rb") as fh:
        pos = 0
        while pos + 8 <= size:
            fh.seek(pos)
            head = fh.read(16)
            if len(head) < 8:
                break
            atom_size, kind = struct.unpack_from(">I4s", head)
            header = 8
            if atom_size == 1:
                if len(head) < 16:
                    break
                atom_size = struct.unpack_from(">Q", head, 8)[0]
                header = 16
            elif atom_size == 0:
                atom_size = size - pos
            if atom_size < header:
                break
            if kind == b"moov":
                fh.seek(pos + header)
                moov = fh.read(min(atom_size - header, 48 * 1024 * 1024))
                break
            pos += atom_size

    if not moov:
        return meta

    # mvhd / mdhd 时长
    for body, stop in _mp4_find(moov, 0, len(moov), b"mvhd"):
        payload = moov[body:stop]
        if len(payload) >= 20:
            version = payload[0]
            try:
                if version == 1 and len(payload) >= 32:
                    timescale = struct.unpack_from(">I", payload, 20)[0]
                    duration = struct.unpack_from(">Q", payload, 24)[0]
                else:
                    timescale = struct.unpack_from(">I", payload, 12)[0]
                    duration = struct.unpack_from(">I", payload, 16)[0]
                if timescale:
                    meta.duration = duration / timescale
            except struct.error:
                pass
        break

    # udta > meta > ilst
    udta = next(_mp4_find(moov, 0, len(moov), b"udta"), None)
    if not udta:
        return meta
    meta_box = next(_mp4_find(moov, udta[0], udta[1], b"meta"), None)
    if not meta_box:
        return meta
    ilst = next(_mp4_find(moov, meta_box[0] + 4, meta_box[1], b"ilst"), None)
    if not ilst:
        return meta

    text_fields = {
        b"\xa9nam": "title", b"\xa9ART": "artist", b"\xa9alb": "album",
        b"aART": "album_artist", b"\xa9day": "date", b"\xa9lyr": "lyrics",
    }
    for kind, body, stop in _mp4_atoms(moov, ilst[0], ilst[1]):
        data_atom = next(_mp4_find(moov, body, stop, b"data"), None)
        if not data_atom:
            continue
        payload = moov[data_atom[0]:data_atom[1]]
        if len(payload) < 8:
            continue
        data_type = int.from_bytes(payload[0:4], "big") & 0xFFFFFF
        value = payload[8:]
        if kind in text_fields:
            text = _decode_text(value, "utf-16" if data_type == 2 else "utf-8")
            if text:
                setattr(meta, text_fields[kind], text)
        elif kind == b"trkn" and len(value) >= 4:
            number = int.from_bytes(value[2:4], "big")
            total = int.from_bytes(value[4:6], "big") if len(value) >= 6 else 0
            meta.track = f"{number}/{total}" if total else str(number)
        elif kind == b"covr" and not meta.cover:
            meta.cover = value
            if value.startswith(b"\x89PNG"):
                meta.cover_mime = "image/png"
            else:
                meta.cover_mime = "image/jpeg"
    return meta


def _syncsafe(raw: bytes) -> int:
    value = 0
    for byte in raw:
        value = (value << 7) | (byte & 0x7F)
    return value


def _id3_text(raw: bytes) -> str:
    if not raw:
        return ""
    enc = raw[0]
    body = raw[1:]
    mapping = {0: "latin-1", 1: "utf-16", 2: "utf-16-be", 3: "utf-8"}
    text = _decode_text(body, mapping.get(enc, "utf-8"))
    return text.replace("\x00", " ").strip()


def _id3_described_text(raw: bytes) -> tuple[str, str]:
    """Split ID3 TXXX/USLT payloads into (description, value)."""
    if not raw:
        return "", ""
    enc = raw[0]
    body = raw[1:]
    mapping = {0: "latin-1", 1: "utf-16", 2: "utf-16-be", 3: "utf-8"}
    if enc in (1, 2):
        pos = 0
        while pos + 1 < len(body) and body[pos:pos + 2] != b"\x00\x00":
            pos += 2
        desc = _decode_text(body[:pos], mapping[enc])
        value = body[min(len(body), pos + 2):]
    else:
        pos = body.find(b"\x00")
        if pos < 0:
            return "", ""
        desc = _decode_text(body[:pos], mapping[enc])
        value = body[pos + 1:]
    text = _decode_text(value, mapping[enc])
    return desc.strip(), text.strip("\x00 \t\r\n")


MP3_BITRATES = {
    (1, 1): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    (1, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    (1, 3): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    (2, 1): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    (2, 3): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
MP3_SAMPLE_RATES = {
    3: [44100, 48000, 32000],  # MPEG 1
    2: [22050, 24000, 16000],  # MPEG 2
    0: [11025, 12000, 8000],   # MPEG 2.5
}


def _mpeg_frame_info(buf: bytes, pos: int):
    if pos + 4 > len(buf):
        return None
    b0, b1, b2, _b3 = buf[pos:pos + 4]
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    version_bits = (b1 >> 3) & 0x03
    layer_bits = (b1 >> 1) & 0x03
    if version_bits == 1 or layer_bits == 0:
        return None
    bitrate_index = (b2 >> 4) & 0x0F
    sample_index = (b2 >> 2) & 0x03
    if bitrate_index in (0, 15) or sample_index == 3:
        return None
    version_group = 1 if version_bits == 3 else 2
    layer = 4 - layer_bits  # 1, 2 or 3
    bitrate = MP3_BITRATES[(version_group, layer)][bitrate_index]
    sample_rate = MP3_SAMPLE_RATES[version_bits][sample_index]
    if not bitrate or not sample_rate:
        return None
    padding = (b2 >> 1) & 0x01
    if layer == 1:
        frame_length = ((12 * bitrate * 1000 // sample_rate) + padding) * 4
        samples = 384
    elif layer == 3 and version_group == 2:
        frame_length = (72 * bitrate * 1000 // sample_rate) + padding
        samples = 576
    else:
        frame_length = (144 * bitrate * 1000 // sample_rate) + padding
        samples = 1152
    if frame_length < 4:
        return None
    return {
        "version_group": version_group,
        "layer": layer,
        "bitrate": bitrate,
        "sample_rate": sample_rate,
        "frame_length": frame_length,
        "samples": samples,
        "channels": 1 if ((_b3 >> 6) & 0x03) == 3 else 2,
        "has_crc": not bool(b1 & 0x01),
    }


def _mp3_duration(path: Path, audio_start: int) -> float:
    try:
        file_size = path.stat().st_size
        with path.open("rb") as fh:
            fh.seek(audio_start)
            probe = fh.read(1024 * 1024)
        frame_index = 0
        info = None
        while frame_index + 4 <= len(probe):
            candidate = _mpeg_frame_info(probe, frame_index)
            if candidate:
                next_pos = frame_index + candidate["frame_length"]
                if next_pos + 4 > len(probe) or _mpeg_frame_info(probe, next_pos):
                    info = candidate
                    break
            frame_index += 1
        if not info:
            return 0.0
        frame_offset = audio_start + frame_index
        side_info = 17 if info["version_group"] == 1 and info["channels"] == 1 else (
            32 if info["version_group"] == 1 else (9 if info["channels"] == 1 else 17)
        )
        xing_pos = frame_index + 4 + (2 if info["has_crc"] else 0) + side_info
        xing = probe[xing_pos:xing_pos + 4]
        if xing in (b"Xing", b"Info") and xing_pos + 12 <= len(probe):
            flags = struct.unpack_from(">I", probe, xing_pos + 4)[0]
            if flags & 0x01:
                frames = struct.unpack_from(">I", probe, xing_pos + 8)[0]
                if frames:
                    return frames * info["samples"] / info["sample_rate"]
        audio_size = max(0, file_size - frame_offset)
        if audio_size > 128:
            with path.open("rb") as fh:
                fh.seek(file_size - 128)
                if fh.read(3) == b"TAG":
                    audio_size -= 128
        return audio_size * 8 / (info["bitrate"] * 1000) if audio_size else 0.0
    except (OSError, struct.error, ZeroDivisionError):
        return 0.0


def _parse_id3(path: Path) -> Meta:
    meta = Meta()
    major = 0
    audio_start = 0
    data = b""
    with path.open("rb") as fh:
        head = fh.read(10)
        if len(head) >= 10 and head[:3] == b"ID3":
            major, flags = head[3], head[5]
            size = _syncsafe(head[6:10])
            audio_start = 10 + size + (10 if flags & 0x10 else 0)
            data = fh.read(min(size, 32 * 1024 * 1024))
    if major not in (3, 4):
        meta.duration = _mp3_duration(path, audio_start)
        return meta
    pos = 0
    while pos + 10 <= len(data):
        frame_id = data[pos:pos + 4]
        if not frame_id.strip(b"\x00"):
            break
        frame_size = struct.unpack_from(">I", data, pos + 4)[0]
        if major == 4:
            frame_size = _syncsafe(data[pos + 4:pos + 8])
        if frame_size <= 0 or pos + 10 + frame_size > len(data):
            break
        payload = data[pos + 10:pos + 10 + frame_size]
        pos += 10 + frame_size
        key = frame_id.decode("latin-1", errors="ignore")
        if key == "TIT2":
            meta.title = _id3_text(payload)
        elif key == "TPE1":
            meta.artist = _id3_text(payload)
        elif key == "TALB":
            meta.album = _id3_text(payload)
        elif key in ("TPE2",):
            meta.album_artist = _id3_text(payload)
        elif key in ("TDRC", "TYER"):
            meta.date = _id3_text(payload)
        elif key == "TRCK":
            meta.track = _id3_text(payload)
        elif key == "TLEN":
            try:
                meta.duration = float(_id3_text(payload)) / 1000
            except ValueError:
                pass
        elif key == "USLT":
            try:
                _desc, text = _id3_described_text(payload[:1] + payload[4:])
                if text:
                    meta.lyrics = text
            except (IndexError, ValueError):
                pass
        elif key == "TXXX":
            try:
                desc, text = _id3_described_text(payload)
                if desc.upper() in ("LYRICS", "LYRIC", "UNSYNCEDLYRICS") and text:
                    meta.lyrics = text
            except (IndexError, ValueError):
                pass
        elif key == "APIC" and not meta.cover:
            try:
                enc = payload[0]
                mime_end = payload.index(b"\x00", 1)
                mime = payload[1:mime_end].decode("latin-1", errors="ignore")
                # APIC: encoding, MIME, picture type, description, image bytes
                pos2 = mime_end + 2
                if enc in (1, 2):
                    # 图片描述以 UTF-16 双字节空字符结束
                    while pos2 + 1 < len(payload) and payload[pos2:pos2 + 2] != b"\x00\x00":
                        pos2 += 2
                    pos2 += 2
                else:
                    pos2 = payload.index(b"\x00", pos2) + 1
                meta.cover = payload[pos2:]
                meta.cover_mime = mime or ("image/png" if meta.cover.startswith(b"\x89PNG") else "image/jpeg")
            except (ValueError, IndexError):
                pass
    if not meta.duration:
        meta.duration = _mp3_duration(path, audio_start)
    return meta


def _parse_flac(path: Path) -> Meta:
    meta = Meta()
    with path.open("rb") as fh:
        if fh.read(4) != b"fLaC":
            return meta
        while True:
            header = fh.read(4)
            if len(header) < 4:
                break
            last = bool(header[0] & 0x80)
            block_type = header[0] & 0x7F
            length = int.from_bytes(header[1:4], "big")
            if length > 32 * 1024 * 1024:
                break
            block = fh.read(length)
            if len(block) < length:
                break
            if block_type == 0 and len(block) >= 18:
                x = int.from_bytes(block[10:18], "big")
                sample_rate = x >> 44
                total = x & 0xFFFFFFFFF
                if sample_rate:
                    meta.duration = total / sample_rate
            elif block_type == 4:
                try:
                    pos = 0
                    vendor_len = struct.unpack_from("<I", block, pos)[0]
                    pos += 4 + vendor_len
                    count = struct.unpack_from("<I", block, pos)[0]
                    pos += 4
                    for _ in range(count):
                        item_len = struct.unpack_from("<I", block, pos)[0]
                        pos += 4
                        item = block[pos:pos + item_len].decode("utf-8", errors="replace")
                        pos += item_len
                        if "=" not in item:
                            continue
                        key, value = item.split("=", 1)
                        key = key.upper()
                        if key == "TITLE":
                            meta.title = value.strip()
                        elif key == "ARTIST":
                            meta.artist = value.strip()
                        elif key == "ALBUM":
                            meta.album = value.strip()
                        elif key == "ALBUMARTIST":
                            meta.album_artist = value.strip()
                        elif key == "DATE":
                            meta.date = value.strip()
                        elif key == "TRACKNUMBER":
                            meta.track = value.strip()
                        elif key in ("LYRICS", "UNSYNCEDLYRICS"):
                            meta.lyrics = value.strip()
                except struct.error:
                    pass
            elif block_type == 6 and not meta.cover and len(block) > 32:
                try:
                    pos = 4
                    mime_len = struct.unpack_from(">I", block, pos)[0]
                    pos += 4
                    mime = block[pos:pos + mime_len].decode("latin-1", errors="ignore")
                    pos += mime_len
                    desc_len = struct.unpack_from(">I", block, pos)[0]
                    pos += 4 + desc_len + 16
                    data_len = struct.unpack_from(">I", block, pos)[0]
                    pos += 4
                    meta.cover = block[pos:pos + data_len]
                    meta.cover_mime = mime or "image/jpeg"
                except struct.error:
                    pass
            if last:
                break
    return meta


def _parse_wav(path: Path) -> Meta:
    meta = Meta()
    try:
        with path.open("rb") as fh:
            head = fh.read(12)
            if head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
                return meta
            byte_rate = 0
            data_size = 0
            while True:
                chunk = fh.read(8)
                if len(chunk) < 8:
                    break
                chunk_id, chunk_size = chunk[:4], struct.unpack_from("<I", chunk, 4)[0]
                if chunk_id == b"fmt ":
                    fmt = fh.read(min(chunk_size, 64))
                    if len(fmt) >= 12:
                        byte_rate = struct.unpack_from("<I", fmt, 8)[0]
                    fh.seek(max(0, chunk_size - len(fmt)), 1)
                elif chunk_id == b"data":
                    data_size = chunk_size
                    break
                else:
                    fh.seek(chunk_size + (chunk_size & 1), 1)
            if byte_rate and data_size:
                meta.duration = data_size / byte_rate
    except OSError:
        pass
    return meta


def _parse_aiff(path: Path) -> Meta:
    meta = Meta()
    try:
        with path.open("rb") as fh:
            if fh.read(4) != b"FORM":
                return meta
            fh.read(4)
            if fh.read(4) != b"AIFF":
                return meta
            while True:
                chunk = fh.read(8)
                if len(chunk) < 8:
                    break
                chunk_id, chunk_size = chunk[:4], struct.unpack_from(">I", chunk, 4)[0]
                if chunk_id == b"COMM":
                    data = fh.read(min(chunk_size, 64))
                    if len(data) >= 18:
                        frames = struct.unpack_from(">I", data, 2)[0]
                        exponent = struct.unpack_from(">H", data, 8)[0]
                        mantissa = struct.unpack_from(">Q", data, 10)[0]
                        sample_rate = mantissa * (2.0 ** (exponent - 16383 - 63)) if exponent else 0
                        if sample_rate:
                            meta.duration = frames / sample_rate
                    break
                fh.seek(chunk_size + (chunk_size & 1), 1)
    except OSError:
        pass
    return meta


def read_metadata(path: Path) -> Meta:
    suffix = path.suffix.lower()
    try:
        if suffix in (".m4a", ".m4b", ".mp4", ".aac", ".alac"):
            return _parse_mp4(path)
        if suffix == ".mp3":
            return _parse_id3(path)
        if suffix == ".flac":
            return _parse_flac(path)
        if suffix in (".wav", ".wave"):
            return _parse_wav(path)
        if suffix in (".aiff", ".aif"):
            return _parse_aiff(path)
        if suffix in (".ogg", ".opus", ".oga"):
            return Meta()
    except (OSError, struct.error, ValueError):
        return Meta()
    return Meta()


# ---------------------------------------------------------------------------
# 文件名兜底解析
# ---------------------------------------------------------------------------

DASH_RE = re.compile(r"\s+[-–—]\s+")
TRACK_PREFIX_RE = re.compile(r"^\s*(?:\[?\d{1,3}\]?)[.、\-_ ]+\s*")


def filename_info(path: Path) -> dict[str, str]:
    stem = TRACK_PREFIX_RE.sub("", path.stem).strip()
    title = artist = album = source = ""

    bracket = re.search(r"《([^》]{1,80})》", stem)
    if bracket:
        title = bracket.group(1).strip()
        artist = stem[:bracket.start()].strip(" -_·")
        tail = stem[bracket.end():].strip(" -_·")
        parts = [p.strip() for p in DASH_RE.split(tail) if p.strip()]
        if len(parts) >= 2:
            album = " - ".join(parts[:-1])
            source = parts[-1]
        else:
            album = tail
    else:
        parts = [p.strip() for p in DASH_RE.split(stem) if p.strip()]
        if len(parts) >= 2:
            artist, title = parts[0], parts[1]
            album = " - ".join(parts[2:])
        else:
            title = stem

    # 去掉歌手名前后常见的装饰符
    artist = artist.strip(" -_·|")
    title = title.strip(" -_·|")
    album = album.strip(" -_·|")
    return {"title": title, "artist": artist, "album": album, "source": source}


def _natural_key(text: str):
    return [int(part) if part.isdigit() else part.casefold()
            for part in re.split(r"(\d+)", text)]


def _playlist_id(name: str) -> str:
    return hashlib.sha1(f"playlist:{name}".encode("utf-8")).hexdigest()[:14]


def _build_playlists(tracks: list["Track"]) -> list[dict]:
    """Each top-level folder inside the library is a playlist.

    Tracks in nested folders still belong to the top-level playlist, so
    ``周杰伦歌单/叶惠美/以父之名.flac`` is part of the 周杰伦歌单 playlist.
    """
    groups: dict[str, list[Track]] = {}
    for track in tracks:
        if "/" not in track.rel:
            continue
        folder = track.rel.split("/", 1)[0]
        groups.setdefault(folder, []).append(track)

    playlists = []
    for name, items in groups.items():
        cover_track = next((item for item in items if item.cover), None)
        playlists.append({
            "id": _playlist_id(name),
            "name": name,
            "path": name,
            "trackCount": len(items),
            "duration": round(sum(item.duration for item in items if item.duration), 3),
            "coverUrl": f"/api/cover/{cover_track.id}" if cover_track else None,
        })
    playlists.sort(key=lambda item: _natural_key(item["name"]))
    return playlists


# ---------------------------------------------------------------------------
# 曲库扫描
# ---------------------------------------------------------------------------

@dataclass
class Track:
    id: str
    rel: str
    path: Path
    title: str
    artist: str
    album: str
    source: str
    duration: float
    size: int
    fmt: str
    cover: bytes | None = None
    cover_mime: str = ""
    lyrics: str = ""
    modified: float = 0.0
    bitrate: int = 0

    def public(self) -> dict:
        folder = self.rel.split("/", 1)[0] if "/" in self.rel else None
        return {
            "id": self.id,
            "path": self.rel,
            "playlist": folder,
            "playlistId": _playlist_id(folder) if folder else None,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "source": self.source,
            "duration": round(self.duration, 3),
            "size": self.size,
            "format": self.fmt,
            "bitrate": self.bitrate,
            "hasCover": bool(self.cover),
            "coverUrl": f"/api/cover/{self.id}" if self.cover else None,
            "audioUrl": "/api/audio/" + quote(self.rel, safe="/"),
            "modified": self.modified,
        }


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self._meta_cache: dict[str, tuple[int, int, Meta]] = {}
        self.tracks: list[Track] = []
        self.track_by_id: dict[str, Track] = {}
        self.scanned_at = 0.0
        self.version = ""

    def _iter_audio(self):
        for path in self.root.rglob("*"):
            try:
                rel_parts = path.relative_to(self.root).parts
                if any(part.startswith(".") or part in SKIP_DIRS for part in rel_parts[:-1]):
                    continue
                if path.name.startswith(".") or not path.is_file():
                    continue
                if path.suffix.lower() not in AUDIO_EXTS:
                    continue
                yield path
            except (OSError, ValueError):
                continue

    def scan(self) -> list[Track]:
        tracks: list[Track] = []
        seen: set[str] = set()
        for path in sorted(self._iter_audio(), key=lambda p: _natural_key(str(p.relative_to(self.root)))):
            try:
                stat = path.stat()
            except OSError:
                continue
            rel = path.relative_to(self.root).as_posix()
            cache_key = rel
            cached = self._meta_cache.get(cache_key)
            if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                meta = cached[2]
            else:
                meta = read_metadata(path)
                self._meta_cache[cache_key] = (stat.st_mtime_ns, stat.st_size, meta)
            info = filename_info(path)
            title = meta.title or info["title"] or path.stem
            artist = meta.artist or meta.album_artist or info["artist"] or "未知艺术家"
            album = meta.album or info["album"]
            source = info["source"]
            duration = meta.duration if meta.duration and meta.duration > 0 else 0.0
            bitrate = round(stat.st_size * 8 / duration / 1000) if duration > 0 else 0
            tid = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:14]
            track = Track(
                id=tid, rel=rel, path=path, title=title, artist=artist,
                album=album, source=source, duration=duration,
                size=stat.st_size, fmt=path.suffix.lower().lstrip(".").upper(),
                cover=meta.cover, cover_mime=meta.cover_mime,
                lyrics=meta.lyrics,
                modified=stat.st_mtime, bitrate=bitrate,
            )
            tracks.append(track)
            seen.add(rel)

        # 清理已删除文件的缓存
        for key in list(self._meta_cache):
            if key not in seen:
                del self._meta_cache[key]

        signature = hashlib.sha1(
            "|".join(f"{t.rel}:{t.size}:{int(t.modified)}" for t in tracks).encode("utf-8")
        ).hexdigest()[:12]
        with self.lock:
            self.tracks = tracks
            self.track_by_id = {t.id: t for t in tracks}
            self.scanned_at = time.time()
            self.version = signature
        return tracks

    def snapshot(self) -> tuple[list[Track], float, str]:
        with self.lock:
            return list(self.tracks), self.scanned_at, self.version

    def find(self, track_id: str) -> Track | None:
        with self.lock:
            return self.track_by_id.get(track_id)


library = Library(BASE_DIR)


def _public_library() -> dict:
    tracks, scanned_at, version = library.snapshot()
    total = sum(t.duration for t in tracks if t.duration)
    known = sum(1 for t in tracks if t.duration)
    playlists = _build_playlists(tracks)
    return {
        "root": str(BASE_DIR),
        "rootName": BASE_DIR.name,
        "version": version,
        "scannedAt": int(scanned_at * 1000),
        "tracks": [t.public() for t in tracks],
        "playlists": playlists,
        "stats": {
            "count": len(tracks),
            "duration": round(total, 3),
            "knownDurations": known,
            "formats": sorted({t.fmt for t in tracks}),
            "playlists": len(playlists),
        },
    }


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 歌词：本地 .lrc / 内嵌歌词 / LRCLIB 在线匹配
# ---------------------------------------------------------------------------

LRC_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
LRC_TAG_RE = re.compile(r"\[[^\]]*\]")
LYRICS_CACHE: dict[str, tuple[float, str, str]] = {}
LYRICS_CACHE_TTL = 6 * 3600


def _read_text_fallback(path: Path) -> str:
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            text = raw.decode(encoding)
            if text and "\x00" not in text[:200]:
                return text
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _sidecar_lyrics(track: Track) -> str:
    folder = track.path.parent
    exact_stem = track.path.stem.casefold()
    title = (track.title or "").casefold()
    title_match = ""
    try:
        for candidate in folder.iterdir():
            if not candidate.is_file() or candidate.suffix.lower() != ".lrc":
                continue
            try:
                if candidate.stat().st_size > 2 * 1024 * 1024:
                    continue
            except OSError:
                continue
            stem = candidate.stem.casefold()
            if stem == exact_stem:
                return _read_text_fallback(candidate)
            if title and stem == title and not title_match:
                title_match = str(candidate)
    except OSError:
        return ""
    return _read_text_fallback(Path(title_match)) if title_match else ""


def parse_lrc(text: str) -> dict:
    if not text or not text.strip():
        return {"timed": False, "lines": []}
    offset_ms = 0
    timed_lines: list[dict] = []
    untimed_lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        raw = raw.strip("\ufeff \t")
        if not raw:
            continue
        offset_match = re.search(r"\[offset:\s*([+-]?\d+)\]", raw, re.IGNORECASE)
        if offset_match:
            try:
                offset_ms = int(offset_match.group(1))
            except ValueError:
                pass
        stamps = LRC_TIME_RE.findall(raw)
        content = LRC_TAG_RE.sub("", raw).strip()
        if not stamps:
            if content:
                untimed_lines.append(content)
            continue
        if not content:
            continue
        for minutes, seconds, fraction in stamps:
            try:
                millis = int(fraction.ljust(3, "0")[:3]) if fraction else 0
                time_value = int(minutes) * 60 + int(seconds) + millis / 1000
            except ValueError:
                continue
            timed_lines.append({"time": round(time_value, 3), "text": content})

    if timed_lines:
        if offset_ms:
            for line in timed_lines:
                line["time"] = round(max(0, line["time"] + offset_ms / 1000), 3)
        # 多个时间标签可能指向同一条歌词，去重并按时间排序
        deduped = []
        seen = set()
        for line in sorted(timed_lines, key=lambda item: item["time"]):
            key = (line["time"], line["text"])
            if key not in seen:
                seen.add(key)
                deduped.append(line)
        return {"timed": True, "lines": deduped[:3000]}
    return {
        "timed": False,
        "lines": [{"time": None, "text": line} for line in untimed_lines[:3000]],
    }


def _normalize_match(value: str) -> str:
    return re.sub(r"[\W_]+", "", (value or "").casefold(), flags=re.UNICODE)


def _online_lyrics(track: Track) -> tuple[str, str] | None:
    now = time.time()
    cached = LYRICS_CACHE.get(track.id)
    if cached and now - cached[0] < (LYRICS_CACHE_TTL if cached[1] else 600):
        return (cached[1], cached[2]) if cached[1] else None
    if not track.title or not track.artist or track.artist in ("未知艺术家", "Unknown Artist"):
        LYRICS_CACHE[track.id] = (now, "", "none")
        return None
    params = urllib.parse.urlencode({
        "track_name": track.title,
        "artist_name": track.artist,
    })
    request = urllib.request.Request(
        f"https://lrclib.net/api/search?{params}",
        headers={
            "User-Agent": "Soundfield/1.0 (local music player)",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            raw = response.read(2 * 1024 * 1024)
            results = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        LYRICS_CACHE[track.id] = (now, "", "none")
        return None

    best = None
    best_score = -999.0
    target_title = _normalize_match(track.title)
    target_artist = _normalize_match(track.artist)
    for item in results if isinstance(results, list) else []:
        if not isinstance(item, dict):
            continue
        synced = str(item.get("syncedLyrics") or "").strip()
        plain = str(item.get("plainLyrics") or "").strip()
        if not synced and not plain:
            continue
        score = 0.0
        if _normalize_match(str(item.get("trackName") or "")) == target_title:
            score += 6
        if _normalize_match(str(item.get("artistName") or "")) == target_artist:
            score += 6
        if synced:
            score += 3
        try:
            result_duration = float(item.get("duration") or 0)
        except (TypeError, ValueError):
            result_duration = 0
        if track.duration > 0 and result_duration > 0:
            score -= min(6.0, abs(result_duration - track.duration) / 8)
        if score > best_score:
            best_score = score
            best = (synced or plain, "lrclib-synced" if synced else "lrclib-plain")
    if best:
        LYRICS_CACHE[track.id] = (now, best[0], best[1])
        return best
    LYRICS_CACHE[track.id] = (now, "", "none")
    return None


def _lyrics_for_track(track: Track, allow_online: bool = True) -> tuple[str, str]:
    sidecar = _sidecar_lyrics(track)
    if sidecar.strip():
        return sidecar, "lrc"
    if track.lyrics.strip():
        return track.lyrics, "embedded"
    if allow_online:
        online = _online_lyrics(track)
        if online:
            return online
    return "", "none"


@app.after_request
def _headers(resp: Response) -> Response:
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    elif ACCESS_CODE and request.path == "/":
        resp.headers["Cache-Control"] = "private, no-store"
    return resp


@app.get("/")
def index():
    page = WEB_DIR / "index.html"
    if not page.exists():
        return Response("播放器界面文件缺失：web/index.html", status=500, mimetype="text/plain")
    return send_file(page, mimetype="text/html")


@app.get("/favicon.ico")
def favicon():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<rect width="64" height="64" rx="16" fill="#141311"/>'
        '<path d="M18 38V26m9 17V21m10 25V18m9 26V24" stroke="#ffffff" '
        'stroke-width="4" stroke-linecap="round"/></svg>'
    )
    return Response(svg, mimetype="image/svg+xml")


@app.get("/api/tracks")
def api_tracks():
    refresh = request.args.get("refresh") in ("1", "true", "yes")
    force = request.args.get("force") in ("1", "true", "yes")
    if force:
        with library.lock:
            library._meta_cache.clear()
    library.scan()
    payload = _public_library()
    payload["refreshed"] = refresh
    return jsonify(payload)


@app.get("/api/cover/<track_id>")
def api_cover(track_id: str):
    track = library.find(track_id)
    if not track or not track.cover:
        abort(404)
    mime = track.cover_mime or "image/jpeg"
    return Response(
        track.cover,
        mimetype=mime,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Length": str(len(track.cover)),
        },
    )


@app.get("/api/lyrics/<track_id>")
def api_lyrics(track_id: str):
    track = library.find(track_id)
    if not track:
        abort(404)
    allow_online = request.args.get("online", "1").lower() not in ("0", "false", "no")
    text, source = _lyrics_for_track(track, allow_online=allow_online)
    parsed = parse_lrc(text)
    return jsonify({
        "trackId": track.id,
        "hasLyrics": bool(parsed["lines"]),
        "source": source,
        "timed": parsed["timed"],
        "lines": parsed["lines"],
    })


def _range_response(path: Path, mime: str):
    size = path.stat().st_size
    range_header = request.headers.get("Range", "").strip()
    if not range_header:
        response = send_file(
            path, mimetype=mime, conditional=True,
            download_name=path.name,
        )
        response.headers.setdefault("Accept-Ranges", "bytes")
        return response
    match = re.match(r"bytes=(\d*)-(\d*)$", range_header)
    if not match:
        return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    start_raw, end_raw = match.groups()
    if not start_raw and not end_raw:
        return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    if not start_raw:
        length = int(end_raw)
        length = min(length, size)
        start, end = max(0, size - length), size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1
    if start >= size or start < 0 or end < start:
        return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    end = min(end, size - 1)
    length = end - start + 1

    def generate():
        with path.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    return Response(generate(), status=206, headers=headers, mimetype=mime, direct_passthrough=True)


@app.route("/api/audio/<path:rel>", methods=["GET", "HEAD"])
def api_audio(rel: str):
    try:
        target = (BASE_DIR / rel).resolve()
        target.relative_to(BASE_DIR)
    except (ValueError, OSError):
        abort(404)
    if not target.is_file() or target.suffix.lower() not in AUDIO_EXTS:
        abort(404)
    mime = MIME_OVERRIDES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return _range_response(target, mime)


@app.post("/api/open-folder")
def api_open_folder():
    if not _is_local_request():
        return jsonify({"ok": False, "error": "「打开文件夹」只能在电脑上使用"}), 403
    try:
        payload = request.get_json(silent=True) or {}
        rel = str(payload.get("path") or "").strip()
        try:
            target = (BASE_DIR / rel).resolve() if rel else BASE_DIR
            target.relative_to(BASE_DIR)
        except (ValueError, OSError):
            target = BASE_DIR
        if target.is_file():
            target = target.parent
        if not target.is_dir():
            target = BASE_DIR
        if os.name == "nt":
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif os.name == "posix":
            import subprocess
            subprocess.Popen(["xdg-open", str(target)])
        return jsonify({"ok": True})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "app": "soundfield",
        "version": "1.0.0",
        "authRequired": bool(ACCESS_CODE),
    })


def _pick_port(start: int = 8765, count: int = 20, host: str = "127.0.0.1") -> int:
    bind_host = "127.0.0.1" if host == "localhost" else host
    for port in range(start, start + count):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((bind_host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


def _lan_ip() -> str:
    """Best-effort LAN address for the phone-access URL."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def _open_browser_when_ready(url: str, port: int) -> None:
    """Wait until Flask is accepting connections, then open the default browser."""
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                break
        except OSError:
            time.sleep(0.15)
    try:
        if os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            webbrowser.open(url)
    except Exception:
        try:
            webbrowser.open(url)
        except Exception:
            pass


def main():
    library.scan()
    host = os.environ.get("SOUNDFIELD_HOST", "127.0.0.1").strip() or "127.0.0.1"
    if host == "localhost":
        host = "127.0.0.1"
    wanted_port = os.environ.get("SOUNDFIELD_PORT", "").strip()
    try:
        if wanted_port.isdigit():
            port = _pick_port(start=int(wanted_port), count=1, host=host)
        else:
            port = _pick_port(host=host)
    except RuntimeError as exc:
        print("")
        print(f"  启动失败：{exc}")
        print("  请关闭占用 8765 附近端口的程序后重试。")
        return
    local_url = f"http://127.0.0.1:{port}/"
    phone_host = _lan_ip() if host == "0.0.0.0" else host
    phone_url = f"http://{phone_host}:{port}/"
    lan_mode = host != "127.0.0.1"
    print("")
    print("  声场 · SOUNDFIELD")
    print("  ------------------------------------------")
    print(f"  曲库目录  {BASE_DIR}")
    print(f"  曲目数量  {len(library.tracks)} 首")
    print(f"  本机地址  {local_url}")
    if ACCESS_CODE:
        print("  访问保护  已开启（手机首次访问需要输入访问码）")
    if lan_mode:
        print(f"  手机访问  {phone_url}")
        print("  手机和电脑需要连接同一个 Wi-Fi")
        print("  Windows 防火墙请允许 Python 访问专用网络")
        print("  同一网络中的人也能访问，请只在可信网络使用")
    print("  如果浏览器没有自动打开，请手动访问上面的本机地址")
    print("  关闭此窗口即可停止播放器")
    print("  ------------------------------------------")
    print("")
    if os.environ.get("SOUNDFIELD_NO_BROWSER") != "1":
        threading.Thread(target=_open_browser_when_ready, args=(local_url, port), daemon=True).start()
    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
