import { describe, it, expect, vi } from 'vitest';
import { dismissModalByStrategy } from './modal-dismissal.js';

/**
 * A page in a tab that is not the selected one in its window: ElementHandle.click()
 * waits on an IntersectionObserver that such a tab never runs, so it never settles.
 */
function hiddenTabPage() {
  let modalOpen = true;
  const button = {
    click: vi.fn(() => new Promise<void>(() => {})),
    scrollIntoView: vi.fn(async () => {}),
    clickablePoint: vi.fn(async () => ({ x: 40, y: 60 })),
    dispose: vi.fn(async () => {}),
  };
  const page = {
    evaluate: vi.fn(async () => ['#accept']),
    $: vi.fn(async () => button),
    mouse: { click: vi.fn(async () => { modalOpen = false; }) },
    waitForSelector: vi.fn(async () => {
      if (modalOpen) throw new Error('still visible');
    }),
  };
  return { page, button };
}

const banner = {
  type: 'cookie-consent',
  selector: '#cookie-banner',
  description: 'Cookie consent banner',
  dismissStrategies: ['accept', 'remove'],
} as any;

describe('dismissing a modal by clicking one of its buttons', () => {
  it('clicks at the button\'s point, so a tab that is not in front is dismissed too', async () => {
    const { page, button } = hiddenTabPage();

    const result = await Promise.race([
      dismissModalByStrategy(page as any, banner, 'accept', 1),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still waiting after 500ms')), 500)),
    ]);

    expect(result).toEqual({ success: true, method: 'Clicked button: #accept' });
    expect(page.mouse.click).toHaveBeenCalledWith(40, 60, {});
    expect(button.click).not.toHaveBeenCalled();
  });
});
