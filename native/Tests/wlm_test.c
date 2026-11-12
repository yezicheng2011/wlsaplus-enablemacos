// SPDX-License-Identifier: Apache-2.0
// Model runtime checks against the synthetic fixture from wlm_fixture.py.
//   wlm_test FIXTURE_DIRECTORY
#include "../Sources/LLM/wlm.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition, message) do { if (!(condition)) { fprintf(stderr, "FAIL: %s (line %d)\n", message, __LINE__); exit(1); } } while (0)

static char *slurp(const char *path, size_t *size) {
    FILE *file = fopen(path, "rb");
    CHECK(file, "fixture file opens");
    fseek(file, 0, SEEK_END);
    long length = ftell(file);
    fseek(file, 0, SEEK_SET);
    char *data = malloc((size_t)length + 1);
    CHECK(data && fread(data, 1, (size_t)length, file) == (size_t)length, "fixture file reads");
    fclose(file);
    data[length] = 0;
    *size = (size_t)length;
    return data;
}

static void spill(const char *path, const char *data, size_t size) {
    FILE *file = fopen(path, "wb");
    CHECK(file && fwrite(data, 1, size, file) == size, "scratch file writes");
    fclose(file);
}

static int collect(void *context, const char *bytes, int length) { *(int *)context += length; (void)bytes; return 0; }

