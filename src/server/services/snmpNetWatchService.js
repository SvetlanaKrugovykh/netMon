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


async function checksnmpObjectStatus(snmpObject, cycleId) {
  const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let response = ''
  try {
    console.log(`[SNMP] checksnmpObjectStatus`, { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid, status: snmpObject.status })
    if (snmpObject.value.length < 10) {
      response = await snmpGet(snmpObject)
    } else {
      response = await runCommand('snmpwalk', ['-v', '2c', '-c', 'public', '-OXsq', '-On', snmpObject.ip_address, snmpObject.oid], snmpObject.value)
    }
    if (response && typeof response === 'string' && response.includes('Status OK')) {
      handleSnmpObjectAliveStatus(snmpObject, response, cycleId)
    } else {
      console.log(`[SNMP] DEAD`, { cycleId, ip: snmpObject.ip_address, desc: snmpObject.description, response, oid: snmpObject.oid })
      handleSnmpObjectDeadStatus(snmpObject, response, cycleId)
    }
  } catch (err) {
    console.log(`[SNMP] Exception in checksnmpObjectStatus`, { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid, error: err && err.message ? err.message : err })
  }
}


async function handleSnmpObjectDeadStatus(snmpObject, response, cycleId) {
  if (!snmpObject.ip_address) {
    console.log('[SNMP] handleSnmpObjectDeadStatus: ip_address is undefined', { cycleId, snmpObject })
    return
  }
  try {
    const foundIndexDead = deadsnmpObjectIP.findIndex(item => (item.ip_address === snmpObject.ip_address && item.oid === snmpObject.oid))
    const loadStatus = snmpObject.status.toLowerCase()
    if (loadStatus === Status.ALIVE) {
      console.log('[SNMP] handleStatusChange ALIVE->DEAD', { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
      await handleStatusChange({ ip_address: snmpObject, removeFromList: alivesnmpObjectIP, addToList: deadsnmpObjectIP, fromStatus: Status.ALIVE, toStatus: Status.DEAD, service: true, response, cycleId })
    } else {
      let prevValue = ''
      if (foundIndexDead !== -1) prevValue = deadsnmpObjectIP[foundIndexDead].lastValue
      const newValue = snmpObject.value
      function cleanVal(val) {
        return (val ?? '').toString()
          .replace(/value/gi, '')
          .replace(/Status OK/gi, '')
          .replace(/Status PROBLEM/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
      }
      const prevValueStr = cleanVal(prevValue)
      const newValueStr = cleanVal(newValue)
      const prevNum = parseFloat(prevValueStr)
      const newNum = parseFloat(newValueStr)
      const bothNumbers = !isNaN(prevNum) && !isNaN(newNum)
      const valueChanged = (bothNumbers && prevNum !== newNum) || (!bothNumbers && prevValueStr && newValueStr && prevValueStr !== newValueStr)
      if (valueChanged) {
        console.log('[SNMP] handleStatusChange DEAD->DEAD valueChanged', { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: deadsnmpObjectIP, fromStatus: Status.DEAD, toStatus: Status.DEAD, service: true, response, cycleId })
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
    console.error('[SNMP] Error in handleSnmpObjectDeadStatus', { cycleId, error: err && err.message ? err.message : err })
  }
}

async function handleSnmpObjectAliveStatus(snmpObject, response, cycleId) {
  if (!snmpObject.ip_address) {
    console.log('[SNMP] handleSnmpObjectAliveStatus: ip_address is undefined', { cycleId, snmpObject })
    return
  }
  try {
    const foundIndexAlive = alivesnmpObjectIP.findIndex(item => (item.ip_address === snmpObject.ip_address && item.oid === snmpObject.oid))
    const loadStatus = snmpObject.status.toLowerCase()
    if (loadStatus === Status.DEAD) {
      console.log('[SNMP] handleStatusChange DEAD->ALIVE', { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
      await handleStatusChange({ ip_address: snmpObject, removeFromList: deadsnmpObjectIP, addToList: alivesnmpObjectIP, fromStatus: Status.DEAD, toStatus: Status.ALIVE, service: true, response, cycleId })
    } else {
      let prevValue = ''
      if (foundIndexAlive !== -1) prevValue = alivesnmpObjectIP[foundIndexAlive].lastValue
      const newValue = snmpObject.value
      function cleanVal(val) {
        return (val ?? '').toString()
          .replace(/value/gi, '')
          .replace(/Status OK/gi, '')
          .replace(/Status PROBLEM/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
      }
      const prevValueStr = cleanVal(prevValue)
      const newValueStr = cleanVal(newValue)
      const prevNum = parseFloat(prevValueStr)
      const newNum = parseFloat(newValueStr)
      const bothNumbers = !isNaN(prevNum) && !isNaN(newNum)
      const valueChanged = (bothNumbers && prevNum !== newNum) || (!bothNumbers && prevValueStr && newValueStr && prevValueStr !== newValueStr)
      if (valueChanged) {
        console.log('[SNMP] handleStatusChange ALIVE->ALIVE valueChanged', { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: alivesnmpObjectIP, fromStatus: Status.ALIVE, toStatus: Status.ALIVE, service: true, response, cycleId })
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
    console.error('[SNMP] Error in handleSnmpObjectAliveStatus', { cycleId, error: err && err.message ? err.message : err })
  }
}


async function snmpGet(snmpObject, community = 'public') {
  const timeoutSec = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC) || 5
  const session = new snmp.Session({ host: snmpObject.ip_address, community: community, timeout: timeoutSec * 1000 })

  try {
    const varbinds = await new Promise((resolve, reject) => {
      session.get({ oid: snmpObject.oid }, (error, varbinds) => {
        session.close()
        const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
        if (error) {
          if (error.message && error.message.toLowerCase().includes('timeout')) {
            console.error(`${formattedDate} [ERROR] Timeout for SNMP get ${snmpObject.ip_address} ${snmpObject.oid}`)
          } else {
            console.error(`${formattedDate} Error:`, error.message || error)
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
    const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
    if (error.message && error.message.toLowerCase().includes('timeout')) {
      console.error(`${formattedDate} [ERROR] Timeout for SNMP get ${snmpObject.ip_address} ${snmpObject.oid}`)
    } else {
      console.error(`${formattedDate} Error:`, error.message || error)
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
          .trim()
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