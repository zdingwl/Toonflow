import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { evaluateVideoPromptBinding, getDefaultVideoPromptPath } from "@/utils/modelPromptTemplates";
const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const root = u.getPath(["modelPrompt"]);
    const dataList = await u.db("o_vendorConfig").select("id").where("enable", 1);
    const data = await Promise.all(dataList.map(async item => {
      const vendor = u.vendor.getVendor(item.id!);
      const bindings = await u.db("o_modelPrompt").where("vendorId", item.id).select("*");
      const models = await u.vendor.getModelList(item.id!);
      const promptList = await Promise.all(models.filter((model: any) => model.type === "video").map(async (model: any) => {
        const binding = bindings.find(binding => binding.model === model.modelName);
        const modes = Array.isArray(model.mode) ? model.mode : [];
        const preferredMode = modes.find(Array.isArray) || modes.find((mode: any) => ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) || "text";
        const mode = typeof preferredMode === "string" ? preferredMode : JSON.stringify(preferredMode);
        const automaticPaths = new Set(modes.map((mode: any) => getDefaultVideoPromptPath(model.modelName, typeof mode === "string" ? mode : JSON.stringify(mode))));
        const effective = await evaluateVideoPromptBinding(root, model.modelName, binding, mode);
        const automatic = binding?.path ? await evaluateVideoPromptBinding(root, model.modelName, undefined, mode) : effective;
        return { name: model.name, type: "video", model: model.modelName, fileName: binding?.fileName || "", path: binding?.path || "", defaultPath: automatic.effectivePath, autoModeDependent: automaticPaths.size > 1, ...effective };
      }));
      return { id: item.id, name: vendor.name, promptList };
    }));
    res.status(200).send(success(data.filter(provider => provider.promptList.length)));
  } catch (cause) {
    res.status((cause as any).status || 500).send(error(u.error(cause).message));
  }
});
