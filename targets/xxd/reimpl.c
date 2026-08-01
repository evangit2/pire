/*
 * reimpl.c - Reimplementation of xxd.exe
 * xxd 2022-01-14 by Juergen Weigert et al. (2024-08-06 standalone-port ckormanyos) (Win32)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdint.h>

/* EBCDIC to ASCII table (for display in ASCII column when -E is set) */
static const char ebcdic_to_ascii[256] = {
    '.','.','.','.','.','.','.','.','.','.','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.','.','.','<','(','+','|','&',
    '.','.','.','.','.','.','.','.','.','.','!','$','*',')',';','~',
    '-','/','.','_','>','?','.','.','.','.','`',':','#','@','\'','=',
    ' ','a','b','c','d','e','f','g','h','i','.','.','.','.','.','.',
    '.','j','k','l','m','n','o','p','q','r','.','.','.','.','.','.',
    '~','s','t','u','v','w','x','y','z','.','.','.','{','|','}','.',
    'A','B','C','D','E','F','G','H','I','J','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.','.','.','.','.','.','.','.','.',
    'a','b','c','d','e','f','g','h','i','.','.','.','.','.','.','.',
    '.','j','k','l','m','n','o','p','q','r','.','.','.','.','.','.',
    's','t','u','v','w','x','y','z','.','.','.','.','{','|','}','.',
    'A','B','C','D','E','F','G','H','I','J','.','.','.','.','.','.',
    'K','L','M','N','O','P','Q','R','S','T','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.','.','.','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.','.','.','.','.','.','.','.','.',
};

static const char hex_chars_lower[] = "0123456789abcdef";
static const char hex_chars_upper[] = "0123456789ABCDEF";

/* Options */
static int opt_autoskip = 0;
static int opt_binary = 0;
static int opt_capitalize = 0;
static int opt_cols = -1;
static int opt_ebcdic = 0;
static int opt_endian = 0;
static int opt_group = -1;
static int opt_c_include = 0;
static char *opt_name = NULL;
static long opt_length = -1;
static long opt_offset = 0;
static int opt_postscript = 0;
static int opt_revert = 0;
static int opt_decimal = 0;
static long opt_seek = 0;
static int opt_seek_set = 0;
static int opt_seek_relative = 0;
static int opt_seek_negative = 0;
static int opt_uppercase = 0;
static int opt_version = 0;
static int opt_help = 0;

static const char *progname = "xxd.exe";

static void usage(void)
{
    fprintf(stderr,
"Usage:\n"
"       %s [options] [infile [outfile]]\n"
"    or\n"
"       %s -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]\n"
"Options:\n"
"    -a          toggle autoskip: A single '*' replaces nul-lines. Default off.\n"
"    -b          binary digit dump (incompatible with -ps,-i,-r). Default hex.\n"
"    -C          capitalize variable names in C include file style (-i).\n"
"    -c cols     format <cols> octets per line. Default 16 (-i: 12, -ps: 30).\n"
"    -E          show characters in EBCDIC. Default ASCII.\n"
"    -e          little-endian dump (incompatible with -ps,-i,-r).\n"
"    -g bytes    number of octets per group in normal output. Default 2 (-e: 4).\n"
"    -h          print this summary.\n"
"    -i          output in C include file style.\n"
"    -n name     set the variable name used in C include output (-i).\n"
"    -l len      stop after <len> octets.\n"
"    -o off      add <off> to the displayed file position.\n"
"    -ps         output in postscript plain hexdump style.\n"
"    -r          reverse operation: convert (or patch) hexdump into binary.\n"
"    -r -s off   revert with <off> added to file positions found in hexdump.\n"
"    -d          show offset in decimal instead of hex.\n"
"    -s [+][-]seek  start at <seek> bytes abs. (or +: rel.) infile offset.\n"
"    -u          use upper case hex letters.\n"
"    -v          show version: \"%%s%%s\".\n",
    progname, progname);
}

static void version_info(void)
{
    printf("xxd 2022-01-14 by Juergen Weigert et al. (2024-08-06 standalone-port ckormanyos) (Win32)\n");
}

static int is_power_of_2(int n)
{
    return n > 0 && (n & (n - 1)) == 0;
}

