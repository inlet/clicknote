"use strict";
(() => {
  // shared/clean.ts
  var HIDDEN_CHARACTERS = /[\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu;
  var HIDDEN_HTML = /<!--[\s\S]*?(?:-->|$)|(<(script|style)(?=[\s/>])[^>]*>)[\s\S]*?(?=<\/\2[\s/>]|$)/gi;
  function cleanText(text) {
    return text.replace(HIDDEN_CHARACTERS, "");
  }
  function cleanHtml(html) {
    let cleaned = cleanText(html);
    for (let before = ""; cleaned !== before; ) {
      before = cleaned;
      cleaned = cleaned.replace(HIDDEN_HTML, (_match, openingTag) => openingTag ?? "");
    }
    return cleaned;
  }
  var SPACE = /\p{White_Space}+/gu;
  function cleanLine(text) {
    return cleanText(text).replace(SPACE, " ").trim();
  }
  function cleanAnnotation(annotation) {
    return {
      ...annotation,
      label: cleanLine(annotation.label),
      selector: cleanText(annotation.selector),
      domPath: cleanText(annotation.domPath),
      text: cleanText(annotation.text),
      html: cleanHtml(annotation.html),
      styles: Object.fromEntries(Object.entries(annotation.styles).map(([prop, value]) => [prop, cleanText(value)]))
    };
  }
  function cleanPage(page) {
    return { ...page, title: cleanText(page.title) };
  }

  // shared/markdown.ts
  var INTENT_HEADING = { change: "Change", question: "Question" };
  var SHADOW_SEPARATOR = " >> ";
  var SELECTOR_NOTE = "- Selector note: ` >> ` steps into an open shadow root; the part after it is a selector inside that root";
  function renderMarkdown(rawPage, note, annotations) {
    const page = cleanPage(rawPage);
    const blocks = [
      "# Browser annotations",
      lines([
        page.title ? `- Page: ${code(page.title)} (${page.url})` : `- Page: ${page.url}`,
        page.sourceFile && `- Source file: ${code(page.sourceFile)}`,
        `- Viewport: ${page.viewport.width}x${page.viewport.height} at ${page.devicePixelRatio}x`,
        `- Annotations: ${annotations.length}`
      ])
    ];
    const generalComment = note.trim();
    if (generalComment) blocks.push("## General comment", generalComment);
    for (const annotation of annotations) blocks.push(...annotationBlocks(cleanAnnotation(annotation)));
    return `${blocks.filter((block) => block !== "").join("\n\n")}
`;
  }
  function annotationBlocks(annotation) {
    const { x, y, width, height } = roundRect(annotation.rect);
    const styles = Object.entries(annotation.styles).map(([prop, value]) => `${prop}: ${value}`).join("; ");
    return [
      `## ${annotation.number}. ${INTENT_HEADING[annotation.intent]}: ${code(annotation.label)}`,
      annotation.comment.trim(),
      lines([
        `- ID: ${code(annotation.id)}`,
        `- Selector: ${code(annotation.selector)}`,
        annotation.selector.includes(SHADOW_SEPARATOR) ? SELECTOR_NOTE : null,
        `- DOM path: ${code(annotation.domPath)}`,
        `- Position: x ${x}, y ${y}, ${width}x${height}`,
        annotation.screenshot && `- Screenshot: ${code(annotation.screenshot)}`,
        styles && `- Styles: ${code(styles)}`
      ]),
      ...annotation.text ? ["Text:", fence(annotation.text)] : [],
      "HTML:",
      fence(annotation.html, "html")
    ];
  }
  function roundRect({ x, y, width, height }) {
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  function lines(items) {
    return items.filter((item) => item).join("\n");
  }
  function fence(content, info = "") {
    const ticks = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    return `${ticks}${info}
${content}
${ticks}`;
  }
  function code(content) {
    const run = longestBacktickRun(content);
    if (run === 0) return `\`${content}\``;
    const ticks = "`".repeat(run + 1);
    return `${ticks} ${content} ${ticks}`;
  }
  function longestBacktickRun(content) {
    return (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  }

  // shared/url.ts
  function parseUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }
  function filePath(url) {
    const parsed = parseUrl(url);
    if (parsed?.protocol !== "file:") return null;
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  }
  function sourceFile(url) {
    const path = filePath(url);
    if (path === null) return null;
    const host = parseUrl(url)?.host;
    if (host) return `\\\\${host}${path.replaceAll("/", "\\")}`;
    if (/^\/[A-Za-z]:(\/|$)/.test(path)) return path.slice(1).replaceAll("/", "\\");
    return path;
  }

  // shared/types.ts
  var WAIT_SENTENCE = "Wait for my annotations with the clicknote skill.";
  var STYLE_PROPS = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "margin",
    "padding",
    "display"
  ];

  // extension/src/bridge-client.ts
  function failed(problem) {
    return { ok: false, kind: "failed", message: messageOf(problem) };
  }
  function unanswered(problem) {
    return { ...failed(problem), own: "none" };
  }
  function messageOf(problem) {
    if (typeof problem === "string") return problem;
    if (problem instanceof Error) return problem.message;
    const message = problem?.message;
    return typeof message === "string" ? message : String(problem);
  }

  // shared/label.ts
  function agentLabel(agent) {
    const number = agent.number === null ? "" : String(agent.number);
    return [agent.folder, agent.about, agent.harness, number].filter((part) => part !== "").join(" \xB7 ");
  }
  function listedAs(agent) {
    return agent.waiting ? `\u25CF ${agentLabel(agent)} \xB7 waiting` : `\u25CB ${agentLabel(agent)}`;
  }

  // extension/src/follow.ts
  var FOLLOW_FIRST_MS = 300;
  var FOLLOW_EVERY_MS = 2e3;
  var FOLLOW_FOR_MS = 3e4;
  var SENDING = "Sending\u2026";
  var WAIT_OFFER = { text: WAIT_SENTENCE, button: "Copy sentence" };
  var SEND_OFF = {
    bridge_down: {
      text: "No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.",
      offer: WAIT_OFFER
    }
  };
  var NO_ANSWER = {
    text: "Clicknote did not answer this send. Say this to your coding agent; this line then says whether the send arrived.",
    tone: "problem",
    offer: WAIT_OFFER
  };
  var AGENT_GONE = "That agent is no longer listed. Choose another.";
  var NOT_ARRIVED = "This send did not arrive. Send again.";
  var LIST_STAYS = "The list has changed since, so it stays.";
  function sendOff(error) {
    if (error.kind === "version_mismatch") return { text: error.message };
    return SEND_OFF[error.kind] ?? null;
  }
  function noAnswer(error) {
    return error.kind === "bridge_down" || "own" in error && error.own === "none";
  }
  function settled(state) {
    return state === "picked_up" || state === "unknown" || state === "agent_gone";
  }
  function shows(reply, agent, count, arrived) {
    const sent = `Sent ${count} ${count === 1 ? "annotation" : "annotations"} to ${agentLabel(agent)}`;
    const them = count === 1 ? "it" : "them";
    const line = reply.line === null ? {} : { offer: { text: reply.line, button: "Copy line", code: true } };
    const shown = (() => {
      switch (reply.state) {
        case "sending":
          return { text: SENDING, tone: "quiet" };
        case "queued":
          return { text: `${sent}. Queued: the agent gets ${them} when it next waits.`, tone: "quiet", ...line };
        case "picked_up":
          return { text: `${sent}. The agent picked ${them} up.`, tone: "done" };
        case "agent_gone":
          return {
            text: `${sent}, but that agent is no longer listed and did not pick ${them} up. Copy the line and paste it into another agent. If that agent comes back and waits again, it still gets ${them}.`,
            tone: "problem",
            ...line
          };
        case "unknown":
          return arrived ? { text: `${sent}. Clicknote no longer knows whether the agent picked ${them} up.`, tone: "problem", ...line } : { text: NOT_ARRIVED, tone: "problem" };
      }
    })();
    return reply.kept ? { ...shown, text: `${shown.text} ${LIST_STAYS}` } : shown;
  }
  function sendFailed(error) {
    if (noAnswer(error)) return NO_ANSWER;
    if (error.kind === "version_mismatch") return { text: error.message, tone: "problem" };
    if (error.kind === "agent_gone") return { text: AGENT_GONE, tone: "problem" };
    return { text: `Sending failed: ${error.message}`, tone: "problem" };
  }
  async function follow(deps) {
    const { ask, show, sleep, now, from, signal, delay = 0 } = deps;
    if (delay > 0) {
      await sleep(delay);
      if (signal.aborted) return null;
    }
    for (; ; ) {
      const reply = await ask();
      if (signal.aborted) return reply;
      show(reply);
      if (!reply.ok || settled(reply.state)) return reply;
      if (reply.state !== "sending" && now() - from >= FOLLOW_FOR_MS) return reply;
      await sleep(FOLLOW_EVERY_MS);
      if (signal.aborted) return reply;
    }
  }

  // extension/src/content/look.ts
  var BOTH = {
    fill: "#A9B5FF",
    // Send and Add
    "on-fill": "#1B1B1F",
    "fill-hover": "#BAC4FF",
    marker: "#FFFFFF",
    // the disc of a marker and of a badge in the list
    "marker-ink": "#1B1B1F",
    // its outline and its number
    "marker-focus": "#6C74E8",
    // a marker's focus ring: light mode's focus, also on a dark system
    change: "#B9F27C",
    // the hard shadow of a Change
    question: "#A9B5FF",
    // and of a Question
    "icon-bar": "#A9B5FF",
    // the icon: the title bar of its window,
    "icon-bubble": "#FFD08A",
    // its speech bubble,
    "icon-prompt": "#1B1B1F"
    // and the prompt in that bubble
  };
  var LIGHT = {
    ...BOTH,
    surface: "#FFFFFF",
    // the bar and the popup
    text: "#1B1B1F",
    muted: "#55555F",
    "panel-ring": "rgba(108, 99, 255, 0.14)",
    "panel-shadow": "rgba(108, 99, 255, 0.22)",
    hover: "#F0F1FF",
    // a row or a button under the pointer
    footer: "#FAFAFF",
    // the bar's lower part: the comment, the dropdown, the buttons
    "footer-line": "rgba(108, 99, 255, 0.14)",
    field: "#FFFFFF",
    // the general comment and the dropdown
    well: "#F5F5FF",
    // the popup's comment and a text on offer
    "field-ring": "rgba(27, 27, 31, 0.14)",
    focus: "#6C74E8",
    count: "#EEF0FF",
    // the count in the bar's title
    "count-text": "#2F3490",
    pressed: "#E4E7FF",
    // Pick while it is on
    segment: "#EEF0FF",
    // the Change and Question switch
    "segment-on": "#FFFFFF",
    "segment-text": "#55555F",
    "segment-shadow": "rgba(27, 27, 31, 0.15)",
    "outline-ground": "#FFFFFF",
    // Copy, an outlined pill
    "off-ground": "#ECECF1",
    // a filled pill that is off
    "off-text": "#5E5E68",
    // the text of any button that is off
    "off-line": "#C9C9D2",
    // the outline of an outlined pill that is off
    "good-ground": "#ECF9DD",
    // the status line when something worked
    "bad-ground": "#FFEFEC",
    // the status line when the user has to act
    bad: "#A3271B",
    "pick-line": "#6C74E8",
    // the outline of the element under the pointer
    "pick-fill": "rgba(169, 181, 255, 0.22)",
    "icon-ink": "#1B1B1F",
    // the icon's lines
    "icon-paper": "#FFFFFF"
    // and the window's body
  };
  var DARK = {
    ...BOTH,
    surface: "#1F1F26",
    text: "#F2F2F4",
    muted: "#A9A9B4",
    "panel-ring": "rgba(169, 181, 255, 0.22)",
    "panel-shadow": "rgba(0, 0, 0, 0.55)",
    hover: "#2A2A33",
    footer: "#1A1A20",
    "footer-line": "rgba(169, 181, 255, 0.18)",
    field: "#16161C",
    well: "#16161C",
    "field-ring": "rgba(255, 255, 255, 0.16)",
    focus: "#8C94F5",
    count: "#2F3360",
    "count-text": "#C9CEFF",
    pressed: "#33365C",
    segment: "#2A2A33",
    "segment-on": "#45454F",
    "segment-text": "#B4B4BE",
    "segment-shadow": "rgba(0, 0, 0, 0)",
    "outline-ground": "#1A1A20",
    "off-ground": "#2A2A33",
    "off-text": "#9C9CA7",
    "off-line": "#4A4A55",
    "good-ground": "#25311E",
    "bad-ground": "#3A2226",
    bad: "#FFB4A8",
    "pick-line": "#8C94F5",
    "pick-fill": "rgba(169, 181, 255, 0.16)",
    "icon-ink": "#F2F2F4",
    "icon-paper": "#2A2A33"
  };
  var ICON = {
    viewBox: "0 0 64 64",
    strokeWidth: 3.6,
    shapes: [
      { tag: "rect", attrs: { x: "7", y: "7", width: "37", height: "33", rx: "7" }, fill: "icon-paper" },
      { tag: "path", attrs: { d: "M7 14a7 7 0 0 1 7-7h23a7 7 0 0 1 7 7v4H7z" }, fill: "icon-bar" },
      { tag: "path", attrs: { d: "M35 27h14a8 8 0 0 1 8 8v10a8 8 0 0 1-8 8H33a8 8 0 0 1-8-8V36l-7-10z" }, fill: "icon-bubble" },
      { tag: "path", attrs: { d: "M34 35l5.5 5-5.5 5M44 45h7" }, stroke: "icon-prompt" }
    ]
  };

  // extension/src/content/ui.ts
  var HOST_TAG = "clicknote-ui";
  function createUi() {
    const host = document.createElement(HOST_TAG);
    host.toggleAttribute("data-off", true);
    const root = host.attachShadow({ mode: false ? "open" : "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];
    const shield = h("div", { class: "shield" });
    shield.hidden = true;
    const box = h("div", { part: "highlight", class: "highlight" });
    box.hidden = true;
    root.append(shield, box);
    for (const type of STOPPED_EVENTS) root.addEventListener(type, (event) => event.stopPropagation());
    document.documentElement.append(host);
    let highlighted = null;
    const followHighlight = () => {
      const rect = highlighted?.isConnected ? highlighted.getBoundingClientRect() : null;
      box.hidden = !rect || rect.width === 0 && rect.height === 0;
      if (rect) placeAt(box, rect.left, rect.top, rect.width, rect.height);
    };
    const highlight = (el) => {
      highlighted = el;
      followHighlight();
    };
    return {
      root,
      host,
      shield,
      show: () => host.toggleAttribute("data-off", false),
      // The outline goes too, so it does not come back on an old element with the UI.
      hide() {
        highlight(null);
        host.toggleAttribute("data-off", true);
      },
      visible: () => !host.hasAttribute("data-off"),
      highlight,
      followHighlight,
      // The screenshot must show the page as the user sees it without our UI on top.
      async hiddenDuring(work) {
        host.toggleAttribute("data-capturing", true);
        try {
          await nextFrames(2);
          return await work();
        } finally {
          host.toggleAttribute("data-capturing", false);
        }
      },
      // The host is fixed to the whole viewport, without scroll bars. Unlike the root element's
      // client size, this is also right on a page in quirks mode.
      viewport: () => ({ width: host.clientWidth, height: host.clientHeight })
    };
  }
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    if (props.part) el.dataset.clicknote = props.part;
    if (props.class) el.className = props.class;
    if (props.text !== void 0) el.textContent = props.text;
    for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
    el.append(...children);
    if (el instanceof HTMLButtonElement) el.type = "button";
    return el;
  }
  var ICONS = {
    pick: ["M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3", "M8 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"],
    chevron: ["M4 6l4 4 4-4"],
    trash: ["M2.5 4.5h11", "M6 4.5V3h4v1.5", "M4 4.5l.6 9h6.8l.6-9", "M6.75 7v4M9.25 7v4"],
    change: ["M3 13l.7-3 6.8-6.8a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L6 12.3z"],
    question: ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.4-.9.8-.9 1.4", "M8 11.4v.1"]
  };
  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  function logo() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", ICON.viewBox);
    svg.setAttribute("class", "logo");
    svg.setAttribute("aria-hidden", "true");
    for (const { tag, attrs, fill, stroke } of ICON.shapes) {
      const shape = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
      if (fill) shape.style.fill = `var(--cn-${fill})`;
      if (stroke) shape.style.stroke = `var(--cn-${stroke})`;
      svg.append(shape);
    }
    return svg;
  }
  function trusted(handler) {
    return (event) => {
      if (event.isTrusted) handler(event);
    };
  }
  function placeAt(el, left, top, width, height) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (width !== void 0) el.style.width = `${width}px`;
    if (height !== void 0) el.style.height = `${height}px`;
  }
  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }
  var SVG = "http://www.w3.org/2000/svg";
  var STOPPED_EVENTS = [
    "keydown",
    "keyup",
    "keypress",
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "focusin",
    "focusout"
  ];
  function nextFrames(count) {
    return new Promise((done) => {
      const timer = setTimeout(done, 250);
      const step = (left) => {
        if (left === 0) {
          clearTimeout(timer);
          done();
        } else {
          requestAnimationFrame(() => step(left - 1));
        }
      };
      step(count);
    });
  }
  function properties(tokens) {
    return Object.entries(tokens).map(([name, value]) => `--cn-${name}: ${value} !important;`).join("\n  ");
  }
  var MONOSPACE = "ui-monospace, SFMono-Regular, Menlo, monospace";
  var STYLES = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  display: block !important;
  pointer-events: none !important;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif !important;
  color: var(--cn-text) !important;
  -webkit-font-smoothing: antialiased;
  color-scheme: light dark;

  ${properties(LIGHT)}
}
@media (prefers-color-scheme: dark) {
  :host {
    ${properties(DARK)}
  }
}
:host([data-off]) { display: none !important; }
:host([data-capturing]) { visibility: hidden !important; }
/* The shield draws nothing, so it stays during a capture: a second click goes to it, not to the page. */
:host([data-capturing]) .shield { visibility: visible; }

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { margin: 0; font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--cn-focus); outline-offset: 2px; }
.icon {
  flex: none; width: 16px; height: 16px;
  fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.logo {
  flex: none; width: 26px; height: 26px;
  fill: none; stroke: var(--cn-icon-ink); stroke-width: ${ICON.strokeWidth}; stroke-linecap: round; stroke-linejoin: round;
}

.shield { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
.highlight {
  position: fixed; pointer-events: none;
  border: 2px solid var(--cn-pick-line); border-radius: 10px; background: var(--cn-pick-fill);
}

/* A marker on the page and its badge in the list: a white disc with a dark outline and a hard
   shadow to its lower right, green for a Change and lilac for a Question, in both modes. With a
   padding of only 2px, a number of two digits fits inside the disc; one of three makes it a pill.
   The marker's focus ring is the same in both modes too. */
.marker, .badge {
  --cn-kind: var(--cn-change);
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 26px; height: 26px; padding: 0 2px;
  border: 1.75px solid var(--cn-marker-ink); border-radius: 13px;
  background: var(--cn-marker); color: var(--cn-marker-ink);
  font-size: 12px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
  box-shadow: 3px 3px 0 var(--cn-kind);
}
[data-intent="question"] { --cn-kind: var(--cn-question); }
.marker { position: fixed; pointer-events: auto; cursor: pointer; }
.marker:focus-visible { outline-color: var(--cn-marker-focus); }
.badge { min-width: 24px; height: 24px; border-radius: 12px; font-size: 11px; box-shadow: 2.5px 2.5px 0 var(--cn-kind); }

.panel {
  position: fixed; pointer-events: auto;
  background: var(--cn-surface); color: var(--cn-text);
  box-shadow: 0 0 0 1px var(--cn-panel-ring), 0 18px 44px var(--cn-panel-shadow);
}

/* Every button is a pill: plain, round, tinted while pressed, filled (Send, Add) or outlined
   (Copy). A button that is off keeps its shape and greys its text. */
.pill {
  flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 11px; border: none; border-radius: 15px;
  background: transparent; color: var(--cn-text);
  font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer;
}
.pill:enabled:hover { background: var(--cn-hover); }
.pill[aria-pressed="true"], .pill[aria-pressed="true"]:enabled:hover { background: var(--cn-pressed); }
.pill.round { width: 30px; padding: 0; }
.pill.tall { height: 34px; padding: 0 15px; border-radius: 17px; }
.pill.filled { padding: 0 14px; background: var(--cn-fill); color: var(--cn-on-fill); font-weight: 700; }
.pill.tall.filled { padding: 0 19px; }
.pill.filled:enabled:hover { background: var(--cn-fill-hover); }
.pill.outlined { border: 1.5px solid var(--cn-text); background: var(--cn-outline-ground); }
.pill.outlined:enabled:hover { background: var(--cn-hover); }
.pill.danger:enabled:hover { color: var(--cn-bad); }
.pill:disabled { color: var(--cn-off-text); cursor: default; }
.pill.filled:disabled { background: var(--cn-off-ground); }
.pill.outlined:disabled { border-color: var(--cn-off-line); }
.pill .icon { width: 14px; height: 14px; }
.pill.round .icon { width: 16px; height: 16px; }

.bar {
  right: 28px; bottom: 28px; width: 308px; max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; overflow: hidden; border-radius: 26px;
}
.bar-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 14px; cursor: grab; user-select: none; touch-action: none; }
/* Collapsed to its header, the bar is a pill with as much room above its buttons as below. */
.bar:has(> .bar-body[hidden]) .bar-header { padding-bottom: 12px; }
.bar-header.dragging { cursor: grabbing; }
.bar-title { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; font-weight: 700; }
.count {
  min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px;
  background: var(--cn-count); color: var(--cn-count-text);
  font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; font-variant-numeric: tabular-nums;
}
.collapse[aria-expanded="false"] .icon { transform: rotate(180deg); }
/* In a window lower than the bar, the list, its hint and the messages under the comment give way,
   each in proportion to its height, and scroll; the header, the comment, the dropdown and the
   buttons keep theirs. */
.bar-body { display: flex; flex-direction: column; min-height: 0; }
.list { min-height: 0; max-height: 40vh; margin: 0; padding: 2px 8px 8px; list-style: none; overflow-y: auto; scrollbar-width: thin; }
.empty { min-height: 0; margin: 0; padding: 2px 16px 14px; overflow: hidden; color: var(--cn-muted); font-size: 12px; }
.row {
  display: flex; align-items: flex-start; gap: 11px; width: 100%; padding: 8px;
  border: none; border-radius: 16px; background: transparent; color: var(--cn-text); text-align: left; cursor: pointer;
}
.row:hover { background: var(--cn-hover); }
/* Inside the row, so the list, which scrolls and so cuts off what lies past its edges, shows all
   of it, also above the first row. */
.row:focus-visible { outline-offset: -2px; }
.row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-comment {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; white-space: pre-line;
}
.row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--cn-muted); font-size: 11px; }
.row-meta .icon { width: 12px; height: 12px; }
.not-found { color: var(--cn-bad); }
.crop { display: block; align-self: flex-start; max-width: 100%; margin-top: 4px; border-radius: 8px; box-shadow: 0 0 0 1px var(--cn-field-ring); }
/* The lower part, on a ground of its own under a line: the comment, the messages, the dropdown and
   the buttons, 8px apart. Under the messages, half of that is padding, which scrolls with them and
   leaves room for the focus ring of their button; the other half is a border, which stays between
   them and the dropdown when they are cut off. */
