import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { expandH3AssetSlots } from "@/utils/h3ReferenceSlots";
const router = express.Router();

function isMiniMaxH3(modelName: string): boolean {
  const value = String(modelName || "").toLowerCase();
  return value.includes("minimax") && value.includes("h3");
}

function h3AssetRank(item: any): number {
  const type = String(item?.type || "").toLowerCase();
  if (type === "role" || type === "character") return 0;
  if (type === "scene" || type === "environment") return 1;
  if (type === "tool" || type === "prop" || type === "creature") return 2;
  return 3;
}

function escapeXmlAttr(value: unknown): string {
  return String(value ?? "").replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] || ch);
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    trackData: z.array(
      z.object({
        trackId: z.number(),
        info: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
            reference: z.boolean().optional(),
            slotType: z.string().optional(),
            fileType: z.string().optional(),
            prompt: z.string().optional(),
          }),
        ),
      }),
    ),
    mode: z.string(),
    model: z.string(),
    concurrentCount: z.number().optional(), //并发数
  }),
  async (req, res) => {
    const { trackData, projectId, mode, model, concurrentCount = 5 } = req.body;
    try {
      // 预加载公共数据
      const [id, modelData] = model.split(/:(.+)/);
      const modelLower = (modelData ?? "").toLowerCase();
      const h3PromptMode = isMiniMaxH3(modelData ?? "");
      const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
      const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
      let videoPromptGeneration = "" as string | undefined;

      const modelPromptData = await u.db("o_modelPrompt").where("vendorId", id).where("model", modelData).first();
      //查询到 有绑定对应视频提示词
      if (modelPromptData) {
        const modelPromptRoot = u.getPath(["modelPrompt"]);
        try {
          const fullPath = path.join(modelPromptRoot, modelPromptData?.path!);
          const content = await fs.readFile(fullPath, "utf-8");
          videoPromptGeneration = content ?? "";
        } catch {}
      }

      // 未查询到绑定，根据模型名称 + mode 自动匹配 modelPrompt/video/ 下的文件
      if (!videoPromptGeneration) {
        const modelPromptRoot = u.getPath(["modelPrompt"]);
        const videoPromptDir = path.join(modelPromptRoot, "video");

        let fileName: string | null = null;

        if (modelLower.includes("minimax") && modelLower.includes("h3")) {
          // MiniMax H3 / local Ref2VA => dedicated ordered <Picture N> prompt skill
          fileName = "minimaxH3Multi-referenceMode.md";
        } else if (modelLower.includes("wan") && modelLower.includes("2.6")) {
          // wan2.6 系列 => 单图首尾帧模式
          fileName = "wan2.6Single-imageFirstFrameMode.md";
        } else if (/seedance.*2[.\-]0/i.test(modelLower)) {
          // seedance 2.0 / 2-0 系列
          fileName = "seedance2Multi-parameterMode.md";
        } else if (mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional") {
          // body.mode 为首尾帧相关 => 通用首尾帧模式
          fileName = "universalFirstAndLastFrameMode.md";
        } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
          // 其他 => 通用多参模式
          fileName = "universalMulti-parameterMode.md";
        }
        if (fileName) {
          try {
            const fullPath = path.join(videoPromptDir, fileName);
            videoPromptGeneration = await fs.readFile(fullPath, "utf-8");
          } catch {
            // 文件不存在则忽略，继续用备选
          }
        }
      }

      //备选
      if (!videoPromptGeneration) {
        if (videoPrompt && videoPrompt.useData) {
          videoPromptGeneration = videoPrompt.useData;
        } else {
          videoPromptGeneration = videoPrompt?.data ?? undefined;
        }
      }

      const artStyle = projectData?.artStyle || "无";
      const visualManual = u.getArtPrompt(artStyle, "art_skills", "art_storyboard_video");
      await u
        .db("o_videoTrack")
        .whereIn(
          "id",
          trackData.map((t: { trackId: number }) => t.trackId),
        )
        .update({ state: "生成中" });
      // 并发控制：每个 track 独立走 查询→拼装→AI调用→更新 流程
      const limit = pLimit(concurrentCount ?? 5);
      const tasks = trackData.map((track: { trackId: number; info: { id: number; sources: string; reference?: boolean; slotType?: string; fileType?: string; prompt?: string }[] }) =>
        limit(async () => {
          // 查询参数
          const images = await Promise.all(
            track.info.map(async (item: { id: number; sources: string; reference?: boolean; slotType?: string; fileType?: string; prompt?: string }) => {
              if (item.sources === "storyboard") {
                // 查询分镜主信息
                const storyboard = await u
                  .db("o_storyboard")
                  .where("o_storyboard.id", item.id)
                  .select("id", "videoDesc", "prompt", "track", "duration", "shouldGenerateImage", "filePath")
                  .first();
                // 查询分镜关联的资产ID
                const assetRows = await u.db("o_assets2Storyboard").where("storyboardId", item.id).orderBy("rowid").select("assetId");
                const associateAssetsIds = assetRows.map((row: any) => row.assetId);
                return {
                  ...storyboard,
                  associateAssetsIds,
                  _type: "storyboard",
                  _reference: item.reference !== false,
                  _slotType: item.slotType,
                  _fileType: item.fileType,
                };
              }
              if (item.sources === "assets") {
                // 查询素材
                const assetsData = await u
                  .db("o_assets")
                  .leftJoin("o_image", "o_image.id", "o_assets.imageId")
                  .where("o_assets.id", item.id)
                  .select("o_assets.id", "o_assets.type", "o_assets.name", "o_assets.describe", "o_assets.prompt as assetPrompt", "o_image.filePath")
                  .first();
                return {
                  ...assetsData,
                  _type: "assets",
                  _reference: item.reference !== false,
                  _slotType: item.slotType,
                  _fileType: item.fileType,
                };
              }
            }),
          );

          // 拆分 assets 和 storyboard
          const assets: any[] = [];
          const storyboard: any[] = [];
          for (const item of images) {
            if (!item) continue;
            if (item._type === "assets")
              assets.push({
                id: item.id,
                type: item.type,
                name: item.name,
                describe: item.describe,
                assetPrompt: item.assetPrompt,
                filePath: item.filePath,
                _reference: item._reference,
                _slotType: item._slotType,
                _fileType: item._fileType,
              });
            if (item._type === "storyboard")
              storyboard.push({
                videoDesc: item.videoDesc,
                prompt: item.prompt,
                track: item.track,
                duration: item.duration,
                associateAssetsIds: item.associateAssetsIds,
                shouldGenerateImage: item.shouldGenerateImage,
                id: item.id,
                filePath: item.filePath,
                _reference: item._reference,
                _slotType: item._slotType,
                _fileType: item._fileType,
              });
          }

          // H3 Picture slots contain only the asset images that will be uploaded to Ref2VA.
          // Selected storyboard images are converted to text guidance and never compete with character identity.
          const pictureSourceItems = h3PromptMode
            ? expandH3AssetSlots(images
                .filter(
                  (item: any) =>
                    item &&
                    item._type === "assets" &&
                    item._reference !== false &&
                    item.filePath &&
                    item._fileType !== "audio" &&
                    item._fileType !== "video",
                )
                .sort((a: any, b: any) => h3AssetRank(a) - h3AssetRank(b)))
            : images.filter((item: any) => item && item._reference !== false && item.filePath);

          const referenceSlotItems = pictureSourceItems.map((item: any, index: number) => {
            const slot = index + 1;
            const sources = item._type === "assets" ? "assets" : "storyboard";
            const type = item._type === "assets" ? String(item.type || "asset") : "storyboard";
            const name = item._type === "assets" ? String(item.name || `资产${item.id}`) : `分镜图${item.id}`;
            return `<reference slot="${slot}" sources="${sources}" id="${item.id}" type="${escapeXmlAttr(type)}" name="${escapeXmlAttr(name)}" />`;
          });
          const referenceSlots = `<referenceSlots>\n${referenceSlotItems.join("\n")}\n</referenceSlots>`;

          const storyboardGuideItems = h3PromptMode
            ? images.filter((item: any) => item && item._type === "storyboard" && item._reference !== false)
            : [];
          const storyboardGuidance = h3PromptMode
            ? `<storyboardGuidance>\n${storyboardGuideItems
                .map(
                  (item: any, index: number) =>
                    `<storyboard index="${index + 1}" id="${item.id}">\nvideoDesc=${JSON.stringify(item.videoDesc || "")}\nimagePrompt=${JSON.stringify(item.prompt || "")}\n</storyboard>`,
                )
                .join("\n")}\n</storyboardGuidance>`
            : "";

          const referenceHeading = h3PromptMode
            ? "**MiniMax H3 实际 Picture 槽位（仅以下素材会上传到 Ref2VA；<Picture N> 必须严格对应 slot N）**"
            : "**参考素材槽位**";
          const storyboardHeading = h3PromptMode
            ? `\n**分镜构图指导（仅文本指导，禁止生成新的 <Picture N>，禁止覆盖角色身份）**：\n${storyboardGuidance}\n`
            : "";

          const videoTrackData = await u.db("o_videoTrack").select("duration").where({ id: track.trackId }).first();
          const storyboardDuration = storyboard.reduce(
            (total: number, item: any) => total + (Number.parseFloat(String(item.duration || 0)) || 0),
            0,
          );
          const rawTargetDuration = Number(videoTrackData?.duration) || storyboardDuration || 5;
          const targetDuration = Math.max(4, Math.min(15, Math.round(rawTargetDuration)));

          const assetDefinitionItems = h3PromptMode
            ? pictureSourceItems.map((item: any, index: number) => {
                const picture = `<Picture ${index + 1}>`;
                const type = escapeXmlAttr(item.type || "asset");
                const name = escapeXmlAttr(item.name || `资产${item.id}`);
                return [
                  `<asset picture="${picture}" type="${type}" name="${name}">`,
                  `describe=${JSON.stringify(item.describe || "")}`,
                  `visualPrompt=${JSON.stringify(item.assetPrompt || "")}`,
                  "</asset>",
                ].join("\n");
              })
            : [];
          const assetDefinitions = h3PromptMode
            ? `<assetDefinitions>\n${assetDefinitionItems.join("\n")}\n</assetDefinitions>`
            : "";

          const content = `
          **模型名称**：${modelData},
          **目标时长 target_duration**：${targetDuration}s,
          ${referenceHeading}：
          ${referenceSlots},
          ${h3PromptMode ? `\n**资产视觉定义**：\n${assetDefinitions}\n` : ""}
          ${storyboardHeading}
          **资产信息**（角色、场景、道具、音频):${assets
            .filter((i: any) => i.filePath)
            .map((i: any) => `[${i.id},${i.type},${i.name}]`)
            .join("，")},
          **分镜信息**：${storyboard.map(
            (i: any) => `<storyboardItem
  videoDesc='${i.videoDesc}'
  duration='${i.duration}'
></storyboardItem>`,
          )},
          `;

          try {
            const { text } = await u.Ai.Text("universalAi").invoke({
              system: videoPromptGeneration,
              messages: [
                {
                  role: "assistant",
                  content: `${visualManual}`,
                },
                {
                  role: "user",
                  content: content,
                },
              ],
            });

            await u.db("o_videoTrack").where({ id: track.trackId }).update({
              prompt: text,
              state: "已完成",
            });

            return { trackId: track.trackId, text };
          } catch (e: any) {
            await u
              .db("o_videoTrack")
              .where({ id: track.trackId })
              .update({ state: "生成失败", reason: u.error(e).message });
          }
        }),
      );

      // 后台执行，不等待结果
      Promise.all(tasks);
      res.status(200).send(success("开始生成提示词"));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
