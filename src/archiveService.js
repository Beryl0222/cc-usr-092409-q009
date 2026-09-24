import { AGGREGATE_TYPES, EVENT_TYPES as T, makeEvent } from "./events.js";
import { contentHash as hashOf } from "./fingerprint.js";
import { DomainError, decideAdjudication, decideCorrection, foldReview, suggestAttribution } from "./domain/review.js";
import { foldConsent, isPermitted } from "./domain/consent.js";
import { DISPOSITION, foldStory } from "./domain/story.js";
import { foldHonor } from "./domain/honor.js";
import { FileEventStore } from "./store/eventStore.js";
import { NoticeQueue } from "./store/noticeQueue.js";

const streamOf = {
  profile: (id) => `${AGGREGATE_TYPES.PROFILE}:${id}`,
  honor: (id) => `${AGGREGATE_TYPES.NOMINATION}:${id}`,
  review: (id) => `${AGGREGATE_TYPES.REVIEW}:${id}`,
  contribution: (id) => `${AGGREGATE_TYPES.CONTRIBUTION}:${id}`,
  consent: (id) => `${AGGREGATE_TYPES.CONSENT}:${id}`,
  story: (id) => `${AGGREGATE_TYPES.STORY}:${id}`
};

// 应用服务：所有写操作都在单个存储锁内完成“载入最新历史 → 纯函数裁定 → 追加不可变事件”。
export class ArchiveService {
  constructor(store, notices, { clock = () => new Date() } = {}) {
    this.store = store;
    this.notices = notices;
    this.clock = clock;
  }

  static async create(rootDir, options = {}) {
    const store = new FileEventStore(rootDir);
    const notices = new NoticeQueue(rootDir, options);
    await store.init();
    await notices.init();
    return new ArchiveService(store, notices, { clock: options.clock });
  }

  async pumpNotices(now = this.clock()) {
    return this.notices.pump(now);
  }

