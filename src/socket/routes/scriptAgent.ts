import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { TaskStore } from "@/utils/agent/runtime/taskStore";

async function verifyToken(rawToken: string): Promise<Boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const { value: tokenKey } = setting;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, tokenKey as string);
    return true;
  } catch (err) {
    return false;
  }
}

export default (nsp: Namespace) => {
  const taskStore = new TaskStore(u.db);
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[scriptAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[scriptAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
    });
    let abortController: AbortController | null = null;
    let activeRunId: string | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("agent:runs", async (_: unknown, callback) => {
      try {
        callback?.({ success: true, runs: await taskStore.list("scriptAgent", Number(resTool.data.projectId)) });
      } catch (error) {
        callback?.({ success: false, error: u.error(error).message });
      }
    });

    socket.on("chat", async (data: { content: string; requestId?: string }) => {
      const { content } = data;
      abortController?.abort();
      const interruptedRunId = activeRunId;
      abortController = new AbortController();
      const currentController = abortController;
      let runId: string | null = null;

      const msg = resTool.newMessage("assistant", "统筹");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        if (interruptedRunId) await taskStore.finish(interruptedRunId, "reconciling", "被新请求中断，需核对已完成结果");
        const run = await taskStore.begin({ requestId: data.requestId, agentType: "scriptAgent", projectId: Number(resTool.data.projectId), isolationKey, content });
        socket.emit("agent:run", run);
        if (run.duplicate) {
          msg.error(`该请求已存在，当前状态：${run.status}`);
          return;
        }
        runId = run.id;
        activeRunId = runId;
        ctx.runId = runId;
        await agent.runDecisionAI(ctx);
        await taskStore.finish(runId, currentController.signal.aborted ? "reconciling" : "completed");
      } catch (err: any) {
        if (runId) await taskStore.finish(runId, currentController.signal.aborted ? "reconciling" : "failed", u.error(err).message);
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[scriptAgent] chat error:", u.error(err).message);
          msg.error(u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
          activeRunId = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      if (activeRunId) void taskStore.finish(activeRunId, "reconciling", "用户停止，需核对已完成结果")
        .catch((error) => console.error("[scriptAgent] 停止任务状态保存失败:", u.error(error).message));
      abortController = null;
      activeRunId = null;
    });
    socket.on("disconnect", () => {
      abortController?.abort();
      if (activeRunId) void taskStore.finish(activeRunId, "reconciling", "连接断开，需核对已完成结果")
        .catch((error) => console.error("[scriptAgent] 断线任务状态保存失败:", u.error(error).message));
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[scriptAgent] 已断开连接:", socket.id);
  });
};
