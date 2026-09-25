import { EventLog } from "./eventLog.js";
import { fingerprintOf } from "./fingerprint.js";
import { ConflictError, ConsentError, DomainError, NotFoundError } from "./errors.js";

const pairKey = (purpose, channel) => `${purpose}|${channel}`;

function freshState() {
  return {
    profiles: new Map(),
    statements: new Map(),
    achievements: new Map(),
    grants: new Map(),
    stories: new Map(),
    objections: new Map(),
    notices: new Map(),
  };
}

// 归约器：只根据事件推进状态，不做任何校验；校验全部在命令侧完成。
const reducers = {
  PROFILE_REGISTERED(state, p, e) {
    state.profiles.set(e.aggregate_id, {
      id: e.aggregate_id,
      displayName: p.displayName,
      note: p.note ?? null,
      registeredAt: e.occurred_at,
    });
  },
  CONTRIBUTION_SUBMITTED(state, p, e) {
    state.statements.set(e.aggregate_id, {
      id: e.aggregate_id,
      contributorId: p.contributorId,
      role: p.role,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      evidenceSummary: p.evidenceSummary,
      coParticipants: [...p.coParticipants],
      achievementHint: p.achievementHint ?? null,
      status: "draft",
      achievementId: null,
      reviewedBy: null,
      proofs: p.proof ? [p.proof] : [],
      confirmations: [],
      conflicts: [],
      version: e.version,
    });
  },
  CONTRIBUTION_CONFIRMED(state, p, e) {
    const s = state.statements.get(e.aggregate_id);
    s.confirmations.push({
      confirmerId: p.confirmerId,
      fingerprint: p.fingerprint,
      offline: p.offline,
      merged: p.merged,
      at: e.occurred_at,
    });
    if (!p.merged && s.status === "draft") s.status = "confirmed";
  },
  PROOF_ATTACHED(state, p) {
    const s = state.statements.get(p.statementId);
    if (p.merged) {
      const existing = s.proofs.find((x) => x.fingerprint === p.proof.fingerprint);
      const source = p.proof.sources[0];
      if (existing && !existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    s.proofs.push(p.proof);
  },
  CONTRIBUTION_FLAGGED_FOR_REVIEW(state, p, e) {
    const s = state.statements.get(e.aggregate_id);
    s.status = "pending_review";
    s.conflicts.push({ fingerprint: p.fingerprint, reason: p.reason, at: e.occurred_at });
    if (p.achievementId) {
      const credit = state.achievements
        .get(p.achievementId)
        ?.credits.find((c) => c.statementId === e.aggregate_id);
      if (credit) credit.suspended = true;
    }
  },
  ACHIEVEMENT_REGISTERED(state, p, e) {
    state.achievements.set(e.aggregate_id, {
      id: e.aggregate_id,
      title: p.title,
      credits: [],
      corrections: [],
      registeredAt: e.occurred_at,
    });
  },
  CONTRIBUTION_ADJUDICATED(state, p, e) {
    const s = state.statements.get(e.aggregate_id);
    s.status = "adjudicated";
    s.achievementId = p.achievementId;
    s.reviewedBy = p.reviewerId;
    const ach = state.achievements.get(p.achievementId);
    const existing = ach.credits.find((c) => c.statementId === e.aggregate_id);
    if (existing) {
      existing.role = p.role;
      existing.suspended = false;
    } else {
      ach.credits.push({
        statementId: e.aggregate_id,
        contributorId: s.contributorId,
        role: p.role,
        suspended: false,
      });
    }
  },
  CONSENT_GRANTED(state, p, e) {
    const activePairs = new Set();
    for (const purpose of p.purposes)
      for (const channel of p.channels) activePairs.add(pairKey(purpose, channel));
    state.grants.set(e.aggregate_id, {
      id: e.aggregate_id,
      subjectId: p.subjectId,
      storyRef: p.storyRef,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      summary: p.summary,
      activePairs,
      withdrawals: [],
      status: "active",
    });
  },
  CONSENT_WITHDRAWN(state, p, e) {
    const g = state.grants.get(e.aggregate_id);
    for (const [purpose, channel] of p.withdrawnPairs) g.activePairs.delete(pairKey(purpose, channel));
    g.withdrawals.push({ purposes: [...p.purposes], channels: [...p.channels], at: p.at });
    if (g.activePairs.size === 0) g.status = "withdrawn";
  },
  STORY_RELEASED(state, p, e) {
    let story = state.stories.get(e.aggregate_id);
    if (!story) {
      story = { id: e.aggregate_id, versions: new Map() };
      state.stories.set(e.aggregate_id, story);
    }
    story.versions.set(p.version, {
      version: p.version,
      purpose: p.purpose,
      channel: p.channel,
      releasedAt: p.releasedAt,
      summary: p.summary,
      grantId: p.grantId,
      dispositions: [],
    });
  },
  RELEASE_DISPOSITION_APPENDED(state, p, e) {
    const v = state.stories.get(e.aggregate_id)?.versions.get(p.version);
    if (v) v.dispositions.push({ kind: p.kind, note: p.note, at: p.at });
  },
  WITHDRAWAL_NOTICE_QUEUED(state, p, e) {
    state.notices.set(p.noticeId, {
      id: p.noticeId,
      grantId: e.aggregate_id,
      storyRef: p.storyRef,
      withdrawnPairs: p.withdrawnPairs.map(([purpose, channel]) => ({ purpose, channel })),
      affected: p.affected.map((a) => ({ ...a })),
      queuedAt: p.at,
      delivered: false,
    });
  },
  WITHDRAWAL_NOTICE_DELIVERED(state, p) {
    const n = state.notices.get(p.noticeId);
    if (n) n.delivered = true;
  },
  OBJECTION_FILED(state, p, e) {
    state.objections.set(e.aggregate_id, {
      id: e.aggregate_id,
      targetType: p.targetType,
      targetId: p.targetId,
      reason: p.reason,
      filedBy: p.filedBy,
      deadline: p.deadline,
      filedAt: e.occurred_at,
      status: "open",
      resolution: null,
    });
  },
  OBJECTION_RESOLVED(state, p, e) {
    const o = state.objections.get(e.aggregate_id);
    o.status = p.upheld ? "upheld" : "dismissed";
    o.resolution = { reviewerId: p.reviewerId, rationale: p.rationale, at: e.occurred_at };
  },
  ATTRIBUTION_CORRECTED(state, p, e) {
    const ach = state.achievements.get(e.aggregate_id);
    ach.corrections.push({
      objectionId: p.objectionId,
      before: p.before,
      after: p.after,
      rationale: p.rationale,
      at: e.occurred_at,
    });
    ach.credits = p.after.map((c) => ({
      statementId: c.statementId ?? null,
      contributorId: c.contributorId,
      role: c.role,
      suspended: false,
    }));
  },
};

// 贡献与公开叙事档案服务：命令校验 → 追加事件 → 归约状态；重启后重放日志恢复。
export class HonorArchiveService {
  constructor({ filePath = null, now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.log = new EventLog(filePath);
    this.state = freshState();
    this.aggregateVersions = new Map();
    this.seq = 0;
    for (const event of this.log.events) this.#apply(event);
  }

  // ---------- 事件基础设施 ----------

  #emit(eventType, aggregateType, aggregateId, payload, summary) {
    const version = (this.aggregateVersions.get(aggregateId) ?? 0) + 1;
    const event = {
      event_id: `evt-${String(this.seq + 1).padStart(6, "0")}`,
      seq: this.seq + 1,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      version,
      summary,
      payload,
    };
    this.log.append(event);
    this.#apply(event);
    return event;
  }

  #apply(event) {
    this.seq = Math.max(this.seq, event.seq);
    this.aggregateVersions.set(event.aggregate_id, event.version);
    const reducer = reducers[event.event_type];
    if (!reducer) throw new DomainError(`未知事件类型：${event.event_type}`);
    reducer(this.state, event.payload, event);
    const stmt = this.state.statements.get(event.aggregate_id);
    if (stmt) stmt.version = event.version;
  }

  #requireStatement(statementId) {
    const s = this.state.statements.get(statementId);
    if (!s) throw new NotFoundError(`贡献声明不存在：${statementId}`);
    return s;
  }

  #requireAchievement(achievementId) {
    const a = this.state.achievements.get(achievementId);
    if (!a) throw new NotFoundError(`成果不存在：${achievementId}`);
    return a;
  }

  #requireGrant(grantId) {
    const g = this.state.grants.get(grantId);
    if (!g) throw new NotFoundError(`同意记录不存在：${grantId}`);
    return g;
  }

  #requireObjection(objectionId) {
    const o = this.state.objections.get(objectionId);
    if (!o) throw new NotFoundError(`异议不存在：${objectionId}`);
    return o;
  }

  #proofEntry(proof, defaultSource) {
    return {
      fingerprint: fingerprintOf(proof.content ?? proof),
      evidenceSummary: proof.evidenceSummary ?? null,
      sources: [proof.source ?? defaultSource],
      receivedAt: this.now(),
    };
  }

  // ---------- 提名档案 ----------

  registerNominee({ profileId, displayName, note = null }) {
    if (this.state.profiles.has(profileId)) throw new ConflictError(`提名档案已存在：${profileId}`);
    this.#emit("PROFILE_REGISTERED", "nominee_profile", profileId, { displayName, note }, `登记提名档案：${displayName}`);
  }

  // ---------- 贡献声明 ----------

  submitStatement({
    statementId,
    contributorId,
    role,
    periodStart,
    periodEnd,
    evidenceSummary,
    coParticipants = [],
    achievementHint = null,
    proof = null,
  }) {
    if (this.state.statements.has(statementId)) throw new ConflictError(`贡献声明已存在：${statementId}`);
    for (const [key, value] of Object.entries({ statementId, contributorId, role, periodStart, periodEnd, evidenceSummary }))
      if (!value) throw new DomainError(`缺少必要字段：${key}`);
    this.#emit(
      "CONTRIBUTION_SUBMITTED",
      "contribution_record",
      statementId,
      {
        contributorId,
        role,
        periodStart,
        periodEnd,
        evidenceSummary,
        coParticipants,
        achievementHint,
        proof: proof ? this.#proofEntry(proof, "submission") : null,
      },
      `登记贡献声明：${contributorId} 担任「${role}」`,
    );
    return this.internalStatementView(statementId);
  }

  // 当事人确认；离线确认按指纹归并，重复确认只留痕不改变状态。
  confirmStatement({ statementId, confirmerId, offlineProof = null }) {
    const stmt = this.#requireStatement(statementId);
    if (confirmerId !== stmt.contributorId) throw new DomainError("须由当事人本人确认贡献声明");
    const fingerprint = fingerprintOf({ statementId, confirmerId, offline: offlineProof?.content ?? null });
    const merged = stmt.confirmations.some((c) => c.fingerprint === fingerprint);
    this.#emit(
      "CONTRIBUTION_CONFIRMED",
      "contribution_record",
      statementId,
      { confirmerId, fingerprint, merged, offline: Boolean(offlineProof) },
      merged ? `归并重复确认：${statementId}` : `当事人确认贡献声明：${statementId}`,
    );
    return this.internalStatementView(statementId);
  }

  // 补充证明（含迟到证明）：按指纹归并重复件；与已登记证据摘要冲突时挂起等待复核。
  attachProof({ statementId, proof, source = "offline" }) {
    const stmt = this.#requireStatement(statementId);
    const entry = this.#proofEntry(proof, source);
    const duplicate = stmt.proofs.some((p) => p.fingerprint === entry.fingerprint);
    this.#emit(
      "PROOF_ATTACHED",
      "contribution_record",
      statementId,
      { statementId, proof: entry, merged: duplicate },
      duplicate ? `归并重复证明：${statementId}` : `补充证明：${statementId}`,
    );
    const conflicts =
      entry.evidenceSummary && stmt.evidenceSummary && entry.evidenceSummary !== stmt.evidenceSummary;
    if (!duplicate && conflicts) {
      this.#emit(
        "CONTRIBUTION_FLAGGED_FOR_REVIEW",
        "contribution_record",
        statementId,
        { reason: "证明与已登记证据摘要冲突", fingerprint: entry.fingerprint, achievementId: stmt.achievementId },
        `证明内容冲突，等待复核：${statementId}`,
      );
    }
    return this.internalStatementView(statementId);
  }

  // 自动聚合：只给出建议分组，不改动任何归属状态。
  suggestAggregation() {
    const pool = [...this.state.statements.values()].filter((s) => s.status === "confirmed");
    const parent = new Map(pool.map((s) => [s.id, s.id]));
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const overlaps = (a, b) => a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
    const linked = (a, b) =>
      a.coParticipants.includes(b.contributorId) ||
      b.coParticipants.includes(a.contributorId) ||
      a.coParticipants.some((p) => b.coParticipants.includes(p));
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        const a = pool[i];
        const b = pool[j];
        const sameHint = a.achievementHint && a.achievementHint === b.achievementHint;
        if (sameHint || (linked(a, b) && overlaps(a, b))) union(a.id, b.id);
      }
    }
    const groups = new Map();
    for (const s of pool) {
      const root = find(s.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(s);
    }
    return [...groups.values()].map((members, index) => ({
      suggestion: `suggestion-${index + 1}`,
      statementIds: members.map((m) => m.id),
      contributorIds: [...new Set(members.map((m) => m.contributorId))],
      rationale: "按共同参与者、工作时段与成果线索自动聚合，仅供审核人参考，不构成归属结论",
    }));
  }

  // 独立审核人裁定归属；expectedVersion 提供乐观并发控制。
  adjudicate({
    statementId,
    reviewerId,
    achievementId = null,
    achievementTitle = null,
    role = null,
    expectedVersion = undefined,
  }) {
    const stmt = this.#requireStatement(statementId);
    if (stmt.status !== "confirmed" && stmt.status !== "pending_review")
      throw new DomainError(`当前状态不可裁定：${stmt.status}`);
    if (reviewerId === stmt.contributorId || stmt.coParticipants.includes(reviewerId))
      throw new DomainError("审核人必须独立于当事人与共同参与者");
    if (expectedVersion !== undefined && expectedVersion !== stmt.version)
      throw new ConflictError(`裁定冲突：声明已变为版本 ${stmt.version}，请刷新后重试`);

    const reAdjudication = stmt.achievementId !== null;
    if (reAdjudication && achievementId && achievementId !== stmt.achievementId)
      throw new DomainError("归属变更须通过异议更正流程，不得在复核中直接改挂");

    let achId = achievementId ?? stmt.achievementId;
    let achievement = achId ? this.state.achievements.get(achId) : null;
    if (achId && !achievement) throw new NotFoundError(`成果不存在：${achId}`);
    if (!achievement) {
      if (!achievementTitle) throw new DomainError("首次裁定需提供成果名称或既有成果标识");
      achId = `ach-${String(this.state.achievements.size + 1).padStart(3, "0")}`;
    }
    const finalRole = role ?? stmt.role;
    if (!reAdjudication && achievement) {
      const dup = achievement.credits.some(
        (c) => c.contributorId === stmt.contributorId && c.role === finalRole,
      );
      if (dup) throw new DomainError("同一成果中相同人员相同角色不得重复计算");
    }
    if (!achievement)
      this.#emit("ACHIEVEMENT_REGISTERED", "achievement", achId, { title: achievementTitle }, `登记团队成果：${achievementTitle}`);
    this.#emit(
      "CONTRIBUTION_ADJUDICATED",
      "contribution_record",
      statementId,
      { reviewerId, achievementId: achId, role: finalRole, reAdjudication },
      reAdjudication
        ? `复核后恢复归属：${stmt.contributorId}「${finalRole}」`
        : `裁定归属：${stmt.contributorId} 以「${finalRole}」计入成果`,
    );
    return this.internalAchievementView(achId);
  }

  // ---------- 患者/家属同意与发布 ----------

  grantConsent({ grantId, subjectId, storyRef, purposes, channels, validFrom, validUntil, summary }) {
    if (this.state.grants.has(grantId)) throw new ConflictError(`同意记录已存在：${grantId}`);
    if (!Array.isArray(purposes) || !purposes.length || !Array.isArray(channels) || !channels.length)
      throw new DomainError("同意必须按用途与渠道限定范围");
    if (!validFrom || !validUntil || validFrom > validUntil) throw new DomainError("同意有效期无效");
    if (!summary) throw new DomainError("须提供经批准可公开的摘要（最小披露）");
    this.#emit(
      "CONSENT_GRANTED",
      "consent_grant",
      grantId,
      { subjectId, storyRef, purposes, channels, validFrom, validUntil, summary },
      `登记同意：${subjectId} 授权「${storyRef}」按限定范围使用`,
    );
    return this.internalConsentChain(storyRef);
  }

  // 发布只保存同意中获准的摘要，不写入任何未授权内容。
  releaseStory({ storyId, version, purpose, channel, at = null }) {
    if (!Number.isInteger(version) || version < 1) throw new DomainError("故事版本必须是正整数");
    const releasedAt = at ?? this.now();
    const story = this.state.stories.get(storyId);
    if (story?.versions.has(version)) throw new ConflictError(`故事版本已存在：${storyId} v${version}`);
    const grant = [...this.state.grants.values()].find(
      (g) =>
        g.storyRef === storyId &&
        g.activePairs.has(pairKey(purpose, channel)) &&
        g.validFrom <= releasedAt &&
        releasedAt <= g.validUntil,
    );
    if (!grant) throw new ConsentError(`缺少覆盖「${purpose}/${channel}」且在有效期内的同意，禁止发布`);
    this.#emit(
      "STORY_RELEASED",
      "public_story",
      storyId,
      { version, purpose, channel, releasedAt, summary: grant.summary, grantId: grant.id },
      `发布公开故事：${storyId} v${version}（${purpose}/${channel}）`,
    );
    return this.publicStoryView(storyId);
  }

  // 撤回：只阻止撤回范围内的新发布；已发布版本保持原样并追加处置标注；
  // 同时为宣传部门生成待送达通知，指明哪些版本必须停止使用。
  withdrawConsent({ grantId, purposes = null, channels = null, at = null }) {
    const grant = this.#requireGrant(grantId);
    const at_ = at ?? this.now();
    const remainingPurposes = [...new Set([...grant.activePairs].map((k) => k.split("|")[0]))];
    const remainingChannels = [...new Set([...grant.activePairs].map((k) => k.split("|")[1]))];
    const ps = purposes ?? remainingPurposes;
    const cs = channels ?? remainingChannels;
    const targets = [];
    for (const p of ps)
      for (const c of cs) if (grant.activePairs.has(pairKey(p, c))) targets.push([p, c]);
    if (!targets.length) throw new DomainError("撤回范围不包含任何仍然有效的授权");

    this.#emit(
      "CONSENT_WITHDRAWN",
      "consent_grant",
      grantId,
      { purposes: ps, channels: cs, withdrawnPairs: targets, at: at_ },
      `撤回同意：${grantId}（${ps.join("/")} × ${cs.join("/")}）`,
    );

    const affected = [];
    const story = this.state.stories.get(grant.storyRef);
    if (story) {
      for (const v of story.versions.values()) {
        if (targets.some(([p, c]) => p === v.purpose && c === v.channel)) {
          this.#emit(
            "RELEASE_DISPOSITION_APPENDED",
            "public_story",
            story.id,
            {
              version: v.version,
              kind: "cease_new_release",
              note: `同意已撤回（${v.purpose}/${v.channel}）：停止新发布，已发布版本保留并追加本处置标注`,
              grantId,
              at: at_,
            },
            `已发布版本追加处置：${story.id} v${v.version}`,
          );
          affected.push({ storyId: story.id, version: v.version });
        }
      }
    }
    const noticeId = `notice-${grantId}-${grant.withdrawals.length}`;
    this.#emit(
      "WITHDRAWAL_NOTICE_QUEUED",
      "consent_grant",
      grantId,
      { noticeId, storyRef: grant.storyRef, withdrawnPairs: targets, affected, at: at_ },
      `撤回通知待送达宣传部门：${noticeId}`,
    );
    return { noticeId, affected };
  }

  markNoticeDelivered({ noticeId }) {
    const n = this.state.notices.get(noticeId);
    if (!n) throw new NotFoundError(`通知不存在：${noticeId}`);
    if (n.delivered) return;
    this.#emit("WITHDRAWAL_NOTICE_DELIVERED", "consent_grant", n.grantId, { noticeId }, `撤回通知已送达：${noticeId}`);
  }

  // ---------- 异议与归属更正 ----------

  fileObjection({ objectionId, targetType, targetId, reason, filedBy, deadline }) {
    if (this.state.objections.has(objectionId)) throw new ConflictError(`异议已存在：${objectionId}`);
    if (!["achievement", "contribution", "story"].includes(targetType))
      throw new DomainError(`不支持的异议对象类型：${targetType}`);
    if (!deadline) throw new DomainError("异议须设定期限");
    this.#emit(
      "OBJECTION_FILED",
      "objection",
      objectionId,
      { targetType, targetId, reason, filedBy, deadline },
      `登记异议：${filedBy} 对 ${targetType}/${targetId} 提出异议`,
    );
  }

  // 异议成立时生成归属更正；历史提名、投票与公开版本保持原样，后续材料采用当前有效结论。
  resolveObjection({ objectionId, reviewerId, upheld, rationale, correctedCredits = null }) {
    const obj = this.#requireObjection(objectionId);
    if (obj.status !== "open") throw new ConflictError(`异议已处理：${objectionId}`);
    if (upheld && obj.targetType === "achievement" && (!Array.isArray(correctedCredits) || !correctedCredits.length))
      throw new DomainError("异议成立时须提供更正后的归属说明");
    this.#emit(
      "OBJECTION_RESOLVED",
      "objection",
      objectionId,
      { reviewerId, upheld: Boolean(upheld), rationale },
      upheld ? `异议成立：${objectionId}` : `异议不成立：${objectionId}`,
    );
    if (upheld && obj.targetType === "achievement") {
      const ach = this.#requireAchievement(obj.targetId);
      this.#emit(
        "ATTRIBUTION_CORRECTED",
        "achievement",
        ach.id,
        { objectionId, before: structuredClone(ach.credits), after: correctedCredits, rationale },
        `归属更正：${ach.title}（历史记录保持原样，后续材料采用当前结论）`,
      );
    }
    return structuredClone(this.state.objections.get(objectionId));
  }

  // ---------- 查询 ----------

  // 重启后继续处理：未送达的撤回通知。
  pendingNotifications() {
    return [...this.state.notices.values()].filter((n) => !n.delivered).map((n) => structuredClone(n));
  }

  // 重启后继续处理：仍在期限内的未决异议，按期限升序。
  pendingObjections() {
    return [...this.state.objections.values()]
      .filter((o) => o.status === "open")
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1))
      .map((o) => structuredClone(o));
  }

  // 同一成果多人多角色只计为一项成果。
  achievementCount() {
    let count = 0;
    for (const ach of this.state.achievements.values()) if (ach.credits.length > 0) count += 1;
    return count;
  }

  internalStatementView(statementId) {
    return structuredClone(this.#requireStatement(statementId));
  }

  // 内部视图：还原团队贡献与校正理由。
  internalAchievementView(achievementId) {
    const ach = this.#requireAchievement(achievementId);
    return {
      achievementId,
      title: ach.title,
      credits: structuredClone(ach.credits),
      statements: ach.credits
        .map((c) => (c.statementId && this.state.statements.has(c.statementId) ? this.internalStatementView(c.statementId) : null))
        .filter(Boolean),
      corrections: structuredClone(ach.corrections),
    };
  }

  // 内部视图：还原同意链（授权、撤回、处置、通知）。
  internalConsentChain(storyRef) {
    const grants = [...this.state.grants.values()].filter((g) => g.storyRef === storyRef);
    const story = this.state.stories.get(storyRef);
    return {
      storyRef,
      grants: grants.map((g) => ({
        grantId: g.id,
        subjectId: g.subjectId,
        validFrom: g.validFrom,
        validUntil: g.validUntil,
        status: g.status,
        activePairs: [...g.activePairs],
        withdrawals: g.withdrawals.map((w) => ({ ...w })),
      })),
      releases: story
        ? [...story.versions.values()].map((v) => ({
            version: v.version,
            purpose: v.purpose,
            channel: v.channel,
            releasedAt: v.releasedAt,
            grantId: v.grantId,
            dispositions: v.dispositions.map((d) => ({ ...d })),
          }))
        : [],
      notices: [...this.state.notices.values()]
        .filter((n) => n.storyRef === storyRef)
        .map((n) => ({ id: n.id, delivered: n.delivered, affected: n.affected.map((a) => ({ ...a })), queuedAt: n.queuedAt })),
    };
  }

  // 公众视图：只看到获准摘要与处置标注。
  publicStoryView(storyId) {
    const story = this.state.stories.get(storyId);
    if (!story) throw new NotFoundError(`公开故事不存在：${storyId}`);
    return {
      storyId,
      versions: [...story.versions.values()].map((v) => ({
        version: v.version,
        releasedAt: v.releasedAt,
        purpose: v.purpose,
        channel: v.channel,
        summary: v.summary,
        dispositions: v.dispositions.map((d) => ({ note: d.note, at: d.at })),
      })),
    };
  }
}
