// 荣誉提名聚合（honor_nomination）：历史提名与投票只增不改，归属更正不回溯改写。
import { EVENT_TYPES as T } from "../events.js";

export function emptyHonor() {
  return { exists: false, honorId: null, achievementId: null, nomineeId: null, nominations: [], votes: [] };
}

export function foldHonor(events) {
  let state = emptyHonor();
  for (const e of events) state = applyHonor(state, e);
  return state;
}

export function applyHonor(state, e) {
  switch (e.event_type) {
    case T.NOMINATION_SUBMITTED:
      return {
        ...state,
        exists: true,
        honorId: e.honor_id ?? state.honorId,
        achievementId: e.achievement_id ?? state.achievementId,
        nominations: [
          ...state.nominations,
          {
            id: e.nomination_id,
            at: e.occurred_at,
            nomineeId: e.nominee_id,
            nomineeName: e.nominee_name,
            claimedAttribution: e.claimed_attribution ?? null,
            reviewId: e.review_id ?? null
          }
        ]
      };

    case T.NOMINATION_VOTED: {
      // 历史投票原样保留；同一提名内同一投票人一次。
      if (state.votes.some((v) => v.nominationId === e.nomination_id && v.voterId === e.voter_id)) return state;
      return {
        ...state,
        votes: [
          ...state.votes,
          { nominationId: e.nomination_id, nominationVersion: e.version - 1, at: e.occurred_at, voterId: e.voter_id, choice: e.choice }
        ]
      };
    }

    default:
      return state;
  }
}
