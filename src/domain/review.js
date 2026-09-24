// 成果评定聚合（achievement_review）的纯函数归约。
// 输入该成果相关事件（review 流 + contribution_record 流），输出不可变历史之上的当前状态。
import { EVENT_TYPES as T } from "../events.js";

export function emptyReview() {
  return {
    exists: false,
    reviewId: null,
    achievementId: null,
    title: null,
    honorId: null,
    contributions: new Map(),
    evidenceByFingerprint: new Map(),
    suggestions: [],
    adjudications: [],
    disputes: [],
    corrections: [],
    pendingConflicts: [],
    closed: false
  };
}

export function foldReview(events) {
  let state = emptyReview();
  for (const e of events) state = applyReview(state, e);
  return state;
}

export function applyReview(state, e) {
  switch (e.event_type) {
    case T.ATTRIBUTION_SUGGESTED:
      return {
        ...state,
        suggestions: [
          ...state.suggestions,
          { id: e.event_id, at: e.occurred_at, basis: e.basis, entries: e.entries, note: e.note, advisory: true }
        ]
      };

    case T.ATTRIBUTION_ADJUDICATED:
      return {
        ...state,
        adjudications: [
          ...state.adjudications,
          {
            id: e.adjudication_id,
            at: e.occurred_at,
            adjudicatorId: e.adjudicator_id,
            adjudicatorName: e.adjudicator_name,
            entries: e.entries,
            rationale: e.rationale ?? null
          }
        ]
      };

    case T.DISPUTE_FILED:
      return {
        ...state,
        disputes: [
          ...state.disputes,
          { id: e.dispute_id, at: e.occurred_at, claimantId: e.claimant_id, reason: e.reason, status: "open", deadline: e.deadline ?? null }
        ]
      };

    case T.DISPUTE_RESOLVED: {
      const disputes = state.disputes.map((d) =>
        d.id === e.dispute_id ? { ...d, status: e.ruling === "upheld" ? "upheld" : "rejected", resolvedAt: e.occurred_at, rationale: e.rationale, adjudicatorId: e.adjudicator_id } : d
      );
      return { ...state, disputes };
    }

    case T.ATTRIBUTION_CORRECTED:
      return {
        ...state,
        corrections: [
          ...state.corrections,
          {
            id: e.correction_id,
            at: e.occurred_at,
            disputeId: e.dispute_id,
            reason: e.reason,
            entries: e.entries,
            correctedBy: e.corrected_by
          }
        ]
      };

    default:
      return applyContributionOrLifecycle(state, e);
  }
}

