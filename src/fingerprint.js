import { createHash } from "node:crypto";

// 规范化 JSON：相同内容无论键顺序如何都得到同一哈希。
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 证明材料的内容指纹；离线补录时凭它与既有证明归并。
export function contentHash(value) {
  return sha256Text(canonicalJson(value));
}

// 材料标识指纹：同一实体材料（如同一份病历改进报告）在任何渠道提交都应使用相同 fingerprint。
export function fingerprintOf(kind, naturalKey) {
  return `${kind}:${sha256Text(canonicalJson(naturalKey)).slice(0, 16)}`;
}
