import { syncManagedPromptDefaults } from "@/utils/managedPromptDefaults";
import u from "@/utils";
import path from "path";
import fs from "fs";
import { Knex } from "knex";
import db from "@/utils/db";
import { transform } from "sucrase";
import rawVendorData from "./vendor.json";

import { migrateVideoLanguages } from "@/utils/videoLanguages";
import { migrateAssetDescriptions } from "@/utils/assetDescriptionVersion";

const vendorData = rawVendorData as Record<string, string>;

export default async (knex: Knex): Promise<void> => {
  await migrateAssetDescriptions(knex);
  const addColumn = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (!(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => (t as any)[type](column));
    }
  };

  const dropColumn = async (table: string, column: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(column));
    }
  };

  const alterColumnType = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => {
        (t as any)[type](column).alter();
      });
    }
  };
  // 进程退出时无法判断模型调用或业务写入是否完成；先核对结果，不能盲目重跑。
  if (await knex.schema.hasTable("o_agentRun")) {
    await knex("o_agentRun").where("status", "running").update({ status: "reconciling", updateTime: Date.now() });
  }
  if (await knex.schema.hasTable("o_agentStep")) {
    await knex("o_agentStep").where("status", "running").update({ status: "reconciling", updateTime: Date.now() });
  }
  if (await knex.schema.hasTable("o_memoryJob")) {
    await knex("o_memoryJob").where("status", "running").update({ status: "pending", updateTime: Date.now() });
  }
  if (await knex.schema.hasTable("o_agentToolCall")) {
    // 工具运行中退出时无法证明写操作是否已经生效；统一进入待核对状态，禁止自动重复执行。
    await knex("o_agentToolCall").where("status", "running").update({ status: "reconciling", updateTime: Date.now() });
  }
  //矫正因软件异常退出导致的状态不一致问题
  await db("o_novel").where("eventState", 0).update({
    eventState: -1,
    errorReason: "软件退出导致失败",
  });
  await db("o_script").where("extractState", 0).update({
    extractState: -1,
    errorReason: "软件退出导致失败",
  });
  await db("o_assets").where("promptState", "生成中").update({
    promptState: "生成失败",
    promptErrorReason: "软件退出导致失败",
  });
  await db("o_image").where("state", "生成中").update({
    state: "生成失败",
    errorReason: "软件退出导致失败",
  });
  await db("o_storyboard").where("state", "生成中").update({
    state: "生成失败",
    reason: "软件退出导致失败",
  });
  await db("o_video").where("state", "生成中").update({
    state: "生成失败",
    errorReason: "软件退出导致失败",
  });

  await migrateVideoLanguages(knex);
  const interruptedLanguageTracks = await knex("o_videoPromptVariant").where({ state: "生成中" }).distinct("trackId");
  if (interruptedLanguageTracks.length) await knex("o_videoTrack").whereIn("id", interruptedLanguageTracks.map(row => row.trackId)).update({ state: "生成失败", reason: "服务重启，请重试未完成的对白语言" });
  await knex("o_videoPromptVariant").where({ state: "生成中" }).update({ state: "生成失败", reason: "服务重启，请重试该语言" });

  // 添加新字段
  await addColumn("o_agentRun", "inputContent", "text");
  await addColumn("o_agentStep", "inputHash", "text");
  await addColumn("o_agentStep", "inputContent", "text");
  await addColumn("o_agentStep", "output", "text");
  await addColumn("o_agentToolCall", "stepKey", "text");
  if (await knex.schema.hasTable("o_videoTrack") && !(await knex.schema.hasColumn("o_videoTrack", "archived"))) {
    await knex.schema.alterTable("o_videoTrack", (table) => table.integer("archived").notNullable().defaultTo(0));
  }
  if (await knex.schema.hasTable("o_setting")) {
    await knex("o_setting").insert([
      { key: "memoryContextTokenBudget", value: "2400" },
      { key: "embeddingBackend", value: "onnx" },
      { key: "ollamaEmbeddingModel", value: "qwen3-embedding:4b" },
      { key: "memoryHybridRetrieval", value: "1" },
      { key: "memoryRerankerEnabled", value: "0" },
      { key: "memoryRerankerUrl", value: "http://127.0.0.1:11435/rerank" },
      { key: "memoryRerankerModel", value: "Qwen3-Reranker-4B" },
      { key: "memoryRerankerCandidates", value: "24" },
      { key: "memoryVectorScanPageSize", value: "256" },
    ]).onConflict("key").ignore();
  }
  await addColumn("o_prompt", "useData", "text");
  // 添加新字段
  await addColumn("o_agentDeploy", "type", "string");
  // 添加新字段
  await addColumn("o_agentDeploy", "temperature", "integer");
  // 添加新字段
  await addColumn("o_agentDeploy", "maxOutputTokens", "integer");
  await addColumn("o_assets", "audioBindState", "integer");
  await addColumn("o_assets", "designVersion", "integer");
  await addColumn("o_assets", "designStatus", "text");
  await addColumn("o_assets", "faceReferencePath", "text");
  await addColumn("o_assets", "fullBodyReferencePath", "text");
  await addColumn("o_assets", "sideReferencePath", "text");
  await addColumn("o_assets", "backReferencePath", "text");
  await addColumn("o_assets", "referenceLayout", "text");
  await addColumn("o_assets", "referenceFingerprint", "text");
  await addColumn("o_modelPrompt", "fileName", "string");
  await addColumn("o_modelPrompt", "path", "string");
  await addColumn("o_video", "width", "integer");
  await addColumn("o_video", "height", "integer");
  await addColumn("o_video", "fps", "float");
  await addColumn("o_video", "bitrate", "integer");
  await addColumn("o_video", "codec", "text");
  await addColumn("o_video", "actualDuration", "float");
  const vendorDataSelect = await u.db("o_vendorConfig").whereIn("id", ["deepseek", "atlascloud"]).select("*");
  if (!vendorDataSelect.find((i) => i.id == "deepseek")) {
    await u.db("o_vendorConfig").insert({
      id: "deepseek",
      inputValues: "{}",
      models: "[]",
      enable: 0,
    });
  }
  if (!vendorDataSelect.find((i) => i.id == "atlascloud")) {
    await u.db("o_vendorConfig").insert({
      id: "atlascloud",
      inputValues: "{}",
      models: "[]",
      enable: 0,
    });
  }
  //检测o_setting是否有agentUseMode
  const agentUserMode = await u.db("o_setting").where("key", "agentUseMode").first();
  if (!agentUserMode) {
    const allDeployData = await u
      .db("o_agentDeploy")
      .leftJoin("o_vendorConfig", "o_vendorConfig.id", "o_agentDeploy.vendorId")
      .select("o_agentDeploy.*");
    const advancedData = allDeployData.filter((item: any) => item.key?.includes(":"));
    const notValModelData = advancedData.filter((item) => !item.modelName);

    await u.db("o_setting").insert({
      key: "agentUseMode",
      value: notValModelData.length ? "0" : "1",
    });
  }
  //添加数据高级配置
  const advancedAgentList = [
    { key: "scriptAgent:decisionAgent", name: "剧本Agent:决策层", desc: "决策层" },
    { key: "scriptAgent:supervisionAgent", name: "剧本Agent:监督层", desc: "监督层" },
    { key: "scriptAgent:storySkeletonAgent", name: "剧本Agent:故事骨架", desc: "故事骨架生成" },
    { key: "scriptAgent:adaptationStrategyAgent", name: "剧本Agent:改编策略", desc: "改编策略生成" },
    { key: "scriptAgent:scriptAgent", name: "剧本Agent:剧本生成", desc: "剧本生成" },
    { key: "productionAgent:decisionAgent", name: "生产Agent:决策层", desc: "决策层" },
    { key: "productionAgent:supervisionAgent", name: "生产Agent:监督层", desc: "监督层" },
    { key: "productionAgent:deriveAssetsAgent", name: "生产Agent:衍生资产", desc: "衍生资产" },
    { key: "productionAgent:generateAssetsAgent", name: "生产Agent:生成资产", desc: "生成资产" },
    { key: "productionAgent:directorPlanAgent", name: "生产Agent:导演规划", desc: "导演规划" },
    { key: "productionAgent:storyboardGenAgent", name: "生产Agent:分镜生成", desc: "分镜生成" },
    { key: "productionAgent:storyboardPanelAgent", name: "生产Agent:分镜面板", desc: "分镜面板生成" },
    { key: "productionAgent:storyboardTableAgent", name: "生产Agent:分镜表格", desc: "分镜表格生成" },
  ];
  for (const agent of advancedAgentList) {
    const exists = await db("o_agentDeploy").where("key", agent.key).select("*").first();
    if (!exists) {
      await db("o_agentDeploy").insert({
        model: "",
        modelName: "",
        vendorId: null,
        key: agent.key,
        name: agent.name,
        desc: agent.desc,
        temperature: 1,
        maxOutputTokens: 0,
        disabled: false,
      });
    }
  }
  // 四项默认规则共用文件来源；管理页面的 useData 自定义内容始终保留。
  await syncManagedPromptDefaults(knex);

  //迁移供应商函数
  const data = await knex("o_vendorConfig").select("*");
  for (const item of data) {
    let { id, code } = item;
    const filename = `${id}.ts`;
    const rootDir = u.getPath("vendor");
    if (!code && fs.existsSync(path.join(rootDir, filename))) continue;
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(path.join(rootDir, filename))) {
      code = vendorData[filename] || code;
      code = code ?? "";
      fs.writeFileSync(path.join(rootDir, filename), code);
    }
  }
  const defList = Object.keys(vendorData).map((filename) => filename.replace(/\.ts$/, ""));
  const existingIds = data.map((i: any) => i.id);
  for (const id of defList) {
    if (!existingIds.includes(id)) {
      const tsCode = vendorData[`${id}.ts`];
      if (tsCode) await tempOnsert(tsCode);
    }
  }

  await dropColumn("o_vendorConfig", "author");
  await dropColumn("o_vendorConfig", "description");
  await dropColumn("o_vendorConfig", "name");
  await dropColumn("o_vendorConfig", "icon");
  await dropColumn("o_vendorConfig", "inputs");
  await dropColumn("o_vendorConfig", "createTime");

  const volcengineVer = await u.vendor.getVendor("volcengine").version;
  if (Number(volcengineVer) < 2.4) {
    u.vendor.writeCode("volcengine", vendorData["volcengine.ts"]);
  }
  const minimaxVer = await u.vendor.getVendor("minimax").version;
  if (Number(minimaxVer) < 2.1) {
    u.vendor.writeCode("minimax", vendorData["minimax.ts"]);
  }
  const toonflowVer = await u.vendor.getVendor("toonflow").version;
  if (Number(toonflowVer) < 3.2) {
    u.vendor.writeCode("toonflow", vendorData["toonflow.ts"]);
  }
  const comfyuiLocalVer = await u.vendor.getVendor("comfyui_local").version;
  if (Number(comfyuiLocalVer) < 2.1) {
    u.vendor.writeCode("comfyui_local", vendorData["comfyui_local.ts"]);
  }
  const comfyuiLocalData = await u.db("o_vendorConfig").where("id", "comfyui_local").first();
  if (comfyuiLocalData) {
    const models = JSON.parse(comfyuiLocalData.models || "[]");
    if (!models.some((item: any) => item.modelName === "qwen-image-2.1-local")) {
      models.splice(Math.min(1, models.length), 0, {
        name: "Qwen Image 2.1 本机",
        modelName: "qwen-image-2.1-local",
        type: "image",
        mode: ["text", "singleImage", "multiReference"],
      });
    }
    const qwenImageModel = models.find((item: any) => item.modelName === "qwen-image-2.1-local");
    qwenImageModel.mode = ["text", "singleImage", "multiReference"];
    const h3Model = models.find((item: any) => item.modelName === "MiniMax-H3-local");
    if (h3Model) {
      for (const item of h3Model.durationResolutionMap || []) {
        item.resolution = ["768p"];
      }
    }
    const inputValues = {
      qwenImageUnet: "qwen_image_2.1_int8_convrot.safetensors",
      qwenImageClip: "qwen3vl_8b_int8_convrot.safetensors",
      qwenImageVae: "qwen_image_2.1_vae_bf16.safetensors",
      qwenImageSteps: "25",
      ...JSON.parse(comfyuiLocalData.inputValues || "{}"),
    };
    await u.db("o_vendorConfig").where("id", "comfyui_local").update({
      models: JSON.stringify(models),
      inputValues: JSON.stringify(inputValues),
    });
  }

  // The role provider renders four independent views and stitches them only for
  // review. Keep it enabled so role generation never falls back to a generic
  // text-to-image model that may draw an arbitrary number of figures.
  const fourViewCodePath = path.join(u.getPath("vendor"), "comfyui_qwen21_fourview.ts");
  if (fs.existsSync(fourViewCodePath)) {
    const fourViewCode = fs.readFileSync(fourViewCodePath, "utf-8");
    const fourViewExports = u.vm(transform(fourViewCode, { transforms: ["typescript"] }).code);
    const fourViewVendor = fourViewExports.vendor;
    const fourViewData = await u.db("o_vendorConfig").where("id", fourViewVendor.id).first();
    if (!fourViewData) {
      await u.db("o_vendorConfig").insert({
        id: fourViewVendor.id,
        inputValues: JSON.stringify(fourViewVendor.inputValues ?? {}),
        models: JSON.stringify(fourViewVendor.models ?? []),
        enable: 1,
      });
    } else {
      await u.db("o_vendorConfig").where("id", fourViewVendor.id).update({
        models: JSON.stringify(fourViewVendor.models ?? []),
        enable: 1,
      });
    }
  }
};

async function tempOnsert(tsCode: string) {
  const jsCode = transform(tsCode, { transforms: ["typescript"] }).code;
  const exports = u.vm(jsCode);
  const vendor = exports.vendor;
  const data = await u.db("o_vendorConfig").where("id", vendor.id).first();
  if (data) return;
  await u.db("o_vendorConfig").insert({
    id: vendor.id,
    inputValues: JSON.stringify(vendor.inputValues ?? {}),
    models: JSON.stringify([]),
    enable: vendor.id == "toonflow" ? 1 : 0,
  });
  u.vendor.writeCode(vendor.id, tsCode);
}
