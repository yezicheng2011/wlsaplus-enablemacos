// SPDX-License-Identifier: Apache-2.0
// On-device language model runtime. Written for WLSAPlus from the public GGUF
// file-format description, the published quantization layouts and the Qwen2
// architecture paper/model card. No inference library source is incorporated.
#if !defined(__APPLE__) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif
#include "wlm.h"

#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#include <dispatch/dispatch.h>
#endif

enum { TYPE_F32 = 0, TYPE_F16 = 1, TYPE_Q5_0 = 6, TYPE_Q8_0 = 8, TYPE_Q4_K = 12, TYPE_Q6_K = 14 };
enum { TOKEN_CONTROL = 3 };
enum { MAX_TENSORS = 4096, MAX_VOCAB = 1 << 20, MAX_LAYERS = 256, MAX_WIDTH = 1 << 16 };

typedef struct { const uint8_t *p, *end; int bad; } reader;
typedef struct { const char *p; uint64_t n; } str;
typedef struct { str name; uint64_t rows, cols, offset; uint32_t type; } tensor;
typedef struct { float *attn_norm, *q_w, *q_b, *k_w, *k_b, *v_w, *v_b, *o_w, *ffn_norm, *gate, *up, *down; } layer;

struct wlm_model {
    uint8_t *map;
    size_t map_size;
    int n_layer, n_embd, n_ff, n_head, n_head_kv, head_dim, kv_dim, n_ctx, n_vocab;
    float rope_base, eps;
    str *tokens;
    int32_t *token_type;
    int32_t *vocab_slots;
    uint32_t vocab_mask;
    uint64_t *pair_keys;
    int32_t *pair_rank, *pair_id;
    uint32_t pair_mask;
    int32_t byte_token[256];
    int16_t code_byte[324];
    int32_t im_start, im_end, eos, bos;
    const uint8_t *embd_raw;
    uint32_t embd_type;
    float *out_w, *out_norm;
    layer *layers;
};

struct wlm_session {
    wlm_model *model;
    int context, length;
    float *keys, *values;
    float *x, *h, *q, *k, *v, *mix, *ff_a, *ff_b, *scores, *logits, *rope;
};

// ---- bounded little-endian reader ----

static uint64_t rd(reader *r, int bytes) {
    if (r->bad || (size_t)(r->end - r->p) < (size_t)bytes) { r->bad = 1; return 0; }
    uint64_t value = 0;
    for (int i = 0; i < bytes; i++) value |= (uint64_t)r->p[i] << (8 * i);
    r->p += bytes;
    return value;
}

static str rd_str(reader *r) {
    str s = { NULL, 0 };
    uint64_t n = rd(r, 8);
    if (r->bad || n > (uint64_t)(r->end - r->p)) { r->bad = 1; return s; }
    s.p = (const char *)r->p; s.n = n; r->p += n;
    return s;
}

static int str_is(str s, const char *text) { size_t n = strlen(text); return s.n == n && memcmp(s.p, text, n) == 0; }

static int scalar_size(uint32_t type) {
    switch (type) {
        case 0: case 1: case 7: return 1;
        case 2: case 3: return 2;
        case 4: case 5: case 6: return 4;
        case 10: case 11: case 12: return 8;
        default: return 0;
    }
}

static void skip_value(reader *r, uint32_t type, int depth) {
    if (type == 8) { rd_str(r); return; }
    if (type == 9) {
        uint32_t inner = (uint32_t)rd(r, 4);
        uint64_t count = rd(r, 8);
        if (depth > 2) { r->bad = 1; return; }
        int size = scalar_size(inner);
        if (size) {
            if (count > (uint64_t)(r->end - r->p) / (uint64_t)size) { r->bad = 1; return; }
            r->p += count * (uint64_t)size;
            return;
        }
        for (uint64_t i = 0; i < count && !r->bad; i++) skip_value(r, inner, depth + 1);
        return;
    }
    int size = scalar_size(type);
    if (!size) { r->bad = 1; return; }
    rd(r, size);
}

// ---- dequantization ----

static float half_to_float(uint16_t h) {
    uint32_t sign = (uint32_t)(h >> 15) << 31, exponent = (h >> 10) & 31, mantissa = h & 1023, bits;
    if (exponent == 0) {
        if (mantissa == 0) bits = sign;
        else {
            int shift = 0;
            while (!(mantissa & 1024)) { mantissa <<= 1; shift++; }
            bits = sign | ((uint32_t)(113 - shift) << 23) | ((mantissa & 1023) << 13);
        }
    } else if (exponent == 31) bits = sign | 0x7f800000u | (mantissa << 13);
    else bits = sign | ((exponent + 112) << 23) | (mantissa << 13);
    float value;
    memcpy(&value, &bits, 4);
    return value;
}

static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static size_t block_values(uint32_t type) {
    switch (type) {
        case TYPE_F32: case TYPE_F16: return 1;
        case TYPE_Q5_0: case TYPE_Q8_0: return 32;
        case TYPE_Q4_K: case TYPE_Q6_K: return 256;
        default: return 0;
    }
}

static size_t block_bytes(uint32_t type) {
    switch (type) {
        case TYPE_F32: return 4;
        case TYPE_F16: return 2;
        case TYPE_Q5_0: return 22;
        case TYPE_Q8_0: return 34;
        case TYPE_Q4_K: return 144;
        case TYPE_Q6_K: return 210;
        default: return 0;
    }
}

static void scale_min_k4(int j, const uint8_t *q, int *scale, int *minimum) {
    if (j < 4) { *scale = q[j] & 63; *minimum = q[j + 4] & 63; }
    else { *scale = (q[j + 4] & 15) | ((q[j - 4] >> 6) << 4); *minimum = (q[j + 4] >> 4) | ((q[j] >> 6) << 4); }
}

