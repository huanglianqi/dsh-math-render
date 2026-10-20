/**
 * dsh-math-render — browser half.
 *
 * One pure rule and two render seats, all using the shell's own machinery:
 *
 * 1. `conversation.user.text.node`, key `math` — the user-text document
 *    (ui-conversation 0.2.1+) parses a user message into JSON nodes through
 *    pure rules, then dispatches each node to a keyed inline renderer. This
 *    bundle registers a `math` rule (TeX spans in a message you sent) and the
 *    `math` node renderer, which hands the slice to `MarkdownText` — the same
 *    KaTeX pipeline assistant replies use. The shipped user bubble, its
 *    attachments, copy action, reference chips and secret masking all stay
 *    exactly as shipped, because this seat never shadows the bubble.
 * 2. `conversation.input.dock` id `math-preview`: a strip above the composer
 *    that renders the draft's TeX live while you type. It renders nothing at
 *    all when the draft holds no TeX, so its footprint is zero otherwise.
 *
 * Escape hatch: TeX inside a fenced code block or an inline code span is left
 * literal, so backticks are how you write a dollar sign you mean literally.
 * A `\$` escape is left literal too.
 *
 * Failure mode: the user-text document catches a failing rule and keeps the
 * whole original message as plain text; the slot boundary contains a failing
 * node renderer and falls back to the raw slice. Either way the worst case is
 * "no effect", never a broken transcript or a missing bubble.
 *
 * Hand-written bundle in the layout the client module system expects:
 * `window.__ModuleLoader__.load({ id, factory })` registering a lazy CJS
 * factory whose `require` resolves against the shell's frozen module table.
 * Only `react` and `@deepseek-ai/dsh-client-ui-primitives` are requested —
 * both are in that table, including the Markdown/KaTeX renderer.
 */
