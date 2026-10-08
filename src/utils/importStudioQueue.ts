import type { Knex } from "knex";

export async function initStudioTables(db: Knex) {
  if (!await db.schema.hasTable("o_importBatch")) await db.schema.createTable("o_importBatch", t => {
    t.string("id").primary(); t.string("kind").notNullable(); t.string("name").notNullable();
    t.string("fingerprint").notNullable().unique(); t.text("assets").notNullable(); t.bigInteger("createdAt").notNullable();
  });
  if (!await db.schema.hasTable("o_importItem")) await db.schema.createTable("o_importItem", t => {
    t.string("id").primary(); t.string("batchId").notNullable().index(); t.integer("position").notNullable();
    t.text("spec").notNullable(); t.string("state").notNullable(); t.string("model"); t.text("error"); t.text("output");
  });
  // A restart must never automatically duplicate a provider job which may still be running.
  await db("o_importItem").whereIn("state", ["queued", "running"]).update({ state: "interrupted", error: "服务已重启，请检查 ComfyUI 队列后再重试" });
}

export class StudioQueue {
  private draining?: Promise<void>;
  private requested = false;
  constructor(private db: Knex, private run: (item: any) => Promise<string>) {}

  async enqueue(batchId: string, ids: string[], model: string) {
    const count = await this.db.transaction(async trx => {
      const rows = await trx("o_importItem").where({ batchId }).whereIn("id", ids);
      if (rows.length !== ids.length) throw new Error("所选条目不存在或不属于当前批次");
      return trx("o_importItem").where({ batchId }).whereIn("id", ids).whereIn("state", ["ready", "failed", "interrupted"])
        .update({ state: "queued", model, error: null });
    });
    this.start();
    return count;
  }

  start() {
    this.requested = true;
    if (!this.draining) this.draining = (async () => {
      do { this.requested = false; await this.drain(); } while (this.requested);
    })().catch(e => console.error("导入任务队列失败", e)).finally(() => { this.draining = undefined; });
  }

  async idle() { await this.draining; }

  private async drain() {
    while (true) {
      const item = await this.db("o_importItem").where({ state: "queued" }).orderBy("rowid").first();
      if (!item) return;
      const claimed = await this.db("o_importItem").where({ id: item.id, state: "queued" }).update({ state: "running" });
      if (!claimed) continue;
      try {
        const output = await this.run(item);
        await this.db("o_importItem").where({ id: item.id }).update({ state: "succeeded", output, error: null });
      } catch (e) {
        await this.db("o_importItem").where({ id: item.id }).update({ state: "failed", error: (e as Error).message || String(e) });
      }
    }
  }
}
