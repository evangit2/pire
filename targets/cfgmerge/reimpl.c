#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_SECTIONS 256
#define MAX_KEYS 64
#define MAX_NAME 64    /* 0x40 */
#define MAX_VALUE 256  /* 0x100 */
#define LINE_BUF 324   /* 0x144 */

typedef struct {
    char name[MAX_NAME];
    int key_count;
    char keys[MAX_KEYS][MAX_NAME];
    char values[MAX_KEYS][MAX_VALUE];
} Section;

static Section sections[MAX_SECTIONS];
static int section_count;

/* Trim trailing whitespace from a string in-place */
static void trim_trailing(char *s) {
    int len = strlen(s);
    while (len > 0) {
        unsigned char c = (unsigned char)s[len - 1];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
            s[--len] = '\0';
        else
            break;
    }
}

/* Trim leading whitespace, returning pointer to first non-ws char */
static char *trim_leading(char *s) {
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r')
        s++;
    return s;
}

/* Parse config file. Returns 0 on success, -1 on error */
static int parse_config(const char *filename) {
    FILE *f = fopen(filename, "r");
    if (!f) {
        printf("ERROR: cannot open %s\r\n", filename);
        return -1;
    }

    section_count = 0;
    /* Initialize first section as "default" */
    memset(&sections[0], 0, sizeof(Section));
    strncpy(sections[0].name, "default", MAX_NAME - 1);
    sections[0].name[MAX_NAME - 1] = '\0';

    Section *cur = &sections[0];
    char line[LINE_BUF];

    while (fgets(line, LINE_BUF, f)) {
        trim_trailing(line);
        char *p = trim_leading(line);

        if (*p == '\0')
            continue;  /* empty line */
        if (*p == '#')
            continue;  /* comment */

        if (*p == '[') {
            /* Section header */
            char *end = strchr(p, ']');
            if (!end)
                continue;  /* malformed, skip */
            *end = '\0';
            char *name = p + 1;

            if (section_count > 0) {
                /* Create new section */
                section_count++;
                cur = &sections[section_count];
                memset(cur, 0, sizeof(Section));
                strncpy(cur->name, name, MAX_NAME - 1);
                cur->name[MAX_NAME - 1] = '\0';
            } else if (cur->key_count > 0) {
                /* Default section has keys, create new section */
                section_count++;
                cur = &sections[section_count];
                memset(cur, 0, sizeof(Section));
                strncpy(cur->name, name, MAX_NAME - 1);
                cur->name[MAX_NAME - 1] = '\0';
            } else {
                /* Reuse current (empty default) section */
                memset(cur, 0, sizeof(Section));
                strncpy(cur->name, name, MAX_NAME - 1);
                cur->name[MAX_NAME - 1] = '\0';
            }
        } else {
            /* Key=value line */
            char *eq = strchr(p, '=');
            if (!eq)
                continue;  /* no '=', skip */

            *eq = '\0';
            char *key = p;
            char *val = eq + 1;

            if (cur->key_count >= MAX_KEYS - 1)
                continue;  /* max keys reached */

            int idx = cur->key_count;
            strncpy(cur->keys[idx], key, MAX_NAME - 1);
            cur->keys[idx][MAX_NAME - 1] = '\0';
            strncpy(cur->values[idx], val, MAX_VALUE - 1);
            cur->values[idx][MAX_VALUE - 1] = '\0';
            cur->key_count++;
        }
    }

    section_count++;
    fclose(f);
    return 0;
}

/* count command */
static int cmd_count(const char *filename) {
    if (parse_config(filename) < 0)
        return 1;

    int total_keys = 0;
    for (int i = 0; i < section_count; i++) {
        printf("Section: %s (%d keys)\r\n", sections[i].name, sections[i].key_count);
        total_keys += sections[i].key_count;
    }
    printf("Total: %d sections, %d keys\r\n", section_count, total_keys);
    return 0;
}

