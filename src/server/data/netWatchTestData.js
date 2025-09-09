const testIpList = [
  { ip_address: '127.0.0.1', description: 'ip1', status: 'dead' },
]

const testServiceList = [
  { ip_address: '127.0.0.1', description: 's1', Port: '8080', status: 'dead' },
]

const testSnmpObjectsList = [
  { ip_address: '127.0.0.1', description: 's1', oid: '.1.3.6.1.2.1.17.7.1.2.2.1.2.XXX', value: '164.147.76.114.120', status: 'dead' },
]

module.exports = { testIpList, testServiceList, testSnmpObjectsList }