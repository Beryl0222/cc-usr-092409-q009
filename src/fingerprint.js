import { createHash } from "node:crypto";

// 稳定序列化：对象键排序后展开，保证同一内容得到同一指纹。
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const body = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",");
  return `{${body}}`;
}

export function fingerprintOf(payload) {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}
