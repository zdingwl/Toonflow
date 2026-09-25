<template>
  <div class="index fc">
    <div class="referenceImage">
      <div class="uploadBtn">
        <imageSelect :mode="modelParmas.mode as VideoMode" v-model="imageList" :storyboard-list="storyboardList" />
      </div>
    </div>
    <div class="modelSelect">
      <modeMenu v-model="modelParmas" :modeOptions="modeOptions" :trackId="currentTrack?.id" :modeList="modeList" @modeChange="modeChange" />
    </div>
    <div class="languagePanel">
      <strong>对白语言</strong>
      <t-select
        :value="selectedLanguages"
        multiple
        :options="languageOptions"
        placeholder="生成提示词前，请选择一种或多种对白语言"
        :disabled="savingLanguages || hasGeneratePromptIds.length > 0"
        @change="saveLanguages"
        style="min-width: 360px; flex: 1" />
      <span>生成提示词会更新当前视频段所选语言的提示词；批量生成只补齐未完成版本，已有视频保留。</span>
    </div>
    <div class="languageTabs">
      <t-radio-group v-model="activeLanguage" variant="default-filled">
        <t-radio-button value="">原版（未标注语言）</t-radio-button>
        <t-radio-button v-for="language in availableLanguages" :key="language" :value="language">{{ languageName(language) }}</t-radio-button>
      </t-radio-group>
    </div>
    <div class="generate ac">
      <div class="prompt" v-if="currentTrack">
        <t-card :title="'#' + (activeTrackIndex + 1) + $t('workbench.generate.generateText')" header-bordered class="videoPrompt">
          <template #actions>
            <t-button size="small" class="genTextbtn" :loading="currentTrack.state == '生成中'" @click="genText">
              {{ $t("workbench.generate.generateText") }}
            </t-button>
          </template>
          <div v-if="activeVariant?.reason" class="languageError">{{ activeVariant.reason }}</div>
          <div v-if="activeLanguage" class="languageHint">
            {{ languageName(activeLanguage) }} · {{ activeVariant?.state || "未生成" }} · 可编辑台词和提示词后再生成视频
          </div>
          <div class="promptData fc">
            <div class="promptInput" :inert="currentTrack.state === '生成中'" @focusout="handlePromptBlur">
              <promptEditor v-model="visiblePrompt" :references="references" :placeholder="$t('workbench.generate.promptPlaceholder')" />
            </div>
          </div>
        </t-card>
      </div>
      <div class="video">
        <videoCard
          v-if="currentTrack"
          :active-track-index="activeTrackIndex"
          :language="activeLanguage"
          :language-label="languageName(activeLanguage)"
          v-model:current-track="currentTrack"
          @refresh="getGenerateData"
          @generate="generateVideo" />
      </div>
    </div>
    <div class="track">
      <newTrack
        v-model:activeTrackIndex="activeTrackIndex"
        v-model="trackList"
        :image-list="imageList"
        @change="trackChange"
        :modelParmas="modelParmas"
        :clampDuration="clampDuration"
        :languages="selectedLanguages"
        :activeLanguage="activeLanguage"
        :languageName="languageName"
        :savePrompt="handlePromptBlur"
        @getData="getGenerateData" />
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
const { getCache, setCache, removeCache, initCacheFromTrackList, warmUpUrls } = cacheStore;
const { urlMap } = storeToRefs(cacheStore);

const modeOptions = ref<VideoModel>({
  name: "",
  modelName: "",
  durationResolutionMap: [],
  audio: false,
  type: "video",
  mode: [],
}); // 当前模型配置

const trackList = ref<TrackItem[]>([]); // 轨道列表

const modelParmas = ref<ModelSetting>({
  mode: "",
  model: "",
  resolution: "768p",
  duration: 8,
  audio: false,
});

