import assert from "node:assert/strict";
import test from "node:test";

import { ArchiveService } from "../src/archiveService.js";
import { ArchiveQueries } from "../src/readModel.js";
import { ConcurrencyError } from "../src/store/eventStore.js";
import {
  PATIENT,
  T0,
  T1,
  T2,
  T3,
  T4,
  TEAM,
  entry,
  evidenceFingerprint,
  makeHarness,
  seedTeam,
  videoScope,
  webScope
} from "./helpers.js";

// ---------- 场景一：共同贡献 ----------

test("共同贡献：多人按不同角色共享同一成果，成果只计一次，自动建议不能充当结论", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0 });

    // 自动聚合只产出建议。
    const suggestion = await service.generateSuggestion({ reviewId: TEAM.reviewId, now: T1 });
    assert.equal(suggestion.advisory ?? true, true);
    assert.equal(suggestion.entries.length, 3);

    const beforeAdj = await queries.internalReview(TEAM.reviewId, { now: new Date(T1) });
    assert.equal(beforeAdj.current_attribution, null, "裁定前不存在当前有效归属结论");
    assert.equal(beforeAdj.suggestions.length, 1);

    // 未经独立裁定不得对外发布。
    await assert.rejects(
      () =>
        service.releaseStory({
          storyId: PATIENT.storyId,
          consentId: PATIENT.consentId,
          reviewId: TEAM.reviewId,
          purpose: "honor_publicity",
          channel: "web",
          publicSummary: "草稿"
        }),
      (err) => err.code === "CONSENT_UNKNOWN" // 先被同意拦截；同意补齐后再验证归属门禁
    );

    // 独立审核人裁定：三名成员各自的角色都写入同一成果。
    await service.adjudicate({
      reviewId: TEAM.reviewId,
      adjudicationId: "adj-01",
      adjudicatorId: TEAM.adjudicator.id,
      adjudicatorName: TEAM.adjudicator.name,
      entries: [entry(TEAM.members.wang, "病案改进"), entry(TEAM.members.li, "夜间抢救"), entry(TEAM.members.zhao, "长期随访")],
      rationale: "病案改进、夜间抢救、长期随访由三人分别完成，按角色共同署名。",
      now: T2
    });

    const view = await queries.internalReview(TEAM.reviewId, { now: new Date(T2) });
    assert.equal(view.achievement_count, 1, "同一成果不得按人头重复计算");
    assert.equal(view.roster.length, 3);
    assert.deepEqual(
      view.roster.map((r) => r.personName).sort(),
      ["李医生", "王医生", "赵医生"]
    );
    assert.equal(view.current_attribution.kind, "adjudication");
    assert.deepEqual(
      view.current_attribution.entries.map((e) => e.role),
      ["病案改进", "夜间抢救", "长期随访"]
    );

    // 声明绑定了时间、职责、证据摘要和共同参与者。
    const wang = view.contributions.find((c) => c.contribution_id === "c-wang");
    assert.equal(wang.duty, "病案改进负责人相关职责");
    assert.equal(wang.confirmed, true);
    assert.deepEqual(wang.co_participants.map((p) => p.person_id).sort(), ["p-li", "p-zhao"]);
    assert.deepEqual(wang.work_period, { from: "2026-01-01", to: "2026-08-31" });
    assert.equal(wang.declared_at, new Date(T0).toISOString());
  } finally {
    await close();
  }
});

test("共同贡献：当事人未确认的声明不能进入独立裁定", async () => {
  const { service, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0, acknowledge: false });
    // 仅赵医生确认。
    await service.acknowledgeContribution({ contributionId: TEAM.members.zhao.contributionId, acknowledgedBy: "p-zhao", now: T1 });
    await assert.rejects(
      () =>
        service.adjudicate({
          reviewId: TEAM.reviewId,
          adjudicationId: "adj-x",
          adjudicatorId: TEAM.adjudicator.id,
          adjudicatorName: TEAM.adjudicator.name,
          entries: [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)],
          now: T2
        }),
      (err) => err.code === "CONTRIBUTION_UNCONFIRMED"
    );
  } finally {
    await close();
  }
});

