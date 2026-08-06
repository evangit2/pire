/*
 * CurrPorts v2.80 - Reconstructed Source Code
 * Originally by Nir Sofer (https://www.nirsoft.net)
 * Reverse-engineered from cports.exe PE64 binary
 *
 * This is a reconstruction of the CurrPorts network port monitoring tool.
 * It displays all currently opened TCP/IP and UDP ports on the local computer.
 */

#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shellapi.h>
#include <winver.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "version.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "psapi.lib")

#define MAX_COLUMNS 30
#define MAX_PORT_ENTRIES 10000
#define WM_REFRESH (WM_USER + 0x15)
#define IDT_TIMER 0x1001

/* ===== Data Structures ===== */

typedef struct {
    DWORD localAddr;
    DWORD localPort;
    DWORD remoteAddr;
    DWORD remotePort;
    DWORD pid;
    DWORD protocol;     /* 1=TCP, 2=UDP, 0x17=TCP6, 0x18=UDP6 */
    BYTE localAddr6[16];
    BYTE remoteAddr6[16];
    DWORD owningPid;
    DWORD createTime;
    char moduleName[MAX_PATH];
} PORT_ENTRY;

typedef struct {
    PORT_ENTRY *entries;
    int count;
    int capacity;
} PORT_LIST;

typedef struct {
    char **strings;
    int *ids;
    int count;
    int capacity;
} STRING_TABLE;

typedef struct {
    void **items;
    int *ids;
    int count;
    int capacity;
} STRING_CACHE;

/* Column definitions */
enum {
    COL_PROTOCOL = 0,
    COL_LOCAL_ADDR,
    COL_LOCAL_PORT,
    COL_REMOTE_ADDR,
    COL_REMOTE_PORT,
    COL_STATE,
    COL_PROCESS_NAME,
    COL_PROCESS_PID,
    COL_PROCESS_PATH,
    COL_PROCESS_PRODUCT,
    COL_PROCESS_DESC,
    COL_PROCESS_COMPANY,
    COL_PROCESS_CMDLINE,
    COL_CREATED_ON,
    COL_MODIFIED_ON,
    COL_USER,
    COL_SERVICE_NAME,
    COL_SERVICE_DESC,
    COL_SERVICE_DISPLAY,
    COL_PROCESS_FILE,
    COL_REMOTE_HOSTNAME,
    COL_COUNTRY,
    COL_CITY,
    COL_ASN,
    COL_MAX
};

/* Column info structure */
typedef struct {
    char name[64];
    int width;
    BOOL visible;
    DWORD format;
} COLUMN_INFO;

/* Application state */
typedef struct {
    HINSTANCE hInstance;
    HWND hWnd;
    HWND hToolbar;
    HWND hStatusBar;
    HWND hList;
    HMENU hMenu;
    HACCEL hAccel;
    HIMAGELIST hImageList;
    HICON hIcon;
    char appName[64];
    char modulePath[MAX_PATH];
    char iniFile[MAX_PATH];
    char langFile[MAX_PATH];
    char filterFile[MAX_PATH];
    
    PORT_LIST portList;
    COLUMN_INFO columns[COL_MAX];
    int sortColumn;
    BOOL sortReverse;
    BOOL autoRefresh;
    int refreshInterval;
    BOOL markSuspicious;
    BOOL showOnlyTCP;
    BOOL showOnlyIncoming;
    
    OSVERSIONINFO osvi;
    BOOL isWin2K;
    BOOL isXP;
    
    /* API function pointers */
    FARPROC pGetExtendedTcpTable;
    FARPROC pGetExtendedUdpTable;
    FARPROC pAllocateAndGetTcpExTableFromStack;
    FARPROC pAllocateAndGetUdpExTableFromStack;
    FARPROC pSetTcpEntry;
    FARPROC pGetTcpTable;
    FARPROC pGetUdpTable;
    FARPROC pNtQuerySystemInformation;
    FARPROC pRtlInitUnicodeString;
    FARPROC pZwOpenSection;
    FARPROC pZwOpenFile;
    
    HMODULE hIphlpapi;
    HMODULE hNtdll;
    HMODULE hPsapi;
    HMODULE hKernel32;
    
    BOOL useExtendedApi;
    BOOL usePsapi;
    BOOL useToolhelp;
    
    /* Tray icon */
    NOTIFYICONDATA trayIcon;
    BOOL trayAdded;
    BOOL minimizeToTray;
    
    /* String table */
    char **strings;
    int stringCount;
    HMODULE hResDll;
    char langIniFile[MAX_PATH];
    BOOL rtl;
} APP_STATE;

APP_STATE g_app;

/* ===== Utility Functions ===== */

static void GetModuleDir(char *path, int maxLen) {
    GetModuleFileNameA(NULL, path, maxLen);
    char *p = strrchr(path, '\\');
    if (p) *p = '\0';
}

static void AddTrailingSlash(char *path) {
    size_t len = strlen(path);
    if (len > 0 && path[len - 1] != '\\')
        strcat(path, "\\");
}

