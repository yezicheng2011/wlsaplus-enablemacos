/* Original userspace proxy endpoint. Written from protocol descriptions; no
 * third-party IP/TCP/VPN implementation is incorporated in this file. */
#include "wlp.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define FLOW_LIMIT 128u
#define RX_LIMIT 32768u
#define TX_LIMIT 262144u
#define UDP_PENDING 65536u
#define MSS_LIMIT 1200u
#define WSCALE_MAX 14u
#define MAX_PACKET 65575u
#define FRAGMENT_LIMIT 16u
#define FRAGMENT_HEADER 2048u
#define FRAGMENT_BYTES 65535u
#define FLAG_FIN 1u
#define FLAG_SYN 2u
#define FLAG_RST 4u
#define FLAG_PSH 8u
#define FLAG_ACK 16u
#define FLAG_URG 32u
#define STATE_CONNECT 0
#define STATE_SYN 1
#define STATE_OPEN 2
#define STATE_WAIT 3

typedef struct datagram {
    struct datagram *next;
    size_t length;
    uint8_t bytes[];
} datagram;

typedef struct flow {
    struct flow *next;
    uint64_t id, created, active, sent_at, probe_at, wait_at;
    uint8_t version, protocol, source[16], destination[16];
    uint16_t source_port, destination_port, mss;
    uint32_t peer_window;      /* already scaled by peer_shift */
    uint8_t peer_shift;        /* RFC 7323 shift the client announced (0..14) */
    int window_scaling;        /* client offered WS on SYN; we echo shift 0 */
    uint32_t iss, receive_next, send_una, send_next, tx_sequence;
    uint32_t window_sequence, window_ack, congestion, threshold;
    uint32_t receive_fin_sequence;
    unsigned receive_position, receive_buffered, retries, duplicate_acks;
    uint64_t retransmit_ms;
    int state, remote_ready, remote_eof, receive_fin, pending_fin;
    int sent_fin, acked_fin, close_notified;
    uint32_t fin_sequence;
    uint8_t *receive_bytes, *receive_present, *transmit_bytes;
    size_t transmit_length;
    datagram *datagrams, *datagrams_tail;
    size_t datagram_bytes, datagram_count;
} flow;

typedef struct fragment {
    struct fragment *next;
    uint64_t created;
    uint32_t id;
    uint8_t version, protocol, source[16], destination[16];
    uint8_t header[FRAGMENT_HEADER];
    size_t header_length, previous_next, received, final_length, highest;
    int first, final, rejected;
    uint8_t bytes[FRAGMENT_BYTES];
    uint8_t present[(FRAGMENT_BYTES + 7) / 8];
} fragment;

struct wlp_engine {
    wlp_callbacks callbacks;
    void *context;
    flow *flows;
    fragment *fragments;
    unsigned count, fragment_count;
    uint64_t next_id, now;
    int random_fd, time_known;
    uint16_t ip_id;
};

typedef struct {
    uint8_t version, protocol;
    const uint8_t *source, *destination, *transport;
    size_t transport_length;
} parsed;

static uint16_t get16(const uint8_t *p) { return (uint16_t)((uint16_t)p[0] << 8 | p[1]); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) << 16 | get16(p + 2); }
static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }
static int before(uint32_t a, uint32_t b) { return ((a - b) & UINT32_C(0x80000000)) != 0; }
static uint32_t minimum(uint32_t a, uint32_t b) { return a < b ? a : b; }
static uint32_t sum_bytes(uint32_t sum, const uint8_t *p, size_t length) {
    while (length >= 2) { sum += get16(p); p += 2; length -= 2; }
    if (length) sum += (uint32_t)p[0] << 8;
    return sum;
}
static uint16_t finish_sum(uint32_t sum) {
    while (sum >> 16) sum = (sum & 65535u) + (sum >> 16);
    return (uint16_t)~sum;
}
static uint16_t transport_sum(uint8_t version, uint8_t protocol,
                              const uint8_t *source, const uint8_t *destination,
                              const uint8_t *data, size_t length) {
    size_t address_length = version == 4 ? 4 : 16;
    uint32_t sum = sum_bytes(0, source, address_length);
    sum = sum_bytes(sum, destination, address_length);
    sum += protocol + (uint32_t)length;
    return finish_sum(sum_bytes(sum, data, length));
}

