import asyncio
import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.events import EventBus
from backend.runner import Runner, create_redactor, redact_trace_zip


LOCAL = {"name": "local", "baseURL": "https://trusted.test/", "production": False, "allowedDomains": ["trusted.test"]}
PRODUCTION = {**LOCAL, "name": "production", "production": True, "policy": {"enabled": True, "requireTestAccount": True, "testAccount": "tester", "maxConcurrency": 1, "requestsPerMinute": 100, "blockedMethods": ["DELETE"]}}


def definition(**fields):
    return {"id": "example", "steps": [{"action": "goto", "path": "/"}, {"action": "expectText", "target": {"strategy": "text", "text": "Ready"}, "text": "Ready"}], **fields}


class FakeManager:
    def __init__(self):
        self.sessions = {}
        self.created = []
        self.closed = []

    async def create_session(self, **options):
        session_id = f"session-{len(self.created)}"
        session = SimpleNamespace(id=session_id, context=SimpleNamespace(tracing=SimpleNamespace(start=AsyncMock(), stop=AsyncMock())), options=options)
        self.created.append(options)
        self.sessions[session_id] = session
        return session

    async def create_page(self, session_id):
        async def screenshot(**kwargs):
            Path(kwargs["path"]).write_bytes(b"masked-test-image")

        page = SimpleNamespace(is_closed=lambda: False, locator=lambda _: SimpleNamespace(aria_snapshot=AsyncMock(return_value="Ready")), get_by_text=lambda *args, **kwargs: None, screenshot=AsyncMock(side_effect=screenshot), content=AsyncMock(return_value="<body>Ready</body>"))
        return SimpleNamespace(id=f"page-{session_id}", session_id=session_id, page=page, diagnostics=AsyncMock(return_value={"console": [], "network": []}))

    async def close_session(self, session_id):
        self.closed.append(session_id)


@pytest.mark.asyncio
async def test_runner_emits_steps_writes_result_and_closes_context(monkeypatch, tmp_path):
    manager, bus = FakeManager(), EventBus()
    stream = bus.subscribe()
    execute = AsyncMock(side_effect=lambda manager, current, *args, **kwargs: current)
    monkeypatch.setattr("backend.runner.execute_action", execute)
    runner = Runner(manager, bus, [LOCAL], tmp_path)
    queued = runner.submit(definition())
    assert queued["status"] == "queued"
    result = await runner.wait(queued["id"])
    assert result["status"] == "passed"
    assert [step["status"] for step in result["steps"]] == ["passed", "passed"]
    assert manager.closed == [result["sessionId"]]
    assert json.loads((tmp_path / result["id"] / "result.json").read_text())["status"] == "passed"
    events = []
    while not stream.empty():
        events.append(stream.get_nowait())
    assert [event["status"] for event in events if event["type"] == "test:step"] == ["started", "passed", "started", "passed"]
    assert all("value" not in event for event in events)
    result["status"] = "mutated"
    assert runner.get(queued["id"])["status"] == "passed"
    await runner.close()


@pytest.mark.asyncio
async def test_missing_and_forbidden_variables_fail_before_browser(monkeypatch, tmp_path):
    monkeypatch.delenv("TEST_MISSING", raising=False)
    manager = FakeManager()
    runner = Runner(manager, EventBus(), [LOCAL], tmp_path)
    for placeholder in ["${TEST_MISSING}", "${GEMINI_API_KEY}"]:
        queued = runner.submit(definition(steps=[{"action": "type", "value": placeholder}]))
        result = await runner.wait(queued["id"])
        assert result["status"] == "failed"
        assert result["steps"][0]["status"] == "skipped"
    assert manager.created == []
    await runner.close()


@pytest.mark.asyncio
async def test_failure_redacts_resolved_input_and_diagnostics(monkeypatch, tmp_path):
    secret = "super-private-credential"
    monkeypatch.setenv("TEST_PASSWORD", secret)
    manager = FakeManager()
    bus = EventBus()
    stream = bus.subscribe()

    async def execute(manager, current, step, *args, **kwargs):
        assert step["value"] == secret
        current.page.content.return_value = f'<input value="{secret}">'
        current.diagnostics.return_value = {"console": [f"token={secret}"]}
        raise RuntimeError(f"Could not fill {secret}")

    monkeypatch.setattr("backend.runner.execute_action", execute)
    runner = Runner(manager, bus, [LOCAL], tmp_path)
    queued = runner.submit(definition(steps=[{"action": "fill", "target": {"strategy": "label", "label": "Password"}, "value": "${TEST_PASSWORD}"}, {"action": "goto", "path": "/"}]))
    result = await runner.wait(queued["id"])
    assert result["status"] == "failed"
    assert result["steps"][0]["status"] == "failed"
    assert result["steps"][1]["status"] == "skipped"
    assert "[REDACTED]" in result["error"]
    for path in (tmp_path / result["id"]).glob("*.json"):
        assert secret not in path.read_text()
    while not stream.empty():
        assert secret not in json.dumps(stream.get_nowait())
    assert "failure.png" in [item["name"] for item in result["artifacts"]]
    await runner.close()


