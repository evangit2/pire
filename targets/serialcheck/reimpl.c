#include <stdio.h>
#include <string.h>
#include <stdint.h>

static int parse_hex_byte(const char *s, unsigned char *out) {
    /* Parse 4 hex chars into 2 bytes. Returns 1 on success, 0 on failure. */
    unsigned char bytes[2];
    for (int i = 0; i < 2; i++) {
        char hi_char = s[i * 2];
        char lo_char = s[i * 2 + 1];
        int hi, lo;

        if (hi_char >= '0' && hi_char <= '9') hi = hi_char - '0';
        else if (hi_char >= 'A' && hi_char <= 'F') hi = hi_char - 'A' + 10;
        else if (hi_char >= 'a' && hi_char <= 'f') hi = hi_char - 'a' + 10;
        else return 0;

        if (lo_char >= '0' && lo_char <= '9') lo = lo_char - '0';
        else if (lo_char >= 'A' && lo_char <= 'F') lo = lo_char - 'A' + 10;
        else if (lo_char >= 'a' && lo_char <= 'f') lo = lo_char - 'a' + 10;
        else return 0;

        bytes[i] = (unsigned char)((hi << 4) | lo);
    }
    out[0] = bytes[0];
    out[1] = bytes[1];
    return 1;
}

static unsigned char bit_reverse(unsigned char b) {
    unsigned char result = 0;
    for (int i = 0; i < 8; i++) {
        result = (unsigned char)((result << 1) | (b & 1));
        b >>= 1;
    }
    return result;
}

static unsigned char crc8(const unsigned char *data, int len) {
    unsigned char crc = 0;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 0x80)
                crc = (unsigned char)((crc << 1) ^ 0x07);
            else
                crc = (unsigned char)(crc << 1);
        }
    }
    return crc;
}

static void print_msg(const char *msg) {
    printf("%s\n", msg);
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        print_msg("Usage: serialcheck <key>");
        print_msg("  key format: XXXX-XXXX-XXXX-XXXX");
        return 2;
    }

    const char *key = argv[1];

    /* Check length */
    if (strlen(key) != 19) {
        print_msg("INVALID: wrong length");
        return 1;
    }

    /* Check format: dashes at positions 4, 9, 14 */
    if (key[4] != '-' || key[9] != '-' || key[14] != '-') {
        print_msg("INVALID: bad format");
        return 1;
    }

    /* Parse 4 groups of hex */
    unsigned char g1[2], g2[2], g3[2], g4[2];

    if (!parse_hex_byte(key, g1)) {
        print_msg("INVALID: group 1 not hex");
        return 1;
    }
    if (!parse_hex_byte(key + 5, g2)) {
        print_msg("INVALID: group 2 not hex");
        return 1;
    }
    if (!parse_hex_byte(key + 10, g3)) {
        print_msg("INVALID: group 3 not hex");
        return 1;
    }
    if (!parse_hex_byte(key + 15, g4)) {
        print_msg("INVALID: group 4 not hex");
        return 1;
    }

    /* Group 1 checksum: XOR must be 0xA5 */
    if ((unsigned char)(g1[0] ^ g1[1]) != 0xA5) {
        print_msg("INVALID: group 1 checksum failed");
        return 1;
    }

    /* Group 2 checksum: sum must be 0x3C */
    if ((unsigned char)(g2[0] + g2[1]) != 0x3C) {
        print_msg("INVALID: group 2 checksum failed");
        return 1;
    }

    /* Group 3 must be bitwise reverse of group 1 */
    if (g3[0] != bit_reverse(g1[0]) || g3[1] != bit_reverse(g1[1])) {
        print_msg("INVALID: group 3 must be bitwise reverse of group 1");
        return 1;
    }

    /* CRC check: CRC8 over 6 bytes must equal g4[0] */
    unsigned char data[6] = {g1[0], g1[1], g2[0], g2[1], g3[0], g3[1]};
    unsigned char crc = crc8(data, 6);
    if (crc != g4[0]) {
        printf("INVALID: CRC mismatch (expected %02X, got %02X)\n", crc, g4[0]);
        return 1;
    }

    /* Group 4 suffix must be 0x00 */
    if (g4[1] != 0x00) {
        print_msg("INVALID: group 4 suffix must be 00");
        return 1;
    }

    print_msg("VALID");
    return 0;
}