static int parse_ip(const uint8_t *packet, size_t length, parsed *result) {
    if (!packet || length < 20 || length > MAX_PACKET) return -1;
    memset(result, 0, sizeof(*result));
    result->version = packet[0] >> 4;
    if (result->version == 4) {
        size_t header = (packet[0] & 15u) * 4u;
        if (header < 20 || header > length || get16(packet + 2) != length ||
            finish_sum(sum_bytes(0, packet, header)) != 0 ||
            (get16(packet + 6) & 0xbfffu) != 0 || packet[8] == 0) return -1;
        /* Fragments are reassembled before this parser; source routing is rejected. */
        for (size_t i = 20; i < header;) {
            uint8_t option = packet[i];
            if (option == 0) break;
            if (option == 1) { ++i; continue; }
            if (i + 2 > header || packet[i + 1] < 2 || i + packet[i + 1] > header ||
                option == 131 || option == 137) return -1;
            i += packet[i + 1];
        }
        result->source = packet + 12;
        result->destination = packet + 16;
        result->protocol = packet[9];
        result->transport = packet + header;
        result->transport_length = length - header;
        if (packet[12] == 0 || packet[12] >= 224 || packet[16] >= 224) return -1;
    } else if (result->version == 6) {
        if (length < 40 || get16(packet + 4) == 0 || (size_t)get16(packet + 4) + 40 != length || packet[7] == 0) return -1;
        result->source = packet + 8;
        result->destination = packet + 24;
        if (packet[8] == 255 || packet[24] == 255) return -1;
        uint8_t next = packet[6];
        size_t offset = 40;
        unsigned headers = 0;
        while (next == 0 || next == 60 || next == 43) {
            if (++headers > 8 || offset + 8 > length) return -1;
            size_t extension = ((size_t)packet[offset + 1] + 1) * 8;
            if (extension > length - offset || (next == 43 && packet[offset + 3] != 0)) return -1;
            /* Unknown options with mandatory discard semantics are rejected. */
            if (next == 0 || next == 60) {
                for (size_t i = offset + 2; i < offset + extension;) {
                    uint8_t option = packet[i];
                    if (option == 0) { ++i; continue; }
                    if (i + 2 > offset + extension || (option & 0xc0u) ||
                        packet[i + 1] > offset + extension - i - 2) return -1;
                    i += (size_t)packet[i + 1] + 2;
                }
            }
            next = packet[offset];
            offset += extension;
        }
        result->protocol = next;
        result->transport = packet + offset;
        result->transport_length = length - offset;
    } else return -1;
    return result->protocol == 6 || result->protocol == 17 ? 0 : -1;
}

static void remove_fragment(wlp_engine *engine, fragment *entry) {
    fragment **link = &engine->fragments;
    while (*link && *link != entry) link = &(*link)->next;
    if (!*link) return;
    *link = entry->next;
    --engine->fragment_count;
    free(entry);
}
/* 0: not fragmented; 1: incomplete; 2: owned assembled packet; -1: reject.
 * Fragment overlap is rejected, including an exact duplicate. IPv6 atomic
 * fragments bypass the reassembly cache, so they cannot disturb partial data. */
