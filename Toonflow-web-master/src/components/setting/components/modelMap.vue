<template>
  <div class="modelMap">
    <div class="mapping-note">这里只设置视频模型专用规则。事件、资产和音色的通用规则请在提示词管理中修改。</div>
    <t-collapse v-for="(item, index) in modelMap" :key="index" style="margin-top: 5px">
      <t-collapse-panel :header="item.name">
        <t-table row-key="model" :data="item.promptList" :columns="columns">
          <template #type="{ row: subRow }">
            <div class="type">
              <span>{{ subRow.type == "text" ? "文本" : subRow.type == "video" ? "视频" : "图片" }}</span>
            </div>
          </template>
          <template #effective="{ row }">
            <t-tag :theme="row.bindingStatus === 'invalid' ? 'danger' : row.bindingStatus === 'bound' ? 'primary' : 'success'" variant="light">{{ effectiveLabel(row) }}</t-tag>
            <div v-if="row.bindingError" class="mapping-error">{{ row.bindingError }}</div>
          </template>
          <template #operation="{ row }">
            <t-space :size="0">
              <t-button theme="danger" v-if="row?.path" variant="text" @click="promptEditor(item, row)">
                <template #icon>
                  <t-icon name="edit" />
                </template>
                {{ $t("settings.memory.modelMap.editRefeshWord") }}
              </t-button>
              <t-button theme="primary" v-else variant="text" @click="promptEditor(item, row)">
                <template #icon>
                  <t-icon name="edit" />
                </template>
                {{ $t("settings.memory.modelMap.editWord") }}
              </t-button>
            </t-space>
          </template>
        </t-table>
      </t-collapse-panel>
    </t-collapse>

    <!-- 绑定提示词弹窗 -->
    <t-dialog
      v-model:visible="visible"
      :header="$t('workbench.project.dialog.prompt.title')"
      width="70%"
      :close-on-overlay-click="false"
      @confirm="onConfirm"
      placement="center">
      <div class="prompt-select">
        <div class="prompt-select-header">
          <div class="prompt-current">
            <span class="label">当前生效：</span>
            <t-tag :theme="promptForm.bindingStatus === 'invalid' ? 'danger' : 'primary'" variant="light">{{ effectiveLabel(promptForm) }}</t-tag>
            <t-button v-if="promptForm.path" theme="default" variant="text" size="small" @click="unselectPrompt">取消专用绑定</t-button>
          </div>
          <t-button theme="primary" variant="outline" size="small" @click="openAddPrompt">
            <template #icon><t-icon name="add" /></template>
            {{ $t("settings.memory.modelMap.addPrompt") }}
          </t-button>
        </div>
        <div v-if="promptForm.bindingError" class="mapping-error">{{ promptForm.bindingError }}</div>
        <div class="mapping-note">未设置专用绑定时，按实际生成方式自动选择规则。新增模板预填的是该模型默认参考方式的规则，可在此修改。</div>
        <div class="mapping-note">{{ promptForm.path ? `选择的模板：${promptForm.fileName}` : '保存后将使用自动规则。取消专用绑定不会删除模板。' }}</div>
        <t-table row-key="path" :data="promptList" :columns="promptColumns" :hover="true" max-height="50vh" style="margin-top: 12px">
          <template #name="{ row }">
            <div style="display: flex; align-items: center; gap: 6px">
              <span>{{ row.name }}</span>
              <t-tag v-if="promptForm.path === row.path" size="small" theme="success">已选择</t-tag>
              <t-tag v-else-if="!promptForm.path && promptForm.defaultPath === row.path" size="small" theme="default">自动参考规则</t-tag>
            </div>
          </template>
          <template #bindOperation="{ row }">
            <t-space :size="0">
              <t-button v-if="promptForm.path !== row.path" theme="primary" variant="text" @click="selectPrompt(row)">
                {{ $t("settings.memory.modelMap.editWord") }}
              </t-button>
              <t-button v-else theme="danger" variant="text" @click="unselectPrompt">
                {{ $t("settings.memory.modelMap.unbind") }}
              </t-button>
              <t-button theme="primary" variant="text" @click="openEditPrompt(row)">
                {{ $t("settings.memory.modelMap.editPrompt") }}
              </t-button>
              <t-button theme="danger" variant="text" :disabled="!row.deletable" :title="row.builtin ? '内置自动规则不能删除' : !row.deletable ? '请先取消使用此模板的模型绑定' : ''" @click="delPrompt(row)">
                {{ $t("settings.memory.modelMap.delPrompt") }}
              </t-button>
            </t-space>
          </template>
        </t-table>
      </div>
    </t-dialog>

    <!-- 新增/编辑提示词弹窗 -->
    <t-dialog
      v-model:visible="addPromptVisible"
      :header="editingPrompt.isEdit ? $t('settings.memory.modelMap.editPromptTitle') : $t('settings.memory.modelMap.addPromptTitle')"
      width="75%"
      :close-on-overlay-click="false"
      @confirm="onAddPromptConfirm"
      top="5vh">
      <div class="add-prompt-form">
        <div v-if="!editingPrompt.isEdit && addPromptPrefilled" class="mapping-note">已按当前模型预填规则，可在此修改并另起一个名称。</div>
        <t-form label-align="top">
          <t-form-item :label="$t('settings.memory.modelMap.filenName')">
            <t-input
              v-model="editingPrompt.name"
              :disabled="editingPrompt.isEdit"
              :placeholder="$t('settings.memory.modelMap.promptNamePlaceholder')" />
          </t-form-item>
          <t-form-item :label="$t('settings.memory.modelMap.type')">
            <t-select
              v-model="editingPrompt.type"
              :disabled="editingPrompt.isEdit"
              :placeholder="$t('settings.memory.modelMap.promptTypePlaceholder')">
              <!-- <t-option value="text" :label="$t('settings.memory.modelMap.typeText')" />
              <t-option value="image" :label="$t('settings.memory.modelMap.typeImage')" /> -->
              <t-option value="video" :label="$t('settings.memory.modelMap.typeVideo')" />
            </t-select>
          </t-form-item>
          <t-form-item :label="$t('promptManage.prompt')">
            <MdEditor
              :theme="themeSetting.mode === 'auto' ? 'light' : themeSetting.mode"
              v-model="editingPrompt.data"
              :toolbars="promptToolbars"
              :footers="[]"
              style="height: 55vh; width: 100%"
              :placeholder="$t('workbench.project.dialog.prompt.placeholder')"
              @onUploadImg="() => {}" />
          </t-form-item>
        </t-form>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { TableProps } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { MdEditor, MdPreview } from "md-editor-v3";
