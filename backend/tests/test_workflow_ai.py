"""Workflow integration with the real AI controller and an offline planner.

No API clients, .env configuration, or real Chrome windows are used here.
"""
import asyncio
import copy
from collections import defaultdict, deque
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from backend.ai import AIController, Decision
from backend.config import Settings
from backend.events import EventBus
from backend.models import AITaskRequest, AIWorkflowRequest
from backend.workflows import WorkflowController


class OfflineManager:
    def __init__(self):
        self.sessions = {}
        self.created = []
        self.closed = []
        self.visits = []

    async def create_session(self, **options):
        session = SimpleNamespace(id=f"session-{len(self.created) + 1}", pages={}, options=options)
        self.created.append(session)
        self.sessions[session.id] = session
        return session

    async def create_page(self, session_id):
        session = self.sessions[session_id]
        page_id = f"{session_id}-page-{len(session.pages) + 1}"
        driver = SimpleNamespace(url="about:blank", bring_to_front=AsyncMock(),
                                 is_closed=lambda: False, screenshot=AsyncMock(return_value=b"image"))

        async def goto(url, **_):
            self.visits.append((page_id, url))
            driver.url = url

        driver.goto = goto

        async def snapshot():
            return {"pageId": page_id, "url": driver.url, "title": "Offline fixture", "snapshot": "Ready"}

        page = SimpleNamespace(id=page_id, session_id=session_id, page=driver, snapshot=snapshot)
        session.pages[page_id] = page
        return page

    def get_session(self, session_id):
        return self.sessions.get(session_id)

    def get_page(self, page_id):
        return next((s.pages[page_id] for s in self.sessions.values() if page_id in s.pages), None)

    def list_sessions(self):
        return [{"id": session.id} for session in self.sessions.values()]

    async def close_session(self, session_id):
        self.closed.append(session_id)
        self.sessions.pop(session_id, None)


class OfflinePlanners:
    def __init__(self):
        self.scripts = defaultdict(deque)
        self.calls = []
        self.instances = []
        self.closed = []
        self.close_hook = None

    def __call__(self, key, model, api_url):
        instance_id = len(self.instances)
        self.instances.append(instance_id)

        async def decide(instruction, observation, history, domains):
            self.calls.append({"instruction": instruction, "observation": copy.deepcopy(observation),
                               "history": copy.deepcopy(history), "domains": list(domains)})
            outcome = self.scripts[instruction].popleft() if self.scripts[instruction] else {
                "action": "done", "summary": "Verified complete", "answer": f"Completed: {instruction}"}
            if callable(outcome):
                outcome = await outcome()
            if isinstance(outcome, Exception):
                raise outcome
            return Decision.model_validate(outcome)

        async def close():
            if self.close_hook:
                await self.close_hook(instance_id)
            self.closed.append(instance_id)

        return SimpleNamespace(decide=decide, close=close)


@pytest_asyncio.fixture
async def offline(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.ai.ROOT", tmp_path)
    monkeypatch.setattr("backend.ai.activate_chrome_window", lambda: None)
    settings = Settings(gemini_api_key="offline-placeholder", artifact_root=tmp_path,
                        environments=[{"name": "fixture", "baseURL": "https://fixture.test", "production": False}])
    bus, manager, planners = EventBus(), OfflineManager(), OfflinePlanners()
    ai = AIController(settings, manager, bus, planner_factory=planners)
    workflows = WorkflowController(ai, manager, bus)
    yield SimpleNamespace(ai=ai, workflows=workflows, manager=manager, planners=planners, bus=bus)
    await workflows.close()
    await ai.close()


async def finish(controller, workflow_id):
    return await asyncio.wait_for(controller.wait(workflow_id), timeout=3)


async def test_real_ai_runs_in_order_and_navigates_start_url_only_once(offline):
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Open search", "Find the result", "Summarize result"],
        startUrl="https://fixture.test/start", maxSteps=7, allowedDomains=["fixture.test"]))
    result = await finish(offline.workflows, queued["id"])
    assert result["status"] == "completed"
    assert [item["status"] for item in result["items"]] == ["completed"] * 3
    assert [call["instruction"] for call in offline.planners.calls] == [
        "Open search", "Find the result", "Summarize result"]
    assert len(offline.manager.created) == 1
    assert offline.manager.visits == [(result["pageId"], "https://fixture.test/start")]
    tasks = [offline.ai.get(item["taskId"]) for item in result["items"]]
    assert {task["sessionId"] for task in tasks} == {result["sessionId"]}
    assert {task["pageId"] for task in tasks} == {result["pageId"]}
    assert offline.planners.closed == [0, 1, 2]
    assert not offline.ai.owns(result["sessionId"])


