/**
 * dndKitDrag.ts
 *
 * Mouse-based drag helper compatible with dnd-kit's PointerSensor.
 *
 * Background: dnd-kit's PointerSensor has `activationConstraint: { distance: 8 }`
 * by default. Generic `dragTo()` helpers don't respect this — they trigger
 * `pointerdown` + `pointerup` without the intermediate movement needed to
 * exceed the constraint. As a result, dnd-kit never starts a drag session.
 *
 * This helper replicates the correct sequence:
 *   1. Move to source center
 *   2. pointerdown
 *   3. Small move (15 px) in multiple steps to exceed the 8 px constraint
 *   4. Scroll target into view (mid-drag) — the board has more droppable
 *      columns than fit in one 1920px viewport (feature BLOQUEADO, 2026-07-03,
 *      added a 9th column), so source and target frequently can't be visible
 *      simultaneously. Source position is captured BEFORE this scroll (mouse
 *      is already down by then), and only the target needs to be visible for
 *      the final move — mirrors a real user scrolling the board mid-drag.
 *   5. Main move to target center (re-measured post-scroll) in many steps so
 *      dnd-kit's collision detection registers the correct drop target
 *   6. pointerup
 *
 * Tested against dnd-kit v6 in Playwright Chromium (headless + headed).
 */

import type { Locator, Page } from '@playwright/test';

export interface DndKitDragOptions {
  /**
   * Number of steps for the initial "activation" movement.
   * Must be enough to trigger move events: default 6.
   */
  activationSteps?: number;
  /**
   * Number of steps for the main drag movement towards the target.
   * More steps = smoother path = more reliable drop detection: default 25.
   */
  mainSteps?: number;
  /**
   * Milliseconds to wait after pointerdown before starting movement.
   * Gives React time to attach event listeners: default 80.
   */
  pauseAfterDown?: number;
  /**
   * Milliseconds to wait after pointerup before resolving.
   * Gives dnd-kit's handleDragEnd + React re-render time to complete: default 400.
   */
  pauseAfterUp?: number;
}

/**
 * Performs a dnd-kit–compatible drag from `source` to `target` using raw
 * mouse events. Does NOT modify any production activation constraints.
 *
 * @param page   - Playwright Page
 * @param source - Locator for the draggable element
 * @param target - Locator for the drop-target element
 * @param opts   - Fine-tuning options (see DndKitDragOptions)
 */
export async function dndKitDrag(
  page: Page,
  source: Locator,
  target: Locator,
  opts: DndKitDragOptions = {},
): Promise<void> {
  const {
    activationSteps = 6,
    mainSteps = 25,
    pauseAfterDown = 80,
    pauseAfterUp = 400,
  } = opts;

  const sb = await source.boundingBox();

  if (!sb) throw new Error('dndKitDrag: source element has no bounding box (not visible?)');

  const startX = sb.x + sb.width / 2;
  const startY = sb.y + sb.height / 2;

  // 1. Position cursor on source
  await page.mouse.move(startX, startY);

  // 2. Press down
  await page.mouse.down();

  // 3. Brief pause so React has time to register the pointerdown listener
  if (pauseAfterDown > 0) {
    await page.waitForTimeout(pauseAfterDown);
  }

  // 4. Small activation move — exceeds the 8 px activationConstraint
  //    Moving diagonally is more reliable than purely horizontal.
  await page.mouse.move(
    startX + 15,
    startY + 5,
    { steps: activationSteps },
  );

  // 4b. Scroll the (horizontally overflowing) board so the target column is
  //     visible, then re-measure — source may now be off-screen, which is
  //     fine: the pointer is already "down" at its captured start position.
  await target.scrollIntoViewIfNeeded();
  const tb = await target.boundingBox();
  if (!tb) throw new Error('dndKitDrag: target element has no bounding box after scrollIntoViewIfNeeded (not visible?)');
  const endX = tb.x + tb.width / 2;
  const endY = tb.y + tb.height / 2;

  // 5. Main move towards drop target in many steps so dnd-kit's collision
  //    detection can compute the correct `over` container at each frame.
  await page.mouse.move(endX, endY, { steps: mainSteps });

  // 6. Release
  await page.mouse.up();

  // 7. Let handleDragEnd + React state update propagate
  if (pauseAfterUp > 0) {
    await page.waitForTimeout(pauseAfterUp);
  }
}
