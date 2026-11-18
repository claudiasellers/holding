#!/usr/bin/env python3
"""LoRA fine-tune on this machine, then export to Ollama (one tag per archetype).

  finetune.py plan                  print the exact commands (no training). Safe to show anyone.
  finetune.py train [--backend mlx|unsloth] [--base PATH]
  finetune.py export                fuse -> Ollama model; create holding-<archetype>:latest tags
  finetune.py webllm                convert fused weights for WebLLM (phone/browser), same arch as base

Backends
  mlx      Apple Silicon (M1+). pip install mlx-lm
  unsloth  NVIDIA CUDA.         pip install unsloth   (falls back to plain PEFT+TRL if unsloth missing)
Network is locked to loopback the whole time; run fetch_base.py first to get base weights.
"""
import argparse
import json
import math
import platform
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import privacy_guard as pg

HERE = Path(__file__).resolve().parent


def paths(cfg, base_override=None):
    v = pg.vault_path()
    tag = cfg["finetune"]["output_tag"]
    base = Path(base_override) if base_override else v / "models" / "base" / cfg["models"]["finetune_base_hf"].split("/")[-1]
    out = v / "models" / tag
    return v, base, out, tag


def pick_backend(explicit):
    if explicit:
        return explicit
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "mlx"
    if shutil.which("nvidia-smi"):
        return "unsloth"
    sys.exit("No Apple Silicon or NVIDIA GPU found. LoRA on CPU is impractical; use RAG + persona prompts instead.")


def n_train(v):
    p = v / "datasets" / "train.jsonl"
    if not p.exists():
        sys.exit("datasets/train.jsonl missing: run make_dataset.py first")
    return sum(1 for l in p.read_text().splitlines() if l.strip())


def mlx_cmds(cfg, v, base, out):
    ft = cfg["finetune"]
    bs = 2
    iters = max(50, math.ceil(ft["epochs"] * n_train(v) / bs))
    lora_cfg = out / "mlx_lora.yaml"
    lora_yaml = textwrap.dedent(f"""\
        lora_parameters:
          rank: {ft['rank']}
          scale: {ft['alpha'] / ft['rank']}
          dropout: 0.05
          keys: ["self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj", "self_attn.o_proj", "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"]
        """)
    train = [sys.executable, "-m", "mlx_lm", "lora", "--model", str(base), "--train", "--data", str(v / "datasets"),
             "--adapter-path", str(out / "adapters"), "--iters", str(iters), "--batch-size", str(bs),
             "--learning-rate", str(ft["lr"] / 2), "--max-seq-length", str(ft["max_seq_len"]),
             "--num-layers", "-1", "--mask-prompt", "--grad-checkpoint", "-c", str(lora_cfg)]
    fuse = [sys.executable, "-m", "mlx_lm", "fuse", "--model", str(base), "--adapter-path", str(out / "adapters"),
            "--save-path", str(out / "fused"), "--dequantize"]
    return lora_cfg, lora_yaml, train, fuse


UNSLOTH_SCRIPT = '''\
import sys; sys.path.insert(0, {here!r})
import privacy_guard  # noqa: F401  network locked before any ML import
try:
    from unsloth import FastLanguageModel
    USE_UNSLOTH = True
except Exception:
    USE_UNSLOTH = False
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

BASE, OUT, L = {base!r}, {out!r}, {L}
if USE_UNSLOTH:
    model, tok = FastLanguageModel.from_pretrained(BASE, max_seq_length=L, load_in_4bit=True, local_files_only=True)
    model = FastLanguageModel.get_peft_model(model, r={r}, lora_alpha={a}, lora_dropout=0,
        target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
        use_gradient_checkpointing="unsloth")
else:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model
    tok = AutoTokenizer.from_pretrained(BASE, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map="auto", local_files_only=True)
    model = get_peft_model(model, LoraConfig(r={r}, lora_alpha={a}, lora_dropout=0.05, task_type="CAUSAL_LM",
        target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]))

ds = load_dataset("json", data_files={{"train": {train!r}, "validation": {valid!r}}})
args = SFTConfig(output_dir=OUT + "/ckpt", per_device_train_batch_size=2, gradient_accumulation_steps=4,
    num_train_epochs={epochs}, learning_rate={lr}, logging_steps=10, save_strategy="no", eval_strategy="epoch",
    report_to="none", max_length=L, bf16=True)
trainer = SFTTrainer(model=model, processing_class=tok, train_dataset=ds["train"], eval_dataset=ds["validation"], args=args)
trainer.train()
print({{"train_loss": trainer.state.log_history[-1].get("train_loss")}})
if USE_UNSLOTH:
    model.save_pretrained_merged(OUT + "/fused", tok, save_method="merged_16bit")
else:
    model = model.merge_and_unload(); model.save_pretrained(OUT + "/fused"); tok.save_pretrained(OUT + "/fused")
'''


