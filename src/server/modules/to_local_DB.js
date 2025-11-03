const axios = require(`axios`)
const USUAL_URL = process.env.URL
const LOG_URL = process.env.LOG_URL
const AUTH_TOKEN = process.env.AUTH_TOKEN

async function sendReqToDB(reqType, data, _text) {

  let dataString = JSON.stringify(data)
  const URL = (reqType === '__traffic__' || reqType === '__mrtg__') ? LOG_URL : USUAL_URL

  // Log only important requests, skip frequent traffic/mrtg
  const shouldLog = reqType !== '__traffic__' && reqType !== '__mrtg__'

  try {
    if (shouldLog) {
      console.log(`[sendReqToDB] ${reqType}`)
    }

    const response = await axios({
      method: 'post',
      url: URL,
      responseType: 'string',
      headers: {
        Authorization: `${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      data: {
        Query: `Execute;${reqType};${dataString};КОНЕЦ`,
      }
    })

    if (response.status !== 200) {
      console.error(`[sendReqToDB] ${reqType} - HTTP ${response.status}`)
      return null
    }

    if (reqType === '__GetClientPersData__' || reqType === '__GetIpAddressesForWatching__') {
      return response.data
    } else {
      let answer = response.data.toString()
      return answer
    }

  } catch (err) {
    console.error(`[sendReqToDB] ${reqType} ERROR: ${err.message}`)
    if (err.code) console.error(`[sendReqToDB] Code: ${err.code}`)
    if (err.response) {
      console.error(`[sendReqToDB] Server response: HTTP ${err.response.status}`)
      if (err.response.data) {
        const preview = typeof err.response.data === 'string'
          ? err.response.data.substring(0, 200)
          : JSON.stringify(err.response.data).substring(0, 200)
        console.error(`[sendReqToDB] Error details: ${preview}`)
      }
    }
    return null
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function sendToChat(url_address, token, chatId, message) {
  try {
    await delay(1000)
    const response = await axios({
      method: 'post',
      url: url_address,
      responseType: 'string',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      data: {
        chat_id: chatId,
        text: message,
      },
    })
    if (response.status !== 200) {
      return null
    } else {
      let answer = response.data.toString()
      return answer
    }

  } catch (err) {
    console.log(err)
    return null
  }
}


module.exports = { sendReqToDB, sendToChat }
