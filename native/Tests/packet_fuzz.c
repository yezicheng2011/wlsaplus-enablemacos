/* Stateful, structure-aware fuzzer for the wlp packet engine.
 *
 * Unlike the random-byte corpus in packet_test.c (which mostly stops at the
 * checksum gate), every generated packet here carries valid IP/TCP/UDP
 * checksums so the fuzzer reaches the TCP state machine, reassembly, flow
 * limits, fragment cache and remote-side API. It checks engine invariants on
 * every callback:
 *
 *   - flow ids are fresh on connect; data/eof/close only for live ids;
 *     close at most once, eof at most once, no TCP data after eof;
 *   - at most 128 live flows;
 *   - delivered TCP bytes are exactly the client stream, in order (payload
 *     bytes are a pure function of tuple + sequence number, so any
 *     misordering, duplication or corruption is caught);
 *   - every emitted packet has valid lengths and checksums, swapped ports,
 *     TCP payload <= MSS, and a sane advertised window;
 *   - remote capacity never exceeds the documented TX limit.
 *
 * Build (portable):   see scripts/run-packet-tests.sh
 * Iterations:         MOCKMINI_FUZZ_STEPS (default 200000), MOCKMINI_FUZZ_SEED
 * libFuzzer:          clang -fsanitize=fuzzer,address,undefined -DMOCKMINI_LIBFUZZER ...
 */
#include "../Sources/Packet/wlp.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FIN 1u
#define SYN 2u
#define RST 4u
#define PSH 8u
#define ACK 16u
#define URG 32u
#define TUPLES 160u          /* > 128 so the flow limit is exercised */
#define MSS_CAP 1200u
#define TX_CAP 262144u
#define RX_CAP 32768u

#define REQUIRE(cond) do { if (!(cond)) { \
    fprintf(stderr, "packet_fuzz invariant failed: %s (%s:%d) step=%lu seed=%lu\n", \
            #cond, __FILE__, __LINE__, (unsigned long)g_step, (unsigned long)g_seed); \
    abort(); } } while (0)

static unsigned long g_step, g_seed;

/* ---------- input source: PRNG or libFuzzer bytes ---------- */
typedef struct { const uint8_t *data; size_t size, at; uint64_t state; } source;
static uint32_t next32(source *s) {
    if (s->data) {
        uint32_t v = 0;
        for (int i = 0; i < 4; ++i) v = v << 8 | (s->at < s->size ? s->data[s->at++] : 0);
        return v;
    }
    s->state ^= s->state << 13; s->state ^= s->state >> 7; s->state ^= s->state << 17;
    return (uint32_t)(s->state >> 16);
}
static uint32_t pick(source *s, uint32_t n) { return n ? next32(s) % n : 0; }
static int exhausted(const source *s) { return s->data && s->at >= s->size; }

/* ---------- wire helpers (independent of wlp.c) ---------- */
static uint16_t g16(const uint8_t *b) { return (uint16_t)(b[0] << 8 | b[1]); }
static uint32_t g32(const uint8_t *b) { return (uint32_t)g16(b) << 16 | g16(b + 2); }
static void p16(uint8_t *b, uint32_t v) { b[0] = (uint8_t)(v >> 8); b[1] = (uint8_t)v; }
static void p32(uint8_t *b, uint32_t v) { p16(b, v >> 16); p16(b + 2, v); }
static uint32_t add(uint32_t sum, const uint8_t *b, size_t n) {
    for (size_t i = 0; i + 1 < n; i += 2) sum += g16(b + i);
    if (n & 1) sum += (uint32_t)b[n - 1] << 8;
    return sum;
}
static uint16_t fold(uint32_t sum) { while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16); return (uint16_t)~sum; }
static uint16_t l4sum(int v6, unsigned proto, const uint8_t *src, const uint8_t *dst, const uint8_t *l4, size_t n) {
    uint32_t sum = add(add(0, src, v6 ? 16 : 4), dst, v6 ? 16 : 4);
    sum += proto; sum += (uint32_t)(n >> 16); sum += (uint32_t)(n & 0xffff);
    return fold(add(sum, l4, n));
}