// `count` must be a multiple of the block size; callers validate tensor sizes.
static void dequantize(uint32_t type, const uint8_t *src, float *dst, size_t count) {
    size_t blocks = count / block_values(type);
    switch (type) {
        case TYPE_F32:
            for (size_t i = 0; i < count; i++) {
                uint32_t bits = (uint32_t)src[4 * i] | ((uint32_t)src[4 * i + 1] << 8) | ((uint32_t)src[4 * i + 2] << 16) | ((uint32_t)src[4 * i + 3] << 24);
                memcpy(&dst[i], &bits, 4);
            }
            break;
        case TYPE_F16:
            for (size_t i = 0; i < count; i++) dst[i] = half_to_float(le16(src + 2 * i));
            break;
        case TYPE_Q8_0:
            for (size_t b = 0; b < blocks; b++, src += 34, dst += 32) {
                float d = half_to_float(le16(src));
                for (int i = 0; i < 32; i++) dst[i] = d * (float)(int8_t)src[2 + i];
            }
            break;
        case TYPE_Q5_0:
            for (size_t b = 0; b < blocks; b++, src += 22, dst += 32) {
                float d = half_to_float(le16(src));
                uint32_t high = (uint32_t)src[2] | ((uint32_t)src[3] << 8) | ((uint32_t)src[4] << 16) | ((uint32_t)src[5] << 24);
                const uint8_t *q = src + 6;
                for (int i = 0; i < 16; i++) {
                    int low = (q[i] & 15) | (int)(((high >> i) & 1) << 4);
                    int upper = (q[i] >> 4) | (int)(((high >> (i + 16)) & 1) << 4);
                    dst[i] = d * (float)(low - 16);
                    dst[i + 16] = d * (float)(upper - 16);
                }
            }
            break;
        case TYPE_Q4_K:
            for (size_t b = 0; b < blocks; b++, src += 144) {
                float d = half_to_float(le16(src)), dmin = half_to_float(le16(src + 2));
                const uint8_t *scales = src + 4, *q = src + 16;
                for (int j = 0; j < 8; j += 2, q += 32) {
                    int s1, m1, s2, m2;
                    scale_min_k4(j, scales, &s1, &m1);
                    scale_min_k4(j + 1, scales, &s2, &m2);
                    float d1 = d * (float)s1, o1 = dmin * (float)m1, d2 = d * (float)s2, o2 = dmin * (float)m2;
                    for (int i = 0; i < 32; i++) *dst++ = d1 * (float)(q[i] & 15) - o1;
                    for (int i = 0; i < 32; i++) *dst++ = d2 * (float)(q[i] >> 4) - o2;
                }
            }
            break;
        case TYPE_Q6_K:
            for (size_t b = 0; b < blocks; b++, src += 210) {
                const uint8_t *low = src, *high = src + 128;
                const int8_t *scale = (const int8_t *)(src + 192);
                float d = half_to_float(le16(src + 208));
                for (int n = 0; n < 2; n++, dst += 128, low += 64, high += 32, scale += 8) {
                    for (int i = 0; i < 32; i++) {
                        int is = i / 16;
                        int q1 = ((low[i] & 15) | ((high[i] & 3) << 4)) - 32;
                        int q2 = ((low[i + 32] & 15) | (((high[i] >> 2) & 3) << 4)) - 32;
                        int q3 = ((low[i] >> 4) | (((high[i] >> 4) & 3) << 4)) - 32;
                        int q4 = ((low[i + 32] >> 4) | (((high[i] >> 6) & 3) << 4)) - 32;
                        dst[i] = d * (float)scale[is] * (float)q1;
                        dst[i + 32] = d * (float)scale[is + 2] * (float)q2;
                        dst[i + 64] = d * (float)scale[is + 4] * (float)q3;
                        dst[i + 96] = d * (float)scale[is + 6] * (float)q4;
                    }
                }
            }
            break;
        default: break;
    }
}

// ---- tokenizer ----

static uint32_t hash_bytes(const char *p, size_t n) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; i++) { h ^= (uint8_t)p[i]; h *= 16777619u; }
    return h;
}

static int32_t vocab_find(const wlm_model *m, const char *p, size_t n) {
    for (uint32_t slot = hash_bytes(p, n) & m->vocab_mask;; slot = (slot + 1) & m->vocab_mask) {
        int32_t id = m->vocab_slots[slot];
        if (id < 0) return -1;
        if (m->tokens[id].n == n && memcmp(m->tokens[id].p, p, n) == 0) return id;
    }
}

static uint32_t pair_slot(uint64_t key, uint32_t mask) {
    key ^= key >> 33; key *= 0xff51afd7ed558ccdULL; key ^= key >> 33;
    return (uint32_t)key & mask;
}

static int pair_find(const wlm_model *m, int32_t a, int32_t b, int32_t *rank, int32_t *id) {
    uint64_t key = ((uint64_t)(uint32_t)a << 32) | (uint32_t)b;
    for (uint32_t slot = pair_slot(key, m->pair_mask);; slot = (slot + 1) & m->pair_mask) {
        if (m->pair_rank[slot] < 0) return 0;
        if (m->pair_keys[slot] == key) { *rank = m->pair_rank[slot]; *id = m->pair_id[slot]; return 1; }
    }
}

