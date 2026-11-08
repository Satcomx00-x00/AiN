// An absolute pointer for the VM tests, created through uinput.
//
// ydotool's virtual device is a *relative* mouse; a desktop applies its pointer acceleration to it,
// and on some machines a large relative move is scaled ~2x (the pointer misses the island). Absolute
// events are not accelerated: `move X Y` lands exactly at that screen pixel.
//
// The daemon reads commands from a FIFO, owned by the desktop user; it runs as root, since only root
// may create uinput devices on a stock system:
//
//   move X Y    absolute position, in screen pixels
//   down        left button down
//   up          left button up
//   click       left button down, then up
//
// Usage: ain-pointer FIFO UID GID WIDTH HEIGHT
#define _GNU_SOURCE

#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int uinput = -1;

static void emit(unsigned type, unsigned code, int value) {
  struct input_event ev;
  memset(&ev, 0, sizeof ev);
  ev.type = type;
  ev.code = code;
  ev.value = value;
  if (write(uinput, &ev, sizeof ev) < 0)
    perror("ain-pointer: write");
}

static int open_device(int width, int height) {
  struct uinput_abs_setup abs;
  struct uinput_setup setup;

  uinput = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (uinput < 0) {
    perror("ain-pointer: /dev/uinput");
    return -1;
  }

  ioctl(uinput, UI_SET_EVBIT, EV_SYN);
  ioctl(uinput, UI_SET_EVBIT, EV_KEY);
  ioctl(uinput, UI_SET_KEYBIT, BTN_LEFT);
  ioctl(uinput, UI_SET_EVBIT, EV_ABS);
  ioctl(uinput, UI_SET_ABSBIT, ABS_X);
  ioctl(uinput, UI_SET_ABSBIT, ABS_Y);

  memset(&abs, 0, sizeof abs);
  abs.code = ABS_X;
  abs.absinfo.minimum = 0;
  abs.absinfo.maximum = width - 1;
  abs.absinfo.resolution = 1;
  if (ioctl(uinput, UI_ABS_SETUP, &abs) < 0) {
    perror("ain-pointer: UI_ABS_SETUP X");
    return -1;
  }
  abs.code = ABS_Y;
  abs.absinfo.maximum = height - 1;
  if (ioctl(uinput, UI_ABS_SETUP, &abs) < 0) {
    perror("ain-pointer: UI_ABS_SETUP Y");
    return -1;
  }

  memset(&setup, 0, sizeof setup);
  snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "AiN test pointer");
  setup.id.bustype = BUS_VIRTUAL;
  setup.id.vendor = 0x1a1;
  setup.id.product = 0x0002;
  setup.id.version = 1;
  if (ioctl(uinput, UI_DEV_SETUP, &setup) < 0) {
    perror("ain-pointer: UI_DEV_SETUP");
    return -1;
  }
  if (ioctl(uinput, UI_DEV_CREATE) < 0) {
    perror("ain-pointer: UI_DEV_CREATE");
    return -1;
  }
  usleep(200000);
  return 0;
}

static void command(const char *line, int width, int height) {
  int x, y;

  if (sscanf(line, "move %d %d", &x, &y) == 2) {
    if (x < 0)
      x = 0;
    if (y < 0)
      y = 0;
    if (x >= width)
      x = width - 1;
    if (y >= height)
      y = height - 1;
    emit(EV_ABS, ABS_X, x);
    emit(EV_ABS, ABS_Y, y);
    emit(EV_SYN, SYN_REPORT, 0);
  } else if (strncmp(line, "down", 4) == 0) {
    emit(EV_KEY, BTN_LEFT, 1);
    emit(EV_SYN, SYN_REPORT, 0);
  } else if (strncmp(line, "up", 2) == 0) {
    emit(EV_KEY, BTN_LEFT, 0);
    emit(EV_SYN, SYN_REPORT, 0);
  } else if (strncmp(line, "click", 5) == 0) {
    emit(EV_KEY, BTN_LEFT, 1);
    emit(EV_SYN, SYN_REPORT, 0);
    usleep(50000);
    emit(EV_KEY, BTN_LEFT, 0);
    emit(EV_SYN, SYN_REPORT, 0);
  }
}

int main(int argc, char **argv) {
  const char *fifo;
  uid_t uid;
  gid_t gid;
  int width, height;

  if (argc != 6) {
    fprintf(stderr, "usage: %s FIFO UID GID WIDTH HEIGHT\n", argv[0]);
    return 2;
  }
  fifo = argv[1];
  uid = (uid_t)strtoul(argv[2], NULL, 10);
  gid = (gid_t)strtoul(argv[3], NULL, 10);
  width = atoi(argv[4]);
  height = atoi(argv[5]);
  if (width <= 0 || height <= 0) {
    fprintf(stderr, "ain-pointer: bad screen size %dx%d\n", width, height);
    return 2;
  }
  if (open_device(width, height) < 0)
    return 1;

  unlink(fifo);
  if (mkfifo(fifo, 0600) < 0) {
    perror("ain-pointer: mkfifo");
    return 1;
  }
  if (chown(fifo, uid, gid) < 0)
    perror("ain-pointer: chown");

  for (;;) {
    FILE *f = fopen(fifo, "r");
    char line[128];
    if (!f) {
      usleep(100000);
      continue;
    }
    while (fgets(line, sizeof line, f))
      command(line, width, height);
    fclose(f);
  }
}