window.__ModuleLoader__.load({ id: "dsh-math-render", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require("react")
var primitives = require("@deepseek-ai/dsh-client-ui-primitives")

var MarkdownText = primitives.MarkdownText

var h = React.createElement
var useMemo = React.useMemo

/** Style tag identity, so a second mount never doubles the sheet. */
var CSS_TAG = "dsh-math-render/styles.css"
/** Package name, which the host graph row id is. */
var PLUGIN_ID = "dsh-math-render"

//#region TeX tokenizer

/** Count the run of one repeated character starting at an index. */
function countRun(text, start, ch) {
  var i = start
  while (i < text.length && text.charAt(i) === ch) i += 1
  return i - start
}

/** Whether an index sits at the start of a line. */
function atLineStart(text, index) {
  return index === 0 || text.charAt(index - 1) === "\n"
}

/** Index just past the line that closes a fenced block opened at `start`. */
function findFenceEnd(text, start, ch, len) {
  var cursor = text.indexOf("\n", start)
  while (cursor !== -1) {
    var lineStart = cursor + 1
    if (atLineStart(text, lineStart) && text.charAt(lineStart) === ch && countRun(text, lineStart, ch) >= len) {
      var after = lineStart + countRun(text, lineStart, ch)
      var next = text.indexOf("\n", after)
      return next === -1 ? text.length : next + 1
    }
    cursor = text.indexOf("\n", cursor + 1)
  }
  return text.length
}

/**
 * Find the closing `$` of a candidate inline-math span.
 *
 * Mirrors the shipped markdown grammar's refusals: no newline, no crossing a
 * code span, no empty or space-padded content, and no closing `$` glued to a
 * digit (so "costs $5 and $10" stays prose).
 *
 * @param text - the message text.
 * @param start - index just past the opening `$`.
 * @returns the closing `$` index, or -1 when this span is not math.
 */
function findInlineDollarClose(text, start) {
  var i = start
  while (i < text.length) {
    var ch = text.charAt(i)
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "\n" || ch === "`") return -1
    if (ch === "$") {
      var content = text.slice(start, i)
      if (content === "" || /^\s|\s$/.test(content)) return -1
      var follower = text.charAt(i + 1)
      if (follower >= "0" && follower <= "9") return -1
      return i
    }
    i += 1
  }
  return -1
}

/**
 * Split one message into plain runs and TeX runs.
 *
 * @param text - the message text.
 * @returns Segments `{ kind: "text" | "inline" | "display", text, start, end }`,
 * in order. A math segment carries its delimiters and its exact source range,
 * so the shell renderer can parse it and the text document can align it.
 */
function splitMath(text) {
  var out = []
  var buffer = ""
  var bufferStart = 0
  var i = 0
  var n = typeof text === "string" ? text.length : 0

  function append(from, to) {
    if (buffer === "") bufferStart = from
    buffer += text.slice(from, to)
  }
  function flush(end) {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer, start: bufferStart, end: end })
      buffer = ""
    }
  }
  function push(kind, from, to) {
    flush(from)
    out.push({ kind: kind, text: text.slice(from, to), start: from, end: to })
  }

  while (i < n) {
    var ch = text.charAt(i)

    // Fenced code block: copied verbatim, so its dollars stay dollars.
    if ((ch === "`" || ch === "~") && atLineStart(text, i) && countRun(text, i, ch) >= 3) {
      var fenceLen = countRun(text, i, ch)
      var fenceEnd = findFenceEnd(text, i, ch, fenceLen)
      append(i, fenceEnd)
      i = fenceEnd
      continue
    }

    // Inline code span: same intent, one line at a time.
    if (ch === "`") {
      var tickRun = countRun(text, i, "`")
      var closeTick = text.indexOf("`".repeat(tickRun), i + tickRun)
      var tickEnd = closeTick === -1 ? i + tickRun : closeTick + tickRun
      append(i, tickEnd)
      i = tickEnd
      continue
    }

    // Backslash forms: `\$` is literal, `\(` / `\[` open math.
    if (ch === "\\" && i + 1 < n) {
      var next = text.charAt(i + 1)
      if (next === "(") {
        var closeParen = text.indexOf("\\)", i + 2)
        if (closeParen !== -1 && text.slice(i + 2, closeParen).trim() !== "") {
          push("inline", i, closeParen + 2)
          i = closeParen + 2
          continue
        }
      } else if (next === "[") {
        var closeBracket = text.indexOf("\\]", i + 2)
        if (closeBracket !== -1 && text.slice(i + 2, closeBracket).trim() !== "") {
          push("display", i, closeBracket + 2)
          i = closeBracket + 2
          continue
        }
      }
      append(i, i + 2)
      i += 2
      continue
    }

    if (ch === "$") {
      var dollars = countRun(text, i, "$")
      if (dollars >= 2) {
        var closeBlock = text.indexOf("$$", i + 2)
        if (closeBlock !== -1 && text.slice(i + 2, closeBlock).trim() !== "") {
          push("display", i, closeBlock + 2)
          i = closeBlock + 2
          continue
        }
        append(i, i + dollars)
        i += dollars
        continue
      }
      var closeSpan = findInlineDollarClose(text, i + 1)
      if (closeSpan !== -1) {
        push("inline", i, closeSpan + 1)
        i = closeSpan + 1
        continue
      }
      append(i, i + 1)
      i += 1
      continue
    }

    append(i, i + 1)
    i += 1
  }

  flush(n)
  return out
}

/** Whether a token list holds any TeX at all. */
function hasMath(segments) {
  for (var i = 0; i < segments.length; i += 1) {
    if (segments[i].kind !== "text") return true
  }
  return false
}

/**
 * Find the first TeX run starting at or after one cursor.
 *
 * The user-text document asks a rule for its nearest candidate on every
 * iteration. Re-tokenizing the whole message from zero (rather than scanning
 * from `from`) is deliberate: a code fence or span that opened before the
 * cursor must still suppress the dollars inside it.
 *
 * @param text - the whole message.
 * @param from - the lowest candidate start.
 * @returns the nearest math segment, or undefined.
 */
