// SPDX-License-Identifier: Apache-2.0
// Small on-device language model runtime for WLSAPlus. Original code; reads
// GGUF model files and runs Qwen2-style decoder-only transformers on the CPU.
#ifndef WLM_H
#define WLM_H

#include <stddef.h>
#include <stdint.h>

typedef struct wlm_model wlm_model;
typedef struct wlm_session wlm_session;

// Returns NULL and writes a message to `error` when the file is not a model
// this runtime supports. The file is validated before any tensor is read.
wlm_model *wlm_load(const char *path, char *error, size_t error_size);
void wlm_free(wlm_model *model);

int wlm_vocab_size(const wlm_model *model);
int wlm_context_limit(const wlm_model *model);

// Plain-text tokenization. Control tokens are never produced from text, so
// user input cannot forge chat-template markers. Returns the token count, or
// -1 when `capacity` is too small.
int wlm_tokenize(const wlm_model *model, const char *text, size_t length, int32_t *out, int capacity);

// Raw bytes of one token (may be a partial UTF-8 sequence). Control tokens
// yield zero bytes. Returns the byte count, or -1 when `capacity` is too small.
int wlm_token_bytes(const wlm_model *model, int32_t token, char *out, int capacity);

wlm_session *wlm_session_new(wlm_model *model, int context);
void wlm_session_free(wlm_session *session);
void wlm_session_reset(wlm_session *session);
int wlm_session_length(const wlm_session *session);

// Appends tokens to the context. Returns 0, or -1 when the context is full or
// a token is out of range. Logits are computed for the last token only.
int wlm_session_feed(wlm_session *session, const int32_t *tokens, int count);
const float *wlm_session_logits(const wlm_session *session);

// Builds a ChatML prompt from `system` and `user`, feeds it, and generates
// greedily until the model ends its turn or `max_tokens` is reached. `emit`
// receives raw token bytes; returning non-zero stops generation. Returns the
// number of generated tokens, or -1 when the prompt does not fit.
typedef int (*wlm_emit)(void *context, const char *bytes, int length);
int wlm_chat(wlm_session *session, const char *system, const char *user, int max_tokens, wlm_emit emit, void *context);

#endif
