#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* BMP header: 14-byte file header + 2 padding bytes + 40-byte DIB header = 56 bytes */
#pragma pack(push, 1)
typedef struct {
    /* File header (14 bytes) */
    char     signature[2];    /* "BM" */
    uint32_t file_size;       /* total file size */
    uint16_t reserved1;       /* 0 */
    uint16_t reserved2;       /* 0 */
    uint32_t data_offset;     /* offset to pixel data = 56 */
    /* 2 padding bytes */
    uint16_t padding;
    /* DIB header (40 bytes) */
    uint32_t header_size;     /* 40 */
    int32_t  width;
    int32_t  height;         /* positive = bottom-up */
    uint16_t planes;          /* 1 */
    uint16_t bpp;             /* 24 */
    uint32_t compression;     /* 0 = BI_RGB */
    uint32_t image_size;      /* padded row * height */
    int32_t  x_ppm;           /* 2835 */
    int32_t  y_ppm;           /* 2835 */
    uint32_t colors_used;     /* 0 */
    uint32_t colors_important;/* 0 */
} BMPHeader;
#pragma pack(pop)

/* Returns 0 on success, 1 on failure */
static int write_bmp(const char *path, int w, int h, unsigned char *pixels) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "ERROR: cannot open %s\r\n", path);
        return 1;
    }
    int row_bytes = w * 3;
    int padded_row = (row_bytes + 3) & ~3;
    int image_size = padded_row * h;
    
    BMPHeader hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.signature[0] = 'B';
    hdr.signature[1] = 'M';
    hdr.file_size = 56 + image_size;
    hdr.data_offset = 56;
    hdr.header_size = 40;
    hdr.width = w;
    hdr.height = h;
    hdr.planes = 1;
    hdr.bpp = 24;
    hdr.compression = 0;
    hdr.image_size = image_size;
    hdr.x_ppm = 2835;
    hdr.y_ppm = 2835;
    
    fwrite(&hdr, 1, sizeof(hdr), f);
    
    /* Write pixel data bottom-up (BMP format) */
    unsigned char *row_buf = (unsigned char *)calloc(padded_row, 1);
    if (!row_buf) {
        fprintf(stderr, "ERROR: out of memory\r\n");
        fclose(f);
        return 1;
    }
    for (int y = 0; y < h; y++) {
        /* BMP is bottom-up: first row in file = bottom row of image (y = h-1) */
        int src_y = h - 1 - y;
        memcpy(row_buf, pixels + src_y * row_bytes, row_bytes);
        /* Zero padding bytes */
        for (int i = row_bytes; i < padded_row; i++)
            row_buf[i] = 0;
        fwrite(row_buf, 1, padded_row, f);
    }
    free(row_buf);
    fclose(f);
    return 0;
}

static unsigned char *alloc_image(int w, int h) {
    unsigned char *p = (unsigned char *)calloc((size_t)w * h * 3, 1);
    if (!p) {
        fprintf(stderr, "ERROR: out of memory\r\n");
        exit(1);
    }
    return p;
}

/* Parse hex color: 0xBBGGRR -> B=(c>>16)&0xFF, G=(c>>8)&0xFF, R=c&0xFF */
static void parse_color(const char *str, unsigned char *b, unsigned char *g, unsigned char *r) {
    unsigned int c = (unsigned int)strtoul(str, NULL, 16);
    *b = (c >> 16) & 0xFF;
    *g = (c >> 8) & 0xFF;
    *r = c & 0xFF;
}

