from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.policy import Guard, PolicyError


def environment(production=False):
    return {
        "name": "production" if production else "local",
        "baseURL": "https://trusted.test/", "allowedDomains": ["trusted.test"], "production": production,
        "policy": {
            "enabled": True, "requireTestAccount": True, "testAccount": "dedicated-test",
            "blockedActions": ["type"], "blockedMethods": ["DELETE", "POST"],
            "blockedPathPatterns": [r"/billing", r"/delete"], "requestsPerMinute": 2, "maxConcurrency": 1,
        },
    }


def test_exact_allowlist_and_url_validation():
    guard = Guard(environment())
    assert guard.check_url("https://TRUSTED.test/path") == "https://TRUSTED.test/path"
    assert guard.check_url("wss://trusted.test/socket")
    for url in [
        "https://trusted.test.evil.test", "https://evil.test/trusted.test", "file:///C:/secrets",
        "javascript:alert(1)", "data:text/html,hello", "https://user:pass@trusted.test",
        "https://trusted.test:invalid", "https://trusted.test\\@evil.test", "https://trusted.test/\nsecret",
    ]:
        with pytest.raises(PolicyError):
            guard.check_url(url)


def test_extra_domains_are_explicit_and_exact():
    guard = Guard(environment(), extra_allowed_domains=["cdn.trusted.test"])
    assert guard.check_url("https://cdn.trusted.test/asset")
    with pytest.raises(PolicyError):
        guard.check_url("https://other.cdn.trusted.test/asset")


def test_production_metadata_cannot_bypass_policy():
    config = environment(production=True)
    test = {"productionAllowed": True, "testAccount": "dedicated-test", "safetyLevel": "read-only", "steps": [{"action": "goto", "path": "/"}]}
    Guard(config).validate(test)
    for field, value in [("productionAllowed", False), ("testAccount", "someone-else"), ("safetyLevel", "destructive")]:
        with pytest.raises(PolicyError):
            Guard(config).validate({**test, field: value})
    with pytest.raises(PolicyError, match="Action type"):
        Guard(config).validate({**test, "steps": [{"action": "type", "value": "hello"}]})
    disabled = deepcopy(config)
    disabled["policy"]["enabled"] = False
    with pytest.raises(PolicyError, match="disabled"):
        Guard(disabled).validate(test)


def test_encoded_paths_http_methods_and_rate_limits():
    guard = Guard(environment(production=True))
    for path in ["/billing", "/%62illing", "/%2562illing", "/delete", "/%GG", "/%ff"]:
        with pytest.raises(PolicyError):
            guard.check_request("https://trusted.test" + path, "GET")
    with pytest.raises(PolicyError, match="HTTP DELETE"):
        guard.check_request("https://trusted.test/", "delete")
    guard.check_request("https://trusted.test/", "GET")
    guard.check_request("https://trusted.test/", "GET")
    with pytest.raises(PolicyError, match="rate limit"):
        guard.check_request("https://trusted.test/", "GET")
    guard._timestamps[0] -= 61
    guard.check_request("https://trusted.test/", "GET")


@pytest.mark.asyncio
async def test_redirect_response_is_never_followed():
    guard = Guard(environment())
    context = SimpleNamespace(route=AsyncMock(), route_web_socket=AsyncMock())
    await guard.install(context)
    handler = context.route.call_args.args[1]
    for location in ["https://evil.test/", "/allowed"]:
        response = SimpleNamespace(status=302, headers={"location": location}, dispose=AsyncMock())
        route = SimpleNamespace(request=SimpleNamespace(url="https://trusted.test/", method="GET"), fetch=AsyncMock(return_value=response), fulfill=AsyncMock(), abort=AsyncMock())
        await handler(route)
        route.fetch.assert_awaited_once_with(max_redirects=0, timeout=30000)
        route.fulfill.assert_not_called()
        route.abort.assert_awaited_once_with("blockedbyclient")
        response.dispose.assert_awaited_once()
    assert len(guard.violations) == 2


@pytest.mark.asyncio
async def test_denied_requests_and_websockets_never_connect():
    guard = Guard(environment())
    context = SimpleNamespace(route=AsyncMock(), route_web_socket=AsyncMock())
    await guard.install(context)
    route = SimpleNamespace(request=SimpleNamespace(url="https://evil.test/", method="GET"), fetch=AsyncMock(), abort=AsyncMock())
    await context.route.call_args.args[1](route)
    route.fetch.assert_not_called()
    socket = SimpleNamespace(url="wss://evil.test/", connect_to_server=AsyncMock(), close=AsyncMock())
    await context.route_web_socket.call_args.args[1](socket)
    socket.connect_to_server.assert_not_called()
    socket.close.assert_awaited_once_with(code=1008, reason="Environment policy")
    assert len(guard.violations) == 2


@pytest.mark.asyncio
async def test_allowed_response_fulfills_and_disposes():
    guard = Guard(environment())
    context = SimpleNamespace(route=AsyncMock(), route_web_socket=AsyncMock())
    await guard.install(context)
    response = SimpleNamespace(status=200, headers={}, dispose=AsyncMock())
    route = SimpleNamespace(request=SimpleNamespace(url="https://trusted.test/", method="GET"), fetch=AsyncMock(return_value=response), fulfill=AsyncMock(), abort=AsyncMock())
    await context.route.call_args.args[1](route)
    route.fulfill.assert_awaited_once_with(response=response)
    response.dispose.assert_awaited_once()
    assert guard.violations == []
