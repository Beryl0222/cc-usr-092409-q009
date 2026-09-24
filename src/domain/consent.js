// 患者同意聚合（consent_grant）的纯函数归约。
// 同意按“用途 × 渠道 × 有效期”逐项控制，最小披露；撤回只移除授权，不删除同意史。
import { EVENT_TYPES as T } from "../events.js";

export function emptyConsent() {
  return {
    exists: false,
    patientId: null,
    patientName: null,
    grantedBy: null, // patient 或 family
    scopes: [], // 当前有效授权项
    withdrawals: [], // 撤回/收窄历史（仅影响新的发布）
    history: []
  };
}

export function foldConsent(events) {
  let state = emptyConsent();
  for (const e of events) state = applyConsent(state, e);
  return state;
}

export function applyConsent(state, e) {
  switch (e.event_type) {
    case T.CONSENT_GRANTED: {
      const scopes = [...state.scopes];
      for (const s of e.scopes ?? []) {
        scopes.push({
          scopeId: s.scope_id,
          purpose: s.purpose,
          channel: s.channel,
          fields: s.fields ?? [],
          validFrom: e.occurred_at,
          validUntil: s.valid_until ?? null,
          withdrawn: false
        });
      }
      return {
        ...state,
        exists: true,
        patientId: e.patient_id,
        patientName: e.patient_name,
        grantedBy: e.granted_by ?? state.grantedBy,
        scopes,
        history: [...state.history, { at: e.occurred_at, kind: "granted", scopeIds: (e.scopes ?? []).map((s) => s.scope_id), grantId: e.consent_id }]
      };
    }

    case T.CONSENT_WITHDRAWN: {
      const targetIds = new Set(e.scope_ids ?? []);
      const scopes = state.scopes.map((s) => {
        if (!targetIds.has(s.scopeId)) return s;
        return { ...s, withdrawn: true, withdrawnAt: e.occurred_at, reason: e.reason ?? null };
      });
      return {
        ...state,
        scopes,
        withdrawals: [
          ...state.withdrawals,
          { at: e.occurred_at, scopeIds: e.scope_ids ?? [], reason: e.reason ?? null, blocksNewRelease: true }
        ],
        history: [...state.history, { at: e.occurred_at, kind: "withdrawn", scopeIds: e.scope_ids ?? [] }]
      };
    }

    default:
      return state;
  }
}

// 某用途+渠道+字段在指定时刻是否仍获授权（未撤回、在有效期内）。
export function isPermitted(state, { purpose, channel, fields = [], at }) {
  const when = Date.parse(at);
  for (const s of state.scopes) {
    if (s.withdrawn) continue;
    if (s.purpose !== purpose || s.channel !== channel) continue;
    if (s.validUntil != null && Date.parse(s.validUntil) < when) continue;
    const allowed = s.fields ?? [];
    if (fields.length === 0) return true;
    if (fields.every((f) => allowed.includes(f))) return true;
  }
  return false;
}

// 列出当前仍然有效的授权项。
export function activeScopes(state, { at } = {}) {
  const when = at ? Date.parse(at) : Infinity;
  return state.scopes.filter((s) => !s.withdrawn && (s.validUntil == null || Date.parse(s.validUntil) >= when));
}
