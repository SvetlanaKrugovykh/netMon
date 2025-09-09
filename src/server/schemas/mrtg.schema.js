module.exports = {
  description: 'mrtg report generation',
  tags: ['mrtg'],
  summary: 'Generate MRTG report',
  headers: {
    type: 'object',
    properties: {
      Authorization: { type: 'string' }
    },
    required: ['Authorization']
  },
  body: {
    type: 'object',
    properties: {
      abonentId: { type: 'string' },
      ipAddress: { type: 'string' },
      vlanId: { type: 'string' }
    },
    required: ['abonentId', 'ipAddress', 'vlanId']
  },
  response: {
    201: {
      description: 'Successful response',
      type: 'object',
      properties: {
        success: { type: 'boolean' }
      }
    },
    500: {
      description: 'Internal server error',
      type: 'object',
      properties: {
        statusCode: { type: 'integer' },
        error: { type: 'string' },
        message: { type: 'string' }
      }
    }
  }
}
