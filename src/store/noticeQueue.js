// 持久化通知队列：撤回通知与异议期限提醒在重启后仍可继续处理。
// 记录追加到 notices.ndjson；投递结果也以追加方式标记，重启归约后继续。
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

let seq = 0;
function newId() {
  seq += 1;
  return `notice-${Date.now().toString(36)}-${seq}`;
}

export class NoticeQueue {
  constructor(rootDir, { sink } = {}) {
    this.path = join(rootDir, "notices.ndjson");
    this.sink = sink ?? (async () => {});
    this.notices = new Map(); // id -> record
    this.dedupe = new Set(); // 业务幂等键
    this.chain = Promise.resolve();
  }

  async init() {
    await mkdir(join(this.path, ".."), { recursive: true });
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      text = "";
    }
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      this.#apply(JSON.parse(line));
    }
  }

  #apply(record) {
    if (record.type === "notice") {
      this.notices.set(record.id, record);
      if (record.dedupe_key) this.dedupe.add(record.dedupe_key);
    } else if (record.type === "result") {
      const cur = this.notices.get(record.id);
      if (cur) this.notices.set(record.id, { ...cur, status: record.status, deliveredAt: record.at, error: record.error ?? null });
    }
  }

  async #append(record) {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.#apply(record);
  }

  // 登记一条到期通知。相同 dedupeKey 只登记一次（撤回/处置重试的幂等保证）。
  async enqueue({ kind, dueAt, target, payload = {}, dedupeKey = null }) {
    if (dedupeKey && this.dedupe.has(dedupeKey)) return null;
    const id = newId();
    await this.#append({
      type: "notice",
      id,
      kind,
      due_at: dueAt instanceof Date ? dueAt.toISOString() : dueAt,
      status: "pending",
      target,
      payload,
      dedupe_key: dedupeKey,
      created_at: new Date().toISOString()
    });
    return id;
  }

  pending() {
    return [...this.notices.values()].filter((n) => n.status === "pending");
  }

  overdue(now = new Date()) {
    const t = now instanceof Date ? now.getTime() : Date.parse(now);
    return this.pending().filter((n) => Date.parse(n.due_at) <= t);
  }

  // 投递所有到期通知；失败保留 pending，下次（含重启后）继续。
  async pump(now = new Date()) {
    const run = this.chain.then(() => this.#pumpOnce(now));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #pumpOnce(now) {
    const delivered = [];
    for (const notice of this.overdue(now)) {
      try {
        await this.sink(notice);
        await this.#append({ type: "result", id: notice.id, status: "delivered", at: new Date().toISOString() });
        delivered.push(notice);
      } catch (err) {
        await this.#append({ type: "result", id: notice.id, status: "pending", at: new Date().toISOString(), error: String(err?.message ?? err) });
      }
    }
    return delivered;
  }
}
