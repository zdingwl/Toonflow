import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { zip } from "compressing";
import u from "@/utils";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import {
  ASSET_CSV,
  EXAMPLE_MANIFEST,
  IMPORT_README,
  MAX_UPLOAD,
  makeZip,
  parseAssetCsv,
  parseVideoZip,
} from "@/utils/importStudioContracts";
import { initStudioTables } from "@/utils/importStudioQueue";
import {
  createImportProject,
  initImportStudioNative,
  materializeImportBatch,
  importProjectType,
} from "@/utils/importStudioNative";

const router = express.Router();
let ready: Promise<void> | undefined;
const ensureReady = () =>
  (ready ??= initStudioTables(db)
    .then(() => initImportStudioNative(db))
    .catch((e) => {
      ready = undefined;
      throw e;
    }));

async function models(kind: "image" | "video") {
  const vendors = await db("o_vendorConfig").where({ enable: 1 });
  const result: { value: string; label: string }[] = [];
  for (const config of vendors) {
    const vendor = await u.vendor.getVendor(String(config.id));
    if (!String(vendor?.id || "").startsWith("comfyui")) continue;
    const values = {
      ...vendor.inputValues,
      ...JSON.parse(config.inputValues || "{}"),
    };
    if (
      kind === "video" &&
      values.videoBackend &&
      values.videoBackend !== "comfyui"
    )
      continue;
    for (const model of await u.vendor.getModelList(String(config.id))) {
      if (
        model.type !== kind ||
        (kind === "video" && !/minimax.*h3/i.test(model.modelName))
      )
        continue;
      result.push({
        value: `${config.id}:${model.modelName}`,
        label: `${model.name} · ${vendor.name}`,
      });
    }
  }
  return result;
}

const projectFields = z.object({
  name: z.string().trim().min(1).max(200),
  intro: z.string().max(2000).default(""),
  artStyle: z.string().max(3000).default(""),
  videoRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  imageQuality: z.enum(["1K", "2K", "4K"]).default("1K"),
  imageModel: z.string().max(200).default(""),
  videoModel: z.string().max(200).default(""),
});

