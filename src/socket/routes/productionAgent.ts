import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { TaskStore } from "@/utils/agent/runtime/taskStore";
import { reconcileDirectorPlanOutput } from "@/agents/productionAgent/directorPlan";

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
      console.log("[productionAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    let isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[productionAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
      scriptId: socket.handshake.auth.scriptId,
    });
    let abortController: AbortController | null = null;
    let activeRunId: string | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    const scope = () => ({
      agentType: "productionAgent" as const,
      projectId: Number(resTool.data.projectId),
      episodesId: Number(resTool.data.scriptId),
      isolationKey,
    });

    const ensureRunScope = async (runId: string) => {
      const run = await taskStore.getRun(runId);
      if (
        run.agentType !== "productionAgent" ||
        Number(run.projectId) !== Number(resTool.data.projectId) ||
        Number(run.episodesId) !== Number(resTool.data.scriptId) ||
        run.isolationKey !== isolationKey
      ) throw new Error("任务不属于当前项目、剧集或 Agent 上下文");
      return run;
    };

    const reconcileKnownSteps = async (runId: string) => {
      let state = await taskStore.reconcile(runId);
      const projectId = Number(resTool.data.projectId);
      const episodesId = Number(resTool.data.scriptId);

      // 分镜新增本身已有 requestId 事务回执；连接中断后可通过后端保存记录确认是否真实写入。
      for (const call of state.toolCalls.filter(
        (item) => item.toolName === "add_flowData_storyboard" && ["reconciling", "failed"].includes(item.status),
      )) {
        try {
          const input = (call.input ?? {}) as Record<string, unknown>;
          const requestId =
            (typeof input.requestId === "string" && input.requestId) ||
            call.error?.match(/requestId=([A-Za-z0-9_-]{8,128})/)?.[1];
          if (!requestId) continue;
          const receipt = await u.db("o_agentWorkData")
            .where({ projectId, episodesId, key: `storyboardWrite:${requestId}` })
            .select("data")
            .first();
          if (!receipt?.data) continue;
          const saved = JSON.parse(receipt.data);
          if (!Array.isArray(saved.createdIds) || !saved.createdIds.length) continue;
          await taskStore.resolveToolCall(runId, call.id, "completed", {
            success: true,
            requestId,
            createdIds: saved.createdIds,
            reconciled: true,
          });
        } catch (error) {
          console.warn("[productionAgent] 自动核对分镜写入失败:", call.id, u.error(error).message);
        }
      }

      state = await taskStore.reconcile(runId);
      for (const step of state.steps.filter((item) => item.status === "reconciling")) {
        try {
          if (step.stepKey.startsWith("productionAgent:directorPlanAgent:")) {
            const resultRef = await reconcileDirectorPlanOutput(u.db, projectId, episodesId, step.output);
            if (resultRef) await taskStore.resolveStep(runId, step.stepKey, "completed", resultRef);
            continue;
          }

          const sideEffects = state.toolCalls.filter((call) => call.stepKey === step.stepKey && call.sideEffect);
          if (!sideEffects.length) {
            // 没有任何写工具开始执行时，中断只影响模型推理，可安全重试该步骤。
            await taskStore.resolveStep(runId, step.stepKey, "retryable", undefined, "未发现写操作，可安全重试");
            continue;
          }
          if (
            sideEffects.every((call) => call.toolName === "add_flowData_storyboard" && call.status === "completed")
          ) {
            // 分镜写入已由 requestId 确认，重跑模型时 ToolExecutor 会直接复用已完成回执。
            await taskStore.resolveStep(runId, step.stepKey, "retryable", undefined, "分镜写入已确认，模型步骤可安全重试");
          }
        } catch (error) {
          console.warn("[productionAgent] 自动核对步骤失败:", step.stepKey, u.error(error).message);
        }
      }
      return taskStore.reconcile(runId);
    };

    const executeRun = async (runId: string, content: string, controller: AbortController) => {
      const msg = resTool.newMessage("assistant", "视频策划");
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
          const message = u.error(err).message;
          console.error("[productionAgent] chat error:", message);
          ctx.msg.error(message);
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
        callback?.({ success: true, runs: await taskStore.list("productionAgent", Number(resTool.data.projectId), Number(resTool.data.scriptId)) });
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

    socket.on("updateContext", (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      if (activeRunId || abortController) {
        callback?.({ success: false, error: "当前任务执行中，不能切换剧集上下文" });
        return;
      }
      isolationKey = data.isolationKey;
      resTool = new ResTool(socket, {
        projectId: data.projectId,
        scriptId: data.scriptId,
      });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
      callback?.({ success: true });
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
          const msg = resTool.newMessage("assistant", "视频策划");
          msg.error(`该请求已存在，当前状态：${run.status}`);
          if (abortController === currentController) abortController = null;
          return;
        }
        await executeRun(run.id, content, currentController);
      } catch (err: any) {
        if (abortController === currentController) abortController = null;
        console.error("[productionAgent] task start error:", u.error(err).message);
        const msg = resTool.newMessage("assistant", "视频策划");
        msg.error(u.error(err).message);
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      if (activeRunId) void taskStore.finish(activeRunId, "reconciling", "用户停止，需核对已完成结果")
        .catch((error) => console.error("[productionAgent] 停止任务状态保存失败:", u.error(error).message));
      abortController = null;
      activeRunId = null;
    });
    socket.on("disconnect", () => {
      abortController?.abort();
      if (activeRunId) void taskStore.finish(activeRunId, "reconciling", "连接断开，需核对已完成结果")
        .catch((error) => console.error("[productionAgent] 断线任务状态保存失败:", u.error(error).message));
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] 已断开连接:", socket.id);
  });
};
