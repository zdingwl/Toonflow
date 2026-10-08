import { z } from "zod";
import { zip } from "compressing";
import sharp from "sharp";
import { assertH3ReferenceBindings } from "./h3ReferenceBindings";

export const MAX_UPLOAD = 45 * 1024 * 1024;
const id = z.string().trim().min(1).max(100).regex(/^[\w-]+$/, "编号只能使用英文字母、数字、下划线和短横线")
  .refine(value => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value), "编号不能使用 Windows 保留文件名");
const text = z.string().trim().min(1).max(30000);
const assetType = z.enum(["role", "scene", "tool", "creature"]);
export const imageRowSchema = z.object({
  id, name: text.max(200), type: assetType, prompt: text,
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "2:3", "3:2", "4:3", "3:4"]).default("1:1"),
});
export const shotSchema = z.object({
  id, name: text.max(200), prompt: text, duration: z.number().int().min(5).max(15),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  resolution: z.enum(["768p"]).default("768p"), audio: z.boolean().default(true),
  assets: z.array(id).min(1).max(9),
});
export const manifestSchema = z.object({
  version: z.literal(1), name: text.max(200),
  assets: z.array(z.object({ id, name: text.max(200), type: assetType, file: text.max(240) })).min(1).max(500),
  shots: z.array(shotSchema).min(1).max(500),
});
export type ImageRow = z.infer<typeof imageRowSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export function unique(values: string[], label: string) {
  if (new Set(values.map(x => x.toLowerCase())).size !== values.length) throw new Error(`${label}存在重复编号（不区分大小写）`);
}

// RFC 4180 quoting, including multiline prompts and Excel's UTF-8 BOM.
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  source = source.replace(/^\uFEFF/, "");
  const pushCell = () => { row.push(cell); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(c => c.trim())) rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ",") pushCell();
    else if (c === "\n" || c === "\r") { if (c === "\r" && source[i + 1] === "\n") i++; pushRow(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error("CSV 引号格式错误，请使用模板另存为 CSV UTF-8"); cell += c; }
  }
  if (quoted) throw new Error("CSV 提示词的引号没有闭合");
  if (cell || row.length || closed) pushRow();
  return rows;
}

export function parseAssetCsv(buffer: Buffer): ImageRow[] {
  if (buffer.length > 4 * 1024 * 1024) throw new Error("表格不能超过 4 MB");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const [header, ...rows] = parseCsv(source);
  const keys = ["id", "name", "type", "prompt", "aspectRatio"];
  if (!header || header.join(",") !== keys.join(",")) throw new Error(`请保留模板表头：${keys.join(",")}`);
  if (!rows.length || rows.length > 500) throw new Error("每张表格需要 1–500 行资产");
  const result = rows.map((row, i) => {
    if (row.length !== keys.length) throw new Error(`第 ${i + 2} 行列数不正确`);
    const parsed = imageRowSchema.safeParse(Object.fromEntries(keys.map((key, j) => [key, row[j].trim() || (key === "aspectRatio" ? "1:1" : "")])));
    if (!parsed.success) throw new Error(`第 ${i + 2} 行：${parsed.error.issues.map(x => `${x.path.join(".")} ${x.message}`).join("；")}`);
    return parsed.data;
  });
  unique(result.map(x => x.id), "资产");
  return result;
}

export function safeZipPath(name: string): string {
  if (!name || name.length > 240 || /[\\:\x00-\x1f]/.test(name) || name.startsWith("/") || name.split("/").some(x => x === ".." || x === "." || /[. ]$/.test(x))) {
    throw new Error(`压缩包路径不安全：${name}`);
  }
  return name;
}

