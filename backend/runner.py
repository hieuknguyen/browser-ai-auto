"""Validated deterministic tests, bounded scheduling, and redacted failure evidence."""

from __future__ import annotations

import asyncio
import copy
import html
import io
import json
import os
import re
import tempfile
import time
import uuid
import zipfile
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .actions import execute_action
from .models import validate_test
from .policy import Guard


def _now() -> int:
    return int(time.time() * 1000)


def create_redactor(values: set[str]) -> Callable[[str], str]:
    # The set remains live as TEST_ placeholders are resolved before execution.
    def redact(value: str) -> str:
        for secret in sorted((item for item in values if item), key=len, reverse=True):
            variants = {secret, quote(secret, safe=""), html.escape(secret), json.dumps(secret)[1:-1]}
            for variant in sorted(variants, key=len, reverse=True):
                if len(variant) < 3:
                    value = re.sub(r"(?<!\w)" + re.escape(variant) + r"(?!\w)", "[REDACTED]", value)
                else:
                    value = value.replace(variant, "[REDACTED]")
        value = re.sub(r"(?i)(Bearer\s+)[^\s\"'<>]+", r"\1[REDACTED]", value)
        value = re.sub(r"(?i)([?&](?:token|key|api_key|secret|password|authorization|code)=)[^&\s\"'<>]*", r"\1[REDACTED]", value)
        return value
    return redact


def redact_structured(value: Any, redact: Callable[[str], str]) -> Any:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_structured(item, redact) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in {"authorization", "cookie", "set-cookie", "apikey", "api_key", "password", "secret", "accesstoken", "refreshtoken"}
            else redact_structured(item, redact)
            for key, item in value.items()
        }
    return value


def redact_trace_zip(source: bytes, redact: Callable[[str], str]) -> bytes:
    """Keep API operation metadata only; never publish network bodies or resources."""
    target = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(source)) as incoming, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as outgoing:
        for item in incoming.infolist():
            if item.file_size > 50_000_000:
                raise ValueError("Trace entry exceeds the export limit")
            if item.filename.endswith(".network"):
                outgoing.writestr(item.filename, "")
            elif item.filename.endswith((".trace", ".stacks")):
                records = []
                for line in incoming.read(item).decode("utf-8").splitlines():
                    if line.strip():
                        records.append(json.dumps(redact_structured(json.loads(line), redact), ensure_ascii=False))
                outgoing.writestr(item.filename, "\n".join(records) + "\n")
    return target.getvalue()


@dataclass
class _Job:
    test: dict
    result: dict
    done: asyncio.Future
    task: asyncio.Task | None = None
    started: bool = False
    cancelled: bool = False
    session: Any = None
    active: Any = None
    trace_started: bool = False
    values: set[str] = field(default_factory=set)


