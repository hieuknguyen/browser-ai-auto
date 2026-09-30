"""Environment allowlists and fail-closed production network rules."""

from __future__ import annotations

import re
import time
from collections import deque
from contextlib import suppress
from typing import Any, Callable
from urllib.parse import unquote, urljoin, urlsplit


class PolicyError(ValueError):
    """A browser action would cross the configured environment boundary."""


class Guard:
    def __init__(self, environment: dict, extra_allowed_domains: list[str] | None = None):
        self.environment = environment
        self.violations: list[PolicyError] = []
        self.on_violation: Callable[[PolicyError], None] | None = None
        self._timestamps: deque[float] = deque()
        self._domains = {
            domain.lower() for domain in [*environment.get("allowedDomains", []), *(extra_allowed_domains or [])]
        }
        try:
            self._blocked_paths = [
                re.compile(pattern, re.IGNORECASE)
                for pattern in environment.get("policy", {}).get("blockedPathPatterns", [])
            ]
        except re.error as error:
            raise PolicyError("Invalid production blocked path pattern") from error
        base_url = environment.get("baseURL", "")
        if urlsplit(base_url).scheme not in {"http", "https"}:
            raise PolicyError("Environment base URL must use HTTP or HTTPS")
        self.check_url(base_url)

    def validate(self, test: dict) -> None:
        production = self.environment.get("production", False)
        policy = self.environment.get("policy") or {}
        if production:
            if not policy.get("enabled", False):
                raise PolicyError("Production is disabled in server configuration")
            if not test.get("productionAllowed", False):
                raise PolicyError("Test must explicitly opt in to production")
            if test.get("safetyLevel") == "destructive":
                raise PolicyError("Destructive production tests are blocked")
            if policy.get("requireTestAccount", True) and (
                not policy.get("testAccount") or test.get("testAccount") != policy["testAccount"]
            ):
                raise PolicyError("Production requires the configured dedicated test account")
        for step in test.get("steps", []):
            if production and step["action"] in policy.get("blockedActions", []):
                raise PolicyError(f"Action {step['action']} is blocked in production")
            if step["action"] in {"goto", "newPage"} and step.get("path"):
                self.check_url(urljoin(self.environment["baseURL"], step["path"]))

    def check_url(self, value: str) -> str:
        try:
            if not isinstance(value, str) or re.search(r"[\x00-\x20\x7f\\]", value):
                raise ValueError("Invalid URL characters")
            url = urlsplit(value)
            _ = url.port  # Validate malformed ports before handing the URL to Chromium.
        except (ValueError, TypeError) as error:
            raise PolicyError("Invalid target URL") from error
        if url.scheme not in {"http", "https", "ws", "wss"}:
            raise PolicyError(f"Protocol {url.scheme or '(missing)'} is not allowed")
        if url.username is not None or url.password is not None:
            raise PolicyError("Credentials in URLs are not allowed")
        if "*" not in self._domains and (not url.hostname or url.hostname.lower() not in self._domains):
            raise PolicyError(f"Domain {url.hostname or '(missing)'} is outside the environment allowlist")
        if self.environment.get("production", False):
            pathname = url.path
            for _ in range(8):
                if re.search(r"%(?![0-9a-fA-F]{2})", pathname):
                    raise PolicyError("Invalid encoded request path")
                try:
                    decoded = unquote(pathname, errors="strict")
                except UnicodeDecodeError as error:
                    raise PolicyError("Invalid encoded request path") from error
                if decoded == pathname:
                    break
                pathname = decoded
            else:
                raise PolicyError("Excessively encoded request path")
            if any(pattern.search(pathname) for pattern in self._blocked_paths):
                raise PolicyError("Request path is blocked by production policy")
        return value

    def check_request(self, url: str, method: str) -> None:
        self.check_url(url)
        if not self.environment.get("production", False):
            return
        policy = self.environment.get("policy") or {}
        if not policy.get("enabled", False):
            raise PolicyError("Production is disabled in server configuration")
        if method.upper() in {item.upper() for item in policy.get("blockedMethods", ["DELETE", "PUT", "PATCH", "POST"])}:
            raise PolicyError(f"HTTP {method.upper()} is blocked by production policy")
        now = time.monotonic()
        while self._timestamps and self._timestamps[0] <= now - 60:
            self._timestamps.popleft()
        if len(self._timestamps) >= max(1, int(policy.get("requestsPerMinute", 60))):
            raise PolicyError("Production request rate limit exceeded")
        self._timestamps.append(now)

    def _record(self, error: PolicyError) -> None:
        # Bound memory for pages that continuously attempt blocked requests.
        if len(self.violations) < 100:
            self.violations.append(error)
        if self.on_violation:
            with suppress(Exception):
                self.on_violation(error)

    async def install(self, context: Any) -> None:
        """Install before creating pages; callers must block service workers."""
        async def route_request(route: Any) -> None:
            response = None
            try:
                self.check_request(route.request.url, route.request.method)
                # Route callbacks do not see every redirect hop. Never fetch a redirect.
                response = await route.fetch(max_redirects=0, timeout=30_000)
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if location:
                        self.check_url(urljoin(route.request.url, location))
                    raise PolicyError("HTTP redirects are blocked by the network guard; use the direct destination URL")
                await route.fulfill(response=response)
            except Exception as error:
                if isinstance(error, PolicyError):
                    self._record(error)
                with suppress(Exception):
                    await route.abort("blockedbyclient")
            finally:
                if response is not None:
                    with suppress(Exception):
                        await response.dispose()

        async def route_websocket(socket: Any) -> None:
            try:
                self.check_request(socket.url, "GET")
                await socket.connect_to_server()
            except Exception as error:
                self._record(error if isinstance(error, PolicyError) else PolicyError("WebSocket blocked"))
                with suppress(Exception):
                    await socket.close(code=1008, reason="Environment policy")

        await context.route("**/*", route_request)
        await context.route_web_socket("**/*", route_websocket)


ProductionGuard = Guard
