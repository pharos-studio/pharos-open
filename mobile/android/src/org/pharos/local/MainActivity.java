package org.pharos.local;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** No server, native runtime, account, analytics, or remote WebView content. */
public final class MainActivity extends Activity {
  private static final String HOST = "app.pharos.invalid";
  private static final String ORIGIN = "https://" + HOST;
  private static final int MAX_BODY = 8 * 1024 * 1024, MAX_BACKUP = 20 * 1024 * 1024;
  private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  private static final Set<String> NETWORK_HOSTS = new HashSet<>(Arrays.asList(
    "danjuanfunds.com", "legulegu.com", "api.fund.eastmoney.com", "fundf10.eastmoney.com",
    "datacenter.eastmoney.com", "fund.eastmoney.com", "fundsuggest.eastmoney.com",
    "fundmobapi.eastmoney.com", "push2.eastmoney.com", "hq.sinajs.cn",
    "www.nffund.com", "www.chinaamc.com.cn", "www.jsfund.cn", "api.efunds.com.cn",
    "www.federalreserve.gov", "www.pbc.gov.cn", "www.ecb.europa.eu", "www.boj.or.jp",
    "www.bankofengland.co.uk", "home.treasury.gov", "www.federalregister.gov", "www.mof.gov.cn",
    "www.gov.cn", "www.customs.gov.cn", "www.chinatax.gov.cn", "www.mof.go.jp", "www.gov.uk",
    "ec.europa.eu", "eur-lex.europa.eu", "ofac.treasury.gov", "www.sge.com.cn"));
  private static final Set<String> BACKUP_FILES = new HashSet<>(Arrays.asList(
    "state/holdings.json", "state/history.json", "state/decision_history.json", "state/signals.json",
    "state/timing_state.json", "state/timing_samples.json", "config/config.json", "config/categories.json",
    "config/theme_map.json", "series/yield_history.json"));
  private WebView web;
  private File account;
  private final ExecutorService io = Executors.newFixedThreadPool(6);
  private final ConcurrentHashMap<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
  private final Set<String> cancelled = ConcurrentHashMap.newKeySet();
  private String documentId, exportText;
  private boolean ready;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    account = new File(getFilesDir(), "account-v1");
    try { recoverRestore(); }
    catch (Exception e) { TextView message = new TextView(this); message.setPadding(32, 64, 32, 32); message.setText("本机恢复事务需要处理，账户和保护副本已保留。请勿卸载或清除数据。" + e.getMessage()); setContentView(message); return; }
    android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
    int chrome = 0;
    try { chrome = Integer.parseInt(provider.versionName.split("\\.")[0]); } catch (Exception ignored) {}
    if (chrome < 110) { TextView message = new TextView(this); message.setPadding(32, 64, 32, 32); message.setText("请先更新 Android System WebView 或 Chrome（需要110及以上版本），再重新打开 Pharos。已有本机账户不会被清空。"); setContentView(message); return; }
    WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    web = new WebView(this);
    web.setBackgroundColor(0xff0A1020);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.addJavascriptInterface(new Bridge(), "PharosBridge");
    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return resource(request.getUrl(), request.getMethod());
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        if (isLocal(u)) return false;
        if (request.isForMainFrame() && "https".equals(u.getScheme())) {
          try { startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)); }
          catch (Exception ignored) { showMessage("没有可打开链接的浏览器"); }
        }
        return true;
      }
      @Override public void onPageFinished(WebView view, String url) { ready = true; }
    });
    setContentView(web);
    web.loadUrl(ORIGIN + "/index.html");
  }
  private boolean isLocal(Uri uri) {
    return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null;
  }
  private WebResourceResponse denied() {
    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.singletonMap("Content-Security-Policy", CSP), new ByteArrayInputStream("Resource unavailable".getBytes(StandardCharsets.UTF_8)));
  }
  private WebResourceResponse resource(Uri uri, String method) {
    if (!isLocal(uri) || !"GET".equals(method)) return denied();
    String p = uri.getPath();
    if (p == null || p.indexOf('\\') >= 0 || p.indexOf('\0') >= 0) return denied();
    for (String part : p.split("/")) if (part.equals("..") || part.equals(".")) return denied();
    if (p.equals("/")) p = "/index.html";
    String name = p.substring(1);
    String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".json") || name.endsWith(".webmanifest") ? "application/json" : name.endsWith(".html") ? "text/html" : "application/octet-stream";
    try {
      InputStream stream = getAssets().open(name);
      Map<String, String> headers = new HashMap<>(); headers.put("Content-Security-Policy", CSP); headers.put("X-Content-Type-Options", "nosniff"); headers.put("Cache-Control", "no-store");
      return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream);
    } catch (IOException e) { return denied(); }
  }
  @Override protected void onResume() {
    super.onResume(); if (web != null) { web.onResume(); if (ready) web.evaluateJavascript("window.PharosMobile&&PharosMobile.foreground(true)", null); }
  }
  @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
  @Override protected void onDestroy() { for (HttpURLConnection c : connections.values()) c.disconnect(); io.shutdownNow(); if (web != null) { web.removeJavascriptInterface("PharosBridge"); web.destroy(); } super.onDestroy(); }
  @Override public void onBackPressed() { if (web != null && !web.getUrl().endsWith("#/overview") && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
  private void showMessage(String message) { new AlertDialog.Builder(this).setMessage(message).setPositiveButton("知道了", null).show(); }
  private boolean online() {
    ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    NetworkCapabilities cap = cm.getNetworkCapabilities(cm.getActiveNetwork());
    return cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
  }
  private boolean validated() {
    ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    NetworkCapabilities cap = cm.getNetworkCapabilities(cm.getActiveNetwork());
    return cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
  }
  private String installKey() {
    android.content.SharedPreferences prefs = getSharedPreferences("local-identity", MODE_PRIVATE);
    String key = prefs.getString("key", null);
    if (key == null) { key = UUID.randomUUID().toString(); prefs.edit().putString("key", key).apply(); }
    return key;
  }
  private JSONObject ok(Object value) throws Exception { JSONObject r = new JSONObject(); r.put("ok", true); r.put("value", value == null ? JSONObject.NULL : value); return r; }
  private JSONObject error(Throwable e) { JSONObject r = new JSONObject(); try { r.put("ok", false); r.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()); r.put("code", e instanceof FileNotFoundException ? "ENOENT" : "EIO"); } catch (Exception ignored) {} return r; }
  private void reply(String id, JSONObject result) { runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__PharosNativeResult(" + JSONObject.quote(id) + "," + result.toString() + ")", null); }); }
  private File dataFile(String virtual) throws Exception {
    if (!(virtual.equals("/data") || virtual.startsWith("/data/")) || virtual.indexOf('\\') >= 0 || virtual.indexOf('\0') >= 0) throw new SecurityException("Invalid data path");
    File f = new File(account, virtual.equals("/data") ? "" : virtual.substring(6)).getCanonicalFile();
    String base = account.getCanonicalPath();
    if (!(f.getPath().equals(base) || f.getPath().startsWith(base + File.separator))) throw new SecurityException("Path outside account");
    return f;
  }
  private static byte[] readBounded(InputStream input, int max) throws IOException {
    try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buf = new byte[16384]; int count;
      while ((count = in.read(buf)) != -1) { if (out.size() + count > max) throw new IOException("内容超过大小限制"); out.write(buf, 0, count); }
      return out.toByteArray();
    }
  }
  private static void atomicWrite(File f, byte[] bytes) throws IOException {
    File parent = f.getParentFile(); if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建本机目录");
    File temp = new File(parent, f.getName() + ".native-tmp");
    try (FileOutputStream out = new FileOutputStream(temp)) { out.write(bytes); out.getFD().sync(); }
    Files.move(temp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
  }
  private final class Bridge {
    @JavascriptInterface public synchronized String call(String op, String args) {
      try {
        JSONObject a = new JSONObject(args); Object result;
        switch (op) {
          case "info": { JSONObject value = new JSONObject(); value.put("online", online()); value.put("validated", validated()); value.put("key", installKey()); value.put("platform", "android-independent-v1"); result = value; break; }
          case "hash": { String algorithm = a.getString("algorithm").toLowerCase(Locale.ROOT); if (!algorithm.equals("md5") && !algorithm.equals("sha256")) throw new SecurityException("Unsupported hash"); byte[] digest = MessageDigest.getInstance(algorithm.equals("md5") ? "MD5" : "SHA-256").digest(Base64.decode(a.getString("base64"), Base64.DEFAULT)); StringBuilder s = new StringBuilder(); for (byte b : digest) s.append(String.format(Locale.ROOT, "%02x", b & 255)); result = s.toString(); break; }
          case "exists": result = dataFile(a.getString("path")).exists(); break;
          case "read": result = Base64.encodeToString(readBounded(new FileInputStream(dataFile(a.getString("path"))), MAX_BACKUP), Base64.NO_WRAP); break;
          case "write": atomicWrite(dataFile(a.getString("path")), Base64.decode(a.getString("base64"), Base64.DEFAULT)); result = true; break;
          case "mkdir": { File f = dataFile(a.getString("path")); if (!f.isDirectory() && !f.mkdirs()) throw new IOException("Cannot create directory"); result = true; break; }
          case "rename": Files.move(dataFile(a.getString("path")).toPath(), dataFile(a.getString("to")).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); result = true; break;
          case "unlink": Files.delete(dataFile(a.getString("path")).toPath()); result = true; break;
          case "stat": { File f = dataFile(a.getString("path")); if (!f.exists()) throw new FileNotFoundException("Missing file"); JSONObject value = new JSONObject(); value.put("size", f.length()); value.put("directory", f.isDirectory()); result = value; break; }
          case "list": { File[] files = dataFile(a.getString("path")).listFiles(); if (files == null) throw new FileNotFoundException("Missing directory"); JSONArray rows = new JSONArray(); for (File f : files) { JSONObject value = new JSONObject(); value.put("name", f.getName()); value.put("directory", f.isDirectory()); rows.put(value); } result = rows; break; }
          default: throw new SecurityException("Unsupported bridge operation");
        }
        return ok(result).toString();
      } catch (Throwable e) { return error(e).toString(); }
    }
    @JavascriptInterface public void request(String id, String kind, String json) {
      try {
        JSONObject payload = new JSONObject(json);
        if (kind.equals("http")) io.execute(() -> { try { reply(id, ok(http(id, payload))); } catch (Throwable e) { reply(id, error(e)); } finally { connections.remove(id); cancelled.remove(id); } });
        else runOnUiThread(() -> { try { document(id, kind, payload); } catch (Throwable e) { reply(id, error(e)); } });
      } catch (Throwable e) { reply(id, error(e)); }
    }
    @JavascriptInterface public void cancel(String id) { cancelled.add(id); HttpURLConnection c = connections.get(id); if (c != null) c.disconnect(); }
  }
  private URL allowedUrl(String raw) throws Exception {
    URL url = new URL(raw);
    // Read-only probe verified byte-identical public responses for this one legacy endpoint.
    if (url.getProtocol().equals("http") && url.getHost().equals("fundf10.eastmoney.com") && url.getPath().equals("/FundArchivesDatas.aspx") && url.getUserInfo() == null && url.getPort() == -1) url = new URL("https" + raw.substring(4));
    if (!url.getProtocol().equals("https") || url.getUserInfo() != null || url.getPort() != -1 && url.getPort() != 443 || !NETWORK_HOSTS.contains(url.getHost().toLowerCase(Locale.ROOT))) throw new SecurityException("该网络来源未获支持");
    for (InetAddress address : InetAddress.getAllByName(url.getHost())) if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress() || address instanceof Inet6Address && (address.getAddress()[0] & 0xfe) == 0xfc) throw new SecurityException("禁止访问本机或私网地址");
    return url;
  }
  private JSONObject http(String id, JSONObject payload) throws Exception {
    if (!payload.optString("method", "GET").equals("GET")) throw new SecurityException("Only public GET requests are supported");
    String raw = payload.getString("url");
    JSONObject headerValues = payload.optJSONObject("headers");
    for (int hop = 0; hop < 6; hop++) {
      if (cancelled.contains(id)) throw new IOException("请求已取消");
      URL url = allowedUrl(raw);
      HttpURLConnection c = (HttpURLConnection) url.openConnection(); connections.put(id, c);
      c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(20000); c.setRequestMethod("GET");
      c.setRequestProperty("Accept-Encoding", "identity");
      if (headerValues != null) for (Iterator<String> keys = headerValues.keys(); keys.hasNext();) { String k = keys.next(); if (!Arrays.asList("accept", "accept-language", "user-agent", "referer", "cookie", "x-csrf-token").contains(k.toLowerCase(Locale.ROOT))) throw new SecurityException("Unsupported request header"); c.setRequestProperty(k, headerValues.getString(k)); }
      int status = c.getResponseCode();
      if (status >= 300 && status < 400 && !payload.optString("redirect").equals("manual")) {
        String next = c.getHeaderField("Location"); c.disconnect();
        if (next == null) throw new IOException("无效跳转");
        URL target = allowedUrl(new URL(url, next).toExternalForm());
        // Cookies and anti-CSRF tokens never cross to another authority.
        if (!target.getHost().equalsIgnoreCase(url.getHost()) && headerValues != null) { headerValues.remove("cookie"); headerValues.remove("x-csrf-token"); }
        raw = target.toExternalForm(); continue;
      }
      if (c.getContentLengthLong() > MAX_BODY) { c.disconnect(); throw new IOException("响应超过8MB"); }
      byte[] bytes;
      try { InputStream input = status >= 400 ? c.getErrorStream() : c.getInputStream(); bytes = input == null ? new byte[0] : readBounded(input, MAX_BODY); }
      finally { c.disconnect(); }
      JSONObject headers = new JSONObject(); JSONArray cookies = new JSONArray();
      for (Map.Entry<String, List<String>> entry : c.getHeaderFields().entrySet()) if (entry.getKey() != null) { headers.put(entry.getKey(), String.join(", ", entry.getValue())); if (entry.getKey().equalsIgnoreCase("Set-Cookie")) for (String cookie : entry.getValue()) cookies.put(cookie); }
      JSONObject result = new JSONObject(); result.put("status", status); result.put("headers", headers); result.put("cookies", cookies); result.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP)); result.put("url", url.toExternalForm()); return result;
    }
    throw new IOException("网络跳转过多");
  }
  private void document(String id, String kind, JSONObject payload) throws Exception {
    if (documentId != null) throw new IOException("另一个文件操作尚未完成");
    if (kind.equals("export")) {
      exportText = payload.getString("text"); if (exportText.getBytes(StandardCharsets.UTF_8).length > MAX_BACKUP) throw new IOException("备份超过20MB");
      documentId = id; Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/json"); intent.putExtra(Intent.EXTRA_TITLE, "pharos-backup-" + new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".json"); startActivityForResult(intent, 100);
    } else if (kind.equals("import")) {
      documentId = id; Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/json"); startActivityForResult(intent, 101);
    } else if (kind.equals("restore")) {
      final String text = payload.getString("text");
      new AlertDialog.Builder(this).setTitle("覆盖本机账户？").setMessage("将用备份中的" + payload.getInt("count") + "只基金及流水覆盖本机账户。当前数据先保存在应用内部保护副本，卸载也会删除保护副本。请确认已另行导出备份。")
        .setNegativeButton("取消", (d, w) -> { try { reply(id, ok(false)); } catch (Exception ignored) {} })
        .setPositiveButton("确认恢复", (d, w) -> io.execute(() -> { try { restore(text); reply(id, ok(true)); } catch (Throwable e) { reply(id, error(e)); } })).setCancelable(false).show();
    } else throw new SecurityException("Unsupported document action");
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != 100 && request != 101 || documentId == null) return;
    final String id = documentId, text = exportText; documentId = null; exportText = null;
    if (result != RESULT_OK || data == null || data.getData() == null) { try { reply(id, ok(null)); } catch (Exception ignored) {} return; }
    final Uri uri = data.getData();
    io.execute(() -> { try {
      if (request == 100) { try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) { if (out == null) throw new IOException("无法写入备份文件"); out.write(text.getBytes(StandardCharsets.UTF_8)); } reply(id, ok(true)); }
      else reply(id, ok(new String(readBounded(getContentResolver().openInputStream(uri), MAX_BACKUP), StandardCharsets.UTF_8)));
    } catch (Throwable e) { reply(id, error(e)); } });
  }
  private void recoverRestore() {
    File journal = new File(getFilesDir(), "restore-journal.json");
    if (!journal.exists()) return;
    try {
      JSONObject j = new JSONObject(new String(readBounded(new FileInputStream(journal), 4096), StandardCharsets.UTF_8));
      File old = new File(getFilesDir(), j.getString("previous"));
      if (!old.getName().matches("account-previous-[0-9]+")) throw new IOException("恢复日志无效");
      if (!account.exists() && old.isDirectory() && !old.renameTo(account)) throw new IOException("恢复原账户失败");
      if (!account.isDirectory()) throw new IOException("原账户及保护副本需要人工恢复");
      if (account.isDirectory()) Files.deleteIfExists(journal.toPath());
    } catch (Exception e) { throw new IllegalStateException("本机恢复事务需要处理，账户未被覆盖", e); }
  }
  private synchronized void restore(String text) throws Exception {
    if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BACKUP) throw new IOException("备份超过20MB");
    JSONObject backup = new JSONObject(text), files = backup.getJSONObject("files");
    if (!backup.getString("format").equals("pharos-android-backup") || backup.getInt("version") != 1 || files.getJSONObject("state/holdings.json").getInt("_schemaVersion") != 2) throw new IOException("不支持的备份格式");
    for (String required : Arrays.asList("state/holdings.json", "state/history.json", "state/decision_history.json", "state/signals.json", "state/timing_state.json", "state/timing_samples.json", "config/config.json", "config/categories.json", "config/theme_map.json")) if (!files.has(required)) throw new IOException("备份不完整：" + required);
    files.getJSONObject("state/holdings.json").getJSONArray("funds"); files.getJSONArray("state/history.json"); files.getJSONArray("state/decision_history.json"); files.getJSONArray("state/timing_samples.json");
    files.getJSONObject("state/signals.json"); files.getJSONObject("state/timing_state.json").getJSONObject("funds"); files.getJSONObject("config/categories.json").getJSONArray("categories"); files.getJSONObject("config/theme_map.json");
    if (files.getJSONObject("config/config.json").getInt("_schemaVersion") != 2) throw new IOException("配置版本不受支持");
    String stamp = Long.toString(System.currentTimeMillis()); File prepared = new File(getFilesDir(), "account-prepared-" + stamp), previous = new File(getFilesDir(), "account-previous-" + stamp);
    if (!prepared.mkdir()) throw new IOException("无法创建恢复目录");
    for (Iterator<String> keys = files.keys(); keys.hasNext();) { String p = keys.next(); if (!BACKUP_FILES.contains(p)) throw new SecurityException("备份路径不支持"); atomicWrite(new File(prepared, p), files.get(p).toString().getBytes(StandardCharsets.UTF_8)); }
    File journal = new File(getFilesDir(), "restore-journal.json"); JSONObject j = new JSONObject(); j.put("previous", previous.getName()); atomicWrite(journal, j.toString().getBytes(StandardCharsets.UTF_8));
    if (!account.renameTo(previous)) throw new IOException("无法保护原账户");
    try { if (!prepared.renameTo(account)) throw new IOException("恢复写入失败"); }
    catch (Exception e) { if (!previous.renameTo(account)) throw new IOException("恢复中断，原账户保存在保护副本", e); throw e; }
    Files.deleteIfExists(journal.toPath());
  }
}
