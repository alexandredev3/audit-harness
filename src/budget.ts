import type { Profile } from "./types.ts";

export const RECON_CALLS = 4;
export const PLANNER_CALLS = 1;

export const criticReserve = (profile: Profile) => (profile === "quick" ? 1 : 2);

export const verifiersPerCandidate = (profile: Profile) => (profile === "quick" ? 1 : 2);

export function minimumBudget(profile: Profile): number {
  return RECON_CALLS + PLANNER_CALLS + criticReserve(profile) + 1;
}

export function hunterAllowance(input: {
  remaining: number;
  profile: Profile;
  pendingCandidates: number;
}): number {
  if (input.remaining === Infinity) return Infinity;
  const afterCritics = input.remaining - criticReserve(input.profile);
  const validation = Math.max(
    1,
    input.pendingCandidates * verifiersPerCandidate(input.profile),
    Math.ceil(afterCritics * 0.3),
  );
  return Math.max(0, afterCritics - validation);
}

export function hunterReserve(profile: Profile, pendingCandidates: number): number {
  return criticReserve(profile) + Math.max(1, pendingCandidates * verifiersPerCandidate(profile));
}
