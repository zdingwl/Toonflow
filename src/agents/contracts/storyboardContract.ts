export interface StoryboardContractResult {
  valid: boolean;
  errors: string[];
}

export function validateStoryboardContract(input: {
  content: string;
  maxSeconds?: number;
}): StoryboardContractResult {
  const errors: string[] = [];

  if (!input.content.trim()) {
    errors.push("storyboard content is empty");
  }

  if (input.maxSeconds !== undefined) {
    const durationMatches = [...input.content.matchAll(/(\d+)s/g)].map((m) => Number(m[1]));
    const total = durationMatches.reduce((a, b) => a + b, 0);
    if (total > input.maxSeconds) {
      errors.push(`duration exceeded: ${total}s > ${input.maxSeconds}s`);
    }
  }

  return { valid: errors.length === 0, errors };
}
