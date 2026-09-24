import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { bindH3Prompt, prepareH3ReferencePlan } from "@/utils/h3GenerationContract";
import { checkH3DialogueBudget, h3DialogueLocaleInstruction, resolveH3DialogueLocale } from "@/utils/h3DialogueLanguage";
import { assertH3PictureSlots } from "@/utils/h3VisualStateGuard";

const router = express.Router();
const view = z.enum(["BOARD", "FACE", "FRONT", "SIDE", "BACK"]);
const refMode = z.enum(["board", "auto", "manual"]);
const shotView = z.enum(["front", "side", "back", "turn", "closeup"]);
const infoSchema = z.object({
  id: z.number(), sources: z.string(), reference: z.boolean().optional(),
  slotType: z.string().optional(), fileType: z.string().optional(), prompt: z.string().optional(),
  h3ReferenceMode: refMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
});
type Info = z.infer<typeof infoSchema>;
const isH3 = (model: string) => /minimax/i.test(model) && /h3/i.test(model);
const xml = (value: unknown) => String(value ?? "").replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] || ch);
const headers = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"];
function validateH3Output(text: string, count: number, locale: string, duration: number): void {
  let previous = -1;
  for (const heading of headers) {
    const first = text.indexOf(heading);
    if (first < 0 || first <= previous || text.indexOf(heading, first + heading.length) >= 0) throw new Error(`H3 提示词缺少、有重复或顺序错误：${heading}`);
    previous = first;
  }
  assertH3PictureSlots(text, count);
  if (locale !== "original") {
    const lines = [...text.matchAll(/<d>\s*\[[^\]]+\]\s*([^<]*?)\s*<\/d>/g)].map(match => match[1].trim());
    const budget = checkH3DialogueBudget(lines, locale, duration);
    if (!budget.fits) throw new Error(`翻译后的对白预计需要 ${budget.estimatedSeconds}s，当前镜头仅 ${duration}s；请局部精简译文、调整镜头或拆镜，不能自动延长整集`);
    const languageTag = /\<d\>\s*\[([^\]]+)\]/g;
    if (text.includes("<d>") && ![...text.matchAll(languageTag)].length) throw new Error("H3 翻译对白缺少语言标签，需重新生成");
  }
}

