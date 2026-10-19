/* Protocol-level tests built with independent packet constructors. */
#include "../Sources/Packet/wlp.h"
#include "../Sources/Packet/utun.h"
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FIN 1
#define SYN 2
#define RST 4
#define PSH 8
#define ACK 16
#define MAX_CAPTURE 256

typedef struct { size_t length; uint8_t bytes[2048]; } packet;
typedef struct {
    uint64_t id;
    unsigned connects, closes, eofs, data_calls;
    int udp;
    char host[64];
    uint8_t data[131072];
    size_t data_length;
    packet packets[MAX_CAPTURE];
    unsigned packet_count;
} observer;
static uint16_t u16(const uint8_t *b) { return (uint16_t)((unsigned)b[0] * 256 + b[1]); }
static uint32_t u32(const uint8_t *b) { return (uint32_t)u16(b) * 65536u + u16(b + 2); }
static void s16(uint8_t *b, uint16_t x) { b[0] = (uint8_t)(x / 256); b[1] = (uint8_t)x; }
static void s32(uint8_t *b, uint32_t x) { s16(b, (uint16_t)(x >> 16)); s16(b + 2, (uint16_t)x); }
static uint16_t checksum(const uint8_t *b, size_t n) {
    uint64_t sum = 0;
    for (size_t i = 0; i < n; ++i) sum += (uint64_t)b[i] << (i % 2 ? 0 : 8);
    while (sum > 65535) sum = (sum & 65535) + (sum >> 16);
    return (uint16_t)(65535 - sum);
}
static uint16_t pseudo(const uint8_t *p, size_t transport_offset, size_t length, unsigned protocol) {
    uint8_t bytes[66000];
    size_t addresses = p[0] >> 4 == 4 ? 8 : 32;
    size_t address_offset = p[0] >> 4 == 4 ? 12 : 8;
    memcpy(bytes, p + address_offset, addresses);
    memset(bytes + addresses, 0, 8);
    size_t prefix = addresses + (addresses == 8 ? 4 : 8);
    if (addresses == 8) {
        bytes[addresses + 1] = (uint8_t)protocol;
        s16(bytes + addresses + 2, (uint16_t)length);
    } else {
        s32(bytes + addresses, (uint32_t)length);
        bytes[addresses + 7] = (uint8_t)protocol;
    }
    memcpy(bytes + prefix, p + transport_offset, length);
    return checksum(bytes, prefix + length);
}
static size_t ip(uint8_t *p, int version, unsigned protocol, size_t length, int extension) {
    size_t header = version == 4 ? 20 : 40;
    memset(p, 0, header + length + (extension ? 8 : 0));
    if (version == 4) {
        p[0] = 0x45; s16(p + 2, (uint16_t)(header + length)); p[8] = 64; p[9] = (uint8_t)protocol;
        p[12] = 10; p[15] = 2; p[16] = 203; p[18] = 113; p[19] = 44;
        s16(p + 10, checksum(p, 20));
    } else {
        p[0] = 0x60; s16(p + 4, (uint16_t)(length + (extension ? 8 : 0))); p[6] = (uint8_t)(extension ? 0 : protocol); p[7] = 64;
        p[8] = 0x20; p[9] = 1; p[10] = 0x0d; p[11] = 0xb8; p[23] = 2;
        p[24] = 0x20; p[25] = 1; p[26] = 0x0d; p[27] = 0xb8; p[39] = 0x44;
        if (extension) { p[40] = (uint8_t)protocol; header += 8; }
    }
    return header;
}
static size_t tcp(uint8_t *p, int version, uint32_t seq, uint32_t ack, unsigned flags,
                  unsigned window, const void *data, size_t length) {
    size_t offset = ip(p, version, 6, length + 20, 0);
    uint8_t *t = p + offset;
    s16(t, 49152); s16(t + 2, 443); s32(t + 4, seq); s32(t + 8, ack);
    t[12] = 0x50; t[13] = (uint8_t)flags; s16(t + 14, (uint16_t)window);
    if (length) memcpy(t + 20, data, length);
    s16(t + 16, pseudo(p, offset, length + 20, 6));
    return offset + 20 + length;
}
static size_t udp(uint8_t *p, int version, int extension, const void *data, size_t length) {
    size_t offset = ip(p, version, 17, length + 8, extension);
    uint8_t *u = p + offset;
    s16(u, 53000); s16(u + 2, 53); s16(u + 4, (uint16_t)(length + 8));
    if (length) memcpy(u + 8, data, length);
    uint16_t sum = pseudo(p, offset, length + 8, 17);
    s16(u + 6, sum ? sum : 65535);
    return offset + 8 + length;
}
static size_t offset(const packet *p) { return p->bytes[0] >> 4 == 4 ? 20 : 40; }
static uint8_t flags(const packet *p) { return p->bytes[offset(p) + 13]; }
static uint32_t sequence(const packet *p) { return u32(p->bytes + offset(p) + 4); }
static uint32_t acknowledge(const packet *p) { return u32(p->bytes + offset(p) + 8); }
static size_t payload_size(const packet *p) { size_t o = offset(p); return p->length - o - (p->bytes[o + 12] >> 4) * 4u; }
static packet *last(observer *o) { assert(o->packet_count); return &o->packets[o->packet_count - 1]; }
static void on_connect(void *context, uint64_t id, const char *host, uint16_t port, int is_udp) {
    observer *o = context;
    assert(port == (is_udp ? 53 : 443));
    o->id = id; ++o->connects; o->udp = is_udp;
    assert(strlen(host) < sizeof(o->host)); strcpy(o->host, host);
}
static void on_data(void *context, uint64_t id, const uint8_t *bytes, size_t length) {
    observer *o = context;
    assert(id && length <= sizeof(o->data) - o->data_length);
    if (length) memcpy(o->data + o->data_length, bytes, length);
    o->data_length += length; ++o->data_calls;
}
static void on_close(void *context, uint64_t id) { observer *o = context; assert(id); ++o->closes; }
static void on_eof(void *context, uint64_t id) { observer *o = context; assert(id); ++o->eofs; }
static void on_packet(void *context, const uint8_t *bytes, size_t length) {
    observer *o = context;
    assert(o->packet_count < MAX_CAPTURE && length <= 65575);
    size_t off = bytes[0] >> 4 == 4 ? 20 : 40;
    unsigned protocol = bytes[0] >> 4 == 4 ? bytes[9] : bytes[6];
    if (off == 20) { assert(u16(bytes + 2) == length); assert(checksum(bytes, 20) == 0); }
    else assert(u16(bytes + 4) + 40u == length);
    assert(pseudo(bytes, off, length - off, protocol) == 0);
    assert(u16(bytes + off) == (protocol == 17 ? 53 : 443));
    assert(u16(bytes + off + 2) == (protocol == 17 ? 53000 : 49152));
    packet *p = &o->packets[o->packet_count++]; p->length = length; memcpy(p->bytes, bytes, length < sizeof(p->bytes) ? length : sizeof(p->bytes));
}
static wlp_engine *engine(observer *o) {
    memset(o, 0, sizeof(*o));
    wlp_callbacks callbacks = {on_connect, on_data, on_close, on_packet, on_eof};
    wlp_engine *e = wlp_new(callbacks, o); assert(e); wlp_tick(e, 0); return e;
}
static uint32_t handshake(wlp_engine *e, observer *o, int version, uint32_t client, unsigned window) {
    uint8_t p[256];
    size_t n = tcp(p, version, client, 0, SYN, window, NULL, 0);
    assert(wlp_input(e, p, n) == 0); assert(o->connects == 1); assert(o->packet_count == 0);
    wlp_remote_open(e, o->id); assert(o->packet_count == 1);
    assert(flags(last(o)) == (SYN | ACK)); assert(acknowledge(last(o)) == client + 1);
    uint32_t server = sequence(last(o)) + 1;
    n = tcp(p, version, client + 1, server, ACK, window, NULL, 0);
    assert(wlp_input(e, p, n) == 0);
    return server;
}
static void test_loss_order_and_close(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o);
    wlp_engine *e = engine(o); uint8_t p[2048];
    size_t n = tcp(p, 4, 100, 0, SYN, 32768, NULL, 0);
    assert(wlp_input(e, p, n) == 0); assert(strcmp(o->host, "203.0.113.44") == 0);
    wlp_remote_open(e, o->id); uint32_t server = sequence(last(o)) + 1;
    wlp_tick(e, 1000); assert(o->packet_count == 2); assert(sequence(last(o)) == server - 1);
    n = tcp(p, 4, 101, server, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    n = tcp(p, 4, 106, server, ACK | PSH, 32768, "world", 5); assert(wlp_input(e, p, n) == 0);
    assert(o->data_length == 0 && acknowledge(last(o)) == 101);
    n = tcp(p, 4, 101, server, ACK | PSH, 32768, "hello", 5); assert(wlp_input(e, p, n) == 0);
    assert(o->data_length == 10 && memcmp(o->data, "helloworld", 10) == 0 && acknowledge(last(o)) == 111);
    assert(wlp_input(e, p, n) == 0); assert(o->data_length == 10);
    uint8_t remote[3000]; for (size_t i = 0; i < sizeof(remote); ++i) remote[i] = (uint8_t)i;
    unsigned initial = o->packet_count;
    assert(wlp_remote_data(e, o->id, remote, sizeof(remote)) == 0);
    assert(o->packet_count == initial + 1 && payload_size(&o->packets[initial]) == 1200);
    assert(sequence(&o->packets[initial]) == server);
    wlp_tick(e, 2000); assert(o->packet_count == initial + 2 && sequence(last(o)) == server);
    assert(payload_size(last(o)) == 1200 && memcmp(last(o)->bytes + 40, remote, 1200) == 0);
    n = tcp(p, 4, 111, server + 1200, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    n = tcp(p, 4, 111, server + 2400, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    assert(sequence(last(o)) == server + 2400 && payload_size(last(o)) == 600);
    n = tcp(p, 4, 111, server + 3000, FIN | ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    assert(o->eofs == 1 && acknowledge(last(o)) == 112);
    wlp_remote_close(e, o->id); assert(flags(last(o)) == (FIN | ACK)); assert(sequence(last(o)) == server + 3000);
    wlp_tick(e, 3000); assert(flags(last(o)) == (FIN | ACK) && sequence(last(o)) == server + 3000);
    n = tcp(p, 4, 112, server + 3001, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0); assert(o->closes == 1);
    n = tcp(p, 4, 111, server + 3001, FIN | ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0); assert(o->eofs == 1);
    assert(wlp_remote_data(e, o->id, remote, 1) == -1);
    wlp_tick(e, 63000); wlp_free(e); assert(o->closes == 1); free(o);
}
static void test_window_ack_reset(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o);
    uint32_t server = handshake(e, o, 4, 500, 0); uint8_t p[512]; unsigned count = o->packet_count;
    assert(wlp_remote_capacity(e, o->id) == 262144);
    assert(wlp_remote_data(e, o->id, (const uint8_t *)"abc", 3) == 0 && o->packet_count == count);
    assert(wlp_remote_capacity(e, o->id) == 262141);
    wlp_tick(e, 1000); assert(sequence(last(o)) == server - 1 && payload_size(last(o)) == 0);
    size_t n = tcp(p, 4, 501, server, ACK, 2, NULL, 0); assert(wlp_input(e, p, n) == 0);
    assert(sequence(last(o)) == server && payload_size(last(o)) == 2);
    n = tcp(p, 4, 501, server + 50000, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    wlp_tick(e, 2000); assert(sequence(last(o)) == server && payload_size(last(o)) == 2);
    n = tcp(p, 4, 501, server + 2, ACK, 32768, NULL, 0); assert(wlp_input(e, p, n) == 0);
    assert(sequence(last(o)) == server + 2 && payload_size(last(o)) == 1);
    assert(wlp_remote_capacity(e, o->id) == 262143);
    n = tcp(p, 4, 502, 0, RST, 0, NULL, 0); assert(wlp_input(e, p, n) == 0); assert(o->closes == 0 && flags(last(o)) == ACK);
    n = tcp(p, 4, 501, 0, RST, 0, NULL, 0); assert(wlp_input(e, p, n) == 0); assert(o->closes == 1);
    wlp_free(e); free(o);
}
static void test_ipv6_wrap_and_fin_gap(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o);
    uint32_t client = UINT32_MAX - 2, server = handshake(e, o, 6, client, 32768); uint8_t p[512];
    assert(strcmp(o->host, "2001:db8::44") == 0);
    size_t n = tcp(p, 6, 1, server, ACK | FIN, 32768, "z", 1); assert(wlp_input(e, p, n) == 0);
    assert(o->eofs == 0 && o->data_length == 0);
    n = tcp(p, 6, UINT32_MAX - 1, server, ACK, 32768, "abc", 3); assert(wlp_input(e, p, n) == 0);
    assert(o->data_length == 4 && memcmp(o->data, "abcz", 4) == 0 && o->eofs == 1 && acknowledge(last(o)) == 3);
    assert(wlp_remote_data(e, o->id, (const uint8_t *)"reply", 5) == 0);
    assert(payload_size(last(o)) == 5);
    wlp_remote_close(e, o->id); assert(flags(last(o)) == (FIN | ACK));
    wlp_free(e); free(o);
}
static void test_udp(int version, int extension) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o); uint8_t p[512];
    size_t n = udp(p, version, extension, "one", 3); assert(wlp_input(e, p, n) == 0);
    n = udp(p, version, extension, "two", 3); assert(wlp_input(e, p, n) == 0);
    assert(o->connects == 1 && o->udp && o->data_length == 0);
    wlp_remote_open(e, o->id); assert(o->data_calls == 2 && o->data_length == 6 && memcmp(o->data, "onetwo", 6) == 0);
    assert(wlp_remote_data(e, o->id, (const uint8_t *)"dns-response", 12) == 0);
    assert(last(o)->length == (size_t)(version == 4 ? 40 : 60));
    n = udp(p, version, extension, NULL, 0); assert(wlp_input(e, p, n) == 0); assert(o->data_calls == 3);
    wlp_tick(e, 15000); assert(o->closes == 0); wlp_tick(e, 60000); assert(o->closes == 1);
    wlp_free(e); free(o);
}
static void test_limits_timeouts_and_fast_retransmit(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o); uint8_t p[2048], data[2400]; memset(data, 42, sizeof(data));
    uint32_t server = handshake(e, o, 4, 700, 32768);
    assert(wlp_remote_data(e, o->id, data, sizeof(data)) == 0);
    unsigned count = o->packet_count;
    size_t n = tcp(p, 4, 701, server, ACK, 32768, NULL, 0);
    for (int i = 0; i < 3; ++i) assert(wlp_input(e, p, n) == 0);
    assert(o->packet_count == count + 1 && sequence(last(o)) == server);
    assert(wlp_remote_data(e, o->id, data, 262145) == -1); assert(o->closes == 1 && (flags(last(o)) & RST));
    wlp_free(e);
    e = engine(o); n = tcp(p, 4, 1, 0, SYN, 1234, NULL, 0); assert(wlp_input(e, p, n) == 0);
    wlp_tick(e, 15000); assert(o->closes == 1 && (flags(last(o)) & RST)); wlp_free(e);
    e = engine(o);
    for (unsigned i = 0; i < 129; ++i) {
        n = udp(p, 4, 0, "x", 1); p[15] = (uint8_t)(i + 1); p[10] = p[11] = 0; s16(p + 10, checksum(p, 20));
        p[26] = p[27] = 0; s16(p + 26, pseudo(p, 20, 9, 17));
        assert(wlp_input(e, p, n) == (i < 128 ? 0 : -1));
    }
    assert(o->connects == 128); wlp_remote_abort(e, o->id); assert(o->closes == 1);
    assert(wlp_remote_capacity(e, o->id) == 0); wlp_free(e); assert(o->closes == 128); free(o);
}
static size_t fragment_packet(uint8_t *out, const uint8_t *whole, size_t start, size_t count, int more, uint32_t id) {
    int version = whole[0] >> 4;
    size_t prefix = version == 4 ? 20 : (whole[6] == 0 ? 48 : 40);
    memcpy(out, whole, prefix);
    if (version == 4) {
        s16(out + 2, (uint16_t)(prefix + count)); s16(out + 4, (uint16_t)id);
        s16(out + 6, (uint16_t)((start / 8) | (more ? 0x2000 : 0)));
        out[10] = out[11] = 0; s16(out + 10, checksum(out, prefix));
    } else {
        size_t previous_next = prefix == 40 ? 6 : 40;
        out[previous_next] = 44;
        memset(out + prefix, 0, 8); out[prefix] = whole[previous_next];
        s16(out + prefix + 2, (uint16_t)(start | !!more)); s32(out + prefix + 4, id);
        s16(out + 4, (uint16_t)(prefix - 40 + 8 + count));
    }
    size_t header = prefix + (version == 6 ? 8 : 0);
    memcpy(out + header, whole + prefix + start, count);
    return header + count;
}
static void test_fragment_reassembly(int version, int extension) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o);
    uint8_t whole[5000], part[2048], payload[4097];
    for (size_t i = 0; i < sizeof(payload); ++i) payload[i] = (uint8_t)(i * 3);
    (void)udp(whole, version, extension, payload, sizeof(payload));
    size_t n = fragment_packet(part, whole, 3600, 505, 0, 700); assert(wlp_input(e, part, n) == 0);
    n = fragment_packet(part, whole, 1200, 1200, 1, 700); assert(wlp_input(e, part, n) == 0);
    n = fragment_packet(part, whole, 0, 1200, 1, 700); assert(wlp_input(e, part, n) == 0); assert(o->connects == 0);
    n = fragment_packet(part, whole, 2400, 1200, 1, 700); assert(wlp_input(e, part, n) == 0); assert(o->connects == 1);
    wlp_remote_open(e, o->id); assert(o->data_calls == 1 && o->data_length == sizeof(payload));
    assert(memcmp(o->data, payload, sizeof(payload)) == 0);
    size_t large_length = version == 4 ? 65507 : 65527;
    uint8_t *large = malloc(large_length); assert(large); memset(large, 19, large_length);
    assert(wlp_remote_data(e, o->id, large, large_length) == 0);
    assert(last(o)->length == large_length + (size_t)(version == 4 ? 28 : 48));
    assert(wlp_remote_data(e, o->id, large, large_length + 1) == -1);
    free(large); wlp_free(e); free(o);
}
static void test_maximum_fragment_payload(int version) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o);
    size_t length = version == 4 ? 65507 : 65527;
    uint8_t *payload = malloc(length), *whole = malloc(65575), part[2048]; assert(payload && whole);
    for (size_t i = 0; i < length; ++i) payload[i] = (uint8_t)(i * 7);
    (void)udp(whole, version, 0, payload, length);
    // Reverse-order arrival at the largest legal IP/UDP length.
    size_t fragmentable = length + 8;
    size_t final_start = (fragmentable - 1) / 1200 * 1200;
    for (size_t start = final_start;; start -= 1200) {
        size_t count = fragmentable - start > 1200 ? 1200 : fragmentable - start;
        size_t n = fragment_packet(part, whole, start, count, start + count < fragmentable, 99);
        assert(wlp_input(e, part, n) == 0);
        if (!start) break;
    }
    assert(o->connects == 1); wlp_remote_open(e, o->id);
    assert(o->data_length == length && memcmp(o->data, payload, length) == 0);
    wlp_free(e); free(whole); free(payload); free(o);
}
static void test_fragment_rejection_and_expiry(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o); uint8_t whole[5000], part[2048], payload[2400]; memset(payload, 17, sizeof(payload));
    for (int version = 4; version <= 6; version += 2) {
        wlp_engine *e = engine(o); (void)udp(whole, version, 0, payload, sizeof(payload));
        size_t n = fragment_packet(part, whole, 0, 1200, 1, 1); assert(wlp_input(e, part, n) == 0);
        n = fragment_packet(part, whole, 800, 1200, 1, 1); assert(wlp_input(e, part, n) == -1); assert(o->connects == 0);
        n = fragment_packet(part, whole, 0, 1200, 1, 1); assert(wlp_input(e, part, n) == -1);
        // Inconsistent final length after a fragment extending past its end.
        n = fragment_packet(part, whole, 1200, 1200, 1, 2); assert(wlp_input(e, part, n) == 0);
        n = fragment_packet(part, whole, 800, 800, 0, 2); assert(wlp_input(e, part, n) == -1);
        n = fragment_packet(part, whole, 0, 1200, 1, 3); assert(wlp_input(e, part, n) == 0);
        wlp_tick(e, 15000);
        n = fragment_packet(part, whole, 1200, 1200, 1, 3); assert(wlp_input(e, part, n) == 0);
        n = fragment_packet(part, whole, 2400, 8, 0, 3); assert(wlp_input(e, part, n) == 0); assert(o->connects == 0);
        wlp_free(e);
        e = engine(o);
        for (unsigned i = 0; i < 17; ++i) {
            n = fragment_packet(part, whole, 0, 1200, 1, i + 100); assert(wlp_input(e, part, n) == (i < 16 ? 0 : -1));
        }
        wlp_tick(e, 15000);
        n = fragment_packet(part, whole, 0, 1200, 1, 999); assert(wlp_input(e, part, n) == 0);
        wlp_free(e);
    }
    // Atomic IPv6 fragments do not interfere with the same-ID partial datagram.
    wlp_engine *e = engine(o); (void)udp(whole, 6, 0, "atomic", 6);
    size_t n = fragment_packet(part, whole, 0, 8, 1, 11); assert(wlp_input(e, part, n) == 0);
    n = fragment_packet(part, whole, 0, 14, 0, 11); assert(wlp_input(e, part, n) == 0); assert(o->connects == 1);
    wlp_remote_open(e, o->id); assert(o->data_length == 6);
    wlp_free(e); free(o);
}

