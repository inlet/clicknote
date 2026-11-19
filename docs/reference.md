# Reference

The details behind the [README](../README.md): how Clicknote runs, what it puts on your machine, the bridge, the permissions, how the bar behaves, the status messages, and the files the agent receives.

`~` is your home folder. Paths are written the macOS and Linux way; the Windows ones are named where they differ. `<skill>` stands for the skill's folder, which the `skills` tool chose, such as `~/.agents/skills/clicknote`.

- [How Clicknote runs](#how-clicknote-runs)
- [What the tool puts on your machine](#what-the-tool-puts-on-your-machine)
- [The bridge](#the-bridge)
- [The open page](#the-open-page)
- [Permissions](#permissions)
- [Using the bar](#using-the-bar)
- [Status messages](#status-messages)
- [What the agent receives](#what-the-agent-receives)
- [The skill](#the-skill)
- [Remove](#remove)
- [Known limits](#known-limits)

## How Clicknote runs

Clicknote has these parts:

- The **extension** draws the bar, takes the screenshots and talks to the bridge. Only it uses the port.
- The **bridge** is a small server on `127.0.0.1:47823`. It serves the extension, writes the send folders, queues each send for its agent, and serves the [open page](#the-open-page).
- The **command** is what an agent runs: one program file that uses only Node's own modules and runs on Node 22 or later. The same file is the bridge.
- The **skill** is the manual for the agent, with the command in it.
- The **state folder** is where the agents and the bridge meet; see [The state folder](#the-state-folder).

The command never talks to the bridge over the port. It registers, links a page, waits, confirms and stops through files in the state folder, which only your own programs can write. The bridge reads and writes the same folder. So a program that holds the port can tell your agent nothing, and a restart of the bridge does not interrupt an agent that waits.

### The bridge's life

`register`, `open` and `wait` start the bridge when none runs. It stops by itself ten minutes after the last agent left the list and the extension last asked it anything. When another program holds port 47823, the bridge cannot start, and the command says so: `port 47823 is held by another program, so Clicknote cannot start.` `register`, `open` and `wait` write nothing when they find a bridge of another version running, and say so: `the running Clicknote is another version than this command. Run stop, then run this again.`

### Agents

An agent registers once and gets an agent id: 12 hexadecimal characters. The id is not a secret. What lets a program act for an agent is that it can write the state folder, not that it knows the id.

An agent gives two things about itself: the name of its harness, and a few words on what it works on, in your words. The bar lists it as its project folder, which is the name of the folder the command runs in, what it works on, and its harness, joined by ` · `. Before a part goes to the bar, control and formatting characters are removed, each run of white space becomes one space, and the part is cut to 60 characters. An agent that waits now has a filled dot and `waiting`; one that does not has an open dot. A later agent that reads the same as an earlier one gets a number:

```
● my-site · landing page copy · claude-code · waiting
○ my-site · landing page copy · claude-code · 2
```

An agent stays in the list while a wait of it is open, and for an hour after its last sign of life. Its signs of life are registering, `open` with its id, the start of a wait, the end of a wait that got a send, and every four minutes of a wait. A wait that is stopped from outside, by `Ctrl+C`, a plain kill or the closing of its terminal, takes its agent off the list at once, unless another wait of it is open. A later sign of life lists it again. Once the bridge has removed its record (see [The state folder](#the-state-folder)), it has to register again.

### The inbox

A send is queued in its agent's inbox, and the bridge answers the extension at once. A wait hands out what is queued, oldest first, one line per send. A send counts as picked up once the wait has confirmed it, after it has written its lines. A send that was handed out and not confirmed, because the wait ended in between, is offered again, so an agent can get the same send twice; its line then names the same folder.

### The command

The agent runs one program file from the skill's folder with Node: `node "<skill>/scripts/clicknote.mjs" <command>`. Its commands are `register`, `open`, `wait` and `stop`, and the [skill](#the-skill) tells the agent how to use them. `node "<skill>/scripts/clicknote.mjs" --help` prints them.

A problem of Clicknote never keeps the page from opening. When `open` cannot link the page to the agent, the agent opens the page's own URL. The bar has then not chosen the agent, so you choose it yourself in the bar, once it lists the agent, before you press Send.

## What the tool puts on your machine

### The state folder

| System | State folder |
|---|---|
| macOS and Linux | `~/.local/state/clicknote` |
| Windows | `%LOCALAPPDATA%\clicknote`, or `AppData\Local\clicknote` in your home folder when `LOCALAPPDATA` is not set or not a full path |

The environment variable `CLICKNOTE_STATE_DIR`, when it is set, replaces it on every system. It must be a full path. `XDG_STATE_HOME` does not count: a process started without it would then look in another folder than the rest.

The bridge and the commands protect the folder before they write anything:

- They set the file mask so that what they write is readable and writable by you only.
- They refuse a path that is not a full path, and make the folder when it is missing.
- On macOS and Linux they refuse a folder that is a link, a path that is not a folder, and a folder of another user, and say so, such as `The state folder <path> is a link. Clicknote does not use it.`
- On macOS and Linux they make the folder and everything in it readable by you only, at every depth. A link inside it is left as it is.

On Windows only the file mask is set, the path checked and the folder made: Clicknote relies on the access rules your profile gives the local application data folder. A state folder set elsewhere through `CLICKNOTE_STATE_DIR` gets no protection from Clicknote there.

What the folder holds:

| Path | What it is |
|---|---|
| `agents/` | One record per agent. The bridge removes it 7 days after the agent's last sign of life. |
| `inbox/` | One folder per agent, with a record per send. The bridge removes a record 7 days after its send was queued. |
| `sends/` | One folder per Send or Copy, with `annotations.md`, `annotations.json` and the screenshots; each Send or Copy removes the ones last changed more than 7 days earlier. |
| `links/` | One file per link that `open` made, with the page's URL and the agent. The bridge removes it once it is more than an hour old. |
| `bindings.json` | For each site, the agent it was last [bound to](#choose-the-agent), kept until you delete the state folder. |
| `bridge.json` | The record of the running bridge, with its version, written once it listens and removed when it stops. |
| `bridge.log` | The bridge's [log](#the-log), which keeps its last half when it passes 256 KB. |

The other small files in the folder are how the command and the bridge talk to each other.

### What the browser keeps

- The browser loads the extension from the folder you chose in "Load unpacked", without copying it, so moving or deleting that folder needs a new load. A fixed `key` in the manifest gives every copy of the extension the same ID, `dacfmlfnipbinbogicdjfckblnjnbonl`, by which the bridge recognises it.
- In `chrome.storage.session`, which the browser empties when it starts and when the extension is reloaded, the extension keeps for each tab its unsent annotations, the [tab's agent](#choose-the-agent), and the record of the send the bar follows. The record goes once the send is picked up, its agent is no longer listed, or the bridge no longer knows it. The extension keeps nothing in `chrome.storage.local`.
- The screenshots of unsent annotations are in the extension's IndexedDB database `clicknote`, in your browser profile. Each is removed when its annotation is sent, copied through the bridge or deleted, or its tab is closed, and any left over when the browser starts or the extension is reloaded.

### What the skill keeps

The `skills` tool places the skill's folder, with `SKILL.md` and the command `scripts/clicknote.mjs`, where each harness you chose looks for skills. With `-g` that is in your home folder: by default the folder itself at `~/.agents/skills/clicknote`, and a link to it in the folder of each harness. Using the command needs no network. An agent that cannot run the command from the skill's folder fetches Clicknote from GitHub through `npx`, which keeps it in npm's cache.

### What it does not do

- It starts the bridge only when an agent needs it, as described under [The bridge's life](#the-bridges-life). Nothing starts it at login.
- It needs no administrator rights.
- It writes nothing outside the state folder: not your shell profile, not a harness's settings, not your projects. The skill, if you add it, is placed by the `skills` tool.
- It makes no connections to other computers. The extension talks only to the bridge at `127.0.0.1`, and the command only to the state folder.

## The bridge

### Address

The bridge listens on `127.0.0.1`, port `47823`, and nowhere else, so other computers cannot reach it. The port is fixed: there is no setting for it, in the bridge or in the extension. The extension sends each request as a POST with JSON to `http://127.0.0.1:47823/bridge`, from its service worker only, never from the page. The one other address the bridge answers is an open address, `http://127.0.0.1:47823/open/<code>`, which the browser opens.

### Who it answers

The bridge first checks the `Host` header, which names the address a request was sent to. A request to any other address than `127.0.0.1:47823`, such as one sent under a host name that leads to this computer, gets status 403 before anything is read.

`/bridge` answers only this extension. The browser sets the `Origin` header of each request itself, and a web page cannot forge it. Any other origin than `chrome-extension://dacfmlfnipbinbogicdjfckblnjnbonl`, and a request without one, gets status 403 before anything is read, listed, written or queued. The answers name the extension as the only origin that may read them, so a web page cannot read them either.

An open address is answered whatever its origin, because the browser sends none when it opens an address. For it the bridge lists no agents, writes no send and queues nothing, and only the code of a link, 32 hexadecimal characters from the system's random source that only a program of your user can know, gets the open page. Any other request gets status 404.

Each request from the extension carries the extension's protocol number and version, and each answer the bridge's. When the protocol numbers differ, the bridge does nothing, and the bar says which of the two to update.

Limits:

- A request may be up to 64 MB, which is room for many screenshots. A larger one gets "This send is too large for the bridge."
- The extension waits up to 25 seconds for an answer.

### The log

A bridge that an agent's command started writes its log to `bridge.log` in the [state folder](#the-state-folder). Each line is the local time, the type of request and the outcome. The log never holds the content of your annotations, comments or pages, and no line holds a URL, a code or an agent id.

## The open page

The bridge answers an open address with the open page, which says `Opening <url> for <label> …`, where `<label>` is how the bar lists the agent. For an `http` or `https` page, the extension's content script on the open page tells the extension the link's code, and the extension asks the bridge whose link it is and makes that agent the [tab's agent](#choose-the-agent). The open page waits for the extension's answer, at most 2 seconds, and then passes the tab on to the page; without the extension it passes the tab on at once.

A page on `http` cannot open a local file, so for a `file://` page the extension opens the file in the tab. When the extension has not opened the file within 2 seconds, the open page shows the file's URL and says: "This page cannot open a local file by itself. The Clicknote extension opens it when "Allow access to file URLs" is switched on for it at chrome://extensions. Switch it on, then ask your agent to open the page again." Without the extension it shows the file's URL at once and says: "This page cannot open a local file by itself. The Clicknote extension does that, and it is not in this browser. Install it, then ask your agent to open the page again. Or copy the address below into the address bar."

A link holds for an hour from when it was made, and its open address can be opened more than once in that hour. After that, the page says "This link has expired. Ask your agent to open the page again."

## Permissions

The extension asks for these permissions:

| Permission | Why |
|---|---|
| `activeTab` | Gives access to the current tab only after you click the toolbar button or press `⌥⇧H` (`Alt+Shift+H` on Windows and Linux). With it the extension draws its UI in that tab and takes the screenshots. |
| `scripting` | Injects the annotation UI into the tab when you turn the extension on. |
| `storage` | Keeps the unsent annotations of each tab, the record of a send and the tab's agent in `chrome.storage.session`; see [What the browser keeps](#what-the-browser-keeps). |
| `clipboardWrite` | Lets Copy write to the clipboard on pages where the page's Clipboard API is not available, such as a dev server on plain `http` under a name other than `localhost`. |
| Host access to `http://127.0.0.1/*` | Lets the service worker call the bridge at `http://127.0.0.1:47823`, and lets the browser run a small content script of the extension on the [open page](#the-open-page), at `http://127.0.0.1:47823/open/*`, in the top frame only, so the extension recognises the tabs your agent opens through the bridge. It is the extension's only host access; any other site it reaches only through `activeTab`. |

## Using the bar

### Turn it on

The toolbar button ("Annotate this page for your coding agent") and the shortcut both turn the UI on and off. You can change the shortcut at `chrome://extensions/shortcuts`. A browser or another extension that already uses the key keeps it: the shortcut then does nothing until you set one there, and the toolbar button still works.

If the browser does not let the extension into the page, the toolbar button gets a `!` badge, and its tooltip says: "Cannot annotate this page. For file:// pages, switch on "Allow access to file URLs" for this extension." This happens on `chrome://` pages, for example, and on `file://` pages while that setting is off.

### Pick an element

When the bar appears, pick mode is on. In pick mode the page does not receive the click, so links do not navigate. Press `Esc`, or the Pick button on the bar, to click the page normally again, for example to open a menu; press Pick to go back to picking. Elements inside open shadow roots can be picked.

### The popup

The popup's label is the tag, the start of the visible text and the size in CSS pixels, for example `button "Get started" 120x40`. The switch is on Change by default, and Add stays off while the comment is empty.

### Screenshots

When you pick an element, before the popup opens, the extension hides its UI for a moment and takes a screenshot of the visible tab. It keeps the visible part of the element plus 8 CSS pixels around it, at full device resolution, so the agent sees the element as you clicked it, also when the page changes before you add the annotation. If the screenshot fails, you can still add the annotation, without one.

### The list and the markers

The numbers of the markers and the list are positions in the list, so they shift when you delete an annotation. One element can have several annotations. A click on a marker or a row reopens the popup, now with Save, Delete and Cancel. Drag the bar by its header. The chevron button at the right end of the header collapses it.

Unsent annotations come back on the same page, which means the same URL apart from the part after `#`. When the page changes its URL without a reload, as a single page app does, the annotations follow to the new URL. An annotation whose element cannot be found stays in the list, marked "no longer found", with its screenshot.

### The general comment

The field "General comment for the agent (optional)" holds one comment for the whole send. It goes into `annotations.md`, not into the line for the agent.

### Choose the agent

The dropdown above Copy and Send lists the agents, as described under [Agents](#agents). With no agent listed it shows "No agent listening".

The list is fetched when the bar appears, when the dropdown gets focus, when you come back to the page from another window or tab or use the bar, once a send was picked up, and once the bar has said that the agent of a send is no longer listed.

The dropdown selects the agent you chose on this page since you turned the extension on; otherwise the tab's agent, when it is listed; otherwise the agent the site was last bound to, when it is listed; otherwise the only agent, when just one is listed. With several agents and none of these, the dropdown shows "Choose an agent…" and Send stays off until you choose one, so a send never goes to an agent by guess.

A tab's agent is the agent whose link opened it, or the agent it last sent to: once the bridge has a send, the agent it went to becomes the tab's agent, also in a tab you opened yourself. The tab keeps its agent through reloads and through navigation to other sites. The extension forgets it when the tab closes, when the browser starts and when the extension is reloaded, and also when a list of the agents does not hold it.

The site is the origin (scheme, host and port) for `http` and `https` pages. For `file://` pages it is the folder of the file, and what a folder was bound to also counts for the folders below it; the deepest one wins. A send binds the site to the agent it went to, and so does the first opening of a link's open address.

### Send

Send stores the annotations with their screenshots in a send folder and queues the send for the chosen agent. The bridge answers as soon as the send is queued. While the request runs, the bar says "Sending…" and the list cannot change. Once the bridge has the send, the list, the markers and the general comment are cleared. When the list changed while it was being sent, it stays, and the bar adds "The list has changed since, so it stays."

The bar then asks the bridge how the send stands, at first by itself and later each time you come back to the page or use the bar, at most once every two seconds, until the agent has picked the send up or is no longer listed. It usually says which of these is true: picked up; queued, with the line to copy; or no longer listed, with the line to copy, to paste into another agent. The table under [Status messages](#status-messages) has every message. It says the last once, and the message stays on the status line until you use Send or Copy, or reload the page; after a reload the bar shows nothing more of that send. If that agent comes back and waits again under its id, it still gets the send.

The extension keeps a record of the send in the tab while the bar follows it, so when the page reloads, by you or by a dev server, turning the bar on again goes on with the same send. When the reload came before the bridge had the send, the bar shows "Sending…" again, with the list frozen and the send's agent in the dropdown, until it knows.

### Copy

Copy writes the same folder as Send, but puts the line on the clipboard instead of queuing it, and clears the list. When the bridge is not running, or its version does not fit the extension's, Copy puts the full Markdown on the clipboard instead, without screenshots, and the annotations stay.

### When no agent is listening

When no agent is listed, or the bridge is not running, the status line says that no agent is listening. Under it the bar offers the sentence "Wait for my annotations with the clicknote skill." with a "Copy sentence" button, which reads "Copied" after a click. Send is off; Copy works as described above. An agent that registers starts the bridge, and the bar finds the agent when you come back to the page or use the bar, without a reload. While the status line says that the agent of a send is no longer listed, it goes on saying that instead; see [Send](#send).

### `file://` pages

Switch on "Allow access to file URLs" for the extension: on `chrome://extensions`, open the extension's details. Opening a `file://` page through the bridge needs that access as well; see [The open page](#the-open-page). Switching the access on reloads the extension, so ask the agent to open the page again afterwards. For a `file://` page, `annotations.md` also gives the local path of the HTML file, so the agent can open the source directly. A file on Windows is given as a Windows path, such as `C:\Users\you\site\index.html`.

## Status messages

The line above the dropdown says what happened or what is wrong. `<agent>` is how the bar lists the agent, without the dot and without `waiting`.

| Message | Meaning |
|---|---|
| "Sending…", "Copying…" | A send or a copy is under way. The list cannot change meanwhile. |
| "Sent 2 annotations to <agent>. The agent picked them up." | The agent has the send. |
| "Sent 2 annotations to <agent>. Queued: the agent gets them when it next waits." | The bridge has the send, and the agent has not waited since. With the line to copy. |
| "Sent 2 annotations to <agent>, but that agent is no longer listed and did not pick them up. Copy the line and paste it into another agent. If that agent comes back and waits again, it still gets them." | The send is queued for an agent that left the list. With the line to copy. |
| "Sent 2 annotations to <agent>. Clicknote no longer knows whether the agent picked them up." | The bridge no longer has the send, as when its record was removed after 7 days. With the line to copy. |
| "… The list has changed since, so it stays." | Added to the above when the list changed while it was being sent. |
| "This send did not arrive. Send again." | The bridge never got the send. The annotations stay. |
| "Clicknote did not answer this send. Say this to your coding agent; this line then says whether the send arrived." | The bridge could not be reached during a send, or its answer could not be read, so the bar cannot tell whether the send arrived. With the sentence to copy. The bar asks again when you come back to the page or use the bar. |
| "That agent is no longer listed. Choose another." | The agent left the list before the send. Nothing was sent. |
| "Copied. Paste the line into your agent." | The folder is written and the line is on the clipboard. |
| "Copied as Markdown, without screenshots." | The bridge is not running, or its version does not fit; the Markdown is on the clipboard. |
| "The clipboard could not be written." | Copy could not use the clipboard. When the bridge wrote the folder, the message goes on with "Paste this line into your agent:" and the line, to paste by hand. |
| "No agent is listening. Say this to your coding agent, then choose it here. Copy still works." | No agent is listed. With the sentence to copy. Send is off. |
| "No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots." | The bridge is not running. With the sentence to copy. Send is off. |
| "This extension is older than the bridge. Load the newest zip from the release page and reload the extension. Copy still works, without screenshots." | The bridge speaks a newer protocol. Send is off. |
| "The bridge is older than this extension. Ask your agent to stop Clicknote and to open the page again. Copy still works, without screenshots." | The bridge speaks an older protocol. Send is off. |
| "Listing the agents failed: …", "Sending failed: …", "Copying failed: …" | Another error, with its message. For example: "This send is too large for the bridge." means the request was over 64 MB; "The bridge did not answer within 25 seconds."; "The bridge refused this extension." means the bridge did not recognise the extension's ID; "The extension could not keep a record of this send, so it was not started." means the browser refused to store the record, and nothing was sent. |

## What the agent receives

A wait prints one line per send, and Copy puts the same line on the clipboard:

```
Browser annotations (3) on http://localhost:3000/: read /Users/you/.local/state/clicknote/sends/20261119-153012/annotations.md, carry out the Change items and answer the Question items.
```

The path is written the way the bridge's system writes it, so on Windows it is a Windows path. A path with a space in it is put in double quotes. The line explains itself, so an agent without the skill knows what to do with it too.

The folder is `sends/<YYYYMMDD-HHMMSS>/` in the [state folder](#the-state-folder), named after the local time of the send. It holds:

- `annotations.md`, for the agent to read. At the top: the page's title and URL, the local path of the HTML file for a `file://` page, the viewport size and device pixel ratio, the number of annotations, and the general comment. Then, per annotation:
  - its number, Change or Question, the label and the comment;
  - a stable ID;
  - a CSS selector that finds exactly this element, and a readable DOM path from `body`. For an element inside a shadow root, the selector joins the host's selector and the selector inside the root with ` >> `, and a note under the selector explains this to the agent;
  - the position and size in whole CSS pixels, relative to the window when you picked the element;
  - the screenshot's file name;
  - the computed `font-family`, `font-size`, `font-weight`, `line-height`, `color`, `background-color`, `margin`, `padding` and `display`;
  - the visible text (up to 500 characters) and the outer HTML (up to 2,000 characters).
- `annotations.json`, the same content as data, with the exact position and size.
- `<number>.png` for each annotation that has a screenshot, for example `1.png`.

Everything but the comments was written by the page. Before it reaches an agent, the page's text loses invisible characters (tag characters, direction controls and zero-width characters), and the HTML also loses its comments and the contents of its script and style elements. In `annotations.md` the page's title, the label and the styles are set in code marks, as the selector and the DOM path are, and the text and the HTML in fenced blocks.

The folders sit outside the agent's repository, so an agent that limits reading to its working folder may ask for permission to read them.

## The skill

Add it with:

```sh
npx skills add inlet/clicknote -g
```

`-g` adds the skill for your whole account, so an agent in any project has it; see [What the skill keeps](#what-the-skill-keeps). Without `-g` the tool adds it only to the project you run the command in. Inside a checkout of this repository, use `-g` for removing as well: without it the tool removes the skill from the repository's own `skills/` folder.

The skill, [`skills/clicknote/SKILL.md`](../skills/clicknote/SKILL.md), tells the agent which page to open, how to run the command, also in a sandboxed shell, how to open the page or register, how to wait in its harness, what to do with a round of annotations, and how to stop, update and remove Clicknote.

## Remove

1. Stop Clicknote: `node "<skill>/scripts/clicknote.mjs" stop`.
2. Remove the extension at `chrome://extensions`. That also removes its storage, with any unsent annotations and their screenshots. Then delete the folder you unpacked it into.
3. Delete the [state folder](#the-state-folder), with the send folders in it: `~/.local/state/clicknote` on macOS and Linux, `%LOCALAPPDATA%\clicknote` on Windows, or the folder in `CLICKNOTE_STATE_DIR` when you set it.
4. Remove the skill: `npx skills remove clicknote -g`.

These steps leave Clicknote in npm's cache if your agent ran it through `npx`, and a clone of the repository, with what [building and testing add](../CONTRIBUTING.md#what-building-and-testing-add), if you made one.

## Known limits

This version does not have:

- a choice of port: the port is fixed at 47823, so another program on that port keeps the bridge from starting;
- a link that holds longer than an hour: after that, its open address says that the link has expired;
- opening a local file through the bridge without the extension in that browser, with access to file URLs: the open page then says that the extension is not in this browser, or how to switch the access on;
- an agent of its own for a tab you open yourself: such a tab is known by its site only, until you send from it;
- drawing on a screenshot, grabbing one element (`⌘C`) or dragging out an area;
- annotations from several pages in one send;
- picking elements inside an iframe: an iframe is picked as a whole;
- picking the content of a modal `<dialog>` or of a popover;
- picking menus that open only on hover: in pick mode the page's hover states do not show;
- agents on other machines: only agents on this computer are listed, because the files exist only here;
- a way back from the agent to the page, such as marking an annotation done or showing an answer at its marker;
- the UI appearing by itself on a page an agent opened: you turn it on in each tab, again after every reload or navigation;
- screenshots of the part of an element outside the window: only the visible part is captured, without scrolling;
- the Chrome Web Store, the npm registry, Firefox or Safari.

Know also:

- The bridge recognises the extension by what the browser says about the sender. A web page cannot pretend to be the extension. Another user account on this computer can hold the port and receive what the extension sends, or pose as the extension and queue a send for your agent, and so can another program of yours. So do not use Clicknote on a computer you share with people you would not let give your agent instructions.
- An agent in a harness that cannot wake it gets a queued send only when it waits again.
- A harness that ends a wait at its own time limit takes the agent off the list until the agent waits again. A send in that moment is refused with "That agent is no longer listed. Choose another."
- An agent whose session ends while it does not wait stays listed for up to an hour.
- Where the system ends a process without telling it, as a kill on Windows does, the wait cannot say that it left, and the agent stays listed for the hour after its last sign of life.
- On Windows Clicknote relies on the rights of your profile's local application data folder. A state folder set elsewhere through `CLICKNOTE_STATE_DIR` is not protected by the tool.
- A page menu that closes when focus leaves it may still close when the popup opens, but the annotation and its screenshot show the element as it was when you picked it.
