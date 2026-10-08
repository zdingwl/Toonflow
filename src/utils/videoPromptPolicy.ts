/** Shared content rules apply even when a provider has its own syntax template. */
export function composeVideoPromptPolicy(common?: string | null, modelTemplate?: string | null): string {
  const policy = common?.trim() || "";
  const model = modelTemplate?.trim() || "";
  if (!model) return policy;
  if (!policy || policy === model) return model;
  return `Shared video content policy (applies to all models):\n${policy}\n\nSelected model template:\n${model}\n\nInstruction precedence: follow the shared policy for source facts, actual input fields, character identity, current state, camera intentions, timing and valid uploaded reference slots. Follow the selected model template for output sections, supported reference syntax and timestamp notation. Its examples are format demonstrations, never new plot facts or assets. Neither layer may invent an uploaded reference, replace exact dialogue, merge explicit cuts, change actor bindings, or override the project's requested video medium. Return only the selected template's complete output.`;
}