/* ---------- tuples and shadow state ---------- */
typedef struct {
    int v6, udp;
    uint16_t sport, dport;
    uint64_t id;            /* current live flow id, 0 if none */
    uint32_t client_isn;    /* SYN sequence used for the live flow */
    uint32_t client_next;   /* next sequence we intend to send */
    uint32_t server_next;   /* server sequence seen after SYN-ACK / data */
    int have_server;
    uint32_t last_ack;      /* previous ACK value we sent (dup-ACK generation) */
} tuple;
typedef struct { int live, closed, eof; uint64_t delivered; int udp; unsigned t; } shadow;

typedef struct {
    tuple tuples[TUPLES];
    shadow *ids;
    size_t id_cap;
    uint64_t max_id;
    unsigned live;
    int in_input;           /* tuple index of the packet being injected, or -1 */
    uint64_t now;
} world;

static const uint8_t SRC4[4] = {10, 0, 0, 2}, DST4[4] = {203, 0, 113, 44};
static const uint8_t SRC6[16] = {0x20, 1, 0x0d, 0xb8, [15] = 2}, DST6[16] = {0x20, 1, 0x0d, 0xb8, [15] = 0x44};

static uint8_t stream_byte(const tuple *t, uint32_t seq) {
    uint32_t x = seq * 2654435761u ^ (uint32_t)t->sport * 40503u ^ (t->v6 ? 0x9e37u : 0);
    x ^= x >> 15; x *= 2246822519u; x ^= x >> 13;
    return (uint8_t)x;
}
static shadow *lookup(world *w, uint64_t id) { REQUIRE(id && id <= w->max_id); return &w->ids[id]; }

