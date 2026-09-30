import type { FrameLocator, Locator, Page } from 'playwright';
import type { BrowserTarget, LocatorTarget } from '../shared/test-schema';

export function resolveLocator(page: Page, target: LocatorTarget): Locator {
  let scope: Page | FrameLocator = page;
  for (const selector of target.frames || []) scope = scope.frameLocator(selector);
  let locator: Locator;
  switch (target.strategy) {
    case 'role': locator = scope.getByRole(target.role, { name: target.name, exact: target.exact ?? true }); break;
    case 'label': locator = scope.getByLabel(target.label, { exact: target.exact ?? true }); break;
    case 'testId': locator = scope.getByTestId(target.testId); break;
    case 'text': locator = scope.getByText(target.text, { exact: target.exact ?? true }); break;
    case 'css': locator = scope.locator(target.selector); break;
  }
  return target.nth === undefined ? locator : locator.nth(target.nth);
}

export async function targetPosition(page: Page, target: BrowserTarget, timeout = 10_000): Promise<{ x: number; y: number }> {
  if (target.strategy === 'coordinates') {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (target.x >= viewport.width || target.y >= viewport.height) throw new Error('Coordinates must be inside the current CSS viewport');
    return { x: target.x, y: target.y };
  }
  const locator = resolveLocator(page, target);
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (!box) throw new Error('Target has no visible bounding box');
  // Playwright bounding boxes are already in the top-level CSS viewport, even inside frames.
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