@pytest.mark.asyncio
async def test_cancellation_covers_queued_and_started_tasks(monkeypatch, tmp_path):
    entered = asyncio.Event()

    async def execute(manager, current, *args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr("backend.runner.execute_action", execute)
    manager = FakeManager()
    runner = Runner(manager, EventBus(), [LOCAL], tmp_path, concurrency=1)
    running = runner.submit(definition())
    queued = runner.submit(definition(id="queued"))
    await entered.wait()
    assert runner.cancel(queued["id"])
    assert (await runner.wait(queued["id"]))["status"] == "cancelled"
    assert runner.cancel(running["id"])
    result = await asyncio.wait_for(runner.wait(running["id"]), timeout=2)
    assert result["status"] == "cancelled"
    assert manager.closed == [result["sessionId"]]
    assert not runner.cancel(result["id"])
    await runner.close()


@pytest.mark.asyncio
async def test_cancel_in_gap_before_scheduled_task_starts(monkeypatch, tmp_path):
    manager = FakeManager()
    runner = Runner(manager, EventBus(), [LOCAL], tmp_path)
    queued = runner.submit(definition())
    runner._drain()
    assert runner.cancel(queued["id"])
    result = await asyncio.wait_for(runner.wait(queued["id"]), timeout=2)
    assert result["status"] == "cancelled"
    assert manager.created == []
    await runner.close()


@pytest.mark.asyncio
async def test_production_concurrency_does_not_block_independent_local_work(monkeypatch, tmp_path):
    release = asyncio.Event()
    started = []

    async def execute(manager, current, step, *args, **kwargs):
        session = manager.sessions[current.session_id]
        if step["action"] == "goto":
            started.append(session.options["environment"])
            await release.wait()
        return current

    monkeypatch.setattr("backend.runner.execute_action", execute)
    manager = FakeManager()
    runner = Runner(manager, EventBus(), [LOCAL, PRODUCTION], tmp_path, concurrency=3)
    production = definition(environment="production", productionAllowed=True, testAccount="tester")
    runs = [runner.submit(production), runner.submit(production), runner.submit(definition())]
    for _ in range(30):
        if len(started) == 2:
            break
        await asyncio.sleep(0)
    assert started == ["production", "local"]
    assert runner.get(runs[1]["id"])["status"] == "queued"
    release.set()
    assert all(item["status"] == "passed" for item in await asyncio.gather(*(runner.wait(run["id"]) for run in runs)))
    assert started == ["production", "local", "production"]
    await runner.close()


@pytest.mark.asyncio
async def test_runner_enforces_timeout_and_closes_browser(monkeypatch, tmp_path):
    async def execute(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr("backend.runner.execute_action", execute)
    manager = FakeManager()
    runner = Runner(manager, EventBus(), [LOCAL], tmp_path)
    queued = runner.submit(definition(timeoutMs=1000))
    result = await asyncio.wait_for(runner.wait(queued["id"]), timeout=3)
    assert result["status"] == "failed"
    assert "timeout" in result["error"]
    assert manager.closed == [result["sessionId"]]
    await runner.close()


def test_trace_export_redacts_operations_and_discards_network_resources():
    source = io.BytesIO()
    secret = "private-text-value"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("trace.trace", json.dumps({"type": "before", "params": {"value": secret, "authorization": "different-secret"}}) + "\n")
        archive.writestr("trace.network", json.dumps({"secret": "unrelated-network-secret"}))
        archive.writestr("resources/response-body", b"unrelated-network-secret")
        archive.writestr("trace.stacks", json.dumps({"files": ["backend/actions.py"]}))
    cleaned = redact_trace_zip(source.getvalue(), create_redactor({secret}))
    with zipfile.ZipFile(io.BytesIO(cleaned)) as archive:
        assert set(archive.namelist()) == {"trace.trace", "trace.network", "trace.stacks"}
        assert archive.read("trace.network") == b""
        trace = archive.read("trace.trace").decode()
        assert secret not in trace and "different-secret" not in trace
        assert json.loads(trace)["type"] == "before"
