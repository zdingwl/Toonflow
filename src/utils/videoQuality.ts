import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import getPath from "@/utils/getPath";

const execFileAsync = promisify(execFile);

export async function inspectVideoQuality(userPath: string) {
  const localPath = path.join(getPath("oss"), userPath.replace(/^[/\\]+/, "").split("/").join(path.sep));
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,bit_rate:format=duration,bit_rate", "-of", "json", localPath]);
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams?.[0] || {};
    const [num, den] = String(stream.r_frame_rate || "0/1").split("/").map(Number);
    return {
      width: Number(stream.width) || null,
      height: Number(stream.height) || null,
      fps: den ? num / den : null,
      bitrate: Number(stream.bit_rate || parsed.format?.bit_rate) || null,
      codec: stream.codec_name || null,
      actualDuration: Number(parsed.format?.duration) || null,
    };
  } catch {
    return {};
  }
}
