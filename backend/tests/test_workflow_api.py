"""API integration with installed Chrome and a deterministic AI double, never a live key."""
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from backend.ai import Decision
from backend.app import create_app
from backend.config import Settings


HTML = b'''<!doctype html><html><head><title>Ordered jobs fixture</title></head><body>
<label>Name <input aria-label="Name"></label>
<button onclick="document.querySelector('[role=status]').textContent=document.querySelector('input').value">Save</button>
<div role="status">Ready</div></body></html>'''


@pytest.fixture
def fixture_url():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(HTML)))
            self.end_headers()
            self.wfile.write(HTML)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}/'
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def settings_for(tmp_path, **options):
    return Settings(headless=True, artifact_root=tmp_path, gemini_api_key='test-only-not-a-real-key',
                    environments=[{'name': 'local', 'baseURL': 'http://127.0.0.1',
                                   'allowedDomains': ['127.0.0.1'], 'production': False}], **options)


async def test_workflow_api_executes_three_jobs_in_one_chrome_page(tmp_path, fixture_url, monkeypatch):
    monkeypatch.setattr('backend.ai.activate_chrome_window', lambda: None)
    monkeypatch.setattr('backend.browser.activate_chrome_window', lambda: None)
    monkeypatch.setattr('backend.ai.ROOT', tmp_path)
    calls = []
    scripts = [
        [dict(action='fill', summary='Fill name', target={'strategy': 'label', 'label': 'Name'}, value='Ordered visitor'),
         dict(action='done', summary='Name entered', answer='Name entered')],
        [dict(action='click', summary='Save name', target={'strategy': 'role', 'role': 'button', 'name': 'Save'}),
         dict(action='done', summary='Name saved', answer='Name saved')],
        [dict(action='expectText', summary='Verify saved name', target={'strategy': 'role', 'role': 'status'}, text='Ordered visitor'),
         dict(action='done', summary='Verified', answer='Verified Ordered visitor')],
    ]
    instances = []

    class Planner:
        def __init__(self, *_args):
            self.index = len(instances)
            self.decisions = iter(scripts[self.index])
            instances.append(self)
            self.closed = False

        async def decide(self, instruction, observation, history, domains):
            calls.append(self.index)
            assert observation['url'] == fixture_url
            return Decision.model_validate(next(self.decisions))

        async def close(self):
            self.closed = True

    app = create_app(settings_for(tmp_path), planner_factory=Planner)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url='http://localhost') as client:
            response = await client.post('/api/ai/workflows', json={
                'name': 'Three ordered jobs', 'instructions': ['Fill the Name field', 'Click the Save button', 'Verify the saved name'],
                'startUrl': fixture_url, 'maxSteps': 4,
            })
            assert response.status_code == 202, response.text
            submitted = response.json()
            result = await asyncio.wait_for(app.state.workflows.wait(submitted['id']), timeout=40)
            assert result['status'] == 'completed', result
            assert [item['status'] for item in result['items']] == ['completed'] * 3
            assert calls == [0, 0, 1, 1, 2, 2]
            assert all(planner.closed for planner in instances)
            tasks = [app.state.ai.get(item['taskId']) for item in result['items']]
            assert len({task['sessionId'] for task in tasks}) == 1
            assert len({task['pageId'] for task in tasks}) == 1
            assert len(app.state.manager.list_sessions()) == 1
            current = app.state.manager.get_page(result['pageId'])
            assert await current.page.get_by_role('status').inner_text() == 'Ordered visitor'
            status = (await client.get('/api/status')).json()
            assert status['aiWorkflows'][0]['id'] == result['id']
            assert (await client.get('/api/ai/workflows')).json()['workflows'][0]['status'] == 'completed'
            assert (await client.get(f"/api/ai/workflows/{result['id']}")).json()['revision'] >= submitted['revision']
            assert (await client.post(f"/api/ai/workflows/{result['id']}/resume", json={})).status_code == 409
            assert 'test-only-not-a-real-key' not in str(status['aiWorkflows'])


async def test_workflow_api_validates_lists_and_unknown_identifiers_without_ai_calls(tmp_path):
    def forbidden_planner(*_args):
        raise AssertionError('Invalid input must not invoke the planner')

    app = create_app(settings_for(tmp_path), planner_factory=forbidden_planner)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://localhost') as client:
            for payload in [
                {'instructions': []}, {'instructions': ['   ']}, {'instructions': ['Do it'] * 51},
                {'instructions': ['Do it'], 'maxSteps': 51}, {'instructions': ['Do it'], 'maxSteps': 0},
                {'instructions': ['Do it'], 'owner_id': 'bypass'},
            ]:
                response = await client.post('/api/ai/workflows', json=payload)
                assert response.status_code == 422, response.text
            for method, url in [('GET', '/api/ai/workflows/unknown'), ('DELETE', '/api/ai/workflows/unknown'), ('POST', '/api/ai/workflows/unknown/resume')]:
                assert (await client.request(method, url)).status_code == 404
            rejected = await client.post('/api/ai/workflows', json={'instructions': ['Do it']}, headers={'Origin': 'https://untrusted.example'})
            assert rejected.status_code == 403
            assert app.state.workflows.list() == []


async def test_workflow_state_is_included_when_websocket_connects(tmp_path):
    # TestClient uses its own event loop and performs no browser/provider operations here.
    from fastapi.testclient import TestClient
    app = create_app(settings_for(tmp_path))
    with TestClient(app) as client:
        with client.websocket_connect('/events') as websocket:
            message = websocket.receive_json()
            assert message['type'] == 'state'
            assert message['aiWorkflows'] == []
