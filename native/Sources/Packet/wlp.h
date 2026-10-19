#ifndef WLP_H
#define WLP_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct wlp_engine wlp_engine;
typedef struct {
    void (*connect)(void *context, uint64_t flow, const char *host, uint16_t port, int udp);
    void (*data)(void *context, uint64_t flow, const uint8_t *bytes, size_t length);
    void (*close)(void *context, uint64_t flow);
    void (*packet)(void *context, const uint8_t *bytes, size_t length);
    /* Optional TCP write-half closure; continue delivering remote reads. */
    void (*eof)(void *context, uint64_t flow);
} wlp_callbacks;

/* All functions and callbacks run on one serial execution context. Callbacks
 * must not reenter the engine. Callback pointers/data are valid only during the
 * callback. Call tick with monotonic milliseconds before processing traffic and
 * at least every 100 ms thereafter. Raw packets exclude the utun AF prefix.
 *
 * Per-engine limit: 128 flows. Per-TCP-flow: 32 KiB receive reassembly and 256 KiB
 * unacknowledged/unsent remote data. UDP waits for remote_open with at most 32
 * datagrams / 64 KiB. Overflow resets TCP or drops the offending UDP datagram.
 * Fragment reassembly: at most 16 datagrams (~1.2 MiB), 15-second expiry;
 * overlapping/inconsistent fragments reject the entire datagram until expiry.
 * IPv6 unfragmentable headers are limited to 2048 bytes.
 *
 * This is a small TCP proxy endpoint, not a general IP router: ICMP,
 * TCP urgent data, IPv6 jumbograms and IPsec are unsupported. No TCP option
 * is negotiated other than MSS; no window scaling, SACK, timestamps, or ECN.
 */
wlp_engine *wlp_new(wlp_callbacks callbacks, void *context);
/* 0 accepted/handled; -1 malformed, unsupported, or resource exhausted. */
int wlp_input(wlp_engine *engine, const uint8_t *packet, size_t length);
void wlp_remote_open(wlp_engine *engine, uint64_t flow);
int wlp_remote_data(wlp_engine *engine, uint64_t flow, const uint8_t *bytes, size_t length);
/* TCP queue space; 0 while not ready, closing, or unknown. UDP returns the
 * largest supported payload. Call after each input/tick to resume paused reads. */
size_t wlp_remote_capacity(wlp_engine *engine, uint64_t flow);
/* Abort a failed remote transport with TCP RST; distinct from orderly EOF. */
void wlp_remote_abort(wlp_engine *engine, uint64_t flow);
/* TCP orderly remote EOF; UDP close. A failure before open produces TCP RST. */
void wlp_remote_close(wlp_engine *engine, uint64_t flow);
void wlp_tick(wlp_engine *engine, uint64_t now_ms);
void wlp_free(wlp_engine *engine);
#ifdef __cplusplus
}
#endif
#endif
