import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 发布签名：gen/android/keystore.properties（不入库），密钥库在 src-tauri/rein-release.keystore
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.gozaoo.rein"
    defaultConfig {
        // 明文 HTTP：本项目**按设计**走明文 —— 更新源与在线服务是自建服务器
        // （`http://47.100.36.179:8787`，无 TLS），而 Android 9+ 的默认策略是拒绝明文，
        // 结果就是 App 里凡是 http 的请求（更新检查、在线模型、WebView 子资源）
        // 一律以 Failed to connect / ERR_CLEARTEXT_NOT_PERMITTED 收场。
        // 这里保持 true 直到服务端上 TLS；那时把它连同 allowHttp 一起翻回 false。
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.gozaoo.rein"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = keystoreProperties["keyPassword"] as String?
            storeFile = keystoreProperties["storeFile"]?.let { rootProject.file(it.toString()) }
            storePassword = keystoreProperties["storePassword"] as String?
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    // core library desugaring：minSdk 24 上也要能用 java.time ——
    // HealthConnectBridge 到处在用 Instant/ZoneId，而 java.time 是 API 26 才进系统的。
    // 不开这个，Android 7 的机器一碰这段代码就 NoClassDefFoundError。
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // 第三方健康数据：Health Connect 客户端（见 modules/healthsync）。
    // 1.1.0 是当前稳定版（1.2.0 还是 alpha），它自带底层的 health-platform-client，
    // 依赖 kotlinx-coroutines-android 会一起进来，不必单独声明。
    implementation("androidx.health.connect:connect-client:1.1.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")