export default router.post("/", validateFields({
  trackId: z.number(), projectId: z.number(), info: z.array(infoSchema),
  model: z.string(), mode: z.string(), dialogueLocale: z.string().optional(),
  h3ReferenceMode: refMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
}), async (req, res) => {
  const { trackId, projectId, info, model, mode } = req.body as {
    trackId: number; projectId: number; info: Info[]; model: string; mode: string;
  };
  try {
    const h3 = isH3(model);
    const locale = h3 ? resolveH3DialogueLocale(req.body.dialogueLocale) : "original";
    const track = await u.db("o_videoTrack").where({ id: trackId, projectId }).select("duration").first();
    const project = await u.db("o_project").where({ id: projectId }).select("artStyle").first();
    if (!track || !project) throw new Error("视频轨道或项目不存在");
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成中" });
    const storyboard = (await Promise.all(info.filter(item => item.sources === "storyboard").map(async item => {
      const found = await u.db("o_storyboard").where({ id: item.id, projectId }).select("id", "videoDesc", "prompt", "track", "duration", "filePath").first();
      return found || null;
    }))).filter(Boolean) as { id: number; videoDesc?: string; prompt?: string; track?: string; duration?: number; filePath?: string }[];
    const assets = (await Promise.all(info.filter(item => item.sources === "assets").map(async item => {
      const found = await u.db("o_assets").where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .select("o_assets.id", "o_assets.type", "o_assets.name", "o_assets.describe", "o_assets.prompt as assetPrompt", "o_image.filePath").first();
      return found || null;
    }))).filter(Boolean) as { id: number; type: string; name: string; describe?: string; assetPrompt?: string; filePath?: string }[];
    const options = { h3ReferenceMode: req.body.h3ReferenceMode, h3Views: req.body.h3Views, h3ShotView: req.body.h3ShotView };
    const plan = h3 ? await prepareH3ReferencePlan(projectId, info.map(item => ({
      ...item, type: item.slotType,
    })), options) : null;
    const { 0: vendorId, 1: modelData } = model.split(/:(.+)/);
    const modelLower = String(modelData || "").toLowerCase();
    const promptRoot = u.getPath(["modelPrompt"]);
    let template: string | undefined;
    if (h3 && plan?.pictures.length) {
      template = await fs.readFile(path.join(promptRoot, "video", "minimaxH3Multi-referenceMode.md"), "utf-8");
    } else {
      const custom = await u.db("o_modelPrompt").where({ vendorId, model: modelData }).first();
      if (custom?.path) try { template = await fs.readFile(path.join(promptRoot, custom.path), "utf-8"); } catch { /* fallback */ }
      if (!template) {
        let name: string | null = null;
        if (modelLower.includes("wan") && modelLower.includes("2.6")) name = "wan2.6Single-imageFirstFrameMode.md";
        else if (/seedance.*2[.\-]0/i.test(modelLower)) name = "seedance2Multi-parameterMode.md";
        else if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) name = "universalFirstAndLastFrameMode.md";
        else if (mode.startsWith('["')) name = "universalMulti-parameterMode.md";
        else if (h3) name = "universalMulti-parameterMode.md";
        if (name) try { template = await fs.readFile(path.join(promptRoot, "video", name), "utf-8"); } catch { /* fallback */ }
      }
      if (!template) {
        const common = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
        template = common?.useData || common?.data || "";
      }
    }
    const storyboardDuration = storyboard.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const duration = Math.max(4, Math.min(15, Math.round(Number(track.duration) || storyboardDuration || 5)));
    const referenceSlots = plan
      ? plan.pictures.map(p => `<reference slot="${p.picture}" sources="assets" id="${p.id}" type="${xml(p.assetType)}" view="${p.view}" name="${xml(p.name)}" />`).join("\n")
      : info.filter(item => item.reference !== false).map((item, index) => `<reference slot="${index + 1}" sources="${xml(item.sources)}" id="${item.id}" />`).join("\n");
    const definitions = plan
      ? plan.pictures.map(p => `<asset picture="&lt;Picture ${p.picture}&gt;" assetId="${p.id}" parentAssetId="${p.parentAssetId ?? ""}" view="${p.view}" type="${xml(p.assetType)}" name="${xml(p.name)}">\ndescribe=${JSON.stringify(p.description)}\nvisualPrompt=${JSON.stringify(p.assetPrompt)}\n</asset>`).join("\n")
      : "";
    const manual = u.getArtPrompt(project.artStyle || "无", "art_skills", "art_storyboard_video");
    const content = [
      `模型名称=${modelData}; target_duration=${duration}s; dialogue_locale=${locale};`,
      h3 ? h3DialogueLocaleInstruction(locale) : "",
      `<referenceSlots>\n${referenceSlots}\n</referenceSlots>`,
      `<assetDefinitions>\n${definitions}\n</assetDefinitions>`,
      `<storyboardGuidance>${storyboard.map(item => JSON.stringify({ id: item.id, videoDesc: item.videoDesc, imagePrompt: item.prompt })).join("\n")}</storyboardGuidance>`,
      `原始角色及场景信息：${JSON.stringify(assets.map(item => ({ id: item.id, name: item.name, type: item.type })) )}`,
      `原始分镜（对白原文不得丢失；选择其他语言时只翻译发声内容）：${JSON.stringify(storyboard.map(item => ({ id: item.id, videoDesc: item.videoDesc, duration: item.duration, track: item.track })))}`,
    ].join("\n\n");
    const { text } = await u.Ai.Text("universalAi").invoke({
      system: template + (h3 ? `\n\n${h3DialogueLocaleInstruction(locale)}` : ""),
      messages: [{ role: "assistant", content: String(manual || "") }, { role: "user", content }],
    });
    if (!text?.trim()) throw new Error("文本模型没有返回有效视频提示词");
    if (h3 && plan?.pictures.length) validateH3Output(text, plan.pictures.length, locale, duration);
    const saved = h3 && plan ? bindH3Prompt(text, plan) : text;
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "已完成", prompt: saved });
    return res.status(200).send(success(saved));
  } catch (cause) {
    await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ state: "生成失败", reason: u.error(cause).message });
    return res.status(400).send(error(u.error(cause).message));
  }
});
