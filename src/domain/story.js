// 公开叙事聚合（public_story）。
// 发布版本一经产生即不可变；撤回不改写旧版本，只追加处置（停止新发布、已发布版本追加声明）。
import { EVENT_TYPES as T } from "../events.js";

export const DISPOSITION = Object.freeze({
  WITHDRAWAL_NOTICE: "withdrawal_notice", // 患者撤回：阻止新发布，已发布版本追加撤回说明
  EXPIRED: "expired", // 同意到期
  SUPERSEDED_BY_CORRECTION: "superseded_by_correction" // 归属更正后，旧叙事不再作为当前版本
});

export function emptyStory() {
  return {
    exists: false,
    storyId: null,
    patientId: null,
    consentId: null,
    reviewId: null,
    versions: [], // 不可变的发布版本列表
    dispositions: [] // 追加式处置记录
  };
}

export function foldStory(events) {
  let state = emptyStory();
  for (const e of events) state = applyStory(state, e);
  return state;
}

export function applyStory(state, e) {
  switch (e.event_type) {
    case T.STORY_RELEASED:
      return {
        ...state,
        exists: true,
        storyId: e.story_id,
        patientId: e.patient_id ?? state.patientId,
        consentId: e.consent_id ?? state.consentId,
        reviewId: e.review_id ?? state.reviewId,
        versions: [
          ...state.versions,
          {
            version: e.story_version,
            at: e.occurred_at,
            purpose: e.purpose,
            channel: e.channel,
            disclosed_fields: e.disclosed_fields ?? [],
            authorized_scope_ids: e.authorized_scope_ids ?? [],
            public_summary: e.public_summary,
            attribution_snapshot: e.attribution_snapshot ?? null
          }
        ]
      };

    case T.STORY_DISPOSITION_APPENDED:
      return {
        ...state,
        dispositions: [
          ...state.dispositions,
          {
            at: e.occurred_at,
            kind: e.disposition,
            reason: e.reason ?? null,
            target_versions: e.target_versions ?? state.versions.map((v) => v.version),
            blocks_new_release: e.blocks_new_release ?? false,
            notice_text: e.notice_text ?? null
          }
        ]
      };

    default:
      return state;
  }
}

export function latestVersion(state) {
  return state.versions[state.versions.length - 1] ?? null;
}

// 某版本是否已被追加“停止新发布”类处置。
export function isBlockedForNewRelease(state, version) {
  return state.dispositions.some(
    (d) => d.blocks_new_release && (d.target_versions ?? []).includes(version)
  );
}

// 某版本是否已有指定处置（撤回通知等），用于重启后幂等继续通知。
export function dispositionsOfVersion(state, version) {
  return state.dispositions.filter((d) => (d.target_versions ?? []).includes(version));
}
