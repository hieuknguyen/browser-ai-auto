import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserManager, type BrowserPageSession } from '../src/browser/BrowserManager.js';
import { EventBus } from '../src/realtime/EventBus.js';
import type { EngineEvent } from '../src/shared/types.js';

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin:0; font:16px sans-serif } #target {position:absolute;left:20px;top:20px;width:150px;height:70px}
#input {position:absolute;left:200px;top:20px} #popup {position:absolute;left:400px;top:20px}
#drag {position:absolute;left:20px;top:150px;width:100px;height:100px;background:coral;touch-action:none}
#scroll {position:absolute;left:200px;top:150px;width:200px;height:150px;overflow:auto} #scroll div {height:1500px}
iframe {position:absolute;left:450px;top:150px;width:300px;height:200px}
#transformed {position:absolute;top:400px;left:100px;transform:scale(1.5);width:100px;height:40px}
</style></head><body>
<button id="target">Target</button><input id="input"/><button id="popup" onclick="window.open('/popup')">Popup</button>
<div id="drag">Drag</div><div id="scroll"><div>Scrollable</div></div><iframe src="/frame"></iframe>
<button id="transformed">Transformed</button><script>
window.inputEvents=[];
for (const type of ['mousemove','mousedown','mouseup','click','dblclick','contextmenu','wheel']) {
 document.addEventListener(type,e=>{ window.inputEvents.push({type,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,detail:e.detail,target:e.target.id}); if(type==='contextmenu')e.preventDefault(); },true);
}
document.querySelector('#drag').addEventListener('pointerdown',e=>e.target.setPointerCapture(e.pointerId));
</script></body></html>`;

let fixtureServer: Server;
let baseURL: string;
let manager: BrowserManager;
let bus: EventBus;
let events: EngineEvent[];

before(async () => {
  fixtureServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/frame') response.end('<button id="inside" onclick="this.dataset.clicked=\'yes\'">Iframe target</button><iframe src="/nested"></iframe>');
    else if (request.url === '/nested') response.end('<button id="nested" onclick="this.dataset.clicked=\'yes\'">Nested iframe target</button>');
    else if (request.url === '/popup') response.end('<h1>Popup</h1>');
    else response.end(fixture);
  });
  await new Promise<void>(resolve => { fixtureServer.listen(0, '127.0.0.1', resolve); });
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== 'string');
  baseURL = `http://127.0.0.1:${address.port}`;
  bus = new EventBus();
  events = [];
  bus.subscribe(event => { events.push(event); });
  manager = new BrowserManager(bus);
  await manager.launch();
});

after(async () => {
  await manager?.close();
  await new Promise<void>((resolve, reject) => { fixtureServer?.close(error => { if (error) reject(error); else resolve(); }); });
});

async function open(mode: 'fast' | 'watch' = 'fast'): Promise<BrowserPageSession> {
  const session = await manager.createSession({ environment: 'local', mode, viewport: { width: 1000, height: 700 } });
  assert.equal(session.pages.size, 0, 'Guards can be installed before first navigation');
  const entry = await manager.createPage(session.id);
  await entry.page.goto(baseURL);
  return entry;
}

type InputEventRecord = { type: string; x: number; y: number; button: number; buttons: number; detail: number; target: string };
async function recorded(entry: BrowserPageSession): Promise<InputEventRecord[]> {
  return entry.page.evaluate(() => (window as unknown as { inputEvents: InputEventRecord[] }).inputEvents);
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!(await check())) { if (Date.now() - started > timeout) throw new Error('Condition was not reached'); await delay(25); }
}

test('browser mouse delivers native left/right/middle/double click and matching event states', async () => {
  const entry = await open();
  await entry.mouse.move(50, 40);
  await entry.mouse.click(50, 40);
  await entry.mouse.click(50, 40, { button: 'right' });
  await entry.mouse.click(50, 40, { button: 'middle' });
  await entry.mouse.doubleClick(50, 40);
  const native = await recorded(entry);
  assert.ok(native.some(event => event.type === 'mousemove' && event.x === 50 && event.y === 40));
  assert.ok(native.some(event => event.type === 'click' && event.button === 0 && event.target === 'target'));
  assert.ok(native.some(event => event.type === 'contextmenu' && event.button === 2));
  assert.ok(native.some(event => event.type === 'mousedown' && event.button === 1));
  assert.ok(native.some(event => event.type === 'dblclick' && event.detail === 2));
  const published = events.filter(event => event.pageId === entry.id);
  assert.equal(published.filter(event => event.type === 'mouse:down').length, 5);
  assert.equal(published.filter(event => event.type === 'mouse:up').length, 5);
  assert.deepEqual(entry.mouse.getState(), { x: 50, y: 40, button: 'none', status: 'hovering' });
  assert.equal((published.find(event => event.type === 'mouse:down')?.state as { status: string }).status, 'pressed');
  assert.equal((published.find(event => event.type === 'mouse:up')?.state as { status: string }).status, 'hovering');
  await manager.closeSession(entry.sessionId);
});