static int utf8_encode(uint32_t cp, char *out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) { out[0] = (char)(0xc0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 63)); return 2; }
    if (cp < 0x10000) { out[0] = (char)(0xe0 | (cp >> 12)); out[1] = (char)(0x80 | ((cp >> 6) & 63)); out[2] = (char)(0x80 | (cp & 63)); return 3; }
    out[0] = (char)(0xf0 | (cp >> 18)); out[1] = (char)(0x80 | ((cp >> 12) & 63)); out[2] = (char)(0x80 | ((cp >> 6) & 63)); out[3] = (char)(0x80 | (cp & 63));
    return 4;
}

// Decodes one code point; malformed bytes decode as themselves so that
// arbitrary input still tokenizes byte-for-byte.
static uint32_t utf8_decode(const uint8_t *p, size_t n, int *used) {
    uint8_t c = p[0];
    int need = c < 0x80 ? 1 : (c & 0xe0) == 0xc0 ? 2 : (c & 0xf0) == 0xe0 ? 3 : (c & 0xf8) == 0xf0 ? 4 : 0;
    if (need == 0 || (size_t)need > n) { *used = 1; return 0xfffd; }
    uint32_t cp = need == 1 ? c : (uint32_t)(c & (0xff >> (need + 1)));
    for (int i = 1; i < need; i++) {
        if ((p[i] & 0xc0) != 0x80) { *used = 1; return 0xfffd; }
        cp = (cp << 6) | (p[i] & 63);
    }
    *used = need;
    return cp;
}

static int is_space(uint32_t c) {
    return (c >= 9 && c <= 13) || c == 32 || c == 0x85 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
           c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000;
}

static int is_number(uint32_t c) { return (c >= '0' && c <= '9') || (c >= 0xff10 && c <= 0xff19) || c == 0xb2 || c == 0xb3 || c == 0xb9 || (c >= 0xbc && c <= 0xbe); }

// Approximates Unicode "letter": exact for ASCII, and for other scripts
// everything that is not in a punctuation, symbol or spacing block.
static int is_letter(uint32_t c) {
    if (c < 0x80) return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    if (is_space(c) || is_number(c) || c == 0xfffd) return 0;
    if (c < 0xc0) return c == 0xaa || c == 0xb5 || c == 0xba;
    if (c == 0xd7 || c == 0xf7) return 0;
    if (c >= 0x2000 && c <= 0x2bff) return 0;
    if (c >= 0x3000 && c <= 0x303f) return c >= 0x3005 && c <= 0x3007;
    if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xfe30 && c <= 0xfe6f)) return 0;
    if ((c >= 0xff00 && c <= 0xff0f) || (c >= 0xff1a && c <= 0xff20) || (c >= 0xff3b && c <= 0xff40) || (c >= 0xff5b && c <= 0xff65) || (c >= 0xffe0 && c <= 0xffef)) return 0;
    if (c >= 0x1f000 && c <= 0x1faff) return 0;
    return 1;
}

typedef struct { const uint8_t *p; size_t n; } text;

static uint32_t peek(text t, size_t at, int *used) {
    if (at >= t.n) { *used = 0; return 0; }
    return utf8_decode(t.p + at, t.n - at, used);
}

static int is_newline(uint32_t c) { return c == '\r' || c == '\n'; }

// Length in bytes of the next pre-token, following the Qwen2 splitting rules:
// contractions, letter runs (with one leading non-letter), single digits,
// punctuation runs (with one leading space), and whitespace runs.
static size_t next_piece(text t, size_t at) {
    int used, step;
    uint32_t c = peek(t, at, &used);
    if (c == '\'' && at + 1 < t.n) {
        uint8_t a = t.p[at + 1] | 32, b = at + 2 < t.n ? (t.p[at + 2] | 32) : 0;
        if ((a == 'r' && b == 'e') || (a == 'v' && b == 'e') || (a == 'l' && b == 'l')) return 3;
        if (a == 's' || a == 't' || a == 'm' || a == 'd') return 2;
    }
    size_t cursor = at;
    if (!is_newline(c) && !is_letter(c) && !is_number(c)) {
        uint32_t following = peek(t, at + (size_t)used, &step);
        if (step && is_letter(following)) cursor = at + (size_t)used;
    }
    c = peek(t, cursor, &step);
    if (step && is_letter(c)) {
        while (step && is_letter(c)) { cursor += (size_t)step; c = peek(t, cursor, &step); }
        return cursor - at;
    }
    c = peek(t, at, &used);
    if (is_number(c)) return (size_t)used;
    cursor = at;
    if (c == ' ') cursor++;
    size_t start = cursor;
    c = peek(t, cursor, &step);
    while (step && !is_space(c) && !is_letter(c) && !is_number(c)) { cursor += (size_t)step; c = peek(t, cursor, &step); }
    if (cursor > start) {
        while (step && is_newline(c)) { cursor += (size_t)step; c = peek(t, cursor, &step); }
        return cursor - at;
    }
    cursor = at;
    size_t last_newline = 0, last_start = at;
    c = peek(t, cursor, &step);
    while (step && is_space(c)) {
        last_start = cursor;
        cursor += (size_t)step;
        if (is_newline(c)) last_newline = cursor;
        c = peek(t, cursor, &step);
    }
    if (last_newline) return last_newline - at;
    if (cursor > at) {
        if (step && last_start > at) return last_start - at;
        return cursor - at;
    }
    return (size_t)(used ? used : 1);
}