/* SYN with optional TCP options. option_bytes is the raw option list (may be empty). */
static size_t tcp_syn_opts(uint8_t *p, int version, uint32_t seq, unsigned window,
                           const uint8_t *option_bytes, size_t option_length) {
    size_t padded = (option_length + 3) & ~((size_t)3);
    size_t header = 20 + padded;
    size_t offset = ip(p, version, 6, header, 0);
    uint8_t *t = p + offset;
    memset(t, 0, header);
    s16(t, 49152); s16(t + 2, 443); s32(t + 4, seq); s32(t + 8, 0);
    t[12] = (uint8_t)((header / 4) << 4); t[13] = (uint8_t)SYN; s16(t + 14, (uint16_t)window);
    if (option_length) memcpy(t + 20, option_bytes, option_length);
    s16(t + 16, pseudo(p, offset, header, 6));
    return offset + header;
}
static void test_tcp_option_policy(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o);
    wlp_engine *e = engine(o);
    uint8_t p[512], opts[16];
    /* Plain SYN without options still accepted. */
    size_t n = tcp_syn_opts(p, 4, 1, 8192, NULL, 0);
    assert(wlp_input(e, p, n) == 0);
    assert(o->connects == 1);
    wlp_remote_abort(e, o->id);
    wlp_free(e);

    /* MSS=1200 on SYN is accepted (only negotiated TCP option). */
    e = engine(o); o->connects = 0; o->closes = 0; o->packet_count = 0;
    opts[0] = 2; opts[1] = 4; opts[2] = 0x04; opts[3] = 0xb0; /* MSS 1200 */
    n = tcp_syn_opts(p, 4, 2, 8192, opts, 4);
    assert(wlp_input(e, p, n) == 0);
    assert(o->connects == 1);
    wlp_remote_abort(e, o->id);
    wlp_free(e);

    /* MSS below 64 is rejected (malformed). */
    e = engine(o); o->connects = 0;
    opts[0] = 2; opts[1] = 4; opts[2] = 0; opts[3] = 32;
    n = tcp_syn_opts(p, 4, 3, 8192, opts, 4);
    assert(wlp_input(e, p, n) == -1);
    assert(o->connects == 0);
    wlp_free(e);

    /* SACK-permitted (kind 4) is ignored, not negotiated; SYN still accepted. */
    e = engine(o); o->connects = 0; o->packet_count = 0;
    opts[0] = 4; opts[1] = 2; /* SACK permitted */
    n = tcp_syn_opts(p, 4, 4, 8192, opts, 2);
    assert(wlp_input(e, p, n) == 0);
    assert(o->connects == 1);
    assert(o->packet_count == 0);
    wlp_remote_open(e, o->id);
    assert(o->packet_count >= 1);
    assert((flags(last(o)) & (SYN | ACK)) == (SYN | ACK));
    {
        packet *synack = last(o);
        size_t off = offset(synack);
        size_t hdr = (synack->bytes[off + 12] >> 4) * 4u;
        /* SYN-ACK carries at most MSS (kind 2); never SACK/WScale/timestamp. */
        assert(hdr == 20 || hdr == 24);
        for (size_t i = 20; i + 1 < hdr;) {
            uint8_t kind = synack->bytes[off + i];
            if (kind == 0) break;
            if (kind == 1) { ++i; continue; }
            assert(kind == 2);
            assert(i + 1 < hdr);
            i += synack->bytes[off + i + 1];
        }
    }
    wlp_remote_abort(e, o->id);
    wlp_free(e);
    free(o);
}

