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

/** A page whose evaluate runs in this happy-dom document, and whose clicks remove the banner. */
const document = (globalThis as any).document;

function domPage(html: string) {
  document.body.innerHTML = html;
  const clicked: string[] = [];
  return {
    clicked,
    page: {
      evaluate: async (fn: any, ...args: any[]) => fn(...args),
      $: async (sel: string) => {
        const el = document.querySelector(sel);
        return el ? {
          scrollIntoView: async () => {},
          clickablePoint: async () => { clicked.push(el.textContent!.trim()); document.getElementById('banner')?.remove(); return { x: 1, y: 1 }; },
          dispose: async () => {},
        } : null;
      },
      mouse: { click: async () => {} },
      waitForSelector: async (sel: string) => { if (document.querySelector(sel)) throw new Error('visible'); },
    },
  };
}

const cookieBanner = { type: 'cookie-consent', selector: '#banner', description: 'Cookie consent banner', dismissStrategies: ['accept', 'reject', 'remove'] } as any;

describe('choosing the button to click', () => {
  it('does not read "Cookie settings" as an accept button', async () => {
    const { page, clicked } = domPage('<div id="banner"><button>Cookie settings</button><button>Accept all</button></div>');

    await dismissModalByStrategy(page as any, cookieBanner, 'accept', 1);

    expect(clicked).toEqual(['Accept all']);
  });

  it('does not read a class merely containing "no" as a reject button', async () => {
    const { page, clicked } = domPage('<div id="banner"><button class="notification-link">Details</button><button class="btn-reject">Reject</button></div>');

    await dismissModalByStrategy(page as any, cookieBanner, 'reject', 1);

    expect(clicked).toEqual(['Reject']);
  });

  it('reaches a button whose id or class needs escaping in a selector', async () => {
    const { page, clicked } = domPage('<div id="banner"><button id="accept:1">Accept</button></div>');

    const result = await dismissModalByStrategy(page as any, cookieBanner, 'accept', 1);

    expect(result.success).toBe(true);
    expect(clicked).toEqual(['Accept']);
  });

  it('reaches the matched button when neither id nor class names it', async () => {
    const { page, clicked } = domPage('<div id="banner"><p><button>Help</button></p><p><button>Accept</button></p></div>');

    const result = await dismissModalByStrategy(page as any, cookieBanner, 'accept', 1);

    expect(result.success).toBe(true);
    expect(clicked).toEqual(['Accept']);
  });
});
