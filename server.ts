/**
 * MCP server for the openape-chat Claude Code plugin.
 *
 * Lifecycle inside a `claude --plugins openape-chat …` session:
 *
 *   1. Claude spawns this script as an MCP server (via `.mcp.json`).
 *   2. We read the OpenApe access token from `~/.config/apes/auth.json` —
 *      the same file `apes login` and `apes agents spawn` populate. The
 *      backend URL comes from `~/.claude/channels/openape-chat/.env`,
 *      written there by the `/openape-chat:configure` slash command.
 *   3. We open a WebSocket to <backend>/api/ws?token=<bearer>.
 *   4. Inbound chat frames are forwarded to Claude as MCP notifications
 *      under the `openape-chat/` namespace.
 *   5. Outbound: we expose a small set of tools (`send_message`,
 *      `send_dm`, `react`, `edit_message`, `list_rooms`,
 *      `list_messages`) that Claude can call.
 *
 * The plugin server's lifetime is bound to the Claude Code session — it
 * exits when Claude exits, and starts fresh on the next launch. There's
 * no daemon, no background process, no token refresh: if the parent's
 * auth.json expires mid-session, the WS gets a 401 and the plugin tells
 * Claude to surface "run apes login again."
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

interface ApesAuth {
  idp: string
  access_token: string
  email: string
  expires_at: number
}

function readJsonFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as T
}

function loadAuth(): ApesAuth {
  const path = join(homedir(), '.config', 'apes', 'auth.json')
  let auth: ApesAuth
  try {
    auth = readJsonFile<ApesAuth>(path)
  }
  catch (err) {
    throw new Error(
      `Could not read ${path}. The plugin uses the access token from `
      + `your OpenApe login (or your spawned agent's). Run \`apes login\` `
      + `(or \`apes agents spawn <name>\` if you are setting up an agent) `
      + `first. Cause: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!auth.access_token) {
    throw new Error(`${path} has no access_token. Run \`apes login\` again.`)
  }
  if (auth.expires_at && Date.now() / 1000 >= auth.expires_at) {
    throw new Error('Your OpenApe access token is expired. Run `apes login` again.')
  }
  return auth
}

function loadBackendUrl(): string {
  const stateDir = process.env.OPENAPE_CHAT_STATE_DIR
    || join(homedir(), '.claude', 'channels', 'openape-chat')
  const envPath = join(stateDir, '.env')

  let envContent = ''
  try {
    envContent = readFileSync(envPath, 'utf-8')
  }
  catch {
    // fall through — env file is optional if OPENAPE_CHAT_URL is set in shell
  }

  const fromFile = parseDotenv(envContent).OPENAPE_CHAT_URL
  const fromEnv = process.env.OPENAPE_CHAT_URL
  const url = (fromEnv ?? fromFile)?.trim()

  if (!url) {
    throw new Error(
      `OPENAPE_CHAT_URL is not configured. Set it via the slash command:\n`
      + `  /openape-chat:configure https://chat.openape.ai\n`
      + `or by writing OPENAPE_CHAT_URL=… to ${envPath}.`,
    )
  }
  return url.replace(/\/$/, '')
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// REST helpers (HTTP fetch with the Bearer token)
// ---------------------------------------------------------------------------

interface HttpClient {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body: unknown) => Promise<T>
  patch: <T>(path: string, body: unknown) => Promise<T>
  del: <T>(path: string, query?: Record<string, string>) => Promise<T>
}

function buildHttpClient(backendUrl: string, bearer: string): HttpClient {
  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, backendUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    }
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`)
    }
    return await res.json() as T
  }
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
    del: <T>(path: string, query?: Record<string, string>) => call<T>('DELETE', path, undefined, query),
  }
}

// ---------------------------------------------------------------------------
// MCP server bootstrap
// ---------------------------------------------------------------------------

const auth = loadAuth()
const backendUrl = loadBackendUrl()
const http = buildHttpClient(backendUrl, auth.access_token)

const server = new Server(
  { name: 'openape-chat', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// --- Tools -----------------------------------------------------------------

const tools = [
  {
    name: 'send_message',
    description: 'Send a message to a chat.openape.ai room. Members of the room will receive it in real-time.',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'The room id (UUID).' },
        body: { type: 'string', description: 'Message text.' },
        reply_to: { type: 'string', description: 'Optional message id this is a reply to.' },
      },
      required: ['room_id', 'body'],
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to a single user by email. Creates a DM room if one does not exist between you.',
    inputSchema: {
      type: 'object',
      properties: {
        user_email: { type: 'string', description: 'Recipient email address.' },
        body: { type: 'string', description: 'Message text.' },
      },
      required: ['user_email', 'body'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a message you can see.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        emoji: { type: 'string', description: 'A single emoji character.' },
      },
      required: ['message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message you previously sent. Other senders cannot be edited.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'list_rooms',
    description: 'List rooms you are a member of.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_messages',
    description: 'Fetch recent messages from a room. Useful when joining a busy room or after reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        limit: { type: 'number', description: 'Max messages to return (default 50, max 200).' },
        before: { type: 'number', description: 'Unix timestamp; only return messages created before this.' },
      },
      required: ['room_id'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  try {
    switch (name) {
      case 'send_message': {
        const result = await http.post(`/api/rooms/${encodeURIComponent(String(a.room_id))}/messages`, {
          body: a.body,
          ...(a.reply_to ? { reply_to: a.reply_to } : {}),
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'send_dm': {
        // v1: just create-or-find a DM room with the two of us, then send.
        // The server already de-dupes membership rows; if a DM with the
        // same two members exists we reuse it via the rooms list.
        const me = auth.email
        const them = String(a.user_email)
        const rooms = await http.get<Array<{ id: string, kind: string, name: string }>>('/api/rooms')
        // We don't have member-list endpoint in v1, so DM detection is
        // best-effort by name convention. For now always create — duplicate
        // rooms are merged in the UI rather than the server (v2 cleanup).
        let roomId: string
        const existing = rooms.find(r => r.kind === 'dm' && r.name === `dm:${[me, them].sort().join('|')}`)
        if (existing) {
          roomId = existing.id
        }
        else {
          const created = await http.post<{ id: string }>('/api/rooms', {
            name: `dm:${[me, them].sort().join('|')}`,
            kind: 'dm',
            members: [them],
          })
          roomId = created.id
        }
        const result = await http.post(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { body: a.body })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'react': {
        const result = await http.post(`/api/messages/${encodeURIComponent(String(a.message_id))}/reactions`, {
          emoji: a.emoji,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'edit_message': {
        const result = await http.patch(`/api/messages/${encodeURIComponent(String(a.message_id))}`, {
          body: a.body,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'list_rooms': {
        const result = await http.get('/api/rooms')
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'list_messages': {
        const query: Record<string, string> = {}
        if (typeof a.limit === 'number') query.limit = String(a.limit)
        if (typeof a.before === 'number') query.before = String(a.before)
        const path = `/api/rooms/${encodeURIComponent(String(a.room_id))}/messages`
        const url = new URL(path, backendUrl)
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${auth.access_token}` } })
        if (!res.ok) {
          throw new Error(`list_messages failed (${res.status}): ${await res.text().catch(() => '')}`)
        }
        return { content: [{ type: 'text', text: JSON.stringify(await res.json()) }] }
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// ---------------------------------------------------------------------------
// WebSocket — inbound notifications
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let manualClose = false

function wsUrl(): string {
  const u = new URL(backendUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/api/ws'
  u.searchParams.set('token', auth.access_token)
  return u.toString()
}

function scheduleReconnect() {
  if (manualClose) return
  if (reconnectTimer) return
  const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts, 6))
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, delay)
}

function openSocket() {
  socket = new WebSocket(wsUrl())
  socket.on('open', () => {
    reconnectAttempts = 0
    process.stderr.write(`[openape-chat] connected to ${backendUrl}\n`)
  })
  socket.on('message', (data) => {
    let frame: { type: string, room_id?: string, payload?: unknown }
    try {
      frame = JSON.parse(data.toString()) as typeof frame
    }
    catch {
      return
    }
    // Forward as an MCP notification under our namespace. Clients can
    // subscribe to `notifications/openape-chat/<type>` to react.
    server.notification({
      method: `notifications/openape-chat/${frame.type}`,
      params: frame as Record<string, unknown>,
    }).catch(() => { /* MCP transport may already be closing */ })
  })
  socket.on('close', (code) => {
    if (code === 1008) {
      process.stderr.write('[openape-chat] auth rejected — run `apes login` again\n')
      manualClose = true
      return
    }
    socket = null
    scheduleReconnect()
  })
  socket.on('error', () => { /* close handler runs after error */ })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  await server.connect(new StdioServerTransport())
  openSocket()
}

main().catch((err) => {
  process.stderr.write(`[openape-chat] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

process.on('SIGINT', () => {
  manualClose = true
  socket?.close()
  process.exit(0)
})