/* ---------- callbacks with invariants ---------- */
static void on_connect(void *ctx, uint64_t id, const char *host, uint16_t port, int udp) {
    world *w = ctx;
    REQUIRE(w->in_input >= 0);
    REQUIRE(id > w->max_id);
    if (id >= w->id_cap) {
        size_t cap = w->id_cap ? w->id_cap : 1024;
        while (cap <= id) cap *= 2;
        shadow *grown = realloc(w->ids, cap * sizeof(*grown));
        REQUIRE(grown);
        memset(grown + w->id_cap, 0, (cap - w->id_cap) * sizeof(*grown));
        w->ids = grown; w->id_cap = cap;
    }
    REQUIRE(host && host[0]);
    tuple *t = &w->tuples[w->in_input];
    REQUIRE(port == t->dport && udp == t->udp);
    REQUIRE(t->id == 0);
    w->max_id = id;
    shadow *s = &w->ids[id];
    memset(s, 0, sizeof(*s)); s->live = 1; s->udp = udp; s->t = (unsigned)w->in_input;
    t->id = id; t->have_server = 0;
    REQUIRE(++w->live <= 128);
}
static void on_data(void *ctx, uint64_t id, const uint8_t *bytes, size_t n) {
    world *w = ctx; shadow *s = lookup(w, id);
    REQUIRE(s->live && !s->closed);
    REQUIRE(n == 0 || bytes);
    if (s->udp) { REQUIRE(n <= 65527); return; }
    REQUIRE(!s->eof && n <= RX_CAP);
    tuple *t = &w->tuples[s->t];
    for (size_t i = 0; i < n; ++i)
        REQUIRE(bytes[i] == stream_byte(t, t->client_isn + 1 + (uint32_t)(s->delivered + i)));
    s->delivered += n;
}
static void on_eof(void *ctx, uint64_t id) {
    world *w = ctx; shadow *s = lookup(w, id);
    REQUIRE(s->live && !s->closed && !s->udp && !s->eof);
    s->eof = 1;
}
static void on_close(void *ctx, uint64_t id) {
    world *w = ctx; shadow *s = lookup(w, id);
    REQUIRE(s->live && !s->closed);
    s->closed = 1; s->live = 0;
    REQUIRE(w->live > 0); --w->live;
    tuple *t = &w->tuples[s->t];
    if (t->id == id) t->id = 0;
}
static void on_packet(void *ctx, const uint8_t *b, size_t n) {
    world *w = ctx;
    REQUIRE(b && n >= 20);
    int v6 = b[0] >> 4 == 6;
    REQUIRE(v6 || b[0] == 0x45);
    size_t ip = v6 ? 40 : 20;
    REQUIRE(n >= ip + 8);
    unsigned proto = v6 ? b[6] : b[9];
    const uint8_t *src = v6 ? b + 8 : b + 12, *dst = v6 ? b + 24 : b + 16;
    if (v6) REQUIRE((size_t)g16(b + 4) + 40 == n);
    else { REQUIRE(g16(b + 2) == n); REQUIRE(fold(add(0, b, 20)) == 0); }
    REQUIRE(memcmp(src, v6 ? DST6 : DST4, v6 ? 16 : 4) == 0);
    REQUIRE(memcmp(dst, v6 ? SRC6 : SRC4, v6 ? 16 : 4) == 0);
    const uint8_t *l4 = b + ip; size_t l4n = n - ip;
    REQUIRE(proto == 6 || proto == 17);
    REQUIRE(l4sum(v6, proto, src, dst, l4, l4n) == 0);
    uint16_t from = g16(l4), to = g16(l4 + 2);
    if (proto == 17) { REQUIRE(g16(l4 + 4) == l4n); REQUIRE(g16(l4 + 6) != 0); }
    else {
        REQUIRE(l4n >= 20);
        size_t hl = (size_t)(l4[12] >> 4) * 4u;
        REQUIRE(hl >= 20 && hl <= l4n);
        REQUIRE(l4n - hl <= MSS_CAP);
        REQUIRE(g16(l4 + 14) <= RX_CAP);
        unsigned flags = l4[13];
        REQUIRE(!((flags & SYN) && (flags & (FIN | RST))));
    }
    /* Learn server sequence for the matching tuple so later ACKs are plausible. */
    for (unsigned i = 0; i < TUPLES; ++i) {
        tuple *t = &w->tuples[i];
        if (t->v6 != v6 || t->udp != (proto == 17) || t->sport != to || t->dport != from) continue;
        if (proto == 6) {
            unsigned flags = l4[13];
            uint32_t seq = g32(l4 + 4);
            size_t payload = l4n - (size_t)(l4[12] >> 4) * 4u;
            uint32_t end = seq + (uint32_t)payload + !!(flags & SYN) + !!(flags & FIN);
            if (!(flags & RST) && (!t->have_server || (int32_t)(end - t->server_next) > 0)) {
                t->server_next = end; t->have_server = 1;
            }
        }
        break;
    }
}

