require('dotenv').config()
const { sendReqToDB } = require('../modules/to_local_DB.js')
const { handleStatusChange, sendTelegramMessage } = require('../modules/watchHandler.js')

const Status = {
  ALIVE: 'alive',
  DEAD: 'dead'
}

const aliveIP = []
const deadIP = []

const { runCommand } = require('../utils/runCommand')

function transformPingResult(stdout, ip_address, sourceIp) {
  const formattedDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let isAlive = stdout.includes('1 received')
  if (isAlive) {
    return `${formattedDate} Host at ${ip_address.ip_address} is alive (source IP: ${sourceIp})`
  } else {
    return `${formattedDate} Host at ${ip_address.ip_address} is not alive (source IP: ${sourceIp})`
  }
}

function netWatchPingerProbe(ip_address) {
  try {
    let failedAttempts = 0
    const sourceIp = process.env.PING_SOURCE_IP || '91.220.106.2'

    const probeHost = function () {
      return new Promise((resolve, reject) => {
        const command = 'ping'
        const args = ['-c', '1', '-I', sourceIp, ip_address.ip_address]
        runCommand(command, args)
          .then(result => {
            let resultMsg = transformPingResult(result.stdout, ip_address, sourceIp)
            if (result.stdout.includes('1 received')) {
              handleAliveStatus(ip_address)
              resolve()
            } else {
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
          .catch(err => {
            console.error(err)
            reject(err)
          })
      })
    }

    probeHost().catch(err => {
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
    const pingCount = 50
    const sourceIp = process.env.PING_SOURCE_IP || '91.220.106.2'

    ipAddresses.forEach(ip => {
      failedAttempts[ip] = {
        totalPings: 0,
        lostPings: 0,
        rttSum: 0
      }
    })

    const probeHostWithDelay = async function (ip_address) {
      let completedPings = 0
      let lostPings = 0
      let rttSum = 0

      for (let i = 0; i < pingCount; i++) {
        const command = 'ping'
        const args = ['-c', '1', '-I', sourceIp, ip_address]
        try {
          const result = await runCommand(command, args)
          const stdout = result.stdout
          const match = stdout.match(/time=([0-9.]+) ms/)
          if (stdout.includes('1 received')) {
            rttSum += match ? parseFloat(match[1]) : 0
          } else {
            lostPings++
          }
        } catch (err) {
          lostPings++
        }
        completedPings++
      }

      failedAttempts[ip_address].totalPings = completedPings
      failedAttempts[ip_address].lostPings = lostPings
      failedAttempts[ip_address].rttSum = rttSum

      const lossPercentage = lostPings / pingCount
      if (lossPercentage > lossThreshold) {
        handlePacketLoss(ip_address, lossPercentage)
      } else {
        handleNormalDelay(ip_address, rttSum / (completedPings - lostPings))
      }
    }

    const promises = ipAddresses.map(ip => probeHostWithDelay(ip))
    await Promise.all(promises)
  } catch (err) {
    console.log(err)
  }
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