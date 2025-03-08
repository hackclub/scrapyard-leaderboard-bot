import { App } from '@slack/bolt';
import { CronJob } from 'cron';
import { SQL } from "bun";
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Global cutoff timestamp - March 15, 2024 at 12:00 in UTC-12 (earliest timezone)
// This is March 16, 2024 at 00:00 UTC (midnight)
const GLOBAL_EVENT_START = new Date('2024-03-16T00:00:00Z');

// Configure Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Configure PostgreSQL connection manually for the warehouse DB
const sql = new SQL({
  url: process.env.WAREHOUSE_DB_URL
});

// Configure PostgreSQL connection for milestone tracking
const milestoneDb = new SQL({
  url: process.env.MILESTONE_DB_URL
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
    // Execute the prepared query directly
    const result = await LEADERBOARD_QUERY;
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
 * Checks if we've passed the global event start time
 * @returns {boolean} True if the event has started globally
 */
function hasEventStartedGlobally() {
  const now = new Date();
  return now >= GLOBAL_EVENT_START;
}

/**
 * Posts the leaderboard to the configured Slack channel
 */
async function postLeaderboard(channelId = process.env.SLACK_CHANNEL) {
  // Check if the event has started globally - if so, don't post leaderboard
  if (hasEventStartedGlobally()) {
    console.log(`Skipping leaderboard post - the event has started globally (${new Date().toISOString()})`);
    return;
  }

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

/**
 * Initializes the milestone database by creating the necessary table if it doesn't exist
 */
async function initMilestoneDb() {
  try {
    // Create a simpler, more intuitive table structure
    await milestoneDb`
      CREATE TABLE IF NOT EXISTS event_tracking (
        event_name TEXT PRIMARY KEY,
        event_slug TEXT,
        last_known_count INTEGER NOT NULL,
        last_milestone_notified INTEGER NOT NULL,
        last_notified_at TIMESTAMP WITH TIME ZONE,
        last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `;
    
    console.log('Milestone database initialized');
  } catch (error) {
    console.error('Error initializing milestone database:', error);
  }
}

/**
 * Determines the next milestone for an event based on its total registrations
 * @param {number} totalRegistrations - The total number of registrations
 * @returns {number} The milestone this count falls into
 */
function getNextMilestone(totalRegistrations) {
  if (totalRegistrations < 50) {
    // For events with < 50 registrations, milestone every 10
    return Math.floor(totalRegistrations / 10) * 10;
  } else {
    // For events with >= 50 registrations, milestone at multiples of 20
    return Math.floor(totalRegistrations / 20) * 20;
  }
}

/**
 * Formats a congratulatory message for an event that reached a milestone
 * @param {string} eventName - The name of the event
 * @param {number} currentCount - The exact current number of signups
 * @returns {Object} A formatted Slack message
 */
function formatMilestoneMessage(eventName, currentCount) {
  let emoji;
  
  // Select emoji based on signup count
  if (currentCount >= 100) {
    emoji = "🚀";
  } else if (currentCount >= 50) {
    emoji = "🔥";
  } else {
    emoji = "🎉";
  }
  
  // Simple, direct message format with the exact current count
  const message = `*${eventName}* just hit *${currentCount} signups*!`;
  
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} ${message}`
        }
      }
    ],
    text: `${eventName} reached ${currentCount} signups!` // Fallback text for notifications
  };
}

/**
 * Fetches data for ALL events with their total signups
 * This is used for milestone tracking to ensure we don't miss any events
 * @returns {Promise<Array>} All events with their total signups
 */
async function fetchAllEventsData() {
  try {
    // Query to get all events and their total signups, regardless of recent activity
    const result = await sql`
      WITH event_signups AS (
        SELECT
          "Local Attendee Event Info"."event_name" AS event_name,
          "Local Attendee Event Info"."slug" AS event_slug,
          COUNT(DISTINCT "source"."lower_email") AS total_sign_ups
        FROM (
          SELECT
            "source"."lower_email" AS "lower_email",
            MAX("source"."email") AS "max"
          FROM (
            SELECT
              "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"."email" AS "email",
              LOWER("airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"."email") AS "lower_email"
            FROM
              "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees"
          ) AS "source"
          GROUP BY "source"."lower_email"
        ) AS "source"
        INNER JOIN "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees" AS "Local Attendees - Max of Email"
          ON "source"."max" = "Local Attendees - Max of Email"."email"
        INNER JOIN (
          SELECT
            DISTINCT LOWER(a.email) AS lower_email,
            e.name AS event_name,
            e.slug AS slug
          FROM
            "airtable_hack_club_scrapyard_appigkif7gbvisalg"."local_attendees" AS a
            LEFT JOIN "airtable_hack_club_scrapyard_appigkif7gbvisalg"."events" AS e
              ON a.event ->> 0 = e.id
          WHERE e.name IS NOT NULL AND e.slug IS NOT NULL
        ) AS "Local Attendee Event Info"
          ON "source"."lower_email" = "Local Attendee Event Info"."lower_email"
        GROUP BY 
          "Local Attendee Event Info"."event_name",
          "Local Attendee Event Info"."slug"
      )
      SELECT
        event_name,
        event_slug,
        total_sign_ups
      FROM
        event_signups
      WHERE
        event_name IS NOT NULL
        AND total_sign_ups > 0
      ORDER BY
        event_name ASC
    `;
    
    console.log(`Fetched data for ${result.length} events`);
    
    // Log the first few events to verify data is correct
    if (result.length > 0) {
      const sampleEvents = result.slice(0, 3);
      console.log('Sample events:');
      sampleEvents.forEach(event => {
        console.log(`- ${event.event_name} (slug: ${event.event_slug}) - ${event.total_sign_ups} signups`);
      });
    }
    
    return result;
  } catch (error) {
    console.error('Error fetching all events data:', error);
    return [];
  }
}

/**
 * Checks for milestone achievements and posts congratulatory messages
 */
async function checkMilestones() {
  // Check if the event has started globally - if so, don't check milestones
  if (hasEventStartedGlobally()) {
    console.log(`Skipping milestone check - the event has started globally (${new Date().toISOString()})`);
    return;
  }

  try {
    console.log(`Checking milestones at ${new Date().toISOString()}`);
    
    // Fetch ALL events data
    const allEvents = await fetchAllEventsData();
    
    if (!allEvents || allEvents.length === 0) {
      console.log('No events found for milestone checking');
      return;
    }
    
    console.log(`Processing ${allEvents.length} events for milestone checks`);
    
    // Process each event
    for (const event of allEvents) {
      // Skip events with null or empty event name
      if (!event.event_name) {
        console.log('Skipping event with null or empty name');
        continue;
      }
      
      const eventName = event.event_name;
      const currentCount = event.total_sign_ups || 0;
      const eventSlug = event.event_slug;
      
      // Skip events with no registrations
      if (!currentCount) {
        console.log(`Skipping ${eventName} with 0 signups`);
        continue;
      }
      
      // Check if we're already tracking this event
      const existingRecord = await milestoneDb`
        SELECT * FROM event_tracking WHERE event_name = ${eventName}
      `;
      
      if (existingRecord.length === 0) {
        // First time seeing this event - add to tracking without notification
        const currentMilestone = getNextMilestone(currentCount);
        
        try {
          await milestoneDb`
            INSERT INTO event_tracking (
              event_name, 
              event_slug, 
              last_known_count, 
              last_milestone_notified,
              last_notified_at,
              last_updated_at
            ) VALUES (
              ${eventName},
              ${eventSlug},
              ${currentCount},
              ${currentMilestone},
              NULL,
              NOW()
            )
          `;
          
          console.log(`Started tracking ${eventName} with ${currentCount} signups (milestone: ${currentMilestone}, slug: ${eventSlug})`);
        } catch (insertError) {
          console.error(`Error adding event ${eventName} to tracking:`, insertError);
        }
      } else {
        // We're already tracking this event
        const record = existingRecord[0];
        const lastKnownCount = record.last_known_count;
        const lastMilestoneNotified = record.last_milestone_notified;
        
        // Determine the current milestone
        const currentMilestone = getNextMilestone(currentCount);
        
        // Check if we've crossed a new milestone threshold
        const crossedNewMilestone = currentMilestone > lastMilestoneNotified;
        
        // For events with > 50 registrations, only notify if milestone is 20% higher
        let shouldNotify = crossedNewMilestone;
        if (lastMilestoneNotified >= 50 && crossedNewMilestone) {
          shouldNotify = currentMilestone >= lastMilestoneNotified * 1.2;
        }
        
        // Notify if we crossed a milestone
        if (shouldNotify && currentCount >= 10) {
          try {
            // Post the milestone message with the EXACT current count, not the milestone
            const message = formatMilestoneMessage(eventName, currentCount);
            
            await app.client.chat.postMessage({
              channel: process.env.SLACK_CHANNEL,
              ...message
            });
            
            console.log(`Posted milestone for ${eventName}: ${currentCount} signups (crossed milestone: ${currentMilestone})`);
            
            // Update our tracking record with the new milestone and always update the slug
            await milestoneDb`
              UPDATE event_tracking 
              SET 
                last_known_count = ${currentCount},
                last_milestone_notified = ${currentMilestone},
                event_slug = ${eventSlug},
                last_notified_at = NOW(),
                last_updated_at = NOW()
              WHERE event_name = ${eventName}
            `;
          } catch (updateError) {
            console.error(`Error updating milestone for ${eventName}:`, updateError);
          }
        } else if (currentCount !== lastKnownCount) {
          try {
            // Just update the count and slug
            await milestoneDb`
              UPDATE event_tracking 
              SET 
                last_known_count = ${currentCount},
                event_slug = ${eventSlug},
                last_updated_at = NOW()
              WHERE event_name = ${eventName}
            `;
          } catch (updateError) {
            console.error(`Error updating count for ${eventName}:`, updateError);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking milestones:', error);
  }
}

// Register slash command handler
app.command('/scrapyard-leaderboard', async ({ command, ack, respond }) => {
  await ack();
  
  // Check if the event has started globally - if so, respond with a message
  if (hasEventStartedGlobally()) {
    await respond({
      response_type: 'ephemeral',
      text: "Scrapyard has started globally. Leaderboard updates are no longer available."
    });
    return;
  }
  
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
  
  // Initialize milestone database before scheduling any jobs
  await initMilestoneDb();
  
  // Check if we're past the global event start time
  if (hasEventStartedGlobally()) {
    console.log(`The event has already started globally (current time: ${new Date().toISOString()})`);
    console.log(`Global event start time was: ${GLOBAL_EVENT_START.toISOString()}`);
    console.log('No scheduled jobs will be started.');
    return;
  }
  
  // Schedule leaderboard posts at 8am and 8pm ET
  // Note: Server time should be set to ET, or TZ env var should be set to America/New_York
  const morningJob = new CronJob('0 0 8 * * *', postLeaderboard, null, true, 'America/New_York');
  const eveningJob = new CronJob('0 0 20 * * *', postLeaderboard, null, true, 'America/New_York');
  
  // Schedule milestone checks every 1 minute
  const milestoneJob = new CronJob('* * * * *', checkMilestones, null, true, 'America/New_York');
  
  console.log('📅 Scheduled jobs:');
  console.log(`- Morning leaderboard: ${morningJob.nextDate().toString()}`);
  console.log(`- Evening leaderboard: ${eveningJob.nextDate().toString()}`);
  console.log(`- Milestone checks: Every minute`);
  console.log(`All jobs will stop after the global event start: ${GLOBAL_EVENT_START.toISOString()}`);
  
  // Verify database connections by testing simple queries
  try {
    const warehouseTest = await sql`SELECT 1 as test`;
    console.log('🔌 Connected to warehouse database successfully');
    
    const milestoneTest = await milestoneDb`SELECT 1 as test`;
    console.log('🔌 Connected to milestone database successfully');
  } catch (error) {
    console.error('Database connection error:', error);
  }
  
  // Run the first milestone check immediately
  console.log('Running initial milestone check...');
  await checkMilestones();
})();