function applyContributionOrLifecycle(state, e) {
  switch (e.event_type) {
    case T.PROFILE_REGISTERED:
    case T.NOMINATION_SUBMITTED:
    case T.NOMINATION_VOTED:
    case T.CONSENT_GRANTED:
    case T.CONSENT_WITHDRAWN:
    case T.STORY_RELEASED:
    case T.STORY_DISPOSITION_APPENDED:
      return state;

    case T.CONTRIBUTION_DECLARED: {
      const contributions = new Map(state.contributions);
      contributions.set(e.contribution_id, {
        id: e.contribution_id,
        personId: e.person_id,
        personName: e.person_name,
        role: e.role,
        duty: e.duty,
        workPeriod: e.work_period,
        evidenceSummary: e.evidence_summary,
        coParticipants: e.co_participants ?? [],
        declaredAt: e.occurred_at,
        acknowledgedBy: new Map(),
        offlineConfirmations: [],
        evidence: []
      });
      return { ...state, exists: true, reviewId: state.reviewId ?? e.review_id, achievementId: e.achievement_id ?? state.achievementId, contributions };
    }

    case T.CONTRIBUTION_ACKNOWLEDGED: {
      const c = state.contributions.get(e.contribution_id);
      if (!c || c.acknowledgedBy.has(e.acknowledged_by)) return state;
      const acknowledgedBy = new Map(c.acknowledgedBy);
      acknowledgedBy.set(e.acknowledged_by, { at: e.occurred_at, note: e.note ?? null });
      return patchContribution(state, e.contribution_id, { acknowledgedBy });
    }

    case T.OFFLINE_CONFIRMATION_RECORDED: {
      const c = state.contributions.get(e.contribution_id);
      if (!c) return state;
      // 离线确认按指纹归并：同一份纸质签认重复补录不再产生新的确认状态。
      if (c.offlineConfirmations.some((o) => o.fingerprint === e.fingerprint)) {
        return mergeOfflineDuplicate(state, e);
      }
      const record = {
        fingerprint: e.fingerprint,
        confirmerId: e.confirmer_id,
        confirmerName: e.confirmer_name,
        witness: e.witness ?? null,
        channel: e.channel,
        at: e.occurred_at,
        contentHash: e.content_hash
      };
      return patchContribution(state, e.contribution_id, { offlineConfirmations: [...c.offlineConfirmations, record] });
    }

    case T.DUPLICATE_MERGED: {
      // 重复证明/离线确认按指纹归并，只在既有材料上追加来源，不产生新事实。
      const fp = state.evidenceByFingerprint.get(e.fingerprint);
      let next = state;
      if (fp) {
        const evidenceByFingerprint = new Map(state.evidenceByFingerprint);
        evidenceByFingerprint.set(e.fingerprint, {
          ...fp,
          sources: [...fp.sources, { channel: e.duplicate_channel, at: e.occurred_at, contentHash: e.content_hash, via: e.via }]
        });
        next = { ...next, evidenceByFingerprint };
      }
      const c = state.contributions.get(e.contribution_id);
      if (c) {
        next = patchContribution(next, e.contribution_id, {
          evidence: c.evidence.some((m) => m.fingerprint === e.fingerprint && m.contentHash === e.content_hash)
            ? c.evidence
            : [...c.evidence, { fingerprint: e.fingerprint, channel: e.duplicate_channel, contentHash: e.content_hash, submittedAt: e.occurred_at, duplicate: true }]
        });
      }
      return next;
    }

    case T.EVIDENCE_SUBMITTED: {
      const c = state.contributions.get(e.contribution_id);
      if (!c) return state;
      const item = {
        fingerprint: e.fingerprint,
        contentHash: e.content_hash,
        channel: e.channel,
        summary: e.summary,
        submittedAt: e.occurred_at,
        afterAdjudication: state.adjudications.length > 0
      };
      const evidenceByFingerprint = new Map(state.evidenceByFingerprint);
      evidenceByFingerprint.set(e.fingerprint, {
        ...(evidenceByFingerprint.get(e.fingerprint) ?? { conflict: false, sources: [] }),
        fingerprint: e.fingerprint,
        lastContentHash: e.content_hash,
        sources: [
          ...(evidenceByFingerprint.get(e.fingerprint)?.sources ?? []),
          { channel: e.channel, at: e.occurred_at, contentHash: e.content_hash }
        ]
      });
      return {
        ...patchContribution(state, e.contribution_id, { evidence: [...c.evidence, item] }),
        evidenceByFingerprint
      };
    }

    case T.EVIDENCE_CONFLICT_FLAGGED: {
      const evidenceByFingerprint = new Map(state.evidenceByFingerprint);
      const prev = evidenceByFingerprint.get(e.fingerprint) ?? { sources: [] };
      evidenceByFingerprint.set(e.fingerprint, {
        ...prev,
        fingerprint: e.fingerprint,
        conflict: true,
        conflictReason: e.reason,
        conflictAt: e.occurred_at,
        resolved: false
      });
      const pending = state.pendingConflicts.some((p) => p.fingerprint === e.fingerprint)
        ? state.pendingConflicts
        : [...state.pendingConflicts, { fingerprint: e.fingerprint, reason: e.reason, at: e.occurred_at, contributionId: e.contribution_id }];
      // 裁定之后出现的冲突证明是“迟到证明”：当前结论保持有效，但标记等待复核。
      return { ...state, evidenceByFingerprint, pendingConflicts: pending };
    }

    case T.EVIDENCE_CONFLICT_RESOLVED: {
      const evidenceByFingerprint = new Map(state.evidenceByFingerprint);
      const prev = evidenceByFingerprint.get(e.fingerprint);
      if (prev) evidenceByFingerprint.set(e.fingerprint, { ...prev, resolved: true, resolution: e.outcome, resolvedAt: e.occurred_at });
      const pendingConflicts = state.pendingConflicts.filter((p) => p.fingerprint !== e.fingerprint);
      return { ...state, evidenceByFingerprint, pendingConflicts };
    }

    default:
      return state;
  }
}

function mergeOfflineDuplicate(state, e) {
  const c = state.contributions.get(e.contribution_id);
  const offlineConfirmations = c.offlineConfirmations.map((o) =>
    o.fingerprint === e.fingerprint
      ? { ...o, duplicateSources: [...(o.duplicateSources ?? []), { channel: e.channel, at: e.occurred_at }] }
      : o
  );
  return patchContribution(state, e.contribution_id, { offlineConfirmations });
}

function patchContribution(state, contributionId, patch) {
  const c = state.contributions.get(contributionId);
  if (!c) return state;
  const contributions = new Map(state.contributions);
  contributions.set(contributionId, { ...c, ...patch });
  return { ...state, contributions };
}

// ---------- 选择器与规则 ----------

export function isConfirmed(c) {
  return c.acknowledgedBy.size > 0 || c.offlineConfirmations.length > 0;
}

