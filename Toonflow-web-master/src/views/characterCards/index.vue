<template>
  <main class="character-cards">
    <header class="page-header">
      <div>
        <h1>角色卡库</h1>
        <p>按画风、人物定义和年龄寻找角色。合适的卡可以复用，部分合适的卡可以作为新角色的参考。</p>
      </div>
      <div class="actions">
        <t-button variant="outline" :disabled="!visibleMissingImages.length" @click="openBatchImageDialog">补全缺图角色卡</t-button>
        <t-button variant="outline" @click="openImport">从项目人物加入</t-button>
        <t-button @click="openEditor()">新建角色卡</t-button>
      </div>
    </header>

    <t-alert theme="info" message="提取人物时会先寻找角色卡；没有完整匹配时，参考已有卡重新生成。新卡校验通过后加入卡库，剧本事实和你的要求优先。" />
    <form class="filters" @submit.prevent="loadCards">
      <label>画风<t-select v-model="filters.artStyle" :options="styleOptions" clearable filterable placeholder="全部画风" /></label>
      <label>人物定义<t-input v-model="filters.roleDefinition" clearable placeholder="身份、定位或气质" /></label>
      <label>年龄段<t-select v-model="filters.ageBand" :options="ageOptions" clearable placeholder="全部年龄段" /></label>
      <label>搜索<t-input v-model="filters.keyword" clearable placeholder="名称或外观关键词" /></label>
      <div class="filter-actions">
        <t-button type="submit" :loading="loading">查找</t-button>
        <t-button variant="text" @click="resetFilters">重置</t-button>
      </div>
      <t-checkbox v-model="filters.includeArchived">显示已停用的卡</t-checkbox>
    </form>

    <p v-if="pageError" class="error" role="alert">{{ pageError }}</p>
    <div class="list-summary" aria-live="polite">
      <p class="list-count">{{ loading ? "正在查找角色卡…" : `共 ${cards.length} 张角色卡` }}</p>
      <div class="tags">
        <t-tag variant="light">有图 {{ imageCounts.ready }}</t-tag>
        <t-tag variant="light" theme="primary">排队 / 生成 {{ imageCounts.running }}</t-tag>
        <t-tag variant="light" theme="danger">失败 {{ imageCounts.failed }}</t-tag>
        <t-tag variant="light" theme="warning">可补全缺图 {{ visibleMissingImages.length }}</t-tag>
      </div>
    </div>
    <section class="card-grid" aria-label="角色卡列表">
      <article v-for="card in cards" :key="card.id" class="character-card" :class="{ archived: card.status === 'archived' }">
        <div class="card-image-box">
          <t-image-viewer v-if="cardImage(card)" :images="[cardImage(card, true)]" :close-on-esc-keydown="true" :close-on-overlay="true">
            <template #trigger="{ open }">
              <button type="button" class="image-button" :aria-label="`放大查看${card.name}的完整角色图`" @click="open()">
                <t-image class="card-image" :src="cardImage(card)" fit="contain" :lazy="true">
                  <template #error><div class="image-placeholder">图片加载失败，可在详情中重新生成</div></template>
                </t-image>
              </button>
            </template>
          </t-image-viewer>
          <div v-else class="image-placeholder">
            <t-icon name="image" size="36px" />
            <span>{{ imageRunning(card) ? imageStatusLabel(card) : '还没有角色图片' }}</span>
            <small>完整角色图和四视图在此显示</small>
          </div>
          <div v-if="imageRunning(card)" class="image-state" role="status"><t-loading size="16px" /> {{ imageStatusLabel(card) }}</div>
          <t-tag v-else-if="card.imageGeneration?.state === 'failed'" class="image-state" theme="danger" variant="light">图片生成失败</t-tag>
          <t-tag v-else-if="card.imageNeedsRegeneration || card.imageState === 'stale'" class="image-state" theme="warning" variant="light">描述已更新，请重新生成图片</t-tag>
        </div>
        <div class="card-heading">
          <h2>{{ card.name }}</h2>
          <t-tag v-if="card.status === 'archived'" theme="warning" variant="light">已停用</t-tag>
          <t-tag v-else-if="card.ownerId === 0" variant="light">预置卡</t-tag>
          <t-tag v-else theme="primary" variant="light">我的角色卡</t-tag>
        </div>
        <div class="tags">
          <t-tag variant="outline">{{ styleName(card.artStyle) }}</t-tag>
          <t-tag variant="outline">{{ ageLabel(card) }}</t-tag>
          <t-tag v-if="card.gender" variant="outline">{{ genderName(card.gender) }}</t-tag>
        </div>
        <p class="role-definition">{{ card.roleDefinition }}</p>
        <p class="card-description">{{ card.describe }}</p>
        <p v-if="card.imageGeneration?.model" class="image-model">图片模型：{{ card.imageGeneration.model }}</p>
        <p v-if="card.imageGeneration?.state === 'failed'" class="image-error">{{ card.imageGeneration.errorReason || card.imageErrorReason || '图片生成失败，请重试' }}</p>
        <div class="card-footer">
          <span>第 {{ card.version }} 版</span>
          <div class="actions">
            <t-button size="small" variant="text" @click="showDetails(card)">查看</t-button>
            <t-button v-if="canReviewImage(card)" size="small" variant="outline" :loading="reviewSubmitting.has(card.id)" @click="reviewExistingImage(card)">复核已有图片</t-button>
            <t-button v-if="card.status === 'active'" size="small" variant="outline" :disabled="imageRunning(card) || reviewSubmitting.has(card.id)" @click="openImageDialog(card)">{{ cardImage(card) ? '重新生成图' : '生成图片' }}</t-button>
            <t-button size="small" variant="outline" @click="openEditor(card, card.ownerId === 0 || card.status === 'archived')">
              {{ card.ownerId === 0 || card.status === "archived" ? "复制为新卡" : "编辑" }}
            </t-button>
          </div>
        </div>
      </article>
    </section>
    <t-empty v-if="!loading && !cards.length && !pageError" description="没有找到合适的角色卡。可以调整条件、新建角色卡，或把已有项目人物加入卡库。" />

    <t-drawer v-model:visible="detailVisible" :header="detail?.name || '角色卡详情'" size="560px" :footer="false">
      <template v-if="detail">
        <div class="detail-image-box">
          <t-image-viewer v-if="cardImage(detail)" :images="[cardImage(detail, true)]" :close-on-esc-keydown="true" :close-on-overlay="true">
            <template #trigger="{ open }">
              <button type="button" class="image-button" aria-label="放大查看完整角色图" @click="open()">
                <t-image class="card-image" :src="cardImage(detail, true)" fit="contain">
                  <template #error><div class="image-placeholder">图片加载失败</div></template>
                </t-image>
              </button>
            </template>
          </t-image-viewer>
          <div v-else class="image-placeholder"><t-icon name="image" size="42px" /><span>{{ imageRunning(detail) ? imageStatusLabel(detail) : '还没有角色图片' }}</span></div>
        </div>
        <p v-if="cardImage(detail)" class="hint image-hint">点击图片放大查看。完整四视图保存在一张图中。</p>
        <t-alert v-if="imageRunning(detail)" theme="info" :message="`${imageStatusLabel(detail)}，结果会自动更新。${reviewingImages.has(detail.id) ? '复核不会再次绘图。' : ''}`" />
        <t-alert v-else-if="detail.imageGeneration?.state === 'failed'" theme="error" :message="detail.imageGeneration.errorReason || detail.imageErrorReason || '图片生成失败，请重试'" />
        <t-alert v-else-if="detail.imageNeedsRegeneration || detail.imageState === 'stale'" theme="warning" message="外观描述已更新，当前图片对应旧描述，请重新生成图片。" />
        <section v-if="detail.imageGeneration?.state === 'failed' && candidateImage(detail)" class="candidate-image-section">
          <h3>未采用的候选图片</h3>
          <div class="detail-image-box">
            <t-image-viewer :images="[candidateImage(detail, true)]" :close-on-esc-keydown="true" :close-on-overlay="true">
              <template #trigger="{ open }">
                <button type="button" class="image-button" aria-label="放大查看未采用的候选图片" @click="open()">
                  <t-image class="card-image" :src="candidateImage(detail, true)" fit="contain">
                    <template #error><div class="image-placeholder">候选图片加载失败</div></template>
                  </t-image>
                </button>
              </template>
            </t-image-viewer>
          </div>
          <p class="hint">这张图片已经保存。可以先查看并复核；复核已有图片不会再次绘图。</p>
        </section>
        <div v-if="detail.status === 'active'" class="detail-image-actions">
          <t-button v-if="canReviewImage(detail)" variant="outline" :loading="reviewSubmitting.has(detail.id)" @click="reviewExistingImage(detail)">复核已有图片</t-button>
          <t-button :disabled="imageRunning(detail) || reviewSubmitting.has(detail.id)" @click="openImageDialog(detail)">{{ cardImage(detail) ? '重新生成角色图片' : '生成角色图片' }}</t-button>
        </div>
        <p v-if="detail.imageGeneration?.model" class="hint">实际图片模型：{{ detail.imageGeneration.model }}{{ detail.imageGeneration.resolution ? ` · ${detail.imageGeneration.resolution}` : '' }}</p>
        <div class="tags">
          <t-tag>{{ styleName(detail.artStyle) }}</t-tag>
          <t-tag>{{ ageLabel(detail) }}</t-tag>
          <t-tag v-if="detail.gender">{{ genderName(detail.gender) }}</t-tag>
        </div>
        <dl class="card-details">
          <dt>人物定义</dt><dd>{{ detail.roleDefinition }}</dd>
          <dt>完整外观</dt><dd>{{ detail.describe }}</dd>
          <template v-for="field in visualFields" :key="field.key">
            <template v-if="detail.visualDesign[field.key]">
              <dt>{{ field.label }}</dt><dd>{{ detail.visualDesign[field.key] }}</dd>
            </template>
          </template>
          <dt>来源</dt><dd>{{ sourceLabel(detail) }}</dd>
          <template v-if="detail.provenance.references.length">
            <dt>参考记录</dt>
            <dd v-for="reference in detail.provenance.references" :key="`${reference.cardId}-${reference.version}`">
              角色卡 {{ reference.cardId }} · 第 {{ reference.version }} 版
              <span v-if="reference.borrowedFields.length"> · {{ reference.borrowedFields.map(visualFieldName).join('、') }}</span>
            </dd>
          </template>
        </dl>
        <p class="hint">角色卡只提供外观参考。项目人物的姓名、关系和剧本依据独立保存，修改卡库不会自动改变已经采用的角色。</p>
        <div class="actions">
          <t-button @click="openEditor(detail, detail.ownerId === 0 || detail.status === 'archived')">
            {{ detail.ownerId === 0 || detail.status === "archived" ? "复制为新卡" : "编辑角色卡" }}
          </t-button>
          <t-button v-if="detail.ownerId !== 0 && detail.status === 'active'" theme="default" variant="outline" :loading="archiving" @click="archiveCard(detail)">停用此卡</t-button>
        </div>
        <p v-if="detailError" class="error" role="alert">{{ detailError }}</p>
      </template>
    </t-drawer>

    <t-dialog v-model:visible="editorVisible" :header="form.id ? '编辑角色卡' : '新建角色卡'" width="760px" :close-on-overlay-click="false" :confirm-btn="{ content: '保存角色卡', loading: saving }" @confirm="saveCard">
      <t-form label-align="top" class="editor-form">
        <div v-if="editorCard && cardImage(editorCard)" class="editor-image-box"><t-image :src="cardImage(editorCard)" fit="contain" /></div>
        <p v-if="editorCard && cardImage(editorCard)" class="hint">现有角色图片会保留。保存新的外观后，按需重新生成图片。</p>
        <div class="form-grid">
          <t-form-item label="角色卡名称"><t-input v-model="form.name" placeholder="方便查找的外观名称" :maxlength="100" /></t-form-item>
          <t-form-item label="画风"><t-select v-model="form.artStyle" :options="styleOptions" filterable placeholder="选择画风" /></t-form-item>
        </div>
        <t-form-item label="人物定义"><t-textarea v-model="form.roleDefinition" placeholder="身份、人物定位、气质和造型要求" :maxlength="600" :autosize="{ minRows: 2, maxRows: 4 }" /></t-form-item>
        <div class="form-grid age-grid">
          <t-form-item label="年龄段"><t-select v-model="form.ageBand" :options="ageOptions" /></t-form-item>
          <t-form-item label="最小年龄"><t-input-number v-model="form.ageMin" :min="0" :max="120" :disabled="form.ageBand === 'unknown'" placeholder="可留空" /></t-form-item>
          <t-form-item label="最大年龄"><t-input-number v-model="form.ageMax" :min="0" :max="120" :disabled="form.ageBand === 'unknown'" placeholder="可留空" /></t-form-item>
          <t-form-item label="性别"><t-input v-model="form.gender" :maxlength="40" placeholder="未知可留空" /></t-form-item>
        </div>
        <p class="hint">年龄没有依据时选择“未知”；参考卡的年龄不会成为剧本事实。</p>
        <t-form-item label="完整外观"><t-textarea v-model="form.describe" placeholder="脸型五官、体态、发型、默认衣装和识别特征" :maxlength="6000" :autosize="{ minRows: 3, maxRows: 7 }" /></t-form-item>
        <details class="visual-editor" open>
          <summary>外观细节</summary>
          <div class="form-grid">
            <t-form-item v-for="field in visualFields" :key="field.key" :label="field.label">
              <t-textarea v-model="form.visualDesign[field.key]" :placeholder="['face', 'body', 'hair', 'clothing'].includes(field.key) ? '必填：描述具体可见的外观' : '不适用可留空'" :maxlength="1600" :autosize="{ minRows: 2, maxRows: 5 }" />
            </t-form-item>
          </div>
        </details>
      </t-form>
      <p v-if="editorError" class="error" role="alert">{{ editorError }}</p>
      <t-button variant="text" :loading="saving" @click="saveCard(true)">保存后生成角色图片</t-button>
    </t-dialog>

    <t-dialog v-model:visible="imageDialogVisible" :header="imageBatchMode ? '补全当前缺图角色卡' : `${imageTarget?.name || '角色卡'} · 生成角色图片`" width="600px" :close-on-overlay-click="false" :confirm-btn="{ content: imageBatchMode ? `开始补全（${imageBatchTargets.length} 张）` : '开始生成', loading: imageSubmitting, disabled: !imageModel || (imageBatchMode ? !imageBatchTargets.length : !imageTarget || imageRunning(imageTarget)) }" @confirm="generateCardImage">
      <t-form label-align="top">
        <t-form-item label="图片模型"><model-select v-model="imageModel" type="image" /></t-form-item>
        <t-form-item label="分辨率"><t-select v-model="imageResolution" :options="resolutionOptions" /></t-form-item>
      </t-form>
      <p v-if="imageBatchMode" class="hint">本次只为当前列表中 {{ imageBatchTargets.length }} 张缺图角色卡补图，已有图片和正在生成的角色卡会跳过。角色图片逐张生成，进度自动更新。</p>
      <p class="hint">根据这张角色卡的画风和完整外观生成角色图片。完成后自动显示；重新生成时仍可查看已有图片。</p>
      <p class="hint">人物图片使用完整四视图工作流，预览与参考共用同一张图。生成状态中会显示实际运行的图片模型。</p>
      <p v-if="imageBatchProgress" class="hint" role="status">{{ imageBatchProgress }}</p>
      <p v-if="imageDialogError" class="error" role="alert">{{ imageDialogError }}</p>
    </t-dialog>

    <t-dialog v-model:visible="importVisible" header="把项目人物加入角色卡库" width="600px" :close-on-overlay-click="false" :confirm-btn="{ content: '加入并编辑角色卡', loading: importing, disabled: !importAssetId }" @confirm="importAsset">
      <t-form label-align="top">
        <t-form-item label="选择项目"><t-select v-model="importProjectId" :options="projectOptions" filterable placeholder="选择项目" @change="loadProjectRoles" /></t-form-item>
        <t-form-item label="选择人物"><t-select v-model="importAssetId" :options="projectRoleOptions" :loading="rolesLoading" filterable placeholder="选择已有项目人物" /></t-form-item>
        <t-form-item label="人物定义"><t-textarea v-model="importForm.roleDefinition" :maxlength="600" placeholder="用于复用的身份、人物定位和气质，不填写当前剧情关系" :autosize="{ minRows: 2, maxRows: 4 }" /></t-form-item>
        <div class="form-grid age-grid">
          <t-form-item label="年龄段"><t-select v-model="importForm.ageBand" :options="ageOptions" /></t-form-item>
          <t-form-item label="最小年龄"><t-input-number v-model="importForm.ageMin" :min="0" :max="120" :disabled="importForm.ageBand === 'unknown'" placeholder="可留空" /></t-form-item>
          <t-form-item label="最大年龄"><t-input-number v-model="importForm.ageMax" :min="0" :max="120" :disabled="importForm.ageBand === 'unknown'" placeholder="可留空" /></t-form-item>
          <t-form-item label="性别"><t-input v-model="importForm.gender" :maxlength="40" placeholder="未知可留空" /></t-form-item>
        </div>
      </t-form>
      <p v-if="!rolesLoading && importProjectId && !projectRoles.length" class="hint">这个项目还没有人物资产。</p>
      <p class="hint">需要人物已有完整的面部、体态、发型和衣装设计；尚未完成时，请先在剧本页提取。只复制外观，不复制剧情关系。年龄按已有依据选择，未知时保持未知。原项目的描述、图片和历史记录保留。</p>
      <p v-if="importError" class="error" role="alert">{{ importError }}</p>
    </t-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import ModelSelect from "@/components/modelSelect.vue";

