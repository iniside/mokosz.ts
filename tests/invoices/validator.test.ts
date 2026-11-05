import { describe, expect, test } from 'vitest'
import { Decimal } from '../../src/decimal.ts'
import {
  ExtractedInvoice,
  Invoice,
  RULES,
  validate,
  type ValidationResult,
} from '../../src/invoices/index.ts'
import { setPath } from './paths.ts'

const PL_NIP = '5260250274'
const DE_UST = 'DE136695976'

type Data = Record<string, unknown>

function plBase(): Data {
  return {
    number: 'FV/2026/11/001',
    issue_date: '2026-11-03',
    sale_date: '2026-11-02',
    currency: 'PLN',
    seller: {
      name: 'Sprzedawca Sp. z o.o.',
      tax_id: PL_NIP,
      country: 'PL',
      address: 'ul. Testowa 1, 00-001 Warszawa',
    },
    buyer: {
      name: 'Nabywca S.A.',
      tax_id: '526-025-02-74',
      country: 'PL',
      address: 'ul. Próbna 2, 30-001 Kraków',
    },
    lines: [
      {
        description: 'Usługa A',
        quantity: '2',
        unit_net: '100.00',
        vat_rate: '23',
        net: '200.00',
      },
      { description: 'Usługa B', quantity: '1', unit_net: '50.00', vat_rate: '8', net: '50.00' },
    ],
    total_net: '250.00',
    total_vat: '50.00',
    total_gross: '300.00',
  }
}

function deBase(): Data {
  return {
    number: 'RE-2026-0001',
    issue_date: '2026-11-03',
    sale_date: null,
    currency: 'EUR',
    seller: {
      name: 'Verkäufer GmbH',
      tax_id: DE_UST,
      country: 'DE',
      address: 'Teststraße 1, 10115 Berlin',
    },
    buyer: { name: 'Käufer AG', tax_id: null, country: 'DE', address: null },
    lines: [
      {
        description: 'Leistung A',
        quantity: '3',
        unit_net: '10.00',
        vat_rate: '19',
        net: '30.00',
      },
      { description: 'Buch', quantity: '1', unit_net: '20.00', vat_rate: '7', net: '20.00' },
    ],
    total_net: '50.00',
    total_vat: '7.10',
    total_gross: '57.10',
  }
}

function withChanges(base: Data, changes: Record<string, unknown> = {}): ExtractedInvoice {
  const data = structuredClone(base)
  for (const [path, value] of Object.entries(changes)) setPath(data, path, value)
  return ExtractedInvoice.parse(data)
}

const outcome = (result: ValidationResult) => result.failures.map((f) => [f.rule, f.fields])
const messages = (result: ValidationResult) => result.failures.map((f) => f.message)

function lines(...items: [string, string, string, string][]): Data[] {
  return items.map(([quantity, unitNet, rate, net], i) => ({
    description: `item ${i}`,
    quantity,
    unit_net: unitNet,
    vat_rate: rate,
    net,
  }))
}

const decimal = (text: string) => new Decimal(text)

function singleLine(rate: string, vat: string): Data {
  return {
    lines: lines(['1', '100.00', rate, '100.00']),
    total_net: '100.00',
    total_vat: vat,
    total_gross: decimal('100.00').plus(decimal(vat)).toString(),
  }
}

const RATE_VAT: Record<string, string> = {
  '23': '23.00',
  '8': '8.00',
  '5': '5.00',
  '0': '0.00',
  zw: '0.00',
  np: '0.00',
  '19': '19.00',
  '7': '7.00',
}