static int reassemble(wlp_engine *engine, const uint8_t *packet, size_t length,
                      uint8_t **assembled, size_t *assembled_length) {
    if (!packet || length < 20 || length > MAX_PACKET) return -1;
    uint8_t version = packet[0] >> 4, protocol;
    const uint8_t *source, *destination;
    size_t header, offset, payload_length, previous_next = 0;
    uint32_t id;
    int more;
    if (version == 4) {
        uint16_t field = get16(packet + 6);
        if (!(field & 0x3fffu)) return 0;
        header = (packet[0] & 15u) * 4u;
        if (header < 20 || header > length || get16(packet + 2) != length ||
            finish_sum(sum_bytes(0, packet, header)) != 0 ||
            (field & 0xc000u) || packet[8] == 0 || packet[12] == 0 || packet[12] >= 224 || packet[16] >= 224) return -1;
        protocol = packet[9];
        source = packet + 12; destination = packet + 16;
        id = get16(packet + 4);
        offset = (size_t)(field & 0x1fffu) * 8;
        more = !!(field & 0x2000u);
        payload_length = length - header;
    } else if (version == 6) {
        if (length < 40 || get16(packet + 4) == 0 || (size_t)get16(packet + 4) + 40 != length ||
            packet[7] == 0 || packet[8] == 255 || packet[24] == 255) return -1;
        source = packet + 8; destination = packet + 24;
        uint8_t next = packet[6];
        header = 40;
        previous_next = 6;
        unsigned headers = 0;
        while (next == 0 || next == 43 || next == 60) {
            if (++headers > 8 || header + 8 > length) return -1;
            size_t count = ((size_t)packet[header + 1] + 1) * 8;
            if (count > length - header || (next == 43 && packet[header + 3] != 0)) return -1;
            previous_next = header;
            next = packet[header];
            header += count;
        }
        if (next != 44) return 0;
        if (header + 8 > length || header > FRAGMENT_HEADER || packet[header + 1] || (get16(packet + header + 2) & 6u)) return -1;
        protocol = packet[header];
        if (protocol == 44) return -1;
        uint16_t field = get16(packet + header + 2);
        offset = field & 0xfff8u;
        more = field & 1u;
        id = get32(packet + header + 4);
        payload_length = length - header - 8;
        if (offset == 0 && !more) {
            uint8_t *output = malloc(length - 8);
            if (!output) return -1;
            memcpy(output, packet, header);
            memcpy(output + header, packet + header + 8, payload_length);
            output[previous_next] = protocol;
            put16(output + 4, (uint16_t)(length - 48));
            *assembled = output; *assembled_length = length - 8;
            return 2;
        }
    } else return -1;
    if (!payload_length || (more && payload_length % 8) ||
        offset > FRAGMENT_BYTES || payload_length > FRAGMENT_BYTES - offset ||
        (version == 4 && offset + payload_length > 65515)) return -1;
    fragment *entry = NULL;
    size_t addresses = version == 4 ? 4 : 16;
    for (fragment *candidate = engine->fragments; candidate; candidate = candidate->next) {
        if (candidate->version == version && candidate->id == id &&
            memcmp(candidate->source, source, addresses) == 0 && memcmp(candidate->destination, destination, addresses) == 0 &&
            (version == 6 || candidate->protocol == protocol)) { entry = candidate; break; }
    }
    if (!entry) {
        if (engine->fragment_count >= FRAGMENT_LIMIT) return -1;
        entry = calloc(1, sizeof(*entry));
        if (!entry) return -1;
        entry->version = version; entry->protocol = protocol; entry->id = id;
        memcpy(entry->source, source, addresses); memcpy(entry->destination, destination, addresses);
        entry->created = engine->now;
        if (version == 6) {
            memcpy(entry->header, packet, header);
            entry->header_length = header; entry->previous_next = previous_next;
        }
        entry->next = engine->fragments; engine->fragments = entry; ++engine->fragment_count;
    }
    if (entry->rejected) return -1;
    if (entry->protocol != protocol || (version == 6 && (entry->header_length != header || entry->previous_next != previous_next))) {
        entry->rejected = 1; return -1;
    }
    if (version == 6) {
        for (size_t i = 0; i < header; ++i) {
            if (i != 4 && i != 5 && i != 7 && entry->header[i] != packet[i]) { entry->rejected = 1; return -1; }
        }
    }
    size_t end = offset + payload_length;
    if ((entry->final && end > entry->final_length) ||
        (!more && ((entry->final && entry->final_length != end) || entry->highest > end))) {
        entry->rejected = 1; return -1;
    }
    for (size_t i = offset; i < end; ++i) {
        if (entry->present[i / 8] & (1u << (i % 8))) { entry->rejected = 1; return -1; }
    }
    const uint8_t *payload = packet + header + (version == 6 ? 8 : 0);
    memcpy(entry->bytes + offset, payload, payload_length);
    for (size_t i = offset; i < end; ++i) entry->present[i / 8] |= (uint8_t)(1u << (i % 8));
    entry->received += payload_length;
    if (end > entry->highest) entry->highest = end;
    if (!offset) {
        entry->first = 1;
        memcpy(entry->header, packet, header);
        entry->header_length = header;
    }
    if (!more) { entry->final = 1; entry->final_length = end; }
    if (!entry->first || !entry->final || entry->received != entry->final_length) return 1;
    size_t total = entry->header_length + entry->final_length;
    if (total > (version == 4 ? 65535u : MAX_PACKET)) { entry->rejected = 1; return -1; }
    uint8_t *output = malloc(total);
    if (!output) { remove_fragment(engine, entry); return -1; }
    memcpy(output, entry->header, entry->header_length);
    memcpy(output + entry->header_length, entry->bytes, entry->final_length);
    if (version == 4) {
        put16(output + 2, (uint16_t)total); put16(output + 6, 0); put16(output + 10, 0);
        put16(output + 10, finish_sum(sum_bytes(0, output, entry->header_length)));
    } else {
        output[entry->previous_next] = entry->protocol;
        put16(output + 4, (uint16_t)(total - 40));
    }
    remove_fragment(engine, entry);
    *assembled = output; *assembled_length = total;
    return 2;
}

