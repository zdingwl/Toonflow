import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAssetVisualDesignSkill } from "@/utils/assetVisualDesignSkill";
import { extractScriptAssets } from "@/utils/scriptAssetExtraction";

const router = express.Router();

// Research basis for the extraction fields below (reviewed 2026-09-28):
// - Hupu 2024 ACG survey: appearance 74%, persona 62%, clothing 44%; visual
//   homogenization is disliked by 46% of respondents.
//   https://pdf.dfcfw.com/pdf/H3_AP202408231639428587_1.pdf
// - iiMedia 2025 mobile-game survey: functional clothing and practical
//   accessories lead virtual-item preferences at 42.97%.
//   https://www.iimedia.cn/c400/105621.html
const assetExtractionDesignRules = `
【资产描述审美设计规则｜高于旧提取模板中的宽泛要求】

资产 desc 不是剧情摘要，而是后续图片生成的稳定视觉设计依据。先保留剧本明确事实，再对未规定但生成图片所必需的外观做审美化设计补全；不得加入剧情动作、台词、镜头、临时表情或未来状态。

角色：
- 不只写“漂亮、帅气、身材好”。每个角色 desc 必须落到可观察字段：脸型与下颌、眉眼鼻唇关系、视线气质、发型整体轮廓与发束、体型剪影、服装大轮廓、功能结构、主辅色、材质和一至两个稳定识别点。
- 先根据身份与性格从 asset_visual_design.md 选择合适的女性或男性视觉原型，再补足未规定字段。成年女性主角保留健康成熟曲线与清楚腰臀轮廓，成年男性主角保留俊朗骨相、宽肩收腰和运动型胸背；具体强度服从职业、性格与衣装，不把所有角色套成同一张网红脸、同一种发型或同一种身材。
- 发型必须有可辨认的大轮廓，服装必须同时具备身份功能和审美剪影；每套衣装至少写一个大轮廓、一个功能结构和一个克制识别点，不用无关紧身、裸露、镂空、开叉、绑带或装饰堆砌代替设计。
- 未成年、儿童或年龄无法确认的角色禁止使用成人胸腰臀、性感或裸露设计；按年龄与身份采用自然、得体的外观。剧本明确的年龄、族裔、肤色、体型、伤病、职业和朴素形象始终优先。
- 基础角色 desc 只记录稳定身份和默认衣装；觉醒、湿身、受伤、换装、红眼、发光等持续变化留给衍生状态，不混入基础描述。

场景：
- 场景 desc 只记录可复用的纯环境：空间拓扑、出入口、前中后景、固定建筑和陈设、基准材质、天气与默认光线。具名人物、人影、动物、怪物、独立生物、车辆/船只等可独立资产及其动作不得写进场景 desc。
- 在不改变剧本地点功能的前提下，按网络幻想概念设计提升审美：设置一个清晰视觉地标或主构图中心，强化纵深、尺度反差、轮廓节奏、色彩层次、氛围光和幻想细节，使画面具有网文封面/精品幻想动画的第一眼吸引力，避免普通库存照片、房地产样板间和无重点的物件堆砌。
- 不把所有场景套成同一种蓝紫霓虹；色彩、材质和奇观必须服务题材与地点身份。基础场景只写默认状态，末日损毁、夜景、暴雨、堆满物资等跨镜头稳定变化交给场景衍生状态，不把互斥状态合并。

道具与生物：
- desc 只记录稳定外形、结构、材质、颜色和识别特征；按网络幻想资产设计强化轮廓、材质对比与标志性细节。持握、攻击、飞驰、张口咬击等瞬时动作不写成永久外形。
`.trim();


const extractingProjects = new Set<number>();

export default router.post(
  "/",
  validateFields({
    scriptIds: z.array(z.number()).min(1),
    projectId: z.number(),
    groupSize: z.number().int().min(1).optional(),
    updateExistingDescriptions: z.boolean().optional(),
  }),
  async (req, res) => {
    const { projectId, groupSize, updateExistingDescriptions = false } = req.body;
    const scriptIds: number[] = req.body.scriptIds;
    if (extractingProjects.has(projectId)) return res.status(409).send(error("当前项目正在提取资产，请完成后再操作"));
    extractingProjects.add(projectId);
    try {
      const scripts = await u.db("o_script").where({ projectId }).whereIn("id", [...new Set(scriptIds)]).select("id");
      if (scripts.length !== new Set(scriptIds).size) throw new Error("剧本不存在或不属于当前项目");
      const project = await u.db("o_project").where({ id: projectId }).first();
      if (!project) throw new Error("项目不存在");
      const template = await u.db("o_prompt").where({ type: "scriptAssetExtraction" }).first();
      const system = (template?.useData || template?.data || "") + "\n\n" + getAssetVisualDesignSkill() + "\n\n" + assetExtractionDesignRules
        + "\n项目画风：" + (project.artStyle || "") + "\n当前 resultTool 的字段结构优先于旧模板。";
      await u.db("o_script").where({ projectId }).whereIn("id", scriptIds).update({ extractState: 0, errorReason: null });
      res.send(success("开始提取资产"));
      void extractScriptAssets({
        db: u.db, invoke: input => u.Ai.Text("universalAi").invoke(input), system,
      }, { projectId, scriptIds, groupSize, updateExistingDescriptions }).catch(async cause => {
        await u.db("o_script").where({ projectId }).whereIn("id", scriptIds).update({ extractState: -1, errorReason: u.error(cause).message });
      }).finally(() => extractingProjects.delete(projectId));
    } catch (cause) {
      extractingProjects.delete(projectId);
      return res.status(400).send(error(u.error(cause).message));
    }
  },
);
