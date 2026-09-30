"""Real Chrome sessions, page observations and browser-scoped input.

Chrome is launched visibly by default. Each session owns an isolated browser
context; neither AI credentials nor application UI code are injected into pages.
"""
from __future__ import annotations

import asyncio
import base64
from collections import deque
import contextlib
import math
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

if sys.platform == "win32":
    import subprocess
    _orig_si_init = subprocess.STARTUPINFO.__init__
    def _si_init(self, *args, **kwargs):
        _orig_si_init(self, *args, **kwargs)
        self.lpDesktop = "WinSta0\\Default"
    subprocess.STARTUPINFO.__init__ = _si_init


def cleanup_profile_locks(profile_dir: Path) -> None:
    for lock in ("lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"):
        lock_path = profile_dir / lock
        try:
            if lock_path.exists():
                lock_path.unlink()
        except OSError:
            pass


CURSOR_HELPER_JS = """
(() => {
  function ensureCursor() {
    let c = document.getElementById('__vector_cursor__');
    if (!c && document.documentElement) {
      c = document.createElement('div');
      c.id = '__vector_cursor__';
      c.style.cssText = 'position:fixed;top:0;left:0;width:32px;height:32px;pointer-events:none;z-index:2147483647;transform:translate3d(100px,100px,0);transition:transform 0.08s cubic-bezier(0.2, 0.8, 0.2, 1);will-change:transform;';
      c.innerHTML = `<div style="position:relative;width:32px;height:32px;pointer-events:none;"><svg viewBox="0 0 24 28" width="28" height="32" style="filter:drop-shadow(0 3px 6px rgba(0,0,0,0.6));position:absolute;top:0;left:0;"><path d="M2 2L22 14.5L12.5 16.5L8.5 25L2 2Z" fill="#ff4d4d" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/></svg><div id="__vector_ripple__" style="position:absolute;top:-6px;left:-6px;width:30px;height:30px;border-radius:50%;border:2.5px solid #ff4d4d;background:rgba(255,77,77,0.4);opacity:0;transform:scale(0.4);pointer-events:none;"></div></div>`;
      document.documentElement.appendChild(c);
    }
    return c;
  }
  window.__vector_move_cursor = (x, y) => {
    const c = ensureCursor();
    if (c) c.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  window.__vector_pulse_cursor = () => {
    ensureCursor();
    const r = document.getElementById('__vector_ripple__');
    if (r) {
      r.style.transition = 'none';
      r.style.transform = 'scale(0.4)';
      r.style.opacity = '1';
      requestAnimationFrame(() => {
        r.style.transition = 'transform 0.4s ease-out, opacity 0.4s ease-out';
        r.style.transform = 'scale(3)';
        r.style.opacity = '0';
      });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureCursor);
  } else {
    ensureCursor();
  }
})()
"""


def activate_chrome_window() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        import ctypes.wintypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        target_hwnd = None

        def callback(hwnd, _):
            nonlocal target_hwnd
            if target_hwnd is not None:
                return False
            if not user32.IsWindowVisible(hwnd):
                return True
            buff = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, buff, 256)
            if buff.value == "Chrome_WidgetWin_1":
                title = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, title, 512)
                if "Chrome" in title.value and not title.value.startswith("Restore"):
                    rect = ctypes.wintypes.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rect))
                    if (rect.right - rect.left) > 400 and (rect.bottom - rect.top) > 300:
                        target_hwnd = hwnd
                        return False
            return True

        proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.c_int)(callback)
        hdesk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
            user32.EnumDesktopWindows(hdesk, proc, 0)

        if not target_hwnd:
            user32.EnumWindows(proc, 0)

        if target_hwnd:
            VK_MENU = 0x12
            KEYEVENTF_KEYUP = 0x0002
            user32.AllowSetForegroundWindow(-1)
            user32.keybd_event(VK_MENU, 0, 0, 0)
            user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
            user32.ShowWindow(target_hwnd, 3)  # SW_MAXIMIZE
            user32.BringWindowToTop(target_hwnd)
            user32.SetForegroundWindow(target_hwnd)
            user32.SwitchToThisWindow(target_hwnd, True)
    except Exception:
        pass


