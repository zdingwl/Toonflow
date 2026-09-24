<template>
  <div class="index fc">
    <div class="referenceImage"><div class="uploadBtn">
      <imageSelect :mode="modelParmas.mode as VideoMode" v-model="imageList" :storyboard-list="storyboardList" />
    </div></div>
    <div class="modelSelect">
      <modeMenu v-model="modelParmas" :modeOptions="modeOptions" :trackId="currentTrack?.id" :modeList="modeList" @modeChange="modeChange" />
    </div>
    <div class="generate ac">
      <div class="prompt" v-if="currentTrack">
        <t-card :title="'#' + (activeTrackIndex + 1) + $t('workbench.generate.generateText')" header-bordered class="videoPrompt">
          <template #actions>
            <t-button size="small" class="genTextbtn" :loading="currentTrack.state == '生成中'" @click="genText">
              {{ $t("workbench.generate.generateText") }}
            </t-button>
          </template>
          <div class="promptData fc"><div class="promptInput" @focusout="handlePromptBlur">
            <promptEditor v-model="currentTrack.prompt" :references="references" :placeholder="$t('workbench.generate.promptPlaceholder')" />
          </div></div>
        </t-card>
      </div>
      <div class="video"><videoCard v-if="currentTrack" :active-track-index="activeTrackIndex" v-model:current-track="currentTrack" @refresh="getGenerateData" @generate="generateVideo" /></div>
    </div>
    <div class="track">
      <newTrack v-model:activeTrackIndex="activeTrackIndex" v-model="trackList" :image-list="imageList"
        @change="trackChange" :modelParmas="modelParmas" :clampDuration="clampDuration" @getData="getGenerateData" />
    </div>
  </div>
</template>
<script setup lang="ts">
import type { Ref } from "vue";
import newTrack from "./components/track.vue";
import imageSelect from "./components/imageSelect.vue";
import modeMenu from "./components/modeMenu.vue";
import videoCard from "./components/video.vue";
import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import promptEditor from "@/components/promptEditor.vue";
import imageListCacheStore from "@/stores/imageListCache";

