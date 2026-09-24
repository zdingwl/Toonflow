<template>
  <div class="modeMenu">
    <div class="left f ac">
      <div class="model">
        <modelSelect v-model="modelParmas.model" type="video" size="small" />
      </div>
      <t-select size="small" class="mode" :value="modelParmas.mode" :onChange="handleBeforeChange">
        <t-option v-for="(item, index) in modeList" :key="index" :value="item.value" :label="item.label"></t-option>
      </t-select>
      <t-button size="small" variant="outline" :theme="modelParmas.audio ? 'success' : 'danger'" class="audio"
        @click="modelParmas.audio = !modelParmas.audio">
        <template #icon>
          <i-volume-notice v-if="modelParmas.audio" size="16" />
          <i-volume-mute v-else size="16" />
        </template>
      </t-button>
      <div class="status">
        <t-popup trigger="click" placement="top" overlay-class-name="resDurPickerPopup"
          :overlay-inner-style="{ padding: '16px', borderRadius: '8px' }">
          <t-tag class="btn" variant="outline">{{ modelParmas.resolution }}·{{ modelParmas.duration }}s</t-tag>
          <template #content>
            <div class="resolutionDurationPicker">
              <div v-if="Array.isArray(modeOptions.durationResolutionMap) && modeOptions.durationResolutionMap.length > 0 && modeOptions.durationResolutionMap[0].resolution && modeOptions.durationResolutionMap[0].resolution.length > 0" class="pickerSection">
                <div class="pickerLabel">{{ $t("workbench.generate.resolution") }}</div>
                <div class="pickerOptions">
                  <div v-for="res in modeOptions.durationResolutionMap[0].resolution" :key="res" class="pickerOption"
                    :class="{ active: modelParmas.resolution == res }" @click="modelParmas.resolution = res">{{ res }}</div>
                </div>
              </div>
              <div v-if="Array.isArray(modeOptions.durationResolutionMap) && modeOptions.durationResolutionMap.length > 0 && modeOptions.durationResolutionMap[0].duration && modeOptions.durationResolutionMap[0].duration.length > 0" class="pickerSection">
                <div class="pickerLabel">{{ $t("workbench.generate.duration") }}</div>
                <div class="pickerOptions">
                  <div v-for="dur in modeOptions.durationResolutionMap[0].duration" :key="dur" class="pickerOption"
                    :class="{ active: modelParmas.duration == dur }" @click="updateDuration(dur)">{{ dur }}s</div>
                </div>
              </div>
            </div>
          </template>
        </t-popup>
      </div>
    </div>
    <div v-if="isH3" class="h3Options f ac">
      <span>对白语言</span>
      <t-select size="small" class="h3Select" :value="modelParmas.dialogueLocale || 'original'"
        @change="(value) => modelParmas.dialogueLocale = String(value)">
        <t-option v-for="item in dialogueLocales" :key="item.value" :value="item.value" :label="item.label" />
      </t-select>
      <span>角色参考</span>
      <t-select size="small" class="h3Select" :value="modelParmas.h3ReferenceMode || 'board'"
        @change="onReferenceModeChange">
        <t-option value="board" label="完整四视图" />
        <t-option value="auto" label="按分镜角度" />
        <t-option value="manual" label="手动选择" />
      </t-select>
      <template v-if="modelParmas.h3ReferenceMode === 'auto'">
        <span>镜头角度</span>
        <t-select size="small" class="h3Select" :value="modelParmas.h3ShotView || 'front'"
          @change="(value) => modelParmas.h3ShotView = String(value) as H3ShotView">
          <t-option value="front" label="正面" /><t-option value="side" label="侧面" />
          <t-option value="back" label="背面" /><t-option value="turn" label="转身" />
          <t-option value="closeup" label="面部特写" />
        </t-select>
      </template>
      <template v-if="modelParmas.h3ReferenceMode === 'manual'">
        <span>参考视图</span>
        <t-select size="small" class="h3Views" multiple :value="modelParmas.h3Views || ['BOARD']"
          @change="onViewsChange">
          <t-option value="BOARD" label="完整四视图" /><t-option value="FACE" label="脸部" />
          <t-option value="FRONT" label="正面" /><t-option value="SIDE" label="侧面" />
          <t-option value="BACK" label="背面" />
        </t-select>
      </template>
      <span class="hint">更换语言或参考方式后须重新生成提示词；不会自动延长视频。</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";
