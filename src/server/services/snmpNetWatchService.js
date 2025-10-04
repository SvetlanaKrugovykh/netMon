const snmp = require('snmp-native')
const { runCommand } = require('../utils/commandsOS')
const { sendReqToDB } = require('../modules/to_local_DB.js')
const { handleStatusChange } = require('../modules/watchHandler.js')

const Status = {
  ALIVE: 'alive',
  DEAD: 'dead'
}
const alivesnmpObjectIP = []
const deadsnmpObjectIP = []


async function checksnmpObjectStatus(snmpObject) {
  const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let response = ''
  try {
    if (snmpObject.value.length < 10) {
      response = await snmpGet(snmpObject)
    } else {
      response = await runCommand('snmpwalk', ['-v', '2c', '-c', 'public', '-OXsq', '-On', snmpObject.ip_address, snmpObject.oid], snmpObject.value)
    }
    if (response && typeof response === 'string' && response.includes('Status OK')) {
      handleSnmpObjectAliveStatus(snmpObject, response)
    } else {
      console.log(`${formattedDate} ip:${snmpObject.ip_address} ${snmpObject.description} response: ${response} oid:${snmpObject.oid}`)
      handleSnmpObjectDeadStatus(snmpObject, response)
    }
  } catch (err) {
    console.log(err)
  }
}


async function handleSnmpObjectDeadStatus(snmpObject, response) {
  if (!snmpObject.ip_address) {
    console.log('handlesnmpObjectAliveStatus: snmpObject.ip_address is undefined', snmpObject)
    return
  }
  try {
    const foundIndexDead = deadsnmpObjectIP.findIndex(item => (item.ip_address === snmpObject.ip_address && item.oid === snmpObject.oid))
    const loadStatus = snmpObject.status.toLowerCase()
    if (loadStatus === Status.ALIVE) {
      await handleStatusChange({ ip_address: snmpObject, removeFromList: alivesnmpObjectIP, addToList: deadsnmpObjectIP, fromStatus: Status.ALIVE, toStatus: Status.DEAD, service: true, response })
    } else {
      let prevValue = ''
      if (foundIndexDead !== -1) prevValue = deadsnmpObjectIP[foundIndexDead].lastValue;
      const newValue = snmpObject.value
      const prevNum = parseFloat(prevValue)
      const newNum = parseFloat(newValue)
      const bothNumbers = !isNaN(prevNum) && !isNaN(newNum)
      const valueChanged = (bothNumbers && prevNum !== newNum) || (!bothNumbers && prevValue !== undefined && newValue !== undefined && prevValue !== newValue)
      if (valueChanged) {
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: deadsnmpObjectIP, fromStatus: Status.DEAD, toStatus: Status.DEAD, service: true, response })
      }
      if (foundIndexDead === -1) {
        deadsnmpObjectIP.push({ ip_address: snmpObject.ip_address, oid: snmpObject.oid, count: 1, lastValue: snmpObject.value })
      } else {
        deadsnmpObjectIP[foundIndexDead].count++
        deadsnmpObjectIP[foundIndexDead].lastValue = snmpObject.value
      }
      snmpObject.status = Status.DEAD
    }
  } catch (err) {
    console.error('Error in handleSnmpObjectDeadStatus:', err)
  }
}

async function handleSnmpObjectAliveStatus(snmpObject, response) {
  if (!snmpObject.ip_address) {
    console.log('handlesnmpObjectAliveStatus: snmpObject.ip_address is undefined', snmpObject)
    return
  }
  try {
    const foundIndexAlive = alivesnmpObjectIP.findIndex(item => (item.ip_address === snmpObject.ip_address && item.oid === snmpObject.oid))
    const loadStatus = snmpObject.status.toLowerCase()
    if (loadStatus === Status.DEAD) {
      await handleStatusChange({ ip_address: snmpObject, removeFromList: deadsnmpObjectIP, addToList: alivesnmpObjectIP, fromStatus: Status.DEAD, toStatus: Status.ALIVE, service: true, response })
    } else {
      // Проверяем изменение значения
      let prevValue = '';
      if (foundIndexAlive !== -1) prevValue = alivesnmpObjectIP[foundIndexAlive].lastValue;
      const newValue = snmpObject.value;
      const prevNum = parseFloat(prevValue);
      const newNum = parseFloat(newValue);
      const bothNumbers = !isNaN(prevNum) && !isNaN(newNum);
      const valueChanged = (bothNumbers && prevNum !== newNum) || (!bothNumbers && prevValue !== undefined && newValue !== undefined && prevValue !== newValue);
      if (valueChanged) {
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: alivesnmpObjectIP, fromStatus: Status.ALIVE, toStatus: Status.ALIVE, service: true, response });
      }
      if (foundIndexAlive === -1) {
        alivesnmpObjectIP.push({ ip_address: snmpObject.ip_address, oid: snmpObject.oid, count: 1, lastValue: snmpObject.value })
      } else {
        alivesnmpObjectIP[foundIndexAlive].count++
        alivesnmpObjectIP[foundIndexAlive].lastValue = snmpObject.value
      }
      snmpObject.status = Status.ALIVE
    }
  } catch (err) {
    console.error('Error in handleSnmpObjectAliveStatus:', err)
  }
}