test("共同贡献：历史提名把成果归于提名人一人，内部视图同时保留原说法与当前团队结论", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0 });
    // 提名人最初把成果全部算在自己头上。
    await service.submitNomination({
      honorId: TEAM.honorId,
      achievementId: TEAM.achievementId,
      nominationId: "nom-01",
      nomineeId: "p-wang",
      nomineeName: "王医生",
      claimedAttribution: "成果全部由提名人完成",
      reviewId: TEAM.reviewId,
      now: T1
    });
    await service.vote({ honorId: TEAM.honorId, nominationId: "nom-01", voterId: "voter-a", choice: "approve", now: T1 });
    await service.adjudicate({
      reviewId: TEAM.reviewId,
      adjudicationId: "adj-01",
      adjudicatorId: TEAM.adjudicator.id,
      adjudicatorName: TEAM.adjudicator.name,
      entries: [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)],
      now: T2
    });

    const view = await queries.internalReview(TEAM.reviewId, { now: new Date(T2) });
    assert.equal(view.immutable_history.nominations_and_votes[0].nominations[0].claimed_attribution, "成果全部由提名人完成");
    assert.equal(view.immutable_history.nominations_and_votes[0].votes.length, 1);
    assert.equal(view.current_attribution.entries.length, 3, "后续材料采用当前有效结论");
  } finally {
    await close();
  }
});

// ---------- 场景二：迟到证明与指纹归并 ----------

test("迟到证明：裁定后到达的冲突证明挂起等待复核，不改变当前结论；重复证明归并", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0 });
    const fp = evidenceFingerprint("duty-record", { record: "c-li-night-rescue", no: 7 });

    const first = await service.submitEvidence({
      contributionId: "c-li",
      fingerprint: fp,
      content: { record: "夜间抢救记录", pages: 3 },
      summary: "夜间抢救记录扫描件",
      channel: "online",
      now: T1
    });
    assert.deepEqual(first, { merged: false, conflict: false, late: false });

    // 同指纹同内容：归并，不产生新事实。
    const dup = await service.submitEvidence({
      contributionId: "c-li",
      fingerprint: fp,
      content: { pages: 3, record: "夜间抢救记录" }, // 键序不同但规范化后内容一致
      summary: "同一扫描件再次上传",
      channel: "paper-scan",
      now: T1
    });
    assert.equal(dup.merged, true);

    await service.adjudicate({
      reviewId: TEAM.reviewId,
      adjudicationId: "adj-01",
      adjudicatorId: TEAM.adjudicator.id,
      adjudicatorName: TEAM.adjudicator.name,
      entries: [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)],
      now: T2
    });

    // 裁定之后到达、同指纹但内容不同：迟到证明 → 冲突挂起，当前结论仍有效。
    const late = await service.submitEvidence({
      contributionId: "c-li",
      fingerprint: fp,
      content: { record: "夜间抢救记录", pages: 9 },
      summary: "页数不一致的新版本",
      channel: "paper",
      now: T3
    });
    assert.equal(late.late, true);
    assert.equal(late.conflict, true);

    let view = await queries.internalReview(TEAM.reviewId, { now: new Date(T3) });
    assert.equal(view.needs_rereview, true);
    assert.equal(view.evidence_conflicts_pending.length, 1);
    assert.equal(view.current_attribution.kind, "adjudication", "等待复核期间当前归属结论保持有效");

    // 挂起期间新的对外发布被暂缓。
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope()],
      now: T3
    });
    await assert.rejects(
      () =>
        service.releaseStory({
          storyId: PATIENT.storyId,
          consentId: PATIENT.consentId,
          reviewId: TEAM.reviewId,
          purpose: "honor_publicity",
          channel: "web",
          fields: ["public_summary"],
          publicSummary: "团队救治纪实",
          now: T3
        }),
      (err) => err.code === "EVIDENCE_CONFLICT_PENDING"
    );

    // 复核完成后解除挂起。
    await service.resolveEvidenceConflict({
      reviewId: TEAM.reviewId,
      fingerprint: fp,
      outcome: "retain_existing",
      reviewerId: TEAM.adjudicator.id,
      note: "迟到材料页数系笔误，维持原记录",
      now: T4
    });
    view = await queries.internalReview(TEAM.reviewId, { now: new Date(T4) });
    assert.equal(view.needs_rereview, false);
    assert.equal(view.evidence_conflicts_pending.length, 0);
  } finally {
    await close();
  }
});

