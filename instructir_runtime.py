"""Lazy-loaded InstructIR wrapper.

Loads the InstructIR model (~62 MB of weights + a language model over HF Hub)
on first call and caches it. Every call takes a PIL image + a natural-language
instruction and returns the restored image.

Model is CPU-only unless CUDA is available; either way we resize the input
down to a manageable size before inference to keep latency reasonable.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

import numpy as np
import torch
import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models" / "instructir"
SRC_DIR = ROOT / "models" / "instructir_src"

_lock = threading.Lock()
_state = None  # populated by load_model()


def _prepare_paths():
    if str(SRC_DIR) not in sys.path:
        sys.path.insert(0, str(SRC_DIR))


def load_model():
    global _state
    if _state is not None:
        return _state
    with _lock:
        if _state is not None:
            return _state
        if not MODEL_DIR.is_dir() or not SRC_DIR.is_dir():
            raise RuntimeError(
                "InstructIR files not found. Expected "
                f"{MODEL_DIR} (weights) and {SRC_DIR} (source)."
            )

        _prepare_paths()
        from utils import dict2namespace, seed_everything
        from models import instructir as instructir_mod
        from text.models import LanguageModel, LMHead

        with (SRC_DIR / "configs" / "eval5d.yml").open("r") as f:
            cfg = dict2namespace(yaml.safe_load(f))

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        model = instructir_mod.create_model(
            input_channels=cfg.model.in_ch,
            width=cfg.model.width,
            enc_blks=cfg.model.enc_blks,
            middle_blk_num=cfg.model.middle_blk_num,
            dec_blks=cfg.model.dec_blks,
            txtdim=cfg.model.textdim,
        )
        model.load_state_dict(
            torch.load(str(MODEL_DIR / "im_instructir-7d.pt"), map_location=device, weights_only=False),
            strict=True,
        )
        model.to(device).eval()

        language_model = LanguageModel(model=cfg.llm.model)
        lm_head = LMHead(
            embedding_dim=cfg.llm.model_dim,
            hidden_dim=cfg.llm.embd_dim,
            num_classes=cfg.llm.nclasses,
        )
        lm_head.load_state_dict(
            torch.load(str(MODEL_DIR / "lm_instructir-7d.pt"), map_location=device, weights_only=False),
            strict=True,
        )
        lm_head.to(device).eval()
        seed_everything(SEED=42)

        _state = {
            "model": model, "lm": language_model, "head": lm_head,
            "cfg": cfg, "device": device,
        }
    return _state


def run(pil_image: Image.Image, instruction: str, *, max_size: int = 1024) -> Image.Image:
    """Restore ``pil_image`` following ``instruction``. Returns an RGB PIL image."""
    state = load_model()
    device = state["device"]

    img = pil_image.convert("RGB")
    ow, oh = img.size
    scaled = False
    m = max(ow, oh)
    if m > max_size:
        scale = max_size / m
        img = img.resize((max(1, int(ow * scale)), max(1, int(oh * scale))), Image.LANCZOS)
        scaled = True

    arr = np.asarray(img, dtype=np.float32) / 255.0
    y = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)

    with torch.no_grad():
        lm_embd = state["lm"](instruction)
        # LanguageModel may return a torch tensor already; move if needed.
        if hasattr(lm_embd, "to"):
            lm_embd = lm_embd.to(device)
        text_embd, _ = state["head"](lm_embd)
        x_hat = state["model"](y, text_embd)

    out = x_hat[0].permute(1, 2, 0).clip(0, 1).detach().cpu().numpy()
    out8 = (out * 255.0 + 0.5).astype(np.uint8)
    restored = Image.fromarray(out8, mode="RGB")

    if scaled:
        # Upscale back so the caller can composite it against the original if desired.
        restored = restored.resize((ow, oh), Image.LANCZOS)
    return restored