.footer { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 8px; background: var(--cn-footer); }
.footer-start { padding-top: 10px; border-top: 1px solid var(--cn-footer-line); }
.messages {
  flex: 0 1 auto; min-height: 0; padding-bottom: 4px; border-bottom: 4px solid var(--cn-footer);
  overflow-y: auto; scrollbar-width: thin;
}
.footer-end { padding-bottom: 12px; }
.bar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
/* Across the whole footer, with its own arrow at the end. An entry too long for it is cut at its
   end with an ellipsis, before the arrow, so the dot at its start stays; its title has all of it. */
.agent { position: relative; }
.agent-select {
  display: block; width: 100%; height: 34px; margin: 0; padding: 0 32px 0 12px;
  border: none; border-radius: 17px; outline: none; appearance: none;
  background: var(--cn-field); color: var(--cn-text); box-shadow: 0 0 0 1px var(--cn-field-ring);
  font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agent-select:focus-visible { box-shadow: 0 0 0 2px var(--cn-focus); }
/* "Choose an agent\u2026" and "No agent listening" are no agent. */
.agent-select:has(option[value=""]:checked) { color: var(--cn-muted); }
.agent .icon { position: absolute; top: 10px; right: 12px; width: 14px; height: 14px; color: var(--cn-text); pointer-events: none; }
/* Plain while something runs; on a green ground when it worked, on a red one when the user has to act. */
.status { margin: 0; padding: 0 2px; color: var(--cn-muted); font-size: 12px; overflow-wrap: anywhere; user-select: text; }
.status[data-tone="done"], .status[data-tone="problem"] { padding: 8px 12px; border-radius: 14px; }
.status[data-tone="done"] { background: var(--cn-good-ground); color: var(--cn-text); }
.status[data-tone="problem"] { background: var(--cn-bad-ground); color: var(--cn-bad); }
/* A text for the user to copy: one click selects all of it, and it wraps anywhere in the narrow
   bar. A sentence is set in the bar's own font, a line to paste as it is in a fixed-width one. */
.status-offer { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.offer {
  display: block; align-self: stretch; margin: 0; padding: 8px 11px; border-radius: 14px;
  background: var(--cn-well); color: var(--cn-text); box-shadow: 0 0 0 1px var(--cn-field-ring);
  font-size: 12px; overflow-wrap: anywhere; user-select: all;
}
.offer.code { font: 11px/1.45 ${MONOSPACE}; }
.clipboard { position: fixed; top: 0; left: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }

.popup { width: 344px; padding: 14px; display: flex; flex-direction: column; gap: 10px; border-radius: 24px; }
.popup-label {
  padding: 0 2px; overflow: hidden; color: var(--cn-muted); white-space: nowrap; text-overflow: ellipsis;
  font: 11px/1.4 ${MONOSPACE};
}
.comment, .note {
  display: block; width: 100%; margin: 0; resize: vertical;
  border: none; border-radius: 14px; outline: none; box-shadow: 0 0 0 1px var(--cn-field-ring);
  color: var(--cn-text); font: inherit; line-height: 1.4;
}
.comment { min-height: 72px; max-height: 40vh; padding: 9px 12px; background: var(--cn-well); font-size: 13px; }
.comment:focus, .note:focus { box-shadow: 0 0 0 2px var(--cn-focus); }
.comment::placeholder, .note::placeholder { color: var(--cn-muted); opacity: 1; }
/* Never lower than four lines of its own text, also in a short window and after a drag of its
   corner; up to a quarter of the window where that is more. A height here counts the padding
   (border-box), 8px above and below. The first of each pair is for a browser without the unit lh:
   four lines at the line height of 1.4, as its rows give. */
.note {
  min-height: calc(5.6em + 16px); min-height: calc(4lh + 16px);
  max-height: max(25vh, calc(5.6em + 16px)); max-height: max(25vh, calc(4lh + 16px));
  padding: 8px 11px; background: var(--cn-field); font-size: 12px;
}
.note:read-only { color: var(--cn-muted); }
/* The switch, then Delete, Cancel and Add or Save at the right end. Where they do not fit in one
   row, as with Delete, the buttons go to a row of their own as a group, in the same order. */
.popup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 6px; }
.popup-buttons { display: flex; align-items: center; gap: 6px; margin-left: auto; }
/* Delete, a size smaller than the pills beside it. */
.pill.round.small { width: 26px; height: 26px; }
.segmented { display: inline-flex; padding: 3px; border-radius: 15px; background: var(--cn-segment); }
.segmented button {
  height: 24px; padding: 0 11px; border: none; border-radius: 12px;
  background: transparent; color: var(--cn-segment-text); font-size: 12px; font-weight: 500; cursor: pointer;
}
.segmented button[aria-pressed="true"] {
  background: var(--cn-segment-on); color: var(--cn-text); font-weight: 600; box-shadow: 0 1px 2px var(--cn-segment-shadow);
}
`;

  // extension/src/content/bar.ts
  var HINT_PICKING = "Click an element on the page to annotate it.";
  var HINT_NOT_PICKING = "Turn on Pick, then click an element to annotate it.";
  var NO_AGENT = "No agent listening";
  var CHOOSE_AGENT = "Choose an agent\u2026";
  var OFFER_COPIED = "Copied";
  var CROP_HEIGHT = 72;
  function createBar(ui, handlers) {
    const count = h("span", { part: "count", class: "count", text: "0" });
    const pick = h("button", {
      part: "pick-toggle",
      class: "pill",
      attrs: { "aria-pressed": "false", title: "Pick an element (Esc to stop)" }
    }, icon("pick"), "Pick");
    const collapse2 = h("button", {
      part: "collapse",
      class: "pill round collapse",
      attrs: { "aria-expanded": "true", "aria-label": "Collapse", title: "Collapse" }
    }, icon("chevron"));
    const title = h("div", { class: "bar-title" }, logo(), h("span", { text: "Annotations" }), count);
    const header = h("div", { class: "bar-header" }, title, pick, collapse2);
    const list = h("ol", { part: "list", class: "list" });
    const hint = h("p", { class: "empty", text: HINT_NOT_PICKING });
    const noteField = h("textarea", {
      part: "note",
      class: "note",
      attrs: { rows: "4", "aria-label": "General comment", placeholder: "General comment for the agent (optional)" }
    });
    const select = h("select", { part: "agent-select", class: "agent-select", attrs: { "aria-label": "Agent" } });
    const copy = h("button", {
      part: "copy",
      class: "pill tall outlined",
      text: "Copy",
      attrs: { title: "Copy to the clipboard instead of sending" }
    });
    const send = h("button", { part: "send", class: "pill tall filled", text: "Send" });
    const status = h("p", { part: "status", class: "status", attrs: { role: "status" } });
    status.hidden = true;
    const offer = h("p", { part: "offer", class: "offer" });
    const copyOffer = h("button", { part: "copy-offer", class: "pill outlined" });
    const statusOffer = h("div", { part: "status-offer", class: "status-offer" }, offer, copyOffer);
    statusOffer.hidden = true;
    const messages = h("div", { class: "footer messages" }, status, statusOffer);
    messages.hidden = true;
    const body = h(
      "div",
      { class: "bar-body" },
      list,
      hint,
      h("div", { class: "footer footer-start" }, noteField),
      messages,
      h(
        "div",
        { class: "footer footer-end" },
        h("div", { class: "agent" }, select, icon("chevron")),
        h("div", { part: "actions", class: "bar-actions" }, copy, send)
      )
    );
    const bar = h("section", { part: "bar", class: "panel bar", attrs: { "aria-label": "Annotations" } }, header, body);
    ui.root.append(bar);
    let annotationCount = 0;
    let busy = false;
    let agents = null;
    let preselected = null;
    let chosen = null;
    let statuses = 0;
    let offered = null;
    const crops = /* @__PURE__ */ new Map();
    const cropOf = (id) => {
      let crop = crops.get(id);
      if (!crop) crops.set(id, crop = handlers.cropOf(id));
      return crop;
    };
    function row({ annotation, element }) {
      const meta = h(
        "span",
        { class: "row-meta" },
        icon(annotation.intent),
        annotation.intent === "change" ? "Change" : "Question"
      );
      const text = h("span", { class: "row-text" }, h("span", { class: "row-comment", text: annotation.comment }), meta);
      if (!element) {
        meta.append(" \xB7 ", h("span", { part: "not-found", class: "not-found", text: "no longer found" }));
        const crop = h("img", { class: "crop", attrs: { alt: `The element of annotation ${annotation.number}` } });
        crop.hidden = true;
        crop.addEventListener("load", () => {
          crop.style.maxWidth = `min(100%, ${crop.naturalWidth / devicePixelRatio}px)`;
          crop.style.maxHeight = `min(${CROP_HEIGHT}px, ${crop.naturalHeight / devicePixelRatio}px)`;
        });
        void cropOf(annotation.id).then((url) => {
          if (!url) return;
          crop.src = url;
          crop.hidden = false;
        });
        text.append(crop);
      }
      const badge = h("span", { class: "badge", text: String(annotation.number), attrs: { "data-intent": annotation.intent } });
      const button = h("button", { class: "row" }, badge, text);
      button.addEventListener("click", () => handlers.onOpen(annotation));
      for (const type of ["mouseenter", "focus"]) button.addEventListener(type, () => handlers.onHover(annotation));
      for (const type of ["mouseleave", "blur"]) button.addEventListener(type, () => handlers.onHover(null));
      return h("li", { part: "list-item" }, button);
    }
    const selectedAgent = () => agents?.find((agent) => agent.id === select.value);
    function updateActions() {
      copy.disabled = busy || annotationCount === 0;
      send.disabled = copy.disabled || !selectedAgent();
      select.title = select.selectedOptions[0]?.textContent ?? "";
    }
    bar.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    for (const type of ["pointerdown", "focusin"]) bar.addEventListener(type, trusted(() => handlers.onUse()));
    pick.addEventListener("click", handlers.onTogglePick);
    noteField.addEventListener("input", () => handlers.onNote(noteField.value));
    select.addEventListener("focus", handlers.onAgentsWanted);
    select.addEventListener("change", () => {
      chosen = select.value;
      updateActions();
    });
    send.addEventListener("click", trusted(() => {
      const agent = selectedAgent();
      if (agent) handlers.onSend(agent);
    }));
    copy.addEventListener("click", trusted(() => handlers.onCopy()));
    copyOffer.addEventListener("click", trusted(() => {
      if (!offered) return;
      const shown = statuses;
      void handlers.onCopyOffer(offered.text).then((copied) => {
        if (copied && shown === statuses) copyOffer.textContent = OFFER_COPIED;
      });
    }));
    collapse2.addEventListener("click", () => {
      const expand = body.hidden;
      body.hidden = !expand;
      const name = expand ? "Collapse" : "Expand";
      collapse2.setAttribute("aria-expanded", String(expand));
      collapse2.setAttribute("aria-label", name);
      collapse2.title = name;
    });
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const start2 = bar.getBoundingClientRect();
      const grab = { x: event.clientX - start2.left, y: event.clientY - start2.top };
      header.setPointerCapture(event.pointerId);
      header.classList.add("dragging");
      const move = (moved) => moveTo(moved.clientX - grab.x, moved.clientY - grab.y);
      const end = () => {
        header.classList.remove("dragging");
        header.removeEventListener("pointermove", move);
        header.removeEventListener("pointerup", end);
        header.removeEventListener("pointercancel", end);
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", end);
      header.addEventListener("pointercancel", end);
    });
    function moveTo(left, top) {
      const { width: vw, height: vh } = ui.viewport();
      const { width, height } = bar.getBoundingClientRect();
      setOffset("right", clamp(vw - left - width, 0, vw - width));
      setOffset("bottom", clamp(vh - top - height, 0, vh - height));
    }
    function keepInView() {
      const rect = bar.getBoundingClientRect();
      if (rect.width === 0) return;
      const { width: vw, height: vh } = ui.viewport();
      const right = vw - rect.right;
      const bottom = vh - rect.bottom;
      const keptRight = clamp(right, 0, vw - rect.width);
      const keptBottom = clamp(bottom, 0, vh - rect.height);
      if (keptRight !== right) setOffset("right", keptRight);
      if (keptBottom !== bottom) setOffset("bottom", keptBottom);
    }
    function setOffset(side, px) {
      const value = `${px}px`;
      if (bar.style[side] !== value) bar.style[side] = value;
    }
    new ResizeObserver(keepInView).observe(bar);
    function showAgents(next, preselect) {
      agents = next;
      preselected = preselect;
      const listed = (id) => next.some((agent) => agent.id === id);
      const selected = listed(chosen) ? chosen : listed(preselect) ? preselect : next.length === 1 ? next[0].id : null;
      const options = next.map((agent) => {
        const text = listedAs(agent);
        return h("option", { text, attrs: { value: agent.id, title: text } });
      });
      if (next.length === 0) options.push(h("option", { text: NO_AGENT, attrs: { value: "" } }));
      else if (selected === null) options.unshift(h("option", { text: CHOOSE_AGENT, attrs: { value: "", disabled: "" } }));
      select.replaceChildren(...options);
      select.value = selected ?? "";
      updateActions();
    }
    return {
      render(placed, note) {
        annotationCount = placed.length;
        count.textContent = String(placed.length);
        list.replaceChildren(...placed.map(row));
        list.hidden = placed.length === 0;
        hint.hidden = placed.length > 0;
        if (noteField.value !== note) noteField.value = note;
        updateActions();
      },
      setPicking(on) {
        pick.setAttribute("aria-pressed", String(on));
        hint.textContent = on ? HINT_PICKING : HINT_NOT_PICKING;
      },
      // The selection is the agent the user chose, else `preselect` (the tab's agent, else the one
      // bound to the site), else the only one. Among several agents nothing is guessed: a
      // placeholder asks the user to choose, and Send stays off until then. An unchanged list is
      // left alone, so a dropdown that is open stays open.
      setAgents(next, preselect) {
        if (preselect !== preselected || JSON.stringify(next) !== JSON.stringify(agents)) showAgents(next, preselect);
      },
      setBusy(on) {
        busy = on;
        pick.disabled = on;
        noteField.readOnly = on;
        updateActions();
      },
      setStatus(text, tone, shownOffer) {
        statuses += 1;
        status.textContent = text;
        status.dataset.tone = tone;
        status.hidden = text === "";
        offered = shownOffer ?? null;
        offer.textContent = offered?.text ?? "";
        offer.classList.toggle("code", offered?.code === true);
        copyOffer.textContent = offered?.button ?? "";
        statusOffer.hidden = offered === null;
        messages.hidden = status.hidden && statusOffer.hidden;
      },
      keepInView
    };
  }

  // extension/src/content/describe.ts
  var ELLIPSIS = "\u2026";
  var LABEL_TEXT_LENGTH = 40;
  var TEXT_LIMIT = 500;
  var HTML_LIMIT = 2e3;
  var SHADOW_SEPARATOR2 = " >> ";
  function truncate(text, max) {
    return text.length <= max ? text : cut(text, max - 1);
  }
  function labelFor(el, rect) {
    const text = collapse(visibleText(el));
    const start2 = text.length > LABEL_TEXT_LENGTH ? cut(text, LABEL_TEXT_LENGTH) : text;
    const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    return start2 ? `${el.localName} "${start2}" ${size}` : `${el.localName} ${size}`;
  }
  function uniqueSelector(el) {
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) {
      return `${uniqueSelector(root.host)}${SHADOW_SEPARATOR2}${selectorWithin(root, el)}`;
    }
    return selectorWithin(root, el);
  }
  function findBySelector(selector, root = document) {
    const [outer, ...inner] = selector.split(SHADOW_SEPARATOR2);
    try {
      let found = root.querySelector(outer);
      for (const part of inner) found = found?.shadowRoot?.querySelector(part) ?? null;
      return found;
    } catch {
      return null;
    }
  }
  function domPath(el) {
    const steps = [];
    let node = el;
    while (node) {
      steps.unshift(pathStep(node));
      if (node === node.ownerDocument.body) break;
      const parent = node.parentNode;
      if (parent instanceof ShadowRoot) {
        steps.unshift("#shadow-root");
        node = parent.host;
      } else {
        node = node.parentElement;
      }
    }
    return steps.join(" > ");
  }
  function snapshot(el, rect) {
    const computed = getComputedStyle(el);
    return {
      label: labelFor(el, rect),
      selector: uniqueSelector(el),
      domPath: domPath(el),
      text: truncate(tidyLines(visibleText(el)), TEXT_LIMIT),
      html: truncate(el.outerHTML, HTML_LIMIT),
      // A copy, so a DOMRect passed in does not bring its other fields along.
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: Object.fromEntries(STYLE_PROPS.map((prop) => [prop, computed.getPropertyValue(prop)]))
    };
  }
  function cut(text, keep) {
    const kept = text.slice(0, keep);
    return (/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept) + ELLIPSIS;
  }
  function visibleText(el) {
    if ("innerText" in el && typeof el.innerText === "string") return el.innerText;
    return el.textContent ?? "";
  }
  function collapse(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function tidyLines(text) {
    return text.split("\n").map(collapse).filter((line) => line !== "").join("\n");
  }
  function selectorWithin(root, el) {
    const steps = [];
    for (let node = el; node; node = node.parentElement) {
      const id = uniqueIdSelector(root, node);
      if (id) return [id, ...steps].join(" > ");
      steps.unshift(typeStep(node));
    }
    const selector = steps.join(" > ");
    const matches = root.querySelectorAll(selector);
    if (matches.length === 1 && matches[0] === el) return selector;
    steps[0] += ":not(* > *)";
    return steps.join(" > ");
  }
  function uniqueIdSelector(root, el) {
    if (!el.id) return null;
    const selector = `#${escapeIdentifier(el.id)}`;
    return root.querySelectorAll(selector).length === 1 ? selector : null;
  }
  function typeStep(el) {
    const tag = escapeIdentifier(el.localName);
    const { index, count } = typePosition(el);
    return count > 1 ? `${tag}:nth-of-type(${index})` : tag;
  }
  function pathStep(el) {
    const id = el.id ? `#${el.id}` : "";
    const classes = Array.from(el.classList, (name) => `.${name}`).join("");
    const { index, count } = typePosition(el);
    return `${el.localName}${id}${classes}${count > 1 ? ` (${index} of ${count})` : ""}`;
  }
  function typePosition(el) {
    const siblings = el.parentNode ? Array.from(el.parentNode.children) : [el];
    const sameType = siblings.filter((sibling) => sibling.localName === el.localName && sibling.namespaceURI === el.namespaceURI);
    return { index: sameType.indexOf(el) + 1, count: sameType.length };
  }
  function escapeIdentifier(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return serializeIdentifier(value);
  }
  function serializeIdentifier(value) {
    let result = "";
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      const code2 = value.charCodeAt(i);
      const isDigit = code2 >= 48 && code2 <= 57;
      if (code2 === 0) {
        result += "\uFFFD";
      } else if (code2 <= 31 || code2 === 127 || isDigit && (i === 0 || i === 1 && value[0] === "-")) {
        result += `\\${code2.toString(16)} `;
      } else if (i === 0 && char === "-" && value.length === 1) {
        result += `\\${char}`;
      } else if (code2 >= 128 || /[\w-]/.test(char)) {
        result += char;
      } else {
        result += `\\${char}`;
      }
    }
    return result;
  }

  // extension/src/content/markers.ts
  var GAP = 6;
  var OVERHANG = { x: 13, y: 13 };
  var EDGE = 2;
  function createMarkers(ui, onOpen) {
    const layer = h("div", { class: "markers" });
    ui.root.append(layer);
    let shown = [];
    function follow2() {
      const { width: vw, height: vh } = ui.viewport();
      const used = /* @__PURE__ */ new Map();
      for (const { marker, element } of shown) {
        const rect = element.getBoundingClientRect();
        marker.hidden = rect.width === 0 && rect.height === 0;
        if (marker.hidden) continue;
        const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
        const x = inView ? Math.max(EDGE, rect.left - OVERHANG.x) : rect.left - OVERHANG.x;
        const y = inView ? Math.max(EDGE, rect.top - OVERHANG.y) : rect.top - OVERHANG.y;
        const offset = used.get(element) ?? 0;
        placeAt(marker, x + offset, y);
        used.set(element, offset + marker.offsetWidth + GAP);
      }
    }
    return {
      render(placed) {
        shown = [];
        for (const { annotation, element } of placed) {
          if (!element) continue;
          const marker = h("button", {
            part: "marker",
            class: "marker",
            text: String(annotation.number),
            attrs: {
              "aria-label": `Annotation ${annotation.number}: ${annotation.comment}`,
              title: annotation.comment,
              "data-intent": annotation.intent
            }
          });
          marker.addEventListener("click", () => onOpen(annotation));
          shown.push({ marker, element });
        }
        layer.replaceChildren(...shown.map(({ marker }) => marker));
        follow2();
      },
      follow: follow2
    };
  }

  // extension/src/content/picker.ts
  function startPicking(ui, onPick, paused) {
    const { shield, host } = ui;
    const listening = new AbortController();
    const { signal } = listening;
    let pointer = null;
    const hover = () => {
      if (!paused()) ui.highlight(pointer && elementAt(pointer.x, pointer.y, host));
    };
    shield.addEventListener("pointermove", (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      hover();
    }, { signal });
    shield.addEventListener("pointerleave", () => {
      pointer = null;
      hover();
    }, { signal });
    shield.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
    shield.addEventListener("click", trusted((event) => {
      if (paused()) return;
      const el = elementAt(event.clientX, event.clientY, host);
      if (el) onPick(el);
    }), { signal });
    window.addEventListener("scroll", hover, { capture: true, passive: true, signal });
    shield.hidden = false;
    return () => {
      listening.abort();
      shield.hidden = true;
      ui.highlight(null);
    };
  }
  function elementAt(x, y, host) {
    let found = topmost(document.elementsFromPoint(x, y), host);
    for (let root = found?.shadowRoot; found && root; root = found.shadowRoot) {
      const inner = topmost(root.elementsFromPoint(x, y), host);
      if (!inner || !root.contains(inner)) break;
      found = inner;
    }
    return found;
  }
  function topmost(elements, host) {
    return elements.find((el) => el !== host) ?? null;
  }

  // extension/src/content/keys.ts
  function addHint(platform) {
    return /^(Mac|iPhone|iPad)/.test(platform) ? "\u2318\u21B5" : "Ctrl+\u21B5";
  }

  // extension/src/content/popup.ts
  var GAP2 = 12;
  var MARGIN = 8;
  function createPopup(ui) {
    const label = h("div", { part: "popup-label", class: "popup-label" });
    const comment = h("textarea", {
      part: "comment",
      class: "comment",
      attrs: { rows: "3", "aria-label": "Comment", placeholder: "What should change, or what do you want to know?" }
    });
    const change = h("button", { part: "intent-change", text: "Change" });
    const question = h("button", { part: "intent-question", text: "Question" });
    const remove = h("button", {
      part: "delete",
      class: "pill round small danger",
      attrs: { "aria-label": "Delete annotation", title: "Delete" }
    }, icon("trash"));
    const cancel = h("button", { part: "cancel", class: "pill", text: "Cancel", attrs: { title: "Esc" } });
    const addText = document.createTextNode("Add");
    const add = h(
      "button",
      { part: "add", class: "pill filled" },
      addText,
      h("span", { class: "kbd", text: addHint(navigator.platform), attrs: { "aria-hidden": "true" } })
    );
    const popup = h(
      "div",
      { part: "popup", class: "panel popup", attrs: { role: "dialog", "aria-label": "Annotation" } },
      label,
      comment,
      h(
        "div",
        { class: "popup-actions" },
        h("div", { class: "segmented", attrs: { role: "group", "aria-label": "Intent" } }, change, question),
        h("div", { class: "popup-buttons" }, remove, cancel, add)
      )
    );
    popup.hidden = true;
    ui.root.append(popup);
    let current = null;
    let intent = "change";
    let submitting = false;
    let locked = false;
    const setIntent = (next) => {
      intent = next;
      change.setAttribute("aria-pressed", String(next === "change"));
      question.setAttribute("aria-pressed", String(next === "question"));
    };
    const updateAdd = () => {
      add.disabled = locked || submitting || comment.value.trim() === "";
      remove.disabled = locked;
    };
    function close() {
      const request = current;
      if (!request) return;
      current = null;
      popup.hidden = true;
      request.onClose();
    }
    async function submit() {
      const request = current;
      if (!request || add.disabled) return;
      submitting = true;
      updateAdd();
      try {
        await request.onSubmit(comment.value.trim(), intent);
        if (current === request) close();
      } catch (error) {
        console.warn("[clicknote] Adding the annotation failed:", error);
      } finally {
        submitting = false;
        updateAdd();
      }
    }
    function follow2() {
      if (!current) return;
      const { width: vw, height: vh } = ui.viewport();
      const { offsetWidth: width, offsetHeight: height } = popup;
      const rect = current.anchor()?.getBoundingClientRect();
      let left = (vw - width) / 2;
      let top = (vh - height) / 2;
      if (rect && (rect.width > 0 || rect.height > 0)) {
        left = rect.left;
        if (rect.bottom + GAP2 + height <= vh - MARGIN) top = rect.bottom + GAP2;
        else if (rect.top - GAP2 - height >= MARGIN) top = rect.top - GAP2 - height;
        else top = rect.top + GAP2;
      }
      placeAt(popup, clamp(left, MARGIN, vw - width - MARGIN), clamp(top, MARGIN, vh - height - MARGIN));
    }
    change.addEventListener("click", () => setIntent("change"));
    question.addEventListener("click", () => setIntent("question"));
    comment.addEventListener("input", updateAdd);
    comment.addEventListener("keydown", trusted((event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void submit();
    }));
    add.addEventListener("click", trusted(() => void submit()));
    cancel.addEventListener("click", close);
    remove.addEventListener("click", trusted(() => {
      current?.onDelete?.();
      close();
    }));
    return {
      open(request) {
        close();
        current = request;
        label.textContent = request.label;
        label.title = request.label;
        comment.value = request.comment ?? "";
        setIntent(request.intent ?? "change");
        remove.hidden = !request.editing;
        addText.data = request.editing ? "Save" : "Add";
        updateAdd();
        popup.hidden = false;
        follow2();
        comment.focus({ preventScroll: true });
      },
      close,
      isOpen: () => current !== null,
      follow: follow2,
      setLocked(on) {
        locked = on;
        updateAdd();
      }
    };
  }

  // extension/src/content/store.ts
  async function toBackground(message) {
    return chrome.runtime.sendMessage(message);
  }
  function createStore(post = postToBackground, pageUrl = () => location.href) {
    let annotations = [];
    let note = "";
    const listeners = [];
    const renumber = (list) => list.map((annotation, index) => annotation.number === index + 1 ? annotation : { ...annotation, number: index + 1 });
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const save = async () => {
      await post({ type: "draft:save", draft: { url: pageUrl(), note, annotations } });
    };
    const changed = (next) => {
      annotations = renumber(next);
      void save();
      notify();
    };
    return {
      annotations: () => annotations,
      note: () => note,
      setNote(next) {
        note = next;
        changed(annotations);
      },
      add(annotation) {
        changed([...annotations, { ...annotation, number: 0, screenshot: null }]);
      },
      update(id, patch) {
        changed(annotations.map((annotation) => annotation.id === id ? { ...annotation, ...patch, id } : annotation));
      },
      remove(id) {
        changed(annotations.filter((annotation) => annotation.id !== id));
        post({ type: "crop:delete", id });
      },
      clear() {
        note = "";
        changed([]);
      },
      removeSent(sent) {
        const ids = new Set(sent.annotations.map((annotation) => annotation.id));
        if (note === sent.note) note = "";
        changed(annotations.filter((annotation) => !ids.has(annotation.id)));
      },
      restore(draft) {
        annotations = renumber(draft.annotations);
        note = draft.note;
        notify();
      },
      save,
      subscribe(listener) {
        listeners.push(listener);
      }
    };
  }
  function postToBackground(message) {
    return toBackground(message).then(
      () => void 0,
      (error) => console.warn(`[clicknote] ${message.type} failed:`, error)
    );
  }

  // extension/src/content/main.ts
  var COPYING = "Copying\u2026";
  var COPIED = "Copied. Paste the line into your agent.";
  var COPIED_MARKDOWN = "Copied as Markdown, without screenshots.";
  var CLIPBOARD_FAILED = "The clipboard could not be written.";
  var NO_AGENTS = "No agent is listening. Say this to your coding agent, then choose it here. Copy still works.";
  var LOOK_AGAIN_PAUSE = 2e3;
  var ASK_AGAIN_PAUSE = 2e3;
  var UNFOLLOWED = unanswered("This tab no longer follows this send.");
  var scope = globalThis;
  scope.__clicknoteContent?.dispose();
  document.querySelector(HOST_TAG)?.remove();
  scope.__clicknoteContent = start();
  function start() {
    const listening = new AbortController();
    const { signal } = listening;
    const ui = createUi();
    const store = createStore();
    const markers = createMarkers(ui, openAnnotation);
    const bar = createBar(ui, {
      onTogglePick: () => setPicking(!stopPicking),
      onOpen: openAnnotation,
      onHover: (annotation) => ui.highlight(annotation ? elementOf(annotation) : popupElement),
      cropOf: (id) => toBackground({ type: "crop:get", id }).then((reply) => reply?.dataUrl ?? null, () => null),
      onNote: (note) => store.setNote(note),
      onAgentsWanted: () => {
        lookedAgain = performance.now();
        listAgents().catch(warn("Listing the agents failed"));
      },
      onSend: (agent) => void send(agent).catch(warn("Sending failed")),
      onCopy: () => void copy().catch(warn("Copying failed")),
      onCopyOffer: (text) => writeClipboard(ui.root, text),
      onUse: () => {
        askAgain();
        listOnLook();
      }
    });
    const popup = createPopup(ui);
    let stopPicking = null;
    let popupElement = null;
    let shown = [];
    let editing = null;
    let listing = 0;
    let delivered = 0;
    let listAfterDelivery = false;
    let whyOff = null;
    let shownKey = "";
    let said = 0;
    let lookedAgain = -Infinity;
    let following = null;
    let askedAt = -Infinity;
    let goneMessage = null;
    let frozen = false;
    let pickAfter = false;
    let capturing = false;
    let cancelled = false;
    let unadded = null;
    const elements = /* @__PURE__ */ new Map();
    function elementOf(annotation) {
      const known = elements.get(annotation.id);
      if (known?.isConnected) return known;
      const found = findBySelector(annotation.selector);
      if (found) elements.set(annotation.id, found);
      else elements.delete(annotation.id);
      return found;
    }
    function render() {
      const placed = store.annotations().map((annotation) => ({ annotation, element: elementOf(annotation) }));
      shown = placed.map(({ element }) => element);
      markers.render(placed);
      bar.render(placed, store.note());
    }
    function follow2() {
      const now = store.annotations().map(elementOf);
      if (now.length !== shown.length || now.some((element, index) => element !== shown[index])) render();
      else markers.follow();
      ui.followHighlight();
      popup.follow();
      bar.keepInView();
    }
    let followQueued = false;
    function queueFollow() {
      if (followQueued) return;
      followQueued = true;
      requestAnimationFrame(() => {
        followQueued = false;
        if (ui.visible()) follow2();
      });
    }
    function setPicking(on) {
      if (frozen) {
        pickAfter = on;
        return;
      }
      if (on && !stopPicking) {
        stopPicking = startPicking(
          ui,
          (element) => void pick(element).catch(warn("Picking failed")),
          () => popup.isOpen() || capturing
        );
      }
      if (!on && stopPicking) {
        stopPicking();
        stopPicking = null;
        ui.highlight(popupElement);
      }
      bar.setPicking(on);
    }
    function setVisible(on) {
      if (on) {
        ui.show();
        setPicking(true);
        follow2();
        listAgents().catch(warn("Listing the agents failed"));
      } else {
        popup.close();
        setPicking(false);
        ui.hide();
      }
    }
    function openPopup(element, request) {
      popup.open(request);
      popupElement = element;
      ui.highlight(element);
    }
    function popupClosed() {
      popupElement = null;
      editing = null;
      ui.highlight(null);
    }
    async function pick(element) {
      if (capturing) return;
      const described = snapshot(element, element.getBoundingClientRect());
      capturing = true;
      cancelled = false;
      const id = newId();
      try {
        await capture(id, described.rect);
      } finally {
        capturing = false;
      }
      if (cancelled || signal.aborted || !ui.visible()) {
        dropCrop(id);
        return;
      }
      openPopup(element, {
        label: described.label,
        anchor: () => element,
        editing: false,
        onSubmit: (comment, intent) => {
          unadded = null;
          add(id, element, described, comment, intent);
        },
        onClose: () => {
          if (unadded === id) {
            unadded = null;
            dropCrop(id);
          }
          popupClosed();
        }
      });
      unadded = id;
    }
    function openAnnotation(annotation) {
      if (frozen) return;
      openPopup(elementOf(annotation), {
        label: annotation.label,
        anchor: () => elementOf(annotation),
        comment: annotation.comment,
        intent: annotation.intent,
        editing: true,
        onSubmit: (comment, intent) => store.update(annotation.id, { comment, intent }),
        onDelete: () => store.remove(annotation.id),
        onClose: popupClosed
      });
      editing = annotation.id;
    }
    async function capture(id, rect) {
      await ui.hiddenDuring(() => toBackground({
        type: "capture",
        id,
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      }).catch(warn("The capture failed")));
    }
    function add(id, element, described, comment, intent) {
      elements.set(id, element);
      store.add({ id, intent, comment, ...described });
    }
    function setStatus(text, tone, offer) {
      say(text, tone, offer);
      whyOff = null;
    }
    function explainSendOff(off) {
      say(off.text, "problem", off.offer);
      whyOff = off;
    }
    function say(text, tone, offer) {
      bar.setStatus(text, tone, offer);
      shownKey = statusKey(text, tone, offer);
      said += 1;
    }
    async function listAgents(explain = true) {
      const asked = ++listing;
      const deliveredBefore = delivered;
      const reply = await askBridge({ type: "agents", url: location.href });
      if (asked !== listing) return;
      if (frozen || delivered !== deliveredBefore) {
        listAfterDelivery = true;
        if (!frozen) listAgainAfterDelivery();
        return;
      }
      if (reply.ok) bar.setAgents(reply.agents, reply.preselect);
      else bar.setAgents([], null);
      if (!explain || following || shownKey === goneMessage) return;
      if (!reply.ok) explainSendOff(sendOff(reply) ?? { text: `Listing the agents failed: ${reply.message}` });
      else if (reply.agents.length === 0) explainSendOff({ text: NO_AGENTS, offer: WAIT_OFFER });
      else if (whyOff) setStatus("", "quiet");
    }
    function listOnLook() {
      if (frozen) return;
      if (performance.now() - lookedAgain < LOOK_AGAIN_PAUSE) return;
      lookedAgain = performance.now();
      listAgents().catch(warn("Listing the agents failed"));
    }
    function listAgainAfterDelivery() {
      if (!listAfterDelivery) return;
      listAfterDelivery = false;
      listAgents(false).catch(warn("Listing the agents failed"));
    }
    function setFrozen(on) {
      if (on) {
        const picking = stopPicking !== null;
        setPicking(false);
        frozen = true;
        pickAfter = picking;
      } else {
        frozen = false;
        setPicking(pickAfter);
        if (editing && !store.annotations().some((annotation) => annotation.id === editing)) popup.close();
      }
      popup.setLocked(on);
      bar.setBusy(on);
    }
    async function delivering(progress, failure, work) {
      setFrozen(true);
      setStatus(progress, "quiet");
      try {
        return await work();
      } catch (error) {
        setStatus(`${failure}: ${failed(error).message}`, "problem");
        warn(failure)(error);
        return void 0;
      } finally {
        setFrozen(false);
        delivered += 1;
        listAgainAfterDelivery();
      }
    }
    async function send(agent) {
      stopFollowing();
      const count = store.annotations().length;
      const sent = {
        note: store.note(),
        annotations: store.annotations().map(({ id, comment, intent }) => ({ id, comment, intent }))
      };
      const done = await delivering(SENDING, "Sending failed", async () => {
        await store.save();
        const reply2 = await askBridge({ type: "send", agent, page: pageInfo() });
        if (reply2.ok) await arrive(reply2.kept, sent);
        return { reply: reply2, record: await loadRecord() };
      });
      if (!done) return;
      const { reply, record } = done;
      if (!reply.ok) {
        showSendFailed(reply);
        if (record) startFollowing(record).shown = shownKey;
        return;
      }
      const progress = said;
      const f = record ? startFollowing(record) : null;
      if (f) {
        f.arrived = true;
        await pursue(f, { delay: FOLLOW_FIRST_MS });
      }
      if (said !== progress) return;
      const shown2 = shows(reply, agent, count, true);
      if (f) showFor(f, shown2);
      else showState(shown2);
    }
    async function goOn(record) {
      const f = startFollowing(record);
      if (record.status !== null) {
        showAnswer(f, { ok: true, state: record.status, line: record.line, kept: record.kept });
        await pursue(f);
        return;
      }
      bar.setAgents([record.agent], record.agent.id);
      listAfterDelivery = true;
      const first = await delivering(SENDING, "Sending failed", async () => {
        const reply = await follow({
          ask: () => stateOf(f),
          show: () => {
          },
          sleep: (ms) => pause(ms, f.stop.signal),
          now: Date.now,
          from: -Infinity,
          signal: f.stop.signal
        }) ?? UNFOLLOWED;
        if (reply.ok && saysArrived(reply) && !f.arrived) {
          f.arrived = true;
          await arrive(reply.kept, f.sent);
        }
        return reply;
      });
      if (!first) return;
      if (f.stop.signal.aborted) {
        setStatus("", "quiet");
      } else if (!first.ok) {
        showSendFailed(first);
        f.shown = shownKey;
      } else {
        await pursue(f, { first });
      }
    }
    async function arrive(kept, sent) {
      if (kept) await takeOverDraft();
      else store.removeSent(sent);
    }
    function showSendFailed(error) {
      const { text, tone, offer } = sendFailed(error);
      if (sendOff(error)) {
        bar.setAgents([], null);
        explainSendOff(offer ? { text, offer } : { text });
      } else {
        setStatus(text, tone, offer);
      }
      if (error.kind === "agent_gone") listAgents().catch(warn("Listing the agents failed"));
    }
    function showState({ text, tone, offer }) {
      if (statusKey(text, tone, offer) !== shownKey) setStatus(text, tone, offer);
    }
    function showFor(f, shown2) {
      const key = statusKey(shown2.text, shown2.tone, shown2.offer);
      if (key === f.shown) return;
      f.shown = key;
      showState(shown2);
    }
    function startFollowing(record) {
      stopFollowing();
      following = {
        id: record.id,
        agent: record.agent,
        sent: record.sent,
        count: record.sent.annotations.length,
        startedAt: record.startedAt,
        arrived: record.line !== null,
        stop: new AbortController(),
        asking: false,
        shown: null
      };
      return following;
    }
    function stopFollowing() {
      following?.stop.abort();
      following = null;
    }
    async function pursue(f, { first, again = false, delay = 0 } = {}) {
      if (f.asking) return;
      f.asking = true;
      let given = first;
      try {
        await follow({
          ask: () => {
            const reply = given;
            given = void 0;
            return reply ? Promise.resolve(reply) : stateOf(f);
          },
          show: (reply) => showAnswer(f, reply),
          sleep: (ms) => pause(ms, f.stop.signal),
          now: Date.now,
          from: again ? -Infinity : f.startedAt,
          signal: f.stop.signal,
          delay
        });
      } finally {
        f.asking = false;
      }
    }
    function askAgain() {
      const f = following;
      if (!f || f.asking || frozen) return;
      if (performance.now() - askedAt < ASK_AGAIN_PAUSE) return;
      pursue(f, { again: true }).catch(warn("Asking for the state of the send failed"));
    }
    async function stateOf(f) {
      askedAt = performance.now();
      const reply = await askBridge({ type: "send:state", id: f.id });
      if (!("followed" in reply)) return reply;
      if (following === f) following = null;
      f.stop.abort();
      return UNFOLLOWED;
    }
    function showAnswer(f, reply) {
      if (!reply.ok) return;
      if (saysArrived(reply) && !f.arrived) {
        f.arrived = true;
        arrive(reply.kept, f.sent).catch(warn("Taking over the annotations of this page failed"));
      }
      if (reply.state !== "sending" || f.shown === null) {
        const shown2 = shows(reply, f.agent, f.count, f.arrived);
        showFor(f, shown2);
        if (reply.state === "agent_gone") goneMessage = statusKey(shown2.text, shown2.tone, shown2.offer);
      }
      if (!settled(reply.state) || following !== f) return;
      following = null;
      if (reply.state === "picked_up" || reply.state === "agent_gone") listAgents().catch(warn("Listing the agents failed"));
    }
    async function takeOverDraft() {
      const loaded = await toBackground({ type: "draft:load", url: location.href }).catch((error) => {
        warn("Loading the annotations of this page failed")(error);
        return null;
      });
      if (loaded && "ok" in loaded) warn("Loading the annotations of this page failed")(loaded.message);
      else if (loaded?.draft) store.restore(loaded.draft);
    }
    async function loadRecord() {
      const loaded = await toBackground({ type: "send:load" }).catch((error) => {
        warn("Loading the record of the send failed")(error);
        return null;
      });
      if (loaded && "ok" in loaded) {
        warn("Loading the record of the send failed")(loaded.message);
        return null;
      }
      return loaded?.record ?? null;
    }
    async function copy() {
      await delivering(COPYING, "Copying failed", async () => {
        await store.save();
        const page = pageInfo();
        const reply = await askBridge({ type: "copy", page });
        if (reply.ok) {
          store.clear();
          if (await writeClipboard(ui.root, reply.line)) setStatus(COPIED, "done");
          else setStatus(`${CLIPBOARD_FAILED} Paste this line into your agent: ${reply.line}`, "problem");
        } else if (reply.kind === "bridge_down" || reply.kind === "version_mismatch") {
          const annotations = store.annotations().map((annotation) => ({ ...annotation, screenshot: null }));
          const markdown = renderMarkdown(page, store.note(), annotations);
          if (await writeClipboard(ui.root, markdown)) setStatus(COPIED_MARKDOWN, "done");
          else setStatus(CLIPBOARD_FAILED, "problem");
        } else {
          setStatus(`Copying failed: ${reply.message}`, "problem");
        }
      });
    }
    function onMessage(message, _sender, reply) {
      if (message.type !== "toggle") return;
      setVisible(!ui.visible());
      reply({ ok: true });
    }
    const onKey = (event) => {
      if (!ui.visible()) return;
      const escape = event.type === "keydown" && event.key === "Escape" && !event.isComposing;
      if (capturing) {
        if (escape) cancelled = true;
      } else if (!escape) {
        return;
      } else if (popup.isOpen()) {
        popup.close();
      } else if (stopPicking) {
        setPicking(false);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ["keydown", "keypress", "keyup"]) {
      window.addEventListener(type, onKey, { capture: true, signal });
    }
    window.addEventListener("scroll", queueFollow, { capture: true, passive: true, signal });
    window.addEventListener("resize", queueFollow, { signal });
    const lookAgain = trusted(() => {
      if (!ui.visible() || document.visibilityState !== "visible") return;
      askAgain();
      listOnLook();
    });
    document.addEventListener("visibilitychange", lookAgain, { signal });
    window.addEventListener("focus", lookAgain, { signal });
    const moveDraft = () => void store.save();
    window.addEventListener("popstate", moveDraft, { signal });
    window.addEventListener("hashchange", moveDraft, { signal });
    window.navigation?.addEventListener("navigatesuccess", moveDraft, { signal });
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      if (unadded) dropCrop(unadded);
      unadded = null;
    }, { signal });
    const pageChanges = new MutationObserver(queueFollow);
    pageChanges.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    chrome.runtime.onMessage.addListener(onMessage);
    store.subscribe(render);
    render();
    setVisible(true);
    load().catch(warn("Loading the annotations of this page failed"));
    async function load() {
      const record = await loadRecord();
      const loaded = await toBackground({ type: "draft:load", url: location.href }).catch((error) => {
        warn("Loading the annotations of this page failed")(error);
        return null;
      });
      if (loaded?.draft) store.restore(loaded.draft);
      if (record) await goOn(record);
    }
    return {
      dispose() {
        if (unadded) dropCrop(unadded);
        stopFollowing();
        listening.abort();
        pageChanges.disconnect();
        stopPicking?.();
        ui.host.remove();
        try {
          chrome.runtime.onMessage.removeListener(onMessage);
        } catch {
        }
      }
    };
  }
  function askBridge(message) {
    return toBackground(message).catch(unanswered);
  }
  function saysArrived(reply) {
    if (reply.state === "sending") return false;
    return reply.state !== "unknown" || reply.line !== null;
  }
  function statusKey(text, tone, offer) {
    return JSON.stringify([text, tone, offer?.text ?? null, offer?.button ?? null]);
  }
  function pause(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  function dropCrop(id) {
    toBackground({ type: "crop:delete", id }).catch(warn("Deleting the crop failed"));
  }
  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      sourceFile: sourceFile(location.href)
    };
  }
  async function writeClipboard(root, text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      if (copyCommand(root, text)) return true;
      warn("Writing to the clipboard failed")(error);
      return false;
    }
  }
  function copyCommand(root, text) {
    const focused = root.activeElement ?? document.activeElement;
    const field = h("textarea", { class: "clipboard", attrs: { "aria-hidden": "true", tabindex: "-1" } });
    field.value = text;
    root.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } finally {
      field.remove();
      focused?.focus({ preventScroll: true });
    }
  }
  function newId() {
    return randomHex(4);
  }
  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function warn(what) {
    return (error) => console.warn(`[clicknote] ${what}:`, error);
  }
})();
