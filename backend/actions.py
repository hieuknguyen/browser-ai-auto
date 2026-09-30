"""Validated JSON actions shared by the deterministic runner and Gemini agent."""
from __future__ import annotations

import contextlib
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit

from playwright.async_api import Locator, Page, expect

from .browser import BrowserManager, BrowserPage


def resolve_locator(page: Page, target: dict) -> Locator:
    scope = page
    for frame in target.get("frames", []):
        scope = scope.frame_locator(frame)
    strategy, exact = target["strategy"], target.get("exact", True)
    if strategy == "role":
        options = {"exact": exact}
        if "name" in target:
            options["name"] = target["name"]
        locator = scope.get_by_role(target["role"], **options)
    elif strategy == "label":
        locator = scope.get_by_label(target["label"], exact=exact)
    elif strategy == "testId":
        locator = scope.get_by_test_id(target["testId"])
    elif strategy == "text":
        locator = scope.get_by_text(target["text"], exact=exact)
    elif strategy == "css":
        locator = scope.locator(target["selector"])
    else:
        raise ValueError("Unsupported locator strategy")
    return locator.nth(target["nth"]) if target.get("nth") is not None else locator.first


async def target_position(page: Page, target: dict, timeout: int = 10_000) -> dict:
    if target["strategy"] == "coordinates":
        viewport = await page.evaluate("() => ({width:innerWidth,height:innerHeight})")
        x, y = target["x"], target["y"]
        if not (0 <= x < viewport["width"] and 0 <= y < viewport["height"]):
            raise ValueError("Coordinates must be inside the current CSS viewport")
        return {"x": x, "y": y}
    locator = resolve_locator(page, target)
    await locator.wait_for(state="visible", timeout=timeout)
    await locator.scroll_into_view_if_needed(timeout=timeout)
    box = await locator.bounding_box(timeout=timeout)
    if box is None:
        raise ValueError("Target has no visible bounding box")
    # Playwright already translates frame coordinates into the top-level viewport.
    return {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}


def navigation_url(path: str, base_url: str) -> str:
    path = path.strip()
    if path.startswith("//"):
        path = "https:" + path
    elif re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/.*)?$", path):
        path = "https://" + path
    url = urljoin(base_url, path)
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Navigation requires an HTTP(S) URL without embedded credentials")
    return url


