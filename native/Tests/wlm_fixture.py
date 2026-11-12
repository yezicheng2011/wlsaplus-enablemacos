#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Builds a tiny synthetic Qwen2-style GGUF model and the logits a correct
runtime must produce for it. The reference forward pass below is plain Python
written from the architecture description, independent of the C runtime.
Covers every tensor encoding the runtime reads: F32, F16, Q5_0, Q8_0, Q4_K, Q6_K.

usage: wlm_fixture.py OUTPUT_DIRECTORY
"""
import math
import pathlib
import random
import struct
import sys

E, HEADS, KV_HEADS, F, LAYERS = 32, 2, 1, 64, 2
D = E // HEADS
K = D * KV_HEADS
ROPE_BASE, EPS = 10000.0, 1e-6
rng = random.Random(20261112)


def byte_alphabet():
    extra, out = 0, []
    for b in range(256):
        if 33 <= b <= 126 or 161 <= b <= 172 or 174 <= b <= 255:
            out.append(chr(b))
        else:
            out.append(chr(256 + extra))
            extra += 1
    return out


ALPHABET = byte_alphabet()
MERGES = [("h", "e"), ("he", "l"), (ALPHABET[32], "he")]
TOKENS = ALPHABET + [a + b for a, b in MERGES] + ["<|endoftext|>", "<|im_start|>", "<|im_end|>"]
TYPES = [1] * (len(TOKENS) - 3) + [3, 3, 3]
V = len(TOKENS)
ID = {token: index for index, token in enumerate(TOKENS)}


def half(value):
    return struct.unpack("<e", struct.pack("<e", value))[0]


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def make_f32(count):
    values = [f32(rng.uniform(-0.6, 0.6)) for _ in range(count)]
    return struct.pack(f"<{count}f", *values), values


def make_f16(count):
    values = [half(rng.uniform(-0.6, 0.6)) for _ in range(count)]
    return struct.pack(f"<{count}e", *values), values


def make_q8_0(count):
    raw, values = b"", []
    for _ in range(count // 32):
        d = half(rng.uniform(0.002, 0.006))
        q = [rng.randint(-127, 127) for _ in range(32)]
        raw += struct.pack("<e32b", d, *q)
        values += [f32(d * x) for x in q]
    return raw, values


def make_q5_0(count):
    raw, values = b"", []
    for _ in range(count // 32):
        d = half(rng.uniform(0.01, 0.04))
        q = [rng.randint(0, 31) for _ in range(32)]
        high = sum(((q[i] >> 4) & 1) << i for i in range(32))
        nibbles = bytes((q[i] & 15) | ((q[i + 16] & 15) << 4) for i in range(16))
        raw += struct.pack("<eI", d, high) + nibbles
        values += [f32(d * (x - 16)) for x in q]
    return raw, values


def make_q4_k(count):
    raw, values = b"", []
    for _ in range(count // 256):
        d, dmin = half(rng.uniform(0.0005, 0.002)), half(rng.uniform(0.0005, 0.002))
        scales = [rng.randint(0, 63) for _ in range(8)]
        mins = [rng.randint(0, 63) for _ in range(8)]
        packed = bytearray(12)
        for j in range(4):
            packed[j] = (scales[j] & 63) | ((scales[j + 4] >> 4) << 6)
            packed[j + 4] = (mins[j] & 63) | ((mins[j + 4] >> 4) << 6)
            packed[j + 8] = (scales[j + 4] & 15) | ((mins[j + 4] & 15) << 4)
        q = [rng.randint(0, 15) for _ in range(256)]
        body = bytearray(128)
        for pair in range(4):
            for i in range(32):
                body[pair * 32 + i] = q[pair * 64 + i] | (q[pair * 64 + 32 + i] << 4)
        raw += struct.pack("<ee", d, dmin) + bytes(packed) + bytes(body)
        for sub in range(8):
            scale, offset = f32(d * scales[sub]), f32(dmin * mins[sub])
            values += [f32(f32(scale * q[sub * 32 + i]) - offset) for i in range(32)]
    return raw, values


def make_q6_k(count):
    raw, values = b"", []
    for _ in range(count // 256):
        d = half(rng.uniform(0.0002, 0.0008))
        scales = [rng.randint(-60, 60) for _ in range(16)]
        q = [rng.randint(0, 63) for _ in range(256)]
        low, high = bytearray(128), bytearray(64)
        for n in range(2):
            base = n * 128
            for i in range(32):
                a, b, c, e = q[base + i], q[base + 32 + i], q[base + 64 + i], q[base + 96 + i]
                low[n * 64 + i] = (a & 15) | ((c & 15) << 4)
                low[n * 64 + 32 + i] = (b & 15) | ((e & 15) << 4)
                high[n * 32 + i] = (a >> 4) | ((b >> 4) << 2) | ((c >> 4) << 4) | ((e >> 4) << 6)
        raw += bytes(low) + bytes(high) + struct.pack("<16b", *scales) + struct.pack("<e", d)
        for index in range(256):
            scale = scales[index // 16]
            values.append(f32(f32(d * scale) * (q[index] - 32)))
    return raw, values


ENCODERS = {0: make_f32, 1: make_f16, 6: make_q5_0, 8: make_q8_0, 12: make_q4_k, 14: make_q6_k}


def build_tensors():
    plan = [("token_embd.weight", V, E, 8), ("output_norm.weight", 1, E, 0), ("output.weight", V, E, 0)]
    for layer in range(LAYERS):
        p = f"blk.{layer}."
        plan += [(p + "attn_norm.weight", 1, E, 0), (p + "attn_q.weight", E, E, 6), (p + "attn_q.bias", 1, E, 0),
                 (p + "attn_k.weight", K, E, 8), (p + "attn_k.bias", 1, K, 0), (p + "attn_v.weight", K, E, 14),
                 (p + "attn_v.bias", 1, K, 0), (p + "attn_output.weight", E, E, 12), (p + "ffn_norm.weight", 1, E, 0),
                 (p + "ffn_gate.weight", F, E, 1), (p + "ffn_up.weight", F, E, 6), (p + "ffn_down.weight", E, F, 8)]
    tensors = {}
    for name, rows, cols, kind in plan:
        raw, values = ENCODERS[kind](rows * cols)
        tensors[name] = (rows, cols, kind, raw, values)
    return plan, tensors


def gguf_string(text):
    data = text.encode("utf-8")
    return struct.pack("<Q", len(data)) + data


def write_gguf(path, plan, tensors):
    def kv_string(key, value): return gguf_string(key) + struct.pack("<I", 8) + gguf_string(value)
    def kv_u32(key, value): return gguf_string(key) + struct.pack("<II", 4, value)
    def kv_f32(key, value): return gguf_string(key) + struct.pack("<If", 6, value)
    def kv_strings(key, values): return gguf_string(key) + struct.pack("<IIQ", 9, 8, len(values)) + b"".join(gguf_string(v) for v in values)
    def kv_i32s(key, values): return gguf_string(key) + struct.pack("<IIQ", 9, 5, len(values)) + struct.pack(f"<{len(values)}i", *values)
    kvs = [kv_string("general.architecture", "qwen2"), kv_u32("qwen2.block_count", LAYERS), kv_u32("qwen2.context_length", 64),
           kv_u32("qwen2.embedding_length", E), kv_u32("qwen2.feed_forward_length", F), kv_u32("qwen2.attention.head_count", HEADS),
           kv_u32("qwen2.attention.head_count_kv", KV_HEADS), kv_f32("qwen2.rope.freq_base", ROPE_BASE),
           kv_f32("qwen2.attention.layer_norm_rms_epsilon", EPS), kv_string("tokenizer.ggml.model", "gpt2"),
           kv_strings("tokenizer.ggml.tokens", TOKENS), kv_i32s("tokenizer.ggml.token_type", TYPES),
           kv_strings("tokenizer.ggml.merges", [f"{a} {b}" for a, b in MERGES]),
           kv_u32("tokenizer.ggml.eos_token_id", ID["<|im_end|>"]), kv_u32("tokenizer.ggml.bos_token_id", ID["<|endoftext|>"])]
    header = b"GGUF" + struct.pack("<IQQ", 3, len(plan), len(kvs)) + b"".join(kvs)
    infos, data = b"", b""
    for name, rows, cols, kind in plan:
        data += b"\0" * (-len(data) % 32)
        dims = struct.pack("<IQ", 1, cols) if rows == 1 else struct.pack("<IQQ", 2, cols, rows)
        infos += gguf_string(name) + dims + struct.pack("<IQ", kind, len(data))
        data += tensors[name][3]
    header += infos
    header += b"\0" * (-len(header) % 32)
    path.write_bytes(header + data)


def matvec(weights, rows, cols, x):
    return [f32(sum(weights[r * cols + c] * x[c] for c in range(cols))) for r in range(rows)]


def rms_norm(x, weight):
    scale = 1.0 / math.sqrt(sum(v * v for v in x) / len(x) + EPS)
    return [v * scale * w for v, w in zip(x, weight)]


def rotate(x, heads, position):
    out, half_dim = list(x), D // 2
    for head in range(heads):
        for i in range(half_dim):
            angle = position * ROPE_BASE ** (-2.0 * i / D)
            a, b = x[head * D + i], x[head * D + i + half_dim]
            out[head * D + i] = a * math.cos(angle) - b * math.sin(angle)
            out[head * D + i + half_dim] = a * math.sin(angle) + b * math.cos(angle)
    return out


def forward(tensors, tokens):
    get = lambda name: tensors[name][4]
    cache = [([], []) for _ in range(LAYERS)]
    x = None
    for position, token in enumerate(tokens):
        x = get("token_embd.weight")[token * E:(token + 1) * E]
        for layer in range(LAYERS):
            p = f"blk.{layer}."
            h = rms_norm(x, get(p + "attn_norm.weight"))
            q = [a + b for a, b in zip(matvec(get(p + "attn_q.weight"), E, E, h), get(p + "attn_q.bias"))]
            k = [a + b for a, b in zip(matvec(get(p + "attn_k.weight"), K, E, h), get(p + "attn_k.bias"))]
            v = [a + b for a, b in zip(matvec(get(p + "attn_v.weight"), K, E, h), get(p + "attn_v.bias"))]
            q, k = rotate(q, HEADS, position), rotate(k, KV_HEADS, position)
            cache[layer][0].append(k)
            cache[layer][1].append(v)
            mixed = []
            for head in range(HEADS):
                shared = head // (HEADS // KV_HEADS)
                scores = [sum(q[head * D + i] * past[shared * D + i] for i in range(D)) / math.sqrt(D) for past in cache[layer][0]]
                peak = max(scores)
                weights = [math.exp(s - peak) for s in scores]
                total = sum(weights)
                mixed += [sum(w / total * past[shared * D + i] for w, past in zip(weights, cache[layer][1])) for i in range(D)]
            x = [a + b for a, b in zip(x, matvec(get(p + "attn_output.weight"), E, E, mixed))]
            h = rms_norm(x, get(p + "ffn_norm.weight"))
            gate, up = matvec(get(p + "ffn_gate.weight"), F, E, h), matvec(get(p + "ffn_up.weight"), F, E, h)
            hidden = [g / (1.0 + math.exp(-g)) * u for g, u in zip(gate, up)]
            x = [a + b for a, b in zip(x, matvec(get(p + "ffn_down.weight"), E, F, hidden))]
    return matvec(get("output.weight"), V, E, rms_norm(x, get("output_norm.weight")))


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    plan, tensors = build_tensors()
    write_gguf(out / "tiny.gguf", plan, tensors)
    text = "hello he"
    expected_tokens = [ID["hel"], ID["l"], ID["o"], ID[ALPHABET[32] + "he"]]
    tokens = [ID["<|im_start|>"]] + expected_tokens + [ID["<|im_end|>"]]
    logits = forward(tensors, tokens)
    lines = [text, " ".join(map(str, expected_tokens)), " ".join(map(str, tokens)), " ".join(f"{value:.6f}" for value in logits)]
    (out / "expected.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Created model runtime fixture ({(out / 'tiny.gguf').stat().st_size} bytes, {V} tokens)")


if __name__ == "__main__":
    main()
