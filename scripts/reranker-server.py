#!/usr/bin/env python3
"""Local-only Qwen3 reranker service for Toonflow.

Prerequisites (install into your own Windows Python environment):
  pip install torch sentence-transformers

Place the model under data/models/Qwen3-Reranker-4B or set
TOONFLOW_RERANKER_MODEL_DIR to another local directory.
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
            raise RuntimeError("缺少本地依赖，请安装 torch 和 sentence-transformers") from exc

        kwargs: dict[str, Any] = {
            "device": DEVICE,
            "local_files_only": True,
            "trust_remote_code": False,
            "max_length": 8192,
        }
        if DEVICE.startswith("cuda") and torch.cuda.is_available():
            # Qwen3 Reranker 官方权重适合 BF16；失败时退回库默认精度。
            try:
                kwargs["automodel_args"] = {"torch_dtype": torch.bfloat16}
                _model = CrossEncoder(str(MODEL_DIR), **kwargs)
            except TypeError:
                kwargs.pop("automodel_args", None)
                _model = CrossEncoder(str(MODEL_DIR), **kwargs)
        else:
            _model = CrossEncoder(str(MODEL_DIR), **kwargs)
        return _model


class Handler(BaseHTTPRequestHandler):
    server_version = "ToonflowReranker/1.0"

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
                self.send_json(200, {"ok": True, "modelDir": str(MODEL_DIR), "device": DEVICE, "loaded": model is not None})
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
            instruction = str(body.get("instruction", "")).strip()
            if not query:
                raise ValueError("query 不能为空")
            if not isinstance(documents, list) or not documents or len(documents) > MAX_DOCS:
                raise ValueError(f"documents 必须为 1-{MAX_DOCS} 条")
            docs = [str(item)[:MAX_CHARS] for item in documents]
            top_n = max(1, min(top_n, len(docs)))
            prompt_query = f"{instruction}\n{query}" if instruction else query

            model = load_model()
            pairs = [(prompt_query, doc) for doc in docs]
            with _infer_lock:
                scores = model.predict(pairs)
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
    print(f"[reranker] listening=http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