function nextMath(text, from) {
  var segments = splitMath(text)
  for (var i = 0; i < segments.length; i += 1) {
    var segment = segments[i]
    if (segment.kind !== "text" && segment.start >= from) return segment
  }
  return undefined
}

//#endregion

//#region User-text seat

/**
 * The `math` user-text rule: one TeX span, carrying its delimiters and whether
 * it asked for display layout.
 *
 * `order` only breaks ties at the same start; the document picks the earliest
 * candidate across every rule, so this sits after the shipped session (10),
 * skill/command (20) and file/folder (30) rules without displacing them.
 */
var MATH_RULE = {
  id: "math",
  order: 40,
  match: function (text, from) {
    var segment = nextMath(text, from)
    if (segment === undefined) return undefined
    return {
      id: "math",
      start: segment.start,
      end: segment.end,
      data: { tex: segment.text, display: segment.kind === "display" }
    }
  }
}

/**
 * Render one `math` user-text node through the shell's Markdown/KaTeX pipeline.
 *
 * The inline wrapper resets the bubble's `white-space: pre-wrap` and the
 * Markdown paragraph margins so the formula sits inside the sentence; the
 * display wrapper keeps the block but still resets those margins.
 *
 * @param props - `{ node, raw }` from the keyed node seat.
 * @returns the rendered formula, or null for a malformed node.
 */
function MathTextNode(props) {
  var owner = props !== undefined && props !== null ? props : {}
  var node = owner.node !== undefined && owner.node !== null ? owner.node : undefined
  var data = node !== undefined ? node.data : undefined
  var tex = data !== undefined && data !== null && typeof data.tex === "string" ? data.tex : owner.raw
  if (typeof tex !== "string" || tex === "") return null
  var display = data !== undefined && data !== null && data.display === true
  return h("span", {
    className: display ? css.displayMath : css.inlineMath,
    "data-math-node": display ? "display" : "inline"
  }, h(MarkdownText, { text: tex }))
}

//#endregion

//#region Composer preview

/**
 * Live TeX preview for the composer draft.
 *
 * Data arrives as a slot prop: `conversation.input.dock` is rendered with the
 * session shell's published input snapshot, so this component re-renders
 * exactly when the draft does. Renders nothing without TeX in the draft.
 *
 * @param props - the dock's render props: `{ session, input }`.
 * @returns the preview strip, or null.
 */
function MathPreview(props) {
  var input = props !== undefined && props !== null ? props.input : undefined
  var draft = input !== undefined && input !== null && typeof input.draft === "string" ? input.draft : ""
  var math = useMemo(function () {
    return splitMath(draft).filter(function (segment) { return segment.kind !== "text" })
  }, [draft])

  if (math.length === 0) return null

  return h("div", { className: css.preview, "data-math-preview": true },
    h("div", { className: css.previewHead },
      h("span", { className: css.previewLabel }, "LaTeX"),
      h("span", { className: css.previewHint }, "草稿里的公式（用 `反引号` 包住可保持原样）")
    ),
    h("div", { className: css.previewBody },
      math.map(function (segment, index) {
        return h("div", {
          key: "preview" + index,
          className: segment.kind === "display" ? css.previewBlock : css.previewInline
        }, h(MarkdownText, { text: segment.text }))
      })
    )
  )
}

//#endregion

//#region Styles

/**
 * Only the two things this bundle draws itself: the formula wrappers inside a
 * shipped bubble, and the composer preview strip. The bubble's own geometry,
 * attachments, reference chips and copy row are no longer copied here — the
 * `math` node rides inside the shipped bubble, so a future restyle reaches it
 * automatically. Colours, fonts and spacing ride the `--dsw-*` / `--dsh-*`
 * custom properties the shell owns.
 */