const { project } = storeToRefs(projectStore());
const episodesId = inject<Ref<number>>("episodesId")!;
const activeTrackIndex = ref(0);
const cacheStore = imageListCacheStore();
const { getCache, setCache, initCacheFromTrackList, warmUpUrls } = cacheStore;
const { urlMap } = storeToRefs(cacheStore);
const modeOptions = ref<VideoModel>({ name: "", modelName: "", durationResolutionMap: [], audio: false, type: "video", mode: [] });
const trackList = ref<TrackItem[]>([]);
const modelParmas = ref<ModelSetting>({
  mode: "", model: "", resolution: "768p", duration: 8, audio: false,
  dialogueLocale: "original", h3ReferenceMode: "board", h3Views: ["BOARD"], h3ShotView: "front",
});
const storyboardList = ref<StoryboardItem[]>([]);
const h3Options = () => ({
  dialogueLocale: modelParmas.value.dialogueLocale || "original",
  h3ReferenceMode: modelParmas.value.h3ReferenceMode || "board",
  h3ShotView: modelParmas.value.h3ShotView || "front",
  h3Views: modelParmas.value.h3Views || ["BOARD"],
});
const h3Model = computed(() => /minimax/i.test(modelParmas.value.model) && /h3/i.test(modelParmas.value.model));
const h3ChoiceKey = () => `toonflow:h3-choice:${project.value?.id || 0}:${episodesId.value || 0}`;
watch(() => [modelParmas.value.dialogueLocale, modelParmas.value.h3ReferenceMode, modelParmas.value.h3ShotView, JSON.stringify(modelParmas.value.h3Views || [])], () => {
  if (!project.value?.id) return;
  try { localStorage.setItem(h3ChoiceKey(), JSON.stringify(h3Options())); } catch { /* storage can be disabled */ }
});
function restoreH3Options() {
  try {
    const choice = JSON.parse(localStorage.getItem(h3ChoiceKey()) || "null");
    if (!choice || typeof choice !== "object") return;
    modelParmas.value.dialogueLocale = choice.dialogueLocale || "original";
    modelParmas.value.h3ReferenceMode = choice.h3ReferenceMode || "board";
    modelParmas.value.h3ShotView = choice.h3ShotView || "front";
    modelParmas.value.h3Views = Array.isArray(choice.h3Views) ? choice.h3Views : ["BOARD"];
  } catch { /* corrupted stored settings => safe defaults */ }
}
function getImageItemPriority(item: UploadItem): number { if (item.src) return item.sources === "assets" ? 0 : 1; return 2; }
const imageList = computed({
  get(): UploadItem[] {
    urlMap.value;
    const trackId = currentTrack.value?.id;
    const pid = project.value?.id;
    const sid = episodesId.value;
    if (pid != null && sid != null && trackId != null) {
      const cached = getCache(pid, sid, trackId);
      if (cached?.length) return [...cached].sort((a,b) => getImageItemPriority(a) - getImageItemPriority(b));
    }
    const medias = currentTrack.value?.medias;
    if (!medias?.length) return [];
    return [...(medias as UploadItem[])].sort((a,b) => getImageItemPriority(a) - getImageItemPriority(b));
  },
  set(val: UploadItem[]) {
    if (!currentTrack.value) return;
    currentTrack.value.medias = val as any;
    const pid = project.value?.id; const sid = episodesId.value; const trackId = currentTrack.value.id;
    if (pid != null && sid != null && trackId != null) setCache(pid, sid, trackId, val);
  },
});
function modeChange(newVal: string) {
  if (newVal == modelParmas.value.mode) return;
  if ((imageList.value.length || currentTrack.value?.prompt) && modelParmas.value.mode) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.generate.modeChange"), body: $t("workbench.generate.modeChangeConfirm"),
      confirmBtn: $t("settings.generate.modelChnageSure"), cancelBtn: $t("settings.memory.msg.cancel"),
      onConfirm: async () => { imageList.value = []; if (currentTrack.value) currentTrack.value.prompt = ""; dialog.destroy(); modelParmas.value.mode = newVal; },
    });
  } else if (newVal) modelParmas.value.mode = newVal;
}
const modeList = computed(() => {
  const map: Record<string,string> = { singleImage: "单图", startEndRequired: "首尾帧", endFrameOptional: "尾帧可选", startFrameOptional: "首帧可选", text: "文本生视频", videoReference: "视频", imageReference: "图片", audioReference: "音频", textReference: "文本" };
  const label = (s: string) => { const match = s.match(/^(videoReference|imageReference|audioReference|textReference):(\d+)$/); return match ? `${map[match[1]]} ×${match[2]}` : map[s] || s; };
  return modeOptions.value.mode ? modeOptions.value.mode.map(mode => Array.isArray(mode)
    ? { value: JSON.stringify(mode), label: mode.map(label).join(" + ") + "参考" }
    : { value: mode, label: label(mode) }) : [];
});
const currentTrack = computed({
  get() { return trackList.value[activeTrackIndex.value]; },
  set(val) { trackList.value[activeTrackIndex.value] = val; },
});
function clampDuration(trackDuration: number): number {
  const dr = modeOptions.value?.durationResolutionMap;
  if (Array.isArray(dr) && dr.length && dr[0].duration?.length) {
    const durations = dr[0].duration;
    return Math.max(Math.min(...durations), Math.min(trackDuration, Math.max(...durations)));
  }
  return trackDuration;
}
watch(() => modelParmas.value.model, val => {
  if (!val) {
    modeOptions.value = { name: "", modelName: "", durationResolutionMap: [], audio: false, type: "video", mode: [] };
    modelParmas.value.mode = ""; return;
  }
  axios.post("/modelSelect/getModelDetail", { modelId: val }).then(({ data }) => {
    modeOptions.value = data;
    modelParmas.value.audio = data.audio === true || data.audio === "true" || data.audio === "optional";
    const dr = data.durationResolutionMap;
    if (Array.isArray(dr) && dr.length) {
      if (dr[0].resolution?.length) modelParmas.value.resolution = dr[0].resolution[0];
      if (dr[0].duration?.length) modelParmas.value.duration = clampDuration(modelParmas.value.duration);
    }
    const parsed = parseMode(modelParmas.value.mode);
    const matched = parsed !== null && data.mode.some((m: VideoMode) => Array.isArray(m) && Array.isArray(parsed) ? JSON.stringify(m) === JSON.stringify(parsed) : m == parsed);
    if (!matched && data.mode.length) modeChange(Array.isArray(data.mode[0]) ? JSON.stringify(data.mode[0]) : data.mode[0]);
  });
});
function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed as ReferenceType[]; } catch { /* simple mode */ }
  return value as Exclude<VideoMode,ReferenceType[]>;
}
const references = computed(() => {
  function fileType(src: string | undefined): "image" | "video" | "audio" {
    const ext = (src || "").split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
    if (["mp4","webm","mov","avi","mkv"].includes(ext)) return "video";
    if (["mp3","wav","ogg","aac","flac","m4a"].includes(ext)) return "audio";
    return "image";
  }
  return imageList.value.filter(i => i.src).map(i => ({ type: fileType(i.src) as "image" | "video" | "audio" | "text", src: i.src ?? "" }));
});
async function getGenerateData() {
  const { data } = await axios.post("/production/workbench/getGenerateData", { projectId: project.value?.id, scriptId: episodesId.value ?? 0 });
  storyboardList.value = data.storyboardList;
  const pid = project.value?.id; const sid = episodesId.value;
  if (pid != null && sid != null) {
    initCacheFromTrackList(pid, sid, data.trackList);
    await warmUpUrls(pid, sid);
    data.trackList.forEach((track: TrackItem) => {
      if (track.id == null) return;
      const cached = getCache(pid, sid, track.id);
      if (cached?.length) track.medias = cached as unknown as TrackMedia[];
    });
    trackList.value = [...data.trackList];
  }
  modelParmas.value.duration = clampDuration(data.trackList?.[activeTrackIndex.value]?.duration);
}
function handlePromptBlur() {
  const id = trackList.value[activeTrackIndex.value]?.id;
  if (id == null) return;
  axios.post("/production/workbench/updateVideoPrompt", { id, prompt: currentTrack.value?.prompt });
}
function getUploadInfo(track: TrackItem, filterEmpty = false) {
  const frames = ["startEndRequired", "endFrameOptional", "startFrameOptional"];
  const raw = track.id === currentTrack.value?.id ? imageList.value : (track.medias as UploadItem[]);
  const sliced = frames.includes(modelParmas.value.mode) ? raw.slice(0,2) : modelParmas.value.mode === "singleImage" ? raw.slice(0,1) : raw;
  return sliced.filter(item => typeof item.id === "number" && !Number.isNaN(item.id) && (!filterEmpty || Boolean(item.src)))
    .map(item => ({ id: item.id!, sources: item.sources, reference: Boolean(item.src), slotType: item.slotType,
      fileType: item.fileType, prompt: item.prompt, h3ReferenceMode: item.h3ReferenceMode,
      h3Views: item.h3Views, h3ShotView: item.h3ShotView }));
}
async function genText() {
  const track = currentTrack.value;
  if (!track || track.id == null || track.state === "生成中") return;
  const info = getUploadInfo(track);
  track.state = "生成中";
  try {
    const { data } = await axios.post("/production/workbench/generateVideoPrompt", {
      projectId: project.value?.id, trackId: track.id, info,
      model: modelParmas.value.model, mode: modelParmas.value.mode,
      ...(h3Model.value ? h3Options() : {}),
    });
    track.prompt = data;
    track.state = "已完成";
  } catch (cause) {
    track.state = "生成失败";
    window.$message.error((cause as Error)?.message ?? "提示词生成失败");
  }
}
function trackChange(prevIndex?: number) {
  if (prevIndex != null) {
    const previous = trackList.value[prevIndex];
    const pid = project.value?.id; const sid = episodesId.value;
    if (pid != null && sid != null && previous?.id != null) setCache(pid, sid, previous.id, previous.medias as unknown as UploadItem[]);
  }
  const pid = project.value?.id; const sid = episodesId.value;
  const track = trackList.value[activeTrackIndex.value];
  if (pid != null && sid != null && track?.id != null) {
    const cached = getCache(pid, sid, track.id);
    if (cached) track.medias = cached as unknown as TrackMedia[];
  }
  if (modelParmas.value.mode === "singleImage" && imageList.value.length > 1) imageList.value = imageList.value.slice(0,1);
  modelParmas.value.duration = clampDuration(track?.duration);
}
watch(() => currentTrack.value?.medias, medias => {
  if (!medias) return;
  const pid = project.value?.id; const sid = episodesId.value; const id = currentTrack.value?.id;
  if (pid != null && sid != null && id != null) setCache(pid, sid, id, medias as unknown as UploadItem[]);
}, { deep: true });
onMounted(() => {
  modelParmas.value.model = project.value?.videoModel || "";
  modelParmas.value.mode = project.value?.mode || "";
  restoreH3Options();
  getGenerateData();
  if (hasGenerateVideoIds.value?.length) startPoll();
});
async function generateVideo() {
  if (!currentTrack.value) return;
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.generateConfirm"), body: $t("workbench.generate.generateConfirmBody"),
    onConfirm: async () => {
      dlg.destroy();
      try {
        const { data } = await axios.post("/production/workbench/generateVideo", {
          projectId: project.value?.id, scriptId: episodesId.value,
          uploadData: modelParmas.value.mode === "text" ? [] : getUploadInfo(currentTrack.value, true).map(item => ({
            ...item,
            type: item.slotType ?? (item.fileType === "audio" ? "audioReference" : item.fileType === "video" ? "videoReference" : "imageReference"),
          })),
          prompt: currentTrack.value.prompt, model: modelParmas.value.model, mode: modelParmas.value.mode,
          resolution: modelParmas.value.resolution, duration: modelParmas.value.duration,
          audio: modelParmas.value.audio, trackId: currentTrack.value.id,
          ...(h3Model.value ? h3Options() : {}),
        });
        window.$message.success($t("workbench.generate.generateStarted"));
        currentTrack.value.videoList.push({ id: data, state: "生成中", src: "" });
      } catch (cause) { window.$message.error((cause as Error)?.message ?? "视频发起生成请求失败"); }
    },
    onCancel: () => dlg.destroy(),
  });
}
let pollTimer: NodeJS.Timeout | null = null;
let promptPollTimer: NodeJS.Timeout | null = null;
function startPoll() { if (pollTimer === null) pollTimer = setInterval(() => getVideoList(), 3000); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
const hasGenerateVideoIds = computed(() => trackList.value.flatMap(track => track.videoList.filter(video => video.state === "生成中").map(video => video.id)));
const hasGeneratePromptIds = computed(() => trackList.value.filter(track => track.state === "生成中").map(track => track.id));
async function getVideoList() {
  const { data } = await axios.post("/production/workbench/checkVideoStateList", {
    projectId: project.value?.id, scriptId: episodesId.value ?? 0, videoIds: hasGenerateVideoIds.value,
  });
  if (!Array.isArray(data)) return;
  data.forEach((item: { id: number; state: "生成中" | "未生成" | "已完成" | "生成失败"; src?: string; errorReason?: string }) => {
    for (const track of trackList.value) {
      const found = track.videoList.find(video => video.id === item.id);
      if (found) { found.state = item.state; found.src = item.src ?? ""; found.errorReason = item.errorReason ?? ""; break; }
    }
  });
}
function startPromptPoll() { if (promptPollTimer === null) promptPollTimer = setInterval(() => getTrackPromptList(), 3000); }
function stopPromptPoll() { if (promptPollTimer) { clearInterval(promptPollTimer); promptPollTimer = null; } }
async function getTrackPromptList() {
  const { data } = await axios.post("/production/workbench/checkVideoPrompt", {
    projectId: project.value?.id, scriptId: episodesId.value ?? 0, trackIds: hasGeneratePromptIds.value,
  });
  if (!Array.isArray(data)) return;
  data.forEach((item: { id: number; state: "生成中" | "未生成" | "已完成" | "生成失败"; prompt?: string; reason?: string }) => {
    const found = trackList.value.find(track => track.id === item.id);
    if (!found) return;
    found.state = item.state; found.prompt = item.prompt ?? ""; found.reason = item.reason ?? "";
    if (item.state === "生成失败") window.$message.error(`提示词生成失败，${item.reason ?? "未知原因"}`);
  });
}
watch(() => hasGenerateVideoIds.value, next => next?.length ? startPoll() : stopPoll());
watch(() => hasGeneratePromptIds.value, next => next?.length ? startPromptPoll() : stopPromptPoll());
onUnmounted(() => { stopPoll(); stopPromptPoll(); });
</script>
<style lang="scss" scoped>
.index {
  height: calc(100vh - 120px); gap: 16px; overflow-y: auto;
  .generate { flex: 1; min-height: 0; width: 100%; gap: 5px;
    .prompt { width: 50%; height: 100%; min-height: 0;
      .videoPrompt { width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column;
        :deep(.t-card__body) { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
        .promptData { width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column;
          .promptInput { flex: 1; min-height: 0; overflow-y: auto; }
        }
      }
    }
    .video { width: 50%; height: 100%; min-height: 0; }
  }
}
</style>
