import db from "@/utils/db";

const taskStateMap = {
  "0": "进行中",
  "1": "已完成",
  "-1": "生成失败",
};

export interface ProviderTaskReceipt {
  provider: string;
  promptId: string;
  baseUrl: string;
  outputNode?: string;
}

export type TaskRecordHandle = ((state: 1 | -1, reason?: string) => Promise<void>) & {
  onTaskSubmitted: (receipt: ProviderTaskReceipt) => Promise<void>;
};
/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
  } = {},
): Promise<TaskRecordHandle> {
  const { content, describe = "" } = opts;

  let opteorContent: string | undefined;
  if (content === undefined || content === null) {
    opteorContent = undefined;
  } else if (typeof content === "string") {
    opteorContent = content;
  } else if (typeof content === "function") {
    throw new Error("不支持的类型");
  } else {
    try {
      opteorContent = JSON.stringify(content);
    } catch (e) {
      opteorContent = content.toString();
    }
  }

  const [id] = await db("o_tasks").insert({
    projectId,
    taskClass,
    relatedObjects: opteorContent,
    model: modelName,
    describe,
    state: taskStateMap[0],
    startTime: Date.now(),
  });

  /** 任务成功时调用 done(1)，失败时调用 done(-1, '原因') */
  const done = async function (state: 1 | -1, reason?: string) {
    await db("o_tasks")
      .where("id", id)
      .update({
        state: taskStateMap[state],
        reason: state === -1 ? (reason ?? "") : null,
      });
  };

  done.onTaskSubmitted = async (receipt: ProviderTaskReceipt) => {
    let relatedObjects: Record<string, unknown> = {};
    if (opteorContent) {
      try {
        const parsed = JSON.parse(opteorContent);
        relatedObjects = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed : { originalContent: opteorContent };
      } catch {
        relatedObjects = { originalContent: opteorContent };
      }
    }
    // Bind the receipt to this insert, even when another task starts before submission finishes.
    await db("o_tasks").where("id", id).update({
      relatedObjects: JSON.stringify({ ...relatedObjects, providerTask: receipt }),
    });
  };

  return done;
}