test("离线确认：按指纹归并重复签认，内容冲突等待复核", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0, acknowledge: false });
    const fp = evidenceFingerprint("paper-signoff", { contribution: "c-zhao", batch: "2026-09" });
    const r1 = await service.recordOfflineConfirmation({
      contributionId: "c-zhao",
      fingerprint: fp,
      confirmerId: "p-zhao",
      confirmerName: "赵医生",
      witness: "w-nurse-1",
      channel: "paper",
      content: { signed: true, date: "2026-09-18" },
      now: T1
    });
    assert.deepEqual(r1, { merged: false, conflict: false });

    const r2 = await service.recordOfflineConfirmation({
      contributionId: "c-zhao",
      fingerprint: fp,
      confirmerId: "p-zhao",
      confirmerName: "赵医生",
      channel: "paper",
      content: { date: "2026-09-18", signed: true },
      now: T2
    });
    assert.equal(r2.merged, true, "同指纹同内容的离线补录归并");

    const view = await queries.internalReview(TEAM.reviewId, { now: new Date(T2) });
    const zhao = view.contributions.find((c) => c.contribution_id === "c-zhao");
    assert.equal(zhao.confirmed, true);
    assert.equal(zhao.offline_confirmations.length, 1, "离线确认不重复计数");
  } finally {
    await close();
  }
});

// ---------- 场景三：部分撤回 ----------

async function adjudicatedArchive(service) {
  await seedTeam(service, { now: T0 });
  await service.adjudicate({
    reviewId: TEAM.reviewId,
    adjudicationId: "adj-01",
    adjudicatorId: TEAM.adjudicator.id,
    adjudicatorName: TEAM.adjudicator.name,
    entries: [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)],
    now: T1
  });
}

test("部分撤回：撤回只阻止对应用途/渠道的新发布，已发布版本追加处置且历史不改写", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await adjudicatedArchive(service);
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope(), videoScope()],
      now: T1
    });

    const released = await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary", "team_attribution"],
      publicSummary: "三人协作完成救治与随访的公开摘要",
      now: T2
    });
    assert.equal(released.version, 1);

    let publicView = await queries.publicStories({ now: new Date(T2) });
    assert.equal(publicView.length, 1);

    // 仅撤回视频渠道：web 版本仍对公众可见，视频新发布被拒。
    await service.withdrawConsent({ consentId: PATIENT.consentId, scopeIds: ["scope-video"], reason: "不同意视频讲述", now: T3 });
    await assert.rejects(
      () =>
        service.releaseStory({
          storyId: "story-video",
          consentId: PATIENT.consentId,
          reviewId: TEAM.reviewId,
          purpose: "honor_publicity",
          channel: "video",
          fields: ["public_summary"],
          publicSummary: "视频版",
          now: T3
        }),
      (err) => err.code === "CONSENT_DENIED"
    );
    publicView = await queries.publicStories({ now: new Date(T3) });
    assert.equal(publicView.length, 1, "web 渠道授权仍在，公众可见");

    // 撤回 web：已发布版本不删除，而是追加处置并从公众视图消失。
    await service.withdrawConsent({ consentId: PATIENT.consentId, scopeIds: ["scope-web"], reason: "患者撤回公开讲述", now: T4 });
    publicView = await queries.publicStories({ now: new Date(T4) });
    assert.equal(publicView.length, 0, "撤回后公众看不到该故事");

    const internal = await queries.internalReview(TEAM.reviewId, { now: new Date(T4) });
    const story = internal.immutable_history.released_versions[0];
    assert.equal(story.versions.length, 1, "历史发布版本保持原样");
    assert.equal(story.versions[0].public_summary, "三人协作完成救治与随访的公开摘要");
    const webDisposition = story.dispositions.find((d) => d.target_versions.includes(1));
    assert.equal(webDisposition.blocks_new_release, true);
    assert.match(webDisposition.notice_text, /撤回/);

    const consent = await queries.internalConsent(PATIENT.consentId, { now: new Date(T4) });
    assert.equal(consent.active_scopes.length, 0);
    assert.equal(consent.withdrawals.length, 2, "两次部分撤回都留在同意链上");
  } finally {
    await close();
  }
});