static flow *find_id(wlp_engine *engine, uint64_t id) {
    for (flow *f = engine->flows; f; f = f->next) if (f->id == id) return f;
    return NULL;
}
static flow *find_tuple(wlp_engine *engine, const parsed *p) {
    size_t n = p->version == 4 ? 4 : 16;
    uint16_t source = get16(p->transport), destination = get16(p->transport + 2);
    for (flow *f = engine->flows; f; f = f->next)
        if (f->version == p->version && f->protocol == p->protocol &&
            f->source_port == source && f->destination_port == destination &&
            memcmp(f->source, p->source, n) == 0 && memcmp(f->destination, p->destination, n) == 0) return f;
    return NULL;
}
static void initialize_tuple(flow *f, const parsed *p) {
    size_t n = p->version == 4 ? 4 : 16;
    f->version = p->version;
    f->protocol = p->protocol;
    memcpy(f->source, p->source, n);
    memcpy(f->destination, p->destination, n);
    f->source_port = get16(p->transport);
    f->destination_port = get16(p->transport + 2);
}
static void notify_close(wlp_engine *engine, flow *f) {
    if (!f->close_notified) {
        f->close_notified = 1;
        engine->callbacks.close(engine->context, f->id);
    }
}
static void remove_flow(wlp_engine *engine, flow *f) {
    flow **link = &engine->flows;
    while (*link && *link != f) link = &(*link)->next;
    if (!*link) return;
    *link = f->next;
    --engine->count;
    notify_close(engine, f);
    free(f->receive_bytes);
    free(f->receive_present);
    free(f->transmit_bytes);
    while (f->datagrams) { datagram *d = f->datagrams; f->datagrams = d->next; free(d); }
    free(f);
}
static flow *make_flow(wlp_engine *engine, const parsed *p) {
    if (engine->count >= FLOW_LIMIT) return NULL;
    flow *f = calloc(1, sizeof(*f));
    if (!f) return NULL;
    initialize_tuple(f, p);
    f->id = ++engine->next_id;
    f->created = f->active = engine->now;
    f->mss = MSS_LIMIT;
    f->retransmit_ms = 1000;
    f->congestion = 2 * MSS_LIMIT;
    f->threshold = 65535;
    if (p->protocol == 6) {
        f->receive_bytes = malloc(RX_LIMIT);
        f->receive_present = calloc(RX_LIMIT, 1);
        if (!f->receive_bytes || !f->receive_present) {
            free(f->receive_bytes); free(f->receive_present); free(f); return NULL;
        }
        uint8_t entropy[4];
        size_t got = 0;
        while (got < sizeof(entropy)) {
            ssize_t n = read(engine->random_fd, entropy + got, sizeof(entropy) - got);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) { free(f->receive_bytes); free(f->receive_present); free(f); return NULL; }
            got += (size_t)n;
        }
        f->iss = get32(entropy);
        f->send_una = f->send_next = f->iss;
        f->tx_sequence = f->iss + 1;
    }
    f->next = engine->flows;
    engine->flows = f;
    ++engine->count;
    return f;
}

