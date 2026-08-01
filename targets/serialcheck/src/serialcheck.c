/*
 * serialcheck.exe — Windows license key validator
 *
 * Validates serial keys in format: XXXX-XXXX-XXXX-XXXX
 * Algorithm:
 *   1. Key must be 19 chars (4 groups of 4 hex digits, dash-separated)
 *   2. Group 1: XOR of all bytes must equal 0xA5
 *   3. Group 2: Sum of all bytes mod 256 must equal 0x3C
 *   4. Group 3: Must be the bitwise reverse of Group 1
 *   5. Group 4: CRC8 of groups 1-3 (concatenated) must equal last byte
 *
 * Exit codes: 0 = valid, 1 = invalid
 * Outputs: "VALID" or "INVALID: <reason>"
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* Bit-reverse a byte */
unsigned char bitrev(unsigned char b) {
    unsigned char r = 0;
    int i;
    for (i = 0; i < 8; i++) {
        r = (r << 1) | (b & 1);
        b >>= 1;
    }
    return r;
}

/* CRC8 computation (polynomial 0x07, init 0x00) */
unsigned char crc8(const unsigned char *data, int len) {
    unsigned char crc = 0x00;
    int i, j;
    for (i = 0; i < len; i++) {
        crc ^= data[i];
        for (j = 0; j < 8; j++) {
            if (crc & 0x80)
                crc = (crc << 1) ^ 0x07;
            else
                crc <<= 1;
        }
    }
    return crc;
}

/* Parse a hex character to its nibble value */
int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

/* Parse a 4-char hex group into 2 bytes */
int parse_group(const char *str, unsigned char *out) {
    int i;
    for (i = 0; i < 2; i++) {
        int hi = hexval(str[i * 2]);
        int lo = hexval(str[i * 2 + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 1;
}

int validate_key(const char *key) {
    /* Check length: 19 chars (4*4 + 3 dashes) */
    if (strlen(key) != 19) {
        printf("INVALID: wrong length\n");
        return 1;
    }

    /* Check dash positions */
    if (key[4] != '-' || key[9] != '-' || key[14] != '-') {
        printf("INVALID: bad format\n");
        return 1;
    }

    unsigned char g1[2], g2[2], g3[2], g4[2];

    /* Parse each group */
    if (!parse_group(key, g1)) {
        printf("INVALID: group 1 not hex\n");
        return 1;
    }
    if (!parse_group(key + 5, g2)) {
        printf("INVALID: group 2 not hex\n");
        return 1;
    }
    if (!parse_group(key + 10, g3)) {
        printf("INVALID: group 3 not hex\n");
        return 1;
    }
    if (!parse_group(key + 15, g4)) {
        printf("INVALID: group 4 not hex\n");
        return 1;
    }

    /* Check 1: XOR of group 1 bytes must be 0xA5 */
    if ((unsigned char)(g1[0] ^ g1[1]) != 0xA5) {
        printf("INVALID: group 1 checksum failed\n");
        return 1;
    }

    /* Check 2: Sum of group 2 bytes mod 256 must be 0x3C */
    if ((unsigned char)(g2[0] + g2[1]) != 0x3C) {
        printf("INVALID: group 2 checksum failed\n");
        return 1;
    }

    /* Check 3: Group 3 must be bit-reverse of group 1 */
    if (g3[0] != bitrev(g1[0]) || g3[1] != bitrev(g1[1])) {
        printf("INVALID: group 3 must be bitwise reverse of group 1\n");
        return 1;
    }

    /* Check 4: CRC8 of groups 1-3 must equal first byte of group 4 */
    unsigned char concat[6];
    memcpy(concat, g1, 2);
    memcpy(concat + 2, g2, 2);
    memcpy(concat + 4, g3, 2);

    unsigned char expected_crc = crc8(concat, 6);
    if (g4[0] != expected_crc) {
        printf("INVALID: CRC mismatch (expected %02X, got %02X)\n", expected_crc, g4[0]);
        return 1;
    }

    /* Check 5: Second byte of group 4 must be 0x00 */
    if (g4[1] != 0x00) {
        printf("INVALID: group 4 suffix must be 00\n");
        return 1;
    }

    printf("VALID\n");
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        printf("Usage: serialcheck <key>\n");
        printf("  key format: XXXX-XXXX-XXXX-XXXX\n");
        return 2;
    }

    /* Normalize: remove dashes if the user typed them differently */
    /* Actually, require exact format with dashes */
    return validate_key(argv[1]);
}

/* Entry point for Windows GUI subsystem — still console app */