static void ShowErrorMessage(HWND hWnd, DWORD error) {
    char errorMsg[1024];
    char fullMsg[2048];
    HMODULE hNetMsg = NULL;
    DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM;
    
    if (error >= 0x834 && error < 0x834 + 900) {
        hNetMsg = LoadLibraryExA("netmsg.dll", NULL, DONT_RESOLVE_DLL_REFERENCES);
        if (hNetMsg) flags = FORMAT_MESSAGE_FROM_HMODULE | FORMAT_MESSAGE_FROM_SYSTEM;
        else flags |= FORMAT_MESSAGE_FROM_SYSTEM;
    } else {
        flags |= FORMAT_MESSAGE_FROM_SYSTEM;
    }
    
    flags |= FORMAT_MESSAGE_ALLOCATE_BUFFER;
    
    char *lpMsgBuf = NULL;
    DWORD result = FormatMessageA(flags, hNetMsg, error, 
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        (LPSTR)&lpMsgBuf, 0, NULL);
    
    if (result == 0) {
        strcpy(errorMsg, "Unknown Error");
    } else {
        strncpy(errorMsg, lpMsgBuf, sizeof(errorMsg) - 1);
        errorMsg[sizeof(errorMsg) - 1] = '\0';
        LocalFree(lpMsgBuf);
    }
    if (hNetMsg) FreeLibrary(hNetMsg);
    
    sprintf(fullMsg, "Error %d: %s", error, errorMsg);
    MessageBoxA(hWnd, fullMsg, "Error", MB_ICONERROR);
}

static HANDLE OpenFileForRead(LPCSTR path) {
    return CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
}

static HANDLE OpenFileForWrite(LPCSTR path) {
    return CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, 0, NULL);
}

static void WriteToFile(HANDLE hFile, const char *data) {
    DWORD written;
    WriteFile(hFile, data, (DWORD)strlen(data), &written, NULL);
}

static int FindStringInArgs(void *cmdArgs, const char *str) {
    /* Search command-line args for a parameter */
    int *args = (int *)cmdArgs;
    int count = args[0x12]; /* argc stored at offset 0x12 */
    char **argv = (char **)args[1]; /* argv at offset 1 */
    for (int i = 0; i < count; i++) {
        if (_strcmpi(str, argv[i]) == 0)
            return i;
    }
    return -1;
}

static int FindStrNoCase(const char *haystack, const char *needle) {
    int needleLen = (int)strlen(needle);
    int hayLen = (int)strlen(haystack);
    if (needleLen > hayLen) return -1;
    for (int i = 0; i <= hayLen - needleLen; i++) {
        if (_memicmp(haystack + i, needle, needleLen) == 0)
            return i;
    }
    return -1;
}

static DWORD GetTickCount64Safe(void) {
    static FARPROC pGetTickCount64 = NULL;
    static BOOL initialized = FALSE;
    if (!initialized) {
        HMODULE hKernel = GetModuleHandleA("kernel32.dll");
        if (hKernel) pGetTickCount64 = GetProcAddress(hKernel, "GetTickCount64");
        initialized = TRUE;
    }
    if (pGetTickCount64)
        return (DWORD)((ULONGLONG (*)(void))pGetTickCount64)();
    return GetTickCount();
}

/* ===== String Table Functions ===== */

static void InitStringTable(void) {
    if (g_app.strings == NULL) {
        g_app.stringCount = 0;
        g_app.strings = (char **)malloc(sizeof(char *) * 256);
        memset(g_app.strings, 0, sizeof(char *) * 256);
    }
}

static const char *LoadStringRes(UINT uID) {
    static char buf[4096];
    HINSTANCE hInst = g_app.hResDll ? g_app.hResDll : g_app.hInstance;
    
    if (g_app.langIniFile[0]) {
        /* Try loading from language ini file */
        char idStr[16];
        _itoa(uID, idStr, 10);
        char section[] = "strings";
        buf[0] = '\0';
        GetPrivateProfileStringA(section, idStr, "", buf, sizeof(buf), g_app.langIniFile);
        if (buf[0]) return buf;
    }
    
    /* Load from resource */
    if (LoadStringA(hInst, uID, buf, sizeof(buf)) > 0)
        return buf;
    return "";
}

/* ===== Dynamic API Loading ===== */

static void InitToolhelpApi(void) {
    if (g_app.useToolhelp) return;
    HMODULE hKernel = GetModuleHandleA("kernel32.dll");
    if (!hKernel) return;
    
    FARPROC p1 = GetProcAddress(hKernel, "CreateToolhelp32Snapshot");
    FARPROC p2 = GetProcAddress(hKernel, "Module32First");
    FARPROC p3 = GetProcAddress(hKernel, "Module32Next");
    FARPROC p4 = GetProcAddress(hKernel, "Process32First");
    FARPROC p5 = GetProcAddress(hKernel, "Process32Next");
    
    if (p1 && p2 && p3 && p4 && p5) {
        g_app.useToolhelp = TRUE;
    }
}

static void InitPsapiApi(void) {
    if (g_app.usePsapi) return;
    char sysDir[MAX_PATH];
    GetSystemDirectoryA(sysDir, MAX_PATH);
    AddTrailingSlash(sysDir);
    strcat(sysDir, "psapi.dll");
    HMODULE hPsapi = LoadLibraryA(sysDir);
    if (!hPsapi) hPsapi = LoadLibraryA("psapi.dll");
    if (!hPsapi) return;
    
    FARPROC p1 = GetProcAddress(hPsapi, "GetModuleBaseNameA");
    FARPROC p2 = GetProcAddress(hPsapi, "EnumProcessModules");
    FARPROC p3 = GetProcAddress(hPsapi, "GetModuleFileNameExA");
    FARPROC p4 = GetProcAddress(hPsapi, "EnumProcesses");
    FARPROC p5 = GetProcAddress(hPsapi, "GetModuleInformation");
    
    if (p1 && p2 && p3 && p4 && p5) {
        g_app.hPsapi = hPsapi;
        g_app.usePsapi = TRUE;
    } else {
        FreeLibrary(hPsapi);
    }
}

