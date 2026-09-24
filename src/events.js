// 领域事件名称、聚合类型与事件构造器。
// 事件一经追加即不可变：归属/同意的更正只能追加后继事件，不能改写历史。

export const EVENT_TYPES = Object.freeze({
  PROFILE_REGISTERED: "PROFILE_REGISTERED",
  NOMINATION_SUBMITTED: "NOMINATION_SUBMITTED",
  NOMINATION_VOTED: "NOMINATION_VOTED",
  CONTRIBUTION_DECLARED: "CONTRIBUTION_DECLARED",
  CONTRIBUTION_ACKNOWLEDGED: "CONTRIBUTION_ACKNOWLEDGED",
  EVIDENCE_SUBMITTED: "EVIDENCE_SUBMITTED",
  OFFLINE_CONFIRMATION_RECORDED: "OFFLINE_CONFIRMATION_RECORDED",
  DUPLICATE_MERGED: "DUPLICATE_MERGED",
  EVIDENCE_CONFLICT_FLAGGED: "EVIDENCE_CONFLICT_FLAGGED",
  EVIDENCE_CONFLICT_RESOLVED: "EVIDENCE_CONFLICT_RESOLVED",
  ATTRIBUTION_SUGGESTED: "ATTRIBUTION_SUGGESTED",
  ATTRIBUTION_ADJUDICATED: "ATTRIBUTION_ADJUDICATED",
  DISPUTE_FILED: "DISPUTE_FILED",
  DISPUTE_RESOLVED: "DISPUTE_RESOLVED",
  ATTRIBUTION_CORRECTED: "ATTRIBUTION_CORRECTED",
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  STORY_RELEASED: "STORY_RELEASED",
  STORY_DISPOSITION_APPENDED: "STORY_DISPOSITION_APPENDED"
});

export const AGGREGATE_TYPES = Object.freeze({
  PROFILE: "nominee_profile",
  NOMINATION: "honor_nomination",
  CONTRIBUTION: "contribution_record",
  REVIEW: "achievement_review",
  CONSENT: "consent_grant",
  STORY: "public_story"
});

let seq = 0;

function defaultId() {
  seq += 1;
  return `evt-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// 构造一个完整事件信封。payload 中的业务字段平铺到事件上。
export function makeEvent({ eventType, aggregateType, aggregateId, version, summary, now, eventId, payload = {} }) {
  return {
    event_id: eventId ?? payload.event_id ?? defaultId(),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: (now ?? new Date()).toISOString(),
    version,
    summary,
    ...payload
  };
}

export function isDomainEventType(name) {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES, name);
}

export function isAggregateType(name) {
  return Object.values(AGGREGATE_TYPES).includes(name);
}
