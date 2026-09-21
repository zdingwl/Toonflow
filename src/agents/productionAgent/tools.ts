import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import { createHash, randomUUID } from "node:crypto";

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

async function readAuthoritativeTextValue(
  key: keyof FlowData,
  projectIdRaw: unknown,
  scriptIdRaw: unknown,
): Promise<{ handled: boolean; value?: string }> {
  const projectId = Number(projectIdRaw);
  const scriptId = Number(scriptIdRaw);
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(scriptId)) {
    throw new Error("工作区缺少有效的项目或剧集 ID");
  }

  if (key === "script") {
    const script = await u.db("o_script").where({ id: scriptId, projectId }).select("content").first();
    if (!script) throw new Error("当前项目不存在该集剧本");
    return { handled: true, value: script.content ?? "" };
  }

  if (key === "scriptPlan" || key === "storyboardTable") {
    const row = await u.db("o_agentWorkData")
      .where({ projectId, episodesId: scriptId, key: "productionAgent" })
      .select("data")
      .first();
    if (!row?.data) return { handled: true, value: "" };
    const data = JSON.parse(row.data);
    return { handled: true, value: typeof data[key] === "string" ? data[key] : "" };
  }

  return { handled: false };
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
      description: "获取工作区数据；script/scriptPlan/storyboardTable 直接读取后端数据库真实值，避免浏览器缓存导致误判。其他字段保持兼容读取。长文本可选 offset/limit 分段。",
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
          const authoritative = await readAuthoritativeTextValue(key, resTool.data.projectId, resTool.data.scriptId);
          let value: unknown;
          if (authoritative.handled) {
            value = authoritative.value ?? "";
          } else {
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
            value = flowData[key];
          }
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
      description: "新增或更新衍生资产。写入使用 requestId 事务回执；重试同一操作必须复用相同 requestId。",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string; requestId?: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
            requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional()
              .describe("可选操作标识；失败重试必须复用错误信息中的 requestId"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const requestId = raw.requestId ?? `da_${randomUUID()}`;
        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const payload = { assetsId: raw.assetsId, id: normalizedId, name: raw.name, desc: raw.desc };
        const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        const receiptKey = `deriveAssetWrite:${requestId}`;

        try {
          const committed = await u.db.transaction(async (trx) => {
            const priorReceipt = await trx("o_agentWorkData")
              .where({ projectId, episodesId: scriptId, key: receiptKey })
              .select("data")
              .first();
            if (priorReceipt?.data) {
              const prior = JSON.parse(priorReceipt.data);
              if (prior.payloadHash !== payloadHash || !Number.isSafeInteger(Number(prior.assetId))) {
                throw new Error("相同 requestId 对应不同的衍生资产写入内容");
              }
              const existing = await trx("o_assets").where({ id: Number(prior.assetId), projectId, assetsId: raw.assetsId }).first();
              const linked = await trx("o_scriptAssets").where({ scriptId, assetId: Number(prior.assetId) }).first();
              if (!existing || !linked || existing.name !== raw.name || (existing.describe ?? "") !== raw.desc) {
                throw new Error("衍生资产写入回执与当前数据库状态不一致");
              }
              return { asset: existing, reused: true };
            }

            const parent = await trx("o_assets").where({ id: raw.assetsId, projectId }).select("id", "type").first();
            if (!parent) throw new Error("关联的资产不存在");

            let assetId = normalizedId;
            if (assetId) {
              const existing = await trx("o_assets").where({ id: assetId, projectId, assetsId: raw.assetsId }).first();
              const linked = await trx("o_scriptAssets").where({ scriptId, assetId }).first();
              if (!existing || !linked) throw new Error("衍生资产不属于当前项目、剧集或指定的父资产");
              const updated = await trx("o_assets").where({ id: assetId, projectId, assetsId: raw.assetsId }).update({
                name: raw.name,
                type: parent.type,
                describe: raw.desc,
                startTime: Date.now(),
              });
              if (updated !== 1) throw new Error("衍生资产更新失败");
            } else {
              const [insertedId] = await trx("o_assets").insert({
                assetsId: raw.assetsId,
                projectId,
                name: raw.name,
                type: parent.type,
                describe: raw.desc,
                startTime: Date.now(),
              });
              assetId = Number(insertedId);
              await trx("o_scriptAssets").insert({ scriptId, assetId });
            }

            const saved = await trx("o_assets").where({ id: assetId, projectId, assetsId: raw.assetsId }).first();
            const linked = await trx("o_scriptAssets").where({ scriptId, assetId }).first();
            if (!saved || !linked || saved.name !== raw.name || (saved.describe ?? "") !== raw.desc) {
              throw new Error("衍生资产写入后校验失败");
            }
            await trx("o_agentWorkData").insert({
              projectId,
              episodesId: scriptId,
              key: receiptKey,
              data: JSON.stringify({ payloadHash, assetId, assetsId: raw.assetsId, action: "upsert" }),
            });
            return { asset: saved, reused: false };
          });

          const data = {
            id: Number(committed.asset.id),
            assetsId: raw.assetsId,
            projectId,
            name: committed.asset.name,
            type: committed.asset.type,
            describe: committed.asset.describe,
            startTime: committed.asset.startTime,
          };
          const ack = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("衍生资产已写入数据库，但前端同步回执超时")), 30000);
            socket.emit("addDeriveAsset", data, (response: any) => {
              clearTimeout(timeout);
              if (response === false || response?.success === false || response?.error) {
                reject(new Error(response?.error ?? response?.message ?? "前端同步衍生资产失败"));
                return;
              }
              resolve(response);
            });
          });
          thinking.appendText(`${committed.reused ? "已复用" : "已提交"}衍生资产，ID: ${data.id}\n`);
          thinking.updateTitle("资产操作完成");
          thinking.complete();
          return { success: true, requestId, id: data.id, reused: committed.reused, ack };
        } catch (error) {
          const detail = `${u.error(error).message}；同一操作如需重试，请复用 requestId=${requestId}`;
          thinking.appendText("资产写入失败:\n" + detail);
          thinking.updateTitle("资产操作失败");
          thinking.complete();
          throw new Error(detail);
        }
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产。删除与 requestId 回执在同一事务；失败重试必须复用相同 requestId。",
      inputSchema: jsonSchema<{ assetsId: number; id: number; requestId?: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
            requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional()
              .describe("可选操作标识；失败重试必须复用错误信息中的 requestId"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id, requestId: rawRequestId }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId, projectId } = resTool.data;
        const requestId = rawRequestId ?? `dd_${randomUUID()}`;
        const payloadHash = createHash("sha256").update(JSON.stringify({ assetsId, id })).digest("hex");
        const receiptKey = `deriveAssetDelete:${requestId}`;

        try {
          const reused = await u.db.transaction(async (trx) => {
            const priorReceipt = await trx("o_agentWorkData")
              .where({ projectId, episodesId: scriptId, key: receiptKey })
              .select("data")
              .first();
            if (priorReceipt?.data) {
              const prior = JSON.parse(priorReceipt.data);
              if (prior.payloadHash !== payloadHash || Number(prior.assetId) !== id) {
                throw new Error("相同 requestId 对应不同的衍生资产删除内容");
              }
              const asset = await trx("o_assets").where({ id, projectId, assetsId }).first();
              const linked = await trx("o_scriptAssets").where({ scriptId, assetId: id }).first();
              if (asset || linked) throw new Error("删除回执存在，但当前数据库仍存在该衍生资产或剧集关联");
              return true;
            }

            const linked = await trx("o_scriptAssets").where({ scriptId, assetId: id }).first();
            const asset = await trx("o_assets").where({ id, projectId, assetsId }).first();
            if (!linked || !asset) throw new Error("衍生资产不属于当前项目或剧集");
            await trx("o_scriptAssets").where({ scriptId, assetId: id }).del();
            await trx("o_assets").where({ id, projectId, assetsId }).del();
            const remainingAsset = await trx("o_assets").where({ id, projectId }).first();
            const remainingLink = await trx("o_scriptAssets").where({ scriptId, assetId: id }).first();
            if (remainingAsset || remainingLink) throw new Error("衍生资产删除后校验失败");
            await trx("o_agentWorkData").insert({
              projectId,
              episodesId: scriptId,
              key: receiptKey,
              data: JSON.stringify({ payloadHash, assetId: id, assetsId, action: "delete" }),
            });
            return false;
          });

          const ack = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("衍生资产已从数据库删除，但前端同步回执超时")), 30000);
            socket.emit("delDeriveAsset", { assetsId, id }, (response: any) => {
              clearTimeout(timeout);
              if (response === false || response?.success === false || response?.error) {
                reject(new Error(response?.error ?? response?.message ?? "前端同步删除失败"));
                return;
              }
              resolve(response);
            });
          });
          thinking.appendText(`${reused ? "已复用删除回执" : "已删除"}衍生资产，ID: ${id}\n`);
          thinking.updateTitle("资产操作完成");
          thinking.complete();
          return { success: true, requestId, id, reused, ack };
        } catch (error) {
          const detail = `${u.error(error).message}；同一删除操作如需重试，请复用 requestId=${requestId}`;
          thinking.appendText("资产删除失败:\n" + detail);
          thinking.updateTitle("资产操作失败");
          thinking.complete();
          throw new Error(detail);
        }
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片。相同生成请求重试时必须复用 requestId，避免重复创建生成任务。",
      inputSchema: jsonSchema<{ ids: number[]; requestId?: string }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
            requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional()
              .describe("可选生成请求标识；失败重试必须复用错误信息中的 requestId"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids, requestId: rawRequestId }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        const requestId = rawRequestId ?? `ga_${randomUUID()}`;
        try {
          const res = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("衍生资产生成请求超时")), 60000);
            socket.emit("generateDeriveAsset", { ids, requestId }, (ack: any) => {
              clearTimeout(timeout);
              if (ack === false || ack?.error || ack?.success === false) reject(new Error(ack?.error ?? ack?.message ?? "衍生资产生成失败"));
              else resolve(ack);
            });
          });
          thinking.appendText(`生成请求已确认，requestId=${requestId}，回执: ${JSON.stringify(res, null, 2)}\n`);
          thinking.updateTitle("衍生资产生成请求已确认");
          thinking.complete();
          return { success: true, requestId, ack: res ?? null };
        } catch (error) {
          const detail = `${u.error(error).message}；同一生成请求如需重试，请复用 requestId=${requestId}`;
          thinking.appendText("生成请求失败:\n" + detail);
          thinking.updateTitle("衍生资产生成失败");
          thinking.complete();
          throw new Error(detail);
        }
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片。相同生成请求重试时必须复用 requestId，避免重复创建生成任务。",
      inputSchema: jsonSchema<{ ids: number[]; requestId?: string }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
            requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional()
              .describe("可选生成请求标识；失败重试必须复用错误信息中的 requestId"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids, requestId: rawRequestId }) => {
        const thinking = msg.thinking("正在生成分镜...");
        const requestId = rawRequestId ?? `gs_${randomUUID()}`;
        try {
          const res = await socketQueue(
            () =>
              new Promise((resolve, reject) =>
              {
                const timeout = setTimeout(() => reject(new Error("分镜生成请求超时")), 60000);
                socket.emit("generateStoryboard", { ids, requestId }, (res: any) => {
                  clearTimeout(timeout);
                  if (res?.error || res?.success === false) return reject(new Error(res?.error ?? res?.message ?? "分镜生成失败"));
                  resolve(res);
                });
              },
            ),
          );
          thinking.appendText(`分镜生成请求已确认，requestId=${requestId}:\n` + JSON.stringify(res, null, 2));
          thinking.updateTitle("分镜生成请求已确认");
          thinking.complete();
          return { success: true, requestId, ack: res ?? null };
        } catch (error) {
          const detail = `${u.error(error).message}；同一生成请求如需重试，请复用 requestId=${requestId}`;
          thinking.appendText("分镜生成请求失败:\n" + detail);
          thinking.updateTitle("分镜生成失败");
          thinking.complete();
          throw new Error(detail);
        }
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增分镜面板到工作区。重试同一镜头时必须复用原 requestId；不同镜头须使用不同 requestId。",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
        requestId?: string;
      }>(
        z
          .object({
            videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
            prompt: z.string().nullable().describe("分镜图片提示词"),
            track: z.string().describe("分组"),
            duration: z.number().describe("视频推荐时间"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
            requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional().describe("可选操作标识；首次调用可省略。超时或失败后重试相同镜头时，必须复用上次错误消息中的 requestId，不可重新生成新标识。"),
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
          requestId: raw.requestId ?? `sb_${Date.now()}_${Math.random().toString(36).slice(2)}`,
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
                    reject(new Error(ack?.error ?? ack?.message ?? "分镜写入失败"));
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
          const detail = `${u.error(error).message}；同一镜头如需重试，请使用 requestId=${data.requestId} 并保持其他参数不变`;
          thinking.appendText("分镜写入失败:\n" + detail);
          thinking.updateTitle("新增分镜失败");
          thinking.complete();
          throw new Error(detail);
        }
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