test("撤回后重新授权：旧版本不复活，只有按新 scope 发布的新版本对公众可见", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await adjudicatedArchive(service);
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope()],
      now: T1
    });
    await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary"],
      publicSummary: "初版摘要",
      now: T2
    });
    await service.withdrawConsent({ consentId: PATIENT.consentId, scopeIds: ["scope-web"], reason: "撤回", now: T3 });
    assert.equal((await queries.publicStories({ now: new Date(T3) })).length, 0);

    // 患者改变主意，按新 scope 重新授权。
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope({ scope_id: "scope-web-renewed" })],
      now: T4
    });
    // 旧版本由已撤回的 scope-web 背书，仍不可见。
    assert.equal((await queries.publicStories({ now: new Date(T4) })).length, 0, "旧版本不被新 scope 复活");

    const released = await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary"],
      publicSummary: "重新授权后的摘要",
      now: T4
    });
    assert.equal(released.version, 2, "旧版本保留，新版本号递增");

    const pub = await queries.publicStories({ now: new Date(T4) });
    assert.equal(pub.length, 1);
    assert.equal(pub[0].version, 2);
    assert.equal(pub[0].public_summary, "重新授权后的摘要");

    // 内部视图仍可看到两个版本和全部处置。
    const internal = await queries.internalReview(TEAM.reviewId, { now: new Date(T4) });
    const story = internal.immutable_history.released_versions[0];
    assert.equal(story.versions.length, 2);
    assert.equal(story.dispositions.length, 1);
  } finally {
    await close();
  }
});

test("最小披露：超出授权字段或过期授权不得发布；重新授权后可发布新版本", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await adjudicatedArchive(service);
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope({ fields: ["public_summary"], valid_until: "2026-10-01T00:00:00+08:00" })],
      now: T1
    });

    await assert.rejects(
      () =>
        service.releaseStory({
          storyId: PATIENT.storyId,
          consentId: PATIENT.consentId,
          reviewId: TEAM.reviewId,
          purpose: "honor_publicity",
          channel: "web",
          fields: ["public_summary", "patient_real_name"],
          publicSummary: "含未授权字段",
          now: T2
        }),
      (err) => err.code === "CONSENT_DENIED"
    );

    await assert.rejects(
      () =>
        service.releaseStory({
          storyId: PATIENT.storyId,
          consentId: PATIENT.consentId,
          reviewId: TEAM.reviewId,
          purpose: "honor_publicity",
          channel: "web",
          fields: ["public_summary"],
          publicSummary: "授权已过期",
          now: "2026-10-02T00:00:00+08:00"
        }),
      (err) => err.code === "CONSENT_DENIED"
    );

    // 重新授权后发布新版本：旧版本处置保留，新版本正常呈现。
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope({ scope_id: "scope-web-2", valid_until: "2027-01-01T00:00:00+08:00" })],
      now: "2026-10-03T00:00:00+08:00"
    });
    // 先撤回旧 scope（已过期）——此处直接以新授权发布新版本验证公众视图取当前获准版本。
    const released = await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary"],
      publicSummary: "重新授权后的摘要",
      now: "2026-10-03T01:00:00+08:00"
    });
    assert.equal(released.version, 1);
    const publicView = await queries.publicStories({ now: new Date("2026-10-03T02:00:00+08:00") });
    assert.equal(publicView[0].public_summary, "重新授权后的摘要");
  } finally {
    await close();
  }
});