/* ---------- packet construction ---------- */
static size_t build(world *w, source *s, unsigned ti, uint8_t *out, size_t cap) {
    tuple *t = &w->tuples[ti];
    size_t ip = t->v6 ? 40 : 20;
    uint8_t *l4 = out + ip;
    size_t l4n;
    if (t->udp) {
        size_t payload = pick(s, 8) == 0 ? pick(s, 1400) : pick(s, 64);
        l4n = 8 + payload;
        if (ip + l4n > cap) l4n = cap - ip;
        memset(l4, 0, 8);
        p16(l4, t->sport); p16(l4 + 2, t->dport); p16(l4 + 4, (uint32_t)l4n);
        for (size_t i = 8; i < l4n; ++i) l4[i] = (uint8_t)next32(s);
    } else {
        static const unsigned shapes[] = {SYN, ACK, ACK | PSH, ACK | FIN, ACK | PSH | FIN, RST, RST | ACK,
                                          SYN | ACK, FIN, 0, ACK | URG, SYN | FIN};
        unsigned flags = shapes[pick(s, sizeof(shapes) / sizeof(shapes[0]))];
        if (pick(s, 16) == 0) flags = pick(s, 256);
        uint32_t seq;
        if (flags & SYN) {
            if (t->id == 0 || pick(s, 4) == 0) { t->client_isn = next32(s); t->client_next = t->client_isn + 1; }
            seq = t->client_isn;
        } else {
            int32_t jitter;
            switch (pick(s, 8)) {
            case 0: jitter = -(int32_t)pick(s, 3000); break;
            case 1: jitter = (int32_t)pick(s, 40000); break;
            case 2: jitter = (int32_t)next32(s); break;
            default: jitter = (int32_t)pick(s, 2) * (int32_t)pick(s, 2400); break;
            }
            seq = t->client_next + (uint32_t)jitter;
        }
        uint32_t ackv = t->have_server ? t->server_next - pick(s, 4) * (uint32_t)pick(s, 1500) : next32(s);
        if (pick(s, 3) == 0) ackv = t->last_ack;               /* duplicate ACKs -> fast retransmit */
        if (pick(s, 32) == 0) ackv = next32(s);
        t->last_ack = ackv;
        size_t opts = 0;
        uint8_t optbuf[40];
        if ((flags & SYN) || pick(s, 8) == 0) {
            switch (pick(s, 5)) {
            case 0: optbuf[0] = 2; optbuf[1] = 4; p16(optbuf + 2, 64 + pick(s, 1600)); opts = 4; break;
            case 1: optbuf[0] = 1; optbuf[1] = 3; optbuf[2] = 3; optbuf[3] = 7; opts = 4; break;   /* NOP + wscale */
            case 2: optbuf[0] = 4; optbuf[1] = 2; optbuf[2] = 0; optbuf[3] = 0; opts = 4; break;   /* SACK-permitted */
            case 3: opts = 4 * (1 + pick(s, 10)); for (size_t i = 0; i < opts; ++i) optbuf[i] = (uint8_t)next32(s); break;
            default: break;
            }
        }
        size_t payload = 0;
        if (!(flags & SYN) || pick(s, 16) == 0)
            payload = pick(s, 4) == 0 ? 0 : (pick(s, 6) == 0 ? pick(s, 1460) : pick(s, 300));
        l4n = 20 + opts + payload;
        if (ip + l4n > cap) { payload = 0; l4n = 20 + opts; }
        memset(l4, 0, 20);
        p16(l4, t->sport); p16(l4 + 2, t->dport); p32(l4 + 4, seq); p32(l4 + 8, ackv);
        l4[12] = (uint8_t)((5 + opts / 4) << 4); l4[13] = (uint8_t)flags;
        p16(l4 + 14, pick(s, 6) == 0 ? 0 : (pick(s, 2) ? 65535 : pick(s, 65536)));
        memcpy(l4 + 20, optbuf, opts);
        for (size_t i = 0; i < payload; ++i) l4[20 + opts + i] = stream_byte(t, seq + (uint32_t)i);
        if ((flags & (SYN | RST)) == 0 && (int32_t)(seq + (uint32_t)payload - t->client_next) > 0 &&
            (int32_t)(seq - t->client_next) <= 0)
            t->client_next = seq + (uint32_t)payload + !!(flags & FIN);
    }
    /* Optional IPv4 options / IPv6 extension headers in front of the transport. */
    size_t extra = 0;
    uint8_t ext[64];
    unsigned first_next = t->udp ? 17 : 6;
    if (!t->v6 && pick(s, 10) == 0) {
        extra = 4 * (1 + pick(s, 4));
        for (size_t i = 0; i < extra; ++i) ext[i] = 1;                  /* NOP padding */
        switch (pick(s, 4)) {
        case 0: ext[0] = 7; ext[1] = 7; ext[2] = 4; break;               /* record route (len 7) */
        case 1: ext[0] = 0; break;                                       /* EOL */
        case 2: ext[0] = (uint8_t)next32(s); ext[1] = (uint8_t)pick(s, 12); break;
        default: break;
        }
    } else if (t->v6 && pick(s, 6) == 0) {
        static const unsigned kinds[] = {0, 60, 43};
        unsigned count = 1 + pick(s, 2);
        unsigned next = first_next;
        for (unsigned k = count; k-- > 0;) {
            unsigned kind = kinds[k == 0 ? pick(s, 3) : 1 + pick(s, 2)];  /* hop-by-hop only first */
            uint8_t *h = ext + 8 * k;
            memset(h, 0, 8);
            h[0] = (uint8_t)next; h[1] = 0;
            if (kind == 43) { h[2] = 0; h[3] = pick(s, 6) ? 0 : 1; }    /* segments left 0 (or 1: reject) */
            else { h[2] = 1; h[3] = 4; if (pick(s, 10) == 0) h[2] = 0xc2; } /* PadN, or must-discard */
            next = kind;
        }
        first_next = next; extra = 8 * count;
    }
    if (ip + extra + l4n > cap) extra = 0, first_next = t->udp ? 17 : 6;
    memmove(out + ip + extra, l4, l4n);
    l4 = out + ip + extra;
    if (t->v6) {
        memset(out, 0, 40); out[0] = 0x60; p16(out + 4, (uint32_t)(extra + l4n)); out[6] = (uint8_t)first_next; out[7] = 64;
        memcpy(out + 8, SRC6, 16); memcpy(out + 24, DST6, 16);
        memcpy(out + 40, ext, extra);
    } else {
        memset(out, 0, 20); out[0] = (uint8_t)(0x40 | (5 + extra / 4)); p16(out + 2, (uint32_t)(20 + extra + l4n));
        out[8] = 64; out[9] = t->udp ? 17 : 6;
        p16(out + 4, next32(s)); memcpy(out + 12, SRC4, 4); memcpy(out + 16, DST4, 4);
        memcpy(out + 20, ext, extra);
        p16(out + 10, fold(add(0, out, 20 + extra)));
    }
    const uint8_t *src = t->v6 ? SRC6 : SRC4, *dst = t->v6 ? DST6 : DST4;
    if (t->udp) {
        uint16_t c = l4sum(t->v6, 17, src, dst, l4, l4n);
        p16(l4 + 6, (t->v6 || pick(s, 8)) ? (c ? c : 0xffff) : 0);   /* IPv4 may omit */
    } else p16(l4 + 16, l4sum(t->v6, 6, src, dst, l4, l4n));
    ip += extra;
    return ip + l4n;
}