const props = defineProps<{
  modeOptions: VideoModel;
  modeList: { value: string; label: string }[];
  trackId: number | undefined;
}>();
const modelParmas = defineModel<ModelSetting>({
  default: { mode: "", model: "", resolution: "768p", duration: 8, audio: false, dialogueLocale: "original", h3ReferenceMode: "board", h3Views: ["BOARD"] },
});
const emit = defineEmits(["modeChange"]);
const isH3 = computed(() => {
  const model = String(modelParmas.value.model || "").toLowerCase();
  return model.includes("minimax") && model.includes("h3");
});
const dialogueLocales = [
  { value: "original", label: "跟随剧本" }, { value: "zh-CN", label: "中国·普通话" },
  { value: "en-US", label: "美国·英语" }, { value: "en-GB", label: "英国·英语" },
  { value: "ja-JP", label: "日本·日语" }, { value: "ko-KR", label: "韩国·韩语" },
  { value: "fr-FR", label: "法国·法语" }, { value: "de-DE", label: "德国·德语" },
  { value: "es-ES", label: "西班牙·西语" }, { value: "es-MX", label: "墨西哥·西语" },
  { value: "ru-RU", label: "俄罗斯·俄语" }, { value: "pt-BR", label: "巴西·葡语" },
];
function onReferenceModeChange(value: unknown) {
  const mode = String(value) as H3ReferenceMode;
  modelParmas.value.h3ReferenceMode = mode;
  if (mode === "manual" && !(modelParmas.value.h3Views?.length)) modelParmas.value.h3Views = ["BOARD"];
}
function onViewsChange(value: unknown) {
  const next = Array.isArray(value) ? value.map(String) as H3RoleView[] : [];
  if (!next.length) { modelParmas.value.h3Views = ["BOARD"]; return; }
  if (next.includes("BOARD") && next.length > 1) {
    const previous = modelParmas.value.h3Views || [];
    modelParmas.value.h3Views = previous.includes("BOARD") ? next.filter(item => item !== "BOARD") : ["BOARD"];
  } else modelParmas.value.h3Views = next;
}
function handleBeforeChange(newVal: string) { emit("modeChange", newVal); }
function updateDuration(newDuration: number) {
  modelParmas.value.duration = newDuration;
  if (props.trackId) axios.post("/production/workbench/updateVideoDuration", { id: props.trackId, duration: newDuration });
}
</script>

<style lang="scss" scoped>
.modeMenu {
  width: 100%;
  .left { flex: 1; gap: 8px; .mode { width: 280px; } .status { .btn { cursor: pointer; &:hover { background-color: var(--td-bg-color-secondarycontainer); } } } }
  .h3Options { margin-top: 8px; gap: 8px; flex-wrap: wrap; font-size: 12px; .h3Select { width: 152px; } .h3Views { width: 230px; } .hint { color: var(--td-text-color-secondary); } }
}
</style>
<style lang="scss">
.resolutionDurationPicker {
  min-width: 240px;
  .pickerSection {
    margin-bottom: 16px;
    &:last-child { margin-bottom: 0; }
    .pickerLabel { font-size: 13px; font-weight: 600; color: var(--td-text-color-primary); margin-bottom: 10px; }
    .pickerOptions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      .pickerOption { padding: 6px 0; border-radius: 8px; border: 1.5px solid var(--td-border-level-1-color); font-size: 13px; color: var(--td-text-color-primary); cursor: pointer; transition: all 0.15s; user-select: none; text-align: center; background: var(--td-bg-color-container);
        &:hover { border-color: var(--td-border-level-2-color); } &.active { border-color: var(--td-text-color-primary); color: var(--td-text-color-primary); font-weight: 500; }
      }
    }
  }
}
</style>
