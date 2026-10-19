#ifndef WL_UTUN_H
#define WL_UTUN_H
#include <stddef.h>
#include <sys/types.h>
/* Native macOS utun socket, with AF framing removed/added by read/write. */
int wl_tun_open(char *ifname, size_t capacity);
ssize_t wl_tun_read(int fd, void *buffer, size_t capacity);
ssize_t wl_tun_write(int fd, const void *buffer, size_t length);
#endif
