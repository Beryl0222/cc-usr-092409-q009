import assert from "node:assert/strict";
import test from "node:test";

import { HonorArchiveService } from "../src/service.js";

// 病案改进、夜间抢救、长期随访分别由不同人员完成。
function teamService() {
  const svc = new HonorArchiveService();
  svc.submitStatement({
    statementId: "stmt-record",
    contributorId: "dr-lin",
    role: "病案改进",
    periodStart: "2026-03-01",
    periodEnd: "2026-05-31",
    evidenceSummary: "重构出院小结模板，病案缺陷率下降",
    coParticipants: ["dr-chen", "nurse-wang"],
    achievementHint: "team-honor",
  });
  svc.submitStatement({
    statementId: "stmt-rescue",
    contributorId: "dr-chen",
    role: "夜间抢救",
    periodStart: "2026-04-10",
    periodEnd: "2026-04-20",
    evidenceSummary: "主持夜间多发伤抢救三例",
    coParticipants: ["dr-lin", "nurse-wang"],
    achievementHint: "team-honor",
  });
  svc.submitStatement({
    statementId: "stmt-followup",
    contributorId: "nurse-wang",
    role: "长期随访",
    periodStart: "2026-01-01",
    periodEnd: "2026-08-31",
    evidenceSummary: "完成 120 例出院后随访",
    coParticipants: ["dr-lin"],
    achievementHint: "team-honor",
  });
  return svc;
}

function confirmAll(svc) {
  svc.confirmStatement({ statementId: "stmt-record", confirmerId: "dr-lin" });
  svc.confirmStatement({ statementId: "stmt-rescue", confirmerId: "dr-chen" });
  svc.confirmStatement({ statementId: "stmt-followup", confirmerId: "nurse-wang" });
}

test("共同贡献：同一成果多人按不同角色计入，只计为一项成果", () => {
  const svc = teamService();
  confirmAll(svc);

  svc.adjudicate({ statementId: "stmt-record", reviewerId: "reviewer-1", achievementTitle: "年度团队荣誉" });
  svc.adjudicate({ statementId: "stmt-rescue", reviewerId: "reviewer-1", achievementId: "ach-001" });
  svc.adjudicate({ statementId: "stmt-followup", reviewerId: "reviewer-2", achievementId: "ach-001" });

  assert.equal(svc.achievementCount(), 1);
  const view = svc.internalAchievementView("ach-001");
  assert.deepEqual(
    view.credits.map((c) => `${c.contributorId}:${c.role}`),
    ["dr-lin:病案改进", "dr-chen:夜间抢救", "nurse-wang:长期随访"],
  );
  assert.equal(view.statements.length, 3);
});

test("同一成果中相同人员相同角色不得重复计算", () => {
  const svc = teamService();
  confirmAll(svc);
  svc.adjudicate({ statementId: "stmt-record", reviewerId: "reviewer-1", achievementTitle: "年度团队荣誉" });

  svc.submitStatement({
    statementId: "stmt-dup",
    contributorId: "dr-lin",
    role: "病案改进",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    evidenceSummary: "补充登记同一项病案改进工作",
    coParticipants: [],
  });
  svc.confirmStatement({ statementId: "stmt-dup", confirmerId: "dr-lin" });
  assert.throws(
    () => svc.adjudicate({ statementId: "stmt-dup", reviewerId: "reviewer-1", achievementId: "ach-001" }),
    /重复计算/,
  );
  assert.equal(svc.achievementCount(), 1);
});

test("自动聚合只给出建议，不改变归属状态", () => {
  const svc = teamService();
  confirmAll(svc);

  const suggestions = svc.suggestAggregation();
  assert.equal(suggestions.length, 1);
  assert.deepEqual(
    suggestions[0].statementIds.slice().sort(),
    ["stmt-followup", "stmt-record", "stmt-rescue"],
  );
  assert.match(suggestions[0].rationale, /仅供审核人参考/);

  assert.equal(svc.internalStatementView("stmt-record").status, "confirmed");
  assert.equal(svc.internalStatementView("stmt-record").achievementId, null);
  assert.equal(svc.achievementCount(), 0);
});

test("确认须由当事人本人完成，裁定须由独立审核人完成", () => {
  const svc = teamService();
  assert.throws(
    () => svc.confirmStatement({ statementId: "stmt-record", confirmerId: "dr-chen" }),
    /本人/,
  );
  confirmAll(svc);
  assert.throws(
    () => svc.adjudicate({ statementId: "stmt-record", reviewerId: "dr-lin", achievementTitle: "x" }),
    /独立/,
  );
  assert.throws(
    () => svc.adjudicate({ statementId: "stmt-record", reviewerId: "dr-chen", achievementTitle: "x" }),
    /独立/,
  );
});

test("并发裁定：同一声明只有一个裁定生效", () => {
  const svc = new HonorArchiveService();
  svc.submitStatement({
    statementId: "s1",
    contributorId: "dr-a",
    role: "夜间抢救",
    periodStart: "2026-01-01",
    periodEnd: "2026-02-01",
    evidenceSummary: "主持抢救",
    coParticipants: [],
  });
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a" });
  const version = svc.internalStatementView("s1").version;

  svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-1", achievementTitle: "成果甲", expectedVersion: version });
  assert.throws(
    () => svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-2", achievementTitle: "成果乙", expectedVersion: version }),
    /不可裁定/,
  );
  assert.equal(svc.achievementCount(), 1);
});

test("并发裁定：复核期间版本已推进则报裁定冲突", () => {
  const svc = new HonorArchiveService();
  svc.submitStatement({
    statementId: "s1",
    contributorId: "dr-a",
    role: "夜间抢救",
    periodStart: "2026-01-01",
    periodEnd: "2026-02-01",
    evidenceSummary: "主持抢救",
    coParticipants: [],
  });
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a" });
  const stale = svc.internalStatementView("s1").version;
  svc.attachProof({ statementId: "s1", proof: { content: { log: 1 }, evidenceSummary: "与登记摘要冲突" } });
  assert.equal(svc.internalStatementView("s1").status, "pending_review");

  assert.throws(
    () => svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-1", achievementTitle: "成果", expectedVersion: stale }),
    /裁定冲突/,
  );
});