static void InitNetworkApi(void) {
    if (g_app.hIphlpapi) return;
    char sysDir[MAX_PATH];
    GetSystemDirectoryA(sysDir, MAX_PATH);
    AddTrailingSlash(sysDir);
    strcat(sysDir, "iphlpapi.dll");
    HMODULE hIp = LoadLibraryA(sysDir);
    if (!hIp) hIp = LoadLibraryA("iphlpapi.dll");
    if (!hIp) return;
    
    g_app.hIphlpapi = hIp;
    g_app.pGetTcpTable = GetProcAddress(hIp, "GetTcpTable");
    g_app.pGetUdpTable = GetProcAddress(hIp, "GetUdpTable");
    g_app.pSetTcpEntry = GetProcAddress(hIp, "SetTcpEntry");
    g_app.pAllocateAndGetTcpExTableFromStack = GetProcAddress(hIp, "AllocateAndGetTcpExTableFromStack");
    g_app.pAllocateAndGetUdpExTableFromStack = GetProcAddress(hIp, "AllocateAndGetUdpExTableFromStack");
    g_app.pGetExtendedTcpTable = GetProcAddress(hIp, "GetExtendedTcpTable");
    g_app.pGetExtendedUdpTable = GetProcAddress(hIp, "GetExtendedUdpTable");
}

/* ===== Port Enumeration ===== */

static BOOL GetProcessPath(DWORD pid, char *path, int maxLen) {
    path[0] = '\0';
    
    if (g_app.osvi.dwPlatformId == VER_PLATFORM_WIN32_NT) {
        if (!g_app.usePsapi) return FALSE;
        
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
        if (!hProcess) {
            if (g_app.osvi.dwMajorVersion >= 6) {
                hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
                if (!hProcess) return FALSE;
            } else {
                return FALSE;
            }
        }
        
        HMODULE hMod;
        DWORD cbNeeded;
        if (EnumProcessModules(hProcess, &hMod, sizeof(hMod), &cbNeeded)) {
            GetModuleFileNameExA(hProcess, hMod, path, maxLen);
            CloseHandle(hProcess);
            return TRUE;
        }
        
        /* Try QueryFullProcessImageName */
        static FARPROC pQueryFull = NULL;
        static BOOL init = FALSE;
        if (!init) {
            HMODULE hKernel = GetModuleHandleA("kernel32.dll");
            if (hKernel) pQueryFull = GetProcAddress(hKernel, "QueryFullProcessImageNameA");
            init = TRUE;
        }
        if (pQueryFull) {
            DWORD size = maxLen;
            if (pQueryFull(hProcess, 0, path, &size)) {
                CloseHandle(hProcess);
                return TRUE;
            }
        }
        CloseHandle(hProcess);
    } else {
        if (!g_app.useToolhelp) return FALSE;
        HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hSnap == INVALID_HANDLE_VALUE) return FALSE;
        
        PROCESSENTRY32 pe32;
        pe32.dwSize = sizeof(pe32);
        if (Process32First(hSnap, &pe32)) {
            do {
                if (pe32.th32ProcessID == pid) {
                    strcpy(path, pe32.szExeFile);
                    CloseHandle(hSnap);
                    return TRUE;
                }
            } while (Process32Next(hSnap, &pe32));
        }
        CloseHandle(hSnap);
    }
    return FALSE;
}