async def test_following_item_keeps_selected_page_even_when_it_is_not_latest(offline, monkeypatch):
    session = await offline.manager.create_session()
    earlier = await offline.manager.create_page(session.id)
    latest = await offline.manager.create_page(session.id)
    earlier.page.url = "https://fixture.test/earlier"
    latest.page.url = "https://fixture.test/latest"
    offline.planners.scripts["Select earlier tab"].append({
        "action": "switchPage", "summary": "Select requested tab", "page": earlier.id})

    async def execute(manager, current, step, *args, **kwargs):
        assert current is latest
        assert step["page"] == earlier.id
        return earlier

    monkeypatch.setattr("backend.ai.execute_action", execute)
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Select earlier tab", "Read selected tab"], sessionId=session.id))
    result = await finish(offline.workflows, queued["id"])
    assert result["status"] == "completed"
    read = next(call for call in offline.planners.calls if call["instruction"] == "Read selected tab")
    assert read["observation"]["pageId"] == earlier.id
    assert read["observation"]["url"] == "https://fixture.test/earlier"
    assert result["pageId"] == earlier.id
    assert offline.manager.visits == []


async def test_default_failure_stops_later_jobs_and_resume_preserves_completed_work(offline):
    offline.planners.scripts["Middle item"].append(RuntimeError("Offline planner failure"))
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["First item", "Middle item", "Final item"], startUrl="https://fixture.test"))
    failed = await finish(offline.workflows, queued["id"])
    assert failed["status"] == "failed"
    assert [item["status"] for item in failed["items"]] == ["completed", "failed", "skipped"]
    original_task = failed["items"][0]["taskId"]
    assert [call["instruction"] for call in offline.planners.calls] == ["First item", "Middle item"]
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "completed"
    assert resumed["items"][0]["taskId"] == original_task
    assert [call["instruction"] for call in offline.planners.calls] == [
        "First item", "Middle item", "Middle item", "Final item"]
    assert len(offline.manager.created) == 1
    assert len(offline.manager.visits) == 1


async def test_continue_on_error_runs_remaining_jobs_and_reports_partial_failure(offline):
    offline.planners.scripts["Middle item"].append(RuntimeError("Deliberate failure"))
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["First item", "Middle item", "Final item"], continueOnError=True))
    result = await finish(offline.workflows, queued["id"])
    assert result["status"] == "completed_with_errors"
    assert [item["status"] for item in result["items"]] == ["completed", "failed", "completed"]
    assert [call["instruction"] for call in offline.planners.calls] == ["First item", "Middle item", "Final item"]


