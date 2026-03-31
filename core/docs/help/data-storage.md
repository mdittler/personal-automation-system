# Data Storage

PAS stores all data as markdown files on the filesystem. There is no database.

## User Data

Each user has their own data directory. Apps can only access data within their declared scopes. For example, the chatbot app stores your conversation history in your personal data area.

## Shared Data

Some apps store data that's shared across all users, like shared grocery lists or household settings.

## Daily Notes

Messages that reach the fallback handler are saved as daily notes in markdown format, organized by date. The chatbot also saves messages to daily notes as a side effect.

## Data Privacy

- Your data stays local on the PAS server
- Apps can only access data scopes they declared in their manifest
- No data is sent to external services unless an app explicitly declares it