type AgeBand = "unknown" | "child" | "teen" | "adult" | "middle" | "elderly";
type VisualKey = "face" | "body" | "hair" | "clothing" | "environment" | "shape";
type VisualDesign = Record<VisualKey, string>;
interface CharacterCard {
  id: number;
  ownerId: number;
  name: string;
  artStyle: string;
  roleDefinition: string;
  ageBand: AgeBand;
  ageMin: number | null;
  ageMax: number | null;
  gender: string;
  describe: string;
  visualDesign: VisualDesign;
  version: number;
  status: "active" | "archived";
  provenance: { method: string; references: { cardId: number; version: number; borrowedFields: string[] }[] };
  imagePath?: string | null;
  imageId?: number | null;
  imageState?: "missing" | "ready" | "stale";
  imageUrl?: string | null;
  imageFullUrl?: string | null;
  imageErrorReason?: string | null;
  imageNeedsRegeneration?: boolean;
  candidateImageUrl?: string | null;
  candidateFullUrl?: string | null;
  imageGeneration?: { id: number; state: "queued" | "running" | "failed" | "completed"; phase?: "queued" | "running"; model?: string; resolution?: string; errorReason?: string | null; baseVersion: number; resultVersion?: number | null; adopted?: boolean; canReview?: boolean; candidateImageUrl?: string | null; candidateFullUrl?: string | null } | null;
}
interface CardForm {
  id?: number;
  version?: number;
  name: string;
  artStyle: string;
  roleDefinition: string;
  ageBand: AgeBand;
  ageMin?: number;
  ageMax?: number;
  gender: string;
  describe: string;
  visualDesign: VisualDesign;
}
const store = projectStore();
const ageOptions: { label: string; value: AgeBand }[] = [
  { label: "未知", value: "unknown" }, { label: "儿童", value: "child" }, { label: "少年", value: "teen" },
  { label: "成年", value: "adult" }, { label: "中年", value: "middle" }, { label: "老年", value: "elderly" },
];
const visualFields: { key: VisualKey; label: string }[] = [
  { key: "face", label: "脸型与五官" }, { key: "body", label: "体态" }, { key: "hair", label: "发型" },
  { key: "clothing", label: "默认衣装" }, { key: "shape", label: "轮廓与识别特征" }, { key: "environment", label: "适用环境" },
];
const blankDesign = (): VisualDesign => ({ face: "", body: "", hair: "", clothing: "", environment: "", shape: "" });
const newForm = (): CardForm => ({ name: "", artStyle: store.project?.artStyle || "", roleDefinition: "", ageBand: "unknown", gender: "", describe: "", visualDesign: blankDesign() });
const cards = ref<CharacterCard[]>([]);
const styles = ref<{ label: string; value: string }[]>([]);
const filters = reactive({ artStyle: "", roleDefinition: "", ageBand: "", keyword: "", includeArchived: false });
const loading = ref(false), pageError = ref("");
const editorVisible = ref(false), saving = ref(false), editorError = ref("");
const editorCard = ref<CharacterCard | null>(null);
const form = ref<CardForm>(newForm());
const detail = ref<CharacterCard | null>(null), detailVisible = ref(false), detailError = ref(""), archiving = ref(false);
const imageDialogVisible = ref(false), imageSubmitting = ref(false), imageDialogError = ref("");
const imageTarget = ref<CharacterCard | null>(null);
const imageBatchMode = ref(false), imageBatchTargets = ref<CharacterCard[]>([]), imageBatchProgress = ref("");
const reviewSubmitting = reactive(new Set<number>());
const reviewingImages = reactive(new Set<number>());
const imageModel = ref(store.project?.imageModel || "");
const imageResolution = ref(store.project?.imageQuality || "1K");
const resolutionOptions = ["1K", "2K", "4K"].map(value => ({ value, label: value }));
const importVisible = ref(false), importing = ref(false), importError = ref(""), rolesLoading = ref(false);
const importForm = reactive({ roleDefinition: "", ageBand: "unknown" as AgeBand, ageMin: undefined as number | undefined, ageMax: undefined as number | undefined, gender: "" });
const importProjectId = ref<number | undefined>(Number(store.project?.id) || undefined), importAssetId = ref<number | undefined>();
const projects = ref<{ id: number; name: string }[]>([]), projectRoles = ref<{ id: number; name: string }[]>([]);
const projectOptions = computed(() => projects.value.map(item => ({ value: Number(item.id), label: item.name })));
const projectRoleOptions = computed(() => projectRoles.value.map(item => ({ value: item.id, label: item.name })));
const styleOptions = computed(() => {
  const options = new Map(styles.value.map(style => [style.value, style.label]));
  for (const style of [...cards.value.map(card => card.artStyle), store.project?.artStyle, form.value.artStyle]) {
    if (style && !options.has(style)) options.set(style, style);
  }
  return [...options].map(([value, label]) => ({ value, label }));
});
const styleName = (value: string) => styleOptions.value.find(item => item.value === value)?.label || value || "未指定画风";
const genderName = (value: string) => ({ female: "女性", male: "男性", unknown: "性别未知" } as Record<string, string>)[value] || value;
const cardImage = (card: CharacterCard, full = false) => (full ? card.imageFullUrl || card.imageUrl : card.imageUrl || card.imageFullUrl) || "";
const candidateImage = (card: CharacterCard, full = false) => (full
  ? card.candidateFullUrl || card.imageGeneration?.candidateFullUrl || card.candidateImageUrl || card.imageGeneration?.candidateImageUrl
  : card.candidateImageUrl || card.imageGeneration?.candidateImageUrl || card.candidateFullUrl || card.imageGeneration?.candidateFullUrl) || "";
