import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transform } from "sucrase";
import test from "node:test";

const source = readFileSync(new URL("../data/vendor/comfyui_local.ts", import.meta.url), "utf8");
const reference = { type: "image", base64: "data:image/png;base64,cGFyZW50" };
const config = { prompt: "Preserve the original design, change only the requested state.", aspectRatio: "16:9", size: "1K" };

function fixture({ missingLoader = false, oldEncoder = false, uploadFails = false } = {}) {
  const calls = { graphs: [], uploads: [], requests: [] };
  const info = Object.fromEntries(["EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage", "LoadImage"].map(name => [name, {}]));
  if (missingLoader) delete info.LoadImage;
  info.TextEncodeQwenImage21 = oldEncoder ? {} : { input: { required: { images: ["COMFY_AUTOGROW_V3"] } }, output: ["CONDITIONING", "CONDITIONING", "LATENT"] };
  for (const [node, field, name] of [
    ["UNETLoader", "unet_name", "qwen_image_2.1_int8_convrot.safetensors"],
    ["CLIPLoader", "clip_name", "qwen3vl_8b_int8_convrot.safetensors"],
    ["VAELoader", "vae_name", "qwen_image_2.1_vae_bf16.safetensors"],
  ]) info[node] = { input: { required: { [field]: [[name]] } } };
  const sandbox = {
    exports: {}, Buffer,
    FormData: class { values = []; append(...args) { this.values.push(args); } getHeaders() { return {}; } },
    axios: {
      get: async url => ({ data: url.endsWith("/system_stats") ? { system: { comfyui_version: "test" } } : info }),
      post: async (url, form) => {
        assert.ok(url.endsWith("/upload/image")); calls.uploads.push(form.values);
        if (uploadFails) throw new Error("upload unavailable");
        return { data: { name: `reference-${calls.uploads.length}.png`, subfolder: "inputs" } };
      },
    },
    fetch: async (url, options) => {
      calls.requests.push(url);
      if (url.endsWith("/prompt")) {
        calls.graphs.push(JSON.parse(options.body).prompt);
        return { ok: true, json: async () => ({ prompt_id: "job-1" }) };
      }
      assert.ok(url.endsWith("/history/job-1"));
      return { ok: true, json: async () => ({ "job-1": { status: { status_str: "success" }, outputs: { "8": { images: [{ filename: "result.png" }] } } } }) };
    },
    pollTask: async fn => fn(),
  };
  vm.runInNewContext(transform(source, { transforms: ["typescript", "imports"] }).code, sandbox);
  return { calls, run: (input = config, modelName = "qwen-image-2.1-local") => sandbox.exports.imageRequest(input, { modelName }), vendor: sandbox.exports.vendor };
}

test("Qwen uploads the complete reference and connects image conditioning and the matching latent to the sampler", async () => {
  const f = fixture();
  await f.run({ ...config, referenceList: [reference] });
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.calls.uploads[0][0][1].toString(), "parent");
  const graph = f.calls.graphs[0];
  assert.equal(graph["10"].class_type, "LoadImage");
  assert.equal(graph["10"].inputs.image, "inputs/reference-1.png");
  assert.deepEqual(graph["4"].inputs["images.image_1"], ["10", 0]);
  assert.deepEqual(graph["4"].inputs.vae, ["3", 0]);
  assert.deepEqual(graph["6"].inputs.positive, ["4", 0]);
  assert.deepEqual(graph["6"].inputs.latent_image, ["4", 2]);
  assert.ok(!Object.values(graph).some(node => node.class_type === "EmptyLatentImage"));
  assert.ok(f.vendor.models.find(m => m.modelName === "qwen-image-2.1-local").mode.includes("singleImage"));
});

test("Qwen preserves reference order for multi-image edits", async () => {
  const f = fixture(); await f.run({ ...config, referenceList: [reference, reference] });
  assert.equal(f.calls.uploads.length, 2);
  assert.deepEqual(f.calls.graphs[0]["4"].inputs["images.image_2"], ["11", 0]);
});

test("base designs without references still use text-to-image", async () => {
  const f = fixture(); await f.run();
  assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.calls.graphs[0]["5"].class_type, "EmptyLatentImage");
  assert.deepEqual(f.calls.graphs[0]["6"].inputs.latent_image, ["5", 0]);
});

for (const options of [{ missingLoader: true }, { oldEncoder: true }, { uploadFails: true }]) {
  test(`reference failure never submits a text-only fallback: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run({ ...config, referenceList: [reference] }));
    assert.equal(f.calls.graphs.length, 0);
  });
}

test("invalid or excessive references fail before uploading or submitting", async () => {
  for (const refs of [[{ ...reference, base64: "" }], Array(17).fill(reference), [{ ...reference, type: "video" }]]) {
    const f = fixture(); await assert.rejects(f.run({ ...config, referenceList: refs }), /参考图/);
    assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.graphs.length, 0);
  }
});

test("FLUX cannot silently discard reference images", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...config, referenceList: [reference] }, "flux-schnell-local"), /仅支持文生图/);
  assert.equal(f.calls.requests.length, 0);
});
