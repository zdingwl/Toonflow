#!/usr/bin/env python3
"""Local-only Qwen3 reranker service for Toonflow.

Prerequisites (install into your own Windows Python environment):
  pip install "sentence-transformers>=5.4.0" "transformers>=4.51.0" torch

Place the current official model files under data/models/Qwen3-Reranker-4B
or set TOONFLOW_RERANKER_MODEL_DIR to another local directory.
"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = "127.0.0.1"
PORT = int(os.getenv("TOONFLOW_RERANKER_PORT", "11435"))
ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.getenv("TOONFLOW_RERANKER_MODEL_DIR", ROOT / "data" / "models" / "Qwen3-Reranker-4B")).resolve()
DEVICE = os.getenv("TOONFLOW_RERANKER_DEVICE", "cuda")
MAX_DOCS = int(os.getenv("TOONFLOW_RERANKER_MAX_DOCS", "100"))
MAX_CHARS = int(os.getenv("TOONFLOW_RERANKER_MAX_CHARS", "24000"))
BATCH_SIZE = max(1, int(os.getenv("TOONFLOW_RERANKER_BATCH_SIZE", "4")))
PROMPT = os.getenv(
    "TOONFLOW_RERANKER_PROMPT",
    "Retrieve the memories that are most relevant to the user's current request.",
)

_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()


def load_model():
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model
        if not MODEL_DIR.is_dir():
            raise RuntimeError(f"本地 Reranker 模型目录不存在: {MODEL_DIR}")

        try:
            import torch
            from sentence_transformers import CrossEncoder
        except ImportError as exc:
            raise RuntimeError(
                '缺少本地依赖，请安装 sentence-transformers>=5.4.0、transformers>=4.51.0 和 torch'
            ) from exc

        kwargs: dict[str, Any] = {
            "device": DEVICE,
            "local_files_only": True,
            "trust_remote_code": False,
            "max_length": 8192,
            "prompts": {"toonflow": PROMPT},
            "default_prompt_name": "toonflow",
        }
        if DEVICE.startswith("cuda") and torch.cuda.is_available():
            kwargs["automodel_args"] = {"torch_dtype": torch.bfloat16}

        try:
            _model = CrossEncoder(str(MODEL_DIR), **kwargs)
        except TypeError as exc:
            raise RuntimeError(
                "当前 sentence-transformers 版本不支持 Qwen3 Reranker 的 prompt 配置，请升级到 5.4.0 或更高版本"
            ) from exc
        return _model


class Handler(BaseHTTPRequestHandler):
    server_version = "ToonflowReranker/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[reranker]", fmt % args)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/health":
            try:
                model = load_model()
                self.send_json(200, {
                    "ok": True,
                    "modelDir": str(MODEL_DIR),
                    "device": DEVICE,
                    "loaded": model is not None,
                    "batchSize": BATCH_SIZE,
                    "maxDocs": MAX_DOCS,
                })
            except Exception as exc:
                self.send_json(503, {"ok": False, "error": str(exc)})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/rerank":
            self.send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                raise ValueError("请求体大小无效")

            body = json.loads(self.rfile.read(length).decode("utf-8"))
            query = str(body.get("query", "")).strip()
            documents = body.get("documents")
            top_n = int(body.get("top_n", 5))
            if not query:
                raise ValueError("query 不能为空")
            if not isinstance(documents, list) or not documents or len(documents) > MAX_DOCS:
                raise ValueError(f"documents 必须为 1-{MAX_DOCS} 条")

            docs = [str(item)[:MAX_CHARS] for item in documents]
            top_n = max(1, min(top_n, len(docs)))
            pairs = [(query, doc) for doc in docs]

            model = load_model()
            with _infer_lock:
                scores = model.predict(
                    pairs,
                    batch_size=BATCH_SIZE,
                    show_progress_bar=False,
                )

            ranked = sorted(
                ({"index": index, "score": float(score)} for index, score in enumerate(scores)),
                key=lambda item: item["score"],
                reverse=True,
            )[:top_n]
            self.send_json(200, {"results": ranked})
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})


if __name__ == "__main__":
    print(f"[reranker] model={MODEL_DIR}")
    print(f"[reranker] device={DEVICE}")
    print(f"[reranker] batch_size={BATCH_SIZE}")
    print(f"[reranker] listening=http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
