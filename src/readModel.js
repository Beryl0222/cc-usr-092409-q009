// 读模型：内部查询还原完整团队贡献、同意链与校正理由（含不可变历史）；
// 公众查询只返回当前获准的公开摘要。
import { AGGREGATE_TYPES, EVENT_TYPES as T } from "./events.js";
import { currentAttribution, foldReview, isConfirmed, needsRereview, rosterOf } from "./domain/review.js";
import { activeScopes, foldConsent } from "./domain/consent.js";
import { foldStory, isBlockedForNewRelease } from "./domain/story.js";
import { foldHonor } from "./domain/honor.js";

function toIso(now) {
  return now instanceof Date ? now.toISOString() : now;
}

export class ArchiveQueries {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  async #events() {
    return this.store.allEvents();
  }

  // ---------- 内部视图 ----------

  // 单个成果评定的完整内部视图。
  async internalReview(reviewId, { now = this.clock() } = {}) {
    const all = await this.#events();
    const reviewEvents = all.filter(
      (e) => (e.aggregate_type === AGGREGATE_TYPES.REVIEW && e.aggregate_id === reviewId) || e.review_id === reviewId
    );
    const state = foldReview(reviewEvents);

    const contributions = [...state.contributions.values()].map((c) => ({
      contribution_id: c.id,
      person: { id: c.personId, name: c.personName },
      role: c.role,
      duty: c.duty,
      work_period: c.workPeriod,
      evidence_summary: c.evidenceSummary,
      co_participants: c.coParticipants,
      declared_at: c.declaredAt,
      confirmed: isConfirmed(c),
      acknowledgements: [...c.acknowledgedBy.entries()].map(([by, v]) => ({ by, at: v.at, note: v.note })),
      offline_confirmations: c.offlineConfirmations,
      evidence: c.evidence
    }));

    // 与该成果关联的提名与投票：历史原样保留，更正不回溯。
    const honors = [];
    for (const e of all.filter((x) => x.aggregate_type === AGGREGATE_TYPES.NOMINATION && x.review_id === reviewId)) {
      if (!honors.includes(e.aggregate_id)) honors.push(e.aggregate_id);
    }
    const honorHistory = honors.map((honorId) => {
      const h = foldHonor(all.filter((x) => x.aggregate_type === AGGREGATE_TYPES.NOMINATION && x.aggregate_id === honorId));
      return {
        honor_id: honorId,
        nominations: h.nominations.map((n) => ({
          nomination_id: n.id,
          at: n.at,
          nominee: { id: n.nomineeId, name: n.nomineeName },
          claimed_attribution: n.claimedAttribution // 原始提名说法，保持原样
        })),
        votes: h.votes.map((v) => ({ nomination_id: v.nominationId, at: v.at, voter_id: v.voterId, choice: v.choice }))
      };
    });

    // 公开叙事版本与处置：版本不可变，处置只追加。
    const storyIds = new Set(
      all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY && e.review_id === reviewId).map((e) => e.aggregate_id)
    );
    const publicNarrative = [...storyIds].map((storyId) => {
      const s = foldStory(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY && e.aggregate_id === storyId));
      return {
        story_id: storyId,
        versions: s.versions,
        dispositions: s.dispositions
      };
    });

    // 同意链：授权、部分撤回、有效期与当前状态。
    const consentIds = new Set();
    for (const e of all.filter((x) => x.aggregate_type === AGGREGATE_TYPES.STORY && x.review_id === reviewId && x.event_type === T.STORY_RELEASED)) {
      if (e.consent_id) consentIds.add(e.consent_id);
    }
    const atIso = toIso(now);
    const consentChain = [...consentIds].map((consentId) => {
      const c = foldConsent(all.filter((x) => x.aggregate_type === AGGREGATE_TYPES.CONSENT && x.aggregate_id === consentId));
      return {
        consent_id: consentId,
        patient: { id: c.patientId, name: c.patientName },
        granted_by: c.grantedBy,
        scopes: c.scopes,
        active_scopes: activeScopes(c, { at: atIso }),
        history: c.history
      };
    });

    const current = currentAttribution(state);
    return {
      review_id: reviewId,
      achievement_id: state.achievementId,
      // 成果唯一：无论多少成员共享，achievement_count 恒为 1，不按人数重复计算。
      achievement_count: 1,
      roster: rosterOf(state),
      contributions,
      evidence_conflicts_pending: state.pendingConflicts,
      needs_rereview: needsRereview(state),
      suggestions: state.suggestions, // 仅供参考
      adjudications: state.adjudications,
      disputes: state.disputes,
      corrections: state.corrections, // 校正理由在此还原
      current_attribution: current,
      immutable_history: {
        nominations_and_votes: honorHistory,
        released_versions: publicNarrative
      },
      consent_chain: consentChain
    };
  }

  async internalConsent(consentId, { now = this.clock() } = {}) {
    const all = await this.#events();
    const c = foldConsent(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.CONSENT && e.aggregate_id === consentId));
    return {
      consent_id: consentId,
      patient: { id: c.patientId, name: c.patientName },
      granted_by: c.grantedBy,
      scopes: c.scopes,
      active_scopes: activeScopes(c, { at: toIso(now) }),
      history: c.history,
      withdrawals: c.withdrawals
    };
  }

  // ---------- 公众视图 ----------

  // 公众只能看到当前仍获准的故事摘要与其当前有效归属。
  async publicStories({ now = this.clock() } = {}) {
    const all = await this.#events();
    const atIso = toIso(now);
    const storyIds = [...new Set(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY).map((e) => e.aggregate_id))];
    const visible = [];

    for (const storyId of storyIds) {
      const story = foldStory(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY && e.aggregate_id === storyId));
      const candidate = [...story.versions].reverse().find((v) => !isBlockedForNewRelease(story, v.version));
      if (!candidate) continue;

      const consent = foldConsent(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.CONSENT && e.aggregate_id === story.consentId));
      // 版本可见性按发布时背书的具体 scope 判定：旧版本不会被同渠道的新授权“复活”。
      const scopeIds = candidate.authorized_scope_ids ?? [];
      const permitted =
        scopeIds.length > 0
          ? consent.scopes.some(
              (s) => scopeIds.includes(s.scopeId) && !s.withdrawn && (s.validUntil == null || Date.parse(s.validUntil) >= Date.parse(atIso))
            )
          : // 向后兼容：早期版本未记录 scope 时回退到用途/渠道匹配。
            consent.scopes.some((s) => {
              if (s.withdrawn) return false;
              if (s.purpose !== candidate.purpose || s.channel !== candidate.channel) return false;
              if (s.validUntil != null && Date.parse(s.validUntil) < Date.parse(atIso)) return false;
              return true;
            });
      if (!permitted) continue;

      // 后续材料采用当前有效结论（更正优先），而不是发布时的旧快照。
      const review = foldReview(
        all.filter((e) => (e.aggregate_type === AGGREGATE_TYPES.REVIEW && e.aggregate_id === story.reviewId) || e.review_id === story.reviewId)
      );
      const current = currentAttribution(review);
      visible.push({
        story_id: storyId,
        version: candidate.version,
        channel: candidate.channel,
        purpose: candidate.purpose,
        public_summary: candidate.public_summary,
        attribution: (current?.entries ?? candidate.attribution_snapshot?.entries ?? []).map((e) => ({ name: e.person_name, role: e.role })),
        attribution_basis: current?.kind ?? "release_snapshot",
        released_at: candidate.at
      });
    }
    return visible;
  }
}