def cmd_plan(a):
    cfg = pg.load_config()
    v, base, out, tag = paths(cfg, a.base)
    be = pick_backend(a.backend)
    plan = {"backend": be, "base_present": base.exists(), "output_tag": tag, "n_train": n_train(v)}
    if be == "mlx":
        _, _, train, fuse = mlx_cmds(cfg, v, base, out)
        plan["train_cmd"] = " ".join(train).replace(str(v), "$VAULT")
        plan["fuse_cmd"] = " ".join(fuse).replace(str(v), "$VAULT")
    else:
        plan["train_cmd"] = f"{sys.executable} $VAULT/models/{tag}/train_unsloth.py"
    # report() truncates long strings; print plan commands verbatim since they contain no content
    print(json.dumps(plan, indent=2))


def cmd_train(a):
    cfg = pg.load_config()
    v, base, out, tag = paths(cfg, a.base)
    pg.assert_private_dir(v)
    if not base.exists():
        sys.exit(f"base weights missing at models/base/{base.name}: run fetch_base.py")
    out.mkdir(parents=True, exist_ok=True)
    be = pick_backend(a.backend)
    log = open(out / "train.log", "w")
    if be == "mlx":
        lora_cfg, lora_yaml, train, fuse = mlx_cmds(cfg, v, base, out)
        lora_cfg.write_text(lora_yaml)
        for c in (train, fuse):
            r = subprocess.run(c, stdout=log, stderr=subprocess.STDOUT)
            if r.returncode:
                sys.exit(f"step failed ({c[3]}); see models/{tag}/train.log (local only)")
    else:
        ft = cfg["finetune"]
        script = out / "train_unsloth.py"
        script.write_text(UNSLOTH_SCRIPT.format(here=str(HERE), base=str(base), out=str(out), L=ft["max_seq_len"],
                                                r=ft["rank"], a=ft["alpha"], epochs=ft["epochs"], lr=ft["lr"],
                                                train=str(v / "datasets/train.jsonl"), valid=str(v / "datasets/valid.jsonl")))
        r = subprocess.run([sys.executable, str(script)], stdout=log, stderr=subprocess.STDOUT)
        if r.returncode:
            sys.exit(f"training failed; see models/{tag}/train.log (local only)")
    losses = _losses(out / "train.log")
    pg.report({"trained": True, "backend": be, "fused": (out / "fused").exists(), **losses})


def _losses(log: Path):
    import re
    t = log.read_text(errors="ignore") if log.exists() else ""
    tr = [float(x) for x in re.findall(r"[Tt]rain loss[\"':= ]+([0-9.]+)", t)]
    va = [float(x) for x in re.findall(r"(?:[Vv]al(?:idation)? loss|eval_loss)[\"':= ]+([0-9.]+)", t)]
    return {"first_train_loss": tr[0] if tr else None, "last_train_loss": tr[-1] if tr else None,
            "last_val_loss": va[-1] if va else None}


def _archetypes(v):
    d = v / "archetypes"
    return [json.loads(p.read_text()) for p in sorted(d.glob("*.json"))] if d.exists() else []


