const ping = require('ping')
const { sendReqToDB } = require('../modules/to_local_DB.js')
const { handleStatusChange, sendTelegramMessage } = require('../modules/watchHandler.js')

const Status = {
  ALIVE: 'alive',
  DEAD: 'dead'
}

const aliveIP = []
const deadIP = []

function netWatchPingerProbe(ip_address) {
  try {
    const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
    let failedAttempts = 0

    const probeHost = function () {
      return new Promise((resolve, reject) => {
        ping.sys.probe(ip_address.ip_address, function (isAlive) {
          if (isAlive) {
            handleAliveStatus(ip_address)
            resolve()
          } else {
            console.log(`${formattedDate} Host at ${ip_address.ip_address} is not alive`)
            failedAttempts++
            if (failedAttempts >= 3) {
              handleDeadStatus(ip_address)
              resolve()
            } else {
              setTimeout(() => {
                probeHost().then(resolve).catch(reject)
              }, 5000)
            }
          }
        })
      })
    }

    probeHost().catch((err) => {
      console.error(err)
    })
  } catch (err) {
    console.log(err)
  }
}

async function netWatchPingerWithDelay(ipAddresses) {
  try {
    const failedAttempts = {}
    const lossThreshold = 0.2  // 20% packet loss threshold

    ipAddresses.forEach(ip => {
      failedAttempts[ip] = {
        totalPings: 0,
        lostPings: 0,
        rttSum: 0
      }
    })

    const probeHostWithDelay = function (ip_address) {
      return new Promise((resolve, reject) => {
        const pingCount = 50

        let completedPings = 0
        let lostPings = 0
        let rttSum = 0

        const handlePingResult = (isAlive, time) => {
          completedPings++
          if (isAlive) {
            rttSum += time
          } else {
            lostPings++
          }

          if (completedPings === pingCount) {
            failedAttempts[ip_address].totalPings = completedPings
            failedAttempts[ip_address].lostPings = lostPings
            failedAttempts[ip_address].rttSum = rttSum

            const lossPercentage = lostPings / pingCount
            if (lossPercentage > lossThreshold) {
              handlePacketLoss(ip_address, lossPercentage)
            } else {
              handleNormalDelay(ip_address, rttSum / completedPings)
            }
            resolve()
          }
        }

        for (let i = 0; i < pingCount; i++) {
          ping.sys.probe(ip_address, function (isAlive, time) {
            handlePingResult(isAlive, time)
          })
        }
      })
    }

    const promises = ipAddresses.map(ip => probeHostWithDelay(ip))

    await Promise.all(promises)
  } catch (err) {
    console.log(err)
  }
}


function handlePacketLoss(ip_address, lossPercentage) {
  console.log(`Warning: High packet loss (${Math.round(lossPercentage * 100)}%) detected at ${ip_address}.`)
  sendTelegramMessage(`Warning: High packet loss (${Math.round(lossPercentage * 100)}%) detected at ${ip_address}.`)
}

function handleNormalDelay(ip_address, avgRTT) {
  // sendTelegramMessage(`Info: Host ${ip_address} has average RTT of ${Math.round(avgRTT)}ms with acceptable packet loss.`)
}



async function handleDeadStatus(ip_address) {
  try {
    const foundIndexDead = deadIP.findIndex(item => item.ip_address === ip_address.ip_address)
    const loadStatus = ip_address.status.toLowerCase()
    if (loadStatus === Status.ALIVE) {
      await handleStatusChange({ ip_address, removeFromList: aliveIP, addToList: deadIP, fromStatus: Status.ALIVE, toStatus: Status.DEAD })
    } else {
      if (foundIndexDead === -1) {
        deadIP.push({ ip_address: ip_address.ip_address, count: 1 })
      } else {
        deadIP[foundIndexDead].count++
      }
      ip_address.status = Status.DEAD
    }
  } catch (err) {
    console.error('Error in handleDeadStatus:', err)
  }
}

async function handleAliveStatus(ip_address) {
  try {
    const foundIndexAlive = aliveIP.findIndex(item => item.ip_address === ip_address.ip_address)
    const loadStatus = ip_address.status.toLowerCase()
    if (loadStatus === Status.DEAD) {
      await handleStatusChange({ ip_address, removeFromList: deadIP, addToList: aliveIP, fromStatus: Status.DEAD, toStatus: Status.ALIVE })
    } else {
      if (foundIndexAlive === -1) {
        aliveIP.push({ ip_address: ip_address.ip_address, count: 1 })
      } else {
        aliveIP[foundIndexAlive].count++
      }
      ip_address.status = Status.ALIVE
    }
  } catch (err) {
    console.error('Error in handleDeadStatus:', err)
  }
}

async function loadipList() {
  try {
    const data = await sendReqToDB('__GetIpAddressesForWatching__', '', '')
    if (!data) return []
    const parsedData = JSON.parse(data)
    if (!parsedData.ResponseArray) return []
    return parsedData.ResponseArray;
  } catch (err) {
    console.log(err)
    return []
  }
}

module.exports = { netWatchPingerProbe, netWatchPingerWithDelay, loadipList }