const selectedLanguages = ref<string[]>([]);
const languageOptions = ref<{ value: string; label: string }[]>([]);
const activeLanguage = ref("");
const savingLanguages = ref(false);
let loadedLanguageSelection = false;
const dirtyPrompts = new Set<string>();
const activeVariant = computed(() => currentTrack.value?.variants?.find((v) => v.language === activeLanguage.value));
const availableLanguages = computed(() => [...new Set([...selectedLanguages.value, ...(currentTrack.value?.variants || []).map((v) => v.language)])]);
const languageName = (code: string) => languageOptions.value.find((v) => v.value === code)?.label || "原版（未标注语言）";
const visiblePrompt = computed({
  get: () => (activeLanguage.value ? activeVariant.value?.prompt || "" : currentTrack.value?.prompt || ""),
  set: (value: string) => {
    if (!currentTrack.value) return;
    dirtyPrompts.add(`${currentTrack.value.id}:${activeLanguage.value}`);
    if (!activeLanguage.value) currentTrack.value.prompt = value;
    else {
      currentTrack.value.variants ||= [];
      let variant = currentTrack.value.variants.find((v) => v.language === activeLanguage.value);
      if (!variant) {
        variant = { language: activeLanguage.value, prompt: "", state: "未生成" };
        currentTrack.value.variants.push(variant);
      }
      variant.prompt = value;
      variant.state = value.trim() ? "已完成" : "未生成";
    }
  },
});
async function saveLanguages(value: unknown) {
  const languages = value as string[];
  if (!languages.length) return window.$message.warning("请至少选择一种对白语言");
  savingLanguages.value = true;
  try {
    const { data } = await axios.post("/production/workbench/saveDialogueLanguages", {
      projectId: project.value?.id,
      scriptId: episodesId.value ?? 0,
      languages,
    });
    selectedLanguages.value = data;
    if (!activeLanguage.value) activeLanguage.value = data[0];
  } catch (e: any) {
    window.$message.error(e?.message || "对白语言保存失败");
  } finally {
    savingLanguages.value = false;
  }
}
const storyboardList = ref<StoryboardItem[]>([]); // 分镜列表

/** 排序优先级：assets有图=0，storyboard有图=1，无图=2 */
function getImageItemPriority(item: UploadItem): number {
  if (item.src) return item.sources === "assets" ? 0 : 1;
  return 2;
}

const imageList = computed({
  get(): UploadItem[] {
    // 触发对 urlMap 的依赖追踪，当 warmUpUrls 更新 urlMap 后自动重新计算
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    urlMap.value;
    const trackId = currentTrack.value?.id;
    const pid = project.value?.id;
    const sid = episodesId.value;
    // 优先从缓存读取
    if (pid != null && sid != null && trackId != null) {
      const cached = getCache(pid, sid, trackId);

      if (cached?.length) {
        return [...cached].sort((a, b) => getImageItemPriority(a) - getImageItemPriority(b));
      }
    }
    const medias = currentTrack.value?.medias;
    if (!medias?.length) return [];
    return [...(medias as UploadItem[])].sort((a, b) => getImageItemPriority(a) - getImageItemPriority(b));
  },
  set(val: UploadItem[]) {
    if (currentTrack.value) {
      currentTrack.value.medias = val as any;
      // 同步写入缓存
      const pid = project.value?.id;
      const sid = episodesId.value;
      const trackId = currentTrack.value.id;
      if (pid != null && sid != null && trackId != null) {
        setCache(pid, sid, trackId, val);
      }
    }
  },
});

function modeChange(newVal: string) {
  if (newVal == modelParmas.value.mode) return;
  if ((imageList.value.length || currentTrack.value?.prompt) && modelParmas.value.mode) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.generate.modeChange"),
      body: $t("workbench.generate.modeChangeConfirm"),
      confirmBtn: $t("settings.generate.modelChnageSure"),
      cancelBtn: $t("settings.memory.msg.cancel"),
      onConfirm: async () => {
        imageList.value = [];
        currentTrack.value.prompt = "";
        dialog.destroy();
        modelParmas.value.mode = newVal;
      },
    });
  } else if (newVal) {
    modelParmas.value.mode = newVal;
  }
}
const modeList = computed(() => {
  const modeLabelMap: Record<string, string> = {
    singleImage: "单图",
    startEndRequired: "首尾帧",
    endFrameOptional: "尾帧可选",
    startFrameOptional: "首帧可选",
    text: "文本生视频",
    videoReference: "视频",
    imageReference: "图片",
    audioReference: "音频",
    textReference: "文本",
  };
  function parseRefLabel(m: string): string {
    const match = m.match(/^(videoReference|imageReference|audioReference|textReference):(\d+)$/);
    if (match) {
      const base = modeLabelMap[match[1]] || match[1];
      return `${base} ×${match[2]}`;
    }
    return modeLabelMap[m] || m;
  }
  return modeOptions.value.mode
    ? modeOptions.value.mode.map((mode) =>
        Array.isArray(mode)
          ? { value: JSON.stringify(mode), label: mode.map((m) => parseRefLabel(m)).join(" + ") + "参考" }
          : { value: mode, label: modeLabelMap[mode] || mode },
      )
    : [];
});
const currentTrack = computed({
  get() {
    return trackList.value[activeTrackIndex.value];
  },
  set(val) {
    trackList.value[activeTrackIndex.value] = val;
  },
});