async function snmpGet(snmpObject, community = 'public') {
  const session = new snmp.Session({ host: snmpObject.ip_address, community: community, timeout: 5000 })

  try {
    const varbinds = await new Promise((resolve, reject) => {
      session.get({ oid: snmpObject.oid }, (error, varbinds) => {
        session.close()
        if (error) {
          if (error.message && error.message.toLowerCase().includes('timeout')) {
            console.error(`[ERROR] Timeout for SNMP get ${snmpObject.ip_address} ${snmpObject.oid}`)
          } else {
            console.error('Error:', error.message || error)
          }
          reject(error)
        } else {
          resolve(varbinds)
        }
      })
    })
    if (varbinds.length > 0) {
      return snmpAnswersAnalizer(snmpObject, varbinds)
    } else {
      throw new Error('No response received')
    }
  } catch (error) {
    if (error.message && error.message.toLowerCase().includes('timeout')) {
      console.error(`[ERROR] Timeout for SNMP get ${snmpObject.ip_address} ${snmpObject.oid}`)
    } else {
      console.error('Error:', error.message || error)
    }
    throw error
  }
}

function snmpAnswersAnalizer(snmpObject, varbinds) {
  try {
    if (varbinds[0].type === 2 && snmpObject.value !== '') {
      if (varbinds[0].value === Number(snmpObject.value)) {
        return 'Status OK'
      }
    }

    if (varbinds[0].type >= 2 && (snmpObject.min !== '' || snmpObject.max !== '')) {
      if (varbinds[0].value >= Number(snmpObject.min) && varbinds[0].value <= Number(snmpObject.max)) {
        return `value ${varbinds[0].value} Status OK`
      } else {
        return `value ${varbinds[0].value} Status PROBLEM`
      }
    }
    return varbinds[0].value
  } catch (error) {
    console.error('Error:', error)
    throw error
  }
}

async function loadSnmpObjectsList() {
  try {
    const data = await sendReqToDB('__GetSnmpObjectsForWatching__', '', '')
    if (!data) {
      console.error('No data received from sendReqToDB')
      return []
    }
    let parsedData
    try {
      parsedData = JSON.parse(data)
    } catch (parseErr) {
      console.error('Error parsing JSON:', parseErr, 'Raw data:', data)
      return []
    }
    if (!parsedData.ResponseArray) {
      console.error('ResponseArray is missing in parsedData:', parsedData)
      return []
    }
    // Add lastValue to each object for status tracking
    // Use lastValue from response if present, parse only the numeric part
    return parsedData.ResponseArray.map(obj => {
      let rawLastValue = obj.lastValue !== undefined ? obj.lastValue : (obj.value !== undefined ? obj.value : '')
      let parsedLastValue = ''
      if (typeof rawLastValue === 'string') {
        // Remove 'value', 'Status OK', 'Status PROBLEM', and extra spaces
        parsedLastValue = rawLastValue
          .replace(/value/gi, '')
          .replace(/Status OK/gi, '')
          .replace(/Status PROBLEM/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        // Try to extract the number if present
        const match = parsedLastValue.match(/-?\d+(\.\d+)?/)
        parsedLastValue = match ? match[0] : ''
      } else if (typeof rawLastValue === 'number') {
        parsedLastValue = rawLastValue.toString()
      }
      return {
        ...obj,
        lastValue: parsedLastValue
      }
    })
  } catch (err) {
    console.error('Error in loadSnmpObjectsList:', err)
    return []
  }
}

module.exports = { checksnmpObjectStatus, loadSnmpObjectsList }