const canReviewImage = (card: CharacterCard) => card.status === "active" && card.imageGeneration?.state === "failed" && card.imageGeneration.canReview === true;
const imageRunning = (card: CharacterCard) => card.imageGeneration?.state === "running" || card.imageGeneration?.state === "queued";
const imageQueued = (card: CharacterCard) => card.imageGeneration?.state === "queued" || card.imageGeneration?.phase === "queued";
const imageStatusLabel = (card: CharacterCard) => reviewingImages.has(card.id)
  ? (imageQueued(card) ? "图片等待复核" : "图片复核中") : (imageQueued(card) ? "图片等待生成" : "图片生成中");
const cardHasImage = (card: CharacterCard) => Boolean(card.imagePath || cardImage(card));
const visibleMissingImages = computed(() => cards.value.filter(card => card.status === "active" && !cardHasImage(card) && !imageRunning(card) && !reviewSubmitting.has(card.id)));
const imageCounts = computed(() => ({
  ready: cards.value.filter(cardHasImage).length,
  running: cards.value.filter(imageRunning).length,
  failed: cards.value.filter(card => card.imageGeneration?.state === "failed").length,
}));
const visualFieldName = (value: string) => visualFields.find(item => item.key === value)?.label || (value === "describe" ? "完整外观" : value);
const errorText = (error: any) => error?.message || "操作失败，请重试";
function ageLabel(card: Pick<CharacterCard, "ageBand" | "ageMin" | "ageMax">) {
  if (card.ageBand === "unknown") return "年龄未知";
  const band = ageOptions.find(item => item.value === card.ageBand)?.label || "年龄未知";
  if (card.ageMin !== null && card.ageMax !== null) return `${band} · ${card.ageMin === card.ageMax ? card.ageMin : `${card.ageMin}–${card.ageMax}`} 岁`;
  if (card.ageMin !== null) return `${band} · ${card.ageMin} 岁以上`;
  if (card.ageMax !== null) return `${band} · ${card.ageMax} 岁以下`;
  return band;
}
function sourceLabel(card: CharacterCard) {
  return ({ seed: "预置角色卡", manual: "手动创建", generated: "人物提取时生成", from_asset: "由项目人物加入" } as Record<string, string>)[card.provenance.method] || "角色卡";
}
let listRequest = 0, roleRequest = 0;
let pendingImport: { cardId: number; assetId: number; projectId: number } | null = null;
let imagePollTimer: ReturnType<typeof setTimeout> | null = null;
let imagePollInFlight = false, disposed = false;
const pendingImages = new Set<number>();
const pollFailures = new Map<number, number>();
const imageSyncError = "图片状态同步暂时失败，正在重试。已有角色图片保留。";
function applyCard(card: CharacterCard) {
  const index = cards.value.findIndex(item => item.id === card.id);
  if (index >= 0) cards.value[index] = card;
  if (detail.value?.id === card.id) detail.value = card;
  if (imageTarget.value?.id === card.id) imageTarget.value = card;
  const batchIndex = imageBatchTargets.value.findIndex(item => item.id === card.id);
  if (batchIndex >= 0) imageBatchTargets.value[batchIndex] = card;
  if (editorCard.value?.id === card.id) editorCard.value = card;
  trackImage(card);
}
function trackImage(card: CharacterCard) {
  if (imageRunning(card)) pendingImages.add(card.id);
  else { pendingImages.delete(card.id); pollFailures.delete(card.id); reviewingImages.delete(card.id); }
  scheduleImagePoll();
}
function scheduleImagePoll(delay = 2500) {
  if (disposed || imagePollTimer || imagePollInFlight || !pendingImages.size) return;
  imagePollTimer = setTimeout(pollImages, delay);
}
async function pollImages() {
  imagePollTimer = null;
  if (disposed || imagePollInFlight || !pendingImages.size) return;
  imagePollInFlight = true;
  const ids = [...pendingImages];
  const results = await Promise.allSettled(ids.map(id => axios.post("/characterCards/get", { id }, { timeout: 15000 })));
  let failed = false;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (disposed) break;
    if (result.status === "fulfilled") {
      pollFailures.delete(ids[index]);
      applyCard(result.value.data);
      if (pageError.value === imageSyncError) pageError.value = "";
    } else {
      failed = true;
      const failures = (pollFailures.get(ids[index]) || 0) + 1;
      pollFailures.set(ids[index], failures);
      if (failures >= 3) pageError.value = imageSyncError;
    }
  }
  imagePollInFlight = false;
  scheduleImagePoll(failed ? 10000 : 2500);
}
async function loadCards() {
  const request = ++listRequest;
  loading.value = true;
  pageError.value = "";
  try {
    const { data } = await axios.post("/characterCards/list", {
      artStyle: filters.artStyle || undefined, roleDefinition: filters.roleDefinition.trim() || undefined,
      ageBand: filters.ageBand || undefined, keyword: filters.keyword.trim() || undefined, includeArchived: filters.includeArchived,
    });
    if (request === listRequest) {
      cards.value = data.list;
      for (const card of cards.value) trackImage(card);
    }
    return true;
  } catch (error) {
    if (request === listRequest) pageError.value = errorText(error);
    return false;
  } finally {
    if (request === listRequest) loading.value = false;
  }
}
function resetFilters() {
  Object.assign(filters, { artStyle: "", roleDefinition: "", ageBand: "", keyword: "", includeArchived: false });
  loadCards();
}
async function showDetails(card: CharacterCard) {
  detailError.value = "";
  try {
    const { data } = await axios.post("/characterCards/get", { id: card.id });
    detail.value = data;
    detailVisible.value = true;
    trackImage(data);
  } catch (error) { pageError.value = errorText(error); }
}
function openEditor(card?: CharacterCard, copy = false) {
  editorError.value = "";
  editorCard.value = copy ? null : card || null;
  form.value = card ? {
    id: copy ? undefined : card.id, version: copy ? undefined : card.version,
    name: copy ? `${card.name}（新卡）` : card.name, artStyle: card.artStyle, roleDefinition: card.roleDefinition,
    ageBand: card.ageBand, ageMin: card.ageMin ?? undefined, ageMax: card.ageMax ?? undefined,
    gender: card.gender, describe: card.describe, visualDesign: { ...blankDesign(), ...card.visualDesign },
  } : newForm();
  editorVisible.value = true;
}
async function saveCard(thenGenerate: unknown = false) {
  if (saving.value) return;
  const current = form.value;
  if (!current.name.trim() || !current.artStyle || !current.roleDefinition.trim() || !current.describe.trim()) {
    editorError.value = "请填写名称、画风、人物定义和完整外观。";
    return;
  }
  const missingVisual = visualFields.find(field => ["face", "body", "hair", "clothing"].includes(field.key) && !current.visualDesign[field.key].trim());
  if (missingVisual) {
    editorError.value = `请补充${missingVisual.label}，角色卡需要完整的面部、体态、发型和衣装设计。`;
    return;
  }
  const ageMin = current.ageBand === "unknown" ? null : current.ageMin ?? null;
  const ageMax = current.ageBand === "unknown" ? null : current.ageMax ?? null;
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) {
    editorError.value = "最小年龄不能大于最大年龄。";
    return;
  }
  saving.value = true;
  editorError.value = "";
  try {
    const { data: saved } = await axios.post("/characterCards/save", { card: { ...current, name: current.name.trim(), roleDefinition: current.roleDefinition.trim(), describe: current.describe.trim(), ageMin, ageMax } });
    // Keep the created identity if readback fails, so another save cannot create a duplicate.
    form.value.id = saved.id;
    form.value.version = saved.version;
    // Read the persisted revision before reporting success or closing the editor.
    const { data } = await axios.post("/characterCards/get", { id: saved.id });
    if (Number(data.version) !== Number(saved.version)) throw new Error("角色卡已经被更新，请重新打开后检查。你的编辑仍保留在此处。");
    form.value.id = data.id;
    form.value.version = data.version;
    applyCard(data);
    editorVisible.value = false;
    const refreshed = await loadCards();
    MessagePlugin.success(refreshed ? "角色卡已保存" : "角色卡已保存，列表刷新失败，请重试查找");
    if (thenGenerate === true) openImageDialog(data);
  } catch (error) { editorError.value = errorText(error); }
  finally { saving.value = false; }
}
async function openImageDialog(card: CharacterCard) {
  imageBatchMode.value = false;
  imageBatchTargets.value = [];
  imageBatchProgress.value = "";
  imageDialogError.value = "";
  imageDialogVisible.value = true;
  imageTarget.value = card;
  try {
    const { data } = await axios.post("/characterCards/get", { id: card.id });
    applyCard(data);
  } catch (error) { imageDialogError.value = errorText(error); }
}
function openBatchImageDialog() {
  imageBatchTargets.value = [...visibleMissingImages.value];
  if (!imageBatchTargets.value.length) return;
  imageBatchMode.value = true;
  imageBatchProgress.value = "";
  imageDialogError.value = "";
  imageTarget.value = null;
  imageDialogVisible.value = true;
}
async function acceptCardImage(card: CharacterCard, model: string, resolution: string) {
  const { data: accepted } = await axios.post("/characterCards/generateImage", { id: card.id, version: card.version, model, resolution });
  applyCard({ ...card, imageGeneration: { id: accepted.attemptId, state: "running", phase: "queued", errorReason: null, baseVersion: card.version } });
  pendingImages.add(card.id);
  scheduleImagePoll();
  try {
    const { data } = await axios.post("/characterCards/get", { id: card.id });
    applyCard(data);
  } catch { /* The scheduled polling resumes state synchronization. */ }
}
async function reviewExistingImage(card: CharacterCard) {
  if (!canReviewImage(card) || !card.imageGeneration || reviewSubmitting.has(card.id)) return;
  reviewSubmitting.add(card.id);
  if (detail.value?.id === card.id) detailError.value = "";
  else pageError.value = "";
  try {
    const { data: accepted } = await axios.post("/characterCards/reviewImage", { id: card.id, version: card.version, attemptId: card.imageGeneration.id });
    reviewingImages.add(card.id);
    applyCard({ ...card, imageGeneration: { ...card.imageGeneration, id: accepted?.attemptId || card.imageGeneration.id, state: "running", phase: "queued", canReview: false, errorReason: null } });
    pendingImages.add(card.id);
    scheduleImagePoll();
    try {
      const { data } = await axios.post("/characterCards/get", { id: card.id });
      applyCard(data);
    } catch { /* State polling continues; the saved candidate is not redrawn. */ }
    MessagePlugin.success("已有图片已加入复核，结果会自动更新");
  } catch (error) {
    if (detail.value?.id === card.id) detailError.value = errorText(error);
    else pageError.value = errorText(error);
  } finally { reviewSubmitting.delete(card.id); }
}
async function generateCardImage() {
  const card = imageTarget.value;
  if (imageSubmitting.value || !imageModel.value || (imageBatchMode.value ? !imageBatchTargets.value.length : !card || imageRunning(card))) return;
  imageSubmitting.value = true;
  imageDialogError.value = "";
  const selectedModel = imageModel.value, selectedResolution = imageResolution.value;
  try {
    if (imageBatchMode.value) {
      const targets = [...imageBatchTargets.value];
      let accepted = 0, skipped = 0;
      const failures: string[] = [];
      for (const [index, target] of targets.entries()) {
        if (disposed) break;
        imageBatchProgress.value = `正在提交 ${index + 1}/${targets.length}：${target.name}`;
        try {
          const { data: fresh } = await axios.post("/characterCards/get", { id: target.id });
          applyCard(fresh);
          if (cardHasImage(fresh) || imageRunning(fresh) || fresh.status !== "active") { skipped++; continue; }
          await acceptCardImage(fresh, selectedModel, selectedResolution);
          accepted++;
        } catch (error) { failures.push(`${target.name}：${errorText(error)}`); }
      }
      imageBatchProgress.value = `已提交 ${accepted} 张${skipped ? `，跳过 ${skipped} 张` : ''}${failures.length ? `，${failures.length} 张未提交` : ''}。完成后图片自动显示。`;
      if (failures.length) imageDialogError.value = failures.join("；");
      else imageDialogVisible.value = false;
      if (accepted) MessagePlugin.success(`已为 ${accepted} 张缺图角色卡排队生成`);
    } else if (card) {
      await acceptCardImage(card, selectedModel, selectedResolution);
      imageDialogVisible.value = false;
      MessagePlugin.success("角色图片已开始生成，完成后自动显示");
    }
  } catch (error) { imageDialogError.value = errorText(error); }
  finally { imageSubmitting.value = false; }
}
async function archiveCard(card: CharacterCard) {
  if (archiving.value) return;
  archiving.value = true;
  detailError.value = "";
  try {
    await axios.post("/characterCards/archive", { id: card.id, version: card.version });
    const { data } = await axios.post("/characterCards/get", { id: card.id });
    if (data.status !== "archived") throw new Error("停用状态未保存，请重试。");
    detail.value = data;
    await loadCards();
    MessagePlugin.success("角色卡已停用，以后提取人物时不再匹配此卡");
  } catch (error) { detailError.value = errorText(error); }
  finally { archiving.value = false; }
}
async function openImport() {
  importVisible.value = true;
  importError.value = "";
  Object.assign(importForm, { roleDefinition: "", ageBand: "unknown", ageMin: undefined, ageMax: undefined, gender: "" });
  try {
    const { data } = await axios.post("/project/getProject");
    projects.value = data;
    if (store.project && !projects.value.some(item => Number(item.id) === Number(store.project!.id))) {
      projects.value.push({ id: Number(store.project.id), name: store.project.name });
    }
    await loadProjectRoles();
  } catch (error) { importError.value = errorText(error); }
}
async function loadProjectRoles() {
  const request = ++roleRequest;
  importAssetId.value = undefined;
  projectRoles.value = [];
  if (!importProjectId.value) return;
  rolesLoading.value = true;
  importError.value = "";
  try {
    const { data } = await axios.post("/cornerScape/getAllAssets", { projectId: importProjectId.value, type: ["role"] });
    if (request === roleRequest) projectRoles.value = data;
  } catch (error) { if (request === roleRequest) importError.value = errorText(error); }
  finally { if (request === roleRequest) rolesLoading.value = false; }
}
async function importAsset() {
  if (importing.value || !importAssetId.value || !importProjectId.value) return;
  if (!importForm.roleDefinition.trim()) {
    importError.value = "请填写用于匹配的人物定义。";
    return;
  }
  const ageMin = importForm.ageBand === "unknown" ? null : importForm.ageMin ?? null;
  const ageMax = importForm.ageBand === "unknown" ? null : importForm.ageMax ?? null;
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) {
    importError.value = "最小年龄不能大于最大年龄。";
    return;
  }
  importing.value = true;
  importError.value = "";
  try {
    const assetId = importAssetId.value, projectId = importProjectId.value;
    if (!pendingImport || pendingImport.assetId !== assetId || pendingImport.projectId !== projectId) {
      const { data: saved } = await axios.post("/characterCards/fromAsset", { assetId, projectId, roleDefinition: importForm.roleDefinition.trim(), ageBand: importForm.ageBand, ageMin, ageMax, gender: importForm.gender });
      pendingImport = { cardId: saved.id, assetId, projectId };
    }
    const { data } = await axios.post("/characterCards/get", { id: pendingImport.cardId });
    importVisible.value = false;
    pendingImport = null;
    await loadCards();
    openEditor(data);
    MessagePlugin.success("已加入角色卡库，可以继续完善人物定义和年龄");
  } catch (error) { importError.value = errorText(error); }
  finally { importing.value = false; }
}
onMounted(async () => {
  const results = await Promise.allSettled([loadCards(), axios.post("/project/getVisualManual")]);
  const styleResult = results[1];
  if (styleResult.status === "fulfilled") styles.value = styleResult.value.data.map((item: { name: string; stylePath: string }) => ({ label: item.name.replace(/^#+\s*/, ""), value: item.stylePath }));
  else pageError.value = [pageError.value, "画风列表加载失败，可刷新页面重试。"].filter(Boolean).join(" ");
});
onUnmounted(() => {
  disposed = true;
  if (imagePollTimer) clearTimeout(imagePollTimer);
  imagePollTimer = null;
  pendingImages.clear();
});
</script>

<style scoped lang="scss">
.character-cards { padding: 24px; height: 100%; overflow-y: auto; color: var(--td-text-color-primary); }
.page-header, .actions, .card-heading, .card-footer, .tags { display: flex; align-items: center; gap: 12px; }
.page-header { justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; }
h1 { margin: 0 0 8px; font-size: 24px; }
.page-header p, .hint, .list-count { color: var(--td-text-color-secondary); font-size: 14px; line-height: 1.6; }
.page-header p { margin: 0; max-width: 850px; }
.filters { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)) auto; gap: 16px; align-items: end; margin: 22px 0 16px; }
.filters label { display: flex; flex-direction: column; gap: 8px; font-size: 14px; }
.filter-actions { display: flex; gap: 4px; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.character-card { background: var(--td-bg-color-container); border: 1px solid var(--td-component-stroke); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; }
.card-image-box, .detail-image-box { position: relative; background: var(--td-bg-color-secondarycontainer); border-radius: 8px; overflow: hidden; }
.card-image-box { height: 220px; margin-bottom: 18px; }
.detail-image-box { height: 320px; margin-bottom: 10px; }
.image-button { display: block; width: 100%; height: 100%; border: 0; padding: 0; background: transparent; cursor: zoom-in; }
.card-image { width: 100%; height: 100%; }
.image-placeholder { display: flex; height: 100%; width: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--td-text-color-secondary); text-align: center; padding: 16px; }
.image-placeholder small { color: var(--td-text-color-placeholder); }
.image-state { position: absolute; bottom: 10px; left: 10px; right: 10px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--td-bg-color-container); font-size: 13px; border-radius: 5px; width: fit-content; }
.image-error { font-size: 12px; line-height: 1.5; color: var(--td-error-color); margin: -8px 0 12px; overflow-wrap: anywhere; }
.image-model { color: var(--td-text-color-secondary); font-size: 12px; margin: -8px 0 12px; overflow-wrap: anywhere; }
.detail-image-actions { margin: 14px 0 20px; display: flex; gap: 10px; flex-wrap: wrap; }
.candidate-image-section { margin: 18px 0; padding: 14px; border: 1px solid var(--td-warning-color-3); border-radius: 8px; }
.candidate-image-section h3 { margin: 0 0 12px; font-size: 16px; }
.list-summary { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 12px 0 18px; }
.list-summary .list-count { margin: 0; }
.image-hint { margin: 0 0 14px; font-size: 12px; }
.editor-image-box { height: 150px; background: var(--td-bg-color-secondarycontainer); border-radius: 8px; overflow: hidden; }
.editor-image-box :deep(.t-image) { width: 100%; height: 100%; }
.character-card.archived { opacity: .7; }
.card-heading { justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
.card-heading h2 { font-size: 18px; margin: 0; overflow-wrap: anywhere; }
.tags { flex-wrap: wrap; gap: 6px; }
.role-definition { font-size: 14px; line-height: 1.6; margin: 14px 0 8px; font-weight: 500; }
.card-description { font-size: 14px; line-height: 1.7; color: var(--td-text-color-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; margin: 0 0 20px; }
.card-footer { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--td-component-stroke); justify-content: space-between; font-size: 12px; color: var(--td-text-color-secondary); }
.card-footer { flex-wrap: wrap; gap: 8px; }
.card-footer .actions { margin-left: auto; flex-wrap: wrap; gap: 6px; }
.card-details dt { font-weight: 600; margin: 20px 0 8px; }
.card-details dd { margin: 0; font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.hint { margin: 12px 0 18px; }
.error { color: var(--td-error-color); font-size: 14px; line-height: 1.6; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.age-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.editor-form { max-height: 62vh; overflow-y: auto; padding-right: 8px; }
.visual-editor summary { cursor: pointer; font-weight: 600; margin-bottom: 14px; }
@media (max-width: 1100px) { .filters { grid-template-columns: repeat(2, minmax(150px, 1fr)); } }
@media (max-width: 680px) { .character-cards { padding: 16px; } .filters, .form-grid { grid-template-columns: 1fr; } .age-grid { grid-template-columns: 1fr 1fr; } }
</style>
