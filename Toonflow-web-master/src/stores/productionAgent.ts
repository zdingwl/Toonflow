import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type { FlowData, Storyboard } from "@/views/production/utils/flowBuilder";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import { useThrottleFn } from "@vueuse/core";

function makeProductionAgentStore(projectId: string) {
  return defineStore(`productionAgent-${projectId}`, () => {
    const defMsg: ChatMessagesData[] = [
      {
        id: "welcome",
        role: "assistant",
        content: [
          { type: "text", status: "complete", data: $t("workbench.production.chatBox.welcomeMessage") },
          {
            type: "suggestion",
            status: "complete",
            data: [{ title: $t("workbench.production.chatBox.startMakingVideo"), prompt: $t("workbench.production.chatBox.startMakingVideoPrompt") }],
          },
        ],
      },
    ];
    onMounted(() => {
      if (messages.value.length <= 0) messages.value = [...defMsg, ...messages.value];
    });

    const flowData = ref<FlowData>({
      script: "", // 剧本
      scriptPlan: "", //导演计划
      storyboardTable: "", //分镜表
      assets: [], // 衍生资产
      storyboard: [], //分镜面板
      workbench: {
        videoList: [],
      }, // 工作台数据
    });

    const episodesId = ref<number>();
    const { connected, messages, chat, stopGenerate, socket, status, reconnect, connect, disconnect } = useChat({
      url: `${settingStore().baseUrl}/socket/productionAgent`,
      auth: () => ({
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      }),
      manageLifecycle: false,
      autoConnect: false,
      xmlTags: [
        { tag: "script", keepInMessage: false },
        { tag: "scriptPlan", keepInMessage: false },
        { tag: "storyboardTable", keepInMessage: false },
        { tag: "storyboardItem", keepInMessage: false },
      ],
      onXmlTag: async (data) => {
        const { tag, value, attrs, status } = data;
        if (tag === "script") {
          flowData.value.script = value ?? "";
        } else if (tag === "scriptPlan") {
          // 导演计划由后端校验并写入数据库，收到提交回执后才更新工作区。
          return;
        } else if (tag === "storyboardTable") {
          // Agent XML is only a stream preview; the backend is the sole writer.
          // Never write a scene (or a full table) from a browser completion event.
          // The storyboardTable:committed handler below updates the workspace.
          return;
        }
        if (status == "complete") {
          throttledFn();
        }
      },
    });

    const throttledFn = useThrottleFn(
      () => {
        void setFlowData(episodesId.value).catch((reason) => {
          window.$message.error(reason instanceof Error ? reason.message : "工作区保存失败");
        });
      },
      500,
      true,
      true,
    );
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("scriptPlan:committed", ({ episodesId: savedEpisode, plan }: { episodesId: number; plan: string }) => {
            if (Number(episodesId.value) === Number(savedEpisode)) flowData.value.scriptPlan = plan;
          });
          s.on("storyboardTable:committed", (payload: {
            episodesId: number;
            storyboardTable: string;
            storyboardTableProgress?: unknown;
          }) => {
            if (Number(episodesId.value) !== Number(payload.episodesId)) return;
            flowData.value.storyboardTable = payload.storyboardTable ?? "";
            if (payload.storyboardTableProgress) {
              (flowData.value as any).storyboardTableProgress = payload.storyboardTableProgress;
            } else {
              delete (flowData.value as any).storyboardTableProgress;
            }
          });
          s.on("connect", () => {
            getHistory();
          });
          s.on("getFlowData", (_, callback) => {
            const returnData = JSON.parse(JSON.stringify(flowData.value));
            returnData.assets.forEach((item: any) => {
              delete item.prompt;
              delete item.flowId;
              delete item.src;
              if (item.derive && item.derive.length) {
                item.derive.forEach((deriveItem: any) => {
                  delete deriveItem.prompt;
                  delete deriveItem.flowId;
                  delete deriveItem.src;
                });
              }
            });
            returnData.storyboard.forEach((item: any) => {
              delete item.prompt;
              delete item.src;
              delete item.flowId;
            });
            callback(returnData);
          });
          s.on("addDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const item = deriveAssetList.find((d) => d.id === data.id);
            if (item) {
              if (!item) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
              item.name = data.name;
              item.type = assets.type;
              callback({ success: true, message: $t("storyboard.assets.derivativeUpdateSuccess") });
            } else {
              deriveAssetList.push({
                assetsId: data.assetsId,
                id: data.id,
                name: data.name,
                type: assets.type,
                desc: data.describe,
                prompt: "",
                state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
                src: "",
              });
              callback({ success: true, message: $t("storyboard.assets.derivativeAddSuccess") });
            }
          });
          s.on("delDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const index = deriveAssetList.findIndex((d) => d.id === data.id);
            if (index === -1) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
            deriveAssetList.splice(index, 1);
            callback({ success: true, message: $t("storyboard.assets.derivativeDelSuccess") });
          });
          s.on("generateDeriveAsset", async (data, callback) => {
            try {
              const assetsData = await batchGenerateAssets(data.ids, data.requestId);
              callback({ success: true, requestId: data.requestId, message: assetsData });
            } catch (reason) {
              callback({
                success: false,
                requestId: data.requestId,
                error: reason instanceof Error ? reason.message : "衍生资产生成请求失败",
              });
            }
          });
          s.on("generateStoryboard", async (data, callback) => {
            try {
              const storyData = await batchGenerateStoryboard(data.ids, false, data.requestId);
              callback({ success: true, requestId: data.requestId, message: storyData });
            } catch (reason) {
              callback({
                success: false,
                requestId: data.requestId,
                error: reason instanceof Error ? reason.message : "分镜生成请求失败",
              });
            }
          });
          s.on("addStoryboard", async (data, callback) => {
            const requestId =
              typeof data.requestId === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(data.requestId)
                ? data.requestId
                : `sb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const insertVal = {
              prompt: data.prompt || "",
              duration: Number(data.duration) || 0,
              track: data.track || "",
              state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
              src: null,
              videoDesc: data.videoDesc,
              shouldGenerateImage:
                (typeof data.shouldGenerateImage == "boolean" && data.shouldGenerateImage) || String(data.shouldGenerateImage).toLowerCase() == "true"
                  ? 1
                  : 0,
              associateAssetsIds: data.associateAssetsIds || [],
            };
            flowData.value.storyboard.push(insertVal);
            const pending = flowData.value.storyboard[flowData.value.storyboard.length - 1];
            try {
              await addStoryboardInfo([insertVal], [pending], requestId);
              throttledFn();
              callback({ success: true, message: $t("storyboard.assets.derivativeAddSuccess"), requestId, id: pending.id });
            } catch (reason) {
              const index = flowData.value.storyboard.indexOf(pending);
              if (index !== -1 && !pending.id) flowData.value.storyboard.splice(index, 1);
              const message = reason instanceof Error ? reason.message : "分镜保存失败";
              callback({ success: false, message, requestId });
            }
          });
        }
      },
      { immediate: true },
    );

    async function setFlowData(
      scriptId?: number,
      writeFields: Array<"scriptPlan" | "storyboardTable"> = [],
    ) {
      const snapshot = JSON.parse(JSON.stringify(flowData.value));
      delete (flowData.value as any).resetStoryboardTable;
      await axios.post("/production/saveFlowData", {
        projectId: projectId,
        data: snapshot,
        episodesId: scriptId || episodesId.value,
        writeFields,
      });
    }

    async function getFlowData() {
      const { data } = await axios.post("/production/getFlowData", {
        projectId: projectId,
        episodesId: episodesId.value,
      });
      flowData.value = data;
    }
    async function batchGenerateStoryboard(allIds: number[], compulsory: boolean = false, requestId?: string) {
      const operationId = requestId ?? `storygen_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      try {
        const { data } = await axios.post("/production/storyboard/batchGenerateImage", {
          scriptId: episodesId.value,
          projectId: projectId,
          storyboardIds: allIds,
          concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
          compulsory,
          requestId: operationId,
        });
        if (data) {
          if (flowData.value.storyboard.length === 0) {
            flowData.value.storyboard = data;
            return data;
          } else {
            flowData.value.storyboard.forEach((item) => {
              const findData = data.find((i: any) => i.id == item.id);
              if (findData) {
                item.state = findData.state;
                item.src = findData.src;
              }
            });
          }
        }
        return data;
      } catch (e) {
        window.$message.error((e as any)?.message);
        throw e;
      }
    }
    async function batchGenerateAssets(allIds: number[], requestId?: string) {
      const operationId = requestId ?? `assetgen_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (allIds.includes(derive.id)) {
              derive.state = "生成中" as "未生成" | "生成中" | "已完成" | "生成失败";
            }
          });
        }
      });
      try {
        const { data } = await axios.post("/production/assets/batchGenerateAssetsImage", {
          assetIds: allIds,
          projectId: projectId,
          scriptId: episodesId.value,
          concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
          requestId: operationId,
        });
        if (data) {
          data.forEach((record: { id: number; state: "未生成" | "生成中" | "已完成" | "生成失败"; src: string }) => {
            flowData.value.assets.forEach((asset) => {
              if (asset.derive) {
                asset.derive.forEach((derive) => {
                  if (derive.id === record.id) {
                    derive.state = record.state;
                    derive.src = record.src;
                  }
                });
              }
            });
          });
        }
        return data;
      } catch (e) {
        try {
          await getFlowData();
        } catch {}
        window.$message.error((e as any)?.message);
        throw e;
      }
    }
    const assetsNotStateImageIds = computed(() => {
      const ids: number[] = [];
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (derive.state == ("生成中" as "未生成" | "生成中" | "已完成" | "生成失败")) {
              ids.push(derive.id);
            }
          });
        }
      });
      return ids;
    });
    const storyboardNotStateImageIds = computed(() => {
      const ids: number[] = [];
      flowData.value.storyboard.forEach((asset) => {
        if (asset.state == "生成中" && asset.id) {
          ids.push(asset.id);
        }
      });
      return ids;
    });
    let assetsPollingTimer: number | null = null;
    let assetsPollingInFlight = false;

    async function pollAssetsImages() {
      const ids = assetsNotStateImageIds.value;
      if (ids.length === 0 || assetsPollingInFlight) return;
      assetsPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/assets/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; errorReason?: string; prompt?: string }>;
        records.forEach((record) => {
          flowData.value.assets.forEach((asset) => {
            if (!asset.derive) return;
            asset.derive.forEach((derive) => {
              if (derive.id === record.id) {
                derive.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
                if (record.src) derive.src = record.src;
                derive.errorReason = record?.errorReason ?? "";
                derive.prompt = record?.prompt ?? "";
              }
            });
          });
        });
      } catch (e) {
        console.error("[assetsPolling] error", e);
      } finally {
        assetsPollingInFlight = false;
      }
    }

    function startAssetsPolling() {
      if (assetsPollingTimer) return;
      assetsPollingTimer = window.setInterval(async () => {
        if (assetsNotStateImageIds.value.length === 0) {
          stopAssetsPolling();
          return;
        }
        await pollAssetsImages();
      }, 5000);
      pollAssetsImages();
    }

    function stopAssetsPolling() {
      if (assetsPollingTimer) {
        clearInterval(assetsPollingTimer);
        assetsPollingTimer = null;
      }
    }

    watch(
      () => assetsNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startAssetsPolling();
        } else {
          stopAssetsPolling();
        }
      },
    );

    let storyboardPollingTimer: number | null = null;
    let storyboardPollingInFlight = false;

    async function pollStoryboardImages() {
      const ids = storyboardNotStateImageIds.value;
      if (ids.length === 0 || storyboardPollingInFlight) return;
      storyboardPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/storyboard/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; reason?: string }>;
        records.forEach((record) => {
          const item = flowData.value.storyboard.find((s) => s.id === record.id);
          if (item) {
            item.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
            if (record.src) item.src = record.src;
            item.reason = record?.reason ?? "";
          }
        });
      } catch (e) {
        console.error("[storyboardPolling] error", e);
      } finally {
        storyboardPollingInFlight = false;
      }
    }

    function startStoryboardPolling() {
      if (storyboardPollingTimer) return;
      storyboardPollingTimer = window.setInterval(async () => {
        if (storyboardNotStateImageIds.value.length === 0) {
          stopStoryboardPolling();
          return;
        }
        await pollStoryboardImages();
      }, 5000);
      pollStoryboardImages();
    }

    function stopStoryboardPolling() {
      if (storyboardPollingTimer) {
        clearInterval(storyboardPollingTimer);
        storyboardPollingTimer = null;
      }
    }

    watch(
      () => storyboardNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startStoryboardPolling();
        } else {
          stopStoryboardPolling();
        }
      },
    );

    function updateContext() {
      if (episodesId.value! < 0) return;
      const ctx = {
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      };
      if (!connected.value) connect();
      socket.value!.emit("updateContext", ctx);
    }
    async function addStoryboardInfo(items: any[], pendingItems: Storyboard[], requestId: string) {
      const response = (await axios.post("/production/storyboard/batchAddStoryboardInfo", {
        scriptId: episodesId.value,
        data: items,
        projectId: projectId,
        requestId,
      })) as unknown as { code: number; message?: string; data: Storyboard[]; createdIds?: number[] };
      if (response?.code !== 200 || !Array.isArray(response.data) || !Array.isArray(response.createdIds) || response.createdIds.length !== items.length) {
        throw new Error(response?.message ?? "分镜保存回执缺少本批镜头 ID");
      }
      const persisted = new Map(response.data.map((item) => [item.id, item]));
      const saved = response.createdIds.map((id) => persisted.get(id));
      if (saved.some((item) => !item)) throw new Error("分镜保存回执与数据库记录不一致");
      saved.forEach((item, index) => {
        const target = pendingItems[index];
        const record = item!;
        const duplicate = flowData.value.storyboard.find((existing) => existing.id === record.id && existing !== target);
        if (duplicate) {
          const position = flowData.value.storyboard.indexOf(target);
          if (position !== -1) flowData.value.storyboard.splice(position, 1);
        } else {
          target.id = record.id;
          target.trackId = record.trackId;
          target.src = record.src;
          target.state = record.state;
          target.associateAssetsIds = record.associateAssetsIds;
        }
      });
    }

    const loadingHistory = ref(false);
    async function getHistory() {
      loadingHistory.value = true;
      const { data } = await axios.post(`/agents/getMemory`, {
        projectId: projectId,
        episodesId: episodesId.value,
        agentType: "productionAgent",
      });
      messages.value = [];
      messages.value = [...defMsg, ...data];
      loadingHistory.value = false;
    }

    const thinkLevel = ref(0);

    function updateThinkConfig(value: number) {
      thinkLevel.value = value;
      if (socket.value) {
        socket.value.emit("updateThinkConfig", { think: value > 0, thinlLevel: value });
      }
    }

    const emitAck = <T = any>(event: string, payload: any = {}) =>
      new Promise<T>((resolve, reject) => {
        if (!socket.value?.connected) return reject(new Error("Agent 尚未连接"));
        socket.value.emit(event, payload, (response: any) => {
          if (!response?.success) reject(new Error(response?.error ?? "Agent 操作失败"));
          else resolve(response as T);
        });
      });

    const getAgentRuns = () => emitAck<{ success: true; runs: any[] }>("agent:runs");
    const reconcileRun = (runId: string) => emitAck<{ success: true; run: any }>("agent:reconcile", { runId });
    const resumeRun = (runId: string) => emitAck<{ success: true; runId: string }>("agent:resume", { runId });
    const resolveRunStep = (
      runId: string,
      stepKey: string,
      resolution: "completed" | "failed" | "retryable" | "cancelled",
      resultRef?: string,
      error?: string,
    ) => emitAck<{ success: true; run: any }>("agent:resolve-step", { runId, stepKey, resolution, resultRef, error });
    const resolveRunTool = (
      runId: string,
      id: string,
      resolution: "completed" | "retryable" | "cancelled",
      output?: unknown,
      error?: string,
    ) => emitAck<{ success: true; run: any }>("agent:resolve-tool", { runId, id, resolution, output, error });

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
      flowData,
      setFlowData,
      getFlowData,
      episodesId,
      stopAssetsPolling,
      stopStoryboardPolling,
      updateContext,
      getHistory,
      loadingHistory,
      batchGenerateStoryboard,
      reconnect,
      thinkLevel,
      updateThinkConfig,
      getAgentRuns,
      reconcileRun,
      resumeRun,
      resolveRunStep,
      resolveRunTool,
    };
  });
}

const storeMap = new Map<string, ReturnType<typeof makeProductionAgentStore>>();

function createProductionAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeProductionAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useProductionAgentStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createProductionAgentStore(id)();
}
