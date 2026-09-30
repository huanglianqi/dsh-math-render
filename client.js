/**
 * dsh-math-render — browser half.
 *
 * Two seats, both driven by the shell's own renderer:
 *
 * 1. `conversation.chat.node` key `user` / `steering`, registered at priority
 *    -1 so it shadows the shipped user-bubble renderer (the registry's own
 *    error text documents this: "register at a different priority to shadow
 *    it (lowest renders)"). The bubble keeps the shipped shape — same DOM,
 *    same CSS declarations copied out of the shell bundle, same plain-text
 *    projection for prose, same attachments, same copy action. The only
 *    change: TeX spans inside the message render as KaTeX through
 *    `MarkdownText`, the exact renderer assistant replies already use. A
 *    message with no TeX renders byte-for-byte as the shipped bubble did.
 * 2. `conversation.input.dock` id `math-preview`: a strip above the composer
 *    that renders the draft's TeX live while you type. It renders nothing at
 *    all when the draft holds no TeX, so its footprint is zero otherwise.
 *
 * Escape hatch: TeX inside a fenced code block or an inline code span is left
 * literal, so backticks are how you write a dollar sign you mean literally.
 * A `\$` escape is left literal too.
 *
 * Failure mode: the slot render boundary contains entry crashes and abdicates
 * the crashed entry from its cell, so if this file ever throws, the shipped
 * user bubble re-appears for that cell instead of the transcript breaking.
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
var projectUserText = primitives.projectUserText
var JsonBlock = primitives.JsonBlock
var FileTypeIcon = primitives.FileTypeIcon
var fileExtension = primitives.fileExtension
var fileSizeText = primitives.fileSizeText
var Tooltip = primitives.Tooltip
/**
 * Icon seats. client-ui renamed the fixed-16px icon variants to size-semantic
 * ones in 0.2.x (`IconCopyOutline16` -> `IconCopyOutlineRegular`), so resolve by
 * capability across both generations -- and NEVER hand React an undefined
 * component: the slot boundary abdicates this renderer when it throws, which
 * silently hands every user bubble back to the shipped renderer. That failure
 * is invisible on plain-text messages (identical output) and only shows up when
 * a message carries TeX.
 */
function resolveIcon() {
  for (var i = 0; i < arguments.length; i += 1) {
    if (typeof arguments[i] === "function") return arguments[i]
  }
  return function () { return null }
}
var IconCopyOutline16 = resolveIcon(
  primitives.IconCopyOutline16,
  primitives.IconCopyOutlineRegular,
  primitives.IconCopyOutlineMedium
)
var IconCheckOutline16 = resolveIcon(
  primitives.IconCheckOutline16,
  primitives.IconCheckOutlineRegular,
  primitives.IconCheckOutlineMedium
)
var writeClipboard = primitives.writeClipboard

var h = React.createElement
var Fragment = React.Fragment
var useCallback = React.useCallback
var useEffect = React.useEffect
var useMemo = React.useMemo
var useRef = React.useRef
var useState = React.useState

/** Locale namespace the shipped chat renderers bind, reused so t() keeps its translations. */
var LOCALE = "chat"
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
 * @returns Segments `{ kind: "text" | "inline" | "display", text }`, in order,
 * where a math segment carries its delimiters so the shell renderer parses it.
 */
