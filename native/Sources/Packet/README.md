# Packet endpoint

`wlp.c` is an original, bounded userspace IP-to-proxy endpoint. Protocol reference
material is the IETF's [TCP specification](https://www.rfc-editor.org/rfc/rfc9293),
[UDP specification](https://www.rfc-editor.org/rfc/rfc768), and
[IPv6 specification](https://www.rfc-editor.org/rfc/rfc8200). No implementation
source was incorporated.

The endpoint validates IP and transport lengths/checksums, reassembles fragmented IP,
tracks independent IPv4/IPv6 TCP/UDP flows, and synthesizes reverse packets. TCP
includes a three-way handshake, cumulative acknowledgments, receive reassembly
and duplicate suppression, peer windows, a bounded retransmission queue, a
conservative congestion window, timer/three-duplicate-ACK retransmission, zero
window probes, FIN half-closure and TIME_WAIT, and sequence-checked resets.

The callback interface is serial and non-reentrant. The optional `eof` callback
must finish the transport's write half without discarding its remaining reads.
Call `wlp_tick` before traffic and every 100 ms using monotonic milliseconds.
Callback data is borrowed and must be copied before the callback returns.

This is experimental code. A real macOS CI smoke passed with an existing VMess
node, utun TCP/UDP traffic, routed HTTPS, correlated DNS replies, and route/DNS
restoration. That is a bounded integration check; it has not passed a TCP
conformance suite, sustained throughput tests, or a security audit. Its retransmission
timer is conservative and does not estimate RTT. It does not implement ICMP, path MTU discovery, SACK, window scaling, timestamps, ECN,
urgent data, IPv6 jumbograms, or IPsec. It is a local proxy endpoint, not a
production replacement for a mature general-purpose TCP stack. UDP datagrams
are preserved. IP reassembly is bounded to sixteen partial datagrams (about
1.2 MiB) and fifteen seconds. Overlaps and inconsistent fragments reject the
entire datagram until expiry. IPv6 atomic fragments bypass the cache; IPv6
unfragmentable headers longer than 2048 bytes are rejected. An idle UDP flow expires
after one minute and a normally open idle TCP flow after ten minutes. Half-closed
TCP flows expire after two minutes; TIME_WAIT lasts one minute.

The portable tests construct and checksum packets independently, exercise loss,
reordering, overlap, windows, sequence wrap, close/reset, UDP, IPv6 extensions,
resource limits, IPv4/IPv6 fragment ordering/overlap/expiry/cache limits, maximum
legal UDP payloads, and malformed inputs. They run under address/undefined behavior
sanitizers. The utun adapter compiles to an unsupported stub outside macOS; its
native control socket, framing and interface setup are exercised by the Mac smoke.
Other protocols, networks, failures and sustained workloads still need validation.
