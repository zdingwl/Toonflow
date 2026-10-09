import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildAssetExtractionTemplateContext, getAssetExtractionVisualDesignSkill } from "@/utils/assetVisualDesignSkill";
import { extractScriptAssets } from "@/utils/scriptAssetExtraction";
import fs from "fs";
import { buildAssetExtractionArtContext } from "@/utils/assetPrompt";

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
- 角色 desc 写清脸型、眉眼鼻唇、妆发轮廓、体型剪影和完整衣装，不只写“漂亮、帅气”。按用户美型目标设计明确五官与搭配，各角色有辨识度，不退回通用脸或灰衫灰裤；美术选择不是剧本事实。
- 核对原文性别及原文明示或 userConstraints 中用户明确确认的年龄；任一来源明确本角色已满18岁即可按成人设计，用户确认保存在 userConstraints，不伪称 scriptFacts 的原文年龄。不得由姓名、姐姐称呼、驾驶或交易猜年龄、成年或职业。
- 衣装按当前资产设计Skill落实成年女主默认方向及用户强度，原文明示朴素、职业、装备与伤病状态优先；美术选择不编家世财富职业。各人有不同轮廓材质，鞋型不一律浅口细跟或靴子。成人JK/洛丽塔仅指服装，不改学生或幼态。已确认成年且用户要求轻性感时装时按目标设计，不自动改回保守衣装；轻性感不是上限，要求更性感/不够性感须实质提高剪裁强度，不靠饰品换色，保持正常覆盖与中性站姿。首饰包袋有主次、不强制全套，不新增工具腰带或胸牌。
- 未成年、儿童或年龄无法确认（原文和用户均未确认成年）的角色禁止使用成人胸腰臀、性感或裸露设计；剧本明确年龄、身份、外形和朴素设定优先，与用户成年设定冲突时待确认。
- 原文与用户均无年龄依据时，不写“成年”或具体年龄。scriptFacts 只收原文直接明示事实，不收用户补充的年龄与衣装设计；称呼、场景署名不扩成年龄、产权或照护责任。最终只输出一套设计，不输出可选清单或人生背景。
- 基础角色 desc 只记录稳定身份和默认衣装；觉醒、湿身、受伤、换装、红眼、发光等持续变化留给衍生状态，不混入基础描述。

场景：
- 场景 desc 只记录可复用的纯环境：空间拓扑、出入口、前中后景、固定建筑和陈设、基准材质、天气与默认光线。具名人物、人影、动物、怪物、独立生物、车辆/船只等可独立资产及其动作不得写进场景 desc。
- 在不改变剧本地点功能、时代和空间关系的前提下，按当前项目媒介与题材进行场景美术设计：设置一个清晰视觉地标或主构图中心，强化纵深、轮廓节奏、色彩层次和材质身份。幻想细节、奇观或夸张尺度仅在剧本或当前项目美术方向允许时补足；日常地点也应有明确设计重点，不用幻想封面效果改写普通生活空间。
- 不把所有场景套成同一种蓝紫霓虹；色彩、材质和奇观必须服务题材与地点身份。基础场景只写默认状态，末日损毁、夜景、暴雨、堆满物资等跨镜头稳定变化交给场景衍生状态，不把互斥状态合并。

道具与生物：
- desc 只记录稳定外形、结构、材质、颜色和识别特征；按当前项目媒介、题材与资产功能强化轮廓、材质对比与标志性细节，不默认加入幻想装饰或特效。持握、攻击、飞驰、张口咬击等瞬时动作不写成永久外形。
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
      const templateContext = buildAssetExtractionTemplateContext(template);
      const prefixPath = u.getPath(["skills", "art_skills", project.artStyle || "", "prefix.md"]);
      const artContext = fs.existsSync(prefixPath) ? buildAssetExtractionArtContext(fs.readFileSync(prefixPath, "utf-8")) : "";
      const discoverySystem = templateContext.discoverySystem + "\n当前步骤只发现实体与关联，不补全外观；当前 resultTool 的字段结构为准。";
      // The default template governs discovery. Design already has its complete
      // field/evidence contract in extractScriptAssets; preserve custom instructions
      // verbatim without loading the default discovery rules a second time.
      const system = templateContext.designSystem + "\n\n" + getAssetExtractionVisualDesignSkill() + "\n\n" + assetExtractionDesignRules
        + "\n项目画风标识：" + (project.artStyle || "") + (artContext ? "\n\n" + artContext : "")
        + "\n当前 resultTool 的字段结构优先于旧模板。";
      await u.db("o_script").where({ projectId }).whereIn("id", scriptIds).update({ extractState: 0, errorReason: null });
      res.send(success("开始提取资产"));
      void extractScriptAssets({
        db: u.db, invoke: input => u.Ai.Text("universalAi").invoke(input), system, discoverySystem,
      }, { projectId, scriptIds, groupSize, updateExistingDescriptions }).catch(async cause => {
        await u.db("o_script").where({ projectId }).whereIn("id", scriptIds).update({ extractState: -1, errorReason: u.error(cause).message });
      }).finally(() => extractingProjects.delete(projectId));
    } catch (cause) {
      extractingProjects.delete(projectId);
      return res.status(400).send(error(u.error(cause).message));
    }
  },
);