static void print_usage(FILE *out) {
    fprintf(out, "Usage: imggen <command> [args...]\r\n");
    fprintf(out, "Commands:\r\n");
    fprintf(out, "  solid    <w> <h> <hex_color> <output.bmp>\r\n");
    fprintf(out, "  gradient <w> <h> <hex_start> <hex_end> <h|v> <output.bmp>\r\n");
    fprintf(out, "  checker  <w> <h> <size> <hex_c1> <hex_c2> <output.bmp>\r\n");
    fprintf(out, "  rect     <w> <h> <x> <y> <rw> <rh> <hex_color> <output.bmp>\r\n");
    fprintf(out, "  circle   <w> <h> <cx> <cy> <r> <hex_color> <output.bmp>\r\n");
    fprintf(out, "  noise    <w> <h> <seed> <output.bmp>\r\n");
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        print_usage(stderr);
        return 1;
    }
    
    const char *cmd = argv[1];
    
    if (strcmp(cmd, "solid") == 0) {
        if (argc < 6) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        unsigned char bc, gc, rc;
        unsigned int color_val = (unsigned int)strtoul(argv[4], NULL, 16); parse_color(argv[4], &bc, &gc, &rc);
        const char *output = argv[5];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        
        unsigned char *pixels = alloc_image(w, h);
        for (int i = 0; i < w * h; i++) {
            pixels[i*3]   = bc;
            pixels[i*3+1] = gc;
            pixels[i*3+2] = rc;
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d solid #%06X -> %s\r\n", w, h, color_val, output);
        free(pixels);
        if (rc2) return 1;
        
    } else if (strcmp(cmd, "gradient") == 0) {
        if (argc < 7) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        unsigned int start_val = (unsigned int)strtoul(argv[4], NULL, 16);
        unsigned int end_val = (unsigned int)strtoul(argv[5], NULL, 16);
        unsigned char bs, gs, rs, be, ge, re;
        parse_color(argv[4], &bs, &gs, &rs);
        parse_color(argv[5], &be, &ge, &re);
        const char *dir_str = argv[6];
        const char *output = argv[7];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        
        int vertical = (strcmp(dir_str, "v") == 0);
        unsigned char *pixels = alloc_image(w, h);
        
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                unsigned char b, g, r;
                if (vertical) {
                    /* channel = start + (end - start) * y / h */
                    b = bs + (int)(be - bs) * y / h;
                    g = gs + (int)(ge - gs) * y / h;
                    r = rs + (int)(re - rs) * y / h;
                } else {
                    /* channel = start + (end - start) * x / w */
                    b = bs + (int)(be - bs) * x / w;
                    g = gs + (int)(ge - gs) * x / w;
                    r = rs + (int)(re - rs) * x / w;
                }
                int idx = (y * w + x) * 3;
                pixels[idx]   = b;
                pixels[idx+1] = g;
                pixels[idx+2] = r;
            }
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d gradient #%06X->#%06X (%s) -> %s\r\n", w, h, start_val, end_val,
               vertical ? "vertical" : "horizontal", output);
        free(pixels);
        if (rc2) return 1;
        
    } else if (strcmp(cmd, "checker") == 0) {
        if (argc < 7) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        int size = atoi(argv[4]);
        unsigned char b1, g1, r1, b2, g2, r2;
        parse_color(argv[5], &b1, &g1, &r1);
        parse_color(argv[6], &b2, &g2, &r2);
        const char *output = argv[7];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        if (size <= 0) {
            fprintf(stderr, "ERROR: invalid size\r\n");
            return 1;
        }
        
        unsigned char *pixels = alloc_image(w, h);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int idx = (y * w + x) * 3;
                if ((x / size + y / size) % 2 == 0) {
                    pixels[idx]   = b1;
                    pixels[idx+1] = g1;
                    pixels[idx+2] = r1;
                } else {
                    pixels[idx]   = b2;
                    pixels[idx+1] = g2;
                    pixels[idx+2] = r2;
                }
            }
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d checker size=%d -> %s\r\n", w, h, size, output);
        free(pixels);
        if (rc2) return 1;
        
    } else if (strcmp(cmd, "rect") == 0) {
        if (argc < 9) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        int rx = atoi(argv[4]);
        int ry = atoi(argv[5]);
        int rw = atoi(argv[6]);
        int rh = atoi(argv[7]);
        unsigned char bc, gc, rc;
        parse_color(argv[8], &bc, &gc, &rc);
        const char *output = argv[9];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        
        unsigned char *pixels = alloc_image(w, h);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int idx = (y * w + x) * 3;
                if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
                    pixels[idx]   = bc;
                    pixels[idx+1] = gc;
                    pixels[idx+2] = rc;
                }
                /* else black (already zeroed by calloc) */
            }
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d rect (%d,%d %dx%d) -> %s\r\n", w, h, rx, ry, rw, rh, output);
        free(pixels);
        if (rc2) return 1;
        
    } else if (strcmp(cmd, "circle") == 0) {
        if (argc < 8) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        int cx = atoi(argv[4]);
        int cy = atoi(argv[5]);
        int r = atoi(argv[6]);
        unsigned char bc, gc, rc;
        parse_color(argv[7], &bc, &gc, &rc);
        const char *output = argv[8];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        
        unsigned char *pixels = alloc_image(w, h);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int idx = (y * w + x) * 3;
                int dx = x - cx;
                int dy = y - cy;
                if (dx * dx + dy * dy <= r * r) {
                    pixels[idx]   = bc;
                    pixels[idx+1] = gc;
                    pixels[idx+2] = rc;
                }
            }
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d circle (%d,%d r=%d) -> %s\r\n", w, h, cx, cy, r, output);
        free(pixels);
        if (rc2) return 1;
        
    } else if (strcmp(cmd, "noise") == 0) {
        if (argc < 5) {
            print_usage(stderr);
            return 1;
        }
        int w = atoi(argv[2]);
        int h = atoi(argv[3]);
        unsigned int seed = (unsigned int)strtoul(argv[4], NULL, 10);
        const char *output = argv[5];
        
        if (w <= 0 || h <= 0) {
            fprintf(stderr, "ERROR: invalid dimensions %dx%d\r\n", w, h);
            return 1;
        }
        
        unsigned char *pixels = alloc_image(w, h);
        uint32_t state = seed;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                state = state * 1103515245u + 12345u;
                uint16_t val16 = (state >> 16) & 0xFFFF;
                int idx = (y * w + x) * 3;
                pixels[idx]   = 0;                    /* B = 0 */
                pixels[idx+1] = (val16 >> 8) & 0xFF;  /* G = high byte */
                pixels[idx+2] = val16 & 0xFF;         /* R = low byte */
            }
        }
        int rc2 = write_bmp(output, w, h, pixels);
        printf("%dx%d noise seed=%u -> %s\r\n", w, h, seed, output);
        free(pixels);
        if (rc2) return 1;
        
    } else {
        fprintf(stderr, "ERROR: unknown command '%s'\r\n", cmd);
        print_usage(stderr);
        return 1;
    }
    
    return 0;
}