/** 将时长限制在模型支持的范围内 */
function clampDuration(trackDuration: number): number {
  const drMap = modeOptions.value?.durationResolutionMap;
  if (Array.isArray(drMap) && drMap.length > 0 && drMap[0].duration?.length) {
    const durations = drMap[0].duration;
    return Math.max(Math.min(...durations), Math.min(trackDuration, Math.max(...durations)));
  }
  return trackDuration;
}
watch(
  () => modelParmas.value.model,
  (val) => {
    if (!val) {
      modeOptions.value = {
        name: "",
        modelName: "",
        durationResolutionMap: [],
        audio: false,
        type: "video",
        mode: [],
      };
      modelParmas.value.mode = "";
      return;
    }
    axios.post("/modelSelect/getModelDetail", { modelId: val }).then(({ data }) => {
      modeOptions.value = data;
      modelParmas.value.audio = data.audio === true || data.audio === "true" || data.audio == "optional";
      const drMap = data.durationResolutionMap;
      if (Array.isArray(drMap) && drMap.length > 0) {
        if (drMap[0].resolution?.length) modelParmas.value.resolution = drMap[0].resolution[0];
        if (drMap[0].duration?.length) modelParmas.value.duration = clampDuration(modelParmas.value.duration);
      }

      const currentParsed = parseMode(modelParmas.value.mode);
      const modeMatched =
        currentParsed !== null &&
        data.mode.some((m: VideoMode) => {
          if (Array.isArray(m) && Array.isArray(currentParsed)) {
            return JSON.stringify(m) === JSON.stringify(currentParsed);
          }
          return m == currentParsed;
        });
      if (!modeMatched) {
        const newMode = Array.isArray(data.mode[0]) ? JSON.stringify(data.mode[0]) : data.mode[0];
        modeChange(newMode);
      }
    });
  },
);
function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as ReferenceType[];
  } catch {
    return value as Exclude<VideoMode, ReferenceType[]>;
  }
  return value as Exclude<VideoMode, ReferenceType[]>;
}
/** uploadBox 作为 promptEditor 的引用预览 */
const references = computed(() => {
  function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
    if (!src) return "image";
    // 去掉 query 和 hash 部分
    const cleanSrc = src.split("?")[0].split("#")[0];
    const ext = cleanSrc.split(".").pop()?.toLowerCase() ?? "";

    if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
    if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
    return "image";
  }

  return imageList.value
    .filter((item) => item.src)
    .map((item) => ({
      type: getFileTypeByExt(item.src) as "image" | "video" | "audio" | "text",
      src: item.src ?? "",
    }));
});