static size_t write_ip(wlp_engine *engine, const flow *f, uint8_t *packet, size_t transport_length) {
    size_t header = f->version == 4 ? 20 : 40;
    memset(packet, 0, header);
    if (f->version == 4) {
        packet[0] = 0x45;
        put16(packet + 2, (uint16_t)(header + transport_length));
        put16(packet + 4, ++engine->ip_id);
        put16(packet + 6, 0x4000);
        packet[8] = 64;
        packet[9] = f->protocol;
        memcpy(packet + 12, f->destination, 4);
        memcpy(packet + 16, f->source, 4);
        put16(packet + 10, finish_sum(sum_bytes(0, packet, header)));
    } else {
        packet[0] = 0x60;
        put16(packet + 4, (uint16_t)transport_length);
        packet[6] = f->protocol;
        packet[7] = 64;
        memcpy(packet + 8, f->destination, 16);
        memcpy(packet + 24, f->source, 16);
    }
    return header;
}
static void emit_tcp(wlp_engine *engine, flow *f, uint32_t sequence, uint32_t ack,
                     uint8_t flags, const uint8_t *bytes, size_t length) {
    uint8_t packet[40 + 28 + MSS_LIMIT];
    size_t header = flags & FLAG_SYN ? (f->window_scaling ? 28 : 24) : 20;
    size_t ip = write_ip(engine, f, packet, header + length);
    uint8_t *tcp = packet + ip;
    memset(tcp, 0, header);
    put16(tcp, f->destination_port);
    put16(tcp + 2, f->source_port);
    put32(tcp + 4, sequence);
    put32(tcp + 8, ack);
    tcp[12] = (uint8_t)(header / 4 << 4);
    tcp[13] = flags;
    put16(tcp + 14, (uint16_t)(RX_LIMIT - f->receive_buffered));
    if (header >= 24) { tcp[20] = 2; tcp[21] = 4; put16(tcp + 22, MSS_LIMIT); }
    /* Our receive buffer fits in 16 bits, so we announce shift 0: the client may
     * scale its own window while ours stays unscaled. */
    if (header == 28) { tcp[24] = 1; tcp[25] = 3; tcp[26] = 3; tcp[27] = 0; }
    if (length) memcpy(tcp + header, bytes, length);
    put16(tcp + 16, transport_sum(f->version, 6, f->destination, f->source, tcp, header + length));
    engine->callbacks.packet(engine->context, packet, ip + header + length);
}
static void emit_ack(wlp_engine *engine, flow *f) {
    emit_tcp(engine, f, f->send_next, f->receive_next, FLAG_ACK, NULL, 0);
}
static void reset_flow(wlp_engine *engine, flow *f) {
    if (f->protocol == 6) emit_tcp(engine, f, f->send_next, f->receive_next, FLAG_RST | FLAG_ACK, NULL, 0);
    remove_flow(engine, f);
}
static void send_syn(wlp_engine *engine, flow *f) {
    emit_tcp(engine, f, f->iss, f->receive_next, FLAG_SYN | FLAG_ACK, NULL, 0);
    f->send_next = f->iss + 1;
    f->sent_at = engine->now;
}
static void enter_wait(wlp_engine *engine, flow *f) {
    if (f->receive_fin && f->acked_fin && f->state != STATE_WAIT) {
        f->state = STATE_WAIT;
        f->wait_at = engine->now;
        notify_close(engine, f);
    }
}
static void send_available(wlp_engine *engine, flow *f) {
    if (f->state != STATE_OPEN) return;
    uint32_t end = f->tx_sequence + (uint32_t)f->transmit_length;
    uint32_t limit = minimum(f->peer_window, f->congestion);
    while (before(f->send_next, end)) {
        uint32_t outstanding = f->send_next - f->send_una;
        if (outstanding >= limit) break;
        uint32_t count = minimum(end - f->send_next, minimum(f->mss, limit - outstanding));
        size_t offset = (size_t)(f->send_next - f->tx_sequence);
        int was_empty = f->send_next == f->send_una;
        emit_tcp(engine, f, f->send_next, f->receive_next, FLAG_ACK | FLAG_PSH, f->transmit_bytes + offset, count);
        f->send_next += count;
        if (was_empty) { f->sent_at = engine->now; f->retries = 0; f->retransmit_ms = 1000; }
    }
    if (f->remote_eof && !f->sent_fin && f->send_next == end && f->send_next - f->send_una < limit) {
        int was_empty = f->send_next == f->send_una;
        f->fin_sequence = f->send_next;
        f->sent_fin = 1;
        emit_tcp(engine, f, f->send_next, f->receive_next, FLAG_FIN | FLAG_ACK, NULL, 0);
        ++f->send_next;
        if (was_empty) { f->sent_at = engine->now; f->retries = 0; f->retransmit_ms = 1000; }
    }
}
static void retransmit(wlp_engine *engine, flow *f) {
    if (f->state == STATE_SYN) { send_syn(engine, f); return; }
    if (before(f->send_una, f->tx_sequence + (uint32_t)f->transmit_length)) {
        size_t offset = (size_t)(f->send_una - f->tx_sequence);
        uint32_t count = minimum(f->mss, minimum((uint32_t)(f->transmit_length - offset), f->send_next - f->send_una));
        if (count) emit_tcp(engine, f, f->send_una, f->receive_next, FLAG_ACK | FLAG_PSH, f->transmit_bytes + offset, count);
    } else if (f->sent_fin && !f->acked_fin) {
        emit_tcp(engine, f, f->fin_sequence, f->receive_next, FLAG_FIN | FLAG_ACK, NULL, 0);
    }
    f->sent_at = engine->now;
}
static void connect_callback(wlp_engine *engine, flow *f) {
    char host[INET6_ADDRSTRLEN];
    if (inet_ntop(f->version == 4 ? AF_INET : AF_INET6, f->destination, host, sizeof(host)))
        engine->callbacks.connect(engine->context, f->id, host, f->destination_port, f->protocol == 17);
}
static int queue_datagram(flow *f, const uint8_t *bytes, size_t length) {
    if (f->datagram_count >= 32 || length > UDP_PENDING - f->datagram_bytes) return -1;
    datagram *d = malloc(sizeof(*d) + length);
    if (!d) return -1;
    d->next = NULL;
    d->length = length;
    if (length) memcpy(d->bytes, bytes, length);
    if (f->datagrams_tail) f->datagrams_tail->next = d;
    else f->datagrams = d;
    f->datagrams_tail = d;
    f->datagram_bytes += length;
    ++f->datagram_count;
    return 0;
}
static int input_udp(wlp_engine *engine, const parsed *p) {
    const uint8_t *udp = p->transport;
    size_t length = p->transport_length;
    if (length < 8 || get16(udp + 4) != length || get16(udp + 2) == 0 ||
        (get16(udp + 6) == 0 && p->version == 6) ||
        (get16(udp + 6) != 0 && transport_sum(p->version, 17, p->source, p->destination, udp, length) != 0)) return -1;
    flow *f = find_tuple(engine, p);
    if (!f) {
        f = make_flow(engine, p);
        if (!f) return -1;
        if (queue_datagram(f, udp + 8, length - 8) < 0) { remove_flow(engine, f); return -1; }
        connect_callback(engine, f);
    } else if (!f->remote_ready) {
        if (queue_datagram(f, udp + 8, length - 8) < 0) return -1;
    } else engine->callbacks.data(engine->context, f->id, udp + 8, length - 8);
    f->active = engine->now;
    return 0;
}
static int tcp_options(const uint8_t *tcp, size_t header, uint16_t *mss, int *wscale) {
    for (size_t i = 20; i < header;) {
        uint8_t option = tcp[i];
        if (option == 0) break;
        if (option == 1) { ++i; continue; }
        if (i + 2 > header || tcp[i + 1] < 2 || tcp[i + 1] > header - i) return -1;
        if (option == 2) {
            if (tcp[i + 1] != 4 || !(tcp[13] & FLAG_SYN) || get16(tcp + i + 2) < 64) return -1;
            *mss = (uint16_t)minimum(*mss, get16(tcp + i + 2));
        } else if (option == 3) {
            /* Window scale: only meaningful on SYN, ignored elsewhere (RFC 7323 2.2). */
            if (tcp[i + 1] != 3) return -1;
            if (tcp[13] & FLAG_SYN) *wscale = (int)minimum(tcp[i + 2], WSCALE_MAX);
        }
        i += tcp[i + 1];
    }
    return 0;
}
static void receive_payload(wlp_engine *engine, flow *f, uint32_t sequence,
                            const uint8_t *bytes, size_t length, int fin) {
    uint32_t fin_sequence = sequence + (uint32_t)length;
    if (fin && !f->receive_fin && !before(fin_sequence, f->receive_next) &&
        fin_sequence - f->receive_next < RX_LIMIT - f->receive_buffered) {
        if (!f->pending_fin || f->receive_fin_sequence == fin_sequence) {
            f->pending_fin = 1;
            f->receive_fin_sequence = fin_sequence;
        }
    }
    if (!f->receive_fin) {
        for (size_t i = 0; i < length; ++i) {
            uint32_t at = sequence + (uint32_t)i;
            if (before(at, f->receive_next)) continue;
            uint32_t distance = at - f->receive_next;
            if (distance >= RX_LIMIT || (f->pending_fin && !before(at, f->receive_fin_sequence))) break;
            unsigned index = (f->receive_position + distance) % RX_LIMIT;
            if (!f->receive_present[index]) {
                f->receive_bytes[index] = bytes[i];
                f->receive_present[index] = 1;
                ++f->receive_buffered;
            }
        }
        while (f->receive_present[f->receive_position] &&
               (!f->pending_fin || f->receive_next != f->receive_fin_sequence)) {
            unsigned count = 0;
            unsigned room = RX_LIMIT - f->receive_position;
            while (count < room && f->receive_present[f->receive_position + count] &&
                   (!f->pending_fin || f->receive_next + count != f->receive_fin_sequence)) {
                f->receive_present[f->receive_position + count] = 0;
                ++count;
            }
            unsigned start = f->receive_position;
            f->receive_position = (f->receive_position + count) % RX_LIMIT;
            f->receive_next += count;
            f->receive_buffered -= count;
            engine->callbacks.data(engine->context, f->id, f->receive_bytes + start, count);
        }
        if (f->pending_fin && f->receive_next == f->receive_fin_sequence) {
            ++f->receive_next;
            f->receive_fin = 1;
            f->pending_fin = 0;
            memset(f->receive_present, 0, RX_LIMIT);
            f->receive_buffered = 0;
            if (engine->callbacks.eof) engine->callbacks.eof(engine->context, f->id);
        }
    }
    emit_ack(engine, f);
    enter_wait(engine, f);
}
static int input_tcp(wlp_engine *engine, const parsed *p) {
    const uint8_t *tcp = p->transport;
    size_t length = p->transport_length;
    if (length < 20) return -1;
    size_t header = (tcp[12] >> 4) * 4u;
    uint8_t flags = tcp[13];
    if (header < 20 || header > length || (tcp[12] & 14u) || (flags & FLAG_URG) ||
        ((flags & FLAG_SYN) && (flags & (FLAG_FIN | FLAG_RST))) || get16(tcp + 2) == 0 ||
        transport_sum(p->version, 6, p->source, p->destination, tcp, length) != 0) return -1;
    uint16_t mss = MSS_LIMIT;
    int wscale = -1;
    if (tcp_options(tcp, header, &mss, &wscale) < 0) return -1;
    uint32_t sequence = get32(tcp + 4), ack = get32(tcp + 8);
    size_t payload_length = length - header;
    flow *f = find_tuple(engine, p);
    if (!f) {
        if ((flags & (FLAG_SYN | FLAG_ACK | FLAG_RST)) != FLAG_SYN || payload_length) {
            if (!(flags & FLAG_RST)) {
                flow temporary;
                memset(&temporary, 0, sizeof(temporary));
                initialize_tuple(&temporary, p);
                if (flags & FLAG_ACK) emit_tcp(engine, &temporary, ack, 0, FLAG_RST, NULL, 0);
                else emit_tcp(engine, &temporary, 0, sequence + (uint32_t)payload_length + !!(flags & FLAG_SYN) + !!(flags & FLAG_FIN), FLAG_RST | FLAG_ACK, NULL, 0);
            }
            return 0;
        }
        f = make_flow(engine, p);
        if (!f) return -1;
        f->receive_next = sequence + 1;
        f->mss = mss;
        f->peer_window = get16(tcp + 14);   /* the SYN's own window is never scaled */
        if (wscale >= 0) { f->window_scaling = 1; f->peer_shift = (uint8_t)wscale; f->threshold = TX_LIMIT; }
        f->window_sequence = sequence;
        f->window_ack = 0;
        connect_callback(engine, f);
        return 0;
    }
    if (flags & FLAG_RST) {
        if (sequence == f->receive_next) remove_flow(engine, f);
        else if (!before(sequence, f->receive_next) && sequence - f->receive_next < RX_LIMIT) emit_ack(engine, f);
        return 0;
    }
    if (flags & FLAG_SYN) {
        if (sequence + 1 == f->receive_next && !payload_length && !(flags & FLAG_ACK)) {
            if (f->state == STATE_SYN) send_syn(engine, f);
        } else emit_ack(engine, f);
        return 0;
    }
    if (f->state == STATE_CONNECT) return 0;
    if (!(flags & FLAG_ACK)) return 0;
    if (f->state == STATE_SYN) {
        if (ack != f->iss + 1 || sequence != f->receive_next) return 0;
        f->state = STATE_OPEN;
        f->send_una = ack;
        f->retries = 0;
    }
    /* Reject out-of-window traffic before it can update acknowledgments. */
    if (before(sequence, f->receive_next)) {
        if (f->receive_next - sequence > payload_length + !!(flags & FLAG_FIN)) { emit_ack(engine, f); return 0; }
    } else if (sequence - f->receive_next >= RX_LIMIT && sequence != f->receive_next) {
        emit_ack(engine, f); return 0;
    }
    f->active = engine->now;
    if (before(f->send_next, ack)) { emit_ack(engine, f); return 0; }
    if (!before(ack, f->send_una)) {
        if (before(f->window_sequence, sequence) ||
            (sequence == f->window_sequence && !before(ack, f->window_ack))) {
            f->peer_window = (uint32_t)get16(tcp + 14) << f->peer_shift;
            f->window_sequence = sequence;
            f->window_ack = ack;
        }
        if (before(f->send_una, ack)) {
            uint32_t advanced = ack - f->send_una;
            f->send_una = ack;
            f->duplicate_acks = f->retries = 0;
            f->retransmit_ms = 1000;
            f->sent_at = engine->now;
            if (before(f->tx_sequence, ack)) {
                uint32_t trim = minimum(ack - f->tx_sequence, (uint32_t)f->transmit_length);
                f->transmit_length -= trim;
                if (f->transmit_length) memmove(f->transmit_bytes, f->transmit_bytes + trim, f->transmit_length);
                f->tx_sequence += trim;
            }
            if (f->sent_fin && before(f->fin_sequence, ack)) f->acked_fin = 1;
            uint32_t growth = f->congestion < f->threshold ? minimum(advanced, f->mss) : minimum(f->mss, (uint32_t)((uint64_t)f->mss * advanced / f->congestion) + 1);
            f->congestion = minimum(f->window_scaling ? TX_LIMIT : 65535u, f->congestion + growth);
        } else if (!payload_length && !(flags & FLAG_FIN) && f->send_una != f->send_next) {
            if (++f->duplicate_acks == 3) {
                f->threshold = minimum(f->congestion, f->send_next - f->send_una) / 2;
                if (f->threshold < 2u * f->mss) f->threshold = 2u * f->mss;
                f->congestion = f->mss;
                retransmit(engine, f);
            }
        }
    }
    if (f->state == STATE_WAIT) {
        if (payload_length || (flags & FLAG_FIN)) emit_ack(engine, f);
        if (flags & FLAG_FIN) f->wait_at = engine->now;
        return 0;
    }
    if (payload_length || (flags & FLAG_FIN)) receive_payload(engine, f, sequence, tcp + header, payload_length, !!(flags & FLAG_FIN));
    send_available(engine, f);
    enter_wait(engine, f);
    return 0;
}