int wlm_tokenize(const wlm_model *m, const char *bytes, size_t length, int32_t *out, int capacity) {
    text t = { (const uint8_t *)bytes, length };
    int count = 0;
    for (size_t at = 0; at < length;) {
        size_t n = next_piece(t, at);
        if (n == 0 || n > length - at) n = 1;
        if (n > (size_t)(capacity - count)) return -1;
        int32_t *piece = out + count;
        int size = (int)n;
        for (int i = 0; i < size; i++) piece[i] = m->byte_token[t.p[at + (size_t)i]];
        while (size > 1) {
            int32_t best_rank = INT32_MAX, best_id = -1, best_a = 0, best_b = 0, rank, id;
            for (int i = 0; i + 1 < size; i++) {
                if (pair_find(m, piece[i], piece[i + 1], &rank, &id) && rank < best_rank) { best_rank = rank; best_id = id; best_a = piece[i]; best_b = piece[i + 1]; }
            }
            if (best_id < 0) break;
            int write = 0;
            for (int i = 0; i < size;) {
                if (i + 1 < size && piece[i] == best_a && piece[i + 1] == best_b) { piece[write++] = best_id; i += 2; }
                else piece[write++] = piece[i++];
            }
            size = write;
        }
        count += size;
        at += n;
    }
    return count;
}

int wlm_token_bytes(const wlm_model *m, int32_t token, char *out, int capacity) {
    if (token < 0 || token >= m->n_vocab || m->token_type[token] == TOKEN_CONTROL) return 0;
    str s = m->tokens[token];
    int written = 0;
    for (size_t at = 0; at < s.n;) {
        int used;
        uint32_t cp = utf8_decode((const uint8_t *)s.p + at, s.n - at, &used);
        if (cp < 324 && m->code_byte[cp] >= 0) {
            if (written + 1 > capacity) return -1;
            out[written++] = (char)m->code_byte[cp];
        } else {
            if (written + used > capacity) return -1;
            memcpy(out + written, s.p + at, (size_t)used);
            written += used;
        }
        at += (size_t)used;
    }
    return written;
}

// ---- loading ----

static void fail(char *error, size_t size, const char *message) { if (error && size) snprintf(error, size, "%s", message); }

static const tensor *find_tensor(const tensor *list, int count, const char *name) {
    for (int i = 0; i < count; i++) if (str_is(list[i].name, name)) return &list[i];
    return NULL;
}

typedef struct { const tensor *list; int count; const uint8_t *data; size_t data_size; int bad; } weights;

static const uint8_t *tensor_bytes(weights *w, const char *name, uint64_t rows, uint64_t cols, uint32_t *type) {
    const tensor *t = find_tensor(w->list, w->count, name);
    if (!t || t->rows != rows || t->cols != cols || !block_values(t->type)) { w->bad = 1; return NULL; }
    size_t values = (size_t)(rows * cols), per = block_values(t->type);
    if (values % per) { w->bad = 1; return NULL; }
    size_t bytes = values / per * block_bytes(t->type);
    if (t->offset > w->data_size || bytes > w->data_size - t->offset) { w->bad = 1; return NULL; }
    if (type) *type = t->type;
    return w->data + t->offset;
}

static float *tensor_floats(weights *w, const char *name, uint64_t rows, uint64_t cols) {
    uint32_t type = 0;
    const uint8_t *bytes = tensor_bytes(w, name, rows, cols, &type);
    if (!bytes) return NULL;
    float *out = malloc(sizeof(float) * (size_t)(rows * cols));
    if (!out) { w->bad = 1; return NULL; }
    dequantize(type, bytes, out, (size_t)(rows * cols));
    return out;
}

static float *layer_floats(weights *w, int index, const char *suffix, uint64_t rows, uint64_t cols) {
    char name[64];
    snprintf(name, sizeof name, "blk.%d.%s", index, suffix);
    return tensor_floats(w, name, rows, cols);
}

void wlm_free(wlm_model *m) {
    if (!m) return;
    if (m->layers) for (int i = 0; i < m->n_layer; i++) {
        layer *l = &m->layers[i];
        free(l->attn_norm); free(l->q_w); free(l->q_b); free(l->k_w); free(l->k_b); free(l->v_w); free(l->v_b);
        free(l->o_w); free(l->ffn_norm); free(l->gate); free(l->up); free(l->down);
    }
    free(m->layers); free(m->out_w); free(m->out_norm); free(m->tokens); free(m->token_type); free(m->vocab_slots);
    free(m->pair_keys); free(m->pair_rank); free(m->pair_id);
    if (m->map) munmap(m->map, m->map_size);
    free(m);
}

static uint32_t table_mask(uint64_t entries) { uint32_t size = 1024; while (size < entries * 3) size <<= 1; return size - 1; }