def is_cdp_ready(port: int = 9222) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as resp:
            return resp.status == 200
    except Exception:
        return False


async def ensure_desktop_chrome(port: int = 9222) -> bool:
    if is_cdp_ready(port):
        return True

    profile_dir = Path.home() / ".browser-ai-auto" / "chrome_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    cleanup_profile_locks(profile_dir)

    script_path = Path(__file__).resolve().parent.parent / "scripts" / "launch_chrome.bat"

    if sys.platform == "win32":
        if script_path.exists():
            try:
                subprocess.run(
                    ["schtasks", "/create", "/tn", "VectorLaunchChrome", "/tr", str(script_path), "/sc", "once", "/st", "23:59", "/f", "/it"],
                    capture_output=True,
                    timeout=5,
                )
                subprocess.run(["schtasks", "/run", "/tn", "VectorLaunchChrome"], capture_output=True, timeout=5)
            except Exception:
                pass

        # Wait up to 5 seconds for the interactive desktop Chrome launched by Task Scheduler to bind port 9222
        for _ in range(25):
            if is_cdp_ready(port):
                return True
            await asyncio.sleep(0.2)

        # Fallback only if schtasks didn't start it, and NEVER use CREATE_NO_WINDOW for a visible browser!
        if not is_cdp_ready(port):
            try:
                if script_path.exists():
                    subprocess.Popen(["cmd.exe", "/c", str(script_path)])
                else:
                    candidates = [
                        Path(os.environ.get("PROGRAMFILES", "C:\\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
                        Path(os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
                        Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
                    ]
                    chrome_bin = next((p for p in candidates if p.exists()), None)
                    if chrome_bin:
                        subprocess.Popen(
                            [
                                str(chrome_bin),
                                f"--remote-debugging-port={port}",
                                f"--user-data-dir={profile_dir}",
                                "--no-first-run",
                                "--no-default-browser-check",
                                "--disable-session-crashed-bubble",
                                "--hide-crash-restore-bubble",
                                "--disable-infobars",
                                "--start-maximized",
                                "about:blank",
                            ]
                        )
            except Exception:
                pass
    else:
        try:
            import shutil
            candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
            chrome_bin = next((shutil.which(c) for c in candidates if shutil.which(c)), None)
            if chrome_bin:
                subprocess.Popen(
                    [
                        chrome_bin,
                        f"--remote-debugging-port={port}",
                        f"--user-data-dir={profile_dir}",
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--start-maximized",
                        "about:blank",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except Exception:
            pass

    for _ in range(40):
        if is_cdp_ready(port):
            return True
        await asyncio.sleep(0.2)
    return False


def redact_diagnostics(value: str) -> str:
    value = re.sub(r"\bBearer\s+[a-zA-Z0-9._~+/=-]+", "Bearer [REDACTED]", value, flags=re.I)
    value = re.sub(r"\bAIza[\w-]{20,}\b", "[REDACTED]", value)
    value = re.sub(r"([?&](?:token|access_token|api_key|key|secret|password|authorization|code)=)[^&\s\"'<>]*", r"\1[REDACTED]", value, flags=re.I)
    value = re.sub(r"(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\b[\"']?\s*[:=]\s*[\"']?)[^\s,;\"'}]+", r"\1[REDACTED]", value, flags=re.I)
    return re.sub(r"(https?://)[^/\s@]+@", r"\1[REDACTED]@", value, flags=re.I)


class BrowserMouse:
    """Serialize mouse gestures independently, without reacquiring page.lock."""

    def __init__(self, page: Page, emit: Callable[..., None], mode: str = "fast"):
        self.page, self.emit, self.mode = page, emit, mode
        self._state = {"x": 0.0, "y": 0.0, "button": "none", "status": "idle"}
        self._held: list[str] = []
        self._lock = asyncio.Lock()

    def get_state(self) -> dict:
        return dict(self._state)

    def get_position(self) -> dict:
        return {"x": self._state["x"], "y": self._state["y"]}

    @staticmethod
    def _coordinates(x: float, y: float) -> None:
        if isinstance(x, bool) or isinstance(y, bool) or not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("Mouse coordinates and deltas must be finite numbers")

    @staticmethod
    def _button(button: str) -> None:
        if button not in ("left", "middle", "right"):
            raise ValueError("Unsupported mouse button")

    @staticmethod
    def _duration(value: float) -> None:
        if not math.isfinite(value) or not 0 <= value <= 30_000:
            raise ValueError("Input duration must be between 0 and 30000 ms")

    def _publish(self, kind: str, **extra: Any) -> None:
        self.emit(kind, **{**self.get_state(), "state": self.get_state(), **extra})

    def sync_position(self, x: float, y: float) -> None:
        self._coordinates(x, y)
        self._state.update(x=x, y=y, status="dragging" if self._held else "hovering")
        self._publish("mouse:moved")

    async def _move(self, x: float, y: float, steps: int | None = None, duration_ms: float = 0) -> None:
        self._coordinates(x, y)
        steps = steps if steps is not None else (8 if self.mode == "watch" else 1)
        if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 1000:
            raise ValueError("steps must be between 1 and 1000")
        self._duration(duration_ms)
        start = self.get_position()
        began = time.monotonic()
        for index in range(1, steps + 1):
            delay = began + duration_ms / 1000 * index / steps - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            nx = start["x"] + (x - start["x"]) * index / steps
            ny = start["y"] + (y - start["y"]) * index / steps
            await self.page.mouse.move(nx, ny)
            if hasattr(self.page, "evaluate"):
                with contextlib.suppress(Exception):
                    await self.page.evaluate(
                        f"""(() => {{
                            if (!window.__vector_move_cursor) {{ {CURSOR_HELPER_JS} }}
                            window.__vector_move_cursor?.({nx}, {ny});
                        }})()"""
                    )
            self._state.update(x=nx, y=ny, status="dragging" if self._held else "moving")
            self._publish("mouse:moved")
        if not self._held:
            self._state["status"] = "hovering"

    async def move(self, x: float, y: float, *, steps: int | None = None, duration_ms: float = 0) -> None:
        async with self._lock:
            await self._move(x, y, steps, duration_ms)

    async def _down(self, button: str = "left", click_count: int = 1) -> None:
        self._button(button)
        if button in self._held:
            raise ValueError(f"{button} mouse button is already pressed")
        await self.page.mouse.down(button=button, click_count=click_count)
        if hasattr(self.page, "evaluate"):
            with contextlib.suppress(Exception):
                await self.page.evaluate(
                    f"""(() => {{
                        if (!window.__vector_pulse_cursor) {{ {CURSOR_HELPER_JS} }}
                        window.__vector_pulse_cursor?.();
                    }})()"""
                )
        self._held.append(button)
        self._state.update(button=button, status="pressed")
        self._publish("mouse:down", button=button, clickCount=click_count)

    async def _up(self, button: str = "left", click_count: int = 1) -> None:
        self._button(button)
        try:
            await self.page.mouse.up(button=button, click_count=click_count)
        finally:
            if button in self._held:
                self._held.remove(button)
            self._state.update(button=self._held[-1] if self._held else "none", status="pressed" if self._held else "hovering")
            self._publish("mouse:up", releasedButton=button, clickCount=click_count)

    async def down(self, button: str = "left") -> None:
        async with self._lock:
            await self._down(button)

    async def up(self, button: str = "left") -> None:
        async with self._lock:
            await self._up(button)

    async def click(self, x: float, y: float, *, button: str = "left", click_count: int = 1, delay_ms: float = 0) -> None:
        self._button(button)
        if isinstance(click_count, bool) or not isinstance(click_count, int) or not 1 <= click_count <= 3:
            raise ValueError("click_count must be between 1 and 3")
        self._duration(delay_ms)
        async with self._lock:
            steps = 6 if self.mode == "watch" else 1
            await self._move(x, y, steps=steps)
            for count in range(1, click_count + 1):
                await self._down(button, count)
                try:
                    if delay_ms:
                        await asyncio.sleep(delay_ms / 1000)
                finally:
                    await self._up(button, count)

    async def double_click(self, x: float, y: float, *, button: str = "left", delay_ms: float = 0) -> None:
        await self.click(x, y, button=button, click_count=2, delay_ms=delay_ms)

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        self._coordinates(delta_x, delta_y)
        async with self._lock:
            await self.page.mouse.wheel(delta_x, delta_y)
            self._publish("mouse:wheel", deltaX=delta_x, deltaY=delta_y)

    async def drag(self, origin: dict, destination: dict, *, steps: int | None = None, duration_ms: float = 0) -> None:
        async with self._lock:
            await self._move(origin["x"], origin["y"], steps=1)
            await self._down()
            try:
                await self._move(destination["x"], destination["y"], steps if steps is not None else (20 if self.mode == "watch" else 1), duration_ms)
            finally:
                await self._up()


class BrowserPage:
    def __init__(self, session: BrowserSession, page: Page, bus: Any, on_closed: Callable[[BrowserPage], None]):
        self.id = f"page-{uuid4()}"
        self.session_id, self.page, self.bus = session.id, page, bus
        self.mode, self.run_id = session.mode, session.run_id
        self.lock = asyncio.Lock()
        self.mouse = BrowserMouse(page, self.emit, self.mode)
        self.redact: Callable[[str], str] = lambda value: redact_diagnostics(session.redact(value))
        self._on_closed = on_closed
        self._disposed = False
        self._tasks: set[asyncio.Task] = set()
        self._viewport = {**(page.viewport_size or {"width": 1920, "height": 1080}), "deviceScaleFactor": 1, "scrollX": 0, "scrollY": 0}
        self._console: deque = deque(maxlen=500)
        self._network: deque = deque(maxlen=500)
        self._requests: dict[Any, dict] = {}
        self._listeners = {
            "close": lambda _: self._closed(),
            "crash": lambda _: self.emit("page:crashed", url=self.redact(page.url)),
            "framenavigated": self._navigated,
            "load": lambda _: self._spawn(self._updated()),
            "console": lambda message: self._record_console(message.type, message.text),
            "pageerror": lambda error: self._record_console("pageerror", str(error)),
            "request": self._request,
            "response": self._response,
            "requestfinished": self._request_finished,
            "requestfailed": self._request_failed,
        }
        for event, listener in self._listeners.items():
            page.on(event, listener)

    def emit(self, kind: str, **payload: Any) -> None:
        if not self._disposed:
            self.bus.publish(kind, sessionId=self.session_id, pageId=self.id, **({"runId": self.run_id} if self.run_id else {}), **payload)

    def _spawn(self, coroutine: Any) -> None:
        if self._disposed:
            coroutine.close()
            return
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def start(self) -> None:
        if self.mode == "watch":
            self._spawn(self._frames())

    def info(self) -> dict:
        return {"id": self.id, "sessionId": self.session_id, "url": self.redact(self.page.url), "mouse": self.mouse.get_state(), "viewport": self.page.viewport_size or self._viewport}

    async def refresh_viewport(self) -> None:
        if self._disposed or self.page.is_closed():
            return
        with contextlib.suppress(Exception):
            dim = await self.page.evaluate("() => ({width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY})")
            if dim and isinstance(dim, dict):
                self._viewport = dim

    async def snapshot(self, include_screenshot: bool = True) -> dict:
        await self.refresh_viewport()
        title, accessibility = "", ""
        with contextlib.suppress(Exception):
            title = await self.page.title()
        with contextlib.suppress(Exception):
            accessibility = await self.page.locator("body").aria_snapshot(timeout=2500)
        res = {"url": self.redact(self.page.url), "title": self.redact(title), "accessibility": self.redact(accessibility[:100_000]), "viewport": self.info()["viewport"], "mouse": self.mouse.get_state()}
        if include_screenshot and hasattr(self.page, "screenshot"):
            with contextlib.suppress(Exception):
                ss = await self.page.screenshot(type="jpeg", quality=60, timeout=2500)
                res["screenshot"] = base64.b64encode(ss).decode("ascii")
        return res

    async def diagnostics(self) -> dict:
        snapshot = await self.snapshot()
        return {**snapshot, "semanticSnapshot": snapshot["accessibility"], "console": [{**item, "text": self.redact(item["text"])} for item in self._console], "network": [{**item, "url": self.redact(item["url"]), **({"error": self.redact(item["error"])} if "error" in item else {})} for item in self._network]}

    async def _updated(self) -> None:
        await self.refresh_viewport()
        self.emit("page:updated", page=self.info(), url=self.redact(self.page.url))

    async def _safe_inject_cursor(self) -> None:
        with contextlib.suppress(Exception):
            await self.page.evaluate(CURSOR_HELPER_JS)

    def _navigated(self, frame: Any) -> None:
        if frame == self.page.main_frame:
            self._spawn(self._updated())
            if self.mode == "watch" and hasattr(self.page, "evaluate"):
                self._spawn(self._safe_inject_cursor())

    def _record_console(self, kind: str, text: str) -> None:
        self._console.append({"timestamp": int(time.time() * 1000), "type": kind, "text": self.redact(text[:16_000])})
        self.emit("page:console", consoleType=kind)

    def _request(self, request: Any) -> None:
        entry = {"timestamp": int(time.time() * 1000), "method": request.method, "url": self.redact(request.url), "resourceType": request.resource_type}
        self._requests[request] = entry
        self._network.append(entry)
        # A never-finishing stream must not grow the request lookup indefinitely.
        if len(self._requests) > 500:
            self._requests.pop(next(iter(self._requests)))

    def _response(self, response: Any) -> None:
        if entry := self._requests.get(response.request):
            entry["status"] = response.status

    def _request_finished(self, request: Any) -> None:
        if entry := self._requests.pop(request, None):
            entry["durationMs"] = int(time.time() * 1000) - entry["timestamp"]

    def _request_failed(self, request: Any) -> None:
        if entry := self._requests.get(request):
            entry["error"] = self.redact(request.failure or "Request failed")
        self._request_finished(request)

    async def _frames(self) -> None:
        while not self._disposed and not self.page.is_closed():
            try:
                if self.bus.queues:
                    await self.refresh_viewport()
                    # Do not pass scale="css"; native device scale avoids deviceScaleFactor mutation and screen flicker
                    data = await self.page.screenshot(type="jpeg", quality=55, caret="initial", timeout=2500)
                    self.emit("browser:frame", data=base64.b64encode(data).decode("ascii"), mimeType="image/jpeg", viewport=self.info()["viewport"])
            except Exception:
                pass  # Navigation can interrupt a frame; the next iteration retries.
            await asyncio.sleep(0.5)

    def _closed(self) -> None:
        if self._disposed:
            return
        self.emit("page:closed")
        self.dispose()
        self._on_closed(self)

    def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        for task in self._tasks:
            task.cancel()
        for event, listener in self._listeners.items():
            self.page.remove_listener(event, listener)
        self._requests.clear()


class BrowserSession:
    def __init__(self, context: BrowserContext, environment: str, mode: str, run_id: str | None):
        self.id = f"session-{uuid4()}"
        self.context, self.environment, self.mode, self.run_id = context, environment, mode, run_id
        self.redact: Callable[[str], str] = lambda value: value
        self.pages: dict[str, BrowserPage] = {}

    def info(self) -> dict:
        return {"id": self.id, "environment": self.environment, "mode": self.mode, "pages": [page.info() for page in self.pages.values()], **({"runId": self.run_id} if self.run_id else {})}


class BrowserManager:
    def __init__(self, bus: Any, headless: bool = False, channel: str = "chrome", executable_path: str | None = None):
        self.bus, self.headless, self.channel, self.executable_path = bus, headless, channel, executable_path
        self.browser: Browser | None = None
        self._cdp_browser: Browser | None = None
        self._playwright: Any = None
        self._sessions: dict[str, BrowserSession] = {}
        self._pages: dict[str, BrowserPage] = {}
        self._page_lookup: dict[Page, BrowserPage] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._closing = False

    async def _ensure_playwright(self) -> None:
        if self._playwright is None:
            self._playwright = await async_playwright().start()

    async def _get_cdp_browser(self) -> Browser | None:
        if self._cdp_browser and self._cdp_browser.is_connected():
            return self._cdp_browser
        ready = await ensure_desktop_chrome()
        if not ready:
            return None
        await self._ensure_playwright()
        try:
            self._cdp_browser = await self._playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
            self._cdp_browser.on("disconnected", lambda _: self._cdp_disconnected())
            return self._cdp_browser
        except Exception:
            self._cdp_browser = None
            return None

    def _cdp_disconnected(self) -> None:
        self._cdp_browser = None

    async def start(self) -> None:
        async with self._lifecycle_lock:
            if self._closing:
                raise RuntimeError("Browser manager is closing")
            if self.browser and self.browser.is_connected():
                return
            await self._ensure_playwright()
            try:
                launch_options: dict = {"headless": self.headless}
                if self.executable_path:
                    launch_options["executable_path"] = self.executable_path
                else:
                    launch_options["channel"] = self.channel
                if not self.headless:
                    launch_options["args"] = [
                        "--no-default-browser-check",
                        "--no-first-run",
                        "--start-maximized",
                    ]
                    launch_options["ignore_default_args"] = ["--no-startup-window"]
                self.browser = await self._playwright.chromium.launch(**launch_options)
            except Exception as error:
                if self._playwright:
                    await self._playwright.stop()
                    self._playwright = None
                raise RuntimeError("Could not open Google Chrome. Install Chrome or set CHROME_EXECUTABLE_PATH to its executable. " + redact_diagnostics(str(error))) from error
            browser = self.browser
            browser.on("disconnected", lambda _: self._disconnected(browser))
            self.bus.publish("browser:launched", version=browser.version, channel=self.channel, headless=self.headless)

    def _disconnected(self, browser: Browser) -> None:
        if self.browser is browser:
            self.browser = None
        self.bus.publish("browser:disconnected")

    async def create_session(self, environment: str = "local", mode: str = "watch", run_id: str | None = None, viewport: dict | None = None, guard: Any = None) -> BrowserSession:
        if mode not in ("fast", "watch"):
            raise ValueError("Unsupported execution mode")

        context = None
        if not self.headless:
            cdp_browser = await self._get_cdp_browser()
            if cdp_browser:
                try:
                    if cdp_browser.contexts:
                        context = cdp_browser.contexts[0]
                    else:
                        context_opts: dict = {}
                        if viewport:
                            context_opts["viewport"] = viewport
                        else:
                            context_opts["no_viewport"] = True
                        context = await cdp_browser.new_context(**context_opts)
                except Exception:
                    context = None

        if context is None:
            if environment == "ai" and not self.headless:
                await self._ensure_playwright()
                session_id = f"session-{uuid4()}"
                profile_dir = Path.home() / ".browser-ai-auto" / "chrome_profile"
                profile_dir.mkdir(parents=True, exist_ok=True)
                cleanup_profile_locks(profile_dir)
                launch_args = [
                    "--start-maximized",
                    "--no-default-browser-check",
                    "--no-first-run",
                    "--disable-session-crashed-bubble",
                    "--hide-crash-restore-bubble",
                    "--disable-infobars",
                ]
                launch_opts: dict = {
                    "user_data_dir": str(profile_dir),
                    "headless": False,
                    "args": launch_args,
                    "accept_downloads": False,
                    "no_viewport": True if viewport is None else False,
                    "viewport": viewport,
                }
                if self.executable_path:
                    launch_opts["executable_path"] = self.executable_path
                else:
                    launch_opts["channel"] = self.channel
                try:
                    context = await self._playwright.chromium.launch_persistent_context(**launch_opts)
                except Exception:
                    isolated_dir = Path.home() / ".browser-ai-auto" / "profiles" / session_id
                    isolated_dir.mkdir(parents=True, exist_ok=True)
                    cleanup_profile_locks(isolated_dir)
                    launch_opts["user_data_dir"] = str(isolated_dir)
                    context = await self._playwright.chromium.launch_persistent_context(**launch_opts)
            else:
                await self.start()
                browser = self.browser
                if self._closing or not browser or not browser.is_connected():
                    raise RuntimeError("Browser manager is closing")
                context_opts = {"viewport": viewport} if viewport else ({"no_viewport": True} if not self.headless else {"viewport": {"width": 1280, "height": 800}})
                context = await browser.new_context(accept_downloads=False, **context_opts)

        try:
            if guard:
                await guard.install(context)
        except BaseException:
            await context.close()
            raise

        session = BrowserSession(context, environment, mode, run_id)
        if mode == "watch" and hasattr(context, "add_init_script"):
            with contextlib.suppress(Exception):
                await context.add_init_script(CURSOR_HELPER_JS)
        self._sessions[session.id] = session
        context.on("page", lambda page: self.register_page(session, page))
        context.on("close", lambda _: self._session_closed(session))
        self.bus.publish("session:created", sessionId=session.id, **({"runId": run_id} if run_id else {}), session=session.info())
        for page in context.pages:
            self.register_page(session, page)
        activate_chrome_window()
        return session

    def register_page(self, session: BrowserSession, page: Page) -> BrowserPage:
        if page in self._page_lookup:
            return self._page_lookup[page]

        def closed(entry: BrowserPage) -> None:
            session.pages.pop(entry.id, None)
            self._pages.pop(entry.id, None)
            self._page_lookup.pop(entry.page, None)

        async def _safe_eval() -> None:
            with contextlib.suppress(Exception):
                await page.evaluate(CURSOR_HELPER_JS)

        entry = BrowserPage(session, page, self.bus, closed)
        if session.mode == "watch" and hasattr(page, "evaluate"):
            asyncio.create_task(_safe_eval())
        self._page_lookup[page] = entry
        self._pages[entry.id] = session.pages[entry.id] = entry
        entry.emit("page:created", page=entry.info())
        entry.start()
        return entry

    def get_session(self, session_id: str) -> BrowserSession | None:
        return self._sessions.get(session_id)

    def get_page(self, page_id: str) -> BrowserPage | None:
        return self._pages.get(page_id)

    def list_sessions(self) -> list[dict]:
        return [session.info() for session in self._sessions.values()]

    async def create_page(self, session_id: str) -> BrowserPage:
        session = self.get_session(session_id)
        if not session:
            raise ValueError("Browser session not found")
        for p in session.context.pages:
            if p.url in ("about:blank", "chrome://newtab/", "chrome://new-tab-page/"):
                if p not in self._page_lookup:
                    activate_chrome_window()
                    return self.register_page(session, p)
        if session.pages and len(session.pages) == 1:
            first_page = list(session.pages.values())[0]
            if first_page.page.url in ("about:blank", "chrome://newtab/", "chrome://new-tab-page/"):
                activate_chrome_window()
                return first_page
        page = await session.context.new_page()
        activate_chrome_window()
        return self.register_page(session, page)

    def _session_closed(self, session: BrowserSession) -> None:
        if session.id not in self._sessions:
            return
        for page in list(session.pages.values()):
            page._closed()
        session.pages.clear()
        self._sessions.pop(session.id, None)
        self.bus.publish("session:closed", sessionId=session.id, **({"runId": session.run_id} if session.run_id else {}))

    async def close_session(self, session_id: str) -> None:
        if session := self.get_session(session_id):
            try:
                for page in list(session.pages.values()):
                    try:
                        await page.page.close()
                    except Exception:
                        pass
                is_default_cdp = bool(self._cdp_browser and (session.context in self._cdp_browser.contexts[:1]))
                if not is_default_cdp:
                    await session.context.close()
            except Exception:
                pass
            finally:
                self._session_closed(session)

    async def close(self) -> None:
        self._closing = True
        async with self._lifecycle_lock:
            try:
                await asyncio.gather(*(self.close_session(sid) for sid in list(self._sessions)), return_exceptions=True)
                if self.browser:
                    await self.browser.close()
                if self._cdp_browser:
                    try:
                        await self._cdp_browser.close()
                    except Exception:
                        pass
            finally:
                self.browser = None
                self._cdp_browser = None
                if self._playwright:
                    await self._playwright.stop()
                    self._playwright = None
                self._closing = False
