# Commands and Message Routing

## Slash Commands

Commands start with `/` and are routed directly to the app that declared them. For example, `/echo hello` sends the message to the Echo app.

Each app declares its commands in its manifest. Use `/help` to see all available commands.

Commands may accept arguments. For example: `/echo <message>` takes a message argument.

## Intent-Based Routing

When you send a regular text message (not a command), PAS uses AI classification to determine which app should handle it. Apps declare keywords and phrases called "intents" that describe what they handle.

For example, if an app declares intents like "reminder" and "schedule", sending "remind me to buy milk" would route to that app.

## Photo Routing

When you send a photo, PAS classifies it by type and routes to the app that handles that photo category. The photo's caption (if any) helps with classification.

## Fallback Behavior

If no app matches your message, PAS has a configurable fallback:
- **Chatbot mode** (default): A general-purpose AI assistant responds to your message
- **Notes mode**: Your message is saved to daily notes for later review
