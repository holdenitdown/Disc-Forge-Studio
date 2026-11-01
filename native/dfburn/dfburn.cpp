// dfburn.exe - DiscForge Studio disc burning helper.
// Talks to the Windows Image Mastering API v2 (IMAPI2) directly and prints one JSON
// object per line on stdout so the app can show live progress.
//
//   dfburn list
//   dfburn burn  <image.iso> <recorderUniqueId|index> [--speed-sectors N | --speed X] [--no-eject] [--allow-nonblank]
//   dfburn erase <recorderUniqueId|index> [--full]
//
// While burning, writing the line "cancel" to stdin asks IMAPI2 to stop.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <oleauto.h>
#include <ocidl.h>
#include <shlwapi.h>
#include <stdio.h>
#include <string>
#include <vector>

static const GUID DIID_DDiscFormat2DataEvents = {0x2735413C, 0x7F64, 0x5B0F, {0x8F, 0x00, 0x5D, 0x77, 0xAF, 0xBE, 0x26, 0x1E}};
static const GUID DIID_DDiscFormat2EraseEvents = {0x2735413A, 0x7F64, 0x5B0F, {0x8F, 0x00, 0x5D, 0x77, 0xAF, 0xBE, 0x26, 0x1E}};

static CRITICAL_SECTION g_out;