static char display_char(unsigned char c)
{
    if (opt_ebcdic) {
        return ebcdic_to_ascii[c];
    }
    if (c >= 32 && c <= 126)
        return (char)c;
    return '.';
}

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Normal hex dump */
static int normal_hexdump(FILE *fp, FILE *fpo, long display_offset)
{
    int cols = opt_cols;
    if (cols <= 0) cols = 16;
    int group = opt_group;
    if (group <= 0) group = 2;

    const char *hex = opt_uppercase ? hex_chars_upper : hex_chars_lower;

    unsigned char buf[512];
    long bytes_read;
    long file_pos = 0;
    int prev_all_zero = 0;
    int star_printed = 0;
    long remaining = opt_length;

    while (1) {
        int to_read = cols;
        if (remaining >= 0 && remaining < to_read)
            to_read = (int)remaining;

        if (to_read <= 0)
            break;

        bytes_read = fread(buf, 1, to_read, fp);
        if (bytes_read <= 0)
            break;

        if (remaining >= 0)
            remaining -= bytes_read;

        /* Check for all-zero line (autoskip) */
        int all_zero = 1;
        for (int i = 0; i < bytes_read; i++) {
            if (buf[i] != 0) { all_zero = 0; break; }
        }

        if (opt_autoskip && all_zero && bytes_read == cols) {
            if (prev_all_zero && !star_printed) {
                fprintf(fpo, "*\r\n");
                star_printed = 1;
            }
            prev_all_zero = 1;
            file_pos += bytes_read;
            continue;
        }

        /* Print offset */
        long disp = display_offset + file_pos;
        if (opt_decimal) {
            fprintf(fpo, "%08ld:", disp);
        } else {
            fprintf(fpo, "%08lx:", disp);
        }

        /* Print hex bytes */
        int i = 0;
        while (i < bytes_read) {
            fputc(' ', fpo);
            if (opt_endian) {
                int j = i + group - 1;
                if (j >= bytes_read) j = bytes_read - 1;
                for (; j >= i; j--) {
                    fputc(hex[buf[j] >> 4], fpo);
                    fputc(hex[buf[j] & 0xf], fpo);
                }
            } else {
                int end = i + group;
                if (end > bytes_read) end = bytes_read;
                for (int j = i; j < end; j++) {
                    fputc(hex[buf[j] >> 4], fpo);
                    fputc(hex[buf[j] & 0xf], fpo);
                }
            }
            i += group;
        }

        /* Pad hex to full width */
        {
            int n_groups_total = cols / group;
            int full_hex_width = 1 + n_groups_total * (group * 2) + (n_groups_total - 1);
            int n_groups_written = (bytes_read + group - 1) / group;
            int written_width;
            if (bytes_read == 0) {
                written_width = 0;
            } else {
                int last_group_bytes = bytes_read % group;
                if (last_group_bytes == 0) last_group_bytes = group;
                written_width = 1 + (n_groups_written - 1) * (group * 2 + 1) + last_group_bytes * 2;
            }
            int pad = full_hex_width - written_width;
            for (int p = 0; p < pad; p++)
                fputc(' ', fpo);
        }

        /* Print ASCII (no padding) */
        fprintf(fpo, "  ");
        for (int i = 0; i < bytes_read; i++) {
            fputc(display_char(buf[i]), fpo);
        }

        fputc('\r', fpo);
        fputc('\n', fpo);

        prev_all_zero = 0;
        star_printed = 0;
        file_pos += bytes_read;
    }

    return 0;
}

/* Postscript plain hexdump */
static int postscript_dump(FILE *fp, FILE *fpo)
{
    int cols = opt_cols;
    if (cols <= 0) cols = 30;

    const char *hex = opt_uppercase ? hex_chars_upper : hex_chars_lower;
    long remaining = opt_length;
    int col = 0;

    while (1) {
        if (remaining >= 0 && remaining <= 0)
            break;
        unsigned char c;
        int n = fread(&c, 1, 1, fp);
        if (n <= 0)
            break;
        if (remaining >= 0)
            remaining--;

        fputc(hex[c >> 4], fpo);
        fputc(hex[c & 0xf], fpo);
        col++;
        if (col >= cols) {
            fputc('\r', fpo);
            fputc('\n', fpo);
            col = 0;
        }
    }
    if (col > 0) {
        fputc('\r', fpo);
        fputc('\n', fpo);
    }

    return 0;
}

/* Make variable name from filename */
static char *make_var_name(const char *filename)
{
    char *name;
    int len = strlen(filename);
    name = malloc(len + 1);
    int j = 0;
    for (int i = 0; i < len; i++) {
        char c = filename[i];
        if (isalnum((unsigned char)c)) {
            name[j++] = c;
        } else {
            name[j++] = '_';
        }
    }
    name[j] = '\0';
    return name;
}

