export const CALLBACK_DELIVERY_SELECT = `
  SELECT
    id,
    target_session_id AS targetSessionId,
    source_kind AS sourceKind,
    source_id AS sourceId,
    source_attempt AS sourceAttempt,
    source_outcome AS sourceOutcome,
    source_version AS sourceVersion,
    delivery_kind AS deliveryKind,
    payload,
    status,
    message_id AS messageId,
    queue_item_id AS queueItemId,
    attempt_count AS attemptCount,
    next_attempt_at AS nextAttemptAt,
    last_attempt_at AS lastAttemptAt,
    last_error AS lastError,
    dead_lettered_at AS deadLetteredAt,
    created_at AS createdAt,
    accepted_at AS acceptedAt
  FROM callback_deliveries
`;
