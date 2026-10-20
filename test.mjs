/**
 * Offline test for dsh-math-render's browser half.
 *
 * No harness, no browser, no network: the bundle is executed against a React
 * stub, a primitives stub and a service/slot stub, through the real
 * `__ModuleLoader__.load` handshake, so the assertions cover the parts that a
 * typo would break silently in the browser (tokenizer, the user-text rule,
 * seat registrations, and the components).
 *
 * `npm install` first: the render assertions use real React, and the keyed-seat
 * assertion uses the shell's own slot registry when it can be found.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const testRequire = createRequire(import.meta.url)
let React
let renderToStaticMarkup
try {
  React = testRequire('react')
  renderToStaticMarkup = testRequire('react-dom/server').renderToStaticMarkup
} catch (error) {
  console.error('This suite needs its devDependencies: run `npm install` first.')
  console.error(String(error && error.message ? error.message : error))
  process.exit(1)
}

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

//#region Load the bundle through the real handshake

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
let registration
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { registration = value } } },
  console
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.equal(registration.id, 'dsh-math-render', 'bundle registers under the package name the host row id is')

const MarkdownText = (props) => React.createElement('md', { 'data-md': true }, props.text)
const primitives = { MarkdownText }

const mod = registration.factory((spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${spec}") — the shell module table has no such entry`)
})

const { splitMath, nextMath, hasMath, MATH_RULE, MathTextNode, STYLE_TEXT } = mod.internals

//#endregion

//#region Tokenizer

const kinds = (text) => splitMath(text).map((segment) => segment.kind).join(',')

test('inline dollar math', () => {
  assert.equal(kinds('设 $a^2+b^2=c^2$ 成立'), 'text,inline,text')
})

test('display dollar math', () => {
  assert.equal(kinds('$$\\int_0^1 x\\,dx$$'), 'display')
})

test('display math spans lines', () => {
  assert.equal(kinds('$$\n a+b \n$$'), 'display')
})

test('backslash paren and bracket delimiters', () => {
  assert.equal(kinds('a \\(x\\) b'), 'text,inline,text')
  assert.equal(kinds('a \\[x\\] b'), 'text,display,text')
})

test('fraction keeps its braces', () => {
  const segments = splitMath('$\\frac{1}{2}$')
  assert.equal(segments.length, 1)
  assert.equal(segments[0].text, '$\\frac{1}{2}$')
})

test('currency is not math', () => {
  assert.equal(kinds('costs $5 and $10 today'), 'text')
})

test('space-padded dollars are not math', () => {
  assert.equal(kinds('$ x $'), 'text')
})

test('unbalanced dollar is not math', () => {
  assert.equal(kinds('$x + 1'), 'text')
})

test('escaped dollar is literal', () => {
  assert.equal(kinds('price \\$x\\$ here'), 'text')
})

test('inline code span hides math', () => {
  assert.equal(kinds('write `$x$` for math'), 'text')
})

test('fenced block hides math', () => {
  assert.equal(kinds('```\n$x$\n```\n'), 'text')
})

test('segments reconstruct the source exactly', () => {
  const samples = [
    '',
    'plain',
    '$x$',
    '\\$x\\$',
    '$$x$$',
    '$a$\\$b$c$',
    '```\n$$x$$\n```\ntail $y$',
    '\\(a\\) \\[b\\] $$c$$ $d$',
    '$$',
    '$',
    '``',
    '~~~\n$z$\n~~~',
    '中文 $x$ 与 $$y$$ 和 `$z$`'
  ]
  for (const sample of samples) {
    assert.equal(splitMath(sample).map((s) => s.text).join(''), sample, `round trip: ${JSON.stringify(sample)}`)
  }
})

test('ranges stay contiguous and slice back to their own text', () => {
  const sample = '前 $x$ 中 $$y$$ 后 `$z$` 尾 $w$'
  const segments = splitMath(sample)
  let cursor = 0
  for (const segment of segments) {
    assert.equal(segment.start, cursor, 'the next segment starts where the previous ended')
    assert.ok(segment.end > segment.start, 'a segment is nonempty')
    assert.equal(sample.slice(segment.start, segment.end), segment.text, 'text and range agree')
    cursor = segment.end
  }
  assert.equal(cursor, sample.length, 'the last segment ends at the end of the message')
})

test('nextMath finds the nearest run at or after the cursor', () => {
  const text = 'a $x$ b $y$ c'
  const first = nextMath(text, 0)
  const second = nextMath(text, first.end)
  assert.equal(first.text, '$x$')
  assert.equal(second.text, '$y$')
  assert.equal(nextMath(text, second.end), undefined)
})

test('nextMath still refuses dollars inside a code span opened before the cursor', () => {
  const text = '`code $x$` $y$'
  const math = nextMath(text, 1)
  assert.equal(math.text, '$y$', 'the tokenizer restarts at zero, so the span suppresses the first dollar')
})

test('hasMath reports the token kinds', () => {
  assert.equal(hasMath(splitMath('$x$')), true)
  assert.equal(hasMath(splitMath('no math here')), false)
  assert.equal(hasMath(splitMath('costs $5 and $10')), false)
})

//#endregion

//#region The user-text rule

test('the rule identifies itself as the free math key', () => {
  assert.equal(MATH_RULE.id, 'math')
  assert.ok(Number.isFinite(MATH_RULE.order))
})

test('inline math becomes one candidate with its delimiters', () => {
  const text = '设 $a^2+b^2=c^2$ 成立'
  const candidate = MATH_RULE.match(text, 0)
  assert.equal(candidate.id, 'math')
  assert.equal(candidate.start, 2)
  assert.equal(candidate.end, 2 + '$a^2+b^2=c^2$'.length)
  assert.equal(candidate.data.tex, '$a^2+b^2=c^2$')
  assert.equal(candidate.data.display, false)
  assert.equal(text.slice(candidate.start, candidate.end), candidate.data.tex)
})

test('display math marks the display layout', () => {
  const candidate = MATH_RULE.match('前 $$x^2$$ 后', 0)
  assert.equal(candidate.data.display, true)
  assert.equal(candidate.data.tex, '$$x^2$$')
})

test('the rule skips a leading match already behind the cursor', () => {
  const text = '$x$ and $y$'
  const first = MATH_RULE.match(text, 0)
  const second = MATH_RULE.match(text, first.end)
  assert.equal(second.data.tex, '$y$')
  assert.equal(MATH_RULE.match(text, second.end), undefined)
})

test('prose and code produce no candidate', () => {
  assert.equal(MATH_RULE.match('costs $5 and $10', 0), undefined)
  assert.equal(MATH_RULE.match('write `$x$` for math', 0), undefined)
  assert.equal(MATH_RULE.match('```\n$x$\n```\n', 0), undefined)
  assert.equal(MATH_RULE.match('', 0), undefined)
})

test('a candidate is a range the user-text document will accept', () => {
  for (const text of ['$x$', 'a $$y$$ b', '\\(z\\)', '\\[w\\]']) {
    for (let from = 0; from < text.length; from += 1) {
      const candidate = MATH_RULE.match(text, from)
      if (candidate === undefined) continue
      assert.equal(candidate.id, 'math')
      assert.ok(Number.isInteger(candidate.start) && Number.isInteger(candidate.end))
      assert.ok(candidate.start >= from, 'start is not behind the cursor')
      assert.ok(candidate.end > candidate.start, 'range is nonempty')
      assert.ok(candidate.end <= text.length, 'range stays inside the text')
      assert.equal(text.slice(candidate.start, candidate.end), candidate.data.tex)
    }
  }
})

//#endregion

//#region Seat registration

function boot(options = {}) {
  const injected = []
  const registrations = []
  const rules = []
  const effects = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      }
    },
    uiConversation: {
      userText: {
        register(rule) {
          if (options.duplicateRule) throw new Error('user-text rule "math" is already registered')
          rules.push(rule)
          return () => {}
        }
      }
    },
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
      return () => {}
    }
  }
  mod.apply(ctx)
  return { injected, registrations, rules, effects }
}

const booted = boot()

test('declares the two services it actually uses', () => {
  assert.equal(mod.name, 'math-render')
  assert.deepEqual(Array.from(mod.inject), ['slots', 'uiConversation'], 'cross-realm array: compare by value')
})

test('registers exactly one math rule, through an effect', () => {
  assert.equal(booted.rules.length, 1, 'one rule registration')
  assert.equal(booted.rules[0], MATH_RULE)
  assert.equal(booted.effects.length, 1, 'the rule is owned by an effect')
  assert.equal(typeof booted.effects[0].dispose, 'function', 'the registration disposer is retained')
})

test('registers the math node in the shipped user-text factory', () => {
  const seat = booted.registrations.find((entry) => entry.options.name === 'conversation.user.text.node')
  assert.ok(seat, 'math node seat registered')
  assert.equal(seat.options.key, 'math')
  assert.equal(seat.options.priority, 100, 'matches the shipped node priorities')
  assert.equal(typeof seat.component, 'function')
})

test('registers the composer preview ahead of the queue dock', () => {
  const dock = booted.registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(dock, 'preview seat registered')
  assert.equal(dock.options.id, 'math-preview')
  assert.ok(dock.options.order < 20, 'renders above the shipped queue dock at order 20')
})

test('never shadows the chat bubble any more', () => {
  const seats = booted.registrations.map((entry) => entry.options.name)
  assert.ok(!seats.includes('conversation.chat.node'), 'the shipped bubble keeps its cell')
})

test('a conflicting math rule is reported, not fatal', () => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    const conflicting = boot({ duplicateRule: true })
    assert.equal(warnings.length, 1, 'the duplicate is reported once')
    assert.ok(String(warnings[0][0]).includes('could not register the math user-text rule'))
    assert.equal(conflicting.registrations.length, 2, 'the node and preview seats still register')
  } finally {
    console.warn = original
  }
})

test('styles are prefixed and scoped to what this bundle draws', () => {
  assert.ok(STYLE_TEXT.includes('.dshmr_inlineMath'))
  assert.ok(STYLE_TEXT.includes('.dshmr_displayMath'))
  assert.ok(STYLE_TEXT.includes('.dshmr_preview'))
  assert.ok(!STYLE_TEXT.includes('.dshmr_bubble'), 'no copied bubble geometry')
  assert.ok(!STYLE_TEXT.includes('.dshmr_actions'), 'no copied copy-action geometry')
  assert.ok(!/\.xIFHsG_|\._8leB5q_/.test(STYLE_TEXT), 'no copied hashed selectors')
  assert.ok(STYLE_TEXT.includes('--dsw-alias-label-primary'), 'rides shell tokens')
})

//#endregion

//#region Components

function renderNode(node, raw) {
  return renderToStaticMarkup(React.createElement(MathTextNode, { node, raw }))
}

test('an inline math node routes its TeX through MarkdownText', () => {
  const html = renderNode({ data: { tex: '$a^2+b^2=c^2$', display: false } }, '$a^2+b^2=c^2$')
  assert.ok(html.includes('data-md'), 'the formula reached the shell renderer')
  assert.ok(html.includes('$a^2+b^2=c^2$'), 'delimiters survive so the renderer parses them')
  assert.ok(html.includes('data-math-node="inline"'), 'inline math keeps the inline wrapper')
  assert.ok(html.includes('dshmr_inlineMath'))
})

test('a display math node renders as a block', () => {
  const html = renderNode({ data: { tex: '$$x^2$$', display: true } }, '$$x^2$$')
  assert.ok(html.includes('data-math-node="display"'))
  assert.ok(html.includes('dshmr_displayMath'))
})

test('missing data falls back to the raw slice', () => {
  const html = renderNode({ data: {} }, '$x$')
  assert.ok(html.includes('data-md'))
  assert.ok(html.includes('$x$'))
})

test('a malformed node degrades instead of throwing', () => {
  assert.equal(renderNode({}, undefined), '')
  assert.equal(renderNode({ data: { tex: '' } }, ''), '')
  assert.doesNotThrow(() => renderNode({ data: null }, null))
  assert.equal(renderToStaticMarkup(React.createElement(MathTextNode)), '', 'no props at all')
})

const previewSeat = booted.registrations.find((entry) => entry.options.name === 'conversation.input.dock')

test('preview renders the draft formulas and nothing else', () => {
  const withMath = renderToStaticMarkup(React.createElement(previewSeat.component, {
    input: { draft: '求 $\\int_0^1 x^2 dx$ 的值' }
  }))
  assert.ok(withMath.includes('data-math-preview'))
  assert.ok(withMath.includes('$\\int_0^1 x^2 dx$'))
  const withoutMath = renderToStaticMarkup(React.createElement(previewSeat.component, { input: { draft: 'no formula here' } }))
  assert.equal(withoutMath, '', 'zero footprint without math')
  const noDraft = renderToStaticMarkup(React.createElement(previewSeat.component, {}))
  assert.equal(noDraft, '', 'zero footprint without an input snapshot')
})

test('preview keeps a display formula on its own block', () => {
  const html = renderToStaticMarkup(React.createElement(previewSeat.component, {
    input: { draft: '$$\\frac{1}{2}$$' }
  }))
  assert.ok(html.includes('dshmr_previewBlock'))
  assert.ok(html.includes('$$\\frac{1}{2}$$'))
})

//#endregion

//#region Keyed-seat semantics, against the real registry when it is reachable

/**
 * The claim a stub cannot check: `register({ name, key, priority })` on a keyed
 * node slot projects one winner per key, and the shipped keys keep their own
 * cells. Runs against the shipped SlotCore when its path exists.
 */
