/**
 * Offline test for dsh-math-render's browser half.
 *
 * No harness, no browser, no network: the bundle is executed against a React
 * stub, a primitives stub and a slot-registry stub, through the real
 * `__ModuleLoader__.load` handshake, so the assertions cover the parts that a
 * typo would break silently in the browser (tokenizer, seat registrations,
 * component props, and the no-math pass-through).
 *
 * `npm install` first: the render assertions use real React, and the shadowing
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
const primitives = {
  MarkdownText,
  projectUserText: (text) => [React.createElement('plain', { key: 'p' }, text)],
  JsonBlock: () => React.createElement('json'),
  FileTypeIcon: () => React.createElement('icon'),
  fileExtension: (name) => String(name).split('.').pop() ?? '',
  fileSizeText: (bytes) => `${bytes} B`,
  Tooltip: (props) => props.children,
  IconCopyOutline16: () => React.createElement('i'),
  IconCheckOutline16: () => React.createElement('i'),
  writeClipboard: async () => true
}

const mod = registration.factory((spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${spec}") — the shell module table has no such entry`)
})

const { splitMath, hasMath } = mod.internals

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
    '~~~\n$z$\n~~~'
  ]
  for (const sample of samples) {
    assert.equal(splitMath(sample).map((s) => s.text).join(''), sample, `round trip: ${JSON.stringify(sample)}`)
  }
})

test('hasMath reports the token kinds', () => {
  assert.equal(hasMath(splitMath('$x$')), true)
  assert.equal(hasMath(splitMath('no math here')), false)
  assert.equal(hasMath(splitMath('costs $5 and $10')), false)
})

//#endregion

//#region Seat registration

const injected = []
const registrations = []
const fakeCtx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    }
  }
}
mod.apply(fakeCtx)

test('declares name and the slots service', () => {
  assert.equal(mod.name, 'math-render')
  assert.deepEqual(Array.from(mod.inject), ['slots'], 'cross-realm array: compare by value')
})

test('shadows both user bubble kinds at priority -1', () => {
  const bubbleSeats = registrations.filter((entry) => entry.options.name === 'conversation.chat.node')
  assert.deepEqual(bubbleSeats.map((entry) => entry.options.key), ['user', 'steering'])
  for (const seat of bubbleSeats) {
    assert.equal(seat.options.priority, -1, 'priority -1 is what shadows the shipped 0')
    assert.equal(seat.options.locale, 'chat', 'the chat namespace carries copy/copied/clock keys')
    assert.equal(typeof seat.component, 'function')
  }
})

test('registers the composer preview ahead of the queue dock', () => {
  const dock = registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(dock, 'preview seat registered')
  assert.equal(dock.options.id, 'math-preview')
  assert.ok(dock.options.order < 20, 'renders above the shipped queue dock at order 20')
})

test('styles are prefixed so they cannot leak into the shell', () => {
  const style = mod.internals.STYLE_TEXT
  assert.ok(style.includes('.dshmr_bubble'))
  assert.ok(!/\.xIFHsG_|\._8leB5q_/.test(style), 'no copied hashed selectors')
  assert.ok(style.includes('--dsw-alias-label-primary'), 'rides shell tokens')
})

//#endregion

//#region Components

const t = (key) => key
const userSeat = registrations.find((entry) => entry.options.name === 'conversation.chat.node' && entry.options.key === 'user')
const previewSeat = registrations.find((entry) => entry.options.name === 'conversation.input.dock')

function renderBubble(text, extra = {}) {
  return renderToStaticMarkup(React.createElement(userSeat.component, {
    t,
    renderMessageImages: () => null,
    node: { data: Object.assign({ content: text === null ? [] : [{ type: 'text', text }], time: undefined }, extra) }
  }))
}

test('math in a user message routes through MarkdownText', () => {
  const html = renderBubble('设 $a^2+b^2=c^2$ 成立')
  assert.ok(html.includes('data-md'), 'the math segment reached the shell renderer')
  assert.ok(html.includes('$a^2+b^2=c^2$'), 'delimiters survive so the renderer parses them')
  assert.ok(html.includes('a^2'), 'and the plain prose run is still rendered')
  assert.ok(html.includes('dshmr_inlineMath'), 'inline math renders inline')
})

test('display math renders as a block', () => {
  const html = renderBubble('before $$x^2$$ after')
  assert.ok(html.includes('dshmr_displayMath'))
})

test('a message without math never touches MarkdownText', () => {
  const html = renderBubble('plain prose only')
  assert.ok(!html.includes('data-md'), 'no markdown rendering for plain user text')
  assert.ok(html.includes('dshmr_bubble'))
  assert.ok(html.includes('dshmr_actions'), 'the copy action row survives')
  assert.ok(html.includes('dshmr_userRow'))
})

test('currency in a message stays prose', () => {
  const html = renderBubble('costs $5 and $10')
  assert.ok(!html.includes('data-md'))
})

test('an empty message renders no bubble', () => {
  const html = renderBubble(null)
  assert.ok(!html.includes('dshmr_bubble'))
  assert.ok(html.includes('dshmr_userRow'))
})

test('a malformed node degrades instead of throwing', () => {
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(userSeat.component, { t, node: {} })))
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(userSeat.component, { t, node: { data: { content: 'not-an-array' } } })))
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(userSeat.component, { t, node: { data: { content: [null, 42, { type: 'text' }] } } })))
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(userSeat.component, { node: { data: { content: [] } } })), 'missing translator')
})

test('reference labels keep the shipped summary row', () => {
  const html = renderBubble('hello @note.md', { referenceLabels: ['note.md'] })
  assert.ok(html.includes('dshmr_referenceSummary'))
})

test('attachments render the shipped card geometry', () => {
  const html = renderBubble('see this', { content: [] })
  assert.ok(html.includes('dshmr_actions'))
  const withFile = renderToStaticMarkup(React.createElement(userSeat.component, {
    t,
    renderMessageImages: () => null,
    node: { data: { content: [{ type: 'file', attachment: { name: 'notes.pdf', bytes: 2048 } }] } }
  }))
  assert.ok(withFile.includes('dshmr_fileCard'))
  assert.ok(withFile.includes('notes.pdf'))
})

test('preview renders the draft formulas and nothing else', () => {
  const withMath = renderToStaticMarkup(React.createElement(previewSeat.component, { input: { draft: '求 $\\int_0^1 x^2 dx$ 的值' } }))
  assert.ok(withMath.includes('data-math-preview'))
  assert.ok(withMath.includes('$\\int_0^1 x^2 dx$'))
  const withoutMath = renderToStaticMarkup(React.createElement(previewSeat.component, { input: { draft: 'no formula here' } }))
  assert.equal(withoutMath, '', 'zero footprint without math')
  const noDraft = renderToStaticMarkup(React.createElement(previewSeat.component, {}))
  assert.equal(noDraft, '', 'zero footprint without an input snapshot')
})

//#endregion

//#region Shadowing semantics, against the real registry when it is reachable

/**
 * The one claim that cannot be checked with a stub: that a `priority: -1` entry
 * actually wins the cell over the shipped `0` entry, and that abdicating hands
 * the cell back. Runs against the shipped SlotCore when its path is present.
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
  console.log('note: shipped slot registry not reachable — shadowing semantics were not re-checked here')
} else {
  test('priority -1 shadows the shipped bubble and abdicates back to it', () => {
    const slots = new SlotCore()
    const shipped = () => null
    const registered = { name: 'conversation.chat.node', key: 'user', locale: 'chat' }
    slots.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null)
    slots.register(registered, shipped)
    assert.equal(slots.entriesOfSlot('conversation.chat.node')[0].component, shipped, 'shipped entry holds the cell first')

    const occupant = registrations.find((entry) => entry.options.name === 'conversation.chat.node' && entry.options.key === 'user')
    const dispose = slots.register(occupant.options, occupant.component)
    const cell = slots.entriesOfSlot('conversation.chat.node')
    assert.equal(cell.length, 1, 'the seat still projects one renderer per cell')
    assert.equal(cell[0].component, occupant.component, 'the -1 entry wins the cell')
    assert.equal(slots.entries('conversation.chat.node').length, 2, 'the shipped entry stays on the ledger')

    slots.reportEntryError('conversation.chat.node', cell[0], new Error('boom'), { abdicate: true })
    assert.equal(slots.entriesOfSlot('conversation.chat.node')[0].component, shipped, 'abdication hands the cell back')
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
