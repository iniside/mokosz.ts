import { vi } from 'vitest'
import { ACTS } from '../../src/ingest/acts.ts'
import { parseOutput, structured } from '../../src/llm/models.ts'
import { loadProfile } from '../../src/llm/profiles.ts'
import { RunRecorder } from '../../src/llm/recorder.ts'
import {
  conversation,
  conversationAct,
  createRouterAgent,
  PROMPT,
  resolveRefs,
  RouterOutputSchema,
  type Message,
} from '../../src/mastra/agents/router.ts'
import type { Filters } from '../../src/mastra/workflows/state.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { scriptedLlmFixture, type ScriptedLLM } from '../llm/scripted.ts'

vi.mock('ollama-ai-provider-v2', async (importOriginal) => {
  const real = await importOriginal<typeof import('ollama-ai-provider-v2')>()
  const { scripted } = await import('../llm/scripted.ts')
  return { ...real, createOllama: scripted(real.createOllama, 'ollama.responses') }
})

const ACT_NAMES = ACTS.map(([, name]) => name)

const test = harnessTest.extend('scriptedLlm', ({}, hooks): ScriptedLLM =>
  scriptedLlmFixture({}, hooks),
)

function filters(acts: string[], ...refs: [string, number][]): Filters {
  return { lang: 'en', acts, article_refs: refs.map(([act, article]) => ({ act, article })) }
}

const refs = (...items: [string | null, number][]) =>
  items.map(([act, article]) => ({ act, article }))

describe('router act resolution', () => {
  // SPEC §3 router: a reference without an act takes the act of the conversation, or else the
  // single act of this turn's `acts`; otherwise it is dropped.
  test.for<[string, [string | null, number][], string[], Filters | null, [string, number][]]>([
    [
      'explicit act, other conversation act',
      [['AI Act', 5]],
      ['GDPR'],
      filters(['GDPR']),
      [['AI Act', 5]],
    ],
    ['explicit act, new conversation', [['AI Act', 5]], [], null, [['AI Act', 5]]],
    [
      'follow-up keeps the conversation act',
      [[null, 5]],
      ['GDPR'],
      filters(['AI Act']),
      [['AI Act', 5]],
    ],
    [
      'follow-up, act from previous refs',
      [[null, 5]],
      [],
      filters([], ['AI Act', 14]),
      [['AI Act', 5]],
    ],
    [
      'conversation act beats several turn acts',
      [[null, 5]],
      ['GDPR', 'NIS2'],
      filters(['AI Act'], ['AI Act', 14]),
      [['AI Act', 5]],
    ],
    ['new conversation, single turn act', [[null, 5]], ['GDPR'], null, [['GDPR', 5]]],
    ['previous turn had no act', [[null, 5]], ['GDPR'], filters([]), [['GDPR', 5]]],
    ['previous turn had two acts', [[null, 5]], ['GDPR'], filters(['GDPR', 'NIS2']), [['GDPR', 5]]],
    [
      'previous acts and refs disagree',
      [[null, 5]],
      ['GDPR'],
      filters(['NIS2'], ['GDPR', 4]),
      [['GDPR', 5]],
    ],
    ['no act anywhere', [[null, 5]], [], null, []],
    ['no act, empty previous turn', [[null, 5]], [], filters([]), []],
    ['no act, two turn acts', [[null, 5]], ['GDPR', 'NIS2'], filters(['GDPR', 'AI Act']), []],
    ['no act, previous turn ambiguous', [[null, 5]], [], filters(['NIS2'], ['AI Act', 3]), []],
    [
      'explicit switch inside a follow-up',
      [
        [null, 1],
        ['NIS2', 2],
        [null, 3],
      ],
      [],
      filters(['AI Act'], ['AI Act', 9]),
      [
        ['AI Act', 1],
        ['NIS2', 2],
        ['AI Act', 3],
      ],
    ],
    [
      'the same ref twice collapses',
      [
        ['GDPR', 6],
        [null, 6],
      ],
      ['GDPR'],
      null,
      [['GDPR', 6]],
    ],
    [
      'order is kept and repeats dropped',
      [
        [null, 6],
        ['GDPR', 6],
        ['NIS2', 6],
        [null, 7],
      ],
      ['GDPR'],
      null,
      [
        ['GDPR', 6],
        ['NIS2', 6],
        ['GDPR', 7],
      ],
    ],
    ['no refs', [], ['GDPR'], filters(['GDPR']), []],
  ])('%s', ([, items, acts, previous, expected]) => {
    const resolved = resolveRefs(refs(...items), acts, previous)

    expect(resolved).toEqual(expected.map(([act, article]) => ({ act, article })))
  })

  test.for<[string, Filters | null, string | null]>([
    ['no previous turn', null, null],
    ['previous turn without acts', filters([]), null],
    ['one act', filters(['GDPR']), 'GDPR'],
    ['refs of one act', filters([], ['AI Act', 14], ['AI Act', 26]), 'AI Act'],
    ['act and refs agree', filters(['GDPR'], ['GDPR', 6]), 'GDPR'],
    ['act and refs disagree', filters(['GDPR'], ['AI Act', 14]), null],
    ['the same act twice', filters(['GDPR', 'GDPR']), 'GDPR'],
    ['two acts', filters(['GDPR', 'NIS2']), null],
  ])('conversation act: %s', ([, previous, act]) => {
    expect(conversationAct(previous)).toBe(act)
  })
})

