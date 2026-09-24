#!/usr/bin/env node
/**
 * Metadata QA for an exported MiniMax H3 HD video.
 * Usage: node scripts/qa-h3-hd.mjs path/to/output.mp4 [path/to/original.mp4]
 * Checks decodeable streams, dimensions, FPS, duration and presence of audio.
 * Motion flicker/face consistency require human viewing or a dedicated temporal model.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

function probe(filename) {
  if (!fs.existsSync(filename)) throw new Error(`视频文件不存在：${filename}`);
  let text;
  try {
    text = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate',
      '-of', 'json', filename,
    ], { encoding: 'utf8', timeout: 30000 });
  } catch (cause) {
    throw new Error(`无法通过 ffprobe 读取 ${filename}；请安装 FFmpeg/ffprobe 并加入 PATH。${cause.message}`);
  }
  const parsed = JSON.parse(text);
  const video = parsed.streams?.find(stream => stream.codec_type === 'video');
  const audio = parsed.streams?.some(stream => stream.codec_type === 'audio') || false;
  if (!video?.width || !video?.height) throw new Error(`${filename} 没有可用视频流`);
  const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    file: filename, width: video.width, height: video.height,
    fps: den ? num / den : 0, duration: Number(parsed.format?.duration),
    audio, codec: video.codec_name || 'unknown',
  };
}

function validate(hd, original) {
  const issues = [];
  if (hd.fps <= 0 || !Number.isFinite(hd.duration) || hd.duration <= 0) issues.push('视频帧率或时长无效');
  if (hd.width % 2 || hd.height % 2) issues.push('输出宽/高不是偶数，部分编码器可能不兼容');
  if (original) {
    if (Math.abs(hd.fps - original.fps) > 0.2) issues.push(`帧率发生变化：${original.fps} → ${hd.fps}`);
    if (Math.abs(hd.duration - original.duration) > 0.35) issues.push(`时长发生变化：${original.duration}s → ${hd.duration}s`);
    if (original.audio && !hd.audio) issues.push('原视频有音频，高清版缺失音频流');
    if (Math.min(hd.width, hd.height) <= Math.min(original.width, original.height)) issues.push('高清版短边没有比原版增加（如果 upscaleMode=off 则可忽略）');
    const srcRatio = original.width / original.height;
    if (Math.abs(hd.width / hd.height - srcRatio) / srcRatio > 0.02) issues.push('输出画幅比例与原视频相差超过2%');
  }
  return issues;
}

try {
  const [hdFile, originalFile] = process.argv.slice(2);
  if (!hdFile) {
    console.error('用法：node scripts/qa-h3-hd.mjs 高清视频.mp4 [H3原始视频.mp4]');
    process.exitCode = 2;
  } else {
    const hd = probe(hdFile);
    const original = originalFile ? probe(originalFile) : null;
    const issues = validate(hd, original);
    console.log(JSON.stringify({ hd, original, issues, metadataPassed: issues.length === 0 }, null, 2));
    if (issues.length) process.exitCode = 1;
    else console.log('元数据检查通过；仍需人工检查角色脸部、衣装、镜头连续性、水流闪烁及口型音画同步。');
  }
} catch (cause) {
  console.error(cause.message);
  process.exitCode = 1;
}
