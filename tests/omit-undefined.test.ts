import assert from 'node:assert/strict'
import test from 'node:test'

import { omitUndefined } from '../src/lib/omit-undefined.js'

type Equal<Left, Right> = (
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
        ? true
        : false
    : false
)

type Expect<Value extends true> = Value

test('omitUndefined removes only top-level undefined fields', () => {
  const nested = { retained: undefined } as const
  const callback = () => 'ok' as const
  const optionalText = (): 'present' | undefined => undefined
  const input = {
    text: 'value' as const,
    optionalText: optionalText(),
    removed: undefined,
    nil: null,
    disabled: false,
    zero: 0,
    empty: '',
    notANumber: Number.NaN,
    callback,
    nested,
  }
  const result = omitUndefined(input)

  type Result = typeof result
  type _RequiredFieldsStayRequired = Expect<Equal<Result['text'], 'value'>>
  type _OptionalUndefinedIsExcluded = Expect<Equal<Result['optionalText'], 'present' | undefined>>
  type _PureUndefinedFieldIsRemoved = Expect<Equal<'removed' extends keyof Result ? true : false, false>>
  type _FunctionsKeepTheirCallSignature = Expect<Equal<Result['callback'], typeof callback>>
  type _NestedReferencesKeepTheirType = Expect<Equal<Result['nested'], typeof nested>>
  type _Assertions = [
    _RequiredFieldsStayRequired,
    _OptionalUndefinedIsExcluded,
    _PureUndefinedFieldIsRemoved,
    _FunctionsKeepTheirCallSignature,
    _NestedReferencesKeepTheirType,
  ]
  const assertions: _Assertions = [true, true, true, true, true]

  assert.deepEqual(assertions, [true, true, true, true, true])
  assert.notStrictEqual(result, input)
  assert.equal(Object.hasOwn(result, 'optionalText'), false)
  assert.equal(Object.hasOwn(result, 'removed'), false)
  assert.equal(result.nil, null)
  assert.equal(result.disabled, false)
  assert.equal(result.zero, 0)
  assert.equal(result.empty, '')
  assert.equal(Number.isNaN(result.notANumber), true)
  assert.equal(result.callback(), 'ok')
  assert.strictEqual(result.nested, nested)
  assert.equal(Object.hasOwn(result.nested, 'retained'), true)
})

test('omitUndefined retains defined optional fields', () => {
  const optionalText: string | undefined = 'present'
  const result = omitUndefined({ optionalText })

  assert.deepEqual(result, { optionalText: 'present' })
  assert.equal(Object.hasOwn(result, 'optionalText'), true)
})