wlp_engine *wlp_new(wlp_callbacks callbacks, void *context) {
    if (!callbacks.connect || !callbacks.data || !callbacks.close || !callbacks.packet) return NULL;
    wlp_engine *engine = calloc(1, sizeof(*engine));
    if (!engine) return NULL;
    engine->random_fd = open("/dev/urandom", O_RDONLY);
    if (engine->random_fd < 0) { free(engine); return NULL; }
    if (fcntl(engine->random_fd, F_SETFD, FD_CLOEXEC) < 0) { close(engine->random_fd); free(engine); return NULL; }
    engine->callbacks = callbacks;
    engine->context = context;
    return engine;
}
int wlp_input(wlp_engine *engine, const uint8_t *packet, size_t length) {
    if (!engine) return -1;
    uint8_t *assembled = NULL;
    size_t assembled_length = 0;
    int status = reassemble(engine, packet, length, &assembled, &assembled_length);
    if (status < 0) return -1;
    if (status == 1) return 0;
    if (status == 2) { packet = assembled; length = assembled_length; }
    parsed p;
    int result = parse_ip(packet, length, &p) < 0 ? -1 :
                 (p.protocol == 6 ? input_tcp(engine, &p) : input_udp(engine, &p));
    free(assembled);
    return result;
}
void wlp_remote_open(wlp_engine *engine, uint64_t id) {
    if (!engine) return;
    flow *f = find_id(engine, id);
    if (!f || f->remote_ready) return;
    f->remote_ready = 1;
    f->active = engine->now;
    if (f->protocol == 6) {
        f->state = STATE_SYN;
        send_syn(engine, f);
    } else {
        f->state = STATE_OPEN;
        while (f->datagrams) {
            datagram *d = f->datagrams;
            f->datagrams = d->next;
            engine->callbacks.data(engine->context, f->id, d->bytes, d->length);
            free(d);
        }
        f->datagrams_tail = NULL;
        f->datagram_bytes = f->datagram_count = 0;
    }
}
int wlp_remote_data(wlp_engine *engine, uint64_t id, const uint8_t *bytes, size_t length) {
    if (!engine || (!bytes && length)) return -1;
    flow *f = find_id(engine, id);
    if (!f || !f->remote_ready || f->remote_eof || f->state == STATE_WAIT) return -1;
    f->active = engine->now;
    if (f->protocol == 17) {
        size_t limit = f->version == 4 ? 65507 : 65527;
        if (length > limit) return -1;
        uint8_t *packet = malloc(length + 48);
        if (!packet) return -1;
        size_t ip = write_ip(engine, f, packet, length + 8);
        uint8_t *udp = packet + ip;
        memset(udp, 0, 8);
        put16(udp, f->destination_port);
        put16(udp + 2, f->source_port);
        put16(udp + 4, (uint16_t)(length + 8));
        if (length) memcpy(udp + 8, bytes, length);
        uint16_t checksum = transport_sum(f->version, 17, f->destination, f->source, udp, length + 8);
        put16(udp + 6, checksum ? checksum : 65535);
        engine->callbacks.packet(engine->context, packet, ip + length + 8);
        free(packet);
        return 0;
    }
    if (length > TX_LIMIT - f->transmit_length) { reset_flow(engine, f); return -1; }
    if (length && !f->transmit_bytes) {
        f->transmit_bytes = malloc(TX_LIMIT);
        if (!f->transmit_bytes) { reset_flow(engine, f); return -1; }
    }
    if (length) memcpy(f->transmit_bytes + f->transmit_length, bytes, length);
    f->transmit_length += length;
    send_available(engine, f);
    return 0;
}
size_t wlp_remote_capacity(wlp_engine *engine, uint64_t id) {
    if (!engine) return 0;
    flow *f = find_id(engine, id);
    if (!f || !f->remote_ready || f->remote_eof || f->state == STATE_WAIT) return 0;
    if (f->protocol == 17) return f->version == 4 ? 65507 : 65527;
    return TX_LIMIT - f->transmit_length;
}
void wlp_remote_abort(wlp_engine *engine, uint64_t id) {
    if (!engine) return;
    flow *f = find_id(engine, id);
    if (f) reset_flow(engine, f);
}
void wlp_remote_close(wlp_engine *engine, uint64_t id) {
    if (!engine) return;
    flow *f = find_id(engine, id);
    if (!f) return;
    if (f->protocol == 17) { remove_flow(engine, f); return; }
    if (!f->remote_ready) { reset_flow(engine, f); return; }
    f->remote_eof = 1;
    f->active = engine->now;
    send_available(engine, f);
}
void wlp_tick(wlp_engine *engine, uint64_t now_ms) {
    if (!engine) return;
    if (!engine->time_known) {
        engine->now = now_ms;
        engine->time_known = 1;
        for (flow *f = engine->flows; f; f = f->next)
            f->created = f->active = f->sent_at = f->probe_at = f->wait_at = now_ms;
        for (fragment *entry = engine->fragments; entry; entry = entry->next) entry->created = now_ms;
        return;
    }
    if (now_ms < engine->now) return;
    engine->now = now_ms;
    for (fragment *entry = engine->fragments, *next; entry; entry = next) {
        next = entry->next;
        if (now_ms - entry->created >= 15000) remove_fragment(engine, entry);
    }
    for (flow *f = engine->flows, *next; f; f = next) {
        next = f->next;
        uint64_t idle_limit = f->protocol == 17 ? 60000 : (f->receive_fin || f->remote_eof ? 120000 : 600000);
        if (f->state == STATE_WAIT) {
            if (now_ms - f->wait_at >= 60000) remove_flow(engine, f);
        } else if ((f->state == STATE_CONNECT && now_ms - f->created >= 15000) || now_ms - f->active >= idle_limit) {
            reset_flow(engine, f);
        } else if (f->protocol == 6 && f->send_una != f->send_next && now_ms - f->sent_at >= f->retransmit_ms) {
            if (f->retries >= 8) { reset_flow(engine, f); continue; }
            ++f->retries;
            f->threshold = f->congestion / 2;
            if (f->threshold < 2u * f->mss) f->threshold = 2u * f->mss;
            f->congestion = f->mss;
            retransmit(engine, f);
            f->retransmit_ms = f->retransmit_ms >= 30000 ? 60000 : f->retransmit_ms * 2;
        } else if (f->protocol == 6 && f->state == STATE_OPEN && f->peer_window == 0 &&
                   (f->transmit_length || (f->remote_eof && !f->sent_fin)) && now_ms - f->probe_at >= 1000) {
            /* An ACK at SND.UNA-1 elicits the peer's current window. */
            emit_tcp(engine, f, f->send_una - 1, f->receive_next, FLAG_ACK, NULL, 0);
            f->probe_at = now_ms;
        }
    }
}
void wlp_free(wlp_engine *engine) {
    if (!engine) return;
    while (engine->flows) remove_flow(engine, engine->flows);
    while (engine->fragments) remove_fragment(engine, engine->fragments);
    close(engine->random_fd);
    free(engine);
}