/* C include dump */
static int c_include_dump(FILE *fp, FILE *fpo, const char *filename)
{
    int cols = opt_cols;
    if (cols <= 0) cols = 12;

    const char *prefix = opt_uppercase ? "0X" : "0x";

    char *var_name;
    if (opt_name) {
        var_name = strdup(opt_name);
    } else {
        var_name = make_var_name(filename);
    }

    if (opt_capitalize) {
        for (char *p = var_name; *p; p++)
            *p = toupper((unsigned char)*p);
    }

    fprintf(fpo, "unsigned char %s[] = {\r\n", var_name);

    unsigned char buf[512];
    long total = 0;
    long remaining = opt_length;
    int col = 0;

    while (1) {
        int to_read = sizeof(buf);
        if (remaining >= 0 && remaining < to_read)
            to_read = (int)remaining;
        if (to_read <= 0)
            break;
        int n = fread(buf, 1, to_read, fp);
        if (n <= 0)
            break;
        if (remaining >= 0)
            remaining -= n;

        for (int i = 0; i < n; i++) {
            if (col == 0) {
                if (total > 0)
                    fprintf(fpo, "\r\n");
                fprintf(fpo, "  ");
            } else {
                fprintf(fpo, " ");
            }
            fprintf(fpo, "%s%02x", prefix, buf[i]);
            /* Add comma unless this is the last byte */
            int has_more = 0;
            if (i + 1 < n) {
                has_more = 1;
            } else {
                /* Check if there's more data to read */
                if (remaining >= 0) {
                    has_more = (remaining - n) > 0 ? 1 : 0;
                } else {
                    /* Peek at next byte */
                    int c = fgetc(fp);
                    if (c != EOF) {
                        ungetc(c, fp);
                        has_more = 1;
                    }
                }
            }
            if (has_more)
                fprintf(fpo, ",");
            total++;
            col++;
            if (col >= cols)
                col = 0;
        }
    }
    if (total > 0)
        fprintf(fpo, "\r\n");
    fprintf(fpo, "};\r\n");
    fprintf(fpo, "unsigned int %s%s = %ld;\r\n", var_name,
            opt_capitalize ? "_LEN" : "_len", total);

    free(var_name);
    return 0;
}

/* Binary digit dump */
static int binary_dump(FILE *fp, FILE *fpo)
{
    int cols = opt_cols;
    if (cols <= 0) cols = 6;

    unsigned char buf[512];
    long file_pos = 0;
    long display_offset = opt_offset;
    long remaining = opt_length;

    while (1) {
        int to_read = cols;
        if (remaining >= 0 && remaining < to_read)
            to_read = (int)remaining;
        if (to_read <= 0)
            break;
        int n = fread(buf, 1, to_read, fp);
        if (n <= 0)
            break;
        if (remaining >= 0)
            remaining -= n;

        /* Offset */
        long disp = display_offset + file_pos;
        fprintf(fpo, "%08lx:", disp);

        /* Binary: each byte as 8 bits, space before each byte */
        for (int i = 0; i < n; i++) {
            fputc(' ', fpo);
            for (int bit = 7; bit >= 0; bit--) {
                fputc((buf[i] >> bit) & 1 ? '1' : '0', fpo);
            }
        }
        /* Pad to full width: 9 chars per missing byte (1 space + 8 bits) */
        for (int i = n; i < cols; i++) {
            fprintf(fpo, "         ");
        }

        /* ASCII (no padding) */
        fprintf(fpo, "  ");
        for (int i = 0; i < n; i++) {
            fputc(display_char(buf[i]), fpo);
        }

        fputc('\r', fpo);
        fputc('\n', fpo);
        file_pos += n;
    }

    return 0;
}

