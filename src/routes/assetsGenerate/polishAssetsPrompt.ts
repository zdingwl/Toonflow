import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { type AssetPromptType } from "@/utils/assetPrompt";
import { generateAssetPrompt, loadAssetPromptContext } from "@/utils/assetPromptGeneration";
const router = express.Router();


type ItemType = "characters" | "props" | "scenes";

//润色提示词
export default router.post(
  "/",
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.enum(["role", "scene", "tool"]),
    name: zod.string(),
    describe: zod.string(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, name, describe } = req.body;
    //获取风格
    const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));


    //查询资产是否是衍生资产
    const assetsData = await u.db("o_assets").where({ id: assetsId, projectId, type }).select("assetsId").first();
    if (!assetsData) return res.status(404).send(error("资产不存在、类型不符或不属于当前项目"));
    const typeConfig: Record<string, { promptKey: string; itemType: ItemType; label: string; nameLabel: string; visualManual: string; assetType: AssetPromptType }> = {
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
        visualManual: assetsData.assetsId ? "art_character_derivative" : "art_character",
        assetType: "role",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
        visualManual: assetsData.assetsId ? "art_scene_derivative" : "art_scene",
        assetType: "scene",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
        visualManual: assetsData.assetsId ? "art_prop_derivative" : "art_prop",
        assetType: "tool",
      },
    };

    const config = typeConfig[type];
    if (!config) return res.status(500).send(error("不支持的类型"));
    if (!config.visualManual) return res.status(500).send(error("视觉手册未定义"));
    //获取到视觉手册
    const visualManual = await u.getArtPrompt(project.artStyle as string, "art_skills", config.visualManual);
    if (!visualManual) return res.status(500).send(error("视觉手册未定义"));
    await u.db("o_assets").where({ id: assetsId, projectId }).update({ promptState: "生成中", promptErrorReason: null });
    try {
      const context = await loadAssetPromptContext(u.db, { projectId, assetsId, type, name, describe });
      const prompt = await generateAssetPrompt({
        loadImage: path => u.oss.getImageBase64(path),
        invoke: input => u.Ai.Text("universalAi").invoke(input),
      }, context, visualManual);
      await u.db("o_assets").where({ id: assetsId, projectId }).update({ prompt, promptState: "已完成", promptErrorReason: null });
      res.status(200).send(success({ prompt, assetsId }));
    } catch (e: any) {
      await u
        .db("o_assets")
        .where({ id: assetsId, projectId })
        .update({ promptState: "生成失败", promptErrorReason: u.error(e).message });
      return res.status(500).send(error(e?.data?.error?.message ?? e?.message ?? "生成失败"));
    }
  },
);