wlm_model *wlm_load(const char *path, char *error, size_t error_size) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) { fail(error, error_size, "The model file could not be opened."); return NULL; }
    struct stat info;
    if (fstat(fd, &info) != 0 || info.st_size < 64) { close(fd); fail(error, error_size, "The model file is too small."); return NULL; }
    wlm_model *m = calloc(1, sizeof *m);
    if (!m) { close(fd); fail(error, error_size, "Out of memory."); return NULL; }
    m->map_size = (size_t)info.st_size;
    void *map = mmap(NULL, m->map_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (map == MAP_FAILED) { free(m); fail(error, error_size, "The model file could not be mapped."); return NULL; }
    m->map = map;

    const char *problem = "The model file is malformed.";
    tensor *tensors = NULL;
    reader r = { m->map, m->map + m->map_size, 0 };
    if (rd(&r, 4) != 0x46554747u) { problem = "The file is not a GGUF model."; goto bad; }
    uint32_t version = (uint32_t)rd(&r, 4);
    uint64_t tensor_count = rd(&r, 8), kv_count = rd(&r, 8);
    if (r.bad || version < 2 || version > 3 || tensor_count == 0 || tensor_count > MAX_TENSORS || kv_count > 65536) goto bad;

    uint64_t alignment = 32, token_count = 0, merge_count = 0, type_count = 0;
    const uint8_t *tokens_at = NULL, *merges_at = NULL, *types_at = NULL;
    int64_t eos = -1, bos = -1;
    str architecture = { NULL, 0 };
    double rope_base = 10000.0, eps = 1e-6;
    uint64_t n_layer = 0, n_embd = 0, n_ff = 0, n_head = 0, n_head_kv = 0, n_ctx = 0;
    for (uint64_t i = 0; i < kv_count && !r.bad; i++) {
        str key = rd_str(&r);
        uint32_t type = (uint32_t)rd(&r, 4);
        if (r.bad) break;
        const char *suffix = NULL;
        if (architecture.n && key.n > architecture.n + 1 && memcmp(key.p, architecture.p, architecture.n) == 0 && key.p[architecture.n] == '.') {
            suffix = key.p + architecture.n + 1;
        }
        size_t suffix_length = suffix ? (size_t)(key.n - architecture.n - 1) : 0;
#define SUFFIX(text) (suffix && suffix_length == sizeof(text) - 1 && memcmp(suffix, text, suffix_length) == 0)
        if (str_is(key, "general.architecture") && type == 8) architecture = rd_str(&r);
        else if (str_is(key, "general.alignment") && type == 4) alignment = rd(&r, 4);
        else if (str_is(key, "tokenizer.ggml.eos_token_id") && type == 4) eos = (int64_t)rd(&r, 4);
        else if (str_is(key, "tokenizer.ggml.bos_token_id") && type == 4) bos = (int64_t)rd(&r, 4);
        else if (SUFFIX("block_count") && type == 4) n_layer = rd(&r, 4);
        else if (SUFFIX("embedding_length") && type == 4) n_embd = rd(&r, 4);
        else if (SUFFIX("feed_forward_length") && type == 4) n_ff = rd(&r, 4);
        else if (SUFFIX("attention.head_count") && type == 4) n_head = rd(&r, 4);
        else if (SUFFIX("attention.head_count_kv") && type == 4) n_head_kv = rd(&r, 4);
        else if (SUFFIX("context_length") && type == 4) n_ctx = rd(&r, 4);
        else if (SUFFIX("rope.freq_base") && type == 6) { uint32_t bits = (uint32_t)rd(&r, 4); float f; memcpy(&f, &bits, 4); rope_base = f; }
        else if (SUFFIX("attention.layer_norm_rms_epsilon") && type == 6) { uint32_t bits = (uint32_t)rd(&r, 4); float f; memcpy(&f, &bits, 4); eps = f; }
        else if (type == 9 && (str_is(key, "tokenizer.ggml.tokens") || str_is(key, "tokenizer.ggml.merges") || str_is(key, "tokenizer.ggml.token_type"))) {
            const uint8_t *header = r.p;
            uint32_t inner = (uint32_t)rd(&r, 4);
            uint64_t count = rd(&r, 8);
            if (str_is(key, "tokenizer.ggml.tokens") && inner == 8) { tokens_at = r.p; token_count = count; }
            else if (str_is(key, "tokenizer.ggml.merges") && inner == 8) { merges_at = r.p; merge_count = count; }
            else if (str_is(key, "tokenizer.ggml.token_type") && inner == 5) { types_at = r.p; type_count = count; }
            r.p = header;
            skip_value(&r, type, 0);
        } else skip_value(&r, type, 0);
#undef SUFFIX
    }
    if (r.bad) goto bad;
    if (!str_is(architecture, "qwen2")) { problem = "This model architecture is not supported."; goto bad; }
    if (n_layer == 0 || n_layer > MAX_LAYERS || n_embd == 0 || n_embd > MAX_WIDTH || n_ff == 0 || n_ff > MAX_WIDTH || n_head == 0 ||
        n_head_kv == 0 || n_embd % n_head || n_head % n_head_kv || (n_embd / n_head) % 2 || token_count == 0 || token_count > MAX_VOCAB ||
        type_count != token_count || merge_count > MAX_VOCAB || alignment == 0 || alignment > 4096 || !tokens_at || !types_at) goto bad;

    tensors = calloc((size_t)tensor_count, sizeof *tensors);
    if (!tensors) { problem = "Out of memory."; goto bad; }
    for (uint64_t i = 0; i < tensor_count && !r.bad; i++) {
        tensors[i].name = rd_str(&r);
        uint32_t dims = (uint32_t)rd(&r, 4);
        if (dims < 1 || dims > 2) { r.bad = 1; break; }
        tensors[i].cols = rd(&r, 8);
        tensors[i].rows = dims == 2 ? rd(&r, 8) : 1;
        tensors[i].type = (uint32_t)rd(&r, 4);
        tensors[i].offset = rd(&r, 8);
        if (tensors[i].cols == 0 || tensors[i].rows == 0 || tensors[i].cols > MAX_VOCAB || tensors[i].rows > MAX_VOCAB) r.bad = 1;
    }
    if (r.bad) goto bad;
    size_t header = (size_t)(r.p - m->map);
    size_t data_start = (header + alignment - 1) / alignment * alignment;
    if (data_start >= m->map_size) goto bad;

    m->n_layer = (int)n_layer; m->n_embd = (int)n_embd; m->n_ff = (int)n_ff; m->n_head = (int)n_head; m->n_head_kv = (int)n_head_kv;
    m->head_dim = (int)(n_embd / n_head); m->kv_dim = m->head_dim * m->n_head_kv;
    m->n_ctx = n_ctx > 0 && n_ctx < INT_MAX ? (int)n_ctx : 2048;
    m->n_vocab = (int)token_count; m->rope_base = (float)rope_base; m->eps = (float)eps;

    m->tokens = calloc(token_count, sizeof *m->tokens);
    m->vocab_mask = table_mask(token_count);
    m->vocab_slots = malloc(sizeof(int32_t) * ((size_t)m->vocab_mask + 1));
    if (!m->tokens || !m->vocab_slots) { problem = "Out of memory."; goto bad; }
    for (uint32_t i = 0; i <= m->vocab_mask; i++) m->vocab_slots[i] = -1;
    reader tr = { tokens_at, m->map + m->map_size, 0 };
    for (uint64_t i = 0; i < token_count; i++) {
        m->tokens[i] = rd_str(&tr);
        if (tr.bad) goto bad;
        uint32_t slot = hash_bytes(m->tokens[i].p, m->tokens[i].n) & m->vocab_mask;
        while (m->vocab_slots[slot] >= 0) slot = (slot + 1) & m->vocab_mask;
        m->vocab_slots[slot] = (int32_t)i;
    }
    m->token_type = malloc(sizeof(int32_t) * token_count);
    if (!m->token_type) { problem = "Out of memory."; goto bad; }
    reader yr = { types_at, m->map + m->map_size, 0 };
    for (uint64_t i = 0; i < token_count; i++) m->token_type[i] = (int32_t)rd(&yr, 4);
    if (yr.bad) goto bad;

    // GPT-2 byte alphabet: printable Latin-1 bytes map to themselves, the rest to U+0100 onwards.
    for (int i = 0; i < 324; i++) m->code_byte[i] = -1;
    int extra = 0;
    for (int b = 0; b < 256; b++) {
        int printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
        uint32_t cp = printable ? (uint32_t)b : (uint32_t)(256 + extra++);
        char encoded[4];
        int n = utf8_encode(cp, encoded);
        m->code_byte[cp] = (int16_t)b;
        m->byte_token[b] = vocab_find(m, encoded, (size_t)n);
        if (m->byte_token[b] < 0) { problem = "The model vocabulary is missing byte tokens."; goto bad; }
    }

    m->pair_mask = table_mask(merge_count + 1);
    m->pair_keys = calloc((size_t)m->pair_mask + 1, sizeof(uint64_t));
    m->pair_rank = malloc(sizeof(int32_t) * ((size_t)m->pair_mask + 1));
    m->pair_id = malloc(sizeof(int32_t) * ((size_t)m->pair_mask + 1));
    if (!m->pair_keys || !m->pair_rank || !m->pair_id) { problem = "Out of memory."; goto bad; }
    for (uint32_t i = 0; i <= m->pair_mask; i++) m->pair_rank[i] = -1;
    reader mr = { merges_at, m->map + m->map_size, 0 };
    char joined[512];
    for (uint64_t i = 0; i < merge_count; i++) {
        str merge = rd_str(&mr);
        if (mr.bad) goto bad;
        const char *space = memchr(merge.p, ' ', merge.n);
        if (!space || merge.n - 1 > sizeof joined) continue;
        size_t left = (size_t)(space - merge.p), right = merge.n - left - 1;
        memcpy(joined, merge.p, left);
        memcpy(joined + left, space + 1, right);
        int32_t a = vocab_find(m, merge.p, left), b = vocab_find(m, space + 1, right), id = vocab_find(m, joined, left + right);
        if (a < 0 || b < 0 || id < 0) continue;
        uint64_t key = ((uint64_t)(uint32_t)a << 32) | (uint32_t)b;
        uint32_t slot = pair_slot(key, m->pair_mask);
        while (m->pair_rank[slot] >= 0 && m->pair_keys[slot] != key) slot = (slot + 1) & m->pair_mask;
        if (m->pair_rank[slot] < 0) { m->pair_keys[slot] = key; m->pair_rank[slot] = (int32_t)i; m->pair_id[slot] = id; }
    }

    m->im_start = vocab_find(m, "<|im_start|>", 12);
    m->im_end = vocab_find(m, "<|im_end|>", 10);
    m->eos = eos >= 0 && eos < (int64_t)token_count ? (int32_t)eos : -1;
    m->bos = bos >= 0 && bos < (int64_t)token_count ? (int32_t)bos : -1;
    if (m->im_start < 0 || m->im_end < 0) { problem = "The model does not use the ChatML template."; goto bad; }

    weights w = { tensors, (int)tensor_count, m->map + data_start, m->map_size - data_start, 0 };
    uint64_t E = n_embd, F = n_ff, K = (uint64_t)m->kv_dim, V = token_count;
    m->embd_raw = tensor_bytes(&w, "token_embd.weight", V, E, &m->embd_type);
    if (m->embd_raw && E % block_values(m->embd_type)) w.bad = 1;
    m->out_norm = tensor_floats(&w, "output_norm.weight", 1, E);
    m->out_w = tensor_floats(&w, find_tensor(tensors, (int)tensor_count, "output.weight") ? "output.weight" : "token_embd.weight", V, E);
    m->layers = calloc(n_layer, sizeof *m->layers);
    if (!m->layers) { problem = "Out of memory."; goto bad; }
    for (int i = 0; i < m->n_layer && !w.bad; i++) {
        layer *l = &m->layers[i];
        l->attn_norm = layer_floats(&w, i, "attn_norm.weight", 1, E);
        l->q_w = layer_floats(&w, i, "attn_q.weight", E, E);
        l->q_b = layer_floats(&w, i, "attn_q.bias", 1, E);
        l->k_w = layer_floats(&w, i, "attn_k.weight", K, E);
        l->k_b = layer_floats(&w, i, "attn_k.bias", 1, K);
        l->v_w = layer_floats(&w, i, "attn_v.weight", K, E);
        l->v_b = layer_floats(&w, i, "attn_v.bias", 1, K);
        l->o_w = layer_floats(&w, i, "attn_output.weight", E, E);
        l->ffn_norm = layer_floats(&w, i, "ffn_norm.weight", 1, E);
        l->gate = layer_floats(&w, i, "ffn_gate.weight", F, E);
        l->up = layer_floats(&w, i, "ffn_up.weight", F, E);
        l->down = layer_floats(&w, i, "ffn_down.weight", E, F);
    }
    if (w.bad) { problem = "The model tensors do not match the declared architecture."; goto bad; }
    free(tensors);
    return m;
bad:
    free(tensors);
    fail(error, error_size, problem);
    wlm_free(m);
    return NULL;
}

