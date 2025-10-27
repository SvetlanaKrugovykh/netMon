const axios = require('axios')
require('dotenv').config()

async function getChatIdFromGroup() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

  console.log('=== GET REAL CHAT ID ===')
  console.log('')
  console.log('📝 INSTRUCTIONS:')
  console.log('1. Go to your NEW group')
  console.log('2. Send this message: @NetNotifySilverBot /get_chat_id')
  console.log('3. Press Enter here...')

  await new Promise(resolve => {
    process.stdin.once('data', () => resolve())
  })

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    )

    if (response.data.ok && response.data.result.length > 0) {
      console.log('')
      console.log('🔍 SEARCHING FOR YOUR GROUP...')
      console.log('')

      const groupMessages = response.data.result
        .filter(update =>
          update.message &&
          (update.message.chat.type === 'group' ||
          update.message.chat.type === 'supergroup')
        )
        .slice(-10)

      if (groupMessages.length > 0) {
        console.log('📊 FOUND GROUPS:')
        console.log('')

        groupMessages.forEach((update, index) => {
          const chat = update.message.chat
          console.log(`Group ${index + 1}:`)
          console.log(`  Bot API Chat ID: ${chat.id}`)
          console.log(`  Title: ${chat.title}`)
          console.log(`  Type: ${chat.type}`)
          console.log(`  Message: ${update.message.text || '[media]'}`)
          console.log('  ---')
        })

        const uniqueChatIds = [...new Set(groupMessages.map(m => m.message.chat.id))]
        console.log('')
        console.log('🎯 USE THESE CHAT IDs:')
        uniqueChatIds.forEach(id => console.log(`  ${id}`))

      } else {
        console.log('❌ No group messages found')
        console.log('Make sure to mention the bot in group!')
      }

    } else {
      console.log('❌ No updates found')
    }

  } catch (error) {
    console.error('❌ Error:', error.message)
  }
}

getChatIdFromGroup()