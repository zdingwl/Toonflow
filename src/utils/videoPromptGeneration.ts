import u from "@/utils";
import fs from "fs/promises";
import path from "path";
import { expandH3AssetSlots } from "@/utils/h3ReferenceSlots";
import { h3SlotPath, saveH3ReferencePlan, loadH3ReferencePlan, copyH3ReferencePlan, resolveH3ReferencePlan } from "@/utils/h3ReferencePlan";
import { assertH3ActiveStates } from "@/utils/h3VisualStateGuard";
import { db as languageDb } from "@/utils/db";
import { generateLanguageVariants } from "@/utils/videoLanguages";
import { assertH3PromptContract, normalizeH3PromptFormat, h3FormatChecklist } from "@/utils/h3PromptContract";
import { buildH3PromptInput, h3BindingSlots } from "@/utils/h3PromptContext";
import { assertH3ReferenceBindings } from "@/utils/h3ReferenceBindings";
import { prepareH3VisionImage } from "@/utils/h3VisionImage";
import { h3SemanticReviewInstruction, parseH3SemanticReview } from "@/utils/h3SemanticReview";

export interface VideoPromptRequest {
  trackId: number;
  projectId: number;
  info: { id: number; sources: string; reference?: boolean; slotType?: string; fileType?: string; prompt?: string }[];
  model: string;
  mode: string;
  languages?: string[];
  regenerate?: boolean;
  replaceBasePrompt?: boolean;
}

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

const runningTracks = new Set<number>();
export const isVideoPromptRunning = (trackId: number) => runningTracks.has(trackId);

export async function generateVideoPromptForTrack(input: VideoPromptRequest) {
  if (isVideoPromptRunning(input.trackId)) throw Object.assign(new Error("该视频段提示词正在生成，请完成后再重试"), { status: 409 });
  runningTracks.add(input.trackId);
  try { return await generateForTrack(input); }
  finally { runningTracks.delete(input.trackId); }
}

