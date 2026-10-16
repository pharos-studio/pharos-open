# Android 独立版 v1

开发测试预览：完整工程验收尚未完成，当前仅供跨设备测试，请勿录入真实账户、持仓或私人流水。本测试包不代表正式启用或正式发行。

本机独立运行：APK内含现有页面和生产算法，Android系统WebView执行JavaScript，受限原生桥提供本机文件、摘要算法及公开数据请求。没有电脑后台、监听端口、账号、云同步或自动交易。电脑版继续使用原Node服务。主题行业及主动权益仍仅记账，已上线规则及原有数据门禁保持；黄金政策仍为原来源范围的有限资料与条件性解释。

要求Android 8及以上、近期Android System WebView（Chrome 110及以上）。安装后为空账户。在「我的基金」添加基金并记录流水；「设置」导出或恢复本机备份。联网直接取原公开源，来源受限、错误或缺资料时保留缺失状态，不生成替代行情。离线可看本机记录和缓存资产，旧条件不作为新的可执行候选；月投只保留纯计划，申购状态需要重新联网核验。后台不保证定时采样，打开应用后更新。

卸载、清除应用数据或丢机将丢失本机记录。请定期通过系统文件选择器导出备份。备份含私人基金、流水及历史，请妥善保管；不含口令或行情缓存。恢复先校验内容并确认覆盖，旧账户另留应用内部保护副本；保护副本同样会在卸载时丢失。安卓版与电脑版数据独立，不自动同步。

## 本地构建测试APK

无npm运行依赖，无Gradle/Maven下载。准备JDK21、Android SDK platform35和build-tools35后运行：

```sh
node mobile/android/tools/build.cjs --java-home /absolute/jdk/Contents/Home --platform /absolute/sdk/android.jar --build-tools /absolute/sdk/build-tools
```

也支持`JAVA_HOME`及`ANDROID_HOME`的标准SDK布局。脚本只向`mobile/android/build/`生成公开资产、编译产物和本地debug签名材料，产物为`mobile/android/build/pharos-debug.apk`。该签名仅用于测试，不是正式发行密钥；本轮不包含公开发行或商店上架。首次debug密钥随机生成，因此APK字节不保证跨机器一致；每个APK携带`source-manifest.json`绑定所有公开源SHA256。

构建脚本在生成目录内制作专用debug manifest，允许对测试APK使用WebView调试。源码manifest默认关闭debug；Java仅在应用带`FLAG_DEBUGGABLE`时启用WebView调试。此测试包请仅用于脱敏验收，勿把它当正式发行版本存放私人账户。

运行适配层检查：`node mobile/android/tests/runtime.cjs`。检查在操作系统临时目录使用脱敏账户，不启动真实后台，不读写真实运行数据。完整Android安装、跨重启、系统文件选择器和网络行为仍须设备或模拟器实际验收；编译成功不代表这些检查通过。

## 安全与恢复边界

APK仅收显式白名单公开生产目录及三个空账户模板和公开主题词典；不打包真实账户、缓存、研究目录、脚本、夹具或凭据。WebView只加载受限本地HTTPS origin，未知路径拒绝、无文件访问、无远程脚本或iframe；外部HTTPS链接交系统浏览器。网络桥仅允许登记的公开源GET，拒绝私网及越界跳转。应用内部数据不使用Android自动云备份，导入导出不申请广域存储权限。

恢复以完整目录替换并保留旧目录；事务日志支持中断后恢复原账户。导入失败不自动清空账户。内部保护副本位于应用私有目录，仅用于故障恢复，不应当作外部备份。撤销本轮安卓适配时应保留手机导出的备份；桌面运行数据不受安卓构建影响。