import type { ToolbarNames } from "md-editor-v3";
import settingStore from "@/stores/setting";
const { themeSetting } = storeToRefs(settingStore());

const promptToolbars: ToolbarNames[] = [
  "bold",
  "italic",
  "strikeThrough",
  "-",
  "unorderedList",
  "orderedList",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];
interface PromptList {
  name: string;
  type: string;
  model: string;
  path: string;
  fileName: string;
  effectivePath?: string;
  effectiveName?: string;
  defaultPath?: string;
  autoModeDependent?: boolean;
  bindingStatus?: "bound" | "default" | "invalid" | "common";
  bindingError?: string;
}
interface ModelMap {
  id: string;
  name: string;
  promptList: PromptList[];
}
const modelMap = ref<ModelMap[]>([]);

interface PromptItem {
  name: string;
  type: string;
  data: string;
  path: string;
  builtin: boolean;
  deletable: boolean;
  preview?: string;
}
const promptList = ref<PromptItem[]>([]);

onMounted(() => {
  queryModelMap();
});

//获取提示词列表
async function getPromptList() {
  const res = await axios.get("/setting/modelMap/getPromptList", { params: { model: promptForm.value.model } });
  promptList.value = res.data.map((row: PromptItem) => ({ ...row, preview: row.data.replace(/<!--\s*toonflow-video-template:\s*[\w.-]+\s*-->/gi, "").trim() }));
}
//查询模型映射提示词
async function queryModelMap() {
  const res = await axios.post("/setting/modelMap/getImageAndVideoModel");
  modelMap.value = res.data;
}
const columns: TableProps["columns"] = [
  {
    colKey: "name",
    title: $t("settings.memory.modelMap.name"),
    width: 150,
    align: "left",
  },
  {
    colKey: "model",
    title: $t("settings.memory.modelMap.model"),
    width: 150,
    align: "left",
  },
  {
    colKey: "type",
    title: $t("settings.memory.modelMap.type"),
    width: 50,
    align: "left",
  },
  {
    colKey: "effective",
    title: "当前生效规则",
    align: "left",
    cell: "effective",
  },
  {
    colKey: "operation",
    title: $t("settings.memory.modelMap.operation"),
    width: 100,
    align: "center",
    fixed: "right",
    cell: "operation",
  },
];
const visible = ref(false);
//编辑提示词
const promptForm = ref<PromptList>({
  name: "",
  type: "",
  model: "",
  path: "",
  fileName: "",
});
//当前选中的供应商
const currentSupplier = ref("");
async function promptEditor(item: ModelMap, value: PromptList) {
  promptForm.value = { ...value };
  currentSupplier.value = item.id;
  try {
    await getPromptList();
    visible.value = true;
  } catch (cause) {
    window.$message.error((cause as Error).message || "读取视频模板失败");
  }
}