export async function readZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (buffer.length > MAX_UPLOAD) throw new Error("压缩包不能超过 45 MB");
  const files = new Map<string, Buffer>(), seen = new Set<string>();
  let total = 0, count = 0;
  return new Promise((resolve, reject) => {
    const stream = new zip.UncompressStream({ source: buffer });
    let failed = false;
    const fail = (error: Error) => { failed = true; stream.destroy(); reject(error); };
    stream.on("error", fail);
    stream.on("finish", () => { if (!failed) resolve(files); });
    stream.on("entry", async (header: any, entry: any, next: () => void) => {
      try {
        safeZipPath(header.name);
        if (++count > 1100 || (header.mode & 0o170000) === 0o120000) throw new Error("压缩包文件过多或包含符号链接");
        const key = header.name.toLowerCase();
        if (seen.has(key)) throw new Error(`压缩包有重复路径：${header.name}`);
        seen.add(key);
        if (header.type === "directory") { entry.resume(); next(); return; }
        if (header.yauzl.uncompressedSize > 20 * 1024 * 1024) throw new Error(`文件超过 20 MB：${header.name}`);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of entry) {
          size += chunk.length; total += chunk.length;
          if (size > 20 * 1024 * 1024 || total > 200 * 1024 * 1024) throw new Error("压缩包解压后超过大小限制");
          chunks.push(chunk);
        }
        if (!failed) { files.set(header.name, Buffer.concat(chunks)); next(); }
      } catch (e) { entry.destroy(); fail(e as Error); }
    });
  });
}

export function validateManifest(value: unknown): Manifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.map(x => `${x.path.join(".")} ${x.message}`).join("；"));
  const manifest = parsed.data;
  unique(manifest.assets.map(x => x.id), "资产"); unique(manifest.shots.map(x => x.id), "分镜");
  const assets = new Map(manifest.assets.map((a, index) => [a.id, { ...a, index }]));
  for (const asset of manifest.assets) safeZipPath(asset.file);
  for (const shot of manifest.shots) {
    unique(shot.assets, `分镜 ${shot.id} 的绑定资产`);
    const slots = shot.assets.map(assetId => {
      const asset = assets.get(assetId);
      if (!asset) throw new Error(`分镜 ${shot.id} 引用了不存在的资产：${assetId}`);
      return { assetId: asset.index + 1, assetType: asset.type };
    });
    try { assertH3ReferenceBindings(shot.prompt, slots); }
    catch (e) { throw new Error(`分镜 ${shot.id}：${(e as Error).message}`); }
  }
  return manifest;
}

export async function parseVideoZip(buffer: Buffer) {
  const files = await readZip(buffer);
  const roots = [...files.keys()].filter(x => x === "manifest.json" || x.endsWith("/manifest.json"));
  if (roots.length !== 1) throw new Error("压缩包需要且只能包含一个 manifest.json");
  const root = roots[0].slice(0, -"manifest.json".length);
  const manifest = validateManifest(JSON.parse(files.get(roots[0])!.toString("utf8").replace(/^\uFEFF/, "")));
  const images = new Map<string, Buffer>();
  let normalizedBytes = 0;
  for (const asset of manifest.assets) {
    const file = files.get(root + asset.file);
    if (!file) throw new Error(`缺少资产图片：${asset.file}`);
    if (!/\.(png|jpe?g|webp)$/i.test(asset.file)) throw new Error(`图片仅支持 PNG、JPG、WebP：${asset.file}`);
    try {
      const image = sharp(file, { limitInputPixels: 40000000, animated: false });
      const info = await image.metadata();
      if (!["png", "jpeg", "webp"].includes(info.format || "")) throw new Error("无效格式");
      const normalized = await image.png().toBuffer();
      normalizedBytes += normalized.length;
      if (normalizedBytes > 200 * 1024 * 1024) throw new Error("图片总大小过大");
      images.set(asset.id, normalized);
    } catch { throw new Error(`资产图片无效、损坏或尺寸过大：${asset.file}`); }
  }
  return { manifest, images };
}

