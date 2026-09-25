export interface RevisionState {
  plan: number;
  asset: number;
  storyboard: number;
  video: number;
}

export function nextRevision(current: RevisionState, key: keyof RevisionState): RevisionState {
  return {
    ...current,
    [key]: current[key] + 1,
  };
}

export function createRevisionState(): RevisionState {
  return {
    plan: 0,
    asset: 0,
    storyboard: 0,
    video: 0,
  };
}