async function generateForTrack(input: VideoPromptRequest) {
  const { trackId, projectId, info, model, mode } = input;
  if (!(await u.db("o_videoTrack").where({ id: trackId, projectId }).first())) throw Object.assign(new Error("视频段不存在"), { status: 404 });
  await u.db("o_videoTrack").where({ id: trackId }).update({
    state: "生成中", reason: null,
  });
  try {
    //查询参数
    const images = await Promise.all(
      info.map(async (item: { id: number; sources: string; reference?: boolean; slotType?: string; fileType?: string; prompt?: string }) => {
        if (item.sources === "storyboard") {
          // 查询分镜主信息
          const storyboard = await u
            .db("o_storyboard")
            .where({ "o_storyboard.id": item.id, "o_storyboard.projectId": projectId })
            .select("id", "videoDesc", "prompt", "track", "duration", "shouldGenerateImage", "filePath")
            .first();
          if (!storyboard) throw new Error(`分镜 ${item.id} 不存在或不属于当前项目`);
          // 查询分镜关联的资产ID
          const assetRows = await u.db("o_assets2Storyboard").where("storyboardId", item.id).orderBy("rowid").select("assetId");
          const associateAssetsIds = assetRows.map((row: any) => row.assetId);
          return {
            ...storyboard,
            associateAssetsIds,
            _type: "storyboard", // 标记类型，便于后续区分
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
            .where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
            .select("o_assets.id", "o_assets.assetsId", "o_assets.type", "o_assets.name", "o_assets.describe", "o_assets.prompt as assetPrompt", "o_image.filePath")
            .first();
          if (!assetsData) throw new Error(`资产 ${item.id} 不存在或不属于当前项目`);
          return {
            ...assetsData,
            _type: "assets", // 标记类型
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
      if (!item) continue; // 忽略空
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
    const assetsNotAudioIds = assets.filter((i) => i.type == "audio").map((i) => i.id);

    const assets2Audio = await u
      .db("o_assets")
      .whereIn("o_assets.id", assetsNotAudioIds)
      .join("o_assetsRole2Audio", "o_assetsRole2Audio.assetsAudioId", "o_assets.assetsId")
      .select("o_assets.assetsId", "o_assets.id", "o_assetsRole2Audio.assetsAudioId", "o_assetsRole2Audio.assetsRoleId");

    const assetsAudioRecord: Record<number, number> = {};
    assets2Audio.forEach((i) => {
      assetsAudioRecord[i.assetsRoleId!] = i.id!;
    });

    const [id, modelData] = model.split(/:(.+)/);
    const modelLower = (modelData ?? "").toLowerCase();
    const h3PromptMode = isMiniMaxH3(modelData ?? "");
    const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
    const videoTrackData = await u.db("o_videoTrack").select("duration").where({ id: trackId }).first();
    const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
    let videoPromptGeneration = "" as string | undefined;

    const modelPromptData = await u.db("o_modelPrompt").where("vendorId", id).where("model", modelData).first();
    //查询到 有绑定对应视频提示词
    if (h3PromptMode) {
      // Ref2VA grammar is required, even when this vendor has an older bound template.
      // A missing H3 template must not silently fall through to another model's rules.
      videoPromptGeneration = await fs.readFile(path.join(u.getPath(["modelPrompt"]), "video", "minimaxH3Multi-referenceMode.md"), "utf-8");
      if (!videoPromptGeneration.trim()) throw new Error("H3 多参考提示词规则文件为空，请修复后重试");
    } else if (modelPromptData) {
      const modelPromptRoot = u.getPath(["modelPrompt"]);
      try {
        const fullPath = path.join(modelPromptRoot, modelPromptData?.path!);
        const content = await fs.readFile(fullPath, "utf-8");
        videoPromptGeneration = content ?? "";
      } catch { }
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
      } else if (/seedance.*2[.\-]0/i.test(modelData)) {
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

    // H3 Picture slots must describe only the images that will actually be uploaded to Ref2VA.
    // Storyboard images remain available as text-only composition guidance so they cannot override face identity.
    const h3DirectionText = storyboard.map((item) => item.videoDesc || "").join("\n");
    if (h3PromptMode) assertH3ActiveStates(images.filter((item: any) => item?._type === "assets" && item._reference !== false).map((item: any) => ({
      assetId: Number(item.id), parentAssetId: item.assetsId, assetType: item.type, name: item.name, filePath: item.filePath,
    })));
    const pictureSourceItems = h3PromptMode
      ? expandH3AssetSlots(
        images
          .filter(
            (item: any) =>
              item && item._type === "assets" && item._reference !== false && item._fileType !== "audio" && item._fileType !== "video",
          )
          .sort((a: any, b: any) => h3AssetRank(a) - h3AssetRank(b)),
        h3DirectionText,
      )
      : images.filter((item: any) => item && item._reference !== false && item.filePath);

    const referenceSlotItems = pictureSourceItems.map((item: any, index: number) => {
      const slot = index + 1;
      const sources = item._type === "assets" ? "assets" : "storyboard";
      const type = item._type === "assets" ? String(item.type || "asset") : "storyboard";
      const name = item._type === "assets" ? String(item.name || `资产${item.id}`) : `分镜图${item.id}`;
      return `<reference slot="${slot}" sources="${sources}" id="${item.id}" type="${escapeXmlAttr(type)}" name="${escapeXmlAttr(name)}" />`;
    });
    const referenceSlots = `<referenceSlots>\n${referenceSlotItems.join("\n")}\n</referenceSlots>`;

    const storyboardDuration = storyboard.reduce((total: number, item: any) => total + (Number.parseFloat(String(item.duration || 0)) || 0), 0);
    const rawTargetDuration = Number(videoTrackData?.duration) || storyboardDuration || 5;
    if (h3PromptMode && (!Number.isFinite(rawTargetDuration) || rawTargetDuration < 4 || rawTargetDuration > 15)) {
      throw new Error(`H3 视频段时长 ${rawTargetDuration}s 超出 4–15 秒范围，请先调整分镜时长；不会自动截短剧情`);
    }
    const targetDuration = h3PromptMode ? rawTargetDuration : Math.max(4, Math.min(15, Math.round(rawTargetDuration)));

    const otherReferences = images.filter((item: any) => item?._type === "assets" && item._reference !== false && ["audio", "video"].includes(item._fileType || item.type))
      .map((item: any) => ({ assetId: item.id, name: item.name, mediaType: item._fileType || item.type }));
    const content = h3PromptMode ? buildH3PromptInput(pictureSourceItems, storyboard, targetDuration, otherReferences) : `
          **模型名称**：${modelData},
          **目标时长 target_duration**：${targetDuration}s,
          **参考素材槽位**：
          ${referenceSlots},
          **资产信息**（角色、场景、道具、音频):${assets
        .filter((i) => i.filePath)
        .map((i) => `[${i.id},${i.type},${i.name} ${assetsAudioRecord[i.id] ? `audio:${assetsAudioRecord[i.id]}` : ""} ] `)
        .join("，")},
          **分镜信息**：${storyboard.map(
          (i) => `<storyboardItem
  videoDesc='${i.videoDesc}'
  duration='${i.duration}'
></storyboardItem>`,
        )},
          `;

    // The writer sees the same complete asset images in the order Ref2VA receives them.
    const userContent: any[] = [{ type: "text", text: content }];
    const preparedReferenceImages = new Map<number, Awaited<ReturnType<typeof prepareH3VisionImage>>>();
    if (h3PromptMode) {
      const missing = pictureSourceItems.flatMap(item => {
        try { h3SlotPath(item); return []; } catch (cause) { return [u.error(cause).message]; }
      });
      if (missing.length) throw new Error(missing.join("；"));
      for (const [index, item] of pictureSourceItems.entries()) {
        const referencePath = h3SlotPath(item);
        if (!referencePath) throw new Error(`${item.name} 缺少实际参考图，请先补齐人物参考图`);
        userContent.push({ type: "text", text: `<Picture ${index + 1}>: ${item.name}; actual current reference, identity and wardrobe authority.` });
        const dataUrl = await u.oss.getImageBase64(referencePath);
        const preparedImage = await prepareH3VisionImage(dataUrl);
        preparedReferenceImages.set(Number(item.assetId ?? item.id), preparedImage);
        userContent.push({ type: "image", ...preparedImage });
      }
    }
    const reviewH3Content = async (candidate: string, source?: string, translationRequirements?: string, referenceContent = userContent) => {
      const review = await u.Ai.Text("universalAi", true, 2).invoke({
        system: h3SemanticReviewInstruction,
        temperature: 0,
        messages: [{ role: "user", content: [
          ...referenceContent,
          ...(visualManual.trim() ? [{ type: "text", text: `Project visual requirements from the selected video manual (review its explicit requirements; do not infer additional style obligations):\n${visualManual}` }] : []),
          { type: "text", text: source
            ? `Translation requirements:\n${translationRequirements}\n\nValidated source prompt:\n${source}\n\nCandidate translation to audit:\n${candidate}`
            : `Candidate H3 prompt to audit against the attached current references and storyboard:\n${candidate}` },
        ] }],
      });
      const issues = parseH3SemanticReview(review.text);
      if (issues.length) throw new Error("H3 内容审核未通过：" + issues.map(issue => `${issue.code}: ${issue.reason} Evidence: ${issue.evidence}`).join("\n"));
    };
    const generateBase = async () => {
      const system = h3PromptMode ? `${videoPromptGeneration}\n\n${h3FormatChecklist}\n\nProject visual requirements (rendering guidance only; the H3 rules above govern references, shots, speech and output structure. Use relevant qualities in the style opening; do not import a competing output format or compress the required shot detail):\n${visualManual}` : videoPromptGeneration;
      const messages: any[] = h3PromptMode
        ? [{ role: "user", content: userContent }]
        : [{ role: "assistant", content: visualManual }, { role: "user", content }];
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = { text: (await u.Ai.Text("universalAi", h3PromptMode ? true : undefined, h3PromptMode ? 2 : undefined).invoke({ system, messages })).text };
        if (!h3PromptMode) return result.text;
        result.text = normalizeH3PromptFormat(result.text.trim());
        if (/^(REFERENCE_STATE_REVIEW|LANGUAGE_TIMING_REVIEW):/.test(result.text.trim())) throw new Error(result.text);
        try {
          assertH3PromptContract(result.text, targetDuration, pictureSourceItems.length);
          assertH3ReferenceBindings(result.text, h3BindingSlots(pictureSourceItems));
          await reviewH3Content(result.text);
        }
        catch (cause) {
          if (attempt === 2) throw Object.assign(cause as Error, { candidatePrompt: result.text });
          messages.push({ role: "assistant", content: result.text }, { role: "user", content: `Rewrite and return ALL SIX SECTIONS as one complete prompt against the H3 rules. Do not return a patch or only changed sections. Reinspect the attached images for missing definitions; do not replace observed characteristics with generic preservation instructions. Keep the original image bindings, story events, speakers, exact dialogue and timing. Check reference labels inside shots and agreement with retention_analysis. ${h3FormatChecklist} Validation error: ${u.error(cause).message}` });
          continue;
        }
        await saveH3ReferencePlan(languageDb, trackId, result.text, pictureSourceItems);
        return result.text;
      }
      throw new Error("H3 提示词校验失败");
    };
    if (input.languages) {
      const variants = await generateLanguageVariants(
        languageDb,
        trackId,
        input.languages,
        async () => {
          const prompt = await generateBase();
          if (input.replaceBasePrompt === true) {
            await u.db("o_videoTrack").where({ id: trackId, projectId }).update({ prompt });
          }
          return prompt;
        },
        async (system, source) => {
          let reviewReferenceContent = userContent;
          if (h3PromptMode) {
            const sourcePlan = await loadH3ReferencePlan(languageDb, trackId, source);
            if (sourcePlan) {
              const restored = resolveH3ReferencePlan(images.filter(Boolean), sourcePlan);
              const currentById = new Map(pictureSourceItems.map(item => [Number(item.assetId ?? item.id), item]));
              const orderedItems = restored.map(item => currentById.get(item.assetId)!);
              reviewReferenceContent = [{ type: "text", text: buildH3PromptInput(orderedItems, storyboard, targetDuration, otherReferences) }];
              for (const [index, item] of restored.entries()) {
                const preparedImage = preparedReferenceImages.get(item.assetId);
                if (!preparedImage) throw new Error(`${item.label} 缺少已加载的参考图，请重新生成视频提示词`);
                reviewReferenceContent.push({ type: "text", text: `<Picture ${index + 1}>: ${item.label}; actual current reference in the validated source prompt's saved order.` });
                reviewReferenceContent.push({ type: "image", ...preparedImage });
              }
            }
            assertH3PromptContract(source, targetDuration, sourcePlan?.slots.length ?? pictureSourceItems.length);
            assertH3ReferenceBindings(source, sourcePlan?.slots ?? h3BindingSlots(pictureSourceItems));
          }
          const messages: any[] = [{ role: "user", content: source }];
          for (let attempt = 0; attempt < 3; attempt++) {
            const result = { text: (await u.Ai.Text("universalAi", h3PromptMode ? true : undefined, h3PromptMode ? 2 : undefined).invoke({ system: h3PromptMode ? `${videoPromptGeneration}\n\nTranslation task: preserve the validated reference definitions, shot events and bindings; translate speech according to the following target-language instructions. Return all six sections, including unchanged sections.\n${system}\n${h3FormatChecklist}` : system, messages })).text };
            if (!h3PromptMode || result.text.trim().startsWith("LANGUAGE_TIMING_REVIEW:")) return result.text;
            result.text = normalizeH3PromptFormat(result.text.trim());
            try {
              const sourcePlan = await loadH3ReferencePlan(languageDb, trackId, source);
              assertH3PromptContract(result.text, targetDuration, sourcePlan?.slots.length ?? pictureSourceItems.length);
              assertH3ReferenceBindings(result.text, sourcePlan?.slots ?? h3BindingSlots(pictureSourceItems), source);
              await reviewH3Content(result.text, source, system, reviewReferenceContent);
            }
            catch (cause) {
              if (attempt === 2) throw Object.assign(cause as Error, { candidatePrompt: result.text });
              messages.push({ role: "assistant", content: result.text }, { role: "user", content: `Return ALL SIX SECTIONS of the corrected translation, including unchanged sections. Do not return a patch. Preserve visual facts, speakers, target-language dialogue, timing and reference bindings; recheck their consistency across sections. ${h3FormatChecklist} Validation error: ${u.error(cause).message}` });
              continue;
            }
            await copyH3ReferencePlan(languageDb, trackId, source, result.text);
            return result.text;
          }
          throw new Error("H3 翻译格式校验失败");
        },
        input.regenerate === true,
      );
      const failed = variants.filter((v: any) => input.languages!.includes(v.language) && v.state === "生成失败");
      await u
        .db("o_videoTrack")
        .where({ id: trackId })
        .update({ state: failed.length ? "生成失败" : "已完成", reason: failed.map((v: any) => `${v.language}: ${v.reason}`).join("；") });
      return variants;
    }
    const text = await generateBase();
    await u.db("o_videoTrack").where({ id: trackId }).update({
      state: "已完成",
      prompt: text,
      reason: null,
    });
    return text;
  } catch (e) {
    await u
      .db("o_videoTrack")
      .where({ id: trackId })
      .update({
        state: "生成失败",
        reason: u.error(e).message,
      });
    throw e;
  }
}
