import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      script: z.array(z.object({ name: z.string().min(1), content: z.string() })).optional(),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, data } = req.body;
    const workspaceQuery = () => u.db("o_agentWorkData").where({ projectId, key: agentType });
    const serialized = JSON.stringify(data);
    // 新建项目可能尚未请求 getPlanData，不能把 UPDATE 0 行视为保存成功。
    const updated = await workspaceQuery().update({ data: serialized });
    if (!updated) {
      await u.db("o_agentWorkData").insert({ projectId, key: agentType, data: serialized });
    }

    // 仍按剧本名称更新既有记录；相同名称在一次请求中出现多次时，以最后一次内容为准。
    const scripts = [...new Map((data.script ?? []).map((item: { name: string; content: string }) => [item.name, item])).values()];
    for (const item of scripts) {
      const row = await u.db("o_script").where({ projectId, name: item.name }).first();
      if (row) {
        await u.db("o_script").where({ id: row.id, projectId }).update({ content: item.content });
      } else {
        await u.db("o_script").insert({ projectId, name: item.name, content: item.content });
      }
    }

    // 在返回成功前核对工作区和本次提交的剧本内容；读回失败就让调用方得到错误而不是成功提示。
    const savedWorkspace = await workspaceQuery().select("data").first();
    const savedData = savedWorkspace?.data ? JSON.parse(savedWorkspace.data) : null;
    if (savedData?.storySkeleton !== data.storySkeleton || savedData?.adaptationStrategy !== data.adaptationStrategy) {
      throw new Error("剧本工作区保存校验失败");
    }
    if (scripts.length) {
      const savedScripts = await u.db("o_script").where({ projectId }).whereIn("name", scripts.map((item) => item.name)).select("name", "content");
      const byName = new Map(savedScripts.map((item: { name: string; content: string }) => [item.name, item.content]));
      if (scripts.some((item) => byName.get(item.name) !== item.content)) {
        throw new Error("剧本正文保存校验失败");
      }
    }
    return res.status(200).send(success());
  },
);
