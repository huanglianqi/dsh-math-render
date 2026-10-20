# dsh-math-render

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that renders LaTeX in the web GUI:

- **Your own message bubble** — `$...$`, `$$...$$`, `\(...\)` and `\[...\]` in a message you sent render as formulas, in place.
- **Composer draft preview** — while the draft contains a formula, a strip above the input renders it live. With no formula in the draft the strip does not exist at all.

Assistant replies already render through the shell's KaTeX pipeline; this plugin does not touch them.

## Install

```sh
dsh plugin --profile web add dsh-math-render
```

Restart the harness afterwards (the profile's bundle list is read at boot), then reload the GUI page.

<details>
<summary>Installing from a checkout instead</summary>

```sh
dsh plugin --profile web add /path/to/dsh-math-render
```

Same mechanism: the package declares a `dsh.bundle` layer, so `dsh plugin add` records it in the profile and its row mounts at the next boot.
</details>

## How it works

| Seat | What it does | Why that seat |
|---|---|---|
| `conversation.user.text.node`, key `math`, `priority: 100` | Renders one TeX run through the shell's own `MarkdownText`, the same KaTeX pipeline assistant replies use | ui-conversation 0.2.1 parses a user message into JSON nodes with pure rules and dispatches each node to a keyed inline renderer. `math` is a free key, so the shipped `text`, `session`, `skill`, `command`, `file`, `folder` and `secret` nodes keep their own cells |
| a `math` rule in `uiConversation.userText` at `order: 40` | Turns `$...$`, `$$...$$`, `\(...\)` and `\[...\]` spans into those nodes | The rule registry is the intended pre-render seam: it is pure, revision-tracked, and a failing rule leaves the whole message as plain text |
| `conversation.input.dock`, id `math-preview`, `order: 5` | The draft preview strip above the composer | That seat is a session-scoped list seat rendered with the input snapshot (`draft` included), so no internal service has to be reached; `order: 5` keeps it ahead of the shipped queue dock at `20` |

The host half is a package anchor plus one read-only diagnostic route. It holds no state and touches nothing at boot.

This plugin used to shadow `conversation.chat.node` and rebuild the whole user bubble from copied CSS. 0.2.1 removed the `projectUserText` primitive that approach depended on, so 2.0.0 moved to the user-text extension point instead: the shipped bubble keeps its own DOM, geometry, attachments, copy action, reference chips and secret masking, and only the formula spans are handed to the shell renderer.

## Behaviour

- **A message without TeX renders exactly as the shipped bubble does.** The message is still parsed and rendered by the shipped user-text document and plain-text run; the plugin only adds one node key.
- **Backticks are the escape hatch.** TeX inside a fenced code block or an inline code span stays literal, and so does `\$`.
- **Currency is not mistaken for math.** `costs $5 and $10` stays prose: a closing `$` glued to a digit is refused, as is space-padded content.
- **Bad TeX is not hidden.** It goes to the shell renderer, so a syntax error shows KaTeX's error output, exactly as in an assistant reply.
- **A failing rule or renderer falls back to raw text.** The user-text document keeps the whole original message as plain text when a rule throws, and the slot boundary contains a crashing node renderer, so the worst case is "no effect", not a broken transcript or a missing bubble.
- **No preview on the new-session hero composer.** The host renders that seat only for a bound session; it appears once the first message puts you inside the conversation.

## Limitations

- **Requires dsh 0.2.1-rc.1 or newer.** The `uiConversation.userText` rule registry and the `conversation.user.text.node` seat were introduced there. On an older shell the plugin stays inert.
- **The composer preview is a preview, not inline WYSIWYG.** The composer is a Lexical editor and the plugin seams expose no inline widget. Typing `$x^2$` renders in the strip above the input, not inside the editable area.
- **`dsh.bundle` and a hand-written `file://` row are mutually exclusive.** Two active Loader sources for one package name is an error; install it one way.

## Diagnostics

```sh
curl -s http://127.0.0.1:<port>/plugin/math-render/status
# {"plugin":"dsh-math-render","version":"2.0.0","mounted":true,"clientRegistered":true,"clientBundle":"…/client.js"}
```

Loopback `Host` only. `mounted` proves the row resolved; `clientRegistered` proves the browser half is in the client module graph. In the page console, `document.querySelector('style[data-plugin-css="dsh-math-render/styles.css"]')` is non-null once the browser half has loaded.

## Tests

```sh
npm install
npm test
```

No harness, no browser, no network. 36 assertions over the tokenizer (delimiters, display math across lines, currency and code-span refusals, exact source ranges), the `math` rule's candidate contract, the shapes both seats are registered with, the components (TeX routes to `MarkdownText`, ranges and malformed nodes degrade instead of throwing, the preview's zero footprint), and — when the shell's own slot registry is reachable — that the `math` key occupies one cell without displacing the shipped keys.

## Compatibility

Written and verified against **dsh 0.2.1-rc.2** (client packages `0.2.1-rc.2`, DSH Desktop 2.0.18). The `uiConversation.userText` rule contract, the keyed `conversation.user.text.node` seat, the free `math` key, and the `conversation.input.dock` render props were read out of that version's sources. Newer shell versions may move any of them.

## License

MIT
