import type { Frame, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

const OVERLAY_TIMEOUT_MS = 15_000;

export function getAgentOverlays(frame: Frame): Locator {
  return frame.locator('[data-testid="agent-overlay"]');
}

export function getOverlayByText(frame: Frame, text: string): Locator {
  return getAgentOverlays(frame).filter({ hasText: text });
}

export function getOverlayByTexts(frame: Frame, texts: string[]): Locator {
  return texts.reduce<Locator>(
    (locator, text) => locator.filter({ hasText: text }),
    getAgentOverlays(frame),
  );
}

export async function expectOverlayCount(
  frame: Frame,
  count: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getAgentOverlays(frame)).toHaveCount(count, { timeout });
}

export async function expectOverlayVisible(
  frame: Frame,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByText(frame, text).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleWithTexts(
  frame: Frame,
  texts: string[],
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts).first()).toBeVisible({ timeout });
}

export async function expectNoOverlay(frame: Frame, text: string, timeout = 1_000): Promise<void> {
  await expect(getOverlayByText(frame, text)).toHaveCount(0, { timeout });
}

export async function expectNoOverlayWithTexts(
  frame: Frame,
  texts: string[],
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts)).toHaveCount(0, { timeout });
}

export async function readAgentOverlayIds(frame: Frame): Promise<number[]> {
  const rawIds = await getAgentOverlays(frame).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-agent-id')),
  );

  return rawIds.flatMap((value) => {
    const id = Number(value);
    return Number.isFinite(id) ? [id] : [];
  });
}

export async function expectSingleAgentOverlay(frame: Frame): Promise<number> {
  await expectOverlayCount(frame, 1);
  const ids = await readAgentOverlayIds(frame);
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one agent overlay id, got ${JSON.stringify(ids)}`);
  }
  return ids[0]!;
}