static void EnumeratePorts(void) {
    if (!g_app.hIphlpapi) InitNetworkApi();
    if (!g_app.hIphlpapi) return;
    
    /* Free previous entries */
    if (g_app.portList.entries) {
        free(g_app.portList.entries);
        g_app.portList.entries = NULL;
        g_app.portList.count = 0;
        g_app.portList.capacity = 0;
    }
    
    g_app.portList.capacity = 1024;
    g_app.portList.entries = (PORT_ENTRY *)calloc(g_app.portList.capacity, sizeof(PORT_ENTRY));
    g_app.portList.count = 0;
    
    DWORD dwSize = 0;
    
    /* Get TCP table (IPv4) */
    if (g_app.pGetExtendedTcpTable) {
        dwSize = 0;
        if (g_app.pGetExtendedTcpTable(NULL, &dwSize, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == ERROR_INSUFFICIENT_BUFFER) {
            MIB_TCPTABLE_OWNER_PID *pTcpTable = (MIB_TCPTABLE_OWNER_PID *)malloc(dwSize);
            if (pTcpTable) {
                if (g_app.pGetExtendedTcpTable(pTcpTable, &dwSize, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == NO_ERROR) {
                    for (DWORD i = 0; i < pTcpTable->dwNumEntries; i++) {
                        if (g_app.portList.count >= g_app.portList.capacity) {
                            g_app.portList.capacity *= 2;
                            g_app.portList.entries = (PORT_ENTRY *)realloc(g_app.portList.entries, 
                                g_app.portList.capacity * sizeof(PORT_ENTRY));
                        }
                        PORT_ENTRY *e = &g_app.portList.entries[g_app.portList.count];
                        memset(e, 0, sizeof(PORT_ENTRY));
                        e->localAddr = pTcpTable->table[i].dwLocalAddr;
                        e->localPort = pTcpTable->table[i].dwLocalPort;
                        e->remoteAddr = pTcpTable->table[i].dwRemoteAddr;
                        e->remotePort = pTcpTable->table[i].dwRemotePort;
                        e->pid = pTcpTable->table[i].dwOwningPid;
                        e->protocol = 1; /* TCP */
                        GetProcessPath(e->pid, e->moduleName, MAX_PATH);
                        g_app.portList.count++;
                    }
                }
                free(pTcpTable);
            }
        }
    }
    
    /* Get UDP table (IPv4) */
    if (g_app.pGetExtendedUdpTable) {
        dwSize = 0;
        if (g_app.pGetExtendedUdpTable(NULL, &dwSize, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0) == ERROR_INSUFFICIENT_BUFFER) {
            MIB_UDPTABLE_OWNER_PID *pUdpTable = (MIB_UDPTABLE_OWNER_PID *)malloc(dwSize);
            if (pUdpTable) {
                if (g_app.pGetExtendedUdpTable(pUdpTable, &dwSize, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0) == NO_ERROR) {
                    for (DWORD i = 0; i < pUdpTable->dwNumEntries; i++) {
                        if (g_app.portList.count >= g_app.portList.capacity) {
                            g_app.portList.capacity *= 2;
                            g_app.portList.entries = (PORT_ENTRY *)realloc(g_app.portList.entries, 
                                g_app.portList.capacity * sizeof(PORT_ENTRY));
                        }
                        PORT_ENTRY *e = &g_app.portList.entries[g_app.portList.count];
                        memset(e, 0, sizeof(PORT_ENTRY));
                        e->localAddr = pUdpTable->table[i].dwLocalAddr;
                        e->localPort = pUdpTable->table[i].dwLocalPort;
                        e->pid = pUdpTable->table[i].dwOwningPid;
                        e->protocol = 2; /* UDP */
                        GetProcessPath(e->pid, e->moduleName, MAX_PATH);
                        g_app.portList.count++;
                    }
                }
                free(pUdpTable);
            }
        }
    }
    
    /* Get TCP6 table */
    if (g_app.pGetExtendedTcpTable) {
        dwSize = 0;
        if (g_app.pGetExtendedTcpTable(NULL, &dwSize, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0) == ERROR_INSUFFICIENT_BUFFER) {
            MIB_TCP6TABLE_OWNER_PID *pTcp6Table = (MIB_TCP6TABLE_OWNER_PID *)malloc(dwSize);
            if (pTcp6Table) {
                if (g_app.pGetExtendedTcpTable(pTcp6Table, &dwSize, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0) == NO_ERROR) {
                    for (DWORD i = 0; i < pTcp6Table->dwNumEntries; i++) {
                        if (g_app.portList.count >= g_app.portList.capacity) {
                            g_app.portList.capacity *= 2;
                            g_app.portList.entries = (PORT_ENTRY *)realloc(g_app.portList.entries, 
                                g_app.portList.capacity * sizeof(PORT_ENTRY));
                        }
                        PORT_ENTRY *e = &g_app.portList.entries[g_app.portList.count];
                        memset(e, 0, sizeof(PORT_ENTRY));
                        memcpy(e->localAddr6, pTcp6Table->table[i].ucLocalAddr, 16);
                        e->localPort = pTcp6Table->table[i].dwLocalPort;
                        memcpy(e->remoteAddr6, pTcp6Table->table[i].ucRemoteAddr, 16);
                        e->remotePort = pTcp6Table->table[i].dwRemotePort;
                        e->pid = pTcp6Table->table[i].dwOwningPid;
                        e->protocol = 0x17; /* TCP6 */
                        GetProcessPath(e->pid, e->moduleName, MAX_PATH);
                        g_app.portList.count++;
                    }
                }
                free(pTcp6Table);
            }
        }
    }
    
    /* Get UDP6 table */
    if (g_app.pGetExtendedUdpTable) {
        dwSize = 0;
        if (g_app.pGetExtendedUdpTable(NULL, &dwSize, FALSE, AF_INET6, UDP_TABLE_OWNER_PID, 0) == ERROR_INSUFFICIENT_BUFFER) {
            MIB_UDP6TABLE_OWNER_PID *pUdp6Table = (MIB_UDP6TABLE_OWNER_PID *)malloc(dwSize);
            if (pUdp6Table) {
                if (g_app.pGetExtendedUdpTable(pUdp6Table, &dwSize, FALSE, AF_INET6, UDP_TABLE_OWNER_PID, 0) == NO_ERROR) {
                    for (DWORD i = 0; i < pUdp6Table->dwNumEntries; i++) {
                        if (g_app.portList.count >= g_app.portList.capacity) {
                            g_app.portList.capacity *= 2;
                            g_app.portList.entries = (PORT_ENTRY *)realloc(g_app.portList.entries, 
                                g_app.portList.capacity * sizeof(PORT_ENTRY));
                        }
                        PORT_ENTRY *e = &g_app.portList.entries[g_app.portList.count];
                        memset(e, 0, sizeof(PORT_ENTRY));
                        memcpy(e->localAddr6, pUdp6Table->table[i].ucLocalAddr, 16);
                        e->localPort = pUdp6Table->table[i].dwLocalPort;
                        e->pid = pUdp6Table->table[i].dwOwningPid;
                        e->protocol = 0x18; /* UDP6 */
                        GetProcessPath(e->pid, e->moduleName, MAX_PATH);
                        g_app.portList.count++;
                    }
                }
                free(pUdp6Table);
            }
        }
    }
}

/* ===== Display Functions ===== */

static const char *GetProtocolName(DWORD protocol) {
    switch (protocol) {
        case 1:  return "TCP";
        case 2:  return "UDP";
        case 0x17: return "TCP6";
        case 0x18: return "UDP6";
        default: return "";
    }
}

static const char *GetTcpState(DWORD state) {
    switch (state) {
        case MIB_TCP_STATE_CLOSED: return "Closed";
        case MIB_TCP_STATE_LISTEN: return "Listening";
        case MIB_TCP_STATE_SYN_SENT: return "SYN Sent";
        case MIB_TCP_STATE_SYN_RCVD: return "SYN Received";
        case MIB_TCP_STATE_ESTAB: return "Established";
        case MIB_TCP_STATE_FIN_WAIT1: return "FIN Wait 1";
        case MIB_TCP_STATE_FIN_WAIT2: return "FIN Wait 2";
        case MIB_TCP_STATE_CLOSE_WAIT: return "Close Wait";
        case MIB_TCP_STATE_CLOSING: return "Closing";
        case MIB_TCP_STATE_LAST_ACK: return "Last ACK";
        case MIB_TCP_STATE_TIME_WAIT: return "Time Wait";
        case MIB_TCP_STATE_DELETE_TCB: return "Delete TCB";
        default: return "";
    }
}

static void FormatIpAddress(DWORD addr, char *buf, int maxLen) {
    struct in_addr in;
    in.S_un.S_addr = addr;
    strncpy(buf, inet_ntoa(in), maxLen - 1);
    buf[maxLen - 1] = '\0';
}

static void FormatPort(DWORD port, char *buf, int maxLen) {
    sprintf(buf, "%d", ntohs((USHORT)port));
}

static void UpdateListView(void) {
    if (!g_app.hList) return;
    
    SendMessageA(g_app.hList, WM_SETREDRAW, FALSE, 0);
    ListView_DeleteAllItems(g_app.hList);
    
    for (int i = 0; i < g_app.portList.count; i++) {
        PORT_ENTRY *e = &g_app.portList.entries[i];
        char localAddr[64], localPort[16], remoteAddr[64], remotePort[16];
        char pidStr[16], protocolStr[8];
        char procName[MAX_PATH];
        
        LVITEMA lvi;
        memset(&lvi, 0, sizeof(lvi));
        lvi.mask = LVIF_TEXT;
        lvi.iItem = i;
        
        /* Protocol */
        strcpy(protocolStr, GetProtocolName(e->protocol));
        lvi.iSubItem = COL_PROTOCOL;
        lvi.pszText = protocolStr;
        ListView_InsertItem(g_app.hList, &lvi);
        
        /* Local Address */
        if (e->protocol >= 0x17) {
            /* IPv6 */
            inet_ntop(AF_INET6, e->localAddr6, localAddr, sizeof(localAddr));
        } else {
            FormatIpAddress(e->localAddr, localAddr, sizeof(localAddr));
        }
        ListView_SetItemText(g_app.hList, i, COL_LOCAL_ADDR, localAddr);
        
        /* Local Port */
        FormatPort(e->localPort, localPort, sizeof(localPort));
        ListView_SetItemText(g_app.hList, i, COL_LOCAL_PORT, localPort);
        
        /* Remote Address */
        if (e->protocol >= 0x17) {
            inet_ntop(AF_INET6, e->remoteAddr6, remoteAddr, sizeof(remoteAddr));
        } else {
            FormatIpAddress(e->remoteAddr, remoteAddr, sizeof(remoteAddr));
        }
        ListView_SetItemText(g_app.hList, i, COL_REMOTE_ADDR, remoteAddr);
        
        /* Remote Port */
        FormatPort(e->remotePort, remotePort, sizeof(remotePort));
        ListView_SetItemText(g_app.hList, i, COL_REMOTE_PORT, remotePort);
        
        /* State */
        ListView_SetItemText(g_app.hList, i, COL_STATE, "");
        
        /* Process Name */
        char *p = strrchr(e->moduleName, '\\');
        strcpy(procName, p ? p + 1 : e->moduleName);
        ListView_SetItemText(g_app.hList, i, COL_PROCESS_NAME, procName);
        
        /* PID */
        sprintf(pidStr, "%d", e->pid);
        ListView_SetItemText(g_app.hList, i, COL_PROCESS_PID, pidStr);
        
        /* Process Path */
        ListView_SetItemText(g_app.hList, i, COL_PROCESS_PATH, e->moduleName);
    }
    
    SendMessageA(g_app.hList, WM_SETREDRAW, TRUE, 0);
    InvalidateRect(g_app.hList, NULL, TRUE);
    
    /* Update status bar */
    char statusText[256];
    sprintf(statusText, "%d items", g_app.portList.count);
    SendMessageA(g_app.hStatusBar, SB_SETTEXTA, 0, (LPARAM)statusText);
}

/* ===== Save/Export Functions ===== */

static void SaveReport(const char *filename, int format) {
    HANDLE hFile = OpenFileForWrite(filename);
    if (hFile == INVALID_HANDLE_VALUE) {
        ShowErrorMessage(NULL, 0);
        return;
    }
    
    HCURSOR hOldCursor = SetCursor(LoadCursorA(NULL, IDC_WAIT));
    
    if (format == 4 || format == 5) {
        /* HTML format */
        WriteToFile(hFile, "<html>\n<head>\n<title>CurrPorts - Network Ports Report</title>\n</head>\n<body>\n");
        WriteToFile(hFile, "<table border=\"1\" cellpadding=\"5\">\n<tr>");
        WriteToFile(hFile, "<th>Protocol</th><th>Local Address</th><th>Local Port</th>");
        WriteToFile(hFile, "<th>Remote Address</th><th>Remote Port</th>");
        WriteToFile(hFile, "<th>State</th><th>Process Name</th><th>PID</th><th>Process Path</th>");
        WriteToFile(hFile, "</tr>\n");
    } else if (format == 6) {
        /* XML format */
        WriteToFile(hFile, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<ports>\n");
    }
    
    for (int i = 0; i < g_app.portList.count; i++) {
        PORT_ENTRY *e = &g_app.portList.entries[i];
        char localAddr[64], localPort[16], remoteAddr[64], remotePort[16];
        char pidStr[16];
        
        if (e->protocol >= 0x17) {
            inet_ntop(AF_INET6, e->localAddr6, localAddr, sizeof(localAddr));
            inet_ntop(AF_INET6, e->remoteAddr6, remoteAddr, sizeof(remoteAddr));
        } else {
            FormatIpAddress(e->localAddr, localAddr, sizeof(localAddr));
            FormatIpAddress(e->remoteAddr, remoteAddr, sizeof(remoteAddr));
        }
        FormatPort(e->localPort, localPort, sizeof(localPort));
        FormatPort(e->remotePort, remotePort, sizeof(remotePort));
        sprintf(pidStr, "%d", e->pid);
        
        char *p = strrchr(e->moduleName, '\\');
        char *procName = p ? p + 1 : e->moduleName;
        
        if (format == 1) {
            /* Text report */
            char line[2048];
            sprintf(line, "%-10s: %s\n", "Protocol", GetProtocolName(e->protocol));
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Local Addr", localAddr);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Local Port", localPort);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Remote Addr", remoteAddr);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Remote Port", remotePort);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Process", procName);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "PID", pidStr);
            WriteToFile(hFile, line);
            sprintf(line, "%-10s: %s\n", "Path", e->moduleName);
            WriteToFile(hFile, line);
            WriteToFile(hFile, "==================================\n\n");
        } else if (format == 2 || format == 3) {
            /* Tab-delimited */
            char line[2048];
            sprintf(line, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\r\n",
                GetProtocolName(e->protocol), localAddr, localPort,
                remoteAddr, remotePort, "", procName, pidStr, e->moduleName);
            WriteToFile(hFile, line);
        } else if (format == 7) {
            /* CSV */
            char line[2048];
            sprintf(line, "%s,%s,%s,%s,%s,%s,%s,%s,%s\r\n",
                GetProtocolName(e->protocol), localAddr, localPort,
                remoteAddr, remotePort, "", procName, pidStr, e->moduleName);
            WriteToFile(hFile, line);
        } else if (format == 4 || format == 5) {
            /* HTML */
            char line[2048];
            sprintf(line, "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td></td><td>%s</td><td>%s</td><td>%s</td></tr>\n",
                GetProtocolName(e->protocol), localAddr, localPort,
                remoteAddr, remotePort, procName, pidStr, e->moduleName);
            WriteToFile(hFile, line);
        } else if (format == 6) {
            /* XML */
            char line[2048];
            sprintf(line, "  <item>\n    <protocol>%s</protocol>\n    <local_address>%s</local_address>\n    <local_port>%s</local_port>\n    <remote_address>%s</remote_address>\n    <remote_port>%s</remote_port>\n    <process_name>%s</process_name>\n    <pid>%s</pid>\n    <process_path>%s</process_path>\n  </item>\n",
                GetProtocolName(e->protocol), localAddr, localPort,
                remoteAddr, remotePort, procName, pidStr, e->moduleName);
            WriteToFile(hFile, line);
        }
    }
    
    if (format == 4 || format == 5) {
        WriteToFile(hFile, "</table>\n</body>\n</html>\n");
    } else if (format == 6) {
        WriteToFile(hFile, "</ports>\n");
    }
    
    CloseHandle(hFile);
    SetCursor(hOldCursor);
}

/* ===== Window Procedures ===== */

static void InitColumns(void) {
    LVCOLUMNA lvc;
    lvc.mask = LVCF_FMT | LVCF_WIDTH | LVCF_TEXT | LVCF_SUBITEM;
    
    const char *colNames[] = {
        "Protocol", "Local Address", "Local Port", "Remote Address", "Remote Port",
        "State", "Process", "PID", "Process Path", "Product Name",
        "File Description", "Company", "Command Line", "Created On", "Modified On",
        "User", "Service Name", "Service Description", "Service Display Name",
        "Process File", "Remote Host Name", "Country", "City", "ASN"
    };
    int colWidths[] = {
        70, 130, 65, 130, 65, 80, 100, 50, 200, 100,
        120, 100, 200, 120, 120, 80, 80, 120, 120, 200,
        120, 60, 60, 60
    };
    int numCols = sizeof(colNames) / sizeof(colNames[0]);
    
    for (int i = 0; i < numCols; i++) {
        lvc.iSubItem = i;
        lvc.pszText = (char *)colNames[i];
        lvc.cx = colWidths[i];
        lvc.fmt = LVCFMT_LEFT;
        ListView_InsertColumn(g_app.hList, i, &lvc);
    }
}

static void CreateMainWindow(APP_STATE *app) {
    WNDCLASSA wc;
    wc.style = 0;
    wc.lpfnWndProc = DefWindowProcA;
    wc.cbClsExtra = 0;
    wc.cbWndExtra = 0;
    wc.hInstance = app->hInstance;
    wc.hIcon = LoadIconA(app->hInstance, MAKEINTRESOURCEA(0x65));
    wc.hCursor = NULL;
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszMenuName = NULL;
    wc.lpszClassName = "CurrPorts";
    RegisterClassA(&wc);
    
    app->hWnd = CreateWindowExA(0, "CurrPorts", "CurrPorts",
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
        NULL, NULL, app->hInstance, NULL);
}

static void RefreshPorts(void) {
    HCURSOR hOld = SetCursor(LoadCursorA(NULL, IDC_WAIT));
    EnumeratePorts();
    UpdateListView();
    SetCursor(hOld);
}

/* ===== Command-Line Saving ===== */

static BOOL SaveReportFromCmdLine(const char *filename, int format) {
    EnumeratePorts();
    SaveReport(filename, format);
    return TRUE;
}

static BOOL HandleCommandLineOptions(const char *cmdLine) {
    /* Parse command line for save options */
    char args[4096];
    strncpy(args, cmdLine, sizeof(args) - 1);
    args[sizeof(args) - 1] = '\0';
    
    /* Tokenize */
    char *tokens[64];
    int numTokens = 0;
    char *tok = strtok(args, " ");
    while (tok && numTokens < 64) {
        tokens[numTokens++] = tok;
        tok = strtok(NULL, " ");
    }
    
    int saveFormat = 0;
    int saveArgIdx = -1;
    
    for (int i = 0; i < numTokens; i++) {
        if (_strcmpi("/stext", tokens[i]) == 0) { saveFormat = 1; saveArgIdx = i + 1; }
        else if (_strcmpi("/stab", tokens[i]) == 0) { saveFormat = 2; saveArgIdx = i + 1; }
        else if (_strcmpi("/stabular", tokens[i]) == 0) { saveFormat = 3; saveArgIdx = i + 1; }
        else if (_strcmpi("/shtml", tokens[i]) == 0) { saveFormat = 4; saveArgIdx = i + 1; }
        else if (_strcmpi("/sverhtml", tokens[i]) == 0) { saveFormat = 5; saveArgIdx = i + 1; }
        else if (_strcmpi("/sxml", tokens[i]) == 0) { saveFormat = 6; saveArgIdx = i + 1; }
        else if (_strcmpi("/scomma", tokens[i]) == 0) { saveFormat = 7; saveArgIdx = i + 1; }
    }
    
    if (saveFormat > 0 && saveArgIdx > 0 && saveArgIdx < numTokens) {
        return SaveReportFromCmdLine(tokens[saveArgIdx], saveFormat);
    }
    
    if (_strcmpi("/savelangfile", tokens[0 < numTokens ? 0 : 0]) == 0 ||
        (numTokens > 0 && _strcmpi("/savelangfile", tokens[0]) == 0)) {
        /* Save language file */
        char langPath[MAX_PATH];
        GetModuleDir(langPath, MAX_PATH);
        AddTrailingSlash(langPath);
        strcat(langPath, "cports_lng.ini");
        
        HANDLE hFile = OpenFileForWrite(langPath);
        if (hFile != INVALID_HANDLE_VALUE) {
            WriteToFile(hFile, "[general]\r\nrtl=0\r\nTranslatorName=\r\nTranslatorURL=\r\n\r\n[strings]\r\n");
            CloseHandle(hFile);
        }
        return TRUE;
    }
    
    return FALSE;
}

/* ===== Window Procedure ===== */

static LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_CREATE: {
            /* Create toolbar */
            g_app.hToolbar = CreateWindowExA(0, TOOLBARCLASSNAMEA, NULL,
                WS_CHILD | WS_VISIBLE | TBSTYLE_FLAT | TBSTYLE_TOOLTIPS,
                0, 0, 0, 0, hWnd, (HMENU)0x102, g_app.hInstance, NULL);
            
            /* Create status bar */
            g_app.hStatusBar = CreateWindowExA(0, STATUSCLASSNAMEA, NULL,
                WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP,
                0, 0, 0, 0, hWnd, (HMENU)0x103, g_app.hInstance, NULL);
            
            /* Create list view */
            g_app.hList = CreateWindowExA(WS_EX_CLIENTEDGE, WC_LISTVIEWA, "",
                WS_CHILD | WS_VISIBLE | LVS_REPORT | LVS_SHOWSELALWAYS | LVS_SINGLESEL,
                0, 0, 0, 0, hWnd, (HMENU)0x104, g_app.hInstance, NULL);
            
            ListView_SetExtendedListViewStyle(g_app.hList, 
                LVS_EX_FULLROWSELECT | LVS_EX_GRIDLINES | LVS_EX_HEADERDRAGDROP);
            
            InitColumns();
            
            /* Load menu */
            g_app.hMenu = LoadMenuA(g_app.hInstance, MAKEINTRESOURCEA(0x67));
            SetMenu(hWnd, g_app.hMenu);
            
            /* Load accelerators */
            g_app.hAccel = LoadAcceleratorsA(g_app.hInstance, MAKEINTRESOURCEA(0x67));
            
            /* Refresh ports */
            PostMessageA(hWnd, WM_REFRESH, 0, 0);
            return 0;
        }
        
        case WM_SIZE: {
            RECT rcTool, rcStatus;
            SendMessageA(g_app.hToolbar, TB_AUTOSIZE, 0, 0);
            GetWindowRect(g_app.hToolbar, &rcTool);
            int toolHeight = rcTool.bottom - rcTool.top;
            
            SendMessageA(g_app.hStatusBar, WM_SIZE, 0, 0);
            GetWindowRect(g_app.hStatusBar, &rcStatus);
            int statusHeight = rcStatus.bottom - rcStatus.top;
            
            int width = LOWORD(lParam);
            int height = HIWORD(lParam);
            
            MoveWindow(g_app.hList, 0, toolHeight, width, height - toolHeight - statusHeight, TRUE);
            return 0;
        }
        
        case WM_REFRESH: {
            RefreshPorts();
            return 0;
        }
        
        case WM_COMMAND: {
            switch (LOWORD(wParam)) {
                case 0x9C41: /* File > Refresh */
                    RefreshPorts();
                    break;
                case 0x9C42: /* File > Save */
                {
                    char filename[MAX_PATH] = "";
                    OPENFILENAMEA ofn;
                    memset(&ofn, 0, sizeof(ofn));
                    ofn.lStructSize = sizeof(ofn);
                    ofn.hwndOwner = hWnd;
                    ofn.lpstrFilter = "Text Files (*.txt)\0*.txt\0HTML Files (*.html)\0*.html\0XML Files (*.xml)\0*.xml\0CSV Files (*.csv)\0*.csv\0All Files\0*.*\0";
                    ofn.lpstrFile = filename;
                    ofn.nMaxFile = MAX_PATH;
                    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
                    ofn.lpstrDefExt = "txt";
                    if (GetSaveFileNameA(&ofn)) {
                        SaveReport(filename, 1);
                    }
                    break;
                }
                case 0x9C44: /* File > Exit */
                    DestroyWindow(hWnd);
                    break;
                case 0x9C46: /* View > Mark Suspicious */
                    g_app.markSuspicious = !g_app.markSuspicious;
                    break;
                case 0x9C48: /* View > Show Only TCP */
                    g_app.showOnlyTCP = !g_app.showOnlyTCP;
                    RefreshPorts();
                    break;
                case 0x9C49: /* View > Show Only Incoming */
                    g_app.showOnlyIncoming = !g_app.showOnlyIncoming;
                    RefreshPorts();
                    break;
                case 0x9C4E: /* View > Auto Refresh */
                    g_app.autoRefresh = !g_app.autoRefresh;
                    if (g_app.autoRefresh) {
                        SetTimer(hWnd, IDT_TIMER, g_app.refreshInterval, NULL);
                    } else {
                        KillTimer(hWnd, IDT_TIMER);
                    }
                    break;
                case 0xC2EE: /* Help > About */
                    MessageBoxA(hWnd, 
                        "CurrPorts v2.80\n\n"
                        "Displays the list of all currently opened TCP/IP and UDP ports.\n\n"
                        "Reconstructed from binary analysis.",
                        "About CurrPorts", MB_ICONINFORMATION);
                    break;
            }
            return 0;
        }
        
        case WM_TIMER: {
            if (wParam == IDT_TIMER) {
                RefreshPorts();
            }
            return 0;
        }
        
        case WM_NOTIFY: {
            LPNMHDR pnmh = (LPNMHDR)lParam;
            if (pnmh->hwndFrom == g_app.hList) {
                if (pnmh->code == LVN_COLUMNCLICK) {
                    LPNMLISTVIEW pnmlv = (LPNMLISTVIEW)lParam;
                    if (pnmlv->iSubItem == g_app.sortColumn)
                        g_app.sortReverse = !g_app.sortReverse;
                    else
                        g_app.sortColumn = pnmlv->iSubItem;
                    /* Sort items */
                }
            }
            return 0;
        }
        
        case WM_CLOSE: {
            if (g_app.trayAdded) {
                Shell_NotifyIconA(NIM_DELETE, &g_app.trayIcon);
            }
            DestroyWindow(hWnd);
            return 0;
        }
        
        case WM_DESTROY: {
            PostQuitMessage(0);
            return 0;
        }
        
        default:
            return DefWindowProcA(hWnd, message, wParam, lParam);
    }
    return 0;
}