test('drag holds the button through intermediate events, wheel scrolls, and keyboard types', async () => {
  const entry = await open();
  await entry.mouse.drag({ x: 50, y: 180 }, { x: 130, y: 260 }, { steps: 8 });
  const native = await recorded(entry);
  const pressed = native.findIndex(event => event.type === 'mousedown');
  const released = native.findIndex(event => event.type === 'mouseup');
  assert.ok(pressed >= 0 && released > pressed);
  assert.equal(native.slice(pressed + 1, released).filter(event => event.type === 'mousemove' && event.buttons === 1).length, 8);
  assert.ok(events.some(event => event.pageId === entry.id && event.type === 'mouse:moved' && event.status === 'dragging'));
  await entry.mouse.move(250, 180);
  await entry.mouse.wheel(0, 320);
  await until(() => entry.page.locator('#scroll').evaluate(element => element.scrollTop > 0));
  assert.ok((await recorded(entry)).some(event => event.type === 'wheel'));
  await entry.mouse.click(250, 30);
  await entry.keyboard.type('hello');
  await entry.keyboard.press('ControlOrMeta+A');
  await entry.keyboard.type('world');
  assert.equal(await entry.page.locator('#input').inputValue(), 'world');
  await manager.closeSession(entry.sessionId);
});

test('contexts, pages, and simultaneous inputs have independent state and storage', async () => {
  const first = await open();
  const second = await open();
  const sibling = await manager.createPage(first.sessionId);
  await sibling.page.goto(baseURL);
  await first.page.evaluate(() => localStorage.setItem('isolated', 'first'));
  assert.equal(await sibling.page.evaluate(() => localStorage.getItem('isolated')), 'first');
  assert.equal(await second.page.evaluate(() => localStorage.getItem('isolated')), null);
  await Promise.all([first.mouse.move(10, 20), second.mouse.move(80, 90), sibling.mouse.move(300, 400)]);
  assert.deepEqual(first.mouse.getPosition(), { x: 10, y: 20 });
  assert.deepEqual(second.mouse.getPosition(), { x: 80, y: 90 });
  assert.deepEqual(sibling.mouse.getPosition(), { x: 300, y: 400 });
  const copy = first.mouse.getState();
  copy.x = 999;
  assert.equal(first.mouse.getPosition().x, 10);
  await Promise.all([manager.closeSession(first.sessionId), manager.closeSession(second.sessionId)]);
});

test('popup registration creates a fresh mouse and iframe coordinates target the right element', async () => {
  const entry = await open();
  const target = entry.page.frameLocator('iframe').locator('#inside');
  const box = await target.boundingBox();
  assert.ok(box);
  await entry.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await target.getAttribute('data-clicked'), 'yes');
  const nested = entry.page.frameLocator('iframe').frameLocator('iframe').locator('#nested');
  const nestedBox = await nested.boundingBox();
  assert.ok(nestedBox);
  await entry.mouse.click(nestedBox.x + nestedBox.width / 2, nestedBox.y + nestedBox.height / 2);
  assert.equal(await nested.getAttribute('data-clicked'), 'yes');
  const opened = entry.page.waitForEvent('popup');
  await entry.mouse.click(420, 30);
  const popup = await opened;
  const session = manager.getSession(entry.sessionId)!;
  const popupEntry = [...session.pages.values()].find(candidate => candidate.page === popup);
  assert.ok(popupEntry);
  assert.deepEqual(popupEntry.mouse.getState(), { x: 0, y: 0, button: 'none', status: 'idle' });
  await popup.close();
  assert.equal(manager.getPage(popupEntry.id), undefined);
  await manager.closeSession(entry.sessionId);
});

test('fast mode does not delay for animation, stream frames, or inject cursor DOM', async () => {
  const entry = await open();
  const html = await entry.page.locator('body').innerHTML();
  const started = Date.now();
  await entry.mouse.move(350, 100, { durationMs: 3000 });
  assert.ok(Date.now() - started < 1500, 'Fast mode ignores cosmetic animation duration');
  await entry.mouse.click(50, 40);
  entry.mouse.syncPosition(100, 80);
  assert.equal(await entry.page.locator('body').innerHTML(), html);
  assert.ok(!events.some(event => event.pageId === entry.id && event.type === 'browser:frame'));
  assert.deepEqual(entry.mouse.getPosition(), { x: 100, y: 80 });
  await manager.closeSession(entry.sessionId);
});

