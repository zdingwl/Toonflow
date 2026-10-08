import { readManagedPrompt } from "./managedPromptDefaults";

export async function getPrompts(type: string) {
  if (type === "event") return readManagedPrompt("eventExtraction");
}
