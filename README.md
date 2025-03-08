# Scrapyard Leaderboard Bot

A Slack bot that posts leaderboards for Scrapyard events showing the events with the most new sign-ups.

## Features

- Posts a leaderboard in the configured Slack channel at 8am ET and 8pm ET daily
- Responds to the `/scrapyard-leaderboard` slash command with an ephemeral message showing the latest leaderboard

## Setup

1. Clone this repository
2. Copy `.env.example` to `.env` and fill in your credentials
3. Install dependencies with `bun install`
4. Start the bot with `bun start`

## Configuration

The following environment variables need to be set in the `.env` file:

- `WAREHOUSE_DB_URL`: PostgreSQL database connection URL
- `SLACK_BOT_TOKEN`: Bot token starting with `xoxb-`
- `SLACK_SIGNING_SECRET`: Signing secret for your Slack app
- `SLACK_APP_TOKEN`: App-level token starting with `xapp-`
- `SLACK_CHANNEL`: The channel where the leaderboard will be posted (default: `#scrapyard`)

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