let localSlotRegistry
try {
  localSlotRegistry = testRequire.resolve('@deepseek-ai/dsh-client-ui-slots/lib/index.js')
} catch {
  localSlotRegistry = undefined
}
const SLOT_REGISTRY_CANDIDATES = [
  ...(localSlotRegistry === undefined ? [] : [localSlotRegistry]),
  '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js',
  `${process.env.HOME ?? ''}/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js`
]
let SlotCore
for (const candidate of SLOT_REGISTRY_CANDIDATES) {
  try {
    ({ SlotCore } = await import(candidate))
    break
  } catch {
    // not on this machine / not this layout: the next candidate, then skip.
  }
}

if (SlotCore === undefined) {
  console.log('note: shipped slot registry not reachable — keyed-seat semantics were not re-checked here')
} else {
  test('the math key occupies one node cell without touching the shipped keys', () => {
    const slots = new SlotCore()
    slots.register({
      name: 'root',
      children: { 'conversation.user.text.node': { kind: 'keyed', scope: 'session' } }
    }, () => null)
    const textNode = () => null
    const sessionNode = () => null
    slots.register({ name: 'conversation.user.text.node', key: 'text', priority: 100 }, textNode)
    slots.register({ name: 'conversation.user.text.node', key: 'session', priority: 100 }, sessionNode)

    const mathSeat = booted.registrations.find((entry) => entry.options.name === 'conversation.user.text.node')
    const dispose = slots.register(mathSeat.options, mathSeat.component)
    const heads = slots.entriesOfSlot('conversation.user.text.node')
    assert.equal(heads.length, 3, 'one winner per key')
    assert.equal(heads.find((entry) => entry.options.key === 'text').component, textNode, 'the plain-text seat survives')
    assert.equal(heads.find((entry) => entry.options.key === 'session').component, sessionNode, 'the session seat survives')
    assert.equal(heads.find((entry) => entry.options.key === 'math').component, mathSeat.component, 'math owns its own cell')
    dispose()
  })
}

//#endregion

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} of ${passed + failures.length}`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`ok — ${passed} assertions passed`)