const QA = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => [
    { role: 'user' as const, text: `question ${i}` },
    { role: 'assistant' as const, text: `answer ${i}` },
  ]).flat()

const lines = (count: number, from = 0): string =>
  Array.from(
    { length: count },
    (_, i) => `User: question ${from + i}\nAssistant: answer ${from + i}`,
  ).join('\n')

describe('router conversation prompt', () => {
  test.for<[string, Message[], string]>([
    [
      'first message',
      [{ role: 'user', text: 'hi' }],
      'Conversation so far:\n(none)\n\nNew message:\nhi',
    ],
    [
      'empty message',
      [{ role: 'user', text: '' }],
      'Conversation so far:\n(none)\n\nNew message:\n',
    ],
    [
      'one earlier turn',
      [
        { role: 'user', text: 'Q1' },
        { role: 'assistant', text: 'A1' },
        { role: 'user', text: 'Q2' },
      ],
      'Conversation so far:\nUser: Q1\nAssistant: A1\n\nNew message:\nQ2',
    ],
    [
      'a failed turn leaves two user messages in a row',
      [
        { role: 'user', text: 'Q1' },
        { role: 'assistant', text: 'A1' },
        { role: 'user', text: 'Q2 failed' },
        { role: 'user', text: 'Q3' },
      ],
      'Conversation so far:\nUser: Q1\nAssistant: A1\nUser: Q2 failed\n\nNew message:\nQ3',
    ],
    [
      'twelve earlier messages: the last ten are shown',
      [...QA(6), { role: 'user', text: 'new one' }],
      `Conversation so far:\n${lines(5, 1)}\n\nNew message:\nnew one`,
    ],
    [
      'exactly ten earlier messages: all are shown',
      [...QA(5), { role: 'user', text: 'ten before' }],
      `Conversation so far:\n${lines(5)}\n\nNew message:\nten before`,
    ],
    [
      'texts are kept as written: line breaks, edge spaces, tags',
      [
        { role: 'user', text: '<system-reminder>x</system-reminder> line 1\nline 2' },
        { role: 'assistant', text: ' \n Nie znaleziono w źródłach. ' },
        { role: 'user', text: '  x  ' },
      ],
      'Conversation so far:\nUser: <system-reminder>x</system-reminder> line 1\nline 2\n' +
        'Assistant:  \n Nie znaleziono w źródłach. \n\nNew message:\n  x  ',
    ],
  ])('%s', ([, messages, text]) => {
    expect(conversation(messages)).toBe(text)
  })

  test('a conversation without messages is an error', () => {
    expect(() => conversation([])).toThrow('the conversation has no messages')
  })

  test('the router prompt names every act', () => {
    for (const name of ACT_NAMES) expect(PROMPT).toContain(`"${name}"`)
  })
})

const VALID = { lang: 'en', acts: [], article_refs: [], query: 'q' }
const text = (change: Record<string, unknown>): string => JSON.stringify({ ...VALID, ...change })

