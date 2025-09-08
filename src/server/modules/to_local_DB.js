const axios = require(`axios`)
const USUAL_URL = process.env.URL
const LOG_URL = process.env.LOG_URL
const AUTH_TOKEN = process.env.AUTH_TOKEN

async function sendReqToDB(reqType, data, _text) {

  let dataString = JSON.stringify(data)
  const URL = (reqType === '__traffic__' || reqType === '__mrtg__') ? LOG_URL : USUAL_URL

  try {
    const response = await axios({
      method: 'post',
      url: URL,
      responseType: 'string',
      headers: {
        Authorization: `${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        Query: `Execute;${reqType};${dataString};КОНЕЦ`,
      }
    });
    if (!response.status == 200) {
      return null
    }

    if (reqType === '__GetClientPersData__' || reqType === '__GetIpAddressesForWatching__') {
      return response.data
    } else {
      let answer = response.data.toString()
      return answer;
    }

  } catch (err) {
    console.log(err)
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
    if (!response.status == 200) {
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
