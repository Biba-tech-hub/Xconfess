/**
 * Analytics governance constants and schema registry (#86).
 *
 * All analytics decisions that affect privacy, retention, or event validity
 * are defined here so dashboards, validators, and runbooks all read from a
 * single authoritative source.
 */

// ─── Privacy ──────────────────────────────────────────────────────────────────

/**
 * Privacy constants for analytics aggregation.
 *
 * MIN_COHORT_SIZE defines the minimum number of records required in an
 * aggregated bucket before exposing the count. Buckets below this threshold
 * are suppressed to prevent de-anonymisation via small-cohort inference.
 *
 * Reference: k-anonymity principle (Sweeney, 2002)
 */
export const ANALYTICS_PRIVACY = {
  /**
   * Minimum number of records in any aggregated cohort.
   * Examples: daily active users, daily confession count, reaction type count.
   *
   * Set to 5 (balanced trade-off between privacy and utility):
   * - Prevents single-user or 2-3 user buckets from being exposed
   * - Allows reasonable statistical visibility for platform health metrics
   * - Supports typical retention and churn analysis requirements
   */
  MIN_COHORT_SIZE: 5,
} as const;

// ─── Schema Registry (#86) ───────────────────────────────────────────────────

/**
 * Event ownership map.
 *
 * Each event name is mapped to:
 *   - owner:        Team or module responsible for this event contract
 *   - purpose:      Business or product intent (used in consent checks)
 *   - schemaVersion: Current schema version for this event; bump when the
 *                    meaning of fields changes (not for additive changes)
 *   - retentionDays: How long raw events should be kept before purge/archive.
 *                    null = governed by the global default.
 *   - consentRequired: Whether this event requires explicit user consent
 *                      before being recorded (for GDPR/CCPA purposes).
 *
 * Dashboard note: events with schemaVersion < ANALYTICS_SCHEMA_VERSION in
 * the entity indicate schema drift and should be flagged in quality reports.
 */
export interface EventRegistryEntry {
  owner: string;
  purpose: string;
  schemaVersion: number;
  retentionDays: number | null;
  consentRequired: boolean;
}

export const ANALYTICS_EVENT_REGISTRY: Record<string, EventRegistryEntry> = {
  user_registered: {
    owner: 'auth',
    purpose: 'product_funnel',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  user_login: {
    owner: 'auth',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  confession_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  confession_publish_failed: {
    owner: 'confessions',
    purpose: 'reliability',
    schemaVersion: 1,
    retentionDays: 30,
    consentRequired: false,
  },
  comment_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  reaction_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  message_sent: {
    owner: 'messages',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  wallet_connected: {
    owner: 'stellar',
    purpose: 'stellar_activation',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_submitted: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_confirmed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_failed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  tip_completed: {
    owner: 'tipping',
    purpose: 'monetisation',
    schemaVersion: 1,
    retentionDays: 730,
    consentRequired: false,
  },
  soroban_event_indexed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
} as const;

/**
 * Default event retention in days for events not listed in the registry or
 * with retentionDays = null.
 */
export const ANALYTICS_DEFAULT_RETENTION_DAYS = 90;

/**
 * Allowed event purposes. Used by validators and dashboard filters to group
 * events by intent without exposing raw event names to external systems.
 */
export const ANALYTICS_EVENT_PURPOSES = [
  'product_funnel',
  'engagement',
  'reliability',
  'stellar_activation',
  'stellar_reliability',
  'monetisation',
] as const;

export type AnalyticsEventPurpose = (typeof ANALYTICS_EVENT_PURPOSES)[number];

// ─── Validation helpers ────────────────────────────────────────────────────────

/**
 * Look up the registry entry for an event name.
 * Returns undefined for unknown events (which should be rejected at ingestion).
 */
export function getEventRegistryEntry(
  eventName: string,
): EventRegistryEntry | undefined {
  return ANALYTICS_EVENT_REGISTRY[eventName];
}

/**
 * Returns the retention window in days for a given event name.
 * Falls back to ANALYTICS_DEFAULT_RETENTION_DAYS.
 */
export function getEventRetentionDays(eventName: string): number {
  const entry = getEventRegistryEntry(eventName);
  return entry?.retentionDays ?? ANALYTICS_DEFAULT_RETENTION_DAYS;
}

/**
 * Returns true when an event with the given schema version matches what
 * the registry expects. Mismatches indicate schema drift and should be
 * flagged in data-quality dashboards.
 */
export function isSchemaVersionCurrent(
  eventName: string,
  schemaVersion: number,
): boolean {
  const entry = getEventRegistryEntry(eventName);
  if (!entry) return false;
  return entry.schemaVersion === schemaVersion;
}
