"""Sequential workflow contracts, exercised without browsers or external AI."""
import asyncio
import copy
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.events import EventBus
from backend.models import AIWorkflowRequest
from backend.workflows import WorkflowController


class ScriptedAI:
    """Small independently scheduled child-task executor with visible barriers."""
    key = "offline-key"

    def __init__(self, manager, bus):
        self.manager = manager
        self.bus = bus
        self.requests = []
        self.tasks = {}
        self.workers = {}
        self.reservations = {}
        self.started = asyncio.Queue()
        self.releases = {}
        self.waited = []

    def redact(self, value):
        return value.replace(self.key, "[REDACTED]")

    def owns(self, session_id):
        return session_id in self.reservations

    def reserve(self, session_id, owner_id):
        if session_id in self.reservations and self.reservations[session_id] != owner_id:
            raise ValueError("Session already reserved")
        self.reservations[session_id] = owner_id

    def release(self, owner_id):
        self.reservations = {session: owner for session, owner in self.reservations.items() if owner != owner_id}

    def task_environment(self, request):
        return {"name": "fixture", "baseURL": request.startUrl or "https://fixture.test",
                "allowedDomains": request.allowedDomains, "production": False}

    def submit(self, request, *, owner_id=None, prior_outcomes=None, on_update=None):
        task_id = f"task-{len(self.requests) + 1}"
        self.requests.append({"request": request, "owner": owner_id, "previous": copy.deepcopy(prior_outcomes)})
        self.releases[task_id] = asyncio.Event()
        self.tasks[task_id] = {"id": task_id, "status": "queued", "steps": []}

        def publish():
            snapshot = copy.deepcopy(self.tasks[task_id])
            self.bus.publish("ai:task", task=snapshot)
            if on_update:
                on_update(snapshot)

        async def work():
            try:
                task = self.tasks[task_id]
                task.update(status="running", sessionId=request.sessionId or "session-1",
                            pageId=request.pageId or "page-1", browserReady=True)
                if owner_id:
                    self.reserve(task["sessionId"], owner_id)
                publish()
                self.started.put_nowait(task_id)
                await self.releases[task_id].wait()
                task.update(status="completed", answer=f"Finished {request.instruction}")
            except asyncio.CancelledError:
                self.tasks[task_id]["status"] = "cancelled"
            finally:
                publish()

        self.workers[task_id] = asyncio.create_task(work())
        return copy.deepcopy(self.tasks[task_id])

    def get(self, task_id):
        return copy.deepcopy(self.tasks.get(task_id))

    async def wait(self, task_id):
        await asyncio.gather(self.workers[task_id], return_exceptions=True)
        self.waited.append(task_id)
        return self.get(task_id)

    def cancel(self, task_id):
        worker = self.workers.get(task_id)
        if not worker or worker.done():
            return False
        worker.cancel()
        return True


def controller():
    page = SimpleNamespace(id="page-1", page=SimpleNamespace(url="https://fixture.test"))
    session = SimpleNamespace(id="session-1", pages={page.id: page})
    manager = SimpleNamespace(get_session=lambda value: session if value == session.id else None,
                              get_page=lambda value: page if value == page.id else None,
                              list_sessions=lambda: [{"id": session.id}])
    bus = EventBus()
    ai = ScriptedAI(manager, bus)
    return WorkflowController(ai, manager, bus), ai, bus


@pytest.mark.parametrize("payload", [
    {"instructions": []},
    {"instructions": ["Read page"] * 51},
    {"instructions": ["  "]},
    {"instructions": [" ab "]},
    {"instructions": ["a" * 12001]},
    {"instructions": ["Valid job"], "maxSteps": 0},
    {"instructions": ["Valid job"], "maxSteps": 51},
    {"instructions": ["Valid job"], "surprise": True},
])
def test_invalid_workflow_requests_are_rejected(payload):
    with pytest.raises(ValidationError):
        AIWorkflowRequest.model_validate(payload)


