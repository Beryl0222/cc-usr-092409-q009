import { AGGREGATE_TYPES, EVENT_TYPES } from "./events.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

// 只校验事件信封本身；业务字段的规则由各聚合在写入时保证。
export function validateEvent(record) {
  const errors = required
    .filter((name) => record == null || !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (record == null || typeof record !== "object") return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) errors.push("event_id 必须是非空字符串");
  if ("event_type" in record && !Object.values(EVENT_TYPES).includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !Object.values(AGGREGATE_TYPES).includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是可解析的时间字符串");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  return errors;
}