int wlm_vocab_size(const wlm_model *m) { return m->n_vocab; }
int wlm_context_limit(const wlm_model *m) { return m->n_ctx; }

// ---- inference ----

static float dot(const float *a, const float *b, int n) {
#ifdef __APPLE__
    float value;
    vDSP_dotpr(a, 1, b, 1, &value, (vDSP_Length)n);
    return value;
#else
    float lanes[8] = { 0 };
    int i = 0;
    for (; i + 8 <= n; i += 8) for (int j = 0; j < 8; j++) lanes[j] += a[i + j] * b[i + j];
    float value = 0;
    for (; i < n; i++) value += a[i] * b[i];
    for (int j = 0; j < 8; j++) value += lanes[j];
    return value;
#endif
}

static void matvec(float *y, const float *w, const float *x, int rows, int cols) {
#ifdef __APPLE__
    if ((long)rows * cols >= (1L << 18)) {
        size_t chunks = 8, per = ((size_t)rows + chunks - 1) / chunks;
        dispatch_apply(chunks, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t chunk) {
            size_t start = chunk * per, stop = start + per < (size_t)rows ? start + per : (size_t)rows;
            for (size_t row = start; row < stop; row++) y[row] = dot(w + row * (size_t)cols, x, cols);
        });
        return;
    }
