/*
 * imggen.exe — BMP Image Generator
 * 
 * Generates BMP images with various patterns:
 *   solid <width> <height> <hex_color> <output.bmp>
 *   gradient <width> <height> <hex_start> <hex_end> <direction> <output.bmp>
 *   checker <width> <height> <size> <hex_color1> <hex_color2> <output.bmp>
 *   rect <width> <height> <x> <y> <w> <h> <hex_color> <output.bmp>
 *   circle <width> <height> <cx> <cy> <radius> <hex_color> <output.bmp>
 *   noise <width> <height> <seed> <output.bmp>
 *
 * Uses Win32 GDI to create DIB sections and write BMP files.
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct {
    BITMAPFILEHEADER bfh;
    BITMAPINFOHEADER bih;
} BMP_HEADER;

static unsigned char* g_pixels = NULL;
static int g_width = 0;
static int g_height = 0;

static unsigned int parse_color(const char* hex) {
    if (hex[0] == '#') hex++;
    return (unsigned int)strtoul(hex, NULL, 16);
}

static void set_pixel(int x, int y, unsigned int color) {
    if (x < 0 || x >= g_width || y < 0 || y >= g_height) return;
    int idx = (y * g_width + x) * 3;
    g_pixels[idx + 0] = (color >> 16) & 0xFF;  /* R */
    g_pixels[idx + 1] = (color >> 8) & 0xFF;   /* G */
    g_pixels[idx + 2] = color & 0xFF;           /* B */
}

static unsigned int get_pixel(int x, int y) {
    if (x < 0 || x >= g_width || y < 0 || y >= g_height) return 0;
    int idx = (y * g_width + x) * 3;
    return (g_pixels[idx + 0] << 16) | (g_pixels[idx + 1] << 8) | g_pixels[idx + 2];
}

static void fill_solid(unsigned int color) {
    for (int y = 0; y < g_height; y++) {
        for (int x = 0; x < g_width; x++) {
            set_pixel(x, y, color);
        }
    }
}

static void fill_gradient(unsigned int start, unsigned int end, int vertical) {
    int sr = (start >> 16) & 0xFF, sg = (start >> 8) & 0xFF, sb = start & 0xFF;
    int er = (end >> 16) & 0xFF, eg = (end >> 8) & 0xFF, eb = end & 0xFF;
    int max = vertical ? g_height : g_width;
    if (max < 1) max = 1;
    for (int y = 0; y < g_height; y++) {
        for (int x = 0; x < g_width; x++) {
            int t = vertical ? y : x;
            int r = sr + (er - sr) * t / max;
            int g = sg + (eg - sg) * t / max;
            int b = sb + (eb - sb) * t / max;
            set_pixel(x, y, (r << 16) | (g << 8) | b);
        }
    }
}

static void fill_checker(int size, unsigned int c1, unsigned int c2) {
    for (int y = 0; y < g_height; y++) {
        for (int x = 0; x < g_width; x++) {
            int bx = x / size;
            int by = y / size;
            if ((bx + by) % 2 == 0)
                set_pixel(x, y, c1);
            else
                set_pixel(x, y, c2);
        }
    }
}

static void draw_rect(int rx, int ry, int rw, int rh, unsigned int color) {
    for (int y = ry; y < ry + rh && y < g_height; y++) {
        for (int x = rx; x < rx + rw && x < g_width; x++) {
            if (x >= 0 && y >= 0)
                set_pixel(x, y, color);
        }
    }
}

static void draw_circle(int cx, int cy, int radius, unsigned int color) {
    for (int y = 0; y < g_height; y++) {
        for (int x = 0; x < g_width; x++) {
            int dx = x - cx;
            int dy = y - cy;
            if (dx * dx + dy * dy <= radius * radius)
                set_pixel(x, y, color);
        }
    }
}

/* Simple LCG for noise */
static unsigned int lcg_state = 0;
static unsigned int lcg_next(void) {
    lcg_state = lcg_state * 1103515245 + 12345;
    return (lcg_state >> 16) & 0x7FFFFFFF;
}

static void fill_noise(unsigned int seed) {
    lcg_state = seed;
    for (int y = 0; y < g_height; y++) {
        for (int x = 0; x < g_width; x++) {
            unsigned int v = lcg_next() & 0xFFFFFF;
            set_pixel(x, y, v);
        }
    }
}

static int save_bmp(const char* filename) {
    int row_size = g_width * 3;
    /* BMP rows must be 4-byte aligned */
    int padding = (4 - (row_size % 4)) % 4;
    int padded_row_size = row_size + padding;
    int pixel_data_size = padded_row_size * g_height;
    int file_size = sizeof(BMP_HEADER) + pixel_data_size;

    unsigned char* file_buf = (unsigned char*)calloc(file_size, 1);
    if (!file_buf) {
        fprintf(stderr, "ERROR: out of memory\n");
        return 1;
    }

    BMP_HEADER* hdr = (BMP_HEADER*)file_buf;
    hdr->bfh.bfType = 0x4D42; /* 'BM' */
    hdr->bfh.bfSize = file_size;
    hdr->bfh.bfReserved1 = 0;
    hdr->bfh.bfReserved2 = 0;
    hdr->bfh.bfOffBits = sizeof(BMP_HEADER);
    hdr->bih.biSize = sizeof(BITMAPINFOHEADER);
    hdr->bih.biWidth = g_width;
    hdr->bih.biHeight = g_height;
    hdr->bih.biPlanes = 1;
    hdr->bih.biBitCount = 24;
    hdr->bih.biCompression = 0; /* BI_RGB */
    hdr->bih.biSizeImage = pixel_data_size;
    hdr->bih.biXPelsPerMeter = 2835; /* 72 DPI */
    hdr->bih.biYPelsPerMeter = 2835;
    hdr->bih.biClrUsed = 0;
    hdr->bih.biClrImportant = 0;

    /* Copy pixel data (bottom-up, with padding) */
    for (int y = 0; y < g_height; y++) {
        int src_row = (g_height - 1 - y); /* BMP is bottom-up */
        memcpy(file_buf + sizeof(BMP_HEADER) + y * padded_row_size,
               g_pixels + src_row * row_size,
               row_size);
    }

    HANDLE hFile = CreateFileA(filename, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "ERROR: cannot open %s\n", filename);
        free(file_buf);
        return 1;
    }
    DWORD written;
    WriteFile(hFile, file_buf, file_size, &written, NULL);
    CloseHandle(hFile);
    free(file_buf);
    return 0;
}

