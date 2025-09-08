//#region  status handlers
const { sendReqToDB, sendToChat } = require('./to_local_DB.js')

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const telegramChatId = process.env.TELEGRAM_CHAT_ID

async function handleStatusChange(args) {
  const {
    ip_address,
    removeFromList,
    addToList,
    fromStatus,
    toStatus,
    service = false,
    response = ''
  } = args

  const foundIndex = removeFromList.findIndex(item => {
    const isMatchingIp = item.ip_address === ip_address.ip_address
    const isMatchingOid = ip_address.oid && item.oid === ip_address.oid.toString()
    const isMatchingPort = ip_address.Port && item.Port === ip_address.Port.toString()

    return (isMatchingIp && (isMatchingOid || isMatchingPort)) || (!ip_address.oid && !ip_address.Port && isMatchingIp)
  })

  if (foundIndex !== -1) {
    removeFromList.splice(foundIndex, 1)
  }

  const existingIndex = addToList.findIndex(item => {
    const isMatchingIp = item.ip_address === ip_address.ip_address
    const isMatchingOid = ip_address.oid && item.oid === ip_address.oid.toString()
    const isMatchingPort = ip_address.Port && item.Port === ip_address.Port.toString()

    return (isMatchingIp && (isMatchingOid || isMatchingPort)) || (!ip_address.oid && !ip_address.Port && isMatchingIp)
  })


  console.log(`${new Date().toISOString()}:handleStatusChange: removeFromList, addToList, ${removeFromList.length}, ${addToList.length} service = ${service}`)

  if (existingIndex !== -1) {
    addToList[existingIndex].count++
    ip_address.status = toStatus
    return
  } else {
    addToList.push({
      ip_address: ip_address?.ip_address,
      Port: ip_address?.Port || '',
      oid: ip_address?.oid || '',
      count: 1,
    })
    ip_address.status = toStatus
  }

  let resource = ''
  let msg = ''
  if (service === true) {
    if (ip_address.Port === undefined) {
      resource = `Snmp oid:${ip_address.oid}<=>${ip_address.value}`
    } else {
      resource = `Service Port:${ip_address.Port}`
    }
  } else {
    resource = 'Host'
  }

  if (response === '') {
    msg = `${resource} ${ip_address.ip_address} (${ip_address.description}) ⇆ from ${fromStatus} to ${toStatus}`
    sendReqToDB('__SaveStatusChangeToDb__', `${ip_address.ip_address}#${fromStatus}#${toStatus}#${service}#`, '')
  } else {
    msg = `${resource} ${ip_address.ip_address} (${ip_address.description}) ⇆ from ${fromStatus} to ${toStatus}\n${response}`
    sendReqToDB('__SaveStatusChangeToDb__', `${ip_address.ip_address}#${fromStatus}#${toStatus}#${service}#${ip_address.oid}#${response}#`, '')
  }
  msg = msg.replace("Port:undefined", "snmp")
  sendTelegramMessage(msg)
}
//#endregion


//#region  send message to telegram
async function sendTelegramMessage(message) {
  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`

  try {
    let modifiedText = message.replace("alive", "✅")
    modifiedText = modifiedText.replace("dead", "❌")
    modifiedText = modifiedText.replace("Warning", "⚠️")
    modifiedText = modifiedText.replace("Info", "ℹ️")
    await sendTelegramMessageToExceptionWoda(message)
    const response = await sendToChat(apiUrl, telegramBotToken, telegramChatId, modifiedText)
    if (!response) {
      console.log('Error sending Telegram message.')
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error)
  }
}

async function sendTelegramMessageToExceptionWoda(message) {
  try {
    if (!message.includes('WODA') && !message.includes('GARAZH') && !message.includes('VLans874')) {
      return
    }

  } catch (error) {
    console.error('Error message.includes(EXCEPTION_Msgs)', error)
    return
  }

  const EXCEPTION_ID_WODA = process.env.TELEGRAM_EXCEPTION_ID_WODA
  const telegramBotTokenSilver = process.env.TELEGRAM_BOT_TOKEN_SILVER
  const apiUrl = `https://api.telegram.org/bot${telegramBotTokenSilver}/sendMessage`

  try {
    let modifiedText = message.replace("alive", "✅")
    modifiedText = modifiedText.replace("dead", "❌")
    const response = await sendToChat(apiUrl, telegramBotTokenSilver, EXCEPTION_ID_WODA, modifiedText)
    if (!response) {
      console.log('Error sending Telegram message.')
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error)
  }
}

//#endregion

module.exports = { handleStatusChange, sendTelegramMessage }