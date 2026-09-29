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
| `conversation.chat.node`, keys `user` and `steering`, at `priority: -1` | Shadows the shipped user-bubble renderer. The bubble keeps its shipped shape — same DOM, same geometry, same attachments, same copy action. Only TeX runs are handed to the shell's own `MarkdownText`, the renderer assistant replies use | The slot registry projects one winner per cell in ascending priority order, so `-1` outranks the shipped `0`. The registry's own error text documents the route: *register at a different priority to shadow it (lowest renders)* |
| `conversation.input.dock`, id `math-preview`, `order: 5` | The draft preview strip above the composer | That seat is a session-scoped list seat rendered with the input snapshot (`draft` included), so no internal service has to be reached; `order: 5` keeps it ahead of the shipped queue dock at `20` |

The host half is a package anchor plus one read-only diagnostic route. It holds no state and touches nothing at boot.

## Behaviour

- **A message without TeX renders exactly as the shipped bubble did.** Prose still goes through the shell's plain-text projection, so it is not Markdown-ified: `*`, `#` and backticks keep their literal meaning.
- **Backticks are the escape hatch.** TeX inside a fenced code block or an inline code span stays literal, and so does `\$`.
- **Currency is not mistaken for math.** `costs $5 and $10` stays prose: a closing `$` glued to a digit is refused, as is space-padded content.
- **Bad TeX is not hidden.** It goes to the shell renderer, so a syntax error shows KaTeX's error output, exactly as in an assistant reply.
- **A crashing renderer falls back to the shipped bubble.** The slot boundary contains entry crashes and abdicates the entry from its cell, so the worst case is "no effect", not a broken transcript.
- **No preview on the new-session hero composer.** The host renders that seat only for a bound session; it appears once the first message puts you inside the conversation.

## Limitations

- **The bubble geometry is copied CSS.** Those sheets are CSS modules whose hashed class names no out-of-tree bundle can resolve, and the client module table exposes no `ui-chat` component. An accurate restyle of the shell will not reach these declarations, so the bubble keeps the geometry of the build it was copied from. Colours, fonts and spacing ride `--dsw-*` / `--dsh-*` custom properties, which the shell still owns. Removing the plugin restores the shipped bubble exactly.
- **The composer preview is a preview, not inline WYSIWYG.** The composer is a Lexical editor and the plugin seams expose no inline widget. Typing `$x^2$` renders in the strip above the input, not inside the editable area.
- **`dsh.bundle` and a hand-written `file://` row are mutually exclusive.** Two active Loader sources for one package name is an error; install it one way.

## Diagnostics

```sh
curl -s http://127.0.0.1:<port>/plugin/math-render/status
# {"plugin":"dsh-math-render","version":"1.0.0","mounted":true,"clientRegistered":true,"clientBundle":"…/client.js"}
```

Loopback `Host` only. `mounted` proves the row resolved; `clientRegistered` proves the browser half is in the client module graph. In the page console, `document.querySelector('style[data-plugin-css="dsh-math-render/styles.css"]')` is non-null once the browser half has loaded.

## Tests

```sh
npm install
npm test
```

No harness, no browser, no network. 27 assertions over the tokenizer (delimiters, display math across lines, currency and code-span refusals, plus the invariant that segments must reconstruct the source exactly), the shapes both seats are registered with, the components (TeX routes to `MarkdownText`, a mathless message never reaches it, malformed nodes degrade instead of throwing, the preview's zero footprint), and — when the shell's own slot registry is reachable — the shadowing semantics, including that abdication hands the cell back to the shipped bubble.

## Compatibility

Written and verified against **dsh 0.1.5-rc.2** (client packages `0.1.5-rc.2`, DSH Desktop 2.0.13). Seat names, priority shadowing, the `projectUserText` / `MarkdownText` / `writeClipboard` primitives, and the `conversation.input.dock` render props were read out of that version's sources. Newer shell versions may move any of them.

## License

MIT
