import { describe, expect, it } from 'vitest'
import { STATUS_OUTPUT, createStatusTool } from '../src/status.js'

describe('M0 status tool contract', () => {
  it('returns the fixed status object without inputs', async () => {
    const tool = createStatusTool()
    expect(await tool.execute({}, {} as never)).toEqual(STATUS_OUTPUT)
    expect(JSON.stringify(await tool.execute({}, {} as never))).toBe(JSON.stringify(STATUS_OUTPUT))
  })

  it('declares a closed output schema and no input parameters', () => {
    const tool = createStatusTool()
    expect(tool.parameters).toEqual({ type: 'object', properties: {} })
    expect(tool.output.schema).toMatchObject({ type: 'object', additionalProperties: false })
    if (tool.output.schema.type !== 'object') throw new Error('status schema must be an object')
    expect(tool.output.schema.required).toEqual([
      'plugin',
      'version',
      'protocol_version',
      'memory_enabled',
      'status',
    ])
  })
})