function splitMath(text) {
  var out = []
  var buffer = ""
  var i = 0
  var n = typeof text === "string" ? text.length : 0

  function flush() {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer })
      buffer = ""
    }
  }
  function push(kind, raw) {
    flush()
    out.push({ kind: kind, text: raw })
  }

  while (i < n) {
    var ch = text.charAt(i)

    // Fenced code block: copied verbatim, so its dollars stay dollars.
    if ((ch === "`" || ch === "~") && atLineStart(text, i) && countRun(text, i, ch) >= 3) {
      var fenceLen = countRun(text, i, ch)
      var fenceEnd = findFenceEnd(text, i, ch, fenceLen)
      buffer += text.slice(i, fenceEnd)
      i = fenceEnd
      continue
    }

    // Inline code span: same intent, one line at a time.
    if (ch === "`") {
      var tickRun = countRun(text, i, "`")
      var closeTick = text.indexOf("`".repeat(tickRun), i + tickRun)
      var tickEnd = closeTick === -1 ? i + tickRun : closeTick + tickRun
      buffer += text.slice(i, tickEnd)
      i = tickEnd
      continue
    }

    // Backslash forms: `\$` is literal, `\(` / `\[` open math.
    if (ch === "\\" && i + 1 < n) {
      var next = text.charAt(i + 1)
      if (next === "(") {
        var closeParen = text.indexOf("\\)", i + 2)
        if (closeParen !== -1 && text.slice(i + 2, closeParen).trim() !== "") {
          push("inline", text.slice(i, closeParen + 2))
          i = closeParen + 2
          continue
        }
      } else if (next === "[") {
        var closeBracket = text.indexOf("\\]", i + 2)
        if (closeBracket !== -1 && text.slice(i + 2, closeBracket).trim() !== "") {
          push("display", text.slice(i, closeBracket + 2))
          i = closeBracket + 2
          continue
        }
      }
      buffer += text.slice(i, i + 2)
      i += 2
      continue
    }

    if (ch === "$") {
      var dollars = countRun(text, i, "$")
      if (dollars >= 2) {
        var closeBlock = text.indexOf("$$", i + 2)
        if (closeBlock !== -1 && text.slice(i + 2, closeBlock).trim() !== "") {
          push("display", text.slice(i, closeBlock + 2))
          i = closeBlock + 2
          continue
        }
        buffer += text.slice(i, i + dollars)
        i += dollars
        continue
      }
      var closeSpan = findInlineDollarClose(text, i + 1)
      if (closeSpan !== -1) {
        push("inline", text.slice(i, closeSpan + 1))
        i = closeSpan + 1
        continue
      }
      buffer += "$"
      i += 1
      continue
    }

    buffer += ch
    i += 1
  }

  flush()
  return out
}

/** Whether a token list holds any TeX at all. */
function hasMath(segments) {
  for (var i = 0; i < segments.length; i += 1) {
    if (segments[i].kind !== "text") return true
  }
  return false
}

//#endregion

//#region User bubble

/**
 * Split message blocks the way the shipped bubble does: text runs join, image
 * and file blocks become attachments, everything else stays for a JSON block.
 */
function contentParts(content) {
  var texts = []
  var attachments = []
  var rest = []
  var blocks = Array.isArray(content) ? content : []
  for (var i = 0; i < blocks.length; i += 1) {
    var block = blocks[i]
    if (block === null || typeof block !== "object") {
      rest.push(block)
    } else if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text)
    } else if (block.type === "image" && block.attachment !== undefined) {
      attachments.push({ type: "image", image: { attachment: block.attachment } })
    } else if (block.type === "file" && block.attachment !== undefined) {
      attachments.push({ type: "file", file: block.attachment })
    } else {
      rest.push(block)
    }
  }
  return { text: texts.join(""), attachments: attachments, rest: rest }
}

/** A translator that degrades to the key instead of throwing if the binding is absent. */
function translator(t) {
  return typeof t === "function" ? t : function (key) { return key }
}

/** Zero-pad one clock field. */
function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

/** Shipped clock formatting: bare time today, dated otherwise. */
function formatClock(time, t) {
  var at = new Date(time)
  var now = new Date()
  var clock = pad2(at.getHours()) + ":" + pad2(at.getMinutes())
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return clock
  var params = { y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate() }
  return (at.getFullYear() === now.getFullYear() ? t("clock.md", params) : t("clock.ymd", params)) + " " + clock
}