/* ===== WinMain ===== */

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    /* Initialize common controls */
    INITCOMMONCONTROLSEX icc;
    icc.dwSize = sizeof(icc);
    icc.dwICC = ICC_BAR_CLASSES | ICC_LISTVIEW_CLASSES;
    if (!InitCommonControlsEx(&icc)) {
        MessageBoxA(NULL, "Error: Cannot load the common control classes.", "Error", MB_ICONERROR);
        return 1;
    }
    
    /* Initialize app state */
    memset(&g_app, 0, sizeof(g_app));
    g_app.hInstance = hInstance;
    g_app.refreshInterval = 5000;
    g_app.sortColumn = 0;
    g_app.sortReverse = FALSE;
    
    /* Get OS version */
    g_app.osvi.dwOSVersionInfoSize = sizeof(OSVERSIONINFO);
    GetVersionExA(&g_app.osvi);
    g_app.isWin2K = (g_app.osvi.dwMajorVersion == 5 && g_app.osvi.dwMinorVersion == 0);
    g_app.isXP = (g_app.osvi.dwMajorVersion == 5 && g_app.osvi.dwMinorVersion == 1);
    
    /* Initialize APIs */
    InitToolhelpApi();
    InitPsapiApi();
    InitNetworkApi();
    
    /* Check for resource DLL */
    char modPath[MAX_PATH];
    GetModuleDir(modPath, MAX_PATH);
    AddTrailingSlash(modPath);
    strcat(modPath, "cports_res.dll");
    if (GetFileAttributesA(modPath) != INVALID_FILE_ATTRIBUTES) {
        g_app.hResDll = LoadLibraryA(modPath);
    }
    
    /* Check for language file */
    char langPath[MAX_PATH];
    GetModuleDir(langPath, MAX_PATH);
    AddTrailingSlash(langPath);
    strcat(langPath, "cports_lng.ini");
    if (GetFileAttributesA(langPath) != INVALID_FILE_ATTRIBUTES) {
        strcpy(g_app.langIniFile, langPath);
        g_app.rtl = GetPrivateProfileIntA("general", "rtl", 0, g_app.langIniFile);
    }
    
    /* Handle command-line options */
    if (strlen(lpCmdLine) > 0) {
        if (HandleCommandLineOptions(lpCmdLine)) {
            return 0;
        }
    }
    
    /* Register window class */
    WNDCLASSA wc;
    memset(&wc, 0, sizeof(wc));
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hIcon = LoadIconA(hInstance, MAKEINTRESOURCEA(0x65));
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = "CurrPorts";
    RegisterClassA(&wc);
    
    /* Create main window */
    g_app.hWnd = CreateWindowExA(0, "CurrPorts", "CurrPorts",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 800, 600,
        NULL, NULL, hInstance, NULL);
    
    if (!g_app.hWnd) {
        MessageBoxA(NULL, "Error: Failed to create main window.", "Error", MB_ICONERROR);
        return 1;
    }
    
    /* Show window */
    ShowWindow(g_app.hWnd, nCmdShow);
    UpdateWindow(g_app.hWnd);
    
    /* Message loop */
    MSG msg;
    while (GetMessageA(&msg, NULL, 0, 0)) {
        if (!TranslateAcceleratorA(g_app.hWnd, g_app.hAccel, &msg)) {
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }
    }
    
    /* Cleanup */
    if (g_app.hResDll) FreeLibrary(g_app.hResDll);
    if (g_app.hIphlpapi) FreeLibrary(g_app.hIphlpapi);
    if (g_app.portList.entries) free(g_app.portList.entries);
    if (g_app.strings) free(g_app.strings);
    
    return (int)msg.wParam;
}
