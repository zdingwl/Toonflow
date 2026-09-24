type ReferenceType = "videoReference" | "imageReference" | "audioReference" | "textReference";
type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
type VideoMode = "singleImage" | "startEndRequired" | "endFrameOptional" | "startFrameOptional" | "text" | ReferenceType[];
type H3RoleView = "BOARD" | "FACE" | "FRONT" | "SIDE" | "BACK";
type H3ReferenceMode = "board" | "auto" | "manual";
type H3ShotView = "front" | "side" | "back" | "turn" | "closeup";

interface UploadItemBase {
  fileType: "image" | "video" | "audio";
  id: number | null;
  src?: string;
  prompt?: string;
  slotType?: Type;
  h3ReferenceMode?: H3ReferenceMode;
  h3Views?: H3RoleView[];
  h3ShotView?: H3ShotView;
}

interface UploadItemStoryboard extends UploadItemBase {
  sources: "storyboard";
  index: number;
}
interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}
interface UploadItemAssets extends UploadItemBase {
  sources: "assets";
}

type UploadItem = UploadItemStoryboard | UploadItemAssets;

interface StoryboardItem {
  src: string;
  createTime?: number | null;
  duration?: string | null;
  flowId?: number | null;
  id: number;
  index: number;
  projectId?: number | null;
  prompt?: string | null;
  reason?: string | null;
  scriptId?: number | null;
  state?: string | null;
  trackId?: number | null;
  videoDesc?: string | null;
}

interface TrackItem {
  id: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  selectVideoId?: number | null;
  medias: TrackMedia[];
  videoList: VideoItem[];
  duration: number;
  h3DialogueLocale?: string;
  h3ReferenceMode?: H3ReferenceMode;
  h3ShotView?: H3ShotView;
  h3Views?: H3RoleView[];
}

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  errorReason?: string | null;
}
interface TrackMediaBase {
  src: string;
  id?: number;
  prompt?: string;
  fileType: "image" | "video" | "audio";
  slotType?: Type;
  index?: number;
  h3ReferenceMode?: H3ReferenceMode;
  h3Views?: H3RoleView[];
  h3ShotView?: H3ShotView;
}

interface TrackMediaStoryboard extends TrackMediaBase {
  sources: "storyboard";
  index?: number;
}

interface TrackMediaAssets extends TrackMediaBase {
  sources: "assets";
}

interface TrackMediaUnknown extends TrackMediaBase {
  sources?: string;
}

type TrackMedia = TrackMediaStoryboard | TrackMediaAssets | TrackMediaUnknown;

interface HistoryVideoItem {
  errorReason?: string | null;
  src: string;
  id: number;
  duration?: number | string | null;
  projectId?: number | null;
  scriptId?: number | null;
  state?: string | null;
  time?: number | null;
  videoTrackId?: number | null;
}
interface ModelSetting {
  mode: string;
  model: string;
  resolution: string;
  duration: number;
  audio: boolean;
  dialogueLocale?: string;
  h3ReferenceMode?: H3ReferenceMode;
  h3ShotView?: H3ShotView;
  h3Views?: H3RoleView[];
}