#endif
    for (int row = 0; row < rows; row++) y[row] = dot(w + (size_t)row * (size_t)cols, x, cols);
}

static void rms_norm(float *out, const float *x, const float *weight, int n, float eps) {
    float scale = 1.0f / sqrtf(dot(x, x, n) / (float)n + eps);
    for (int i = 0; i < n; i++) out[i] = x[i] * scale * weight[i];
}

// Rotary position embedding over (i, i + half) pairs of each head.
static void rotate(float *x, int heads, int head_dim, const float *table) {
    int half = head_dim / 2;
    for (int h = 0; h < heads; h++, x += head_dim) {
        for (int i = 0; i < half; i++) {
            float c = table[2 * i], s = table[2 * i + 1], a = x[i], b = x[i + half];
            x[i] = a * c - b * s;
            x[i + half] = a * s + b * c;
        }
    }
}

wlm_session *wlm_session_new(wlm_model *m, int context) {
    if (context < 16) context = 16;
    if (context > m->n_ctx) context = m->n_ctx;
    wlm_session *s = calloc(1, sizeof *s);
    if (!s) return NULL;
    s->model = m; s->context = context;
    size_t cache = (size_t)m->n_layer * (size_t)context * (size_t)m->kv_dim;
    s->keys = malloc(sizeof(float) * cache); s->values = malloc(sizeof(float) * cache);
    s->x = malloc(sizeof(float) * (size_t)m->n_embd); s->h = malloc(sizeof(float) * (size_t)m->n_embd);
    s->q = malloc(sizeof(float) * (size_t)m->n_embd); s->mix = malloc(sizeof(float) * (size_t)m->n_embd);
    s->k = malloc(sizeof(float) * (size_t)m->kv_dim); s->v = malloc(sizeof(float) * (size_t)m->kv_dim);
    s->ff_a = malloc(sizeof(float) * (size_t)m->n_ff); s->ff_b = malloc(sizeof(float) * (size_t)m->n_ff);
    s->scores = malloc(sizeof(float) * (size_t)context); s->logits = malloc(sizeof(float) * (size_t)m->n_vocab);
    s->rope = malloc(sizeof(float) * (size_t)m->head_dim);
    if (!s->keys || !s->values || !s->x || !s->h || !s->q || !s->mix || !s->k || !s->v || !s->ff_a || !s->ff_b || !s->scores || !s->logits || !s->rope) {
        wlm_session_free(s);
        return NULL;
    }
    return s;
}

void wlm_session_free(wlm_session *s) {
    if (!s) return;
    free(s->keys); free(s->values); free(s->x); free(s->h); free(s->q); free(s->mix); free(s->k); free(s->v);
    free(s->ff_a); free(s->ff_b); free(s->scores); free(s->logits); free(s->rope);
    free(s);
}

void wlm_session_reset(wlm_session *s) { s->length = 0; }
int wlm_session_length(const wlm_session *s) { return s->length; }
const float *wlm_session_logits(const wlm_session *s) { return s->logits; }

