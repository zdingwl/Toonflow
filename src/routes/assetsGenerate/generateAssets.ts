import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  buildAssetImagePrompt,
  buildFluxPromptTranslationRequest,
  needsFluxPromptTranslation,
} from "@/utils/assetPrompt";

const router = express.Router();

type AssetType = "role" | "scene" | "tool";

interface AssetTypeConfig {
  label: string;
  taskClass: string;
  dir: string;
}

const assetTypeConfig: Record<AssetType, AssetTypeConfig> = {
  role: {
    label: "角色",
    taskClass: "角色图生成",
    dir: "role",
  },
  scene: {
    label: "场景",
    taskClass: "场景图生成",
    dir: "scene",
  },
  tool: {
    label: "道具",
    taskClass: "道具图生成",
    dir: "props",
  },
};

// ─── 生成资产图片 ────────────────────────────────────────────

const requestSchema = {
  projectId: z.number(),
  model: z.string(),
  resolution: z.string(),
  id: z.number(),
  type: z.enum(["role", "scene", "tool", "storyboard"]),
  name: z.string(),
  prompt: z.string(),
  base64: z.string().optional().nullable(),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, id, type, name, prompt, base64 } = req.body;

  // 1. 查询项目 & 获取类型配置
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
  if (!project) return res.status(500).send(success({ message: "项目为空" }));

  const cfg = assetTypeConfig[type as AssetType];
  if (!cfg) return res.status(400).send(error("不支持的类型"));

  // 2. 创建图片占位记录
  const [imageId] = await u.db("o_image").insert({
    type,
    state: "生成中",
    assetsId: id,
    model: model.split(/:(.+)/)[1],
    resolution,
  });
  await u.db("o_assets").where("id", id).update({ imageId });

  // 3. 准备生成参数
  const imagePath = `/${projectId}/${cfg.dir}/${uuidv4()}.jpg`;
  const describe = `生成${cfg.label}图，名称：${name}，提示词：${prompt}`;
  const relatedObjects = { id, projectId, type: cfg.label };

  try {
    let runtimePrompt = prompt;
    let runtimeArtStyle = project.artStyle || "";
    let runtimeName = name;
    const [vendorId, selectedModelName] = model.split(/:(.+)/);
    const localPromptSource = `Art style: ${runtimeArtStyle || "unspecified"}. Asset name: ${runtimeName}. Visual facts: ${runtimePrompt}`;
    if (vendorId === "comfyui_local" && selectedModelName === "flux-schnell-local" && needsFluxPromptTranslation(localPromptSource)) {
      const translation = buildFluxPromptTranslationRequest(localPromptSource);
      const translated = (await u.Ai.Text("universalAi").invoke({
        system: translation.system,
        messages: [{ role: "user", content: translation.user }],
        temperature: 0,
      })) as any;
      runtimePrompt = String(translated?._output || "")
        .replace(/^```(?:text)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      if (!runtimePrompt || needsFluxPromptTranslation(runtimePrompt)) {
        throw new Error("本地 FLUX 提示词英文转换失败，已停止生成，避免输出与人物设定无关的图片");
      }
      runtimeArtStyle = "as specified in the translated visual facts";
      runtimeName = "the same specified character";
    }
    const userPrompt = buildAssetImagePrompt(type as AssetType, runtimeArtStyle, runtimeName, runtimePrompt);
    const aiImage = u.Ai.Image(model);
    await aiImage.run(
      {
        prompt: userPrompt,
        referenceList: base64 ? [{ type: "image", base64 }] : [],
        size: resolution,
        aspectRatio: "16:9",
      },
      {
        taskClass: cfg.taskClass,
        describe,
        projectId,
        relatedObjects: JSON.stringify(relatedObjects),
      },
    );
    aiImage.save(imagePath);
    // 5. 更新记录 & 返回结果
    const imageData = await u.db("o_image").where("id", imageId).select("*").first();
    if (!imageData) return res.status(500).send("资产已被删除");
    if (imageData.state === "生成失败") return;
    await u
      .db("o_image")
      .where("id", imageId)
      .update({
        state: "已完成",
        filePath: imagePath,
        type,
        model: model.split(/:(.+)/)[1],
        resolution,
      });

    const path = await u.oss.getSmallImageUrl(imagePath);
    await u.db("o_assets").where("id", id).update({ imageId });

    return res.status(200).send(success({ path, assetsId: id }));
  } catch (e) {
    await u
      .db("o_image")
      .where("id", imageId)
      .update({ state: "生成失败", errorReason: u.error(e).message });
    return res.status(400).send(error(u.error(e).message || "图片生成失败"));
  }
});
