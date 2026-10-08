import type { Knex } from "knex";
import { createHash } from "node:crypto";
import { saveH3ReferencePlan } from "./h3ReferencePlan";

export const importProjectType = (kind: string) => `import-${kind}`;

export async function createImportProject(
  db: Knex,
  kind: string,
  fields: Record<string, any>,
) {
  const [id] = await db("o_project").insert({
    name: fields.name,
    intro: fields.intro || "",
    projectType: importProjectType(kind),
    type: "导入创作",
    artStyle: fields.artStyle || "",
    videoRatio: fields.videoRatio || "16:9",
    imageQuality: fields.imageQuality || "1K",
    imageModel: fields.imageModel || "comfyui_local:qwen-image-2.1-local",
    videoModel: fields.videoModel || "comfyui_local:MiniMax-H3-local",
    mode: '["imageReference:9"]',
    directorManual: "",
    userId: 1,
    createTime: Date.now(),
  });
  return Number(id);
}

/** Import into the same assets, images, tracks and reference plans used by the native editors. */
export async function materializeImportBatch(
  db: Knex,
  batch: any,
  projectId: number,
) {
  const [scriptId] = await db("o_script").insert({
    projectId,
    name: batch.name,
    content: "外部导入的资产与分镜",
    createTime: batch.createdAt,
  });
  const items = await db("o_importItem")
    .where({ batchId: batch.id })
    .orderBy("position");
  const assets = JSON.parse(batch.assets);
  const assetIds = new Map<
    string,
    { id: number; name: string; type: string; filePath: string }
  >();
  const addAsset = async (
    spec: any,
    output?: string,
    model?: string,
    failure?: string,
  ) => {
    // The native tool category includes creatures; preserve the original type in the import spec.
    const nativeType = spec.type === "creature" ? "tool" : spec.type;
    const [assetId] = await db("o_assets").insert({
      projectId,
      scriptId,
      name: spec.name,
      type: nativeType,
      describe: spec.prompt || spec.name,
      prompt: spec.prompt || "",
      promptState: spec.prompt ? "已完成" : "未生成",
      assetsId: null,
      descriptionVersion: 0,
      promptDescriptionVersion: 0,
      imageDescriptionVersion: 0,
      ...(output && spec.type === "role"
        ? { referenceLayout: "four_view", designStatus: "ready" }
        : {}),
    });
    await db("o_scriptAssets").insert({ scriptId, assetId });
    if (output || failure) {
      const [imageId] = await db("o_image").insert({
        assetsId: assetId,
        filePath: output || null,
        type: nativeType,
        state: output ? "已完成" : "生成失败",
        model: model || "导入图片",
        errorReason: failure || null,
      });
      if (output)
        await db("o_assets").where({ id: assetId }).update({ imageId });
    }
    return Number(assetId);
  };
  if (batch.kind === "video")
    for (const asset of assets) {
      const assetId = await addAsset(asset, asset.path);
      assetIds.set(asset.id, {
        id: assetId,
        name: asset.name,
        type: asset.type,
        filePath: asset.path,
      });
    }
  for (const item of items) {
    const spec = JSON.parse(item.spec);
    if (batch.kind === "image") {
      const assetId = await addAsset(
        spec,
        item.state === "succeeded" ? item.output : undefined,
        item.model,
        ["failed", "interrupted"].includes(item.state) ? item.error : undefined,
      );
      await db("o_importItem").where({ id: item.id }).update({ assetId });
    } else {
      const [trackId] = await db("o_videoTrack").insert({
        projectId,
        scriptId,
        prompt: spec.prompt,
        duration: spec.duration,
        state: "已完成",
        archived: 0,
      });
      const [storyboardId] = await db("o_storyboard").insert({
        projectId,
        scriptId,
        trackId,
        prompt: spec.name,
        videoDesc: spec.prompt,
        duration: String(spec.duration),
        index: item.position,
        shouldGenerateImage: 0,
        createTime: batch.createdAt,
      });
      const slots = spec.assets.map((id: string) => {
        const asset = assetIds.get(id);
        if (!asset) throw new Error(`分镜 ${spec.id} 缺少资产 ${id}`);
        return asset;
      });
      for (const slot of slots)
        await db("o_assets2Storyboard").insert({
          storyboardId,
          assetId: slot.id,
        });
      await saveH3ReferencePlan(db, Number(trackId), spec.prompt, slots);
      if (item.output && item.state === "succeeded") {
        const [videoId] = await db("o_video").insert({
          projectId,
          scriptId,
          videoTrackId: trackId,
          filePath: item.output,
          state: "生成成功",
          time: batch.createdAt,
        });
        await db("o_videoTrack").where({ id: trackId }).update({ videoId });
      }
      await db("o_importItem").where({ id: item.id }).update({ trackId });
    }
  }
  await db("o_importBatch")
    .where({ id: batch.id })
    .update({ projectId, scriptId });
  return Number(scriptId);
}

export async function initImportStudioNative(db: Knex) {
  for (const column of ["projectId", "scriptId"])
    if (!(await db.schema.hasColumn("o_importBatch", column))) {
      await db.schema.alterTable("o_importBatch", (t) =>
        t.integer(column).index(),
      );
    }
  for (const column of ["assetId", "trackId"])
    if (!(await db.schema.hasColumn("o_importItem", column))) {
      await db.schema.alterTable("o_importItem", (t) =>
        t.integer(column).index(),
      );
    }
  const legacy = await db("o_importBatch")
    .whereNull("projectId")
    .orderBy("createdAt");
  for (const batch of legacy)
    await db.transaction(async (trx) => {
      // Recheck under the transaction so retries never clone a migrated project.
      if (
        (await trx("o_importBatch").where({ id: batch.id }).first()).projectId
      )
        return;
      const firstItem = await trx("o_importItem")
        .where({ batchId: batch.id })
        .orderBy("position")
        .first();
      const spec = firstItem ? JSON.parse(firstItem.spec) : {};
      const projectId = await createImportProject(trx, batch.kind, {
        name: batch.name,
        videoRatio: batch.kind === "video" ? spec.aspectRatio : "16:9",
        ...(batch.kind === "image" && firstItem?.model
          ? { imageModel: firstItem.model }
          : {}),
      });
      await materializeImportBatch(trx, batch, projectId);
      await trx("o_importBatch")
        .where({ id: batch.id })
        .update({
          fingerprint: createHash("sha256")
            .update(`${projectId}:${batch.fingerprint}`)
            .digest("hex"),
        });
    });
}