static void step(wlm_session *s, int32_t token, int want_logits) {
    const wlm_model *m = s->model;
    int E = m->n_embd, K = m->kv_dim, D = m->head_dim, position = s->length, group = m->n_head / m->n_head_kv;
    size_t per = block_values(m->embd_type);
    dequantize(m->embd_type, m->embd_raw + (size_t)token * ((size_t)E / per) * block_bytes(m->embd_type), s->x, (size_t)E);
    for (int i = 0; i < D / 2; i++) {
        float angle = (float)position * powf(m->rope_base, -2.0f * (float)i / (float)D);
        s->rope[2 * i] = cosf(angle);
        s->rope[2 * i + 1] = sinf(angle);
    }
    float scale = 1.0f / sqrtf((float)D);
    for (int index = 0; index < m->n_layer; index++) {
        const layer *l = &m->layers[index];
        float *keys = s->keys + ((size_t)index * (size_t)s->context) * (size_t)K;
        float *values = s->values + ((size_t)index * (size_t)s->context) * (size_t)K;
        rms_norm(s->h, s->x, l->attn_norm, E, m->eps);
        matvec(s->q, l->q_w, s->h, E, E);
        matvec(s->k, l->k_w, s->h, K, E);
        matvec(s->v, l->v_w, s->h, K, E);
        for (int i = 0; i < E; i++) s->q[i] += l->q_b[i];
        for (int i = 0; i < K; i++) { s->k[i] += l->k_b[i]; s->v[i] += l->v_b[i]; }
        rotate(s->q, m->n_head, D, s->rope);
        rotate(s->k, m->n_head_kv, D, s->rope);
        memcpy(keys + (size_t)position * (size_t)K, s->k, sizeof(float) * (size_t)K);
        memcpy(values + (size_t)position * (size_t)K, s->v, sizeof(float) * (size_t)K);
        for (int head = 0; head < m->n_head; head++) {
            int shared = head / group;
            const float *query = s->q + head * D;
            float peak = -INFINITY, total = 0;
            for (int t = 0; t <= position; t++) {
                s->scores[t] = dot(query, keys + (size_t)t * (size_t)K + (size_t)(shared * D), D) * scale;
                if (s->scores[t] > peak) peak = s->scores[t];
            }
            for (int t = 0; t <= position; t++) { s->scores[t] = expf(s->scores[t] - peak); total += s->scores[t]; }
            float *out = s->mix + head * D;
            memset(out, 0, sizeof(float) * (size_t)D);
            for (int t = 0; t <= position; t++) {
                float weight = s->scores[t] / total;
                const float *value = values + (size_t)t * (size_t)K + (size_t)(shared * D);
                for (int i = 0; i < D; i++) out[i] += weight * value[i];
            }
        }
        matvec(s->h, l->o_w, s->mix, E, E);
        for (int i = 0; i < E; i++) s->x[i] += s->h[i];
        rms_norm(s->h, s->x, l->ffn_norm, E, m->eps);
        matvec(s->ff_a, l->gate, s->h, m->n_ff, E);
        matvec(s->ff_b, l->up, s->h, m->n_ff, E);
        for (int i = 0; i < m->n_ff; i++) s->ff_a[i] = s->ff_a[i] / (1.0f + expf(-s->ff_a[i])) * s->ff_b[i];
        matvec(s->h, l->down, s->ff_a, E, m->n_ff);
        for (int i = 0; i < E; i++) s->x[i] += s->h[i];
    }
    s->length = position + 1;
    if (want_logits) {
        rms_norm(s->h, s->x, m->out_norm, E, m->eps);
        matvec(s->logits, m->out_w, s->h, m->n_vocab, E);
    }
}

int wlm_session_feed(wlm_session *s, const int32_t *tokens, int count) {
    if (count <= 0 || count > s->context - s->length) return -1;
    for (int i = 0; i < count; i++) if (tokens[i] < 0 || tokens[i] >= s->model->n_vocab) return -1;
    for (int i = 0; i < count; i++) step(s, tokens[i], i == count - 1);
    return 0;
}

static int append_text(const wlm_model *m, const char *value, int32_t *out, int at, int capacity) {
    if (at < 0) return -1;
    int n = wlm_tokenize(m, value, strlen(value), out + at, capacity - at);
    return n < 0 ? -1 : at + n;
}

static int append_token(int32_t token, int32_t *out, int at, int capacity) {
    if (at < 0 || at >= capacity) return -1;
    out[at] = token;
    return at + 1;
}

int wlm_chat(wlm_session *s, const char *system, const char *user, int max_tokens, wlm_emit emit, void *context) {
    const wlm_model *m = s->model;
    int capacity = s->context;
    int32_t *prompt = malloc(sizeof(int32_t) * (size_t)capacity);
    if (!prompt) return -1;
    int n = 0;
    n = append_token(m->im_start, prompt, n, capacity);
    n = append_text(m, "system\n", prompt, n, capacity);
    n = append_text(m, system, prompt, n, capacity);
    n = append_token(m->im_end, prompt, n, capacity);
    n = append_text(m, "\n", prompt, n, capacity);
    n = append_token(m->im_start, prompt, n, capacity);
    n = append_text(m, "user\n", prompt, n, capacity);
    n = append_text(m, user, prompt, n, capacity);
    n = append_token(m->im_end, prompt, n, capacity);
    n = append_text(m, "\n", prompt, n, capacity);
    n = append_token(m->im_start, prompt, n, capacity);
    n = append_text(m, "assistant\n", prompt, n, capacity);
    wlm_session_reset(s);
    if (n < 0 || wlm_session_feed(s, prompt, n) != 0) { free(prompt); return -1; }
    free(prompt);
    int produced = 0;
    char bytes[512];
    while (produced < max_tokens && s->length < s->context) {
        int32_t best = 0;
        for (int i = 1; i < m->n_vocab; i++) if (s->logits[i] > s->logits[best]) best = i;
        if (best == m->im_end || best == m->eos || best == m->bos || best == m->im_start) break;
        produced++;
        int length = wlm_token_bytes(m, best, bytes, (int)sizeof bytes);
        if (length > 0 && emit && emit(context, bytes, length)) break;
        step(s, best, 1);
    }
    return produced;
}
