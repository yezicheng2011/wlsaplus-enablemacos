// SPDX-License-Identifier: Apache-2.0
// Developer tool for checking the model runtime against a real model file.
//   wlm_tool MODEL tokens TEXT          token ids of TEXT
//   wlm_tool MODEL logits ID [ID...]    top logits after feeding the ids
//   wlm_tool MODEL chat SYSTEM USER [N] greedy reply
#include "../Sources/LLM/wlm.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int print_bytes(void *context, const char *bytes, int length) { (void)context; fwrite(bytes, 1, (size_t)length, stdout); fflush(stdout); return 0; }

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: wlm_tool MODEL tokens|logits|chat ...\n"); return 2; }
    char error[200];
    wlm_model *model = wlm_load(argv[1], error, sizeof error);
    if (!model) { fprintf(stderr, "%s\n", error); return 1; }
    int status = 0;
    if (strcmp(argv[2], "tokens") == 0) {
        int32_t ids[8192];
        int n = wlm_tokenize(model, argv[3], strlen(argv[3]), ids, 8192);
        for (int i = 0; i < n; i++) printf(i ? " %d" : "%d", ids[i]);
        printf("\n");
    } else if (strcmp(argv[2], "logits") == 0) {
        wlm_session *session = wlm_session_new(model, 1024);
        int32_t ids[1024];
        int n = 0;
        for (int i = 3; i < argc && n < 1024; i++) ids[n++] = atoi(argv[i]);
        if (!session || wlm_session_feed(session, ids, n) != 0) status = 1;
        else {
            const float *logits = wlm_session_logits(session);
            int vocab = wlm_vocab_size(model);
            float previous = INFINITY;
            for (int rank = 0; rank < 8; rank++) {
                int best = -1;
                for (int i = 0; i < vocab; i++) if (logits[i] < previous && (best < 0 || logits[i] > logits[best])) best = i;
                if (best < 0) break;
                printf("%d %.4f\n", best, (double)logits[best]);
                previous = logits[best];
            }
        }
        wlm_session_free(session);
    } else if (strcmp(argv[2], "chat") == 0 && argc >= 5) {
        wlm_session *session = wlm_session_new(model, 2048);
        int n = session ? wlm_chat(session, argv[3], argv[4], argc > 5 ? atoi(argv[5]) : 128, print_bytes, NULL) : -1;
        printf("\n[%d tokens]\n", n);
        status = n < 0;
        wlm_session_free(session);
    } else status = 2;
    wlm_free(model);
    return status;
}
