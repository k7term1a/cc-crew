// The P10 mask of /sticky-note new, and where the API keys are read from.
import { describe, expect, test } from 'claude-code/testing'

import { maskNewArgs, NEW_ARGS_MASK } from '../hooks/commands'
import { describeKey, findKey, keyFiles, parseDotenv, resolveKey } from '../hooks/secrets'

describe('P10: /sticky-note new leaves no question in the transcript', () => {
  const record = '<command-name>/sticky-note</command-name>\n            <command-message>sticky-note</command-message>\n            <command-args>new TCP 的 backpressure 是什麼原理？</command-args>'

  test('masks the args of new, leaves everything else', () => {
    expect(maskNewArgs(record)).toBe(record.replace('new TCP 的 backpressure 是什麼原理？', NEW_ARGS_MASK))
    expect(maskNewArgs(record.replace('new TCP', 'back TCP'))).toBeNull()
    expect(maskNewArgs(record.replace('/sticky-note</command-name>', '/other</command-name>'))).toBeNull()
  })
})

describe('keys from files (no machine-wide env vars needed)', () => {
  test('parseDotenv: BOM, CRLF, quotes, export, comments', () => {
    expect(parseDotenv('\uFEFFTYPESAFE_API_KEY="apikey_x"\r\nexport OPENAI_API_KEY=sk-y # mine\r\n# c\r\n')).toEqual({ TYPESAFE_API_KEY: 'apikey_x', OPENAI_API_KEY: 'sk-y' })
  })

  test('order: environment, then ~/.claude/sticky-notes/.env, then the plugin folder', async () => {
    const files = keyFiles('C:\\Users\\me', 'C:\\dev\\cc-sticky-notes')
    expect(files).toEqual(['C:\\Users\\me\\.claude\\sticky-notes\\.env', 'C:\\dev\\cc-sticky-notes\\.env'])
    const disk: Record<string, string> = { [files[1]!]: 'OPENAI_API_KEY=from-plugin\nTYPESAFE_API_KEY=ts-plugin', [files[0]!]: 'OPENAI_API_KEY=from-home' }
    const read = async (p: string) => {
      if (!(p in disk)) throw new Error('ENOENT')
      return disk[p]!
    }
    expect(await resolveKey('OPENAI_API_KEY', 'from-env', files, read)).toBe('from-env')
    expect(await resolveKey('OPENAI_API_KEY', undefined, files, read)).toBe('from-home')
    expect(await resolveKey('TYPESAFE_API_KEY', '', files, read)).toBe('ts-plugin')
    expect(describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', undefined, files, read))).toBe(`OPENAI_API_KEY：有（${files[0]}）`)
    delete disk[files[1]!]
    expect(await resolveKey('TYPESAFE_API_KEY', undefined, files, read)).toBeUndefined()
    expect(describeKey('TYPESAFE_API_KEY', null)).toContain('找不到')
  })
})