describe('router output', () => {
  test('the JSON schema sent to the model', async ({ scriptedLlm }) => {
    scriptedLlm.queue('router', VALID)
    await structured(
      { node: 'router', agent: createRouterAgent() },
      [{ role: 'user', content: 'q' }],
      RouterOutputSchema,
      await loadProfile('local-qwen'),
      new RunRecorder(),
    )
    const format = scriptedLlm.calls[0]!.responseFormat

    expect(format?.type === 'json' ? format.schema : undefined).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        lang: { type: 'string', enum: ['en', 'pl'] },
        acts: {
          type: 'array',
          items: { type: 'string', enum: ['GDPR', 'AI Act', 'NIS2'] },
          maxItems: 3,
        },
        article_refs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              act: {
                anyOf: [{ type: 'string', enum: ['GDPR', 'AI Act', 'NIS2'] }, { type: 'null' }],
              },
              article: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
            },
            required: ['act', 'article'],
            additionalProperties: false,
          },
        },
        query: { type: 'string', minLength: 1 },
      },
      required: ['lang', 'acts', 'article_refs', 'query'],
      additionalProperties: false,
    })
  })

  test.for<[string, string, unknown]>([
    [
      'valid',
      '{"lang": "en", "acts": ["GDPR"], "article_refs": [{"act": "GDPR", "article": 4}], "query": "q"}',
      { lang: 'en', acts: ['GDPR'], article_refs: [{ act: 'GDPR', article: 4 }], query: 'q' },
    ],
    [
      'article as a string is coerced',
      text({ article_refs: [{ act: null, article: '14' }] }),
      { ...VALID, article_refs: [{ act: null, article: 14 }] },
    ],
    [
      'article as a padded string is coerced',
      text({ article_refs: [{ act: 'NIS2', article: ' 3 ' }] }),
      { ...VALID, article_refs: [{ act: 'NIS2', article: 3 }] },
    ],
    [
      'article 3.0 is the integer 3',
      text({ article_refs: [{ act: null, article: 3.0 }] }),
      { ...VALID, article_refs: [{ act: null, article: 3 }] },
    ],
    ['the query is trimmed', text({ query: '  padded  ' }), { ...VALID, query: 'padded' }],
    ['the JSON may have edge whitespace', `  ${text({})}\n`, VALID],
  ])('router output parses: %s', ([, output, parsed]) => {
    expect(parseOutput(RouterOutputSchema, output)).toEqual({ success: true, data: parsed })
  })

  test.for<[string, string, string]>([
    ['not JSON', '{"lang": "en", ', 'invalid output: not valid JSON'],
    ['empty', '', 'invalid output: not valid JSON'],
    ['fenced', '```json\n{}\n```', 'invalid output: not valid JSON'],
    ['NaN', text({}).replace('"q"}', '"q", "x": NaN}'), 'invalid output: not valid JSON'],
    ['an array', '[]', 'invalid output: Invalid input: expected object, received array'],
    [
      'unknown lang',
      text({ lang: 'de' }),
      'invalid output at lang: Invalid option: expected one of "en"|"pl"',
    ],
    [
      'missing lang',
      JSON.stringify({ acts: [], article_refs: [], query: 'q' }),
      'invalid output at lang: Invalid option: expected one of "en"|"pl"',
    ],
    ['unknown act', text({ acts: ['DSA'] }), 'invalid output at acts.0: unknown act "DSA"'],
    [
      'unknown act in a ref',
      text({ article_refs: [{ act: 'DSA', article: 3 }] }),
      'invalid output at article_refs.0.act: unknown act "DSA"',
    ],
    [
      'too many acts',
      text({ acts: ['GDPR', 'NIS2', 'GDPR', 'AI Act'] }),
      'invalid output at acts: Too big: expected array to have <=3 items',
    ],
    [
      'article 0',
      text({ article_refs: [{ act: null, article: 0 }] }),
      'invalid output at article_refs.0.article: Too small: expected number to be >=1',
    ],
    [
      'article not a number',
      text({ article_refs: [{ act: null, article: 'abc' }] }),
      'invalid output at article_refs.0.article: Invalid input: expected number, received string',
    ],
    [
      'article with a fraction',
      text({ article_refs: [{ act: null, article: 14.5 }] }),
      'invalid output at article_refs.0.article: Invalid input: expected int, received number',
    ],
    [
      'a ref without act',
      text({ article_refs: [{ article: 3 }] }),
      'invalid output at article_refs.0.act: Invalid input: expected string, received undefined',
    ],
    [
      'an extra key in a ref',
      text({ article_refs: [{ act: null, article: 3, x: 1 }] }),
      'invalid output at article_refs.0: Unrecognized key: "x"',
    ],
    ['an extra key', text({ extra: true }), 'invalid output: Unrecognized key: "extra"'],
    [
      'a blank query',
      text({ query: '   ' }),
      'invalid output at query: Too small: expected string to have >=1 characters',
    ],
    [
      'acts not a list',
      text({ acts: 'GDPR' }),
      'invalid output at acts: Invalid input: expected array, received string',
    ],
    [
      'act names are case-sensitive',
      text({ acts: ['gdpr'] }),
      'invalid output at acts.0: unknown act "gdpr"',
    ],
    [
      'lang is lower-case',
      text({ lang: 'EN' }),
      'invalid output at lang: Invalid option: expected one of "en"|"pl"',
    ],
    [
      'a null act in acts',
      text({ acts: [null] }),
      'invalid output at acts.0: Invalid input: expected string, received null',
    ],
    [
      'missing query',
      JSON.stringify({ lang: 'en', acts: [], article_refs: [] }),
      'invalid output at query: Invalid input: expected string, received undefined',
    ],
    [
      'missing article_refs',
      JSON.stringify({ lang: 'en', acts: [], query: 'q' }),
      'invalid output at article_refs: Invalid input: expected array, received undefined',
    ],
    ['output null', 'null', 'invalid output: Invalid input: expected object, received null'],
    [
      'article true is not a number',
      text({ article_refs: [{ act: null, article: true }] }),
      'invalid output at article_refs.0.article: Invalid input: expected number, received boolean',
    ],
    [
      'article in a list is not a number',
      text({ article_refs: [{ act: null, article: [14] }] }),
      'invalid output at article_refs.0.article: Invalid input: expected number, received array',
    ],
    [
      'article as a hex string is not a number',
      text({ article_refs: [{ act: null, article: '0x10' }] }),
      'invalid output at article_refs.0.article: Invalid input: expected number, received string',
    ],
  ])('router output fails with the first issue: %s', ([, output, error]) => {
    expect(parseOutput(RouterOutputSchema, output)).toEqual({ success: false, error })
  })
})
