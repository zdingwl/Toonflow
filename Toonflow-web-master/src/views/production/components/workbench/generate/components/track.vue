<template>
  <div class="videoTrack"><t-card bordered :style="{ height: '100%' }">
    <div class="trackMenu f ac jb">
      <div class="left f ac">
        <t-checkbox v-model="checkAll" @change="handleCheckAll">{{ $t("workbench.generate.selectAll") }}</t-checkbox>
        <span class="selectedCount" v-if="checkedTrackIds.length">{{ $t("workbench.generate.selected") }} {{ checkedTrackIds.length }} 段</span>
      </div>
      <div class="right f ac">
        <t-button size="small" variant="outline" @click="batchDownloadVideo">{{ $t("workbench.generate.batchDownloadVideo") }}</t-button>
        <t-button size="small" variant="outline" @click="batchGenText" :loading="generateTextLoad">{{ $t("workbench.generate.batchGenerateText") }}</t-button>
        <t-button size="small" variant="outline" @click="batchGenVideo" :loading="generateVideoLoad">{{ $t("workbench.generate.batchGenerateVideo") }}</t-button>
      </div>
    </div>
    <div class="itemBox">
      <div class="item" :class="{ active: index === activeTrackIndex }" v-for="(track, index) in trackList" :key="track.id" @click="changeIndex(index)">
        <t-checkbox class="trackCheck" :checked="track.id != null && checkedTrackIds.includes(track.id)" @click.stop @change="(val: boolean) => toggleCheck(track.id, val)" />
        <t-tag class="indexTag" size="small">#{{ index + 1 }}</t-tag>
        <t-tag class="selectTag" theme="success" size="small" v-if="track.selectVideoId">已选择</t-tag>
        <div class="thumbGroup" v-if="track.selectVideoId && getSelectedVideoSrc(track)">
          <img v-if="videoCoverMap[getSelectedVideoSrc(track)!]" class="thumb selectedVideoThumb" :src="videoCoverMap[getSelectedVideoSrc(track)!]" draggable="false" />
          <div v-else class="thumb placeholder c"><i-video size="24" /></div>
        </div>
        <div class="thumbGroup" v-else-if="track.medias.some(m => m.src)">
          <template v-for="(m, i) in track.medias" :key="i"><template v-if="m.src">
            <t-image fit="cover" v-if="m.fileType === 'image'" :src="m.src" class="thumb" />
            <div v-else class="thumb placeholder c"><i-volume-notice v-if="m.fileType === 'audio'" size="20" /><i-video v-else size="24" /></div>
          </template></template>
        </div>
        <span v-else class="emptyTrack">{{ $t("workbench.generate.emptyTrack", { index: index + 1 }) }}</span>
        <div class="deleteBtn" @click.stop="confirmDeleteTrack(index)"><i-close size="14" /></div>
      </div>
      <div class="item addItem c" @click="addTrack"><i-plus size="36"></i-plus></div>
    </div>
  </t-card></div>
