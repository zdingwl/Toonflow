export type ProductionStage =
  | "director_plan"
  | "derive_assets"
  | "generate_assets"
  | "storyboard"
  | "video";

export interface ProductionState {
  projectId: number;
  episodesId: number;
  stage: ProductionStage;
  planRevision: number;
  assetRevision: number;
  storyboardRevision: number;
  updatedAt: number;
}

export function createProductionState(projectId: number, episodesId: number): ProductionState {
  return {
    projectId,
    episodesId,
    stage: "director_plan",
    planRevision: 0,
    assetRevision: 0,
    storyboardRevision: 0,
    updatedAt: Date.now(),
  };
}
