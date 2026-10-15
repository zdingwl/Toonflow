import assert from 'node:assert/strict';
import test from 'node:test';
import {buildStoryboardContext,directorSceneBeatRows,storyboardRoleParentMap,storyboardTemperature,storyboardOutputTokenLimit} from '../src/agents/productionAgent/storyboardContext';
test('分镜首轮得到完整导演执行、当前场原文、真实资产及前场完整状态',()=>{
 const script='场景一 甲板（0–5秒）\n艾娃\n拉我。\n场景二 水下（5–10秒）\n艾娃\n回去。';
 const plan='完整导演内容\n| 场次 | 制作预算（秒） |\n|---|---|\n| Sc1 | 5 |\n| Sc2 | 7 |\n最终手部与倒计时时间省略';
 const previous='先前完整分镜'+'.'.repeat(1000)+'同一条伤腿';
 const text=buildStoryboardContext(script,plan,2,[{id:9,name:'艾娃',type:'role'}],previous);
 assert.ok(text.includes(plan));assert.ok(text.includes(previous));
 assert.ok(text.includes('回去。'));assert.ok(!text.includes('拉我。'));
 assert.match(text,/'?target_duration'?"?: 7/);assert.match(text,/"id": 9/);
 assert.match(text,/手机预测功能/);assert.match(text,/不能只写在备注/);
});

test('父子角色映射同时支持本集嵌套资产与平面真实行，场景和道具不作角色状态',()=>{
 const base={id:10,type:'role',assetsId:null};
 const child={id:11,type:'role',assetsId:10};
 const other={id:20,type:'角色',assetsId:null};
 const scene={id:30,type:'scene',assetsId:null,derive:[{id:31,type:'scene',assetsId:30}]};
 const props={id:40,type:'tool',assetsId:null};
 assert.deepEqual(storyboardRoleParentMap([{...base,derive:[child]},other,scene,props]),{10:10,11:10,20:20});
 assert.deepEqual(storyboardRoleParentMap([base,child,other,scene,props]),{10:10,11:10,20:20});
 const context=buildStoryboardContext('场1：室内','',1,[{...base,derive:[child]},scene,props]);
 assert.match(context,/程序角色状态映射/);assert.match(context,/"11": 10/);
});
test('分镜采用稳定温度和充足默认输出预算，同时尊重显式较低限制',()=>{
 assert.equal(storyboardTemperature(1),0.3);assert.equal(storyboardTemperature(0.1),0.1);
 assert.equal(storyboardOutputTokenLimit(0),12000);assert.equal(storyboardOutputTokenLimit(5000),5000);
});
test('本场执行节拍保留完整时段负载且不混入相邻场次',()=>{
 const first='| B1 | 0–5 | 门前 | 揭示 | 同框看门 | 5秒 |';
 const current=['| B1 | 0–2 | 新闻 | 触发 | 并行城市 | 2秒 |','| B2 | 2–9 | 系统 | 条件 | 四行累计保留 | 7秒，末行3秒 |'];
 const last='| B1 | 0–4 | 离开 | 行动 | 转身 | 4秒 |';
 const plan=`#### Sc1：门前\n${first}\n#### Sc2：室内\n${current.join('\n')}\n#### Sc3：室外\n${last}`;
 assert.deepEqual(directorSceneBeatRows(plan,2),current);
 assert.deepEqual(directorSceneBeatRows(plan,4),[]);
 const context=buildStoryboardContext('场景二 室内\n角色甲\n知道了。',plan,2,[]);
 const selected=context.split('【本场必须落实的导演节拍原表】')[1].split('【先排执行时间线再写镜头】')[0];
 for(const row of current)assert.ok(selected.includes(row));
 assert.ok(!selected.includes(first));assert.ok(!selected.includes(last));
});
