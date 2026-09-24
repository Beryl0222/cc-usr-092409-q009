// 测试夹具：在临时目录构建“病案改进 / 夜间抢救 / 长期随访”三人团队的完整场景。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchiveService } from "../src/archiveService.js";
import { ArchiveQueries } from "../src/readModel.js";
import { fingerprintOf } from "../src/fingerprint.js";

export const T0 = "2026-09-20T09:00:00+08:00";
export const T1 = "2026-09-20T10:00:00+08:00";
export const T2 = "2026-09-20T11:00:00+08:00";
export const T3 = "2026-09-20T12:00:00+08:00";
export const T4 = "2026-09-21T09:00:00+08:00";

export async function makeHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "honor-archive-"));
  const delivered = [];
  const sink = options.sink ?? (async (notice) => delivered.push(notice));
  const service = await ArchiveService.create(dir, { sink, clock: options.clock });
  const queries = new ArchiveQueries(service.store, { clock: options.clock });

  async function close() {
    await rm(dir, { recursive: true, force: true });
  }

  return { dir, service, queries, delivered, close };
}

// 三名成员分别承担：病案改进、夜间抢救、长期随访。
export const TEAM = Object.freeze({
  achievementId: "ach-2026-rescue-01",
  reviewId: "review-01",
  honorId: "honor-2026-team-award",
  members: {
    wang: { personId: "p-wang", personName: "王医生", role: "病案改进负责人", contributionId: "c-wang" },
    li: { personId: "p-li", personName: "李医生", role: "夜间抢救值班医生", contributionId: "c-li" },
    zhao: { personId: "p-zhao", personName: "赵医生", role: "长期随访负责人", contributionId: "c-zhao" }
  },
  adjudicator: { id: "p-ethics-secretary", name: "伦理秘书（独立审核人）" }
});

export async function seedTeam(service, { now = T0, acknowledge = true } = {}) {
  for (const m of Object.values(TEAM.members)) {
    await service.registerPerson({ personId: m.personId, name: m.personName, now });
    await service.declareContribution({
      reviewId: TEAM.reviewId,
      achievementId: TEAM.achievementId,
      contributionId: m.contributionId,
      personId: m.personId,
      personName: m.personName,
      role: m.role,
      duty: `${m.role}相关职责`,
      workPeriod: { from: "2026-01-01", to: "2026-08-31" },
      evidenceSummary: `${m.role}的病历、值班与随访记录摘要`,
      coParticipants: Object.values(TEAM.members)
        .filter((x) => x.personId !== m.personId)
        .map((x) => ({ person_id: x.personId, role: x.role })),
      now
    });
    if (acknowledge) {
      await service.acknowledgeContribution({ contributionId: m.contributionId, acknowledgedBy: m.personId, now });
    }
  }
}

export function entry(member, roleLabel) {
  return { contribution_id: member.contributionId, role_label: roleLabel ?? member.role };
}

export function evidenceFingerprint(kind, key) {
  return fingerprintOf(kind, key);
}

export const PATIENT = Object.freeze({
  patientId: "pat-001",
  patientName: "患者甲",
  consentId: "consent-001",
  storyId: "story-001"
});

export function webScope(overrides = {}) {
  return {
    scope_id: "scope-web",
    purpose: "honor_publicity",
    channel: "web",
    fields: ["public_summary", "team_attribution"],
    valid_until: "2027-01-01T00:00:00+08:00",
    ...overrides
  };
}

export function videoScope(overrides = {}) {
  return {
    scope_id: "scope-video",
    purpose: "honor_publicity",
    channel: "video",
    fields: ["public_summary", "team_attribution"],
    valid_until: "2027-01-01T00:00:00+08:00",
    ...overrides
  };
}
