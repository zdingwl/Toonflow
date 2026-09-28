import u from "@/utils";
import fs from "fs/promises";
import path from "path";
import { expandH3AssetSlots } from "@/utils/h3ReferenceSlots";
import { h3SlotPath, saveH3ReferencePlan, loadH3ReferencePlan, copyH3ReferencePlan } from "@/utils/h3ReferencePlan";
import { assertH3ActiveStates } from "@/utils/h3VisualStateGuard";
import { db as languageDb } from "@/utils/db";
import { assertTranslatedDialogueLanguage, generateLanguageVariants } from "@/utils/videoLanguages";
import { assertH3PromptContract, h3FormatChecklist, normalizeH3PromptFormat } from "@/utils/h3PromptContract";
import { buildH3PromptInput, h3BindingSlots } from "@/utils/h3PromptContext";
import { assertH3ReferenceBindings } from "@/utils/h3ReferenceBindings";
import { prepareH3VisionImage } from "@/utils/h3VisionImage";

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

const h3EnglishPromptInstruction = `${h3FormatChecklist} All section prose must be English. Only spoken dialogue inside <d>...</d> and explicitly required visible screen/sign text may use their requested language.`;

function hasUnexpectedH3ChineseProse(prompt: string): boolean {
  const prose = String(prompt || "").replace(/<d(?:\s[^>]*)?>[\s\S]*?<\/d>/gi, "");
  if (/^(?:#{1,6}\s*|\d+[.)]\s*)[^\r\n]*\p{Script=Han}/mu.test(prose)) return true;
  const hanCount = (prose.match(/\p{Script=Han}/gu) || []).length;
  const latinCount = (prose.match(/[A-Za-z]/g) || []).length;
  return hanCount >= 40 && hanCount > latinCount * 0.25;
}

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
    const h3RefPromptMode = h3PromptMode && typeof mode === "string" && /^\s*\[/.test(mode);
    const h3PromptInstruction = h3RefPromptMode
      ? h3EnglishPromptInstruction
      : "Write the complete H3 prompt prose in English. Preserve requested dialogue language, event order, timing and camera instructions.";
    const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
    const videoTrackData = await u.db("o_videoTrack").select("duration").where({ id: trackId }).first();
    const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
    let videoPromptGeneration = "" as string | undefined;

    const modelPromptData = await u.db("o_modelPrompt").where("vendorId", id).where("model", modelData).first();
    //查询到 有绑定对应视频提示词
    if (h3RefPromptMode) {
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

      if (h3RefPromptMode) {
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
        userContent.push({ type: "image", ...preparedImage });
      }
    }
    const generateBase = async () => {
      const system = h3PromptMode ? `${videoPromptGeneration}\n\n${h3PromptInstruction}\n\nProject visual requirements (rendering guidance only; use relevant qualities without replacing the selected H3 prompt template's output structure):\n${visualManual}` : videoPromptGeneration;
      const messages: any[] = h3PromptMode
        ? [{ role: "user", content: userContent }]
        : [{ role: "assistant", content: visualManual }, { role: "user", content }];
      const maxAttempts = h3RefPromptMode ? 5 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = { text: (await u.Ai.Text("universalAi", h3PromptMode ? true : undefined, h3PromptMode ? 2 : undefined).invoke({ system, messages })).text };
        if (!h3PromptMode) return result.text;
        result.text = normalizeH3PromptFormat(result.text.trim());
        if (/^(REFERENCE_STATE_REVIEW|LANGUAGE_TIMING_REVIEW):/.test(result.text.trim())) throw new Error(result.text);
        try {
          if (h3RefPromptMode) {
            assertH3PromptContract(result.text, targetDuration, pictureSourceItems.length);
            assertH3ReferenceBindings(result.text, h3BindingSlots(pictureSourceItems));
          }
          if (hasUnexpectedH3ChineseProse(result.text)) throw new Error("PROMPT_LANGUAGE: section headings and non-dialogue prompt prose must be English; keep only required dialogue or visible text in its required language");
        }
        catch (cause) {
          if (attempt === maxAttempts - 1) throw Object.assign(cause as Error, { candidatePrompt: result.text });
          messages.push({ role: "assistant", content: result.text }, { role: "user", content: `Rewrite and return one complete prompt using the selected H3 template. Do not return a patch. ${h3PromptInstruction} Reinspect the attached images and fix only the reported content contradiction while preserving the story events, speakers, exact dialogue and timing. Review error: ${u.error(cause).message}` });
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
        async (system, source, language) => {
          const messages: any[] = [{ role: "user", content: source }];
          const maxAttempts = h3RefPromptMode ? 5 : 3;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const result = { text: (await u.Ai.Text("universalAi", h3PromptMode ? true : undefined, h3PromptMode ? 2 : undefined).invoke({ system: h3PromptMode ? `You are a surgical H3 dialogue localizer and visible-text localizer. The source prompt is already complete. Copy every heading, reference definition, shot description, sound cue and camera instruction without reorganizing, summarizing or moving it. Preserve the exact relative order of every vocal event and physical action; never move a laugh or spoken line to after an action that follows it in the source. Translate the contents of <d>...</d>, the directly associated spoken-language or locale wording, and every story-required visible button, interface, sign, subtitle or screen label into the requested target language. Return the entire prompt and nothing else.\n\n${h3PromptInstruction}\n\nFor an English language variant, no Chinese characters may remain anywhere in the returned prompt, including quoted visible on-screen text. Do not leave semantic instructions such as \"Chinese text\", \"Chinese system lines\", \"Chinese interface text\", or \"Chinese characters\"; rewrite those instructions to require English visible text. A visual-style phrase such as \"Chinese 3D donghua\" may remain because it describes art style, not text language. If the source prompt's non-dialogue prose is Chinese or another language, translate it to English while preserving sentence and event order. Translate visible Chinese text to English as well.\n\n${system}` : system, messages })).text };
            if (!h3PromptMode || result.text.trim().startsWith("LANGUAGE_TIMING_REVIEW:")) return result.text;
            result.text = normalizeH3PromptFormat(result.text.trim());
            try {
              if (h3RefPromptMode) {
                assertH3PromptContract(result.text, targetDuration, pictureSourceItems.length);
                const sourcePlan = await loadH3ReferencePlan(languageDb, trackId, source);
                if (!sourcePlan) throw new Error("H3 参考图绑定：源提示词缺少保存的参考图计划，请重新生成视频提示词");
                assertH3ReferenceBindings(result.text, sourcePlan.slots, source);
              }
              if (hasUnexpectedH3ChineseProse(result.text)) throw new Error("PROMPT_LANGUAGE: section headings and non-dialogue prompt prose must be English; keep only required dialogue or visible text in its required language");
              assertTranslatedDialogueLanguage(result.text, language);
            }
            catch (cause) {
              if (attempt === maxAttempts - 1) throw Object.assign(cause as Error, { candidatePrompt: result.text });
              messages.push({ role: "assistant", content: result.text }, { role: "user", content: `Return the complete corrected translation. Do not return a patch. Copy the source prompt's non-dialogue text and event order without reorganizing it. ${h3PromptInstruction} Fix only this language requirement: ${u.error(cause).message}` });
              continue;
            }
            await copyH3ReferencePlan(languageDb, trackId, source, result.text, h3RefPromptMode);
            return result.text;
          }
          throw new Error("H3 翻译格式校验失败");
        },
        input.regenerate === true,
        true,
        h3RefPromptMode ? async (prompt, language) => {
          assertTranslatedDialogueLanguage(prompt, language);
          const plan = await loadH3ReferencePlan(languageDb, trackId, prompt);
          if (!plan) throw new Error("H3 参考图绑定：提示词缺少保存的参考图计划");
          if (plan.slots.some(slot => slot.kind)) throw new Error("H3 参考图绑定：仍使用人物独立视图旧计划");
          assertH3PromptContract(prompt, targetDuration, plan.slots.length);
          assertH3ReferenceBindings(prompt, plan.slots);
        } : undefined,
        h3RefPromptMode ? async (prompt) => {
          const plan = await loadH3ReferencePlan(languageDb, trackId, prompt);
          if (!plan) throw new Error("H3 参考图绑定：原版提示词缺少保存的参考图计划");
          if (plan.slots.some(slot => slot.kind)) throw new Error("H3 参考图绑定：原版仍使用人物独立视图旧计划");
          assertH3PromptContract(prompt, targetDuration, plan.slots.length);
          assertH3ReferenceBindings(prompt, plan.slots);
        } : undefined,
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
