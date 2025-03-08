import { App } from '@slack/bolt';
import { CronJob } from 'cron';
import { SQL } from "bun";
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configure Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Configure PostgreSQL connection manually
const sql = new SQL({
  url: process.env.WAREHOUSE_DB_URL
});

// Define SQL query for the leaderboard
const LEADERBOARD_QUERY = sql`
WITH summary AS (
  SELECT
    -- Group by event_name so each row is a single event's stats
    "source"."Local Attendee Event Info - lower_email__event_name" AS event_name,
    
    -- Distinct signups in the last 12 hours
    COUNT(DISTINCT "source"."lower_email") FILTER (
      WHERE
        "source"."Local Attendees - Max of Email__created_at"
          >= DATE_TRUNC('hour', (NOW() + INTERVAL '-12 hour'))
        AND "source"."Local Attendees - Max of Email__created_at"
          < DATE_TRUNC('hour', (NOW() + INTERVAL '1 hour'))
    ) AS new_sign_ups_past_12_hours,
    
    -- Total distinct signups overall
    COUNT(DISTINCT "source"."lower_email") AS total_sign_ups
  FROM
  (
    SELECT
      "source"."lower_email" AS "lower_email",
      "Local Attendees - Max of Email"."created_at" AS "Local Attendees - Max of Email__created_at",
      "Local Attendee Event Info - lower_email"."event_name"
        AS "Local Attendee Event Info - lower_email__event_name"
    FROM
    (
      SELECT
        "source"."lower_email",
        COUNT(DISTINCT "source"."lower_email") AS "count",
        MAX("source"."email") AS "max"
      FROM
      (
        SELECT
          "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"."email" AS "email",
          LOWER("airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"."email")
            AS "lower_email"
        FROM
          "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"
      ) AS "source"
      GROUP BY "source"."lower_email"
    ) AS "source"
    INNER JOIN "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"
      AS "Local Attendees - Max of Email"
        ON "source"."max" = "Local Attendees - Max of Email"."email"
    INNER JOIN "loops"."audience" AS "Audience - lower_email"
      ON "source"."lower_email" = "Audience - lower_email"."email"
    INNER JOIN (
      SELECT
        DISTINCT LOWER(a.email) AS lower_email,
        e.name AS event_name,
        e.slug AS event_slug
      FROM
        "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees" AS a
        LEFT JOIN "airtable_hack_club_scrapyard_appigkif7gbvisalg"."events" AS e
          ON a.event ->> 0 = e.id
    ) AS "Local Attendee Event Info - lower_email"
      ON "source"."lower_email" = "Local Attendee Event Info - lower_email"."lower_email"
  ) AS "source"
  GROUP BY
    "source"."Local Attendee Event Info - lower_email__event_name"
)
SELECT
  /* Rank among these aggregated rows by new signups (descending) */
  RANK() OVER (
    ORDER BY summary.new_sign_ups_past_12_hours DESC
  ) AS "leaderboard_rank",
  
  /* Event name */
  summary.event_name,
  
  /* 12-hour signup count */
  summary.new_sign_ups_past_12_hours,
  
  /* Rank among these aggregated rows by total signups (descending) */
  RANK() OVER (
    ORDER BY summary.total_sign_ups DESC
  ) AS "overall_rank",
  
  /* The total distinct signups */
  summary.total_sign_ups

FROM summary
-- Return only the top rows in terms of new_sign_ups_past_12_hours
WHERE summary.new_sign_ups_past_12_hours > 0
ORDER BY
  summary.new_sign_ups_past_12_hours DESC,
  summary.event_name ASC
`;

/**
 * Fetches the current leaderboard data from the warehouse database
 * @returns {Promise<Array>} The leaderboard data
 */
async function fetchLeaderboardData() {
  try {
    // Using the unsafe method to execute raw SQL
    const result = await sql(LEADERBOARD_QUERY);
    return result;
  } catch (error) {
    console.error('Error fetching leaderboard data:', error);
    return [];
  }
}

/**
 * Formats the leaderboard data into a Slack message
 * @param {Array} data The leaderboard data
 * @returns {Object} A formatted Slack message block
 */
