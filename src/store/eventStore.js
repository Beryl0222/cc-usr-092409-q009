// 基于 JSONL 文件的事件存储：每个聚合流一个只追加文件。
// 进程内用串行链保证读-校验-写的原子性；expectedVersion 提供乐观并发。
import { mkdir, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { validateEvent } from "../validator.js";

export class ConcurrencyError extends Error {
  constructor(streamId, expected, actual) {
    super(`并发修改冲突：${streamId} 期望版本 ${expected}，实际 ${actual}`);
    this.name = "ConcurrencyError";
    this.code = "CONCURRENT_MODIFICATION";
    this.streamId = streamId;
    this.expected = expected;
    this.actual = actual;
  }
}

function safeName(streamId) {
  return encodeURIComponent(streamId);
}

export class FileEventStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.eventsDir = join(rootDir, "events");
    this.cache = new Map(); // streamId -> 已解析事件数组
    this.chain = Promise.resolve();
  }

  async init() {
    await mkdir(this.eventsDir, { recursive: true });
  }

  // 把异步任务串行化，避免同一进程内并发命令交叉写入。
  async withLock(task) {
    const run = this.chain.then(() => task());
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #fileOf(streamId) {
    return join(this.eventsDir, `${safeName(streamId)}.ndjson`);
  }

  async load(streamId) {
    if (this.cache.has(streamId)) return this.cache.get(streamId);
    let text;
    try {
      text = await readFile(this.#fileOf(streamId), "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      text = "";
    }
    const events = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    this.cache.set(streamId, events);
    return events;
  }

  async versionOf(streamId) {
    return (await this.load(streamId)).length;
  }

  // 在一次原子操作内追加一个或多个事件；expectedVersion 为命令开始时读取到的流长度。
  async append(streamId, events, expectedVersion) {
    return this.withLock(() => this.appendUnsafe(streamId, events, expectedVersion));
  }

  // 已持有 store 锁时（如 ArchiveService 的事务内）使用，避免重入死锁。
  async appendUnsafe(streamId, events, expectedVersion) {
    const current = await this.load(streamId);
    if (expectedVersion != null && expectedVersion !== current.length) {
      throw new ConcurrencyError(streamId, expectedVersion, current.length);
    }
    let nextVersion = current.length;
    const stored = [];
    for (const event of events) {
      const errors = validateEvent(event);
      if (errors.length > 0) throw new Error(`事件校验失败：${errors.join("；")}`);
      nextVersion += 1;
      if (event.version !== nextVersion) {
        throw new Error(`事件版本不连续：期望 ${nextVersion}，实际 ${event.version}`);
      }
      stored.push(event);
    }
    if (stored.length === 0) return [];
    const line = stored.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(this.#fileOf(streamId), line, "utf8");
    this.cache.set(streamId, [...current, ...stored]);
    return stored;
  }

  // 在持锁临界区内统计某流长度（与决策依据同源，杜绝 check-then-act 窗口）。
  async streamLengthUnsafe(streamId) {
    return (await this.load(streamId)).length;
  }

  // 全量事件（内部审计/投影视图用）。默认按发生时间排序。
  async allEvents() {
    let names = [];
    try {
      names = await readdir(this.eventsDir);
    } catch {
      return [];
    }
    const all = [];
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const streamId = decodeURIComponent(name.slice(0, -".ndjson".length));
      all.push(...(await this.load(streamId)));
    }
    return all.sort((a, b) => {
      const t = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
      return t !== 0 ? t : a.event_id.localeCompare(b.event_id);
    });
  }
}
