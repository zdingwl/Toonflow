import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { TaskStore } from "@/utils/agent/runtime/taskStore";
import { reconcileScriptStepOutput } from "@/agents/scriptAgent/workspace";

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

    const scope = () => ({
      agentType: "scriptAgent" as const,
      projectId: Number(resTool.data.projectId),
      isolationKey,
    });

    const ensureRunScope = async (runId: string) => {
      const run = await taskStore.getRun(runId);
      if (
        run.agentType !== "scriptAgent" ||
        Number(run.projectId) !== Number(resTool.data.projectId) ||
        run.isolationKey !== isolationKey
      ) throw new Error("任务不属于当前项目或 Agent 上下文");
      return run;
    };

    const reconcileKnownSteps = async (runId: string) => {
      let state = await taskStore.reconcile(runId);
      for (const step of state.steps.filter((item) => item.status === "reconciling")) {
        try {
          const resultRef = await reconcileScriptStepOutput(u.db, Number(resTool.data.projectId), step.stepKey, step.output);
          if (resultRef) await taskStore.resolveStep(runId, step.stepKey, "completed", resultRef);
        } catch (error) {
          console.warn("[scriptAgent] 自动核对步骤失败:", step.stepKey, u.error(error).message);
        }
      }
      state = await taskStore.reconcile(runId);
      return state;
    };

    const executeRun = async (runId: string, content: string, controller: AbortController) => {
      const msg = resTool.newMessage("assistant", "统筹");
      const ctx: agent.AgentContext = {
        runId,
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: controller.signal,
        resTool,
        msg,
        thinkConfig,
      };
      activeRunId = runId;
      try {
        await agent.runDecisionAI(ctx);
        await taskStore.finish(runId, controller.signal.aborted ? "reconciling" : "completed");
      } catch (err: any) {
        await taskStore.finish(runId, controller.signal.aborted ? "reconciling" : "failed", u.error(err).message);
        if (err.name !== "AbortError" && !controller.signal.aborted) {
          console.error("[scriptAgent] chat error:", u.error(err).message);
          ctx.msg.error(u.error(err).message);
        }
      } finally {
        if (abortController === controller) {
          abortController = null;
          activeRunId = null;
        }
      }
    };

    socket.on("agent:runs", async (_: unknown, callback) => {
      try {
        callback?.({ success: true, runs: await taskStore.list("scriptAgent", Number(resTool.data.projectId)) });
      } catch (error) {
        callback?.({ success: false, error: u.error(error).message });
      }
    });

    socket.on("agent:reconcile", async (data: { runId: string }, callback) => {
      try {
        await ensureRunScope(data.runId);
        callback?.({ success: true, run: await reconcileKnownSteps(data.runId) });
      } catch (error) {
        callback?.({ success: false, error: u.error(error).message });
      }
    });

    socket.on("agent:resume", async (data: { runId: string }, callback) => {
      try {
        if (activeRunId || abortController) throw new Error("当前已有任务正在执行，请先停止后再恢复");
        await ensureRunScope(data.runId);
        await reconcileKnownSteps(data.runId);
        const resumed = await taskStore.resume(data.runId, scope());
        const controller = new AbortController();
        abortController = controller;
        socket.emit("agent:run", { id: resumed.id, status: "running", duplicate: false, resumed: true });
        callback?.({ success: true, runId: resumed.id });
        void executeRun(resumed.id, resumed.content, controller);
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

      try {
        if (interruptedRunId) await taskStore.finish(interruptedRunId, "reconciling", "被新请求中断，需核对已完成结果");
        const run = await taskStore.begin({ requestId: data.requestId, ...scope(), content });
        socket.emit("agent:run", run);
        if (run.duplicate) {
          const msg = resTool.newMessage("assistant", "统筹");
          msg.error(`该请求已存在，当前状态：${run.status}`);
          if (abortController === currentController) abortController = null;
          return;
        }
        await executeRun(run.id, content, currentController);
      } catch (err: any) {
        if (abortController === currentController) abortController = null;
        console.error("[scriptAgent] task start error:", u.error(err).message);
        const msg = resTool.newMessage("assistant", "统筹");
        msg.error(u.error(err).message);
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