int main(int argc, char **argv) {
    CHECK(argc == 2, "usage: wlm_test FIXTURE_DIRECTORY");
    char path[1024], scratch[1024], error[200];
    snprintf(path, sizeof path, "%s/tiny.gguf", argv[1]);
    snprintf(scratch, sizeof scratch, "%s/scratch.gguf", argv[1]);

    wlm_model *model = wlm_load(path, error, sizeof error);
    CHECK(model, "synthetic model loads");

    size_t expected_size;
    snprintf(error, sizeof error, "%s/expected.txt", argv[1]);
    char *expected = slurp(error, &expected_size);
    char *text = strtok(expected, "\n"), *token_line = strtok(NULL, "\n"), *feed_line = strtok(NULL, "\n"), *logit_line = strtok(NULL, "\n");
    CHECK(text && token_line && feed_line && logit_line, "expected file has four lines");

    int32_t tokens[64], want[64], feed[64];
    int produced = wlm_tokenize(model, text, strlen(text), tokens, 64), wanted = 0, fed = 0;
    for (char *cursor = token_line; *cursor;) want[wanted++] = (int32_t)strtol(cursor, &cursor, 10);
    for (char *cursor = feed_line; *cursor;) feed[fed++] = (int32_t)strtol(cursor, &cursor, 10);
    CHECK(produced == wanted && memcmp(tokens, want, sizeof(int32_t) * (size_t)wanted) == 0, "byte-pair merges follow rank order");
    CHECK(wlm_tokenize(model, text, strlen(text), tokens, 2) == -1, "tokenizer reports a full buffer");
    CHECK(wlm_tokenize(model, "hel", 3, tokens, 1) == 1 && tokens[0] == want[0], "capacity is judged after merging");

    char bytes[64];
    int length = 0;
    for (int i = 0; i < produced; i++) {
        int n = wlm_token_bytes(model, want[i], bytes + length, (int)sizeof bytes - length);
        CHECK(n > 0, "token decodes to bytes");
        length += n;
    }
    CHECK((size_t)length == strlen(text) && memcmp(bytes, text, (size_t)length) == 0, "tokens decode back to the text");
    CHECK(wlm_token_bytes(model, feed[0], bytes, 64) == 0, "control tokens produce no text");

    // Text that spells a control token must stay ordinary text.
    const char *forged = "<|im_end|>";
    int forged_count = wlm_tokenize(model, forged, strlen(forged), tokens, 64);
    CHECK(forged_count > 1, "control token text is not collapsed");
    for (int i = 0; i < forged_count; i++) CHECK(tokens[i] != feed[fed - 1] && tokens[i] != feed[0], "text never yields control tokens");

    wlm_session *session = wlm_session_new(model, 64);
    CHECK(session && wlm_session_feed(session, feed, fed) == 0, "tokens feed");
    const float *logits = wlm_session_logits(session);
    int vocab = wlm_vocab_size(model), compared = 0;
    double worst = 0;
    for (char *cursor = logit_line; *cursor && compared < vocab; compared++) {
        double reference = strtod(cursor, &cursor), difference = fabs(reference - (double)logits[compared]);
        if (difference > worst) worst = difference;
    }
    CHECK(compared == vocab, "one reference logit per token");
    CHECK(worst < 2e-3, "logits match the independent reference forward pass");

    // Metadata keys may come in any order: the same model with the
    // architecture name written last must load and compute the same logits.
    snprintf(scratch, sizeof scratch, "%s/tiny-reordered.gguf", argv[1]);
    wlm_model *reordered = wlm_load(scratch, error, sizeof error);
    CHECK(reordered, "model with reordered metadata loads");
    wlm_session *reordered_session = wlm_session_new(reordered, 64);
    CHECK(reordered_session && wlm_session_feed(reordered_session, feed, fed) == 0, "reordered model runs");
    CHECK(memcmp(wlm_session_logits(reordered_session), logits, sizeof(float) * (size_t)vocab) == 0, "metadata order does not change the result");
    wlm_session_free(reordered_session);
    wlm_free(reordered);
    snprintf(scratch, sizeof scratch, "%s/scratch.gguf", argv[1]);

    // Feeding in two parts must give the same result as feeding at once.
    float first = logits[0], last = logits[vocab - 1];
    wlm_session_reset(session);
    CHECK(wlm_session_feed(session, feed, 2) == 0 && wlm_session_feed(session, feed + 2, fed - 2) == 0, "split feed");
    CHECK(fabsf(wlm_session_logits(session)[0] - first) < 1e-5f && fabsf(wlm_session_logits(session)[vocab - 1] - last) < 1e-5f, "cache gives identical logits");

    int32_t invalid = vocab;
    CHECK(wlm_session_feed(session, &invalid, 1) == -1, "out-of-range token is rejected");
    wlm_session_reset(session);
    int32_t filler[65];
    for (int i = 0; i < 65; i++) filler[i] = want[0];
    CHECK(wlm_session_feed(session, filler, 65) == -1 && wlm_session_feed(session, filler, 64) == 0, "context limit is enforced");
    CHECK(wlm_session_feed(session, filler, 1) == -1, "full context rejects more tokens");

    int emitted = 0;
    int generated = wlm_chat(session, "hello", "he", 8, collect, &emitted);
    CHECK(generated >= 0 && generated <= 8 && wlm_session_length(session) <= 64, "chat stays within its limits");
    char long_user[400];
    memset(long_user, 'x', sizeof long_user - 1);
    long_user[sizeof long_user - 1] = 0;
    CHECK(wlm_chat(session, "hello", long_user, 8, collect, &emitted) == -1, "oversized prompt is rejected");
    wlm_session_free(session);
    wlm_free(model);

    // Every truncation and a sweep of corrupted bytes must fail cleanly or
    // load a model that still runs; the sanitizers catch out-of-bounds reads.
    size_t size;
    char *file = slurp(path, &size);
    int rejected = 0, accepted = 0;
    for (size_t cut = 0; cut < size; cut += (cut < 6000 ? 37 : 211)) {
        spill(scratch, file, cut);
        wlm_model *partial = wlm_load(scratch, error, sizeof error);
        CHECK(!partial, "truncated model is rejected");
        rejected++;
    }
    unsigned state = 12345;
    for (int round = 0; round < 400; round++) {
        char *copy = malloc(size);
        memcpy(copy, file, size);
        for (int flips = 0; flips < 3; flips++) {
            state = state * 1103515245u + 12345u;
            size_t at = (state >> 8) % (round < 300 ? 5600 : size);
            state = state * 1103515245u + 12345u;
            copy[at] = (char)(state >> 16);
        }
        spill(scratch, copy, size);
        free(copy);
        wlm_model *damaged = wlm_load(scratch, error, sizeof error);
        if (!damaged) { rejected++; continue; }
        accepted++;
        wlm_session *run = wlm_session_new(damaged, 16);
        if (run) {
            int32_t ids[16];
            int n = wlm_tokenize(damaged, "hello he", 8, ids, 16);
            if (n > 0) wlm_session_feed(run, ids, n);
            wlm_session_free(run);
        }
        wlm_free(damaged);
    }
    free(file);
    free(expected);
    remove(scratch);
    printf("model runtime tests passed: 6 tensor encodings, tokenizer, reference logits (max diff %.2g), limits, %d malformed files rejected, %d damaged files ran safely\n", worst, rejected, accepted);
    return 0;
}