  #now(inputNow) {
    return inputNow ? new Date(inputNow) : this.clock();
  }

  #tx(fn) {
    return this.store.withLock(fn);
  }

  async #append(streamId, events, expectedVersion) {
    // 调用方必须已在 #tx 临界区内。
    return this.store.appendUnsafe(streamId, events, expectedVersion);
  }

  async #len(streamId) {
    return this.store.streamLengthUnsafe(streamId);
  }

  // ---------- 人员与提名 ----------

  async registerPerson({ personId, name, title = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const sid = streamOf.profile(personId);
      if ((await this.#len(sid)) > 0) throw new DomainError("PROFILE_EXISTS", `人员已登记：${personId}`);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.PROFILE_REGISTERED,
            aggregateType: AGGREGATE_TYPES.PROFILE,
            aggregateId: personId,
            version: 1,
            now: at,
            summary: `登记团队成员：${name}`,
            payload: { person_id: personId, person_name: name, title }
          })
        ],
        0
      );
      return personId;
    });
  }

  async submitNomination({ honorId, achievementId, nominationId, nomineeId, nomineeName, claimedAttribution, reviewId = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const sid = streamOf.honor(honorId);
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.NOMINATION_SUBMITTED,
            aggregateType: AGGREGATE_TYPES.NOMINATION,
            aggregateId: honorId,
            version: expected + 1,
            now: at,
            summary: `提交提名：${nomineeName}`,
            payload: {
              honor_id: honorId,
              achievement_id: achievementId,
              nomination_id: nominationId,
              nominee_id: nomineeId,
              nominee_name: nomineeName,
              claimed_attribution: claimedAttribution ?? null,
              review_id: reviewId
            }
          })
        ],
        expected
      );
      return nominationId;
    });
  }

  async vote({ honorId, nominationId, voterId, choice, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const sid = streamOf.honor(honorId);
      const state = foldHonor(await this.store.load(sid));
      if (!state.nominations.some((n) => n.id === nominationId)) throw new DomainError("NOMINATION_UNKNOWN", `提名不存在：${nominationId}`);
      if (state.votes.some((v) => v.nominationId === nominationId && v.voterId === voterId)) {
        throw new DomainError("VOTE_DUPLICATED", "同一投票人已对该提名投票");
      }
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.NOMINATION_VOTED,
            aggregateType: AGGREGATE_TYPES.NOMINATION,
            aggregateId: honorId,
            version: expected + 1,
            now: at,
            summary: `${voterId} 对提名 ${nominationId} 投出 ${choice}`,
            payload: { nomination_id: nominationId, voter_id: voterId, choice }
          })
        ],
        expected
      );
    });
  }

  // ---------- 贡献声明、确认、证据 ----------

  async declareContribution(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { reviewId, achievementId, contributionId, personId, personName, role, duty, workPeriod, evidenceSummary, coParticipants = [] } = input;
      const sid = streamOf.contribution(contributionId);
      if ((await this.#len(sid)) > 0) throw new DomainError("CONTRIBUTION_EXISTS", `贡献声明已存在：${contributionId}`);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.CONTRIBUTION_DECLARED,
            aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
            aggregateId: contributionId,
            version: 1,
            now: at,
            summary: `${personName} 就成果 ${achievementId} 声明贡献：${role}`,
            payload: {
              review_id: reviewId,
              achievement_id: achievementId,
              contribution_id: contributionId,
              person_id: personId,
              person_name: personName,
              role,
              duty,
              work_period: workPeriod,
              evidence_summary: evidenceSummary,
              co_participants: coParticipants
            }
          })
        ],
        0
      );
      return contributionId;
    });
  }

  async acknowledgeContribution({ contributionId, acknowledgedBy, note = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const sid = streamOf.contribution(contributionId);
      const review = await this.#loadReviewForContribution(contributionId);
      const c = review?.contributions.get(contributionId);
      if (!c) throw new DomainError("CONTRIBUTION_UNKNOWN", `贡献不存在：${contributionId}`);
      if (c.acknowledgedBy.has(acknowledgedBy)) return; // 当事人重复确认幂等
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.CONTRIBUTION_ACKNOWLEDGED,
            aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
            aggregateId: contributionId,
            version: expected + 1,
            now: at,
            summary: `当事人 ${acknowledgedBy} 确认贡献 ${contributionId}`,
            payload: { review_id: review.reviewId, contribution_id: contributionId, acknowledged_by: acknowledgedBy, note }
          })
        ],
        expected
      );
    });
  }

  // 提交证明：按指纹归并重复材料；同指纹不同内容则挂起等待复核。
  async submitEvidence({ contributionId, fingerprint, content, summary, channel = "online", now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const digest = hashOf(content);
      const review = await this.#loadReviewForContribution(contributionId);
      if (!review) throw new DomainError("CONTRIBUTION_UNKNOWN", `贡献不存在：${contributionId}`);
      const known = review.evidenceByFingerprint.get(fingerprint);
      const sid = streamOf.contribution(contributionId);
      const expected = await this.#len(sid);
      const base = { review_id: review.reviewId, contribution_id: contributionId, fingerprint };

      if (known && known.lastContentHash === digest) {
        await this.#append(
          sid,
          [
            makeEvent({
              eventType: T.DUPLICATE_MERGED,
              aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
              aggregateId: contributionId,
              version: expected + 1,
              now: at,
              summary: `重复证明按指纹归并：${fingerprint}`,
              payload: { ...base, duplicate_channel: channel, content_hash: digest, via: "evidence" }
            })
          ],
          expected
        );
        return { merged: true, conflict: false };
      }

      const events = [
        makeEvent({
          eventType: T.EVIDENCE_SUBMITTED,
          aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
          aggregateId: contributionId,
          version: expected + 1,
          now: at,
          summary: `提交证明（${channel}）：${summary}`,
          payload: { ...base, content_hash: digest, channel, summary }
        })
      ];
      let conflict = false;
      if (known && known.lastContentHash !== digest) {
        conflict = true;
        events.push(
          makeEvent({
            eventType: T.EVIDENCE_CONFLICT_FLAGGED,
            aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
            aggregateId: contributionId,
            version: expected + 2,
            now: at,
            summary: `同一指纹出现不同内容，等待复核：${fingerprint}`,
            payload: { ...base, reason: "同指纹内容不一致", prior_hash: known.lastContentHash, incoming_hash: digest }
          })
        );
      }
      await this.#append(sid, events, expected);
      return { merged: false, conflict, late: review.adjudications.length > 0 };
    });
  }

  // 离线（纸质/口头见证）确认：按指纹归并，内容冲突则等待复核。
  async recordOfflineConfirmation(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { contributionId, fingerprint, confirmerId, confirmerName, witness = null, channel = "paper", content } = input;
      const digest = hashOf(content ?? { contributionId, confirmerId, fingerprint });
      const review = await this.#loadReviewForContribution(contributionId);
      if (!review) throw new DomainError("CONTRIBUTION_UNKNOWN", `贡献不存在：${contributionId}`);
      const c = review.contributions.get(contributionId);
      const sid = streamOf.contribution(contributionId);
      const expected = await this.#len(sid);
      const base = { review_id: review.reviewId, contribution_id: contributionId, fingerprint };

      const existing = c.offlineConfirmations.find((o) => o.fingerprint === fingerprint);
      if (existing) {
        if (existing.contentHash === digest) {
          await this.#append(
            sid,
            [
              makeEvent({
                eventType: T.DUPLICATE_MERGED,
                aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
                aggregateId: contributionId,
                version: expected + 1,
                now: at,
                summary: `离线确认重复，按指纹归并：${fingerprint}`,
                payload: { ...base, duplicate_channel: channel, content_hash: digest, via: "offline_confirmation" }
              })
            ],
            expected
          );
          return { merged: true, conflict: false };
        }
        await this.#append(
          sid,
          [
            makeEvent({
              eventType: T.EVIDENCE_CONFLICT_FLAGGED,
              aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
              aggregateId: contributionId,
              version: expected + 1,
              now: at,
              summary: `离线确认与既有内容冲突，等待复核：${fingerprint}`,
              payload: { ...base, reason: "离线确认内容不一致", prior_hash: existing.contentHash, incoming_hash: digest }
            })
          ],
          expected
        );
        return { merged: false, conflict: true };
      }

      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.OFFLINE_CONFIRMATION_RECORDED,
            aggregateType: AGGREGATE_TYPES.CONTRIBUTION,
            aggregateId: contributionId,
            version: expected + 1,
            now: at,
            summary: `记录${confirmerName}的离线确认（${channel}）`,
            payload: {
              ...base,
              confirmer_id: confirmerId,
              confirmer_name: confirmerName,
              witness,
              channel,
              content_hash: digest
            }
          })
        ],
        expected
      );
      return { merged: false, conflict: false };
    });
  }

  // ---------- 自动建议与独立裁定 ----------

  // 复核冲突/迟到证明：给出结论后解除挂起；若结论改变归属，应另行走异议-更正流程。
  async resolveEvidenceConflict({ reviewId, fingerprint, outcome, reviewerId, note = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const allowed = new Set(["accept_incoming", "retain_existing", "inconclusive"]);
      if (!allowed.has(outcome)) throw new DomainError("OUTCOME_INVALID", `未知复核结论：${outcome}`);
      const state = await this.#loadReview(reviewId);
      if (!state.pendingConflicts.some((p) => p.fingerprint === fingerprint)) {
        throw new DomainError("CONFLICT_UNKNOWN", `没有等待复核的冲突指纹：${fingerprint}`);
      }
      const pending = state.pendingConflicts.find((p) => p.fingerprint === fingerprint);
      const sid = streamOf.review(reviewId);
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.EVIDENCE_CONFLICT_RESOLVED,
            aggregateType: AGGREGATE_TYPES.REVIEW,
            aggregateId: reviewId,
            version: expected + 1,
            now: at,
            summary: `冲突证明 ${fingerprint} 复核结论：${outcome}`,
            payload: {
              review_id: reviewId,
              contribution_id: pending.contributionId,
              fingerprint,
              outcome,
              reviewer_id: reviewerId,
              note
            }
          })
        ],
        expected
      );
    });
  }

  async #reviewEvents(reviewId) {
    const all = await this.store.allEvents();
    return all.filter(
      (e) => (e.aggregate_type === AGGREGATE_TYPES.REVIEW && e.aggregate_id === reviewId) || e.review_id === reviewId
    );
  }

  async #loadReview(reviewId) {
    return foldReview(await this.#reviewEvents(reviewId));
  }

  async #loadReviewForContribution(contributionId) {
    const all = await this.store.allEvents();
    const declared = all.find(
      (e) => e.aggregate_type === AGGREGATE_TYPES.CONTRIBUTION && e.aggregate_id === contributionId && e.event_type === T.CONTRIBUTION_DECLARED
    );
    if (!declared) return null;
    return foldReview(
      all.filter(
        (e) => e.review_id === declared.review_id || (e.aggregate_type === AGGREGATE_TYPES.REVIEW && e.aggregate_id === declared.review_id)
      )
    );
  }

  async generateSuggestion({ reviewId, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const state = await this.#loadReview(reviewId);
      if (state.contributions.size === 0) throw new DomainError("REVIEW_EMPTY", "尚无贡献声明，无法生成建议");
      const suggestion = suggestAttribution(state, { at: at.toISOString() });
      const sid = streamOf.review(reviewId);
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.ATTRIBUTION_SUGGESTED,
            aggregateType: AGGREGATE_TYPES.REVIEW,
            aggregateId: reviewId,
            version: expected + 1,
            now: at,
            summary: "自动聚合生成归属建议（仅供参考，不构成结论）",
            payload: { basis: suggestion.basis, note: suggestion.note, entries: suggestion.entries }
          })
        ],
        expected
      );
      return suggestion;
    });
  }

  // 独立审核人裁定。expectedVersion 为外部读取的版本号，用于乐观并发；缺省在事务内取最新。
  async adjudicate(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { reviewId } = input;
      const sid = streamOf.review(reviewId);
      const expected = input.expectedVersion ?? (await this.#len(sid));
      const state = foldReview(await this.#reviewEvents(reviewId));
      const decision = decideAdjudication(state, { ...input, at: at.toISOString() });
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.ATTRIBUTION_ADJUDICATED,
            aggregateType: AGGREGATE_TYPES.REVIEW,
            aggregateId: reviewId,
            version: expected + 1,
            now: at,
            summary: `独立审核人 ${decision.adjudicatorName} 裁定 ${decision.entries.length} 名成员的贡献归属`,
            payload: {
              adjudication_id: input.adjudicationId,
              adjudicator_id: decision.adjudicatorId,
              adjudicator_name: decision.adjudicatorName,
              entries: decision.entries,
              rationale: decision.rationale
            }
          })
        ],
        expected
      );
      return { adjudicationId: input.adjudicationId, entries: decision.entries };
    });
  }

  // ---------- 异议与更正 ----------

  async fileDispute({ reviewId, disputeId, claimantId, reason, deadline = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const existing = await this.#loadReview(reviewId);
      if (existing.disputes.some((d) => d.id === disputeId)) {
        throw new DomainError("DISPUTE_EXISTS", `异议已存在：${disputeId}`);
      }
      const sid = streamOf.review(reviewId);
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.DISPUTE_FILED,
            aggregateType: AGGREGATE_TYPES.REVIEW,
            aggregateId: reviewId,
            version: expected + 1,
            now: at,
            summary: `当事人 ${claimantId} 提出归属异议：${reason}`,
            payload: { dispute_id: disputeId, claimant_id: claimantId, reason, deadline }
          })
        ],
        expected
      );
      // 异议期限到期提醒：持久化，重启后继续。
      if (deadline) {
        await this.notices.enqueue({
          kind: "dispute_deadline",
          dueAt: deadline,
          target: { reviewId, disputeId },
          payload: { claimantId, reason },
          dedupeKey: `dispute:${reviewId}:${disputeId}`
        });
      }
      return disputeId;
    });
  }

  async resolveDispute(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { reviewId, disputeId, ruling, adjudicatorId, rationale = null } = input;
      const sid = streamOf.review(reviewId);
      const expected = input.expectedVersion ?? (await this.#len(sid));
      const state = foldReview(await this.#reviewEvents(reviewId));

      const events = [
        makeEvent({
          eventType: T.DISPUTE_RESOLVED,
          aggregateType: AGGREGATE_TYPES.REVIEW,
          aggregateId: reviewId,
          version: expected + 1,
          now: at,
          summary: `异议 ${disputeId} 结论：${ruling === "upheld" ? "成立" : "不成立"}`,
          payload: { dispute_id: disputeId, ruling, adjudicator_id: adjudicatorId, rationale }
        })
      ];

      if (ruling === "upheld") {
        const { entries } = decideCorrection(state, { ...input, at: at.toISOString() });
        events.push(
          makeEvent({
            eventType: T.ATTRIBUTION_CORRECTED,
            aggregateType: AGGREGATE_TYPES.REVIEW,
            aggregateId: reviewId,
            version: expected + 2,
            now: at,
            summary: `异议成立，生成归属更正：${disputeId}`,
            payload: {
              correction_id: input.correctionId,
              dispute_id: disputeId,
              reason: input.reason ?? state.disputes.find((d) => d.id === disputeId)?.reason,
              entries,
              corrected_by: adjudicatorId
            }
          })
        );
      }
      await this.#append(sid, events, expected);
    });
  }

  // ---------- 患者同意 ----------

  async grantConsent(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { consentId, patientId, patientName, grantedBy = "patient", scopes } = input;
      if (!Array.isArray(scopes) || scopes.length === 0) throw new DomainError("CONSENT_SCOPE_EMPTY", "同意至少包含一个用途/渠道范围");
      const sid = streamOf.consent(consentId);
      const expected = await this.#len(sid);
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.CONSENT_GRANTED,
            aggregateType: AGGREGATE_TYPES.CONSENT,
            aggregateId: consentId,
            version: expected + 1,
            now: at,
            summary: `${grantedBy === "family" ? "家属" : "患者"} ${patientName} 授予 ${scopes.length} 项公开授权`,
            payload: { consent_id: consentId, patient_id: patientId, patient_name: patientName, granted_by: grantedBy, scopes }
          })
        ],
        expected
      );
      return consentId;
    });
  }

  // 撤回（可部分）：只阻止新的发布，并为已发布版本追加处置；历史版本保持原样。
  async withdrawConsent({ consentId, scopeIds, reason = null, now }) {
    return this.#tx(async () => {
      const at = this.#now(now);
      const consentSid = streamOf.consent(consentId);
      const expected = await this.#len(consentSid);
      if (expected === 0) throw new DomainError("CONSENT_UNKNOWN", `同意记录不存在：${consentId}`);
      const consentState = foldConsent(await this.store.load(consentSid));
      const targets = new Set(scopeIds);
      // 已撤回的授权不再重复处理（撤回幂等）。
      const scopes = consentState.scopes.filter((s) => targets.has(s.scopeId) && !s.withdrawn);
      if (scopes.length === 0) {
        const anyScope = consentState.scopes.some((s) => targets.has(s.scopeId));
        throw new DomainError(
          anyScope ? "SCOPE_ALREADY_WITHDRAWN" : "SCOPE_UNKNOWN",
          anyScope ? "授权范围均已撤回" : "没有匹配的授权范围可撤回"
        );
      }
      const withdrawnScopeIds = scopes.map((s) => s.scopeId);

      await this.#append(
        consentSid,
        [
          makeEvent({
            eventType: T.CONSENT_WITHDRAWN,
            aggregateType: AGGREGATE_TYPES.CONSENT,
            aggregateId: consentId,
            version: expected + 1,
            now: at,
            summary: `撤回 ${withdrawnScopeIds.length} 项公开授权${reason ? `：${reason}` : ""}`,
            payload: { consent_id: consentId, scope_ids: withdrawnScopeIds, reason }
          })
        ],
        expected
      );

      // 为命中撤回 scope 的已发布版本追加处置（公开版本本身不改写）。
      const stories = await this.#storiesOfPatient(consentState.patientId);
      for (const { storyId, state } of stories) {
        const hitVersions = state.versions
          .filter((v) => (v.authorized_scope_ids ?? []).some((id) => targets.has(id)))
          .map((v) => v.version);
        if (hitVersions.length === 0) continue;
        const storySid = streamOf.story(storyId);
        const storyExpected = await this.#len(storySid);
        await this.#append(
          storySid,
          [
            makeEvent({
              eventType: T.STORY_DISPOSITION_APPENDED,
              aggregateType: AGGREGATE_TYPES.STORY,
              aggregateId: storyId,
              version: storyExpected + 1,
              now: at,
              summary: `患者撤回授权，版本 ${hitVersions.join(", ")} 停止新发布并追加撤回说明`,
              payload: {
                story_id: storyId,
                disposition: DISPOSITION.WITHDRAWAL_NOTICE,
                target_versions: hitVersions,
                blocks_new_release: true,
                reason,
                notice_text: "该版本所依据的部分公开授权已由患者（或家属）撤回，停止用于新的发布。"
              }
            })
          ],
          storyExpected
        );

        for (const version of hitVersions) {
          await this.notices.enqueue({
            kind: "withdrawal_notice",
            dueAt: at,
            target: { storyId, version },
            payload: { consentId, scopeIds: withdrawnScopeIds, reason },
            dedupeKey: `withdraw:${storyId}:v${version}:${[...withdrawnScopeIds].sort().join(",")}`
          });
        }
      }
    });
  }

  async #storiesOfPatient(patientId) {
    const all = await this.store.allEvents();
    const ids = new Set(
      all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY && e.patient_id === patientId).map((e) => e.aggregate_id)
    );
    return [...ids].map((storyId) => ({
      storyId,
      state: foldStory(all.filter((e) => e.aggregate_type === AGGREGATE_TYPES.STORY && e.aggregate_id === storyId))
    }));
  }

  async releaseStory(input) {
    return this.#tx(async () => {
      const at = this.#now(input.now);
      const { storyId, consentId, reviewId, purpose, channel, fields = [], publicSummary } = input;
      const consentSid = streamOf.consent(consentId);
      const consentState = foldConsent(await this.store.load(consentSid));
      if (!consentState.exists) throw new DomainError("CONSENT_UNKNOWN", `同意记录不存在：${consentId}`);
      if (!isPermitted(consentState, { purpose, channel, fields, at: at.toISOString() })) {
        throw new DomainError("CONSENT_DENIED", `当前授权不允许以 ${channel} 面向「${purpose}」披露这些字段`);
      }
      // 记录实际为本次发布背书的授权项；撤回按 scope 精确命中版本。
      const authorizingScopes = consentState.scopes.filter(
        (s) =>
          !s.withdrawn &&
          s.purpose === purpose &&
          s.channel === channel &&
          (s.validUntil == null || Date.parse(s.validUntil) >= Date.parse(at.toISOString())) &&
          (fields.length === 0 || fields.every((f) => (s.fields ?? []).includes(f)))
      );
      const reviewState = await this.#loadReview(reviewId);
      const attribution = reviewState.corrections.length
        ? { kind: "correction", ...latestCorrection(reviewState) }
        : reviewState.adjudications.length
          ? { kind: "adjudication", ...latestAdjudication(reviewState) }
          : null;
      if (!attribution) throw new DomainError("ATTRIBUTION_MISSING", "成果归属未经独立裁定，不得对外发布");
      if (reviewState.pendingConflicts.length > 0) throw new DomainError("EVIDENCE_CONFLICT_PENDING", "存在等待复核的冲突证明，暂缓发布");

      const sid = streamOf.story(storyId);
      const state = foldStory(await this.store.load(sid));
      const expected = await this.#len(sid);
      if (expected !== state.versions.length + state.dispositions.length) {
        throw new DomainError("STREAM_STATE_MISMATCH", `故事流状态异常：${storyId}`);
      }
      const nextVersion = state.versions.length + 1;
      await this.#append(
        sid,
        [
          makeEvent({
            eventType: T.STORY_RELEASED,
            aggregateType: AGGREGATE_TYPES.STORY,
            aggregateId: storyId,
            version: expected + 1,
            now: at,
            summary: `发布公开叙事版本 ${nextVersion}（${channel} / ${purpose}）`,
            payload: {
              story_id: storyId,
              patient_id: consentState.patientId,
              consent_id: consentId,
              review_id: reviewId,
              story_version: nextVersion,
              purpose,
              channel,
              disclosed_fields: fields,
              authorized_scope_ids: authorizingScopes.map((s) => s.scopeId),
              public_summary: publicSummary,
              attribution_snapshot: {
                basis: attribution.kind,
                entries: attribution.entries.map((e) => ({ person_name: e.person_name, role: e.role }))
              }
            }
          })
        ],
        expected
      );
      return { storyId, version: nextVersion };
    });
  }
}

function latestCorrection(state) {
  const c = state.corrections[state.corrections.length - 1];
  return { id: c.id, at: c.at, reason: c.reason, entries: c.entries };
}

function latestAdjudication(state) {
  const a = state.adjudications[state.adjudications.length - 1];
  return { id: a.id, at: a.at, entries: a.entries };
}

export { DomainError };