var STYLE_TEXT = [
  /* A math run sits inside the pre-wrap bubble: undo the preserved whitespace
     and Markdown's paragraph box for the inline case; keep the block for a
     display formula but reset its margins. */
  ".dshmr_inlineMath{display:inline;white-space:normal}",
  ".dshmr_inlineMath>div{display:inline}",
  ".dshmr_inlineMath>div>p{display:inline;margin:0}",
  ".dshmr_displayMath{display:block;white-space:normal;margin:6px 0}",
  ".dshmr_displayMath>div>p{margin:0}",
  /* Composer preview */
  ".dshmr_preview{box-sizing:border-box;width:100%;margin:0 0 8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));border-radius:12px;padding:8px 12px 10px}",
  ".dshmr_previewHead{align-items:center;gap:8px;display:flex;margin-bottom:6px}",
  ".dshmr_previewLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.08em}",
  ".dshmr_previewHint{color:var(--dsw-alias-label-tertiary);font-size:11px}",
  ".dshmr_previewBody{flex-direction:column;gap:6px;display:flex;overflow-x:auto}",
  ".dshmr_previewInline,.dshmr_previewBlock{min-width:0;color:var(--dsw-alias-label-primary)}",
  ".dshmr_previewInline>div>p,.dshmr_previewBlock>div>p{margin:0}"
].join("")

/** The class-name map this bundle renders with. */
var css = {
  inlineMath: "dshmr_inlineMath",
  displayMath: "dshmr_displayMath",
  preview: "dshmr_preview",
  previewHead: "dshmr_previewHead",
  previewLabel: "dshmr_previewLabel",
  previewHint: "dshmr_previewHint",
  previewBody: "dshmr_previewBody",
  previewInline: "dshmr_previewInline",
  previewBlock: "dshmr_previewBlock"
}

/** Install the stylesheet once per document. */
function installStyles() {
  if (typeof document === "undefined") return
  if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") !== null) return
  var tag = document.createElement("style")
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = STYLE_TEXT
  document.head.appendChild(tag)
}

//#endregion

//#region Plugin

/** Cordis plugin name. */
exports.name = "math-render"

/**
 * Required services: the slot registry and the user-text document service.
 * `uiConversation.userText` is the non-shadowing seam that 0.2.1 introduced;
 * the plugin cannot render user-bubble formulas without it.
 */
exports.inject = ["slots", "uiConversation"]

/**
 * Register the rule and the two render seats.
 *
 * @param ctx - the client plugin context.
 */
exports.apply = function apply(ctx) {
  installStyles()

  try {
    ctx.effect(function () {
      return ctx.uiConversation.userText.register(MATH_RULE)
    }, "math-render: math user-text rule")
  } catch (error) {
    // A foreign rule named `math` means someone else owns the seat: keep the
    // preview and the rest of the page working instead of failing the plugin.
    if (typeof console !== "undefined") console.warn("[math-render] could not register the math user-text rule", error)
  }

  ctx.slots.inject("conversation.user.text.node", function () {
    try {
      return ctx.slots.register({
        name: "conversation.user.text.node",
        key: "math",
        priority: 100
      }, MathTextNode)
    } catch (error) {
      if (typeof console !== "undefined") console.warn("[math-render] could not register the math text node", error)
      return function () {}
    }
  })

  ctx.slots.inject("conversation.input.dock", function () {
    return ctx.slots.register({
      name: "conversation.input.dock",
      id: "math-preview",
      // Ahead of the shipped queue dock (order 20): the draft preview is about
      // what you are typing, not about what is already sent.
      order: 5
    }, MathPreview)
  })
}

/** Exposed for the offline test harness only. */
exports.internals = {
  splitMath: splitMath,
  nextMath: nextMath,
  hasMath: hasMath,
  MATH_RULE: MATH_RULE,
  MathTextNode: MathTextNode,
  STYLE_TEXT: STYLE_TEXT,
  css: css
}

return module.exports; } });
