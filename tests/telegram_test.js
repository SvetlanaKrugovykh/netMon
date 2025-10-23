const axios = require('axios')
require('dotenv').config()

async function testTelegramMessage() {
  console.log('=== TELEGRAM BOT TEST ===')

  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  const TELEGRAM_EXCEPTION_ID_WODA = process.env.TELEGRAM_EXCEPTION_ID_WODA

  console.log('Environment variables:')
  console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET')
  console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID ? 'SET' : 'NOT SET')
  console.log('TELEGRAM_EXCEPTION_ID_WODA:', TELEGRAM_EXCEPTION_ID_WODA ? 'SET' : 'NOT SET')
  console.log('')

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('--- Testing Main Bot ---')
    await testBot(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, 'Main Bot Test Message 🤖')
  } else {
    console.log('❌ Main bot credentials missing')
  }

  console.log('')

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_EXCEPTION_ID_WODA) {
    console.log('--- Testing Silver Bot (Exception) ---')

    const chatIds = [
      TELEGRAM_EXCEPTION_ID_WODA,           // -4540333614
      parseInt(TELEGRAM_EXCEPTION_ID_WODA), // -4540333614 как число
      TELEGRAM_EXCEPTION_ID_WODA.toString(), // -4540333614 как строка
      Math.abs(parseInt(TELEGRAM_EXCEPTION_ID_WODA)), // 4540333614 без минуса
    ]

    for (let i = 0; i < chatIds.length; i++) {
      console.log(`\n--- Attempt ${i + 1}: Chat ID = ${chatIds[i]} ---`)
      await testBot(TELEGRAM_BOT_TOKEN, chatIds[i], `WODA Test ${i + 1} 🚨`)
      await new Promise(resolve => setTimeout(resolve, 1000)) // Пауза между попытками
    }
  } else {
    console.log('❌ Silver bot credentials missing')
  }
}

async function testBot(botToken, chatId, message) {
  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`

  console.log(`Bot Token: ${botToken.substring(0, 10)}...`)
  console.log(`Chat ID: ${chatId}`)
  console.log(`Message: ${message}`)
  console.log(`API URL: ${apiUrl}`)

  try {
    const response = await axios({
      method: 'post',
      url: apiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        chat_id: chatId,
        text: message,
      },
      timeout: 10000
    })

    console.log('✅ SUCCESS')
    console.log('Status:', response.status)
    console.log('Response data:', JSON.stringify(response.data, null, 2))

    if (response.data.ok) {
      console.log('🎉 Message sent successfully!')
    } else {
      console.log('❌ Telegram API returned error:', response.data.description)
    }

  } catch (error) {
    console.log('❌ ERROR')
    if (error.response) {
      console.log('Status:', error.response.status)
      console.log('Status Text:', error.response.statusText)
      console.log('Response data:', JSON.stringify(error.response.data, null, 2))

      if (error.response.data.description) {
        console.log('Telegram Error:', error.response.data.description)

        if (error.response.data.description.includes('chat not found')) {
          console.log('💡 Solution: Check if chat ID is correct and bot is added to the chat')
        } else if (error.response.data.description.includes('bot was blocked')) {
          console.log('💡 Solution: Unblock the bot in Telegram')
        } else if (error.response.data.description.includes('not enough rights')) {
          console.log('💡 Solution: Give the bot admin rights or permission to send messages')
        }
      }
    } else {
      console.log('Network Error:', error.message)
    }
  }

  console.log('---')
}

testTelegramMessage().catch(error => {
  console.error('Test failed:', error)
  process.exit(1)
})