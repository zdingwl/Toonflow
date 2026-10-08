<template>
  <main class="import-projects">
    <template v-if="!projectId">
      <header>
        <div>
          <h1>{{ isImage ? "批量资产项目" : "视频导入项目" }}</h1>
          <p>先新建项目，再进入项目导入{{ isImage ? "资产表格" : "资产图片与 H3 分镜压缩包" }}</p>
        </div>
        <t-button @click="openSettings()">新建项目</t-button>
      </header>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <div class="project-grid">
        <t-card v-for="item in projects" :key="item.id" hover-shadow class="project-card">
          <h2>{{ item.name }}</h2>
          <p>{{ item.intro || (isImage ? "表格导入 · 资产图片生成" : "压缩包导入 · H3 视频工作台") }}</p>
          <div class="tags">
            <t-tag variant="light">{{ item.batchCount }} 次导入</t-tag>
            <t-tag variant="light">{{ isImage ? item.imageQuality : item.videoRatio }}</t-tag>
            <t-tag v-if="item.artStyle" variant="light">{{ item.artStyle }}</t-tag>
          </div>
          <footer>
            <span>{{ new Date(item.createTime).toLocaleString() }}</span>
            <t-button variant="outline" @click="router.push(`${rootPath}/${item.id}`)">进入项目</t-button>
          </footer>
        </t-card>
      </div>
      <t-empty v-if="!loading && !projects.length" description="还没有项目，点击右上角“新建项目”开始" />
    </template>
    <template v-else-if="currentProject">
      <header>
        <div class="title-row">
          <t-button variant="text" @click="router.push(rootPath)">返回项目列表</t-button>
          <div>
            <h1>{{ currentProject.name }}</h1>
            <p>{{ isImage ? "资产图片工作台" : "视频工作台" }} · {{ batches.length }} 次导入</p>
          </div>
        </div>
        <div class="actions">
          <t-button variant="outline" @click="openSettings(currentProject)">项目设置</t-button>
          <t-button variant="outline" :loading="downloading" @click="downloadTemplate">下载模板</t-button>
          <t-button :loading="importing" @click="fileInput?.click()">{{ isImage ? "导入资产表格" : "导入视频压缩包" }}</t-button>
        </div>
      </header>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <details class="guide">
        <summary>导入格式与操作说明</summary>
        <p v-if="isImage">
          Excel/WPS 填写 CSV UTF-8 模板：id、name、type（role / scene /
          tool / creature）、prompt、aspectRatio。creature（生物）在工作台归入“道具”，使用道具与生物生成规则。导入后使用资产页相同的模型、分辨率、四视图规则、参考图和历史图片管理；实际画布按资产生成规则决定。单次最多 500
          行。
        </p>
        <p v-else>
          ZIP 包含 manifest.json 和 assets 图片目录；shots 中填写提示词与绑定资产。assets 数组顺序对应 &lt;Picture 1&gt;、&lt;Picture 2&gt;…；每镜头
          1–9 张图，5–15 秒。完整人物四视图只占一张图。导入后可直接编辑提示词和生成视频，无需再次生成语言版本。
        </p>
        <p>同一项目可多次导入；不同批次的同名编号不会互相覆盖。同一文件重复导入会打开原批次。原有生成结果保留，可在工作台查看和切换历史版本。</p>
      </details>
      <div v-if="batches.length" class="batch-toolbar">
        <label>
          {{ isImage ? "下载批次" : "分镜批次" }}
          <t-select v-model="batchId" :options="batches.map((b) => ({ label: b.name, value: b.id }))" />
        </label>
        <t-button variant="outline" :loading="downloading" @click="downloadResults">下载本批次已完成{{ isImage ? "图片" : "视频" }}</t-button>
        <span>{{ isImage ? "下方显示本项目全部资产" : "单条生成使用当前设置；批量生成保留各分镜导入的时长、声音与画幅" }}</span>
      </div>
      <section v-if="batches.length" class="native-workbench">
        <AssetWorkbench v-if="isImage" :key="`assets-${projectId}-${revision}`" />
        <VideoWorkbench v-else-if="episodesId" :key="`video-${episodesId}-${revision}`" imported />
      </section>
      <t-empty v-else description="项目已创建。下载模板并导入数据，即可进入生成工作台。" />
      <input ref="fileInput" type="file" :accept="isImage ? '.csv' : '.zip'" hidden @change="readFile" />
    </template>
    <template v-else>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <t-button @click="router.push(rootPath)">返回项目列表</t-button>
      <t-loading v-if="loading" text="正在打开项目" />
    </template>
    <t-dialog
      v-model:visible="settingsVisible"
      :header="editing ? '项目设置' : '新建项目'"
      width="600px"
      :confirm-btn="{ content: editing ? '保存设置' : '创建并进入项目', loading: saving }"
      @confirm="saveProject">
      <t-form label-align="top">
        <t-form-item label="项目名称"><t-input v-model="form.name" placeholder="例如：第一集资产 / 第一集视频" :maxlength="200" /></t-form-item>
        <t-form-item label="项目说明"><t-textarea v-model="form.intro" placeholder="可选" /></t-form-item>
        <t-form-item :label="isImage ? '默认图片模型' : '默认视频模型'">
          <t-select v-model="form.model" :options="modelOptions" placeholder="选择已启用的本地 ComfyUI 模型" />
        </t-form-item>
        <t-form-item v-if="isImage" label="图片分辨率">
          <t-select v-model="form.imageQuality" :options="['1K', '2K', '4K'].map((value) => ({ label: value, value }))" />
        </t-form-item>
        <t-form-item v-if="isImage" label="画风">
          <t-input v-model="form.artStyle" placeholder="例如：半写实三维动画；可留空，以提示词为准" />
        </t-form-item>
        <t-form-item v-else label="默认视频画幅">
          <t-radio-group v-model="form.videoRatio">
            <t-radio-button value="16:9">横屏 16:9</t-radio-button>
            <t-radio-button value="9:16">竖屏 9:16</t-radio-button>
          </t-radio-group>
        </t-form-item>
      </t-form>
      <p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p>
    </t-dialog>
    <t-dialog
      v-model:visible="previewVisible"
      header="确认导入到当前项目"
      width="850px"
      :confirm-btn="{ content: '确认导入', loading: importing }"
      @confirm="confirmImport">
      <template v-if="preview">
        <p>
          {{ currentProject?.name }} / {{ preview.name }} · {{ preview.count }} 项{{
            preview.assets.length ? ` · ${preview.assets.length} 张参考图` : ""
          }}
        </p>
        <div class="preview-list">
          <article v-for="item in preview.items" :key="item.id">
            <strong>{{ item.id }} · {{ item.name }}</strong>
            <p>{{ item.prompt }}</p>
            <small v-if="item.assets">Picture 顺序：{{ item.assets.join(" → ") }} · {{ item.duration }} 秒</small>
          </article>
        </div>
      </template>
    </t-dialog>
  </main>