async function getGenerateData() {
  const { data } = await axios.post("/production/workbench/getGenerateData", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
  });

  languageOptions.value = data.dialogueLanguages || [];
  selectedLanguages.value = data.selectedLanguages || [];
  if (!loadedLanguageSelection) {
    activeLanguage.value = selectedLanguages.value[0] || "";
    loadedLanguageSelection = true;
  }
  storyboardList.value = data.storyboardList;
  // 优先使用本地缓存，没有缓存则用后端数据并写入缓存
  const pid = project.value?.id;
  const sid = episodesId.value;
  if (pid != null && sid != null) {
    // 先将没有缓存的轨道写入缓存（保留已有本地编辑）
    initCacheFromTrackList(pid, sid, data.trackList);
    // 批量向后端请求文件路径对应的完整 URL
    await warmUpUrls(pid, sid);
    // 将本地缓存回写到 trackList，确保优先使用缓存数据（src 已解析为完整 URL）
    data.trackList.forEach((track: TrackItem) => {
      if (track.id == null) return;
      const cached = getCache(pid, sid, track.id);
      if (cached?.length) {
        track.medias = cached as unknown as TrackMedia[];
      }
    });
    // 整体赋值触发响应式
    trackList.value = [...data.trackList];
  }

  modelParmas.value.duration = clampDuration(data.trackList?.[activeTrackIndex.value]?.duration);
}
/** 提示词失焦时保存到后端 */
async function handlePromptBlur() {
  const trackId = currentTrack.value?.id;
  if (trackId == null || currentTrack.value?.state === "生成中") return;
  const language = activeLanguage.value || undefined;
  const prompt = visiblePrompt.value;
  const key = `${trackId}:${language || ""}`;
  if (!dirtyPrompts.has(key)) return;
  if (language && !activeVariant.value) return;
  try {
    await axios.post("/production/workbench/updateVideoPrompt", { id: trackId, prompt, language });
    if (currentTrack.value?.id === trackId && visiblePrompt.value === prompt) dirtyPrompts.delete(key);
  } catch (e: any) {
    window.$message.error(e?.message || "提示词保存失败");
    throw e;
  }
}

/** 单个轨道生成提示词 */
async function genText() {
  if (!selectedLanguages.value.length) return window.$message.warning("请先选择对白语言");
  await handlePromptBlur();
  const track = currentTrack.value;
  if (track.id == null || track.state === "生成中") return;
  let info: {
    id: number;
    sources: string;
    reference?: boolean;
    slotType?: Type;
    fileType?: "image" | "video" | "audio";
    prompt?: string;
  }[] = [];
  const currentTrackId = track.id;
  const requestedLanguages = [...selectedLanguages.value];
  // Use the exact same ordered list as video generation. H3 <Picture N> must match Runtime ref_image_N.
  const rawMedias = imageList.value as UploadItem[];
  if (modelParmas.value.mode == "text") {
    info = rawMedias.map((item) => ({
      id: item.id!,
      sources: item.sources,
      reference: Boolean(item.src),
      slotType: item.slotType,
      fileType: item.fileType,
      prompt: item.prompt,
    }));
  } else {
    const frameMode = ["startEndRequired", "endFrameOptional", "startFrameOptional"];
    const preSliced = frameMode.includes(modelParmas.value.mode)
      ? rawMedias.slice(0, 2)
      : modelParmas.value.mode === "singleImage"
        ? rawMedias.slice(0, 1)
        : rawMedias;
    const filtered = preSliced
      .filter((item) => typeof item.id === "number" && !isNaN(item.id))
      .map((item) => ({
        id: item.id!,
        sources: item.sources,
        reference: Boolean(item.src),
        slotType: item.slotType,
        fileType: item.fileType,
        prompt: item.prompt,
      }));
    if (frameMode.includes(modelParmas.value.mode)) info = filtered.slice(0, 2);
    else if (modelParmas.value.mode === "singleImage") info = filtered.slice(0, 1);
    else info = filtered;
  }
  track.state = "生成中";
  try {
    const { data } = await axios.post("/production/workbench/generateVideoPrompt", {
      projectId: project.value?.id,
      trackId: currentTrackId,
      languages: requestedLanguages,
      regenerate: true,
      info: info,
      model: modelParmas.value.model,
      mode: modelParmas.value.mode,
    });
    track.variants = data;
    const failures = data.filter((v: VideoPromptVariant) => requestedLanguages.includes(v.language) && v.state === "生成失败");
    track.state = failures.length ? "生成失败" : "已完成";
    if (failures.length) window.$message.error(failures.map((v: VideoPromptVariant) => `${languageName(v.language)}：${v.reason || "生成失败"}`).join("；"));
    else window.$message.success("所选语言提示词已更新，已有视频已保留");
    if (!activeLanguage.value) activeLanguage.value = selectedLanguages.value[0] || "";
  } catch (e) {
    track.state = "生成失败";
    window.$message.error((e as Error)?.message ?? "提示词生成失败");
  }
}
function trackChange(prevIndex?: number) {
  // 切换前：将旧轨道的 imageList 保存到缓存
  if (prevIndex != null) {
    const prevTrack = trackList.value[prevIndex];
    const pid = project.value?.id;
    const sid = episodesId.value;
    if (pid != null && sid != null && prevTrack?.id != null) {
      setCache(pid, sid, prevTrack.id, prevTrack.medias as unknown as UploadItem[]);
    }
  }
  // 切换后：从缓存恢复当前轨道的 imageList
  const pid = project.value?.id;
  const sid = episodesId.value;
  const curTrack = trackList.value[activeTrackIndex.value];
  if (pid != null && sid != null && curTrack?.id != null) {
    const cached = getCache(pid, sid, curTrack.id);
    if (cached) {
      curTrack.medias = cached as unknown as TrackMedia[];
    }
  }
  // imageList 是基于 currentTrack.medias 的计算属性，切换轨道后自动切换数据
  if (modelParmas.value.mode == "singleImage" && imageList.value.length > 1) {
    imageList.value = imageList.value.slice(0, 1);
  }
  modelParmas.value.duration = clampDuration(trackList.value?.[activeTrackIndex.value]?.duration);
}
/** 监听当前轨道的 medias 变化，实时同步到缓存 */
watch(
  () => currentTrack.value?.medias,
  (medias) => {
    if (!medias) return;
    const pid = project.value?.id;
    const sid = episodesId.value;
    const trackId = currentTrack.value?.id;
    if (pid != null && sid != null && trackId != null) {
      setCache(pid, sid, trackId, medias as unknown as UploadItem[]);
    }
  },
  { deep: true },
);