// 存在未复核的冲突证明（含裁定之后到达的“迟到证明”）时，需要复核。
export function needsRereview(state) {
  return state.pendingConflicts.length > 0;
}

export function rosterOf(state) {
  // 同一人在同一成果中只占一行；成果本身绝不按人数重复计数。
  const byPerson = new Map();
  for (const c of state.contributions.values()) {
    if (!byPerson.has(c.personId)) byPerson.set(c.personId, { personId: c.personId, personName: c.personName, roles: [] });
    const row = byPerson.get(c.personId);
    if (!row.roles.includes(c.role)) row.roles.push(c.role);
  }
  return [...byPerson.values()];
}

// 当前有效归属结论：异议成立后的更正优先，否则取最近一次独立裁定；自动建议永不作为结论。
export function currentAttribution(state) {
  if (state.corrections.length > 0) {
    const corr = state.corrections[state.corrections.length - 1];
    return { kind: "correction", id: corr.id, at: corr.at, reason: corr.reason, entries: corr.entries };
  }
  if (state.adjudications.length > 0) {
    const adj = state.adjudications[state.adjudications.length - 1];
    return { kind: "adjudication", id: adj.id, at: adj.at, entries: adj.entries };
  }
  return null;
}

// 自动聚合只能产出建议：不检查确认、不检查冲突，显式标注 advisory。
export function suggestAttribution(state, { at } = {}) {
  const entries = [...state.contributions.values()].map((c) => ({
    contribution_id: c.id,
    person_id: c.personId,
    person_name: c.personName,
    role: c.role,
    confirmed: isConfirmed(c)
  }));
  return {
    basis: "auto-aggregation",
    note: "由声明与证明自动聚合生成，仅供独立审核人参考，不构成归属结论",
    at,
    entries
  };
}

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

// 独立裁定的前置规则；返回事件 payload（由服务层加封信封）。
export function decideAdjudication(state, input) {
  const { adjudicatorId, adjudicatorName, rationale, at } = input;
  if (state.contributions.size === 0) throw new DomainError("REVIEW_EMPTY", "尚无贡献声明，无法裁定");
  if (state.pendingConflicts.length > 0) {
    throw new DomainError("EVIDENCE_CONFLICT_PENDING", "存在等待复核的冲突证明，裁定暂缓");
  }
  const entryPeople = new Set();
  for (const entry of input.entries) {
    const c = state.contributions.get(entry.contribution_id);
    if (!c) throw new DomainError("CONTRIBUTION_UNKNOWN", `贡献不存在：${entry.contribution_id}`);
    if (!isConfirmed(c)) throw new DomainError("CONTRIBUTION_UNCONFIRMED", `贡献尚未经当事人确认：${c.personName}`);
    if (entryPeople.has(c.personId)) throw new DomainError("PERSON_DUPLICATED", "同一当事人不能在同一成果中重复计为多行");
    entryPeople.add(c.personId);
  }
  if (entryPeople.has(adjudicatorId)) {
    throw new DomainError("ADJUDICATOR_NOT_INDEPENDENT", "裁定人必须独立于被裁定的团队成员");
  }
  const entries = input.entries.map((entry) => {
    const c = state.contributions.get(entry.contribution_id);
    return {
      contribution_id: c.id,
      person_id: c.personId,
      person_name: c.personName,
      role: entry.role_label ?? c.role,
      duty: c.duty,
      work_period: c.workPeriod
    };
  });
  return { adjudicatorId, adjudicatorName, rationale: rationale ?? null, at, entries };
}

export function decideCorrection(state, input) {
  const dispute = state.disputes.find((d) => d.id === input.disputeId);
  if (!dispute) throw new DomainError("DISPUTE_UNKNOWN", `异议不存在：${input.disputeId}`);
  if (dispute.status !== "open") throw new DomainError("DISPUTE_CLOSED", "异议已有结论，不能再次更正");
  if (input.ruling !== "upheld") throw new DomainError("RULING_NOT_UPHELD", "只有异议成立才生成归属更正");
  const people = new Set();
  for (const entry of input.entries) {
    const c = state.contributions.get(entry.contribution_id);
    if (!c) throw new DomainError("CONTRIBUTION_UNKNOWN", `贡献不存在：${entry.contribution_id}`);
    if (people.has(c.personId)) throw new DomainError("PERSON_DUPLICATED", "同一当事人不能在同一成果中重复计为多行");
    people.add(c.personId);
  }
  if (people.has(input.adjudicatorId)) throw new DomainError("ADJUDICATOR_NOT_INDEPENDENT", "裁定人必须独立于被裁定的团队成员");
  const entries = input.entries.map((entry) => {
    const c = state.contributions.get(entry.contribution_id);
    return { contribution_id: c.id, person_id: c.personId, person_name: c.personName, role: entry.role_label ?? c.role };
  });
  return { dispute, entries };
}