async def test_cancel_waits_for_child_cleanup_before_releasing_session(offline):
    entered, cleanup_entered, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def hold_decision():
        entered.set()
        await asyncio.Event().wait()

    async def hold_cleanup(_):
        cleanup_entered.set()
        await allow_cleanup.wait()

    offline.planners.scripts["Hold first item"].append(hold_decision)
    offline.planners.close_hook = hold_cleanup
    queued = offline.workflows.submit(AIWorkflowRequest(instructions=["Hold first item", "Never run this"]))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        active = offline.workflows.get(queued["id"])
        session_id = active["sessionId"]
        assert offline.workflows.cancel(queued["id"])
        await asyncio.wait_for(cleanup_entered.wait(), 3)
        waiter = asyncio.create_task(offline.workflows.wait(queued["id"]))
        await asyncio.sleep(0)
        assert not waiter.done(), "workflow wait must include the planner's asynchronous cleanup"
        assert offline.ai.owns(session_id), "the workflow reservation must outlive child cancellation"
        assert offline.planners.closed == []
    finally:
        allow_cleanup.set()
    result = await finish(offline.workflows, queued["id"])
    await waiter
    assert result["status"] == "cancelled"
    assert offline.planners.closed == [0]
    assert [call["instruction"] for call in offline.planners.calls] == ["Hold first item"]
    assert not offline.ai.owns(session_id)
    assert not offline.workflows.cancel(queued["id"])


async def test_cancel_before_first_tick_never_opens_a_browser(offline):
    queued = offline.workflows.submit(AIWorkflowRequest(instructions=["First item", "Second item"]))
    assert offline.workflows.cancel(queued["id"])
    result = await finish(offline.workflows, queued["id"])
    assert result["status"] == "cancelled"
    assert offline.planners.instances == []
    assert offline.manager.created == []


async def test_existing_session_is_reserved_at_submission_before_worker_starts(offline):
    session = await offline.manager.create_session()
    page = await offline.manager.create_page(session.id)
    page.page.url = "https://fixture.test"
    queued = offline.workflows.submit(AIWorkflowRequest(instructions=["First item"], sessionId=session.id))
    assert offline.ai.owns(session.id)
    with pytest.raises(ValueError):
        offline.ai.submit(AITaskRequest(instruction="Competing task", sessionId=session.id))
    with pytest.raises(ValueError):
        offline.workflows.submit(AIWorkflowRequest(instructions=["Competing workflow"], sessionId=session.id))
    assert (await finish(offline.workflows, queued["id"]))["status"] == "completed"
    followup = offline.ai.submit(AITaskRequest(instruction="Now allowed", sessionId=session.id))
    assert (await finish(offline.ai, followup["id"]))["status"] == "completed"


async def test_individual_tasks_also_reserve_session_before_first_tick(offline):
    session = await offline.manager.create_session()
    page = await offline.manager.create_page(session.id)
    page.page.url = "https://fixture.test"
    task = offline.ai.submit(AITaskRequest(instruction="First task", sessionId=session.id))
    with pytest.raises(ValueError):
        offline.ai.submit(AITaskRequest(instruction="Second task", sessionId=session.id))
    with pytest.raises(ValueError):
        offline.workflows.submit(AIWorkflowRequest(instructions=["Workflow item"], sessionId=session.id))
    assert (await finish(offline.ai, task["id"]))["status"] == "completed"


async def test_resume_cancelled_workflow_keeps_browser_and_skips_finished_jobs(offline):
    entered = asyncio.Event()

    async def hold_middle():
        entered.set()
        await asyncio.Event().wait()

    offline.planners.scripts["Middle item"].append(hold_middle)
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["First item", "Middle item", "Final item"], startUrl="https://fixture.test"))
    await asyncio.wait_for(entered.wait(), 3)
    assert offline.workflows.cancel(queued["id"])
    cancelled = await finish(offline.workflows, queued["id"])
    assert [item["status"] for item in cancelled["items"]] == ["completed", "cancelled", "cancelled"]
    assert offline.manager.closed == [], "workflow Chrome state must remain available for resume"
    completed_task = cancelled["items"][0]["taskId"]
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "completed"
    assert resumed["sessionId"] == cancelled["sessionId"]
    assert resumed["items"][0]["taskId"] == completed_task
    assert [call["instruction"] for call in offline.planners.calls] == [
        "First item", "Middle item", "Middle item", "Final item"]