router.use(async (_req, _res, next) => {
  try {
    await ensureReady();
    next();
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res) => {
  try {
    const action = z
      .enum([
        "projects",
        "createProject",
        "project",
        "updateProject",
        "list",
        "detail",
        "models",
        "preview",
        "import",
        "download",
        "template",
      ])
      .parse(req.body.action);
    if (action === "models")
      return res.send(
        success(await models(z.enum(["image", "video"]).parse(req.body.kind))),
      );
    if (action === "projects") {
      const kind = z.enum(["image", "video"]).parse(req.body.kind);
      const projects = await db("o_project")
        .where({ projectType: importProjectType(kind) })
        .orderBy("createTime", "desc");
      for (const project of projects)
        project.batchCount = Number(
          (
            await db("o_importBatch")
              .where({ projectId: project.id })
              .count({ count: "id" })
              .first()
          )?.count || 0,
        );
      return res.send(success(projects));
    }
    if (action === "createProject") {
      const kind = z.enum(["image", "video"]).parse(req.body.kind);
      const fields = projectFields.parse(req.body);
      const selected = kind === "image" ? fields.imageModel : fields.videoModel;
      if (!(await models(kind)).some((x) => x.value === selected))
        throw new Error("请选择已启用的本地 ComfyUI 模型");
      return res.send(
        success({ id: await createImportProject(db, kind, fields) }),
      );
    }
    if (action === "template") {
      const kind = z.enum(["image", "video"]).parse(req.body.kind);
      if (kind === "image")
        return res
          .type("text/csv; charset=utf-8")
          .attachment("assets-template.csv")
          .send(ASSET_CSV);
      const placeholder = async (label: string) =>
        sharp(
          Buffer.from(
            `<svg width="768" height="512"><rect width="768" height="512" fill="#edf2fa"/><text x="384" y="235" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#0052d9">${label}</text><text x="384" y="300" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#555">REPLACE THIS SAMPLE IMAGE</text></svg>`,
          ),
        )
          .png()
          .toBuffer();
      const files = new Map<string, Buffer>([
        [
          "manifest.json",
          Buffer.from(JSON.stringify(EXAMPLE_MANIFEST, null, 2)),
        ],
        ["使用说明.txt", Buffer.from(IMPORT_README)],
        ["assets/hero.png", await placeholder("Picture 1 / hero")],
        ["assets/room.png", await placeholder("Picture 2 / room")],
      ]);
      return res
        .type("application/zip")
        .attachment("h3-video-template.zip")
        .send(await makeZip(files));
    }
    const projectId = z.number().int().positive().parse(req.body.projectId);
    const project = await db("o_project")
      .where({ id: projectId })
      .whereIn("projectType", ["import-image", "import-video"])
      .first();
    if (!project)
      return res.status(404).send(error("导入项目不存在，请先新建项目"));
    const projectKind =
      project.projectType === "import-image" ? "image" : "video";
    if (req.body.kind && req.body.kind !== projectKind)
      throw new Error("项目类型与导入文件不一致");
    if (action === "project")
      return res.send(
        success({
          project,
          batches: await db("o_importBatch")
            .where({ projectId })
            .select("id", "name", "scriptId", "createdAt")
            .orderBy("createdAt", "desc"),
        }),
      );
    if (action === "updateProject") {
      const fields = projectFields.parse(req.body);
      const selected =
        projectKind === "image" ? fields.imageModel : fields.videoModel;
      if (!(await models(projectKind)).some((x) => x.value === selected))
        throw new Error("请选择已启用的本地 ComfyUI 模型");
      await db("o_project").where({ id: projectId }).update(fields);
      return res.send(success({ id: projectId }));
    }
    if (action === "list")
      return res.send(
        success(
          await db("o_importBatch")
            .where({ projectId })
            .select("id", "name", "scriptId", "createdAt")
            .orderBy("createdAt", "desc"),
        ),
      );
    if (action === "preview" || action === "import") {
      const { kind, file, name } = z
        .object({
          kind: z.enum(["image", "video"]),
          file: z.string().max(Math.ceil(MAX_UPLOAD / 3) * 4),
          name: z.string().trim().min(1).max(200),
        })
        .parse(req.body);
      if (file.length % 4 || /[^A-Za-z0-9+/=]/.test(file))
        throw new Error("文件编码无效");
      const buffer = Buffer.from(file, "base64");
      if (buffer.toString("base64") !== file || buffer.length > MAX_UPLOAD)
        throw new Error("文件编码无效或超过大小限制");
      const sourceHash = createHash("sha256")
        .update(kind)
        .update(buffer)
        .digest("hex");
      const fingerprint = createHash("sha256")
        .update(`${projectId}:${sourceHash}`)
        .digest("hex");
      const existing = await db("o_importBatch").where({ fingerprint }).first();
      if (existing)
        return res.send(
          success({ id: existing.id, existing: true, name: existing.name }),
        );
      const video = kind === "video" ? await parseVideoZip(buffer) : undefined;
      const specs = video ? video.manifest.shots : parseAssetCsv(buffer);
      if (action === "preview")
        return res.send(
          success({
            name: video?.manifest.name || name,
            count: specs.length,
            assets: video?.manifest.assets || [],
            items: specs,
          }),
        );
      const batchId = randomUUID();
      const assets = video
        ? video.manifest.assets.map((asset) => ({
            ...asset,
            path: `/import-studio/${batchId}/assets/${asset.id}.png`,
          }))
        : [];
      try {
        for (const asset of assets)
          await u.oss.writeFile(asset.path, video!.images.get(asset.id)!);
        await db.transaction(async (trx) => {
          const batch = {
            id: batchId,
            projectId,
            kind,
            name: video?.manifest.name || name,
            fingerprint,
            assets: JSON.stringify(assets),
            createdAt: Date.now(),
          };
          await trx("o_importBatch").insert(batch);
          for (let position = 0; position < specs.length; position++)
            await trx("o_importItem").insert({
              id: randomUUID(),
              batchId,
              position,
              spec: JSON.stringify(specs[position]),
              state: "ready",
            });
          await materializeImportBatch(trx, batch, projectId);
        });
      } catch (e) {
        for (const asset of assets)
          await u.oss.deleteFile(asset.path).catch(() => {});
        const duplicate = await db("o_importBatch")
          .where({ fingerprint })
          .first();
        if (duplicate)
          return res.send(success({ id: duplicate.id, existing: true }));
        throw e;
      }
      return res.send(success({ id: batchId }));
    }
    const batchId = z.string().uuid().parse(req.body.batchId);
    const batch = await db("o_importBatch")
      .where({ id: batchId, projectId })
      .first();
    if (!batch) return res.status(404).send(error("导入批次不存在"));
    if (action === "detail") {
      const items = await db("o_importItem")
        .where({ batchId })
        .orderBy("position");
      const assets = await Promise.all(
        JSON.parse(batch.assets).map(async (asset: any) => ({
          ...asset,
          url: await u.oss.getFileUrl(asset.path),
        })),
      );
      return res.send(
        success({
          id: batch.id,
          name: batch.name,
          kind: batch.kind,
          assets,
          items: await Promise.all(
            items.map(async (item) => ({
              ...item,
              spec: JSON.parse(item.spec),
              url: item.output ? await u.oss.getFileUrl(item.output) : null,
            })),
          ),
        }),
      );
    }
    if (action === "download") {
      const candidates = await db("o_importItem")
        .where({ batchId })
        .orderBy("position");
      const items = [];
      for (const item of candidates) {
        const asset = item.assetId
          ? await db("o_assets").where({ id: item.assetId, projectId }).first()
          : null;
        const image = asset?.imageId
          ? await db("o_image")
              .where({ id: asset.imageId, state: "已完成" })
              .first()
          : null;
        const track = item.trackId
          ? await db("o_videoTrack")
              .where({ id: item.trackId, projectId, archived: 0 })
              .first()
          : null;
        const videos = track
          ? await db("o_video")
              .where({ videoTrackId: track.id, projectId })
              .whereIn("state", ["生成成功", "已完成"])
              .orderBy("id", "desc")
          : [];
        const video = videos.find((v) => v.id === track.videoId) || videos[0];
        const output = image?.filePath || video?.filePath;
        if (output)
          items.push({ ...item, output, model: image?.model || item.model });
      }
      if (!items.length) throw new Error("还没有成功生成的文件");
      const archive = new zip.Stream();
      for (const item of items)
        archive.addEntry(u.getPath(["oss", item.output.replace(/^\//, "")]), {
          relativePath: `${batch.kind === "image" ? "assets" : "videos"}/${JSON.parse(item.spec).id}${extname(item.output)}`,
        });
      archive.addEntry(
        Buffer.from(
          JSON.stringify(
            items.map((x) => ({ ...JSON.parse(x.spec), model: x.model })),
            null,
            2,
          ),
        ),
        { relativePath: "results.json" },
      );
      res.type("application/zip").attachment(`${batch.kind}-results.zip`);
      archive.on("error", (e) => res.destroy(e));
      res.on("close", () => archive.destroy());
      archive.pipe(res);
      return;
    }
  } catch (e) {
    return res.status(400).send(error((e as Error).message));
  }
});
export default router;