onMounted(() => {
  modelParmas.value.model = project.value?.videoModel || "";
  modelParmas.value.mode = project.value?.mode || "";
  getGenerateData();
  if (hasGenerateVideoIds.value && hasGenerateVideoIds.value.length) {
    startPoll();
  }
});
/** 单个轨道生成视频 */
async function generateVideo() {
  if (!selectedLanguages.value.length) return window.$message.warning("请先选择对白语言并生成提示词");
  if (!modelParmas.value.audio) return window.$message.warning("请开启声音后生成对白语言版本");
  await handlePromptBlur();
  const track = currentTrack.value;
  const languages = [...selectedLanguages.value];
  if (languages.some((language) => !track.variants?.some((v) => v.language === language && v.prompt.trim() && v.state === "已完成")))
    return window.$message.warning("请先生成并检查所有已选语言的提示词");
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.generateConfirm"),
    body: `将为当前视频段生成 ${languages.length} 个版本：${languages.map(languageName).join("、")}。`,
    onConfirm: async () => {
      dlg.destroy();
      try {
        const request = {
          projectId: project.value?.id,
          scriptId: episodesId.value,
          uploadData:
            modelParmas.value.mode === "text"
              ? []
              : (() => {
                  const frameMode = ["startEndRequired", "endFrameOptional", "startFrameOptional"];
                  const preSliced = frameMode.includes(modelParmas.value.mode)
                    ? imageList.value.slice(0, 2)
                    : modelParmas.value.mode === "singleImage"
                      ? imageList.value.slice(0, 1)
                      : imageList.value;
                  const filtered = preSliced
                    .filter((item) => Boolean(item.src) && typeof item.id === "number" && !isNaN(item.id))
                    .map((item) => ({
                      id: item.id,
                      sources: item.sources,
                      type: item.slotType ?? (item.fileType === "audio" ? "audioReference" : item.fileType === "video" ? "videoReference" : "imageReference"),
                      fileType: item.fileType,
                      prompt: item.prompt,
                    }));
                  if (frameMode.includes(modelParmas.value.mode)) return filtered.slice(0, 2);
                  if (modelParmas.value.mode === "singleImage") return filtered.slice(0, 1);
                  return filtered;
                })(),
          prompt: currentTrack.value.prompt,
          model: modelParmas.value.model,
          mode: modelParmas.value.mode,
          resolution: modelParmas.value.resolution,
          duration: modelParmas.value.duration,
          audio: modelParmas.value.audio,
          trackId: track.id,
        };
        const { data } = await axios.post("/production/workbench/batchGenerateVideo", {
          ...request,
          trackData: languages.map((language) => ({ trackId: track.id, language, prompt: "", duration: request.duration, uploadData: request.uploadData })),
        });
        window.$message.success($t("workbench.generate.generateStarted"));
        data.forEach((item: { videoId: number; language: string }) =>
          track.videoList.push({ id: item.videoId, language: item.language, state: "生成中", src: "" }),
        );
      } catch (e) {
        window.$message.error((e as any)?.message ?? "视频发起生成请求失败");
      } finally {
      }
    },
    onCancel: () => dlg.destroy(),
  });
}
let pollTimer: NodeJS.Timeout | null = null;
let promptPollTimer: NodeJS.Timeout | null = null;
function startPoll() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => getVideoList(), 3000);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
const hasGenerateVideoIds = computed(() => {
  return trackList.value
    .map((track) => {
      return track.videoList.filter((i) => i.state == "生成中").map((i) => i.id);
    })
    .flatMap((i) => i);
});
const hasGeneratePromptIds = computed(() => {
  const trackIds = trackList.value.filter((t) => t.state == "生成中").map((t) => t.id);
  return trackIds;
});
/** 查询所有视频列表，并检测生成完成/失败状态 */
async function getVideoList() {
  const { data } = await axios.post("/production/workbench/checkVideoStateList", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
    videoIds: hasGenerateVideoIds.value,
  });
  if (data && data.length) {
    data.forEach((item: { id: number; state: "生成中" | "未生成" | "已完成" | "生成失败"; src?: string; errorReason?: string }) => {
      for (const track of trackList.value) {
        const findData = track.videoList.find((i) => i.id == item.id);
        if (findData) {
          findData.state = item.state;
          findData.src = item?.src ?? "";
          findData.errorReason = item?.errorReason ?? "";
          break;
        }
      }
    });
  }
}
function startPromptPoll() {
  if (promptPollTimer !== null) return;
  promptPollTimer = setInterval(() => getTrackPromptList(), 3000);
}

