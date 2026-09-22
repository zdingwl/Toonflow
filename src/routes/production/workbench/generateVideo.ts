import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType?: "image" | "video" | "audio";
  type?: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

interface ResolvedReference {
  path?: string;
  sourceType: "assets" | "storyboard";
  assetType?: string;
  fileType?: "image" | "video" | "audio" | string;
  referenceType?: Type;
  label?: string;
  prompt?: string;
}

function isMiniMaxH3(model: string): boolean {
  const value = String(model || "").toLowerCase();
  return value.includes("minimax") && value.includes("h3");
}

function h3ReferenceRank(item: ResolvedReference): number {
  const type = String(item.assetType || "").toLowerCase();
  if (type === "role" || type === "character") return 0;
  if (type === "scene" || type === "environment") return 1;
  if (type === "tool" || type === "prop" || type === "creature") return 2;
  return 3;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
        type: z.enum(["imageReference", "startImage", "endImage", "videoReference", "audioReference"]).optional(),
        fileType: z.enum(["image", "video", "audio"]).optional(),
        label: z.string().optional(),
        prompt: z.string().optional(),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }

    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;

    const images = (
      await Promise.all(
        (uploadData as UploadItem[]).map(async (item): Promise<ResolvedReference | null> => {
          if (item.sources === "storyboard") {
            const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath", "prompt").first();
            return {
              path: filePath?.filePath,
              sourceType: "storyboard",
              assetType: "storyboard",
              fileType: item.fileType || "image",
              referenceType: item.type,
              label: item.label || `分镜图${item.id}`,
              prompt: item.prompt || filePath?.prompt,
            };
          }

          if (item.sources === "assets") {
            const filePath = await u
              .db("o_assets")
              .where("o_assets.id", item.id)
              .leftJoin("o_image", "o_assets.imageId", "o_image.id")
              .select(
                "o_image.filePath",
                "o_image.type as imageType",
                "o_assets.name",
                "o_assets.prompt",
                "o_assets.type as assetType",
              )
              .first();
            return {
              path: filePath?.filePath,
              sourceType: "assets",
              assetType: filePath?.assetType,
              fileType: item.fileType || filePath?.imageType || "image",
              referenceType: item.type,
              label: item.label || filePath?.name,
              prompt: item.prompt || filePath?.prompt,
            };
          }

          return null;
        }),
      )
    ).filter(Boolean) as ResolvedReference[];

    // MiniMax H3 uses asset references for identity/design. Storyboard images are prompt-only
    // guidance because feeding them into Ref2VA can override the authoritative character faces.
    const runtimeImages = isMiniMaxH3(model)
      ? images.filter((item) => item.sourceType !== "storyboard").sort((a, b) => h3ReferenceRank(a) - h3ReferenceRank(b))
      : images;

    const base64 = await Promise.all(
      runtimeImages.map(async (item) => {
        if (!item.path) return null;
        const type =
          item.referenceType === "audioReference" || item.fileType === "audio"
            ? "audio"
            : item.referenceType === "videoReference" || item.fileType === "video"
              ? "video"
              : "image";
        return {
          base64: await u.oss.getImageBase64(item.path),
          type,
          label: item.label,
          prompt: item.prompt,
          sourceType: item.sourceType,
          assetType: item.assetType,
        };
      }),
    );

    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    res.status(200).send(success(videoId));

    const relatedObjects = {
      projectId,
      videoId,
      scriptId,
      type: "视频",
    };
    const aiVideo = u.Ai.Video(model);
    aiVideo
      .run(
        {
          prompt,
          referenceList: base64.filter(Boolean) as ReferenceList[],
          mode: modeData.length > 0 ? modeData : mode,
          duration,
          aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
          resolution,
          audio,
        },
        {
          projectId,
          taskClass: "视频生成",
          describe: "根据提示词生成视频",
          relatedObjects: JSON.stringify(relatedObjects),
        },
      )
      .then(async () => await aiVideo.save(videoPath))
      .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" }))
      .catch(async (error: any) => {
        await u
          .db("o_video")
          .where("id", videoId)
          .update({
            state: "生成失败",
            errorReason: u.error(error).message,
          });
      });
  },
);
