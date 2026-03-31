# Scheduling

PAS supports two types of scheduled tasks:

## Cron Jobs

Apps can declare recurring scheduled jobs using cron expressions. These run automatically at the specified times. Examples:
- Daily summaries at 8 AM
- Weekly reports every Monday
- Periodic data cleanup

Cron jobs are declared in the app's manifest and run automatically once the app is enabled.

## One-Off Tasks

Apps can also schedule one-time tasks for a specific future time. These are useful for reminders, delayed actions, or time-based follow-ups.

## Job Failure Handling

If a scheduled job fails repeatedly, PAS automatically:
1. Notifies you via Telegram about the failure
2. Disables the job after too many consecutive failures
3. Logs the error for the administrator to investigate
