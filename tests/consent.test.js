import assert from "node:assert/strict";
import test from "node:test";

import { HonorArchiveService } from "../src/service.js";

const GRANT = {
  grantId: "grant-1",
  subjectId: "patient-1",
  storyRef: "story-1",
  purposes: ["公开宣传", "内部教育"],
  channels: ["官网", "公众号"],
  validFrom: "2026-01-01T00:00:00+08:00",
  validUntil: "2026-12-31T23:59:59+08:00",
  summary: "获准公开摘要：团队完成高难度救治。",
};

function consentService() {
  const svc = new HonorArchiveService();
  svc.grantConsent(GRANT);
  return svc;
}

test("发布受用途、渠道与有效期约束，仅保存获准摘要", () => {
  const svc = consentService();
  svc.releaseStory({ storyId: "story-1", version: 1, purpose: "公开宣传", channel: "官网", at: "2026-06-01T10:00:00+08:00" });

  assert.throws(
    () => svc.releaseStory({ storyId: "story-1", version: 2, purpose: "商业推广", channel: "官网", at: "2026-06-01T10:00:00+08:00" }),
    /禁止发布/,
  );
  assert.throws(
    () => svc.releaseStory({ storyId: "story-1", version: 2, purpose: "公开宣传", channel: "官网", at: "2027-01-01T00:00:00+08:00" }),
    /禁止发布/,
  );

  const pub = svc.publicStoryView("story-1");
  assert.equal(pub.versions[0].summary, "获准公开摘要：团队完成高难度救治。");
  assert.deepEqual(
    Object.keys(pub.versions[0]).sort(),
    ["channel", "dispositions", "purpose", "releasedAt", "summary", "version"],
  );
});

test("部分撤回：只阻止撤回范围内的新发布，并为已发布版本追加处置", () => {
  const svc = consentService();
  svc.releaseStory({ storyId: "story-1", version: 1, purpose: "公开宣传", channel: "官网", at: "2026-06-01T10:00:00+08:00" });
  svc.releaseStory({ storyId: "story-1", version: 2, purpose: "公开宣传", channel: "公众号", at: "2026-06-02T10:00:00+08:00" });
  svc.releaseStory({ storyId: "story-1", version: 3, purpose: "内部教育", channel: "官网", at: "2026-06-03T10:00:00+08:00" });

  const { noticeId, affected } = svc.withdrawConsent({ grantId: "grant-1", channels: ["公众号"] });
  assert.deepEqual(affected, [{ storyId: "story-1", version: 2 }]);

  // 撤回范围内的新发布被阻止，范围外仍可发布
  assert.throws(
    () => svc.releaseStory({ storyId: "story-1", version: 4, purpose: "内部教育", channel: "公众号", at: "2026-06-04T10:00:00+08:00" }),
    /禁止发布/,
  );
  svc.releaseStory({ storyId: "story-1", version: 4, purpose: "公开宣传", channel: "官网", at: "2026-06-04T10:00:00+08:00" });

  // 处置标注只落在撤回范围内的已发布版本，历史版本内容保持原样
  const pub = svc.publicStoryView("story-1");
  const byVersion = new Map(pub.versions.map((v) => [v.version, v]));
  assert.equal(byVersion.get(1).dispositions.length, 0);
  assert.equal(byVersion.get(2).dispositions.length, 1);
  assert.match(byVersion.get(2).dispositions[0].note, /停止新发布/);
  assert.equal(byVersion.get(2).summary, "获准公开摘要：团队完成高难度救治。");
  assert.equal(byVersion.get(3).dispositions.length, 0);

  // 撤回通知指明必须停止使用的版本，送达后不再待办
  assert.deepEqual(svc.pendingNotifications().map((n) => n.id), [noticeId]);
  svc.markNoticeDelivered({ noticeId });
  assert.equal(svc.pendingNotifications().length, 0);
});

test("全部撤回后任何新发布都被阻止，同意链完整还原", () => {
  const svc = consentService();
  svc.releaseStory({ storyId: "story-1", version: 1, purpose: "公开宣传", channel: "官网", at: "2026-06-01T10:00:00+08:00" });
  svc.withdrawConsent({ grantId: "grant-1" });

  assert.throws(
    () => svc.releaseStory({ storyId: "story-1", version: 2, purpose: "内部教育", channel: "官网", at: "2026-06-05T10:00:00+08:00" }),
    /禁止发布/,
  );

  const chain = svc.internalConsentChain("story-1");
  assert.equal(chain.grants[0].status, "withdrawn");
  assert.equal(chain.grants[0].activePairs.length, 0);
  assert.equal(chain.grants[0].withdrawals.length, 1);
  assert.equal(chain.releases[0].dispositions.length, 1);
  assert.equal(chain.notices.length, 1);
});
