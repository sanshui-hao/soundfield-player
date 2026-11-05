# -*- coding: utf-8 -*-
"""声场 · 手机远程访问

一条命令同时启动：
1. 只监听本机的播放器服务（app.py）
2. Cloudflare 快速隧道，把播放器映射到一个 https://xxx.trycloudflare.com 地址

电脑和手机不需要在同一个 Wi-Fi，手机用移动数据也能访问。
电脑上的这个窗口需要保持开启；关闭窗口就停止远程访问。
"""

from __future__ import annotations

import collections
import ctypes
import html
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import quote

BASE_DIR = Path(__file__).resolve().parent
TOOLS_DIR = BASE_DIR / "tools"
VENDOR_DIR = TOOLS_DIR / "vendor"
CLOUDFLARED = TOOLS_DIR / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
CONFIG_PATH = BASE_DIR / ".remote-access.json"
STATUS_PATH = TOOLS_DIR / "remote-access.html"
PLAYER_LOG = TOOLS_DIR / "player.log"
TUNNEL_LOG = TOOLS_DIR / "tunnel.log"
DEFAULT_PORT = 8765
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
CF_DOWNLOAD_URLS = [
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
]
TUNNEL_TIMEOUT = 50


# ---------------------------------------------------------------------------
# 控制台输出
# ---------------------------------------------------------------------------

def log(message: str = "") -> None:
    print(message, flush=True)


def print_rule(char: str = "=") -> None:
    log("  " + char * 60)


# ---------------------------------------------------------------------------
# 配置：访问码、会话密钥、端口
# ---------------------------------------------------------------------------

def load_config() -> dict:
    data: dict = {}
    if CONFIG_PATH.exists():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
        except (OSError, ValueError):
            log("  ! 远程访问配置文件损坏，已重新生成。")

    changed = False
    code = str(data.get("code") or "").strip()
    if len(code) < 4:
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        data["code"] = code
        changed = True
    if not str(data.get("secret") or "").strip():
        data["secret"] = secrets.token_urlsafe(32)
        changed = True
    try:
        port = int(data.get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    if not 1024 <= port <= 65535:
        port = DEFAULT_PORT
    if data.get("port") != port:
        data["port"] = port
        changed = True
    if "preventSleep" not in data:
        data["preventSleep"] = True
        changed = True

    if changed:
        save_config(data)
    return data


def save_config(data: dict) -> None:
    try:
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)
    except OSError as exc:
        log(f"  ! 无法保存远程访问配置：{exc}")


# ---------------------------------------------------------------------------
# 端口与健康检查
# ---------------------------------------------------------------------------

def pick_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        if port > 65535:
            break
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口，请关闭占用 8765 附近端口的程序。")