static void test_malformed(void) {
    observer *o = calloc(1, sizeof(*o)); assert(o); wlp_engine *e = engine(o); uint8_t p[2048], valid[512];
    size_t n = udp(valid, 4, 0, "test", 4);
    for (size_t i = 0; i < n; ++i) assert(wlp_input(e, valid, i) == -1);
    memcpy(p, valid, n); p[20 + 8] ^= 1; assert(wlp_input(e, p, n) == -1);
    memcpy(p, valid, n); p[6] = 0x20; p[10] = p[11] = 0; s16(p + 10, checksum(p, 20)); assert(wlp_input(e, p, n) == -1);
    memcpy(p, valid, n); p[0] = 0x44; assert(wlp_input(e, p, n) == -1);
    n = udp(p, 6, 0, "test", 4); p[46] = p[47] = 0; assert(wlp_input(e, p, n) == -1);
    n = udp(p, 6, 1, "test", 4); p[42] = 0x80; assert(wlp_input(e, p, n) == -1);
    n = udp(p, 6, 1, "test", 4); p[6] = 44; p[41] = 1; assert(wlp_input(e, p, n) == -1);
    n = tcp(p, 4, 1, 0, SYN | FIN, 123, NULL, 0); assert(wlp_input(e, p, n) == -1);
    n = tcp(p, 4, 1, 0, SYN, 123, NULL, 0); p[32] = 0xf0; assert(wlp_input(e, p, n) == -1);
    uint32_t rng = 0x12345678;
    for (unsigned run = 0; run < 20000; ++run) {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        size_t length = rng % sizeof(p);
        for (size_t i = 0; i < length; ++i) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; p[i] = (uint8_t)rng; }
        (void)wlp_input(e, p, length);
    }
    assert(o->connects == 0); wlp_free(e); free(o);
}
int main(void) {
    test_loss_order_and_close();
    test_window_ack_reset();
    test_ipv6_wrap_and_fin_gap();
    test_udp(4, 0); test_udp(6, 0); test_udp(6, 1);
    test_limits_timeouts_and_fast_retransmit();
    test_fragment_reassembly(4, 0); test_fragment_reassembly(6, 0); test_fragment_reassembly(6, 1);
    test_maximum_fragment_payload(4); test_maximum_fragment_payload(6);
    test_fragment_rejection_and_expiry(); test_tcp_option_policy(); test_malformed();
#ifndef __APPLE__
    char name[32]; errno = 0; assert(wl_tun_open(name, sizeof(name)) == -1 && errno == ENOTSUP);
#endif
    puts("packet tests passed: TCP loss/order/window/FIN/RST/wrap/limits/options; IPv4/IPv6 UDP/fragments; malformed corpus");
    return 0;
}
