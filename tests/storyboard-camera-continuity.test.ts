import assert from "node:assert/strict";
import test from "node:test";
import { validateStoryboardScene } from "../src/agents/productionAgent/storyboardValidator";

function board(visual: string, camera = "固定", secondRow = "") {
  return `## 场1：测试场景
### 片段一（约6s）
**引用资产ID**：[1]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | ${visual} | ${secondRow ? 3 : 6} | 近景 | ${camera} | 无台词 | 环境音 |${secondRow}`;
}
const validate = (visual: string, camera?: string) => validateStoryboardScene(1, board(visual, camera), undefined, { targetDuration: 6, assetIds: [1] });

test("真实漏检表达：运镜中的并切到、时切到、快速硬切均拒绝，画面列同样保护", () => {
  for (const camera of [
    "贴近接触点小幅跟移，并切到两人面部关系后落回手部",
    "前1秒主观静止，数字2时切到外部眼部近景，数字1后快速推近并被白光覆盖",
    "快速硬切连接，最后一切回公寓艾娃的脸",
  ]) {
    const result = validate("角色保持同一外观", camera);
    assert.equal(result.valid, false); assert.match(result.errors.join("；"), /镜内切换/);
    assert.equal(validate(camera, "固定").valid, false);
  }
});

test("明确多机位、主客观交替和镜内插切不能用固定运镜掩盖", () => {
  for (const visual of [
    "先看到手部抓握，随后切入角色面部特写",
    "角色与对手正反打交替，分别表现两人反应",
    "主观视野与眼部特写交替承接",
    "多机位交替拍摄两人的动作",
    "先拍角色呼吸，再插切手机屏幕",
    "画面先跟随人物，再切换到另一机位",
  ]) assert.equal(validate(visual).valid, false, visual);
});

test("单设备内容更新不是切镜，文本中出现切换字样也不影响连续拍摄", () => {
  for (const [visual, camera] of [
    ["镜头固定拍手机，页面切换到银行账户页", "固定"],
    ["同一手机界面从银行页切换到房产资料页", "缓慢推近"],
    ["倒计时数字从【3】切到【2】，人物持续望着界面", "固定"],
    ["同一设备文字切换，图标保持原位", "固定"],
    ["在同一台设备内快速切换到银行账户、房产估值和车辆资料三个页面", "静止，焦点在手机页面与人物嘴唇之间轻微转换"],
    ["拇指在屏幕上连续切换三个资料页，人物持续核对", "静止特写拍手机三类页面切换，末尾轻拉到人物脸部与手机同框"],
    ["24–25s。同一台手机在设备内部切到房产估值页面，页面标题可识别", "静止，随手机页面切换轻微对焦"],
    ["25–26s。同一台手机再在设备内部切到车辆资料页面，页面标题可识别", "静止，落幅在车辆资料标题"],
    ["外部机位拍人物眼睛，同一蓝色系统文字保持在画面中", "固定机位，无推镜；蓝色系统叠层随3、2、1依次切换，结尾白光瞬间充满画面"],
    ["手机显示【切换视点】的按钮文字", "固定"],
    ["界面显示“切到下一机位”的教程文字", "固定"],
  ]) assert.equal(validate(visual, camera).valid, true, visual);
  assert.equal(validate("主观视野保持静止", "数字2时切到外部眼部近景").valid, false);
  assert.equal(validate("同一台手机在设备内部切到人物面部特写").valid, false);
});

test("否定不掩盖后续肯定切镜，连续移动与首帧切入保留", () => {
  for (const [visual, camera] of [
    ["角色保持站姿，不切到另一视点", "固定长镜头，不再切镜，无插切"],
    ["固定，不切入其他视点，仅界面切换", "固定"],
    ["避免通过硬切打断这次连续动作", "慢慢推近"],
    ["固定连续摄影，不采用多机位交替", "固定"],
    ["禁止正反打交替，始终固定同框", "固定"],
    ["主观与外部视点不交替，始终外部机位", "固定"],
    ["人物始终保持同一画面，记忆即将切入", "固定"],
    ["镜头开始切入甲板全景，人物持续行走", "固定跟移"],
    ["切入人物主观视野，保持同一观察方向", "固定"],
    ["从黑场切入公寓全景，角色从床上坐起", "缓慢推近"],
    ["角色始终处于同一画面", "切到公寓全景后固定"],
    ["角色始终处于同一画面", "从近景连续拉远为全景"],
  ]) assert.equal(validate(visual, camera).valid, true, `${visual} / ${camera}`);
  assert.equal(validate("不切到手机，随后切到人物眼部").valid, false);
});

