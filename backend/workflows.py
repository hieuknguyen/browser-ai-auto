"""Execute ordered AI jobs while retaining one browser session and active page."""
from __future__ import annotations

import asyncio
import copy
import time
from uuid import uuid4

from .models import AITaskRequest, AIWorkflowRequest


def timestamp() -> int:
    return int(time.time() * 1000)


class WorkflowController:
    def __init__(self, ai, manager, bus):
        self.ai = ai
        self.manager = manager
        self.bus = bus
        self._workflows: dict[str, dict] = {}
        self._requests: dict[str, AIWorkflowRequest] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self._cancel_requested: set[str] = set()
        self._initial_navigation_done: set[str] = set()
        self._initial_urls: dict[str, str] = {}

    def list(self) -> list[dict]:
        return [copy.deepcopy(workflow) for workflow in reversed(list(self._workflows.values()))]

    def get(self, id: str) -> dict | None:
        return copy.deepcopy(self._workflows.get(id))

    def _emit(self, workflow: dict) -> None:
        workflow["revision"] = workflow.get("revision", 0) + 1
        self.bus.publish("ai:workflow", workflow=copy.deepcopy(workflow))

    def _ensure_idle(self) -> None:
        if self._workers:
            raise ValueError("Một danh sách công việc đang chạy; hãy dừng hoặc chờ hoàn tất trước khi bắt đầu danh sách khác")

    def submit(self, request: AIWorkflowRequest) -> dict:
        self._ensure_idle()
        if not self.ai.key:
            raise ValueError("Configure an AI API key before starting an AI workflow")
        # Validate before reserving a session or reporting the request accepted.
        first = AITaskRequest(instruction=request.instructions[0], startUrl=request.startUrl,
                              sessionId=request.sessionId, allowedDomains=request.allowedDomains,
                              maxSteps=request.maxSteps)
        environment = self.ai.task_environment(first)
        workflow = {
            "id": str(uuid4()), "name": self.ai.redact(request.name), "status": "queued",
            "startUrl": self.ai.redact(request.startUrl.strip()), "maxSteps": request.maxSteps,
            "continueOnError": request.continueOnError, "revision": 0,
            "items": [{"id": str(uuid4()), "index": index, "instruction": self.ai.redact(instruction),
                       "status": "pending"} for index, instruction in enumerate(request.instructions)],
        }
        if request.sessionId:
            self.ai.reserve(request.sessionId, workflow["id"])
            workflow["sessionId"] = request.sessionId
        self._workflows[workflow["id"]] = workflow
        self._requests[workflow["id"]] = request.model_copy(deep=True)
        self._initial_urls[workflow["id"]] = environment["baseURL"]
        self._schedule(workflow)
        return copy.deepcopy(workflow)

    def _schedule(self, workflow: dict) -> None:
        self._emit(workflow)
        worker = asyncio.create_task(self._run(workflow))
        self._workers[workflow["id"]] = worker
        worker.add_done_callback(lambda completed: self._worker_done(workflow["id"], completed))

    def _worker_done(self, id: str, worker: asyncio.Task) -> None:
        # Cancellation before the coroutine starts cannot enter its finally block.
        if worker.cancelled() and self._workflows[id]["status"] in ("queued", "running"):
            workflow = self._workflows[id]
            for item in workflow["items"]:
                if item["status"] not in ("completed", "failed"):
                    item.update(status="cancelled", finishedAt=timestamp())
            workflow.update(status="cancelled", finishedAt=timestamp())
            workflow.pop("activeIndex", None)
            self.ai.release(id)
            self._emit(workflow)
        self._workers.pop(id, None)
        self._cancel_requested.discard(id)

    def cancel(self, id: str) -> bool:
        worker = self._workers.get(id)
        if not worker or worker.done():
            return False
        if id not in self._cancel_requested:
            self._cancel_requested.add(id)
            workflow = self._workflows[id]
            workflow["cancelRequested"] = True
            self._emit(workflow)
            worker.cancel()
        return True

    async def wait(self, id: str) -> dict | None:
        worker = self._workers.get(id)
        if worker:
            await asyncio.gather(worker, return_exceptions=True)
        return self.get(id)

    def resume(self, id: str) -> dict:
        self._ensure_idle()
        workflow = self._workflows.get(id)
        if not workflow:
            raise ValueError("Không tìm thấy danh sách công việc")
        if workflow["status"] not in ("failed", "cancelled", "completed_with_errors"):
            raise ValueError("Chỉ có thể tiếp tục danh sách đã dừng hoặc có công việc lỗi")
        if not any(item["status"] != "completed" for item in workflow["items"]):
            raise ValueError("Tất cả công việc trong danh sách đã hoàn tất")
        if not self.ai.key:
            raise ValueError("Configure an AI API key before resuming an AI workflow")
        if workflow.get("sessionId"):
            self.ai.reserve(workflow["sessionId"], id)
        for item in workflow["items"]:
            if item["status"] != "completed":
                for field in ("taskId", "answer", "error", "startedAt", "finishedAt"):
                    item.pop(field, None)
                item["status"] = "pending"
        for field in ("error", "finishedAt", "activeIndex", "cancelRequested"):
            workflow.pop(field, None)
        workflow["status"] = "queued"
        self._schedule(workflow)
        return copy.deepcopy(workflow)

    def _child_update(self, workflow: dict, task: dict) -> None:
        if task.get("browserReady"):
            self._initial_navigation_done.add(workflow["id"])
        changed = False
        for field in ("sessionId", "pageId"):
            if task.get(field) and workflow.get(field) != task[field]:
                workflow[field] = task[field]
                changed = True
        if changed:
            self._emit(workflow)

    def _outcomes(self, workflow: dict, index: int) -> list[dict]:
        # Future jobs are never passed to the planner. Bound past output size.
        return [{key: (value[:4000] if isinstance(value, str) else value)
                 for key, value in item.items() if key in {"index", "instruction", "status", "answer", "error"}}
                for item in workflow["items"][:index]]

    async def _run(self, workflow: dict) -> None:
        id = workflow["id"]
        request = self._requests[id]
        child_id = None
        active_item = None
        cancelled = False
        try:
            workflow.update(status="running")
            workflow.setdefault("startedAt", timestamp())
            self._emit(workflow)
            for item in workflow["items"]:
                if item["status"] == "completed":
                    continue
                if id in self._cancel_requested:
                    raise asyncio.CancelledError
                active_item = item
                child_id = None
                workflow["activeIndex"] = item["index"]
                item.update(status="running", startedAt=timestamp())
                self._emit(workflow)
                try:
                    child_request = AITaskRequest(
                        instruction=request.instructions[item["index"]],
                        startUrl=self._initial_urls[id] if id not in self._initial_navigation_done else "",
                        sessionId=workflow.get("sessionId"), pageId=workflow.get("pageId"),
                        allowedDomains=request.allowedDomains, maxSteps=request.maxSteps,
                    )
                    child = self.ai.submit(child_request, owner_id=id,
                                           prior_outcomes=self._outcomes(workflow, item["index"]),
                                           on_update=lambda task: self._child_update(workflow, task))
                    child_id = child["id"]
                    item["taskId"] = child_id
                    self._child_update(workflow, child)
                    self._emit(workflow)
                    # Shield prevents cancelling this waiter from interrupting child cleanup.
                    result = await asyncio.shield(self.ai.wait(child_id))
                    self._child_update(workflow, result)
                    if result["status"] == "cancelled":
                        raise asyncio.CancelledError
                    item.update(status="completed" if result["status"] == "completed" else "failed",
                                finishedAt=timestamp())
                    for field in ("answer", "error"):
                        if result.get(field):
                            item[field] = self.ai.redact(result[field])
                    if item["status"] == "failed" and not item.get("error"):
                        item["error"] = "AI chưa xác nhận công việc hoàn tất"
                except Exception as error:
                    item.update(status="failed", error=self.ai.redact(str(error))[:2000], finishedAt=timestamp())
                self._emit(workflow)
                if item["status"] == "failed" and not request.continueOnError:
                    workflow.update(status="failed", error=item["error"])
                    for later in workflow["items"][item["index"] + 1:]:
                        if later["status"] != "completed":
                            later.update(status="skipped", finishedAt=timestamp())
                    break
            else:
                workflow["status"] = ("completed_with_errors" if any(item["status"] == "failed" for item in workflow["items"])
                                      else "completed")
        except asyncio.CancelledError:
            cancelled = True
        except Exception as error:
            workflow.update(status="failed", error=self.ai.redact(str(error))[:2000])
            if active_item and active_item["status"] == "running":
                active_item.update(status="failed", error=workflow["error"], finishedAt=timestamp())
        finally:
            if cancelled:
                if child_id:
                    self.ai.cancel(child_id)
                    result = await asyncio.shield(self.ai.wait(child_id))
                    if result:
                        self._child_update(workflow, result)
                        if active_item and result["status"] == "completed":
                            active_item.update(status="completed", finishedAt=timestamp())
                            if result.get("answer"):
                                active_item["answer"] = self.ai.redact(result["answer"])
                for item in workflow["items"]:
                    if item["status"] not in ("completed", "failed"):
                        item.update(status="cancelled", finishedAt=timestamp())
                workflow["status"] = "cancelled"
            elif workflow["status"] == "failed":
                for item in workflow["items"]:
                    if item["status"] == "pending":
                        item.update(status="skipped", finishedAt=timestamp())
            self.ai.release(id)
            workflow.pop("activeIndex", None)
            workflow["finishedAt"] = timestamp()
            self._emit(workflow)

    async def close(self) -> None:
        workers = list(self._workers.values())
        for id in list(self._workers):
            self.cancel(id)
        await asyncio.gather(*workers, return_exceptions=True)