function effectiveLabel(row: PromptList) {
  if (row.bindingStatus === "invalid") return "绑定无效，请重新选择";
  if (row.bindingStatus === "bound") return row.effectiveName || row.fileName;
  if (row.autoModeDependent) return "自动按生成方式选择";
  return `自动：${row.effectiveName || '通用视频规则'}`;
}

//提示词列表表格列
const promptColumns: TableProps["columns"] = [
  {
    colKey: "name",
    title: $t("settings.memory.modelMap.filenName"),
    width: 150,
    align: "left",
    cell: "name",
  },
  {
    colKey: "type",
    title: $t("settings.memory.modelMap.type"),
    width: 80,
    align: "left",
  },
  {
    colKey: "preview",
    title: $t("promptManage.prompt"),
    align: "left",
    ellipsis: true,
  },
  {
    colKey: "bindOperation",
    title: $t("settings.memory.modelMap.operation"),
    width: 200,
    align: "center",
    fixed: "right",
    cell: "bindOperation",
  },
];

//选择提示词绑定
function selectPrompt(row: PromptItem) {
  promptForm.value.fileName = row.name;
  promptForm.value.path = row.path;
}

//取消绑定
function unselectPrompt() {
  promptForm.value.fileName = "";
  promptForm.value.path = "";
}

// 新增/编辑提示词弹窗
const addPromptVisible = ref(false);
const addPromptPrefilled = ref(false);
const editingPrompt = ref({ isEdit: false, name: "", type: "video", data: "" });

function openAddPrompt() {
  const source = promptList.value.find(row => row.path === promptForm.value.path)
    || promptList.value.find(row => row.path === promptForm.value.effectivePath)
    || promptList.value.find(row => row.path === promptForm.value.defaultPath);
  editingPrompt.value = { isEdit: false, name: "", type: "video", data: source?.data || "" };
  addPromptPrefilled.value = Boolean(source);
  addPromptVisible.value = true;
}

function openEditPrompt(row: PromptItem) {
  editingPrompt.value = { isEdit: true, ...row };
  addPromptVisible.value = true;
}
async function delPrompt(row: PromptItem) {
  try {
    await axios.post("/setting/modelMap/deletePrompt", { path: row.path });
    if (promptForm.value.path === row.path) unselectPrompt();
    await getPromptList();
    await queryModelMap();
    window.$message.success("模板已删除");
  } catch (cause) {
    window.$message.error((cause as Error).message || "删除模板失败");
  }
}
async function onAddPromptConfirm() {
  if (!editingPrompt.value.name.trim()) {
    window.$message.warning($t("settings.memory.modelMap.promptNameRequired"));
    return;
  }
  try {
    await axios.post(editingPrompt.value.isEdit ? "/setting/modelMap/updatePrompt" : "/setting/modelMap/savePrompt", {
      name: editingPrompt.value.name,
      type: editingPrompt.value.type,
      data: editingPrompt.value.data,
    });
    window.$message.success($t("settings.memory.modelMap.promptSaveSuccess"));
    addPromptVisible.value = false;
    await getPromptList();
    await queryModelMap();
  } catch (cause) {
    window.$message.error((cause as Error).message || "保存模板失败");
  }
}

//更新提示词
async function onConfirm() {
  const data = {
    vendorId: currentSupplier.value,
    model: promptForm.value.model,
    path: promptForm.value.path,
    fileName: promptForm.value.fileName,
  };
  try {
    await axios.post("/setting/modelMap/bindingPrompt", data);
    window.$message.success(promptForm.value.path ? $t("settings.memory.modelMap.bindingSuccessful") : "已恢复自动规则");
    visible.value = false;
    await queryModelMap();
  } catch (cause) {
    window.$message.error((cause as Error).message || "保存绑定失败");
  }
}
</script>

<style lang="scss" scoped>
.modelMap {
  .mapping-note { color: var(--td-text-color-secondary); margin: 8px 0; }
  .mapping-error { color: var(--td-error-color); margin-top: 4px; }
  .prompt-select {
    .prompt-select-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .prompt-current {
      display: flex;
      align-items: center;
      gap: 8px;
      .label {
        font-size: 14px;
        color: var(--td-text-color-secondary);
      }
    }
    .prompt-preview {
      font-size: 13px;
      max-height: 80px;
      overflow: hidden;
      :deep(.md-editor-preview-wrapper) {
        padding: 0;
      }
      :deep(p) {
        margin: 0;
      }
    }
  }
  .add-prompt-form {
    .t-form__item {
      margin-bottom: 16px;
    }
  }
}
</style>
