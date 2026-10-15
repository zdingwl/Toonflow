import assert from "node:assert/strict";
import test from "node:test";
import { syncCommittedDerivedAsset } from "../Toonflow-web-master/src/utils/productionDerivedAssets.ts";

const payload = { assetsId: 10, id: 11, name: "角色湿身", describe: "黑裙保持原款，仅衣料湿透。" };

test("a committed revision updates the next agent read while preserving generated media", () => {
  const existing = {
    assetsId: 10, id: 11, name: "旧名称", type: "role", desc: "错误裤管",
    prompt: "已付费的历史提示词", src: "/assets/completed.png", state: "已完成",
    flowId: 22, errorReason: "历史记录",
  };
  const assets = [{ id: 10, type: "role", derive: [existing] }];
  const mediaBefore = { prompt: existing.prompt, src: existing.src, state: existing.state, flowId: existing.flowId, errorReason: existing.errorReason };

  assert.equal(syncCommittedDerivedAsset(assets, payload), "updated");
  assert.equal(assets[0].derive[0], existing);
  assert.equal(existing.id, 11);
  assert.equal(existing.assetsId, 10);
  assert.equal(existing.name, payload.name);
  assert.equal(existing.type, assets[0].type);
  assert.equal(existing.desc, payload.describe);
  assert.deepEqual({ prompt: existing.prompt, src: existing.src, state: existing.state, flowId: existing.flowId, errorReason: existing.errorReason }, mediaBefore);
  // getFlowData serializes this same cache before returning it to subsequent agents.
  assert.equal(JSON.parse(JSON.stringify({ assets })).assets[0].derive[0].desc, payload.describe);
});

test("a new committed asset is attached when the parent has no derive array", () => {
  const assets = [{ id: 10, type: "role" }];
  assert.equal(syncCommittedDerivedAsset(assets, payload), "added");
  assert.deepEqual(assets[0].derive, [{ assetsId: 10, id: 11, name: payload.name, type: "role", desc: payload.describe, prompt: "", state: "未生成", src: "" }]);
  assert.equal(syncCommittedDerivedAsset(assets, payload), "updated");
  assert.equal(assets[0].derive.length, 1);
});

test("a missing parent refuses synchronization without changing another asset", () => {
  const assets = [{ id: 20, type: "scene", derive: [] }];
  const before = structuredClone(assets);
  assert.equal(syncCommittedDerivedAsset(assets, payload), "missing");
  assert.deepEqual(assets, before);
});