// ------------------------------------------------------------------ output helpers
static std::string utf8(const wchar_t *w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}
static std::string jstr(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) { char b[8]; sprintf(b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
static std::string jstr(const wchar_t *w) { return jstr(utf8(w)); }
static void emit(const std::string &line) {
  EnterCriticalSection(&g_out);
  fputs(line.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
  LeaveCriticalSection(&g_out);
}

static std::string hrText(HRESULT hr) {
  switch ((unsigned)hr) {
    case 0xC0AA0002: return "The operation was cancelled.";
    case 0xC0AA0202: return "There is no disc in the drive.";
    case 0xC0AA0203: return "The disc in the drive is not compatible with this burner, or is not a recordable disc.";
    case 0xC0AA0204: return "The disc is upside down.";
    case 0xC0AA0205: return "The drive is still getting ready. Wait a few seconds and try again.";
    case 0xC0AA0206: return "The disc is not formatted.";
    case 0xC0AA0207: return "The drive is busy formatting the disc.";
    case 0xC0AA0210: return "Another program is using the burner. Close other burning software and try again.";
    case 0xC0AA0400: return "A burn is already in progress on this drive.";
    case 0xC0AA0402: return "The disc is not blank. Use a blank disc or erase a rewritable disc first.";
    case 0xC0AA0403: return "This type of disc is not supported for writing.";
    case 0xC0AA0404: return "The disc is in a state that cannot be written to (it may be finalized or damaged).";
    case 0xC0AA0405: return "The image could not be read for writing.";
    case 0xC0AA0406: return "The image is larger than the free space on the disc.";
    case 0xC0AA0407: return "The disc is not blank. Use a blank disc or erase a rewritable disc first.";
    case 0xC0AA020D: return "The burner lost the write stream (buffer underrun). Try a slower speed.";
    case 0xC0AA020F: return "The write failed. The disc may be defective; try another disc or a slower speed.";
    case 0xC0AA0300: return "The burner is in use by another application.";
  }
  wchar_t *msg = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, hr, 0, (LPWSTR)&msg, 0, nullptr);
  std::string s = msg ? utf8(msg) : "";
  if (msg) LocalFree(msg);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
  char b[32]; sprintf(b, " (0x%08X)", (unsigned)hr);
  return (s.empty() ? std::string("Windows disc burning error") : s) + b;
}

struct ComError {
  HRESULT hr; std::string msg;
};
[[noreturn]] static void fail(HRESULT hr, const std::string &where, const std::string &desc = "") {
  std::string m = desc.empty() ? hrText(hr) : desc;
  throw ComError{hr, m + (where.empty() ? "" : " [" + where + "]")};
}

// ------------------------------------------------------------------ late-bound IDispatch
struct Disp {
  IDispatch *p = nullptr;
  Disp() {}
  explicit Disp(IDispatch *d) : p(d) {}
  Disp(const Disp &o) : p(o.p) { if (p) p->AddRef(); }
  Disp &operator=(const Disp &o) { if (o.p) o.p->AddRef(); if (p) p->Release(); p = o.p; return *this; }
  ~Disp() { if (p) p->Release(); }

  static Disp create(const wchar_t *progId) {
    CLSID clsid;
    HRESULT hr = CLSIDFromProgID(progId, &clsid);
    if (FAILED(hr)) fail(hr, utf8(progId), "Windows disc burning (IMAPI2) is not available on this PC");
    IDispatch *d = nullptr;
    hr = CoCreateInstance(clsid, nullptr, CLSCTX_ALL, IID_IDispatch, (void **)&d);
    if (FAILED(hr)) fail(hr, utf8(progId));
    return Disp(d);
  }
  DISPID id(const wchar_t *name) const {
    DISPID did; LPOLESTR n = (LPOLESTR)name;
    HRESULT hr = p->GetIDsOfNames(IID_NULL, &n, 1, LOCALE_USER_DEFAULT, &did);
    if (FAILED(hr)) fail(hr, utf8(name));
    return did;
  }
  // args are given in natural order
  VARIANT invoke(const wchar_t *name, WORD flags, std::vector<VARIANT> args = {}) const {
    DISPID did = id(name);
    std::vector<VARIANT> rev(args.rbegin(), args.rend());
    DISPPARAMS dp = {rev.empty() ? nullptr : rev.data(), nullptr, (UINT)rev.size(), 0};
    DISPID put = DISPID_PROPERTYPUT;
    if (flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) { dp.rgdispidNamedArgs = &put; dp.cNamedArgs = 1; }
    VARIANT res; VariantInit(&res);
    EXCEPINFO ei; memset(&ei, 0, sizeof ei);
    UINT argErr = 0;
    HRESULT hr = p->Invoke(did, IID_NULL, LOCALE_USER_DEFAULT, flags, &dp, (flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) ? nullptr : &res, &ei, &argErr);
    if (hr == DISP_E_EXCEPTION) {
      HRESULT real = ei.scode ? ei.scode : (HRESULT)ei.wCode;
      std::string desc;
      // prefer our friendly text for known IMAPI codes
      std::string friendly = hrText(real);
      if (friendly.find("(0x") == std::string::npos) desc = friendly;
      else if (ei.bstrDescription) desc = utf8(ei.bstrDescription);
      SysFreeString(ei.bstrDescription); SysFreeString(ei.bstrSource); SysFreeString(ei.bstrHelpFile);
      fail(real, utf8(name), desc);
    }
    if (FAILED(hr)) fail(hr, utf8(name));
    return res;
  }
  VARIANT get(const wchar_t *name) const { return invoke(name, DISPATCH_PROPERTYGET | DISPATCH_METHOD); }
  VARIANT call(const wchar_t *name, std::vector<VARIANT> args = {}) const { return invoke(name, DISPATCH_METHOD, args); }
  void put(const wchar_t *name, VARIANT v) const { invoke(name, DISPATCH_PROPERTYPUT, {v}); }
  void putRef(const wchar_t *name, VARIANT v) const {
    try { invoke(name, DISPATCH_PROPERTYPUTREF, {v}); }
    catch (ComError &) { invoke(name, DISPATCH_PROPERTYPUT, {v}); }
  }
  long long getInt(const wchar_t *name) const {
    VARIANT v = get(name); VARIANT o; VariantInit(&o);
    long long r = 0;
    if (SUCCEEDED(VariantChangeType(&o, &v, 0, VT_I8))) r = o.llVal;
    VariantClear(&v); VariantClear(&o);
    return r;
  }
  bool getBool(const wchar_t *name) const { VARIANT v = get(name); bool b = v.vt == VT_BOOL ? v.boolVal != VARIANT_FALSE : getIntFrom(v) != 0; VariantClear(&v); return b; }
  static long long getIntFrom(VARIANT &v) { VARIANT o; VariantInit(&o); long long r = 0; if (SUCCEEDED(VariantChangeType(&o, &v, 0, VT_I8))) r = o.llVal; VariantClear(&o); return r; }
  std::string getStr(const wchar_t *name) const {
    VARIANT v = get(name); std::string s;
    if (v.vt == VT_BSTR) s = utf8(v.bstrVal);
    VariantClear(&v);
    return s;
  }
};

static VARIANT vStr(const wchar_t *s) { VARIANT v; VariantInit(&v); v.vt = VT_BSTR; v.bstrVal = SysAllocString(s); return v; }
static VARIANT vBool(bool b) { VARIANT v; VariantInit(&v); v.vt = VT_BOOL; v.boolVal = b ? VARIANT_TRUE : VARIANT_FALSE; return v; }
static VARIANT vI4(long n) { VARIANT v; VariantInit(&v); v.vt = VT_I4; v.lVal = n; return v; }
static VARIANT vDisp(IDispatch *d) { VARIANT v; VariantInit(&v); v.vt = VT_DISPATCH; v.pdispVal = d; return v; }  // borrowed
static VARIANT vUnk(IUnknown *u) { VARIANT v; VariantInit(&v); v.vt = VT_UNKNOWN; v.punkVal = u; return v; }        // borrowed
static std::string trim(std::string s) { while (!s.empty() && s.back() == ' ') s.pop_back(); size_t i = 0; while (i < s.size() && s[i] == ' ') i++; return s.substr(i); }

static std::vector<std::string> safeArrayStrings(VARIANT &v) {
  std::vector<std::string> out;
  if (!(v.vt & VT_ARRAY) || !v.parray) return out;
  SAFEARRAY *sa = v.parray;
  LONG lo = 0, hi = -1;
  SafeArrayGetLBound(sa, 1, &lo); SafeArrayGetUBound(sa, 1, &hi);
  VARTYPE vt; SafeArrayGetVartype(sa, &vt);
  for (LONG i = lo; i <= hi; i++) {
    if (vt == VT_VARIANT) {
      VARIANT e; VariantInit(&e);
      if (SUCCEEDED(SafeArrayGetElement(sa, &i, &e))) {
        VARIANT s; VariantInit(&s);
        if (SUCCEEDED(VariantChangeType(&s, &e, 0, VT_BSTR))) out.push_back(utf8(s.bstrVal));
        VariantClear(&s); VariantClear(&e);
      }
    } else if (vt == VT_BSTR) {
      BSTR b = nullptr;
      if (SUCCEEDED(SafeArrayGetElement(sa, &i, &b))) { out.push_back(utf8(b)); SysFreeString(b); }
    } else if (vt == VT_I4 || vt == VT_INT) {
      LONG n = 0;
      if (SUCCEEDED(SafeArrayGetElement(sa, &i, &n))) out.push_back(std::to_string(n));
    }
  }
  return out;
}

static const char *mediaName(long t) {
  switch (t) {
    case 0: return "Unknown"; case 1: return "CD-ROM"; case 2: return "CD-R"; case 3: return "CD-RW";
    case 4: return "DVD-ROM"; case 5: return "DVD-RAM"; case 6: return "DVD+R"; case 7: return "DVD+RW";
    case 8: return "DVD+R DL"; case 9: return "DVD-R"; case 10: return "DVD-RW"; case 11: return "DVD-R DL";
    case 12: return "Disk"; case 13: return "DVD+RW DL"; case 14: return "HD DVD-ROM"; case 15: return "HD DVD-R";
    case 16: return "HD DVD-RAM"; case 17: return "BD-ROM"; case 18: return "BD-R"; case 19: return "BD-RE";
  }
  return "Disc";
}
static bool rewritable(long t) { return t == 3 || t == 5 || t == 7 || t == 10 || t == 13 || t == 19; }

// ------------------------------------------------------------------ recorders
static std::vector<std::wstring> recorderIds() {
  Disp dm = Disp::create(L"IMAPI2.MsftDiscMaster2");
  long n = (long)dm.getInt(L"Count");
  std::vector<std::wstring> ids;
  for (long i = 0; i < n; i++) {
    VARIANT v = dm.invoke(L"Item", DISPATCH_PROPERTYGET | DISPATCH_METHOD, {vI4(i)});
    if (v.vt == VT_BSTR) ids.push_back(v.bstrVal);
    VariantClear(&v);
  }
  return ids;
}
static Disp openRecorder(const std::wstring &idOrIndex) {
  std::wstring id = idOrIndex;
  auto ids = recorderIds();
  if (ids.empty()) fail(E_FAIL, "", "No disc burner was found on this PC.");
  bool numeric = !id.empty() && id.size() < 4;
  for (wchar_t c : id) if (c < L'0' || c > L'9') numeric = false;
  if (id.empty()) id = ids[0];
  else if (numeric) { size_t k = _wtoi(id.c_str()); if (k >= ids.size()) fail(E_INVALIDARG, "", "That burner is no longer connected."); id = ids[k]; }
  Disp rec = Disp::create(L"IMAPI2.MsftDiscRecorder2");
  VARIANT a = vStr(id.c_str());
  rec.call(L"InitializeDiscRecorder", {a});
  VariantClear(&a);
  return rec;
}

static int cmdList() {
  auto ids = recorderIds();
  std::string out = "{\"type\":\"burners\",\"burners\":[";
  for (size_t i = 0; i < ids.size(); i++) {
    std::string item;
    try {
      Disp rec = Disp::create(L"IMAPI2.MsftDiscRecorder2");
      VARIANT a = vStr(ids[i].c_str());
      rec.call(L"InitializeDiscRecorder", {a});
      VariantClear(&a);
      std::string name = trim(rec.getStr(L"VendorId")) + " " + trim(rec.getStr(L"ProductId"));
      VARIANT vp = rec.get(L"VolumePathNames");
      auto paths = safeArrayStrings(vp); VariantClear(&vp);
      std::string letters; for (auto &p : paths) { if (!letters.empty()) letters += ","; letters += p; }
      VARIANT pr = rec.get(L"SupportedProfiles");
      auto profiles = safeArrayStrings(pr); VariantClear(&pr);
      long media = -1; long long freeB = 0, totalB = 0; bool blank = false, supported = false, present = false;
      std::vector<std::string> speeds; long curSpeed = 0;
      try {
        Disp fmt = Disp::create(L"IMAPI2.MsftDiscFormat2Data");
        fmt.putRef(L"Recorder", vDisp(rec.p));
        VARIANT sup = fmt.call(L"IsCurrentMediaSupported", {vDisp(rec.p)});
        supported = sup.vt == VT_BOOL && sup.boolVal != VARIANT_FALSE; VariantClear(&sup);
        if (supported) {
          present = true;
          media = (long)fmt.getInt(L"CurrentPhysicalMediaType");
          blank = fmt.getBool(L"MediaHeuristicallyBlank");
          freeB = fmt.getInt(L"FreeSectorsOnMedia") * 2048LL;
          totalB = fmt.getInt(L"TotalSectorsOnMedia") * 2048LL;
          try {
            VARIANT sp = fmt.get(L"SupportedWriteSpeeds");
            speeds = safeArrayStrings(sp); VariantClear(&sp);
          } catch (ComError &) {}
          try { curSpeed = (long)fmt.getInt(L"CurrentWriteSpeed"); } catch (ComError &) {}
        }
      } catch (ComError &) {}
      std::string mname = present ? mediaName(media) : "No writable disc";
      if (present && !blank) mname += " (not blank)";
      item = "{\"index\":" + std::to_string(i) + ",\"id\":" + jstr(ids[i].c_str()) + ",\"name\":" + jstr(trim(name)) +
             ",\"letter\":" + jstr(letters) + ",\"media\":" + std::to_string(media) + ",\"mediaName\":" + jstr(mname) +
             ",\"mediaPresent\":" + (present ? "true" : "false") + ",\"blank\":" + (blank ? "true" : "false") +
             ",\"rewritable\":" + (present && rewritable(media) ? "true" : "false") +
             ",\"free\":" + std::to_string(freeB) + ",\"total\":" + std::to_string(totalB) + ",\"profiles\":[";
      for (size_t k = 0; k < profiles.size(); k++) item += (k ? "," : "") + profiles[k];
      item += "],\"speeds\":[";
      for (size_t k = 0; k < speeds.size(); k++) item += (k ? "," : "") + speeds[k];
      item += "],\"currentSpeed\":" + std::to_string(curSpeed) + "}";
    } catch (ComError &e) {
      item = "{\"index\":" + std::to_string(i) + ",\"id\":" + jstr(ids[i].c_str()) + ",\"name\":\"Disc burner\",\"letter\":\"\",\"media\":-1,\"mediaName\":" + jstr(e.msg) + ",\"mediaPresent\":false,\"blank\":false,\"rewritable\":false,\"free\":0,\"total\":0,\"profiles\":[],\"speeds\":[],\"currentSpeed\":0}";
    }
    out += (i ? "," : "") + item;
  }
  emit(out + "]}");
  return 0;
}

// ------------------------------------------------------------------ event sinks
struct Sink : public IDispatch {
  LONG refs = 1;
  GUID iid;
  bool erase;
  DWORD start = GetTickCount();
  Sink(const GUID &g, bool e) : iid(g), erase(e) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID r, void **o) override {
    if (IsEqualIID(r, IID_IUnknown) || IsEqualIID(r, IID_IDispatch) || IsEqualIID(r, iid)) { *o = this; AddRef(); return S_OK; }
    *o = nullptr; return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
  ULONG STDMETHODCALLTYPE Release() override { LONG r = InterlockedDecrement(&refs); if (!r) delete this; return r; }
  HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT *n) override { *n = 0; return S_OK; }
  HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT, LCID, ITypeInfo **) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID, LPOLESTR *, UINT, LCID, DISPID *) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Invoke(DISPID id, REFIID, LCID, WORD, DISPPARAMS *dp, VARIANT *, EXCEPINFO *, UINT *) override {
    if (id != 0x200 || !dp) return S_OK;
    try {
      if (erase) {
        // Update(object, elapsedSeconds, estimatedTotalSeconds) -> reversed order in rgvarg
        if (dp->cArgs >= 3) {
          long long el = Disp::getIntFrom(dp->rgvarg[1]), tot = Disp::getIntFrom(dp->rgvarg[0]);
          double f = tot > 0 ? (double)el / tot : 0; if (f > 0.99) f = 0.99;
          char b[200]; sprintf(b, "{\"type\":\"progress\",\"phase\":\"erasing\",\"fraction\":%.4f,\"elapsed\":%lld,\"remaining\":%lld}", f, el, tot > el ? tot - el : 0);
          emit(b);
        }
        return S_OK;
      }
      if (dp->cArgs < 2) return S_OK;
      VARIANT &pv = dp->rgvarg[0];
      IDispatch *pd = (pv.vt == VT_DISPATCH) ? pv.pdispVal : (pv.vt == (VT_DISPATCH | VT_BYREF) && pv.ppdispVal ? *pv.ppdispVal : nullptr);
      if (!pd) return S_OK;
      pd->AddRef();
      Disp a(pd);
      long action = (long)a.getInt(L"CurrentAction");
      long long el = a.getInt(L"ElapsedTime"), rem = a.getInt(L"RemainingTime");
      long long startLba = a.getInt(L"StartLba"), count = a.getInt(L"SectorCount"), last = a.getInt(L"LastWrittenLba");
      long long done = last - startLba; if (done < 0) done = 0;
      long long used = 0, freeb = 0;
      try { used = a.getInt(L"UsedSystemBuffer"); freeb = a.getInt(L"FreeSystemBuffer"); } catch (ComError &) {}
      static const char *phases[] = {"validating", "formatting", "initializing", "calibrating", "writing", "finalizing", "completed", "verifying"};
      const char *ph = (action >= 0 && action <= 7) ? phases[action] : "working";
      double f = 0;
      if (action == 4 && count > 0) f = (double)done / count;
      else if (action >= 5) f = 1;
      char b[400];
      sprintf(b, "{\"type\":\"progress\",\"phase\":\"%s\",\"fraction\":%.4f,\"sectorsDone\":%lld,\"sectors\":%lld,\"bytesDone\":%lld,\"bytes\":%lld,\"elapsed\":%lld,\"remaining\":%lld,\"buffer\":%d}",
              ph, f, done, count, done * 2048LL, count * 2048LL, el, rem, (used + freeb) > 0 ? (int)(100 * used / (used + freeb)) : -1);
      emit(b);
    } catch (ComError &) {}
    return S_OK;
  }
};

