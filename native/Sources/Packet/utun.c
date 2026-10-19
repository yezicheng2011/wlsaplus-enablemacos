#include "utun.h"
#include <errno.h>
#include <stdint.h>
#include <string.h>
#ifdef __APPLE__
#include <arpa/inet.h>
#include <fcntl.h>
#include <net/if.h>
#include <net/if_utun.h>
#include <sys/ioctl.h>
#include <sys/kern_control.h>
#include <sys/socket.h>
#include <sys/sys_domain.h>
#include <sys/uio.h>
#include <unistd.h>

int wl_tun_open(char *ifname, size_t capacity) {
    if (!ifname || capacity < IFNAMSIZ) { errno = EINVAL; return -1; }
    int fd = socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL);
    if (fd < 0) return -1;
    struct ctl_info control;
    memset(&control, 0, sizeof(control));
    strncpy(control.ctl_name, UTUN_CONTROL_NAME, sizeof(control.ctl_name) - 1);
    struct sockaddr_ctl address;
    memset(&address, 0, sizeof(address));
    address.sc_len = sizeof(address);
    address.sc_family = AF_SYSTEM;
    address.ss_sysaddr = AF_SYS_CONTROL;
    if (ioctl(fd, CTLIOCGINFO, &control) < 0) goto fail;
    address.sc_id = control.ctl_id;
    address.sc_unit = 0;
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) goto fail;
    socklen_t size = (socklen_t)capacity;
    if (getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, ifname, &size) < 0) goto fail;
    ifname[capacity - 1] = '\0';
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) goto fail;
    return fd;
fail: {
    int error = errno;
    close(fd);
    errno = error;
    return -1;
}
}
ssize_t wl_tun_read(int fd, void *buffer, size_t capacity) {
    if (!buffer || capacity < 40) { errno = EINVAL; return -1; }
    uint32_t family = 0;
    struct iovec vectors[2] = {{&family, sizeof(family)}, {buffer, capacity}};
    struct msghdr message;
    memset(&message, 0, sizeof(message));
    message.msg_iov = vectors;
    message.msg_iovlen = 2;
    ssize_t count = recvmsg(fd, &message, 0);
    if (count < 0) return count;
    if (count <= 4 || (message.msg_flags & MSG_TRUNC)) { errno = EMSGSIZE; return -1; }
    family = ntohl(family);
    unsigned version = ((const uint8_t *)buffer)[0] >> 4;
    if (!((family == AF_INET && version == 4) || (family == AF_INET6 && version == 6))) {
        errno = EPROTO; return -1;
    }
    return count - 4;
}
ssize_t wl_tun_write(int fd, const void *buffer, size_t length) {
    if (!buffer || length < 1 || length > 65575) { errno = EINVAL; return -1; }
    unsigned version = ((const uint8_t *)buffer)[0] >> 4;
    if (version != 4 && version != 6) { errno = EAFNOSUPPORT; return -1; }
    uint32_t family = htonl(version == 4 ? AF_INET : AF_INET6);
    struct iovec vectors[2] = {{&family, sizeof(family)}, {(void *)buffer, length}};
    ssize_t count = writev(fd, vectors, 2);
    if (count < 0) return count;
    if ((size_t)count != length + 4) { errno = EIO; return -1; }
    return (ssize_t)length;
}
#else
int wl_tun_open(char *ifname, size_t capacity) {
    (void)ifname; (void)capacity; errno = ENOTSUP; return -1;
}
ssize_t wl_tun_read(int fd, void *buffer, size_t capacity) {
    (void)fd; (void)buffer; (void)capacity; errno = ENOTSUP; return -1;
}
ssize_t wl_tun_write(int fd, const void *buffer, size_t length) {
    (void)fd; (void)buffer; (void)length; errno = ENOTSUP; return -1;
}
#endif
