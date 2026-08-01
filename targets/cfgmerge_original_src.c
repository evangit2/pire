/*
 * cfgmerge.exe — Windows config file merger/checker
 *
 * Usage: cfgmerge <command> <file> [args...]
 *   count <file>              — count [section]s and keys
 *   get <file> <key>          — get value for a key
 *   set <file> <key> <value>  — set a key value
 *   checksum <file>           — compute config checksum
 *
 * Config format:
 *   [section]
 *   key=value
 *   # comment
 *
 * Checksum: XOR all key+value bytes, then add length mod 256
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define MAX_LINES 256
#define MAX_KEY 64
#define MAX_VAL 256
#define MAX_LINE (MAX_KEY + MAX_VAL + 4)

typedef struct {
    char key[MAX_KEY];
    char value[MAX_VAL];
} Entry;

typedef struct {
    char section[64];
    Entry entries[64];
    int count;
} Section;

static Section sections[32];
static int section_count = 0;

void trim(char *s) {
    int len = strlen(s);
    while (len > 0 && (s[len-1] == '\n' || s[len-1] == '\r' || s[len-1] == ' ' || s[len-1] == '\t')) {
        s[--len] = '\0';
    }
    int start = 0;
    while (s[start] == ' ' || s[start] == '\t') start++;
    if (start > 0) memmove(s, s + start, len - start + 1);
}

int parse_config(const char *filename) {
    FILE *f = fopen(filename, "r");
    if (!f) {
        printf("ERROR: cannot open %s\n", filename);
        return -1;
    }

    section_count = 0;
    Section *cur = &sections[0];
    strcpy(cur->section, "default");
    cur->count = 0;

    char line[MAX_LINE];
    while (fgets(line, sizeof(line), f)) {
        trim(line);
        if (line[0] == '\0' || line[0] == '#') continue;

        if (line[0] == '[') {
            char *end = strchr(line, ']');
            if (!end) continue;
            *end = '\0';
            if (section_count > 0 || cur->count > 0) {
                section_count++;
                cur = &sections[section_count];
                cur->count = 0;
            }
            strncpy(cur->section, line + 1, 63);
            cur->section[63] = '\0';
            continue;
        }

        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = '\0';
        char *key = line;
        char *val = eq + 1;

        if (cur->count < 64) {
            strncpy(cur->entries[cur->count].key, key, MAX_KEY - 1);
            cur->entries[cur->count].key[MAX_KEY - 1] = '\0';
            strncpy(cur->entries[cur->count].value, val, MAX_VAL - 1);
            cur->entries[cur->count].value[MAX_VAL - 1] = '\0';
            cur->count++;
        }
    }

    section_count++;
    fclose(f);
    return 0;
}

int cmd_count(const char *file) {
    if (parse_config(file) < 0) return 1;
    int total_keys = 0;
    for (int i = 0; i < section_count; i++) {
        printf("Section: %s (%d keys)\n", sections[i].section, sections[i].count);
        total_keys += sections[i].count;
    }
    printf("Total: %d sections, %d keys\n", section_count, total_keys);
    return 0;
}

int cmd_get(const char *file, const char *key) {
    if (parse_config(file) < 0) return 1;
    for (int i = 0; i < section_count; i++) {
        for (int j = 0; j < sections[i].count; j++) {
            if (strcmp(sections[i].entries[j].key, key) == 0) {
                printf("%s\n", sections[i].entries[j].value);
                return 0;
            }
        }
    }
    printf("NOT FOUND\n");
    return 1;
}

int cmd_set(const char *file, const char *key, const char *value) {
    if (parse_config(file) < 0) return 1;
    int found = 0;
    for (int i = 0; i < section_count && !found; i++) {
        for (int j = 0; j < sections[i].count; j++) {
            if (strcmp(sections[i].entries[j].key, key) == 0) {
                strncpy(sections[i].entries[j].value, value, MAX_VAL - 1);
                sections[i].entries[j].value[MAX_VAL - 1] = '\0';
                found = 1;
                break;
            }
        }
    }
    if (!found) {
        printf("NOT FOUND\n");
        return 1;
    }
    /* Rewrite file */
    FILE *f = fopen(file, "w");
    if (!f) {
        printf("ERROR: cannot write %s\n", file);
        return 1;
    }
    for (int i = 0; i < section_count; i++) {
        fprintf(f, "[%s]\n", sections[i].section);
        for (int j = 0; j < sections[i].count; j++) {
            fprintf(f, "%s=%s\n", sections[i].entries[j].key, sections[i].entries[j].value);
        }
    }
    fclose(f);
    printf("OK\n");
    return 0;
}

int cmd_checksum(const char *file) {
    if (parse_config(file) < 0) return 1;
    unsigned char cs = 0;
    int total_len = 0;
    for (int i = 0; i < section_count; i++) {
        for (int j = 0; j < sections[i].count; j++) {
            const char *k = sections[i].entries[j].key;
            const char *v = sections[i].entries[j].value;
            for (int c = 0; k[c]; c++) { cs ^= k[c]; total_len++; }
            cs ^= '=';
            total_len++;
            for (int c = 0; v[c]; c++) { cs ^= v[c]; total_len++; }
            cs ^= '\n';
            total_len++;
        }
    }
    cs = (unsigned char)((cs + total_len) & 0xFF);
    printf("%02X\n", cs);
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        printf("Usage: cfgmerge <count|get|set|checksum> <file> [args...]\n");
        printf("  count <file>              — count sections and keys\n");
        printf("  get <file> <key>          — get value for key\n");
        printf("  set <file> <key> <value>  — set key value\n");
        printf("  checksum <file>           — compute config checksum\n");
        return 2;
    }

    const char *cmd = argv[1];
    const char *file = argv[2];

    if (strcmp(cmd, "count") == 0) {
        return cmd_count(file);
    } else if (strcmp(cmd, "get") == 0) {
        if (argc < 4) { printf("ERROR: get requires a key\n"); return 1; }
        return cmd_get(file, argv[3]);
    } else if (strcmp(cmd, "set") == 0) {
        if (argc < 5) { printf("ERROR: set requires key and value\n"); return 1; }
        return cmd_set(file, argv[3], argv[4]);
    } else if (strcmp(cmd, "checksum") == 0) {
        return cmd_checksum(file);
    } else {
        printf("ERROR: unknown command '%s'\n", cmd);
        return 1;
    }
}
