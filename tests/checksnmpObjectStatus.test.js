require('dotenv').config();
const { checksnmpObjectStatus } = require('../src/server/services/snmpNetWatchService');

const TEST_SNMP_IP = process.env.TEST_SNMP_IP;
const TEST_SNMP_OID = process.env.TEST_SNMP_OID;
const TEST_SNMP_VALUE = process.env.TEST_SNMP_VALUE || '';
const TEST_SNMP_MIN = process.env.TEST_SNMP_MIN || '';
const TEST_SNMP_MAX = process.env.TEST_SNMP_MAX || '';
const TEST_SNMP_DESCRIPTION = process.env.TEST_SNMP_DESCRIPTION || '';

if (!TEST_SNMP_IP || !TEST_SNMP_OID) {
  console.error('Please set TEST_SNMP_IP and TEST_SNMP_OID in your .env file');
  process.exit(1);
}

const testSnmpObject = {
  ip_address: TEST_SNMP_IP,
  oid: TEST_SNMP_OID,
  value: TEST_SNMP_VALUE,
  min: TEST_SNMP_MIN,
  max: TEST_SNMP_MAX,
  description: TEST_SNMP_DESCRIPTION,
  status: 'alive', // or 'dead', depending on what you want to test
};

console.log('Testing checksnmpObjectStatus with:', testSnmpObject);

(async () => {
  try {
    const result = await checksnmpObjectStatus(testSnmpObject);
    console.log('Result from checksnmpObjectStatus:', result);
  } catch (err) {
    console.error('Error during checksnmpObjectStatus test:', err);
  }
})();