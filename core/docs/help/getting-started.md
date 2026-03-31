# Getting Started with PAS

PAS (Personal Automation System) is a home automation platform you interact with through Telegram.

## How to Use PAS

- **Send a message** in Telegram to interact with your installed apps
- **Use /commands** for specific actions (e.g., `/echo hello`)
- **Type /help** to see all available commands
- **Type /ask** followed by a question to get help from the PAS assistant

## How Messages Are Handled

1. If your message starts with `/command`, it goes directly to the app that owns that command
2. If you send a photo, PAS classifies it and routes to the right app
3. For regular text, PAS uses AI to figure out which app should handle it
4. If no app matches, the chatbot responds as a general-purpose AI assistant

## Managing Your Apps

Your system administrator can enable or disable apps for you through the management GUI. You can ask `/ask what apps do I have?` to see what's available.
