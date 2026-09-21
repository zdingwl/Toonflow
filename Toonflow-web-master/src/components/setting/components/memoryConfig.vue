<template>
  <div class="memoryConfig">
    <t-alert theme="warning" class="topAlert" :message="$t('settings.memory.warning')" />

    <t-form :data="formData" labelAlign="top" labelWidth="180px" class="memoryForm" @submit="handleSave">
      <t-card :title="$t('settings.memory.vectorModelConfig')" :bordered="true" style="margin-top: 16px">
        <t-form-item label="Embedding 后端" name="embeddingBackend">
          <t-select v-model="formData.embeddingBackend">
            <t-option value="onnx" label="ONNX（兼容现有本地模型）" />
            <t-option value="ollama" label="Ollama（推荐 Qwen3 Embedding）" />
          </t-select>
          <template #help>切换后会释放当前 Embedding 实例；旧向量按模型版本隔离，不会与新向量混用。</template>
        </t-form-item>

        <template v-if="formData.embeddingBackend === 'onnx'">
          <t-form-item :label="$t('settings.memory.modelFilePath')" name="modelOnnxFile">
            <t-tag-input v-model="formData.modelOnnxFile" clearable />
            <template #help>向量模型文件路径：/data/models/{{ formData.modelOnnxFile ? formData.modelOnnxFile.join("/") : "" }}</template>
          </t-form-item>
          <t-form-item :label="$t('settings.memory.quantizationType')" name="modelDtype">
            <t-select v-model="formData.modelDtype" :placeholder="$t('settings.memory.quantizationPlaceholder')">
              <t-option v-for="item in dtypeOptions" :key="item" :value="item" :label="item" />
            </t-select>
          </t-form-item>
        </template>

        <t-form-item v-else label="Ollama Embedding 模型" name="ollamaEmbeddingModel">
          <t-input v-model="formData.ollamaEmbeddingModel" placeholder="qwen3-embedding:4b" />
          <template #help>仅连接本机 127.0.0.1:11434。你的 5090D 环境建议使用 qwen3-embedding:4b。</template>
        </t-form-item>
      </t-card>

      <t-card title="高级检索配置" :bordered="true" style="margin-top: 16px">
        <t-form-item label="混合检索" name="memoryHybridRetrieval">
          <t-switch v-model="formData.memoryHybridRetrieval" />
          <template #help>同时使用关键词召回和向量召回，提高中文项目名、角色名和精确术语的命中率。</template>
        </t-form-item>
        <t-form-item label="记忆上下文 Token 预算" name="memoryContextTokenBudget">
          <t-input-number v-model="formData.memoryContextTokenBudget" :min="400" :max="32768" :step="100" :allowInputOverLimit="false" />
        </t-form-item>
        <t-form-item label="向量分页扫描大小" name="memoryVectorScanPageSize">
          <t-input-number v-model="formData.memoryVectorScanPageSize" :min="64" :max="2000" :step="64" :allowInputOverLimit="false" />
          <template #help>只影响 SQLite 向量扫描的单页内存占用；默认 256。</template>
        </t-form-item>
        <t-form-item label="启用本地 Reranker" name="memoryRerankerEnabled">
          <t-switch v-model="formData.memoryRerankerEnabled" />
        </t-form-item>
        <template v-if="formData.memoryRerankerEnabled">
          <t-form-item label="Reranker 地址" name="memoryRerankerUrl">
            <t-input v-model="formData.memoryRerankerUrl" placeholder="http://127.0.0.1:11435/rerank" />
          </t-form-item>
          <t-form-item label="Reranker 模型" name="memoryRerankerModel">
            <t-input v-model="formData.memoryRerankerModel" placeholder="Qwen3-Reranker-4B" />
          </t-form-item>
          <t-form-item label="Reranker 候选数" name="memoryRerankerCandidates">
            <t-input-number v-model="formData.memoryRerankerCandidates" :min="8" :max="100" :step="4" :allowInputOverLimit="false" />
            <template #help>推荐 24；先混合召回候选，再由本地 Reranker 精排。</template>
          </t-form-item>
        </template>
      </t-card>
      <t-card :title="$t('settings.memory.memoryParams')" :bordered="true" style="margin-top: 16px">
        <t-form-item :label="$t('settings.memory.messagesPerSummary')" name="messagesPerSummary">
          <t-input-number v-model="formData.messagesPerSummary" :min="1" :max="200" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.messagesPerSummaryHelp") }}</template>
        </t-form-item>
        <t-form-item :label="$t('settings.memory.shortTermLimit')" name="shortTermLimit">
          <t-input-number v-model="formData.shortTermLimit" :min="1" :max="100" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.shortTermLimitHelp") }}</template>
        </t-form-item>
        <t-form-item :label="$t('settings.memory.summaryMaxLength')" name="summaryMaxLength">
          <t-input-number v-model="formData.summaryMaxLength" :min="0" :max="1000" :step="1" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.summaryMaxLengthHelp") }}</template>
        </t-form-item>
        <t-form-item :label="$t('settings.memory.summaryLimit')" name="summaryLimit">
          <t-input-number v-model="formData.summaryLimit" :min="0" :max="100" :step="1" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.summaryLimitHelp") }}</template>
        </t-form-item>
        <t-form-item :label="$t('settings.memory.ragLimit')" name="ragLimit">
          <t-input-number v-model="formData.ragLimit" :min="0" :max="50" :step="1" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.ragLimitHelp") }}</template>
        </t-form-item>
        <t-form-item :label="$t('settings.memory.deepRetrieveSummaryLimit')" name="deepRetrieveSummaryLimit">
          <t-input-number v-model="formData.deepRetrieveSummaryLimit" :min="0" :max="100" :step="1" :allowInputOverLimit="false" />
          <template #help>{{ $t("settings.memory.deepRetrieveSummaryLimitHelp") }}</template>
        </t-form-item>
      </t-card>

      <div class="actionRow f frr">
        <t-button theme="primary" type="submit" :loading="saving">{{ $t("settings.memory.saveConfig") }}</t-button>
        <t-button theme="danger" variant="outline" :loading="clearing" @click="handleClearMemory">{{ $t("settings.memory.clearMemory") }}</t-button>
        <t-button theme="warning" variant="outline" :loading="saving" @click="handleRestory">{{ $t("settings.memory.restoreDefault") }}</t-button>
      </div>
    </t-form>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";

