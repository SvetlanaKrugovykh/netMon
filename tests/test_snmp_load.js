(async () => {
  const { loadSnmpObjectsList } = require('../src/server/services/snmpNetWatchService')

  let snmpObjectsList = await loadSnmpObjectsList();
  console.log(snmpObjectsList);
})();