describe('validate', () => {
  test('a clean PL invoice passes and is typed', () => {
    const result = validate(withChanges(plBase()))

    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.failedRules).toEqual([])
    const invoice = result.invoice!
    expect(invoice).not.toBeNull()
    expect(invoice.issue_date).toBe('2026-11-03')
    expect(invoice.sale_date).toBe('2026-11-02')
    expect(invoice.lines[0]!.quantity.equals(decimal('2'))).toBe(true)
    expect(invoice.lines[0]!.net!.equals(decimal('200.00'))).toBe(true)
    expect(String(invoice.lines[0]!.net)).toBe('200.00')
    expect(invoice.total_gross!.equals(decimal('300.00'))).toBe(true)
    expect(invoice.seller.tax_id).toBe(PL_NIP)
  })

  test('a clean DE invoice passes', () => {
    const result = validate(withChanges(deBase()))

    expect(result.failures).toEqual([])
    expect(result.invoice).not.toBeNull()
    expect(result.invoice!.sale_date).toBeNull()
  })

  test('a typed invoice round trips through its json', () => {
    const first = validate(withChanges(plBase())).invoice
    expect(first).not.toBeNull()

    const again = validate(ExtractedInvoice.parse(JSON.parse(JSON.stringify(first))))

    expect(again.passed).toBe(true)
    expect(again.invoice).toEqual(first)
  })

  test('VAT groups round half up, not half even', () => {
    const cent = decimal('0.01')
    expect(decimal('0.345').quantize(cent, 'HALF_UP').equals(decimal('0.35'))).toBe(true)
    expect(decimal('0.345').quantize(cent, 'HALF_EVEN').equals(decimal('0.34'))).toBe(true)
    const items = lines(['1', '1.50', '23', '1.50'], ['1', '0.90', '5', '0.90'])
    const halfUp = { lines: items, total_net: '2.40', total_vat: '0.40', total_gross: '2.80' }
    const halfEven = { lines: items, total_net: '2.40', total_vat: '0.38', total_gross: '2.78' }

    expect(validate(withChanges(plBase(), halfUp)).failures).toEqual([])
    expect(outcome(validate(withChanges(plBase(), halfEven)))).toEqual([
      ['vat_total', ['total_vat']],
    ])
  })

  test('the line net tolerance is inclusive', () => {
    const within = {
      lines: lines(['3', '33.33', '23', '100.00']),
      total_net: '100.00',
      total_vat: '23.00',
      total_gross: '123.00',
    }
    const outside = {
      lines: lines(['3', '33.33', '23', '100.01']),
      total_net: '100.01',
      total_vat: '23.00',
      total_gross: '123.01',
    }

    expect(validate(withChanges(plBase(), within)).failures).toEqual([])
    const result = validate(withChanges(plBase(), outside))
    expect(outcome(result)).toEqual([['line_net', ['lines[0].net']]])
  })

  test('line_net reports the failing line index', () => {
    const result = validate(
      withChanges(plBase(), {
        'lines[1].net': '50.02',
        total_net: '250.02',
        total_gross: '300.02',
      }),
    )

    expect(outcome(result)).toEqual([['line_net', ['lines[1].net']]])
  })

  test.each([
    ['250.01', '300.01', []],
    ['249.99', '299.99', []],
    ['250.02', '300.02', [['lines_total', ['total_net']]]],
  ])('the lines total tolerance is inclusive (%s, %s)', (totalNet, totalGross, expected) => {
    const result = validate(withChanges(plBase(), { total_net: totalNet, total_gross: totalGross }))

    expect(outcome(result)).toEqual(expected)
  })

  test.each([
    ['300.01', []],
    ['299.99', []],
    ['300.02', [['gross_total', ['total_gross']]]],
  ])('the gross total tolerance is inclusive (%s)', (totalGross, expected) => {
    expect(outcome(validate(withChanges(plBase(), { total_gross: totalGross })))).toEqual(expected)
  })

  test.each([
    ['50.01', '300.01', []],
    ['50.02', '300.02', [['vat_total', ['total_vat']]]],
  ])('the VAT total tolerance is inclusive (%s, %s)', (totalVat, totalGross, expected) => {
    const result = validate(withChanges(plBase(), { total_vat: totalVat, total_gross: totalGross }))

    expect(outcome(result)).toEqual(expected)
  })

  test('a PL seller with a German rate fails on the line rate', () => {
    const result = validate(
      withChanges(plBase(), {
        lines: lines(['1', '100.00', '19', '100.00']),
        total_net: '100.00',
        total_vat: '19.00',
        total_gross: '119.00',
      }),
    )

    expect(outcome(result)).toEqual([['vat_rate_country', ['lines[0].vat_rate']]])
  })

  test('a DE seller with a Polish exemption fails on the line rate', () => {
    const result = validate(
      withChanges(deBase(), {
        lines: lines(['1', '100.00', '19', '100.00'], ['1', '100.00', 'zw', '100.00']),
        total_net: '200.00',
        total_vat: '19.00',
        total_gross: '219.00',
      }),
    )

    expect(outcome(result)).toEqual([['vat_rate_country', ['lines[1].vat_rate']]])
  })

  test.each(['FR', 'Polska', 'pl'])(
    'a seller outside PL and DE fails on the country and skips the tax id (%s)',
    (country) => {
      const result = validate(
        withChanges(plBase(), { 'seller.country': country, 'seller.tax_id': 'FR40303265045' }),
      )

      expect(outcome(result)).toEqual([['vat_rate_country', ['seller.country']]])
      expect(result.failures[0]!.message).toContain(country)
    },
  )

  test.each(['zw', 'np'])('exempt lines count as zero VAT (%s)', (exempt) => {
    const changes = {
      lines: lines(['1', '100.00', exempt, '100.00'], ['1', '100.00', '23', '100.00']),
      total_net: '200.00',
      total_vat: '23.00',
      total_gross: '223.00',
    }

    expect(validate(withChanges(plBase(), changes)).failures).toEqual([])
  })

  test('a missing issue date fails required_fields and still builds the invoice', () => {
    const result = validate(withChanges(plBase(), { issue_date: null }))

    expect(outcome(result)).toEqual([['required_fields', ['issue_date']]])
    expect(messages(result)).toEqual(['issue_date is missing'])
    expect(result.invoice).not.toBeNull()
    expect(result.invoice!.issue_date).toBeNull()
  })

  test.each(['31.12.2026', '2026-02-30', '20261231', '2026-1-3'])(
    'an unparseable issue date fails required_fields and builds nothing (%s)',
    (raw) => {
      const result = validate(withChanges(plBase(), { issue_date: raw }))

      expect(outcome(result)).toEqual([['required_fields', ['issue_date']]])
      expect(messages(result)).toEqual(['issue_date is not parseable'])
      expect(result.invoice).toBeNull()
    },
  )

  test('a Polish formatted total_net fails every rule that uses it', () => {
    const result = validate(withChanges(plBase(), { total_net: '1 234,56' }))

    expect(outcome(result)).toEqual([
      ['lines_total', ['total_net']],
      ['gross_total', ['total_net']],
    ])
    expect(messages(result)).toEqual(['total_net is not parseable', 'total_net is not parseable'])
    expect(result.invoice).toBeNull()
  })

  test('everything wrong at once reports all seven rules', () => {
    const result = validate(
      withChanges(plBase(), {
        number: null,
        'seller.tax_id': '5260250275',
        'lines[0].vat_rate': '19',
        'lines[0].net': '201.00',
        total_net: '999.00',
        total_vat: '1.00',
        total_gross: '5.00',
      }),
    )

    expect(outcome(result)).toEqual([
      ['required_fields', ['number']],
      ['line_net', ['lines[0].net']],
      ['lines_total', ['total_net']],
      ['vat_rate_country', ['lines[0].vat_rate']],
      ['vat_total', ['total_vat']],
      ['gross_total', ['total_gross']],
      ['tax_id', ['seller.tax_id']],
    ])
    expect(result.failedRules).toEqual([...RULES])
    expect(result.invoice).not.toBeNull()
  })

  test.each([
    ['number', null, 'number is missing'],
    ['number', '  ', 'number is missing'],
    ['sale_date', '02.11.2026', 'sale_date is not parseable'],
    ['currency', null, 'currency is missing'],
    ['currency', 'zł', 'currency is not parseable'],
    ['currency', 'pln', 'currency is not parseable'],
    ['seller.name', null, 'seller.name is missing'],
    ['seller.name', '', 'seller.name is missing'],
  ])('each required field fails on its path (%s = %j)', (path, value, message) => {
    const result = validate(withChanges(plBase(), { [path]: value }))

    expect(outcome(result)).toEqual([['required_fields', [path]]])
    expect(messages(result)).toEqual([message])
  })

  test('a missing sale date is allowed', () => {
    expect(validate(withChanges(plBase(), { sale_date: null })).failures).toEqual([])
  })

  test('a missing seller tax id fails required_fields and tax_id', () => {
    const result = validate(withChanges(plBase(), { 'seller.tax_id': null }))

    expect(outcome(result)).toEqual([
      ['required_fields', ['seller.tax_id']],
      ['tax_id', ['seller.tax_id']],
    ])
  })

  test('a missing seller country fails required_fields and the rate rule', () => {
    const result = validate(
      withChanges(plBase(), { 'seller.country': null, 'seller.tax_id': 'garbage' }),
    )

    expect(outcome(result)).toEqual([
      ['required_fields', ['seller.country']],
      ['vat_rate_country', ['seller.country']],
    ])
    expect(messages(result)).toEqual(['seller.country is missing', 'seller.country is missing'])
  })

  test('no lines fails required_fields and the totals that need them', () => {
    const result = validate(withChanges(plBase(), { lines: [] }))

    expect(outcome(result)).toEqual([
      ['required_fields', ['lines']],
      ['lines_total', ['total_net']],
      ['vat_total', ['total_vat']],
    ])
  })

  describe.each(['quantity', 'unit_net'])('line_net input %s', (field) => {
    test.each([
      [null, 'missing'],
      ['2,5', 'not parseable'],
    ])('fails on its path (%j)', (value, reason) => {
      const result = validate(withChanges(plBase(), { [`lines[0].${field}`]: value }))

      expect(outcome(result)).toEqual([['line_net', [`lines[0].${field}`]]])
      expect(messages(result)).toEqual([`lines[0].${field} is ${reason}`])
    })
  })

  test('a missing quantity builds no invoice', () => {
    expect(validate(withChanges(plBase(), { 'lines[0].quantity': null })).invoice).toBeNull()
  })

  test('a missing unit_net still builds the invoice', () => {
    const result = validate(withChanges(plBase(), { 'lines[0].unit_net': null }))

    expect(result.invoice).not.toBeNull()
    expect(result.invoice!.lines[0]!.unit_net).toBeNull()
  })

  test('a missing line net fails every rule that uses it', () => {
    const result = validate(withChanges(plBase(), { 'lines[0].net': null }))

    expect(outcome(result)).toEqual([
      ['line_net', ['lines[0].net']],
      ['lines_total', ['lines[0].net']],
      ['vat_total', ['lines[0].net']],
    ])
    expect(messages(result)).toEqual(Array(3).fill('lines[0].net is missing'))
  })

  test('a missing VAT rate fails the rate and VAT rules', () => {
    const result = validate(withChanges(plBase(), { 'lines[0].vat_rate': null }))

    expect(outcome(result)).toEqual([
      ['vat_rate_country', ['lines[0].vat_rate']],
      ['vat_total', ['lines[0].vat_rate']],
    ])
    expect(messages(result)).toEqual(Array(2).fill('lines[0].vat_rate is missing'))
  })

  test('an unparseable VAT rate fails the rate and VAT rules', () => {
    const result = validate(withChanges(plBase(), { 'lines[0].vat_rate': '23%' }))

    expect(outcome(result)).toEqual([
      ['vat_rate_country', ['lines[0].vat_rate']],
      ['vat_total', ['lines[0].vat_rate']],
    ])
    expect(messages(result)[1]).toBe('lines[0].vat_rate is not parseable')
  })

  test('a missing total_vat fails the VAT and gross rules once each', () => {
    const result = validate(withChanges(plBase(), { total_vat: null }))

    expect(outcome(result)).toEqual([
      ['vat_total', ['total_vat']],
      ['gross_total', ['total_vat']],
    ])
    expect(messages(result)).toEqual(Array(2).fill('total_vat is missing'))
  })

  test('an unparseable total_gross fails gross_total', () => {
    const result = validate(withChanges(plBase(), { total_gross: '300.00 zł' }))

    expect(outcome(result)).toEqual([['gross_total', ['total_gross']]])
    expect(result.invoice).toBeNull()
  })

  test.each([
    'issue_date',
    'sale_date',
    'total_net',
    'total_vat',
    'total_gross',
    'lines[0].quantity',
    'lines[0].unit_net',
    'lines[0].net',
  ])('every unparseable value fails a rule and builds nothing (%s)', (path) => {
    const result = validate(withChanges(plBase(), { [path]: 'n/a' }))

    expect(result.passed).toBe(false)
    expect(result.invoice).toBeNull()
    expect(result.failures.every((f) => f.fields.length === 1 && f.fields[0] === path)).toBe(true)
  })

  test.each(['1e3', 'NaN', 'Infinity', '1_000', '+5', '1.', '.5'])(
    'only plain decimals parse (%s)',
    (raw) => {
      const result = validate(withChanges(plBase(), { total_gross: raw }))

      expect(outcome(result)).toEqual([['gross_total', ['total_gross']]])
    },
  )

  test('a DE seller with a bad USt-IdNr fails tax_id', () => {
    const result = validate(withChanges(deBase(), { 'seller.tax_id': 'DE136695975' }))

    expect(outcome(result)).toEqual([['tax_id', ['seller.tax_id']]])
    expect(result.failures[0]!.message).toContain('USt-IdNr')
  })

  test('a DE seller with a valid NIP fails tax_id', () => {
    const result = validate(withChanges(deBase(), { 'seller.tax_id': PL_NIP }))

    expect(outcome(result)).toEqual([['tax_id', ['seller.tax_id']]])
  })

  test('a PL seller with a printed PL prefix passes', () => {
    const result = validate(withChanges(plBase(), { 'seller.tax_id': 'PL 526-025-02-74' }))

    expect(result.failures).toEqual([])
  })

  test.each([
    ['PL', '5260250275'],
    ['DE', 'DE136695975'],
    ['DE', PL_NIP],
  ])('a printed buyer tax id is checked for PL and DE (%s %s)', (country, taxId) => {
    const result = validate(
      withChanges(plBase(), { 'buyer.country': country, 'buyer.tax_id': taxId }),
    )

    expect(outcome(result)).toEqual([['tax_id', ['buyer.tax_id']]])
  })

  test.each([
    ['PL', null],
    ['PL', ' '],
    ['FR', 'FR-garbage'],
    [null, 'garbage'],
    ['DE', DE_UST],
  ])('the buyer tax id is skipped when absent or outside PL and DE (%j %j)', (country, taxId) => {
    const result = validate(
      withChanges(plBase(), { 'buyer.country': country, 'buyer.tax_id': taxId }),
    )

    expect(result.failures).toEqual([])
  })

  test('failed rules follow the rule order without duplicates', () => {
    const result = validate(withChanges(plBase(), { total_vat: null, number: null }))

    expect(result.failedRules).toEqual(['required_fields', 'vat_total', 'gross_total'])
  })

  test('failures serialise to the contract shape', () => {
    const result = validate(withChanges(plBase(), { issue_date: null }))

    expect(JSON.parse(JSON.stringify(result.failures))).toEqual([
      { rule: 'required_fields', message: 'issue_date is missing', fields: ['issue_date'] },
    ])
  })

  test.each(['extra', 'seller.extra', 'lines[0].extra'])(
    'ExtractedInvoice forbids extra fields (%s)',
    (path) => {
      const data = plBase()
      setPath(data, path, 'x')

      const parsed = ExtractedInvoice.safeParse(data)

      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues[0]!.code).toBe('unrecognized_keys')
    },
  )

  test('the typed invoice forbids extra fields', () => {
    const invoice = validate(withChanges(plBase())).invoice
    expect(invoice).not.toBeNull()
    const data = JSON.parse(JSON.stringify(invoice))
    data.note = 'x'

    const parsed = Invoice.safeParse(data)

    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['note'] })
  })

  test('ExtractedInvoice keeps money and dates as text', () => {
    const extracted = withChanges(plBase(), { total_net: '1 234,56', issue_date: '31.12.2026' })

    expect(extracted.total_net).toBe('1 234,56')
    expect(extracted.issue_date).toBe('31.12.2026')
  })

  test.each([
    ...['23', '8', '5', '0', 'zw', 'np'].map((rate) => ['pl', plBase, rate] as const),
    ...['19', '7', '0'].map((rate) => ['de', deBase, rate] as const),
  ])('every rate of the country passes (%s %s)', (_name, base, rate) => {
    expect(validate(withChanges(base(), singleLine(rate, RATE_VAT[rate]!))).failures).toEqual([])
  })

  test.each([
    ...['19', '7'].map((rate) => ['pl', plBase, rate] as const),
    ...['23', '8', '5', 'zw', 'np'].map((rate) => ['de', deBase, rate] as const),
  ])('every rate of the other country fails on the line (%s %s)', (_name, base, rate) => {
    const result = validate(withChanges(base(), singleLine(rate, RATE_VAT[rate]!)))

    expect(outcome(result)).toEqual([['vat_rate_country', ['lines[0].vat_rate']]])
  })

  test.each([
    ['pl', plBase, 'lines[1].vat_rate', '8.0'],
    ['pl', plBase, 'lines[0].vat_rate', '23.00'],
    ['pl', plBase, 'lines[0].vat_rate', '23 '],
    ['pl', plBase, 'lines[1].vat_rate', ' zw '],
    ['de', deBase, 'lines[1].vat_rate', '7.0'],
  ] as const)(
    'a rate written differently is the same rate in both rules (%s %s %j)',
    (_name, base, path, rate) => {
      const data = base()
      if (rate.trim() === 'zw') {
        setPath(data, 'total_vat', '46.00')
        setPath(data, 'total_gross', '296.00')
      }

      expect(validate(withChanges(data, { [path]: rate })).failures).toEqual([])
    },
  )

  test('whitespace around text is ignored and stripped in the invoice', () => {
    const result = validate(
      withChanges(plBase(), {
        currency: 'PLN ',
        'seller.country': ' PL',
        number: ' FV/1 ',
        'seller.name': ' Sprzedawca Sp. z o.o. ',
        'seller.tax_id': ` ${PL_NIP} `,
        'seller.address': ' ul. Testowa 1 ',
        'buyer.name': ' Nabywca S.A. ',
        'buyer.tax_id': ' 526-025-02-74 ',
        'buyer.address': ' ul. Próbna 2 ',
        'lines[0].description': ' Usługa A ',
        'lines[0].vat_rate': ' 23 ',
        'lines[0].net': ' 200.00 ',
        total_gross: ' 300.00',
        issue_date: '2026-11-03 ',
        sale_date: ' 2026-11-02',
      }),
    )

    expect(result.failures).toEqual([])
    const invoice = result.invoice!
    expect(invoice).not.toBeNull()
    expect(invoice.currency).toBe('PLN')
    expect(invoice.number).toBe('FV/1')
    expect([invoice.seller.name, invoice.seller.tax_id, invoice.seller.country]).toEqual([
      'Sprzedawca Sp. z o.o.',
      PL_NIP,
      'PL',
    ])
    expect(invoice.seller.address).toBe('ul. Testowa 1')
    expect([invoice.buyer.name, invoice.buyer.tax_id, invoice.buyer.address]).toEqual([
      'Nabywca S.A.',
      '526-025-02-74',
      'ul. Próbna 2',
    ])
    expect(invoice.lines[0]!.description).toBe('Usługa A')
    expect(invoice.lines[0]!.vat_rate).toBe('23')
    expect(invoice.lines[0]!.net!.equals(decimal('200.00'))).toBe(true)
    expect(invoice.total_gross!.equals(decimal('300.00'))).toBe(true)
    expect([invoice.issue_date, invoice.sale_date]).toEqual(['2026-11-03', '2026-11-02'])
  })

  test('a padded seller country still checks the tax id', () => {
    const result = validate(
      withChanges(plBase(), { 'seller.country': 'PL ', 'seller.tax_id': '5260250275' }),
    )

    expect(outcome(result)).toEqual([['tax_id', ['seller.tax_id']]])
  })

  test('a blank seller tax id is missing in both rules', () => {
    const result = validate(withChanges(plBase(), { 'seller.tax_id': '   ' }))

    expect(outcome(result)).toEqual([
      ['required_fields', ['seller.tax_id']],
      ['tax_id', ['seller.tax_id']],
    ])
    expect(messages(result)).toEqual(Array(2).fill('seller.tax_id is missing'))
  })

  test.each([
    ['FR', [['vat_rate_country', ['seller.country']]]],
    [
      null,
      [
        ['required_fields', ['seller.country']],
        ['vat_rate_country', ['seller.country']],
      ],
    ],
  ])(
    'an unknown or missing country checks no line rate against a set (%j)',
    (country, expected) => {
      const changes = { ...singleLine('19', '19.00'), 'seller.country': country }

      expect(outcome(validate(withChanges(plBase(), changes)))).toEqual(expected)
    },
  )

  test('an unknown country still fails an unparseable line rate', () => {
    const result = validate(
      withChanges(plBase(), { 'seller.country': 'FR', 'lines[0].vat_rate': 'abc' }),
    )

    expect(outcome(result)).toEqual([
      ['vat_rate_country', ['seller.country']],
      ['vat_rate_country', ['lines[0].vat_rate']],
      ['vat_total', ['lines[0].vat_rate']],
    ])
    expect(messages(result)[1]).toBe('lines[0].vat_rate is not parseable')
  })

  test('vat_total reports every missing input', () => {
    const result = validate(withChanges(plBase(), { 'lines[0].net': null, total_vat: null }))

    expect(outcome(result)).toEqual([
      ['line_net', ['lines[0].net']],
      ['lines_total', ['lines[0].net']],
      ['vat_total', ['lines[0].net']],
      ['vat_total', ['total_vat']],
      ['gross_total', ['total_vat']],
    ])
  })

  test('lines with the same rate are summed into one group', () => {
    const changes = {
      lines: lines(['1', '100.00', '23', '100.00'], ['1', '100.00', '23', '100.00']),
      total_net: '200.00',
      total_vat: '46.00',
      total_gross: '246.00',
    }

    expect(validate(withChanges(plBase(), changes)).failures).toEqual([])
  })

  test('VAT groups round half up, not up', () => {
    const changes = {
      lines: lines(['1', '1.10', '23', '1.10'], ['1', '0.40', '8', '0.40']),
      total_net: '1.50',
      total_vat: '0.28',
      total_gross: '1.78',
    }
    const roundUp = { ...changes, total_vat: '0.30', total_gross: '1.80' }

    expect(validate(withChanges(plBase(), changes)).failures).toEqual([])
    expect(outcome(validate(withChanges(plBase(), roundUp)))).toEqual([
      ['vat_total', ['total_vat']],
    ])
  })
})