function stopPromptPoll() {
  if (promptPollTimer) {
    clearInterval(promptPollTimer);
    promptPollTimer = null;
  }
}
/** 查询所有视频列表，并检测生成完成/失败状态 */
async function getTrackPromptList() {
  const { data } = await axios.post("/production/workbench/checkVideoPrompt", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
    trackIds: hasGeneratePromptIds.value,
  });
  if (data && data.length) {
    data.forEach(
      (item: { id: number; state: "生成中" | "未生成" | "已完成" | "生成失败"; prompt?: string; reason?: string; variants?: VideoPromptVariant[] }) => {
        const findData = trackList.value.find((t) => t.id == item.id);
        if (findData) {
          findData.state = item.state;
          findData.prompt = item?.prompt ?? "";
          findData.variants = item.variants || [];
          findData.reason = item?.reason ?? "";
          if (item.state === "生成失败") {
            window.$message.error(`提示词生成失败，${item.reason ?? "未知原因"}`);
          }
        }
      },
    );
  }
}
watch(
  () => hasGenerateVideoIds.value,
  (newVal) => {
    if (newVal && newVal.length > 0) {
      startPoll();
    } else {
      stopPoll();
    }
  },
);
watch(
  () => hasGeneratePromptIds.value,
  (newVal) => {
    if (newVal && newVal.length > 0) {
      startPromptPoll();
    } else {
      stopPromptPoll();
    }
  },
);
onUnmounted(() => {
  stopPoll();
  stopPromptPoll();
});
</script>

<style lang="scss" scoped>
.languagePanel {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px;
  background: var(--td-bg-color-container);
  border-radius: 8px;
}
.languagePanel span,
.languageHint {
  color: var(--td-text-color-secondary);
  font-size: 12px;
}
.languageTabs {
  overflow-x: auto;
  flex-shrink: 0;
}
.languageError {
  color: var(--td-error-color);
  padding: 8px 0;
}
.index {
  height: calc(100vh - 120px);
  gap: 16px;
  overflow-y: auto;
  .referenceImage {
  }
  .modelSelect {
  }
  .generate {
    flex: 1 0 320px;
    min-height: 320px;
    width: 100%;
    gap: 5px;
    .prompt {
      width: 50%;
      height: 100%;
      min-height: 0;
      .videoPrompt {
        width: 100%;
        height: 100%;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        :deep(.t-card__body) {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .promptData {
          width: 100%;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          .promptInput {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
          }
        }
      }
    }
    .video {
      width: 50%;
      height: 100%;
      min-height: 0;
    }
  }
  .track {
    flex-shrink: 0;
  }
}
</style>