test("末尾黑屏、白光与场景边界保留，中途切黑后回到另一视点仍拒绝", () => {
  for (const [visual, camera] of [
    ["角色说完台词，镜头末尾切到黑屏", "固定"],
    ["角色保持同一画面", "静止，末尾硬切黑屏"],
    ["角色保持同一画面", "最后白光硬切"],
    ["白光覆盖全画面，结束本场", "固定，结尾切入白光"],
    ["角色最后被白光覆盖，作为下场转场边界", "固定"],
  ]) assert.equal(validate(visual, camera).valid, true, `${visual} / ${camera}`);
  assert.equal(validate("先拍人物，硬切黑屏，随后切回不同机位").valid, false);
});

test("确需不同镜头时拆成独立行与独立预算可通过", () => {
  const split = board("角色手部近景持续抓握", "固定", "\n| 2 | 切入角色面部特写，持续表现迟疑 | 3 | 特写 | 固定 | 无台词 | 环境音 |");
  const result = validateStoryboardScene(1, split, undefined, { targetDuration: 6, assetIds: [1] });
  assert.equal(result.valid, true); assert.deepEqual(result.errors, []);
});

test("真实修订稿独立行首时间区间和独立标记是镜头边界，后续真实切镜仍被拦截", () => {
  for (const visual of [
    "17.5–19.5秒，切到人物面部近景：人物持续惊怒质问，机位固定",
    "19.5–22秒，独立切回手部近景：一只手仍承重，手指逐根松脱",
    "18–20s，切到人物面部近景：人物抬眼惊瞪，保持同一机位",
    "20–22s，切回手部与对手同框近景，镜头沿面部缓慢下摇到手部",
    "24.5–25s，切回上方倾斜甲板，镜头停在空栏杆与对手反应",
    "0-6s: 独立切入场景全景，人物始终在同一画面",
    "独立切回人物近景，机位固定",
  ]) assert.equal(validate(visual).valid, true, visual);
  for (const visual of [
    "18–20s，先拍手部，随后切到人物面部",
    "18–20s，独立切入人物主观视野，数字2时切到外部眼部近景",
    "前1秒主观静止，数字2时切到外部眼部近景",
    "17.5–19.5秒，切到人物面部，随后切回手部",
  ]) assert.equal(validate(visual).valid, false, visual);
});

test("真实记忆行首句点、记忆标记和单次硬切回是边界，硬切连接多镜仍拒绝", () => {
  for (const [visual, camera] of [
    ["12.8–13.9s。记忆切入城市楼宇与街道，灯光在同一画面熄灭", "静止起幅，轻微推近"],
    ["13.9–14.9s。记忆切到取水点，人群在同一画面争抢", "短促手持，在同一取水点横移"],
    ["14.9–16s。记忆切到前世水下，人物身体持续下沉", "缓慢下沉式跟拍"],
    ["16–17s。硬切回清晨公寓，人物始终坐在床边", "静止，记忆的水下闷响切回室内后轻微推近人物"],
    ["16–17秒.独立记忆切入水下远景，人物持续下沉", "固定"],
    ["独立记忆切到前世街道，灯光熄灭", "固定"],
    ["角色保持同一外观", "硬切到场景全景，随后连续推近"],
  ]) assert.equal(validate(visual, camera).valid, true, `${visual} / ${camera}`);
  for (const visual of [
    "12–16s。记忆切入城市后，随后硬切到抢水，再硬切到水下",
    "16–17s。硬切回公寓，随即硬切到角色眼部特写",
    "16–17s。快速硬切连接多个记忆镜头，最后静止在人物面部",
  ]) assert.equal(validate(visual).valid, false, visual);
});

test("明确音轨和闷响切换不当作相机切镜，声音伴随真实机位切换仍拦", () => {
  for (const camera of [
    "静止，记忆的水下闷响切回室内后轻微推近人物",
    "缓慢推近，音轨切换到室内环境音，画面仍然连续",
    "固定，声音切到房间背景声，人物保持同框",
  ]) assert.equal(validate("人物保持在同一画面", camera).valid, true, camera);
  assert.equal(validate("人物保持同一画面", "伴随水下闷响，随后切回另一外部机位").valid, false);
  assert.equal(validate("人物保持同一画面", "水下闷响切回室内，镜头随即切到人物眼部").valid, false);
});