describe('one case per rule, with its message', () => {
  test.each<[string, () => Data, Record<string, unknown>, [string, string, string][]]>([
    [
      'required_fields: no number',
      plBase,
      { number: null },
      [['required_fields', 'number', 'number is missing']],
    ],
    [
      'required_fields: an impossible issue date',
      plBase,
      { issue_date: '2026-02-30' },
      [['required_fields', 'issue_date', 'issue_date is not parseable']],
    ],
    [
      'line_net: 2 × 100.50 is not the printed 200.00',
      plBase,
      { 'lines[0].unit_net': '100.50' },
      [['line_net', 'lines[0].net', 'lines[0].net is 200.00, quantity times unit_net is 201.00']],
    ],
    [
      'lines_total: 200.00 + 50.00 is not 250.02',
      plBase,
      { total_net: '250.02', total_gross: '300.02' },
      [['lines_total', 'total_net', 'total_net is 250.02, the line nets sum to 250.00']],
    ],
    [
      'vat_rate_country: 19 is a German rate',
      plBase,
      {
        lines: lines(['1', '100.00', '19', '100.00']),
        total_net: '100.00',
        total_vat: '19.00',
        total_gross: '119.00',
      },
      [
        [
          'vat_rate_country',
          'lines[0].vat_rate',
          'lines[0].vat_rate 19 is not a valid VAT rate for PL',
        ],
      ],
    ],
    [
      'vat_rate_country: a seller outside PL and DE',
      plBase,
      { 'seller.country': 'FR' },
      [['vat_rate_country', 'seller.country', 'seller.country "FR" is not PL or DE']],
    ],
    [
      'vat_total: 23% of 200.00 plus 8% of 50.00 is 50.00',
      plBase,
      { total_vat: '50.02', total_gross: '300.02' },
      [['vat_total', 'total_vat', 'total_vat is 50.02, the rate groups give 50.00']],
    ],
    [
      'vat_total: 0.345 and 0.045 round half up to 0.35 and 0.05',
      plBase,
      {
        lines: lines(['1', '1.50', '23', '1.50'], ['1', '0.90', '5', '0.90']),
        total_net: '2.40',
        total_vat: '0.38',
        total_gross: '2.78',
      },
      [['vat_total', 'total_vat', 'total_vat is 0.38, the rate groups give 0.40']],
    ],
    [
      'gross_total: 250.00 + 50.00 is not 300.02',
      plBase,
      { total_gross: '300.02' },
      [['gross_total', 'total_gross', 'total_gross is 300.02, total_net plus total_vat is 300.00']],
    ],
    [
      'tax_id: a NIP with a wrong check digit',
      plBase,
      { 'seller.tax_id': '5260250275' },
      [['tax_id', 'seller.tax_id', 'seller.tax_id "5260250275" is not a valid NIP']],
    ],
    [
      'tax_id: a USt-IdNr with a wrong check digit',
      deBase,
      { 'seller.tax_id': 'DE136695975' },
      [['tax_id', 'seller.tax_id', 'seller.tax_id "DE136695975" is not a valid USt-IdNr']],
    ],
    [
      'tax_id: a printed buyer NIP with a wrong check digit',
      plBase,
      { 'buyer.tax_id': '526-025-02-75' },
      [['tax_id', 'buyer.tax_id', 'buyer.tax_id "526-025-02-75" is not a valid NIP']],
    ],
  ])('%s', (_name, base, changes, expected) => {
    const result = validate(withChanges(base(), changes))

    expect(result.failures).toEqual(
      expected.map(([rule, field, message]) => ({ rule, message, fields: [field] })),
    )
  })
})

