import type { BrowserManager, BrowserPageSession } from './browser/BrowserManager.js';
import type { EventBus } from './realtime/EventBus.js';
import type { TestEnvironment } from './shared/types.js';
import { ProductionGuard } from './policy/ProductionGuard.js';

export async function startDemo(manager: BrowserManager, bus: EventBus, environment: TestEnvironment, register: (id: string, guard: ProductionGuard) => void): Promise<string[]> {
  const ids: string[] = [];
  try {
    const pages: BrowserPageSession[] = [];
    for (let index = 0; index < 2; index++) {
      const session = await manager.createSession({ environment: environment.name, mode: 'watch', viewport: { width: 1100, height: 820 } });
      ids.push(session.id);
      const guard = new ProductionGuard(environment); await guard.install(session.context);
      register(session.id, guard);
      const page = await manager.createPage(session.id);
      await page.page.goto(`${environment.baseURL}/debug/mouse`, { waitUntil: 'domcontentloaded' });
      pages.push(page);
    }
    // Demo-only pacing makes parallel pointers observable. Test execution never depends on it.
    void Promise.all(pages.map((page, index) => page.execute(async () => {
      const center = async (testId: string) => { const box = await page.page.getByTestId(testId).boundingBox(); if (!box) throw new Error(`Missing demo target ${testId}`); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
      for (let lap = 0; lap < 2; lap++) {
        const click = await center('click-target');
        await page.mouse.move(click.x, click.y, { steps: 16, durationMs: 600 + index * 200 });
        await page.mouse.click(click.x, click.y);
        const double = await center('double-target'); await page.mouse.move(double.x, double.y, { steps: 12, durationMs: 500 }); await page.mouse.doubleClick(double.x, double.y);
        const right = await center('right-target'); await page.mouse.move(right.x, right.y, { steps: 12, durationMs: 500 }); await page.mouse.click(right.x, right.y, { button: 'right' });
        await page.mouse.drag(await center('drag-source'), await center('drop-zone'), { steps: 25, durationMs: 900 });
        const scroll = await center('scroll-container'); await page.mouse.move(scroll.x, scroll.y, { steps: 12, durationMs: 500 }); await page.mouse.wheel(0, 180);
        await page.page.getByLabel('Your name').fill(`Worker ${index + 1}`);
      }
      bus.publish({ type: 'demo:completed', sessionId: page.sessionId, pageId: page.id });
    }))).catch(error => bus.publish({ type: 'demo:error', error: error instanceof Error ? error.message : 'Demo failed' }));
    return ids;
  } catch (error) { await Promise.all(ids.map(id => manager.closeSession(id).catch(() => {}))); throw error; }
}