def cmd_export(a):
    cfg = pg.load_config()
    v, base, out, tag = paths(cfg, a.base)
    fused = out / "fused"
    if not fused.exists():
        sys.exit("no fused model: run train first")
    if not shutil.which("ollama"):
        sys.exit("ollama CLI not found")
    quant = cfg["finetune"]["quant"].upper().replace("Q4_K_M", "q4_K_M").replace("Q8_0", "q8_0")
    created = []
    mf = out / "Modelfile"
    mf.write_text(f"FROM {fused}\nPARAMETER temperature 0.7\nPARAMETER num_ctx 8192\n")
    r = subprocess.run(["ollama", "create", f"{tag}:latest", "-f", str(mf), "--quantize", quant],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode:
        gguf = _llama_cpp_gguf(fused, out, cfg["finetune"]["quant"])
        mf.write_text(f"FROM {gguf}\nPARAMETER temperature 0.7\nPARAMETER num_ctx 8192\n")
        subprocess.run(["ollama", "create", f"{tag}:latest", "-f", str(mf)], check=True, stdout=subprocess.DEVNULL)
    created.append(f"{tag}:latest")
    for arch in _archetypes(v):
        persona = (arch.get("persona") or "").replace('"""', "'''")
        amf = out / f"Modelfile.{arch['id']}"
        amf.write_text(f'FROM {tag}:latest\nSYSTEM """{persona}"""\n')
        subprocess.run(["ollama", "create", f"holding-{arch['id']}:latest", "-f", str(amf)], check=True,
                       stdout=subprocess.DEVNULL)
        created.append(f"holding-{arch['id']}:latest")
    pg.report({"ollama_tags_created": created})


def _llama_cpp_gguf(fused, out, quant):
    import os
    lc = Path(os.environ.get("LLAMA_CPP_DIR", "~/llama.cpp")).expanduser()
    conv = lc / "convert_hf_to_gguf.py"
    qbin = shutil.which("llama-quantize") or str(lc / "build/bin/llama-quantize")
    if not conv.exists():
        sys.exit("Ollama could not import this architecture directly and llama.cpp was not found. "
                 "Clone llama.cpp and set LLAMA_CPP_DIR, then re-run export.")
    f16 = out / "model-f16.gguf"
    q = out / f"model-{quant}.gguf"
    subprocess.run([sys.executable, str(conv), str(fused), "--outfile", str(f16), "--outtype", "f16"], check=True,
                   stdout=subprocess.DEVNULL)
    subprocess.run([qbin, str(f16), str(q), quant.upper()], check=True, stdout=subprocess.DEVNULL)
    f16.unlink()
    return q


def cmd_webllm(a):
    cfg = pg.load_config()
    v, base, out, tag = paths(cfg, a.base)
    fused = out / "fused"
    if not shutil.which("mlc_llm"):
        sys.exit("pip install mlc-llm (nightly wheels from mlc.ai) first")
    dst = out / f"{tag}-q4f16_1-MLC"
    subprocess.run(["mlc_llm", "convert_weight", str(fused), "--quantization", "q4f16_1", "-o", str(dst)], check=True,
                   stdout=subprocess.DEVNULL)
    subprocess.run(["mlc_llm", "gen_config", str(fused), "--quantization", "q4f16_1", "--conv-template", "qwen2",
                    "-o", str(dst)], check=True, stdout=subprocess.DEVNULL)
    pg.report({"webllm_weights": f"models/{tag}/{dst.name}",
               "model_lib": "reuse WebLLM's prebuilt wasm for the base model (same architecture)",
               "base_lib_hint": cfg["models"].get("mobile_webllm_lib")})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "train", "export", "webllm"])
    ap.add_argument("--backend", choices=["mlx", "unsloth"])
    ap.add_argument("--base")
    a = ap.parse_args()
    {"plan": cmd_plan, "train": cmd_train, "export": cmd_export, "webllm": cmd_webllm}[a.cmd](a)