test('watch frames are bounded, preserve target DOM, and stop when the session closes', async () => {
  const entry = await open('watch');
  const html = await entry.page.locator('body').innerHTML();
  await until(() => events.some(event => event.pageId === entry.id && event.type === 'browser:frame'));
  await entry.mouse.move(200, 100, { steps: 4, durationMs: 100 });
  await delay(500);
  const frames = events.filter(event => event.pageId === entry.id && event.type === 'browser:frame');
  assert.ok(frames.length > 0 && frames.length < 15);
  assert.ok(typeof frames[0].data === 'string' && frames[0].data.length > 100);
  assert.equal(await entry.page.locator('body').innerHTML(), html);
  await manager.closeSession(entry.sessionId);
  const count = events.filter(event => event.pageId === entry.id && event.type === 'browser:frame').length;
  await delay(350);
  assert.equal(events.filter(event => event.pageId === entry.id && event.type === 'browser:frame').length, count);
});

test('operation queue supports nested adapters, recovers after errors, and closes cleanly', async () => {
  const entry = await open();
  await entry.execute(() => entry.mouse.click(50, 40));
  await assert.rejects(entry.mouse.move(Number.NaN, 0), /finite/);
  await Promise.all([entry.mouse.move(11, 12), entry.mouse.move(21, 22), entry.mouse.move(31, 32)]);
  assert.deepEqual(entry.mouse.getPosition(), { x: 31, y: 32 });
  await entry.page.evaluate(() => console.log('diagnostic sample'));
  const diagnostics = await entry.captureDiagnostics();
  assert.ok(entry.consoleMessages.some(message => message.text === 'diagnostic sample'));
  assert.ok(entry.networkRequests.some(request => request.url === `${baseURL}/` && request.status === 200));
  assert.equal(typeof diagnostics.semanticSnapshot, 'string');
  await manager.closeSession(entry.sessionId);
  assert.equal(manager.getPage(entry.id), undefined);
  await assert.rejects(entry.mouse.move(1, 1), /closed/);
});

test('context configuration installs before pages and service workers remain blocked', async () => {
  let configured = false;
  const session = await manager.createSession({
    environment: 'local', mode: 'fast', contextOptions: { serviceWorkers: 'allow' },
    configureContext: async context => {
      assert.equal(context.pages().length, 0);
      await context.route('**/guarded', route => route.fulfill({ body: '<h1>Guarded</h1>', contentType: 'text/html' }));
      configured = true;
    },
  });
  assert.equal(configured, true);
  const entry = await manager.createPage(session.id);
  await entry.page.goto(`${baseURL}/guarded`);
  assert.equal(await entry.page.locator('h1').innerText(), 'Guarded');
  assert.equal(session.context.serviceWorkers().length, 0);
  await manager.closeSession(session.id);
});

test('browser diagnostics redact known inputs and common credentials before storage or publication', async () => {
  const session = await manager.createSession({ environment: 'local', mode: 'fast', redact: value => value.replaceAll('private-test-value', '[REDACTED]') });
  const entry = await manager.createPage(session.id);
  await entry.page.goto(`${baseURL}/?password=hunter2&form=private-test-value`);
  await entry.page.evaluate(() => console.error('private-test-value password=hunter2 Bearer abc123.def456'));
  await until(() => entry.consoleMessages.length > 0);
  const diagnostics = JSON.stringify(await entry.captureDiagnostics());
  for (const secret of ['private-test-value', 'hunter2', 'abc123.def456']) {
    assert.ok(!diagnostics.includes(secret));
    assert.ok(!JSON.stringify(events.filter(event => event.sessionId === session.id)).includes(secret));
  }
  assert.ok(entry.info().url.includes('[REDACTED]'));
  await manager.closeSession(session.id);
});

test('closing during context configuration cannot leave a registered stale session', async () => {
  const isolatedManager = new BrowserManager(new EventBus());
  let finishConfiguration!: () => void;
  let configurationStarted!: () => void;
  const started = new Promise<void>(resolve => { configurationStarted = resolve; });
  const configuring = new Promise<void>(resolve => { finishConfiguration = resolve; });
  const creating = isolatedManager.createSession({ environment: 'local', mode: 'fast', configureContext: async () => { configurationStarted(); await configuring; } });
  await started;
  await isolatedManager.close();
  finishConfiguration();
  await assert.rejects(creating, /closed while creating/);
  assert.deepEqual(isolatedManager.listSessions(), []);
});