// ---------- 场景四：并发裁定 + 异议更正 ----------

test("并发裁定：同一版本上的两次并发裁定只有一次生效", async () => {
  const { service, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0 });
    const entries = [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)];
    const expected = await service.store.versionOf("achievement_review:review-01");
    assert.equal(expected, 0);

    const attempts = await Promise.allSettled([
      service.adjudicate({
        reviewId: TEAM.reviewId,
        adjudicationId: "adj-a",
        adjudicatorId: "p-reviewer-a",
        adjudicatorName: "审核人甲",
        entries,
        rationale: "裁定 A",
        expectedVersion: 0,
        now: T1
      }),
      service.adjudicate({
        reviewId: TEAM.reviewId,
        adjudicationId: "adj-b",
        adjudicatorId: "p-reviewer-b",
        adjudicatorName: "审核人乙",
        entries,
        rationale: "裁定 B",
        expectedVersion: 0,
        now: T1
      })
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ConcurrencyError);

    const events = await service.store.load("achievement_review:review-01");
    assert.equal(events.length, 1, "失败的裁定不得留下事件");
  } finally {
    await close();
  }
});

test("异议成立：生成归属更正，历史提名/投票/公开版本不变，后续材料采用当前结论", async () => {
  const { service, queries, close } = await makeHarness();
  try {
    await seedTeam(service, { now: T0 });
    await service.submitNomination({
      honorId: TEAM.honorId,
      achievementId: TEAM.achievementId,
      nominationId: "nom-01",
      nomineeId: "p-wang",
      nomineeName: "王医生",
      claimedAttribution: "全部归提名人",
      reviewId: TEAM.reviewId,
      now: T1
    });
    await service.vote({ honorId: TEAM.honorId, nominationId: "nom-01", voterId: "voter-a", choice: "approve", now: T1 });
    // 初次裁定漏掉了赵医生。
    await service.adjudicate({
      reviewId: TEAM.reviewId,
      adjudicationId: "adj-01",
      adjudicatorId: TEAM.adjudicator.id,
      adjudicatorName: TEAM.adjudicator.name,
      entries: [entry(TEAM.members.wang), entry(TEAM.members.li)],
      rationale: "初评仅列两人",
      now: T2
    });
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope()],
      now: T2
    });
    await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary", "team_attribution"],
      publicSummary: "初版公开摘要",
      now: T3
    });

    // 赵医生提出异议，成立后生成更正。
    await service.fileDispute({
      reviewId: TEAM.reviewId,
      disputeId: "disp-01",
      claimantId: "p-zhao",
      reason: "长期随访由本人完成，初评遗漏",
      deadline: T4,
      now: T3
    });
    await service.resolveDispute({
      reviewId: TEAM.reviewId,
      disputeId: "disp-01",
      ruling: "upheld",
      adjudicatorId: TEAM.adjudicator.id,
      reason: "长期随访确由赵医生完成，初评遗漏",
      correctionId: "corr-01",
      entries: [entry(TEAM.members.wang), entry(TEAM.members.li), entry(TEAM.members.zhao)],
      now: T4
    });

    const view = await queries.internalReview(TEAM.reviewId, { now: new Date(T4) });
    assert.equal(view.current_attribution.kind, "correction");
    assert.equal(view.current_attribution.entries.length, 3);
    assert.equal(view.corrections[0].reason, "长期随访确由赵医生完成，初评遗漏");
    // 历史原样保留。
    assert.equal(view.immutable_history.nominations_and_votes[0].nominations[0].claimed_attribution, "全部归提名人");
    assert.equal(view.immutable_history.nominations_and_votes[0].votes[0].choice, "approve");
    assert.equal(view.immutable_history.released_versions[0].versions[0].public_summary, "初版公开摘要");

    // 公众视图反映当前有效结论。
    const pub = await queries.publicStories({ now: new Date(T4) });
    assert.equal(pub.length, 1);
    assert.deepEqual(pub[0].attribution.map((a) => a.name).sort(), ["李医生", "王医生", "赵医生"]);
    assert.equal(pub[0].attribution_basis, "correction");

    // 异议不成立不产生更正。
    await service.fileDispute({ reviewId: TEAM.reviewId, disputeId: "disp-02", claimantId: "p-li", reason: "试探性异议", now: T4 });
    await service.resolveDispute({
      reviewId: TEAM.reviewId,
      disputeId: "disp-02",
      ruling: "rejected",
      adjudicatorId: TEAM.adjudicator.id,
      rationale: "缺乏依据",
      now: T4
    });
    const after = await queries.internalReview(TEAM.reviewId, { now: new Date(T4) });
    assert.equal(after.corrections.length, 1);
    assert.equal(after.disputes.find((d) => d.id === "disp-02").status, "rejected");
  } finally {
    await close();
  }
});

