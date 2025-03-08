# Scrapyard Leaderboard Bot

A Slack bot that posts leaderboards for Scrapyard events showing the events with the most new sign-ups and celebrates registration milestones.

> **Note:** This bot was written with assistance from AI.

## Features

- Posts a leaderboard in the configured Slack channel at 8am ET and 8pm ET daily
- Responds to the `/scrapyard-leaderboard` slash command with an ephemeral message showing the latest leaderboard
- Tracks event registration milestones and posts celebratory messages when events hit significant registration numbers
- Checks for milestones every 15 minutes
- Tracks ALL events, not just those with recent activity

## Setup

1. Clone this repository
2. Copy `.env.example` to `.env` and fill in your credentials
3. Install dependencies with `bun install`
4. Start the bot with `bun start`

## Docker Compose Development Setup

For local development, you can use Docker Compose to spin up a PostgreSQL database:

```bash
docker-compose up -d
```

This will create a PostgreSQL 16 database accessible at `postgres://scrapyard_user:scrapyard_password@localhost:5432/scrapyard_milestones`

## Configuration

The following environment variables need to be set in the `.env` file:

- `WAREHOUSE_DB_URL`: PostgreSQL database connection URL for the data warehouse
- `MILESTONE_DB_URL`: PostgreSQL database connection URL for storing milestone tracking data
- `SLACK_BOT_TOKEN`: Bot token starting with `xoxb-`
- `SLACK_SIGNING_SECRET`: Signing secret for your Slack app
- `SLACK_APP_TOKEN`: App-level token starting with `xapp-` (for Socket Mode)
- `SLACK_CHANNEL`: The channel where the leaderboard will be posted (specified as a Slack channel ID like "C0864GFN63X")

## Milestone Tracking

The bot tracks registration milestones for all events:

- When an event is first discovered, it's added to the tracking database without posting a message
- For events with < 50 registrations: Milestone messages are sent at every multiple of 10 (10, 20, 30, 40)
- For events with ≥ 50 registrations: Milestone messages are sent at multiples of 20 (60, 80, 100, etc.)
- For larger events (≥ 50 registrations), a new milestone is only announced if it represents at least a 20% increase from the last milestone
- The system keeps track of the last known registration count for each event
- Milestone messages are only posted when an event crosses a new milestone threshold

## Slack App Configuration

1. Create a new Slack app at https://api.slack.com/apps
2. Add the following bot token scopes:
   - `chat:write`
   - `commands`
3. Create a slash command `/scrapyard-leaderboard`
4. Install the app to your workspace
5. Enable Socket Mode and generate an app-level token with `connections:write` scope

## Development

Run the bot in development mode with auto-reload:

```
bun dev
``` 

## AI Attribution

This bot was primarily developed with the assistance of AI technology. The codebase, including the leaderboard logic, Slack integration, and Docker configuration, was generated with the help of Claude 3.7 Sonnet by Anthropic. Human oversight and modifications were applied to ensure functionality and security. 