class Runner:
    def __init__(self, manager: Any, bus: Any, environments: list[dict], artifact_root: Path, concurrency: int = 4):
        self.manager = manager
        self.bus = bus
        self.environments = copy.deepcopy(environments)
        self.artifact_root = Path(artifact_root).resolve()
        self.concurrency = max(1, min(32, int(concurrency)))
        self.history_limit = 200
        self._jobs: dict[str, _Job] = {}
        self._queue: list[_Job] = []
        self._active: dict[str, _Job] = {}
        self._rate_windows: dict[str, deque] = {}
        self._closed = False
        for environment in self.environments:
            Guard(environment)  # Fail early for invalid server policy.
            self._rate_windows[environment["name"]] = deque()

    def environment(self, name: str) -> dict:
        for item in self.environments:
            if item["name"] == name:
                return item
        raise ValueError(f"Unknown environment: {name}")

    def submit(self, test: dict, mode: str = "fast") -> dict:
        if self._closed:
            raise ValueError("Runner is closed")
        if len(self._queue) >= 1000:
            raise ValueError("Run queue is full")
        if mode not in {"fast", "watch"}:
            raise ValueError("Mode must be fast or watch")
        definition = validate_test(test)
        self.environment(definition["environment"])
        result = {
            "id": str(uuid.uuid4()), "testId": definition["id"], "name": definition["name"],
            "environment": definition["environment"], "mode": mode, "status": "queued",
            "steps": [], "artifacts": [],
        }
        job = _Job(definition, result, asyncio.get_running_loop().create_future())
        job.values.update(value for name, value in os.environ.items() if name.startswith("TEST_") or name in {"GEMINI_API_KEY", "GOOGLE_API_KEY"})
        job.values.update(step["value"] for step in definition["steps"] if step["action"] in {"fill", "type"})
        self._jobs[result["id"]] = job
        self._queue.append(job)
        self._publish(job)
        asyncio.get_running_loop().call_soon(self._drain)
        return self._public(job)

    def list(self) -> list[dict]:
        return [self._public(job) for job in reversed(list(self._jobs.values()))]

    def get(self, run_id: str) -> dict | None:
        job = self._jobs.get(run_id)
        return self._public(job) if job else None

    async def wait(self, run_id: str) -> dict:
        job = self._jobs.get(run_id)
        if not job:
            raise KeyError("Run not found")
        return copy.deepcopy(await asyncio.shield(job.done))

    def cancel(self, run_id: str) -> bool:
        job = self._jobs.get(run_id)
        if not job or job.result["status"] not in {"queued", "running"}:
            return False
        if job.cancelled:
            return True
        job.cancelled = True
        if job in self._queue:
            self._queue.remove(job)
            job.result.update(status="cancelled", finishedAt=_now(), error="Run cancelled")
            job.result["steps"] = [self._skipped(index, step) for index, step in enumerate(job.test["steps"])]
            self._publish(job)
            job.done.set_result(self._public(job))
            self._prune()
        elif job.started and job.task and not job.task.done():
            job.task.cancel()
        return True

    async def close(self) -> None:
        self._closed = True
        tasks = [job.task for job in self._active.values() if job.task]
        for job in [*self._queue, *self._active.values()]:
            self.cancel(job.result["id"])
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _public(self, job: _Job) -> dict:
        return redact_structured(copy.deepcopy(job.result), create_redactor(job.values))

    def _publish(self, job: _Job) -> None:
        self.bus.publish("run:updated", runId=job.result["id"], run=self._public(job))

    @staticmethod
    def _skipped(index: int, step: dict) -> dict:
        return {"index": index, "action": step["action"], "status": "skipped", "durationMs": 0}

    def _drain(self) -> None:
        if self._closed:
            return
        while len(self._active) < self.concurrency:
            candidate = None
            for job in self._queue:
                environment = self.environment(job.test["environment"])
                count = sum(active.test["environment"] == environment["name"] for active in self._active.values())
                limit = max(1, int((environment.get("policy") or {}).get("maxConcurrency", 1)))
                if not environment.get("production") or count < limit:
                    candidate = job
                    break
            if candidate is None:
                break
            self._queue.remove(candidate)
            self._active[candidate.result["id"]] = candidate
            candidate.result.update(status="running", startedAt=_now())
            self._publish(candidate)
            candidate.task = asyncio.create_task(self._execute(candidate), name=f"browser-run-{candidate.result['id']}")

    async def _execute(self, job: _Job) -> None:
        job.started = True
        directory = self.artifact_root / job.result["id"]
        redact = create_redactor(job.values)
        environment = self.environment(job.test["environment"])
        guard = Guard(environment)
        guard._timestamps = self._rate_windows[environment["name"]]
        guard.on_violation = lambda error: self.bus.publish(
            "policy:blocked", runId=job.result["id"],
            sessionId=job.session.id if job.session else None, message=redact(str(error)),
        )
        try:
            if job.cancelled:
                raise asyncio.CancelledError
            directory.mkdir(parents=True, exist_ok=True)
            async with asyncio.timeout(job.test["timeoutMs"] / 1000):
                guard.validate(job.test)
                steps = self._resolve_steps(job)
                job.session = await self.manager.create_session(
                    environment=environment["name"], mode=job.result["mode"], run_id=job.result["id"],
                    viewport=job.test.get("viewport"), guard=guard,
                )
                job.session.redact = redact
                job.result["sessionId"] = job.session.id
                await job.session.context.tracing.start(screenshots=False, snapshots=False, sources=False)
                job.trace_started = True
                job.active = await self.manager.create_page(job.session.id)
                aliases = {"main": job.active.id}
                self._publish(job)
                for index, step in enumerate(steps):
                    if guard.violations:
                        raise guard.violations[0]
                    started = time.monotonic()
                    self._step_event(job, index, step, "started")
                    try:
                        job.active = await execute_action(
                            self.manager, job.active, step, environment["baseURL"], aliases=aliases, artifact_dir=directory,
                        )
                        if guard.violations:
                            raise guard.violations[0]
                        if step["action"] == "screenshot":
                            self._artifact(job, f"{step['name']}.png")
                        job.result["steps"].append({"index": index, "action": step["action"], "status": "passed", "durationMs": int((time.monotonic() - started) * 1000)})
                        self._step_event(job, index, step, "passed")
                        self._publish(job)
                    except Exception as error:
                        message = redact(str(guard.violations[0] if guard.violations else error))
                        job.result["steps"].append({"index": index, "action": step["action"], "status": "failed", "durationMs": int((time.monotonic() - started) * 1000), "error": message})
                        self._step_event(job, index, step, "failed", error=message)
                        raise
                if guard.violations:
                    raise guard.violations[0]
                job.result["status"] = "passed"
        except asyncio.CancelledError:
            job.result.update(status="cancelled", error="Run cancelled")
        except TimeoutError:
            job.result.update(status="failed", error=f"Test exceeded its {job.test['timeoutMs']} ms timeout")
        except Exception as error:
            job.result.update(status="failed", error=redact(str(guard.violations[0] if guard.violations else error)))
        finally:
            for index in range(len(job.result["steps"]), len(job.test["steps"])):
                job.result["steps"].append(self._skipped(index, job.test["steps"][index]))
            if job.result["status"] == "failed":
                await self._failure_artifacts(job, directory, redact)
            await self._finish_trace(job, directory, redact)
            if job.session:
                with suppress(Exception):
                    await asyncio.wait_for(self.manager.close_session(job.session.id), timeout=15)
            job.result["finishedAt"] = _now()
            self._artifact(job, "result.json")
            try:
                directory.mkdir(parents=True, exist_ok=True)
                (directory / "result.json").write_text(json.dumps(self._public(job), ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError:
                job.result["artifacts"] = [item for item in job.result["artifacts"] if item["name"] != "result.json"]
                job.result.setdefault("error", "Unable to write result artifact")
                if job.result["status"] == "passed":
                    job.result["status"] = "failed"
            self._active.pop(job.result["id"], None)
            self._publish(job)
            if not job.done.done():
                job.done.set_result(self._public(job))
            self._prune()
            self._drain()

    def _resolve_steps(self, job: _Job) -> list[dict]:
        def resolve(match: re.Match) -> str:
            name = match.group(1)
            if not name.startswith("TEST_"):
                raise ValueError("Only TEST_ environment variables may be referenced by test inputs")
            if name not in os.environ:
                raise ValueError(f"Missing test variable: {name}")
            job.values.add(os.environ[name])
            return os.environ[name]

        steps = copy.deepcopy(job.test["steps"])
        for step in steps:
            if step["action"] in {"fill", "type"}:
                step["value"] = re.sub(r"\$\{([A-Z][A-Z0-9_]*)\}", resolve, step["value"])
        return steps

    def _step_event(self, job: _Job, index: int, step: dict, status: str, **payload: Any) -> None:
        self.bus.publish("test:step", runId=job.result["id"], sessionId=job.session.id,
                         pageId=job.active.id, index=index, action=step["action"], status=status, **payload)

    @staticmethod
    def _artifact(job: _Job, name: str) -> None:
        if not any(item["name"] == name for item in job.result["artifacts"]):
            job.result["artifacts"].append({"name": name, "url": f"/artifacts/{job.result['id']}/{name}"})

    async def _failure_artifacts(self, job: _Job, directory: Path, redact: Callable[[str], str]) -> None:
        if not job.active or job.active.page.is_closed():
            return
        page = job.active.page
        masks = [page.locator('input,textarea,[contenteditable="true"],[data-sensitive]')]
        masks.extend(page.get_by_text(value, exact=False) for value in job.values if len(value) > 2)
        with suppress(Exception):
            await page.screenshot(path=str(directory / "failure.png"), caret="initial", mask=masks, timeout=5000)
            self._artifact(job, "failure.png")

        async def save(name: str, awaitable: Any) -> None:
            with suppress(Exception):
                value = await asyncio.wait_for(awaitable, timeout=5)
                (directory / name).write_text(json.dumps(redact_structured(value, redact), ensure_ascii=False, indent=2), encoding="utf-8")
                self._artifact(job, name)

        await save("diagnostics.json", job.active.diagnostics())
        await save("accessibility.json", page.locator("body").aria_snapshot(timeout=3000))
        await save("dom.json", page.content())

    async def _finish_trace(self, job: _Job, directory: Path, redact: Callable[[str], str]) -> None:
        if not job.trace_started or not job.session:
            return
        with suppress(Exception):
            if job.result["status"] == "failed":
                # Raw traces exist only in a private temporary directory, never under /artifacts.
                with tempfile.TemporaryDirectory(prefix="browser-engine-trace-") as temporary:
                    raw_path = Path(temporary) / "trace.zip"
                    await asyncio.wait_for(job.session.context.tracing.stop(path=str(raw_path)), timeout=10)
                    clean = redact_trace_zip(raw_path.read_bytes(), redact)
                    (directory / "trace.zip").write_bytes(clean)
                    self._artifact(job, "trace.zip")
            else:
                await asyncio.wait_for(job.session.context.tracing.stop(), timeout=10)

    def _prune(self) -> None:
        completed = [run_id for run_id, job in self._jobs.items() if job.result["status"] not in {"queued", "running"} and job.done.done()]
        for run_id in completed[:max(0, len(completed) - self.history_limit)]:
            self._jobs.pop(run_id, None)