function formatLeaderboardMessage(data) {
  if (!data || data.length === 0) {
    return {
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🏆 Scrapyard Leaderboard",
            emoji: true
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "No new sign-ups in the past 12 hours."
          }
        }
      ]
    };
  }

  // Format the current time in ET
  const now = new Date();
  const formattedTime = formatInTimeZone(now, 'America/New_York', 'MMMM d, yyyy h:mm a zzz');

  // Create the header section
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🏆 New sign-ups in past 12 hours",
        emoji: true
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Top 10 by new sign-ups:"
      }
    }
  ];

  // Top 10 events - one row per event for better visibility
  const topEvents = data.slice(0, 10);
  if (topEvents.length > 0) {
    // Emoji number mapping
    const rankEmojis = {
      1: ":one:",
      2: ":two:",
      3: ":three:",
      4: ":four:",
      5: ":five:",
      6: ":six:",
      7: ":seven:",
      8: ":eight:",
      9: ":nine:",
      10: ":keycap_ten:"
    };
    
    const topEventsText = topEvents.map((event, index) => {
      const displayRank = index + 1; // Use array index + 1 for emoji lookup
      const rank = event.leaderboard_rank; // Keep the actual rank for debugging
      const rankDisplay = rankEmojis[displayRank] || `${rank}.`;
      // Keep the full name for top 10
      const name = event.event_name;
      return `${rankDisplay} *${name}* · ${event.new_sign_ups_past_12_hours}↑ · ${event.total_sign_ups}:bust_in_silhouette:`;
    }).join('\n');
    
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: topEventsText
      }
    });
  }
  
  // Remaining events in compact format (11-25)
  const remainingEvents = data.slice(10, 25);
  if (remainingEvents.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Other events with new sign-ups:"
      }
    });
    
    // Group remaining events by their new sign-up count
    const eventsBySignups = {};
    remainingEvents.forEach(event => {
      const signups = event.new_sign_ups_past_12_hours;
      if (!eventsBySignups[signups]) {
        eventsBySignups[signups] = [];
      }
      eventsBySignups[signups].push(event);
    });
    
    // Sort by signup count (descending)
    const signupCounts = Object.keys(eventsBySignups).sort((a, b) => b - a);
    
    const compactRows = signupCounts.map(signupCount => {
      const eventsWithCount = eventsBySignups[signupCount];
      const eventNames = eventsWithCount.map(event => {
        // Remove "Scrapyard" prefix for the compact view
        const name = event.event_name.replace('Scrapyard ', '');
        return `*${name}* (${event.total_sign_ups})`;
      }).join(', ');
      
      return `• ${signupCount}↑: ${eventNames}`;
    });
    
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: compactRows.join('\n')
      }
    });
  }
  
  // Add a footer with explanation
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Format: New sign-ups↑ · Total sign-ups:bust_in_silhouette: · `/scrapyard-leaderboard` for latest data"
      }
    ]
  });

  return { blocks };
}

/**
 * Posts the leaderboard to the configured Slack channel
 */
async function postLeaderboard(channelId = process.env.SLACK_CHANNEL) {
  try {
    const data = await fetchLeaderboardData();
    const message = formatLeaderboardMessage(data);
    
    await app.client.chat.postMessage({
      channel: channelId,
      ...message,
      text: "Scrapyard Leaderboard Update" // Fallback text for notifications
    });
    
    console.log(`Leaderboard posted to ${channelId} at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Error posting leaderboard:', error);
  }
}

// Register slash command handler
app.command('/scrapyard-leaderboard', async ({ command, ack, respond }) => {
  await ack();
  
  try {
    // Log the user who triggered the command
    const userId = command.user_id;
    const username = command.user_name;
    console.log(`Slash command triggered by user: ${username} (${userId}) at ${new Date().toISOString()}`);
    
    const data = await fetchLeaderboardData();
    const message = formatLeaderboardMessage(data);
    
    await respond({
      response_type: 'ephemeral', // Only visible to the user who triggered the command
      ...message,
      text: "Scrapyard Leaderboard Update" // Fallback text
    });
  } catch (error) {
    console.error('Error handling slash command:', error);
    await respond({
      response_type: 'ephemeral',
      text: "Sorry, there was an error fetching the leaderboard data."
    });
  }
});

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ Scrapyard Leaderboard Bot is running!');
  
  // Schedule leaderboard posts at 8am and 8pm ET
  // Note: Server time should be set to ET, or TZ env var should be set to America/New_York
  const morningJob = new CronJob('0 0 8 * * *', postLeaderboard, null, true, 'America/New_York');
  const eveningJob = new CronJob('0 0 20 * * *', postLeaderboard, null, true, 'America/New_York');
  
  console.log('📅 Scheduled jobs:');
  console.log(`- Morning leaderboard: ${morningJob.nextDate().toString()}`);
  console.log(`- Evening leaderboard: ${eveningJob.nextDate().toString()}`);
  
  // Verify database connection by testing a simple query
  try {
    const test = await sql`SELECT 1 as test`;
    console.log('🔌 Connected to database successfully');
  } catch (error) {
    console.error('Database connection error:', error);
  }
})();