async def execute_action(manager: BrowserManager, current: BrowserPage, step: dict, base_url: str, aliases: dict | None = None, artifact_dir: Path | None = None) -> BrowserPage:
    """Own the outer action lock. Callers must not acquire current.lock first."""
    aliases = aliases if aliases is not None else {}
    session = manager.get_session(current.session_id)
    if session is None or current.page.is_closed():
        raise ValueError("Browser page is no longer available")
    action, timeout = step["action"], step.get("timeoutMs", 10_000)
    if action == "newPage":
        if step["name"] in aliases:
            raise ValueError("Page alias already exists")
        next_page = await manager.create_page(session.id)
        aliases[step["name"]] = next_page.id
        async with next_page.lock:
            if step.get("path"):
                await next_page.page.goto(navigation_url(step["path"], base_url), wait_until="domcontentloaded", timeout=timeout)
            await next_page.page.bring_to_front()
        return next_page
    if action == "switchPage":
        page_id = (next(reversed(session.pages), None) if step["page"] == "latest" else aliases.get(step["page"], step["page"]))
        next_page = session.pages.get(page_id)
        if next_page is None or next_page.page.is_closed():
            raise ValueError("Requested browser page is unavailable")
        async with next_page.lock:
            await next_page.page.bring_to_front()
        return next_page

    async with current.lock:
        page, mouse = current.page, current.mouse
        if action == "goto":
            await page.goto(navigation_url(step["path"], base_url), wait_until="domcontentloaded", timeout=timeout)
        elif action in ("click", "doubleClick", "rightClick"):
            popup_name = step.get("popup") if action == "click" else None
            if popup_name and popup_name in aliases:
                raise ValueError("Page alias already exists")

            async def click() -> None:
                button = "right" if action == "rightClick" else step.get("button", "left")
                count = 2 if action == "doubleClick" else 1
                target = step["target"]
                point = None
                with contextlib.suppress(Exception):
                    point = await target_position(page, target, timeout)
                if point:
                    await mouse.move(**point, steps=10 if mouse.mode == "watch" else 1)
                if target["strategy"] == "coordinates":
                    if not point:
                        point = await target_position(page, target, timeout)
                    await mouse.click(**point, button=button, click_count=count)
                else:
                    locator = resolve_locator(page, target)
                    try:
                        await locator.click(button=button, click_count=count, timeout=timeout)
                        if point:
                            mouse.sync_position(**point)
                            current.emit("mouse:down", **point, button=button, status="pressed", clickCount=count)
                            current.emit("mouse:up", **point, button="none", releasedButton=button, status="hovering", clickCount=count)
                    except Exception:
                        if not point:
                            point = await target_position(page, target, timeout)
                        await mouse.click(**point, button=button, click_count=count)

            if popup_name:
                async with page.expect_popup(timeout=timeout) as popup:
                    await click()
                opened = manager.register_page(session, await popup.value)
                aliases[popup_name] = opened.id
            else:
                await click()
        elif action in ("move", "hover"):
            target = step["target"]
            point = await target_position(page, target, timeout)
            await mouse.move(**point, steps=10 if mouse.mode == "watch" else 1)
            if action == "hover" and target["strategy"] != "coordinates":
                with contextlib.suppress(Exception):
                    await resolve_locator(page, target).hover(timeout=timeout)
        elif action == "fill":
            target = step["target"]
            with contextlib.suppress(Exception):
                point = await target_position(page, target, timeout)
                await mouse.move(**point, steps=8 if mouse.mode == "watch" else 1)
                await mouse.down("left")
                await mouse.up("left")
            await resolve_locator(page, target).fill(step["value"], timeout=timeout)
        elif action == "press":
            if step.get("target"):
                await resolve_locator(page, step["target"]).press(step["key"], timeout=timeout)
            else:
                await page.keyboard.press(step["key"])
            current.emit("keyboard:press", key=current.redact(step["key"]))
        elif action == "type":
            await page.keyboard.type(step["value"])
            current.emit("keyboard:typed", length=len(step["value"]))
        elif action == "down":
            await mouse.down(step.get("button", "left"))
        elif action == "up":
            await mouse.up(step.get("button", "left"))
        elif action == "wheel":
            await mouse.wheel(step.get("deltaX", 0), step["deltaY"])
        elif action == "drag":
            if step["from"]["strategy"] != "coordinates" and step["to"]["strategy"] != "coordinates":
                await resolve_locator(page, step["from"]).drag_to(resolve_locator(page, step["to"]), timeout=timeout)
                mouse.sync_position(**await target_position(page, step["to"], timeout))
            else:
                origin = await target_position(page, step["from"], timeout)
                destination = await target_position(page, step["to"], timeout)
                await mouse.drag(origin, destination, steps=step.get("steps", 20))
        elif action == "wait":
            await resolve_locator(page, step["target"]).wait_for(state=step.get("state", "visible"), timeout=timeout)
        elif action == "expectVisible":
            await expect(resolve_locator(page, step["target"])).to_be_visible(timeout=timeout)
        elif action == "expectText":
            assertion = expect(resolve_locator(page, step["target"]))
            if step.get("exact", False):
                await assertion.to_have_text(step["text"], timeout=timeout)
            else:
                await assertion.to_contain_text(step["text"], timeout=timeout)
        elif action == "select":
            await resolve_locator(page, step["target"]).select_option(step["value"], timeout=timeout)
        elif action == "screenshot":
            name = step.get("name", "screenshot")
            if not artifact_dir or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
                raise ValueError("A screenshot requires an artifact directory and a safe filename")
            directory = Path(artifact_dir)
            directory.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(directory / f"{name}.png"), caret="initial", mask=[page.locator('input,textarea,[contenteditable="true"],[data-sensitive]')], timeout=timeout)
        else:
            raise ValueError(f"Unsupported browser action: {action}")
    return current
