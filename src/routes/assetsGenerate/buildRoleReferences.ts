import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

// Keep a non-mutating response for older clients instead of silently cropping again.
export default router.post("/", (_req, res) => {
  return res.status(410).send(error("已改用完整人物参考图，无需创建独立视图。请刷新页面，并重新生成旧版视频提示词。"));
});
