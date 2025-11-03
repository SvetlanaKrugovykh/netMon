//#region  status handlers
const { sendReqToDB, sendToChat } = require('./to_local_DB.js')

let telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
let telegramBotTokenSilver = process.env.TELEGRAM_BOT_TOKEN_SILVER
let telegramChatId = process.env.TELEGRAM_CHAT_ID

let lastTelegramSendTime = 0
const TELEGRAM_SEND_DELAY = 2000 // ms

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
    const isMatchingIp = item.ip_address === ip_address.ip_address;
    const isMatchingOid = ip_address.oid && item.oid === ip_address.oid.toString();
    const isMatchingPort = ip_address.Port && item.Port === ip_address.Port?.toString();
    const result = (isMatchingIp && (isMatchingOid || isMatchingPort)) || (!ip_address.oid && !ip_address.Port && isMatchingIp)
    return result
  });
  
  // Log only if not found and only the summary, not every iteration
  if (existingIndex === -1 && process.env.DEBUG_WATCH_HANDLER === 'true') {
    console.log('[DEBUG handleStatusChange] No match found in addToList for:', {
      ip_address: ip_address.ip_address,
      oid: ip_address.oid,
      Port: ip_address.Port,
      addToListLength: addToList.length
    })
  }


  console.log(`${new Date().toISOString()}:handleStatusChange: removeFromList, addToList, ${removeFromList.length}, ${addToList.length} service = ${service}`)

  if (existingIndex !== -1) {
    addToList[existingIndex].count++
    const prevValue = addToList[existingIndex].lastValue
    const newValue = ip_address.value  // Revert back to original
    function cleanVal(val) {
      return (val ?? '').toString()
        .replace(/value/gi, '')
        .replace(/Status OK/gi, '')
        .replace(/Status PROBLEM/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    const prevValueStr = cleanVal(prevValue);
    const newValueStr = cleanVal(newValue);
    const prevNum = parseFloat(prevValueStr);
    const newNum = parseFloat(newValueStr);
    const bothNumbers = !isNaN(prevNum) && !isNaN(newNum);

    if (
      (bothNumbers && prevNum !== newNum) ||
      (!bothNumbers && prevValueStr && newValueStr && prevValueStr !== newValueStr)
    ) {
      if (!prevValueStr || !newValueStr) {
        console.log('[DEBUG handleStatusChange] SKIP: one of values is empty after clean')
        return
      }
      console.log('[DEBUG handleStatusChange] SENDING: value changed, writing to DB and sending message');
      let resource = '';
      if (service === true) {
        if (ip_address.Port === undefined) {
          resource = `Snmp oid:${ip_address.oid}<=>${ip_address.value}`;
        } else {
          resource = `Service Port:${ip_address.Port}`;
        }
      } else {
        resource = 'Host';
      }
      let msg = `${resource} ${ip_address.ip_address} (${ip_address.description}) ⇆ from ${fromStatus} to ${toStatus}\n${response}`;
      sendReqToDB('__SaveStatusChangeToDb__', `${ip_address.ip_address}#${fromStatus}#${toStatus}#${service}#${ip_address.oid}#${response}#`, '');
      addToList[existingIndex].lastValue = newValue;
    }
    ip_address.status = toStatus
    return
  } else {
    addToList.push({
      ip_address: ip_address?.ip_address,
      Port: ip_address?.Port || '',
      oid: ip_address?.oid || '',
      count: 1,
      lastValue: ip_address.value  // Revert back to original
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
  const now = Date.now()
  const waitTime = lastTelegramSendTime + TELEGRAM_SEND_DELAY - now
  if (waitTime > 0) {
    console.log(`[TELEGRAM] Waiting ${waitTime}ms before sending message`)
    await sleep(waitTime)
  }
  try {
    let modifiedText = message.replace("alive", "✅")
    modifiedText = modifiedText.replace("dead", "❌")
    modifiedText = modifiedText.replace("Warning", "⚠️")
    modifiedText = modifiedText.replace("Info", "ℹ️")
    console.log('[TELEGRAM] Sending message:', modifiedText)
    await sendTelegramMessageToExceptionWoda(message)
    const response = await sendToChat(apiUrl, telegramBotToken, telegramChatId, modifiedText)
    lastTelegramSendTime = Date.now()
    if (!response) {
      console.log('[TELEGRAM] Error sending Telegram message.')
    } else {
      console.log('[TELEGRAM] Message sent successfully')
    }
  } catch (error) {
    console.error('[TELEGRAM] Error sending Telegram message:', error?.message || error)
  }
}

async function sendTelegramMessageToExceptionWoda(message) {
  try {
    if (!message.includes('WODA') && !message.includes('GARAZH') && !message.includes('VLans874')) {
      console.log('[TELEGRAM] EXCEPTION: Message does not contain trigger words, skipping')
      return
    }
  } catch (error) {
    console.error('[TELEGRAM] Error message.includes(EXCEPTION_Msgs)', error)
    return
  }

  const EXCEPTION_ID_WODA = process.env.TELEGRAM_EXCEPTION_ID_WODA
  await sleep(2000)

  if (!EXCEPTION_ID_WODA || !telegramBotTokenSilver) {
    console.error('[TELEGRAM] EXCEPTION: Missing env variables - EXCEPTION_ID_WODA or TELEGRAM_BOT_TOKEN_SILVER')
    return
  }

  const apiUrl = `https://api.telegram.org/bot${telegramBotTokenSilver}/sendMessage`

  try {
    console.log('[TELEGRAM] EXCEPTION: Waiting 2 seconds before sending...')
    await sleep(2000)

    let modifiedText = message.replace("alive", "✅")
    modifiedText = modifiedText.replace("dead", "❌")
    console.log('[TELEGRAM] EXCEPTION: Sending message:', modifiedText)
    console.log('[TELEGRAM] EXCEPTION: To chat ID:', EXCEPTION_ID_WODA)

    console.log('[TELEGRAM] EXCEPTION: Calling sendToChat with:', {
      apiUrl: apiUrl,
      chatId: EXCEPTION_ID_WODA,
      messageLength: modifiedText.length
    })

    const response = await sendToChat(apiUrl, telegramBotTokenSilver, EXCEPTION_ID_WODA, modifiedText)
    console.log('[TELEGRAM] EXCEPTION: sendToChat response:', response)

    if (!response) {
      console.log('[TELEGRAM] EXCEPTION: Error sending Telegram message.')
    } else {
      console.log('[TELEGRAM] EXCEPTION: Message sent successfully')
    }
  } catch (error) {
    console.error('[TELEGRAM] EXCEPTION: Error sending Telegram message:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      statusText: error.response?.statusText,
      stack: error.stack
    })
  }
}

module.exports = { handleStatusChange, sendTelegramMessage }