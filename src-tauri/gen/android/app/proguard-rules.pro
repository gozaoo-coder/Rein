# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ---------------------------------------------------------------------------
# 手工维护的 Kotlin 桥接类：只被 Rust 经 JNI 反射调用（modules/tracking 的
# call_static_method），R8 静态分析看不到 JNI 引用，release 混淆会把方法裁掉，
# 运行时 NoSuchMethodError 闪退（如打开跑步页崩溃）。必须整类保留。
# ---------------------------------------------------------------------------
-keep class com.gozaoo.rein.TrackingBridge { *; }
-keep class com.gozaoo.rein.RunTrackingService { *; }
# UpdateBridge 同理：Rust 经 JNI 反射调 install/snapshot（modules/update 的
# call_static_method）。漏了这条的后果实测就是「点安装并更新 → 闪退」：
# release 包把 install 方法裁掉，JNI 调用抛 NoSuchMethodError。
-keep class com.gozaoo.rein.UpdateBridge { *; }