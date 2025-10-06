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
      if (snmpObject.oid === '.1.3.6.1.4.1.171.12.72.2.1.1.1.6.26') {
        console.log('[DEBUG][CONTROL_OID] Going to handleSnmpObjectAliveStatus - Status OK detected')
      }
      handleSnmpObjectAliveStatus(snmpObject, response, cycleId)
    } else {
      if (snmpObject.oid === '.1.3.6.1.4.1.171.12.72.2.1.1.1.6.26') {
        console.log('[DEBUG][CONTROL_OID] Going to handleSnmpObjectDeadStatus - Status PROBLEM detected', { response })
      }
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
      if (foundIndexDead !== -1) {
        prevValue = deadsnmpObjectIP[foundIndexDead].lastValue
      } else {
        // If not found in deadsnmpObjectIP, use lastValue from snmpObject (from DB)
        prevValue = snmpObject.lastValue || ''
      }

      if (snmpObject.oid === '1.3.6.1.4.1.171.12.72.2.1.1.1.6.26') {
        console.log('[DEBUG][CONTROL_OID] prevValue source:', {
          oid: snmpObject.oid,
          foundIndexDead,
          snmpObjectLastValue: snmpObject.lastValue,
          deadListLastValue: foundIndexDead !== -1 ? deadsnmpObjectIP[foundIndexDead].lastValue : 'N/A',
          finalPrevValue: prevValue
        })
      }

      const newValue = response
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
      if (snmpObject.oid === '1.3.6.1.4.1.171.12.72.2.1.1.1.6.26') {
        console.log('[DEBUG][CONTROL_OID] Before sendReqToDB check:', {
          oid: snmpObject.oid,
          prevValue: prevValueStr,
          newValue: newValueStr,
          valueChanged,
          prevNum,
          newNum,
          bothNumbers
        })
      }
      if (valueChanged) {
        console.log('[SNMP] handleStatusChange DEAD->DEAD valueChanged', { cycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
        if (snmpObject.oid === '1.3.6.1.4.1.171.12.72.2.1.1.1.6.26') {
          console.log('[DEBUG][CONTROL_OID] About to call sendReqToDB for:', snmpObject.oid)
        }
        await sendReqToDB('__UpdateSnmpObjectValue__', JSON.stringify({
          ip_address: snmpObject.ip_address,
          oid: snmpObject.oid,
          value: newValueStr,
          status: 'dead',
          timestamp: new Date().toISOString()
        }), '')
        snmpObject.lastValue = newValueStr
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: deadsnmpObjectIP, fromStatus: Status.DEAD, toStatus: Status.DEAD, service: true, response, cycleId })
      }
      if (foundIndexDead === -1) {
        deadsnmpObjectIP.push({ ip_address: snmpObject.ip_address, oid: snmpObject.oid, count: 1, lastValue: newValueStr })
      } else {
        deadsnmpObjectIP[foundIndexDead].count++
        deadsnmpObjectIP[foundIndexDead].lastValue = newValueStr
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
      const newValue = response
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
        await sendReqToDB('__UpdateSnmpObjectValue__', JSON.stringify({
          ip_address: snmpObject.ip_address,
          oid: snmpObject.oid,
          value: newValueStr,
          status: 'alive',
          timestamp: new Date().toISOString()
        }), '')
        // Update lastValue in snmpObject for next cycle
        snmpObject.lastValue = newValueStr
        await handleStatusChange({ ip_address: snmpObject, removeFromList: [], addToList: alivesnmpObjectIP, fromStatus: Status.ALIVE, toStatus: Status.ALIVE, service: true, response, cycleId })
      }
      if (foundIndexAlive === -1) {
        alivesnmpObjectIP.push({ ip_address: snmpObject.ip_address, oid: snmpObject.oid, count: 1, lastValue: newValueStr })
      } else {
        alivesnmpObjectIP[foundIndexAlive].count++
        alivesnmpObjectIP[foundIndexAlive].lastValue = newValueStr
      }
      snmpObject.status = Status.ALIVE
    }
  } catch (err) {
    console.error('[SNMP] Error in handleSnmpObjectAliveStatus', { cycleId, error: err && err.message ? err.message : err })
  }
}