/* Split a datagram into (possibly shuffled / duplicated / dropped) fragments.
 * IPv4: header copied with MF/offset. IPv6: a Fragment header (44) is inserted
 * after the fixed 40-byte header. */
static void inject_fragments(wlp_engine *e, source *s, const uint8_t *pkt, size_t n) {
    int v6 = pkt[0] >> 4 == 6;
    size_t hdr = v6 ? 40 : (size_t)(pkt[0] & 15) * 4;
    if (n <= hdr + 8) { (void)wlp_input(e, pkt, n); return; }
    size_t body = n - hdr;
    size_t step = 8 * (1 + pick(s, 64));
    static uint8_t frags[24][1700]; size_t lens[24]; unsigned count = 0;
    uint32_t id = next32(s);
    for (size_t off = 0; off < body && count < 24; off += step) {
        size_t len = body - off < step ? body - off : step;
        uint8_t *f = frags[count];
        int more = off + len < body;
        if (v6) {
            memcpy(f, pkt, 40); f[6] = 44;
            uint8_t *fh = f + 40;
            fh[0] = pkt[6]; fh[1] = 0;
            p16(fh + 2, (uint32_t)((off & 0xfff8u) | (more ? 1u : 0u))); p32(fh + 4, id);
            memcpy(f + 48, pkt + 40 + off, len);
            p16(f + 4, (uint32_t)(8 + len));
            lens[count++] = 48 + len;
        } else {
            memcpy(f, pkt, hdr); memcpy(f + hdr, pkt + hdr + off, len);
            p16(f + 2, (uint32_t)(hdr + len)); p16(f + 4, id);
            p16(f + 6, (uint32_t)((more ? 0x2000 : 0) | (off / 8)));
            f[10] = f[11] = 0; p16(f + 10, fold(add(0, f, hdr)));
            lens[count++] = hdr + len;
        }
    }
    for (unsigned i = 0; i < count; ++i) {               /* light shuffle */
        unsigned j = pick(s, count);
        if (pick(s, 2)) {
            static uint8_t tmp[1700]; size_t tl = lens[i];
            memcpy(tmp, frags[i], tl); memcpy(frags[i], frags[j], lens[j]); memcpy(frags[j], tmp, tl);
            lens[i] = lens[j]; lens[j] = tl;
        }
    }
    for (unsigned i = 0; i < count; ++i) {
        if (pick(s, 20) == 0) continue;                    /* drop */
        (void)wlp_input(e, frags[i], lens[i]);
        if (pick(s, 20) == 0) (void)wlp_input(e, frags[i], lens[i]);   /* duplicate */
    }
}

