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
            const response = await axios.post("/scriptAgent/setPlanData", {
              projectId: projectId,
              agentType: "scriptAgent",
              data: JSON.parse(snapshot),
            });
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
            const { tag, value, children, status, attrs } = data;
            if (tag === "storySkeleton") {
              planData.value.storySkeleton = value;
            } else if (tag === "adaptationStrategy") {
              planData.value.adaptationStrategy = value;
            } else if (tag === "scriptItem") {
              const name = attrs.name ?? "";
              const content = value;
              if (name) {
                const existingIndex = planData.value.script.findIndex((s) => s.name === name);
                if (existingIndex !== -1) {
                  planData.value.script[existingIndex].content = content;
                } else {
                  planData.value.script.push({ name, content });
                }
              }
            }
            if (status === "complete") {
              setPlanData().catch((error) => {
                console.error("剧本工作区保存失败", error);
                window.$message.error("剧本工作区保存失败，请检查后端状态并重试保存");
              });
            }
          },
          autoConnect: false,
        });

        watch(
          socket,
          (s) => {
            if (s) {
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

        return { connected, messages, chat, stopGenerate, socket, status, planData, setPlanData, connect, disconnect, thinkLevel, updateThinkConfig };
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
