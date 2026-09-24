import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
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
const h3Options = {
  dialogueLocale: z.string().optional(), h3ReferenceMode: refMode.optional(),
  h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
};
const infoSchema = z.object({
  id: z.number(), sources: z.string(), reference: z.boolean().optional(),
  slotType: z.string().optional(), fileType: z.string().optional(), prompt: z.string().optional(),
  h3ReferenceMode: refMode.optional(), h3Views: z.array(view).optional(), h3ShotView: shotView.optional(),
});
type TrackInput = { trackId: number; info: z.infer<typeof infoSchema>[] } & {
  dialogueLocale?: string; h3ReferenceMode?: z.infer<typeof refMode>;
  h3Views?: z.infer<typeof view>[]; h3ShotView?: z.infer<typeof shotView>;
};
const isH3 = (model: string) => /minimax/i.test(model) && /h3/i.test(model);
const xml = (value: unknown) => String(value ?? "").replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] || ch);
const headings = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"];

export default router.post("/", validateFields({
  projectId: z.number(), trackData: z.array(z.object({ trackId: z.number(), info: z.array(infoSchema), ...h3Options })),
  mode: z.string(), model: z.string(), concurrentCount: z.number().optional(), ...h3Options,
}), async (req, res) => {
  const { trackData, projectId, mode, model, concurrentCount = 5 } = req.body as {
    trackData: TrackInput[]; projectId: number; mode: string; model: string; concurrentCount?: number;
  };
  const h3 = isH3(model);
  try {
    const [vendorId, modelData] = model.split(/:(.+)/);
    const modelLower = String(modelData || "").toLowerCase();
    const project = await u.db("o_project").where({ id: projectId }).select("artStyle").first();
    if (!project) throw new Error("项目不存在");
    const manual = String(u.getArtPrompt(project.artStyle || "无", "art_skills", "art_storyboard_video") || "");
    const root = u.getPath(["modelPrompt"]);
    const officialH3 = h3 ? await fs.readFile(path.join(root, "video", "minimaxH3Multi-referenceMode.md"), "utf-8") : "";
    const custom = await u.db("o_modelPrompt").where({ vendorId, model: modelData }).first();
    let fallback = "";
    if (custom?.path) try { fallback = await fs.readFile(path.join(root, custom.path), "utf-8"); } catch { /* fallback */ }
    if (!fallback) {
      let file: string | null = null;
      if (modelLower.includes("wan") && modelLower.includes("2.6")) file = "wan2.6Single-imageFirstFrameMode.md";
      else if (/seedance.*2[.\-]0/i.test(modelLower)) file = "seedance2Multi-parameterMode.md";
      else if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) file = "universalFirstAndLastFrameMode.md";
      else if (mode.startsWith('["') || h3) file = "universalMulti-parameterMode.md";
      if (file) try { fallback = await fs.readFile(path.join(root, "video", file), "utf-8"); } catch { /* fallback */ }
    }
    if (!fallback) {
      const common = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
      fallback = common?.useData || common?.data || "";
    }
    await u.db("o_videoTrack").where({ projectId }).whereIn("id", trackData.map(item => item.trackId)).update({ state: "生成中" });
    const limit = pLimit(Math.max(1, Math.min(20, concurrentCount)));
    const tasks = trackData.map(track => limit(async () => {
      try {
        const row = await u.db("o_videoTrack").where({ id: track.trackId, projectId }).select("duration").first();
        if (!row) throw new Error("视频轨道不属于当前项目");
        const locale = h3 ? resolveH3DialogueLocale(track.dialogueLocale ?? req.body.dialogueLocale) : "original";
        const opts = {
          h3ReferenceMode: track.h3ReferenceMode ?? req.body.h3ReferenceMode,
          h3Views: track.h3Views ?? req.body.h3Views,
          h3ShotView: track.h3ShotView ?? req.body.h3ShotView,
        };
        const plan = h3 ? await prepareH3ReferencePlan(projectId, track.info.map(item => ({ ...item, type: item.slotType })), opts) : null;
        const storyboard = (await Promise.all(track.info.filter(item => item.sources === "storyboard").map(async item => {
          const found = await u.db("o_storyboard").where({ id: item.id, projectId }).select("id", "videoDesc", "prompt", "track", "duration").first();
          return found || null;
        }))).filter(Boolean) as { id: number; videoDesc?: string; prompt?: string; track?: string; duration?: number }[];
        const assets = (await Promise.all(track.info.filter(item => item.sources === "assets").map(async item => {
          const found = await u.db("o_assets").where({ "o_assets.id": item.id, "o_assets.projectId": projectId }).select("id", "type", "name").first();
          return found || null;
        }))).filter(Boolean);
        const sum = storyboard.reduce((total, item) => total + (Number(item.duration) || 0), 0);
        const duration = Math.max(4, Math.min(15, Math.round(Number(row.duration) || sum || 5)));
        const slots = plan
          ? plan.pictures.map(p => `<reference slot="${p.picture}" sources="assets" id="${p.id}" type="${xml(p.assetType)}" view="${p.view}" name="${xml(p.name)}" />`).join("\n")
          : track.info.filter(item => item.reference !== false).map((item, index) => `<reference slot="${index + 1}" sources="${xml(item.sources)}" id="${item.id}" />`).join("\n");
        const definitions = plan ? plan.pictures.map(p => `<asset picture="&lt;Picture ${p.picture}&gt;" assetId="${p.id}" parentAssetId="${p.parentAssetId ?? ""}" view="${p.view}" type="${xml(p.assetType)}" name="${xml(p.name)}">\ndescribe=${JSON.stringify(p.description)}\nvisualPrompt=${JSON.stringify(p.assetPrompt)}\n</asset>`).join("\n") : "";
        const content = [
          `模型名称=${modelData}; target_duration=${duration}s; dialogue_locale=${locale};`,
          h3 ? h3DialogueLocaleInstruction(locale) : "",
          `<referenceSlots>\n${slots}\n</referenceSlots>`, `<assetDefinitions>\n${definitions}\n</assetDefinitions>`,
          `<storyboardGuidance>${storyboard.map(item => JSON.stringify({ id: item.id, videoDesc: item.videoDesc, imagePrompt: item.prompt })).join("\n")}</storyboardGuidance>`,
          `资产信息：${JSON.stringify(assets)}`,
          `原始分镜与对白（原文保留；若指定语言则只翻译发声台词）：${JSON.stringify(storyboard.map(item => ({ id: item.id, videoDesc: item.videoDesc, duration: item.duration, track: item.track })))}`,
        ].join("\n\n");
        const template = h3 && plan?.pictures.length ? officialH3 : fallback;
        const { text } = await u.Ai.Text("universalAi").invoke({
          system: template + (h3 ? `\n\n${h3DialogueLocaleInstruction(locale)}` : ""),
          messages: [{ role: "assistant", content: manual }, { role: "user", content }],
        });
        if (!text?.trim()) throw new Error("未生成有效视频提示词");
        if (h3 && plan?.pictures.length) {
          let previous = -1;
          for (const heading of headings) {
            const first = text.indexOf(heading);
            if (first < 0 || first <= previous || text.indexOf(heading, first + heading.length) >= 0) throw new Error(`H3 六段提示词结构不完整：${heading}`);
            previous = first;
          }
          assertH3PictureSlots(text, plan.pictures.length);
          if (locale !== "original") {
            const spoken = [...text.matchAll(/<d>\s*\[[^\]]+\]\s*([^<]*?)\s*<\/d>/g)].map(match => match[1].trim());
            const budget = checkH3DialogueBudget(spoken, locale, duration);
            if (!budget.fits) throw new Error(`对白翻译后预计 ${budget.estimatedSeconds}s，超过当前片段 ${duration}s；请精简译文或局部拆镜`);
          }
        }
        const saved = h3 && plan ? bindH3Prompt(text, plan) : text;
        await u.db("o_videoTrack").where({ id: track.trackId, projectId }).update({ prompt: saved, state: "已完成", reason: null });
        return { trackId: track.trackId, succeeded: true };
      } catch (cause) {
        await u.db("o_videoTrack").where({ id: track.trackId, projectId }).update({ state: "生成失败", reason: u.error(cause).message });
        return { trackId: track.trackId, succeeded: false };
      }
    }));
    void Promise.all(tasks);
    return res.status(200).send(success("开始生成提示词"));
  } catch (cause) {
    return res.status(400).send(error(u.error(cause).message));
  }
});