def test_workflow_request_normalizes_items_and_preserves_duplicates():
    request = AIWorkflowRequest(instructions=["  Read page  ", "Read page"])
    assert request.instructions == ["Read page", "Read page"]
    assert request.maxSteps == 20
    assert request.continueOnError is False


async def test_controller_waits_for_each_child_and_passes_only_completed_context():
    workflows, ai, bus = controller()
    stream = bus.subscribe()
    queued = workflows.submit(AIWorkflowRequest(
        name="Two steps", instructions=["Read first page", "Read next page"],
        startUrl="https://fixture.test/start", allowedDomains=["fixture.test"], maxSteps=8))
    try:
        assert queued["status"] == "queued"
        first = await asyncio.wait_for(ai.started.get(), 2)
        assert len(ai.requests) == 1
        running = workflows.get(queued["id"])
        assert [item["status"] for item in running["items"]] == ["running", "pending"]
        assert ai.requests[0]["request"].startUrl == "https://fixture.test/start"
        ai.releases[first].set()
        second = await asyncio.wait_for(ai.started.get(), 2)
        assert ai.waited == [first]
        followup = ai.requests[1]
        assert followup["request"].sessionId == "session-1"
        assert followup["request"].pageId == "page-1"
        assert followup["request"].startUrl == ""
        assert followup["request"].maxSteps == 8
        assert followup["request"].allowedDomains == ["fixture.test"]
        assert [item["instruction"] for item in followup["previous"]] == ["Read first page"]
        assert followup["previous"][0]["status"] == "completed"
        assert followup["previous"][0]["answer"] == "Finished Read first page"
        ai.releases[second].set()
        result = await asyncio.wait_for(workflows.wait(queued["id"]), 2)
        assert result["status"] == "completed"
        assert ai.reservations == {}
        events = []
        while not stream.empty():
            events.append(stream.get_nowait())
        workflow_events = [event for event in events if event["type"] == "ai:workflow"]
        assert workflow_events[0]["workflow"]["status"] == "queued"
        assert workflow_events[-1]["workflow"]["status"] == "completed"
        assert [event["sequence"] for event in events] == sorted(event["sequence"] for event in events)
    finally:
        await workflows.close()


async def test_public_snapshots_cannot_mutate_internal_workflow_or_events():
    workflows, ai, bus = controller()
    stream = bus.subscribe()
    queued = workflows.submit(AIWorkflowRequest(instructions=["Read original page"]))
    workflow_id = queued["id"]
    queued["items"][0]["instruction"] = "Tampered submit result"
    try:
        assert workflows.get(workflow_id)["items"][0]["instruction"] == "Read original page"
        listed = workflows.list()
        listed[0]["items"].clear()
        snapshot = workflows.get(workflow_id)
        snapshot["items"][0]["status"] = "completed"
        assert workflows.get(workflow_id)["items"][0]["status"] == "pending"
        event = stream.get_nowait()
        assert event["workflow"]["items"][0]["instruction"] == "Read original page"
        event["workflow"]["items"].clear()
        assert len(workflows.get(workflow_id)["items"]) == 1
        child = await asyncio.wait_for(ai.started.get(), 2)
        ai.releases[child].set()
        result = await asyncio.wait_for(workflows.wait(workflow_id), 2)
        assert result["status"] == "completed"
        assert workflows.get("missing") is None
        assert not workflows.cancel("missing")
        with pytest.raises(ValueError):
            workflows.resume(workflow_id)
    finally:
        await workflows.close()


async def test_close_cancels_active_workflows_and_never_starts_pending_items():
    workflows, ai, _ = controller()
    queued = workflows.submit(AIWorkflowRequest(instructions=["Hold first item", "Never start this"]))
    await asyncio.wait_for(ai.started.get(), 2)
    await asyncio.wait_for(workflows.close(), 2)
    assert workflows.get(queued["id"])["status"] == "cancelled"
    assert len(ai.requests) == 1
    assert all(worker.done() for worker in ai.workers.values())
    assert ai.reservations == {}