/* get command */
static int cmd_get(const char *filename, const char *key) {
    if (parse_config(filename) < 0)
        return 1;

    for (int s = 0; s < section_count; s++) {
        for (int k = 0; k < sections[s].key_count; k++) {
            if (strcmp(sections[s].keys[k], key) == 0) {
                printf("%s\r\n", sections[s].values[k]);
                return 0;
            }
        }
    }

    printf("NOT FOUND\r\n");
    return 1;
}

/* set command */
static int cmd_set(const char *filename, const char *key, const char *value) {
    if (parse_config(filename) < 0)
        return 1;

    int found_s = -1, found_k = -1;
    for (int s = 0; s < section_count && found_s < 0; s++) {
        for (int k = 0; k < sections[s].key_count; k++) {
            if (strcmp(sections[s].keys[k], key) == 0) {
                found_s = s;
                found_k = k;
                break;
            }
        }
    }

    if (found_s < 0) {
        printf("NOT FOUND\r\n");
        return 1;
    }

    /* Update the value */
    strncpy(sections[found_s].values[found_k], value, MAX_VALUE - 1);
    sections[found_s].values[found_k][MAX_VALUE - 1] = '\0';

    /* Write back */
    FILE *f = fopen(filename, "w");
    if (!f) {
        printf("ERROR: cannot write %s\r\n", filename);
        return 1;
    }

    for (int s = 0; s < section_count; s++) {
        fprintf(f, "[%s]\r\n", sections[s].name);
        for (int k = 0; k < sections[s].key_count; k++) {
            fprintf(f, "%s=%s\r\n", sections[s].keys[k], sections[s].values[k]);
        }
    }

    fclose(f);
    printf("OK\r\n");
    return 0;
}

/* checksum command */
static int cmd_checksum(const char *filename) {
    if (parse_config(filename) < 0)
        return 1;

    unsigned int ecx = 0;
    unsigned int r8 = 0;

    for (int s = 0; s < section_count; s++) {
        for (int k = 0; k < sections[s].key_count; k++) {
            const char *key = sections[s].keys[k];
            const char *val = sections[s].values[k];

            /* XOR key chars */
            for (int i = 0; key[i]; i++)
                ecx ^= (unsigned char)key[i];

            /* XOR '=' */
            ecx ^= 0x3d;

            /* XOR value chars */
            for (int i = 0; val[i]; i++)
                ecx ^= (unsigned char)val[i];

            /* XOR newline */
            ecx ^= 0x0a;

            /* r8 += strlen(key) + strlen(val) + 2 */
            r8 += (unsigned int)strlen(key) + (unsigned int)strlen(val) + 2;
        }
    }

    unsigned int result = (ecx + r8) & 0xFF;
    printf("%02X\r\n", result);
    return 0;
}

int main(int argc, char **argv) {
    if (argc <= 2) {
        printf("Usage: cfgmerge <count|get|set|checksum> <file> [args...]\r\n");
        printf("  count <file>              \xe2\x80\x94 count sections and keys\r\n");
        printf("  get <file> <key>          \xe2\x80\x94 get value for key\r\n");
        printf("  set <file> <key> <value>  \xe2\x80\x94 set key value\r\n");
        printf("  checksum <file>           \xe2\x80\x94 compute config checksum\r\n");
        return 2;
    }

    const char *cmd = argv[1];
    const char *filename = argv[2];

    if (strcmp(cmd, "count") == 0) {
        return cmd_count(filename);
    } else if (strcmp(cmd, "get") == 0) {
        if (argc <= 3) {
            printf("ERROR: get requires a key\r\n");
            return 1;
        }
        return cmd_get(filename, argv[3]);
    } else if (strcmp(cmd, "set") == 0) {
        if (argc <= 4) {
            printf("ERROR: set requires key and value\r\n");
            return 1;
        }
        return cmd_set(filename, argv[3], argv[4]);
    } else if (strcmp(cmd, "checksum") == 0) {
        return cmd_checksum(filename);
    } else {
        printf("ERROR: unknown command '%s'\r\n", cmd);
        return 1;
    }
}
