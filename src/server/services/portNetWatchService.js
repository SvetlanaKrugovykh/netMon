const net = require('net')
const { sendReqToDB } = require('../modules/to_local_DB.js')
const { handleStatusChange } = require('../modules/watchHandler.js')

const Status = {
  ALIVE: 'alive',
  DEAD: 'dead'
}

const aliveServiceIP = []
const deadServiceIP = []

function checkServiceStatus(service) {
  const client = new net.Socket()
  const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)

  try {
    client.connect(Number(service.Port), service.ip_address.trim(), () => {
      handleServiceAliveStatus(service)
      client.end()
    })

    client.on('error', () => {
      console.log(`${formattedDate} Service at ${service.ip_address.trim()}:${service.Port} is not alive`)
      handleServiceDeadStatus(service)
    })
  } catch (err) {
    console.error('Error in checkServiceStatus:', err)
  }
}

async function handleServiceDeadStatus(service) {
  try {
    if (!service.ip_address) {
      console.log('handleServiceAliveStatus: service.ip_address is undefined', service)
      return
    }
    const foundIndexDead = deadServiceIP.findIndex(item => (item.ip_address === service.ip_address && item.Port === service.Port))

    const loadStatus = service.status.toLowerCase()
    if (loadStatus === Status.ALIVE) {
      await handleStatusChange({ ip_address: service, removeFromList: aliveServiceIP, addToList: deadServiceIP, fromStatus: Status.ALIVE, toStatus: Status.DEAD, service: true })
    } else {
      if (foundIndexDead === -1) {
        deadServiceIP.push({ ip_address: service.ip_address, Port: service.Port, count: 1 })
      } else {
        deadServiceIP[foundIndexDead].count++
      }
      service.status = Status.DEAD
    }
  } catch (err) {
    console.error('Error in handleServiceDeadStatus:', err)
  }
}

async function handleServiceAliveStatus(service) {
  try {
    if (!service.ip_address) {
      console.log('handleServiceAliveStatus: service.ip_address is undefined', service)
      return
    }
    const foundIndexAlive = aliveServiceIP.findIndex(item => (item.ip_address === service.ip_address && item.Port === service.Port))
    const loadStatus = service.status.toLowerCase()

    if (loadStatus === Status.DEAD) {
      await handleStatusChange({ ip_address: service, removeFromList: deadServiceIP, addToList: aliveServiceIP, fromStatus: Status.DEAD, toStatus: Status.ALIVE, service: true })
    } else {
      if (foundIndexAlive === -1) {
        aliveServiceIP.push({ ip_address: service.ip_address, Port: service.Port, count: 1 })
      } else {
        aliveServiceIP[foundIndexAlive].count++
      }
      service.status = Status.ALIVE
    }
  } catch (err) {
    console.error('Error in handleServiceAliveStatus:', err)
  }
}

async function loadServicesList() {
  try {
    const data = await sendReqToDB('__GetServicesForWatching__', '', '')
    const parsedData = JSON.parse(data)
    const servicesList = parsedData.ResponseArray
    return servicesList
  } catch (err) {
    console.error('Error in loadServicesList:', err)
  }
}

module.exports = { checkServiceStatus, loadServicesList }
