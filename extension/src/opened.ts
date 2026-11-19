import type { ToBackground } from './messages.ts';

// The content script of the open page: the open address of a link, which the `open` command opens
// in the browser for an agent, or prints for the agent to open. The manifest runs it at the start
// of the document, in the top frame, on the bridge's port only. It marks the page, so the page's
// own script waits for the extension, and tells the service worker the link's code; the service
// worker asks the bridge whose link it is and remembers the tab's agent. Once the service worker
// has answered, or cannot be reached, the page goes on. It draws nothing and reads nothing of the
// page.

// The path of an open address: the code of a link is 32 lower-case hexadecimal characters.
const OPEN_PATH = /^\/open\/([0-9a-f]{32})$/;

markPage();
const code = OPEN_PATH.exec(location.pathname)?.[1];
// A load that comes from Back or Forward passes nothing on, as the open page itself does.
if (code !== undefined && navigationType() !== 'back_forward') void tell(code);

// Sets the attribute data-clicknote on the root element, before the page's own script runs: when
// the root element is not there yet, as soon as the parser adds it.
function markPage(): void {
  if (document.documentElement) {
    document.documentElement.setAttribute('data-clicknote', '');
    return;
  }
  const watching = new MutationObserver(() => {
    if (!document.documentElement) return;
    document.documentElement.setAttribute('data-clicknote', '');
    watching.disconnect();
  });
  watching.observe(document, { childList: true });
}

// How the document came to load: `navigate`, `reload`, `back_forward` or `prerender`.
function navigationType(): string | undefined {
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type;
}

// Tells the service worker the code, then the page, with the event clicknote:linked. Also when
// the message fails: the page then goes on as it does without the extension.
async function tell(code: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage<ToBackground, { ok: boolean }>({ type: 'opened', code });
  } catch {
    // No service worker to tell; the page needs nothing more.
  }
  document.dispatchEvent(new Event('clicknote:linked'));
}