static DWORD advise(const Disp &src, Sink *sink, IConnectionPoint **cpOut) {
  IConnectionPointContainer *cpc = nullptr;
  DWORD cookie = 0;
  *cpOut = nullptr;
  if (SUCCEEDED(src.p->QueryInterface(IID_IConnectionPointContainer, (void **)&cpc)) && cpc) {
    IConnectionPoint *cp = nullptr;
    if (SUCCEEDED(cpc->FindConnectionPoint(sink->iid, &cp)) && cp) {
      if (SUCCEEDED(cp->Advise(sink, &cookie))) *cpOut = cp; else cp->Release();
    }
    cpc->Release();
  }
  if (!*cpOut) emit("{\"type\":\"log\",\"message\":\"Live progress events are not available; progress will be estimated.\"}");
  return cookie;
}

// ------------------------------------------------------------------ cancel via stdin
static Disp *g_cancelTarget = nullptr;
static volatile LONG g_cancelled = 0;
static DWORD WINAPI stdinWatcher(LPVOID) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  char buf[256]; DWORD n;
  std::string acc;
  while (ReadFile(h, buf, sizeof buf, &n, nullptr) && n) {
    acc.append(buf, n);
    if (acc.find("cancel") != std::string::npos) {
      InterlockedExchange(&g_cancelled, 1);
      emit("{\"type\":\"log\",\"message\":\"Cancelling...\"}");
      try { if (g_cancelTarget) g_cancelTarget->call(L"CancelWrite"); } catch (ComError &) {}
      break;
    }
  }
  return 0;
}

