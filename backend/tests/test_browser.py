"""Input invariants and real installed-Chrome integration checks.

Tests are headless; the application deliberately defaults to visible Chrome.
Set TEST_BROWSER_CHANNEL=chromium to use a Playwright CI browser installation.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
import pytest_asyncio

from backend.actions import execute_action, navigation_url, target_position
from backend.browser import BrowserManager, BrowserMouse, redact_diagnostics
from backend.events import EventBus


class FakeMouse:
    def __init__(self):
        self.calls = []
        self.fail_move = False

    async def move(self, x, y):
        self.calls.append(("move", x, y))
        if self.fail_move and x == 50:
            raise RuntimeError("lost page")
        await asyncio.sleep(0)

    async def down(self, **options):
        self.calls.append(("down", options))
        await asyncio.sleep(0)

    async def up(self, **options):
        self.calls.append(("up", options))

    async def wheel(self, x, y):
        self.calls.append(("wheel", x, y))


async def test_mouse_serializes_gestures_and_tracks_double_click():
    driver = FakeMouse()
    events = []
    mouse = BrowserMouse(SimpleNamespace(mouse=driver), lambda kind, **value: events.append((kind, value)))
    await asyncio.gather(mouse.double_click(20, 30), mouse.click(80, 90, button="right"))
    assert [call[0] for call in driver.calls] == ["move", "down", "up", "down", "up", "move", "down", "up"]
    assert [call[1]["click_count"] for call in driver.calls if call[0] == "down"] == [1, 2, 1]
    assert mouse.get_state() == {"x": 80, "y": 90, "button": "none", "status": "hovering"}
    assert events[-1][1]["state"]["button"] == "none"
    assert events[-1][1]["releasedButton"] == "right"


async def test_mouse_drag_releases_after_failure_and_tracks_multiple_buttons():
    driver = FakeMouse()
    mouse = BrowserMouse(SimpleNamespace(mouse=driver), lambda *args, **kwargs: None)
    driver.fail_move = True
    with pytest.raises(RuntimeError, match="lost page"):
        await mouse.drag({"x": 0, "y": 0}, {"x": 50, "y": 20}, steps=1)
    assert mouse.get_state()["button"] == "none"
    assert driver.calls[-1][0] == "up"
    await mouse.down("left")
    await mouse.down("right")
    await mouse.up("right")
    assert mouse.get_state()["button"] == "left"
    assert mouse.get_state()["status"] == "pressed"
    with pytest.raises(ValueError, match="already pressed"):
        await mouse.down("left")
    await mouse.up("left")
    with pytest.raises(ValueError, match="finite"):
        await mouse.move(float("nan"), 0)
    with pytest.raises(ValueError, match="steps"):
        await mouse.move(1, 2, steps=0)


def test_credentials_redaction_and_navigation_protocols():
    for secret in ("Bearer top-secret", "?api_key=top-secret", "password=top-secret", "AIza" + "a" * 35):
        assert "top-secret" not in redact_diagnostics(secret)
        assert "[REDACTED]" in redact_diagnostics(secret)
    assert navigation_url("/hello", "https://example.com/app") == "https://example.com/hello"
    for url in ("javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "https://user:password@example.com"):
        with pytest.raises(ValueError):
            navigation_url(url, "https://example.com")


@pytest_asyncio.fixture
async def browser():
    bus = EventBus()
    manager = BrowserManager(bus, headless=True, channel=os.getenv("TEST_BROWSER_CHANNEL", "chrome"), executable_path=os.getenv("TEST_CHROME_EXECUTABLE_PATH"))
    await manager.start()
    try:
        yield manager, bus
    finally:
        await manager.close()


HTML = """<!doctype html><html><head><title>Chrome engine fixture</title></head><body>
<label>Name <input id="name" aria-label="Name"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button>
<div id="result" role="status">Ready</div>
<button onclick="window.open('/popup','_blank')">Open popup</button>
<iframe title="Inner" src="/frame"></iframe>
<select aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option></select>
<div style="height:1800px">Scroll content</div></body></html>"""


class FixtureGuard:
    def __init__(self):
        self.initial_pages = None
        self.visits = []

    async def install(self, context):
        self.initial_pages = len(context.pages)

        async def route(request):
            self.visits.append(request.request.url)
            if request.request.url.endswith("/frame"):
                body = '<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>'
            elif request.request.url.endswith("/popup"):
                body = "<title>Popup</title><h1>Popup page</h1>"
            else:
                body = HTML
            await request.fulfill(status=200, content_type="text/html", body=body)

        await context.route("http://browser.test/**", route)


async def test_real_chrome_actions_frames_popups_and_session_isolation(browser, tmp_path):
    manager, _ = browser
    guard = FixtureGuard()
    session = await manager.create_session(mode="fast", guard=guard)
    assert guard.initial_pages == 0
    assert session.pages == {}
    page = await manager.create_page(session.id)
    aliases = {"main": page.id}

    async def action(step):
        return await asyncio.wait_for(execute_action(manager, page, step, "http://browser.test", aliases, tmp_path), 15)

    await action({"action": "goto", "path": "/"})
    await action({"action": "fill", "target": {"strategy": "label", "label": "Name"}, "value": "Ada"})
    await action({"action": "click", "target": {"strategy": "role", "role": "button", "name": "Save"}})
    await action({"action": "expectText", "target": {"strategy": "role", "role": "status"}, "text": "Ada", "exact": True})
    await action({"action": "select", "target": {"strategy": "label", "label": "Theme"}, "value": "dark"})
    assert await page.page.get_by_label("Theme").input_value() == "dark"
    await action({"action": "click", "target": {"strategy": "role", "role": "button", "name": "Frame button", "frames": ["iframe"]}})
    await action({"action": "expectVisible", "target": {"strategy": "text", "text": "Frame clicked", "frames": ["iframe"]}})
    await action({"action": "click", "target": {"strategy": "role", "role": "button", "name": "Open popup"}, "popup": "popup"})
    popup = await action({"action": "switchPage", "page": "popup"})
    assert popup.id != page.id
    assert len(session.pages) == 2
    assert await popup.page.title() == "Popup"
    await page.page.evaluate("localStorage.setItem('isolated', 'secret')")
    other = await manager.create_session(mode="fast", guard=FixtureGuard())
    other_page = await manager.create_page(other.id)
    await execute_action(manager, other_page, {"action": "goto", "path": "/"}, "http://browser.test")
    assert await other_page.page.evaluate("localStorage.getItem('isolated')") is None
    await action({"action": "screenshot", "name": "safe-shot"})
    assert (tmp_path / "safe-shot.png").stat().st_size > 100
    with pytest.raises(ValueError, match="viewport"):
        await target_position(page.page, {"strategy": "coordinates", "x": 1280, "y": 20})
    await manager.close_session(session.id)
    assert manager.get_page(page.id) is None
    assert manager.get_page(popup.id) is None
    assert manager.get_session(other.id) is other


async def test_watch_frames_do_not_mutate_dom_and_diagnostics_are_redacted(browser):
    manager, bus = browser
    queue = bus.subscribe()
    session = await manager.create_session(mode="watch", guard=FixtureGuard())
    session.redact = lambda value: value.replace("fixture-secret", "[REDACTED]")
    page = await manager.create_page(session.id)
    await execute_action(manager, page, {"action": "goto", "path": "/"}, "http://browser.test")
    await page.page.evaluate("""() => {
      window.mutations = 0;
      new MutationObserver(records => window.mutations += records.length).observe(document.body, {attributes:true,childList:true,subtree:true});
      console.log('fixture-secret api_key=hidden-token');
    }""")
    while not queue.empty():
        queue.get_nowait()

    async def next_frame():
        while True:
            event = await queue.get()
            if event["type"] == "browser:frame":
                return event

    first = await asyncio.wait_for(next_frame(), 8)
    second = await asyncio.wait_for(next_frame(), 8)
    assert first["mimeType"] == "image/jpeg"
    assert len(first["data"]) > 100
    assert second["timestamp"] - first["timestamp"] >= 300
    assert await page.page.evaluate("window.mutations") == 0
    diagnostics = await page.diagnostics()
    assert diagnostics["title"] == "Chrome engine fixture"
    assert "fixture-secret" not in str(diagnostics)
    assert "hidden-token" not in str(diagnostics)
    assert diagnostics["console"][-1]["text"].count("[REDACTED]") == 2
    bus.unsubscribe(queue)


async def test_guard_failure_leaves_no_context_or_session(browser):
    manager, _ = browser

    class RejectGuard:
        async def install(self, context):
            assert context.pages == []
            raise ValueError("fixture policy rejection")

    with pytest.raises(ValueError, match="fixture policy rejection"):
        await manager.create_session(guard=RejectGuard())
    assert manager.list_sessions() == []
    assert manager.browser.contexts == []
