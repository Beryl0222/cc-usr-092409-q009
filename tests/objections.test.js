import assert from "node:assert/strict";
import test from "node:test";

import { HonorArchiveService } from "../src/service.js";

// 现有材料把最终成果全部归到提名人名下。
function nomineeOnlyService() {
  const svc = new HonorArchiveService();
  svc.registerNominee({ profileId: "nominee-1", displayName: "提名人甲" });
  svc.submitStatement({
    statementId: "stmt-nominee",
    contributorId: "nominee-1",
    role: "全部成果",
    periodStart: "2026-01-01",
    periodEnd: "2026-08-31",
    evidenceSummary: "现有材料将病案改进、夜间抢救、长期随访全部归于提名人",
    coParticipants: [],
  });
  svc.confirmStatement({ statementId: "stmt-nominee", confirmerId: "nominee-1" });
  svc.adjudicate({ statementId: "stmt-nominee", reviewerId: "reviewer-0", achievementTitle: "年度团队荣誉" });
  return svc;
}

test("异议成立生成归属更正，历史保持原样，后续采用当前有效结论", () => {
  const svc = nomineeOnlyService();
  svc.fileObjection({
    objectionId: "obj-1",
    targetType: "achievement",
    targetId: "ach-001",
    reason: "病案改进、夜间抢救、长期随访实际由不同人员完成",
    filedBy: "dr-lin",
    deadline: "2026-10-15T00:00:00+08:00",
  });
  svc.resolveObjection({
    objectionId: "obj-1",
    reviewerId: "reviewer-1",
    upheld: true,
    rationale: "病案记录、抢救排班与随访登记证实三人分工",
    correctedCredits: [
      { contributorId: "dr-lin", role: "病案改进" },
      { contributorId: "dr-chen", role: "夜间抢救" },
      { contributorId: "nurse-wang", role: "长期随访" },
    ],
  });

  // 当前有效结论
  const view = svc.internalAchievementView("ach-001");
  assert.deepEqual(
    view.credits.map((c) => `${c.contributorId}:${c.role}`),
    ["dr-lin:病案改进", "dr-chen:夜间抢救", "nurse-wang:长期随访"],
  );
  assert.equal(svc.achievementCount(), 1);

  // 校正理由可还原
  assert.equal(view.corrections.length, 1);
  assert.match(view.corrections[0].rationale, /三人分工/);
  assert.deepEqual(
    view.corrections[0].before.map((c) => `${c.contributorId}:${c.role}`),
    ["nominee-1:全部成果"],
  );

  // 历史事件未被改写
  const adjudicated = svc.log.events.find((e) => e.event_type === "CONTRIBUTION_ADJUDICATED");
  assert.equal(adjudicated.payload.role, "全部成果");
  assert.equal(svc.log.events.filter((e) => e.event_type === "ATTRIBUTION_CORRECTED").length, 1);

  // 同一异议不可重复处理
  assert.throws(
    () => svc.resolveObjection({ objectionId: "obj-1", reviewerId: "reviewer-1", upheld: true, rationale: "重复处理" }),
    /已处理/,
  );
});

test("异议不成立则不产生更正", () => {
  const svc = nomineeOnlyService();
  svc.fileObjection({
    objectionId: "obj-2",
    targetType: "achievement",
    targetId: "ach-001",
    reason: "提名人认为无需调整",
    filedBy: "nominee-1",
    deadline: "2026-10-15T00:00:00+08:00",
  });
  svc.resolveObjection({ objectionId: "obj-2", reviewerId: "reviewer-1", upheld: false, rationale: "证据不足" });

  const view = svc.internalAchievementView("ach-001");
  assert.deepEqual(view.credits.map((c) => c.contributorId), ["nominee-1"]);
  assert.equal(view.corrections.length, 0);
  assert.equal(svc.log.events.filter((e) => e.event_type === "ATTRIBUTION_CORRECTED").length, 0);
});

test("异议成立但缺少更正后的归属说明时拒绝处理", () => {
  const svc = nomineeOnlyService();
  svc.fileObjection({
    objectionId: "obj-3",
    targetType: "achievement",
    targetId: "ach-001",
    reason: "归属有误",
    filedBy: "dr-lin",
    deadline: "2026-10-15T00:00:00+08:00",
  });
  assert.throws(
    () => svc.resolveObjection({ objectionId: "obj-3", reviewerId: "reviewer-1", upheld: true, rationale: "成立" }),
    /更正后的归属/,
  );
  assert.equal(svc.pendingObjections().length, 1);
});