static std::string argVal(int argc, wchar_t **argv, const wchar_t *flag) {
  for (int i = 0; i < argc - 1; i++) if (!wcscmp(argv[i], flag)) return utf8(argv[i + 1]);
  return "";
}
static bool hasFlag(int argc, wchar_t **argv, const wchar_t *flag) {
  for (int i = 0; i < argc; i++) if (!wcscmp(argv[i], flag)) return true;
  return false;
}

static int cmdBurn(int argc, wchar_t **argv) {
  if (argc < 4) fail(E_INVALIDARG, "", "usage: dfburn burn <image.iso> <burner>");
  const wchar_t *iso = argv[2];
  emit("{\"type\":\"progress\",\"phase\":\"preparing\",\"fraction\":0}");
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (!GetFileAttributesExW(iso, GetFileExInfoStandard, &fa)) fail(HRESULT_FROM_WIN32(GetLastError()), "", "The ISO file could not be opened: " + utf8(iso));
  long long size = ((long long)fa.nFileSizeHigh << 32) | fa.nFileSizeLow;
  if (size % 2048) fail(E_INVALIDARG, "", "The ISO file is not a valid disc image (its size is not a multiple of 2048 bytes).");

  Disp rec = openRecorder(argv[3]);
  std::string name = trim(rec.getStr(L"VendorId")) + " " + trim(rec.getStr(L"ProductId"));
  emit("{\"type\":\"log\",\"message\":" + jstr("Burner: " + trim(name)) + "}");

  Disp fmt = Disp::create(L"IMAPI2.MsftDiscFormat2Data");
  fmt.putRef(L"Recorder", vDisp(rec.p));
  VARIANT cn = vStr(L"DiscForge Studio"); fmt.put(L"ClientName", cn); VariantClear(&cn);

  VARIANT sup = fmt.call(L"IsCurrentMediaSupported", {vDisp(rec.p)});
  bool supported = sup.vt == VT_BOOL && sup.boolVal != VARIANT_FALSE; VariantClear(&sup);
  if (!supported) {
    fail(0xC0AA0202, "", "There is no writable disc in the drive. Insert a blank DVD-R/DVD+R (or BD-R for Blu-ray) and try again.");
  }
  long media = (long)fmt.getInt(L"CurrentPhysicalMediaType");
  bool blank = fmt.getBool(L"MediaHeuristicallyBlank");
  long long freeB = fmt.getInt(L"FreeSectorsOnMedia") * 2048LL;
  char b[300];
  sprintf(b, "{\"type\":\"media\",\"media\":%ld,\"mediaName\":\"%s\",\"blank\":%s,\"free\":%lld,\"size\":%lld}", media, mediaName(media), blank ? "true" : "false", freeB, size);
  emit(b);
  if (!blank && !hasFlag(argc, argv, L"--allow-nonblank")) {
    if (rewritable(media)) fail(0xC0AA0402, "", std::string("The ") + mediaName(media) + " disc is not blank. Use \"Erase rewritable disc\" first, or insert a blank disc.");
    fail(0xC0AA0402, "", std::string("The ") + mediaName(media) + " disc in the drive has already been written to. Insert a blank disc.");
  }
  if (freeB > 0 && size > freeB) {
    char m[200]; sprintf(m, "The image (%.2f GB) is larger than the space on the disc (%.2f GB).", size / 1e9, freeB / 1e9);
    fail(0xC0AA0406, "", m);
  }

  // Write speed: --speed-sectors N (sectors per second, as reported by "list") or --speed X (multiple of 1x)
  long sectorsPerSec = 0;
  std::string sps = argVal(argc, argv, L"--speed-sectors");
  std::string sp = argVal(argc, argv, L"--speed");
  if (!sps.empty()) sectorsPerSec = atol(sps.c_str());
  else if (!sp.empty()) {
    double oneX = media >= 17 ? 2195.0 : media >= 4 ? 676.5 : 75.0;  // IMAPI_SECTORS_PER_SECOND_AT_1X_*
    sectorsPerSec = (long)(atof(sp.c_str()) * oneX + 0.5);
  }
  if (sectorsPerSec > 0) {
    try {
      fmt.call(L"SetWriteSpeed", {vI4(sectorsPerSec), vBool(false)});
      long now = (long)fmt.getInt(L"CurrentWriteSpeed");
      char m[160]; sprintf(m, "{\"type\":\"speed\",\"requested\":%ld,\"current\":%ld}", sectorsPerSec, now);
      emit(m);
    } catch (ComError &e) {
      emit("{\"type\":\"log\",\"message\":" + jstr("The burner did not accept the chosen speed; using its default. " + e.msg) + "}");
    }
  } else {
    try { fmt.call(L"SetWriteSpeed", {vI4(0xFFFFFFFF), vBool(false)}); } catch (ComError &) {}  // drive maximum
  }
  try { fmt.put(L"ForceMediaToBeClosed", vBool(true)); } catch (ComError &) {}

  IStream *stream = nullptr;
  HRESULT hr = SHCreateStreamOnFileEx(iso, STGM_READ | STGM_SHARE_DENY_WRITE, FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, &stream);
  if (FAILED(hr)) fail(hr, "", "The ISO file could not be opened for reading.");

  Sink *sink = new Sink(DIID_DDiscFormat2DataEvents, false);
  IConnectionPoint *cp = nullptr;
  DWORD cookie = advise(fmt, sink, &cp);
  g_cancelTarget = &fmt;
  CreateThread(nullptr, 0, stdinWatcher, nullptr, 0, nullptr);

  emit("{\"type\":\"progress\",\"phase\":\"initializing\",\"fraction\":0}");
  try {
    fmt.call(L"Write", {vUnk(stream)});
  } catch (ComError &e) {
    g_cancelTarget = nullptr;
    if (cp) { cp->Unadvise(cookie); cp->Release(); }
    sink->Release(); stream->Release();
    if (g_cancelled) fail(0xC0AA0002, "", "Burning was cancelled. The disc is probably unusable.");
    throw;
  }
  g_cancelTarget = nullptr;
  if (cp) { cp->Unadvise(cookie); cp->Release(); }
  sink->Release();
  stream->Release();
  emit("{\"type\":\"progress\",\"phase\":\"completed\",\"fraction\":1}");
  if (!hasFlag(argc, argv, L"--no-eject")) { try { rec.call(L"EjectMedia"); } catch (ComError &) {} }
  emit("{\"type\":\"done\"}");
  return 0;
}

