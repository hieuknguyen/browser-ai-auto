import asyncio
import base64
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError, Field

from .config import ROOT, Settings
from .events import EventBus
from .models import StrictModel, SessionRequest, RunRequest, AISettingsRequest, AITaskRequest, AIWorkflowRequest, validate_test
from .browser import BrowserManager, activate_chrome_window
from .runner import Runner
from .policy import Guard
from .ai import AIController
from .workflows import WorkflowController


class Navigation(StrictModel):
    url: str = Field(min_length=1, max_length=4000)


def create_app(settings: Settings | None = None, planner_factory=None) -> FastAPI:
    settings = settings or Settings.from_env()
    bus = EventBus()
    manager = BrowserManager(bus, headless=settings.headless, channel=settings.browser_channel,
                             executable_path=settings.executable_path)
    runner = Runner(manager, bus, settings.environments, settings.artifact_root, concurrency=settings.concurrency)
    ai = AIController(settings, manager, bus, **({"planner_factory": planner_factory} if planner_factory else {}))
    workflows = WorkflowController(ai, manager, bus)
    manual_guards: dict[str, Guard] = {}
    demo_sessions: set[str] = set()
    demos: set[asyncio.Task] = set()
    session_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(_app):
        settings.artifact_root.mkdir(parents=True, exist_ok=True)
        yield
        for task in demos:
            task.cancel()
        await asyncio.gather(*demos, return_exceptions=True)
        await workflows.close()
        await ai.close()
        await runner.close()
        await manager.close()

    app = FastAPI(title="Vector · Chrome + Gemini", version="2.0.0", lifespan=lifespan)
    app.state.manager, app.state.runner, app.state.ai, app.state.bus = manager, runner, ai, bus
    app.state.workflows = workflows
    app.state.settings = settings

    def environment(name):
        for env in settings.environments:
            if env["name"] == name:
                return env
        raise HTTPException(400, "Unknown environment")

    def state():
        environments = json.loads(json.dumps(settings.environments))
        for env in environments:
            env.get("policy", {}).pop("testAccount", None)
        return {"sessions": manager.list_sessions(), "runs": runner.list(), "environments": environments,
                "concurrency": settings.concurrency, "aiTasks": ai.list(), "aiSettings": ai.public_settings(),
                "aiWorkflows": workflows.list(),
                "browser": {"channel": settings.browser_channel, "headless": settings.headless}, "backend": "python"}

    def check_origin(headers):
        host = headers.get("host", "")
        try:
            hostname = urlsplit(f"http://{host}").hostname
        except ValueError:
            hostname = None
        if hostname not in {"localhost", "127.0.0.1", "::1", "testserver"}:
            raise HTTPException(403, "Only local access is supported")
        origin = headers.get("origin")
        if origin:
            try:
                origin_hostname = urlsplit(origin).hostname
            except ValueError:
                origin_hostname = None
            if origin_hostname not in {"localhost", "127.0.0.1", "::1", "testserver"} and origin not in {f"http://{host}", f"https://{host}"}:
                raise HTTPException(403, "Cross-origin browser control is disabled")

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        try:
            check_origin(request.headers)
        except HTTPException as error:
            return JSONResponse({"error": error.detail}, status_code=error.status_code)
        if int(request.headers.get("content-length", "0")) > 1_048_576:
            return JSONResponse({"error": "Request too large"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
        return response

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def validation_error(_request, error):
        # Never return invalid field input: it could contain an API key.
        return JSONResponse({"error": "Invalid request", "details": [{"path": list(item["loc"]), "message": "Invalid field value"} for item in error.errors()]}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        return JSONResponse({"error": ai.redact(str(error.detail))}, status_code=error.status_code)

    @app.exception_handler(Exception)
    async def internal_error(_request, error):
        message = ai.redact(str(error))
        return JSONResponse({"error": message[:1500]}, status_code=400)

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": "2.0.0", "backend": "python", "browser": settings.browser_channel}

    @app.get("/api/status")
    async def status():
        return state()

    @app.websocket("/events")
    async def events(socket: WebSocket):
        try:
            check_origin(socket.headers)
        except HTTPException:
            await socket.close(code=1008)
            return
        await socket.accept()
        queue = bus.subscribe()
        async def send_events():
            await socket.send_json({"type": "state", "sequence": bus.sequence, "timestamp": 0, **state()})
            while True:
                event = await queue.get()
                if event["type"] == "resync":
                    event = {**event, "type": "state", **state()}
                await asyncio.wait_for(socket.send_json(event), timeout=10)
        async def receive_close():
            while True:
                if (await socket.receive())["type"] == "websocket.disconnect":
                    return
        tasks = [asyncio.create_task(send_events()), asyncio.create_task(receive_close())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            bus.unsubscribe(queue)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    @app.get("/api/examples")
    async def examples():
        return {"tests": [validate_test(json.loads(path.read_text(encoding="utf-8"))) for path in sorted((ROOT / "examples").glob("*.json"))]}

    @app.post("/api/runs", status_code=202)
    async def submit_run(body: RunRequest):
        test = body.test.model_dump(by_alias=True, exclude_none=True)
        Guard(environment(test["environment"])).validate(test)
        return runner.submit(test, body.mode)

    @app.get("/api/runs/{id}")
    async def run_status(id: str):
        result = runner.get(id)
        if not result:
            raise HTTPException(404, "Run not found")
        return result

    @app.delete("/api/runs/{id}")
    async def cancel_run(id: str):
        if not runner.get(id):
            raise HTTPException(404, "Run not found")
        return {"ok": runner.cancel(id)}

    def session(id):
        item = manager.get_session(id)
        if not item:
            raise HTTPException(404, "Browser session not found")
        return item

    def page(id, manual=False):
        item = manager.get_page(id)
        if not item:
            raise HTTPException(404, "Browser page not found")
        if manual:
            current_session = session(item.session_id)
            if current_session.run_id or ai.owns(item.session_id):
                raise HTTPException(409, "This browser is controlled by an active task; stop it before manual input")
        return item

    @app.post("/api/sessions")
    async def new_session(body: SessionRequest):
        env = environment(body.environment)
        if env.get("production"):
            raise HTTPException(403, "Production requires a policy-validated JSON test")
        async with session_lock:
            if len(manager.list_sessions()) >= 20:
                raise HTTPException(409, "Close unused Chrome sessions first")
            guard = Guard(env)
            current = await manager.create_session(environment=body.environment, mode=body.mode, guard=guard)
            manual_guards[current.id] = guard
            try:
                item = await manager.create_page(current.id)
                if body.url:
                    await item.page.goto(guard.check_url(urljoin(env["baseURL"], body.url)), wait_until="domcontentloaded")
                await item.page.bring_to_front()
                activate_chrome_window()
                return current.info()
            except Exception:
                manual_guards.pop(current.id, None)
                await manager.close_session(current.id)
                raise

    @app.delete("/api/sessions/{id}")
    async def close_session(id: str):
        current = session(id)
        if current.run_id or ai.owns(id):
            raise HTTPException(409, "Stop the active task before closing its browser")
        await manager.close_session(id)
        manual_guards.pop(id, None)
        demo_sessions.discard(id)
        return {"ok": True}

    @app.post("/api/sessions/{id}/focus")
    async def focus_session(id: str):
        current = session(id)
        if current.pages:
            await list(current.pages.values())[-1].page.bring_to_front()
        activate_chrome_window()
        return {"ok": True}

    @app.post("/api/sessions/{id}/screenshot")
    async def session_screenshot(id: str):
        current = session(id)
        if not current.pages:
            raise HTTPException(404, "No active pages in session")
        active_page = list(current.pages.values())[-1]
        data = await active_page.page.screenshot(type="jpeg", quality=85)
        b64 = base64.b64encode(data).decode("ascii")
        artifact_dir = ROOT / "artifacts" / id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        filename = f"screenshot_{int(time.time()*1000)}.jpg"
        (artifact_dir / filename).write_bytes(data)
        return {"data": b64, "url": f"/artifacts/{id}/{filename}"}

    @app.post("/api/sessions/{id}/pages")
    async def new_page(id: str):
        current = session(id)
        if current.run_id or ai.owns(id):
            raise HTTPException(409, "This session is busy")
        return (await manager.create_page(id)).info()

    @app.delete("/api/sessions/{id}/pages/{page_id}")
    async def close_page(id: str, page_id: str):
        item = page(page_id, manual=True)
        if item.session_id != id:
            raise HTTPException(404, "Page does not belong to session")
        await item.page.close()
        return {"ok": True}

    @app.get("/api/pages/{id}/state")
    async def page_state(id: str):
        return page(id).info()

    @app.post("/api/pages/{id}/goto")
    async def navigate(id: str, body: Navigation):
        item = page(id, manual=True)
        guard = manual_guards.get(item.session_id)
        if not guard:
            raise HTTPException(409, "Open a new manual browser session to navigate")
        url = guard.check_url(urljoin(guard.environment["baseURL"], body.url))
        async with item.lock:
            await item.page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await item.page.bring_to_front()
            activate_chrome_window()
        return item.info()

    @app.post("/api/pages/{id}/screenshot")
    async def page_screenshot(id: str):
        item = page(id, manual=True)
        data = await item.page.screenshot(type="jpeg", quality=85)
        b64 = base64.b64encode(data).decode("ascii")
        artifact_dir = ROOT / "artifacts" / item.session_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        filename = f"screenshot_{int(time.time()*1000)}.jpg"
        (artifact_dir / filename).write_bytes(data)
        return {"data": b64, "url": f"/artifacts/{item.session_id}/{filename}"}

    @app.post("/api/pages/{id}/mouse/{action}")
    async def mouse_input(id: str, action: str, body: dict):
        from .models import validate_step
        item = page(id, manual=True)
        step = {"action": action, **body}
        if action in ("move", "click", "doubleClick", "rightClick"):
            allowed = {"x", "y", "button", "steps", "durationMs", "delayMs", "clickCount"}
            if set(body) - allowed:
                raise HTTPException(422, "Unknown mouse parameters")
            step = {"action": action, "target": {"strategy": "coordinates", "x": body.get("x"), "y": body.get("y")}}
            if "button" in body:
                step["button"] = body["button"]
        elif action == "drag":
            step = {"action": "drag", "from": {"strategy": "coordinates", **body.get("from", {})}, "to": {"strategy": "coordinates", **body.get("to", {})}, "steps": body.get("steps", 20)}
        if action not in {"move", "click", "doubleClick", "rightClick", "down", "up", "wheel", "drag"}:
            raise HTTPException(404, "Unknown mouse action")
        step = validate_step(step)
        from .actions import execute_action
        await execute_action(manager, item, step, "http://localhost")
        return {"ok": True, "position": item.mouse.get_position(), "state": item.mouse.get_state()}

    @app.post("/api/pages/{id}/keyboard")
    async def keyboard(id: str, body: dict):
        from .models import validate_step
        from .actions import execute_action
        if body.get("action") == "type":
            step = {"action": "type", "value": body.get("text")}
        elif body.get("action") == "press":
            step = {"action": "press", "key": body.get("key")}
        else:
            raise HTTPException(422, "Unknown keyboard action")
        await execute_action(manager, page(id, manual=True), validate_step(step), "http://localhost")
        return {"ok": True}

    @app.get("/api/ai/settings")
    async def ai_settings():
        return ai.public_settings()

    @app.put("/api/ai/settings")
    async def save_ai_settings(body: AISettingsRequest):
        return ai.configure(body.apiKey, body.model, body.apiUrl)

    @app.delete("/api/ai/settings")
    async def clear_ai_settings():
        return ai.clear_key()

    @app.get("/api/ai/tasks")
    async def ai_tasks():
        return {"tasks": ai.list()}

    @app.post("/api/ai/tasks", status_code=202)
    async def start_ai_task(body: AITaskRequest):
        return ai.submit(body)

    @app.get("/api/ai/tasks/{id}")
    async def ai_task(id: str):
        task = ai.get(id)
        if not task:
            raise HTTPException(404, "AI task not found")
        return task

    @app.delete("/api/ai/tasks/{id}")
    async def cancel_ai_task(id: str):
        if not ai.get(id):
            raise HTTPException(404, "AI task not found")
        return {"ok": ai.cancel(id)}

    @app.get("/api/ai/workflows")
    async def list_workflows():
        return {"workflows": workflows.list()}

    @app.post("/api/ai/workflows", status_code=202)
    async def start_workflow(body: AIWorkflowRequest):
        try:
            return workflows.submit(body)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @app.get("/api/ai/workflows/{id}")
    async def get_workflow(id: str):
        result = workflows.get(id)
        if result is None:
            raise HTTPException(404, "Work list not found")
        return result

    @app.delete("/api/ai/workflows/{id}")
    async def stop_workflow(id: str):
        if workflows.get(id) is None:
            raise HTTPException(404, "Work list not found")
        return {"ok": workflows.cancel(id)}

    @app.post("/api/ai/workflows/{id}/resume", status_code=202)
    async def resume_workflow(id: str):
        if workflows.get(id) is None:
            raise HTTPException(404, "Work list not found")
        try:
            return workflows.resume(id)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @app.post("/api/demo")
    async def demo(request: Request):
        async with session_lock:
            for running in demos:
                running.cancel()
            await asyncio.gather(*demos, return_exceptions=True)
            demos.clear()
            for id in demo_sessions:
                await manager.close_session(id)
                manual_guards.pop(id, None)
            demo_sessions.clear()
            # The frontend dev proxy preserves the request Host for Origin checks;
            # the backend fixture lives on its own configured port.
            base = f"http://127.0.0.1:{settings.port}"
            env = {"name": "local", "baseURL": base, "production": False, "allowedDomains": ["127.0.0.1", "localhost"]}
            try:
                for index in range(2):
                    guard = Guard(env)
                    current = await manager.create_session(environment="local", mode="watch", guard=guard)
                    demo_sessions.add(current.id)
                    manual_guards[current.id] = guard
                    item = await manager.create_page(current.id)
                    await item.page.goto(base + "/debug/mouse", wait_until="domcontentloaded")
                    async def perform(page=item, worker=index):
                        from .actions import execute_action
                        try:
                            for _ in range(2):
                                for action, target in [("click", "click-target"), ("doubleClick", "double-target"), ("rightClick", "right-target")]:
                                    box = await page.page.get_by_test_id(target).bounding_box()
                                    if box:
                                        async with page.lock:
                                            await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=12, duration_ms=500)
                                    await execute_action(manager, page, {"action": action, "target": {"strategy": "testId", "testId": target}}, base)
                                await execute_action(manager, page, {"action": "drag", "from": {"strategy": "testId", "testId": "drag-source"}, "to": {"strategy": "testId", "testId": "drop-zone"}}, base)
                            bus.publish("demo:completed", sessionId=page.session_id, pageId=page.id)
                        except asyncio.CancelledError:
                            pass
                        except Exception as error:
                            if not page.page.is_closed():
                                bus.publish("demo:error", error=str(error))
                    task = asyncio.create_task(perform())
                    demos.add(task)
                    task.add_done_callback(demos.discard)
            except Exception:
                for id in list(demo_sessions):
                    await manager.close_session(id)
                demo_sessions.clear()
                raise
            return {"sessionIds": list(demo_sessions)}

    @app.get("/debug/mouse")
    async def fixture():
        return FileResponse(ROOT / "src/fixtures/mouse.html")

    @app.get("/debug/frame")
    async def frame():
        return FileResponse(ROOT / "src/fixtures/frame.html")

    @app.api_route("/debug/echo", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
    async def echo(request: Request):
        return {"ok": True, "method": request.method}

    @app.get("/artifacts/{run_id}/{filename}")
    async def artifact(run_id: str, filename: str):
        path = (settings.artifact_root / run_id / filename).resolve()
        if not path.is_relative_to(settings.artifact_root.resolve()) or not path.is_file():
            raise HTTPException(404, "Artifact not found")
        return FileResponse(path, filename=filename, headers={"Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "no-store"})

    if (ROOT / "dist/assets").is_dir():
        app.mount("/assets", StaticFiles(directory=ROOT / "dist/assets"), name="assets")

    @app.get("/{path:path}")
    async def frontend(path: str):
        if path.startswith(("api/", "artifacts/", "debug/")):
            raise HTTPException(404, "Not found")
        if (ROOT / "dist/index.html").is_file():
            return FileResponse(ROOT / "dist/index.html")
        return JSONResponse({"message": "Backend ready. Start the React UI with npm run dev, or npm run build first."})

    return app