async function snmpGet(snmpObject, community = 'public') {
  const timeoutSec = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC) || 5
  const maxAttempts = parseInt(process.env.SNMP_GET_RETRIES) || 2
  const startOverall = Date.now()
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    console.log('[SNMP][snmpGet] Attempt', { attempt, maxAttempts, ip: snmpObject.ip_address, oid: snmpObject.oid, timeoutSec, community, expectedValue: snmpObject.value, lastValue: snmpObject.lastValue, min: snmpObject.min, max: snmpObject.max })
    const session = new snmp.Session({ host: snmpObject.ip_address, community: community, timeout: timeoutSec * 1000 })
    try {
      const varbinds = await new Promise((resolve, reject) => {
        session.get({ oid: snmpObject.oid }, (error, varbinds) => {
          session.close()
          const elapsedAttemptMs = Date.now() - attemptStart
          if (error) {
            if (error.message && error.message.toLowerCase().includes('timeout')) {
              console.error('[SNMP][snmpGet] Timeout', {
                ip: snmpObject.ip_address,
                oid: snmpObject.oid,
                timeoutSec,
                attempt,
                maxAttempts,
                elapsedAttemptMs,
                totalElapsedMs: Date.now() - startOverall,
                startedAt: new Date(attemptStart).toISOString(),
                finishedAt: new Date().toISOString(),
                expectedValue: snmpObject.value,
                lastValue: snmpObject.lastValue,
                minExpected: snmpObject.min,
                maxExpected: snmpObject.max
              })
            } else {
              console.error('[SNMP][snmpGet] Error', {
                ip: snmpObject.ip_address,
                oid: snmpObject.oid,
                error: error.message || error,
                attempt,
                elapsedAttemptMs
              })
            }
            reject(error)
          } else {
            resolve(varbinds)
          }
        })
      })
      if (varbinds.length > 0) {
        const parsed = snmpAnswersAnalizer(snmpObject, varbinds)
        const totalElapsedMs = Date.now() - startOverall
        console.log('[SNMP][snmpGet] Success', { ip: snmpObject.ip_address, oid: snmpObject.oid, attempt, totalElapsedMs, result: parsed })
        return parsed
      } else {
        throw new Error('No response received')
      }
    } catch (error) {
      lastError = error
      // If timeout and not last attempt -> small delay before retry to mitigate ARP/cache issues
      if (attempt < maxAttempts && error.message && error.message.toLowerCase().includes('timeout')) {
        const backoffMs = 200
        await new Promise(r => setTimeout(r, backoffMs))
        continue
      }
      const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
      if (error.message && error.message.toLowerCase().includes('timeout')) {
        console.error(`${formattedDate} [ERROR] Timeout for SNMP get ${snmpObject.ip_address} ${snmpObject.oid} (attempts=${attempt}/${maxAttempts}) totalElapsedMs=${Date.now() - startOverall}`)
        console.error('[SNMP][snmpGet] TimeoutDetails', {
          ip: snmpObject.ip_address,
          oid: snmpObject.oid,
          expectedValue: snmpObject.value,
          lastValue: snmpObject.lastValue,
          min: snmpObject.min,
          max: snmpObject.max,
          timeoutSec,
          attempts: `${attempt}/${maxAttempts}`
        })
      } else {
        console.error(`${formattedDate} Error:`, error.message || error)
      }
      if (attempt === maxAttempts) {
        throw error
      }
    }
  }
  throw lastError || new Error('Unknown SNMP get error')
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

      console.log('[DEBUG][loadSnmpObjectsList] Processing object:', {
        oid: obj.oid,
        ip: obj.ip_address,
        description: obj.description,
        rawLastValue,
        rawLastValueType: typeof rawLastValue,
        objValue: obj.value,
        objLastValue: obj.lastValue
      })

      if (typeof rawLastValue === 'string') {
        // Remove 'value', 'Status OK', 'Status PROBLEM', and extra spaces
        parsedLastValue = rawLastValue
          .replace(/value/gi, '')
          .replace(/Status OK/gi, '')
          .replace(/Status PROBLEM/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
        // Try to extract the number if present - improved regex for decimal numbers
        const match = parsedLastValue.match(/-?\d+(?:\.\d+)?/)
        parsedLastValue = match ? match[0] : parsedLastValue
      } else if (typeof rawLastValue === 'number') {
        parsedLastValue = rawLastValue.toString()
      }

      console.log('[DEBUG][loadSnmpObjectsList] Processed result:', {
        oid: obj.oid,
        ip: obj.ip_address,
        parsedLastValue,
        finalValue: obj.value
      })

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