/** The shipped per-message copy action, rebuilt from exported primitives. */
function BubbleActions(props) {
  var text = props.text
  var time = props.time
  var t = props.t
  var copiedState = useState(false)
  var copied = copiedState[0]
  var setCopied = copiedState[1]
  var pending = useRef(false)
  var timer = useRef(null)

  useEffect(function () {
    return function () {
      pending.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  var onCopy = useCallback(function () {
    if (copied || pending.current) return
    pending.current = true
    writeClipboard(text).then(function (ok) {
      pending.current = false
      if (!ok) return
      setCopied(true)
      timer.current = window.setTimeout(function () {
        timer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])

  var label = copied ? t("copied") : t("copy")
  return h("div", { className: css.actions },
    time === undefined ? null : h("span", { className: css.timeStart }, formatClock(time, t)),
    h(Tooltip, { label: label, side: "bottom" },
      h("button", {
        type: "button",
        className: css.action,
        "aria-label": label,
        onClick: onCopy
      }, copied ? h(IconCheckOutline16, {}) : h(IconCopyOutline16, {}))
    )
  )
}

/** Render one tokenized message: prose through the shipped projection, TeX through MarkdownText. */
function renderSegments(segments, referenceLabels, skillNames) {
  return segments.map(function (segment, index) {
    if (segment.kind === "text") {
      return h(Fragment, { key: "t" + index }, projectUserText(segment.text, referenceLabels, skillNames))
    }
    return h(
      segment.kind === "display" ? "div" : "span",
      {
        key: segment.kind + index,
        className: segment.kind === "display" ? css.displayMath : css.inlineMath
      },
      h(MarkdownText, { text: segment.text })
    )
  })
}

/**
 * Shadowing renderer for the `user` and `steering` chat node kinds.
 *
 * @param props - the seat's owner object: `node`, `renderMessageImages`, `t`.
 * @returns the user bubble, with TeX rendered in place.
 */
function MathUserBubble(props) {
  var node = props.node
  var data = node !== undefined && node !== null && node.data !== undefined ? node.data : {}
  var t = translator(props.t)
  var renderMessageImages = props.renderMessageImages
  var referenceLabels = Array.isArray(data.referenceLabels) ? data.referenceLabels : []
  var skillNames = Array.isArray(data.skillNames) ? data.skillNames : []
  var parts = contentParts(data.content)
  var segments = useMemo(function () { return splitMath(parts.text) }, [parts.text])
  var attachments = parts.attachments
  var rest = parts.rest
  var compactImages = attachments.length > 1
  var showBubble = parts.text !== "" || rest.length > 0
  var truncated = function (total) { return t("json.truncated", { total: total }) }

  return h("div", { className: css.userRow },
    h("div", { className: css.userStack },
      attachments.length > 0
        ? h("div", { className: css.attachmentRow, "data-message-attachments": true },
            attachments.map(function (attachment, index) {
              if (attachment.type === "image" && typeof renderMessageImages === "function") {
                return h(Fragment, { key: "image:" + index }, renderMessageImages({
                  images: [attachment.image],
                  align: "end",
                  compact: compactImages
                }))
              }
              var file = attachment.file === undefined ? { name: "" } : attachment.file
              return h("span", { className: css.fileCard, title: file.name, key: "file:" + index },
                h(FileTypeIcon, { path: file.name, className: css.fileIcon }),
                h("span", { className: css.fileContent },
                  h("span", { className: css.fileName }, file.name),
                  h("span", { className: css.fileMeta },
                    [fileExtension(file.name).toUpperCase().slice(0, 8), fileSizeText(file.bytes)]
                      .filter(Boolean)
                      .join(" "))
                )
              )
            })
          )
        : null,
      showBubble
        ? h("div", { className: css.bubble },
            renderSegments(segments, referenceLabels, skillNames),
            rest.map(function (block, index) {
              return h(JsonBlock, {
                key: "rest" + index,
                label: t("message.extraBlock"),
                payload: block,
                truncatedLabel: truncated
              })
            })
          )
        : null,
      referenceLabels.length > 0
        ? h("div", { className: css.referenceSummary },
            t("message.referenceSummary", {
              labels: referenceLabels.join(t("message.referenceSeparator"))
            }))
        : null
    ),
    h(BubbleActions, { text: parts.text, time: data.time, t: t })
  )
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
 * Style declarations copied out of the shipped bundles (`MessageItem.module.css`
 * and `MessageIconActions.module.css` for the bubble, MarkdownText's own sheet
 * for the math resets) under this plugin's own prefix.
 *
 * They are copied rather than imported because those sheets are CSS modules
 * whose hashed names no out-of-tree bundle can resolve, and the client module
 * table exposes no component from `ui-chat`. Consequence to keep in mind: a
 * future shell restyle will not reach these declarations, so the bubble keeps
 * this build's geometry until this file is updated. Geometry that does move —
 * fonts, spacing and colours — rides the `--dsw-*` / `--dsh-*` custom
 * properties below, which the shell still owns.
 */
var STYLE_TEXT = [
  ".dshmr_userRow{flex-direction:column;align-items:flex-end;gap:6px;display:flex}",
  ".dshmr_userStack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}",
  ".dshmr_bubble{background:var(--dsw-specific-bubble);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:22px;padding:10px 16px}",
  ".dshmr_referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}",
  ".dshmr_attachmentRow{flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%;display:flex}",
  ".dshmr_fileCard{border:.5px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-specific-input-major,transparent);box-sizing:border-box;border-radius:16px;flex:0 0 240px;align-items:center;gap:10px;width:240px;min-height:64px;padding:8px 12px;display:inline-flex}",
  ".dshmr_fileIcon{flex:none;width:28px;height:28px}",
  ".dshmr_fileContent{flex-direction:column;flex:1;min-width:0;display:flex}",
  ".dshmr_fileName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden}",
  ".dshmr_fileMeta{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#00000073);font-size:12px;line-height:15px;overflow:hidden}",
  ".dshmr_actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}",
  ".dshmr_timeStart{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}",
  ".dshmr_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
  ".dshmr_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
  ".dshmr_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
  "@media (hover:hover){[data-actions-reveal=hover] .dshmr_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .dshmr_actions{opacity:0;transition:opacity 80ms}[data-actions-reveal=hover]:hover .dshmr_actions,[data-actions-reveal=hover]:focus-within .dshmr_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .dshmr_actions,:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .dshmr_actions{opacity:1}}",
  /* Math runs: MarkdownText's root div and its paragraph go inline inside the
     pre-wrap bubble so an inline formula sits in the sentence rather than on
     its own line; a display formula keeps the block it asks for. */
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
  userRow: "dshmr_userRow",
  userStack: "dshmr_userStack",
  bubble: "dshmr_bubble",
  referenceSummary: "dshmr_referenceSummary",
  attachmentRow: "dshmr_attachmentRow",
  fileCard: "dshmr_fileCard",
  fileIcon: "dshmr_fileIcon",
  fileContent: "dshmr_fileContent",
  fileName: "dshmr_fileName",
  fileMeta: "dshmr_fileMeta",
  actions: "dshmr_actions",
  timeStart: "dshmr_timeStart",
  action: "dshmr_action",
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

/** Required service: the slot registry. */
exports.inject = ["slots"]

/**
 * Occupy both seats.
 *
 * @param ctx - the client plugin context.
 */
exports.apply = function apply(ctx) {
  installStyles()

  ctx.slots.inject("conversation.chat.node", function () {
    var disposers = []
    var keys = ["user", "steering"]
    for (var i = 0; i < keys.length; i += 1) {
      try {
        disposers.push(ctx.slots.register({
          name: "conversation.chat.node",
          key: keys[i],
          // -1 renders instead of the shipped 0: lowest priority wins the cell.
          priority: -1,
          locale: LOCALE
        }, MathUserBubble))
      } catch (error) {
        // A cell that is already shadowed at -1 is not worth failing a boot for.
        if (typeof console !== "undefined") console.warn("[math-render] could not shadow " + keys[i] + " bubble", error)
      }
    }
    return function () {
      for (var index = 0; index < disposers.length; index += 1) disposers[index]()
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
  hasMath: hasMath,
  contentParts: contentParts,
  STYLE_TEXT: STYLE_TEXT,
  css: css
}

return module.exports; } });