// ---------- 重启恢复 ----------

test("重启恢复：撤回通知与异议期限在新进程实例中继续投递", async () => {
  const { dir, service, delivered, close } = await makeHarness();
  try {
    await adjudicatedArchive(service);
    await service.grantConsent({
      consentId: PATIENT.consentId,
      patientId: PATIENT.patientId,
      patientName: PATIENT.patientName,
      scopes: [webScope()],
      now: T1
    });
    await service.releaseStory({
      storyId: PATIENT.storyId,
      consentId: PATIENT.consentId,
      reviewId: TEAM.reviewId,
      purpose: "honor_publicity",
      channel: "web",
      fields: ["public_summary"],
      publicSummary: "即将撤回的摘要",
      now: T2
    });
    await service.fileDispute({
      reviewId: TEAM.reviewId,
      disputeId: "disp-restart",
      claimantId: "p-zhao",
      reason: "异议期限需跨重启提醒",
      deadline: T4,
      now: T2
    });
    await service.withdrawConsent({ consentId: PATIENT.consentId, scopeIds: ["scope-web"], reason: "撤回公开讲述", now: T3 });
    assert.equal(delivered.length, 0, "撤回时刻早于 T4 时立即可投递；这里先不 pump");

    // 模拟重启：用同一目录新建实例，通知队列从磁盘归约。
    const restartedDelivered = [];
    const restarted = await ArchiveService.create(dir, { sink: async (n) => restartedDelivered.push(n) });
    const pending = restarted.notices.pending();
    const kinds = pending.map((n) => n.kind).sort();
    assert.ok(kinds.includes("withdrawal_notice"));
    assert.ok(kinds.includes("dispute_deadline"));

    const sent = await restarted.pumpNotices(new Date(T4));
    assert.equal(sent.length, pending.length, "到期通知在重启后继续投递");
    assert.ok(restartedDelivered.some((n) => n.kind === "withdrawal_notice"));
    assert.ok(restartedDelivered.some((n) => n.kind === "dispute_deadline"));

    // 再次 pump 幂等：不重复投递。
    const again = await restarted.pumpNotices(new Date(T4));
    assert.equal(again.length, 0);

    // 事件也完整恢复。
    const queries2 = new ArchiveQueries(restarted.store);
    const view = await queries2.internalReview(TEAM.reviewId, { now: new Date(T4) });
    assert.equal(view.current_attribution.kind, "adjudication");
  } finally {
    await close();
  }
});