interface MemoryConfigForm {
  messagesPerSummary: number;
  shortTermLimit: number;
  summaryMaxLength: number;
  summaryLimit: number;
  ragLimit: number;
  deepRetrieveSummaryLimit: number;
  modelOnnxFile: string[];
  modelDtype: string;
  embeddingBackend: "onnx" | "ollama";
  ollamaEmbeddingModel: string;
  memoryHybridRetrieval: boolean;
  memoryRerankerEnabled: boolean;
  memoryRerankerUrl: string;
  memoryRerankerModel: string;
  memoryRerankerCandidates: number;
  memoryContextTokenBudget: number;
  memoryVectorScanPageSize: number;
}

const formData = ref<MemoryConfigForm>({
  messagesPerSummary: 3,
  shortTermLimit: 5,
  summaryMaxLength: 500,
  summaryLimit: 10,
  ragLimit: 3,
  deepRetrieveSummaryLimit: 5,
  modelOnnxFile: ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"], // 模型文件路径
  modelDtype: "fp16",
  embeddingBackend: "onnx",
  ollamaEmbeddingModel: "qwen3-embedding:4b",
  memoryHybridRetrieval: true,
  memoryRerankerEnabled: false,
  memoryRerankerUrl: "http://127.0.0.1:11435/rerank",
  memoryRerankerModel: "Qwen3-Reranker-4B",
  memoryRerankerCandidates: 24,
  memoryContextTokenBudget: 2400,
  memoryVectorScanPageSize: 256,
});

