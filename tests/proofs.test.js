import assert from "node:assert/strict";
import test from "node:test";

import { HonorArchiveService } from "../src/service.js";

function submitted() {
  const svc = new HonorArchiveService();
  svc.submitStatement({
    statementId: "s1",
    contributorId: "dr-a",
    role: "长期随访",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    evidenceSummary: "完成随访",
    coParticipants: [],
    proof: { content: { report: "R-1" }, source: "his" },
  });
  return svc;
}

test("重复证明按指纹归并，来源保留", () => {
  const svc = submitted();
  svc.attachProof({ statementId: "s1", proof: { content: { report: "R-1" } }, source: "email" });
  const view = svc.internalStatementView("s1");
  assert.equal(view.proofs.length, 1);
  assert.deepEqual(view.proofs[0].sources.slice().sort(), ["email", "his"]);
});

test("离线确认按指纹归并，重复确认不改变状态", () => {
  const svc = submitted();
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a", offlineProof: { content: "paper-form-7" } });
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a", offlineProof: { content: "paper-form-7" } });
  const view = svc.internalStatementView("s1");
  assert.equal(view.status, "confirmed");
  assert.equal(view.confirmations.length, 2);
  assert.equal(view.confirmations[0].merged, false);
  assert.equal(view.confirmations[1].merged, true);
});

test("迟到证明：一致的补充直接归档，归属不变", () => {
  const svc = submitted();
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a" });
  svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-1", achievementTitle: "年度团队荣誉" });

  svc.attachProof({ statementId: "s1", proof: { content: { log: "L-9" }, evidenceSummary: "完成随访" }, source: "ward" });
  const view = svc.internalStatementView("s1");
  assert.equal(view.status, "adjudicated");
  assert.equal(view.proofs.length, 2);
  assert.equal(svc.internalAchievementView("ach-001").credits[0].suspended, false);
});

test("迟到证明：冲突内容等待复核，已计入说明挂起，复核后恢复", () => {
  const svc = submitted();
  svc.confirmStatement({ statementId: "s1", confirmerId: "dr-a" });
  svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-1", achievementTitle: "年度团队荣誉" });

  svc.attachProof({ statementId: "s1", proof: { content: { log: "L-10" }, evidenceSummary: "实际为协助随访" }, source: "ward" });
  let view = svc.internalStatementView("s1");
  assert.equal(view.status, "pending_review");
  assert.equal(view.conflicts.length, 1);
  assert.equal(svc.internalAchievementView("ach-001").credits[0].suspended, true);

  svc.adjudicate({ statementId: "s1", reviewerId: "reviewer-2", role: "协助随访" });
  view = svc.internalStatementView("s1");
  assert.equal(view.status, "adjudicated");
  const credits = svc.internalAchievementView("ach-001").credits;
  assert.equal(credits[0].suspended, false);
  assert.equal(credits[0].role, "协助随访");
  assert.equal(svc.achievementCount(), 1);
});