</template>
<script setup lang="ts">
import type { Ref } from "vue";
import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import imageListCacheStore from "@/stores/imageListCache";
import JSZip from "jszip";
import settingStore from "@/stores/setting";
const { otherSetting } = storeToRefs(settingStore());
const { project } = storeToRefs(projectStore());
const { removeCache } = imageListCacheStore();
const episodesId = inject<Ref<number>>("episodesId")!;
const props = defineProps<{ modelParmas: ModelSetting; imageList: UploadItem[]; clampDuration: (trackDuration: number) => number }>();
const activeTrackIndex = defineModel("activeTrackIndex", { default: 0 });
const checkedTrackIds = ref<number[]>([]);
const trackList = defineModel<TrackItem[]>({ default: () => [] });
const emit = defineEmits<{ getData: []; change: [prevIndex: number]; saveImageList: [trackId: number] }>();
const checkAll = ref(false);
const videoCoverMap = ref<Record<string,string>>({});
const isH3 = computed(() => /minimax/i.test(props.modelParmas.model) && /h3/i.test(props.modelParmas.model));
const h3Options = () => ({
  dialogueLocale: props.modelParmas.dialogueLocale || "original",
  h3ReferenceMode: props.modelParmas.h3ReferenceMode || "board",
  h3ShotView: props.modelParmas.h3ShotView || "front",
  h3Views: props.modelParmas.h3Views || ["BOARD"],
});
function getSelectedVideoSrc(track: TrackItem): string | null {
  if (!track.selectVideoId) return null;
  return track.videoList?.find(video => video.id === track.selectVideoId)?.src || null;
}
function captureVideoCover(src: string) {
  if (!src || videoCoverMap.value[src]) return;
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; video.preload = "auto"; video.muted = true; video.src = src;
  video.addEventListener("seeked", () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 160; canvas.height = video.videoHeight || 90;
      const context = canvas.getContext("2d");
      if (context) { context.drawImage(video, 0, 0, canvas.width, canvas.height); videoCoverMap.value[src] = canvas.toDataURL("image/jpeg", 0.7); }
    } catch { /* thumbnail is optional */ }
    video.src = "";
  }, { once: true });
  video.addEventListener("loadeddata", () => { video.currentTime = 0; }, { once: true });
  video.addEventListener("error", () => { video.src = ""; }, { once: true });
  video.load();
}
function changeIndex(index: number) {
  if (activeTrackIndex.value === index) return;
  const previous = activeTrackIndex.value; activeTrackIndex.value = index; emit("change", previous);
}
async function deleteTrack(index: number) {
  const track = trackList.value[index]; if (!track) return;
  await axios.post("/production/workbench/deleteTrack", { id: track.id });
  checkedTrackIds.value = checkedTrackIds.value.filter(id => id !== track.id);
  const pid = project.value?.id; const sid = episodesId.value;
  if (pid != null && sid != null && track.id != null) removeCache(pid, sid, track.id);
  if (activeTrackIndex.value >= trackList.value.length) activeTrackIndex.value = trackList.value.length - 1;
}
function confirmDeleteTrack(index: number) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.generate.del"), body: $t("workbench.generate.delConfirm"),
    confirmBtn: $t("settings.generate.delConfirmBtn"), cancelBtn: $t("settings.memory.msg.cancel"),
    onConfirm: async () => {
      try { await deleteTrack(index); window.$message.success($t("workbench.generate.delSuccess")); emit("getData"); }
      catch (cause: any) { window.$message.error(cause.message ?? "删除失败"); }
      finally { dialog.destroy(); }
    },
  });
}
async function addTrack() {
  const { data: modelData } = await axios.post("/modelSelect/getModelDetail", { modelId: props.modelParmas.model });
  const dr = modelData.durationResolutionMap;
  if (!Array.isArray(dr) || !dr.length || !dr[0].duration?.length) return;
  const { data } = await axios.post("/production/workbench/addTrack", {
    projectId: project.value?.id, scriptId: episodesId.value ?? 0, duration: dr[0].duration[0],
  });
  emit("getData"); activeTrackIndex.value = trackList.value.length - 1;
}
function getFileExtension(url: string): string { return url.split(".").pop()?.split(/[#?]/)[0] || "mp4"; }
async function batchDownloadVideo() {
  const zip = new JSZip();
  const tasks = trackList.value.filter(track => checkedTrackIds.value.includes(track.id)).map(track => {
    const video = track.videoList.find(item => item.id === track.selectVideoId);
    if (!video?.src) return null;
    return fetch(video.src).then(res => res.blob()).then(blob => zip.file(`分镜${track.id}.${getFileExtension(video.src)}`, blob))
      .catch(cause => console.error(`视频下载失败: ${video.src}`, cause));
  }).filter(Boolean);
  await Promise.all(tasks);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = `视频批量下载_${Date.now()}.zip`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  checkedTrackIds.value = []; checkAll.value = false;
}
function getTrackUploadInfo(track: TrackItem, filterEmpty = false) {
  const activeId = trackList.value[activeTrackIndex.value]?.id;
  const items = track.id === activeId ? props.imageList : track.medias;
  return items.filter(item => (!filterEmpty || Boolean(item.src)) && typeof item.id === "number" && !Number.isNaN(item.id)).map(item => ({
    id: item.id!, sources: item.sources ?? "storyboard", reference: Boolean(item.src),
    slotType: item.slotType, fileType: item.fileType, prompt: item.prompt,
    type: item.slotType ?? (item.fileType === "audio" ? "audioReference" : item.fileType === "video" ? "videoReference" : "imageReference"),
    h3ReferenceMode: item.h3ReferenceMode, h3Views: item.h3Views, h3ShotView: item.h3ShotView,
  }));
}
const generateTextLoad = ref(false);
async function batchGenText() {
  const checked = trackList.value.filter(track => checkedTrackIds.value.includes(track.id));
  if (!checked.length) return window.$message.warning("请先选择分镜片段");
  generateTextLoad.value = true;
  const trackData = checked.map(track => ({
    trackId: track.id, info: props.modelParmas.mode === "text" ? [] : getTrackUploadInfo(track),
    ...(isH3.value ? h3Options() : {}),
  }));
  checked.forEach(track => { track.state = "生成中"; });
  try {
    await axios.post("/production/workbench/batchGeneratePrompt", {
      projectId: project.value?.id, trackData, model: props.modelParmas.model, mode: props.modelParmas.mode,
      concurrentCount: otherSetting.value.assetsBatchGenereateSize,
      ...(isH3.value ? h3Options() : {}),
    });
    window.$message.success("开始生成提示词"); checkedTrackIds.value = []; checkAll.value = false;
  } catch (cause: any) {
    window.$message.error(cause?.message ?? "生成提示词失败");
    checked.forEach(track => { track.state = "生成失败"; });
  } finally { generateTextLoad.value = false; }
}
const generateVideoLoad = ref(false);
function batchGenVideo() {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.generate.generateConfirm"), body: $t("workbench.generate.generateVideosInBatches"),
    onConfirm: async () => {
      dialog.destroy();
      const checked = trackList.value.filter(track => checkedTrackIds.value.includes(track.id));
      if (checked.some(track => !track.prompt)) return window.$message.warning($t("workbench.generate.skipDataWithEmptyVideoPromptWords"));
      generateVideoLoad.value = true;
      const trackData = checked.map(track => ({
        duration: props.clampDuration(track.duration || props.modelParmas.duration), prompt: track.prompt,
        uploadData: props.modelParmas.mode === "text" ? [] : getTrackUploadInfo(track, true),
        trackId: track.id, ...(isH3.value ? h3Options() : {}),
      }));
      try {
        const { data } = await axios.post("/production/workbench/batchGenerateVideo", {
          projectId: project.value?.id, scriptId: episodesId.value, model: props.modelParmas.model,
          mode: props.modelParmas.mode, resolution: props.modelParmas.resolution,
          audio: Boolean(props.modelParmas.audio), trackData,
          ...(isH3.value ? h3Options() : {}),
        });
        const ids: Record<number,number> = {};
        data.forEach((item: { videoId: number; trackId: number }) => { ids[item.trackId] = item.videoId; });
        checked.forEach(track => { if (ids[track.id]) track.videoList.push({ id: ids[track.id], state: "生成中", src: "" }); });
        checkedTrackIds.value = []; checkAll.value = false;
        window.$message.success($t("workbench.generate.generateStarted"));
      } catch (cause: any) { window.$message.error(cause?.message ?? $t("workbench.generate.generateError")); }
      finally { generateVideoLoad.value = false; }
    },
    onCancel: () => dialog.destroy(),
  });
}
function handleCheckAll(checked: boolean) {
  checkedTrackIds.value = checked ? trackList.value.map(track => track.id).filter((id): id is number => id != null) : [];
}
function toggleCheck(trackId: number | undefined, checked: boolean) {
  if (trackId == null) return;
  if (checked) { if (!checkedTrackIds.value.includes(trackId)) checkedTrackIds.value.push(trackId); }
  else checkedTrackIds.value = checkedTrackIds.value.filter(id => id !== trackId);
  const all = trackList.value.map(track => track.id).filter((id): id is number => id != null);
  checkAll.value = all.length > 0 && all.every(id => checkedTrackIds.value.includes(id));
}
watch(() => trackList.value.map(track => ({ selectVideoId: track.selectVideoId, videoList: track.videoList })), () => {
  trackList.value.forEach(track => { const src = getSelectedVideoSrc(track); if (src) captureVideoCover(src); });
}, { deep: true, immediate: true });
</script>
<style lang="scss" scoped>
.videoTrack {
  width: 100%; overflow: hidden; display: flex; flex-direction: column;
  .trackMenu { margin-bottom: 10px; .selectedCount { font-size: 12px; color: var(--td-text-color-secondary); margin-left: 8px; } .right { gap: 8px; } }
  .itemBox { height: 150px; flex: 1; min-height: 0; width: 100%; display: flex; overflow-x: auto; gap: 10px; padding-bottom: 6px;
    &::-webkit-scrollbar { height: 6px; } &::-webkit-scrollbar-thumb { background: #696969; border-radius: 3px; }
    .item { border-radius: 8px; flex-shrink: 0; width: 200px; border: 1px solid var(--td-gray-color-3); overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center; position: relative;
      &.active { border-color: var(--td-brand-color); border-width: 2px; box-shadow: 0 0 0 3px rgba(var(--td-brand-color-rgb, 0, 82, 217), 0.25); background: linear-gradient(180deg, rgba(var(--td-brand-color-rgb, 0, 82, 217), 0.05) 0%, transparent 100%); }
      &:hover { filter: brightness(90%); }
      .indexTag { position: absolute; bottom: 4px; left: 4px; z-index: 2; }
      .selectTag { position: absolute; bottom: 4px; right: 4px; z-index: 1; }
      .thumbGroup { width: 100%; height: 100%; display: flex;
        .thumb { flex: 1; min-width: 0; height: 100%; object-fit: cover; }
        .placeholder { background: var(--td-bg-color-secondarycontainer); color: var(--td-text-color-placeholder); font-size: 12px; }
      }
      .emptyTrack { color: var(--td-text-color-placeholder); font-size: 12px; }
      .trackCheck { position: absolute; top: 4px; left: 4px; z-index: 2; }
      .deleteBtn { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; display: none; align-items: center; justify-content: center; cursor: pointer; z-index: 1;
        &:hover { background: rgba(0,0,0,0.8); }
      }
      &:hover .deleteBtn { display: flex; }
    }
    .addItem { border: 4px dashed var(--td-component-border); cursor: pointer; }
    .selectedVideoThumb { width: 100%; height: 100%; object-fit: cover; pointer-events: none; user-select: none; display: block; }
  }
}
</style>