static uint64_t random_live(world *w, source *s) {
    if (!w->live) return pick(s, 4) ? 0 : (uint64_t)pick(s, 1u << 20);
    unsigned start = pick(s, TUPLES);
    for (unsigned k = 0; k < TUPLES; ++k) {
        tuple *t = &w->tuples[(start + k) % TUPLES];
        if (t->id) return t->id;
    }
    return 0;
}

static void run(source *s, unsigned long steps) {
    world *w = calloc(1, sizeof(*w));
    REQUIRE(w);
    for (unsigned i = 0; i < TUPLES; ++i) {
        tuple *t = &w->tuples[i];
        t->v6 = (int)(i % 3 == 1); t->udp = (int)(i % 4 == 3);
        t->sport = (uint16_t)(40000 + i); t->dport = t->udp ? 53 : (i % 5 ? 443 : 80);
    }
    w->in_input = -1;
    wlp_callbacks cb = {on_connect, on_data, on_close, on_packet, on_eof};
    wlp_engine *e = wlp_new(cb, w);
    REQUIRE(e);
    w->now = 1000; wlp_tick(e, w->now);
    static uint8_t pkt[2048], blob[70000];
    for (unsigned long i = 0; i < steps && !exhausted(s); ++i) {
        g_step = i;
        unsigned op = pick(s, 100);
        if (op < 55) {
            unsigned ti = pick(s, 8) ? pick(s, 24) : pick(s, TUPLES);  /* hot set + long tail */
            size_t n = build(w, s, ti, pkt, sizeof(pkt));
            w->in_input = (int)ti;
            if (n > 60 && (pkt[0] == 0x45 || (pkt[0] >> 4 == 6 && (pkt[6] == 6 || pkt[6] == 17))) && pick(s, 12) == 0)
                inject_fragments(e, s, pkt, n);
            else {
                if (pick(s, 40) == 0) {                      /* truncate: must be rejected or handled */
                    size_t cut = pick(s, (uint32_t)n);
                    (void)wlp_input(e, pkt, cut);
                } else (void)wlp_input(e, pkt, n);
            }
            w->in_input = -1;
        } else if (op < 65) {
            wlp_remote_open(e, random_live(w, s));
        } else if (op < 80) {
            uint64_t id = random_live(w, s);
            size_t n = pick(s, 10) == 0 ? pick(s, sizeof(blob)) : pick(s, 2000);
            for (size_t k = 0; k < n && k < 64; ++k) blob[k] = (uint8_t)next32(s);
            (void)wlp_remote_data(e, id, n ? blob : NULL, n);
        } else if (op < 85) {
            uint64_t id = random_live(w, s);
            size_t cap = wlp_remote_capacity(e, id);
            REQUIRE(cap <= TX_CAP);
        } else if (op < 89) {
            wlp_remote_close(e, random_live(w, s));
        } else if (op < 91) {
            wlp_remote_abort(e, random_live(w, s));
        } else if (op < 94) {
            /* Duplicate-ACK burst on a live TCP tuple: pure ACKs at the previous ACK value. */
            unsigned ti = pick(s, 24);
            tuple *t = &w->tuples[ti];
            if (!t->udp && t->id && t->have_server) {
                if (pick(s, 2)) (void)wlp_remote_data(e, t->id, blob, 1 + pick(s, 6000));
                unsigned reps = 3 + pick(s, 2);
                for (unsigned r = 0; r < reps; ++r) {
                    uint8_t *l4 = pkt + (t->v6 ? 40 : 20);
                    size_t ip = t->v6 ? 40 : 20, l4n = 20;
                    memset(pkt, 0, ip + 20);
                    p16(l4, t->sport); p16(l4 + 2, t->dport); p32(l4 + 4, t->client_next); p32(l4 + 8, t->last_ack);
                    l4[12] = 0x50; l4[13] = ACK; p16(l4 + 14, 65535);
                    if (t->v6) { pkt[0] = 0x60; p16(pkt + 4, 20); pkt[6] = 6; pkt[7] = 64; memcpy(pkt + 8, SRC6, 16); memcpy(pkt + 24, DST6, 16); }
                    else { pkt[0] = 0x45; p16(pkt + 2, 40); pkt[8] = 64; pkt[9] = 6; memcpy(pkt + 12, SRC4, 4); memcpy(pkt + 16, DST4, 4); p16(pkt + 10, fold(add(0, pkt, 20))); }
                    p16(l4 + 16, l4sum(t->v6, 6, t->v6 ? SRC6 : SRC4, t->v6 ? DST6 : DST4, l4, l4n));
                    w->in_input = (int)ti;
                    (void)wlp_input(e, pkt, ip + l4n);
                    w->in_input = -1;
                }
            }
        } else {
            unsigned r = pick(s, 50);
            uint64_t dt = r == 0 ? 70000 + pick(s, 600000) : (r < 5 ? pick(s, 16000) : pick(s, 400));
            if (pick(s, 50) == 0 && w->now > 10) dt = 0;          /* repeat timestamp */
            w->now += dt; wlp_tick(e, w->now);
        }
        REQUIRE(w->live <= 128);
    }
    wlp_free(e);
    REQUIRE(w->live == 0);                                     /* free closes every flow */
    free(w->ids); free(w);
}

#ifdef MOCKMINI_LIBFUZZER
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    source s = {data, size, 0, 0};
    g_seed = 0;
    run(&s, 1u << 20);
    return 0;
}
#else
int main(void) {
    const char *steps_env = getenv("MOCKMINI_FUZZ_STEPS"), *seed_env = getenv("MOCKMINI_FUZZ_SEED");
    unsigned long steps = steps_env ? strtoul(steps_env, NULL, 10) : 200000ul;
    unsigned long first = seed_env ? strtoul(seed_env, NULL, 10) : 1ul;
    unsigned long seeds = seed_env ? 1ul : 8ul;
    for (unsigned long k = 0; k < seeds; ++k) {
        g_seed = first + k;
        source s = {NULL, 0, 0, 0x9e3779b97f4a7c15ull ^ (uint64_t)g_seed * 0x100000001b3ull};
        run(&s, steps / seeds);
    }
    printf("packet fuzz passed: %lu steps over %lu seed(s); stateful TCP/UDP/fragments + remote API invariants\n",
           steps, seeds);
    return 0;
}
#endif
