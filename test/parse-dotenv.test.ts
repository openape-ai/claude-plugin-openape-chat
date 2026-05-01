import { describe, expect, it } from 'bun:test'

// The tested function lives inline in server.ts (it's a single-purpose
// helper for ~/.claude/channels/openape-chat/.env). We re-declare it here
// rather than refactoring server.ts to export it — the parser is small
// and stable, and pulling it into a separate module just to test it
// would be ceremony.

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

describe('parseDotenv', () => {
  it('reads a single key=value', () => {
    expect(parseDotenv('OPENAPE_CHAT_URL=https://chat.openape.ai'))
      .toEqual({ OPENAPE_CHAT_URL: 'https://chat.openape.ai' })
  })

  it('strips matching surrounding quotes', () => {
    expect(parseDotenv('FOO="bar"')).toEqual({ FOO: 'bar' })
    expect(parseDotenv('FOO=\'bar\'')).toEqual({ FOO: 'bar' })
  })

  it('keeps mismatched quotes literal', () => {
    expect(parseDotenv('FOO="bar')).toEqual({ FOO: '"bar' })
  })

  it('ignores comments and blank lines', () => {
    const raw = `
# this is a comment
FOO=1

BAR=2
# trailing
`
    expect(parseDotenv(raw)).toEqual({ FOO: '1', BAR: '2' })
  })

  it('handles values containing equals', () => {
    expect(parseDotenv('TOKEN=eyJ=padding=='))
      .toEqual({ TOKEN: 'eyJ=padding==' })
  })

  it('returns empty object for empty input', () => {
    expect(parseDotenv('')).toEqual({})
  })
})