</template>
<script setup lang="ts">
import { ref, computed, provide, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { MessagePlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import AssetWorkbench from "@/views/cornerScape/index.vue";
import VideoWorkbench from "@/views/production/components/workbench/generate/index.vue";
const props = defineProps<{ kind: "image" | "video" }>();
const route = useRoute(),
  router = useRouter(),
  store = projectStore();
const previousProject = store.project;
const isImage = computed(() => props.kind === "image"),
  rootPath = computed(() => (isImage.value ? "/batch-assets" : "/import-videos"));
const projectId = computed(() => Number(route.params.projectId) || 0);
const mountedProjectId = projectId.value;
const projects = ref<any[]>([]),
  currentProject = ref<any>(null),
  batches = ref<any[]>([]),
  batchId = ref("");
const episodesId = computed(() => Number(batches.value.find((b) => b.id === batchId.value)?.scriptId) || 0);
provide("episodesId", episodesId);
const revision = ref(0),
  loading = ref(false),
  importing = ref(false),
  downloading = ref(false),
  saving = ref(false);
const errorMessage = ref(""),
  settingsError = ref(""),
  settingsVisible = ref(false),
  editing = ref(false),
  previewVisible = ref(false),
  preview = ref<any>(null);
const modelOptions = ref<{ label: string; value: string }[]>([]),
  fileInput = ref<HTMLInputElement>();
const form = ref({ name: "", intro: "", model: "", artStyle: "", imageQuality: "1K", videoRatio: "16:9" });
let importPayload: any,
  disposed = false;
const api = (action: string, data: any = {}) =>
  axios.post("/importStudio", { action, kind: props.kind, ...(projectId.value ? { projectId: projectId.value } : {}), ...data });
const report = (e: any) => {
  errorMessage.value = e?.message || "操作失败，请重试";
};
async function loadProject() {
  const { data } = await api("project");
  if (disposed) return;
  currentProject.value = data.project;
  batches.value = data.batches;
  if (!batches.value.some((b) => b.id === batchId.value)) batchId.value = batches.value[0]?.id || "";
  store.project = data.project;
}
function openSettings(project?: any) {
  settingsError.value = "";
  editing.value = !!project;
  form.value = {
    name: project?.name || "",
    intro: project?.intro || "",
    model: (isImage.value ? project?.imageModel : project?.videoModel) || modelOptions.value[0]?.value || "",
    artStyle: project?.artStyle || "",
    imageQuality: project?.imageQuality || "1K",
    videoRatio: project?.videoRatio || "16:9",
  };
  settingsVisible.value = true;
}
async function saveProject() {
  if (saving.value) return;
  if (!form.value.name.trim() || !form.value.model) {
    settingsError.value = "请填写项目名称并选择模型";
    return;
  }
  saving.value = true;
  settingsError.value = "";
  try {
    const { model, ...fields } = form.value;
    const { data } = await api(editing.value ? "updateProject" : "createProject", {
      ...fields,
      imageModel: isImage.value ? model : currentProject.value?.imageModel || "",
      videoModel: !isImage.value ? model : currentProject.value?.videoModel || "",
    });
    settingsVisible.value = false;
    if (editing.value) {
      await loadProject();
      revision.value++;
      MessagePlugin.success("项目设置已保存");
    } else await router.push(`${rootPath.value}/${data.id}`);
  } catch (e: any) {
    settingsError.value = e.message || "项目保存失败";
  } finally {
    saving.value = false;
  }
}
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  importing.value = true;
  errorMessage.value = "";
  try {
    if (!file.name.toLowerCase().endsWith(isImage.value ? ".csv" : ".zip"))
      throw new Error(isImage.value ? "请导入 CSV UTF-8 表格" : "请导入 ZIP 压缩包");
    if (file.size > (isImage.value ? 4 : 45) * 1024 * 1024) throw new Error("文件超过大小限制");
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    importPayload = { name: file.name.replace(/\.(csv|zip)$/i, ""), file: base64 };
    const { data } = await api("preview", importPayload);
    if (data.existing) {
      batchId.value = data.id;
      await loadProject();
      MessagePlugin.info("文件已导入到本项目，已打开原批次");
      importPayload = null;
      return;
    }
    preview.value = data;
    previewVisible.value = true;
  } catch (e) {
    report(e);
  } finally {
    importing.value = false;
  }
}
async function confirmImport() {
  if (importing.value || !importPayload) return;
  importing.value = true;
  try {
    const { data } = await api("import", importPayload);
    batchId.value = data.id;
    previewVisible.value = false;
    importPayload = null;
    await loadProject();
    revision.value++;
    MessagePlugin.success("数据已保存到项目，可在下方工作台生成");
  } catch (e) {
    report(e);
  } finally {
    importing.value = false;
  }
}
async function download(action: string, name: string) {
  downloading.value = true;
  try {
    const blob = (await axios.post(
      "/importStudio",
      { action, kind: props.kind, projectId: projectId.value, batchId: batchId.value },
      { responseType: "blob" },
    )) as unknown as Blob;
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e: any) {
    if (e instanceof Blob) {
      try {
        report(JSON.parse(await e.text()));
      } catch {
        report({ message: "下载失败" });
      }
    } else report(e);
  } finally {
    downloading.value = false;
  }
}
const downloadTemplate = () => download("template", isImage.value ? "资产导入模板.csv" : "H3视频导入模板.zip");
const downloadResults = () => download("download", isImage.value ? "资产图片.zip" : "分镜视频.zip");
onMounted(async () => {
  loading.value = true;
  try {
    const { data } = await api("models");
    modelOptions.value = data;
    if (projectId.value) await loadProject();
    else projects.value = (await api("projects")).data;
  } catch (e) {
    report(e);
  } finally {
    loading.value = false;
  }
});
onUnmounted(() => {
  disposed = true;
  if (Number(store.project?.id) === mountedProjectId) store.project = previousProject;
});
</script>
<style scoped>
.import-projects {
  padding: 28px 0;
  color: var(--td-text-color-primary);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
h1 {
  font-size: 28px;
  margin: 0;
}
h2 {
  font-size: 20px;
  margin: 0 0 12px;
}
p {
  line-height: 1.65;
  margin: 6px 0;
  color: var(--td-text-color-secondary);
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 24px;
}
.project-card {
  min-height: 200px;
}
.tags,
.actions,
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tags {
  margin: 16px 0;
}
footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
}
footer span {
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
.guide {
  background: var(--td-bg-color-secondarycontainer);
  padding: 12px 16px;
  border-radius: 8px;
  margin: 12px 0;
}
.guide summary {
  cursor: pointer;
  color: var(--td-brand-color);
}
.batch-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin: 16px 0;
}
.batch-toolbar label {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 320px;
}
.batch-toolbar span {
  font-size: 13px;
  color: var(--td-text-color-secondary);
}
.native-workbench {
  min-height: 600px;
}
.error {
  color: var(--td-error-color);
  padding: 12px;
  background: var(--td-bg-color-secondarycontainer);
  white-space: pre-wrap;
}
.preview-list {
  max-height: 420px;
  overflow: auto;
}
.preview-list article {
  padding: 12px 0;
  border-bottom: 1px solid var(--td-component-border);
}
.preview-list p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preview-list small {
  color: var(--td-text-color-secondary);
}
</style>