static int init_canvas(int width, int height) {
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
        fprintf(stderr, "ERROR: invalid dimensions %dx%d\n", width, height);
        return 1;
    }
    g_width = width;
    g_height = height;
    g_pixels = (unsigned char*)malloc(width * height * 3);
    if (!g_pixels) {
        fprintf(stderr, "ERROR: out of memory\n");
        return 1;
    }
    memset(g_pixels, 0, width * height * 3);
    return 0;
}

static void usage(void) {
    fprintf(stderr, "Usage: imggen <command> [args...]\n");
    fprintf(stderr, "Commands:\n");
    fprintf(stderr, "  solid    <w> <h> <hex_color> <output.bmp>\n");
    fprintf(stderr, "  gradient <w> <h> <hex_start> <hex_end> <h|v> <output.bmp>\n");
    fprintf(stderr, "  checker  <w> <h> <size> <hex_c1> <hex_c2> <output.bmp>\n");
    fprintf(stderr, "  rect     <w> <h> <x> <y> <rw> <rh> <hex_color> <output.bmp>\n");
    fprintf(stderr, "  circle   <w> <h> <cx> <cy> <r> <hex_color> <output.bmp>\n");
    fprintf(stderr, "  noise    <w> <h> <seed> <output.bmp>\n");
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        usage();
        return 1;
    }

    const char* cmd = argv[1];

    if (strcmp(cmd, "solid") == 0) {
        if (argc != 6) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        unsigned int color = parse_color(argv[4]);
        const char* out = argv[5];
        if (init_canvas(w, h)) return 1;
        fill_solid(color);
        int ret = save_bmp(out);
        printf("%dx%d solid #%06X -> %s\n", w, h, color, out);
        free(g_pixels);
        return ret;
    }

    if (strcmp(cmd, "gradient") == 0) {
        if (argc != 8) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        unsigned int start = parse_color(argv[4]);
        unsigned int end = parse_color(argv[5]);
        int vertical = (argv[6][0] == 'v' || argv[6][0] == 'V');
        const char* out = argv[7];
        if (init_canvas(w, h)) return 1;
        fill_gradient(start, end, vertical);
        int ret = save_bmp(out);
        printf("%dx%d gradient #%06X->#%06X (%s) -> %s\n", w, h, start, end, vertical ? "vertical" : "horizontal", out);
        free(g_pixels);
        return ret;
    }

    if (strcmp(cmd, "checker") == 0) {
        if (argc != 8) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        int size = atoi(argv[4]);
        unsigned int c1 = parse_color(argv[5]);
        unsigned int c2 = parse_color(argv[6]);
        const char* out = argv[7];
        if (size <= 0) { fprintf(stderr, "ERROR: invalid size\n"); return 1; }
        if (init_canvas(w, h)) return 1;
        fill_checker(size, c1, c2);
        int ret = save_bmp(out);
        printf("%dx%d checker size=%d -> %s\n", w, h, size, out);
        free(g_pixels);
        return ret;
    }

    if (strcmp(cmd, "rect") == 0) {
        if (argc != 10) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        int rx = atoi(argv[4]), ry = atoi(argv[5]);
        int rw = atoi(argv[6]), rh = atoi(argv[7]);
        unsigned int color = parse_color(argv[8]);
        const char* out = argv[9];
        if (init_canvas(w, h)) return 1;
        fill_solid(0x000000);
        draw_rect(rx, ry, rw, rh, color);
        int ret = save_bmp(out);
        printf("%dx%d rect (%d,%d %dx%d) -> %s\n", w, h, rx, ry, rw, rh, out);
        free(g_pixels);
        return ret;
    }

    if (strcmp(cmd, "circle") == 0) {
        if (argc != 9) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        int cx = atoi(argv[4]), cy = atoi(argv[5]);
        int radius = atoi(argv[6]);
        unsigned int color = parse_color(argv[7]);
        const char* out = argv[8];
        if (init_canvas(w, h)) return 1;
        fill_solid(0x000000);
        draw_circle(cx, cy, radius, color);
        int ret = save_bmp(out);
        printf("%dx%d circle (%d,%d r=%d) -> %s\n", w, h, cx, cy, radius, out);
        free(g_pixels);
        return ret;
    }

    if (strcmp(cmd, "noise") == 0) {
        if (argc != 6) { usage(); return 1; }
        int w = atoi(argv[2]), h = atoi(argv[3]);
        unsigned int seed = (unsigned int)strtoul(argv[4], NULL, 0);
        const char* out = argv[5];
        if (init_canvas(w, h)) return 1;
        fill_noise(seed);
        int ret = save_bmp(out);
        printf("%dx%d noise seed=%u -> %s\n", w, h, seed, out);
        free(g_pixels);
        return ret;
    }

    fprintf(stderr, "ERROR: unknown command '%s'\n", cmd);
    usage();
    return 1;
}