function typed(changes: Record<string, unknown> = {}): Data {
  const data: Data = JSON.parse(JSON.stringify(validate(withChanges(plBase())).invoice))
  for (const [path, value] of Object.entries(changes)) setPath(data, path, value)
  return data
}

describe('the Invoice schema', () => {
  test('money and quantities parse to decimals that keep their scale, dates stay ISO text', () => {
    const invoice = Invoice.parse(typed({ sale_date: null, 'lines[0].unit_net': null }))

    expect(invoice.total_net).toBeInstanceOf(Decimal)
    expect(String(invoice.total_net)).toBe('250.00')
    expect(String(invoice.lines[0]!.quantity)).toBe('2')
    expect(invoice.lines[0]!.unit_net).toBeNull()
    expect([invoice.issue_date, invoice.sale_date]).toEqual(['2026-11-03', null])
  })

  test.each<[string, Record<string, unknown>, string]>([
    ['total_net', { total_net: '1 234,56' }, 'custom'],
    ['total_net', { total_net: '1e3' }, 'custom'],
    ['total_net', { total_net: 250 }, 'invalid_type'],
    ['lines[0].quantity', { 'lines[0].quantity': null }, 'invalid_type'],
    ['issue_date', { issue_date: '2026-02-30' }, 'invalid_format'],
    ['issue_date', { issue_date: '03.11.2026' }, 'invalid_format'],
    ['currency', { currency: undefined }, 'invalid_type'],
  ])('a bad %s is refused (%j)', (path, changes, code) => {
    const parsed = Invoice.safeParse(typed(changes))

    expect(parsed.success).toBe(false)
    const issue = parsed.error!.issues[0]!
    expect([issue.path.join('.'), issue.code]).toEqual([path.replace(/\[(\d+)\]/, '.$1'), code])
  })

  test.each(['lines[0].extra', 'seller.extra', 'buyer.extra'])(
    'a typed invoice refuses an extra key on a nested object (%s)',
    (path) => {
      const parsed = Invoice.safeParse(typed({ [path]: 'x' }))

      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['extra'] })
    },
  )

  test('a decimal that does not parse says which text it was', () => {
    const parsed = Invoice.safeParse(typed({ total_net: '1 234,56' }))

    expect(parsed.error!.issues[0]!.message).toBe('"1 234,56" is not a decimal number')
  })
})

