import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

/** 串行队列：一个请求失败不能让其后的分镜操作全部停在已拒绝的 Promise 上。 */
function createSocketQueue(delayMs = 800) {
  let lastPromise: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const operation = lastPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => {
            try {
              Promise.resolve(fn()).then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          }, delayMs);
        }),
    );
    lastPromise = operation.then(() => undefined, () => undefined);
    return operation;
  };
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const socketQueue = createSocketQueue(800);
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据；不传 offset/limit 时返回完整原始数据。长文本可选用 offset/limit 按字符分段，数组按条目分段，返回 data、total、nextOffset。",
      inputSchema: jsonSchema<{ key: keyof FlowData; offset?: number; limit?: number }>(
        z
          .object({
            key: keySchema.describe("数据key"),
            offset: z.number().int().min(0).optional().describe("可选分段起点，从0开始；文本按字符、数组按条目计数"),
            limit: z.number().int().min(1).max(12000).optional().describe("可选分段长度，默认文本6000字符、数组10条；不传 offset/limit 时返回完整数据"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key, offset, limit }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);
        try {
          const flowData: FlowData = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`获取${flowDataKeyLabels[key]}超时，未收到工作区响应`)), 60000);
            socket.emit("getFlowData", { key }, (res: any) => {
              clearTimeout(timeout);
              if (!res || typeof res !== "object" || res.error || !(key in res)) {
                reject(new Error(res?.error ?? `工作区未返回${flowDataKeyLabels[key]}数据`));
                return;
              }
              resolve(res);
            });
          });
          const value = flowData[key];
          // 只有显式传入分段参数才改变返回形状；原有 Agent 调用保持原始值类型。
          const useChunk = offset !== undefined || limit !== undefined;
          let result: unknown = value;
          if (useChunk && (typeof value === "string" || Array.isArray(value))) {
            const start = offset ?? 0;
            const count = limit ?? (typeof value === "string" ? 6000 : 10);
            const end = Math.min(start + count, value.length);
            result = {
              data: value.slice(start, end),
              offset: start,
              total: value.length,
              nextOffset: end < value.length ? end : null,
            };
          }
          thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(result, null, 2));
          thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
          thinking.complete();
          return result;
        } catch (error) {
          thinking.appendText(`读取失败: ${u.error(error).message}`);
          thinking.updateTitle(`获取${flowDataKeyLabels[key]}失败`);
          thinking.complete();
          throw error;
        }
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };
        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type").first();
        if (!parentAssets) return "关联的资产不存在";
        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("衍生资产生成失败:\n" + u.error(e).message);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
          });
        return "开始生成衍生资产";
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("generateStoryboard", { ids }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
            thinking.updateTitle("分镜生成完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("分镜生成失败:\n" + u.error(e).message);
            thinking.updateTitle("分镜生成失败");
            thinking.complete();
          });
        return "开始生成分镜";
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增分镜面板到工作区",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
      }>(
        z
          .object({
            videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
            prompt: z.string().nullable().describe("分镜图片提示词"),
            track: z.string().describe("分组"),
            duration: z.number().describe("视频推荐时间"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const thinking = msg.thinking("正在新增 分镜面板 数据...");
        const data = {
          videoDesc: raw.videoDesc,
          prompt: raw.prompt,
          track: raw.track,
          duration: raw.duration,
          associateAssetsIds: raw.associateAssetsIds ?? [],
          shouldGenerateImage: raw.shouldGenerateImage,
        };
        try {
          // 分镜写入是前置数据操作，不同于图片生成：必须收到前端确认后才向 Agent 报告成功。
          const res = await socketQueue(
            () =>
              new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("分镜写入超时，未收到前端确认")), 60000);
                socket.emit("addStoryboard", { ...data }, (ack: any) => {
                  clearTimeout(timeout);
                  if (ack === false || ack?.success === false || ack?.error) {
                    reject(new Error(ack?.error ?? "分镜写入失败"));
                    return;
                  }
                  resolve(ack);
                });
              }),
          );
          thinking.appendText("新增的分镜数据:\n" + JSON.stringify(data, null, 2));
          thinking.updateTitle("新增分镜成功");
          thinking.complete();
          return res ?? true;
        } catch (error) {
          thinking.appendText("分镜写入失败:\n" + u.error(error).message);
          thinking.updateTitle("新增分镜失败");
          thinking.complete();
          throw error;
        }
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
