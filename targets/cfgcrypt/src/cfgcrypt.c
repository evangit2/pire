/*
 * cfgcrypt.exe — Windows config file encryptor/decryptor
 *
 * Usage: cfgcrypt <mode> <infile> <outfile> <password>
 *   mode: encrypt | decrypt
 *
 * Algorithm:
 *   - XOR stream cipher with rolling key derived from password
 *   - Key schedule: SHA-256-like mixing of password into 256-byte state
 *   - Encryption: XOR each byte with state[byte_index % 256]
 *   - State advances: state[i] = (state[i] * 31 + i + 7) & 0xFF after each block
 *   - File format: 4-byte magic "CFGX" + 4-byte length + encrypted data
 *   - Decrypt: reverse the process, verify magic
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* "SHA-256-like" key mixing — not real SHA-256, just a custom hash */
void mix_key(const char *password, unsigned char state[256]) {
    /* Initialize state with password bytes */
    memset(state, 0, 256);
    int plen = strlen(password);
    for (int i = 0; i < 256; i++) {
        state[i] = (unsigned char)(password[i % plen] ^ (i * 17 + 3));
    }

    /* Mix: 16 rounds of shuffling */
    unsigned char tmp[256];
    for (int round = 0; round < 16; round++) {
        for (int i = 0; i < 256; i++) {
            int j = (i * 31 + round * 7 + state[(i + 1) % 256]) % 256;
            tmp[i] = state[j];
        }
        for (int i = 0; i < 256; i++) {
            state[i] = (unsigned char)(tmp[i] ^ (i * 13 + round));
        }
    }
}

void advance_state(unsigned char state[256]) {
    for (int i = 0; i < 256; i++) {
        state[i] = (unsigned char)((state[i] * 31 + i + 7) & 0xFF);
    }
}

int encrypt_file(const char *infile, const char *outfile, const char *password) {
    FILE *in = fopen(infile, "rb");
    if (!in) {
        printf("ERROR: cannot open input file\n");
        return 1;
    }

    /* Read input */
    fseek(in, 0, SEEK_END);
    long size = ftell(in);
    fseek(in, 0, SEEK_SET);

    unsigned char *data = malloc(size);
    if (!data) {
        fclose(in);
        printf("ERROR: out of memory\n");
        return 1;
    }
    fread(data, 1, size, in);
    fclose(in);

    /* Encrypt */
    unsigned char state[256];
    mix_key(password, state);

    for (long i = 0; i < size; i++) {
        data[i] ^= state[i % 256];
        if (i > 0 && i % 256 == 0) advance_state(state);
    }

    /* Write output */
    FILE *out = fopen(outfile, "wb");
    if (!out) {
        free(data);
        printf("ERROR: cannot open output file\n");
        return 1;
    }

    /* Header: "CFGX" + 4-byte little-endian length */
    fwrite("CFGX", 1, 4, out);
    unsigned char len_bytes[4] = {
        (unsigned char)(size & 0xFF),
        (unsigned char)((size >> 8) & 0xFF),
        (unsigned char)((size >> 16) & 0xFF),
        (unsigned char)((size >> 24) & 0xFF),
    };
    fwrite(len_bytes, 1, 4, out);
    fwrite(data, 1, size, out);
    fclose(out);
    free(data);

    printf("Encrypted %ld bytes → %s\n", size, outfile);
    return 0;
}

int decrypt_file(const char *infile, const char *outfile, const char *password) {
    FILE *in = fopen(infile, "rb");
    if (!in) {
        printf("ERROR: cannot open input file\n");
        return 1;
    }

    /* Read header */
    char magic[4];
    fread(magic, 1, 4, in);
    if (memcmp(magic, "CFGX", 4) != 0) {
        fclose(in);
        printf("ERROR: bad magic (not a CFGX file)\n");
        return 1;
    }

    unsigned char len_bytes[4];
    fread(len_bytes, 1, 4, in);
    long size = len_bytes[0] | (len_bytes[1] << 8) | (len_bytes[2] << 16) | ((long)len_bytes[3] << 24);

    unsigned char *data = malloc(size);
    if (!data) {
        fclose(in);
        printf("ERROR: out of memory\n");
        return 1;
    }
    fread(data, 1, size, in);
    fclose(in);

    /* Decrypt (same XOR process) */
    unsigned char state[256];
    mix_key(password, state);

    for (long i = 0; i < size; i++) {
        data[i] ^= state[i % 256];
        if (i > 0 && i % 256 == 0) advance_state(state);
    }

    /* Write output */
    FILE *out = fopen(outfile, "wb");
    if (!out) {
        free(data);
        printf("ERROR: cannot open output file\n");
        return 1;
    }
    fwrite(data, 1, size, out);
    fclose(out);
    free(data);

    printf("Decrypted %ld bytes → %s\n", size, outfile);
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc != 5) {
        printf("Usage: cfgcrypt <encrypt|decrypt> <infile> <outfile> <password>\n");
        return 2;
    }

    if (strcmp(argv[1], "encrypt") == 0) {
        return encrypt_file(argv[2], argv[3], argv[4]);
    } else if (strcmp(argv[1], "decrypt") == 0) {
        return decrypt_file(argv[2], argv[3], argv[4]);
    } else {
        printf("ERROR: unknown mode '%s' (use encrypt or decrypt)\n", argv[1]);
        return 1;
    }
}
