import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HonorArchiveService } from "../src/service.js";

const clock = () => "2026-09-25T10:00:00+08:00";

test("重启后继续撤回通知与异议期限，状态完整恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honor-archive-"));
  const file = join(dir, "events.jsonl");
  try {
    const a = new HonorArchiveService({ filePath: file, now: clock });
    a.submitStatement({
      statementId: "s1",
      contributorId: "dr-a",
      role: "夜间抢救",
      periodStart: "2026-01-01",
      periodEnd: "2026-02-01",
      evidenceSummary: "主持抢救",
      coParticipants: [],
    });
    a.confirmStatement({ statementId: "s1", confirmerId: "dr-a" });
    a.adjudicate({ statementId: "s1", reviewerId: "reviewer-1", achievementTitle: "年度团队荣誉" });
    a.grantConsent({
      grantId: "grant-1",
      subjectId: "patient-1",
      storyRef: "story-1",
      purposes: ["公开宣传"],
      channels: ["官网", "公众号"],
      validFrom: "2026-01-01T00:00:00+08:00",
      validUntil: "2026-12-31T23:59:59+08:00",
      summary: "获准公开摘要。",
    });
    a.releaseStory({ storyId: "story-1", version: 1, purpose: "公开宣传", channel: "公众号" });
    const { noticeId } = a.withdrawConsent({ grantId: "grant-1", channels: ["公众号"] });
    a.fileObjection({
      objectionId: "obj-r",
      targetType: "achievement",
      targetId: "ach-001",
      reason: "归属待核",
      filedBy: "dr-b",
      deadline: "2026-10-01T00:00:00+08:00",
    });

    // 重启：新实例重放同一日志
    const b = new HonorArchiveService({ filePath: file, now: clock });
    assert.deepEqual(b.pendingNotifications().map((n) => n.id), [noticeId]);
    assert.deepEqual(
      b.pendingObjections().map((o) => [o.id, o.deadline]),
      [["obj-r", "2026-10-01T00:00:00+08:00"]],
    );
    assert.equal(b.internalAchievementView("ach-001").credits[0].contributorId, "dr-a");
    assert.throws(
      () => b.releaseStory({ storyId: "story-1", version: 2, purpose: "公开宣传", channel: "公众号" }),
      /禁止发布/,
    );

    // 重启后送达通知，再次重启后不再出现待办
    b.markNoticeDelivered({ noticeId });
    const c = new HonorArchiveService({ filePath: file, now: clock });
    assert.equal(c.pendingNotifications().length, 0);
    assert.equal(c.log.events.length, b.log.events.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
