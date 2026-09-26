import test from "node:test";
import assert from "node:assert/strict";
import { expandH3AssetSlots } from "../src/utils/h3ReferenceSlots";

const role = (id: number, name = `角色${id}`) => ({ id, type: "role", name });
const views = (items: ReturnType<typeof expandH3AssetSlots>, id: number) => items.filter(item => item.id === id).map(item => item._referenceRole);

test("each character board uses one slot even with side/back actions and stale crop hints", () => {
  const input = [{...role(1), filePath:'board.png', _referenceRole:'FACE', referenceKind:'FACE'}, role(2), {id:3,type:'scene'}, {id:4,type:'tool'}];
  const before = structuredClone(input);
  const slots = expandH3AssetSlots(input as any, '角色1侧身；角色2背对镜头');
  assert.equal(slots.length,4);
  assert.deepEqual(slots.map(s=>s.id),[1,2,3,4]);
  assert.equal(slots[0].filePath,'board.png');
  assert.ok(slots.every(s=>!s._referenceRole && !s.referenceKind));
  assert.deepEqual(input,before);
});
test("nine characters fit nine slots and ten distinct assets fail",()=>{
  assert.equal(expandH3AssetSlots(Array.from({length:9},(_,id)=>role(id))).length,9);
  assert.throws(()=>expandH3AssetSlots(Array.from({length:10},(_,id)=>role(id))),/10 个独立图片资产/);
});
test("deduplicate assets and exclude storyboard and non-image inputs",()=>{
  const slots=expandH3AssetSlots([role(1),role(1),{id:2,type:'scene',_reference:false},{id:3,_type:'storyboard'},{id:4,type:'audio'},{id:5,type:'tool',fileType:'video'},{id:6,type:'tool',referenceType:'audioReference'}]);
  assert.deepEqual(slots.map(s=>s.id),[1]);
});
