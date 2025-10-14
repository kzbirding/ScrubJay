import { sql } from 'drizzle-orm';
import {
  integer,
  text,
  real,
  primaryKey,
  index,
  boolean,
  timestamp,
  pgTable,
} from 'drizzle-orm/pg-core';

import { timezones } from '@/shared/timezones';

export const locations = pgTable(
  'location',
  {
    id: text('id').primaryKey(),
    county: text('county').notNull(),
    countyCode: text('county_code').notNull(),
    state: text('state').notNull(),
    stateCode: text('state_code').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    name: text('name').notNull(),
    isPrivate: boolean('is_private').notNull(),
    lastUpdated: timestamp('last_updated')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('county_state_code_idx').on(table.countyCode, table.stateCode),
  ]
);

export const observations = pgTable(
  'observation',
  {
    speciesCode: text('species_code').notNull(),
    subId: text('sub_id').notNull(),
    comName: text('common_name').notNull(),
    sciName: text('scientific_name').notNull(),
    locId: text('location_id')
      .references(() => locations.id, { onDelete: 'cascade', onUpdate: 'cascade' })
      .notNull(),
    obsDt: timestamp('observation_date').notNull(),
    howMany: integer('how_many').notNull(),
    obsValid: boolean('observation_valid').notNull(),
    obsReviewed: boolean('observation_reviewed').notNull(),
    presenceNoted: boolean('presence_noted').notNull(),
    photoCount: integer('photo_count').notNull().default(0),
    audioCount: integer('audio_count').notNull().default(0),
    videoCount: integer('video_count').notNull().default(0),
    hasComments: boolean('has_comments').notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastUpdated: timestamp('last_updated')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.speciesCode, t.subId] }),
    index('obs_created_at_idx').on(t.createdAt),
    index('obs_location_date_idx').on(t.locId, t.obsDt),
    index('obs_review_valid_date_idx').on(t.obsReviewed, t.obsValid, t.obsDt),
  ]
);

export const channelSubscriptions = pgTable(
  'channel_subscription',
  {
    channelId: text('channel_id').notNull(),
    countyCode: text('county_code').notNull(),
    stateCode: text('state_code').notNull(),
    active: boolean('active').notNull().default(true),
    lastUpdated: timestamp('last_updated')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.countyCode, t.stateCode] }),
    index('county_state_idx').on(t.countyCode, t.stateCode),
    index('active_state_idx').on(t.active, t.stateCode),
  ]
);

export const filteredSpecies = pgTable(
  'filtered_species',
  {
    commonName: text('common_name').notNull(),
    channelId: text('channel_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commonName, t.channelId] }),
    index('common_name_channel_id_idx').on(t.commonName, t.channelId),
  ]
);

export const countyTimezones = pgTable(
  'county_timezones',
  {
    countyCode: text('county_code').primaryKey(),
    timezone: text('timezone', { enum: timezones })
      .notNull()
      .default('America/Los_Angeles'),
  },
  (t) => [index('county_code_idx').on(t.countyCode)]
);

export const SourceType = ['RSS', 'EBIRD', 'EMAIL'] as const;
export const FeedFormat = ['rss', 'atom', 'unknown'] as const;

// --- Sources: one per RSS/Atom feed (or eBird region, or mailbox) ---
export const sources = pgTable(
  'source',
  {
    id: text('id').primaryKey(), // e.g. "sandiegoregionbirding"
    type: text('type', { enum: SourceType }).notNull().default('RSS'),
    url: text('url'), // For RSS/Atom
    format: text('format', { enum: FeedFormat }).notNull().default('unknown'),
    configJson: text('config_json'), // Optional JSON config (e.g., email params)
    etag: text('etag'),
    lastModified: text('last_modified'),
    fetchIntervalMin: integer('fetch_interval_min').notNull().default(20),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('source_type_active_idx').on(t.type, t.active)]
);

// --- Source Items: entries (RSS/Atom posts, emails, etc.) ---
export const sourceItems = pgTable(
  'source_item',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    guid: text('guid'),
    canonicalLink: text('canonical_link').notNull(),
    title: text('title'),
    author: text('author'),
    summary: text('summary'),
    publishedAt: timestamp('published_at'),
    mediaUrl: text('media_url'),
    contentHash: text('content_hash'),
    rawJson: text('raw_json'),
    fetchedAt: timestamp('fetched_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('source_items_sourceid_published_idx').on(t.sourceId, t.publishedAt),
    index('source_items_guid_idx').on(t.guid),
    index('source_items_canonical_idx').on(t.canonicalLink),
  ]
);

export const deliveries = pgTable(
  'delivery',
  {
    kind: text('kind', { enum: ['RSS', 'EBIRD', 'EMAIL'] }).notNull(),
    itemKey: text('item_key').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    deliveredAt: timestamp('delivered_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.itemKey, t.channelId] }),
    index('delivery_channel_kind_idx').on(t.channelId, t.kind),
  ]
);

export const channelSourceSubscriptions = pgTable(
  'channel_source_subscription',
  {
    channelId: text('channel_id').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastUpdated: timestamp('last_updated')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.sourceId] }),
    index('channel_source_active_idx').on(t.channelId, t.active),
  ]
);