const dtypeOptions = ["fp16", "auto", "fp32", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"];

const loading = ref(false);
const saving = ref(false);
const clearing = ref(false);

async function getMemoryConfig() {
  loading.value = true;
  try {
    const { data } = await axios.get("/setting/memoryConfig/getMemory");
    formData.value = {
      messagesPerSummary: data.messagesPerSummary ?? 3,
      shortTermLimit: data.shortTermLimit ?? 5,
      summaryMaxLength: data.summaryMaxLength ?? 500,
      summaryLimit: data.summaryLimit ?? 10,
      ragLimit: data.ragLimit ?? 3,
      deepRetrieveSummaryLimit: data.deepRetrieveSummaryLimit ?? 5,
      modelOnnxFile: data.modelOnnxFile ?? ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"], // 模型文件路径
      modelDtype: data.modelDtype ?? "fp16",
      embeddingBackend: data.embeddingBackend === "ollama" ? "ollama" : "onnx",
      ollamaEmbeddingModel: data.ollamaEmbeddingModel ?? "qwen3-embedding:4b",
      memoryHybridRetrieval: data.memoryHybridRetrieval ?? true,
      memoryRerankerEnabled: data.memoryRerankerEnabled ?? false,
      memoryRerankerUrl: data.memoryRerankerUrl ?? "http://127.0.0.1:11435/rerank",
      memoryRerankerModel: data.memoryRerankerModel ?? "Qwen3-Reranker-4B",
      memoryRerankerCandidates: data.memoryRerankerCandidates ?? 24,
      memoryContextTokenBudget: data.memoryContextTokenBudget ?? 2400,
      memoryVectorScanPageSize: data.memoryVectorScanPageSize ?? 256,
    };
  } catch (error: any) {
    window.$message.warning(error?.message);
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  saving.value = true;
  try {
    await axios.post("/setting/memoryConfig/sureMemory", {
      ...formData.value,
    });

    window.$message.success($t("settings.memory.msg.saved"));
  } catch (error: any) {
    window.$message.warning(error?.message);
  } finally {
    saving.value = false;
  }
}

async function handleClearMemory() {
  const dialog = DialogPlugin.confirm({
    header: $t("settings.memory.msg.clearConfirmTitle"),
    body: $t("settings.memory.msg.clearConfirmBody"),
    confirmBtn: $t("settings.memory.msg.confirmClear"),
    cancelBtn: $t("settings.memory.msg.cancel"),
    onConfirm: async () => {
      clearing.value = true;
      try {
        await axios.post("/setting/memoryConfig/delAllMemory");
        window.$message.success($t("settings.memory.msg.cleared"));
        dialog.hide();
      } catch (error: any) {
        window.$message.error(error?.msg || $t("settings.memory.msg.clearFailed"));
      } finally {
        clearing.value = false;
      }
    },
  });
}

function handleRestory() {
  formData.value = {
    messagesPerSummary: 3,
    shortTermLimit: 5,
    summaryMaxLength: 500,
    summaryLimit: 10,
    ragLimit: 3,
    deepRetrieveSummaryLimit: 5,
    modelOnnxFile: ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"], // 模型文件路径
    modelDtype: "fp16",
    embeddingBackend: "onnx",
    ollamaEmbeddingModel: "qwen3-embedding:4b",
    memoryHybridRetrieval: true,
    memoryRerankerEnabled: false,
    memoryRerankerUrl: "http://127.0.0.1:11435/rerank",
    memoryRerankerModel: "Qwen3-Reranker-4B",
    memoryRerankerCandidates: 24,
    memoryContextTokenBudget: 2400,
    memoryVectorScanPageSize: 256,
  };
  handleSave();
}

onMounted(() => {
  getMemoryConfig();
});
</script>

<style lang="scss" scoped>
.memoryConfig {
  .topAlert {
    margin-bottom: 16px;
  }

  .memoryForm {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .formCard {
    :deep(.t-card__header) {
      padding-bottom: 8px;
    }
  }

  .actionRow {
    & > * {
      margin-left: 16px;
    }
  }
}
</style>