// Five lines of 0.10 at 23 %: the group VAT is 0.23 × 0.50 = 0.115, 0.12 half up, while rounding
// each line gives 0.023 → 0.02, five times 0.10.
const fiveDimes = (vat: string, gross: string) => ({
  lines: lines(
    ...Array.from(
      { length: 5 },
      () => ['1', '0.10', '23', '0.10'] as [string, string, string, string],
    ),
  ),
  total_net: '0.50',
  total_vat: vat,
  total_gross: gross,
})

describe('what parses', () => {
  test.each(['2028-02-29', '2000-02-29', '2026-02-28', '0001-01-01', '9999-12-31'])(
    'a real calendar date passes (%s)',
    (raw) => {
      expect(validate(withChanges(plBase(), { issue_date: raw })).failures).toEqual([])
    },
  )

  test.each(['2026-02-29', '2100-02-29', '0000-01-01', '2026-04-31', '2026-13-01'])(
    'a date that is not in the calendar is not parseable (%s)',
    (raw) => {
      const result = validate(withChanges(plBase(), { issue_date: raw }))

      expect(result.failures).toEqual([
        { rule: 'required_fields', message: 'issue_date is not parseable', fields: ['issue_date'] },
      ])
    },
  )

  test.each(['1234567890123456', '300.00000000001'])(
    'money over 15 integer digits or 10 decimal places is not parseable (%s)',
    (raw) => {
      const result = validate(withChanges(plBase(), { total_gross: raw }))

      expect(result.failures).toEqual([
        { rule: 'gross_total', message: 'total_gross is not parseable', fields: ['total_gross'] },
      ])
    },
  )

  test('money at 10 decimal places parses', () => {
    expect(validate(withChanges(plBase(), { total_gross: '300.0000000000' })).failures).toEqual([])
  })

  test('a credit line with negative money passes when the totals match', () => {
    const changes = {
      lines: lines(['2', '100.00', '23', '200.00'], ['1', '-100.00', '23', '-100.00']),
      total_net: '100.00',
      total_vat: '23.00',
      total_gross: '123.00',
    }

    expect(validate(withChanges(plBase(), changes)).failures).toEqual([])
  })

  test.each(['1000', '23.000'])(
    'a VAT rate over 3 digits or 2 places is not parseable (%s)',
    (raw) => {
      const result = validate(withChanges(plBase(), { 'lines[0].vat_rate': raw }))

      expect(result.failures).toEqual(
        ['vat_rate_country', 'vat_total'].map((rule) => ({
          rule,
          message: 'lines[0].vat_rate is not parseable',
          fields: ['lines[0].vat_rate'],
        })),
      )
    },
  )

  test('VAT is rounded once per rate group, not per line', () => {
    expect(validate(withChanges(plBase(), fiveDimes('0.12', '0.62'))).failures).toEqual([])
    expect(validate(withChanges(plBase(), fiveDimes('0.10', '0.60'))).failures).toEqual([
      {
        rule: 'vat_total',
        message: 'total_vat is 0.10, the rate groups give 0.12',
        fields: ['total_vat'],
      },
    ])
  })
})
