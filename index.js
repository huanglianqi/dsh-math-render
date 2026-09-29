/**
 * dsh-math-render — host half.
 *
 * The plugin's whole behaviour lives in the browser half: both seats it
 * occupies are browser seats, and it needs no durable state. What the host
 * half provides is the package anchor a Loader row resolves to — the client
 * module system reads the *same* package's `exports["./client"]` next to this
 * file — plus one read-only status route.
 *
 * The route exists because an out-of-tree row fails silently from the outside:
 * if it does not resolve, nothing reports it, the page simply has no plugin.
 * `GET /plugin/math-render/status` answers "did this row mount, and is the
 * browser half registered as a client bundle". Access model: loopback Host
 * only — the same trust the rest of the local GUI assumes.
 */

import { readFileSync } from 'node:fs'

/** Cordis plugin name. */
export const name = 'math-render'

/** Required service: the route registry and request dispatch. */
export const inject = ['webServer']

/** Package name, which is also the client graph row id. */
export const PLUGIN_ID = 'dsh-math-render'

/** Route owned by this plugin. */
export const STATUS_ROUTE = '/plugin/math-render/status'

/** This package's manifest, for the version the row was resolved from. */
const MANIFEST = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * Whether the request arrived on a loopback Host.
 * @param req - the incoming request.
 * @returns true for 127.0.0.1, localhost, or [::1].
 */
export function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/**
 * Report whether this row mounted and whether the browser half is a registered
 * client bundle.
 * @param ctx - the host plugin context.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
function serveStatus(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (!loopbackHost(req)) {
    sendJson(res, 403, { error: 'loopback only' })
    return
  }
  const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
  const clientPath = clientModules !== undefined && typeof clientModules.clientPath === 'function'
    ? clientModules.clientPath(PLUGIN_ID)
    : undefined
  sendJson(res, 200, {
    plugin: PLUGIN_ID,
    version: MANIFEST.version,
    mounted: true,
    clientRegistered: clientPath !== undefined,
    clientBundle: clientPath ?? null
  })
}

/**
 * Register the status route for this plugin's lifetime.
 * @param ctx - the host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: STATUS_ROUTE, handler: (req, res) => serveStatus(ctx, req, res) }),
    'math-render: status route'
  )
}
