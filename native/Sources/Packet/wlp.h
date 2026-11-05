#ifndef WLP_H
#define WLP_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Build-time limits; override with -D for tighter embeddings or stress builds. */
#ifndef WLP_FLOW_LIMIT
#define WLP_FLOW_LIMIT 1024u   /* concurrent TCP + UDP flows per engine */
#endif
#ifndef WLP_TX_BUFFERS
#define WLP_TX_BUFFERS 128u    /* 256 KiB TCP send queues held at once (32 MiB) */
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
 * Per-engine limit: WLP_FLOW_LIMIT flows (1024). Per-TCP-flow: 32 KiB receive
 * reassembly and 256 KiB unacknowledged/unsent remote data. Both buffers are
 * allocated on first use and released after a second without use, so idle flows
 * hold none. While WLP_TX_BUFFERS send queues are held, wlp_remote_capacity
 * reports 0 for a flow that has none; resume when it turns nonzero. UDP waits
 * for remote_open with at most 32 datagrams / 64 KiB. Overflow resets TCP or
 * drops the offending UDP datagram.
 * Fragment reassembly: at most 16 datagrams (~1.2 MiB), 15-second expiry;
 * overlapping/inconsistent fragments reject the entire datagram until expiry.
 * IPv6 unfragmentable headers are limited to 2048 bytes.
 *
 * This is a small TCP proxy endpoint, not a general IP router: ICMP,
 * TCP urgent data, IPv6 jumbograms and IPsec are unsupported. Negotiated TCP
 * options: MSS and window scaling (RFC 7323; the client's shift is honoured up
 * to 14 and the engine announces shift 0). No SACK, timestamps, or ECN.
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