def http_ok(url: str, timeout: float = 3.0) -> bool:
    request = urllib.request.Request(url, headers={"User-Agent": "Soundfield/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def wait_local_player(port: int, process: subprocess.Popen, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    health = f"http://127.0.0.1:{port}/api/health"
    while time.time() < deadline:
        if process.poll() is not None:
            return False
        if http_ok(health, timeout=1.0):
            return True
        time.sleep(0.2)
    return False


# ---------------------------------------------------------------------------
# cloudflared：校验 / 自动下载
# ---------------------------------------------------------------------------

def _valid_cloudflared() -> bool:
    version_file = TOOLS_DIR / "cloudflared-version.txt"
    try:
        if not CLOUDFLARED.is_file() or CLOUDFLARED.stat().st_size < 8 * 1024 * 1024:
            return False
        TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        with open(version_file, "w", encoding="utf-8", errors="replace") as handle:
            result = subprocess.run(
                [str(CLOUDFLARED), "--version"],
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=20,
            )
        text = version_file.read_text(encoding="utf-8", errors="replace").lower()
        return result.returncode == 0 and "cloudflared" in text
    except Exception:
        return False
    finally:
        try:
            version_file.unlink()
        except OSError:
            pass


def ensure_cloudflared() -> str:
    if os.name != "nt":
        found = shutil_which("cloudflared")
        if found:
            return found
        if _valid_cloudflared():
            return str(CLOUDFLARED)
        raise RuntimeError("没有找到 cloudflared，请先安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")

    if _valid_cloudflared():
        return str(CLOUDFLARED)

    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    part = CLOUDFLARED.with_name("cloudflared.download")
    log("  正在准备隧道组件（约 55 MB，只需要下载一次）...")
    errors = []
    for url in CF_DOWNLOAD_URLS:
        try:
            log(f"  下载中：{url.split('/')[2]}")
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as handle:
                total = int(response.headers.get("Content-Length") or 0)
                done = 0
                next_mark = 0
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if done - next_mark >= 10 * 1024 * 1024:
                        next_mark = done
                        percent = f"  {done * 100 // total}%" if total else ""
                        log(f"    {done / 1048576:5.1f} MB{percent}")
            os.replace(part, CLOUDFLARED)
            if _valid_cloudflared():
                log("  隧道组件已准备好。")
                return str(CLOUDFLARED)
            errors.append("下载完成但文件无法运行")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{type(exc).__name__}: {exc}")
            log(f"  这次下载失败：{type(exc).__name__}")
            try:
                part.unlink()
            except OSError:
                pass

    raise RuntimeError(
        "无法下载 cloudflared（Cloudflare 隧道组件）。\n"
        "  请检查网络后重试，或手动下载后放到：\n"
        f"  {CLOUDFLARED}\n"
        "  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe\n"
        f"  详细错误：{' | '.join(errors[-2:])}"
    )


def shutil_which(name: str) -> str | None:
    import shutil
    return shutil.which(name)


# ---------------------------------------------------------------------------
# 阻止电脑自动睡眠（屏幕仍然可以关闭）
# ---------------------------------------------------------------------------

def set_prevent_sleep(enabled: bool) -> None:
    if os.name != "nt":
        return
    try:
        ES_CONTINUOUS = 0x80000000
        ES_SYSTEM_REQUIRED = 0x00000001
        flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if enabled else 0)
        ctypes.windll.kernel32.SetThreadExecutionState(flags)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Windows Job Object：父进程退出时一起结束播放器和隧道，避免留下僵尸进程
# ---------------------------------------------------------------------------

class KillOnCloseJob:
    def __init__(self) -> None:
        self.handle = None
        self._kernel32 = None
        self._open_process = None
        if os.name != "nt":
            return
        try:
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            size_t = ctypes.c_size_t

            class BasicLimit(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", size_t),
                    ("MaximumWorkingSetSize", size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class IoCounters(ctypes.Structure):
                _fields_ = [
                    ("ReadOperationCount", ctypes.c_uint64),
                    ("WriteOperationCount", ctypes.c_uint64),
                    ("OtherOperationCount", ctypes.c_uint64),
                    ("ReadTransferCount", ctypes.c_uint64),
                    ("WriteTransferCount", ctypes.c_uint64),
                    ("OtherTransferCount", ctypes.c_uint64),
                ]

            class ExtendedLimit(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", BasicLimit),
                    ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", size_t),
                    ("JobMemoryLimit", size_t),
                    ("PeakProcessMemoryUsed", size_t),
                    ("PeakJobMemoryUsed", size_t),
                ]

            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel32.SetInformationJobObject.argtypes = [
                wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
            ]
            kernel32.SetInformationJobObject.restype = wintypes.BOOL
            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                return
            info = ExtendedLimit()
            info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                kernel32.CloseHandle(handle)
                return
            self._kernel32 = kernel32
            self._open_process = kernel32.OpenProcess
            self.handle = handle
        except Exception:
            self.handle = None

    def assign(self, pid: int) -> None:
        if not self.handle or not self._open_process:
            return
        try:
            PROCESS_SET_QUOTA = 0x0100
            PROCESS_TERMINATE = 0x0001
            process = self._open_process(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, int(pid))
            if process:
                self._kernel32.AssignProcessToJobObject(self.handle, process)
                self._kernel32.CloseHandle(process)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 隧道
# ---------------------------------------------------------------------------

class Tunnel:
    def __init__(self, port: int, cloudflared: str) -> None:
        self.port = port
        self.cloudflared = cloudflared
        self.process: subprocess.Popen | None = None
        self.url: str | None = None
        self.ready = threading.Event()
        self.connected = threading.Event()
        self.lines: collections.deque[str] = collections.deque(maxlen=40)
        self._reader: threading.Thread | None = None
        self._stop = threading.Event()
        self._log_handle = None
        self._offset = 0
        self._partial = ""

    def start(self) -> None:
        TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        self._stop.clear()
        self._offset = 0
        self._partial = ""
        self._log_handle = open(TUNNEL_LOG, "wb")
        try:
            self.process = subprocess.Popen(
                [
                    self.cloudflared,
                    "tunnel",
                    "--url", f"http://127.0.0.1:{self.port}",
                    "--no-autoupdate",
                    "--loglevel", "info",
                ],
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                creationflags=0,
            )
        except Exception:
            self._log_handle.close()
            self._log_handle = None
            raise
        self._reader = threading.Thread(target=self._pump, name="tunnel-reader", daemon=True)
        self._reader.start()

    def _handle_line(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        self.lines.append(line)
        match = URL_RE.search(line)
        if match and not self.url:
            self.url = match.group(0)
            self.ready.set()
            return
        if "Registered tunnel connection" in line:
            self.connected.set()
            return
        lowered = line.lower()
        if ("err" in lowered or "failed" in lowered) and "precheck" not in lowered:
            log(f"  [隧道] {line[:240]}")

    def _read_new(self) -> None:
        try:
            with open(TUNNEL_LOG, "rb") as handle:
                handle.seek(self._offset)
                data = handle.read()
                self._offset += len(data)
        except OSError:
            return
        if not data:
            return
        self._partial += data.decode("utf-8", errors="replace")
        while "\n" in self._partial:
            line, self._partial = self._partial.split("\n", 1)
            self._handle_line(line)

    def _pump(self) -> None:
        while not self._stop.is_set():
            self._read_new()
            if self.process and self.process.poll() is not None:
                self._read_new()
                if self._partial:
                    self._handle_line(self._partial)
                    self._partial = ""
                break
            self._stop.wait(0.25)

    def wait_url(self, timeout: float = TUNNEL_TIMEOUT) -> str | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.ready.wait(0.5):
                return self.url
            if self.process and self.process.poll() is not None:
                return None
        return None

    def tail(self, count: int = 8) -> str:
        return "\n".join(list(self.lines)[-count:])

    def stop(self) -> None:
        self._stop.set()
        process = self.process
        if process and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        if self._reader and self._reader.is_alive():
            self._reader.join(timeout=2)
        if self._log_handle:
            try:
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None


# ---------------------------------------------------------------------------
# 状态页 / 二维码
# ---------------------------------------------------------------------------

def make_qr_data_uri(text: str) -> str:
    try:
        vendor = str(VENDOR_DIR)
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        import segno  # type: ignore

        qr = segno.make(text, error="m")
        # PNG 比 SVG data URI 在 iOS Safari 上兼容性更稳
        return qr.png_data_uri(scale=8, border=2, dark="#141311", light="#ffffff")
    except Exception:
        return ""


STATUS_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f7f7f3">
<title>手机访问 · 声场</title>
<style>
  :root {
    --bg: #f4f3ee; --panel: #fff; --text: #171716; --soft: #55554f;
    --muted: #8c8c83; --line: #e8e7e0; --ink: #161512;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 34px 18px 44px; color: var(--text); background: var(--bg);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC",
      "Microsoft YaHei", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased;
  }
  .wrap { width: min(880px, 100%); margin: 0 auto; }
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
  .eyebrow { margin: 0 0 7px; color: var(--muted); font-size: 9px; font-weight: 650; letter-spacing: .3em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(26px, 4.6vw, 38px); font-weight: 650; letter-spacing: -.02em; }
  .sub { margin: 9px 0 0; color: var(--soft); font-size: 12.5px; line-height: 1.7; }
  .pill { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 29px; padding: 0 12px; margin-bottom: 4px; color: #2d6a46; border: 1px solid #cfe4d7; border-radius: 999px; background: #f3faf5; font-size: 10px; font-weight: 600; }
  .pill i { width: 6px; height: 6px; border-radius: 50%; background: #3b9a63; box-shadow: 0 0 0 3px rgba(59,154,99,.13); }
  .card { display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 28px; padding: 28px; border: 1px solid rgba(255,255,255,.9); border-radius: 22px; background: rgba(255,255,255,.88); box-shadow: 0 30px 80px -48px rgba(30,28,22,.4), 0 0 0 1px rgba(23,23,22,.035); }
  .qr-box { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px; border: 1px solid var(--line); border-radius: 16px; background: #fff; }
  .qr-box img { width: 100%; height: auto; display: block; image-rendering: crisp-edges; }
  .qr-note { margin: 10px 0 0; color: var(--muted); font-size: 9px; letter-spacing: .08em; }
  .label { margin: 0 0 7px; color: var(--muted); font-size: 9px; font-weight: 650; letter-spacing: .18em; text-transform: uppercase; }
  .url-box { padding: 13px 15px; border: 1px solid var(--line); border-radius: 12px; background: #f8f8f4; color: var(--ink); font-size: 13.5px; font-weight: 550; line-height: 1.6; word-break: break-all; }
  .code-row { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
  .code-box { flex: 1; height: 52px; display: flex; align-items: center; justify-content: center; border: 1px dashed #d8d7cf; border-radius: 12px; background: #fbfbf8; font-size: 27px; font-weight: 650; letter-spacing: .38em; font-variant-numeric: tabular-nums; }
  .btns { display: flex; gap: 9px; margin-top: 15px; }
  button { height: 40px; padding: 0 16px; border: 1px solid var(--ink); border-radius: 10px; background: var(--ink); color: #fff; font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .03em; cursor: pointer; }
  button.ghost { border-color: var(--line); background: #fff; color: var(--text); }
  button:active { transform: scale(.98); }
  .steps { margin: 22px 0 0; padding: 0; list-style: none; counter-reset: step; }
  .steps li { position: relative; padding: 0 0 11px 28px; color: var(--soft); font-size: 12px; line-height: 1.75; }
  .steps li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 1px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: #efeee8; color: var(--muted); font-size: 9px; font-weight: 650; }
  .steps b { color: var(--text); font-weight: 600; }
  .warn { display: flex; gap: 10px; margin-top: 18px; padding: 12px 14px; border: 1px solid #f0e1c9; border-radius: 11px; background: #fdf9f1; color: #735b31; font-size: 11px; line-height: 1.7; }
  .warn svg { flex: none; width: 15px; height: 15px; margin-top: 1px; }
  .foot { margin: 20px 0 0; color: var(--muted); font-size: 10px; line-height: 1.7; }
  a { color: inherit; }
  .toast { position: fixed; left: 50%; bottom: 24px; padding: 10px 18px; border-radius: 999px; background: #171716; color: #fff; font-size: 11px; opacity: 0; transform: translate(-50%, 10px); transition: .2s; pointer-events: none; }
  .toast.on { opacity: 1; transform: translate(-50%, 0); }
  @media (max-width: 720px) {
    body { padding: 24px 14px 34px; }
    .top { align-items: flex-start; flex-direction: column; gap: 12px; }
    .pill { margin: 0; }
    .card { grid-template-columns: 1fr; gap: 20px; padding: 20px; }
    .qr-box { width: min(260px, 100%); margin: 0 auto; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <p class="eyebrow">Soundfield · Remote</p>
      <h1>手机远程访问已开启</h1>
      <p class="sub">手机用 Wi-Fi 或移动数据都可以，不需要和电脑在同一个网络。</p>
    </div>
    <span class="pill"><i></i>正在运行</span>
  </div>

  <section class="card">
    <div class="qr-box">
      __QR__
      <p class="qr-note">用手机相机扫码</p>
    </div>
    <div>
      <p class="label">手机访问地址</p>
      <div class="url-box" id="urlText">__URL__</div>
      <div class="code-row">
        <div class="code-box" id="codeText">__CODE__</div>
      </div>
      <div class="btns">
        <button id="copyUrl" data-label="复制链接">复制链接</button>
        <button class="ghost" id="copyCode" data-label="复制访问码">复制访问码</button>
        <button class="ghost" id="openLocal">在电脑上打开</button>
      </div>
      <ol class="steps">
        <li>手机扫描左边的二维码，或把上面的链接发到手机（微信、备忘录都可以）。</li>
        <li>扫码会自动登录；手动打开时需要输入 <b>访问码 __CODE__</b>。</li>
        <li>登录后在浏览器菜单里选择 <b>「添加到主屏幕」</b>，以后点图标就能听。</li>
        <li>刚生成的新链接如果暂时打不开，等 10–30 秒再扫一次即可。</li>
      </ol>
      <div class="warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v5m0 3.5h.01"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke-linejoin="round"/></svg>
        <span>这个窗口需要保持开启，关闭后远程访问就会停止。电脑重启或重新打开后，链接会变成新的，重新扫码即可。</span>
      </div>
    </div>
  </section>

  <p class="foot">访问码只保存在这台电脑上（.remote-access.json）。音频不会上传到任何服务器，手机直接播放电脑上的文件；公网链路经由 Cloudflare 加密转发。<br>页面生成于 __TIME__ · 本机端口 __PORT__</p>
</div>

<div class="toast" id="toast">已复制</div>
<script>
  const urlText = document.getElementById('urlText').textContent.trim();
  const codeText = document.getElementById('codeText').textContent.trim();
  const toast = document.getElementById('toast');
  let toastTimer = 0;
  function notify(text) {
    toast.textContent = text;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      return ok;
    }
  }
  document.getElementById('copyUrl').addEventListener('click', async () => {
    const ok = await copyText(urlText);
    notify(ok ? '链接已复制' : '复制失败，请手动选中链接');
  });
  document.getElementById('copyCode').addEventListener('click', async () => {
    const ok = await copyText(codeText);
    notify(ok ? '访问码已复制' : '复制失败，请手动选中访问码');
  });
  document.getElementById('openLocal').addEventListener('click', () => {
    window.open('__LOCAL_URL__', '_blank');
  });
</script>
</body>
</html>
"""


def write_status_page(url: str, code: str, port: int) -> bool:
    login_url = f"{url.rstrip('/')}/?code={quote(str(code), safe='')}"
    qr = make_qr_data_uri(login_url)
    if qr:
        qr_html = f'<img src="{qr}" alt="手机扫码访问">'
    else:
        qr_html = '<p class="qr-note">二维码组件缺失，请手动输入链接</p>'
    page = (
        STATUS_TEMPLATE
        .replace("__QR__", qr_html)
        .replace("__URL__", html.escape(url, quote=True))
        .replace("__CODE__", html.escape(str(code), quote=True))
        .replace("__TIME__", time.strftime("%Y-%m-%d %H:%M"))
        .replace("__PORT__", str(port))
        .replace("__LOCAL_URL__", f"http://127.0.0.1:{port}/")
    )
    try:
        TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        STATUS_PATH.write_text(page, encoding="utf-8")
        return True
    except OSError as exc:
        log(f"  ! 无法写入二维码页面：{exc}")
        return False


def open_status_page() -> None:
    try:
        if os.name == "nt":
            os.startfile(str(STATUS_PATH))  # type: ignore[attr-defined]
        else:
            webbrowser.open(STATUS_PATH.as_uri())
    except Exception:
        pass


def copy_to_clipboard(text: str) -> bool:
    if os.name != "nt":
        return False
    path = TOOLS_DIR / "_clipboard.txt"
    try:
        TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="ascii", errors="ignore")
        with open(path, "rb") as handle:
            result = subprocess.run(["clip"], stdin=handle, timeout=5)
        return result.returncode == 0
    except Exception:
        return False
    finally:
        try:
            path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 播放器进程
# ---------------------------------------------------------------------------

def start_player(port: int, code: str, secret: str) -> tuple[subprocess.Popen, object]:
    env = os.environ.copy()
    env.update({
        "SOUNDFIELD_HOST": "127.0.0.1",
        "SOUNDFIELD_PORT": str(port),
        "SOUNDFIELD_ACCESS_CODE": code,
        "SOUNDFIELD_SECRET_KEY": secret,
        "SOUNDFIELD_HTTPS": "1",
        "SOUNDFIELD_NO_BROWSER": "1",
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = open(PLAYER_LOG, "w", encoding="utf-8", errors="replace")
    process = subprocess.Popen(
        [sys.executable, "-u", str(BASE_DIR / "app.py")],
        cwd=str(BASE_DIR),
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        creationflags=0,
    )
    return process, log_handle


def stop_process(process: subprocess.Popen | None) -> None:
    if not process or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def tail_player_log(lines: int = 14) -> str:
    try:
        content = PLAYER_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(content[-lines:])
    except OSError:
        return ""


def print_banner(url: str, code: str, copied: bool) -> None:
    log("")
    print_rule()
    log("  声场 · 手机远程访问已开启")
    log("")
    log(f"  手机地址   {url}")
    log(f"  访问码     {code}")
    log("")
    log("  手机和电脑不需要在同一个 Wi-Fi。")
    log("  已在浏览器打开二维码页面（tools/remote-access.html）。")
    log("  手机扫一下就能用；刚启动的新链接有时要等 10–30 秒。")
    if copied:
        log("  链接已复制到剪贴板，也可以发到微信/备忘录再打开。")
    log("")
    log("  这个窗口保持开启；按 Ctrl+C 停止远程访问。")
    print_rule()
    log("")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def run() -> int:
    log("")
    print_rule()
    log("  声场 · SOUNDFIELD 手机远程访问")
    print_rule()
    log("")

    try:
        cloudflared = ensure_cloudflared()
    except RuntimeError as exc:
        log(f"  ✗ {exc}")
        return 1

    config = load_config()
    code = str(config["code"])
    secret = str(config["secret"])
    try:
        port = pick_port(int(config.get("port") or DEFAULT_PORT))
    except RuntimeError as exc:
        log(f"  ✗ {exc}")
        return 1
    if port != int(config.get("port") or DEFAULT_PORT):
        log(f"  ! 默认端口被占用，改用 {port} 端口（不影响手机访问）")

    log(f"  正在启动播放器（本机端口 {port}）...")
    player, player_log = start_player(port, code, secret)
    job = KillOnCloseJob()
    job.assign(player.pid)
    if not wait_local_player(port, player):
        log("  ✗ 播放器启动失败。")
        detail = tail_player_log()
        if detail:
            log("  播放器日志最后几行：")
            log(detail)
        stop_process(player)
        player_log.close()
        return 1
    log("  播放器已就绪。")
    if config.get("preventSleep", True):
        set_prevent_sleep(True)
        log("  已阻止电脑自动睡眠（屏幕仍可正常关闭）。")

    tunnel: Tunnel | None = None
    failed_rounds = 0
    try:
        while True:
            tunnel = Tunnel(port, cloudflared)
            log("  正在建立公网链接 ...")
            tunnel.start()
            job.assign(tunnel.process.pid)
            url = tunnel.wait_url()

            if not url:
                failed_rounds += 1
                log("  ✗ 公网链接没有建立成功。")
                tail = tunnel.tail(6)
                if tail:
                    log(tail)
                tunnel.stop()
                if player.poll() is not None:
                    log("  ✗ 播放器意外退出。")
                    break
                if failed_rounds >= 4:
                    log("  连续多次失败，可能是网络无法连接 Cloudflare。")
                    log("  请检查网络/代理后重新打开「启动远程访问.cmd」。")
                    return 1
                wait = min(20, 4 * failed_rounds)
                log(f"  {wait} 秒后重试 ...")
                time.sleep(wait)
                continue

            failed_rounds = 0
            write_status_page(url, code, port)
            copied = False
            if os.environ.get("SOUNDFIELD_NO_CLIPBOARD") != "1":
                copied = copy_to_clipboard(url)
            if os.environ.get("SOUNDFIELD_NO_OPEN") != "1":
                open_status_page()
            print_banner(url, code, copied)
            if tunnel.connected.wait(8):
                log("  ✓ 隧道连接已建立。")
            else:
                log("  ! 隧道还在连接中；手机如果打不开，稍等 1–2 分钟再试。")

            while True:
                if player.poll() is not None:
                    log("  ✗ 播放器已退出，正在停止远程访问。")
                    raise SystemExit(0)
                if tunnel.process and tunnel.process.poll() is not None:
                    log("  ! 公网链接断开了，正在重新连接（地址会变化）...")
                    break
                time.sleep(1)

            tunnel.stop()
            time.sleep(2)
    except KeyboardInterrupt:
        log("")
        log("  正在停止 ...")
        return 0
    except SystemExit:
        return 0
    finally:
        if tunnel:
            tunnel.stop()
        stop_process(player)
        try:
            player_log.close()
        except Exception:
            pass
        set_prevent_sleep(False)


def main() -> None:
    try:
        code = run()
    except KeyboardInterrupt:
        log("")
        log("  已停止远程访问。")
        code = 0
    except Exception as exc:  # noqa: BLE001
        log("")
        log(f"  ✗ 远程访问启动失败：{type(exc).__name__}: {exc}")
        code = 1
    raise SystemExit(code)


if __name__ == "__main__":
    main()