static int cmdErase(int argc, wchar_t **argv) {
  if (argc < 3) fail(E_INVALIDARG, "", "usage: dfburn erase <burner>");
  emit("{\"type\":\"progress\",\"phase\":\"preparing\",\"fraction\":0}");
  Disp rec = openRecorder(argv[2]);
  Disp er = Disp::create(L"IMAPI2.MsftDiscFormat2Erase");
  er.putRef(L"Recorder", vDisp(rec.p));
  VARIANT cn = vStr(L"DiscForge Studio"); er.put(L"ClientName", cn); VariantClear(&cn);
  er.put(L"FullErase", vBool(hasFlag(argc, argv, L"--full")));
  Sink *sink = new Sink(DIID_DDiscFormat2EraseEvents, true);
  IConnectionPoint *cp = nullptr;
  DWORD cookie = advise(er, sink, &cp);
  try { er.call(L"EraseMedia"); }
  catch (ComError &) { if (cp) { cp->Unadvise(cookie); cp->Release(); } sink->Release(); throw; }
  if (cp) { cp->Unadvise(cookie); cp->Release(); }
  sink->Release();
  emit("{\"type\":\"progress\",\"phase\":\"completed\",\"fraction\":1}");
  emit("{\"type\":\"done\"}");
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  InitializeCriticalSection(&g_out);
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { emit("{\"type\":\"error\",\"message\":\"COM could not be initialised.\"}"); return 2; }
  int rc = 0;
  try {
    if (argc < 2) fail(E_INVALIDARG, "", "usage: dfburn list | burn <iso> <burner> | erase <burner>");
    if (!wcscmp(argv[1], L"list")) rc = cmdList();
    else if (!wcscmp(argv[1], L"burn")) rc = cmdBurn(argc, argv);
    else if (!wcscmp(argv[1], L"erase")) rc = cmdErase(argc, argv);
    else fail(E_INVALIDARG, "", "unknown command");
  } catch (ComError &e) {
    char code[16]; sprintf(code, "0x%08X", (unsigned)e.hr);
    emit("{\"type\":\"error\",\"code\":\"" + std::string(code) + "\",\"message\":" + jstr(e.msg) + "}");
    rc = 1;
  }
  CoUninitialize();
  return rc;
}
