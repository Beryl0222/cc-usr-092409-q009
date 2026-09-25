import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// 追加式事件日志：事件落盘为 JSONL，重启后按序重放，不原地改写任何记录。
export class EventLog {
  #filePath;
  #events = [];

  constructor(filePath = null) {
    this.#filePath = filePath;
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim()) this.#events.push(JSON.parse(line));
      }
    }
  }

  get events() {
    return this.#events.slice();
  }

  append(event) {
    this.#events.push(event);
    if (this.#filePath) {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      appendFileSync(this.#filePath, `${JSON.stringify(event)}\n`);
    }
    return event;
  }
}
