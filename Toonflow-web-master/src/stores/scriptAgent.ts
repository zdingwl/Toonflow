import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
}

function makeScriptAgentStore(projectId: string) {
  return defineStore(`scriptAgent-${projectId}`, () => {
        const planData = ref<PlanData>({
          storySkeleton: "",
          adaptationStrategy: "",
          script: [],
        });

        // 将每次保存的工作区快照按顺序提交，避免较早的异步请求覆盖较新的剧本。
        let saveQueue: Promise<void> = Promise.resolve();
        let lastQueuedSnapshot = "";

        async function setPlanData() {
          const snapshot = JSON.stringify(planData.value);
          if (snapshot === lastQueuedSnapshot) return saveQueue;
          lastQueuedSnapshot = snapshot;
          const currentSave = saveQueue.then(async () => {
            // axios 响应拦截器在运行时解包 response.data，类型声明仍是 AxiosResponse。
            const response: { code: number; message?: string } = (await axios.post("/scriptAgent/setPlanData", {
              projectId: projectId,
              agentType: "scriptAgent",
              data: JSON.parse(snapshot),
            })) as any;
            if (response?.code !== 200) throw new Error(response?.message || "剧本保存未得到成功回执");
          });
          saveQueue = currentSave.then(
            () => undefined,
            () => {
              if (lastQueuedSnapshot === snapshot) lastQueuedSnapshot = "";
            },
          );
          return currentSave;
        }

        const { connected, messages, chat, stopGenerate, socket, status, disconnect, connect } = useChat({
          url: `${settingStore().baseUrl}/socket/scriptAgent`,
          auth: () => ({
            isolationKey: `${projectId}:scriptAgent`,
            projectId: projectId,
          }),
          manageLifecycle: false,
          xmlTags: [
            { tag: "storySkeleton", keepInMessage: false },
            { tag: "adaptationStrategy", keepInMessage: false },
            { tag: "scriptItem", keepInMessage: false },
          ],
          onXmlTag: (data) => {
            // Agent 产物先由后端校验、事务写入并读回确认；这里只等待 committed 回执。
            if (["storySkeleton", "adaptationStrategy", "scriptItem"].includes(data.tag)) return;
          },
          autoConnect: false,
        });

        watch(
          socket,
          (s) => {
            if (s) {
              s.on("scriptWorkspace:committed", (payload: any) => {
                if (payload?.type === "storySkeleton") {
                  planData.value.storySkeleton = payload.value ?? "";
                } else if (payload?.type === "adaptationStrategy") {
                  planData.value.adaptationStrategy = payload.value ?? "";
                } else if (payload?.type === "scriptItem" && payload.name) {
                  const existingIndex = planData.value.script.findIndex((item) => item.name === payload.name);
                  const next = { id: payload.id, name: payload.name, content: payload.content ?? "" };
                  if (existingIndex === -1) planData.value.script.push(next);
                  else planData.value.script[existingIndex] = next;
                }
              });
              s.on("getPlanData", (_, callback) => {
                callback(planData.value);
              });
            }
          },
          { immediate: true },
        );

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

        return {
          connected, messages, chat, stopGenerate, socket, status, planData, setPlanData, connect, disconnect,
          thinkLevel, updateThinkConfig, getAgentRuns, reconcileRun, resumeRun, resolveRunStep,
        };
      });
}

const storeMap = new Map<string, ReturnType<typeof makeScriptAgentStore>>();

function createScriptAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeScriptAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useScriptAgentStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createScriptAgentStore(id)();
}
