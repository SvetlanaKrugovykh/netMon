require('dotenv').config()
const { handleStatusChange } = require('../src/server/modules/watchHandler');

(async () => {
  const addToList = [{ ip_address: process.env.TEST_SNMP_IP, oid: ".1.3.6.1.4.1.171.12.72.2.1.1.1.6.26", count: 1, lastValue: "19.0658" }]
  const removeFromList = []

  const snmpObj = {
    ip_address: "192.168.65.238",
    description: "Rx Power DDM Olimp10G-Kiev_26_UP",
    oid: ".1.3.6.1.4.1.171.12.72.2.1.1.1.6.26",
    status: "dead",
    min: -18.9,
    max: -17.3,
    value: "-19.3930"
  }

  await handleStatusChange({
    ip_address: snmpObj,
    removeFromList,
    addToList,
    fromStatus: "dead",
    toStatus: "dead",
    service: true,
    response: "value -19.3930 Status PROBLEM"
  })

  console.log('addToList after:', addToList)
})()