async def test_resume_partial_success_retries_only_failed_item(offline):
    offline.planners.scripts["Middle item"].append(RuntimeError("Temporary error"))
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["First item", "Middle item", "Final item"], continueOnError=True))
    partial = await finish(offline.workflows, queued["id"])
    assert partial["status"] == "completed_with_errors"
    original_tasks = [item["taskId"] for item in partial["items"]]
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "completed"
    assert resumed["items"][0]["taskId"] == original_tasks[0]
    assert resumed["items"][2]["taskId"] == original_tasks[2]
    assert resumed["items"][1]["taskId"] != original_tasks[1]
    assert [call["instruction"] for call in offline.planners.calls] == [
        "First item", "Middle item", "Final item", "Middle item"]


async def test_planner_context_contains_only_prior_results_with_api_key_redacted(offline):
    offline.planners.scripts["Read first page"].append({
        "action": "done", "summary": "Read fixture", "answer": "Result offline-placeholder"})
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Read first page", "Summarize prior result", "Future instruction"]))
    result = await finish(offline.workflows, queued["id"])
    assert result["status"] == "completed"
    observation = offline.planners.calls[1]["observation"]
    context = observation["workflowContext"]
    assert "UNTRUSTED" in context["note"]
    assert [item["instruction"] for item in context["previousJobs"]] == ["Read first page"]
    assert context["previousJobs"][0]["answer"] == "Result [REDACTED]"
    assert "offline-placeholder" not in str(result)


async def test_resume_retries_initial_navigation_when_it_failed_before_loading(offline, monkeypatch):
    original_create = offline.manager.create_page
    visits = []

    async def create_page(session_id):
        page = await original_create(session_id)
        original_goto = page.page.goto

        async def goto(url, **kwargs):
            visits.append(url)
            if len(visits) == 1:
                raise RuntimeError("Temporary initial navigation failure")
            await original_goto(url, **kwargs)

        page.page.goto = goto
        return page

    monkeypatch.setattr(offline.manager, "create_page", create_page)
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Read first page", "Read second page"], startUrl="https://fixture.test/start"))
    failed = await finish(offline.workflows, queued["id"])
    assert failed["status"] == "failed"
    assert offline.planners.calls == []
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "completed"
    assert visits == ["https://fixture.test/start", "https://fixture.test/start"]
    assert len(offline.manager.created) == 1


async def test_resume_recovers_when_first_page_creation_failed(offline, monkeypatch):
    original_create = offline.manager.create_page
    attempts = []

    async def create_page(session_id):
        attempts.append(session_id)
        if len(attempts) == 1:
            raise RuntimeError("Temporary page creation failure")
        return await original_create(session_id)

    monkeypatch.setattr(offline.manager, "create_page", create_page)
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Read first page", "Read second page"], startUrl="https://fixture.test/start"))
    failed = await finish(offline.workflows, queued["id"])
    assert failed["status"] == "failed"
    assert not offline.ai.owns(failed["sessionId"])
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "completed"
    assert attempts == [resumed["sessionId"], resumed["sessionId"]]
    assert offline.manager.visits == [(resumed["pageId"], "https://fixture.test/start")]
    assert len(offline.manager.created) == 1


async def test_resume_never_silently_switches_away_from_closed_selected_page(offline):
    session = await offline.manager.create_session()
    older = await offline.manager.create_page(session.id)
    selected = await offline.manager.create_page(session.id)
    older.page.url = "https://fixture.test/unrelated"
    selected.page.url = "https://fixture.test/selected"
    offline.planners.scripts["Read second page"].append(RuntimeError("Temporary failure"))
    queued = offline.workflows.submit(AIWorkflowRequest(
        instructions=["Read first page", "Read second page"], sessionId=session.id))
    failed = await finish(offline.workflows, queued["id"])
    assert failed["status"] == "failed"
    assert failed["pageId"] == selected.id
    del session.pages[selected.id]
    offline.workflows.resume(queued["id"])
    resumed = await finish(offline.workflows, queued["id"])
    assert resumed["status"] == "failed"
    assert "page" in resumed["items"][1]["error"].lower()
    assert not offline.ai.owns(session.id)
    assert [call["instruction"] for call in offline.planners.calls] == ["Read first page", "Read second page"]