/* Parse a line of hexdump for reverse operation */
static int reverse_hexdump(FILE *fp, FILE *fpo)
{
    char line[1024];
    long seek_offset = 0;
    int have_seek_offset = opt_seek_set;
    if (have_seek_offset)
        seek_offset = opt_seek;
    long output_pos = 0;
    int cols = opt_cols;
    if (cols <= 0) cols = 16;

    long star_line_addr = 0;
    int last_was_star = 0;

    while (fgets(line, sizeof(line), fp) != NULL) {
        char *p = line;
        while (*p && isspace((unsigned char)*p)) p++;
        if (*p == '\0') continue;

        /* Check for star line */
        if (*p == '*') {
            last_was_star = 1;
            continue;
        }

        /* Parse the address at beginning of line */
        char *endptr;
        long addr;

        addr = strtol(p, &endptr, 16);
        if (endptr == p || *endptr != ':') {
            addr = -1;
            p = line;
            while (*p && isspace((unsigned char)*p)) p++;
        } else {
            p = endptr + 1;
        }

        if (last_was_star && addr >= 0) {
            long fill_start = star_line_addr;
            long fill_end = addr;
            if (have_seek_offset) {
                fill_start += seek_offset;
                fill_end += seek_offset;
            }
            while (output_pos < fill_end) {
                if (output_pos < fill_start) {
                    fseek(fpo, fill_start, SEEK_SET);
                    output_pos = fill_start;
                }
                fputc(0, fpo);
                output_pos++;
            }
            last_was_star = 0;
        }

        if (addr >= 0) {
            long target = addr;
            if (have_seek_offset) {
                if (seek_offset < 0) {
                    fprintf(stderr, "%s: Sorry, cannot seek backwards.\n", progname);
                    return 0;
                }
                target += seek_offset;
            }
            while (output_pos < target) {
                fputc(0, fpo);
                output_pos++;
            }
        }

        /* Parse hex bytes */
        int byte_count = 0;
        while (*p) {
            while (*p && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
                p++;
            if (*p == '\0') break;

            int h1, h2;
            h1 = hexval(*p);
            if (h1 < 0) break;
            p++;
            h2 = hexval(*p);
            if (h2 < 0) {
                p++;
                fputc(h1, fpo);
                output_pos++;
                byte_count++;
                continue;
            }
            p++;
            unsigned char byte = (h1 << 4) | h2;
            fputc(byte, fpo);
            output_pos++;
            byte_count++;

            while (*p == ' ' || *p == '\t') p++;
            if (hexval(*p) < 0) break;
        }

        if (addr >= 0)
            star_line_addr = addr + byte_count;
        else
            star_line_addr += byte_count;
    }

    return 0;
}

/* Reverse postscript */
static int reverse_postscript(FILE *fp, FILE *fpo)
{
    int c;
    int hi = -1;
    long seek_offset = 0;
    int have_seek_offset = opt_seek_set;
    if (have_seek_offset)
        seek_offset = opt_seek;
    long output_pos = 0;

    if (have_seek_offset) {
        if (seek_offset < 0) {
            fprintf(stderr, "%s: Sorry, cannot seek backwards.\n", progname);
            return 0;
        }
        while (output_pos < seek_offset) {
            fputc(0, fpo);
            output_pos++;
        }
    }

    while ((c = fgetc(fp)) != EOF) {
        int h = hexval(c);
        if (h < 0) continue;
        if (hi < 0) {
            hi = h;
        } else {
            fputc((hi << 4) | h, fpo);
            output_pos++;
            hi = -1;
        }
    }
    return 0;
}

int main(int argc, char *argv[])
{
    int i;
    char *infile_name = NULL;
    char *outfile_name = NULL;

    if (argc > 0 && argv[0]) {
        const char *p = strrchr(argv[0], '/');
        if (!p) p = strrchr(argv[0], '\\');
        if (p) progname = strdup(p + 1);
        else progname = strdup(argv[0]);
    }

    for (i = 1; i < argc; i++) {
        if (argv[i][0] != '-' || argv[i][1] == '\0') {
            if (!infile_name) {
                infile_name = argv[i];
            } else if (!outfile_name) {
                outfile_name = argv[i];
            }
            continue;
        }

        char *opt = argv[i] + 1;
        if (strcmp(opt, "a") == 0) {
            opt_autoskip = 1;
        } else if (strcmp(opt, "b") == 0) {
            opt_binary = 1;
        } else if (strcmp(opt, "C") == 0) {
            opt_capitalize = 1;
        } else if (strcmp(opt, "E") == 0) {
            opt_ebcdic = 1;
        } else if (strcmp(opt, "e") == 0) {
            opt_endian = 1;
        } else if (strcmp(opt, "h") == 0) {
            opt_help = 1;
        } else if (strcmp(opt, "i") == 0) {
            opt_c_include = 1;
        } else if (strcmp(opt, "ps") == 0 || strcmp(opt, "p") == 0) {
            opt_postscript = 1;
        } else if (strcmp(opt, "r") == 0) {
            opt_revert = 1;
        } else if (strcmp(opt, "d") == 0) {
            opt_decimal = 1;
        } else if (strcmp(opt, "u") == 0) {
            opt_uppercase = 1;
        } else if (strcmp(opt, "v") == 0) {
            opt_version = 1;
        } else if (strcmp(opt, "c") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            opt_cols = atoi(argv[++i]);
        } else if (strcmp(opt, "g") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            opt_group = atoi(argv[++i]);
        } else if (strcmp(opt, "l") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            opt_length = strtol(argv[++i], NULL, 0);
        } else if (strcmp(opt, "o") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            opt_offset = strtol(argv[++i], NULL, 0);
        } else if (strcmp(opt, "n") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            opt_name = argv[++i];
        } else if (strcmp(opt, "s") == 0) {
            if (i + 1 >= argc) { usage(); return 1; }
            char *s = argv[++i];
            opt_seek_set = 1;
            if (*s == '+') {
                opt_seek_relative = 1;
                s++;
            } else if (*s == '-') {
                opt_seek_negative = 1;
                s++;
            }
            opt_seek = strtol(s, NULL, 0);
            if (opt_seek_negative) opt_seek = -opt_seek;
        } else {
            usage();
            return 1;
        }
    }

    if (opt_help) {
        usage();
        return 0;
    }

    if (opt_version) {
        version_info();
        return 0;
    }

    if (opt_binary) {
        if (opt_postscript || opt_c_include || opt_revert) {
            opt_binary = 0;
        }
    }

    if (opt_endian) {
        if (opt_postscript || opt_c_include || opt_revert) {
            if (opt_revert) {
                fprintf(stderr, "%s: Sorry, cannot revert this type of hexdump\n", progname);
                return 0;
            }
            opt_endian = 0;
        }
    }

    if (opt_endian && opt_group > 0 && !is_power_of_2(opt_group)) {
        fprintf(stderr, "%s: number of octets per group must be a power of 2 with -e.\n", progname);
        return 1;
    }

    if (opt_cols > 256) {
        fprintf(stderr, "%s: invalid number of columns (max. 256).\n", progname);
        return 1;
    }

    if (opt_endian && opt_group <= 0) {
        opt_group = 4;
    }

    if (opt_cols <= 0) {
        if (opt_postscript) opt_cols = 30;
        else if (opt_c_include) opt_cols = 12;
        else if (opt_binary) opt_cols = 6;
        else opt_cols = 16;
    }

    if (opt_revert) {
        if (opt_binary || opt_c_include || opt_endian) {
            fprintf(stderr, "%s: Sorry, cannot revert this type of hexdump\n", progname);
            return 0;
        }
    }

    FILE *fp = stdin;
    if (infile_name) {
        fp = fopen(infile_name, "rb");
        if (!fp) {
            perror(infile_name);
            fprintf(stderr, "%s: \n", progname);
            return 2;
        }
    }

    FILE *fpo = stdout;
    if (outfile_name) {
        if (opt_revert) {
            fpo = fopen(outfile_name, "r+b");
            if (!fpo) {
                fpo = fopen(outfile_name, "w+b");
                if (!fpo) {
                    perror(outfile_name);
                    return 2;
                }
            }
        } else {
            fpo = fopen(outfile_name, "wb");
            if (!fpo) {
                perror(outfile_name);
                return 2;
            }
        }
    }

    if (opt_seek_set && !opt_revert) {
        if (opt_seek_relative) {
            if (fseek(fp, opt_seek, SEEK_CUR) != 0) {
                fprintf(stderr, "%s: Sorry, cannot seek.\n", progname);
                return 0;
            }
        } else if (opt_seek_negative) {
            if (fseek(fp, opt_seek, SEEK_END) != 0) {
                fprintf(stderr, "%s: Sorry, cannot seek.\n", progname);
                return 0;
            }
        } else {
            if (fseek(fp, opt_seek, SEEK_SET) != 0) {
                fprintf(stderr, "%s: Sorry, cannot seek.\n", progname);
                return 0;
            }
        }
    }

    long display_offset = opt_offset;
    if (opt_seek_set && !opt_revert) {
        if (opt_seek_relative || opt_seek_negative) {
            long cur = ftell(fp);
            display_offset = opt_offset + cur;
        } else {
            display_offset = opt_offset + opt_seek;
        }
    }

    if (opt_revert) {
        if (opt_postscript) {
            reverse_postscript(fp, fpo);
        } else {
            reverse_hexdump(fp, fpo);
        }
    } else if (opt_postscript) {
        postscript_dump(fp, fpo);
    } else if (opt_c_include) {
        const char *fname = infile_name ? infile_name : "stdin";
        c_include_dump(fp, fpo, fname);
    } else if (opt_binary) {
        binary_dump(fp, fpo);
    } else {
        normal_hexdump(fp, fpo, display_offset);
    }

    if (fp != stdin) fclose(fp);
    if (fpo != stdout) fclose(fpo);

    return 0;
}