export async function makeZip(files: Map<string, Buffer>): Promise<Buffer> {
  const stream = new zip.Stream();
  for (const [name, file] of files) stream.addEntry(file, { relativePath: safeZipPath(name) });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export const ASSET_CSV = '\uFEFFid,name,type,prompt,aspectRatio\r\nhero,主角,role,"完整人物四视图，同一名青年男性，黑色短发，蓝色外套，统一服装与身份，干净背景",3:2\r\nroom,客厅,scene,"现代客厅，木质家具，清晨窗光，无人物",16:9\r\nwatch,腕表,tool,"黑色电子腕表，产品展示，干净背景",1:1\r\n';
export const EXAMPLE_MANIFEST: Manifest = {
  version: 1, name: "H3 导入示例（请替换示例图片）",
  assets: [{ id: "hero", name: "主角", type: "role", file: "assets/hero.png" }, { id: "room", name: "客厅", type: "scene", file: "assets/room.png" }],
  shots: [{ id: "shot_001", name: "主角走入客厅", prompt: "一个连续镜头，<Picture 1> 中的人物走入 <Picture 2> 的客厅，保持参考人物的身份和服装；人物设定图的多个视角表示同一个人，不在视频中展示排版。镜头缓慢跟随，半写实三维动画、国漫式人物设计、真实材质和电影光照。", duration: 5, aspectRatio: "16:9", resolution: "768p", audio: true, assets: ["hero", "room"] }],
};
export const IMPORT_README = `批量资产与 H3 视频导入规则

先在“批量资产”或“导入视频”中创建项目，选择本地模型，再进入项目下载模板和导入。

资产表格：用 Excel/WPS 打开 CSV 模板，保留表头，另存为 CSV UTF-8（逗号分隔）。
每行一个资产，id 唯一，只使用字母、数字、下划线、短横线。
name 为名称；type 使用 role（人物）、scene（场景）、tool（道具）、creature（生物）；prompt 为完整图片提示词。
creature 保留在导入记录中，工作台归入“道具”，使用现有道具与生物规则，不走人物四视图流程。
aspectRatio 使用 1:1、16:9、9:16、2:3、3:2、4:3、3:4。每次最多 500 行、4 MB。
图片使用资产页相同的生成逻辑：角色四视图、参考图、分辨率和历史图片管理。实际画布按资产类型和模型规则决定，aspectRatio 作为导入信息保留。

视频压缩包：ZIP 中放 manifest.json 与 assets 图片目录；允许整体套一层文件夹。
version 固定为 1；name 是批次名称。assets 定义资产编号、名称、类型和图片的相对路径。
资产 type 支持 role（人物）、scene（场景）、tool（道具）、creature（生物）。生物在工作台归入“道具”，每张生物图片仍独立占用一个 Picture，导入记录保留原始类型。
shots 中每项是一个视频：id、name、prompt、duration（5–15 秒整数）、aspectRatio（16:9 或 9:16）、resolution（768p）、audio（true/false）、assets。
分镜 assets 数组的顺序就是 Picture 顺序：第一个是 <Picture 1>，第二个是 <Picture 2>。
提示词必须引用全部已绑定 Picture，不得引用未绑定的序号。每镜头 1–9 张图，不允许重复编号。
人物完整四视图按一张图片绑定，不拆分视角。Subject 标签可选，使用时需保持绑定一致。
图片仅支持 PNG/JPG/WebP；路径不能是绝对路径、网络地址或含 ..；ZIP 最多 45 MB，解压后最多 200 MB，单文件最多 20 MB，图片最多 4000 万像素。
模板中的图片是标明用途的示例占位图，使用前请替换。最多 500 个资产、500 个分镜。

先检查文件，确认预览后导入；导入不会自动开始生成。模型沿用设置中已启用的本地 ComfyUI 配置。
图片在资产工作台生成；视频在视频工作台编辑提示词、参考图，单条生成或勾选批量生成。重新生成会保留历史结果。
视频无需再次生成对白语言提示词。单条使用当前设置；批量保留每条导入的声音、分辨率、画幅和时长。H3 在同一批次内串行生成，状态自动更新。
关闭页面不会中断服务端任务。服务重启后请检查原生任务中心及 ComfyUI 队列再重试。
同一项目内相同文件重复导入会打开已有批次。不同文件创建新批次，同名编号不覆盖原有资产；不同项目可分别导入同一个文件。
`;
